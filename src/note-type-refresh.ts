/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { checkedCount } from './sync-outcome'
import { Notice, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { russianUi, uiDiagnostic, uiFor } from './interface-language'
import { AnkiProfileError, checkPinnedAnkiProfile, expectedAnkiProfile, readActiveAnkiProfile } from './anki-profile'
import { savePluginDataInOrder, withFastScanReadLock } from './fast-scan'
import { auditRead } from './sync-audit'
import { currentCardExpression } from './card-format-presets'

interface RefreshResult {
    changed: boolean
    noteTypeCount: number
    conflicts: string[]
    disabled: { model: string; use: 'file' | 'context'; field: string }[]
}

type FieldMap = Record<string, string[]>
type Choices = Record<string, string>
const refreshes = new WeakMap<MyPlugin, Promise<RefreshResult>>()
const lastStatus = new WeakMap<MyPlugin, readonly [english: string, russian: string]>()
const requestWindowMs = 20_000
const timeoutMessage = 'AnkiConnect did not finish reading the note types within 20 seconds.'
const modelsPerBatch = 50

function validatedNames(value: unknown, description: string): string[] {
    if (!Array.isArray(value) || value.length === 0 ||
        !value.every((name: unknown): name is string => typeof name === 'string' && name.trim().length > 0) || new Set(value).size !== value.length) {
        throw new Error(`Anki returned an invalid or empty list of ${description}.`)
    }
    return value
}

function requestTimeLeft(deadline: number): number {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw new Error(timeoutMessage)
    return remaining
}

async function readRefreshProfile(deadline: number, pinned?: string): Promise<string | undefined> {
    const remaining = requestTimeLeft(deadline)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), remaining)
    try {
        return pinned === undefined ? await readActiveAnkiProfile(controller.signal) :
            await checkPinnedAnkiProfile(pinned, controller.signal)
    } catch (error) {
        if (controller.signal.aborted) throw new Error(timeoutMessage)
        if (pinned === undefined && error instanceof AnkiProfileError && error.reason === 'unsupported') return undefined
        throw error
    } finally {
        window.clearTimeout(timer)
    }
}

export async function readNoteTypeSchema(deadline: number, signal?: AbortSignal): Promise<{ names: string[]; fields: FieldMap }> {
    const read = async (action: 'modelNames' | 'modelFieldNames' | 'multi', params: Record<string, unknown>) => {
        try {
            return await auditRead(action, params, signal, requestTimeLeft(deadline))
        } catch (error) {
            if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(timeoutMessage)
            throw error
        }
    }
    const names = validatedNames(await read('modelNames', {}), 'note types')
    const fields: [string, string[]][] = []
    let useMulti = true
    for (let offset = 0; offset < names.length; offset += modelsPerBatch) {
        const batch = names.slice(offset, offset + modelsPerBatch)
        if (useMulti) {
            let response: unknown
            try {
                response = await read('multi', {
                    actions: batch.map(modelName => ({ action: 'modelFieldNames', version: 6, params: { modelName } })),
                })
            } catch (error) {
                if (!/(unsupported|unexpected|invalid|unknown) action|(?:multi|action).*(not supported|not implemented)/i.test(String(error))) {
                    throw error
                }
                useMulti = false
            }
            if (useMulti) {
                if (!Array.isArray(response) || response.length !== batch.length) {
                    throw new Error('Anki returned an incomplete batch of note-type fields.')
                }
                batch.forEach((name, index) => {
                    const row: unknown = response[index]
                    if (typeof row !== 'object' || !row || !('error' in row) || !('result' in row)) {
                        throw new Error(`Anki returned an invalid response for note type “${name}”.`)
                    }
                    const { error, result } = row
                    if (error !== null) throw new Error(`Could not read note type “${name}”. ${String(error)}`)
                    fields.push([name, validatedNames(result, `fields for “${name}”`)])
                })
                continue
            }
        }
        for (const name of batch) {
            fields.push([name, validatedNames(await read('modelFieldNames', { modelName: name }), `fields for “${name}”`)])
        }
    }
    return { names, fields: Object.fromEntries(fields) }
}

function sameNames(previous: readonly string[] | undefined, expected: readonly string[]): boolean {
    return Array.isArray(previous) && previous.length === expected.length &&
        expected.every((name, index) => previous[index] === name)
}

