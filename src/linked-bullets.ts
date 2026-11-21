/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { activeCardMarkdown } from './archived-card'
import { maskIdMarkerHtmlLiterals } from './id-marker-literals'
import { readSuspendLine } from './suspend-label'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { markedPageAnswerBoundary, parseAnkiIdMarker } from './anki-id-marker'
import * as AnkiConnect from './anki'
import { withAnkiDeadline } from './anki-transport'
import { parseExistingNoteSnapshot } from './anki-delta'
import type { NoteSnapshot } from './anki-delta'
import { parseExplicitLinkedField } from './bidirectional-fields'

export interface LinkedBullet {
    id: number
    markerLine?: number
    /** The current Anki note type uses the reversible RemNote rule for this line. */
    remNoteAnswerSlot?: boolean
    front: string
    back: string
    metadata: Partial<Record<MetadataField, string>>
    extra?: Record<string, string>
    start: number
    end: number
}

export interface LinkedBulletModel {
    name: string
    fieldNames: ReadonlySet<string>
}

type MetadataField = 'Add Reverse' | 'FrontLang' | 'BackLang'

const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/
const locale = /^([FB])=([a-z]{2,3}\\?_[A-Z]{2})\.?$/

function parseMetadata(parts: readonly string[]): Pick<LinkedBullet, 'metadata' | 'extra'> | undefined {
    const metadata: LinkedBullet['metadata'] = {}
    let extra: Record<string, string> | undefined
    for (const part of parts) {
        if (part.startsWith('X[')) {
            const field = parseExplicitLinkedField(part)
            if (!field) return undefined
            extra ??= Object.create(null) as Record<string, string>
            if (Object.prototype.hasOwnProperty.call(extra, field.field)) return undefined
            extra[field.field] = field.value
            continue
        }
        if (part === 'R') {
            if (metadata['Add Reverse'] !== undefined) return undefined
            metadata['Add Reverse'] = part
            continue
        }
        const match = locale.exec(part)
        if (!match) return undefined
        const field = match[1] === 'F' ? 'FrontLang' : 'BackLang'
        if (metadata[field] !== undefined) return undefined
        metadata[field] = match[2].replace('\\_', '_')
    }
    return extra ? { metadata, extra } : { metadata }
}

function lineContentEnd(text: string, lineBreak: number): number {
    if (lineBreak < 0) return text.length
    return text[lineBreak - 1] === '\r' ? lineBreak - 1 : lineBreak
}

