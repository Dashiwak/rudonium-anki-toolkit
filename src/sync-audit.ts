/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import * as AnkiConnect from './anki'
import { sameFieldValue } from './anki-delta'
import { findFilteredAnkiCards, isProtectedAnkiTag, readAnkiDeckEntries, readAnkiDeckKind } from './anki-study-state'
import { isRecoveryTag } from './export-recovery'
import type { DeckRouteOrigin } from './deck-routes'
import { rememberAttachmentDeckMembers } from './audit-attachment-check'
import { auditLinkedRow, rememberAuditLinkedRows } from './audit-card-status'
import type { AuditCardRow } from './audit-card-status'

export interface SyncAuditExpected {
    modelName: string
    fields: Record<string, string>
    tags: string[]
    deck: string
}

export interface SyncAuditDeckReference {
    deck: string
    path: string
    deckRoute?: DeckRouteOrigin
}

export interface SyncAuditSource {
    id: number
    path: string
    line?: number
    endLine?: number
    markerLine?: number
    auditCaption?: string
    expected?: SyncAuditExpected
    assignedDeck?: string
    deckRoute?: DeckRouteOrigin
    inExportScope?: boolean
    excludedByProfile?: boolean
}

export interface SyncAuditFileError {
    path: string
    message: string
}

export interface SyncAuditUnlinked {
    path: string
    count: number
    lines?: number[]
    assignedDeck?: string
    deckRoute?: DeckRouteOrigin
    inExportScope?: boolean
}

interface SyncAuditFolderProfile {
    label: string
    files: number
    named: boolean
}

export interface SyncAuditInput {
    vaultName: string
    exportTag: string
    deck: string
    folderProfile?: SyncAuditFolderProfile
    sources: readonly SyncAuditSource[]
    duplicateIds?: readonly SyncAuditGroup[]
    filesScanned: number
    fileErrors?: readonly SyncAuditFileError[]
    unlinked?: readonly SyncAuditUnlinked[]
    pendingDeletions?: readonly SyncAuditSource[]
    unparsedIds?: readonly SyncAuditSource[]
    deckAssignments?: readonly SyncAuditDeckReference[]
    linkedDetails?: AuditNoteSnapshots
}

export interface SyncAuditProgress {
    phase: 'ids' | 'details' | 'decks'
    completed: number
    total: number
}

export interface SyncAuditGroup {
    id: number
    occurrences: SyncAuditSource[]
}

export interface SyncAuditAnkiDeckMismatch extends SyncAuditGroup {
    actualDecks: string[]
    deckDetailsComplete: boolean
}

export interface SyncAuditFilteredCard {
    id: number
    cardId: number
    path: string
    line?: number
    homeDeck?: string
    expectedHomeDeck?: string
    homeMismatch?: boolean
    filteredDeck: string
}

export interface SyncAuditAnkiOnly {
    id: number
    modelName?: string
    markers: Array<'configured-tag' | 'vault-link'>
    metadataAvailable: boolean
}

export interface SyncAuditDifference {
    id: number
    path: string
    line?: number
    endLine?: number
    markerLine?: number
    model?: { expected: string; actual: string }
    fields: Array<{ name: string; kind: 'missing' | 'different'; expected: string; actual?: string }>
    missingTags: string[]
    extraTags: string[]
    decks: Array<{ cardId: number; expected: string; actual: string }>
    deckRoute?: DeckRouteOrigin
    complete: boolean
}

interface SyncAuditDeckFile {
    path: string
    linked: number
    unlinked: number
    deckRoute?: DeckRouteOrigin
}

export interface SyncAuditDeckAssignment {
    deck: string
    files: SyncAuditDeckFile[]
}

export type SyncAuditAnkiProfile = { active: string; expected?: string } | { problem: string; expected?: string }

export interface SyncAuditResult {
    startedAt: string
    vaultName: string
    deck: string
    folderProfile?: SyncAuditFolderProfile
    ankiProfile?: SyncAuditAnkiProfile
    ankiDeckExists?: boolean
    ankiDeckKind?: 'ordinary' | 'filtered'
    ankiInventoryComplete: boolean
    vaultInventoryComplete: boolean
    counts: {
        filesScanned: number
        vaultReferences: number
        vaultIds: number
        ankiNotes: number
        ankiCards: number
        ankiFilteredCards: number
        matchedIds: number
        duplicateIds: number
        obsidianOnlyIds: number
        ankiOnlyIds: number
        comparisonCandidates: number
        comparedIds: number
        differenceIds: number
        unlinkedNotes: number
        pendingDeletions: number
        unparsedIds: number
    }
    duplicateIds: SyncAuditGroup[]
    obsidianOnly: SyncAuditGroup[]
    ankiOnly: SyncAuditAnkiOnly[]
    unverifiedSourceIds: number[]
    outsideAnkiDeck: SyncAuditAnkiDeckMismatch[]
    outsideObsidianScope: SyncAuditGroup[]
    differences: SyncAuditDifference[]
    filteredCards: SyncAuditFilteredCard[]
    deckAssignments: SyncAuditDeckAssignment[]
    fileErrors: SyncAuditFileError[]
    markdownWarnings?: Array<{ path: string; line: number; message: string }>
    ankiErrors: string[]
    unlinked: SyncAuditUnlinked[]
    pendingDeletions: SyncAuditSource[]
    unparsedIds: SyncAuditSource[]
}

const batchSize = 500
const readBatchesPerRequest = 4
const readTimeoutMs = 60_000

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Sync audit cancelled', 'AbortError')
}

export function auditRead(
    action: 'findNotes' | 'notesInfo' | 'notesModTime' | 'getDecks' | 'deckNames' | 'deckNamesAndIds' | 'findCards' | 'cardsInfo' | 'cardsToNotes' |
        'modelNames' | 'modelFieldNames' | 'modelTemplates' | 'getActiveProfile' | 'getDeckConfig' | 'guiSelectedNotes' | 'multi' |
        'canAddNotesWithErrorDetail',
    params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = readTimeoutMs,
): Promise<unknown> {
    checkAbort(signal)
    return new Promise((resolve, reject) => {
        const abort = () => {
            cleanup()
            reject(new DOMException('Sync audit cancelled', 'AbortError'))
        }
        const timeout = window.setTimeout(() => {
            cleanup()
            reject(new DOMException(`AnkiConnect did not respond within ${timeoutMs / 1000} seconds`, 'TimeoutError'))
        }, timeoutMs)
        function cleanup(): void {
            window.clearTimeout(timeout)
            signal?.removeEventListener('abort', abort)
        }
        signal?.addEventListener('abort', abort, { once: true })
        void Promise.resolve().then(() => {
            checkAbort(signal)
            return AnkiConnect.invoke(action, params)
        }).then(
            response => { cleanup(); resolve(response) },
            error => { cleanup(); reject(error) },
        )
    })
}

