/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { hasPageYamlIdText, mayHavePageTag, pageControlStart, pageHeading, pageTextSpan, pageYamlId, yamlBounds } from './page-frontmatter'
import { findPageAnswerBoundary, maskIdMarkerHtmlLiterals, pageAnswerEnd, signedPageIdLines } from './id-marker-literals'

/** Other scanners must not treat private material on a marked page as a linked card or command. */
export function markedPageAnswerBoundary(text: string): number | undefined {
    if (!text.includes(pageAnswerEnd) || !mayHavePageTag(text)) return
    const marked = pageHeading(text)
    return marked ? findPageAnswerBoundary(text, marked.start + marked.heading[0].length) : undefined
}

/** Числовая связь с Anki не зависит от даты и способа её оформления. */
export interface ParsedAnkiIdMarker {
    id: number
    digits: string
    comment: boolean
    inner: string
    text: string
    from: number
    to: number
    idFrom: number
    idTo: number
    metadata: string
    date?: string
    warning?: 'missing-date' | 'invalid-date'
}

export interface AnkiIdDateWarning {
    id: number
    line: number
    message: string
    russianMessage: string
}

function validDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
    if (!match) return false
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** The date occupies an explicit pipe slot or the legacy first ISO date after the number. */
function markerDate(tail: string): { from: number; to: number; value: string } | undefined {
    if (!tail.includes('-')) return
    // Explicit pipe wins over a date in the user's prose. The old format also allowed a date
    // immediately after the ID. Punctuation inserted between that date and the ID is retained.
    const explicit = /\|[ \t]*(\d{4}-\d{2}-\d{2})(?!\d)/gu
    for (const match of tail.matchAll(explicit)) {
        if (!validDate(match[1])) continue
        let from = match.index
        while (from > 0 && /[ \t]/u.test(tail[from - 1])) from--
        return { from, to: match.index + match[0].length, value: match[1] }
    }
    const legacy = /^([\p{P}\p{S} \t]*?)(\d{4}-\d{2}-\d{2})(?!\d)/u.exec(tail)
    if (legacy && validDate(legacy[2])) return { from: legacy[1].trimEnd().length, to: legacy[0].length, value: legacy[2] }
}

/** Распознаём число целиком. Дробное число или экспонента не могут служить ссылкой. */
export function parseAnkiIdMarker(raw: string): ParsedAnkiIdMarker | undefined {
    if (/[\r\n]/u.test(raw) || raw.includes("\0")) return
    const from = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    const comment = trimmed.startsWith('<!--')
    const closing = comment ? trimmed.indexOf('-->', 4) : -1
    if (comment && closing < 0) return
    const text = comment ? trimmed.slice(0, closing + 3) : trimmed
    const inner = comment ? text.slice(4, -3) : text
    const match = /^[ \t]*ID:[ \t]*(\d+)(.*)$/u.exec(inner)
    if (!match || /^(?:[.,]\d|[eE][+-]?\d)/u.test(match[2])) return
    const digits = match[1], id = Number(digits)
    if (!Number.isSafeInteger(id) || id <= 0) return
    const tail = match[2]
    const slot = markerDate(tail)
    const after = tail.trimStart()
    const metadata = (after.startsWith('|') ? after.slice(1) : after).trim()
    const warning = !slot && (after.startsWith('|') || /^\d{4}-\d/u.test(after))
        ? metadata ? 'invalid-date' : 'missing-date' : undefined
    const idFrom = from + (comment ? 4 : 0) + match[0].length - tail.length - digits.length
    return { id, digits, comment, inner, text, from, to: from + text.length,
        idFrom, idTo: idFrom + digits.length, metadata, ...(slot && { date: slot.value }), ...(warning && { warning }) }
}

