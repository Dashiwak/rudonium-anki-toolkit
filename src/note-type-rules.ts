// SPDX-License-Identifier: GPL-3.0-only
import { currentCardExpression, cardFormatPresets, pageCardExpression } from './card-format-presets'
import type { UiText } from './interface-language'

type Strings = Record<string, string>
export interface RuleSettings {
    CUSTOM_REGEXPS?: Strings
    INACTIVE_CUSTOM_REGEXPS?: Strings
    FILE_LINK_FIELDS?: Strings
    CONTEXT_FIELDS?: Strings
    NOTE_TYPE_RULE_NAMES?: Strings
    NOTE_TYPE_RULE_MODELS?: string[]
    REGEXP_WIZARD_FIELDS?: Record<string, string[]>
}
export interface NoteTypeRule {
    name?: string
    model: string
    expression: string
    file: string
    context: string
}

function own(map: Strings | undefined, key: string): string {
    return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : ''
}

export function readRule(settings: RuleSettings, model: string): NoteTypeRule {
    const name = own(settings.NOTE_TYPE_RULE_NAMES, model)
    return { model, ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}), expression: currentCardExpression(own(settings.CUSTOM_REGEXPS, model)), file: own(settings.FILE_LINK_FIELDS, model),
        context: own(settings.CONTEXT_FIELDS, model) }
}

export function configuredModels(settings: RuleSettings, fields: Record<string, string[]>): string[] {
    const saved = new Set(Array.isArray(settings.NOTE_TYPE_RULE_MODELS) ? settings.NOTE_TYPE_RULE_MODELS : [])
    // Older versions initialized every model's source link to its first field, even without a rule.
    return Object.keys(fields).filter(model => {
        const rule = readRule(settings, model)
        return saved.has(model) || !!rule.expression || !!rule.context || !!rule.file && rule.file !== fields[model][0]
    })
}

export function presetId(expression: string): string {
    return cardFormatPresets.find(item => item.expression === currentCardExpression(expression))?.id ?? 'custom'
}

export function customExpressionProblem(expression: string, t: UiText): string {
    if (!expression.trim()) return t('Enter a regular expression.', 'Введите регулярное выражение.')
    if (expression === pageCardExpression) return t('Select Whole page to use @page.', 'Для @page выберите формат «Целая страница».')
    return ''
}

export function ruleProblem(settings: RuleSettings, fields: Record<string, string[]>, rule: NoteTypeRule, t: UiText): string {
    if (!Object.prototype.hasOwnProperty.call(fields, rule.model)) return t('Refresh note types and select a current model.', 'Обновите типы записей и выберите существующий тип.')
    const names = fields[rule.model]
    if ([rule.file, rule.context].some(value => value && !names.includes(value))) return t('Choose a field from this note type.', 'Выберите поле из этого типа записи.')
    if (rule.expression === pageCardExpression && names.length < 2) return t('A page card needs two fields.', 'Для карточки-страницы нужны два поля.')
    if (rule.expression && Object.entries(settings.CUSTOM_REGEXPS ?? {}).some(([model, expression]) =>
        model !== rule.model && currentCardExpression(expression) === currentCardExpression(rule.expression))) {
        return t('This format is already assigned to another note type.', 'Этот формат уже назначен другому типу записи.')
    }
    if (rule.expression && rule.expression !== pageCardExpression) {
        if (rule.expression.length > 65536) return t('The expression exceeds 65,536 characters.', 'Длина выражения превышает 65 536 символов.')
        try {
            new RegExp(rule.expression, 'gm')
            // The empty first branch always wins. Count captures without running user code on the UI thread.
            const empty = new RegExp('(?:)|(?:' + rule.expression + ')', 'm').exec('')
            if (!empty || empty.length < 2) return t('Add a capture group for the first Anki field.', 'Добавьте группу захвата для первого поля Anki.')
        } catch (error) {
            return t('Check the regular expression. ', 'Проверьте регулярное выражение. ') + String(error)
        }
    }
    return ''
}

/** Change only the selected model. Optional field mappings stay intact when Quick Start edits a format. */
export function withRule(settings: RuleSettings, rule: NoteTypeRule, remove = false, chosenFields?: readonly string[]): Required<RuleSettings> {
    const pinned = new Set(Array.isArray(settings.NOTE_TYPE_RULE_MODELS) ? settings.NOTE_TYPE_RULE_MODELS : [])
    if (remove) pinned.delete(rule.model)
    else pinned.add(rule.model)
    const names = { ...settings.NOTE_TYPE_RULE_NAMES }
    if (remove || !rule.name?.trim()) delete names[rule.model]
    else Object.defineProperty(names, rule.model, { value: rule.name.trim(), writable: true, configurable: true, enumerable: true })
    const inactive = Object.fromEntries(Object.entries(settings.INACTIVE_CUSTOM_REGEXPS ?? {}))
    delete inactive[rule.model]
    const signatures = Object.fromEntries(Object.entries(settings.REGEXP_WIZARD_FIELDS ?? {}))
    if (chosenFields && !remove) Object.defineProperty(signatures, rule.model, {
        value: [...chosenFields], writable: true, configurable: true, enumerable: true,
    })
    else if (remove || readRule(settings, rule.model).expression !== rule.expression) delete signatures[rule.model]
    return {
        NOTE_TYPE_RULE_NAMES: names,
        REGEXP_WIZARD_FIELDS: signatures,
        INACTIVE_CUSTOM_REGEXPS: inactive,
        CUSTOM_REGEXPS: { ...settings.CUSTOM_REGEXPS, [rule.model]: remove ? '' : rule.expression },
        FILE_LINK_FIELDS: { ...settings.FILE_LINK_FIELDS, [rule.model]: remove ? '' : rule.file },
        CONTEXT_FIELDS: { ...settings.CONTEXT_FIELDS, [rule.model]: remove ? '' : rule.context },
        NOTE_TYPE_RULE_MODELS: Array.from(pinned),
    }
}

/** Restore both values and missing optional keys if writing settings fails. */
export function applyRuleSettings(settings: RuleSettings, updated: Required<RuleSettings>): () => void {
    const previous = { ...settings }
    const keys = Object.keys(updated) as Array<keyof RuleSettings>
    Object.assign(settings, updated)
    return () => {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(previous, key)) Object.assign(settings, { [key]: previous[key] })
            else delete settings[key]
        }
    }
}