function isTimeout(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'TimeoutError'
}

function isId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function location(source: SyncAuditSource): SyncAuditSource {
    const { id, path, line, endLine, markerLine, inExportScope, excludedByProfile, deckRoute } = source
    const assignedDeck = source.assignedDeck ?? source.expected?.deck
    return {
        id, path, line,
        ...(endLine !== undefined && { endLine }),
        ...(markerLine !== undefined && { markerLine }),
        ...(assignedDeck !== undefined && { assignedDeck }),
        ...(deckRoute !== undefined && { deckRoute }),
        ...(inExportScope !== undefined && { inExportScope }),
        ...(excludedByProfile && { excludedByProfile }),
    }
}

export function markObsidianInventoryIncomplete(result: SyncAuditResult): void {
    result.vaultInventoryComplete = false
    for (const { id } of result.ankiOnly) result.unverifiedSourceIds.push(id)
    result.ankiOnly = []
    result.counts.ankiOnlyIds = 0
}

export function syncAuditDeckKey(deck: string): string {
    return deck.normalize('NFC').toLowerCase()
}

function sameDeck(left: string, right: string): boolean {
    return syncAuditDeckKey(left) === syncAuditDeckKey(right)
}

function groupDeckAssignments(input: SyncAuditInput): SyncAuditDeckAssignment[] {
    const decks = new Map<string, { deck: string; files: Map<string, SyncAuditDeckFile> }>()
    function remember(deck: string | undefined, path: string, linked: number, unlinked: number,
        deckRoute?: DeckRouteOrigin): void {
        if (!deck?.trim()) return
        const key = syncAuditDeckKey(deck)
        let group = decks.get(key)
        if (!group) {
            group = { deck, files: new Map() }
            decks.set(key, group)
        }
        const existing = group.files.get(path)
        if (existing) {
            existing.linked += linked
            existing.unlinked += unlinked
            existing.deckRoute ??= deckRoute
        } else group.files.set(path, { path, linked, unlinked, ...(deckRoute && { deckRoute }) })
    }

    for (const { deck, path, deckRoute } of input.deckAssignments ?? []) remember(deck, path, 0, 0, deckRoute)
    for (const source of input.sources) {
        if (source.inExportScope !== false) remember(source.assignedDeck ?? source.expected?.deck, source.path, 1, 0, source.deckRoute)
    }
    for (const source of input.unlinked ?? []) {
        if (source.inExportScope !== false && source.count > 0) remember(source.assignedDeck, source.path, 0, source.count, source.deckRoute)
    }
    return Array.from(decks.values(), ({ deck, files }) => ({
        deck, files: Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path)),
    })).sort((left, right) => left.deck.localeCompare(right.deck))
}

function indexTags(values: readonly string[], ignoredTag: (tag: string) => boolean = isRecoveryTag): Map<string, string> {
    const result = new Map<string, string>()
    for (const value of values) {
        for (const tag of value.trim().split(/\s+/u)) {
            const key = tag.toLowerCase()
            if (tag && !result.has(key) && !ignoredTag(key)) result.set(key, tag)
        }
    }
    return result
}

