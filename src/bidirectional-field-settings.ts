/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal, Notice, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { isBidirectionalFieldName, isGeneratedBidirectionalField, readBidirectionalFieldRules } from './bidirectional-fields'
import type { BidirectionalFieldDirection, BidirectionalFieldRule } from './bidirectional-fields'
import { addPreviewPreference } from './bidirectional-preview-preference'
import { previewBidirectionalSync } from './bidirectional-sync'
import { withFastScanReadLock } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import { installModalLayout } from './modal-layout'
import { pageCardExpression } from './card-format-presets'
import { isDeckPageSchema, isLinkedPageSchema } from './page-card'
import { pageFieldIsAvailable } from './page-named-fields'
import { isWritableBlockExtraName } from './bidirectional-blocks'

const openDialogs = new WeakMap<MyPlugin, Modal>()
const migratedPairs = [['ob-deck-front', 'ob-deck-back'], ['Front', 'Back'], ['Question', 'Answer']] as const

type DirectionSettings = Pick<MyPlugin['settings'], 'CUSTOM_REGEXPS' | 'PAGE_MODEL' | 'FILE_LINK_FIELDS' | 'CONTEXT_FIELDS'>

export function selectableDirectionFields(models: Record<string, string[]>, settings: DirectionSettings) {
    const pageModel = Object.entries(settings.CUSTOM_REGEXPS ?? {}).find(([, expression]) => expression === pageCardExpression)?.[0]
        ?? settings.PAGE_MODEL
    return Object.entries(models).map(([model, fields]) => {
        const mapped = { file: settings.FILE_LINK_FIELDS?.[model], context: settings.CONTEXT_FIELDS?.[model] }
        const plain = fields.filter(name => isBidirectionalFieldName(name) && !isGeneratedBidirectionalField(settings, model, name))
        const serviceKey = fields[0] === 'ForgeKey' || fields[0] === 'CardKey'
        const fieldPair = isDeckPageSchema(model, fields) || serviceKey
            ? migratedPairs.find(pair => isLinkedPageSchema(model, fields, pair)) : undefined
        const conventional = fields.includes('Front') && fields.includes('Back')
        const primary = fields.slice(0, 2)
        const positional = primary.length === 2 && primary[0] !== primary[1] && primary.every((name, i) =>
            name === (i ? 'Back' : 'Front') || isWritableBlockExtraName(name))
        if (fieldPair || model === pageModel && positional) {
            return [model, plain.filter(name => pageFieldIsAvailable(name, { fieldPair }, fields, mapped))] as const
        }
        if (conventional) return [model, plain] as const
        return [model, positional ? plain.filter(name => !primary.includes(name) && isWritableBlockExtraName(name)) : []] as const
    }).filter(([, fields]) => fields.length > 0)
}

class BidirectionalFieldSettingsModal extends Modal {
    private readonly initial: string
    private rules: BidirectionalFieldRule[]
    private busy = false