const invalidPageFooter = () => new Error('Keep one signed ID after the public answer: <!--ID: 123 @page-->. / Оставьте один подписанный ID после ответа: <!--ID: 123 @page-->.')
/** The explicit signature distinguishes a whole page from another plugin's block ID. */
export function pageFooterMarker(row: string): ParsedAnkiIdMarker | undefined {
    const shape = /^ {0,3}<!--[ \t]*ID:[ \t]*([1-9]\d*)(?:[ \t]*\|[ \t]*(\d{4}-\d{2}-\d{2}))?[ \t]+@page[ \t]*-->[ \t]*$/u.exec(row)
    if (!shape) return
    const marker = parseAnkiIdMarker(row)
    if (marker && marker.date === shape[2]) return marker
}

export function pageFooterId(text: string) {
    if (!text.includes('@page')) return
    const heading = pageHeading(text)
    const bodyStart = heading && pageControlStart(text, heading.start + heading.heading[0].length, heading.tags)
    const boundary = bodyStart === undefined ? undefined : findPageAnswerBoundary(text, bodyStart)
    const publicText = boundary === undefined ? text : text.slice(0, boundary)
    const rows = signedPageIdLines(publicText)
    if (!rows.length) return
    if (!heading || bodyStart === undefined || rows.length !== 1) throw invalidPageFooter()
    const { start, end } = rows[0]
    // A standalone page tag may come after the footer without contributing to the answer.
    const following = pageTextSpan(publicText, end, publicText.length, heading.tags).value
    if (start <= bodyStart || following.trim() && !/^\s*\n\n<!-- Obsidian-to-Anki pending [a-f0-9]{32} -->(?:\n)?$/u.test(following)) throw invalidPageFooter()
    const marker = pageFooterMarker(text.slice(start, end))
    if (!marker) throw invalidPageFooter()
    return { id: marker.id, line: text.slice(0, start).split('\n').length, column: marker.idFrom,
        start, end, digitsStart: start + marker.idFrom, digitsEnd: start + marker.idTo, bodyStart,
        headingEnd: bodyStart - heading.heading[3].length }
}

export function formatLocalIdDate(date: Date): string {
    return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')].join('-')
}

/** Изменяем только участок от конца числа до даты; остальной текст и оболочка остаются на месте. */
export function idDatePatch(row: string, id: number, date: string, offset = 0): { start: number; end: number; text: string } | undefined {
    const marker = parseAnkiIdMarker(row)
    if (!marker || marker.id !== id) return
    const innerEnd = marker.comment ? marker.to - 3 : row.length
    const tail = row.slice(marker.idTo, innerEnd)
    const slot = markerDate(tail)
    // После HTML-комментария могла остаться дата старой записи. Переносим только явно отделённую дату.
    const outside = marker.comment && !slot ? markerDate(row.slice(marker.to)) : undefined
    const value = slot?.value ?? outside?.value ?? date
    const prefix = ' | ' + value
    const start = offset + marker.idFrom
    if (slot?.from === 0 && tail.slice(0, slot.to) === prefix) return
    if (outside) return { start, end: offset + marker.to + outside.to,
        text: marker.digits + prefix + row.slice(marker.idTo, marker.to) + row.slice(marker.to, marker.to + outside.from) }
    return { start, end: offset + marker.idTo + (slot?.to ?? 0),
        text: marker.digits + prefix + (slot ? tail.slice(0, slot.from) : '') }
}

/** Only the verified page property may receive a date in its YAML comment. */
export function pageIdDatePatch(text: string, id: number, date: string) {
    if (!hasPageYamlIdText(text) || !mayHavePageTag(text)) return
    const owner = pageYamlId(text)
    if (!owner || owner.id !== id) return
    const end = owner.digitsEnd + (text[owner.digitsEnd] === "'" || text[owner.digitsEnd] === '"' ? 1 : 0)
    const tail = text.slice(end, owner.end)
    const hash = tail.indexOf('#')
    if (hash < 0) return { start: end, end, text: ' # | ' + date }
    const at = end + hash + 1
    const comment = text.slice(at, owner.end)
    // A note's original linking date is stable across later synchronizations.
    if (markerDate(comment)) return
    const space = comment && !/^[ \t]/u.test(comment) ? ' ' : ''
    return { start: at, end: at, text: ' | ' + date + space }
}