function hasVaultLink(fields: ReadonlyMap<string, string>, vaultName: string): boolean {
    for (const field of fields.values()) {
        if (!/obsidian:\/\/(?:open|anki-card)\?/i.test(field)) continue
        for (const match of field.matchAll(/<a\b[^>]*?\s+href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>]+))/gi)) {
            const value = match[1] ?? match[2] ?? match[3]
            if (!/^obsidian:\/\/(?:open|anki-card)\?/i.test(value)) continue
            try {
                const url = new URL(value.replace(/&(?:amp|#0*38|#x0*26);/gi, '&'))
                if (url.searchParams.get('vault')?.normalize('NFC') === vaultName.normalize('NFC') &&
                    url.searchParams.get('file')) return true
            } catch {
            }
        }
    }
    return false
}

interface Snapshot {
    modelName: string
    fields: Map<string, string>
    tags: string[]
    cards: number[] | null
}

function readSnapshot(row: Record<string, unknown>): Snapshot | null {
    if (typeof row.modelName !== 'string' || !isRecord(row.fields) ||
        !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string')) return null
    const fields = new Map<string, string>()
    for (const [name, info] of Object.entries(row.fields)) {
        if (!isRecord(info) || typeof info.value !== 'string') return null
        fields.set(name, info.value)
    }
    const cards = Array.isArray(row.cards) && row.cards.every(isId) &&
        new Set(row.cards).size === row.cards.length ? row.cards : null
    return { modelName: row.modelName, fields, tags: row.tags, cards }
}

export class AuditNoteSnapshots {
    private readonly entries = new Map<number, Snapshot>()
    private remainingBytes = 24 * 1024 * 1024

    remember(ids: readonly number[], response: unknown): void {
        if (this.remainingBytes <= 0 || !Array.isArray(response) || response.length !== ids.length) return
        const requested = new Set(ids)
        const validated = new Map<number, Snapshot>()
        for (const row of response) {
            if (!isRecord(row) || !isId(row.noteId) || !requested.delete(row.noteId)) return
            const snapshot = readSnapshot(row)
            if (snapshot && snapshot.cards !== null) validated.set(row.noteId, snapshot)
        }
        for (const [id, snapshot] of validated) {
            let size = 208 + 2 * snapshot.modelName.length + snapshot.cards!.length * 8
            for (const [name, value] of snapshot.fields) size += 80 + 2 * (name.length + value.length)
            for (const tag of snapshot.tags) size += 40 + 2 * tag.length
            if (size > this.remainingBytes) continue
            this.entries.set(id, snapshot)
            this.remainingBytes -= size
        }
    }

    take(id: number): Snapshot | undefined {
        const snapshot = this.entries.get(id)
        if (snapshot) this.entries.delete(id)
        return snapshot
    }
}

interface Comparison {
    difference: SyncAuditDifference
    expectedDeck: string
    cards: number[]
    actualDecks: Set<string>
    filteredCards: SyncAuditFilteredCard[]
    unknownHome: boolean
}

function compareNote(source: SyncAuditSource, actual: Snapshot, deckOnly?: string): Comparison {
    const expected = deckOnly === undefined ? source.expected! : undefined
    const wantedTags = indexTags(expected?.tags ?? [], isProtectedAnkiTag)
    const actualTags = indexTags(expected ? actual.tags : [], isProtectedAnkiTag)
    const difference: SyncAuditDifference = {
        id: source.id,
        path: source.path,
        line: source.line,
        ...(source.endLine !== undefined && { endLine: source.endLine }),
        ...(source.markerLine !== undefined && { markerLine: source.markerLine }),
        ...(source.deckRoute !== undefined && { deckRoute: source.deckRoute }),
        fields: [],
        missingTags: Array.from(wantedTags).filter(([key]) => !actualTags.has(key)).map(([, tag]) => tag),
        extraTags: Array.from(actualTags).filter(([key]) => !wantedTags.has(key)).map(([, tag]) => tag),
        decks: [],
        complete: actual.cards !== null,
    }
    if (expected && expected.modelName !== actual.modelName) {
        difference.model = { expected: expected.modelName, actual: actual.modelName }
    }
    for (const [name, value] of Object.entries(expected?.fields ?? {})) {
        const stored = actual.fields.get(name)
        if (stored === undefined) difference.fields.push({ name, kind: 'missing', expected: value })
        else if (!sameFieldValue(stored, value)) difference.fields.push({ name, kind: 'different', expected: value, actual: stored })
    }
    return {
        difference, expectedDeck: expected?.deck ?? deckOnly!, cards: actual.cards ?? [],
        actualDecks: new Set(), filteredCards: [], unknownHome: false,
    }
}

type Progress = (progress: SyncAuditProgress) => void

async function readDetails(
    ids: readonly number[],
    consume: (id: number, snapshot: Snapshot) => void,
    errors: string[],
    progress?: Progress,
    signal?: AbortSignal,
    linkedDetails?: AuditNoteSnapshots,
): Promise<boolean> {
    for (let offset = 0; offset < ids.length; offset += batchSize) {
        checkAbort(signal)
        const batch = ids.slice(offset, offset + batchSize)
        const requested = new Set<number>()
        const snapshots = new Map<number, Snapshot>()
        for (const id of batch) {
            const snapshot = linkedDetails?.take(id)
            if (snapshot) snapshots.set(id, snapshot)
            else requested.add(id)
        }
        if (requested.size) {
            try {
                const response = await auditRead('notesInfo', { notes: Array.from(requested) }, signal)
                checkAbort(signal)
                if (!Array.isArray(response)) throw new Error('expected an array')
                const rows = new Map<number, Record<string, unknown>>()
                const repeated = new Set<number>()
                for (const row of response) {
                    if (!isRecord(row) || !isId(row.noteId) || !requested.has(row.noteId)) {
                        errors.push('notesInfo: unexpected note in response')
                        continue
                    }
                    if (rows.has(row.noteId)) {
                        rows.delete(row.noteId)
                        repeated.add(row.noteId)
                    } else if (!repeated.has(row.noteId)) rows.set(row.noteId, row)
                }
                const unavailable: number[] = []
                for (const id of requested) {
                    const row = rows.get(id)
                    const snapshot = row && readSnapshot(row)
                    if (snapshot) snapshots.set(id, snapshot)
                    else unavailable.push(id)
                }
                if (unavailable.length) {
                    errors.push(`notesInfo: unavailable or ambiguous details for ${unavailable.length} notes (${unavailable.slice(0, 5).join(', ')})`)
                }
            } catch (error) {
                checkAbort(signal)
                errors.push(`notesInfo: notes ${offset + 1}–${offset + batch.length} of ${ids.length}: ${String(error)}`)
                if (isTimeout(error)) {
                    for (const [id, snapshot] of snapshots) consume(id, snapshot)
                    return false
                }
            }
        }
        for (const id of batch) {
            const snapshot = snapshots.get(id)
            if (snapshot) consume(id, snapshot)
        }
        progress?.({ phase: 'details', completed: offset + batch.length, total: ids.length })
    }
    return true
}

async function compareDecks(
    comparisons: readonly Comparison[], inventory: AnkiDeckInventory, auditDeck: string,
    errors: string[], progress?: Progress, signal?: AbortSignal,
): Promise<void> {
    const owners = new Map<number, Comparison>()
    const repeated = new Set<number>()
    for (const comparison of comparisons) {
        for (const card of comparison.cards) {
            const previous = owners.get(card)
            if (previous) {
                previous.difference.complete = false
                owners.delete(card)
                repeated.add(card)
                errors.push(`notesInfo: card ${card} belongs to multiple notes in response`)
            }
            if (repeated.has(card)) comparison.difference.complete = false
            else owners.set(card, comparison)
        }
    }

    const cards = Array.from(owners.keys())
    if (cards.length) progress?.({ phase: 'decks', completed: 0, total: cards.length })
    let useMulti = true
    let grouped: AuditBundleRow[] = []
    for (let offset = 0; offset < cards.length; offset += batchSize) {
        checkAbort(signal)
        const batch = cards.slice(offset, offset + batchSize)
        const requested = new Set(batch)
        const decks = new Map<number, string>()
        const ambiguous = new Set<number>()
        let timedOut = false
        try {
            if (useMulti && !grouped.length && cards.length - offset > batchSize) {
                const actions: AuditBundleAction[] = []
                for (let index = offset; index < Math.min(offset + batchSize * readBatchesPerRequest, cards.length);
                    index += batchSize) {
                    actions.push({ action: 'getDecks', cards: cards.slice(index, index + batchSize) })
                }
                grouped = await readAuditBundle(actions, signal) ?? []
                useMulti = grouped.length > 0 && grouped.every(row => row.error === null)
            }
            const row = grouped.shift()
            const response = row?.error === null ? row.result : await auditRead('getDecks', { cards: batch }, signal)
            checkAbort(signal)
            if (!isRecord(response)) throw new Error('expected a mapping from deck names to card IDs')
            for (const [deck, ids] of Object.entries(response)) {
                if (!deck || !Array.isArray(ids)) {
                    errors.push('getDecks: invalid deck or card list in response')
                    continue
                }
                for (const id of ids) {
                    if (!isId(id) || !requested.has(id)) {
                        errors.push('getDecks: unexpected card ID in response')
                        continue
                    }
                    if (decks.has(id)) {
                        decks.delete(id)
                        ambiguous.add(id)
                    } else if (!ambiguous.has(id)) decks.set(id, deck)
                }
            }
        } catch (error) {
            checkAbort(signal)
            errors.push(`getDecks: cards ${offset + 1}–${offset + batch.length} of ${cards.length}: ${String(error)}`)
            timedOut = isTimeout(error)
        }
        const temporary = inventory.kind === 'filtered' ? undefined :
            await checkTemporaryDecks(batch, decks, owners, inventory, errors, signal)
        let missing = 0
        for (const card of batch) {
            const owner = owners.get(card)!
            const { difference, expectedDeck, actualDecks } = owner
            const deck = decks.get(card)
            if (deck === undefined) {
                difference.complete = false
                missing++
            } else if (!temporary) {
                if (sameDeck(deck, auditDeck)) actualDecks.add(deck)
            } else if (temporary.filtered.has(card)) {
                const inHome = temporary.inHome.has(card)
                const unknown = temporary.unknown.has(card)
                if (inHome) actualDecks.add(expectedDeck)
                else difference.complete = false
                if (unknown) owner.unknownHome = true
                owner.filteredCards.push({
                    id: difference.id, cardId: card, path: difference.path, line: difference.line,
                    homeDeck: inHome ? expectedDeck : undefined, expectedHomeDeck: expectedDeck,
                    filteredDeck: deck, homeMismatch: !inHome && !unknown,
                })
            } else if (temporary.unknown.has(card)) {
                difference.complete = false
                owner.unknownHome = true
            } else {
                actualDecks.add(deck)
                if (!sameDeck(deck, expectedDeck)) difference.decks.push({ cardId: card, expected: expectedDeck, actual: deck })
            }
        }
        if (missing) errors.push(`getDecks: unavailable or ambiguous deck for ${missing} cards in this batch`)
        if (timedOut) {
            for (const card of cards.slice(offset + batch.length)) owners.get(card)!.difference.complete = false
            return
        }
        progress?.({ phase: 'decks', completed: offset + batch.length, total: cards.length })
    }
}

async function checkTemporaryDecks(
    cards: readonly number[], decks: ReadonlyMap<number, string>, owners: ReadonlyMap<number, Comparison>,
    inventory: AnkiDeckInventory, errors: string[], signal?: AbortSignal,
): Promise<{ filtered: Set<number>; inHome: Set<number>; unknown: Set<number> }> {
    let filtered = new Set<number>()
    const inHome = new Set<number>()
    const unknown = new Set<number>()
    const deckIds = inventory.deckIds
    const displaced = cards.filter(card => {
        const actual = decks.get(card)
        return actual && !sameDeck(actual, owners.get(card)!.expectedDeck)
    })
    const read = studyRead(signal)
    try {
        filtered = await findFilteredAnkiCards(displaced, read)
        const byHome = new Map<string, number[]>()
        for (const card of filtered) {
            const expected = owners.get(card)!.expectedDeck
            const home = deckIds?.get(syncAuditDeckKey(expected))
            if (deckIds && !home) continue
            const inChild = syncAuditDeckKey(decks.get(card)!).startsWith(`${syncAuditDeckKey(expected)}::`)
            const query = inventory.numericSearch && home ? `did:${home.id}`
                : inventory.namedSearch && !inChild ? exactNamedDeckQuery(home?.name ?? expected) : undefined
            if (!query) { unknown.add(card); continue }
            const group = byHome.get(query)
            if (group) group.push(card)
            else byHome.set(query, [card])
        }
        if (unknown.size) errors.push('findCards: exact home deck of filtered cards could not be verified')
        for (const [query, group] of byHome) {
            try {
                const atHome = checkedIds(await read('findCards', { query: `${query} cid:${group.join(',')}` }), 'findCards')
                const requested = new Set(group)
                if (atHome.some(card => !requested.has(card))) throw new Error('unexpected card ID in response')
                for (const card of atHome) inHome.add(card)
            } catch (error) {
                checkAbort(signal)
                for (const card of group) unknown.add(card)
                errors.push(`findCards: could not verify the home deck of filtered cards: ${String(error)}`)
            }
        }
    } catch (error) {
        checkAbort(signal)
        for (const card of displaced) unknown.add(card)
        errors.push(`findCards: temporary deck placement could not be verified: ${String(error)}`)
    }
    return { filtered, inHome, unknown }
}

interface AnkiDeckInventory {
    ids: Set<number>
    cards: number
    filtered: number
    complete: boolean
    exists?: boolean
    names?: readonly string[]
    deckIds?: ReadonlyMap<string, { name: string; id: number }>
    numericSearch?: boolean
    namedSearch?: boolean
    kind?: 'ordinary' | 'filtered'
    locationReadFailed?: boolean
    changed?: boolean
}

function checkedIds(response: unknown, action: string): number[] {
    if (!Array.isArray(response) || !response.every(isId) || new Set(response).size !== response.length) {
        throw new Error(`${action}: invalid or repeated IDs in response`)
    }
    return response
}

export async function readSyncAuditDeckNames(signal?: AbortSignal, timeoutMs = readTimeoutMs): Promise<string[]> {
    const names = await auditRead('deckNames', {}, signal, timeoutMs)
    checkAbort(signal)
    if (!Array.isArray(names) || !names.every((name: unknown): name is string => typeof name === 'string' && name.length > 0)) {
        throw new Error('deckNames: invalid deck names')
    }
    return names
}

function studyRead(signal?: AbortSignal) {
    return (action: 'deckNamesAndIds' | 'findCards', params: Record<string, unknown> = {}) =>
        auditRead(action, params, signal)
}

function exactNamedDeckQuery(deck: string): string | undefined {
    return /^(?:current|filtered)$/i.test(deck) || /["\\*_\r\n]/.test(deck)
        ? undefined : `deck:"${deck}" -deck:"${deck}::*"`
}

async function readDeckInventory(deck: string, errors: string[], progress?: Progress,
    signal?: AbortSignal): Promise<AnkiDeckInventory> {
    const result: AnkiDeckInventory = { ids: new Set(), cards: 0, filtered: 0, complete: false }
    if (!deck.trim()) {
        errors.push('Defaults → Deck is empty. Set a deck name and run the audit again.')
        return result
    }
    const read = studyRead(signal)
    try {
        result.deckIds = await readAnkiDeckEntries(read)
    } catch (error) {
        checkAbort(signal)
        if (isTimeout(error)) {
            errors.push(`Anki deck inventory: ${String(error)}`)
            return result
        }
    }
    try {
        const names = result.deckIds ? Array.from(result.deckIds.values(), item => item.name) : await readSyncAuditDeckNames(signal)
        result.names = names
        const matching = names.filter(name => sameDeck(name, deck))
        if (matching.length > 1) throw new Error('deckNames: multiple decks match the configured name')
        result.exists = matching.length === 1
        if (!result.exists) return { ...result, complete: true }
        const canonical = matching[0]
        try {
            const kind = await readAnkiDeckKind(canonical, (action, params) => auditRead(action, params, signal, 5_000))
            if (kind === 'ordinary' || kind === 'filtered') result.kind = kind
            if (kind === 'missing') {
                result.changed = true
                errors.push('Anki deck membership changed during the audit. Recheck to refresh the result.')
                return result
            }
        } catch {
            checkAbort(signal)
        }
        const numericId = result.deckIds?.get(syncAuditDeckKey(canonical))?.id
        if (numericId !== undefined) {
            const query = `did:${numericId}`
            let candidates: number[] = []
            try {
                candidates = checkedIds(await auditRead('findCards', { query }, signal), 'findCards')
            } catch (error) {
                checkAbort(signal)
                if (isTimeout(error)) throw error
            }
            if (candidates.length) {
                try {
                    await readLightweightInventory(candidates, canonical, result, progress, signal)
                } catch (error) {
                    checkAbort(signal)
                    if (isTimeout(error)) throw error
                    result.ids.clear()
                    result.cards = 0
                    result.filtered = 0
                    const responsive = await readCardsInfoInventory(candidates, canonical, result, errors, progress, signal)
                    if (!responsive) return result
                    if (result.locationReadFailed && !result.complete) {
                        await readNumericInventoryWithoutLocations(candidates, result, progress, signal)
                    }
                }
                const current = new Set(checkedIds(await auditRead('findCards', { query }, signal), 'findCards'))
                if (current.size !== candidates.length || candidates.some(id => !current.has(id))) {
                    result.complete = false
                    result.changed = true
                    errors.push('Anki deck membership changed during the audit. Recheck to refresh the result.')
                } else result.numericSearch = result.complete
                return result
            }
        }
        const query = exactNamedDeckQuery(canonical)
        if (query === undefined) {
            errors.push('This exact deck name requires numeric deck search. Check AnkiConnect and recheck the deck.')
            return result
        }
        const cards = checkedIds(await auditRead('findCards', { query }, signal), 'findCards')
        await readCardsInfoInventory(cards, canonical, result, errors, progress, signal)
        result.namedSearch = result.complete
    } catch (error) {
        checkAbort(signal)
        result.changed = result.complete
        result.complete = false
        errors.push(`Anki deck inventory: ${String(error)}`)
    }
    return result
}

export async function readSyncAuditNoteInventory(deck: string, signal?: AbortSignal): Promise<ReadonlySet<number> | undefined> {
    const inventory = await readDeckInventory(deck, [], undefined, signal)
    return inventory.complete && inventory.exists ? inventory.ids : undefined
}

async function detectPhysicalDeckKind(card: number | undefined, result: AnkiDeckInventory, signal?: AbortSignal): Promise<void> {
    if (card === undefined || result.kind !== undefined) return
    try {
        result.kind = (await findFilteredAnkiCards([card], studyRead(signal))).has(card) ? 'filtered' : 'ordinary'
    } catch { checkAbort(signal) }
}

async function readNumericInventoryWithoutLocations(cards: readonly number[], result: AnkiDeckInventory,
    progress?: Progress, signal?: AbortSignal): Promise<void> {
    result.ids.clear()
    result.cards = 0
    result.filtered = 0
    for (let offset = 0; offset < cards.length; offset += batchSize) {
        const batch = cards.slice(offset, offset + batchSize)
        const notes = checkedIds(await auditRead('cardsToNotes', { cards: batch }, signal), 'cardsToNotes')
        if (!notes.length || notes.length > batch.length) throw new Error('cardsToNotes: invalid number of notes')
        const filtered = result.kind === 'filtered' ? batch.length : (await findFilteredAnkiCards(batch, studyRead(signal))).size
        for (const id of notes) result.ids.add(id)
        result.cards += batch.length
        result.filtered += filtered
        progress?.({ phase: 'decks', completed: offset + batch.length, total: cards.length })
    }
    result.complete = true
}

type AuditBundleAction = { action: 'getDecks' | 'cardsToNotes'; cards: readonly number[] } |
    { action: 'findNotes'; query: string }

interface AuditBundleRow {
    result: unknown
    error: unknown
}

async function readAuditBundle(actions: readonly AuditBundleAction[], signal?: AbortSignal): Promise<AuditBundleRow[] | null> {
    try {
        const response = await auditRead('multi', {
            actions: actions.map(request => ({ action: request.action, version: 6,
                params: request.action === 'findNotes' ? { query: request.query } : { cards: request.cards } })),
        }, signal)
        if (!Array.isArray(response) || response.length !== actions.length) return null
        const valid = (row: unknown): row is AuditBundleRow => isRecord(row) && 'result' in row && 'error' in row
        return response.every(valid) ? response : null
    } catch (error) {
        checkAbort(signal)
        if (isTimeout(error)) throw error
        return null
    }
}

async function readLightweightInventory(
    cards: readonly number[], canonical: string, result: AnkiDeckInventory, progress?: Progress, signal?: AbortSignal,
): Promise<void> {
    progress?.({ phase: 'decks', completed: 0, total: cards.length })
    let useMulti = true
    for (let offset = 0; offset < cards.length; offset += batchSize) {
        const batch = cards.slice(offset, offset + batchSize)
        const requested = new Set(batch)
        const displaced: number[] = []
        let direct: number | undefined
        const bundle = useMulti ? await readAuditBundle([
            { action: 'getDecks', cards: batch }, { action: 'cardsToNotes', cards: batch },
        ], signal) : null
        useMulti = !!bundle && bundle.every(row => row.error === null)
        const response = bundle && useMulti ? bundle[0].result : await auditRead('getDecks', { cards: batch }, signal)
        if (!isRecord(response)) throw new Error('getDecks: expected card IDs grouped by deck')
        for (const [name, ids] of Object.entries(response)) {
            if (!name || !Array.isArray(ids)) throw new Error('getDecks: invalid deck or ID list')
            const outside = !sameDeck(name, canonical)
            for (const id of ids) {
                if (!isId(id) || !requested.delete(id)) throw new Error('getDecks: unexpected or repeated card ID')
                if (outside) displaced.push(id)
                else direct ??= id
            }
        }
        if (requested.size) throw new Error('getDecks: card deck unavailable')
        await detectPhysicalDeckKind(direct, result, signal)
        if (result.kind === 'filtered' && displaced.length) throw new Error('getDecks: filtered deck membership changed')
        const filtered = await findFilteredAnkiCards(displaced, studyRead(signal))
        if (filtered.size !== displaced.length) throw new Error('getDecks: searched card appeared outside its deck')
        const notes = checkedIds(bundle && useMulti ? bundle[1].result : await auditRead('cardsToNotes', { cards: batch }, signal), 'cardsToNotes')
        if (!notes.length || notes.length > batch.length) throw new Error('cardsToNotes: invalid number of notes')
        for (const id of notes) result.ids.add(id)
        result.cards += batch.length
        result.filtered += result.kind === 'filtered' ? batch.length : filtered.size
        progress?.({ phase: 'decks', completed: offset + batch.length, total: cards.length })
    }
    result.complete = true
}

async function readCardsInfoInventory(
    cards: readonly number[], canonical: string, result: AnkiDeckInventory, errors: string[],
    progress?: Progress, signal?: AbortSignal,
): Promise<boolean> {
    result.complete = true
    if (cards.length) progress?.({ phase: 'decks', completed: 0, total: cards.length })
    for (let offset = 0; offset < cards.length; offset += batchSize) {
        const batch = cards.slice(offset, offset + batchSize)
        const requested = new Set(batch)
        try {
            const response = await auditRead('cardsInfo', { cards: batch }, signal).catch(error => {
                result.locationReadFailed = true
                throw error
            })
            checkAbort(signal)
            if (!Array.isArray(response)) throw new Error('expected an array of cards')
            const rows = new Map<number, { note: number; deck: string }>()
            const uncertain = new Set<number>()
            for (const row of response) {
                if (!isRecord(row) || !isId(row.cardId) || !requested.has(row.cardId)) {
                    result.complete = false
                    errors.push('cardsInfo: unexpected card in deck inventory response')
                    continue
                }
                if (rows.has(row.cardId) || !isId(row.note) || typeof row.deckName !== 'string' || !row.deckName) {
                    rows.delete(row.cardId)
                    uncertain.add(row.cardId)
                } else if (!uncertain.has(row.cardId)) {
                    rows.set(row.cardId, { note: row.note, deck: row.deckName })
                }
            }
            if (rows.size !== batch.length) {
                result.complete = false
                errors.push(`cardsInfo: unavailable or ambiguous deck and note for ${batch.length - rows.size} cards`)
            }
            const direct = [...rows].find(([, item]) => sameDeck(item.deck, canonical))?.[0]
            await detectPhysicalDeckKind(direct, result, signal)
            const displaced = [...rows].filter(([, item]) => !sameDeck(item.deck, canonical)).map(([id]) => id)
            const filtered = result.kind === 'filtered' ? new Set<number>() :
                await findFilteredAnkiCards(displaced, studyRead(signal))
            if (filtered.size !== displaced.length) {
                result.complete = false
                errors.push('cardsInfo: a searched card appeared outside its deck')
            }
            for (const [id, item] of rows) {
                if (sameDeck(item.deck, canonical) || filtered.has(id)) {
                    result.ids.add(item.note)
                    result.cards++
                    if (result.kind === 'filtered' || filtered.has(id)) result.filtered++
                }
            }
        } catch (error) {
            checkAbort(signal)
            result.complete = false
            errors.push(`cardsInfo: deck inventory cards ${offset + 1}–${offset + batch.length} of ${cards.length}: ${String(error)}`)
            if (isTimeout(error)) return false
        }
        progress?.({ phase: 'decks', completed: offset + batch.length, total: cards.length })
    }
    return true
}

export async function checkAnkiNoteExistence(ids: readonly number[], errors: string[], signal?: AbortSignal,
    onLookup?: () => void): Promise<Map<number, boolean>> {
    const result = new Map<number, boolean>()
    let useMulti = true
    let grouped: AuditBundleRow[] = []
    for (let offset = 0; offset < ids.length; offset += batchSize) {
        checkAbort(signal)
        const batch = ids.slice(offset, offset + batchSize)
        const requested = new Set(batch)
        try {
            if (useMulti && !grouped.length && ids.length - offset > batchSize) {
                const actions: AuditBundleAction[] = []
                const end = Math.min(offset + batchSize * readBatchesPerRequest, ids.length)
                for (let index = offset; index < end; index += batchSize) {
                    actions.push({ action: 'findNotes', query: `nid:${ids.slice(index, index + batchSize).join(',')}` })
                }
                onLookup?.()
                grouped = await readAuditBundle(actions, signal) ?? []
                useMulti = grouped.length > 0 && grouped.every(row => row.error === null)
            }
            const row = grouped.shift()
            if (row?.error !== null) onLookup?.()
            const response = row?.error === null ? row.result : await auditRead('findNotes', { query: `nid:${batch.join(',')}` }, signal)
            const returned = checkedIds(response, 'findNotes')
            if (returned.some(id => !requested.has(id))) throw new Error('unexpected note IDs in response')
            const found = new Set(returned)
            for (const id of batch) result.set(id, found.has(id))
        } catch (error) {
            checkAbort(signal)
            errors.push(`findNotes: note existence ${offset + 1}–${offset + batch.length} of ${ids.length}: ${String(error)}`)
            if (isTimeout(error)) break
        }
    }
    return result
}

export async function checkWarmAnkiNoteExistence(ids: readonly number[], errors: string[], signal?: AbortSignal,
    onLookup?: () => void): Promise<Map<number, boolean>> {
    if (ids.length < batchSize * 8 || ids.length > 30_000) return checkAnkiNoteExistence(ids, errors, signal, onLookup)
    let present: Set<number> | undefined
    try {
        onLookup?.()
        const response = await auditRead('findNotes', { query: '' }, signal, 5_000)
        checkAbort(signal)
        if (Array.isArray(response) && response.length <= 30_000) present = new Set(checkedIds(response, 'findNotes'))
    } catch {
        checkAbort(signal)
    }
    if (!present) return checkAnkiNoteExistence(ids, errors, signal, onLookup)

    const missing = ids.filter(id => !present.has(id))
    if (missing.length === ids.length) return checkAnkiNoteExistence(ids, errors, signal, onLookup)
    const result = new Map<number, boolean>()
    for (const id of ids) if (present.has(id)) result.set(id, true)
    const verified = await checkAnkiNoteExistence(missing, errors, signal, onLookup)
    for (const [id, exists] of verified) result.set(id, exists)
    return result
}

export async function runSyncAudit(
    input: SyncAuditInput, onProgress?: Progress, signal?: AbortSignal,
): Promise<SyncAuditResult> {
    checkAbort(signal)
    const { deck } = input
    const deckKey = syncAuditDeckKey(deck)
    const validDeck = deck.trim() !== ''
    const ankiErrors: string[] = []
    onProgress?.({ phase: 'ids', completed: 0, total: 1 })
    const inventory = await readDeckInventory(deck, ankiErrors, onProgress, signal)
    const ankiIds = inventory.ids
    const inScope = (item: { id?: number; assignedDeck?: string; inExportScope?: boolean; expected?: SyncAuditExpected }): boolean => {
        if (item.inExportScope === false) return false
        if (inventory.kind === 'filtered') return item.id !== undefined && ankiIds.has(item.id)
        const assigned = item.assignedDeck ?? item.expected?.deck
        return validDeck && assigned !== undefined && syncAuditDeckKey(assigned) === deckKey
    }
    const byId = new Map<number, SyncAuditSource[]>()
    for (const source of input.sources) {
        if (!isId(source.id)) throw new Error(`${source.path}: invalid Anki ID ${source.id}`)
        const group = byId.get(source.id)
        if (group) group.push(source)
        else byId.set(source.id, [source])
    }
    const duplicateIds = Array.from(input.duplicateIds ?? [])
    if (!input.duplicateIds) {
        for (const [id, occurrences] of byId) {
            if (occurrences.length > 1) duplicateIds.push({ id, occurrences: occurrences.map(location) })
        }
    }
    duplicateIds.sort((left, right) => left.id - right.id)
    const conflictingIds = new Set(duplicateIds.map(group => group.id))
    const scopedById = new Map<number, SyncAuditSource[]>()
    let scopedReferenceCount = 0
    for (const [id, occurrences] of byId) {
        const scoped = occurrences.filter(inScope)
        if (!scoped.length) continue
        scopedById.set(id, scoped)
        scopedReferenceCount += scoped.length
    }
    const scopedIds = Array.from(scopedById.keys()).sort((left, right) => left - right)
    const unlinked = (input.unlinked ?? []).filter(inScope)
    const pending = input.pendingDeletions ?? []
    const unparsed = input.unparsedIds ?? []
    const result: SyncAuditResult = {
        startedAt: new Date().toISOString(),
        vaultName: input.vaultName,
        deck,
        folderProfile: input.folderProfile,
        ankiDeckKind: inventory.kind,
        ankiInventoryComplete: false,
        vaultInventoryComplete: !(input.fileErrors?.length),
        counts: {
            filesScanned: input.filesScanned,
            vaultReferences: scopedReferenceCount,
            vaultIds: scopedIds.length, ankiNotes: 0, ankiCards: 0, ankiFilteredCards: 0, matchedIds: 0,
            duplicateIds: duplicateIds.length,
            obsidianOnlyIds: 0, ankiOnlyIds: 0, comparisonCandidates: 0, comparedIds: 0,
            differenceIds: 0, unlinkedNotes: unlinked.reduce((sum, group) => sum + group.count, 0),
            pendingDeletions: 0, unparsedIds: 0,
        },
        duplicateIds, obsidianOnly: [], ankiOnly: [], unverifiedSourceIds: [], outsideAnkiDeck: [], outsideObsidianScope: [],
        differences: [], filteredCards: [], deckAssignments: groupDeckAssignments(input),
        fileErrors: Array.from(input.fileErrors ?? []), ankiErrors, unlinked,
        pendingDeletions: [], unparsedIds: [],
    }

    result.ankiDeckExists = inventory.exists
    result.counts.ankiCards = inventory.cards
    result.counts.ankiFilteredCards = inventory.filtered
    result.counts.ankiNotes = ankiIds.size
    if (inventory.names) {
        const names = new Map(inventory.names.map(name => [syncAuditDeckKey(name), name]))
        for (const group of result.deckAssignments) group.deck = names.get(syncAuditDeckKey(group.deck)) ?? group.deck
        result.deckAssignments.sort((left, right) => left.deck.localeCompare(right.deck))
    }
    const missing = scopedIds.filter(id => !ankiIds.has(id))
    const existence = await checkAnkiNoteExistence(missing, result.ankiErrors, signal)
    result.ankiInventoryComplete = inventory.complete && existence.size === missing.length

    const inScopeOrAnki = (item: SyncAuditSource) => inScope(item) || ankiIds.has(item.id)
    result.pendingDeletions = pending.filter(inScopeOrAnki).map(location)
    result.unparsedIds = unparsed.filter(inScopeOrAnki).map(location)
    result.counts.pendingDeletions = result.pendingDeletions.length
    result.counts.unparsedIds = result.unparsedIds.length
    onProgress?.({ phase: 'ids', completed: 1, total: 1 })

    const expected = new Map<number, SyncAuditSource>()
    const indexedRows: AuditCardRow[] = []
    const indexedById = new Map<number, AuditCardRow>()
    const outside = new Map<number, SyncAuditGroup>()
    for (const id of scopedIds) {
        const occurrences = scopedById.get(id)!
        if (ankiIds.has(id)) {
            result.counts.matchedIds++
            for (const source of occurrences) {
                const row = auditLinkedRow(source, conflictingIds.has(id) ? 'duplicate' : 'unverified')
                indexedRows.push(row)
                indexedById.set(id, row)
            }
            if (!conflictingIds.has(id) && byId.get(id)!.length === 1 && occurrences[0].expected) expected.set(id, occurrences[0])
        } else if (existence.get(id) === false) {
            result.obsidianOnly.push({ id, occurrences: occurrences.map(location) })
        } else if (existence.get(id) === true && !inventory.changed) {
            outside.set(id, { id, occurrences: occurrences.map(location) })
        } else {
            for (const source of occurrences) indexedRows.push(auditLinkedRow(source, 'unverified'))
        }
    }
    const unresolvedIds = new Set<number>()
    for (const item of pending) unresolvedIds.add(item.id)
    for (const item of unparsed) unresolvedIds.add(item.id)
    const ankiOnly = new Map<number, SyncAuditAnkiOnly>()
    const unmatched = Array.from(ankiIds).filter(id => !scopedById.has(id)).sort((left, right) => left - right)
    for (const id of unmatched) {
        const known = byId.get(id)
        if (known) {
            result.outsideObsidianScope.push({ id, occurrences: known.map(location) })
            continue
        }
        if (unresolvedIds.has(id)) continue
        if (result.vaultInventoryComplete) ankiOnly.set(id, { id, markers: [], metadataAvailable: false })
        else result.unverifiedSourceIds.push(id)
    }
    result.ankiOnly = Array.from(ankiOnly.values())
    result.counts.obsidianOnlyIds = result.obsidianOnly.length
    result.counts.ankiOnlyIds = result.ankiOnly.length
    result.counts.comparisonCandidates = expected.size

    const comparisons: Comparison[] = []
    const tags = indexTags([input.exportTag])
    const outsideComparisons = new Map<number, Comparison>()
    const details = [...expected.keys(), ...ankiOnly.keys(), ...outside.keys()]
    if (details.length) onProgress?.({ phase: 'details', completed: 0, total: details.length })
    const canReadDecks = await readDetails(details, (id, snapshot) => {
        const source = expected.get(id)
        if (source) {
            const comparison = compareNote(source, snapshot)
            if (!comparison.difference.complete) result.ankiErrors.push(`notesInfo: invalid card list for note ${id}`)
            comparisons.push(comparison)
        } else if (outside.has(id)) {
            const comparison = compareNote(outside.get(id)!.occurrences[0], snapshot, deck)
            if (!comparison.difference.complete) result.ankiErrors.push(`notesInfo: invalid card list for note ${id}`)
            outsideComparisons.set(id, comparison)
        } else {
            const row = ankiOnly.get(id)!
            row.modelName = snapshot.modelName
            row.metadataAvailable = true
            if (Array.from(indexTags(snapshot.tags).keys()).some(tag => tags.has(tag))) row.markers.push('configured-tag')
            if (hasVaultLink(snapshot.fields, input.vaultName)) row.markers.push('vault-link')
        }
    }, result.ankiErrors, onProgress, signal, input.linkedDetails)
    const allComparisons = [...comparisons, ...outsideComparisons.values()]
    if (canReadDecks) await compareDecks(allComparisons, inventory, deck, result.ankiErrors, onProgress, signal)
    else for (const comparison of allComparisons) if (comparison.cards.length) comparison.difference.complete = false
    checkAbort(signal)
    const membership = (comparison: Comparison) => Array.from(comparison.actualDecks).some(name => syncAuditDeckKey(name) === deckKey)
    const initialInventoryComplete = result.ankiInventoryComplete
    for (const [id, group] of outside) {
        const comparison = outsideComparisons.get(id)
        if (comparison) result.filteredCards.push(...comparison.filteredCards)
        if (comparison?.unknownHome) {
            result.ankiInventoryComplete = false
            continue
        }
        if (comparison && membership(comparison)) {
            result.ankiInventoryComplete = false
            result.ankiErrors.push(`Anki deck membership changed for note ${id} during the audit. Recheck to refresh the result.`)
            continue
        }
        const complete = comparison?.difference.complete ?? false
        if (initialInventoryComplete || complete) {
            result.outsideAnkiDeck.push({ ...group, deckDetailsComplete: complete,
                actualDecks: comparison ? Array.from(comparison.actualDecks).sort() : [] })
        }
    }
    for (const comparison of comparisons) {
        const { difference } = comparison
        if (difference.complete && !membership(comparison)) {
            difference.complete = false
            result.ankiInventoryComplete = false
            result.ankiErrors.push(`Anki deck membership changed for note ${difference.id} during the audit. Recheck to refresh the result.`)
        }
        if (difference.complete) result.counts.comparedIds++
        if (comparison.unknownHome) result.ankiInventoryComplete = false
        result.filteredCards.push(...comparison.filteredCards)
        const differs = difference.model || difference.fields.length || difference.missingTags.length ||
            difference.extraTags.length || difference.decks.length
        if (differs) result.differences.push(difference)
        const row = indexedById.get(difference.id)
        if (row && difference.complete && !comparison.unknownHome) row.status = differs ? 'different' : 'same'
    }
    rememberAuditLinkedRows(result, indexedRows)
    result.counts.differenceIds = result.differences.length
    if (inventory.kind === 'filtered' && result.ankiInventoryComplete) rememberAttachmentDeckMembers(result, ankiIds)
    return result
}
