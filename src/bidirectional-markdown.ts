/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { hasLinkedAnswerSlot } from './card-format-presets'
import { parseAnkiIdMarker } from './anki-id-marker'
import type { LinkedBullet } from './linked-bullets'
import type { BidirectionalBlock } from './bidirectional-blocks'
import { isExplicitFieldBoundary, isWritableBlockExtraName } from './bidirectional-blocks'
import { legacyFieldSections } from './legacy-field-sections'
import { planPageFieldInsertion } from './page-field-insertion'
import { isRecoveryTag } from './export-recovery'
import { parseExplicitLinkedField } from './bidirectional-fields'

export type EditableCardField = 'Front' | 'Back'

export interface MarkdownPatch {
    start: number
    end: number
    text: string
}

export interface CardTagOverride {
    add: string[]
    remove: string[]
}

const tagCommentStart = '<!-- anki-bidirectional-tags:'
const fieldSeparator = /[ \t]+::[ \t]+/
const entities: Readonly<Record<string, string>> = {
    amp: '&', AMP: '&', apos: "'", gt: '>', GT: '>', lt: '<', LT: '<', nbsp: '\u00a0', quot: '"', QUOT: '"',
}

function tagKey(tag: string): string {
    return tag.normalize('NFC').toLowerCase()
}

function tagIndex(tags: readonly string[]): Map<string, string> {
    const index = new Map<string, string>()
    for (const value of tags) {
        for (const tag of value.split(/\s+/u)) {
            const key = tagKey(tag)
            if (key && !index.has(key) && !isRecoveryTag(key)) index.set(key, tag)
        }
    }
    return index
}

export function validCardTags(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((tag: unknown) =>
        typeof tag === 'string' && tag.length > 0 && !/[\s\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(tag))
}

function lineEnd(content: string, start: number): number {
    const newline = content.indexOf('\n', start)
    if (newline === -1) return content.length
    return content[newline - 1] === '\r' ? newline - 1 : newline
}

function followingLine(content: string, anchor: number): number | undefined {
    if (content.startsWith('\r\n', anchor)) return anchor + 2
    if (content[anchor] === '\n') return anchor + 1
}

/** A tag override may precede or follow the editable fields of the same ID. */
function tagLine(content: string, anchor: number) {
    const next = followingLine(content, anchor)
    if (next === undefined) return
    const end = lineEnd(content, next)
    const line = content.slice(next, end).trim()
    if (line.startsWith(tagCommentStart)) return { anchor, end, line }
}

function cardMetadata(content: string, card: TagSource) {
    const anchor = card.tagEnd ?? card.end
    const first = tagLine(content, anchor)
    const next = followingLine(content, first?.end ?? anchor)
    if (card.format === 'page' || next === undefined || !content.startsWith('<!--anki-fields-->', next)) {
        return { anchor, tag: first, end: first?.end ?? anchor }
    }
    const legacyEnd = legacyFieldSections(content).ends.get(next)
    if (legacyEnd === undefined) return { anchor, tag: first, end: first?.end ?? anchor }
    const last = tagLine(content, legacyEnd)
    if (first && last) throw new Error('Repeated tag comment for Anki ID / Повтор меток тегов у ID ' + card.id)
    return { anchor: last?.anchor ?? anchor, tag: first ?? last, end: first?.end ?? anchor }
}

/** Keep inert 0.9.7 appendices outside a deleted or archived card. */
export function cardMetadataEnd(content: string, card: TagSource): number {
    const metadata = cardMetadata(content, card)
    if (metadata.tag) tagComment(content, card, metadata)
    return Math.max(card.end, metadata.end)
}

function tagComment(content: string, bullet: TagSource, metadata = cardMetadata(content, bullet)):
    { end: number; override: CardTagOverride } | undefined {
    if (!metadata.tag) return
    const { line, end } = metadata.tag
    try {
        if (!line.endsWith('-->')) throw new Error()
        const json = line.slice(tagCommentStart.length, -3)
        if (json.includes('-->')) throw new Error()
        const override = JSON.parse(json) as Partial<CardTagOverride> | null
        if (!override || !validCardTags(override.add) || !validCardTags(override.remove)) throw new Error()
        const add = override.add.filter(tag => !isRecoveryTag(tag))
        const remove = override.remove.filter(tag => !isRecoveryTag(tag))
        const addKeys = new Set(add.map(tagKey))
        if (remove.some(tag => addKeys.has(tagKey(tag)))) throw new Error()
        return { end, override: { add, remove } }
    } catch {
        throw new Error(`Invalid per-card tag comment under Anki ID ${bullet.id}.`)
    }
}

export function readCardTagOverride(content: string, bullet: TagSource): CardTagOverride | undefined {
    return tagComment(content, bullet)?.override
}

/** Меняет теги только этой карточки, сохраняя теги YAML, папки и файла. */
export function reconcileCardTags(inherited: readonly string[], override?: CardTagOverride): string[] {
    if (!override) return inherited.filter(tag => !isRecoveryTag(tag))
    const tags = tagIndex([...inherited, ...override.add])
    for (const tag of override.remove) tags.delete(tagKey(tag))
    return Array.from(tags.values())
}

function isEditablePlainField(text: string): boolean {
    // Markdown keeps intraword underscores literal (de_DE, tcp_port); isolated markup stays protected.
    const syntax = text.includes('_') ? text.replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, 'a') : text
    // The exporter needs both == delimiters for a highlight. A single trailing == or === is literal.
    const firstDelimiter = text.indexOf('==')
    if (firstDelimiter !== -1 && (text.indexOf('==', firstDelimiter + 2) !== -1 || /^=+$/u.test(text))) return false
    return text.length > 0 && text.trim() === text && !fieldSeparator.test(text) &&
        !/[\x00-\x1f\x7f-\x9f\u2028\u2029\ud800-\udfff<>[\]{}*_~$\x60\\]|(?:^|\s)(?:#|Tags:(?: |$))|&(?:#[\da-fx]+|[a-z][a-z\d]*);/iu.test(syntax) &&
        !/^(?:[-+]\s|\d{1,9}[.)]\s|-{3,}$|::(?: |$))| ::$/u.test(text)
}

