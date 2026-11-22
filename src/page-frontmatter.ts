// SPDX-License-Identifier: GPL-3.0-only
import { pageTagOffsets } from './id-marker-literals'
import { readSuspendLine } from './suspend-label'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import type { ExplicitFieldSpan } from './bidirectional-blocks'

// Extract only the managed property; never reserialize the user's YAML.
interface YamlBounds { first: number; close: number; after: number; closed: boolean }
export function yamlBounds(text: string): YamlBounds | undefined {
    const opening = /^\uFEFF?---[ \t]*\r?\n/u.exec(text)
    if (!opening) return
    const closing = /^---[ \t]*(?:\r?\n|$)/gmu
    closing.lastIndex = opening[0].length
    const match = closing.exec(text)
    return { first: opening[0].length, close: match?.index ?? text.length, after: match ? closing.lastIndex : text.length, closed: !!match }
}
export function hasPageYamlIdText(text: string): boolean {
    return /rudonium-id|anki-page-id/iu.test(text)
}

/** The Obsidian routing tag is local to a page, including when supplied by YAML. */
export function pageContentTags(tags: readonly string[]): string[] {
    return tags.flatMap(group => group.split(/\s+/u)).filter(tag => tag && !/^#?anki-page$/iu.test(tag))
}

export function mayHavePageTag(text: string): boolean {
    return /anki-page/iu.test(text)
}

/** Remove active tags from an exported value while retaining source offsets for a checked return edit. */
export function pageTextSpan(text: string, start: number, end: number, offsets: readonly number[] = []): ExplicitFieldSpan {
    const omitted: Array<[number, number]> = []
    for (const pos of offsets) {
        if (pos < start || pos + 10 > end) continue
        let left = pos, right = pos + 10
        while (left > start && (text[left - 1] === ' ' || text[left - 1] === '\t')) left--
        while (right < end && (text[right] === ' ' || text[right] === '\t')) right++
        const atLineStart = left === start || text[left - 1] === '\n'
        const atLineEnd = right === end || text[right] === '\r' || text[right] === '\n'
        if (atLineStart && atLineEnd) {
            if (right < end) right += text[right] === '\r' ? 2 : 1
            else if (left > start) left -= text[left - 2] === '\r' ? 2 : 1
        } else if (!atLineStart && !atLineEnd) {
            if (right > pos + 10) left = pos
        } else if (atLineEnd) right = pos + 10
        const previous = omitted[omitted.length - 1]
        if (previous && previous[1] >= left) previous[1] = Math.max(previous[1], right)
        else omitted.push([left, right])
    }
    // A leading/trailing marker stays physically outside the editable span.
    let first = 0, last = omitted.length
    while (first < last && omitted[first][0] <= start) {
        start = Math.max(start, omitted[first++][1])
        start += /^(?:[ \t]*\r?\n)+/u.exec(text.slice(start, end))?.[0].length ?? 0
    }
    while (first < last && omitted[last - 1][1] >= end) {
        end = Math.max(start, omitted[--last][0])
        end -= /(?:\r?\n[ \t]*)+$/u.exec(text.slice(start, end))?.[0].length ?? 0
    }
    const raw = text.slice(start, end)
    if (first === last) return { start, end, value: raw.replace(/\r\n/gu, '\n'), spaceWhenFilled: false }
    const parts: string[] = []
    let at = start
    for (let i = first; i < last; i++) {
        const [left, right] = omitted[i]
        parts.push(text.slice(at, left))
        at = right
    }
    parts.push(text.slice(at, end))
    return { start, end, value: parts.join('').replace(/\r\n/gu, '\n'), spaceWhenFilled: false, pageSource: raw }
}

/** A marker on its own line is transparent to the commands and ID directly under the question. */
export function pageControlStart(text: string, start: number, tags: readonly number[]): number {
    const row = /[ \t]*(#anki-page)[ \t]*(?:\r?\n|$)/iyu
    for (const tag of tags) {
        if (tag < start) continue
        row.lastIndex = start
        const match = row.exec(text)
        if (!match || tag !== start + match[0].indexOf(match[1])) break
        start = row.lastIndex
    }
    return start
}

/** Единственное место для команды страницы — отдельная строка под вопросом. */
export function pageLifecycleSlot(text: string, bodyStart: number, tags: readonly number[], syntax?: DuplicateMarkerSyntax) {
    const lineAt = (offset: number) => /^([^\r\n]*)(?:\r?\n|$)/u.exec(text.slice(offset))!
    const commandOf = (line: string) => {
        const deletion = syntax?.['Delete Note Line'] ?? 'DELETE'
        if (deletion && !/^(?: {4}| {0,3}\t)/u.test(line) && line.trim().toLowerCase() === deletion.toLowerCase()) return 'delete' as const
        return readSuspendLine(line, syntax)
    }
    const first = lineAt(bodyStart)
    const command = commandOf(first[1])
    const end = command ? bodyStart + first[0].length : bodyStart
    const next = command ? pageControlStart(text, end, tags) : bodyStart
    if (command && commandOf(lineAt(next)[1])) throw new Error(
        'Conflicting page commands. Keep one command below the question. / Несовместимые команды страницы. Оставьте одну команду под вопросом.')
    return { start: bodyStart, end, next, command, tail: bodyStart + first[1].length }
}

const tagOnlyRow = /[ \t]*#[\p{L}\p{N}_/-]+(?:[ \t]+#[\p{L}\p{N}_/-]+)*[ \t]*(?:\r?\n|$)/guy
/** The question starts at the first H1; the page is selected by a separate tag in Markdown or YAML. */
export function pageHeading(text: string, strict = false): { start: number; heading: RegExpExecArray; tags: readonly number[] } | undefined {
    if (!mayHavePageTag(text)) return
    const bounds = yamlBounds(text)
    if (bounds && !bounds.closed) return
    const tags = pageTagOffsets(text)
    const taggedProperties = bounds && mayHavePageTag(text.slice(bounds.first, bounds.close)) && inspect(text, bounds).marked
    if (!tags.length && !taggedProperties) return
    let start = bounds?.after ?? (text.charCodeAt(0) === 0xfeff ? 1 : 0)
    const trivia = /[ \t]*(?:\r?\n|(<!--(?![ \t]*ID:)|%%))/gyu
    const lineEnd = /[ \t]*(?:\r?\n|$)/gyu
    while (start < text.length) {
        tagOnlyRow.lastIndex = start
        if (tagOnlyRow.test(text)) { start = tagOnlyRow.lastIndex; continue }
        trivia.lastIndex = start
        const prefix = trivia.exec(text)
        if (!prefix) break
        if (!prefix[1]) { start = trivia.lastIndex; continue }
        const close = prefix[1] === '%%' ? '%%' : '-->'
        const end = text.indexOf(close, trivia.lastIndex)
        if (end < 0) break
        lineEnd.lastIndex = end + close.length
        if (!lineEnd.exec(text)) break
        start = lineEnd.lastIndex
    }
    const heading = /^( {0,3}#[ \t]+)(\S[^\r\n]*?)(?:[ \t]+\^[A-Za-z0-9-]+)?[ \t]*(\r?\n|$)/u.exec(text.slice(start))
    if (heading) return { start, heading, tags }
    if (strict) throw new Error('A tagged page needs a first-level question heading before its text. / На странице с меткой разместите заголовок вопроса первого уровня перед текстом.')
}

interface PropertyId {
    id: number
    legacy?: true
    line: number
    column: number
    start: number
    end: number
    digitsStart: number
    digitsEnd: number
}
export interface PageYamlId extends PropertyId { bodyStart: number; headingEnd: number }
const invalid = () => new Error("Keep one valid anki-page-ID property on the page. / Оставьте одно свойство anki-page-ID с положительным целым ID записи Anki.")
const unsupported = () => new Error("Use ordinary top-level YAML properties to store the page ID. / Для хранения ID страницы используйте свойства верхнего уровня в обычном блочном YAML.")
function retiredProperty(conflict: boolean): Error {
    return new Error(conflict
        ? 'Both rudonium-id and anki-page-ID are present. Verify the Anki note number and keep only anki-page-ID. / Указаны rudonium-id и anki-page-ID. Проверьте номер записи Anki и оставьте только anki-page-ID.'
        : 'Rename the YAML property rudonium-id to anki-page-ID, keeping the same Anki note number. / Переименуйте YAML-свойство rudonium-id в anki-page-ID, сохранив номер записи Anki.')
}
const pageKey = /^(?:(?:rudonium-id|anki-page-ID)|'(?:rudonium-id|anki-page-ID)'|"(?:rudonium-id|anki-page-ID)")([ \t]*:)(?=[ \t]|$)/u
const scalarId = /^([ \t]*)(['"]?)([1-9]\d*)\2(?:[ \t]+#[^\r\n]*)?[ \t]*$/u

// Consume quoted and flow-style values across lines. A new property must never be appended
// inside an unfinished string or collection. Plain and block scalars have no such delimiters.
function scanValue(line: string, closing: string[], quote: string): { quote: string; invalid: boolean } {
    for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (quote) {
            if (quote === '"' && char === '\\') i++
            else if (quote === "'" && char === "'" && line[i + 1] === "'") i++
            else if (char === quote) quote = ''
        } else if (char === '#' && (!i || /[ \t]/u.test(line[i - 1]))) break
        else if ((char === '"' || char === "'") && (!i || /[\s[{: ,]/u.test(line[i - 1]))) quote = char
        else if (char === '{' || char === '[') closing.push(char === '{' ? '}' : ']')
        else if (char === '}' || char === ']') {
            if (closing.pop() !== char) return { quote: '', invalid: true }
        }
        if (!quote && !closing.length) break
    }
    return { quote, invalid: false }
}

function propertyTag(value: string): boolean {
    const scalar = /^(?:("|')([^"'\r\n]*)\1|([^#\s,[\]]+))[ \t]*(?:#.*)?$/u.exec(value.trim())
    return !!scalar && /^#?anki-page$/iu.test(scalar[2] ?? scalar[3])
}

/** Read ordinary Obsidian tag arrays, scalar tags and indented or indentless YAML sequences. */
function taggedYaml(text: string, after: number, close: number, indent: number, initial: string): boolean {
    let value = initial.trim()
    if (value.startsWith('[')) {
        if (!value.includes(']')) {
            const end = text.indexOf(']', after)
            if (end < 0 || end >= close) return false
            value += '\n' + text.slice(after, end + 1)
        }
        const array = /^\[(.*)\][ \t]*(?:#.*)?$/su.exec(value)
        if (!array) return false
        const entries = /\s*(?:'([^']*)'|"([^"\\]*)"|([^'",\s[\]#]+))\s*(?:,|$)/gyu
        let match, marked = false
        while (entries.lastIndex < array[1].length) {
            match = entries.exec(array[1])
            if (!match) return false
            marked ||= /^#?anki-page$/iu.test(match[1] ?? match[2] ?? match[3])
        }
        return marked
    }
    if (value && !value.startsWith('#')) return propertyTag(value)
    for (let at = after; at < close;) {
        const nl = text.indexOf('\n', at), end = nl < 0 ? close : nl
        const row = text.slice(at, end).replace(/\r$/u, '')
        at = end + 1
        if (/^[ \t]*(?:#|$)/u.test(row)) continue
        const item = /^( *)-[ \t]+(.+)$/u.exec(row)
        if (!item || item[1].length < indent) break
        if (propertyTag(item[2])) return true
    }
    return false
}

function inspect(text: string, bounds: YamlBounds) {
    const properties: PropertyId[] = []
    const closing: string[] = []
    let quote = ''
    let keys = 0, retired = 0, bad = !bounds.closed, unsafe = false, ambiguous = false
    let base: number | undefined, line = 1, indentlessSequence = false, tagKeys = 0, marked = false
    for (let at = bounds.first; at < bounds.close;) {
        const lf = text.indexOf('\n', at)
        const next = lf < 0 ? text.length : lf + 1
        const end = lf < 0 ? text.length : (text[lf - 1] === '\r' ? lf - 1 : lf)
        const raw = text.slice(at, end), indent = /^ */u.exec(raw)![0].length
        const row = raw.slice(indent)
        line++
        if (quote || closing.length) {
            const state = scanValue(raw, closing, quote)
            quote = state.quote
            bad ||= state.invalid
            at = next
            continue
        }
        if (row && !row.startsWith('#')) {
            if (base === undefined) base = indent
            if (indent < base) { bad = true; unsafe = true }
            if (indent <= base) {
                const sequenceItem = /^-(?:[ \t]|$)/u.test(row)
                if (sequenceItem && !indentlessSequence) unsafe = true
                if (!sequenceItem) indentlessSequence = /:[ \t]*(?:#.*)?$/u.test(row)
                const tagKey = /^(?:tags|'tags'|"tags")[ \t]*:(?=[ \t]|$)/u.exec(row)
                if (tagKey) {
                    tagKeys++
                    marked = taggedYaml(text, next, bounds.close, indent, row.slice(tagKey[0].length))
                }
                const key = pageKey.exec(row)
                if (key) {
                    keys++
                    const legacy = key[0].includes('rudonium-id')
                    if (legacy) retired++
                    const value = scalarId.exec(row.slice(key[0].length))
                    if (!value || !Number.isSafeInteger(Number(value[3]))) bad = true
                    else {
                        const digitsStart = at + indent + key[0].length + value[1].length + value[2].length
                        properties.push({ ...(legacy ? { legacy: true as const } : {}), id: Number(value[3]), line, column: indent, start: at, end,
                            digitsStart, digitsEnd: digitsStart + value[3].length })
                    }
                } else if (/^(?:<<[ \t]*:|[?{[!*&%\t])/u.test(row) ||
                    /^"(?:[^"\\]|\\.)*\\/u.test(row)) {
                    // Complex mappings may hide or inherit this key. Require ordinary notation before changing the property.
                    unsafe = true
                    if (/(?:rudonium-id|anki-page-ID|^<<[ \t]*:|^\?|^["'{][^\n]*\\)/iu.test(row)) ambiguous = true
                } else if (/^(?:(?:rudonium-id|anki-page-ID)(?:[ \t:]|$)|['"](?:rudonium-id|anki-page-ID)['"])/iu.test(row)) {
                    bad = true
                    ambiguous = true
                } else if (!sequenceItem && !/^(?:[^'":#\s][^:]*|'[^']*'|"[^"]*")[ \t]*:(?:[ \t]|$)/u.test(row)) {
                    unsafe = true
                }
                const flow = /^(?:[^'":#\s][^:]*|'[^']*'|"[^"]*")[ \t]*:[ \t]+(["'{[].*)$/u.exec(row)
                if (flow) {
                    const state = scanValue(flow[1], closing, '')
                    quote = state.quote
                    bad ||= state.invalid
                }
            }
        }
        at = next
    }
    return { properties, retired, keys, marked: tagKeys === 1 && marked, bad: bad || keys > 1 || !!quote || closing.length > 0, unsafe, ambiguous, indent: base ?? 0 }
}

/** Positive, directly declared IDs remain reserved even when the page needs manual review. */
export function pageYamlClaims(text: string): PropertyId[] {
    const bounds = yamlBounds(text)
    if (!bounds) return []
    const header = text.slice(bounds.first, bounds.close)
    if (!hasPageYamlIdText(header)) return []
    const state = inspect(text, bounds)
    // A retired property can only reserve a number on a marked page. Its presence never
    // authorizes syncing, deleting or relinking that note.
    const includeRetired = /rudonium-id/iu.test(header) &&
        (state.marked || pageTagOffsets(text).length > 0)
    const claims = !state.retired || includeRetired ? state.properties : state.properties.filter(property => !property.legacy)
    if (!state.bad && !state.unsafe && !state.ambiguous) return claims
    // An unsupported JSON/flow/merged mapping may still carry a real Anki link. Reserve its
    // positive numeric candidates during collision checks; the page parser refuses to update it.
    const known = new Set(claims.map(property => property.digitsStart))
    let line = 2, start = bounds.first, newline = text.indexOf('\n', bounds.first)
    for (const candidate of header.matchAll(/(?:^|[,{\s])((?:(?:rudonium-id|anki-page-ID)|'(?:rudonium-id|anki-page-ID)'|"(?:rudonium-id|anki-page-ID)")[ \t]*:[ \t]*)(['"]?)([1-9]\d*)\2(?=[ \t,}\r\n]|$)/gimu)) {
        const digitsStart = bounds.first + candidate.index + candidate[0].length - candidate[2].length - candidate[3].length
        const legacy = /rudonium-id/iu.test(candidate[1])
        if (legacy && !includeRetired) continue
        const id = Number(candidate[3])
        if (known.has(digitsStart) || !Number.isSafeInteger(id)) continue
        const keyStart = digitsStart - candidate[2].length - candidate[1].length
        while (newline >= 0 && newline < keyStart) { start = newline + 1; line++; newline = text.indexOf('\n', start) }
        const end = newline < 0 ? text.length : newline - (text[newline - 1] === '\r' ? 1 : 0)
        claims.push({ id, start, end, line, column: keyStart - start, digitsStart, digitsEnd: digitsStart + candidate[3].length })
    }
    return claims.sort((a, b) => a.digitsStart - b.digitsStart)
}

export function hasRetiredPageProperty(text: string): boolean {
    const bounds = yamlBounds(text)
    return !!bounds && text.slice(bounds.first, bounds.close).includes('rudonium-id') && inspect(text, bounds).retired > 0
}

function checkedProperty(text: string, purpose: 'page' | 'orphan' | 'archive'): PropertyId | undefined {
    const bounds = yamlBounds(text)
    if (!bounds) return
    const header = text.slice(bounds.first, bounds.close)
    if (!/(?:rudonium-id|anki-page-ID|^[ \t]*(?:<<[ \t]*:|\?|["'{][^\n]*\\))/imu.test(header)) return
    const state = inspect(text, bounds)
    if (state.retired && purpose !== 'archive') {
        if (purpose === 'orphan' && state.keys === state.retired) return
        throw retiredProperty(state.keys > state.retired)
    }
    if (state.bad || state.ambiguous || state.unsafe) throw invalid()
    return state.properties[0]
}

export function unclaimedPageYamlId(text: string): PropertyId | undefined {
    if (!/^\uFEFF?---[ \t]*\r?\n/u.test(text) || !/anki-page-id/iu.test(text) || pageHeading(text)) return
    return checkedProperty(text, 'orphan')
}

export function pageYamlId(text: string, heading?: ReturnType<typeof pageHeading>): PageYamlId | undefined {
    if (!/^\uFEFF?---[ \t]*\r?\n/u.test(text)) return
    const location = heading ?? pageHeading(text)
    if (!location) return
    const property = checkedProperty(text, 'page')
    if (!property) return
    const bodyStart = pageControlStart(text, location.start + location.heading[0].length, location.tags)
    return { ...property, bodyStart, headingEnd: bodyStart - (/\r?\n$/u.exec(text.slice(0, bodyStart))?.[0].length ?? 0) }
}

/** Historical archives can still be opened and validated. They confer no active editing rights. */
export function archivedPageProperty(text: string): PropertyId | undefined {
    return checkedProperty(text, 'archive')
}

function destination(text: string) {
    const location = pageHeading(text)
    if (!location) throw new Error('Add the anki-page tag and a first-level question heading. / Добавьте метку anki-page и заголовок вопроса первого уровня.')
    const start = pageControlStart(text, location.start + location.heading[0].length, location.tags)
    const body = text.slice(start)
    if (/^[ \t]*(?:<!--[ \t]*)?ID[ \t]*:/u.test(body) ||
        /^[\p{L}\p{N}_ ,-]+\r?\n[ \t]*(?:<!--[ \t]*)?ID[ \t]*:/u.test(body)) throw invalid()
    const bounds = yamlBounds(text)
    const state = bounds && inspect(text, bounds)
    if (state?.retired) throw retiredProperty(state.keys > state.retired)
    if (state && (state.bad || state.ambiguous || state.properties.length)) throw invalid()
    if (state?.unsafe) throw unsupported()
    return { bounds, indent: state?.indent ?? 0, eol: location.heading[3] || (/\r?\n/u.exec(text)?.[0] ?? '\n') }
}

/** Preflight before creating the Anki note so an unsupported header cannot leave a note without its ID. */
export function validatePageYamlPlacement(text: string): void { destination(text) }

export function insertPageYamlId(text: string, id: number, date?: string): string {
    if (!Number.isSafeInteger(id) || id <= 0 || (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date))) throw invalid()
    const { bounds, indent, eol } = destination(text)
    const row = ' '.repeat(indent) + "anki-page-ID: '" + id + "'" + (date ? ' # | ' + date : '') + eol
    if (bounds) return text.slice(0, bounds.close) + row + text.slice(bounds.close)
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0
    return text.slice(0, start) + '---' + eol + row + '---' + eol + text.slice(start)
}