/** Marks come from the source index. Only the IDs allowed by the verified operation may be changed. */
export function dateLinkedMarkers(text: string, markers: readonly { id: number; line: number }[],
    ids: ReadonlySet<number>, today: string, accept?: (id: number, line: number, before: string, after: string) => boolean): string {
    const changes = new Map<number, number>()
    for (const mark of markers) if (ids.has(mark.id)) changes.set(mark.line, mark.id)
    if (!changes.size) return text
    const yaml = hasPageYamlIdText(text) && mayHavePageTag(text) ? pageYamlId(text) : undefined
    const parts: string[] = []
    let line = 1, copied = 0
    for (const row of text.matchAll(/[^\r\n]*(?:\r\n?|\n|$)/gu)) {
        const id = changes.get(line++)
        if (id === undefined) continue
        const patch = yaml?.line === line - 1 && yaml.id === id ? pageIdDatePatch(text, id, today) : idDatePatch(row[0].replace(/[\r\n]+$/u, ''), id, today, row.index)
        if (!patch || accept && !accept(id, line - 1, text.slice(patch.start, patch.end), patch.text)) continue
        parts.push(text.slice(copied, patch.start), patch.text)
        copied = patch.end
    }
    if (!parts.length) return text
    parts.push(text.slice(copied))
    return parts.join('')
}

/** Границы служебных строк проверяются даже у некорректного числа, чтобы не создать новую карточку вместо старой. */
export function looksLikeAnkiIdMarker(raw: string): boolean {
    return /^[ \t]*(?:<!--[ \t]*)?ID[ \t]*:/u.test(raw)
}

export function ankiIdDateWarning(marker: ParsedAnkiIdMarker, line: number): AnkiIdDateWarning | undefined {
    if (!marker.warning) return
    return { id: marker.id, line,
        message: `Anki ID ${marker.id} is preserved. Its date is ${marker.warning === 'missing-date' ? 'missing' : 'invalid'}; use YYYY-MM-DD.`,
        russianMessage: `Связь по ID Anki ${marker.id} сохранена. ${marker.warning === 'missing-date' ? 'После разделителя отсутствует дата' : 'Дата записана некорректно'}; используйте ГГГГ-ММ-ДД.` }
}

/** Один захват числа сохраняет совместимость с порядком полей штатного RegexNote. */
export const ankiIdRegexpSource = String.raw`[ \t]*(?:<!--[ \t]*)?ID:[ \t]*(\d+)(?!\d|[.,]\d|[eE][+-]?\d)[^\r\n]*`

/** Обновляет только известный слот ID; пользовательские захваты полей не переставляются. */
export function compatibleAnkiIdRegexp(pattern: RegExp, stopBefore?: string): RegExp {
    // В однострочном формате метаданные не должны поглотить следующую карточку на той же строке.
    const stop = stopBefore?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const marker = stop ? ankiIdRegexpSource.replace(/\[\^\\r\\n\]\*/gu, () => `(?:(?!${stop})[^\\r\\n])*`) : ankiIdRegexpSource
    const source = pattern.source.replace(/ID: \(\\d\+\)(?:\.\*)?/gu, () => marker)
    return source === pattern.source ? pattern : new RegExp(source, pattern.flags)
}

/** Кандидаты для штатного разбора: принадлежность карточке затем проверяет сам парсер. */
export function ankiIdNumberTokens(content: string): number[] {
    const boundary = markedPageAnswerBoundary(content)
    const ids = new Set<number>()
    if (hasPageYamlIdText(content) && mayHavePageTag(content)) {
        const page = pageYamlId(content)
        if (page) ids.add(page.id)
    }
    // Properties may include unrelated user IDs; only the verified page owner above belongs to Anki.
    const body = content.slice(yamlBounds(content)?.after ?? 0, boundary)
    for (const match of maskIdMarkerHtmlLiterals(body).matchAll(/\bID:[ \t]*(\d+)(?!\d|[.,]\d|[eE][+-]?\d)/gmu)) {
        const marker = parseAnkiIdMarker(match[0])
        if (marker) ids.add(marker.id)
    }
    return [...ids]
}

