/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Md5 } from 'ts-md5'
import { isProtectedAnkiTag } from './anki-study-state'
import { isBidirectionalFieldName } from './bidirectional-fields'
import type { BidirectionalFieldDirection } from './bidirectional-fields'

import { validSuspendBase } from './suspend-merge'
import type { SuspendBase } from './suspend-merge'

export interface SyncValue {
    front: string
    back: string
    tags: string[]
    extra?: Record<string, string>
}

export type PairBases = Partial<Record<'front' | 'back', string | null>>

export type SyncField = 'front' | 'back' | 'tags'
export type SyncChangeField = SyncField | `extra:${string}`
export type SyncChoices = Partial<Record<SyncChangeField, 'obsidian' | 'anki'>>
export type SyncBacklinks = readonly [front: string | null, back: string | null]

export interface PendingSync {
    skipped?: SyncChangeField[]
    targetSourceSuffixes?: Record<string, string>
    obsidian: SyncValue
    anki: SyncValue
    target: SyncValue
    sourceSuffixes?: Record<string, string>
    ankiBacklinks?: SyncBacklinks
    extraDirections?: Record<string, BidirectionalFieldDirection>
}

export interface SyncRecord {
    unbasedFields?: SyncChangeField[]
    /** Whole-file and unmanaged note contents last confirmed together. */
    clockContext?: { file: string; other: string; mtime: number; mod?: number }
    /** The verified HTML hashes written to one-way history with this two-way checkpoint. */
    pairReceipt?: { model: string; front: string; back: string }
    /** Only receipts made with named-line tracking may authorize clearing a removed line. */
    namedFieldModel?: string
    sourceSuffixes?: Record<string, string>
    deletionSource?: string
    suspension?: SuspendBase
    base?: SyncValue
    pending?: PendingSync
}

interface SyncStorage {
    exists(path: string): Promise<boolean>
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
}

interface SyncSnapshot {
    version: 1 | 2 | 3 | 4 | 5
    checksum?: string
    profile: string
    revision: number
    records: Array<[number, SyncRecord]>
}

type SyncDisk = [string | undefined, string | undefined, string | undefined]
const endings = ['0', '1', 'staged'] as const
const diskQueues = new WeakMap<SyncStorage, Map<string, Promise<void>>>()
// Keep validated bytes, not objects a caller can modify through get(). Bound retention to one profile per adapter.
const validatedCheckpoints = new WeakMap<SyncStorage, {
    path: string; profile: string; disk: SyncDisk; selected: number; seal: boolean
}>()
const maxCachedCheckpointChars = 16_000_000

function withDiskQueue<T>(storage: SyncStorage, path: string, operation: () => Promise<T>): Promise<T> {
    let queue = diskQueues.get(storage)
    if (!queue) {
        queue = new Map()
        diskQueues.set(storage, queue)
    }
    const active = queue
    const result = (active.get(path) ?? Promise.resolve()).then(operation)
    const wait = result.then(() => {}, () => {})
    active.set(path, wait)
    return result.finally(() => {
        if (active.get(path) === wait) active.delete(path)
    })
}

function normalizedText(text: string): string {
    return text.normalize('NFC')
}

function indexTags(tags: readonly string[]): Map<string, string> {
    const result = new Map<string, string>()
    for (const value of tags) {
        const tag = value.trim().normalize('NFC')
        const key = tag.toLowerCase()
        if (tag && !isProtectedAnkiTag(tag) && !result.has(key)) result.set(key, tag)
    }
    return result
}

export function normalizeSyncTags(tags: readonly string[]): string[] {
    const indexed = indexTags(tags)
    return Array.from(indexed.keys()).sort().map(key => indexed.get(key)!)
}

function sameTags(left: Map<string, string>, right: Map<string, string>): boolean {
    return left.size === right.size && Array.from(left.keys()).every(key => right.has(key))
}

export function syncValuesEqual(left: SyncValue, right: SyncValue): boolean {
    return normalizedText(left.front) === normalizedText(right.front) &&
        normalizedText(left.back) === normalizedText(right.back) && sameTags(indexTags(left.tags), indexTags(right.tags)) &&
        sameSyncExtras(left.extra, right.extra)
}

export function sameSyncExtras(left?: Readonly<Record<string, string>>, right?: Readonly<Record<string, string>>): boolean {
    if (left === right) return true
    const a = Object.keys(left ?? {})
    const b = Object.keys(right ?? {})
    return a.length === b.length && a.every(name => typeof right?.[name] === 'string' &&
        normalizedText(left![name]) === normalizedText(right[name]))
}

