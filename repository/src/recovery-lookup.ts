/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { AnkiProfileError } from './anki-profile'
import { isRecoveryTag } from './export-recovery'
import { auditRead } from './sync-audit'

export interface RecoveryLookupRequest {
    tag: string
    modelName?: string
    fields?: Readonly<Record<string, string>>
}

export interface RecoveryLookupResult {
    state: 'found' | 'missing' | 'ambiguous' | 'mismatch' | 'unverified'
    candidates: readonly number[]
    noteId?: number
    detail?: string
}

export type RecoveryLookupRead = (action: 'findNotes' | 'notesInfo' | 'multi',
    params: Record<string, unknown>) => Promise<unknown>

interface TaggedNote {
    modelName: unknown
    fields: unknown
    tags: readonly string[]
}

const tagsPerRequest = 32
const detailsPerRequest = 100
const maximumMatches = 100
const maximumDisplayedIds = 20

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNoteId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 160)
}

function unverified(detail: string, ids: readonly number[] = []): RecoveryLookupResult {
    return { state: 'unverified', candidates: ids.slice(0, maximumDisplayedIds), detail }
}

function searchIds(result: unknown): number[] | RecoveryLookupResult {
    if (!Array.isArray(result)) {
        return unverified('Anki returned an invalid or repeated note ID in the recovery search.')
    }
    if (result.length > maximumMatches) {
        const sample = result.slice(0, maximumDisplayedIds).filter(isNoteId)
        return unverified('Anki returned too many matches for this recovery tag.', sample)
    }
    const ids = Array.from(result as unknown[])
    if (!ids.every(isNoteId) || new Set(ids).size !== ids.length) {
        return unverified('Anki returned an invalid or repeated note ID in the recovery search.')
    }
    return ids
}

async function findTags(requests: readonly RecoveryLookupRequest[], read: RecoveryLookupRead):
    Promise<Array<number[] | RecoveryLookupResult>> {
    const parameters = (tag: string) => ({ query: `tag:${tag.toLowerCase()}` })
    try {
        if (requests.length === 1) {
            return [searchIds(await read('findNotes', parameters(requests[0].tag)))]
        }
        const reply = await read('multi', {
            actions: requests.map(({ tag }) => ({ action: 'findNotes', version: 6, params: parameters(tag) })),
        })
        if (!Array.isArray(reply) || reply.length !== requests.length) {
            return requests.map(() => unverified('Anki returned an incomplete recovery search response.'))
        }
        return reply.map((row: unknown) => isRecord(row) && row.error === null
            ? searchIds(row.result)
            : unverified(`Anki could not search for the recovery tag. ${isRecord(row) && typeof row.error === 'string' ? message(row.error) : ''}`.trim()))
    } catch (error) {
        return requests.map(() => unverified(`Anki could not search for the recovery tag. ${message(error)}`))
    }
}

async function confirmNotes(ids: readonly number[], expectedProfile: string | undefined,
    check: () => Promise<void>, read: RecoveryLookupRead): Promise<ReadonlyMap<number, TaggedNote>> {
    const notes = new Map<number, TaggedNote>()
    for (let offset = 0; offset < ids.length; offset += detailsPerRequest) {
        await check()
        const batch = ids.slice(offset, offset + detailsPerRequest)
        let reply: unknown
        try {
            reply = await read('notesInfo', { notes: batch })
        } catch {
            continue
        }
        if (!Array.isArray(reply)) continue
        const requested = new Set(batch)
        const received = new Set<number>()
        const validated = new Map<number, TaggedNote>()
        let unexpected = false
        for (const row of reply as unknown[]) {
            if (!isRecord(row) || !isNoteId(row.noteId) || !requested.has(row.noteId)) {
                unexpected = true
                break
            }
            const { noteId, tags, profile } = row
            if (typeof profile === 'string' && expectedProfile !== undefined && profile !== expectedProfile) {
                throw new AnkiProfileError('mismatch', expectedProfile, profile)
            }
            if (received.has(noteId)) {
                validated.delete(noteId)
                continue
            }
            received.add(noteId)
            if (Array.isArray(tags) && tags.every((tag: unknown): tag is string => typeof tag === 'string')) {
                validated.set(noteId, { modelName: row.modelName, fields: row.fields, tags })
            }
        }
        if (!unexpected) for (const [id, note] of validated) notes.set(id, note)
    }
    return notes
}