function correctedChoices(choices: Choices | undefined | null, fields: FieldMap,
    use: 'file' | 'context', disabled?: RefreshResult['disabled']): Choices {
    return Object.fromEntries(Object.entries(choices ?? {}).map(([model, value]) => {
        const names = Object.prototype.hasOwnProperty.call(fields, model) ? fields[model] : undefined
        if (value && names && !names.includes(value)) {
            disabled?.push({ model, use, field: value })
            return [model, '']
        }
        return [model, value]
    }))
}

function sameChoices(left: Choices | undefined | null, right: Choices): boolean {
    return !!left && Object.keys(left).length === Object.keys(right).length &&
        Object.entries(right).every(([name, value]) =>
            Object.prototype.hasOwnProperty.call(left, name) && left[name] === value)
}

export function updatedChoices(settings: MyPlugin['settings'], names: readonly string[], fields: FieldMap,
    disabled?: RefreshResult['disabled'], conflicts?: string[]) {
    const active = new Map(Object.entries(settings.CUSTOM_REGEXPS ?? {}))
    const inactive = new Map(Object.entries(settings.INACTIVE_CUSTOM_REGEXPS ?? {}).filter(([, value]) => typeof value === 'string' && value.trim()))
    const present = new Set(names)
    for (const [model, value] of active) {
        if (!present.has(model) && typeof value === 'string' && value.trim()) inactive.set(model, value)
    }
    // A user can reuse a format while a model is absent. Leave ambiguous restorations disabled.
    const owners = new Map<string, number>()
    for (const name of names) {
        const expression = active.get(name) || inactive.get(name)
        if (!expression) continue
        const canonical = currentCardExpression(expression)
        owners.set(canonical, (owners.get(canonical) ?? 0) + 1)
    }
    const selected = names.map((name): [string, string] => {
        const current = active.get(name) || ''
        const saved = inactive.get(name)
        if (!current && saved && owners.get(currentCardExpression(saved)) !== 1) {
            conflicts?.push(name)
            return [name, '']
        }
        inactive.delete(name)
        return [name, current || saved || '']
    })
    return {
        CUSTOM_REGEXPS: Object.fromEntries(selected),
        INACTIVE_CUSTOM_REGEXPS: Object.fromEntries(inactive),
        FILE_LINK_FIELDS: correctedChoices(settings.FILE_LINK_FIELDS, fields, 'file', disabled),
        CONTEXT_FIELDS: correctedChoices(settings.CONTEXT_FIELDS, fields, 'context', disabled),
    }
}

export function refreshNoteTypes(plugin: MyPlugin): Promise<RefreshResult> {
    const active = refreshes.get(plugin)
    if (active) return active

    const update = withFastScanReadLock(plugin, async () => {
        const deadline = performance.now() + requestWindowMs
        const expected = expectedAnkiProfile(plugin)
        const profile = await readRefreshProfile(deadline)
        if (expected && profile && expected !== profile) throw new AnkiProfileError('mismatch', expected, profile)
        const { names, fields } = await readNoteTypeSchema(deadline)
        let changed = false
        const disabled: RefreshResult['disabled'] = []
        const conflicts: string[] = []
        await savePluginDataInOrder(plugin, async () => {
            if (profile !== undefined) await readRefreshProfile(deadline, profile)
            if (expected !== expectedAnkiProfile(plugin)) throw new AnkiProfileError('changed', expected)
            const { settings, fields_dict: previousFields } = plugin
            const choices = updatedChoices(settings, names, fields, undefined, conflicts)
            changed = !sameNames(plugin.note_types, names) || Object.keys(previousFields ?? {}).length !== names.length ||
                names.some(name => !sameNames(previousFields?.[name], fields[name])) ||
                !sameChoices(settings.CUSTOM_REGEXPS, choices.CUSTOM_REGEXPS) ||
                !sameChoices(settings.INACTIVE_CUSTOM_REGEXPS ?? {}, choices.INACTIVE_CUSTOM_REGEXPS) ||
                !sameChoices(settings.FILE_LINK_FIELDS, choices.FILE_LINK_FIELDS) ||
                !sameChoices(settings.CONTEXT_FIELDS, choices.CONTEXT_FIELDS)
            if (!changed) return

            try {
                await plugin.saveData({
                    settings: { ...settings, ...choices },
                    'Added Media': plugin.added_media,
                    'File Hashes': plugin.file_hashes,
                    fields_dict: fields,
                })
            } catch (error) {
                throw new Error(`Could not save note-type settings. ${error instanceof Error ? error.message : String(error)}`)
            }
            plugin.note_types = names
            plugin.fields_dict = fields
            conflicts.length = 0
            Object.assign(plugin.settings, updatedChoices(plugin.settings, names, fields, disabled, conflicts))
        })
        return { changed, noteTypeCount: names.length, disabled, conflicts }
    }).finally(() => refreshes.delete(plugin))
    refreshes.set(plugin, update)
    return update
}

