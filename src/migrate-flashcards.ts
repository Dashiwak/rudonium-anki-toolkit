// SPDX-License-Identifier: GPL-3.0-only
import { parseYaml } from 'obsidian'
import { splitMigrationMarkdown, withoutMigrationKeys } from './migration-markdown'
import { looksLikeAnkiIdMarker, parseAnkiIdMarker } from './anki-id-marker'
import type { MigrationAdapter, MigrationCandidate } from './page-migration-context'

type Sides = { front: string; back: string }
const own = (object: object, name: string) => Object.prototype.hasOwnProperty.call(object, name)
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
const cardTag = /(?:^|[ \t])#card(?:[-/][\w-]+)?(?=[ \t]|$)/u
const callout = /^> ?\[!CARD\][+-]?[ \t]*(?::[ \t]*)?(.*)$/iu
const fence = /^`{3}flashcard[ \t]*$/u
const yamlHint = /^(?:["']?(?:test|flashcards|cards-deck|cards-tags)["']?)[ \t]*:/mu
const anchorHint = /(?:^|[ \t])\^(?:q-|\d{13}(?=[ \t]|$))/u
const anchorPattern = /(?:^|[ \t]+)\^(q-[a-z0-9][a-z0-9-]{2,31}|[1-9]\d{12})[ \t]*$/u
const blockStart = /^(?: {4}|\t| {0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|`{3}|~{3}|<!--|%%|\||---+$|===+$))/u

