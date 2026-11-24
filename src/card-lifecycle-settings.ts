// SPDX-License-Identifier: GPL-3.0-only
import { Notice, Setting } from 'obsidian'
import type { ToggleComponent, ButtonComponent, DropdownComponent, TextComponent } from 'obsidian'
import type MyPlugin from '../main'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { withFastScanReadLock, savePluginDataInOrder } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { legacySettingLabel } from './interface-settings-ui'
import { createSettingsGroup } from './settings-layout'
import { deletionLabelProblem, suspendLabel, suspendLabelProblem } from './suspend-label'
import { afterDeleteMode, isAfterDeleteMode } from './deletion-policy'
import { openFrozenFields } from './frozen-fields-ui'

type Settings = MyPlugin['settings']
type Syntax = DuplicateMarkerSyntax & { 'Suspend Line Aliases'?: string }

function validationMessage(message: string, t: UiText): string {
    const [english, russian] = message.split(' / ')
    return t(english, russian || english)
}

export function renamedSuspendSyntax(previous: Syntax, label: string): Syntax {
    const old = suspendLabel(previous)
    const saved = JSON.parse(previous['Suspend Line Aliases'] || '[]') as unknown
    if (!Array.isArray(saved) || !saved.every(value => typeof value === 'string')) {
        throw new Error('Invalid list of previous markers. / Повреждён список прежних меток.')
    }
    const aliases = [...new Set<string>([...saved, old])].filter(value => value.toLowerCase() !== label.toLowerCase())
    const next = { ...previous, 'Suspend Line': label, 'Suspend Line Aliases': JSON.stringify(aliases) }
    const problem = suspendLabelProblem(label, next)
    if (problem) throw new Error(problem)
    return next
}

export function allowSyntaxEdit(plugin: MyPlugin, key: string, value: string): boolean {
    const current: Syntax = plugin.settings.Syntax
    const next = { ...current, [key]: value }
    const problem = suspendLabelProblem(suspendLabel(next), next) || deletionLabelProblem(next)
    if (problem) new Notice(validationMessage(problem, uiFor(plugin.settings)))
    return !problem
}

async function saveChange(plugin: MyPlugin, change: (current: Settings) => Partial<Settings>): Promise<void> {
    await withFastScanReadLock(plugin, () => savePluginDataInOrder(plugin, async () => {
        const current = plugin.settings
        const patch = change(current)
        const previous: unknown = await plugin.loadData()
        if (previous != null && (typeof previous !== 'object' || Array.isArray(previous))) {
            throw new Error(uiFor(plugin.settings)('Saved plugin data is invalid.', 'Сохранённые данные плагина повреждены.'))
        }
        const data = previous && typeof previous === 'object' ? previous : {}
        await plugin.saveData({ ...data, settings: { ...current, ...patch },
            'Added Media': plugin.added_media, 'File Hashes': plugin.file_hashes, fields_dict: plugin.fields_dict })
        Object.assign(current, patch)
    }))
}

export function isLifecycleSyntax(key: string): boolean {
    return ['Suspend Line', 'Suspend Line Aliases', 'Delete Note Line', 'Frozen Fields Line'].includes(key)
}

export function bindSyntaxEdit(input: TextComponent, plugin: MyPlugin, key: string, fallback = ''): void {
    const value = () => (plugin.settings.Syntax as Record<string, string>)[key] ?? fallback
    input.setValue(value())
    input.inputEl.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) input.inputEl.blur()
        if (event.key === 'Escape') { input.setValue(value()); input.inputEl.blur() }
    })
    const saveOnBlur = async () => {
        const next = input.getValue()
        if (next === value()) return
        input.setDisabled(true)
        try {
            await saveChange(plugin, current => {
                if (!allowSyntaxEdit(plugin, key, next)) return {}
                return { Syntax: { ...current.Syntax, [key]: next } }
            })
        } catch (error) { new Notice(uiDiagnostic(error, uiFor(plugin.settings))) }
        finally { input.setValue(value()).setDisabled(false) }
    }
    input.inputEl.addEventListener('blur', () => { void saveOnBlur() })
}