    constructor(private readonly plugin: MyPlugin) {
        super(plugin.app)
        this.rules = readBidirectionalFieldRules(plugin.settings.BIDIRECTIONAL_FIELDS)
        this.initial = JSON.stringify(this.rules)
    }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Additional Sync Fields', 'Дополнительные поля синхронизации'))
        installModalLayout(this, t)
        this.render()
    }

    onClose(): void { openDialogs.delete(this.plugin) }

    private render(): void {
        const { plugin, contentEl } = this
        const t = uiFor(plugin.settings)
        contentEl.empty()
        contentEl.createEl('p', { text: t(
            'For linked START/END blocks and card pages, editable named fields sync both ways by default. Choose a direction below to override it for one field.',
            'В связанных блоках START/END и на страницах-карточках редактируемые именованные поля по умолчанию передаются в обе стороны. Ниже можно изменить направление для отдельного поля.') })
        contentEl.createEl('p', { text: t(
            'Use a line such as Notes: Example in a block or page field section. On a single-line card use :: X[Notes]=Example and set its direction here.',
            'В блоке или в разделе полей страницы добавьте строку, например Notes: Пример. В однострочной карточке добавьте :: X[Notes]=Пример и задайте здесь направление.') })
        const labels: Record<BidirectionalFieldDirection, string> = {
            both: t('Both directions', 'В обе стороны'), 'to-anki': 'Obsidian → Anki', 'to-obsidian': 'Anki → Obsidian',
        }
        const list = contentEl.createEl('ul')
        this.rules.forEach(({ model, field, direction }, index) => {
            const row = list.createEl('li')
            row.createSpan({ text: `${model} · ${field} · ${labels[direction]} ` })
            row.createEl('button', { text: t('Remove', 'Убрать'),
                attr: { 'aria-label': t(`Remove rule for ${field} in ${model}`, `Убрать правило для ${field} в ${model}`) } }).onclick = () => {
                if (this.busy) return
                this.rules.splice(index, 1)
                this.render()
            }
        })
        const available = selectableDirectionFields(plugin.fields_dict ?? {}, plugin.settings)
        const controls = contentEl.createDiv({ cls: 'modal-button-container' })
        controls.classList.add('rudonium-wrap-controls')
        const model = controls.createEl('select', { attr: { 'aria-label': t('Anki note type', 'Тип записи Anki') } })
        const field = controls.createEl('select', { attr: { 'aria-label': t('Additional Anki field', 'Дополнительное поле Anki') } })
        const direction = controls.createEl('select', { attr: { 'aria-label': t('Sync direction', 'Направление синхронизации') } })
        for (const [name] of available) model.createEl('option', { value: name, text: name })
        for (const [value, label] of Object.entries(labels)) direction.createEl('option', { value, text: label })
        const add = controls.createEl('button', { text: t('Set Rule', 'Задать правило') })
        const refreshFields = () => {
            field.empty()
            for (const name of available.find(([name]) => name === model.value)?.[1] ?? []) {
                field.createEl('option', { value: name, text: name })
            }
            add.disabled = !field.value
        }
        model.onchange = refreshFields
        refreshFields()
        add.onclick = () => {
            if (this.busy || !available.find(([name]) => name === model.value)?.[1].includes(field.value)) return
            const choice = direction.value as BidirectionalFieldDirection
            const current = this.rules.find(rule => rule.model === model.value && rule.field === field.value)
            if (current) current.direction = choice
            else if (this.rules.length < 256) this.rules.push({ model: model.value, field: field.value, direction: choice })
            this.render()
        }
        if (!available.length) contentEl.createEl('p', { text: t(
            'Refresh the Anki note types to configure eligible fields.', 'Обновите список типов записей Anki для настройки доступных полей.') })
        const save = contentEl.createDiv({ cls: 'modal-button-container' })
            .createEl('button', { text: t('Save', 'Сохранить'), cls: 'mod-cta' })
        save.disabled = this.busy || this.initial === JSON.stringify(this.rules)
        save.onclick = () => {
            if (this.busy || save.disabled) return
            this.busy = true
            save.disabled = true
            const rules = this.rules.map(rule => ({ ...rule }))
            void withFastScanReadLock(plugin, async () => {
                const previous = plugin.settings.BIDIRECTIONAL_FIELDS
                if (JSON.stringify(readBidirectionalFieldRules(previous)) !== this.initial) {
                    throw new Error(t('The field rules changed. Reopen the settings.', 'Правила полей изменились. Откройте настройки заново.'))
                }
                plugin.settings.BIDIRECTIONAL_FIELDS = rules
                try { await plugin.saveAllData() } catch (error) {
                    plugin.settings.BIDIRECTIONAL_FIELDS = previous
                    throw error
                }
            }).then(() => this.close(), error => {
                this.busy = false
                save.disabled = false
                new Notice(uiDiagnostic(error, t))
            })
        }
    }
}

function openBidirectionalFieldSettings(plugin: MyPlugin): void {
    if (openDialogs.has(plugin)) return
    const dialog = new BidirectionalFieldSettingsModal(plugin)
    openDialogs.set(plugin, dialog)
    dialog.open()
}

export function installBidirectionalSettings(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    type Flag = 'BIDIRECTIONAL_SYNC' | 'SKIP_SYNC_ERRORS'
    const toggleRow = (row: Setting, key: Flag, changed?: () => void) => row.addToggle(toggle =>
        toggle.setValue(plugin.settings[key] === true).onChange(async value => {
            toggle.setDisabled(true)
            try {
                await withFastScanReadLock(plugin, async () => {
                    const previous = plugin.settings[key]
                    plugin.settings[key] = value
                    try { await plugin.saveAllData() } catch (error) {
                        if (previous === undefined) delete plugin.settings[key]
                        else plugin.settings[key] = previous
                        throw error
                    }
                })
            } catch (error) {
                toggle.setValue(plugin.settings[key] === true)
                new Notice(uiDiagnostic(error, t))
            } finally {
                toggle.setDisabled(false)
                changed?.()
            }
        }))
    toggleRow(new Setting(container)
        .setName(t('Skip recoverable card errors', 'Пропускать ошибки отдельных карточек'))
        .setDesc(t('Continue with other cards and report skipped records.',
            'Обрабатывать остальные карточки и показывать пропущенные записи.')), 'SKIP_SYNC_ERRORS')
    const mode = new Setting(container).setName(t('Bidirectional sync', 'Двусторонняя синхронизация'))
        .setDesc(t('Reads linked Anki notes on each run. A full check can take around 10× as long as one-way export, depending on the collection.',
            'При каждом запуске читает связанные записи Anki. Полная проверка может занять примерно в 10 раз больше времени, чем односторонний экспорт. Время зависит от коллекции.'))
    const options = container.createDiv()
    const update = () => { options.hidden = plugin.settings.BIDIRECTIONAL_SYNC !== true }
    toggleRow(mode, 'BIDIRECTIONAL_SYNC', update)
    addPreviewPreference(options, plugin, 'settings')
    new Setting(options)
        .addButton(button => button.setButtonText(t('Preview now', 'Открыть предпросмотр')).onClick(() => previewBidirectionalSync(plugin)))
        .addButton(button => button.setButtonText(t('Additional fields', 'Дополнительные поля')).onClick(() => openBidirectionalFieldSettings(plugin)))
    update()
}
