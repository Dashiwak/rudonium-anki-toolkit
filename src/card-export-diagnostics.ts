/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { hasPageYamlIdText } from './page-frontmatter'
import { activeCardMarkdown } from './archived-card'
import { maskIdMarkerHtmlLiterals } from './id-marker-literals'
import { markedPageAnswerBoundary, parseAnkiIdMarker } from './anki-id-marker'
import { Md5 } from 'ts-md5'
import { isDuplicateFirstFieldErrorMessage } from './anki-transport'
import { findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax, IdMarker } from './duplicate-markers'
import { frontmatterBounds, makeSpanLookup, makeSpanOverlap } from './markdown-pipeline'
import { uiDiagnostic } from './interface-language'
import type { UiText } from './interface-language'
import type { DuplicateAnkiCandidate, DuplicateSource } from './duplicate-preflight'

export { isDuplicateFirstFieldErrorMessage } from './anki-transport'

export type ExportCardIssueCode =
    'missing-note-type' | 'unknown-note-type' | 'unrecognized-block' | 'missing-id' |
    'unmatched-id' | 'duplicate-id' | 'duplicate-first-field' | 'unconfirmed-response' | 'protected-block' | 'conflicting-deck-directive'

export interface ExportCardIssue {
    code: ExportCardIssueCode
    line: number
    message: string
    id?: number
    deck?: string
    source?: ExportCardLocation
    duplicateOrigin?: 'anki' | 'batch'
    otherSource?: DuplicateSource
    ankiCandidates?: readonly DuplicateAnkiCandidate[]
}

export interface ExportCardLocation {
    line: number
    endLine: number
    startColumn: number
    endColumn: number
    markerColumn?: number
    digest?: string
}

export interface CardRange {
    start: number
    end: number
    identifier?: number
}

interface SourceLine {
    line: number
    offset: number
    end: number
    text: string
}

interface InspectSource<T extends CardRange> {
    text: string
    ranges: readonly T[]
    syntax?: DuplicateMarkerSyntax
    noteTypes: ReadonlySet<string>
    existingIds: ReadonlySet<number>
    duplicateIds: ReadonlyMap<number, string>
    tableIdWarnings?: ReadonlyArray<{ id: number; line: number }>
    linkedRanges?: readonly CardRange[]
    deck?: string
    protectedSpans?: ReadonlyArray<readonly [number, number]>
    frontmatterEnd?: number
}

interface CardInspection<T extends CardRange> {
    issues: readonly ExportCardIssue[]
    skippedNew: ReadonlySet<T>
    skippedIds: ReadonlySet<number>
}

export function isExportCardIssue(value: unknown): value is ExportCardIssue {
    if (!value || typeof value !== 'object') return false
    const { code, line, message, id, deck, source, duplicateOrigin, otherSource, ankiCandidates } = value as Partial<ExportCardIssue>
    return (code === 'missing-note-type' || code === 'unknown-note-type' || code === 'unrecognized-block' ||
        code === 'missing-id' || code === 'unmatched-id' || code === 'duplicate-id' ||
        code === 'duplicate-first-field' || code === 'unconfirmed-response' || code === 'protected-block' ||
        code === 'conflicting-deck-directive') &&
        typeof line === 'number' && Number.isSafeInteger(line) && line > 0 && typeof message === 'string' &&
        (id === undefined || Number.isSafeInteger(id) && id > 0) &&
        (deck === undefined || typeof deck === 'string') &&
        (duplicateOrigin === undefined || duplicateOrigin === 'anki' || duplicateOrigin === 'batch') &&
        (otherSource === undefined || otherSource !== null && typeof otherSource.path === 'string' &&
            Number.isSafeInteger(otherSource.line) && otherSource.line > 0 &&
            typeof otherSource.modelName === 'string' && typeof otherSource.deckName === 'string') &&
        (ankiCandidates === undefined || Array.isArray(ankiCandidates) && ankiCandidates.length <= 8 && ankiCandidates.every(isDuplicateCandidate)) &&
        (source === undefined || source !== null && Number.isSafeInteger(source.line) && source.line > 0 &&
            Number.isSafeInteger(source.endLine) && source.line <= line && source.endLine >= line &&
            Number.isSafeInteger(source.startColumn) && source.startColumn >= 0 &&
            Number.isSafeInteger(source.endColumn) && source.endColumn >= 0 &&
            (source.markerColumn === undefined || Number.isSafeInteger(source.markerColumn) && source.markerColumn >= 0) &&
            (source.digest === undefined || typeof source.digest === 'string' && /^[a-f0-9]{32}$/.test(source.digest)))
}