/** Проверяет исходный хвост пользовательского шаблона до создания или изменения записи. */
export function assertCustomAnkiIdMatch(content: string, match: RegExpMatchArray, hasId: boolean): AnkiIdDateWarning | undefined {
    const start = match.index ?? 0
    let markerOffset: number | undefined
    let raw: string | undefined
    if (hasId) {
        const digits = match[match.length - 1]
        if (typeof digits !== 'string') throw new Error('Missing Anki ID capture in Custom Regexp.')
        for (const token of match[0].matchAll(/(?:<!--[ \t]*)?ID:[ \t]*(\d+)/gu)) {
            if (token[1] === digits) { markerOffset = token.index; raw = match[0].slice(markerOffset).replace(/\r$/u, '') }
        }
        const parsed = raw && parseAnkiIdMarker(raw)
        if (parsed) {
            if (!parsed.warning) return
            const at = start + (markerOffset ?? 0)
            const lineStart = Math.max(content.lastIndexOf('\n', at - 1), content.lastIndexOf('\r', at - 1)) + 1
            // Отдельные строки уже проверены общим сборщиком. Здесь добавляем только пользовательский inline-хвост.
            if (!content.slice(lineStart, at).trim()) return
            const line = (content.slice(0, at).match(/\r\n?|\n/gu)?.length ?? 0) + 1
            return ankiIdDateWarning(parsed, line)
        }
    } else {
        const tail = content.slice(start + match[0].length)
        const opening = /^[ \t]*(?:(?:\r\n?|\n)[ \t]*)?(?:<!--[ \t]*)?ID[ \t]*:/u.exec(tail)
        if (!opening) return
        markerOffset = match[0].length + opening[0].length - opening[0].trimStart().length
        raw = tail.slice(opening[0].length - opening[0].trimStart().length).split(/\r\n?|\n/u, 1)[0]
    }
    const line = (content.slice(0, start + (markerOffset ?? 0)).match(/\r\n?|\n/gu)?.length ?? 0) + 1
    const valid = raw && parseAnkiIdMarker(raw)
    throw new Error(valid
        ? `Anki ID on line ${line} was not safely matched by Custom Regexp. Its link was kept; repair the pattern before exporting. / Пользовательский шаблон не подтвердил связь ID Anki в строке ${line}. Маркер сохранён; исправьте шаблон перед экспортом.`
        : `Invalid Anki ID marker on line ${line}. Keep a positive whole number and repair the marker before exporting. / Некорректный маркер ID Anki в строке ${line}. Исправьте целое положительное число перед экспортом.`)
}

/** RegexNote consumes captures with pop(). Keep the worker's original match for the preview. */
export function copyMatchForRegexNote(match: RegExpMatchArray): RegExpMatchArray {
    const copy: RegExpMatchArray = [match[0]]
    for (let i = 1; i < match.length; i++) copy.push(match[i] ?? '')
    return Object.assign(copy, { index: match.index, input: match.input, groups: match.groups })
}

/** Отдаём карточку парсеру после проверки диапазона и исходного захвата ID. */
export function* checkedCustomAnkiMatches(matches: Iterable<RegExpMatchArray>, content: string, hasId: boolean,
    warnings: AnkiIdDateWarning[], excluded: (start: number, end: number) => boolean): IterableIterator<RegExpMatchArray> {
    for (const match of matches) {
        if (match.index === undefined) throw new Error('Missing Custom Regexp match position.')
        if (excluded(match.index, match.index + match[0].length)) continue
        const warning = assertCustomAnkiIdMatch(content, match, hasId)
        if (warning) warnings.push(warning)
        yield match
    }
}
