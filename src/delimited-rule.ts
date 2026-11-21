// SPDX-License-Identifier: GPL-3.0-only
import type { UiText } from './interface-language'

// Only canonical patterns generated here are interpreted as wizard settings.
// Their capture groups contain the user's field values; the parser appends tags/ID.
const start = String.raw`^(?![ \t]*(?:<!--[ \t]*)?ID[ \t]*:)(?:[-*+][ \t]+|(?![-*+][ \t]))`
const padding = String.raw`[ \t]*`
const end = String.raw`(?=\r?$)`
const newline = String.raw`\r?\n`
const blockStart = String.raw`^:::anki[ \t]*\r?\n`
const headerGuard = String.raw`(?![ \t]*(?::::(?:anki)?[ \t]*(?=\r?$)|(?:<!--[ \t]*)?ID[ \t]*:))`
const blockEnd = newline + ':::' + padding + end
// Each repetition consumes an entire line. An incomplete block cannot absorb another opener or an ID.
const answerLine = headerGuard + String.raw`[^\r\n]*`
const answer = '(' + String.raw`(?=[ \t]*\S)` + answerLine + '(?:' + newline + answerLine + ')*)'
const question = String.raw`([^\s](?:[^\r\n]*[^\s])?)`
const twoFieldBlock = blockStart + headerGuard + question + padding + newline + answer + blockEnd
export type DelimitedFormat = { count: number; separator: string; multiline?: true }

function fieldPattern(literal: string): string {
    return String.raw`((?!${literal})\S(?:(?:(?!${literal})[^\r\n])*(?!${literal})\S)?)`
}
export function delimitedRule(count: number, separator: string, multiline = false): string | undefined {
    if (!Number.isSafeInteger(count) || count < 2) return
    if (multiline && count === 2) return twoFieldBlock
    if (!separator || separator.trim() !== separator || /[\x00-\x1f\x7f\u2028\u2029]/u.test(separator)) return
    const literal = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const field = fieldPattern(literal)
    const between = padding + literal + padding
    const fields = multiline ? count - 1 : count
    const prefix = multiline ? blockStart + headerGuard : start
    const suffix = multiline ? padding + newline + answer + blockEnd : padding + end
    if (prefix.length + fields * field.length + (fields - 1) * between.length + suffix.length > 65536) return
    return prefix + Array(fields).fill(field).join(between) + suffix
}

export function readDelimitedRule(expression: string): DelimitedFormat | undefined {
    if (typeof expression !== 'string' || expression.length > 65536) return
    if (expression === twoFieldBlock) return { count: 2, separator: ':', multiline: true }
    const multiline = expression.startsWith(blockStart + headerGuard)
    const prefix = multiline ? blockStart + headerGuard : start
    if (!expression.startsWith(prefix)) return
    const first = /^\(\(\?!((?:\\.|[^)\\])+)\)\\S/u.exec(expression.slice(prefix.length))
    if (!first) return
    const literal = first[1]
    const count = expression.split(fieldPattern(literal)).length - 1 + Number(multiline)
    const separator = literal.replace(/\\(.)/gu, '$1')
    if (delimitedRule(count, separator, multiline) === expression) return multiline ? { count, separator, multiline: true } : { count, separator }
}

interface RuleSources {
    CUSTOM_REGEXPS?: Record<string, string>
    REGEXP_WIZARD_FIELDS?: Record<string, string[]>
}
interface ParsedFile {
    path: string
    all_notes_to_add: readonly { modelName: string }[]
    notes_to_edit: readonly { note: { modelName: string } }[]
}

/** Check positional fields against the pinned Anki profile before using its write pipeline. */
export function generatedRuleGuard(settings: RuleSources, cached: Record<string, string[]>,
    readFields: (model: string) => Promise<unknown>, t: UiText) {
    const rules = new Map<string, number>()
    for (const [name, pattern] of Object.entries(settings.CUSTOM_REGEXPS ?? {})) {
        const rule = typeof pattern === 'string' && readDelimitedRule(pattern)
        if (rule) rules.set(name, rule.count)
    }
    const verified = new Map<string, string | undefined>()
    async function problem(model: string, count: number): Promise<string | undefined> {
        if (verified.has(model)) return verified.get(model)
        const parsed = Object.prototype.hasOwnProperty.call(cached, model) ? cached[model] : undefined
        const signatures = settings.REGEXP_WIZARD_FIELDS
        const authored = signatures && Object.prototype.hasOwnProperty.call(signatures, model)
            ? signatures[model] : parsed?.slice(0, count)
        let error: string | undefined
        try {
            const actual = await readFields(model)
            if (!Array.isArray(authored) || authored.length !== count || !Array.isArray(actual) || !Array.isArray(parsed) ||
                !authored.every((field, index) => typeof field === 'string' && !!field && field === parsed[index] && field === actual[index])) {
                error = t(`The field names or order for “${model}” changed. Refresh note types, review the field mapping in the rule wizard, then save and retry.`,
                    `Изменились имена или порядок полей типа «${model}». Обновите типы записей, проверьте поля в мастере правил, сохраните правило и повторите экспорт.`)
            }
        } catch (cause) {
            error = t(`Could not verify the Anki fields for “${model}”. Check the connection and refresh note types.`,
                `Не удалось проверить поля типа «${model}» в Anki. Проверьте подключение и обновите типы записей.`) + ' ' + String(cause)
        }
        verified.set(model, error)
        return error
    }
    return async (files: readonly ParsedFile[]): Promise<Map<string, string>> => {
        const blocked = new Map<string, string>()
        if (!rules.size) return blocked
        for (const file of files) {
            const models = new Set<string>()
            for (const note of file.all_notes_to_add) if (rules.has(note.modelName)) models.add(note.modelName)
            for (const { note } of file.notes_to_edit) if (rules.has(note.modelName)) models.add(note.modelName)
            for (const model of models) {
                const error = await problem(model, rules.get(model)!)
                if (error) { blocked.set(file.path, error); break }
            }
        }
        return blocked
    }
}