/** Only paired, non-nested bold spans have a reversible Markdown representation. */
export function isEditableMarkdownField(text: string): boolean {
    if (!text.includes('*')) return isEditablePlainField(text)
    const parts = text.split('**')
    if (parts.length < 3 || parts.length % 2 === 0 || !isEditablePlainField(parts.join(''))) return false
    return parts.every((part, index) => index % 2 === 1 ? !!part && part.trim() === part :
        !!part || index === 0 || index === parts.length - 1)
}

const emptyEditorField = /^(?:[\s\u00a0]|<br\s*\/?>|<\/?(?:div|p)>|&(?:nbsp|#160|#x0*a0);)*$/iu

function unwrapEditorContainer(html: string): string {
    return /^<(div|p)>(.*)<\/\1>$/isu.exec(html)?.[2] ?? html
}

/** Принимает только точную ссылку, созданную плагином для этого ID записи. */
export function readGeneratedAnkiBacklink(html: string, id: number): string | undefined {
    const body = unwrapEditorContainer(html)
    const link = /<br ?\/?><a href="(obsidian:\/\/anki-card\?[^"<>\r\n]*)" class="obsidian-link">Obsidian<\/a>$/iu.exec(body)
    if (!link) return
    try {
        const url = new URL(link[1].replace(/&amp;/gu, '&'))
        if (url.searchParams.getAll('nid').length === 1 && url.searchParams.get('nid') === String(id) &&
            url.searchParams.get('vault') && url.searchParams.get('file')) return link[0]
    } catch {
        return
    }
}

