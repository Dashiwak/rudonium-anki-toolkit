/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import * as AnkiConnect from './anki'
import { ankiBrowseMessage } from './interface-language'
import { sameFieldValue } from './anki-field-value'
import { cardFieldHazards, compareStudyCardIds, readCardIds, readCardStudyDetails, sameCardIds } from './anki-card-impact'
import type { ReviewedCardImpact, VerifiedCardImpact } from './anki-card-impact'
import { AnkiProfileError, checkPinnedAnkiProfile } from './anki-profile'
import { withAnkiDeadline } from './anki-transport'
import { ankiStudyDeckKey, findAnkiDeckCardIds, findFilteredAnkiCards, isProtectedAnkiTag, readAnkiDeckIds, readFilteredAnkiDecks } from './anki-study-state'
import type { DeckRouteOrigin } from './deck-routes'
import { oneWayFieldDigest, oneWayTagKey } from './oneway-history'
import type { OneWayHistory, OneWayNamedLayout, OneWayReceipt, OneWayRecord } from './oneway-history'
import { exportOperationKey } from './export-plan'
import type { ExportPreviewOperation } from './export-plan'

const readAnki: typeof AnkiConnect.invoke = (action, params) =>
    withAnkiDeadline(() => AnkiConnect.invoke(action, params), `AnkiConnect ${action}`)

export interface ExistingNoteSource {
    id: number
    path: string
    fields: Record<string, string>
    tags: string[]
    deck: string
    modelName: string
    deckRule?: DeckRouteOrigin
    authoredFields?: readonly string[]
    namedLayout?: OneWayNamedLayout
    repairedPair?: readonly string[]
    sharedPageFields?: readonly string[]
}

export interface OneWayFieldConflict {
    id: number
    name: string
    source: string
    actual: string
    kind: 'untracked' | 'both'
    cardImpact?: ReviewedCardImpact
}

export interface ExportFieldPreview {
    id: number
    fields: readonly string[]
}

export interface ExistingNotePolicy {
    history?: Pick<OneWayHistory, 'get'>
    allowDeckMoves?: boolean
    capture?(receipt: OneWayReceipt): void
    onFieldConflict?(conflict: OneWayFieldConflict): void
    onKeptAnkiFields?(path: string, note: ExportFieldPreview): void
    authorizeField?(conflict: OneWayFieldConflict): boolean
    reviewOperation?(path: string, operation: ExportPreviewOperation): boolean
    reviewEvidence?(request: AnkiConnect.AnkiConnectRequest, evidence: ReviewedAnkiEvidence): void
    rememberMoveOwner?(request: AnkiConnect.AnkiConnectRequest, id: number): void
    rememberReviewedCards?(request: AnkiConnect.AnkiConnectRequest, cardIds: readonly number[]): void
    includeCardStudyDetails?: boolean
}

export interface ReviewedAnkiEvidence {
    id: number
    modelName: string
    fields?: readonly [string, string][]
    presentTags?: readonly string[]
    absentTags?: readonly string[]
    snapshot?: string
    cardIds?: readonly number[]
}

export interface ExportDeckMove {
    from: string
    to: string
    count: number
    cardIds: number[]
    reason?: DeckRouteOrigin
}

export interface NoteSnapshot {
    /** Optional notesInfo modification time in Unix seconds. */
    mod?: number
    modelName: string
    fields: Record<string, unknown>
    tags: string[]
    cards: number[]
}

const readBatchSize = 500

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyFields(): Record<string, string> {
    const fields: Record<string, string> = {}
    Object.setPrototypeOf(fields, null)
    return fields
}

function isId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function readField(fields: Record<string, unknown>, name: string): string | undefined {
    const field = Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : undefined
    return isRecord(field) && typeof field.value === 'string' ? field.value : undefined
}

export function parseExistingNoteSnapshot(row: unknown): NoteSnapshot | undefined {
    if (!isRecord(row) || typeof row.modelName !== 'string' || !row.modelName || !isRecord(row.fields) ||
        !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string') ||
        !Array.isArray(row.cards) || !row.cards.every(isId) || new Set(row.cards).size !== row.cards.length) return
    return { modelName: row.modelName, fields: row.fields, tags: row.tags, cards: row.cards,
        ...(isId(row.mod) ? { mod: row.mod } : {}) }
}

export function snapshotFields(note: NoteSnapshot): [string, string][] {
    return Object.keys(note.fields).sort().flatMap<[string, string]>(name => {
        const value = readField(note.fields, name)
        return value === undefined ? [] : [[name, value]]
    })
}

export function snapshotKey(note: NoteSnapshot): string {
    return exportOperationKey('delete', [note.modelName, snapshotFields(note), [...note.tags].sort(),
        [...note.cards].sort((left, right) => left - right)])
}

