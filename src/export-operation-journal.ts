/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import type { AnkiConnectRequest } from './anki'
import { Md5 } from 'ts-md5'
import { hasPendingAnkiWrite, isDefiniteAddNoteRejection, pendingAnkiWriteMessage, withAnkiWriteDeadline } from './anki-transport'
import { checkPinnedAnkiProfile, requireExpectedAnkiProfile } from './anki-profile'
import { cardFieldHazards } from './anki-card-impact'
import { parseExistingNoteSnapshot, snapshotFields } from './anki-delta'
import type { ReviewedAnkiEvidence } from './anki-delta'
import { hasPendingBidirectionalWrite, pendingBidirectionalWriteMessage } from './bidirectional-sync'
import { withFastScanReadLock } from './fast-scan'
import { oneWayFieldDigest, oneWayTagKey } from './oneway-history'
import type { OneWayReceipt } from './oneway-history'
import { ankiStudyDeckKey, isProtectedAnkiTag } from './anki-study-state'
import { auditRead } from './sync-audit'
import { isRecoveryTag } from './export-recovery'
import { ensureScheduledBackup } from './vault-backup'

type Storage = Pick<MyPlugin['app']['vault']['adapter'], 'exists' | 'read' | 'write'>
type Status = 'unknown' | 'confirmed' | 'failed'
type Kind = 'create' | 'fields' | 'add-tags' | 'remove-tags' | 'move' | 'delete'
type OriginalField = [name: string, value: string, writtenHash: string]
type UndoEvidence = { modelName: string; fields: OriginalField[] } | { modelName: string; tags: string[] }
export interface JournalSource {
    path: string
    deck?: string
}

export interface ExportOperation extends JournalSource {
    key: string
    profile: string
    at: string
    kind: Kind
    status: Status
    noteId?: number
    cardId?: number
    fields?: Array<[string, string]>
    tags?: string[]
    destination?: string
    recoveryTag?: string
    reason?: string
    undo?: UndoEvidence
    undoOf?: string
}

interface Snapshot {
    version: 1
    revision: number
    rows: ExportOperation[]
}

const kinds: readonly Kind[] = ['create', 'fields', 'add-tags', 'remove-tags', 'move', 'delete']
const statuses: readonly Status[] = ['unknown', 'confirmed', 'failed']
const finishedLimit = 1000
const queryBatch = 500
const maxUndoSize = 32_768
const maxStoredUndoSize = 512_000

function digest(value: string): string {
    return Md5.hashStr(value) as string
}