/** Декодирует простой текст Anki вместе с необязательной обёрткой редактора. Сложный HTML остаётся в отчёте о конфликте. */
export function readEditableAnkiField(html: string, generatedBacklink?: string, allowEmpty = false): string | undefined {
    let body = unwrapEditorContainer(html)
    if (generatedBacklink && body.endsWith(generatedBacklink)) {
        body = unwrapEditorContainer(body.slice(0, -generatedBacklink.length))
    }
    if (allowEmpty && emptyEditorField.test(body)) return ''
    // Literal asterisks in HTML text are not formatting. Only actual, bare HTML
    // tags may introduce Markdown delimiters, including when entities are decoded.
    if (!/[<>]/u.test(body)) {
        const plain = decodeFieldText(body)
        return plain !== undefined && isEditablePlainField(plain) ? plain : undefined
    }
    const parts: string[] = []
    let position = 0
    for (const match of body.matchAll(/<(b|strong)>([^<>]+)<\/\1>/giu)) {
        const before = decodeFieldText(body.slice(position, match.index))
        const bold = decodeFieldText(match[2])
        if (before === undefined || bold === undefined || before.includes('*') || bold.includes('*')) return
        parts.push(before, '**', bold, '**')
        position = match.index + match[0].length
    }
    const tail = decodeFieldText(body.slice(position))
    if (!parts.length || tail === undefined || tail.includes('*')) return
    const markdown = parts.join('') + tail
    return isEditableMarkdownField(markdown) ? markdown : undefined
}

function decodeFieldText(body: string): string | undefined {
    if (/[<>]/u.test(body)) return
    let needsHtmlDecoder = false
    let invalid = false
    let text = body.replace(/&(#[\da-fx]+|[a-z][a-z\d]*)(;?)/giu, (source, name: string, semicolon: string) => {
        if (semicolon && Object.prototype.hasOwnProperty.call(entities, name)) return entities[name]
        if (semicolon && /^#(?:x[\da-f]+|\d+)$/iu.test(name)) {
            const hex = name[1].toLowerCase() === 'x'
            const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
            if (point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
                invalid = true
                return source
            }
            if (point < 0x80 || point > 0x9f) return String.fromCodePoint(point)
        }
        needsHtmlDecoder = true
        return source
    })
    if (invalid) return
    if (needsHtmlDecoder) {
        if (typeof DOMParser === 'undefined') return
        try {
            // Сюда попадает только текст. Начальный символ предотвращает потерю ведущих пробелов при обработке HTML.
            const decoded = new DOMParser().parseFromString('.' + body, 'text/html').body.textContent
            if (!decoded?.startsWith('.')) return
            text = decoded.slice(1)
        } catch {
            return
        }
    }
    return text
}

/** Кодирует простой текст перед отправкой в поле Anki с HTML-разметкой. */
export function writeEditableAnkiField(text: string, allowEmpty = false): string {
    if (!(allowEmpty && text === '') && !isEditableMarkdownField(text)) throw new Error('This value requires manual Markdown editing.')
    const escaped = text.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;').replace(/\u00a0/gu, '&nbsp;')
    return escaped.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
}

export type EditableBlockFormat = Pick<BidirectionalBlock, 'format' | 'layout' | 'begin' | 'closing' | 'blockSyntax'>

export function isEditableBlockField(text: string, block: EditableBlockFormat, allowEmpty = false): boolean {
    if (!text) return allowEmpty
    if (block.layout && block.format && block.format !== 'page') {
        const lines = text.split('\n')
        return !!lines[0] && !!lines[lines.length - 1] && lines.every(line => !line ||
            isEditableMarkdownField(line) && !/^(?::::(?:anki)?|ID:|Tags:)/iu.test(line.trim()))
    }
    const lines = text.split('\n')
    if (block.format === 'page' && lines.some(line => parseAnkiIdMarker(line))) return false
    return lines.every((line, index) => line ? isEditableMarkdownField(line) &&
        (index === 0 || !isExplicitFieldBoundary(line, block)) :
        (!block.format || block.format === 'page') && index > 0 && index + 1 < lines.length)
}