export function isMissingAnkiNoteError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : error
    return typeof message === 'string' &&
        /\b(?:notes?(?: ids?)?(?: \d+)? (?:(?:was|were) )?(?:not found|does not exist)|unknown note id|no such note)\b/i.test(message)
}

// Some connectors reject an entire notesInfo batch if even one note disappeared during the export.
async function readAvailableNoteRows(notes: number[]): Promise<unknown> {
    try {
        return await readAnki('notesInfo', { notes })
    } catch (error) {
        if (!isMissingAnkiNoteError(error)) throw error
        const found: unknown = await readAnki('findNotes', { query: `nid:${notes.join(',')}` })
        const requested = new Set(notes)
        if (!Array.isArray(found) || found.length >= notes.length) throw error
        const surviving = found.filter(isId)
        if (surviving.length !== found.length || surviving.some(id => !requested.delete(id))) throw error
        return surviving.length ? readAnki('notesInfo', { notes: surviving }) : []
    }
}

export async function readReviewedNoteSnapshots(ids: readonly number[]): Promise<Map<number, NoteSnapshot>> {
    const result = new Map<number, NoteSnapshot>()
    const requestedIds = [...new Set(ids)]
    for (let offset = 0; offset < requestedIds.length; offset += readBatchSize) {
        const batch = requestedIds.slice(offset, offset + readBatchSize)
        const requested = new Set(batch)
        const seen = new Set<number>()
        const rows: unknown = await readAvailableNoteRows(batch)
        if (!Array.isArray(rows)) throw new Error('notesInfo did not return reviewed notes')
        for (const row of rows) {
            if (!isRecord(row) || !isId(row.noteId) || !requested.has(row.noteId)) continue
            const id = row.noteId
            if (seen.has(id)) {
                result.delete(id)
                continue
            }
            seen.add(id)
            const note = parseExistingNoteSnapshot(row)
            if (note && snapshotFields(note).length === Object.keys(note.fields).length) result.set(id, note)
        }
    }
    return result
}

export function matchesReviewedAnkiEvidence(note: NoteSnapshot | undefined, evidence: ReviewedAnkiEvidence): boolean {
    if (!note || note.modelName !== evidence.modelName) return false
    if (evidence.snapshot !== undefined) return snapshotKey(note) === evidence.snapshot
    if (evidence.cardIds !== undefined && !sameCardIds(note.cards, evidence.cardIds)) return false
    if (evidence.fields?.some(([name, value]) => readField(note.fields, name) !== value)) return false
    if (!evidence.presentTags?.length && !evidence.absentTags?.length) return true
    const tags = indexTags(note.tags)
    return !evidence.presentTags?.some(tag => !tags.has(oneWayTagKey(tag))) &&
        !evidence.absentTags?.some(tag => tags.has(oneWayTagKey(tag)))
}

export { sameFieldValue } from './anki-field-value'

function indexTags(tags: readonly string[]): Map<string, string> {
    const indexed = new Map<string, string>()
    for (const tag of tags) {
        const key = oneWayTagKey(tag)
        if (key && !isProtectedAnkiTag(key) && !indexed.has(key)) indexed.set(key, tag.trim())
    }
    return indexed
}

export function isExistingDeckManaged(source: Pick<ExistingNoteSource, 'deckRule'>): boolean {
    return source.deckRule !== undefined && source.deckRule.origin !== 'default'
}

export function managedFieldEntries(source: ExistingNoteSource): [string, string][] {
    const authored = source.authoredFields ? new Set(source.authoredFields) : undefined
    return Object.entries(source.fields).filter(([name, value]) => authored ? authored.has(name) : value !== '')
}