/** Fenced examples and comments in prose do not announce a source card. */
function visibleMarker(rows: readonly string[], match: (row: string) => boolean): boolean {
    let code = '', comment = ''
    for (const row of rows) {
        if (code) {
            const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(row)
            if (end && end[1][0] === code[0] && end[1].length >= code.length) code = ''
            continue
        }
        if (comment) { if (row.includes(comment)) comment = ''; continue }
        const start = /^ {0,3}(`{3,}|~{3,})/u.exec(row)
        if (start) {
            if (fence.test(row) && match(row)) return true
            code = start[1]
            continue
        }
        const opening = /<!--|%%/u.exec(row)
        if (opening) {
            if (match(row.slice(0, opening.index))) return true
            const end = opening[0] === '<!--' ? '-->' : '%%'
            if (!row.includes(end, opening.index + opening[0].length)) comment = end
            continue
        }
        if (/^(?: {4}|\t)/u.test(row) || /^ {0,3}>/u.test(row) && !callout.test(row)) continue
        if (match(row)) return true
    }
    return false
}

function trimBlankRows(lines: string[]): string[] {
    let first = 0, end = lines.length
    while (first < end && !lines[first].trim()) first++
    while (end > first && !lines[end - 1].trim()) end--
    return lines.slice(first, end)
}

function headingSafe(front: string): boolean {
    return !!front && front === front.trim() && !blockStart.test(front) &&
        !/[\r\n\x00-\x1f]|#anki-page|(?:^|\s)\^[\w-]+$/u.test(front)
}

/** Page migration accepts whole source files. An anchor on an unrelated inner block must stay there. */
function extractAnchor(rows: string[]): string | undefined | false {
    let found: string | undefined
    for (let i = 0; i < rows.length; i++) {
        if (!anchorHint.test(rows[i])) continue
        const match = anchorPattern.exec(rows[i])
        if (!match || found || anchorHint.test(rows[i].slice(0, match.index))) return false
        const before = rows[i].slice(0, match.index)
        const belowQuestion = before.trim() === '#card'
        if (i !== 0 && !belowQuestion && i !== rows.length - 1 && (before.trim() || i !== 1)) return false
        if (i === rows.length - 1 && i > 0 && before.trim() && blockStart.test(before)) return false
        found = match[1]
        rows[i] = rows[i].slice(0, match.index)
        if (!rows[i]) rows.splice(i--, 1)
    }
    return found
}

function positiveId(value: unknown): number | undefined {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value))) return
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** A q-* key is a Markdown identity, not an Anki ID. Only its exact map entry may supply nid. */
function linkedFlashcard(anchor: string | undefined, properties: Record<string, unknown>, yaml: string): number | undefined | false {
    const legacy = anchor && /^\d{13}$/u.test(anchor) ? Number(anchor) : undefined
    if (!own(properties, 'flashcards')) return legacy
    const entries = properties.flashcards
    if (!record(entries) || !anchor || Object.keys(entries).length !== 1 || !own(entries, anchor)) return false
    const entry = entries[anchor]
    if (!record(entry) || Object.keys(entry).some(key => !['nid', 'hash', 'sync'].includes(key))) return false
    if (!own(entry, 'nid')) return legacy
    const id = positiveId(entry.nid)
    // Check the raw scalar as well. A YAML reader can coerce hexadecimal/fractional values
    // into an integer or silently accept a repeated mapping key.
    const tokens = [...yaml.matchAll(/(?:^|[\s,{])(?:nid|'nid'|"nid")[ \t]*:[ \t]*/gu)]
    if (tokens.length !== 1) return false
    const raw = yaml.slice(tokens[0].index + tokens[0][0].length)
    const digits = /^(?:"([1-9]\d*)"|'([1-9]\d*)'|([1-9]\d*))(?=[ \t]*(?:[,}#]|\r?$))/mu.exec(raw)
    if (!digits || digits.index !== 0 || (digits[1] ?? digits[2] ?? digits[3]) !== String(id)) return false
    return id && (!legacy || id === legacy) ? id : false
}

function fencedSides(rows: string[]): Sides | undefined {
    if (!fence.test(rows[0]) || rows[rows.length - 1]?.trimEnd() !== '```') return
    const fields = new Map<string, string[]>()
    let field: string[] | undefined
    for (const line of rows.slice(1, -1)) {
        if (/^[ \t]*(?:`{3}|~{3})/u.test(line)) return
        const key = /^(front|back|content|type):[ \t]*(.*)$/u.exec(line)
        if (key) {
            if (key[1] === 'content' || fields.has(key[1])) return
            field = [key[2]]
            fields.set(key[1], field)
        } else if (field) field.push(line)
        else if (line.trim()) return
    }
    const type = fields.get('type')?.join('\n').trim()
    if (type !== undefined && type !== 'basic') return
    return { front: fields.get('front')?.join('\n').trim() ?? '', back: fields.get('back')?.join('\n').trim() ?? '' }
}

function taggedSides(rows: string[]): Sides | undefined {
    const header = /^(#{1,6})[ \t]+(.*)$/u.exec(rows[0])
    const line = header?.[2] ?? rows[0]
    const inline = /^(\S.*?)[ \t]+#card[ \t]*$/u.exec(line)
    if (inline && cardTag.test(inline[1])) return
    let next = 1
    if (!inline) {
        while (next < rows.length && !rows[next].trim()) next++
        if (rows[next]?.trimEnd() !== '#card') return
        next++
    }
    const answer = trimBlankRows(rows.slice(next))
    if (answer.some(row => cardTag.test(row) || fence.test(row) || callout.test(row))) return
    // A tagged heading owns only its section. A tagged paragraph owns only one block.
    if (header) {
        if (answer.some(row => {
            const nextHeading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/u.exec(row)
            return (nextHeading && nextHeading[1].length <= header[1].length) || /^(?:=+|-+)[ \t]*$/u.test(row)
        })) return
    } else if (answer.some(row => !row.trim() || blockStart.test(row))) return
    return { front: (inline?.[1] ?? line).trimEnd(), back: answer.join('\n') }
}

function readFlashcard(path: string, rows: string[], props: Record<string, unknown>, allowInline: boolean): Sides | undefined {
    if (!rows.length) return
    if (own(props, 'test')) {
        const cue = Array.isArray(props.test) && props.test.length === 1 ? props.test[0] : props.test
        const title = path.split('/').pop()?.replace(/\.md$/iu, '') ?? ''
        if (typeof cue !== 'string' || !cue.trim() || ['reversed', 'cloze'].includes(cue) ||
            (cue !== 'title' && cue.toLowerCase() === title.toLowerCase())) return
        if (rows.some(row => !row.trim() || blockStart.test(row) || cardTag.test(row))) return
        return { front: cue === 'title' ? title : cue, back: rows.join('\n') }
    }
    if (fence.test(rows[0])) return fencedSides(rows)
    const box = callout.exec(rows[0])
    if (box) {
        if (rows.slice(1).some(row => !/^>/u.test(row))) return
        return { front: box[1].trim(), back: rows.slice(1).map(row => row.replace(/^> ?/u, '')).join('\n') }
    }
    if (rows.some(row => cardTag.test(row))) return taggedSides(rows)
    if (allowInline && rows.length === 1 && !blockStart.test(rows[0]) && !/[`$\\]|:::|\[\[|\]\(/u.test(rows[0])) {
        const bits = rows[0].split('::')
        if (bits.length === 2) return { front: bits[0].trimEnd(), back: bits[1].trimStart() }
    }
}

/** Detect documented Flashcards v1/v2 signatures. Never use a bare :: as automatic proof of ownership. */
export const detectFlashcards: MigrationAdapter = (path, text, context) => {
    const source = 'flashcards'
    if (context.source && context.source !== 'auto' && context.source !== source) return
    const selected = context.source === source
    if (!/#card\b|\[!CARD\]|^`{3}flashcard|(?:^|\s)\^(?:q-|\d{13}\b)/imu.test(text) && !yamlHint.test(text) &&
        !(selected && text.includes('::'))) return
    const review = (en: string, ru: string, id?: number): MigrationCandidate =>
        ({ source, status: 'review', reason: context.t(en, ru), id })
    const parts = splitMigrationMarkdown(text)
    if (!parts) return review('Check the YAML boundaries in this file.', 'Проверьте границы свойств YAML в этом файле.')
    const rows = trimBlankRows(parts.body.split(/\r?\n/u))
    const hasProps = yamlHint.test(parts.yaml)
    const first = rows[0] ?? ''
    const evidence = visibleMarker(rows, row => cardTag.test(row) || anchorHint.test(row) || callout.test(row) || fence.test(row))
    if (!hasProps && !evidence && !(selected && first.includes('::'))) return
    // A complete file starting with an ordinary code fence, comment or indented code is an example.
    if (!hasProps && /^(?: {4}|\t| {0,3}(?:`{3}|~{3}|<!--|%%))/u.test(first) && !fence.test(first)) return
    let props: Record<string, unknown> = {}
    if (parts.yaml) {
        try {
            const parsed: unknown = parseYaml(parts.yaml.replace(/^---[^\n]*\n/u, '').replace(/^---[ \t]*(?:\r?\n)?$/mu, ''))
            if (parsed != null) {
                if (!record(parsed)) throw Error()
                props = parsed
            }
        } catch { return review('Check for invalid or duplicate YAML properties.', 'Проверьте ошибки и повторяющиеся свойства YAML.') }
    }
    if (!selected && !evidence && !own(props, 'flashcards') && !(own(props, 'test') && own(props, 'cards-deck'))) {
        if (own(props, 'test')) return review('Confirm Flashcards as the source to import this test property.', 'Выберите Flashcards как источник, чтобы перенести карточку со свойством test.')
        return
    }
    // YAML merges and aliases can inherit another record's ID or cue. Require literal keys.
    if (/^[ \t]*(?:<<[ \t]*:|[-\w'" ]+:[ \t]*[&*][\w-]+)/mu.test(parts.yaml)) {
        return review('Check YAML anchors and inherited source properties.', 'Проверьте якоря YAML и унаследованные свойства карточки.')
    }
    const anchor = extractAnchor(rows)
    const id = anchor !== false && linkedFlashcard(anchor, props, parts.yaml)
    if (anchor === false || id === false) return review('Check the Markdown anchor and its original Anki note ID in flashcards.', 'Проверьте якорь Markdown и соответствующий ID записи Anki в свойстве flashcards.')
    if (Object.keys(props).some(key => key.startsWith('cards-') && key !== 'cards-deck') ||
        (own(props, 'cards-deck') && (typeof props['cards-deck'] !== 'string' || !props['cards-deck'].trim()))) {
        return review('Check the original deck, tags and Flashcards properties.', 'Проверьте исходную колоду, теги и параметры Flashcards.', id)
    }
    if (rows.some(row => looksLikeAnkiIdMarker(row) || /^(?:STARTI?|ENDI?)\s*$/u.test(row))) {
        return review('This file contains additional card markers.', 'В файле найдены дополнительные маркеры карточек.', id)
    }
    const sides = readFlashcard(path, trimBlankRows(rows), props, selected || !!anchor)
    if (!sides || !headingSafe(sides.front) || !sides.back.trim()) {
        return review('Check the card type and boundaries. A page needs one basic question and its complete answer.', 'Проверьте тип и границы карточки. Для страницы нужны один обычный вопрос и весь его ответ.', id)
    }
    const yaml = withoutMigrationKeys(parts.yaml, new Set(['test', 'flashcards', 'cards-deck'].filter(key => own(props, key))))
    if (yaml === undefined) return review('Check the source YAML spelling and references.', 'Проверьте оформление исходного YAML и ссылки на его свойства.', id)
    return { source, status: 'candidate', front: sides.front, back: sides.back.replace(/\n/gu, parts.eol), id, prefix: parts.bom + yaml, anchor,
        externalKey: anchor?.startsWith('q-') ? anchor : undefined, recoveryModel: 'Obsidian-basic', model: id ? 'Obsidian-basic' : undefined, deck: props['cards-deck'] as string | undefined }
}

export const detectObsidianToAnki: MigrationAdapter = (_path, text, context) => {
    const source = 'obsidian-to-anki'
    if (context.source && context.source !== 'auto' && context.source !== source || !/^STARTI?(?:[ \t]|\r?$)/mu.test(text)) return
    const review = (en: string, ru: string, id?: number): MigrationCandidate =>
        ({ source, status: 'review', reason: context.t(en, ru), id })
    const parts = splitMigrationMarkdown(text)
    if (!parts) return review('Check the YAML boundaries before importing.', 'Проверьте границы YAML перед переносом.')
    let rows = trimBlankRows(parts.body.split(/\r?\n/u))
    if (!visibleMarker(rows, row => /^STARTI?(?:[ \t]|$)/u.test(row))) return
    if (/^(?: {4}|\t| {0,3}(?:`{3}|~{3}|<!--|%%))/u.test(rows[0])) return
    let deck: string | undefined
    if (rows[0] === 'TARGET DECK' || /^TARGET DECK:[ \t]/u.test(rows[0])) {
        const inline = rows[0] !== 'TARGET DECK'
        deck = inline ? rows[0].slice('TARGET DECK:'.length).trim() : rows[1]?.trim()
        if (!deck || /^(?:(?:STARTI?|ENDI?)$|TARGET DECK(?:[: \t]|$))/u.test(deck)) return review('Specify the original target deck.', 'Укажите исходную колоду.')
        rows = trimBlankRows(rows.slice(inline ? 1 : 2))
    }
    const last = rows.length - 1
    if (last > 0 && (rows[last - 1] === 'TARGET DECK' || /^TARGET DECK:[ \t]/u.test(rows[last]))) {
        if (deck) return review('Check the repeated target deck directive.', 'Проверьте повторяющуюся команду выбора колоды.')
        const inline = rows[last - 1] !== 'TARGET DECK'
        deck = (inline ? rows[last].slice('TARGET DECK:'.length) : rows[last]).trim()
        if (!deck || /^(?:(?:STARTI?|ENDI?)$|TARGET DECK(?:[: \t]|$))/u.test(deck)) return review('Check the target deck name.', 'Проверьте название колоды.')
        rows = trimBlankRows(rows.slice(0, inline ? last : last - 1))
    }
    if (rows[0] !== 'START' || rows.filter(row => /^STARTI?(?:[ \t]|$)/u.test(row)).length !== 1) {
        return review('Keep one START/END note per file and check any surrounding text.', 'Проверьте текст вокруг записи. В файле нужна одна запись START/END.')
    }
    let id: number | undefined
    const markers = rows.flatMap((row, index) => looksLikeAnkiIdMarker(row) ? [index] : [])
    if (markers.length) {
        const i = markers[0]
        const marker = parseAnkiIdMarker(rows[i])
        if (markers.length !== 1 || !marker || marker.warning || String(marker.id) !== marker.digits ||
            !(i === rows.length - 2 && rows[rows.length - 1] === 'END' || i === rows.length - 1 && rows[rows.length - 2] === 'END')) {
            return review('Check the Anki note ID and its position beside END.', 'Проверьте ID записи Anki и его положение рядом с END.')
        }
        id = marker.id
        rows.splice(i, 1)
    }
    if (rows[rows.length - 1] !== 'END' || rows.slice(1, -1).some(row => /^(?:ENDI?\b|TARGET DECK\b|FILE TAGS\b|FROZEN\b|DELETE\b|Tags:)|<!--\s*(?:ID:|Obsidian-to-Anki pending |anki-bidirectional-tags:)/u.test(row))) {
        return review('Check text outside the note and any tag, frozen-field or deck directives.', 'Проверьте текст вне записи и директивы тегов, фиксированных полей и колоды.', id)
    }
    const model = rows[1] ?? ''
    if (!model.trim() || model !== model.trim() || /cloze|reverse|type in|type-in/iu.test(model)) {
        return review('Check the original card template and its directions.', 'Проверьте шаблон исходной карточки и её направления.', id)
    }
    const content = trimBlankRows(rows.slice(2, -1))
    const frontLine = content.shift() ?? ''
    const explicit = /^Front:[ \t]*(.*)$/u.exec(frontLine)
    const front = explicit ? explicit[1] : frontLine
    const tail = trimBlankRows(content)
    const backLine = /^Back:[ \t]*(.*)$/u.exec(tail[0] ?? '')
    const extraField = /^[^ \t:][^:]{0,80}:(?:[ \t]|$)/u
    if ((!explicit && (model !== 'Basic' || extraField.test(front))) || !headingSafe(front) || !backLine ||
        tail.slice(1).some(row => extraField.test(row))) {
        return review('Check the fields. A page needs a one-line Front and one Back.', 'Проверьте поля. Для страницы нужны однострочный Front и одно поле Back.', id)
    }
    const back = trimBlankRows([backLine[1], ...tail.slice(1)]).join(parts.eol)
    if (!back.trim()) return review('The answer is empty.', 'Ответ пуст.', id)
    return { source, status: 'candidate', front, back, model, id, deck, prefix: parts.bom + parts.yaml, fieldNames: ['Front', 'Back'] }
}