export function readEditableAnkiBlockField(html: string, block: EditableBlockFormat,
    generatedBacklink?: string, allowEmpty = false): string | undefined {
    let body = unwrapEditorContainer(html)
    if (generatedBacklink && body.endsWith(generatedBacklink)) {
        body = unwrapEditorContainer(body.slice(0, -generatedBacklink.length))
    }
    if (allowEmpty && emptyEditorField.test(body)) return ''
    if (block.layout?.multiline || !block.format || block.format === 'page') {
        // Showdown renders separate Markdown paragraphs as <p>…</p>, and wraps soft line breaks in <br />.
        // Decode only sibling paragraphs or divs without attributes. Mixed or decorated HTML stays in review.
        const bare = generatedBacklink && html.endsWith(generatedBacklink) ? html.slice(0, -generatedBacklink.length) : html
        if (/^<p>(?:[^<>]|<br\s*\/?>|<\/p>\s*<p>)*<\/p>$/iu.test(bare)) {
            body = bare.slice(3, -4).replace(/<\/p>\s*<p>/giu, '\n\n')
        } else if (/^<div>(?:[^<>]|<br\s*\/?>|<\/div>\s*<div>)*<\/div>$/iu.test(bare)) {
            body = bare.slice(5, -6).replace(/<\/div>\s*<div>/giu, '\n')
        }
        body = body.replace(/<br\s*\/?>(?:\r\n|\n)/giu, '<br>')
    }
    const lines = body.split(/<br\s*\/?>|\r\n|\n/iu).map(line => readEditableAnkiField(line, undefined, true))
    if (lines.some(line => line === undefined)) return
    const text = lines.join('\n')
    return isEditableBlockField(text, block, allowEmpty) ? text : undefined
}

export function writeEditableAnkiBlockField(text: string, block: EditableBlockFormat, allowEmpty = false): string {
    if (!isEditableBlockField(text, block, allowEmpty)) throw new Error('This value requires manual Markdown editing.')
    return text.split('\n').map(line => writeEditableAnkiField(line, true)).join('<br>')
}

type TagSource = Pick<LinkedBullet, 'end' | 'id'> & { tagEnd?: number; format?: string }

type EditableTags = { inherited: readonly string[]; effective: readonly string[] }

export class MarkdownFieldBoundaryError extends Error {}

export function planExplicitBlockPatches(content: string, block: BidirectionalBlock,
    fields: Readonly<Record<string, string>>, tags?: EditableTags): MarkdownPatch[] {
    const patches: MarkdownPatch[] = []
    const additions: Record<string, string> = Object.create(null)
    for (const [field, value] of Object.entries(fields)) {
        const span = block.explicitFields.get(field)
        const canInsert = !span && (block.format === 'page' ? block.pageOptionalFieldNames?.includes(field) :
            block.namedFieldInsertAt !== undefined && !block.fieldPair?.includes(field) && isWritableBlockExtraName(field))
        if (canInsert && isEditableBlockField(value, block, true)) {
            if (value !== '') additions[field] = value
            continue
        }
        if (block.layout && block.format && block.format !== 'page') {
            const answer = block.layout.multiline && field === block.layout.answer
            if (!value && !(field === 'Back' && hasLinkedAnswerSlot(block.format)) || !answer && (value.includes('\n') ||
                !(block.layout.multiline && block.layout.names.length === 2) && block.layout.separators.some(separator => value.includes(separator)))) {
                throw new MarkdownFieldBoundaryError(`Anki ID ${block.id}: the replacement changes a field boundary in the Markdown rule. / Значение меняет границу поля в правиле Markdown.`)
            }
        }
        if ((!block.layout || block.format === 'page') && block.format && ((field === 'Front' || block.format !== 'page') && value.includes('\n') ||
            block.format === 'table' && value.includes('|') ||
            block.format === 'remnote' && value.includes('::'))) {
            throw new Error(`Anki ID ${block.id}: the value needs manual editing in this card format.`)
        }
        const raw = span && content.slice(span.start, span.end)
        if (!span || (span.pageSource !== undefined ? raw !== span.pageSource : raw?.replace(/\r\n/gu, '\n') !== span.value) ||
            !isEditableBlockField(value, block, field !== 'Front' && (field !== 'Back' || hasLinkedAnswerSlot(block.format)))) {
            throw new Error(`Anki ID ${block.id} has a ${field} value that needs manual Markdown editing.`)
        }
        const followsPageTag = block.format === 'page' && span.start === span.end &&
            content.slice(Math.max(0, span.start - 10), span.start).toLowerCase() === '#anki-page'
        const space = value && (span.spaceWhenFilled || followsPageTag) ? ' ' : ''
        // A tag inside the old value must survive replacement of that value from Anki.
        const pageTag = span.pageSource === undefined ? '' : value ? ' #anki-page' : '#anki-page'
        patches.push({ start: span.start, end: span.end, text: space + value.replace(/\n/gu, block.eol) + pageTag })
    }
    if (Object.keys(additions).length) {
        const append = block.format === 'page' ? planPageFieldInsertion(content, block, additions) :
            planBlockFieldInsertion(content, block, additions)
        // Filling a previously empty last page label can share the insertion point of the new labels.
        const same = patches.find(patch => patch.start === append.start && patch.end === append.start)
        if (same) same.text += append.text
        else patches.push(append)
    }
    if (tags) {
        const patch = planCardTagPatch(content, block, tags)
        if (patch) patches.push(patch)
    }
    return patches
}

