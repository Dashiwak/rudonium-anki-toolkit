/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { parseYaml } from 'obsidian'
import type { UiText } from './interface-language'

export type ExportRuleFieldSource = 'field' | 'property' | 'text'

export interface ExportRuleField {
    target: string
    source: ExportRuleFieldSource
    value: string
}

export interface ExportRule {
    id: string
    name: string
    folder?: string
    heading?: string
    property?: { key: string; value: string }
    model?: string
    deck?: string
    fields: ExportRuleField[]
    tags: string[]
}

export interface ExportRuleOutcome {
    rule: string
    deckApplied: boolean
    deckOverridden?: boolean
    modelCheckRequired?: boolean
    mappedFields: readonly string[]
    problem?: 'linked-model' | 'unknown-model' | 'invalid-field' | 'missing-source' | 'first-field'
    detail?: string
}

interface RuleNote {
    modelName: string
    fields: Record<string, string>
    deckName: string
    tags: string[]
}

interface Heading {
    offset: number
    ancestors: readonly string[]
}

type Properties = Record<string, unknown>
const owns = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)
const record = (value: unknown): value is Properties => !!value && typeof value === 'object' && !Array.isArray(value)
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const key = (value: unknown): value is string => typeof value === 'string' && !!value.trim() &&
    value === value.trim() && value.length <= 512 && !forbidden.has(value) && !value.includes('\0') && !/[\r\n]/u.test(value)
const pathKey = (value: unknown): value is string => key(value) && !/[\\]/u.test(value) &&
    value.split('/').every(part => !!part && part !== '.' && part !== '..')

function readField(value: unknown): ExportRuleField | undefined {
    if (!record(value) || !key(value.target) || typeof value.value !== 'string') return undefined
    if (value.source === 'text' && value.value.length <= 8_192) {
        return { target: value.target, source: value.source, value: value.value }
    }
    if ((value.source === 'field' || value.source === 'property') && key(value.value)) {
        return { target: value.target, source: value.source, value: value.value }
    }
    return undefined
}

export function validateExportRules(raw: unknown): ExportRule[] | undefined {
    if (!Array.isArray(raw) || raw.length > 64) return undefined
    const ids = new Set<string>()
    const rules: ExportRule[] = []
    for (const item of raw) {
        if (!record(item) || !key(item.id) || ids.has(item.id) || !key(item.name)) return undefined
        const { id, name, folder, heading, property, model, deck, fields, tags } = item
        if (folder !== undefined && !pathKey(folder) || heading !== undefined && !key(heading) ||
            model !== undefined && !key(model) || deck !== undefined && !key(deck)) return undefined
        let propertyRule: ExportRule['property']
        if (property !== undefined) {
            if (!record(property) || !key(property.key) || typeof property.value !== 'string' || property.value.length > 512 ||
                property.value.includes('\0') || /[\r\n]/u.test(property.value)) return undefined
            propertyRule = { key: property.key, value: property.value }
        }
        if (!Array.isArray(fields) || fields.length > 64 || !Array.isArray(tags) || tags.length > 64 ||
            !tags.every(tag => key(tag) && !/\s/u.test(tag))) return undefined
        const mapped: ExportRuleField[] = []
        const targets = new Set<string>()
        for (const field of fields) {
            const parsed = readField(field)
            if (!parsed || targets.has(parsed.target)) return undefined
            mapped.push(parsed)
            targets.add(parsed.target)
        }
        if (!model && !deck && !mapped.length && !tags.length) return undefined
        ids.add(id)
        rules.push({ id, name,
            folder: typeof folder === 'string' ? folder : undefined,
            heading: typeof heading === 'string' ? heading : undefined,
            property: propertyRule,
            model: typeof model === 'string' ? model : undefined,
            deck: typeof deck === 'string' ? deck : undefined,
            fields: mapped, tags: Array.from(new Set<string>(tags)) })
    }
    return rules
}

function scalar(value: unknown): string | undefined {
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
        return String(value)
    }
    return undefined
}

function normalized(value: string): string {
    return value.trim().normalize('NFC')
}

function propertyMatches(properties: Properties, rule: NonNullable<ExportRule['property']>): boolean {
    if (!owns(properties, rule.key)) return false
    const raw = properties[rule.key]
    const values: unknown[] = Array.isArray(raw) ? raw : [raw]
    return values.some(value => {
        const text = scalar(value)
        return text !== undefined && normalized(text) === normalized(rule.value)
    })
}

function headingAt(headings: readonly Heading[], offset: number): readonly string[] {
    let left = 0
    let right = headings.length
    while (left < right) {
        const middle = Math.floor((left + right) / 2)
        if (headings[middle].offset <= offset) left = middle + 1
        else right = middle
    }
    return left ? headings[left - 1].ancestors : []
}

