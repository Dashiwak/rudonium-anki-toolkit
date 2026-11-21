/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { activeCardMarkdown, archivedCardRanges } from './archived-card'
import { pageYamlClaims } from './page-frontmatter'
export { insertPageYamlId, pageYamlId } from './page-frontmatter'
import { readSuspendLine } from './suspend-label'
import { maskIdMarkerHtmlLiterals } from './id-marker-literals'
import { maskLegacyFieldSections } from './legacy-field-sections'
import { parseAnkiIdMarker, ankiIdDateWarning, markedPageAnswerBoundary } from './anki-id-marker'
import type { AnkiIdDateWarning } from './anki-id-marker'
/** Номер строки начинается с 1. Столбец начинается с 0 и указывает на I в ID:. */
export interface IdMarker {
    location?: 'yaml'
    id: number
    line: number
    column: number
}

/** Сохранённый архивом ID занят при перепривязке. Его строка служит только для диагностики. */
export function archivedIdMarkers(content: string): IdMarker[] {
    const ranges = archivedCardRanges(content)
    const markers: IdMarker[] = []
    let line = 1, offset = 0, start = 0
    for (const range of ranges) {
        while (offset < range.start) {
            const newline = content.indexOf('\n', offset)
            if (newline < 0 || newline >= range.start) break
            line++
            offset = newline + 1
            start = offset
        }
        markers.push({ id: range.id, line, column: range.start - start })
        offset = range.start
    }
    return markers
}

export interface DuplicateSource extends IdMarker {
    preview: string
    front?: string
    back?: string
    options?: string
}

export type DuplicateMarkerSyntax = Partial<Record<
    'Begin Note' | 'End Note' | 'Begin Inline Note' | 'End Inline Note' | 'Delete Note Line' | 'Suspend Line' | 'Suspend Line Aliases' | 'Frozen Fields Line' | 'Target Deck Line' | 'File Tags Line', string
>>

const lineBreak = /\r\n?|\n/
const fenceDelimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/
const standaloneId = /^\uFEFF?[ \t]*(ID:[ \t]*\d+[^\r\n]*)$/
const commentId = /<!--[ \t]*(ID:[ \t]*(\d+)[^\r\n]*?)-->/g
const inlineId = /(?:^|\s)(ID:[ \t]*(\d+))(?!\d|[.,]\d|[eE][+-]?\d)/g
const trailingInlineId = /^[ \t]*(ID:[ \t]*(\d+))(?!\d|[.,]\d|[eE][+-]?\d)/
const inlineCardBody = /^(?:[ \t]*\[[^\]\r\n]+\][ \t]+\S|[ \t]+[^|]+\|[^|]+\|[^|]+\|$)/

/** Маскируем только закрытые фрагменты кода, сохраняя столбцы исходной строки. */
function maskCode(line: string): string {
    return line.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, span => ' '.repeat(span.length))
}

function maskInlineCommentExamples(line: string, state: { closing?: string }): string {
    let offset = 0
    let visible = ''
    while (offset < line.length) {
        if (!state.closing) {
            const opening = /<!--|%%/.exec(line.slice(offset))
            if (!opening) return visible + line.slice(offset)
            visible += line.slice(offset, offset + opening.index) + ' '.repeat(opening[0].length)
            offset += opening.index + opening[0].length
            state.closing = opening[0] === '<!--' ? '-->' : '%%'
        }
        const close = line.indexOf(state.closing, offset)
        if (close < 0) return visible + ' '.repeat(line.length - offset)
        const end = close + state.closing.length
        visible += ' '.repeat(end - offset)
        offset = end
        state.closing = undefined
    }
    return visible
}

/** Служебный комментарий должен быть самостоятельным, а не вложенным примером в обычном комментарии. */
function rootIdComments(line: string, initialClosing?: string): Set<number> {
    const result = new Set<number>()
    let cursor = 0
    if (initialClosing) {
        const end = line.indexOf(initialClosing)
        if (end < 0) return result
        cursor = end + initialClosing.length
    }
    while (cursor < line.length) {
        const hit = /<!--|%%/.exec(line.slice(cursor))
        if (!hit) break
        const start = cursor + hit.index
        const closing = hit[0] === '<!--' ? '-->' : '%%'
        const end = line.indexOf(closing, start + hit[0].length)
        if (end < 0) break
        if (closing === '-->' && parseAnkiIdMarker(line.slice(start, end + closing.length))) result.add(start)
        cursor = end + closing.length
    }
    return result
}

function appendMarker(markers: IdMarker[], match: RegExpMatchArray, row: number, offset = 0): void {
    const parsed = parseAnkiIdMarker(match[0].trim()) ?? parseAnkiIdMarker(match[1])
    const id = parsed?.id
    if (id !== undefined) {
        markers.push({ id, line: row + 1, column: offset + match.index! + match[0].indexOf(match[1]) })
    }
}

