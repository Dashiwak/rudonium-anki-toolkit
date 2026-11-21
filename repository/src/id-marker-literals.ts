/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
function escaped(text: string, position: number): boolean {
    let slashes = 0
    for (let previous = position - 1; previous >= 0 && text[previous] === '\\'; previous--) slashes++
    return slashes % 2 === 1
}

/** Сохраняет координаты, но скрывает от распознавания ID атрибуты HTML и экранированные примеры комментариев. */
export function maskIdMarkerHtmlLiterals(text: string, hideComments = false): string {
    return scanHtmlLiterals(text, hideComments)
}

export const pageAnswerEnd = '<!--rudonium-answer-end-->'

/** Calls the visitor only outside YAML, HTML containers, comments, code and math literals. */
export function visitRootMarkdownLines(text: string, observer: {
    comment(start: number, lineStart: number, end: number): void
    line(start: number, value: string): void
}): void {
    scanHtmlLiterals(text, false, observer)
}

/** Only a column-zero comment exposed by Markdown can open a page section. */
export function pageDirective(text: string, marker: string, from: number, until: number,
    onLine?: (start: number, value: string) => void): number | undefined {
    const possible = text.indexOf(marker, from)
    if (possible < 0 || possible >= until) return
    let position: number | undefined
    scanHtmlLiterals(text, false, {
        comment(start, lineStart, end) {
            if (start < from || start >= until || start !== lineStart || end - start !== marker.length ||
                !text.startsWith(marker, start)) return
            let next = end
            while (text[next] === ' ' || text[next] === '\t') next++
            if (next !== text.length && text[next] !== '\n' && !text.startsWith('\r\n', next)) return
            if (position !== undefined) throw new Error(marker === pageAnswerEnd
                ? 'Keep one end-of-answer marker on the page. / Оставьте на странице один маркер конца ответа.'
                : 'Keep one additional fields section per page. / Оставьте на странице один раздел дополнительных полей.')
            position = start
        },
        line: onLine && ((start, value) => {
            if (position !== undefined && start > position && start < until) onLine(start, value)
        }),
    })
    return position
}

export function findPageAnswerBoundary(text: string, from = 0): number | undefined {
    return pageDirective(text, pageAnswerEnd, from, text.length)
}

