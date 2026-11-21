/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { parseAnkiIdMarker } from './anki-id-marker'
export interface EditorWarningLine {
    number: number
    from: number
    text: string
    literal: boolean
}

interface EditorWarningOptions {
    begin: string
    end: string
    inlineBegin: string
    inlineEnd: string
    models: ReadonlySet<string>
    resolves: (link: string) => boolean
}

export interface EditorCardWarning {
    from: number
    to: number
    code: 'id' | 'duplicate' | 'model' | 'attachment'
    value: string
}

const linkedBullet = /^ {0,3}[-+*][ \t]+\S.*[ \t]+::[ \t]+\S/u
const idLine = /^[ \t]*(?:<!--[ \t]*)?ID:[ \t]*(.*?)(?:[ \t]*-->)?[ \t]*$/u
const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

/** Проверяет только строки с явной разметкой карточки и соседнюю строку ID. */
export function inspectEditorCardLines(lines: readonly EditorWarningLine[], options: EditorWarningOptions): EditorCardWarning[] {
    const warnings: EditorCardWarning[] = []
    const seen = new Map<number, EditorCardWarning>()
    const repeated = new Set<number>()
    let readingBlock = false
    let previous = 0
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (line.number !== previous + 1 || line.literal) readingBlock = false
        previous = line.number
        if (line.literal || line.text.length > 8192) continue
        const trimmed = line.text.trim()
        const before = lines[index - 1]
        const after = lines[index + 1]
        const hasPrevious = before?.number === line.number - 1 && !before.literal
        const hasNext = after?.number === line.number + 1 && !after.literal
        const createWarning = (code: EditorCardWarning['code'], value: string, column: number, length: number): EditorCardWarning =>
            ({ code, value, from: line.from + column, to: line.from + column + length })
        const readsType = hasPrevious && options.begin && before.text.trim() === options.begin
        const inlineStart = options.inlineBegin && options.inlineEnd ? line.text.indexOf(options.inlineBegin) : -1
        const inline = inlineStart >= 0 ? /^\s*\[([^\]\r\n]+)\]/u.exec(line.text.slice(inlineStart + options.inlineBegin.length)) : null
        const explicitInline = Boolean(inline && line.text.includes(options.inlineEnd, inlineStart + options.inlineBegin.length + inline[0].length))
        const type = readsType ? trimmed : explicitInline ? inline?.[1].trim() : undefined
        if (type && options.models.size && !options.models.has(type)) {
            const column = line.text.indexOf(type, explicitInline ? inlineStart + options.inlineBegin.length : 0)
            if (column >= 0) warnings.push(createWarning('model', type, column, type.length))
        }

        const marker = idLine.exec(line.text)
        if (marker && (hasPrevious && linkedBullet.test(before.text) || readingBlock)) {
            const column = line.text.indexOf('ID:')
            const length = Math.max(3, line.text.trimEnd().length - column)
            const value = marker[1]
            const id = parseAnkiIdMarker(line.text)?.id
            if (id === undefined) warnings.push(createWarning('id', value, column, length))
            else {
                const warning = createWarning('duplicate', String(id), column, length)
                const prior = seen.get(id)
                if (!prior) seen.set(id, warning)
                else {
                    if (!repeated.has(id)) warnings.push(prior)
                    warnings.push(warning)
                    repeated.add(id)
                }
            }
        }

        if (options.begin && trimmed === options.begin) readingBlock = true
        if (options.end && trimmed === options.end) readingBlock = false
        if (readingBlock || explicitInline || hasNext && linkedBullet.test(line.text) && idLine.test(after.text)) {
            for (const match of line.text.matchAll(/!\[\[([^\]\r\n]+)\]\]|!\[[^\]\r\n]*\]\((<[^>\r\n]+>|[^\s)]+)\)/gu)) {
                const target = (match[1]?.split('|', 1)[0] ?? match[2]?.replace(/^<|>$/g, '') ?? '').trim()
                if (target && !external.test(target) && !options.resolves(target)) {
                    warnings.push(createWarning('attachment', target, match.index, match[0].length))
                }
            }
        }
    }
    return warnings.sort((left, right) => left.from - right.from || left.to - right.to)
}