/** Собирает маркеры, в том числе повторы в одном файле, с их точными координатами. */
export function findIdMarkers(content: string, syntax: DuplicateMarkerSyntax = {}): IdMarker[] {
    if (content.includes('RUDONIUM-ARCHIVE')) content = activeCardMarkdown(content)
    content = maskLegacyFieldSections(content)
    // The page tag can be in the private appendix. Resolve YAML ownership using the whole note;
    // markers inside the appendix itself remain outside the body scan.
    const markers: IdMarker[] = pageYamlClaims(content).map(({ id, line, column }) => ({ id, line, column, location: 'yaml' }))
    // A broken page is rejected by its parser. Keep all ownership claims during a vault-wide scan.
    try {
        const boundary = markedPageAnswerBoundary(content)
        if (boundary !== undefined) content = content.slice(0, boundary)
    } catch { /* The page parser reports the ambiguous boundary. */ }
    if (!content.includes('ID:')) return markers
    const lines = maskIdMarkerHtmlLiterals(content, true).split(lineBreak)
    let first = 0
    if (/^\uFEFF?---[ \t]*$/.test(lines[0])) {
        const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line))
        if (close < 0) return markers
        first = close + 1
    }
    const inlineStart = syntax['Begin Inline Note'] ?? 'STARTI'
    const inlineEnd = syntax['End Inline Note'] ?? 'ENDI'
    const deleteLine = syntax['Delete Note Line'] ?? 'DELETE'
    const inlineComments: { closing?: string } = {}

    let fence: string | undefined
    let math = false
    for (let row = first; row < lines.length; row++) {
        const line = lines[row]
        const delimiter = fenceDelimiter.exec(line)
        if (delimiter) {
            const mark = delimiter[1]
            if (!fence) fence = mark
            else if (mark[0] === fence[0] && mark.length >= fence.length && !delimiter[2].trim()) fence = undefined
            continue
        }
        if (fence) continue
        if (line.trim() === '$$') { math = !math; continue }
        if (math) continue

        const text = line
        const serviceComments = rootIdComments(text, inlineComments.closing)
        const visible = maskInlineCommentExamples(text, inlineComments)
        if (!line.includes('ID:')) continue
        const lineMarkers: IdMarker[] = []
        const plain = standaloneId.exec(visible)
        if (plain) {
            appendMarker(lineMarkers, plain, row)
        } else if (deleteLine) {
            const trimmed = visible.trimStart()
            if (trimmed.startsWith(deleteLine)) {
                const target = standaloneId.exec(trimmed.slice(deleteLine.length))
                if (target) appendMarker(lineMarkers, target, row, text.length - trimmed.length + deleteLine.length)
            }
        }
        for (const hit of text.matchAll(commentId)) if (serviceComments.has(hit.index!)) appendMarker(lineMarkers, hit, row)
        if (inlineStart && inlineEnd) {
            for (let start = text.indexOf(inlineStart); start !== -1;) {
                const from = start + inlineStart.length
                const end = text.indexOf(inlineEnd, from)
                if (end === -1) break
                const tailStart = end + inlineEnd.length
                const tail = trailingInlineId.exec(text.slice(tailStart))
                const ownsTail = tail && (!start || /[\s([{"'«>]/.test(text[start - 1])) &&
                    inlineCardBody.test(line.slice(from, end)) && visible.startsWith(inlineStart, start) &&
                    visible.slice(tailStart, tailStart + tail[0].length) === tail[0]
                if (tail && ownsTail) appendMarker(lineMarkers, tail, row, tailStart)
                else {
                    const clause = visible.slice(from, end)
                    for (const hit of clause.matchAll(inlineId)) appendMarker(lineMarkers, hit, row, from)
                }
                start = text.indexOf(inlineStart, tailStart)
            }
        }
        lineMarkers.sort((left, right) => left.column - right.column)
        for (const marker of lineMarkers) markers.push(marker)
    }
    return markers
}

function excerpt(lines: readonly string[]): string {
    const text = lines.join('\n').trim()
    return text.length > 400 ? text.slice(0, 397) + '…' : text
}

function linkedFields(line: string): Pick<DuplicateSource, 'front' | 'back' | 'options'> | undefined {
    const item = /^ {0,3}[-+*][ \t]+(.+)$/.exec(line)
    if (!item) return undefined
    const text = item[1]
    const values: string[] = []
    let offset = 0
    for (const delimiter of maskCode(text).matchAll(/::/g)) {
        const index = delimiter.index!
        if (!/[ \t]/.test(text[index - 1] ?? '') || !/[ \t]/.test(text[index + 2] ?? '')) continue
        values.push(text.slice(offset, index).trim())
        offset = index + 2
    }
    values.push(text.slice(offset).trim())
    const [front, back, ...rest] = values
    if (!front || !back) return undefined
    const options = rest.join(' :: ')
    return options ? { front, back, options } : { front, back }
}

function stockBlockSource(rows: readonly string[], row: number, syntax: DuplicateMarkerSyntax):
    Pick<DuplicateSource, 'preview' | 'front' | 'back'> | undefined {
    const opening = syntax['Begin Note'] ?? 'START'
    const closing = syntax['End Note'] ?? 'END'
    if (!opening || !closing || rows[row + 1]?.trim() !== closing) return undefined

    let start = row - 1
    while (start >= 0 && rows[start].trim() !== opening) {
        if (rows[start].trim() === closing) return undefined
        start--
    }
    if (start < 0 || !rows[start + 1]?.trim()) return undefined

    const fields = { front: [] as string[], back: [] as string[] }
    let active: keyof typeof fields | undefined
    const fieldsEnd = readSuspendLine(rows[row - 1] ?? '', syntax) ? row - 1 : row
    for (let index = start + 2; index < fieldsEnd; index++) {
        const line = rows[index]
        const label = /^([A-Za-z][A-Za-z ]*):[ \t]*(.*)$/.exec(line)
        if (label) {
            active = label[1] === 'Front' ? 'front' : label[1] === 'Back' ? 'back' : undefined
            if (active) fields[active].push(label[2])
        } else if (active) {
            fields[active].push(line)
        }
    }
    const front = fields.front.join('\n').trim()
    const back = fields.back.join('\n').trim()
    const preview = excerpt(rows.slice(start, row + 2))
    return { preview, ...(front && { front }), ...(back && { back }) }
}

/** Для известной разметки берёт поля, иначе показывает ближайший исходный текст. */
export function readDuplicateSource(content: string, marker: IdMarker, syntax: DuplicateMarkerSyntax = {}): DuplicateSource {
    return readSourceLines(content.split(lineBreak), marker, syntax)
}

/** Подготавливает исходные строки один раз для всех повторных ID в файле. */
export function readDuplicateSources(content: string, markers: readonly IdMarker[],
    syntax: DuplicateMarkerSyntax = {}): DuplicateSource[] {
    if (!markers.length) return []
    const rows = content.split(lineBreak)
    return markers.map(marker => readSourceLines(rows, marker, syntax))
}

function readSourceLines(rows: readonly string[], marker: IdMarker, syntax: DuplicateMarkerSyntax): DuplicateSource {
    const row = marker.line - 1
    const line = rows[row] ?? ''
    const prefix = line.slice(0, marker.column)
    const actual = /^ID:[ \t]*(\d+)(?!\d|[.,]\d|[eE][+-]?\d)/.exec(line.slice(marker.column))
    if (!actual || Number(actual[1]) !== marker.id) return { ...marker, preview: '' }

    const adjacent = rows[row - 1] ?? ''
    const previous = readSuspendLine(adjacent, syntax) ? rows[row - 2] ?? '' : adjacent
    const standalone = /^[ \t]*(?:<!--[ \t]*)?$/.test(prefix)
    const deleteLine = syntax['Delete Note Line'] ?? 'DELETE'
    if (standalone && previous.trim() !== deleteLine) {
        const fields = linkedFields(previous)
        if (fields) return { ...marker, preview: excerpt([previous, line]), ...fields }
        const stock = stockBlockSource(rows, row, syntax)
        if (stock) return { ...marker, ...stock }
    }
    const inlineStart = syntax['Begin Inline Note'] ?? 'STARTI'
    const inlineEnd = syntax['End Inline Note'] ?? 'ENDI'
    if (!standalone && inlineStart && inlineEnd) {
        const text = maskCode(line)
        const start = text.lastIndexOf(inlineStart, marker.column)
        if (start >= 0) {
            const end = text.indexOf(inlineEnd, start + inlineStart.length)
            const tail = end + inlineEnd.length
            if (end > marker.column || end >= 0 && /^[ \t]*(?:<!--[ \t]*)?$/.test(text.slice(tail, marker.column))) {
                return { ...marker, preview: excerpt([line.slice(start, Math.max(tail, marker.column + actual[0].length))]) }
            }
        }
    }

    return { ...marker, preview: excerpt(standalone && previous.trim() ? [previous, line] : [line]) }
}

/** Нестандартная дата видна пользователю, но не отменяет числовую связь с Anki. */
export function collectAnkiIdDateWarnings(content: string, syntax: DuplicateMarkerSyntax = {}): AnkiIdDateWarning[] {
    const lines = content.split(lineBreak)
    const warnings: AnkiIdDateWarning[] = []
    for (const marker of findIdMarkers(content, syntax)) {
        const line = lines[marker.line - 1]
        const prefix = line.slice(0, marker.column)
        const shell = /<!--[ \t]*$/u.exec(prefix)
        const opening = shell ? shell.index : -1
        const closing = opening >= 0 ? line.indexOf('-->', marker.column) : -1
        const nextInline = line.indexOf(syntax['Begin Inline Note'] ?? 'STARTI', marker.column)
        const raw = opening >= 0 && closing >= 0 ? line.slice(opening, closing + 3)
            : line.slice(marker.column, nextInline < 0 ? undefined : nextInline)
        const parsed = parseAnkiIdMarker(raw)
        const warning = parsed && ankiIdDateWarning(parsed, marker.line)
        if (warning) warnings.push(warning)
    }
    return warnings
}