/** Ищет карточки проекта, ID которых стоит на следующей строке Markdown. */
export function findLinkedBullets(content: string, trackLines = false, syntax?: DuplicateMarkerSyntax): LinkedBullet[] {
    if (content.includes('RUDONIUM-ARCHIVE')) content = activeCardMarkdown(content)
    const result: LinkedBullet[] = []
    if (!content.includes('ID:') || !content.includes('::')) return result
    content = content.slice(0, markedPageAnswerBoundary(content))

    // Обычные ID-комментарии не требуют отдельной маски; примеры карточек не должны стать записями Anki.
    const visible = /%%|\$|\x60|<(?!!--[ \t]*ID:)|\\\[/u.test(content) ? maskIdMarkerHtmlLiterals(content, true) : content
    // Храним смещения в исходном тексте, в том числе для строк Windows.
    const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(content)
    const closing = opening && /^---[ \t]*(?:\r?\n|$)/m.exec(content.slice(opening[0].length))
    if (opening && !closing) return result
    let offset = opening && closing ? opening[0].length + closing.index + closing[0].length : 0
    let row = trackLines ? (content.slice(0, offset).match(/\n/g)?.length ?? 0) : 0
    let level = 0
    let openFence = ''
    let comment = false
    while (offset < content.length) {
        if (trackLines) row++
        const start = offset
        const lineBreak = content.indexOf('\n', start)
        const endOfLine = lineContentEnd(content, lineBreak)
        const line = visible.slice(start, endOfLine)
        offset = lineBreak < 0 ? content.length : lineBreak + 1
        const fenceMatch = fence.exec(line)
        if (openFence) {
            if (fenceMatch && fenceMatch[1][0] === openFence[0] &&
                fenceMatch[1].length >= openFence.length && !fenceMatch[2].trim()) openFence = ''
            continue
        }
        if (fenceMatch) {
            openFence = fenceMatch[1]
            continue
        }
        if (comment) {
            if (line.includes('-->')) comment = false
            continue
        }
        const commentStart = line.indexOf('<!--')
        if (commentStart !== -1 && !line.slice(commentStart + 4).includes('-->')) {
            comment = true
            continue
        }
        const section = heading.exec(line)
        if (section) {
            const depth = section[1].length
            if (/^(?:карточки|cards)$/iu.test(section[2])) level = depth
            else if (depth <= level) level = 0
            continue
        }
        // В старых словарях название раздела могло быть выделено жирным вместо ATX-заголовка.
        const bold = /^ {0,3}(\*\*|__)([^*_]+)\1[ \t]*$/u.exec(line)
        if (bold) {
            if (/^(?:карточки|cards)$/iu.test(bold[2])) level = 7
            else if (level === 7) level = 0
            continue
        }
        if (offset >= content.length || !line.includes('::')) continue
        const item = /^ {0,3}[-+*][ \t]+(.+)$/.exec(content.slice(start, endOfLine))
        if (!item || /(?:^|[ \t])Tags: /.test(item[1])) continue
        // Сначала проверяем соседнюю строку. Поля черновика без ID разбирать не нужно.
        const nextBreak = content.indexOf('\n', offset)
        let end = lineContentEnd(content, nextBreak)
        const nextLine = visible.slice(offset, end)
        let marker = parseAnkiIdMarker(nextLine)
        let markerDistance = 1
        if (!marker && nextBreak >= 0) {
            const followingEnd = lineContentEnd(content, content.indexOf('\n', nextBreak + 1))
            const followingId = parseAnkiIdMarker(visible.slice(nextBreak + 1, followingEnd))
            if (followingId && readSuspendLine(nextLine, syntax)) {
                marker = followingId
                markerDistance = 2
                end = followingEnd
            }
        }
        if (!marker) continue
        const id = marker.id
        if (!Number.isSafeInteger(id) || id <= 0) continue
        const [front, back, ...parts] = item[1].split(/[ \t]+::[ \t]+/).map(value => value.trim())
        // A cleared second slot belongs to the configured regex reader. Never take its next separator as the answer.
        if (!front || !back || /^::(?:[ \t]|$)/u.test(back)) continue
        const parsed = parseMetadata(parts)
        if (!parsed) continue
        // За пределами раздела карточек нужны явный признак формата и датированный ID.
        if (!level && (!parts.length || !marker.metadata && !marker.warning)) continue
        const bullet: LinkedBullet = { id, front, back, ...parsed, start, end }
        if (trackLines) bullet.markerLine = row + markerDistance
        result.push(bullet)
    }
    return result
}

/** Возвращает поля, явно заданные карточкой, с учётом фактического типа записи. */
export function linkedBulletSourceFields(bullet: LinkedBullet, model: LinkedBulletModel): Record<string, string> {
    const fields: Record<string, string> = { Front: bullet.front, Back: bullet.back }
    for (const [name, value] of Object.entries(bullet.metadata)) {
        if (model.fieldNames.has(name)) {
            fields[name] = value
        } else if (name === 'Add Reverse') {
            throw new Error(`Anki ID ${bullet.id} uses R, but note type ${model.name} has no Add Reverse field.`)
        }
    }
    return fields
}

/** По ID читаем фактический тип и список полей записи Anki. */
export async function readLinkedBulletModels(ids: ReadonlySet<number>,
    snapshots?: Map<number, NoteSnapshot>,
    readNotes: (notes: number[]) => Promise<unknown> = notes =>
        withAnkiDeadline(() => AnkiConnect.invoke('notesInfo', { notes }), 'Anki linked note types'),
): Promise<Map<number, LinkedBulletModel>> {
    const models = new Map<number, LinkedBulletModel>()
    const requested = Array.from(ids)
    for (let offset = 0; offset < requested.length; offset += 500) {
        const batch = requested.slice(offset, offset + 500)
        const requestedIds = new Set(batch)
        const seen = new Set<number>()
        const notes = await readNotes(batch)
        if (!Array.isArray(notes)) throw new Error('notesInfo: expected an array of linked notes')
        const rows: readonly unknown[] = notes
        for (const note of rows) {
            if (typeof note !== 'object' || note === null || !('noteId' in note) ||
                typeof note.noteId !== 'number' || !requestedIds.has(note.noteId)) continue
            if (seen.has(note.noteId)) {
                models.delete(note.noteId)
                snapshots?.delete(note.noteId)
                continue
            }
            seen.add(note.noteId)
            if (!('modelName' in note) || typeof note.modelName !== 'string' || !note.modelName ||
                !('fields' in note) || !note.fields || typeof note.fields !== 'object' || Array.isArray(note.fields)) continue
            const fieldNames = new Set(Object.keys(note.fields))
            if (fieldNames.has('Front') && fieldNames.has('Back')) {
                models.set(note.noteId, { name: note.modelName, fieldNames })
                const snapshot = snapshots && parseExistingNoteSnapshot(note)
                if (snapshot) snapshots.set(note.noteId, snapshot)
            }
        }
    }
    return models
}