export function installNoteTypeRefresh(container: HTMLElement, fallback: HTMLElement, plugin: MyPlugin, redraw: () => void): void {
    const t = uiFor(plugin.settings)
    const target = container.querySelector<HTMLElement>('[data-anki-note-type-refresh]') ?? fallback
    const setting = new Setting(target).setName(t('Anki note types', 'Типы записей Anki'))
        .setDesc(t('Read the current note types and fields from Anki.', 'Считывает текущие типы записей и поля из Anki.'))
    const status = target.createEl('small', { attr: { role: 'status', 'aria-live': 'polite' } })
    const recent = lastStatus.get(plugin)
    status.setText(recent ? t(recent[0], recent[1]) : '')
    setting.addButton(button => {
        const label = t('Refresh', 'Обновить')
        button.setButtonText(label)
        const observe = async (work: Promise<RefreshResult>) => {
            button.setDisabled(true).setButtonText(t('Refreshing…', 'Обновляем…'))
            status.setText(t('Reading note types from Anki…', 'Читаем типы записей из Anki…'))
            let result: RefreshResult
            try {
                result = await work
                const count = `${result.noteTypeCount} ${result.noteTypeCount === 1 ? 'note type' : 'note types'}`
                const base = result.changed
                    ? [`Updated ${count}.`, `Обновлено типов записей: ${result.noteTypeCount}.`] as const
                    : [`Checked ${count}. No changes.`, checkedCount(result.noteTypeCount, 'note type', russianUi) + ' Изменений нет.'] as const
                const message = result.disabled.length ? [
                    base[0] + ' Missing fields were disabled. Choose replacements in the note type settings. ' +
                        result.disabled.map(({ model, use, field }) => `${model} · ${use === 'file' ? 'file link' : 'context'} · ${field}`).join(', '),
                    base[1] + ' Привязки к отсутствующим полям отключены. Новые поля можно выбрать в настройках типов записей. ' +
                        result.disabled.map(({ model, use, field }) => `${model} · ${use === 'file' ? 'ссылка на файл' : 'контекст'} · ${field}`).join(', '),
                ] as const : base
                const finalMessage = result.conflicts.length ? [
                    message[0] + ' Another model uses the saved format. Review the rule for: ' + result.conflicts.join(', '),
                    message[1] + ' Сохранённый формат используется другим типом. Проверьте правило для: ' + result.conflicts.join(', '),
                ] as const : message
                lastStatus.set(plugin, finalMessage)
                status.setText(t(finalMessage[0], finalMessage[1]))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const failure = [message, `Не удалось обновить типы записей. ${uiDiagnostic(error, russianUi)}`] as const
                status.setText(t(failure[0], failure[1]))
                lastStatus.set(plugin, failure)
                new Notice(t(`Regenerate failed. ${message}`, failure[1]))
                return
            } finally {
                button.setButtonText(label).setDisabled(false)
            }
            if (result.changed && container.contains(status)) {
                try {
                    redraw()
                } catch (error) {
                    new Notice(t(`Note types were saved. Reopen the settings to see the updated list. ${String(error)}`,
                        `Типы записей сохранены. Откройте настройки заново, чтобы увидеть обновлённый список. ${uiDiagnostic(error, t)}`))
                }
            }
        }
        button.onClick(() => observe(refreshNoteTypes(plugin)))
        const active = refreshes.get(plugin)
        if (active) void observe(active)
    })
}
