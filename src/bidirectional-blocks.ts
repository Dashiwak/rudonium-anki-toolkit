/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { activeCardMarkdown } from './archived-card'
import { explicitFieldLabel as fieldLabel, isBidirectionalFieldName } from './bidirectional-fields'
import { readSuspendLine } from './suspend-label'
import { parseAnkiIdMarker } from './anki-id-marker'
import { pageTagOffsets } from './id-marker-literals'
import type { DuplicateMarkerSyntax } from './duplicate-markers'

interface Line {
    start: number
    end: number
    text: string
}

export interface ExplicitFieldSpan {
    start: number
    end: number
    value: string
    spaceWhenFilled: boolean
    /** Original bytes when the page-selection tag sits inside the editable text. */
    pageSource?: string
}

export interface BidirectionalBlock {
    id: number
    idStart: number
    idLocation?: 'heading' | 'yaml' | 'after-answer'
    /** For page cards, tag metadata follows the ID under the heading. */
    tagEnd?: number
    /** Start of the local-only notes on a dedicated card page. */
    answerBoundary?: number
    fieldPair?: readonly [string, string]
    /** Line start before trailing Tags, suspension, ID, or END in an explicit block. */
    namedFieldInsertAt?: number
    blockSyntax?: DuplicateMarkerSyntax
    pageFieldSyntax?: DuplicateMarkerSyntax
    pageOptionalFieldNames?: readonly string[]
    linkedRoute?: import('./page-card').LinkedPageRoute
    /** Exact user-authored spans. Internal Front/Back refer to the first two captures. */
    layout?: { names: readonly string[]; separators: readonly string[]; multiline: boolean; answer: string }
    format?: string
    start: number
    end: number
    line: number
    endLine: number
    model: string
    front: string
    back: string
    extra: Record<string, string>
    explicitFields: ReadonlyMap<string, ExplicitFieldSpan>
    eol: string
    begin: string
    closing: string
}