function readHeadings(text: string, isProtected: (offset: number) => boolean): Heading[] {
    const headings: Heading[] = []
    const ancestors: Array<{ level: number; text: string }> = []
    for (const match of text.matchAll(/^ {0,3}(#{1,6})[ \t]+([^\r\n]+)/gm)) {
        const offset = match.index
        const marker = offset + match[0].indexOf('#')
        if (isProtected(marker)) continue
        const level = match[1].length
        const heading = normalized(match[2].replace(/[ \t]+#+[ \t]*$/u, ''))
        while (ancestors.length && ancestors[ancestors.length - 1].level >= level) ancestors.pop()
        if (heading) ancestors.push({ level, text: heading })
        headings.push({ offset, ancestors: ancestors.map(item => item.text) })
    }
    return headings
}

export function exportRuleMatcher(rules: readonly ExportRule[], path: string, text: string,
    frontmatter: { start: number; close: number } | undefined, protectedHeading: () => (offset: number) => boolean):
    ((offset: number) => { rule: ExportRule; properties: Properties } | undefined) {
    let matching = rules.filter(rule => rule.folder === undefined || path.startsWith(rule.folder + '/'))
    if (!matching.length) return () => undefined
    let properties: Properties = {}
    if (matching.some(rule => rule.property || rule.fields.some(field => field.source === 'property')) && frontmatter) {
        if (frontmatter.close === text.length) throw new Error('YAML frontmatter must be closed to apply export rules.')
        const parsed: unknown = parseYaml(text.slice(frontmatter.start, frontmatter.close))
        if (record(parsed)) properties = parsed
    }
    matching = matching.filter(rule => !rule.property || propertyMatches(properties, rule.property))
    const headings = matching.some(rule => rule.heading) ? readHeadings(text, protectedHeading()) : undefined
    return offset => {
        const context = headings && headingAt(headings, offset)
        const rule = matching.find(item => !item.heading || context?.includes(normalized(item.heading)))
        return rule ? { rule, properties } : undefined
    }
}

function literal(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n?|\n/g, '<br>')
}

function mappedValue(mapping: ExportRuleField, note: RuleNote, properties: Properties): string | undefined {
    if (mapping.source === 'field') return owns(note.fields, mapping.value) ? note.fields[mapping.value] : undefined
    if (mapping.source === 'text') return literal(mapping.value)
    const value = owns(properties, mapping.value) ? scalar(properties[mapping.value]) : undefined
    return value === undefined ? undefined : literal(value)
}

export function applyExportRule(note: RuleNote, rule: ExportRule, properties: Properties,
    schema: Record<string, string[]>, linked: boolean, linkedModel: string | undefined, explicitDeck: boolean): ExportRuleOutcome {
    const outcome: ExportRuleOutcome = { rule: rule.name, deckApplied: false, mappedFields: [] }
    const model = rule.model ?? note.modelName
    if (linkedModel && rule.model && model !== linkedModel) return { ...outcome, problem: 'linked-model', detail: linkedModel }
    const names = owns(schema, model) ? schema[model] : undefined
    if (rule.fields.length || model !== note.modelName) {
        if (!names?.length) return { ...outcome, problem: 'unknown-model', detail: model }
        const remapped = new Map<string, string>()
        const schemaFields = new Set(names)
        for (const mapping of rule.fields) {
            if (!schemaFields.has(mapping.target)) return { ...outcome, problem: 'invalid-field', detail: mapping.target }
            const value = mappedValue(mapping, note, properties)
            if (value === undefined) return { ...outcome, problem: 'missing-source', detail: mapping.value }
            remapped.set(mapping.target, value)
        }
        const changeModel = model !== note.modelName
        const fields = changeModel ? Object.fromEntries(names.map(name => [name, remapped.get(name) ??
            (owns(note.fields, name) ? note.fields[name] : '')])) : { ...note.fields, ...Object.fromEntries(remapped) }
        if ((changeModel || remapped.has(names[0])) && !fields[names[0]]?.trim()) {
            return { ...outcome, problem: 'first-field', detail: names[0] }
        }
        note.fields = fields
        note.modelName = model
        if (linked && !linkedModel && changeModel) outcome.modelCheckRequired = true
    }
    if (rule.deck && !explicitDeck) {
        note.deckName = rule.deck
        outcome.deckApplied = true
    }
    if (rule.deck && explicitDeck) outcome.deckOverridden = true
    if (rule.tags.length) note.tags = [...(note.tags ?? []), ...rule.tags]
    outcome.mappedFields = rule.fields.map(field => field.target)
    return outcome
}

export function describeExportRule(result: ExportRuleOutcome, t: UiText): string {
    const label = t(`Export rule · ${result.rule}`, `Правило экспорта · ${result.rule}`)
    const detail = result.detail ?? ''
    switch (result.problem) {
        case 'linked-model':
            return label + t(` · Skipped to retain the linked note type ${detail}.`, ` · Пропущено для сохранения связанного типа ${detail}.`)
        case 'unknown-model':
            return label + t(` · Unknown note type ${detail}.`, ` · Неизвестный тип записи ${detail}.`)
        case 'invalid-field':
            return label + t(` · Unknown target field ${detail}.`, ` · Неизвестное поле назначения ${detail}.`)
        case 'missing-source':
            return label + t(` · Missing value ${detail}.`, ` · Отсутствует значение ${detail}.`)
        case 'first-field':
            return label + t(` · Empty first field ${detail}.`, ` · Пустое первое поле ${detail}.`)
        default:
            return label +
                (result.deckOverridden ? t(' · The explicit note deck takes precedence.', ' · Приоритет у колоды, заданной в заметке.') : '') +
                (result.modelCheckRequired ? t(' · The linked note type will be checked before writing.',
                    ' · Тип связанной записи будет проверен перед записью.') : '')
    }
}