function id(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function object(row: unknown): row is Record<string, unknown> {
    return typeof row === 'object' && row !== null && !Array.isArray(row)
}

function optionalText(value: unknown): boolean {
    return value === undefined || typeof value === 'string'
}

function validTag(tag: unknown): tag is string {
    return typeof tag === 'string' && tag.length > 0 && !/\s/u.test(tag) && !isProtectedAnkiTag(oneWayTagKey(tag))
}

function hashString(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

function validUndo(row: Record<string, unknown>): boolean {
    if (row.undo === undefined) return true
    const undo = row.undo
    if (row.undoOf !== undefined || row.status !== 'confirmed' || !id(row.noteId) ||
        !object(undo) || typeof undo.modelName !== 'string' || !undo.modelName ||
        JSON.stringify(undo).length > maxUndoSize) return false
    if (row.kind === 'fields') {
        if (!Array.isArray(undo.fields) || !Array.isArray(row.fields) || !undo.fields.length ||
            undo.fields.length !== row.fields.length) return false
        return undo.fields.every((field, index) => Array.isArray(field) && field.length === 3 &&
            typeof field[0] === 'string' && field[0] === (row.fields as unknown[][])[index][0] &&
            typeof field[1] === 'string' && hashString(field[2]))
    }
    return (row.kind === 'add-tags' || row.kind === 'remove-tags') &&
        Array.isArray(undo.tags) && Array.isArray(row.tags) && undo.tags.length > 0 &&
        undo.tags.length === row.tags.length &&
        undo.tags.every((tag, index) => validTag(tag) && oneWayTagKey(tag) === (row.tags as unknown[])[index])
}

function validOperation(row: unknown): row is ExportOperation {
    return object(row) && typeof row.key === 'string' && typeof row.path === 'string' &&
        typeof row.profile === 'string' && typeof row.at === 'string' &&
        kinds.includes(row.kind as Kind) && statuses.includes(row.status as Status) &&
        optionalText(row.deck) && optionalText(row.destination) && optionalText(row.reason) &&
        (row.undoOf === undefined || typeof row.undoOf === 'string' && row.undoOf.length > 0 && row.undoOf !== row.key &&
            (row.kind === 'fields' || row.kind === 'add-tags' || row.kind === 'remove-tags') && id(row.noteId)) &&
        (row.recoveryTag === undefined || typeof row.recoveryTag === 'string' && isRecoveryTag(row.recoveryTag)) &&
        (row.noteId === undefined || id(row.noteId)) && (row.cardId === undefined || id(row.cardId)) &&
        (row.fields === undefined || Array.isArray(row.fields) && row.fields.every(pair =>
            Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' &&
            typeof pair[1] === 'string' && /^[0-9a-f]{32}$/.test(pair[1]))) &&
        (row.tags === undefined || Array.isArray(row.tags) && row.tags.every(tag => typeof tag === 'string')) && validUndo(row)
}

export function operationJournalPath({ app, manifest }: MyPlugin): string {
    const base = manifest.dir ?? `${app.vault.configDir}/plugins/${manifest.id}`
    return `${base}/export-operation-journal.json`
}

async function load(storage: Storage, path: string): Promise<Snapshot> {
    const candidates = await Promise.all([0, 1].map(async slot => {
        const file = `${path}.${slot}`
        if (!await storage.exists(file)) return undefined
        try {
            const raw: unknown = JSON.parse(await storage.read(file))
            if (!object(raw) || raw.version !== 1 || !id(raw.revision) || raw.revision % 2 !== slot ||
                !Array.isArray(raw.rows) || !raw.rows.every(validOperation) ||
                new Set(raw.rows.map(row => row.key)).size !== raw.rows.length) return null
            const snapshot: Snapshot = { version: 1, revision: raw.revision, rows: raw.rows }
            return raw.checksum === digest(JSON.stringify(snapshot)) ? snapshot : null
        } catch {
            return null
        }
    }))
    const valid = candidates.filter((value): value is Snapshot => value !== null && value !== undefined)
    if (!valid.length && candidates.includes(null)) throw new Error('The operation journal could not be verified.')
    return valid.reduce((latest, candidate) => candidate.revision > latest.revision ? candidate : latest,
        { version: 1, revision: 0, rows: [] })
}

async function store(storage: Storage, path: string, state: Snapshot): Promise<Snapshot> {
    const pending = state.rows.filter(row => row.status === 'unknown')
    const settled = state.rows.filter(row => row.status !== 'unknown').slice(-finishedLimit)
    const keep = new Set([...pending, ...settled])
    const rows = state.rows.filter(row => keep.has(row))
    let available = maxStoredUndoSize
    for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index]
        if (!row.undo) continue
        const length = JSON.stringify(row.undo).length
        if (length <= available) available -= length
        else {
            const { undo: _old, ...withoutUndo } = row
            rows[index] = withoutUndo
        }
    }
    const next: Snapshot = { version: 1, revision: state.revision + 1, rows }
    const raw = JSON.stringify({ ...next, checksum: digest(JSON.stringify(next)) })
    const slot = `${path}.${next.revision % 2}`
    await storage.write(slot, raw)
    if (await storage.read(slot) !== raw) throw new Error('The operation journal could not be saved and verified.')
    return next
}

function noteFields(fields: Record<string, string>): Array<[string, string]> {
    return Object.entries(fields).map(([name, value]) => [name, oneWayFieldDigest(value)])
}

type Target = Pick<ExportOperation, 'kind' | 'noteId' | 'cardId' | 'fields' | 'tags' | 'destination' | 'recoveryTag'>

