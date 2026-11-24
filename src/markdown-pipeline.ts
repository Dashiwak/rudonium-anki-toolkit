/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
type Span = readonly [start: number, end: number]

export function markdownHighlightPattern(): RegExp {
    return /(?<!=)==(?!=)([^\r\n]+?)(?<!=)==(?!=)/gu
}

export function sameEditorText(current: string, saved: string | undefined): boolean {
    return current === saved || (saved !== undefined && current.replace(/\r\n/g, '\n') === saved.replace(/\r\n/g, '\n'))
}

export function makeSpanOverlap(spans: readonly Span[]): (start: number, end: number) => boolean {
    const sorted = spans.filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1]
        if (last && start <= last[1]) last[1] = Math.max(last[1], end)
        else merged.push([start, end])
    }
    return (start, end) => {
        if (start >= end) return false
        let low = 0
        let high = merged.length
        while (low < high) {
            const mid = low + Math.floor((high - low) / 2)
            if (merged[mid][1] <= start) low = mid + 1
            else high = mid
        }
        return low < merged.length && merged[low][0] < end
    }
}

export function makeSpanLookup(spans: readonly Span[]): (offset: number) => boolean {
    const overlaps = makeSpanOverlap(spans)
    return offset => overlaps(offset, offset + 1)
}

export function maskMarkdownSpans(text: string, spans: readonly Span[]): string {
    if (!spans.length) return text
    const pieces: string[] = []
    let cursor = 0
    for (const [start, end] of spans.slice().sort((a, b) => a[0] - b[0])) {
        if (end <= cursor) continue
        if (cursor < start) pieces.push(text.slice(cursor, start))
        pieces.push(text.slice(Math.max(cursor, start), end).replace(/[^\r\n]+/g, segment => ' '.repeat(segment.length)))
        cursor = end
    }
    pieces.push(text.slice(cursor))
    return pieces.join('')
}

export function findMarkdownSyntaxSpans(text: string, fenced: RegExp, inline: RegExp,
    displayMath: RegExp, inlineMath: RegExp): { code: Array<[number, number]>; math: Array<[number, number]> } {
    const hasMath = text.includes('$')
    const hasBackticks = text.includes('`')
    const hasFence = text.includes('```') || text.includes('~~~')
    if (!hasMath && !hasBackticks && !hasFence) return { code: [], math: [] }
    const collect = (pattern: RegExp, value: string): Array<[number, number]> =>
        Array.from(value.matchAll(pattern), (match): [number, number] => [match.index ?? 0, (match.index ?? 0) + match[0].length])
    const displayCode = hasFence ? collect(fenced, text) : []
    const isDisplayCode = makeSpanOverlap(displayCode)
    const outsideFences = maskMarkdownSpans(text, displayCode)
    const inlineCode = hasBackticks ? collect(inline, outsideFences).filter(([start, end]) => !isDisplayCode(start, end)) : []
    const code = displayCode.concat(inlineCode)
    if (!hasMath) return { code, math: [] }
    const sourceMath = maskMarkdownSpans(outsideFences, inlineCode)
    return { code, math: collect(displayMath, sourceMath).concat(collect(inlineMath, sourceMath)) }
}

export function removeUnprotectedMatches(text: string, regex: RegExp, isProtected: (offset: number) => boolean): string {
    const pieces: string[] = []
    let cursor = 0
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
        if (match.index === undefined || isProtected(match.index)) continue
        pieces.push(text.slice(cursor, match.index))
        cursor = match.index + match[0].length
    }
    pieces.push(text.slice(cursor))
    return pieces.join('')
}

export function* matchesOutsideSpans(pattern: RegExp | Iterable<RegExpMatchArray>, text: string,
    spans: readonly Span[]): IterableIterator<RegExpMatchArray> {
    const initialCount = spans.length
    let sorted: Span[] | undefined
    let nextInitial = 0
    let nextAdded = initialCount
    let furthestEnd = -Infinity
    for (const match of pattern instanceof RegExp ? text.matchAll(pattern) : pattern) {
        if (match.index === undefined) continue
        sorted ??= spans.slice(0, initialCount).sort((a, b) => a[0] - b[0])
        const start = match.index + 1
        const finish = match.index + match[0].length - 1
        for (; nextInitial < sorted.length && sorted[nextInitial][0] <= start; nextInitial++) {
            furthestEnd = Math.max(furthestEnd, sorted[nextInitial][1])
        }
        for (; nextAdded < spans.length; nextAdded++) {
            furthestEnd = Math.max(furthestEnd, spans[nextAdded][1])
        }
        if (furthestEnd >= finish) continue
        yield match
    }
}

export function joinIdInsertions(text: string, inserts: ReadonlyArray<readonly [number, string]>,
    renderMarker?: (text: string, position: number, marker: string) => string): string {
    if (!inserts.length) return text
    const ordered = inserts.slice().sort((a, b) => a[0] - b[0])
    const pieces: string[] = []
    let offset = 0
    for (const [position, marker] of ordered) {
        if (!Number.isInteger(position) || position < 0 || position > text.length) {
            throw new Error('Invalid position for writing a new Anki ID.')
        }
        pieces.push(text.slice(offset, position), renderMarker ? renderMarker(text, position, marker) : marker)
        offset = position
    }
    pieces.push(text.slice(offset))
    return pieces.join('')
}

const memoByFormatter = new WeakMap<object, Map<string, string>>()

export function memoizeMarkdownField(owner: object, text: string, cloze: boolean, highlights: boolean, render: () => string): string {
    if (text.length > 1024 || /[[\]<>!]/.test(text)) return render()
    let memo = memoByFormatter.get(owner)
    if (!memo) {
        memo = new Map()
        memoByFormatter.set(owner, memo)
    }
    const key = `${Number(cloze)}${Number(highlights)}:${text}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const value = render()
    if (value.length <= 4096 && memo.size < 128) memo.set(key, value)
    return value
}

export function suspiciousMathCardLines(text: string, math: readonly Span[], code: readonly Span[]): number[] {
    if (!math.length) return []
    const insideMath = makeSpanLookup(math)
    const insideCode = makeSpanLookup(code)
    const lines: number[] = []
    let offset = 0
    const rows = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []
    for (const [index, row] of rows.entries()) {
        const candidate = /^([ \t]*)(?:[-+*] +[^\r\n]+[ \t]::[ \t]+\S|Q:[ \t]+\S|START(?:I)?[ \t]*(?:\r?\n|\r|$))/.exec(row)
        if (candidate) {
            const start = offset + candidate[1].length
            if (insideMath(start) && !insideCode(start)) lines.push(index + 1)
        }
        offset += row.length
    }
    return lines
}

/** Original offsets of the YAML properties, including a BOM or Windows line endings. */
export function frontmatterBounds(content: string): { start: number; close: number; end: number } | undefined {
    const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(content)
    if (!opening) return undefined
    const start = opening[0].length
    const closing = /^---[ \t]*\r?$/m.exec(content.slice(start))
    const close = closing ? start + closing.index : content.length
    return { start, close, end: closing ? close + closing[0].replace(/\r$/, '').length : content.length }
}