function planBlockFieldInsertion(content: string, block: BidirectionalBlock,
    fields: Readonly<Record<string, string>>): MarkdownPatch {
    const at = block.namedFieldInsertAt
    const idLine = content.slice(block.idStart, lineEnd(content, block.idStart))
    if (at === undefined || at <= block.start || at > block.end ||
        !content.startsWith(block.eol, at - block.eol.length) || parseAnkiIdMarker(idLine)?.id !== block.id) {
        throw new Error('The block changed before its extra fields could be added. / Блок изменился перед добавлением полей.')
    }
    const text = Object.entries(fields).map(([name, value]) =>
        name + ': ' + value.replace(/\n/gu, block.eol) + block.eol).join('')
    return { start: at, end: at, text }
}

function trimmedSpan(content: string, start: number, end: number): { start: number; end: number } {
    const text = content.slice(start, end)
    return { start: start + (text.length - text.trimStart().length), end: start + text.trimEnd().length }
}

function cardFieldSpans(content: string, bullet: LinkedBullet): Record<EditableCardField, { start: number; end: number }> {
    const end = lineEnd(content, bullet.start)
    const line = content.slice(bullet.start, end)
    const prefix = /^ {0,3}[-+*][ \t]+/.exec(line)?.[0]
    if (!prefix || end >= bullet.end) throw new Error(`Anki ID ${bullet.id} is no longer at the saved Markdown location.`)
    const separator = fieldSeparator.exec(line.slice(prefix.length))
    if (!separator) throw new Error(`Anki ID ${bullet.id} has no editable Markdown fields.`)
    const front = bullet.start + prefix.length
    const split = front + separator.index
    const back = split + separator[0].length
    const suffix = fieldSeparator.exec(content.slice(back, end))
    const spans = { Front: trimmedSpan(content, front, split), Back: trimmedSpan(content, back, suffix ? back + suffix.index : end) }
    for (const [key, expected] of [['Front', bullet.front], ['Back', bullet.back]] as const) {
        const field = spans[key]
        if (content.slice(field.start, field.end) !== expected) throw new Error(`Anki ID ${bullet.id} changed before writing its Markdown fields.`)
    }
    return spans
}