function targets(request: AnkiConnectRequest): Target[] {
    switch (request.action) {
        case 'addNote':
            return [{ kind: 'create', destination: request.params.note.deckName,
                recoveryTag: request.params.note.tags.find(isRecoveryTag) }]
        case 'updateNoteFields':
            return [{ kind: 'fields', noteId: request.params.note.id, fields: noteFields(request.params.note.fields) }]
        case 'addTags':
        case 'removeTags': {
            const kind = request.action === 'addTags' ? 'add-tags' : 'remove-tags'
            const tags = request.params.tags.split(/\s+/u).map(oneWayTagKey).filter(Boolean)
            return request.params.notes.map(noteId => ({ kind, noteId, tags }))
        }
        case 'changeDeck':
            return request.params.cards.map(cardId => ({ kind: 'move', cardId, destination: request.params.deck }))
        case 'deleteNotes':
            return request.params.notes.map(noteId => ({ kind: 'delete', noteId }))
        default:
            return []
    }
}

function canReverseField(name: string, before: string, after: string): boolean {
    const populated = (value: string) => !!value.replace(/<[^>]*>|&nbsp;|&#160;/gi, '').trim()
    return populated(before) && populated(after) && cardFieldHazards(name, before, after).length === 0
}

function captureUndo(request: AnkiConnectRequest, row: ExportOperation,
    reviewed: readonly ReviewedAnkiEvidence[] | undefined): UndoEvidence | undefined {
    if (!row.noteId || !reviewed) return
    const trusted = reviewed.filter(note => note.id === row.noteId)
    if (trusted.length !== 1) return
    const { fields: before, modelName, presentTags, absentTags } = trusted[0]
    let undo: UndoEvidence
    if (request.action === 'updateNoteFields' && before) {
        const previous = new Map(before)
        const fields: OriginalField[] = []
        for (const [name, after] of Object.entries(request.params.note.fields)) {
            const original = previous.get(name)
            if (typeof after !== 'string' || original === undefined || !canReverseField(name, original, after)) return
            fields.push([name, original, digest(after)])
        }
        if (!fields.length) return
        undo = { modelName, fields }
    } else if (request.action === 'addTags' || request.action === 'removeTags') {
        const approved = new Set((request.action === 'addTags' ? absentTags : presentTags)?.map(oneWayTagKey))
        const tags = request.params.tags.split(/\s+/u).filter(Boolean)
        if (!tags.length || tags.some(tag => !validTag(tag) || !approved.has(oneWayTagKey(tag)))) return
        undo = { modelName, tags }
    } else return
    return JSON.stringify(undo).length <= maxUndoSize ? undo : undefined
}

export class ExportOperationJournal {
    private snapshot?: Snapshot
    private readonly packetRows = new Map<AnkiConnectRequest, ExportOperation[]>()
    private readonly currentKeys = new Set<string>()
    private readonly respondedKeys = new Set<string>()
    private readonly undoEvidence = new Map<string, UndoEvidence>()
    private readonly unsentKeys = new Set<string>()
    private changed = false

    constructor(private readonly storage: Storage, private readonly path: string, private readonly profile: string) {}

    private async state(): Promise<Snapshot> {
        return this.snapshot ??= await load(this.storage, this.path)
    }

    private async save(): Promise<void> {
        const state = await this.state()
        this.snapshot = await store(this.storage, this.path, { ...state, rows: state.rows.filter(row => !this.unsentKeys.has(row.key)) })
        this.unsentKeys.clear()
        this.changed = false
    }

    async prepare(packet: readonly AnkiConnectRequest[], sources: ReadonlyMap<AnkiConnectRequest, readonly JournalSource[]>,
        reviewed?: ReadonlyMap<AnkiConnectRequest, readonly ReviewedAnkiEvidence[]>): Promise<void> {
        const relevant = packet.flatMap(request => {
            const locations = sources.get(request)
            const wanted = locations?.length ? targets(request) : []
            return wanted.length && locations ? [{ request, locations, wanted }] : []
        })
        if (!relevant.length) return
        const state = await this.state()
        const at = new Date().toISOString()
        let sequence = 0
        for (const { request, locations, wanted } of relevant) {
            const rows: ExportOperation[] = []
            for (const source of locations) for (const target of wanted) {
                const key = `${state.revision + 1}:${++sequence}`
                const deck = target.kind === 'create' ? target.destination ?? source.deck : source.deck
                const row: ExportOperation = { ...target, ...source, deck, key, at, profile: this.profile, status: 'unknown' }
                const undo = captureUndo(request, row, reviewed?.get(request))
                if (undo) this.undoEvidence.set(key, undo)
                state.rows.push(row)
                this.currentKeys.add(key)
                rows.push(row)
            }
            this.packetRows.set(request, rows)
        }
        await this.save()
    }

    observe(request: AnkiConnectRequest, response: unknown, unsent: boolean): void {
        const rows = this.packetRows.get(request)
        if (!rows) return
        this.packetRows.delete(request)
        const moved = request.action === 'changeDeck' ? new Set(request.params.cards) : undefined
        for (const row of rows) {
            if (unsent || moved && row.cardId !== undefined && !moved.has(row.cardId)) {
                this.unsentKeys.add(row.key)
                this.currentKeys.delete(row.key)
                this.undoEvidence.delete(row.key)
                this.changed = true
                continue
            }
            if (!object(response)) {
                this.undoEvidence.delete(row.key)
                continue
            }
            if (response.error === null && 'result' in response && response.result !== undefined) {
                if (row.kind === 'create') {
                    if (!id(response.result)) continue
                    row.noteId = response.result
                    this.changed = true
                }
                this.respondedKeys.add(row.key)
            } else {
                this.undoEvidence.delete(row.key)
                if (row.kind === 'create' && isDefiniteAddNoteRejection(response.error)) {
                    row.status = 'failed'
                    row.reason = String(response.error).slice(0, 500)
                    this.changed = true
                }
            }
        }
    }

    async confirmFiles(paths: ReadonlySet<string>): Promise<void> {
        const state = this.snapshot
        if (!state) return
        for (const row of state.rows) {
            if (row.kind === 'delete' || row.status !== 'unknown' || !this.currentKeys.has(row.key) ||
                !paths.has(row.path) || !this.respondedKeys.has(row.key)) continue
            this.confirm(row)
        }
        if (this.changed) await this.save()
    }

    confirmReceipts(receipts: readonly OneWayReceipt[]): void {
        if (!this.snapshot || !receipts.length) return
        const byId = new Map(receipts.map(receipt => [receipt.id, receipt] as const))
        for (const row of this.snapshot.rows) {
            if (row.noteId === undefined || row.status !== 'unknown' || !this.respondedKeys.has(row.key)) continue
            const evidence = byId.get(row.noteId)
            if (!evidence) continue
            const fields = row.kind === 'fields' && row.fields?.length && row.fields.every(([name, expected]) => {
                const value = evidence.fields?.[name]
                return typeof value === 'string' && oneWayFieldDigest(value) === expected
            })
            const tags = row.kind === 'add-tags' ? evidence.matchedTags : row.kind === 'remove-tags' ? evidence.removedTags : undefined
            if (!fields && !(tags && row.tags?.length && row.tags.every(tag => tags.includes(tag)))) continue
            this.confirm(row)
        }
    }

    private confirm(row: ExportOperation): void {
        row.status = 'confirmed'
        const undo = this.undoEvidence.get(row.key)
        if (undo) row.undo = undo
        this.undoEvidence.delete(row.key)
        this.changed = true
    }

    async confirmCreationLinks(links: readonly { path: string; noteId: number; tag: string }[]): Promise<void> {
        if (!links.length) return
        const state = await this.state()
        const byTag = new Map<string, ExportOperation | null>()
        for (const row of state.rows) {
            if (row.kind === 'create' && row.status === 'unknown' && row.profile === this.profile && row.recoveryTag) {
                byTag.set(row.recoveryTag, byTag.has(row.recoveryTag) ? null : row)
            }
        }
        for (const { tag, noteId, path } of links) {
            const row = byTag.get(tag)
            if (!row || !id(noteId) || row.noteId !== undefined && row.noteId !== noteId) continue
            Object.assign(row, { noteId, path, status: 'confirmed' })
            byTag.delete(tag)
            this.changed = true
        }
    }
}

export async function readExportOperations(plugin: MyPlugin, deck?: string): Promise<readonly ExportOperation[]> {
    const { rows } = await load(plugin.app.vault.adapter, operationJournalPath(plugin))
    const deckKey = deck ? ankiStudyDeckKey(deck) : undefined
    return rows.filter(row => !deckKey || row.deck && ankiStudyDeckKey(row.deck) === deckKey).reverse()
}

type UndoKind = 'fields' | 'add-tags' | 'remove-tags'
type RevertibleOperation = ExportOperation & { noteId: number; undo: UndoEvidence; kind: UndoKind }

function isRevertible(row: ExportOperation): row is RevertibleOperation {
    return row.status === 'confirmed' && id(row.noteId) && row.undo !== undefined && row.undoOf === undefined &&
        (row.kind === 'fields' || row.kind === 'add-tags' || row.kind === 'remove-tags')
}

export function canOfferExportUndo(row: ExportOperation, rows: readonly ExportOperation[]): boolean {
    return isRevertible(row) && !rows.some(later => later.undoOf === row.key && later.status !== 'failed')
}

export interface ExportUndoPlan {
    key: string
    noteId: number
    profile: string
    changes: readonly { name: string; current: string; previous: string }[]
    cardIds: readonly number[]
    fingerprint: string
}

const unavailableUndo = 'This operation cannot be undone from the journal.'
const outdatedUndo = 'Anki or the journal changed after confirmation. Review the operation again.'
const uncertainUndo = 'Anki did not confirm the undo. Check the journal before trying another operation.'

function resolveUndoRow(state: Snapshot, key: string): RevertibleOperation {
    const index = state.rows.findIndex(row => row.key === key)
    const row = state.rows[index]
    if (!row || !isRevertible(row)) throw new Error(unavailableUndo)
    const names = new Set(row.fields?.map(([name]) => name) ?? row.tags)
    for (let offset = index + 1; offset < state.rows.length; offset++) {
        const later = state.rows[offset]
        if (later.status === 'failed' || later.profile !== row.profile || later.noteId !== row.noteId) continue
        if (later.undoOf === key || later.kind === 'delete' || later.kind === 'create' ||
            (row.kind === 'fields' ? later.fields?.some(([name]) => names.has(name)) :
                later.tags?.some(tag => names.has(tag)))) throw new Error(outdatedUndo)
    }
    return row
}

async function readUndoNote(noteId: number, modelName: string) {
    const raw = await auditRead('notesInfo', { notes: [noteId] })
    const value = Array.isArray(raw) && raw.length === 1 && object(raw[0]) && raw[0].noteId === noteId ? raw[0] : undefined
    const note = parseExistingNoteSnapshot(value)
    if (!note || note.modelName !== modelName) throw new Error(outdatedUndo)
    const tags = new Map<string, string>()
    for (const tag of note.tags) {
        const key = oneWayTagKey(tag)
        if (tags.has(key)) throw new Error(outdatedUndo)
        tags.set(key, tag)
    }
    return { fields: new Map(snapshotFields(note)), tags, cards: [...note.cards].sort((a, b) => a - b) }
}

async function buildUndoPlan(row: RevertibleOperation): Promise<ExportUndoPlan> {
    const note = await readUndoNote(row.noteId, row.undo.modelName)
    const changes: { name: string; current: string; previous: string }[] = []
    if ('fields' in row.undo) {
        for (const [name, previous, written] of row.undo.fields) {
            const current = note.fields.get(name)
            if (current === undefined || digest(current) !== written || !canReverseField(name, current, previous)) {
                throw new Error(outdatedUndo)
            }
            changes.push({ name, current, previous })
        }
    } else {
        for (const tag of row.undo.tags) {
            const current = note.tags.get(oneWayTagKey(tag))
            if (current !== (row.kind === 'add-tags' ? tag : undefined)) throw new Error(outdatedUndo)
            changes.push({ name: tag, current: current ?? '', previous: current ? '' : tag })
        }
    }
    const fingerprint = digest(JSON.stringify([row, changes, note.cards]))
    return { key: row.key, noteId: row.noteId, profile: row.profile, changes, cardIds: note.cards, fingerprint }
}

function assertNoPendingWrites(plugin: MyPlugin): void {
    if (hasPendingAnkiWrite(plugin.app)) throw new Error(pendingAnkiWriteMessage)
    if (hasPendingBidirectionalWrite(plugin.app)) throw new Error(pendingBidirectionalWriteMessage)
}

export function previewExportUndo(plugin: MyPlugin, key: string): Promise<ExportUndoPlan> {
    return withFastScanReadLock(plugin, async () => {
        assertNoPendingWrites(plugin)
        const state = await load(plugin.app.vault.adapter, operationJournalPath(plugin))
        const row = resolveUndoRow(state, key)
        await requireExpectedAnkiProfile(plugin, row.profile)
        const plan = await buildUndoPlan(row)
        await requireExpectedAnkiProfile(plugin, row.profile)
        return plan
    })
}

function undoRequest(row: RevertibleOperation): AnkiConnectRequest {
    if ('fields' in row.undo) {
        return AnkiConnect.updateNoteFields(row.noteId, Object.fromEntries(row.undo.fields.map(([name, value]) => [name, value])))
    }
    const tags = row.undo.tags.join(' ')
    return row.kind === 'add-tags' ? AnkiConnect.removeTags([row.noteId], tags) : AnkiConnect.addTags([row.noteId], tags)
}

async function ensureJournalCurrent(storage: Storage, path: string, expected: Snapshot): Promise<void> {
    if (JSON.stringify(await load(storage, path)) !== JSON.stringify(expected)) throw new Error(outdatedUndo)
}

export function applyExportUndo(plugin: MyPlugin, plan: ExportUndoPlan): Promise<void> {
    return withFastScanReadLock(plugin, async () => {
        assertNoPendingWrites(plugin)
        const storage = plugin.app.vault.adapter
        const path = operationJournalPath(plugin)
        const state = await load(storage, path)
        const original = resolveUndoRow(state, plan.key)
        const verify = async () => {
            await requireExpectedAnkiProfile(plugin, original.profile)
            const current = await buildUndoPlan(original)
            if (current.fingerprint !== plan.fingerprint) throw new Error(outdatedUndo)
            return current
        }
        await verify()
        await ensureScheduledBackup(plugin, original.profile)
        await requireExpectedAnkiProfile(plugin, original.profile)
        await ensureJournalCurrent(storage, path, state)
        const request = undoRequest(original)
        const inverse: ExportOperation = { ...targets(request)[0], path: original.path, deck: original.deck,
            profile: original.profile, at: new Date().toISOString(), key: `${state.revision + 1}:1`,
            status: 'unknown', undoOf: original.key }
        const pending = await store(storage, path, { ...state, rows: [...state.rows, inverse] })
        let sent = false
        try {
            if (original.kind === 'fields') {
                const selected = await auditRead('guiSelectedNotes', {})
                if (!Array.isArray(selected) || !selected.every(id) || selected.includes(original.noteId)) {
                    throw new Error('Close Anki Browse for this note and review the operation again.')
                }
            }
            const before = await verify()
            await requireExpectedAnkiProfile(plugin, original.profile)
            const response: unknown = await withAnkiWriteDeadline(plugin.app, () => {
                sent = true
                return AnkiConnect.invoke('multi', { actions: [request] })
            }, 'AnkiConnect undo')
            if (!Array.isArray(response) || response.length !== 1 || !object(response[0]) ||
                response[0].error !== null || response[0].result !== null) throw new Error(uncertainUndo)
            const current = await readUndoNote(original.noteId, original.undo.modelName)
            const restored = 'fields' in original.undo
                ? original.undo.fields.every(([name, previous]) => current.fields.get(name) === previous)
                : original.undo.tags.every(tag => current.tags.get(oneWayTagKey(tag)) === (original.kind === 'add-tags' ? undefined : tag))
            if (!restored || current.cards.length !== before.cardIds.length ||
                current.cards.some((card, index) => card !== before.cardIds[index])) throw new Error(uncertainUndo)
            await requireExpectedAnkiProfile(plugin, original.profile)
            await ensureJournalCurrent(storage, path, pending)
            await store(storage, path, { ...pending, rows: pending.rows.map(row => row.key === inverse.key
                ? { ...row, status: 'confirmed' } : row) })
        } catch (error) {
            if (sent) {
                throw new Error(uncertainUndo)
            }
            await ensureJournalCurrent(storage, path, pending)
            await store(storage, path, { ...pending, rows: pending.rows.map(row => row.key === inverse.key
                ? { ...row, status: 'failed', reason: 'Undo was not sent.' } : row) })
            throw error
        }
    })
}

export async function checkExportOperations(rows: readonly ExportOperation[], profile: string): Promise<ReadonlySet<string>> {
    const candidates = rows.filter(row => row.profile === profile && row.status === 'unknown' && row.kind !== 'create')
    if (!candidates.length) return new Set()
    await checkPinnedAnkiProfile(profile)
    const matched = new Set<string>()
    const noteRows = candidates.filter(row => row.noteId !== undefined && row.kind !== 'delete')
    const noteIds = [...new Set(noteRows.map(row => row.noteId!))]
    const notes = new Map<number, Record<string, unknown>>()
    for (let offset = 0; offset < noteIds.length; offset += queryBatch) {
        const batch = noteIds.slice(offset, offset + queryBatch)
        const requested = new Set(batch)
        const raw = await auditRead('notesInfo', { notes: batch })
        if (!Array.isArray(raw)) throw new Error('Anki did not return a valid note list.')
        for (const item of raw) {
            if (object(item) && !Object.keys(item).length) continue
            if (!object(item) || !id(item.noteId) || !requested.delete(item.noteId)) {
                throw new Error('Anki returned an unexpected or repeated note.')
            }
            notes.set(item.noteId, item)
        }
    }
    for (const row of noteRows) {
        const result = notes.get(row.noteId!)
        if (!result) continue
        if (row.kind === 'fields' && row.fields?.length && object(result.fields)) {
            const fields = result.fields
            if (row.fields.every(([name, hash]) => {
                const field = fields[name]
                return object(field) && typeof field.value === 'string' && oneWayFieldDigest(field.value) === hash
            })) matched.add(row.key)
        }
        if ((row.kind === 'add-tags' || row.kind === 'remove-tags') && row.tags?.length &&
            Array.isArray(result.tags) && result.tags.every(value => typeof value === 'string')) {
            const tags = new Set(result.tags.map(oneWayTagKey))
            if (row.tags.every(tag => tags.has(tag) === (row.kind === 'add-tags'))) matched.add(row.key)
        }
    }
    const deletes = candidates.filter(row => row.kind === 'delete' && row.noteId !== undefined)
    for (let offset = 0; offset < deletes.length; offset += queryBatch) {
        const batch = deletes.slice(offset, offset + queryBatch)
        const queryIds = new Set(batch.map(row => row.noteId!))
        const raw = await auditRead('findNotes', { query: `nid:${[...queryIds].join(',')}` })
        if (!Array.isArray(raw) || !raw.every(value => id(value) && queryIds.has(value)) ||
            new Set(raw).size !== raw.length) throw new Error('Anki returned an invalid deletion check.')
        const present = new Set(raw)
        for (const row of batch) if (!present.has(row.noteId)) matched.add(row.key)
    }
    const moves = candidates.filter(row => row.kind === 'move' && row.cardId !== undefined && row.destination)
    for (let offset = 0; offset < moves.length; offset += queryBatch) {
        const batch = moves.slice(offset, offset + queryBatch)
        const wanted = new Set(batch.map(row => row.cardId!))
        const raw = await auditRead('getDecks', { cards: [...wanted] })
        if (!object(raw)) throw new Error('Anki returned an invalid deck check.')
        const current = new Map<number, string>()
        for (const [deck, ids] of Object.entries(raw)) {
            if (!Array.isArray(ids) || !ids.every((card: unknown): card is number => id(card) && wanted.delete(card))) {
                throw new Error('Anki returned unexpected or repeated card locations.')
            }
            for (const card of ids) current.set(card, deck)
        }
        for (const row of batch) if (ankiStudyDeckKey(current.get(row.cardId!) ?? '') === ankiStudyDeckKey(row.destination!)) matched.add(row.key)
    }
    await checkPinnedAnkiProfile(profile)
    return matched
}