function classify(request: RecoveryLookupRequest, ids: readonly number[],
    notes: ReadonlyMap<number, TaggedNote>): RecoveryLookupResult {
    const tag = request.tag.toLowerCase()
    const exact: number[] = []
    let incomplete = false
    for (const id of ids) {
        const match = notes.get(id)
        const tags = match?.tags.map(tag => tag.toLowerCase())
        if (tags?.includes(tag)) exact.push(id)
        // Anki может находить вложенные теги. Кандидатами считаем только записи с точным тегом.
        else if (!tags?.some(candidate => candidate.startsWith(tag + '::'))) incomplete = true
    }
    const candidates = exact.slice(0, maximumDisplayedIds)
    if (exact.length > 1) {
        return { state: 'ambiguous', candidates, detail: `${exact.length} Anki notes have the same recovery tag.` }
    }
    if (incomplete) return unverified('Anki did not verify every note returned for this recovery tag.', candidates)
    if (!exact.length) return { state: 'missing', candidates: [] }

    const noteId = exact[0]
    const note = notes.get(noteId)!
    if (new Set(note.tags.map(tag => tag.toLowerCase()).filter(isRecoveryTag)).size > 1) {
        return { state: 'ambiguous', candidates, detail: 'The same Anki note has multiple recovery tags.' }
    }
    if (request.modelName !== undefined) {
        if (typeof note.modelName !== 'string') return unverified('Anki did not return the note type.', candidates)
        if (note.modelName !== request.modelName) {
            return { state: 'mismatch', candidates, detail: 'The Anki note type differs from the creation plan.' }
        }
    }
    if (request.fields !== undefined) {
        if (!isRecord(note.fields)) return unverified('Anki did not return the note fields.', candidates)
        for (const [field, expected] of Object.entries(request.fields)) {
            const current = Object.prototype.hasOwnProperty.call(note.fields, field) ? note.fields[field] : undefined
            if (!isRecord(current) || typeof current.value !== 'string') {
                return unverified('Anki did not return all fields from the creation plan.', candidates)
            }
            if (current.value.normalize('NFC') !== expected.normalize('NFC')) {
                return { state: 'mismatch', candidates, detail: 'The Anki note fields differ from the creation plan.' }
            }
        }
    }
    return { state: 'found', noteId, candidates }
}

/** Работает в режиме чтения. Вызывающий код проверяет принадлежность исходника и сохраняет подтверждённые ID. */
export async function lookupRecoveryNotes(requests: readonly RecoveryLookupRequest[],
    checkProfile: () => Promise<unknown>, read: RecoveryLookupRead = (action, params) => auditRead(action, params, undefined, 15_000)):
    Promise<ReadonlyMap<string, RecoveryLookupResult>> {
    const results = new Map<string, RecoveryLookupResult>()
    const counts = new Map<string, number>()
    for (const { tag } of requests) {
        const canonical = tag.toLowerCase()
        counts.set(canonical, (counts.get(canonical) ?? 0) + 1)
    }
    const valid = requests.filter(({ tag }) => {
        if (!isRecoveryTag(tag)) results.set(tag, unverified('Invalid Anki recovery tag in the creation plan.'))
        else if (counts.get(tag.toLowerCase()) !== 1) results.set(tag, unverified('The same recovery tag is used for multiple creation slots.'))
        else return true
        return false
    })
    if (!valid.length) return results

    const active = await checkProfile()
    const profile = typeof active === 'string' ? active : undefined
    const check = async () => {
        const current = await checkProfile()
        if (profile !== undefined && typeof current === 'string' && current !== profile) {
            throw new AnkiProfileError('mismatch', profile, current)
        }
    }
    for (let offset = 0; offset < valid.length; offset += tagsPerRequest) {
        const batch = valid.slice(offset, offset + tagsPerRequest)
        const matches = await findTags(batch, read)
        const ids = [...new Set(matches.flatMap(match => Array.isArray(match) ? match : []))]
        const notes = await confirmNotes(ids, profile, check, read)
        await check()
        batch.forEach((request, index) => {
            const match = matches[index]
            results.set(request.tag, Array.isArray(match) ? classify(request, match, notes) : match)
        })
    }
    return results
}