export function planLinkedBulletPatches(
    content: string,
    bullet: LinkedBullet,
    fields: Partial<Record<EditableCardField, string>>,
    tags?: EditableTags,
    extra?: Readonly<Record<string, string>>,
): MarkdownPatch[] {
    const patches: MarkdownPatch[] = []
    const idStart = content.lastIndexOf('\n', bullet.end - 1) + 1
    const idMarker = parseAnkiIdMarker(content.slice(idStart, bullet.end))
    if (idMarker?.id !== bullet.id || lineEnd(content, idStart) !== bullet.end) {
        throw new Error('The Anki ID moved before writing this Markdown card.')
    }
    if (fields.Front !== undefined || fields.Back !== undefined) {
        const spans = cardFieldSpans(content, bullet)
        for (const field of ['Front', 'Back'] as const) {
            const value = fields[field]
            if (value === undefined) continue
            const span = spans[field]
            if (value === content.slice(span.start, span.end)) continue
            if (!(field === 'Back' && bullet.remNoteAnswerSlot && value === '') && !isEditableMarkdownField(value)) {
                throw new Error(`Anki ID ${bullet.id} has a ${field} value that needs manual Markdown editing.`)
            }
            patches.push({ ...span, text: value })
        }
    }
    if (extra && Object.keys(extra).length) {
        const end = lineEnd(content, bullet.start)
        const line = content.slice(bullet.start, end)
        const separators = [...line.matchAll(/[ \t]+::[ \t]+/gu)]
        const remaining = new Set(Object.keys(extra))
        for (let index = 1; index < separators.length && remaining.size; index++) {
            const separator = separators[index]
            const start = bullet.start + separator.index! + separator[0].length
            const next = separators[index + 1]?.index
            const span = trimmedSpan(content, start, next === undefined ? end : bullet.start + next)
            const field = parseExplicitLinkedField(content.slice(span.start, span.end))
            if (!field || !remaining.has(field.field)) continue
            const value = extra[field.field]
            if (bullet.extra?.[field.field] !== field.value || value !== '' && !isEditableMarkdownField(value)) {
                throw new Error(`Anki ID ${bullet.id} has an additional field that needs manual Markdown editing.`)
            }
            if (value !== field.value) patches.push({ start: span.start + field.offset, end: span.end, text: value })
            remaining.delete(field.field)
        }
        if (remaining.size) throw new Error(`Anki ID ${bullet.id} changed before writing its additional Markdown fields.`)
    }
    if (tags) {
        const patch = planCardTagPatch(content, bullet, tags)
        if (patch) patches.push(patch)
    }
    return patches
}

function planCardTagPatch(content: string, card: TagSource & { start: number }, tags: EditableTags): MarkdownPatch | undefined {
    if (!validCardTags(tags.effective)) throw new Error(`Anki ID ${card.id} has an invalid tag.`)
    const metadata = cardMetadata(content, card)
    const anchor = metadata.anchor
    const current = tagComment(content, card, metadata)
    const inherited = tagIndex(tags.inherited)
    const effective = tagIndex(tags.effective)
    const priorAdditions = tagIndex(current?.override.add ?? [])
    const exclusions = tagIndex([...inherited.values(), ...(current?.override.remove ?? [])])
    // Выбор для отдельной записи сохраняется при временном добавлении или удалении того же общего тега.
    const add = Array.from(effective).filter(([key]) => !inherited.has(key) || priorAdditions.has(key)).map(([, tag]) => tag)
    const remove = Array.from(exclusions).filter(([key]) => !effective.has(key)).map(([, tag]) => tag)
    if (!add.length && !remove.length) return current ? { start: anchor, end: current.end, text: '' } : undefined
    // JSON хранится внутри комментария. Экранируем дефисы, чтобы теги не могли сформировать '-->'.
    const json = JSON.stringify({ add, remove }).replace(/[-<>]/gu, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
    const sourceLineEnd = lineEnd(content, card.start)
    const eol = content.startsWith('\r\n', anchor) ||
        (anchor === content.length && content.startsWith('\r\n', sourceLineEnd)) ? '\r\n' : '\n'
    const closingLine = content.lastIndexOf('\n', anchor - 1) + 1
    const indent = /^[ \t]*/.exec(content.slice(closingLine, anchor))?.[0] ?? ''
    const text = `${eol}${indent}${tagCommentStart} ${json} -->`
    const end = current?.end ?? anchor
    return content.slice(anchor, end) !== text ? { start: anchor, end, text } : undefined
}

/** Применяет изменения, подготовленные для одной неизменяемой версии Markdown. */
export function applyMarkdownPatches(content: string, patches: readonly MarkdownPatch[]): string {
    const ordered = Array.from(patches).sort((left, right) => left.start - right.start)
    const pieces: string[] = []
    let offset = 0
    let previousStart = -1
    for (const patch of ordered) {
        if (!Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.end) ||
            patch.start < offset || patch.start === previousStart || patch.end < patch.start || patch.end > content.length) {
            throw new Error('Overlapping or invalid Markdown changes.')
        }
        pieces.push(content.slice(offset, patch.start), patch.text)
        offset = patch.end
        previousStart = patch.start
    }
    pieces.push(content.slice(offset))
    return pieces.join('')
}