function isDuplicateCandidate(value: DuplicateAnkiCandidate): boolean {
    return !!value && Number.isSafeInteger(value.id) && value.id > 0 && typeof value.modelName === 'string' &&
        Array.isArray(value.decks) && value.decks.every(deck => typeof deck === 'string') &&
        Array.isArray(value.fieldChanges) && value.fieldChanges.length <= 12 && value.fieldChanges.every(field => !!field &&
            typeof field.name === 'string' && (field.source === undefined || typeof field.source === 'string') &&
            (field.anki === undefined || typeof field.anki === 'string'))
}

export function exportCardIssueText(issue: ExportCardIssue, t: UiText): string {
    const id = issue.id
    switch (issue.code) {
        case 'missing-id':
            if (id !== undefined) return t(`Card with ID: ${id} was not found in Anki!`, `Карточка с ID: ${id} в Anki не найдена!`)
            return t(issue.message, 'Карточка не найдена в открытом профиле Anki.')
        case 'missing-note-type': return t(issue.message, 'Укажите тип записи в блоке карточки.')
        case 'unknown-note-type': {
            const model = /[“«]([^”»]+)[”»]/.exec(issue.message)?.[1]
            return t(issue.message, model ? `Тип записи «${model}» отсутствует в Anki. Проверьте настройки типов записей.` :
                'Тип записи отсутствует в Anki. Проверьте настройки типов записей.')
        }
        case 'unrecognized-block': return t(issue.message, 'Формат карточки не распознан. Проверьте её поля и закрывающий маркер.')
        case 'unmatched-id': return issue.message === tableIdAdvice ? t(tableIdAdvice, 'ID находится в ячейке. Перенесите строку ID под таблицу.') : /^Damaged Anki ID marker/.test(issue.message)
            ? t(issue.message, `Повреждён маркер ID. Проверьте исходную карточку в Anki и исправьте маркер на ID: ${id ?? '…'}.`)
            : t(issue.message, `Карточка около ID ${id ?? '…'} не распознана. Проверьте разметку или регулярное выражение.`)
        case 'duplicate-id': return localizeExportError(issue.message, t)
        case 'duplicate-first-field': {
            const other = issue.otherSource
            if (other) return t(`Card skipped. This export has the same first field at ${other.path}:${other.line} (${other.modelName} · ${other.deckName}).`,
                `Карточка пропущена. Первое поле совпадает с записью в этом экспорте ${other.path}:${other.line} (${other.modelName} · ${other.deckName}).`)
            const candidates = issue.ankiCandidates?.length ? issue.ankiCandidates.map(({ id }) => id).join(', ') : undefined
            return t('Card skipped. Anki already has a note with the same first field.',
                'Карточка пропущена. В Anki уже есть запись с таким же первым полем.') + (candidates
                ? t(` Candidate IDs: ${candidates}.`, ` Подходящие ID: ${candidates}.`) : '')
        }
        case 'unconfirmed-response': return t(issue.message,
            'Anki не подтвердила создание записи. Проверьте незавершённое создание записей Anki перед повтором.')
        case 'protected-block': return t(issue.message, `Строка ${issue.line} похожа на карточку внутри математического блока.`)
        case 'conflicting-deck-directive': {
            const conflict = /Deck “(.+)” is ignored\. The first active deck is “(.+)” on line (\d+)\./.exec(issue.message)
            return t(issue.message, conflict
                ? `Используется колода «${conflict[2]}» из строки ${conflict[3]}. Указание «${conflict[1]}» в строке ${issue.line} пропущено.`
                : `В строке ${issue.line} указана другая колода. Используется первое действующее указание колоды.`)
        }
    }
}

/** Messages emitted by the one-way planner for values that require an explicit choice. */
export function fieldReviewIssue(message: string): { id: string; field: string; reason: 'first' | 'both' | 'cards' } | undefined {
    const match = /^Anki note (\d+), field “(.+)” (?:needs review: (no confirmed previous value is available|Obsidian and Anki both changed)\.|(may change its study cards)\.)/u.exec(message)
    if (!match) return
    return { id: match[1], field: match[2], reason: match[4] ? 'cards' : match[3].startsWith('no confirmed') ? 'first' : 'both' }
}