/** A real tag anywhere in Markdown can select a page; fields are bounded separately. */
export function pageTagOffsets(text: string): number[] {
    const offsets: number[] = []
    if (/#anki-page/iu.test(text)) scanHtmlLiterals(text, false, undefined, undefined, at => offsets.push(at))
    return offsets
}

const pageSignature = /^(?:<!--[ \t]*)?ID[ \t]*:[^\r\n]*?[ \t]@page(?=[ \t]*(?:-->|$))/u

/** Only Markdown-level signed lines can bind an ID at the end of a page. */
export function signedPageIdLines(text: string): Array<{ start: number; end: number }> {
    const rows: Array<{ start: number; end: number }> = []
    if (text.includes('@page')) scanHtmlLiterals(text, false, undefined, (start, end) => rows.push({ start, end }))
    return rows
}

function scanHtmlLiterals(text: string, hideComments: boolean,
    observer?: { comment: (start: number, lineStart: number, end: number) => void; line?: (start: number, value: string) => void },
    onPageId?: (start: number, end: number) => void, onPageTag?: (position: number) => void): string {
    if (!onPageTag && !onPageId && !/[<`$]|\\\[/u.test(text) && !(hideComments && text.includes('%%'))) return text
    const ranges: Array<[number, number]> = []
    const serviceId = /<!--[ \t]*ID:/uy
    const maskAnnotation = (from: number, to: number) => {
        if (to > from && /[<%\x60$\\]|ID:/u.test(text.slice(from, to))) ranges.push([from, to])
    }
    let position = 0, lineStart = 0, fence = '', frontmatter = false
    const signed = text.includes('@page')
    const htmlParents: string[] | undefined = observer || onPageTag || signed ? [] : undefined
    let mathLineEnd = -1, nextMathClose = -1
    const advance = (to: number) => {
        const newline = text.slice(position, to).lastIndexOf('\n')
        if (newline >= 0) lineStart = position + newline + 1
        position = to
    }
    while (position < text.length) {
        if (position === lineStart) {
            const newline = text.indexOf('\n', position)
            const end = newline < 0 ? text.length : newline + 1
            const line = text.slice(position, newline < 0 ? text.length : newline).replace(/\r$/u, '')
            if (position === 0 && /^\uFEFF?---[ \t]*$/u.test(line)) { frontmatter = true; advance(end); continue }
            if (frontmatter) {
                if (/^---[ \t]*$/u.test(line)) frontmatter = false
                advance(end); continue
            }
            const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
            if (delimiter) {
                if (!fence) fence = delimiter[1]
                else if (fence[0] === delimiter[1][0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ''
                advance(end); continue
            }
            if (fence || onPageTag && /^(?: {4}| {0,3}\t)/u.test(line)) { advance(end); continue }
            if (!htmlParents?.length) observer?.line?.(position, line)
            if (signed && line.includes('@page') && pageSignature.test(line.trimStart())) {
                if (htmlParents?.length || /^(?: {4}| {0,3}\t)/u.test(line)) {
                    ranges.push([position, position + line.length])
                    advance(end)
                    continue
                }
                onPageId?.(position, position + line.length)
            }
            // Annotation delimiters cannot open a comment or formula extending into the next card.
            const id = /^\uFEFF?[ \t]*(<!--[ \t]*)?ID:[ \t]*\d+(?!\d|[.,]\d|[eE][+-]?\d)/u.exec(line)
            if (id) {
                const close = id[1] ? line.indexOf('-->', id[0].length) : -1
                if (!id[1] || close >= 0) {
                    const suffix = position + id[0].length
                    if (id[1]) {
                        maskAnnotation(suffix, position + close)
                        maskAnnotation(position + close + 3, position + line.length)
                    } else maskAnnotation(suffix, position + line.length)
                    advance(end); continue
                }
            }
        }
        const character = text[position]
        if (character === '\n') { position++; lineStart = position; continue }
        if (text.startsWith('%%', position) && !escaped(text, position)) {
            const end = text.indexOf('%%', position + 2)
            const to = end >= 0 ? end + 2 : text.length
            if (hideComments) ranges.push([position, to])
            advance(to)
            continue
        }
        // HTML-подобный текст внутри кода и формулы не открывает настоящий тег.
        if (character === '`' && !escaped(text, position)) {
            const run = /^`+/u.exec(text.slice(position))![0]
            let end = text.indexOf(run, position + run.length)
            while (end >= 0 && (text[end - 1] === '`' || text[end + run.length] === '`')) end = text.indexOf(run, end + run.length)
            if (end >= 0) {
                const inner = text.slice(position + run.length, end)
                // An inline code span ends at a blank paragraph. Keep explicitly quoted legacy archive examples literal.
                const archive = inner.startsWith('<!--RUDONIUM-ARCHIVE:') && /^<!--RUDONIUM-ARCHIVE:(\d+)(?=:|-->)/u.exec(inner)
                const quotedArchive = archive && inner.endsWith('/RUDONIUM-ARCHIVE:' + archive[1] + '-->')
                if (quotedArchive || !/\n[ \t]*\r?\n/u.test(inner)) {
                    ranges.push([position, end + run.length])
                    advance(end + run.length)
                    continue
                }
            }
            advance(position + run.length); continue
        }
        if (character === '$' && !escaped(text, position)) {
            const delimiter = text.startsWith('$$', position) ? '$$' : '$'
            if (delimiter === '$' && (!text[position + 1] || /\s/u.test(text[position + 1]))) { position++; continue }
            let end: number
            if (delimiter === '$') {
                // The closing rule is independent of the opening position. Scan a long price list once.
                if (position >= mathLineEnd) {
                    const newline = text.indexOf('\n', position + 1)
                    mathLineEnd = newline < 0 ? text.length : newline
                    nextMathClose = -1
                }
                if (nextMathClose <= position) {
                    end = text.indexOf('$', position + 1)
                    while (end >= 0 && end < mathLineEnd && (escaped(text, end) || text[end + 1] === '$' ||
                        text[end - 1] === '$' || /\s/u.test(text[end - 1]) || /[0-9]/u.test(text[end + 1] ?? ''))) {
                        end = text.indexOf('$', end + 1)
                    }
                    nextMathClose = end < 0 || end >= mathLineEnd ? mathLineEnd : end
                }
                end = nextMathClose < mathLineEnd ? nextMathClose : -1
            } else {
                end = text.indexOf(delimiter, position + delimiter.length)
                while (end >= 0 && escaped(text, end)) end = text.indexOf(delimiter, end + delimiter.length)
            }
            if (end >= 0) { ranges.push([position, end + delimiter.length]); advance(end + delimiter.length); continue }
            position += delimiter.length
            continue
        }
        if (text.startsWith('\\[', position) && !escaped(text, position)) {
            const end = text.indexOf('\\]', position + 2)
            if (end >= 0) { ranges.push([position, end + 2]); advance(end + 2); continue }
        }
        if (onPageTag) {
            if (text.startsWith('[[', position) && !escaped(text, position)) {
                const link = /^\[\[[^\[\]\r\n]*\]\]/u.exec(text.slice(position))
                if (link) { advance(position + link[0].length); continue }
            }
            if (character === '[' && !escaped(text, position)) {
                const link = /^\[[^\[\]\r\n]*\](?:\([^()\r\n]*\)|\[[^\[\]\r\n]*\])/u.exec(text.slice(position))
                if (link) { advance(position + link[0].length); continue }
            }
            if (character === '#' && !htmlParents?.length && !escaped(text, position) &&
                (!position || /[\s("'«“‘]/u.test(text[position - 1])) &&
                text.slice(position, position + 10).toLowerCase() === '#anki-page' &&
                !/^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200d_/-]/u.test(text.slice(position + 10, position + 12))) onPageTag(position)
        }
        if (character !== '<') { position++; continue }
        if (text.startsWith('<!--', position)) {
            const close = text.indexOf('-->', position + 4)
            let end = close >= 0 ? close + 3 : text.length
            if (escaped(text, position)) {
                // Экранированное начало не открывает многострочный HTML-комментарий.
                const newline = text.indexOf('\n', position + 4)
                if (newline >= 0) end = Math.min(end, newline)
                ranges.push([position, end])
            }
            else {
                if (signed && position !== lineStart && pageSignature.test(text.slice(position, end))) {
                    const prefix = text.slice(lineStart, position)
                    if (htmlParents?.length || /^(?: {4}| {0,3}\t| {0,3}>| {0,3}(?:[*+-]|\d+[.)])[ \t])/u.test(prefix)) {
                        ranges.push([position, end])
                        advance(end)
                        continue
                    }
                    // An ID accidentally joined to answer text must be repaired before a new note can be created.
                    if (prefix.trim() && onPageId) {
                        const next = text.indexOf('\n', position)
                        const lineEnd = next < 0 ? text.length : next - (text[next - 1] === '\r' ? 1 : 0)
                        onPageId(lineStart, lineEnd)
                    }
                }
                if (observer && !htmlParents?.length) observer.comment(position, lineStart, end)
                if (hideComments) {
                    serviceId.lastIndex = position
                    if (!serviceId.test(text)) ranges.push([position, end])
                }
            }
            // Внутри обычного комментария разметка не открывает HTML-теги.
            advance(end)
            continue
        }
        if (escaped(text, position) || !/^(?:<\/?[A-Za-z][A-Za-z\d:_-]*(?=[\s/>])|<!DOCTYPE(?=\s))/iu.test(text.slice(position))) {
            position++; continue
        }
        const from = position
        let cursor = position + 1
        let quote = ''
        let closed = false
        while (cursor < text.length) {
            const character = text[cursor++]
            if (quote) { if (character === quote) quote = '' }
            else if (character === '"' || character === "'") quote = character
            else if (character === '<') break
            else if (character === '>') { closed = true; break }
        }
        if (!closed) { position++; continue }
        if (htmlParents) {
            // A stand-alone marker inside a raw HTML list, table or other container is a literal.
            const tag = /^<(\/?)(article|aside|blockquote|details|div|figure|footer|form|header|li|main|nav|ol|section|table|td|th|tr|ul)(?=[\s/>])/iu.exec(text.slice(from, cursor))
            if (tag) {
                const name = tag[2].toLowerCase()
                if (tag[1]) {
                    const open = htmlParents.lastIndexOf(name)
                    if (open >= 0) htmlParents.length = open
                } else if (!/\/\s*>$/u.test(text.slice(from, cursor))) htmlParents.push(name)
            }
        }
        // HTML code examples and raw-text elements can contain complete, visible card examples.
        const literal = /^<(pre|code|script|style|textarea)(?=[\s/>])/iu.exec(text.slice(from, cursor))
        if (literal && !/\/\s*>$/u.test(text.slice(from, cursor))) {
            const closing = new RegExp('</' + literal[1] + '\\s*>', 'giu')
            closing.lastIndex = cursor
            const match = closing.exec(text)
            cursor = match ? closing.lastIndex : text.length
        }
        ranges.push([from, cursor])
        advance(cursor)
    }
    if (observer || onPageId || onPageTag || !ranges.length) return text
    const pieces: string[] = []
    let previous = 0
    for (const [from, to] of ranges) {
        pieces.push(text.slice(previous, from), text.slice(from, to).replace(/[^\r\n]/g, ' '))
        previous = to
    }
    pieces.push(text.slice(previous))
    return pieces.join('')
}
