// SPDX-License-Identifier: GPL-3.0-only
import { hasPageYamlIdText, mayHavePageTag, pageControlStart, pageHeading, pageLifecycleSlot, pageYamlId } from './page-frontmatter'
import { activeCardMarkdown } from './archived-card'
import { maskLegacyFieldSections } from './legacy-field-sections'
import { pageFooterId, pageFooterMarker, parseAnkiIdMarker } from './anki-id-marker'
import { findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { readSuspendLine, suspendLabel, suspendLabels, suspendLabelProblem } from './suspend-label'
import type { SuspendSelection } from './suspend-label'
export { suspendLabelProblem } from './suspend-label'
export type { SuspendSelection } from './suspend-label'

export interface SuspendMark { id: number; selection: SuspendSelection; start: number; end: number; idStart: number; line: number }

export function mayHaveSuspendMarker(text: string, syntax?: DuplicateMarkerSyntax): boolean {
    if (text.includes('RUDONIUM-ARCHIVE')) text = activeCardMarkdown(text)
    if (!text.includes('ID:') && !hasPageYamlIdText(text)) return false
    const labels = suspendLabels(syntax)
    if (labels.some(label => text.includes(label))) return true
    const lower = text.toLowerCase()
    return labels.some(label => lower.includes(label.toLowerCase()))
}

/** Read page ownership once, using the complete note even when its routing tag is in a private appendix. */
export function pageLifecycleLink(text: string, syntax?: DuplicateMarkerSyntax) {
    if (!mayHavePageTag(text) && !text.includes('@page')) return
    if (maskLegacyFieldSections(text) !== text) return
    const footer = pageFooterId(text)
    const heading = pageHeading(text)
    if (!heading) return
    const yaml = hasPageYamlIdText(text) ? pageYamlId(text, heading) : undefined
    const at = pageControlStart(text, heading.start + heading.heading[0].length, heading.tags)
    const slot = pageLifecycleSlot(text, at, heading.tags, syntax)
    const first = /^[^\r\n]*/u.exec(text.slice(slot.next))![0]
    const marker = parseAnkiIdMarker(first)
    if (footer && yaml || marker && (footer || yaml)) throw new Error('Conflicting page IDs. / У страницы несколько ID.')
    const id = yaml?.id ?? footer?.id ?? marker?.id
    if (id !== undefined) return { id, slot }
}

function indexSource(text: string, syntax?: DuplicateMarkerSyntax) {
    const problem = suspendLabelProblem(suspendLabel(syntax), syntax)
    if (problem) throw new Error(problem)
    const lines = text.split(/\r\n|\n|\r/u), starts = [0]
    for (const match of text.matchAll(/\r\n|\n|\r/gu)) starts.push(match.index + match[0].length)
    const marked = new Map<number, SuspendMark>(), ids = new Map<number, number>()
    const deletion = (syntax?.['Delete Note Line'] || 'DELETE').toLowerCase()
    const conflict = (id: number) => new Error('Conflicting markers at ID ' + id + '. / Несовместимые метки у ID ' + id + '.')
    const active = activeCardMarkdown(text)
    const pageLink = pageLifecycleLink(active, syntax)
    const commandRow = pageLink ? starts.indexOf(pageLink.slot.start) : -1
    const allMarkers = findIdMarkers(text, syntax)
    if (pageLink && allMarkers.length !== 1) throw conflict(pageLink.id)
    for (const { id, line } of allMarkers) {
        if (pageLink && pageLink.id === id) {
            const { start, end, command } = pageLink.slot
            ids.set(id, commandRow)
            if (command && command !== 'delete') marked.set(id, { id, selection: command,
                start, end, idStart: start, line: commandRow + 1 })
            continue
        }
        const row = line - 1, current = lines[row], prev = lines[row - 1] ?? ''
        // A detached page footer cannot authorize a suspension of a different card.
        if (pageFooterMarker(current)) continue
        const repeated = ids.has(id)
        ids.set(id, repeated ? -1 : row)
        if (repeated && marked.has(id)) throw conflict(id)
        // The ID must be the entire physical line, including its optional HTML wrapper.
        const standalone = !/^(?: {4}| {0,3}\t)/u.test(current) && parseAnkiIdMarker(current)?.id === id
        const sameLineDelete = current.trimStart().toLowerCase().startsWith(deletion) &&
            parseAnkiIdMarker(current.trimStart().slice(deletion.length))?.id === id
        const previous = readSuspendLine(prev, syntax)
        if (!standalone && !sameLineDelete) {
            if (previous && !/^(?: {4}| {0,3}\t)/u.test(current)) {
                throw new Error('Move the Anki ID to a supported standalone card format before suspending it. / Для приостановки используйте формат с ID на отдельной строке.')
            }
            continue
        }
        const earlier = lines[row - 2] ?? ''
        if (!previous) {
            if (prev.trim().toLowerCase() === deletion && readSuspendLine(earlier, syntax)) throw conflict(id)
            continue
        }
        if (repeated || sameLineDelete || earlier.trim().toLowerCase() === deletion || readSuspendLine(earlier, syntax)) throw conflict(id)
        marked.set(id, { id, selection: previous, start: starts[row - 1] + (row === 1 && text.charCodeAt(0) === 0xfeff ? 1 : 0), end: starts[row], idStart: starts[row], line: row })
    }
    return { lines, starts, marked, ids, deletion, pageLink }
}

export function readSuspendMarkers(text: string, syntax?: DuplicateMarkerSyntax): Map<number, SuspendMark> {
    return mayHaveSuspendMarker(text, syntax) ? indexSource(text, syntax).marked : new Map<number, SuspendMark>()
}

export function rewriteSuspendMarkers(text: string, changes: ReadonlyMap<number, SuspendSelection | null>,
    syntax?: DuplicateMarkerSyntax): string {
    if (!changes.size) return text
    const { lines, starts, marked, ids, deletion, pageLink } = indexSource(text, syntax)
    const patches: { start: number; end: number; value: string }[] = []
    for (const [id, wanted] of changes) {
        const row = ids.get(id), previous = marked.get(id)
        const page = pageLink?.id === id
        if (row === undefined || row < 0 || (page ? pageLink.slot.command === 'delete' :
            /^(?: {4}| {0,3}\t)/u.test(lines[row]) || parseAnkiIdMarker(lines[row])?.id !== id ||
            lines[row - 1]?.trim().toLowerCase() === deletion)) {
            throw new Error('No unique standalone ID for the suspension marker. / Для метки требуется отдельная уникальная строка ID: ' + id)
        }
        const at = starts[row] + (row === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0), start = previous?.start ?? at
        const eol = row ? text.slice(starts[row - 1] + lines[row - 1].length, at) : /\r\n|\n|\r/u.exec(text)?.[0] ?? '\n'
        let replacement = ''
        if (wanted !== null) {
            const label = suspendLabel(syntax)
            if (wanted !== 'all' && (!wanted.length || !wanted.every(n => Number.isSafeInteger(n) && n > 0) ||
                new Set(wanted).size !== wanted.length)) throw new Error('Invalid suspension card numbers. / Некорректные номера карточек.')
            const selection = wanted === 'all' ? wanted : [...wanted].sort((a, b) => a - b)
            if (previous && String(selection) === String(previous.selection)) continue
            replacement = (page ? '' : lines[row].match(/^ */u)?.[0] ?? '') + label + (selection === 'all' ? '' : '_' + selection.join(',')) + eol
        } else if (!previous) continue
        patches.push({ start, end: previous?.end ?? at, value: replacement })
    }
    let cursor = 0
    const parts: string[] = []
    for (const patch of patches.sort((a, b) => a.start - b.start)) {
        parts.push(text.slice(cursor, patch.start), patch.value)
        cursor = patch.end
    }
    return parts.join('') + text.slice(cursor)
}

/** The stock parser expects the ID next to the fields. Translate only complete control lines,
 * keeping editor positions, subsequent ID insertions and regex capture groups in source coordinates. */
export function suspendParserView(text: string, marks: ReadonlyMap<number, SuspendMark>) {
    const spans = [...marks.values()].sort((a, b) => a.start - b.start)
    const offsets: number[] = [], cumulative: number[] = [], parts: string[] = []
    let cursor = 0, removed = 0
    for (const span of spans) {
        parts.push(text.slice(cursor, span.start))
        offsets.push(span.start - removed)
        removed += span.end - span.start
        cumulative.push(removed)
        cursor = span.end
    }
    parts.push(text.slice(cursor))
    const countBefore = (offset: number, coordinate: 'raw' | 'parsed' | 'line', includeEqual = true): number => {
        let low = 0, high = spans.length
        while (low < high) {
            const middle = (low + high) >>> 1
            const boundary = coordinate === 'line' ? spans[middle].line - middle : coordinate === 'raw' ? spans[middle].end : offsets[middle]
            if (boundary < offset || includeEqual && boundary === offset) low = middle + 1
            else high = middle
        }
        return low
    }
    return {
        text: parts.join(''),
        toRaw: (offset: number) => offset + (cumulative[countBefore(offset, 'parsed') - 1] ?? 0),
        toRawLine: (line: number) => line + countBefore(line, 'line'),
        toRawEnd: (offset: number) => offset + (cumulative[countBefore(offset, 'parsed', false) - 1] ?? 0),
        toParsed: (offset: number) => {
            const n = countBefore(offset, 'raw')
            return Math.min(offset, spans[n]?.start ?? offset) - (cumulative[n - 1] ?? 0)
        },
    }
}