export function localizeExportError(error: string, t: UiText): string {
    if (t('en', 'ru') === 'en') return error
    const clean = error.replace(/^Error:\s*/i, '')
    const withPath = /^(.+?\.md):\s+([\s\S]*)$/i.exec(clean)
    if (withPath) return `${withPath[1]}: ${localizeExportError(withPath[2], t)}`
    if (clean.startsWith('Anki Browse: ID ') || clean.startsWith('Deck type unverified: ')) return uiDiagnostic(clean, t)
    const review = fieldReviewIssue(clean)
    if (review) {
        const why = review.reason === 'cards' ? 'Изменение может повлиять на учебные карточки.' :
            review.reason === 'first' ? 'Ещё нет подтверждённого общего значения.' : 'Значение изменилось с обеих сторон.'
        return `Anki ID ${review.id}, поле «${review.field}». ${why} Проверьте поле в предпросмотре экспорта.`
    }
    const missing = /^Anki note (\d+) was not found\b/.exec(clean)
    if (missing) return `Карточка с ID: ${missing[1]} в Anki не найдена!`
    const duplicate = /^Duplicate Anki note ID (\d+) in (.+)\. Keep the ID in one source\.?$/.exec(clean)
    if (duplicate) return `ID Anki ${duplicate[1]} встречается несколько раз: ${duplicate[2]}. Оставьте его в одном исходном блоке.`
    const filtered = /^(.+) is a filtered deck\./.exec(clean)
    if (filtered) return `«${filtered[1]}» — фильтрованная колода. Выберите обычную колоду для новых карточек.`
    if (/could not be (?:opened|read)|could not read|missing\. Recheck|has moved or is missing/i.test(clean)) {
        return 'Не удалось открыть источник. Повторите проверку, чтобы обновить расположение карточки.'
    }
    if (/frontmatter|invalid yaml/i.test(clean)) return 'Не удалось прочитать свойства YAML в начале файла.'
    if (/unsaved|editor has.*changes|editor changed|save editor changes/i.test(clean)) {
        return 'В редакторе остались несохранённые или конфликтующие правки. Сохраните их и повторите действие.'
    }
    if (/pending.*(?:creation|journal|marker)|pending markdown/i.test(clean)) {
        return 'Создание записи Anki ещё не подтверждено. Откройте проверку незавершённых операций перед повтором.'
    }
    if (/selected operations changed|Anki changed after the preview|the audited deck changed/i.test(clean)) {
        return 'Выбранные операции или данные в Anki изменились. Откройте новый предпросмотр.'
    }
    if (/attachment changes were not approved/i.test(clean)) {
        return 'Изменения вложений сняты с выбора или устарели. Проверьте и отметьте вложения перед экспортом этого файла.'
    }
    if (/file changed|markdown changed|vault changed|settings changed|profile changed|deck assignments/i.test(clean)) {
        return 'Файл, настройки или профиль изменились во время операции. Откройте новый предпросмотр или повторите проверку.'
    }
    if (/not confirmed|could not confirm|could not verify|unconfirmed/i.test(clean)) {
        return 'Результат операции не подтверждён. Проверьте состояние записи и повторите проверку.'
    }
    if (/timed? ?out|did not reply in time|deadline|fetch|ECONNREFUSED/i.test(clean)) {
        return 'AnkiConnect не ответил. Проверьте, что Anki запущена и доступна.'
    }
    if (/update desktop obsidian/i.test(clean)) return 'Обновите настольную версию Obsidian для безопасной записи файлов.'
    if (/invalid report format/i.test(clean)) return 'У сохранённого отчёта неизвестный формат.'
    return uiDiagnostic(clean, t)
}

function sourceLines(text: string): SourceLine[] {
    const rows: SourceLine[] = []
    let offset = 0
    for (const breakMatch of text.matchAll(/\r\n?|\n/g)) {
        const end = breakMatch.index
        rows.push({ line: rows.length + 1, offset, end, text: text.slice(offset, end) })
        offset = end + breakMatch[0].length
    }
    rows.push({ line: rows.length + 1, offset, end: text.length, text: text.slice(offset) })
    return rows
}

