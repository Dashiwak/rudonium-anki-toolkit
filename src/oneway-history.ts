/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Md5 } from 'ts-md5'
import { isProtectedAnkiTag } from './anki-study-state'

interface HistoryStorage {
    exists(path: string): Promise<boolean>
    read(path: string): Promise<string>
    write(path: string, data: string): Promise<void>
}

export interface OneWayRecord {
    readonly modelName: string
    readonly fields: Readonly<Record<string, string>>
    readonly matchedTags: readonly string[]
    readonly managedTags: readonly string[]
    readonly namedFields?: readonly string[]
}

export interface OneWayNamedLayout {
    shared?: readonly string[]
    eligible: readonly string[]
    present: readonly string[]
}

export interface OneWayReceipt {
    id: number
    modelName: string
    fields?: Readonly<Record<string, string>>
    namedLayout?: OneWayNamedLayout
    matchedTags?: readonly string[]
    absentTags?: readonly string[]
    addedTags?: readonly string[]
    removedTags?: readonly string[]
}

interface Snapshot {
    version: 1
    profile: string
    revision: number
    notes: Array<[number, OneWayRecord]>
}

type DiskSnapshot = [string | undefined, string | undefined]

const validatedHistory = new WeakMap<HistoryStorage, { path: string; disk: DiskSnapshot; snapshot?: Snapshot }>()

function rememberValidation(storage: HistoryStorage, path: string, disk: DiskSnapshot, snapshot?: Snapshot): void {
    const [first, second] = disk
    if ((first?.length ?? 0) + (second?.length ?? 0) > 16_000_000) {
        validatedHistory.delete(storage)
        return
    }
    validatedHistory.set(storage, { path, disk: [first, second], snapshot })
}

function digest(value: string): string {
    return Md5.hashStr(value)
}

export function oneWayFieldDigest(value: string): string {
    return digest(value.normalize('NFC'))
}

