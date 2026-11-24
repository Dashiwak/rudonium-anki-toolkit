/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { isRecoveryTag } from './export-recovery'

interface RestoreFormatInput {
    id: number
    modelName: string
    fields: Readonly<Record<string, string>>
    fieldNames: readonly string[]
    tags: readonly string[]
    syntax?: { 'Begin Note'?: string; 'End Note'?: string }
    idAsComment?: boolean
}

interface RestoreFormatResult {
    markdown: string
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
const escapedMarkdownCharacter = /[\\`*[\]{}~#$!%\t\r\n]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu
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
    throw new Error('The Anki field contains an unsupported HTML entity.')
}

function escapeMarkdownText(text: string): string {
    return text.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)
        .replace(escapedMarkdownCharacter, character => `&#${character.codePointAt(0)};`)
        .replace(/^([+-])(?=[ \t-]|$)/, character => `&#${character.codePointAt(0)};`)
        .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, (_match, digits: string, marker: string) => `${digits}&#${marker.codePointAt(0)};`)
}

type FieldPart = { kind: 'text' | 'open' | 'close' | 'break'; value: string }

function inspectField(value: string): { source: string; comparable: string } {
    if (unsafeCharacter.test(value)) throw new Error('The Anki field contains unsupported characters.')
    const parts: FieldPart[] = []
    const tags: string[] = []
    const source: string[] = []
    let text = ''
    let decoded = ''
    const flushText = () => {
        if (!text && !decoded) return
        source.push(text)
        parts.push({ kind: 'text', value: decoded })
        text = ''
        decoded = ''
    }

    for (let offset = 0; offset < value.length;) {
        const next = value.slice(offset)
        const plain = /^[^<&]+/u.exec(next)?.[0]
        if (plain) {
            text += escapeMarkdownText(plain)
            decoded += plain
            offset += plain.length
            continue
        }
        if (next[0] === '&') {
            const entity = entityToken.exec(next)
            if (entity) {
                decoded += htmlEntity(entity[1])
                text += entity[0]
                offset += entity[0].length
            } else {
                decoded += '&'
                text += '&amp;'
                offset++
            }
            continue
        }
        if (!/^<[a-zA-Z!?/]/u.test(next)) {
            decoded += '<'
            text += '&lt;'
            offset++
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
    return { source: source.join(''), comparable: JSON.stringify(parts).normalize('NFC') }
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

    const rows = [begin, modelName]
    for (const name of fieldNames) {
        if (!usableLabel(name) || /:|^(?:ID|Tags|__proto__|constructor|prototype)$/iu.test(name) ||
            !Object.prototype.hasOwnProperty.call(fields, name) || typeof fields[name] !== 'string') {
            throw new Error('The Anki note type contains an unsupported or missing field.')
        }
        const value = fields[name]
        let source: string
        try {
            source = inspectField(value).source
        } catch (error) {
            throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (source) rows.push(`${name}: ${source}`)
    }

    const tags: string[] = []
    const seenTags = new Set<string>()
    for (const tag of input.tags) {
        if (!tag || unsafeCharacter.test(tag) || /[\s<>]/u.test(tag)) throw new Error('The Anki note contains an invalid tag.')
        const key = tag.normalize('NFC').toLowerCase()
        if (isRecoveryTag(key) || seenTags.has(key)) continue
        seenTags.add(key)
        tags.push(tag)
    }
    if (tags.length) rows.push(`Tags: ${tags.join(' ')}`)
    const idMarker = `ID: ${id}`
    rows.push(input.idAsComment ? `<!--${idMarker}-->` : idMarker, end)
    return { markdown: rows.join('\n'), fields: { ...fields }, tags }
}
