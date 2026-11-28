// SPDX-License-Identifier: GPL-3.0-only
import { addRegexpWizard } from './regexp-wizard'
import { Modal, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { cardFormatPresets, explicitExample, knowledgeBulletExpression, pageCardExpression, presetExample, remNoteExpression, tutorialFields } from './card-format-presets'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { applyRuleSettings, configuredModels, customExpressionProblem, presetId, readRule, ruleProblem, withRule } from './note-type-rules'
import type { NoteTypeRule, RuleSettings } from './note-type-rules'
import { withFastScanReadLock } from './fast-scan'
import { copyBlock } from './copy-block'
import { installModalLayout } from './modal-layout'
import { customRegexpKey, matchCustomRegexps } from './custom-regexp-worker'
import { readDelimitedRule } from './delimited-rule'
import { previewRuleOnNote, showRuleReport } from './rule-note-preview'
import { createSettingsGroup, rememberGroup } from './settings-layout'

type Syntax = MyPlugin['settings']['Syntax']
function markerPair(syntax?: Syntax): string {
    return (syntax?.['Begin Note'] ?? 'START') + ' / ' + (syntax?.['End Note'] ?? 'END')
}

export function formatControl(container: HTMLElement, t: UiText, expression: string, custom: boolean,
    change: (expression: string, custom: boolean) => void, input: (expression: string) => void, syntax?: Syntax): void {
    const item = new Setting(container).setName(t('Card format', 'Формат карточки'))
    item.addDropdown(list => {
        for (const preset of cardFormatPresets) list.addOption(preset.id, preset.id === 'explicit' ? markerPair(syntax) : t(preset.en, preset.ru))
        list.addOption('custom', t('Custom regular expression', 'Своё регулярное выражение'))
        list.setValue(custom ? 'custom' : presetId(expression)).onChange(id => {
            if (id === 'custom') change(expression === pageCardExpression ? '' : expression, true)
            else {
                const selected = cardFormatPresets.find(preset => preset.id === id)
                if (selected) change(selected.expression, false)
            }
        })
    })
    if (custom) new Setting(container).setName(t('Regular expression', 'Регулярное выражение'))
        .setDesc(t('Capture groups fill Anki fields in order.', 'Группы захвата заполняют поля Anki по порядку.'))
        .addTextArea(area => {
            area.inputEl.spellcheck = false
            area.setValue(expression).onChange(input)
        })
}

function ruleFormat(expression: string, fields: string[], t: UiText, syntax?: Syntax): string {
    if (!expression) return markerPair(syntax)
    const preset = cardFormatPresets.find(item => item.expression === expression)
    if (preset) return t(preset.en, preset.ru)
    if (expression === knowledgeBulletExpression) return t('- Question :: Answer [:: R] [:: F=en_US] [:: B=de_DE]',
        '- Вопрос :: Ответ [:: R] [:: F=en_US] [:: B=de_DE]')
    const layout = readDelimitedRule(expression)
    if (!layout) return expression.length > 76 ? expression.slice(0, 75) + '…' : expression
    const names = fields.slice(0, layout.count)
    if (layout.multiline) return names.slice(0, -1).join(' ' + layout.separator + ' ') + t(' · Answer below', ' · Ответ ниже')
    return names.join(' ' + layout.separator + ' ')
}

type FieldMap = Record<string, string[]>

interface RuleHost {
    fields: () => FieldMap
    settings: () => RuleSettings
    stage?: (updated: Required<RuleSettings>) => void
}

function renderRuleList(container: HTMLElement, plugin: MyPlugin, host: RuleHost): () => void {
    const t = uiFor(plugin.settings)
    const list = container.createDiv({ cls: 'rudonium-rule-list' })
    let editor: RuleEditor | undefined
    function open(model: string, isNew: boolean): void {
        editor = new RuleEditor(plugin, host, model, isNew, () => { editor = undefined }, render)
        editor.open()
    }
    function render(): void {
        list.empty()
        const settings = host.settings(), fields = host.fields()
        const models = configuredModels(settings, fields)
        for (const model of models) {
            const rule = readRule(settings, model)
            const format = ruleFormat(rule.expression, fields[model], t, plugin.settings.Syntax)
            new Setting(list).setName(rule.name || model).setDesc(rule.name ? model + ' · ' + format : format)
                .addButton(button => button.setButtonText(t('Edit', 'Изменить')).onClick(() => open(model, false)))
        }
        const available = Object.keys(fields).filter(model => !models.includes(model))
        const add = list.createEl('button', { text: t('Add note type', 'Добавить тип записи') })
        add.disabled = !available.length
        if (available.length) add.onclick = () => open(available[0], true)
    }
    render()
    return () => editor?.close()
}

export function renderQuickStartNoteTypeRules(container: HTMLElement, plugin: MyPlugin, fields: FieldMap,
    getSettings: () => RuleSettings, onChange: (updated: Required<RuleSettings>) => void): () => void {
    const group = container.createEl('fieldset', { cls: 'rudonium-quick-start-types' })
    group.createEl('legend', { text: uiFor(plugin.settings)('Note types', 'Типы записей') })
    return renderRuleList(group, plugin, { fields: () => fields, settings: getSettings, stage: onChange })
}

export function installNoteTypeRules(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const body = createSettingsGroup(container, plugin, 'note-types', t('Note type rules', 'Правила типов записей'))
    renderRuleList(body, plugin, { fields: () => plugin.fields_dict, settings: () => plugin.settings })
    body.createDiv({ cls: 'anki-note-type-refresh', attr: { 'data-anki-note-type-refresh': '' } })
}

class RuleEditor extends Modal {
    private original: NoteTypeRule
    private draft: NoteTypeRule
    private custom: boolean
    private wizardFields?: string[]
    private sample = ''
    private sampleValues?: string[]
    private tools?: HTMLDetailsElement
    private closeWizard?: () => void
    private request?: AbortController
    private closed = false
    private saving = false
    private readonly t: UiText

    constructor(private readonly plugin: MyPlugin, private readonly host: RuleHost, model: string,
        private readonly isNew: boolean, private readonly dismissed: () => void, private readonly saved: () => void) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
        this.original = readRule(host.settings(), model)
        this.draft = { ...this.original }
        this.custom = presetId(this.draft.expression) === 'custom'
    }

    onOpen(): void {
        installModalLayout(this, this.t)
        this.contentEl.classList.add('rudonium-rule-editor')
        this.render()
    }

    onClose(): void {
        this.closed = true
        this.closeWizard?.()
        this.request?.abort()
        this.contentEl.empty()
        this.dismissed()
    }

    private async verifySample(signal: AbortSignal): Promise<string[]> {
        const pattern = { source: this.draft.expression, flags: 'gm', label: this.draft.model }
        const result = await matchCustomRegexps(this.sample, [pattern], { signal })
        const matches = result.get(customRegexpKey(pattern)) ?? []
        if (matches.length !== 1 || !matches[0][1]) throw new Error(this.t(
            'Enter one sample card that matches the pattern and captures its first field.',
            'Введите одну карточку, которая подходит под выражение и заполняет первое поле.'))
        return matches[0].slice(1)
    }

    private render(): void {
        this.request?.abort()
        this.contentEl.empty()
        const { host, plugin, t, draft } = this
        this.titleEl.setText(this.isNew ? t('Add note type', 'Добавить тип записи') : t('Edit note type', 'Изменить тип записи') + ' · ' + draft.model)
        const form = this.contentEl.createEl('fieldset', { cls: 'rudonium-rule-form' })
        if (this.isNew) new Setting(form).setName(t('Note type', 'Тип записи')).addDropdown(control => {
            const configured = configuredModels(host.settings(), host.fields())
            for (const model of Object.keys(host.fields())) if (!configured.includes(model)) control.addOption(model, model)
            control.setValue(draft.model).onChange(model => {
                this.original = readRule(host.settings(), model)
                this.draft = { ...this.original }
                this.custom = presetId(this.draft.expression) === 'custom'
                this.sample = ''
                this.sampleValues = this.wizardFields = undefined
                this.render()
            })
        })
        new Setting(form).setName(t('Rule name (optional)', 'Название правила (необязательно)')).addText(control => {
            control.inputEl.placeholder = draft.model
            control.setValue(draft.name ?? '').onChange(value => { draft.name = value.trim() })
        })
        const syntax = plugin.settings.Syntax
        formatControl(form, t, draft.expression, this.custom, (expression, custom) => {
            draft.expression = expression
            this.custom = custom
            this.sampleValues = this.wizardFields = undefined
            this.render()
        }, value => {
            draft.expression = value
            this.sampleValues = this.wizardFields = undefined
            showCard()
        }, syntax)
        const fields = host.fields()[draft.model] ?? []
        const preset = this.custom ? undefined : cardFormatPresets.find(item => item.expression === draft.expression)
        const remNote = preset?.expression === remNoteExpression
        if (preset?.expression) {
            const pattern = form.createEl('details')
            const expression = preset.expression
            pattern.createEl('summary', { text: remNote ? t('RemNote regular expression', 'Регулярное выражение RemNote') :
                expression === pageCardExpression ? t('Page marker', 'Обозначение страницы') : t('Regular expression', 'Регулярное выражение') })
            copyBlock(pattern, expression, remNote ? t('Copy RemNote regular expression', 'Скопировать регулярное выражение RemNote') :
                t('Copy pattern', 'Скопировать шаблон'), t)
            if (expression === pageCardExpression) {
                pattern.createEl('p', { text: t(
                    'Mark the note with #anki-page. Its first H1 is the question. For extra Anki fields, add this section after the answer and use the exact field names.',
                    'Пометьте заметку тегом #anki-page. Первый заголовок уровня 1 станет вопросом. Для дополнительных полей добавьте после ответа такой раздел с точными названиями полей Anki.') })
                pattern.createEl('pre', { text: '<!--anki-fields-->\n' + t('Field name: value', 'Название поля: значение') })
            }
            rememberGroup(pattern, plugin, 'note-types-pattern')
        }
        if (preset && (preset.expression || fields.length >= 2)) {
            const text = preset.expression ? presetExample(preset, t) : explicitExample(
                syntax?.['Begin Note'] ?? 'START', syntax?.['End Note'] ?? 'END', draft.model, fields, t)
            form.createEl('pre', { text, cls: 'rudonium-rule-example' })
        }
        const presetCard = this.custom ? undefined : form.createEl('section', { cls: 'rudonium-first-connection-card' })
        const mapping = (name: string, key: 'file' | 'context') => new Setting(form).setName(name).addDropdown(control => {
            control.addOption('', t('None', 'Без поля'))
            for (const field of fields) control.addOption(field, field)
            control.setValue(draft[key]).onChange(value => { draft[key] = value })
        })
        mapping(t('File link field', 'Поле ссылки на файл'), 'file')
        mapping(t('Context field', 'Поле контекста'), 'context')
        const tools = form.createEl('details', { cls: 'rudonium-rule-tools' })
        tools.createEl('summary', { text: t('Rule tools', 'Инструменты правила') })
        tools.open = this.tools?.open ?? false
        this.tools = tools
        this.closeWizard = addRegexpWizard(tools, plugin.app, t, fields, () => draft.expression, (expression, sample, values) => {
            draft.expression = expression
            this.wizardFields = fields.slice(0, values.length)
            this.custom = true
            this.sample = sample
            this.sampleValues = values
            this.render()
        })
        if (this.custom) {
            new Setting(tools).setName(t('Sample Markdown', 'Пример Markdown')).addTextArea(control => {
                control.inputEl.spellcheck = false
                control.setValue(this.sample).onChange(value => { this.sample = value; this.sampleValues = undefined; showCard() })
            })
            tools.createEl('button', { text: t('Test sample', 'Проверить пример') }).onclick = async () => {
                const request = begin()
                try {
                    const values = await this.verifySample(request.signal)
                    if (!request.signal.aborted) { this.sampleValues = values; showCard() }
                } catch (error) { if (!request.signal.aborted) status.setText(uiDiagnostic(error, t)) }
            }
        }
        const card = presetCard ?? tools.createEl('section', { cls: 'rudonium-first-connection-card' })
        const showCard = () => {
            const values = this.custom ? this.sampleValues : fields.length >= 2 ? tutorialFields(t) : undefined
            card.empty()
            card.hidden = !values
            if (!values) return
            card.createEl('small', { text: t('Front', 'Лицевая сторона') })
            card.createDiv({ text: values[0] })
            card.createEl('small', { text: t('Back', 'Обратная сторона') })
            card.createDiv({ text: values[1] ?? '' })
        }
        showCard()
        const check = tools.createEl('button', { text: t('Check current note', 'Проверить на текущей заметке') })
        const report = tools.createDiv()
        const status = tools.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        const saveStatus = form.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        const reset = () => { this.request?.abort(); status.setText(''); saveStatus.setText(''); report.empty(); check.disabled = false }
        const begin = () => { reset(); return this.request = new AbortController() }
        form.addEventListener?.('input', reset)
        form.addEventListener?.('change', reset)
        check.onclick = async () => {
            const request = begin()
            check.disabled = true
            try {
                const issue = (this.custom && customExpressionProblem(draft.expression, t)) ||
                    ruleProblem({ CUSTOM_REGEXPS: {} }, host.fields(), draft, t)
                if (issue) throw new Error(issue)
                status.setText(t('Checking…', 'Идёт проверка…'))
                const result = await previewRuleOnNote(plugin, { ...draft }, request.signal, () => !form.isConnected, host.settings(), host.fields())
                if (!request.signal.aborted) { showRuleReport(report, result, t); status.setText('') }
            } catch (error) { if (!request.signal.aborted) status.setText(uiDiagnostic(error, t)) }
            finally { if (this.request === request) check.disabled = false }
        }
        const actions = form.createDiv({ cls: 'modal-button-container' })
        const persist = async (remove: boolean) => {
            if (this.saving) return
            form.disabled = this.saving = true
            const request = begin()
            try {
                const update = async () => {
                    if (this.closed || request.signal.aborted) return
                    const settings = host.settings()
                    const current = readRule(settings, draft.model)
                    const { original } = this
                    if (current.name !== original.name || current.expression !== original.expression || current.file !== original.file ||
                        current.context !== original.context || configuredModels(settings, host.fields()).includes(draft.model) === this.isNew) {
                        throw new Error(t('This rule changed. Cancel and reopen it.', 'Правило изменилось. Отмените правку и откройте его заново.'))
                    }
                    if (!remove) {
                        if (this.wizardFields?.some((name, i) => host.fields()[draft.model]?.[i] !== name)) {
                            throw new Error(t('The Anki field order changed. Reopen the regular expression wizard.',
                                'Порядок полей Anki изменился. Откройте мастер регулярных выражений заново.'))
                        }
                        const issue = (this.custom && customExpressionProblem(draft.expression, t)) || ruleProblem(settings, host.fields(), draft, t)
                        if (issue) throw new Error(issue)
                    }
                    const updated = withRule(settings, draft, remove, this.wizardFields)
                    if (host.stage) { host.stage(updated); return }
                    const rollback = applyRuleSettings(settings, updated)
                    try { await plugin.saveAllData() } catch (error) { rollback(); throw error }
                }
                if (host.stage) await update()
                else await withFastScanReadLock(plugin, update)
                if (!this.closed) this.close()
                this.saved()
            } catch (error) { if (!request.signal.aborted) saveStatus.setText(uiDiagnostic(error, t)) }
            finally { form.disabled = this.saving = false }
        }
        if (!this.isNew) actions.createEl('button', { text: t('Remove rule', 'Убрать правило') }).onclick = () => void persist(true)
        actions.createEl('button', { text: t('Cancel', 'Отмена') }).onclick = () => this.close()
        actions.createEl('button', { cls: 'mod-cta', text: t('Save rule', 'Сохранить правило') }).onclick = () => void persist(false)
    }
}

/** Compatibility path for source builds that inline the original table in the settings layout. */
export function replaceRenderedNoteTypeTable(container: HTMLElement, plugin: MyPlugin): void {
    const mount = container.createDiv()
    for (const table of Array.from(container.querySelectorAll<HTMLTableElement>('table.anki-settings-table'))) {
        if (table.tHead?.rows[0]?.cells[0]?.textContent?.trim() !== 'Note Type') continue
        const toggle = table.previousElementSibling
        const heading = toggle?.previousElementSibling
        if (toggle?.classList.contains('collapsible-item')) {
            if (heading?.tagName === 'H3' || heading?.classList.contains('setting-item-heading') &&
                heading.textContent?.trim() === 'Note type settings') heading.remove()
            toggle.remove()
        }
        table.before(mount)
        table.remove()
        break
    }
    installNoteTypeRules(mount, plugin)
}
