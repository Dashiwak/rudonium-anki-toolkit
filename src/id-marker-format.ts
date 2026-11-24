/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { pageFooterMarker, parseAnkiIdMarker } from './anki-id-marker'
import { maskIdMarkerHtmlLiterals } from './id-marker-literals'

export interface IdMarkerSpan {
    id: number
    from: number
    to: number
    text: string
    comment: boolean
    inner: string
    line: number
}

export function collectIdMarkerSpans(text: string, syntax: DuplicateMarkerSyntax = {}): IdMarkerSpan[] {
    const visible = maskIdMarkerHtmlLiterals(text)
    const found = findIdMarkers(visible, syntax)
    if (!found.length) return []
    const rows = text.split(/\r\n?|\n/u)
    const visibleRows = visible.split(/\r\n?|\n/u)
    const byLine = new Map<number, typeof found>()
    for (const marker of found) {
        const existing = byLine.get(marker.line) ?? []
        existing.push(marker)
        byLine.set(marker.line, existing)
    }
    const result: IdMarkerSpan[] = []
    let offset = 0, fence = '', comment = '', math = '', frontmatter = /^\uFEFF?---[ \t]*$/u.test(rows[0])
    for (let index = 0; index < rows.length; index++) {
        const line = visibleRows[index]
        const newline = offset + line.length
        const next = newline + (text.charCodeAt(newline) === 13 && text.charCodeAt(newline + 1) === 10 ? 2 : 1)
        if (frontmatter) {
            if (index && /^---[ \t]*$/u.test(line)) frontmatter = false
            offset = next; continue
        }
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
        if (!comment && !math && delimiter) {
            if (!fence) fence = delimiter[1]
            else if (fence[0] === delimiter[1][0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ''
            offset = next; continue
        }
        if (fence) { offset = next; continue }
        const protectedColumns = new Uint8Array(line.length)
        for (let position = 0; position < line.length;) {
            if (comment) {
                const end = line.indexOf(comment, position)
                const until = end < 0 ? line.length : end + comment.length
                protectedColumns.fill(1, position, until)
                position = until
                if (end >= 0) comment = ''
                continue
            }
            if (math) {
                const end = line.indexOf(math, position)
                const until = end < 0 ? line.length : end + math.length
                protectedColumns.fill(1, position, until)
                position = until
                if (end >= 0) math = ''
                continue
            }
            if (line.startsWith('<!--', position)) {
                const end = line.indexOf('-->', position + 4)
                if (end >= 0 && parseAnkiIdMarker(line.slice(position, end + 3))) { position = end + 3; continue }
                comment = '-->'; protectedColumns.fill(1, position, position + 4); position += 4; continue
            }
            if (line.startsWith('%%', position)) { comment = '%%'; protectedColumns.fill(1, position, position + 2); position += 2; continue }
            if (line[position] === '`' && line[position - 1] !== '\\') {
                const run = /^`+/u.exec(line.slice(position))![0]
                const end = line.indexOf(run, position + run.length)
                const until = end < 0 ? line.length : end + run.length
                protectedColumns.fill(1, position, until); position = until; continue
            }
            if (line.startsWith('$$', position) && line[position - 1] !== '\\') {
                math = '$$'; protectedColumns.fill(1, position, position + 2); position += 2; continue
            }
            if (line.startsWith('\\[', position)) { math = '\\]'; protectedColumns.fill(1, position, position + 2); position += 2; continue }
            if (line[position] === '$' && line[position - 1] !== '\\') {
                const end = line.indexOf('$', position + 1)
                if (end >= 0) { protectedColumns.fill(1, position, end + 1); position = end + 1; continue }
            }
            position++
        }
        for (const marker of (byLine.get(index + 1) ?? []).sort((left, right) => left.column - right.column)) {
            if (protectedColumns[marker.column]) continue
            const raw = rows[index]
            if (pageFooterMarker(raw)) continue
            const opening = raw.lastIndexOf('<!--', marker.column)
            const closing = opening >= 0 ? raw.indexOf('-->', marker.column) : -1
            let start = marker.column, end = raw.length
            if (opening >= 0 && closing >= 0 && /^[ \t]*$/u.test(raw.slice(opening + 4, marker.column))) {
                start = opening; end = closing + 3
            } else {
                const inlineStart = syntax['Begin Inline Note'] ?? 'STARTI'
                const inlineEnd = syntax['End Inline Note'] ?? 'ENDI'
                const nextStart = inlineStart ? raw.indexOf(inlineStart, marker.column + 3) : -1
                if (nextStart >= 0) end = nextStart
                if (inlineStart && inlineEnd && raw.lastIndexOf(inlineStart, marker.column) >= 0) {
                    const close = raw.indexOf(inlineEnd, marker.column)
                    if (close >= 0) end = Math.min(end, close)
                }
            }
            const parsed = parseAnkiIdMarker(raw.slice(start, end))
            if (!parsed || parsed.id !== marker.id) continue
            const from = offset + start + parsed.from, to = offset + start + parsed.to
            if (result.length && result[result.length - 1].to > from) continue
            result.push({ id: parsed.id, from, to, text: text.slice(from, to), comment: parsed.comment,
                inner: parsed.inner, line: index + 1 })
        }
        offset = next
    }
    return result
}

export type IdMarkerDirection = 'to-comment' | 'to-plain'

export function convertIdMarkerText(text: string, direction: IdMarkerDirection,
    syntax: DuplicateMarkerSyntax = {}): { text: string; markers: IdMarkerSpan[] } {
    const markers = collectIdMarkerSpans(text, syntax).filter(marker => direction === 'to-comment' ? !marker.comment : marker.comment)
    let result = text
    for (const marker of [...markers].sort((left, right) => right.from - left.from)) {
        const replacement = direction === 'to-comment' ? `<!--${marker.inner}-->` : marker.inner
        result = result.slice(0, marker.from) + replacement + result.slice(marker.to)
    }
    return { text: result, markers }
}
