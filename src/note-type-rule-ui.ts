// SPDX-License-Identifier: GPL-3.0-only
import { addRegexpWizard } from './regexp-wizard'
import { Setting } from 'obsidian'
import type MyPlugin from '../main'
import { cardFormatPresets, knowledgeBulletExpression, pageCardExpression } from './card-format-presets'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { applyRuleSettings, configuredModels, customExpressionProblem, presetId, readRule, ruleProblem, withRule } from './note-type-rules'
import type { NoteTypeRule } from './note-type-rules'
import { withFastScanReadLock } from './fast-scan'
import { readDelimitedRule } from './delimited-rule'
import { previewRuleOnNote, showRuleReport } from './rule-note-preview'
import { createSettingsGroup } from './settings-layout'

export function formatControl(container: HTMLElement, t: UiText, expression: string, custom: boolean,
    change: (expression: string, custom: boolean) => void, input: (expression: string) => void): void {
    const item = new Setting(container).setName(t('Card format', 'Формат карточки'))
    item.addDropdown(list => {
        for (const preset of cardFormatPresets) list.addOption(preset.id, t(preset.en, preset.ru))
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

function ruleFormat(expression: string, fields: string[], t: UiText): string {
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

export function installNoteTypeRules(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const body = createSettingsGroup(container, plugin, 'note-types', t('Note type rules', 'Правила типов записей'))
    body.createDiv({ cls: 'anki-note-type-refresh', attr: { 'data-anki-note-type-refresh': '' } })
    const list = body.createDiv()
    let editing: { draft: NoteTypeRule; original: NoteTypeRule; isNew: boolean; custom: boolean; wizardFields?: string[] } | undefined
    let busy = false
    let review: AbortController | undefined
    const render = () => {
        review?.abort()
        list.empty()
        const models = configuredModels(plugin.settings, plugin.fields_dict)
        const available = Object.keys(plugin.fields_dict).filter(model => !models.includes(model))
        const edit = (model: string, isNew: boolean) => {
            const original = readRule(plugin.settings, model)
            editing = { original, draft: { ...original }, isNew, custom: presetId(original.expression) === 'custom' }
            render()
        }
        for (const model of models) {
            if (editing?.draft.model === model) continue
            const rule = readRule(plugin.settings, model)
            const format = ruleFormat(rule.expression, plugin.fields_dict[model], t)
            new Setting(list).setName(rule.name || model).setDesc(rule.name ? model + ' · ' + format : format)
                .addButton(button => button.setButtonText(t('Edit', 'Изменить')).setDisabled(!!editing).onClick(() => edit(model, false)))
        }
        if (!editing) {
            if (!models.length) list.createEl('p', { text: t('Add a rule to recognize your Markdown card format.', 'Добавьте правило, чтобы распознавать карточки вашего формата в Markdown.') })
            const add = list.createEl('button', { text: t('+ Add rule', '+ Добавить правило') })
            add.disabled = !available.length
            add.onclick = () => { if (available.length) edit(available[0], true) }
            return
        }
        const state = editing
        const { draft, original } = state
        const form = list.createEl('fieldset')
        form.createEl('legend', { text: state.isNew ? t('New rule', 'Новое правило') : draft.model })
        if (state.isNew) new Setting(form).setName(t('Note type', 'Тип записи')).addDropdown(control => {
            for (const model of available) control.addOption(model, model)
            control.setValue(draft.model).onChange(model => edit(model, true))
        })
        new Setting(form).setName(t('Rule name (optional)', 'Название правила (необязательно)')).addText(control => {
            control.inputEl.placeholder = draft.model
            control.setValue(draft.name ?? '').onChange(value => { draft.name = value.trim() })
        })
        formatControl(form, t, draft.expression, state.custom, (expression, custom) => {
            state.wizardFields = undefined
            draft.expression = expression
            state.custom = custom
            render()
        }, value => { state.wizardFields = undefined; draft.expression = value })
        const fields = plugin.fields_dict[draft.model] ?? []
        addRegexpWizard(form, plugin.app, t, fields, () => draft.expression, (pattern, _sample, values) => {
            draft.expression = pattern
            state.wizardFields = fields.slice(0, values.length)
            state.custom = true
            render()
        })
        const preset = !state.custom && cardFormatPresets.find(item => item.expression === draft.expression)
        if (preset && preset.expression) {
            form.createEl('pre', { text: preset.example })
            const pattern = form.createEl('details')
            pattern.createEl('summary', { text: preset.expression === pageCardExpression
                ? t('Page marker', 'Обозначение страницы') : t('Regular expression', 'Регулярное выражение') })
            pattern.createEl('code', { text: preset.expression })
            if (preset.expression === pageCardExpression) {
                pattern.createEl('p', { text: t(
                    'Mark the note with #anki-page. Its first H1 is the question. For extra Anki fields, add this section after the answer and use the exact field names.',
                    'Пометьте заметку тегом #anki-page. Первый заголовок уровня 1 станет вопросом. Для дополнительных полей добавьте после ответа такой раздел с точными названиями полей Anki.') })
                pattern.createEl('pre', { text: '<!--anki-fields-->\n' + t('Field name: value', 'Название поля: значение') })
            }
        }
        const mapping = (name: string, key: 'file' | 'context') => new Setting(form).setName(name).addDropdown(control => {
            control.addOption('', t('None', 'Без поля'))
            for (const field of fields) control.addOption(field, field)
            control.setValue(draft[key]).onChange(value => { draft[key] = value })
        })
        mapping(t('File link field', 'Поле ссылки на файл'), 'file')
        mapping(t('Context field', 'Поле контекста'), 'context')
        const status = form.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        const check = form.createEl('button', { text: t('Check current note', 'Проверить на текущей заметке') })
        const report = form.createDiv()
        const resetReview = () => { review?.abort(); report.empty(); status.setText(''); check.disabled = false }
        form.addEventListener?.('input', resetReview)
        form.addEventListener?.('change', resetReview)
        check.onclick = async () => {
            resetReview()
            const request = review = new AbortController()
            check.disabled = true
            try {
                const issue = (state.custom && customExpressionProblem(draft.expression, t)) ||
                    ruleProblem({ ...plugin.settings, CUSTOM_REGEXPS: {} }, plugin.fields_dict, draft, t)
                if (issue) throw new Error(issue)
                status.setText(t('Checking…', 'Идёт проверка…'))
                const result = await previewRuleOnNote(plugin, { ...draft }, request.signal, () => !form.isConnected)
                if (!request.signal.aborted && form.isConnected) {
                    showRuleReport(report, result, t)
                    status.setText('')
                }
            } catch (error) {
                if (!request.signal.aborted) status.setText(uiDiagnostic(error, t))
            } finally { if (review === request) check.disabled = false }
        }
        const controls = form.createDiv({ cls: 'modal-button-container' })
        const persist = async (remove: boolean) => {
            if (busy) return
            form.disabled = busy = true
            try {
                await withFastScanReadLock(plugin, async () => {
                    const settings = plugin.settings
                    const current = readRule(settings, draft.model)
                    if (current.name !== original.name || current.expression !== original.expression || current.file !== original.file || current.context !== original.context) {
                        throw new Error(t('This rule changed. Cancel and reopen it.', 'Правило изменилось. Отмените правку и откройте его заново.'))
                    }
                    if (!remove) {
                        if (state.wizardFields?.some((name, i) => plugin.fields_dict[draft.model]?.[i] !== name)) {
                            throw new Error(t('The Anki field order changed. Reopen the regular expression wizard.',
                                'Порядок полей Anki изменился. Откройте мастер регулярных выражений заново.'))
                        }
                        const issue = (state.custom && customExpressionProblem(draft.expression, t)) || ruleProblem(settings, plugin.fields_dict, draft, t)
                        if (issue) throw new Error(issue)
                    }
                    const rollback = applyRuleSettings(settings, withRule(settings, draft, remove, state.wizardFields))
                    try { await plugin.saveAllData() }
                    catch (error) { rollback(); throw error }
                })
                editing = undefined
                render()
            } catch (error) { status.setText(uiDiagnostic(error, t)) }
            finally { busy = form.disabled = false }
        }
        const save = controls.createEl('button', { cls: 'mod-cta', text: t('Save rule', 'Сохранить правило') })
        save.onclick = () => void persist(false)
        controls.createEl('button', { text: t('Cancel', 'Отмена') }).onclick = () => { editing = undefined; render() }
        if (!state.isNew) controls.createEl('button', { text: t('Remove rule', 'Убрать правило') }).onclick = () => void persist(true)
    }
    render()
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
