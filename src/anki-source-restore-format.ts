/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { blockFieldHashtag, blockFieldTagSignature } from './block-field-tags'
import { isRecoveryTag } from './export-recovery'

interface RestoreFormatInput {
    id: number
    modelName: string
    fields: Readonly<Record<string, string>>
    fieldNames: readonly string[]
    tags: readonly string[]
    syntax?: { 'Begin Note'?: string; 'End Note'?: string }
    vaultName?: string
    preferMarkdown?: boolean
    idAsComment?: boolean
}

interface RestoreFormatResult {
    markdown: string
    wikiLinks: Array<{ original: string; link: string; displayText: string }>
    manualFields: string[]
    fields: Record<string, string>
    tags: string[]
}

const unsafeCharacter = /[^\P{Cc}\t\r\n]|[\u2028\u2029\p{Cs}]/u
const inlineTag = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'mark', 'sub', 'sup', 'code', 'span'])
const containerTag = new Set(['div', 'p'])
const comparableTag: Readonly<Record<string, string>> = { b: 'strong', i: 'em', s: 'del', strike: 'del' }
const entities: Readonly<Record<string, string>> = {
    amp: '&', AMP: '&', apos: "'", gt: '>', GT: '>', lt: '<', LT: '<', nbsp: '\u00a0', quot: '"', QUOT: '"',
    ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', deg: '°', times: '×', minus: '−',
}
const htmlToken = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)[ \t]*(\/?)>/
const entityToken = /^&(#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/
const escapedMarkdownCharacter = /[\\`*[\]{}~#$%\t\r\n]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu
const unsupportedRenderedText = /\[sound:|\{\{c\d+::/iu

function htmlEntity(name: string): string {
    if (Object.prototype.hasOwnProperty.call(entities, name)) return entities[name]
    if (name[0] === '#') {
        const hex = name[1].toLowerCase() === 'x'
        const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
        if (point > 0 && point <= 0x10ffff) {
            const character = String.fromCodePoint(point)
            if (!unsafeCharacter.test(character)) return character
        }
    }
    if (typeof DOMParser !== 'undefined' && /^[a-z][a-z\d]{1,31}$/iu.test(name)) {
        const entity = '&' + name + ';'
        const decoded = new DOMParser().parseFromString(entity, 'text/html').body.textContent
        if (decoded && decoded !== entity && !unsafeCharacter.test(decoded)) return decoded
    }
    throw new Error('The Anki field contains an unsupported HTML entity.')
}

function escapeMarkdownText(text: string): string {
    return text.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)
        .replace(escapedMarkdownCharacter, character => `&#${character.codePointAt(0)};`)
        .replace(/\.\.\./g, '&#46;..')
        .replace(/^([+-])(?=[ \t-]|$)/, character => `&#${character.codePointAt(0)};`)
        .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, (_match, digits: string, marker: string) => `${digits}&#${marker.codePointAt(0)};`)
}