function startsToken(text: string, token: string): boolean {
    const following = text[token.length]
    return Boolean(token && text.startsWith(token) && (following === undefined || /[ \t[|]/.test(following)))
}

export function commentSpans(text: string, isProtected: (offset: number) => boolean): Array<[number, number]> {
    const starts = /<!--|%%/g
    const searchable = maskIdMarkerHtmlLiterals(text)
    const spans: Array<[number, number]> = []
    let marker: RegExpExecArray | null
    while ((marker = starts.exec(searchable))) {
        if (isProtected(marker.index)) continue
        const close = marker[0] === '<!--' ? '-->' : '%%'
        const closingAt = text.indexOf(close, starts.lastIndex)
        const finish = closingAt === -1 ? text.length : closingAt + close.length
        const content = text.slice(marker.index, finish)
        if (!parseAnkiIdMarker(content)?.comment) {
            spans.push([marker.index, finish])
        }
        starts.lastIndex = finish
    }
    return spans
}

/** A named preset may start only in the note body, outside code, metadata and comments. */
export function presetStartGuard(text: string, claimed: readonly (readonly [number, number])[]): (start: number) => boolean {
    const end = frontmatterBounds(text)?.end ?? 0
    const occupied = makeSpanLookup(claimed)
    const protectedAt = (offset: number) => offset < end || occupied(offset)
    if (!text.includes('<!--') && !text.includes('%%')) return protectedAt
    const insideComment = makeSpanLookup(commentSpans(text, protectedAt))
    return offset => protectedAt(offset) || insideComment(offset)
}

/** A wizard delimiter can also occur in deck, tag and frozen-field declarations.
 * Use the active parser's directive expressions so renamed syntax stays protected. */
export function wizardStartGuard(text: string, claimed: readonly (readonly [number, number])[],
    directivePatterns: ReadonlyArray<RegExp | undefined>): (start: number) => boolean {
    const blocked = presetStartGuard(text, claimed)
    const isDirective = wizardServiceGuard(text, directivePatterns, blocked)
    return offset => blocked(offset) || isDirective(offset)
}

export function wizardServiceGuard(text: string, directivePatterns: ReadonlyArray<RegExp | undefined>,
    blocked = presetStartGuard(text, [])): (offset: number) => boolean {
    const spans: Array<[number, number]> = []
    for (const pattern of [...directivePatterns,
        /^[ \t]*(?:[-*+][ \t]+)?(?:[Tt][Aa][Gg][Ss][ \t]*:|(?:<!--[ \t]*)?ID[ \t]*:)[^\r\n]*/gm]) {
        if (!pattern) continue
        const flags = pattern.global ? pattern.flags : pattern.flags + 'g'
        for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
            const start = match.index
            const first = match[0].search(/\S/u)
            if (first >= 0 && !blocked(start + first)) spans.push([start, start + match[0].length])
        }
    }
    return makeSpanLookup(spans)
}

function declaredInlineType(text: string): string | undefined {
    return /^\s*\[([^\r\n\]]+)\]/.exec(text)?.[1]?.trim() ?? /^\s*([^|]+)\|/.exec(text)?.[1]?.trim()
}