export function mergeSyncValues(base: SyncValue | undefined, obsidian: SyncValue, anki: SyncValue,
    choices: SyncChoices = {}, extraDirections?: ReadonlyMap<string, BidirectionalFieldDirection>,
    fieldBases?: ReadonlyMap<string, string | null>, pairBases?: PairBases, initialTagBase?: readonly string[], unbased?: readonly SyncChangeField[]):
    { value: SyncValue; conflicts: SyncChangeField[] } {
    const conflicts: SyncChangeField[] = []
    const resolveText = (field: SyncChangeField, localValue: string, remoteValue: string,
        previousValue: string | undefined, direction: BidirectionalFieldDirection = 'both'): string => {
        const local = normalizedText(localValue)
        const remote = normalizedText(remoteValue)
        const previous = previousValue === undefined ? undefined : normalizedText(previousValue)
        if (local === remote || direction !== 'to-obsidian' && remote === previous) return localValue
        if (direction !== 'to-anki' && local === previous) return remoteValue
        const choice = choices[field]
        if (choice === 'anki' && direction !== 'to-anki') return remoteValue
        if (choice === 'obsidian' && direction !== 'to-obsidian') return localValue
        conflicts.push(field)
        return localValue
    }
    const front = resolveText('front', obsidian.front, anki.front, pairBases?.front === null ? undefined : pairBases?.front ?? (unbased?.includes('front') ? undefined : base?.front))
    const back = resolveText('back', obsidian.back, anki.back, pairBases?.back === null ? undefined : pairBases?.back ?? (unbased?.includes('back') ? undefined : base?.back))
    const common: Pick<SyncValue, 'front' | 'back' | 'extra'> = { front, back }
    if (extraDirections?.size) {
        common.extra = Object.fromEntries(Array.from(extraDirections, ([name, direction]) => [
            name, resolveText(`extra:${name}`, obsidian.extra![name], anki.extra![name],
                fieldBases?.has(name) ? fieldBases.get(name) ?? undefined : unbased?.includes(`extra:${name}`) ? undefined : base?.extra?.[name], direction),
        ]))
    }
    const localTags = indexTags(obsidian.tags)
    const remoteTags = indexTags(anki.tags)
    if (sameTags(localTags, remoteTags)) return { value: { ...common, tags: normalizeSyncTags(obsidian.tags) }, conflicts }
    const tagBase = unbased?.includes('tags') ? initialTagBase : base?.tags ?? initialTagBase
    if (!tagBase) {
        if (!choices.tags) conflicts.push('tags')
        return { value: { ...common, tags: normalizeSyncTags(choices.tags === 'anki' ? anki.tags : obsidian.tags) }, conflicts }
    }
    const previousTags = indexTags(tagBase)
    const keys = new Set([...previousTags.keys(), ...localTags.keys(), ...remoteTags.keys()])
    const tags: string[] = []
    for (const key of Array.from(keys).sort()) {
        const local = localTags.get(key)
        const remote = remoteTags.get(key)
        const selected = localTags.has(key) === previousTags.has(key) ? remote : local
        if (selected !== undefined) tags.push(selected)
    }
    return { value: { ...common, tags }, conflicts }
}