const fenceMarker = /^ {0,3}(`{3,}|~{3,})(.*)$/u

/** Продолжение простого поля не может начать другой блок или поменять имя поля. */
export function isExplicitFieldBoundary(line: string, block: Pick<BidirectionalBlock, 'begin' | 'closing' | 'blockSyntax'>): boolean {
    if (fieldLabel.test(line) || parseAnkiIdMarker(line) || line === block.begin || line === block.closing) return true
    if (!block.begin) return false
    const syntax = block.blockSyntax
    if (line === (syntax?.['Delete Note Line'] ?? 'DELETE') || line === (syntax?.['Target Deck Line'] ?? 'TARGET DECK') ||
        line === (syntax?.['File Tags Line'] ?? 'FILE TAGS') ||
        line.startsWith((syntax?.['Begin Inline Note'] ?? 'STARTI') + ' ')) return true
    // Malformed suspension commands are unsafe as continuation lines too.
    try { return Boolean(readSuspendLine(line, syntax)) } catch { return true }
}

function readId(line: string): number | undefined {
    return parseAnkiIdMarker(line)?.id
}

function linesOf(content: string): Line[] {
    const lines: Line[] = []
    let start = 0
    for (const match of content.matchAll(/\r\n|\n|\r/gu)) {
        const end = match.index!
        lines.push({ start, end, text: content.slice(start, end) })
        start = end + match[0].length
    }
    if (start < content.length) lines.push({ start, end: content.length, text: content.slice(start) })
    return lines
}

function readFields(content: string, lines: readonly Line[], first: number, limit: number) {
    const result = new Map<string, ExplicitFieldSpan>()
    let active: { name: string; start: number; end: number; spaceWhenFilled: boolean } | undefined
    let tagsStart: number | undefined
    const finish = () => {
        if (!active) return
        const raw = content.slice(active.start, active.end)
        const clean = raw.trim()
        const start = clean ? active.start + raw.length - raw.trimStart().length : active.start
        const end = clean ? active.start + raw.trimEnd().length : active.start
        result.set(active.name, { start, end, value: clean.replace(/\r\n|\r/gu, '\n'),
            spaceWhenFilled: active.spaceWhenFilled && !clean })
    }
    for (let index = first; index < limit; index++) {
        const line = lines[index]
        const label = fieldLabel.exec(line.text)
        if (label) {
            finish()
            const name = label[1]
            if (!name.trim() || name.trim() !== name || tagsStart !== undefined || result.has(name)) return
            if (name === 'Tags') {
                tagsStart = line.start
                active = undefined
                continue
            }
            const start = line.start + name.length + 1 + label[2].length
            active = { name, start, end: line.end, spaceWhenFilled: !label[2].length }
        } else if (active) {
            active.end = line.end
        } else if (line.text.trim()) {
            return
        }
    }
    finish()
    return result.size ? { fields: result, tagsStart } : undefined
}

export function isWritableBlockExtraName(name: string): boolean {
    return isBidirectionalFieldName(name) && !/^(?:ob-deck-|(?:ForgeKey|CardKey|anki-page-id|rudonium-id)$)/iu.test(name) &&
        fieldLabel.exec(name + ': ')?.[1] === name &&
        (!name.includes('#') || pageTagOffsets(name + ': ').length === 0)
}

/** Only claim labels in the exact START / END range recognized by the one-way parser. */
export function explicitBlockNamedFields(source: string, model: string, names: readonly string[],
    syntax: DuplicateMarkerSyntax = {}): string[] | undefined {
    const begin = syntax['Begin Note'] ?? 'START', closing = syntax['End Note'] ?? 'END'
    if (!begin || !closing || begin === closing || !source.trimStart().startsWith(begin)) return
    const text = source.trim()
    const lines = linesOf(text)
    if (lines[0]?.text.trim() !== begin || lines[1]?.text.trim() !== model) return
    // The upstream match can own the ID inside the block or on the next line.
    let end = lines.length - 1
    if (end > 2 && readId(lines[end].text)) {
        end--
        if (readSuspendLine(lines[end].text, syntax)) end--
    }
    if (end <= 2 || lines[end].text.trim() !== closing) return
    let limit = end
    if (readId(lines[limit - 1].text)) {
        limit--
        if (readSuspendLine(lines[limit - 1].text, syntax)) limit--
    }
    if (lines.slice(2, limit).some(row => {
        const trimmed = row.text.trim()
        return trimmed === begin || trimmed === closing || trimmed === (syntax['Delete Note Line'] ?? 'DELETE') ||
            fenceMarker.test(row.text) || trimmed.startsWith('%%') || trimmed.startsWith('<!--') || Boolean(readId(row.text))
    })) return
    const parsed = readFields(text, lines, 2, limit)
    if (!parsed || [...parsed.fields.keys()].some(name => !names.includes(name))) return
    return [...parsed.fields.keys()].filter(name => name !== names[0] && name !== names[1] && isWritableBlockExtraName(name))
}

/** Координаты берём только у явно подписанных полей. Формат и ID дополнительно проверяет штатный разборщик. */
export function findBidirectionalBlocks(content: string, syntax: DuplicateMarkerSyntax = {},
    modelFields?: Readonly<Record<string, readonly string[]>>): BidirectionalBlock[] {
    if (content.includes('RUDONIUM-ARCHIVE')) content = activeCardMarkdown(content)
    const begin = syntax['Begin Note'] ?? 'START'
    const closing = syntax['End Note'] ?? 'END'
    if (!begin || !closing || begin === closing || !content.includes(begin) ||
        !content.includes(closing) || !content.includes('ID:')) return []
    const lines = linesOf(content)
    let first = 0
    if (/^\uFEFF?---[ \t]*$/u.test(lines[0]?.text ?? '')) {
        const end = lines.findIndex(({ text }, index) => index > 0 && /^---[ \t]*$/u.test(text))
        if (end === -1) return []
        first = end + 1
    }
    const blocks: BidirectionalBlock[] = []
    let fence = ''
    let comment = ''
    let math = false
    let opening = -1
    for (let index = first; index < lines.length; index++) {
        const { text } = lines[index]
        const trimmed = text.trim()
        const marker = fenceMarker.exec(text)
        if (fence) {
            if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
            continue
        }
        if (comment) {
            if (text.includes(comment)) comment = ''
            continue
        }
        if (marker) {
            fence = marker[1]
            opening = -1
            continue
        }
        if (trimmed === '$$') {
            math = !math
            opening = -1
            continue
        }
        if (math) continue
        const htmlComment = text.indexOf('<!--')
        const obsidianComment = text.indexOf('%%')
        if (htmlComment !== -1 && !text.includes('-->', htmlComment + 4) ||
            obsidianComment !== -1 && !text.includes('%%', obsidianComment + 2)) {
            comment = htmlComment !== -1 && !text.includes('-->', htmlComment + 4) ? '-->' : '%%'
            opening = -1
            continue
        }
        if (trimmed === begin && /^ {0,3}\S/u.test(text)) {
            opening = opening === -1 ? index : -1
            continue
        }
        if (opening < 0 || trimmed !== closing) continue
        const start = opening
        opening = -1
        if (index - start < 3 || index - start > 200 || lines[index].end - lines[start].start > 65_536) continue
        const existing = readId(lines[index - 1].text)
        const markedExternal = !!readId(lines[index + 2]?.text ?? '') && !!readSuspendLine(lines[index + 1]?.text ?? '', syntax)
        const outside = index + (markedExternal ? 2 : 1)
        const external = readId(lines[outside]?.text ?? '')
        // Два соседних ID означают неоднозначную привязку, которая остаётся для ручной проверки.
        if (existing && external || !existing && !external) continue
        const end = external ? outside : index
        const model = lines[start + 1].text.trim()
        const fieldEnd = existing ? index - (readSuspendLine(lines[index - 2].text, syntax) ? 2 : 1) : index
        const parsed = readFields(content, lines, start + 2, fieldEnd)
        if (!parsed || !model) continue
        const { fields, tagsStart } = parsed
        const names = modelFields?.[model]
        // Named blocks can spell the question and answer in the language of the Anki model.
        const pair: readonly [string, string] | undefined = names && names.length >= 2 &&
            !(fields.has('Front') && fields.has('Back')) && names[0] !== names[1] &&
            names.slice(0, 2).every((name, i) => fields.has(name) &&
                (name === (i ? 'Back' : 'Front') || isWritableBlockExtraName(name))) &&
            !names.slice(2).some(name => name === 'Front' || name === 'Back') ? [names[0], names[1]] : undefined
        const frontName = pair?.[0] ?? 'Front', backName = pair?.[1] ?? 'Back'
        const extra = Object.fromEntries([...fields].filter(([name]) => name !== frontName && name !== backName)
            .map(([name, field]) => [name, field.value]))
        const eol = content.slice(lines[start].end, lines[start + 1].start)
        if (eol !== '\r\n' && eol !== '\n') continue
        blocks.push({ id: (existing ?? external)!, idStart: lines[existing ? index - 1 : outside].start,
            start: lines[start].start, end: lines[end].end, line: start + 1,
            endLine: end + 1, model, front: fields.get(frontName)?.value ?? '', back: fields.get(backName)?.value ?? '',
            fieldPair: pair, layout: pair && { names: pair, separators: [], multiline: true, answer: 'Back' },
            extra, explicitFields: pair ? new Map([...fields].map(([name, span]) =>
                [name === frontName ? 'Front' : name === backName ? 'Back' : name, span] as const)) : fields,
            namedFieldInsertAt: tagsStart ?? lines[fieldEnd].start, blockSyntax: syntax, eol, begin, closing })
    }
    return blocks
}