function looksLikeInlineFields(text: string): boolean {
    return /^\s*\[/.test(text) || text.includes('|') || /\b(?:Front|Back):[ \t]/.test(text)
}

export function typeInExplicitMatch(match: string, inline: boolean, syntax?: DuplicateMarkerSyntax): string | undefined {
    const text = match.trimStart()
    const marker = inline ? syntax?.['Begin Inline Note'] ?? 'STARTI' : syntax?.['Begin Note'] ?? 'START'
    if (!marker || !text.startsWith(marker)) return undefined
    const body = text.slice(marker.length)
    if (inline) return declaredInlineType(body)
    return /^[ \t]*(?:\r\n?|\n)([^\r\n]+)(?:\r\n?|\n)/.exec(body)?.[1].trim() || undefined
}

export function duplicateFirstFieldSlots(response: unknown, expectedLength: number): number[] {
    if (!response || typeof response !== 'object' || !('error' in response) || !('result' in response)) return []
    const { error, result } = response
    if (error !== null || !Array.isArray(result) || result.length !== expectedLength) return []
    const slots: number[] = []
    result.forEach((row: unknown, index) => {
        if (row && typeof row === 'object' && 'result' in row && row.result === null &&
            'error' in row && typeof row.error === 'string' &&
            isDuplicateFirstFieldErrorMessage(row.error)) slots.push(index)
    })
    return slots
}

export function exportCardSourceDigest(text: string): string {
    return Md5.hashStr(text.replace(/\r\n?/g, '\n')) as string
}

function rowAt(rows: readonly SourceLine[], offset: number): SourceLine {
    let low = 0
    let high = rows.length
    while (low < high) {
        const mid = (low + high) >>> 1
        if (rows[mid].offset <= offset) low = mid + 1
        else high = mid
    }
    return rows[Math.max(0, low - 1)]
}

function occurrences(text: string, block: string): number[] {
    const offsets: number[] = []
    for (let index = text.indexOf(block); index >= 0; index = text.indexOf(block, index + 1)) offsets.push(index)
    return offsets
}

export function duplicateFirstFieldSources(before: string, after: string, ranges: readonly (CardRange | undefined)[],
    insertions: readonly number[] = []): Array<ExportCardLocation | undefined> {
    const unchanged = before === after
    let prefix = 0
    let suffix = 0
    if (!unchanged) {
        const length = Math.min(before.length, after.length)
        while (prefix < length && before[prefix] === after[prefix]) prefix++
        while (suffix < length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
    }
    const offsetsByBlock = new Map<string, Map<number, number>>()
    const rows = sourceLines(after)
    return ranges.map(range => {
        if (!range || range.start < 0 || range.end > before.length || range.start >= range.end) return undefined
        const { start } = range
        let end = range.end
        while (end > start && /[\r\n]/.test(before[end - 1])) end--
        if (start === end) return undefined
        const block = before.slice(start, end)
        let position: number | undefined
        if (unchanged || end <= prefix) position = start
        else if (start >= before.length - suffix) position = start + after.length - before.length
        else {
            let locations = offsetsByBlock.get(block)
            if (!locations) {
                const original = occurrences(before, block)
                const current = occurrences(after, block)
                const kept = original.length === current.length ? original : original.filter(offset =>
                    !insertions.some(point => offset < point && point < offset + block.length))
                locations = new Map(kept.length === current.length ? kept.map((offset, index) => [offset, current[index]]) : [])
                offsetsByBlock.set(block, locations)
            }
            position = locations.get(start)
        }
        if (position === undefined) return undefined
        const first = rowAt(rows, position)
        const last = rowAt(rows, position + block.length)
        return { line: first.line, endLine: last.line, startColumn: position - first.offset,
            endColumn: position + block.length - last.offset, digest: exportCardSourceDigest(block) }
    })
}

const damagedIdStart = /^[ \t]*(<!--[ \t]*)?(ID[ \t]*:[ \t]*(\d+))(?=[ \t]|-->|$)/im
const inlineIdTail = /^[ \t]*(<!--[ \t]*)?(ID[ \t]*:[ \t]*(\d+))(?=[ \t|]|-->|$)(?:[ \t]*\|[^\r\n]*?|[ \t]+\d{4}-\d{2}-\d{2})?[ \t]*(-->)?[ \t]*$/i

interface TableIdConflict { start: number; end: number; line: number; id: number }

/** A formatter can move the entire ID marker into a table cell. Never infer which row owns it. */
export function tableIdConflicts(text: string, protectedAt?: (offset: number) => boolean): TableIdConflict[] {
    if (!text.includes('ID:') || !/^[ \t]*\|[^\r\n]*?ID:[ \t]*\d/mu.test(text)) return []
    const rows = sourceLines(text)
    const result: TableIdConflict[] = []
    for (let header = 0; header + 1 < rows.length; header++) {
        if (!/^\|[^|\r\n]+\|[^|\r\n]+\|[ \t]*$/u.test(rows[header].text) ||
            !/^\|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*$/u.test(rows[header + 1].text) ||
            protectedAt?.(rows[header].offset)) continue
        let stop = header + 2
        while (stop < rows.length && /^\s*\|/u.test(rows[stop].text)) stop++
        for (let index = header; index < stop; index++) {
            const row = rows[index]
            if (!row.text.includes('ID:')) continue
            // HTML ID comments can follow existing cell content. A plain marker starts at a cell boundary.
            const visible = maskIdMarkerHtmlLiterals(row.text, true)
            const token = /<!--[ \t]*ID:[^\r\n]*?-->|(?<=\|)[ \t]*ID:[^|\r\n]*/gu
            for (const match of visible.matchAll(token)) {
                if (protectedAt?.(row.offset + match.index)) continue
                const marker = parseAnkiIdMarker(match[0])
                if (marker) result.push({ start: rows[header].offset, end: rows[stop - 1].end, line: row.line, id: marker.id })
            }
        }
        header = stop - 1
    }
    return result
}

export const tableIdAdvice = 'An Anki ID is inside a table cell. Move its marker to a separate line below the table.'

export function mayHaveCardMarkers(text: string, syntax?: DuplicateMarkerSyntax): boolean {
    const start = syntax?.['Begin Note'] ?? 'START'
    const inlineStart = syntax?.['Begin Inline Note'] ?? 'STARTI'
    return text.includes('ID:') || hasPageYamlIdText(text) || Boolean(start && text.includes(start) || inlineStart && text.includes(inlineStart)) ||
        damagedIdStart.test(text)
}

export function inspectCardSources<T extends CardRange>(input: InspectSource<T>): CardInspection<T> {
    const { ranges, noteTypes, existingIds, duplicateIds } = input
    const text = input.text.includes('RUDONIUM-ARCHIVE') ? activeCardMarkdown(input.text) : input.text
    const issues: ExportCardIssue[] = []
    const skippedNew = new Set<T>()
    const skippedIds = new Set<number>()
    const start = input.syntax?.['Begin Note'] ?? 'START'
    const end = input.syntax?.['End Note'] ?? 'END'
    const inlineStart = input.syntax?.['Begin Inline Note'] ?? 'STARTI'
    const inlineEnd = input.syntax?.['End Inline Note'] ?? 'ENDI'
    const deleteMarker = input.syntax?.['Delete Note Line'] ?? 'DELETE'
    if (!mayHaveCardMarkers(text, input.syntax)) {
        return { issues, skippedNew, skippedIds }
    }

    const rows = sourceLines(text)
    const isProtected = makeSpanLookup(input.protectedSpans ?? [])
    const contentEnd = markedPageAnswerBoundary(text) ?? text.length
    const isSourceRegion = (offset: number) => offset >= (input.frontmatterEnd ?? 0) && offset < contentEnd && !isProtected(offset)
    const comments = commentSpans(text, offset => !isSourceRegion(offset))
    const isComment = makeSpanLookup(comments)
    const isSource = (offset: number) => isSourceRegion(offset) && !isComment(offset)
    const isAccepted = makeSpanLookup(ranges.map(range => [range.start, range.end]))
    const invalidBlocks: Array<[number, number]> = []
    for (const conflict of input.tableIdWarnings ?? []) {
        issues.push({ code: 'unmatched-id', line: conflict.line, message: tableIdAdvice, id: conflict.id })
        skippedIds.add(conflict.id)
    }
    const edits = new Map<number, T[]>()
    const linkedRanges = new Map<number, CardRange>()
    for (const range of input.linkedRanges ?? []) {
        if (range.identifier !== undefined) linkedRanges.set(range.identifier, range)
    }
    const additionsByEnd = ranges.filter(range => range.identifier === undefined).sort((a, b) => a.end - b.end)
    for (const range of ranges) {
        if (range.identifier === undefined) continue
        const list = edits.get(range.identifier) ?? []
        list.push(range)
        edits.set(range.identifier, list)
    }

    const flagBlock = (row: SourceLine, offset: number, finish: number, type: string | undefined, form: string) => {
        const code = !type ? 'missing-note-type' : !noteTypes.has(type) ? 'unknown-note-type' : 'unrecognized-block'
        const message = !type ? `${form} card needs a note type.` :
            !noteTypes.has(type) ? `Unknown Anki note type “${type}”. Check Note Type Settings.` :
                `${form} card could not be parsed. Check its fields and closing marker.`
        issues.push({ code, line: row.line, message })
        if (finish > offset) invalidBlocks.push([offset, finish])
    }

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index]
        const trimmed = row.text.trim()
        const offset = row.offset + row.text.length - row.text.trimStart().length
        if (!trimmed || !isSource(offset) || /^(?:<!--|%%)/.test(trimmed)) continue
        if (start && trimmed === start && !isAccepted(offset)) {
            let after = index + 1
            let type: string | undefined
            while (after < rows.length) {
                const next = rows[after].text.trim()
                if (next === start || end && next === end) break
                if (type === undefined && next) type = next
                after++
            }
            if (rows[after]?.text.trim() === end) after++
            const finish = rows[after]?.offset ?? text.length
            flagBlock(row, offset, finish, type, start)
            index = Math.max(index, after - 1)
            continue
        }
        let from = 0
        if (startsToken(trimmed, inlineStart) && !isAccepted(offset)) {
            const bodyStart = offset - row.offset + inlineStart.length
            const next = row.text.indexOf(inlineStart, bodyStart)
            const close = inlineEnd ? row.text.indexOf(inlineEnd, bodyStart) : -1
            from = close >= 0 && (next < 0 || close < next) ? close + inlineEnd.length :
                next >= 0 ? next : row.text.length
            const body = row.text.slice(bodyStart, from)
            if (!body.trim() || looksLikeInlineFields(body)) {
                flagBlock(row, offset, row.offset + from, declaredInlineType(body), inlineStart)
            }
        }
        if (!inlineStart || !inlineEnd || !row.text.includes(inlineStart)) continue
        while (from < row.text.length) {
            const at = row.text.indexOf(inlineStart, from)
            if (at < 0) break
            from = at + inlineStart.length
            if (at > 0 && !/\s/.test(row.text[at - 1])) continue
            if (!startsToken(row.text.slice(at), inlineStart) || !isSource(row.offset + at) || isAccepted(row.offset + at)) continue
            const close = row.text.indexOf(inlineEnd, from)
            if (close < 0) break
            const body = row.text.slice(from, close)
            if (!body.trim() || looksLikeInlineFields(body)) {
                flagBlock(row, row.offset + at, row.offset + close + inlineEnd.length, declaredInlineType(body), inlineStart)
            }
            from = close + inlineEnd.length
        }
    }

    const isInvalidBlock = makeSpanLookup(invalidBlocks)
    const reportedLinkedIds = new Set<string>()
    const markers = findIdMarkers(text, input.syntax)
    const markedLines = new Set(markers.map(marker => marker.line))
    const damagedMarkers = new Map<IdMarker, boolean>()
    const commentEnds = new Map(comments)
    const lineAt = (offset: number) => {
        let low = 0
        let high = rows.length
        while (low < high) {
            const mid = low + Math.floor((high - low) / 2)
            if (rows[mid].offset <= offset) low = mid + 1
            else high = mid
        }
        return Math.max(1, low)
    }
    const missingIssue = (id: number, line: number, markerColumn: number | undefined, range?: CardRange): ExportCardIssue => {
        let source: ExportCardLocation | undefined
        if (range) {
            const first = lineAt(range.start)
            const row = rows[line - 1]
            const marker = markerColumn === undefined ? undefined :
                /^ID:[ \t]*\d+(?!\d|[.,]\d|[eE][+-]?\d)[^\r\n]*/.exec(row.text.slice(markerColumn))
            let endOffset = Math.max(range.end, marker === undefined || markerColumn === undefined ? row.end :
                row.offset + markerColumn + (marker?.[0].length ?? 0))
            while (endOffset > range.start && /[\r\n]/.test(text[endOffset - 1])) endOffset--
            const last = lineAt(endOffset)
            source = { line: first, endLine: last, startColumn: range.start - rows[first - 1].offset,
                endColumn: endOffset - rows[last - 1].offset, markerColumn }
        }
        return { code: 'missing-id', line, id, deck: input.deck, source,
            message: `Anki note ${id} was not found in the active profile. Its original ID was kept in Markdown.` }
    }
    for (const row of rows) {
        if (markedLines.has(row.line)) continue
        const damaged = damagedIdStart.exec(row.text)
        const id = Number(damaged?.[3])
        if (!damaged || !Number.isSafeInteger(id) || id <= 0) continue
        const [prefix, comment, identifier] = damaged
        const column = prefix.length - identifier.length
        const marker = { id, line: row.line, column }
        const close = comment ? commentEnds.get(row.offset + column - comment.length) : undefined
        const standaloneComment = close !== undefined && close <= row.end &&
            text.slice(close - 3, close) === '-->' && !text.slice(close, row.end).trim()
        damagedMarkers.set(marker, standaloneComment)
        markers.push(marker)
    }
    if (inlineStart && inlineEnd && text.includes(inlineStart)) {
        const markedOffsets = new Set(markers.map(marker => rows[marker.line - 1].offset + marker.column))
        for (const range of additionsByEnd) {
            if (!text.endsWith(inlineEnd, range.end) ||
                !startsToken(text.slice(range.start, range.start + inlineStart.length + 1), inlineStart)) continue
            const row = rows[lineAt(range.end) - 1]
            const trailing = inlineIdTail.exec(text.slice(range.end, row.end))
            const id = Number(trailing?.[3])
            if (!trailing || !Number.isSafeInteger(id) || id <= 0) continue
            const [tail, opening, identifier, , closing] = trailing
            if (Boolean(opening) !== Boolean(closing)) continue
            const offset = range.end + tail.indexOf(identifier)
            if (markedOffsets.has(offset)) continue
            const marker = { id, line: row.line, column: offset - row.offset }
            const standaloneComment = Boolean(opening && commentEnds.get(offset - opening.length) ===
                range.end + tail.trimEnd().length)
            damagedMarkers.set(marker, standaloneComment)
            markers.push(marker)
            markedOffsets.add(offset)
        }
    }
    for (const marker of markers) {
        const row = rows[marker.line - 1]
        if (!row) continue
        const offset = row.offset + marker.column
        if (marker.location !== 'yaml' && (!isSourceRegion(offset) || isComment(offset) && !damagedMarkers.get(marker) ||
            startsToken(row.text.trimStart(), deleteMarker) ||
            (deleteMarker && rows[marker.line - 2]?.text.trim() === deleteMarker))) continue
        const accepted = edits.get(marker.id)?.find(range => range.start <= offset && offset < range.end)
        const conflict = duplicateIds.get(marker.id)
        const markerStart = offset - (/(?:<!--[ \t]*)$/.exec(row.text.slice(0, marker.column))?.[0].length ?? 0)
        let predecessor: T | undefined
        if (!accepted) {
            let low = 0
            let high = additionsByEnd.length
            while (low < high) {
                const mid = low + Math.floor((high - low) / 2)
                if (additionsByEnd[mid].end <= markerStart) low = mid + 1
                else high = mid
            }
            const before = additionsByEnd[low - 1]
            if (before && markerStart - before.end <= 512 &&
                /^(?:[ \t]*(?:\r\n?|\n)){0,2}[ \t]*$/.test(text.slice(before.end, markerStart))) predecessor = before
        }
        if (!conflict && !accepted && !existingIds.has(marker.id) && !predecessor &&
            !isAccepted(offset) && !isInvalidBlock(offset) && !rows[marker.line - 2]?.text.includes(' :: ')) continue
        if (conflict) {
            issues.push({ code: 'duplicate-id', line: marker.line, message: conflict, id: marker.id })
            skippedIds.add(marker.id)
        } else if (damagedMarkers.has(marker) && !accepted) {
            issues.push({ code: 'unmatched-id', line: marker.line,
                message: `Damaged Anki ID marker near this card. Verify its original note in Anki, then repair the Markdown marker to ID: ${marker.id}.`,
                id: marker.id })
            skippedIds.add(marker.id)
        } else if (!existingIds.has(marker.id)) {
            const linked = linkedRanges.get(marker.id)
            const linkedRange = linked && linked.start <= offset && offset < linked.end ? linked : undefined
            issues.push(missingIssue(marker.id, marker.line, marker.column, accepted ?? linkedRange ?? predecessor))
            skippedIds.add(marker.id)
        } else if (!accepted) {
            issues.push({ code: 'unmatched-id', line: marker.line,
                message: `No card matched the Markdown near Anki ID ${marker.id}. Check the card format or Custom Regexp with Sync Audit.`,
                id: marker.id })
            skippedIds.add(marker.id)
        } else continue
        if (accepted) {
            reportedLinkedIds.add(`${marker.id}:${marker.line}`)
            continue
        }
        if (predecessor) skippedNew.add(predecessor)
        invalidBlocks.push([markerStart, offset + 1])
    }
    for (const [id, linked] of edits) {
        const conflict = duplicateIds.get(id)
        if (!conflict && existingIds.has(id)) continue
        const marker = `ID: ${id}`
        for (const range of linked) {
            const local = text.slice(range.start, range.end).lastIndexOf(marker)
            const line = lineAt(range.start + Math.max(0, local))
            if (reportedLinkedIds.has(`${id}:${line}`)) continue
            if (conflict) issues.push({ code: 'duplicate-id', line, message: conflict, id })
            else issues.push(missingIssue(id, line, local >= 0 ? range.start + local - rows[line - 1].offset : undefined, range))
        }
        skippedIds.add(id)
    }
    const overlapsInvalid = makeSpanOverlap(invalidBlocks)
    for (const range of ranges) if (overlapsInvalid(range.start, range.end)) {
        if (range.identifier === undefined) skippedNew.add(range)
        else skippedIds.add(range.identifier)
    }
    issues.sort((a, b) => a.line - b.line)
    return { issues, skippedNew, skippedIds }
}