// Plain punctuation is readable in the draft. Protect only sequences interpreted
// by the Markdown renderer or by the vault's tag, cloze and link readers.
function readableMarkdownText(text: string): string {
    const source = text.replace(/&(?=(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);)/giu, '&amp;')
        .replace(/<(?=[a-z!?/])/giu, '&lt;')
        .replace(/[\\`*~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, character => '\\' + character)
        .replace(/[\t\r\n]|#(?=[\s\p{L}\p{M}\p{N}\p{Extended_Pictographic}_/#-]|$)|\$(?=[^\n]*\$)|\{(?=[^\n]*\})|%(?=%)|=(?==)/gu,
            character => `&#${character.codePointAt(0)};`)
        .replace(/^[ \t]{0,3}>/u, value => value.slice(0, -1) + '\\>')
        .replace(/\.\.\./gu, '&#46;..')
        .replace(/^([+-])(?=[ \t-]|$)/u, '\\$1')
        .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/u, '$1\\$2')
    // Backslash-escaped square brackets are display-math delimiters in Anki.
    // Ordinary bracketed text is already literal Markdown, unlike links or link definitions.
    if (text.includes('[[') || /\][ \t]*[(\[]|^[ \t]*\[[^\]\n]+\]:/u.test(text)) {
        return source.replace(/[\[\]]/gu, bracket => bracket === '[' ? '&#91;' : '&#93;')
    }
    return source
}

const simpleAnchor = /^<a[ \t]+href[ \t]*=[ \t]*(?:"([^"<>]+)"|'([^'<>]+)')[ \t]*>([^<>]*)<\/a[ \t]*>/iu
const decodeEntities = (value: string) => value.replace(/&(#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/g,
    (_entity, name: string) => htmlEntity(name))

function readableManualField(value: string): string {
    const decoded = value.replace(/&(#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/gu, (original, name: string) => {
        try { return htmlEntity(name) } catch { return original }
    })
    return readableMarkdownText(decoded)
}

function inspectAnchor(match: RegExpExecArray, vaultName?: string) {
    const href = decodeEntities(match[1] ?? match[2])
    const label = decodeEntities(match[3])
    if (unsafeCharacter.test(href) || /[\s<>"'\\]/u.test(href)) throw new Error('Unsupported link address.')
    const url = new URL(href)
    if (!['http:', 'https:', 'mailto:', 'obsidian:'].includes(url.protocol) ||
        url.protocol === 'obsidian:' && url.hostname !== 'open') throw new Error('Unsupported link address.')
    let source = match[0]
    let wikiLink: RestoreFormatResult['wikiLinks'][number] | undefined
    const link = url.searchParams.get('file')
    if (vaultName && url.protocol === 'obsidian:' && link && label &&
        href === 'obsidian://open?vault=' + encodeURIComponent(vaultName) + '&file=' + encodeURIComponent(link) &&
        !/[[\]<>|\r\n]/u.test(link + label) && !unsafeCharacter.test(link) && !unsafeCharacter.test(label) &&
        link.trim() === link && label.trim() === label) {
        source = label === link ? `[[${link}]]` : `[[${link}|${label}]]`
        wikiLink = { original: source, link, displayText: label }
    }
    return { source, wikiLink, comparable: JSON.stringify([href, label]) }
}

type FieldPart = { kind: 'text' | 'open' | 'close' | 'break' | 'link'; value: string }

function inspectField(value: string, vaultName?: string, preferMarkdown = false): { source: string; comparable: string; wikiLinks: RestoreFormatResult['wikiLinks'] } {
    const wikiLinks: RestoreFormatResult['wikiLinks'] = []
    if (unsafeCharacter.test(value)) throw new Error('The Anki field contains unsupported characters.')
    const parts: FieldPart[] = []
    const tags: string[] = []
    const source: string[] = []
    let decoded = ''
    const flushText = () => {
        if (!decoded) return
        source.push(preferMarkdown ? readableMarkdownText(decoded) : escapeMarkdownText(decoded))
        parts.push({ kind: 'text', value: decoded })
        decoded = ''
    }

    for (let offset = 0; offset < value.length;) {
        const next = value.slice(offset)
        const plain = /^[^<&]+/u.exec(next)?.[0]
        if (plain) {
            decoded += plain
            offset += plain.length
            continue
        }
        if (next[0] === '&') {
            const entity = entityToken.exec(next)
            if (entity) {
                decoded += htmlEntity(entity[1])
                offset += entity[0].length
            } else {
                decoded += '&'
                offset++
            }
            continue
        }
        if (!/^<[a-zA-Z!?/]/u.test(next)) {
            decoded += '<'
            offset++
            continue
        }
        const anchor = simpleAnchor.exec(next)
        if (anchor) {
            const link = inspectAnchor(anchor, preferMarkdown ? vaultName : undefined)
            flushText()
            parts.push({ kind: 'link', value: link.comparable })
            source.push(link.source)
            if (link.wikiLink) wikiLinks.push(link.wikiLink)
            offset += anchor[0].length
            continue
        }
        const tag = htmlToken.exec(next)
        if (!tag) throw new Error('The Anki field contains HTML that requires manual restoration.')
        const [, closing, name, selfClosing] = tag
        const lowerName = name.toLowerCase()
        flushText()
        if (lowerName === 'br' && !closing) {
            parts.push({ kind: 'break', value: '' })
        } else if (inlineTag.has(lowerName) || containerTag.has(lowerName)) {
            if (selfClosing || closing && tags.pop() !== lowerName) throw new Error('The Anki field contains unbalanced HTML.')
            if (!closing) tags.push(lowerName)
            parts.push({ kind: closing ? 'close' : 'open', value: comparableTag[lowerName] ?? lowerName })
        } else {
            throw new Error('The Anki field contains rich HTML or an attachment that requires manual restoration.')
        }
        source.push(tag[0])
        offset += tag[0].length
    }
    flushText()
    if (tags.length) throw new Error('The Anki field contains unbalanced HTML.')
    if (unsupportedRenderedText.test(parts.filter(part => part.kind === 'text').map(part => part.value).join(''))) {
        throw new Error('The Anki field contains audio or a cloze that requires manual restoration.')
    }

    const first = parts[0]
    const last = parts[parts.length - 1]
    if (first?.kind === 'open' && containerTag.has(first.value) && last?.kind === 'close' && last.value === first.value &&
        !parts.slice(1, -1).some(part => part.kind !== 'text' && containerTag.has(part.value))) {
        parts.shift()
        parts.pop()
    }
    // Convert simple emphasis only. Mixed or nested HTML keeps its original spelling.
    const html = source.join('')
    const markdown = preferMarkdown ? html.replace(/<(b|strong|i|em)>([^<>*\s](?:[^<>*]*[^<>*\s])?)<\/\1>/gi,
        (_whole, name: string, body: string) => {
            const delimiter = /^(?:b|strong)$/i.test(name) ? '**' : '*'
            return delimiter + body + delimiter
        }) : html
    return { source: markdown, comparable: JSON.stringify(parts).normalize('NFC'), wikiLinks }
}

export function sameRestoredAnkiField(actual: string | undefined, expected: string): boolean {
    try {
        return actual !== undefined && inspectField(actual).comparable === inspectField(expected).comparable
    } catch {
        return false
    }
}

function usableLabel(value: string): boolean {
    return !!value && value.trim() === value && !unsafeCharacter.test(value) && !/[\t\r\n<>]/u.test(value)
}

export function formatAnkiSourceRestore(input: RestoreFormatInput): RestoreFormatResult {
    const { id, modelName, fieldNames, fields } = input
    const begin = input.syntax?.['Begin Note'] ?? 'START'
    const end = input.syntax?.['End Note'] ?? 'END'
    if (!Number.isSafeInteger(id) || id <= 0 || !usableLabel(modelName) || !usableLabel(begin) || !usableLabel(end) || begin === end) {
        throw new Error('Invalid Anki note ID, note type, or Markdown block markers.')
    }
    const declaredFields = new Set(fieldNames.map(name => name.toLowerCase()))
    if (!fieldNames.length || declaredFields.size !== fieldNames.length || fieldNames.length !== Object.keys(fields).length) {
        throw new Error('The Anki note type has changed. Refresh its fields and try again.')
    }

    const tags: string[] = []
    const hashtags: string[] = []
    const otherTags: string[] = []
    const seenTags = new Set<string>()
    for (const tag of input.tags) {
        if (!tag || unsafeCharacter.test(tag) || /[\s<>]/u.test(tag)) throw new Error('The Anki note contains an invalid tag.')
        const key = tag.normalize('NFC').toLowerCase()
        if (isRecoveryTag(key) || seenTags.has(key)) continue
        seenTags.add(key)
        tags.push(tag)
        const hashtag = blockFieldHashtag(tag)
        if (hashtag) hashtags.push(hashtag)
        else otherTags.push(tag)
    }
    const rows = [begin, modelName]
    const wikiLinks: RestoreFormatResult['wikiLinks'] = []
    const manualFields: string[] = []
    for (const name of fieldNames) {
        if (!usableLabel(name) || /:|^(?:ID|Tags|__proto__|constructor|prototype)$/iu.test(name) ||
            !Object.prototype.hasOwnProperty.call(fields, name) || typeof fields[name] !== 'string') {
            throw new Error('The Anki note type contains an unsupported or missing field.')
        }
        const value = fields[name]
        let source: string
        try {
            const inspected = inspectField(value, input.vaultName, input.preferMarkdown !== false)
            source = inspected.source
            wikiLinks.push(...inspected.wikiLinks)
        } catch {
            // Preserve unsupported markup for the user to review in the editable draft.
            manualFields.push(name)
            source = input.preferMarkdown === false ? escapeMarkdownText(value) : readableManualField(value)
        }
        if (name === fieldNames[0] && hashtags.length) source = [source, ...hashtags].filter(Boolean).join(' ')
        if (source) rows.push(`${name}: ${source}`)
    }

    if (otherTags.length) rows.push(`Tags: ${otherTags.join(' ')}`)
    const idMarker = `ID: ${id}` + (hashtags.length ? ' ' + blockFieldTagSignature : '')
    rows.push(input.idAsComment ? `<!--${idMarker}-->` : idMarker, end)
    return { markdown: rows.join('\n'), fields: { ...fields }, tags, wikiLinks, manualFields }
}