export function installCardLifecycleSettings(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const body = createSettingsGroup(container, plugin, 'card-status-and-deletion',
        t('Card suspension, deletion and shared fields', 'Приостановка, удаление и общие поля'))
    const row = new Setting(body).setName(t('Suspension marker', 'Метка приостановки'))
    let draft = suspendLabel(plugin.settings.Syntax)
    let save: ButtonComponent
    let saving = false
    const refresh = () => {
        let problem: string | undefined
        try { renamedSuspendSyntax(plugin.settings.Syntax, draft) }
        catch (error) { problem = validationMessage(error instanceof Error ? error.message : String(error), t) }
        row.setDesc(problem || t(
            `Write ${draft} above the ID for all cards, or ${draft}_2 for card 2. Existing markers keep working after a rename.`,
            `Напишите ${draft} над ID для всех карточек записи или ${draft}_2 для второй. После переименования прежние метки продолжат работать.`))
        save?.setDisabled(saving || !!problem || draft === suspendLabel(plugin.settings.Syntax))
    }
    row.addText(text => text.setValue(draft).onChange(value => { draft = value; refresh() }))
        .addButton(button => {
            save = button
            button.setButtonText(t('Save marker', 'Сохранить метку')).onClick(async () => {
                if (saving) return
                saving = true
                const label = draft
                refresh()
                try {
                    await saveChange(plugin, settings => ({
                        Syntax: { ...settings.Syntax, ...renamedSuspendSyntax(settings.Syntax, label) }
                    }))
                } catch (error) { new Notice(uiDiagnostic(error, t)) }
                finally { saving = false; refresh() }
            })
        })
    refresh()
    new Setting(body).setName(legacySettingLabel('Delete Note Line', t))
        .addText(text => bindSyntaxEdit(text, plugin, 'Delete Note Line', 'DELETE'))
    const deletionRow = new Setting(body).setName(t('Markdown after confirmed Anki deletion',
        'Что делать с текстом после удаления записи в Anki'))
    let action: DropdownComponent
    let pages: ToggleComponent
    let pending = false
    const refreshCleanup = () => {
        const selected = afterDeleteMode(plugin.settings)
        const remove = selected === 'remove'
        const descriptions = {
            keep: t('Keep the original text and ID in the note.', 'Исходный текст и ID остаются в заметке.'),
            remove: t('Remove the linked block. Whole card pages require the separate trash switch below.',
                'Связанный блок удаляется. Для целых страниц нужно отдельно разрешить перенос в корзину.'),
            mark: t('Keep the card readable and add a visible “Deleted from Anki” label.',
                'Текст остаётся читаемым. Под карточкой появляется надпись «Удалено из Anki».'),
            strike: t('Show the entire archived card as struck-through text in Reading view.',
                'В режиме чтения весь текст архивной карточки отображается зачёркнутым.'),
            hidden: t('Keep the card in the Markdown source. Reading view hides the whole archived block.',
                'Карточка сохраняется в исходном Markdown. В режиме чтения весь архивный блок скрыт.'),
        }
        deletionRow.setDesc(descriptions[selected] + ' ' + t(
            'Changing the setting affects future confirmations. Two-way cleanup requires a previous successful sync of this note ID in the same Anki profile.',
            'Новый режим применяется при следующем подтверждении удаления. Для двусторонней обработки нужна предыдущая успешная сверка этого ID в том же профиле Anki.'))
        action.setValue(selected).setDisabled(pending)
        pages.setValue(remove && plugin.settings.TRASH_DELETED_PAGES === true).setDisabled(pending || !remove)
    }
    const updateCleanup = async (change: (current: Settings) => Partial<Settings>) => {
        if (pending) return
        pending = true
        refreshCleanup()
        try { await saveChange(plugin, change) }
        catch (error) { new Notice(uiDiagnostic(error, t)) }
        finally { pending = false; refreshCleanup() }
    }
    deletionRow.addDropdown(dropdown => {
        action = dropdown
        dropdown.addOption('keep', t('Keep text and ID', 'Оставлять текст и ID'))
            .addOption('remove', t('Remove card block', 'Удалять блок карточки'))
            .addOption('mark', t('Keep and mark as deleted', 'Сохранять с пометкой «Удалено из Anki»'))
            .addOption('strike', t('Strike through the whole card', 'Зачёркивать всю карточку'))
            .addOption('hidden', t('Hide in an HTML comment', 'Скрывать в HTML-комментарии'))
            .onChange(value => {
                if (!isAfterDeleteMode(value)) { refreshCleanup(); return }
                return updateCleanup(current => ({
                    AFTER_DELETE_MODE: value,
                    MARK_DELETED_BLOCKS: value === 'mark', CLEAN_DELETED_BLOCKS: value === 'remove',
                    TRASH_DELETED_PAGES: value === 'remove' && current.TRASH_DELETED_PAGES === true,
                }))
            })
    })
    new Setting(body).setName(t('Move deleted card pages to trash', 'Перемещать удалённые страницы-карточки в корзину'))
        .setDesc(t('Available with Remove card block. Applies to whole files marked as @page cards.',
            'Доступно в режиме «Удалять блок карточки». Относится к целым файлам с карточкой @page.'))
        .addToggle(toggle => {
            pages = toggle
            toggle.onChange(value => updateCleanup(current => ({
                TRASH_DELETED_PAGES: afterDeleteMode(current) === 'remove' && value,
            })))
        })
    refreshCleanup()
    new Setting(body).setName(t('Shared fields in the current note', 'Общие поля текущей заметки'))
        .setDesc(t('Choose an Anki note type and add shared values to its fields, such as a source and a chapter.',
            'Выберите тип записи Anki и заполните общие поля, например источник и главу.'))
        .addButton(button => button.setButtonText(t('Edit shared fields', 'Редактировать общие поля')).onClick(() => openFrozenFields(plugin)))
    new Setting(body).setName(legacySettingLabel('Frozen Fields Line', t))
        .addText(text => bindSyntaxEdit(text, plugin, 'Frozen Fields Line', 'FROZEN'))
}