function isNonemptyPlainText(value: string): boolean {
    if (/[<>]|\[sound:|\{\{c\d+::/iu.test(value)) return false
    // Anki stores MathJax and legacy LaTeX as text even though the card displays a formula.
    if (/\\(?:\(|\[)|\[(?:latex|\$\$?)\]/iu.test(value)) return false
    return value.replace(/&(?:nbsp|#0*160|#x0*a0);/giu, ' ').trim() !== ''
}

async function planProtectedFields(source: ExistingNoteSource, actual: NoteSnapshot, prior: OneWayRecord | undefined,
    policy: ExistingNotePolicy, report: (path: string, message: string) => void): Promise<{
        fields: Record<string, string>; cardIds?: readonly number[]
    }> {
    const changed: Record<string, string> = emptyFields()
    const matched: Record<string, string> = emptyFields()
    const kept: string[] | undefined = policy.onKeptAnkiFields ? [] : undefined
    let cards: ReviewedCardImpact['cards'] | undefined
    let cardIds: readonly number[] | undefined
    const readImpact = async (hazards: ReviewedCardImpact['hazards']): Promise<ReviewedCardImpact> => {
        const ids = [...actual.cards].sort((left, right) => left - right)
        if (policy.includeCardStudyDetails && cards === undefined) {
            cards = await readCardStudyDetails(source.id, ids, batch => readAnki('cardsInfo', { cards: batch }))
                .catch(() => ids.map(id => ({ id })))
        }
        return { hazards, cardIds: ids, cards: cards ?? [] }
    }
    const needsStudyReview = (name: string) => report(source.path,
        `Anki note ${source.id}, field “${name}” may change its study cards. Open Preview Export and confirm this field separately.`)
    const entries = managedFieldEntries(source)
    const removed = prior?.namedFields?.filter(name => source.namedLayout?.eligible.includes(name) &&
        !source.namedLayout.present.includes(name)) ?? []
    for (const name of removed) {
        // If a generator has meanwhile supplied a value, keep using its normal export path.
        if (!entries.some(([current]) => current === name)) entries.push([name, ''])
    }
    for (const [name, wanted] of entries) {
        const remote = readField(actual.fields, name)
        if (remote === undefined) continue
        if (sameFieldValue(remote, wanted)) {
            matched[name] = wanted
            continue
        }
        const base = prior && Object.prototype.hasOwnProperty.call(prior.fields, name) ? prior.fields[name] : undefined
        const fixed = source.sharedPageFields?.includes(name) === true
        const unchangedSource = base !== undefined && base === oneWayFieldDigest(wanted)
        const repairedText = source.repairedPair?.includes(name) && isNonemptyPlainText(wanted) &&
            isNonemptyPlainText(remote) && !cardFieldHazards(name, remote, wanted).length
        if (unchangedSource && !fixed && !repairedText && !removed.includes(name)) {
            kept?.push(name)
            continue
        }
        const hazards = cardFieldHazards(name, remote, wanted)
        // A newly edited, previously confirmed text field belongs to this export.
        // A concurrent deletion or a change affecting study cards still needs a choice.
        const editedText = base !== undefined && !unchangedSource && hazards.length === 0 &&
            isNonemptyPlainText(remote) && isNonemptyPlainText(wanted)
        if (fixed || editedText || repairedText || base !== undefined && base === oneWayFieldDigest(remote)) {
            const cardImpact = hazards.length ? await readImpact(hazards) : undefined
            if (cardImpact && !policy.reviewOperation) {
                needsStudyReview(name)
                continue
            }
            if (policy.reviewOperation) {
                const values = [{ name, before: remote, after: wanted }]
                const reviewed = cardImpact ? [source.id, source.modelName, values, cardImpact.cardIds]
                    : [source.id, source.modelName, values]
                if (!policy.reviewOperation(source.path, {
                    key: exportOperationKey('field', reviewed), kind: 'field',
                    id: source.id, modelName: source.modelName, deck: source.deck, values, cardImpact,
                })) continue
            }
            if (cardImpact) cardIds = cardImpact.cardIds
            changed[name] = wanted
            continue
        }
        const cardImpact = hazards.length ? await readImpact(hazards) : undefined
        const conflict: OneWayFieldConflict = { id: source.id, name, source: wanted, actual: remote,
            kind: base === undefined ? 'untracked' : 'both', cardImpact }
        if ((!cardImpact || policy.reviewOperation) && policy.authorizeField?.(conflict)) {
            if (cardImpact) cardIds = cardImpact.cardIds
            changed[name] = wanted
            continue
        }
        policy.onFieldConflict?.(conflict)
        if (cardImpact && !policy.reviewOperation) {
            needsStudyReview(name)
            continue
        }
        const detail = base === undefined ? 'no confirmed previous value is available' : 'Obsidian and Anki both changed'
        report(source.path, `Anki note ${source.id}, field “${name}” needs review: ${detail}. Choose the value in Preview Export.`)
    }
    if (Object.keys(matched).length) policy.capture?.({ id: source.id, modelName: source.modelName, fields: matched,
        ...(source.namedLayout && { namedLayout: source.namedLayout }) })
    if (kept?.length) policy.onKeptAnkiFields?.(source.path, { id: source.id, fields: kept })
    return { fields: Object.fromEntries(Object.entries(changed)), cardIds }
}

function planProtectedTags(source: ExistingNoteSource, actual: NoteSnapshot, prior: OneWayRecord | undefined,
    policy: ExistingNotePolicy): { added: string[]; removed: string[] } {
    const wanted = indexTags(source.tags.flatMap(tag => tag.split(/\s+/u)))
    const present = indexTags(actual.tags)
    const previouslyMatched = new Set(prior?.matchedTags)
    const knownOwned = new Set(prior?.managedTags)
    const matchedTags = [...wanted.keys()].filter(key => present.has(key))
    // Release a pre-existing Anki tag as soon as Markdown drops it. Keeping a
    // match after that would suppress a later explicit re-add from Markdown.
    const absentTags = [...previouslyMatched].filter(key => !wanted.has(key) && (!knownOwned.has(key) || !present.has(key)))
    if (matchedTags.length || absentTags.length) {
        policy.capture?.({ id: source.id, modelName: source.modelName, matchedTags, absentTags })
    }
    return {
        added: Array.from(wanted).filter(([key]) => !present.has(key) && !previouslyMatched.has(key)).map(([, tag]) => tag),
        removed: Array.from(present).filter(([key]) => knownOwned.has(key) && !wanted.has(key)).map(([, tag]) => tag),
    }
}

async function readNoteSnapshots(sources: ReadonlyMap<number, ExistingNoteSource>,
    report: (path: string, message: string) => void,
    prefetched: ReadonlyMap<number, NoteSnapshot>): Promise<Map<number, NoteSnapshot>> {
    const result = new Map<number, NoteSnapshot>()
    const ids: number[] = []
    for (const source of sources.values()) {
        const note = prefetched.get(source.id)
        if (note?.modelName === source.modelName &&
            managedFieldEntries(source).every(([name]) => readField(note.fields, name) !== undefined)) {
            result.set(source.id, note)
        } else ids.push(source.id)
    }

    for (let offset = 0; offset < ids.length; offset += readBatchSize) {
        const batch = ids.slice(offset, offset + readBatchSize)
        const missing = new Set(batch)
        const requested = new Set(batch)
        let response: unknown[]
        try {
            const rows: unknown = await readAvailableNoteRows(batch)
            if (!Array.isArray(rows)) throw new Error('expected an array of notes')
            response = rows
        } catch (error) {
            for (const id of batch) report(sources.get(id)!.path, `notesInfo could not read Anki note ${id}: ${String(error)}`)
            continue
        }

        for (const row of response) {
            if (!isRecord(row) || !isId(row.noteId) || !requested.has(row.noteId)) continue
            const id = row.noteId
            const source = sources.get(id)!
            if (!missing.delete(id)) {
                result.delete(id)
                report(source.path, `notesInfo returned repeated note ID ${id}`)
                continue
            }
            if (row.modelName !== source.modelName) {
                report(source.path, `note ${id} has model ${String(row.modelName)}, expected ${source.modelName}`)
                continue
            }
            const note = parseExistingNoteSnapshot(row)
            if (!note) {
                report(source.path, `notesInfo returned invalid fields, tags or cards for note ${id}`)
                continue
            }
            const invalid = managedFieldEntries(source).find(([field]) => readField(note.fields, field) === undefined)
            if (invalid) {
                report(source.path, `notesInfo did not return field ${invalid[0]} of note ${id}`)
                continue
            }
            result.set(id, note)
        }

        for (const id of missing) report(sources.get(id)!.path, `notesInfo did not return note ${id}`)
    }
    return result
}

async function readCardDecks(cards: readonly number[], read = readAnki): Promise<{ decks: Map<number, string>; problems: Map<number, string> }> {
    const decks = new Map<number, string>()
    const problems = new Map<number, string>()
    for (let offset = 0; offset < cards.length; offset += readBatchSize) {
        const batch = cards.slice(offset, offset + readBatchSize)
        const requested = new Set(batch)
        const batchDecks = new Map<number, string>()
        const repeated = new Set<number>()
        try {
            const response = await read('getDecks', { cards: batch })
            if (!isRecord(response)) throw new Error('expected an object with card IDs grouped by deck')
            for (const [deck, ids] of Object.entries(response)) {
                if (!deck || !Array.isArray(ids)) throw new Error('invalid deck or card list in response')
                for (const id of ids) {
                    if (!isId(id) || !requested.has(id)) throw new Error(`unexpected card ID ${String(id)}`)
                    if (batchDecks.has(id)) repeated.add(id)
                    else batchDecks.set(id, deck)
                }
            }
        } catch (error) {
            for (const id of batch) problems.set(id, `getDecks could not read card ${id}: ${String(error)}`)
            continue
        }
        for (const id of batch) {
            const deck = batchDecks.get(id)
            if (repeated.has(id)) problems.set(id, `getDecks returned repeated card ID ${id}`)
            else if (deck === undefined) problems.set(id, `getDecks returned no deck for card ${id}`)
            else decks.set(id, deck)
        }
    }
    return { decks, problems }
}

async function readMoveBundle(cards: readonly number[], profile: string): Promise<typeof readAnki | undefined> {
    const actions: Array<{ action: string; version: 6; params?: Record<string, unknown> }> = [
        { action: 'getActiveProfile', version: 6 },
    ]
    for (let offset = 0; offset < cards.length; offset += readBatchSize) {
        const batch = cards.slice(offset, offset + readBatchSize)
        actions.push({ action: 'findCards', version: 6, params: { query: `deck:filtered cid:${batch.join(',')}` } },
            { action: 'getDecks', version: 6, params: { cards: batch } })
    }
    actions.push({ action: 'getActiveProfile', version: 6 })
    let response: unknown
    try {
        response = await readAnki('multi', { actions })
    } catch {
        return undefined
    }
    if (!Array.isArray(response) || response.length !== actions.length) return undefined
    const rows: readonly unknown[] = response
    const values: unknown[] = []
    for (const row of rows) {
        if (!isRecord(row) || row.error !== null || !('result' in row)) return undefined
        values.push(row.result)
    }
    const before = values[0]
    const after = values[values.length - 1]
    if (before !== profile || after !== profile) {
        const actual = before !== profile ? before : after
        if (typeof actual !== 'string' || !actual.trim()) return undefined
        throw new AnkiProfileError('mismatch', profile, actual)
    }
    const results = new Map<string, unknown>()
    for (let index = 1; index < actions.length - 1; index++) {
        const { action, params } = actions[index]
        const value = values[index]
        if (action === 'findCards' ? !Array.isArray(value) : !isRecord(value)) return undefined
        results.set(JSON.stringify([action, params]), value)
    }
    return async (action, params) => results.get(JSON.stringify([action, params]))
}

export async function readUnfilteredMoveSources(cards: readonly number[], profile: string): Promise<Map<number, string>> {
    const unique = Array.from(new Set(cards))
    const bundled = await readMoveBundle(unique, profile)
    const read = bundled ?? readAnki
    const filtered = await findFilteredAnkiCards(unique, read)
    const { decks } = await readCardDecks(bundled ? unique : unique.filter(card => !filtered.has(card)), read)
    for (const id of filtered) decks.delete(id)
    if (!bundled) await checkPinnedAnkiProfile(profile)
    return decks
}

export async function filteredMoveTargets(decks: readonly string[], unverified = new Set<string>()): Promise<Set<string>> {
    return new Set((await readFilteredAnkiDecks(decks, readAnki, undefined, unverified)).keys())
}

async function planDeckMoves(sources: ReadonlyMap<number, ExistingNoteSource>, snapshots: ReadonlyMap<number, NoteSnapshot>,
    report: (path: string, message: string) => void): Promise<{ moves: Map<number, number[]>; decks: Map<number, string> }> {
    const cards = Array.from(new Set(Array.from(snapshots.values()).flatMap(note => note.cards)))
    let filtered: Set<number> | undefined
    let filteredError: unknown
    try {
        filtered = await findFilteredAnkiCards(cards, readAnki)
    } catch (error) {
        filteredError = error
    }
    const { decks, problems } = await readCardDecks(cards.filter(card => !filtered?.has(card)))
    const moves = new Map<number, number[]>()
    const filteredByNote = new Map<number, number[]>()
    const byTarget = new Map<string, number[]>()
    for (const [id, note] of snapshots) {
        const source = sources.get(id)!
        const affected = note.cards.filter(card => filtered?.has(card))
        if (affected.length) {
            filteredByNote.set(id, affected)
            const target = ankiStudyDeckKey(source.deck)
            const group = byTarget.get(target) ?? []
            group.push(...affected)
            byTarget.set(target, group)
        }
        const ordinary = note.cards.filter(card => !filtered?.has(card))
        const unresolved = ordinary.find(card => problems.has(card))
        if (unresolved !== undefined) {
            report(source.path, `deck changes for Anki note ${id} were deferred: ${problems.get(unresolved)}`)
            continue
        }
        const target = ankiStudyDeckKey(source.deck)
        const different = ordinary.filter(card => ankiStudyDeckKey(decks.get(card)!) !== target)
        if (!different.length) continue
        if (!filtered) {
            report(source.path, `could not check filtered decks for Anki note ${id}: ${String(filteredError)}`)
        } else moves.set(id, different)
    }

    const unverified = new Set<string>()
    const filteredTargets = await filteredMoveTargets([...moves.keys()].map(id => sources.get(id)!.deck), unverified)
    for (const id of moves.keys()) {
        const { deck, path } = sources.get(id)!
        if (unverified.has(ankiStudyDeckKey(deck))) {
            moves.delete(id)
            report(path, `Deck type unverified: ${deck}. Retry sync.`)
            continue
        }
        if (!filteredTargets.has(ankiStudyDeckKey(deck))) continue
        moves.delete(id)
        report(path, `Anki note ${id} cannot be assigned to the filtered deck ${deck}. Choose a regular deck.`)
    }
    if (!filteredByNote.size) return { moves, decks }

    const confirmed = new Map<string, Set<number>>()
    let deckIds: Map<string, number>
    try {
        deckIds = await readAnkiDeckIds(readAnki)
    } catch {
        deckIds = new Map()
    }
    for (const [target, ids] of byTarget) {
        const targetId = deckIds.get(target)
        if (targetId === undefined) continue
        try {
            confirmed.set(target, await findAnkiDeckCardIds(targetId, ids, readAnki))
        } catch {
            continue
        }
    }
    for (const [id, ids] of filteredByNote) {
        const source = sources.get(id)!
        const inTarget = confirmed.get(ankiStudyDeckKey(source.deck))
        if (ids.some(card => !inTarget?.has(card))) {
            report(source.path, `Anki note ${id} has cards in a filtered deck whose home deck could not be confirmed as ${source.deck}. Return the cards to their home decks and run the scan again.`)
        }
    }
    return { moves, decks }
}

export async function prepareExistingNoteChanges(
    notes: readonly ExistingNoteSource[],
    report: (path: string, message: string) => void,
    prefetched: ReadonlyMap<number, NoteSnapshot> = new Map(),
    onDeckMove?: (path: string, detail: ExportDeckMove) => void,
    policy: ExistingNotePolicy = {},
): Promise<Map<string, AnkiConnect.AnkiConnectRequest[]>> {
    const sources = new Map<number, ExistingNoteSource>()
    const repeated = new Set<number>()
    const changes = new Map<string, AnkiConnect.AnkiConnectRequest[]>()
    for (const source of notes) {
        if (!isId(source.id)) {
            report(source.path, `invalid Anki note ID ${source.id}`)
            continue
        }
        const previous = sources.get(source.id)
        if (previous || repeated.has(source.id)) {
            const message = `Duplicate Anki note ID ${source.id} in ${previous?.path ?? source.path} and ${source.path}`
            if (previous) report(previous.path, message)
            report(source.path, message)
            sources.delete(source.id)
            repeated.add(source.id)
            continue
        }
        sources.set(source.id, source)
    }
    if (!sources.size) return changes

    const snapshots = await readNoteSnapshots(sources, report, prefetched)
    const moveSnapshots = new Map<number, NoteSnapshot>()
    if (policy.allowDeckMoves !== false) {
        for (const [id, snapshot] of snapshots) {
            if (isExistingDeckManaged(sources.get(id)!)) moveSnapshots.set(id, snapshot)
        }
    }
    const { moves, decks } = await planDeckMoves(sources, moveSnapshots, report)
    const previewMoves = onDeckMove ? new Map<string, Map<string, ExportDeckMove>>() : undefined

    for (const source of sources.values()) {
        const actual = snapshots.get(source.id)
        if (!actual) continue
        const actions: AnkiConnect.AnkiConnectRequest[] = []
        const prior = policy.history?.get(source.id, source.modelName)
        const { fields, cardIds } = await planProtectedFields(source, actual, prior, policy, report)
        const fieldNames = Object.keys(fields)
        if (fieldNames.length) {
            const request = AnkiConnect.updateNoteFields(source.id, fields)
            policy.reviewEvidence?.(request, { id: source.id, modelName: source.modelName,
                fields: fieldNames.map(name => [name, readField(actual.fields, name)!]), cardIds })
            if (cardIds) policy.rememberReviewedCards?.(request, cardIds)
            actions.push(request)
        }

        const { added, removed } = planProtectedTags(source, actual, prior, policy)
        let allowTags = true
        if (policy.reviewOperation && (added.length || removed.length)) {
            const before = indexTags(actual.tags)
            const after = new Map(before)
            for (const tag of removed) after.delete(oneWayTagKey(tag))
            for (const tag of added) after.set(oneWayTagKey(tag), tag)
            const values = [{ name: 'Tags', before: [...before.values()].sort().join(' '), after: [...after.values()].sort().join(' ') }]
            allowTags = policy.reviewOperation(source.path, {
                key: exportOperationKey('tags', [source.id, source.modelName, values]), kind: 'tags',
                id: source.id, modelName: source.modelName, deck: source.deck, values,
            })
        }
        if (allowTags && added.length) {
            const request = AnkiConnect.addTags([source.id], added.join(' '))
            policy.reviewEvidence?.(request, { id: source.id, modelName: source.modelName, absentTags: added })
            actions.push(request)
        }
        if (allowTags && removed.length) {
            const request = AnkiConnect.removeTags([source.id], removed.join(' '))
            policy.reviewEvidence?.(request, { id: source.id, modelName: source.modelName, presentTags: removed })
            actions.push(request)
        }

        const move = moves.get(source.id)
        if (move?.length && (!policy.reviewOperation || policy.reviewOperation(source.path, {
            key: exportOperationKey('deck', [source.id, source.modelName, source.deck, move.map(card => [card, decks.get(card)])]),
            kind: 'deck', id: source.id, modelName: source.modelName, deck: source.deck,
            values: move.map(card => ({ name: String(card), before: decks.get(card), after: source.deck })),
        }))) {
            const request = AnkiConnect.changeDeck(move, source.deck)
            policy.rememberMoveOwner?.(request, source.id)
            actions.push(request)
            if (previewMoves) {
                const details = previewMoves.get(source.path) ?? new Map<string, ExportDeckMove>()
                const reason = source.deckRule
                for (const card of move) {
                    const from = decks.get(card)!
                    const key = JSON.stringify([from, source.deck, reason?.origin, reason?.folder])
                    const existing = details.get(key)
                    if (existing) {
                        existing.count++
                        existing.cardIds.push(card)
                    } else details.set(key, { from, to: source.deck, count: 1, cardIds: [card], reason })
                }
                previewMoves.set(source.path, details)
            }
        }

        if (actions.length) {
            const fileActions = changes.get(source.path)
            if (fileActions) fileActions.push(...actions)
            else changes.set(source.path, actions)
        }
    }
    if (onDeckMove && previewMoves) {
        for (const [path, details] of previewMoves) {
            for (const detail of details.values()) onDeckMove(path, detail)
        }
    }
    return changes
}

export async function findOpenNotesForUpdate(
    changes: ReadonlyMap<string, readonly AnkiConnect.AnkiConnectRequest[]>,
): Promise<Set<number>> {
    const planned = new Set<number>()
    for (const actions of changes.values()) {
        for (const request of actions) {
            if (request.action === 'updateNoteFields') planned.add(request.params.note.id)
        }
    }
    if (!planned.size) return planned

    try {
        const selected = await readAnki('guiSelectedNotes')
        if (Array.isArray(selected) && selected.every(isId)) {
            return new Set(selected.filter(id => planned.has(id)))
        }
    } catch {
        // The Anki browser can be closed during an export.
    }
    return new Set()
}

export interface ExistingWriteEvidence {
    models: ReadonlyMap<number, string>
    namedLayouts?: ReadonlyMap<number, OneWayNamedLayout>
    created?: readonly Pick<ExistingNoteSource, 'id' | 'path' | 'modelName' | 'fields' | 'tags' | 'namedLayout'>[]
    confirmedActions?: ReadonlySet<AnkiConnect.AnkiConnectRequest>
    reviewedCards?: ReadonlyMap<AnkiConnect.AnkiConnectRequest, readonly number[]>
    onDeckVerified?(cardId: number): void
    onCardImpact?(impact: VerifiedCardImpact): void
    capture?(receipt: OneWayReceipt): void
}

interface ExpectedNoteWrite {
    path: string
    modelName?: string
    fields: Record<string, string>
    createdFields?: Readonly<Record<string, string>>
    namedLayout?: OneWayNamedLayout
    added: Map<string, boolean>
    removed: Set<string>
    cardIds?: readonly number[]
}

export async function verifyExistingNoteFieldWrites(
    changes: ReadonlyMap<string, AnkiConnect.AnkiConnectRequest[]>,
    report?: (path: string, message: string) => void,
    evidence?: ExistingWriteEvidence,
): Promise<string[]> {
    const writes = new Map<number, ExpectedNoteWrite>()
    const deckWrites = new Map<number, { path: string; deck: string }>()
    function obtain(id: number, path: string, modelName = evidence?.models.get(id)): ExpectedNoteWrite {
        const previous = writes.get(id)
        if (previous) return previous
        const result: ExpectedNoteWrite = { path, modelName, fields: emptyFields(), added: new Map(), removed: new Set() }
        writes.set(id, result)
        return result
    }
    for (const source of evidence?.created ?? []) {
        const expected = obtain(source.id, source.path, source.modelName)
        expected.createdFields = source.fields
        expected.namedLayout = source.namedLayout
        Object.assign(expected.fields, source.fields)
        for (const key of indexTags(source.tags.flatMap(tag => tag.split(/\s+/u))).keys()) expected.added.set(key, true)
    }
    for (const [path, actions] of changes) {
        for (const request of actions) {
            if (request.action === 'updateNoteFields') {
                const { id, fields } = request.params.note
                const expected = obtain(id, path)
                Object.assign(expected.fields, fields)
                const cardIds = evidence?.reviewedCards?.get(request)
                if (cardIds) expected.cardIds = cardIds
            } else if (evidence && request.action === 'changeDeck') {
                for (const card of request.params.cards) deckWrites.set(card, { path, deck: request.params.deck })
            } else if (evidence && (request.action === 'addTags' || request.action === 'removeTags')) {
                const keys = [...indexTags(request.params.tags.split(/\s+/u)).keys()]
                for (const id of request.params.notes) {
                    const expected = obtain(id, path)
                    for (const key of keys) {
                        if (request.action === 'addTags') {
                            expected.removed.delete(key)
                            expected.added.set(key, expected.added.get(key) === true || evidence.confirmedActions?.has(request) === true)
                        } else {
                            expected.added.delete(key)
                            expected.removed.add(key)
                        }
                    }
                }
            }
        }
    }

    const errors: string[] = []
    const issue = (path: string, message: string) => {
        errors.push(`${path}: ${message}`)
        report?.(path, message)
    }
    const ids = Array.from(writes.keys())
    for (let offset = 0; offset < ids.length; offset += readBatchSize) {
        const batch = ids.slice(offset, offset + readBatchSize)
        try {
            const response = await readAvailableNoteRows(batch)
            if (!Array.isArray(response)) throw new Error('notesInfo: expected an array of notes')
            let selection: Set<number> | undefined
            const stored = new Map<number, Record<string, unknown> | undefined>()
            for (const row of response) {
                if (!isRecord(row) || !isId(row.noteId)) continue
                stored.set(row.noteId, !stored.has(row.noteId) && isRecord(row.fields) ? row : undefined)
            }

            for (const id of batch) {
                const { path, modelName, fields, createdFields, added, removed, cardIds } = writes.get(id)!
                const actual = stored.get(id)
                if (!actual || !isRecord(actual.fields) || (modelName && actual.modelName !== modelName)) {
                    issue(path, `could not verify saved fields for Anki note ${id}`)
                    continue
                }
                const observed = Object.entries(fields).filter(([name, value]) => sameFieldValue(readField(actual.fields as Record<string, unknown>, name), value))
                const verifiedFields = Object.fromEntries(observed)
                const mismatched = Object.keys(fields).filter(name => !Object.prototype.hasOwnProperty.call(verifiedFields, name))
                if (mismatched.length) {
                    selection ??= await findOpenNotesForUpdate(changes)
                    issue(path, selection.has(id) ? ankiBrowseMessage(id) :
                        `Anki ID ${id}: fields differ after saving (${mismatched.join(', ')}). Review this note and retry sync.`)
                    for (const name of mismatched) {
                        const created = createdFields?.[name]
                        if (typeof created === 'string' && sameFieldValue(readField(actual.fields, name), created)) {
                            verifiedFields[name] = created
                        }
                    }
                }
                const haveTags = Array.isArray(actual.tags) && actual.tags.every(tag => typeof tag === 'string')
                const tags = haveTags ? indexTags(actual.tags as string[]) : undefined
                const matchedTags = [...added.keys()].filter(tag => tags?.has(tag))
                const removedTags = [...removed].filter(tag => tags && !tags.has(tag))
                if (matchedTags.length !== added.size || removedTags.length !== removed.size) {
                    issue(path, `could not verify saved tags for Anki note ${id}`)
                }
                if (cardIds) {
                    const verified = readCardIds(actual.cards)
                    if (!verified) issue(path, `could not verify the resulting study card IDs of Anki note ${id}`)
                    else evidence?.onCardImpact?.(compareStudyCardIds(id, path, cardIds, verified))
                }
                if (modelName) {
                    const layout = writes.get(id)!.namedLayout ?? evidence?.namedLayouts?.get(id)
                    evidence?.capture?.({ id, modelName, fields: verifiedFields, matchedTags, removedTags,
                        ...(layout && { namedLayout: layout }),
                        addedTags: matchedTags.filter(tag => added.get(tag)) })
                }
            }
        } catch (error) {
            for (const id of batch) {
                issue(writes.get(id)!.path, `could not verify saved fields for Anki note ${id}: ${String(error)}`)
            }
        }
    }
    if (deckWrites.size) {
        const { decks, problems } = await readCardDecks([...deckWrites.keys()])
        for (const [card, { path, deck }] of deckWrites) {
            const actual = decks.get(card)
            if (actual === undefined || ankiStudyDeckKey(actual) !== ankiStudyDeckKey(deck)) {
                const failure = problems.get(card) ?? `expected ${deck}, received ${actual ?? 'no deck'}`
                issue(path, `could not verify the new deck for Anki card ${card}: ${failure}`)
            } else evidence?.onDeckVerified?.(card)
        }
    }
    return errors
}
