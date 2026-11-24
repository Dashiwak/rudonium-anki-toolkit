// SPDX-License-Identifier: GPL-3.0-only
import { hasPageYamlIdText, mayHavePageTag, pageHeading, archivedPageProperty } from './page-frontmatter'
import { parseAnkiIdMarker } from './anki-id-marker'
import { findPageAnswerBoundary, maskIdMarkerHtmlLiterals, pageAnswerEnd } from './id-marker-literals'
import { maskMarkdownSpans } from './markdown-pipeline'

export type ArchiveStyle = 'mark' | 'strike' | 'hidden'

export interface ArchiveRange {
    privateTail?: boolean
    yamlStart?: number
    yamlEnd?: number
    style: ArchiveStyle | 'legacy'
    sourceEnd?: number
    payloadStart?: number
    payloadEnd?: number
    id: number
    start: number
    end: number
    bodyStart: number
    bodyEnd: number
    statusStart: number
}

interface ParsedRange extends ArchiveRange { ownerStart?: number }

const token = 'RUDONIUM-ARCHIVE'
const delimiter = /^<!--(\/?)RUDONIUM-ARCHIVE:([1-9]\d*)(:mark)?-->[ \t]*$/u
const packedHeader = /^<!--RUDONIUM-ARCHIVE:([1-9]\d*):(hidden|strike):([a-f0-9]{8})$/u
const projectionStart = '<del data-rudonium="RUDONIUM-ARCHIVE:'

const statusLine = /^\*\*[^\r\n]+\*\*[ \t]*$/u
const broken = () => new Error('Check the archive boundaries and the retained Anki ID in this file. / Проверьте границы архивного блока и сохранённый ID Anki в этом файле.')

let previous: { text: string; ranges: ArchiveRange[]; active?: string } | undefined

const commentEntities: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '-': '&#45;', '%': '&#37;' }
const originalCharacters: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#45;': '-', '&#37;': '%' }

function packSource(source: string): string {
    const escaped = source.replace(/[&<>]|-{2,}|%{2,}/gu, group => commentEntities[group[0]].repeat(group.length))
    return '| ' + escaped.replace(/\n/gu, '\n| ')
}

