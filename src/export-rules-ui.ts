/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Modal, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { validateExportRules } from './export-rules'
import type { ExportRule, ExportRuleField, ExportRuleFieldSource } from './export-rules'
import { installModalLayout } from './modal-layout'
import type { SyncFolderProfile } from './sync-profiles'

type SaveRules = (rules: ExportRule[]) => Promise<void>

class ExportRulesModal extends Modal {
    private readonly rules: ExportRule[]
    private readonly invalid: boolean
    private busy = false

    constructor(private readonly plugin: MyPlugin, private readonly profile: SyncFolderProfile,
        private readonly saveRules: SaveRules, private readonly afterSave: () => void) {
        super(plugin.app)
        const rules = validateExportRules(profile.exportRules ?? [])
        this.invalid = !rules
        this.rules = rules ?? []
    }

    onOpen(): void {
        this.modalEl.classList.add('rudonium-modal-58rem')
        installModalLayout(this, uiFor(this.plugin.settings))
        this.render()
    }

    onClose(): void {
        this.contentEl.empty()
    }

    private render(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t(`Export Rules · ${this.profile.name}`, `Правила экспорта · ${this.profile.name}`))
        this.contentEl.empty()
        this.contentEl.createEl('p', { text: t(
            'Rules are checked from top to bottom for each parsed card. All specified conditions must match.',
            'Правила проверяются сверху вниз для каждой распознанной карточки. Должны совпасть все заданные условия.') })
        this.contentEl.createEl('p', { text: t(
            'A deck written in the note takes priority. Existing Anki records keep their type; rules can only update matching records.',
            'Колода, указанная в заметке, имеет приоритет. Тип уже связанной записи сохраняется. Правило может обновить запись при совпадении типа.') })
        if (this.invalid) this.contentEl.createEl('p', { text: t(
            'The stored rules could not be read. You can replace them by saving this list.',
            'Сохранённые правила не удалось прочитать. Можно заменить их, сохранив этот список.') })
        const list = this.contentEl.createDiv()
        for (let index = 0; index < this.rules.length; index++) this.renderRule(list, this.rules[index], index, t)
        const status = this.contentEl.createEl('p', { attr: { role: 'status' } })
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        const add = footer.createEl('button', { text: t('Add Rule', 'Добавить правило') })
        const save = footer.createEl('button', { text: t('Save Rules', 'Сохранить правила'), cls: 'mod-cta' })
        add.disabled = this.rules.length >= 64
        add.onclick = () => {
            if (this.busy || this.rules.length >= 64) return
            this.rules.push({ id: crypto.randomUUID(), name: '', fields: [], tags: [] })
            this.render()
        }
        save.onclick = async () => {
            if (this.busy) return
            const rules = validateExportRules(this.rules)
            if (!rules) {
                status.setText(t('Check each rule name and action. Every mapped target must be unique and have a valid source.',
                    'Проверьте название и действие каждого правила. Для каждого поля назначения нужен один допустимый источник.'))
                return
            }
            const invalid = rules.find(rule => rule.model && !Object.prototype.hasOwnProperty.call(this.plugin.fields_dict, rule.model) ||
                rule.model && rule.fields.some(field => !this.plugin.fields_dict[rule.model!]?.includes(field.target)))
            if (invalid) {
                status.setText(t(`Check the model and target fields of “${invalid.name}”.`,
                    `Проверьте модель и поля назначения правила «${invalid.name}».`))
                return
            }
            this.busy = true
            save.disabled = true
            add.disabled = true
            try {
                await this.saveRules(rules)
                this.close()
                this.afterSave()
            } catch (error) {
                status.setText(uiDiagnostic(error, t))
            } finally {
                this.busy = false
                save.disabled = false
                add.disabled = this.rules.length >= 64
            }
        }
    }

    private renderRule(parent: HTMLElement, rule: ExportRule, index: number, t: UiText): void {
        const section = parent.createEl('section')
        section.createEl('h3', { text: t(`Rule ${index + 1}`, `Правило ${index + 1}`) })
        const text = (name: string, current: string | undefined, change: (value: string) => void, placeholder = '') => {
            new Setting(section).setName(name).addText(input => input.setPlaceholder(placeholder).setValue(current ?? '')
                .onChange(value => { if (!this.busy) change(value.trim()) }))
        }
        text(t('Rule name', 'Название правила'), rule.name, value => { rule.name = value })
        text(t('Folder path', 'Путь папки'), rule.folder, value => { rule.folder = value || undefined }, 'Knowledge/Places')
        text(t('Heading', 'Заголовок'), rule.heading, value => { rule.heading = value || undefined },
            t('A Markdown heading without #', 'Заголовок Markdown без #'))
        const updateProperty = (key: string, value: string) => { rule.property = key || value ? { key, value } : undefined }
        text(t('YAML property name', 'Имя свойства YAML'), rule.property?.key,
            value => updateProperty(value, rule.property?.value ?? ''), 'category')
        text(t('YAML property value', 'Значение свойства YAML'), rule.property?.value,
            value => updateProperty(rule.property?.key ?? '', value), 'dictionary')
        new Setting(section).setName(t('Anki note type', 'Тип записи Anki')).addDropdown(select => {
            select.addOption('', t('Use the parsed type', 'Использовать распознанный тип'))
            const models = [...new Set([...Object.keys(this.plugin.fields_dict), ...(rule.model ? [rule.model] : [])])].sort()
            for (const model of models) select.addOption(model, model)
            select.setValue(rule.model ?? '').onChange(value => { if (!this.busy) rule.model = value || undefined })
        })
        text(t('Target deck', 'Колода назначения'), rule.deck, value => { rule.deck = value || undefined })
        text(t('Additional tags', 'Дополнительные теги'), rule.tags.join(' '),
            value => { rule.tags = value.split(/\s+/u).filter(Boolean).map(tag => tag.replace(/^#/, '').replace(/\//g, '::')) },
            'dictionary de')
        for (const field of rule.fields) this.renderField(section, rule, field, t)
        const controls = section.createDiv({ cls: 'modal-button-container' })
        controls.classList.add('rudonium-wrap-controls')
        const addField = controls.createEl('button', { text: t('Map Field', 'Сопоставить поле') })
        addField.disabled = rule.fields.length >= 64
        addField.onclick = () => {
            if (this.busy || rule.fields.length >= 64) return
            rule.fields.push({ target: '', source: 'field', value: '' })
            this.render()
        }
        const move = (distance: number) => {
            if (this.busy || index + distance < 0 || index + distance >= this.rules.length) return
            const adjacent = index + distance
            this.rules[index] = this.rules[adjacent]
            this.rules[adjacent] = rule
            this.render()
        }
        const up = controls.createEl('button', { text: t('Move Up', 'Выше') })
        up.disabled = index === 0
        up.onclick = () => move(-1)
        const down = controls.createEl('button', { text: t('Move Down', 'Ниже') })
        down.disabled = index === this.rules.length - 1
        down.onclick = () => move(1)
        const remove = controls.createEl('button', { text: t('Remove Rule', 'Удалить правило') })
        remove.onclick = () => { if (!this.busy) { this.rules.splice(index, 1); this.render() } }
    }

    private renderField(parent: HTMLElement, rule: ExportRule, field: ExportRuleField, t: UiText): void {
        const sourceTitle: Record<ExportRuleFieldSource, string> = {
            field: t('Parsed field', 'Поле карточки'),
            property: t('YAML property', 'Свойство YAML'),
            text: t('Fixed text', 'Заданный текст'),
        }
        new Setting(parent).setName(t('Field mapping', 'Сопоставление поля'))
            .addText(input => {
                input.inputEl.setAttribute('aria-label', t('Target field name', 'Имя поля назначения'))
                input.setPlaceholder(t('Target field', 'Поле назначения')).setValue(field.target)
                    .onChange(value => { if (!this.busy) field.target = value.trim() })
            })
            .addDropdown(select => {
                select.selectEl.setAttribute('aria-label', t('Value source', 'Источник значения'))
                for (const [value, label] of Object.entries(sourceTitle)) select.addOption(value, label)
                select.setValue(field.source).onChange(value => {
                    if (!this.busy && (value === 'field' || value === 'property' || value === 'text')) {
                        field.source = value
                        if (value !== 'text') field.value = field.value.trim()
                    }
                })
            })
            .addText(input => {
                input.inputEl.setAttribute('aria-label', t('Source name or text', 'Имя источника или текст'))
                input.setPlaceholder(t('Source name or text', 'Имя источника или текст')).setValue(field.value)
                    .onChange(value => { if (!this.busy) field.value = field.source === 'text' ? value : value.trim() })
            })
            .addButton(button => button.setButtonText(t('Remove', 'Убрать')).onClick(() => {
                if (this.busy) return
                rule.fields = rule.fields.filter(item => item !== field)
                this.render()
            }))
    }
}

export function openExportRulesEditor(plugin: MyPlugin, profile: SyncFolderProfile,
    save: SaveRules, afterSave: () => void): void {
    new ExportRulesModal(plugin, profile, save, afterSave).open()
}
