/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import type { CachedMetadata, HeadingCache } from 'obsidian'

interface EditorLine {
    text: string
    number: number
    offset: number
}

type CommentEnd = '-->' | '%%'

const fenceMarker = /^ {0,3}(`{3,}|~{3,})/
const atxHeading = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/
const setextMarker = /^ {0,3}(=+|-+)[ \t]*$/
const blockBoundary = /^(?: {4}|\t| {0,3}(?:>|[-+*](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$)|(?:\* *){3,}$|(?:_ *){3,}$|(?:- *){3,}$))/

function* editorLines(text: string): IterableIterator<EditorLine> {
    const separator = /\r\n|\n|\r/g
    let number = 0
    let offset = 0
    for (const match of text.matchAll(separator)) {
        const end = match.index!
        yield { text: text.slice(offset, end), number, offset }
        offset = end + match[0].length
        number++
    }
    if (offset < text.length) yield { text: text.slice(offset), number, offset }
}

function commentFreeLine(text: string, comment: CommentEnd | undefined): { text: string; comment?: CommentEnd } {
    const markers = /<!--|%%|`+/g
    let from = 0
    const parts: string[] = []
    while (from < text.length) {
        if (comment) {
            const end = text.indexOf(comment, from)
            const next = end < 0 ? text.length : end + comment.length
            parts.push(' '.repeat(next - from))
            from = next
            if (end < 0) break
            comment = undefined
        }
        markers.lastIndex = from
        const mark = markers.exec(text)
        if (!mark) {
            parts.push(text.slice(from))
            break
        }
        parts.push(text.slice(from, mark.index))
        from = mark.index
        if (mark[0][0] === '`') {
            // Совпадающая серия обратных кавычек сохраняет маркеры комментариев внутри кода как обычный текст.
            const ticks = /`+/g
            ticks.lastIndex = markers.lastIndex
            let end: RegExpExecArray | null
            do { end = ticks.exec(text) } while (end && end[0].length !== mark[0].length)
            const next = end ? ticks.lastIndex : markers.lastIndex
            parts.push(text.slice(from, next))
            from = next
        } else {
            let escapeStart = mark.index
            while (escapeStart > 0 && text[escapeStart - 1] === '\\') escapeStart--
            if ((mark.index - escapeStart) % 2) {
                parts.push(mark[0])
                from = markers.lastIndex
            } else {
                comment = mark[0] === '%%' ? '%%' : '-->'
                // Сразу забираем начальный маркер, чтобы один %% не закрыл сам себя.
                parts.push(' '.repeat(mark[0].length))
                from = markers.lastIndex
            }
        }
    }
    return { text: parts.join(''), comment }
}

function position(line: EditorLine, col: number): HeadingCache['position']['start'] {
    return { line: line.number, col, offset: line.offset + col }
}

/** Позиции заголовков в предпросмотре берём только из текущего текста редактора. */
export function editorPreviewMetadata(text: string, cached?: CachedMetadata | null): CachedMetadata {
    const headings: HeadingCache[] = []
    const previousHeadings = new Map(cached?.headings?.map(heading => [heading.position.start.offset, heading]))
    const add = (heading: string, level: number, start: EditorLine, col: number, end: EditorLine) => {
        if (!heading) return
        const from = position(start, col)
        const to = position(end, end.text.length)
        const previous = previousHeadings.get(from.offset)
        const reusable = previous && previous.heading === heading && previous.level === level &&
            previous.position.start.line === from.line && previous.position.start.col === from.col &&
            previous.position.end.offset === to.offset && previous.position.end.line === to.line && previous.position.end.col === to.col
        headings.push(reusable ? previous : { heading, level, position: { start: from, end: to } })
    }
    let frontmatter = false
    let fence: string | undefined
    let comment: CommentEnd | undefined
    let math = false
    let paragraph: { start: EditorLine; col: number; lines: string[] } | undefined
    for (const line of editorLines(text)) {
        const prefix = line.number === 0 && line.text.startsWith('\uFEFF') ? 1 : 0
        const source = line.text.slice(prefix)
        if (line.number === 0 && /^---[ \t]*$/.test(source)) {
            frontmatter = true
            continue
        }
        if (frontmatter) {
            if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) frontmatter = false
            continue
        }
        const fenceMatch = !comment && !math ? fenceMarker.exec(source) : null
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length &&
                    !source.slice(fenceMatch[0].length).trim()) fence = undefined
            continue
        }
        if (fenceMatch && (fenceMatch[1][0] === '~' || !source.slice(fenceMatch[0].length).includes('`'))) {
            fence = fenceMatch[1]
            paragraph = undefined
            continue
        }
        if (!comment && /^ {0,3}\$\$[ \t]*$/.test(source)) {
            math = !math
            paragraph = undefined
            continue
        }
        if (math) continue
        const visible = commentFreeLine(source, comment)
        comment = visible.comment
        const atx = atxHeading.exec(visible.text)
        if (atx) {
            add(atx[3].replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim(), atx[2].length, line, prefix + atx[1].length, line)
            paragraph = undefined
            continue
        }
        const underline = setextMarker.exec(visible.text)
        if (underline) {
            if (paragraph) add(paragraph.lines.join('\n'), underline[1][0] === '=' ? 1 : 2, paragraph.start, paragraph.col, line)
            paragraph = undefined
            continue
        }
        const trimmed = visible.text.trim()
        if (!trimmed || blockBoundary.test(visible.text)) {
            paragraph = undefined
        } else if (paragraph) {
            paragraph.lines.push(trimmed)
        } else {
            paragraph = { start: line, col: prefix + visible.text.indexOf(trimmed), lines: [trimmed] }
        }
    }
    return { ...cached, headings }
}

/** Keep cached links used by the renderer only when the literal still belongs to the public page prefix. */
export function pagePrefixMetadata(visible: string, cached?: CachedMetadata | null): CachedMetadata {
    const metadata = editorPreviewMetadata(visible)
    const belongs = (item: { original: string; position: { start: { offset: number }; end: { offset: number } } }) => {
        const from = item.position.start.offset, to = item.position.end.offset
        return from >= 0 && to <= visible.length && from < to && visible.slice(from, to) === item.original
    }
    if (cached?.links) metadata.links = cached.links.filter(belongs)
    if (cached?.embeds) metadata.embeds = cached.embeds.filter(belongs)
    return metadata
}