function unpackSource(payload: string): string {
    const original = payload.split('\n').map(line => {
        if (!line.startsWith('| ')) throw broken()
        return line.slice(2)
    }).join('\n').replace(/&(?:amp|lt|gt|#45|#37);/gu, entity => originalCharacters[entity])
    if (packSource(original) !== payload) throw broken()
    return original
}

// FNV-1a detects accidental edits or a mismatched owner. Ignore editor-wide CRLF/LF conversions.
function checksum(style: ArchiveStyle, id: number, source: string): string {
    const data = style + ':' + id + ':' + source.replace(/\r\n/gu, '\n')
    let hash = 0x811c9dc5
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data.charCodeAt(i), 0x01000193)
    return (hash >>> 0).toString(16).padStart(8, '0')
}

// Whole-page archives leave Properties accessible in Obsidian. Authenticate the external ID
// against the original marked H1 before allowing it to stand in for the heading ID line.
function pageArchiveContext(text: string, start: number, body: string, id: number, archiveEnd: number) {
    const prefix = text.slice(0, start)
    if (prefix !== '' && prefix !== '\ufeff') {
        const first = /^\uFEFF?---[ \t]*\r?\n/u.exec(prefix)
        if (!first) return
        const close = /^---[ \t]*\r?\n/mu.exec(prefix.slice(first[0].length))
        if (!close || first[0].length + close.index + close[0].length !== prefix.length) return
    }
    // If only the private appendix carries the tag, authenticate it against the original public
    // page and the verified end-of-answer marker. Never take an ID from the appendix.
    const appendix = body.trimEnd().endsWith(pageAnswerEnd) && findPageAnswerBoundary(body) !== undefined
        ? text.slice(archiveEnd) : ''
    if (!mayHavePageTag(body) && !mayHavePageTag(prefix) && !mayHavePageTag(appendix)) return
    const source = prefix + body + (appendix ? '\n' + appendix : '')
    const heading = pageHeading(source)
    if (!heading) return
    const owner = hasPageYamlIdText(prefix) ? archivedPageProperty(source) : undefined
    if (owner && owner.id !== id) throw broken()
    const boundary = findPageAnswerBoundary(source, heading.start + heading.heading[0].length)
    return { owner, privateTail: boundary !== undefined }
}

function struckProjection(source: string, id: number, propertyOwner = false): string {
    const rows = source.split(/\r?\n/u)
    if (rows[rows.length - 1] === '') rows.pop()
    const candidates = rows.flatMap((line, index) => line.includes('ID:') && parseAnkiIdMarker(line)?.id === id ? [index] : [])
    if (!propertyOwner && !candidates.length) throw broken()
    let ownedLine = propertyOwner ? -1 : candidates[0]
    if (!propertyOwner && candidates.length > 1) {
        // A code example may quote the same ID as the actual marker. Hide only the physical owner.
        const prefix = '<!--RUDONIUM-ARCHIVE:' + id + ':mark-->\n'
        const [owner] = readRanges(prefix + source + '\n<!--/RUDONIUM-ARCHIVE:' + id + '-->')
        if (owner?.ownerStart === undefined) throw broken()
        ownedLine = source.slice(0, owner.ownerStart - prefix.length).split('\n').length - 1
    }
    const visible = rows.filter((_line, index) => index !== ownedLine)
    // Encode Markdown and HTML punctuation. Text from cards is never interpreted as HTML, a
    // transclusion, a link or an additional card in this rendering. The original remains intact.
    const escaped = visible.map(line => line.replace(/[!-/:-@[-`{-~]|[\r\t]/gu,
        char => '&#' + char.charCodeAt(0) + ';'))
    return projectionStart + id + '">' + escaped.join('<br>') + '</del>'
}

function readPacked(text: string, start: number, payloadStart: number, header: RegExpExecArray): ArchiveRange {
    const id = Number(header[1]), style = header[2] as 'strike' | 'hidden'
    if (!Number.isSafeInteger(id) || payloadStart >= text.length) throw broken()
    const closeAt = text.indexOf('-->', payloadStart)
    if (closeAt === -1) throw broken()
    const closing = '/RUDONIUM-ARCHIVE:' + id + '-->'
    const sourceEnd = closeAt + 3
    const footer = sourceEnd - closing.length
    if (footer <= payloadStart || text[footer - 1] !== '\n' || !text.startsWith(closing, footer) ||
        (sourceEnd < text.length && text[sourceEnd] !== '\n' && !text.startsWith('\r\n', sourceEnd))) throw broken()
    const payloadEnd = footer - (text[footer - 2] === '\r' ? 2 : 1)
    const source = unpackSource(text.slice(payloadStart, payloadEnd))
    if (checksum(style, id, source) !== header[3]) throw broken()
    let end = sourceEnd, bodyStart = end
    if (style === 'strike') {
        bodyStart = sourceEnd + (text.startsWith('\r\n', sourceEnd) ? 2 : 1)
        const nextLine = text.indexOf('\n', bodyStart)
        end = nextLine === -1 ? text.length : nextLine - (text[nextLine - 1] === '\r' ? 1 : 0)
    }
    const context = pageArchiveContext(text, start, source, id, end), owner = context?.owner
    if (style === 'strike' && (bodyStart >= end || text.slice(bodyStart, end) !== struckProjection(source, id, !!owner))) throw broken()
    return { id, style, privateTail: context?.privateTail, yamlStart: owner?.start, yamlEnd: owner?.end, start, end, sourceEnd, payloadStart, payloadEnd, bodyStart, bodyEnd: end, statusStart: end }
}

export function archivedCardSource(text: string, range: ArchiveRange): string {
    if (range.payloadStart !== undefined && range.payloadEnd !== undefined) {
        return unpackSource(text.slice(range.payloadStart, range.payloadEnd))
    }
    return text.slice(range.bodyStart, range.bodyEnd)
}

function readRanges(text: string): ParsedRange[] {
    const safe = maskIdMarkerHtmlLiterals(text)
    const ranges: ParsedRange[] = []
    const ids = new Set<number>()
    let open: { start: number; bodyStart: number; style: 'legacy' | 'mark'; id: number; ownerStart?: number; owners: number[] } | undefined
    let fence = '', comment = '', yaml = false
    let lastLine = '', lastStart = 0
    for (let row = 0; row < text.length;) {
        const newline = text.indexOf('\n', row)
        const next = newline < 0 ? text.length : newline + 1
        const to = newline < 0 ? text.length : text[newline - 1] === '\r' ? newline - 1 : newline
        const from = row === 0 && text.charCodeAt(0) === 0xfeff ? 1 : row
        const line = safe.slice(from, to)
        const original = text.slice(from, to)
        const first = row === 0
        row = next
        if (first && /^---[ \t]*$/u.test(line)) { yaml = true; continue }
        if (yaml) { if (/^---[ \t]*$/u.test(line)) yaml = false; continue }
        if (comment) {
            if (line.includes(comment)) comment = ''
            continue
        }
        const backticks = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
        if (fence) {
            if (backticks && backticks[1][0] === fence[0] && backticks[1].length >= fence.length && !backticks[2].trim()) fence = ''
            continue
        }
        if (backticks) { fence = backticks[1]; continue }
        if ((original.startsWith(projectionStart) && line.trim()) || /^\/RUDONIUM-ARCHIVE:\d+-->$/u.test(line)) throw broken()
        if (/^\s*<!--\/?RUDONIUM-ARCHIVE\b/u.test(line) && !/^(?: {4}|\t)/u.test(line)) {
            const packed = packedHeader.exec(original)
            if (packed) {
                if (open || ids.has(Number(packed[1]))) throw broken()
                const range = readPacked(text, from, next, packed)
                ids.add(range.id)
                ranges.push(range)
                if (range.privateTail) break
                row = range.end + (text.startsWith('\r\n', range.end) ? 2 : 1)
                continue
            }
            const match = delimiter.exec(original)
            const id = match && Number(match[2])
            if (!match || !id || !Number.isSafeInteger(id) || match[1] && match[3]) throw broken()
            if (!match[1]) {
                if (open || ids.has(id)) throw broken()
                open = { id, style: match[3] ? 'mark' : 'legacy', start: from, bodyStart: next, owners: [] }
                ids.add(id)
            } else {
                if (!open || id !== open.id || from <= lastStart) throw broken()
                const hasStatus = statusLine.test(lastLine) && text.slice(lastStart, from).trimEnd() === lastLine.trimEnd()
                const statusStart = hasStatus ? lastStart : from
                let bodyEnd = statusStart
                for (let i = 0; i < (hasStatus ? 2 : 1) && bodyEnd > open.bodyStart && text[bodyEnd - 1] === '\n'; i++) {
                    bodyEnd--; if (text[bodyEnd - 1] === '\r') bodyEnd--
                }
                const context = pageArchiveContext(text, open.start, text.slice(open.bodyStart, bodyEnd), id, to), owner = context?.owner
                if (owner ? open.owners.length !== 0 : open.owners.length !== 1 || open.owners[0] !== id) throw broken()
                ranges.push({ id, style: open.style, privateTail: context?.privateTail, yamlStart: owner?.start, yamlEnd: owner?.end, ownerStart: open.ownerStart, start: open.start, end: to, bodyStart: open.bodyStart, bodyEnd, statusStart })
                open = undefined
                if (context?.privateTail) break
            }
        } else {
            if (open && !/^(?: {4}|\t)/u.test(line) && line.includes('ID:')) {
                const marker = parseAnkiIdMarker(line)
                if (marker) {
                    open.owners.push(marker.id)
                    open.ownerStart = from
                }
            }
            const fragments = /<!--|-->|%%/gu
            for (const part of line.matchAll(fragments)) {
                if (comment) { if (part[0] === comment) comment = '' }
                else if (part[0] === '<!--') comment = '-->'
                else if (part[0] === '%%') comment = '%%'
            }
        }
        lastLine = original
        lastStart = from
    }
    if (open) throw broken()
    return ranges
}

export function archivedCardRanges(text: string): readonly ArchiveRange[] {
    if (!text.includes(token)) return []
    if (previous?.text !== text) previous = { text, ranges: readRanges(text) }
    return previous.ranges
}

export function activeCardMarkdown(text: string): string {
    if (!text.includes(token)) return text
    const ranges = archivedCardRanges(text)
    if (!ranges.length) return text
    return previous!.active ??= maskMarkdownSpans(text, ranges.flatMap(r => {
        const spans: [number, number][] = []
        if (r.yamlStart !== undefined && r.yamlEnd !== undefined) spans.push([r.yamlStart, r.yamlEnd])
        spans.push([r.start, r.privateTail ? text.length : r.end])
        return spans
    }))
}

export function wrapArchivedCard(block: string, id: number, label: string, page = false,
    eol: string = /\r\n|\n/u.exec(block)?.[0] ?? '\n', style: ArchiveStyle = 'mark', appendix = ''): string {
    if (!Number.isSafeInteger(id) || id <= 0 || !label || label !== label.trim() || /[\r\n*]/u.test(label) ||
        !/^(?:\r\n|\n)$/u.test(eol)) throw broken()
    let start = block.charCodeAt(0) === 0xfeff ? 1 : 0
    if (page && /^---[ \t]*\r?\n/u.test(block.slice(start))) {
        const front = /^---[ \t]*\r?\n[\s\S]*?^---[ \t]*\r?\n/mu.exec(block.slice(start))
        if (!front || front.index !== 0) throw broken()
        start += front[0].length
    }
    const inside = block.slice(start)
    const tail = /\r?\n$/u.exec(inside)?.[0] ?? ''
    if (style !== 'mark' && style !== 'strike' && style !== 'hidden') throw broken()
    const prefix = block.slice(0, start)
    const marked = prefix + '<!--RUDONIUM-ARCHIVE:' + id + ':mark-->' + eol + inside +
        (tail ? '' : eol) + eol + '**' + label + '**' + eol + '<!--/RUDONIUM-ARCHIVE:' + id + '-->' + tail
    // Use the same strict ownership test for every representation before replacing a live card.
    if (archivedCardRanges(marked + appendix).length !== 1) throw broken()
    if (style === 'mark') return marked
    const propertyOwner = page && !!pageArchiveContext(block + appendix, start, inside, id, block.length)?.owner
    const packed = '<!--RUDONIUM-ARCHIVE:' + id + ':' + style + ':' + checksum(style, id, inside) + eol +
        packSource(inside) + eol + '/RUDONIUM-ARCHIVE:' + id + '-->'
    const result = prefix + packed + (style === 'strike' ? eol + struckProjection(inside, id, propertyOwner) : '') + tail
    if (archivedCardRanges(result + appendix).length !== 1) throw broken()
    return result
}