export function oneWayTagKey(value: string): string {
    return value.trim().normalize('NFC').toLowerCase()
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is number {
    return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function isTagList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(tag => typeof tag === 'string' && tag.length > 0 &&
        oneWayTagKey(tag) === tag && !isProtectedAnkiTag(tag)) && new Set(value).size === value.length
}

function isRecord(value: unknown): value is OneWayRecord {
    return isObject(value) && typeof value.modelName === 'string' && Boolean(value.modelName) &&
        isObject(value.fields) && Object.values(value.fields).every(item =>
            typeof item === 'string' && /^[a-f0-9]{32}$/.test(item)) &&
        (value.namedFields === undefined || Array.isArray(value.namedFields) &&
            value.namedFields.every(name => typeof name === 'string' && name.length > 0 &&
                Object.prototype.hasOwnProperty.call(value.fields, name)) &&
            new Set(value.namedFields).size === value.namedFields.length) &&
        isTagList(value.matchedTags) && isTagList(value.managedTags) &&
        value.managedTags.every(tag => (value.matchedTags as string[]).includes(tag))
}

function readSnapshot(data: string, profile: string, slot: number): Snapshot {
    const row: unknown = JSON.parse(data)
    if (!isObject(row) || row.version !== 1 || row.profile !== profile || !isId(row.revision) ||
        row.revision % 2 !== slot || !Array.isArray(row.notes) ||
        !row.notes.every((entry: unknown): entry is [number, OneWayRecord] =>
            Array.isArray(entry) && entry.length === 2 && isId(entry[0]) && isRecord(entry[1])) ||
        new Set(row.notes.map(entry => entry[0])).size !== row.notes.length) {
        throw new Error('Invalid one-way sync history.')
    }
    const snapshot: Snapshot = { version: 1, profile, revision: row.revision, notes: row.notes }
    if (row.checksum !== digest(JSON.stringify(snapshot))) throw new Error('Damaged one-way sync history.')
    return snapshot
}

async function readDisk(storage: HistoryStorage, path: string): Promise<DiskSnapshot> {
    const read = async (slot: number) => {
        const file = `${path}.${slot}`
        return await storage.exists(file) ? storage.read(file) : undefined
    }
    return Promise.all([read(0), read(1)])
}

export class OneWayHistory {
    private readonly records: Map<number, OneWayRecord>
    private revision: number
    private changed = false

    private constructor(private readonly storage: HistoryStorage, private readonly path: string,
        private readonly profile: string, private readonly disk: DiskSnapshot, snapshot?: Snapshot) {
        this.records = new Map(snapshot?.notes ?? [])
        this.revision = snapshot?.revision ?? 0
    }

    static async open(storage: HistoryStorage, path: string, profile: string): Promise<OneWayHistory> {
        if (!profile.trim()) throw new Error('Cannot open one-way history without an Anki profile.')
        const profilePath = `${path}.${digest(profile)}`
        const disk = await readDisk(storage, profilePath)
        const cached = validatedHistory.get(storage)
        if (cached?.path === profilePath && disk[0] === cached.disk[0] && disk[1] === cached.disk[1]) {
            return new OneWayHistory(storage, profilePath, profile, disk, cached.snapshot)
        }
        let latest: Snapshot | undefined
        for (const [slot, data] of disk.entries()) {
            if (data === undefined) continue
            const snapshot = readSnapshot(data, profile, slot)
            if (!latest || snapshot.revision > latest.revision) latest = snapshot
        }
        rememberValidation(storage, profilePath, disk, latest)
        return new OneWayHistory(storage, profilePath, profile, disk, latest)
    }

    get(id: number, modelName: string): OneWayRecord | undefined {
        const entry = this.records.get(id)
        return entry?.modelName === modelName ? entry : undefined
    }

    apply(receipts: readonly OneWayReceipt[]): void {
        for (const receipt of receipts) {
            if (!isId(receipt.id) || !receipt.modelName) throw new Error('Invalid one-way sync receipt.')
            const previous = this.get(receipt.id, receipt.modelName)
            let updatedFields: Record<string, string> | undefined
            const matched = new Set(previous?.matchedTags)
            const managed = new Set(previous?.managedTags)
            let named: Set<string> | undefined
            for (const [name, value] of Object.entries(receipt.fields ?? {})) {
                if (receipt.namedLayout?.shared?.includes(name) && previous?.namedFields?.includes(name)) {
                    named ??= new Set(previous.namedFields)
                    named.delete(name)
                } else if (receipt.namedLayout?.eligible.includes(name)) {
                    const local = receipt.namedLayout.present.includes(name)
                    if ((local || value === '') && local !== (previous?.namedFields?.includes(name) ?? false)) {
                        named ??= new Set(previous?.namedFields)
                        if (local) named.add(name)
                        else named.delete(name)
                    }
                }
                const hash = oneWayFieldDigest(value)
                if (previous?.fields[name] === hash) continue
                const fields = updatedFields ??= Object.assign(Object.create(null) as Record<string, string>, previous?.fields)
                fields[name] = hash
            }
            for (const tag of [...(receipt.matchedTags ?? []), ...(receipt.addedTags ?? [])]) {
                const key = oneWayTagKey(tag)
                if (key && !isProtectedAnkiTag(key)) matched.add(key)
            }
            for (const tag of receipt.addedTags ?? []) {
                const key = oneWayTagKey(tag)
                if (matched.has(key)) managed.add(key)
            }
            for (const tag of [...(receipt.absentTags ?? []), ...(receipt.removedTags ?? [])]) {
                const key = oneWayTagKey(tag)
                matched.delete(key)
                managed.delete(key)
            }
            if (!updatedFields && !named && previous &&
                matched.size === previous.matchedTags.length && previous.matchedTags.every(tag => matched.has(tag)) &&
                managed.size === previous.managedTags.length && previous.managedTags.every(tag => managed.has(tag))) continue
            const fields = updatedFields ?? previous?.fields ?? {}
            if (!Object.keys(fields).length && !matched.size) {
                if (this.records.delete(receipt.id)) this.changed = true
                continue
            }
            const namedFields = named ? [...named] : previous?.namedFields
            const next = { modelName: receipt.modelName, fields, matchedTags: [...matched], managedTags: [...managed],
                ...(namedFields && { namedFields }) }
            this.records.set(receipt.id, next)
            this.changed = true
        }
    }

    async flush(): Promise<void> {
        if (!this.changed) return
        const current = await readDisk(this.storage, this.path)
        if (current.some((data, slot) => this.disk[slot] !== data)) {
            throw new Error('The one-way sync history changed during export. Run the scan again.')
        }
        const revision = this.revision + 1
        const slot = revision % 2
        const snapshot: Snapshot = { version: 1, profile: this.profile, revision, notes: [...this.records] }
        const payload = JSON.stringify(snapshot)
        const text = `${payload.slice(0, -1)},"checksum":"${digest(payload)}"}`
        const file = `${this.path}.${slot}`
        await this.storage.write(file, text)
        if (await this.storage.read(file) !== text) throw new Error('Could not verify the one-way sync history.')
        this.disk[slot] = text
        this.revision = revision
        this.changed = false
        rememberValidation(this.storage, this.path, this.disk, snapshot)
    }
}