export function matchesPendingSyncValue(current: SyncValue, before: SyncValue, target: SyncValue): boolean {
    for (const field of ['front', 'back'] as const) {
        const value = normalizedText(current[field])
        if (value !== normalizedText(before[field]) && value !== normalizedText(target[field])) return false
    }
    const extra = Object.entries(current.extra ?? {})
    if (extra.length !== Object.keys(before.extra ?? {}).length || extra.length !== Object.keys(target.extra ?? {}).length ||
        extra.some(([name, value]) => {
            const left = before.extra?.[name]
            const right = target.extra?.[name]
            return typeof left !== 'string' || typeof right !== 'string' ||
                normalizedText(value) !== normalizedText(left) && normalizedText(value) !== normalizedText(right)
        })) return false
    const live = indexTags(current.tags)
    const previous = indexTags(before.tags)
    const wanted = indexTags(target.tags)
    return Array.from(new Set([...live.keys(), ...previous.keys(), ...wanted.keys()])).every(tag =>
        live.has(tag) === previous.has(tag) || live.has(tag) === wanted.has(tag))
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isValue(value: unknown): value is SyncValue {
    return isObject(value) && typeof value.front === 'string' && typeof value.back === 'string' &&
        Array.isArray(value.tags) && value.tags.every(tag => typeof tag === 'string') &&
        (value.extra === undefined || isObject(value.extra) && Object.entries(value.extra).every(([name, field]) =>
            isBidirectionalFieldName(name) && typeof field === 'string'))
}

function validFieldList(value: unknown): boolean {
    return value === undefined || Array.isArray(value) && value.every(key => key === 'front' || key === 'back' ||
        key === 'tags' || typeof key === 'string' && key.startsWith('extra:') && isBidirectionalFieldName(key.slice(6)))
}

function validSourceSuffixes(value: unknown): boolean {
    return value === undefined || isObject(value) && Object.entries(value).every(([name, text]) => name.length > 0 && typeof text === 'string')
}

function validPairReceipt(value: unknown): boolean {
    return value === undefined || isObject(value) && typeof value.model === 'string' && !!value.model &&
        typeof value.front === 'string' && /^[0-9a-f]{32}$/u.test(value.front) &&
        typeof value.back === 'string' && /^[0-9a-f]{32}$/u.test(value.back)
}

function isRecord(value: unknown): value is SyncRecord {
    if (!isObject(value)) return false
    const clock = value.clockContext
    if (clock !== undefined && (!isObject(clock) || typeof clock.file !== 'string' || typeof clock.other !== 'string' ||
        !/^[0-9a-f]{32}$/u.test(clock.file) || !/^[0-9a-f]{32}$/u.test(clock.other) ||
        typeof clock.mtime !== 'number' || !Number.isFinite(clock.mtime) || clock.mtime <= 0 ||
        clock.mod !== undefined && !isId(clock.mod))) return false
    return validFieldList(value.unbasedFields) && validPairReceipt(value.pairReceipt) && (value.namedFieldModel === undefined || typeof value.namedFieldModel === 'string' && !!value.namedFieldModel) && validSourceSuffixes(value.sourceSuffixes) && (value.deletionSource === undefined || typeof value.deletionSource === 'string' && /^[0-9a-f]{32}$/u.test(value.deletionSource)) &&
        (value.suspension === undefined || validSuspendBase(value.suspension)) &&
        (value.base === undefined || isValue(value.base)) &&
        (value.pending === undefined || (isObject(value.pending) && validSourceSuffixes(value.pending.sourceSuffixes) && validFieldList(value.pending.skipped) &&
            validSourceSuffixes(value.pending.targetSourceSuffixes) && isValue(value.pending.obsidian) &&
            isValue(value.pending.anki) && isValue(value.pending.target) &&
            (value.pending.extraDirections === undefined || isObject(value.pending.extraDirections) &&
                Object.entries(value.pending.extraDirections).every(([name, direction]) => isBidirectionalFieldName(name) &&
                    (direction === 'both' || direction === 'to-anki' || direction === 'to-obsidian'))) &&
            (value.pending.ankiBacklinks === undefined || (Array.isArray(value.pending.ankiBacklinks) &&
                value.pending.ankiBacklinks.length === 2 && value.pending.ankiBacklinks.every(link =>
                    link === null || typeof link === 'string'))))) &&
        (value.base !== undefined || value.pending !== undefined || value.suspension !== undefined)
}

function usesPartialFields(record: SyncRecord): boolean {
    return !!record.pending?.skipped?.length || !!record.unbasedFields?.length
}

function hasExtraFields(record: SyncRecord): boolean {
    return record.base?.extra !== undefined || record.pending?.obsidian.extra !== undefined ||
        record.pending?.anki.extra !== undefined || record.pending?.target.extra !== undefined ||
        record.pending?.extraDirections !== undefined
}

function digest(text: string): string {
    return Md5.hashStr(text)
}

function isSnapshotRow(row: unknown): row is [number, SyncRecord] {
    return Array.isArray(row) && row.length === 2 && isId(row[0]) && isRecord(row[1])
}

function parseSnapshot(text: string, profile: string, slot?: number): SyncSnapshot {
    const value: unknown = JSON.parse(text)
    if (!isObject(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4 && value.version !== 5) || value.profile !== profile ||
        !isId(value.revision) || (slot !== undefined && value.revision % 2 !== slot) || !Array.isArray(value.records) ||
        !value.records.every((row: unknown): row is [number, SyncRecord] => isSnapshotRow(row) &&
            (value.version !== 1 || !hasExtraFields(row[1])) &&
            (value.version === 5 || !usesPartialFields(row[1])) &&
            (value.version === 5 || value.version === 4 || value.version === 3 || row[1].suspension === undefined && row[1].deletionSource === undefined)) ||
        new Set(value.records.map(row => row[0])).size !== value.records.length) {
        throw new Error('Invalid bidirectional sync checkpoint.')
    }
    const snapshot: SyncSnapshot = { version: value.version, profile, revision: value.revision, records: value.records }
    const checksum = digest(JSON.stringify(snapshot))
    if (value.checksum !== checksum) throw new Error('Damaged bidirectional sync checkpoint.')
    return { ...snapshot, checksum }
}

async function readDisk(storage: SyncStorage, basePath: string): Promise<SyncDisk> {
    const [first, second, staged] = await Promise.all(endings.map(async ending => {
        const path = `${basePath}.${ending}`
        try {
            return await storage.exists(path) ? await storage.read(path) : undefined
        } catch (error) {
            throw new Error(`Cannot verify the bidirectional sync checkpoint at ${path}. ${String(error)}`)
        }
    }))
    return [first, second, staged]
}

function selectSnapshot(disk: SyncDisk, basePath: string, profile: string): { saved?: SyncSnapshot; seal: boolean } {
    const parse = (index: number) => {
        const text = disk[index]
        if (text === undefined) return
        try {
            return parseSnapshot(text, profile, index < 2 ? index : undefined)
        } catch {
            return undefined
        }
    }
    const first = parse(0)
    const second = parse(1)
    const staged = first && disk[0] === disk[2] ? first : second && disk[1] === disk[2] ? second : parse(2)
    if (staged) {
        const slot = staged.revision % 2
        const target = slot === 0 ? first : second
        const predecessor = slot === 0 ? second : first
        const hasPredecessor = staged.revision === 1 ? disk[1 - slot] === undefined
            : predecessor?.revision === staged.revision - 1
        const matchesTarget = disk[slot] === disk[2]
        if (hasPredecessor && (matchesTarget || !target || target.revision === staged.revision - 2)) {
            return { saved: staged, seal: !matchesTarget }
        }
        if (staged.revision >= Math.max(first?.revision ?? 0, second?.revision ?? 0)) {
            throw new Error(`Cannot verify the staged bidirectional sync checkpoint at ${basePath}.staged.`)
        }
    }
    const [saved, previous] = [first, second].filter((snapshot): snapshot is SyncSnapshot => snapshot !== undefined)
        .sort((left, right) => right.revision - left.revision)
    if ((disk[0] !== undefined && !first) || (disk[1] !== undefined && !second) ||
        (!saved && disk[2] !== undefined)) {
        throw new Error(`Cannot verify the bidirectional sync checkpoints at ${basePath}.`)
    }
    if (saved && (previous ? previous.revision !== saved.revision - 1 : saved.revision !== 1)) {
        throw new Error('The bidirectional sync checkpoints are incomplete. Restore them before syncing.')
    }
    return { saved, seal: false }
}

type DeltaRow = [number, SyncRecord | null]
interface Delta {
    base: string
    seq: number
    previous: string
    rows: DeltaRow[]
    checksum: string
}

interface Journal {
    head: Delta
    primary: string | undefined
    staged: string | undefined
    seal: boolean
}

const journalMinRecords = 128
const journalMaxUpdates = 64
const journalMaxChars = 65536

function makeDelta(base: string, seq: number, previous: string, rows: DeltaRow[]): Delta {
    const body = { base, seq, previous, rows }
    return { ...body, checksum: digest(JSON.stringify(body)) }
}

function parseDelta(text: string | undefined, base: string): Delta | undefined {
    if (!text) return
    try {
        const data: unknown = JSON.parse(text)
        if (!isObject(data) || data.base !== base || typeof data.seq !== 'number' || !Number.isSafeInteger(data.seq) ||
            data.seq < 0 || data.seq > journalMaxUpdates || typeof data.previous !== 'string' || !Array.isArray(data.rows) ||
            (data.seq === 0 ? data.previous !== '' || data.rows.length !== 0 : !/^[a-f0-9]{32}$/u.test(data.previous)) ||
            !data.rows.every((row): row is DeltaRow => Array.isArray(row) && row.length === 2 &&
                isId(row[0]) && (row[1] === null || isRecord(row[1]))) ||
            new Set(data.rows.map(r => r[0])).size !== data.rows.length) return
        const result = makeDelta(base, data.seq, data.previous, data.rows)
        return result.checksum === data.checksum ? result : undefined
    } catch { return }
}

async function readOptional(storage: SyncStorage, path: string): Promise<string | undefined> {
    return await storage.exists(path) ? storage.read(path) : undefined
}

async function readJournal(storage: SyncStorage, path: string, snapshot: SyncSnapshot): Promise<Journal> {
    const base = snapshot.checksum!
    const [primary, staged] = await Promise.all([
        readOptional(storage, path + '.journal.' + snapshot.revision % 2),
        readOptional(storage, path + '.journal.staged'),
    ])
    const committed = parseDelta(primary, base)
    const prepared = staged === primary ? committed : parseDelta(staged, base)
    if (prepared && (!committed || prepared.seq === committed.seq + 1 && prepared.previous === committed.checksum))
        return { head: prepared, primary, staged, seal: true }
    if (committed && (!prepared || prepared.checksum === committed.checksum))
        return { head: committed, primary, staged, seal: false }
    throw new Error('Cannot verify the bidirectional sync journal. Restore its matching checkpoint and journal files before syncing.')
}

function applyRows(records: Map<number, SyncRecord>, rows: Iterable<readonly [number, SyncRecord | null | undefined]>): void {
    for (const [id, record] of rows) {
        if (record) records.set(id, record)
        else records.delete(id)
    }
}

export class BidirectionalState {
    private readonly records: Map<number, SyncRecord>
    private revision: number
    private format: SyncSnapshot['version']
    private failed = false
    private journal?: Journal
    private seal: boolean

    private constructor(private readonly storage: SyncStorage, private readonly basePath: string,
        private readonly profile: string, private readonly disk: SyncDisk, saved?: SyncSnapshot, seal = false) {
        this.records = new Map(saved?.records)
        this.revision = saved?.revision ?? 0
        this.format = saved?.version ?? 1
        this.seal = seal
    }

    static async open(storage: SyncStorage, vaultPath: string, profile: string): Promise<BidirectionalState> {
        if (!profile.trim()) throw new Error('Cannot verify the active Anki profile.')
        const basePath = `${vaultPath}.${digest(profile)}`
        return withDiskQueue(storage, basePath, async () => {
            const disk = await readDisk(storage, basePath)
            const cached = validatedCheckpoints.get(storage)
            let saved: SyncSnapshot | undefined
            let seal = false
            if (cached?.path === basePath && cached.profile === profile && disk.every((text, slot) => text === cached.disk[slot])) {
                // These exact bytes already passed parseSnapshot for this vault and profile.
                saved = JSON.parse(disk[cached.selected]!) as SyncSnapshot
                seal = cached.seal
            } else {
                const selected = selectSnapshot(disk, basePath, profile)
                saved = selected.saved
                seal = selected.seal
                if (saved && disk.reduce((chars, text) => chars + (text?.length ?? 0), 0) <= maxCachedCheckpointChars) {
                    validatedCheckpoints.set(storage, { path: basePath, profile, disk: [...disk], selected: seal ? 2 : saved.revision % 2, seal })
                } else validatedCheckpoints.delete(storage)
            }
            if (!saved && (await Promise.all(['0', '1', 'staged'].map(suffix => storage.exists(basePath + '.journal.' + suffix)))).some(Boolean))
                throw new Error('Cannot verify the bidirectional sync journal without its matching full checkpoint.')
            const state = new BidirectionalState(storage, basePath, profile, disk, saved, seal)
            if (saved && saved.version >= 4) {
                state.journal = await readJournal(storage, basePath, saved)
                applyRows(state.records, state.journal.head.rows)
            }
            return state
        })
    }

    get(id: number): SyncRecord | undefined {
        return this.records.get(id)
    }

    private async writeVerified(suffix: string, text: string): Promise<void> {
        const path = this.basePath + '.' + suffix
        await this.storage.write(path, text)
        if (await this.storage.read(path) !== text) throw new Error('The saved checkpoint does not match the intended data.')
    }

    private async verifyCurrent(): Promise<void> {
        const disk = await readDisk(this.storage, this.basePath)
        if (disk.some((copy, slot) => copy !== this.disk[slot])) throw new Error('The bidirectional sync checkpoint changed. Preview the sync again.')
        if (this.journal) {
            const paths = ['journal.' + this.revision % 2, 'journal.staged']
            const [primary, staged] = await Promise.all(paths.map(suffix => readOptional(this.storage, this.basePath + '.' + suffix)))
            if (primary !== this.journal.primary || staged !== this.journal.staged)
                throw new Error('The bidirectional sync checkpoint changed. Preview the sync again.')
        }
    }

    private async sealRecovered(): Promise<void> {
        if (this.seal) {
            const slot = this.revision % 2
            await this.writeVerified(endings[slot], this.disk[2]!)
            this.disk[slot] = this.disk[2]
            this.seal = false
        }
        if (this.journal?.seal) {
            await this.writeVerified('journal.' + this.revision % 2, this.journal.staged!)
            this.journal.primary = this.journal.staged
            this.journal.seal = false
        }
    }

    private async saveDelta(changes: Map<number, SyncRecord | null>): Promise<boolean> {
        const old = this.journal?.head
        if (this.format < 5 && Array.from(changes.values()).some(record => record && usesPartialFields(record))) return false
        if (!old || old.seq >= journalMaxUpdates || changes.size > journalMinRecords) return false
        const rows = new Map(old.rows)
        for (const [id, record] of changes) rows.set(id, record)
        const head = makeDelta(old.base, old.seq + 1, old.checksum, Array.from(rows))
        const text = JSON.stringify(head)
        if (text.length > journalMaxChars) return false
        await this.writeVerified('journal.staged', text)
        await this.writeVerified('journal.' + this.revision % 2, text)
        this.journal = { head, primary: text, staged: text, seal: false }
        return true
    }

    private async saveSnapshot(changes: Map<number, SyncRecord | null>): Promise<void> {
        const records = new Map(this.records)
        applyRows(records, changes)
        const rows = Array.from(records)
        const version = this.format === 5 || rows.some(([, record]) => usesPartialFields(record)) ? 5 :
            this.format === 4 || rows.length >= journalMinRecords || rows.some(([, r]) => r.sourceSuffixes || r.pending?.sourceSuffixes) ? 4 :
            this.format === 3 || rows.some(([, r]) => r.suspension || r.deletionSource) ? 3 :
            this.format === 2 || rows.some(([, r]) => hasExtraFields(r)) ? 2 : 1
        if (version >= 4 && this.revision === 0) await this.saveSnapshot(new Map())
        const revision = this.revision + 1
        if (!isId(revision)) throw new Error('Invalid bidirectional sync checkpoint revision.')
        const snapshot: SyncSnapshot = { version, profile: this.profile, revision, records: rows }
        const checksum = digest(JSON.stringify(snapshot))
        const text = JSON.stringify({ ...snapshot, checksum })
        const slot = revision % 2
        let journal: Journal | undefined
        if (version >= 4) {
            const head = makeDelta(checksum, 0, '', [])
            const primary = JSON.stringify(head)
            const staged = this.journal ? this.journal.staged : await readOptional(this.storage, this.basePath + '.journal.staged')
            await this.writeVerified('journal.' + slot, primary)
            journal = { head, primary, staged, seal: false }
        }
        await this.writeVerified('staged', text)
        await this.writeVerified(endings[slot], text)
        this.disk[2] = this.disk[slot] = text
        this.revision = revision
        this.format = version
        this.journal = journal
    }

    checkpoint(updates: Iterable<readonly [number, SyncRecord | undefined]>): Promise<void> {
        const changes = new Map<number, SyncRecord | null>()
        for (const [id, record] of updates) {
            if (!isId(id) || (record !== undefined && !isRecord(record)))
                return Promise.reject(new Error('Invalid bidirectional sync record.'))
            changes.set(id, record ?? null)
        }
        if (!changes.size) return Promise.resolve()
        return withDiskQueue(this.storage, this.basePath, async () => {
            if (this.failed) throw new Error('The previous bidirectional sync checkpoint could not be verified.')
            try {
                await this.verifyCurrent()
                await this.sealRecovered()
                if (!await this.saveDelta(changes)) await this.saveSnapshot(changes)
                applyRows(this.records, changes)
            } catch (error) {
                this.failed = true
                throw new Error(`Could not save the bidirectional sync checkpoint. ${String(error)}`)
            }
        })
    }
}
