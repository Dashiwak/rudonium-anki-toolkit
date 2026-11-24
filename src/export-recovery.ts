/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Md5 } from 'ts-md5'
import { isDefiniteAddNoteRejection } from './anki-transport'

export type RecoverySlot = number | null | 'unknown'

export interface RecoveryPlan {
    readonly path: string
    readonly sourceHash: string
    readonly signatures: readonly string[]
    readonly token?: string
    readonly tagVersion?: 1
    readonly cursorOffset?: number
    readonly slotLines?: readonly (number | null)[]
}

export interface RecoveryEntry extends RecoveryPlan {
    readonly slots: readonly RecoverySlot[]
    readonly ankiProfile?: string
    readonly writtenHash?: string
    readonly formerPath?: string
}

export interface RecoveryCleanup {
    readonly tag: string
    readonly noteId: number
    readonly ankiProfile: string
}

interface RecoveryStorage {
    exists(path: string): Promise<boolean>
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
}

interface RecoverySnapshot {
    version: 1
    revision: number
    entries: RecoveryEntry[]
    cleanup?: RecoveryCleanup[]
}

const recoveryTagPrefix = 'ota-recovery::'

export function isRecoveryTag(tag: string): boolean {
    return /^ota-recovery::[a-f0-9]{32}-[1-9][0-9]*$/i.test(tag)
}

export function recoveryTag(plan: RecoveryPlan, index: number): string | undefined {
    if (plan.tagVersion !== 1 || !isHash(plan.token) ||
        !Number.isSafeInteger(index) || index < 0 || index >= plan.signatures.length) return
    return `${recoveryTagPrefix}${plan.token}-${index + 1}`
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isHash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function isSlot(value: unknown): value is RecoverySlot {
    return value === null || value === 'unknown' || isId(value)
}

function isProfile(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function isPlan(row: unknown): row is RecoveryPlan {
    return isObject(row) && typeof row.path === 'string' && row.path.length > 0 && isHash(row.sourceHash) &&
        Array.isArray(row.signatures) && row.signatures.length > 0 && row.signatures.every(isHash) &&
        (row.cursorOffset === undefined || typeof row.cursorOffset === 'number' && Number.isSafeInteger(row.cursorOffset) && row.cursorOffset >= 0 && row.signatures.length === 1) &&
        (row.token === undefined || isHash(row.token)) &&
        (row.tagVersion === undefined || (row.tagVersion === 1 && isHash(row.token))) &&
        (row.slotLines === undefined || (Array.isArray(row.slotLines) && row.slotLines.length === row.signatures.length &&
            row.slotLines.every(line => line === null || isId(line))))
}

function isEntry(row: unknown): row is RecoveryEntry {
    return isObject(row) && isPlan(row) && Array.isArray(row.slots) && row.slots.length === row.signatures.length &&
        row.slots.every(isSlot) && (row.ankiProfile === undefined ? row.tagVersion === undefined : isProfile(row.ankiProfile)) && (row.formerPath === undefined ||
            (typeof row.formerPath === 'string' && row.formerPath.length > 0 && row.token !== undefined)) && (row.writtenHash === undefined ||
            (isHash(row.writtenHash) && row.writtenHash !== row.sourceHash && row.slots.some(isId)))
}

function uniqueIds(entries: Iterable<RecoveryEntry>, cleanup: Iterable<RecoveryCleanup>): boolean {
    const idsByProfile = new Map<string | undefined, Set<number>>()
    const add = (ankiProfile: string | undefined, id: number) => {
        let ids = idsByProfile.get(ankiProfile)
        if (!ids) {
            ids = new Set<number>()
            idsByProfile.set(ankiProfile, ids)
        }
        if (ids.has(id)) return false
        ids.add(id)
        return true
    }
    for (const { ankiProfile, noteId } of cleanup) {
        if (!add(ankiProfile, noteId)) return false
    }
    for (const { slots, ankiProfile } of entries) {
        for (const slot of slots) {
            if (!isId(slot)) continue
            if (!add(ankiProfile, slot)) return false
        }
    }
    return true
}

function isCleanup(row: unknown): row is RecoveryCleanup {
    return isObject(row) && typeof row.tag === 'string' && isRecoveryTag(row.tag) &&
        row.tag === row.tag.toLowerCase() && isId(row.noteId) && isProfile(row.ankiProfile)
}

function cleanupTagsDistinct(entries: Iterable<RecoveryEntry>, cleanup: readonly RecoveryCleanup[]): boolean {
    const tokens = new Set<string>()
    for (const entry of entries) if (entry.tagVersion === 1 && entry.token) tokens.add(entry.token)
    return new Set(cleanup.map(item => item.tag)).size === cleanup.length &&
        !cleanup.some(item => tokens.has(item.tag.slice(recoveryTagPrefix.length, recoveryTagPrefix.length + 32)))
}

export function pendingRecoveryProfileProblem(entry: RecoveryEntry, profile: string | undefined): string | undefined {
    if (entry.ankiProfile === undefined) {
        return 'This pending Anki note creation predates profile verification. Its Anki profile is unknown. ' +
            'Review the original record before retrying.'
    }
    if (profile !== entry.ankiProfile) {
        return `This pending Anki note creation belongs to profile “${entry.ankiProfile}”. ` +
            'Open that profile and verify the export destination before retrying.'
    }
    return undefined
}

function requireRecoveryProfile(entry: RecoveryEntry, profile: string): void {
    const problem = pendingRecoveryProfileProblem(entry, profile)
    if (problem) throw new Error(problem)
}

function parseSnapshot(text: string, slot: number): RecoverySnapshot {
    const value: unknown = JSON.parse(text)
    if (!isObject(value) || value.version !== 1 || !isId(value.revision) || value.revision % 2 !== slot ||
        !Array.isArray(value.entries) || !value.entries.every(isEntry) ||
        new Set(value.entries.map(entry => entry.path)).size !== value.entries.length ||
        !uniqueTokens(value.entries)) {
        throw new Error('Invalid pending export journal')
    }
    const cleanup = value.cleanup === undefined ? [] : value.cleanup
    if (!Array.isArray(cleanup) || !cleanup.every(isCleanup) || !cleanupTagsDistinct(value.entries, cleanup) ||
        !uniqueIds(value.entries, cleanup)) throw new Error('Invalid pending export journal')
    return { version: 1, revision: value.revision, entries: value.entries, cleanup }
}

function uniqueTokens(entries: Iterable<RecoveryEntry>): boolean {
    const seen = new Set<string>()
    for (const { token } of entries) {
        if (token === undefined) continue
        if (seen.has(token)) return false
        seen.add(token)
    }
    return true
}

const markerPrefix = '<!-- Obsidian-to-Anki pending '

export function addRecoveryMarker(text: string, token: string): string {
    const line = text.includes('\r\n') ? '\r\n' : '\n'
    return `${text}${line}${line}${markerPrefix}${token} -->${line}`
}

export function readRecoveryMarker(text: string): { token: string; clean: string } | undefined {
    if (!text.includes(markerPrefix)) return undefined
    const matches = Array.from(text.matchAll(/\r?\n\r?\n<!-- Obsidian-to-Anki pending ([a-f0-9]{32}) -->(?:\r?\n|$)/g))
    if (matches.length !== 1 || text.indexOf(markerPrefix) !== text.lastIndexOf(markerPrefix)) {
        throw new Error('Invalid or repeated pending export marker. Inspect the pending operation before adding any cards.')
    }
    const [marker] = matches
    const index = marker.index
    const suffix = text.slice(index + marker[0].length)
    const separator = suffix ? (marker[0].endsWith('\r\n') ? '\r\n' : '\n') : ''
    return { token: marker[1], clean: text.slice(0, index) + separator + suffix }
}

export function* recoveryMarkerTokens(text: string): Iterable<string> {
    if (!text.includes(markerPrefix)) return
    for (const marker of text.matchAll(/<!-- Obsidian-to-Anki pending ([a-f0-9]{32})/g)) yield marker[1]
}

export function newRecoveryToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function hasRecoveredLinks(entry: RecoveryEntry, confirmedLinkedIds: readonly number[]): boolean {
    if (entry.slots.includes('unknown')) return false
    const counts = new Map<number, number>()
    for (const id of confirmedLinkedIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    return entry.slots.every(slot => slot === null || (isId(slot) && counts.get(slot) === 1))
}

export function noteRecoverySignature(note: { fields: Record<string, string>; deckName: string; modelName: string }): string {
    const fields = Object.keys(note.fields).sort().map(name => [name, note.fields[name]])
    return Md5.hashStr(JSON.stringify([note.modelName, note.deckName, fields])) as string
}

export function readRecoverySlots(response: unknown, expectedLength: number,
    definitelyUnsent?: (response: unknown) => boolean): RecoverySlot[] {
    if (!isObject(response) || response.error !== null || !Array.isArray(response.result) ||
        response.result.length !== expectedLength) return Array<RecoverySlot>(expectedLength).fill('unknown')
    const counts = new Map<number, number>()
    const slots: RecoverySlot[] = response.result.map(row => {
        if (definitelyUnsent?.(row)) return null
        if (!isObject(row)) return 'unknown'
        if (row.error === null && isId(row.result)) {
            counts.set(row.result, (counts.get(row.result) ?? 0) + 1)
            return row.result
        }
        if (row.result === null && isDefiniteAddNoteRejection(row.error)) return null
        return 'unknown'
    })
    return slots.map(slot => isId(slot) && counts.get(slot) !== 1 ? 'unknown' : slot)
}

export class ExportRecovery {
    private readonly storage: RecoveryStorage
    private readonly basePath: string
    private entries: Map<string, RecoveryEntry>
    private cleanup: Map<string, RecoveryCleanup>
    private lookupIndexes?: {
        bySourceHash: Map<string, RecoveryEntry>
        byToken: Map<string, RecoveryEntry>
    }
    private revision: number
    private writes: Promise<unknown> = Promise.resolve()
    private failed = false

    private constructor(storage: RecoveryStorage, basePath: string, saved?: RecoverySnapshot) {
        this.storage = storage
        this.basePath = basePath
        this.revision = saved?.revision ?? 0
        this.entries = new Map(saved?.entries.map(entry => [entry.path, entry]))
        this.cleanup = new Map(saved?.cleanup?.map(item => [item.tag, item]))
    }

    static async open(storage: RecoveryStorage, basePath: string): Promise<ExportRecovery> {
        const snapshots = await Promise.all([0, 1].map(async slot => {
            const path = `${basePath}.${slot}`
            try {
                return await storage.exists(path) ? parseSnapshot(await storage.read(path), slot) : undefined
            } catch {
                throw new Error(`Cannot verify the pending Anki export journal at ${path}. Review it before creating new notes.`)
            }
        }))
        const [saved, previous] = snapshots.filter((entry): entry is RecoverySnapshot => entry !== undefined)
            .sort((first, second) => second.revision - first.revision)
        if (saved && (previous ? previous.revision !== saved.revision - 1 : saved.revision !== 1)) {
            throw new Error(`The pending Anki export journal at ${basePath} is incomplete. Review it before creating new notes.`)
        }
        return new ExportRecovery(storage, basePath, saved)
    }

    get(path: string, sourceHash?: string): RecoveryEntry | undefined {
        const entry = this.entries.get(path)
        if (entry || sourceHash === undefined || !this.entries.size) return entry
        return this.getLookupIndexes().bySourceHash.get(sourceHash)
    }

    records(): readonly RecoveryEntry[] {
        return Array.from(this.entries.values())
    }

    cleanupRecords(profile: string, limit = Infinity): readonly RecoveryCleanup[] {
        const records: RecoveryCleanup[] = []
        if (limit < 1) return records
        for (const item of this.cleanup.values()) {
            if (item.ankiProfile !== profile) continue
            records.push(item)
            if (records.length >= limit) break
        }
        return records
    }

    confirmCleanup(items: readonly RecoveryCleanup[], profile: string): Promise<void> {
        return this.update((_next, cleanup) => {
            let changed = false
            for (const item of items) {
                if (!isCleanup(item) || item.ankiProfile !== profile) throw new Error('Unexpected Anki recovery tag cleanup.')
                const queued = cleanup.get(item.tag)
                if (!queued) continue
                if (queued.ankiProfile !== profile || queued.noteId !== item.noteId) {
                    throw new Error('Anki recovery tag cleanup belongs to another record.')
                }
                cleanup.delete(item.tag)
                changed = true
            }
            return changed
        })
    }

    byToken(token: string): RecoveryEntry | undefined {
        if (!this.entries.size) return undefined
        return this.getLookupIndexes().byToken.get(token)
    }

    private getLookupIndexes() {
        if (this.lookupIndexes) return this.lookupIndexes
        const bySourceHash = new Map<string, RecoveryEntry>()
        const byToken = new Map<string, RecoveryEntry>()
        for (const entry of this.entries.values()) {
            if (!bySourceHash.has(entry.sourceHash)) bySourceHash.set(entry.sourceHash, entry)
            if (entry.token !== undefined) byToken.set(entry.token, entry)
        }
        return this.lookupIndexes = { bySourceHash, byToken }
    }

    relocate(token: string, previous: string, path: string, profile: string): Promise<void> {
        return this.update(next => {
            const entry = next.get(previous)
            if (!entry || entry.token !== token || next.has(path)) throw new Error('Ambiguous pending export source')
            requireRecoveryProfile(entry, profile)
            next.delete(previous)
            next.set(path, { ...entry, path, formerPath: entry.formerPath ?? previous })
            return true
        })
    }

    begin(plans: readonly RecoveryPlan[], profile: string): Promise<void> {
        return this.update((next, cleanup) => {
            if (plans.length && !isProfile(profile)) throw new Error('Cannot journal new Anki notes without a verified profile.')
            for (const plan of plans) {
                if (!isPlan(plan) || next.has(plan.path)) throw new Error(`Cannot start a new creation while ${plan.path} has a pending export.`)
                if (this.get(plan.path, plan.sourceHash)) throw new Error(`An identical Markdown source already has a pending export for ${plan.path}.`)
                next.set(plan.path, { ...plan, ankiProfile: profile, signatures: [...plan.signatures],
                    slotLines: plan.slotLines && [...plan.slotLines],
                    slots: Array<RecoverySlot>(plan.signatures.length).fill('unknown') })
            }
            if (!uniqueTokens(next.values())) throw new Error('Repeated pending export operation marker')
            if (!cleanupTagsDistinct(next.values(), Array.from(cleanup.values()))) {
                throw new Error('Pending export marker already exists in the Anki tag cleanup queue.')
            }
            return plans.length > 0
        })
    }

    record(results: readonly { path: string; slots: readonly RecoverySlot[] }[], profile: string): Promise<void> {
        return this.update((next, cleanup) => {
            for (const { path, slots } of results) {
                const entry = next.get(path)
                if (!entry || entry.writtenHash || slots.length !== entry.slots.length || !slots.every(isSlot) ||
                    entry.slots.some((slot, index) => slot !== 'unknown' && slot !== slots[index])) {
                    throw new Error(`Unexpected Anki creation result for ${path}.`)
                }
                requireRecoveryProfile(entry, profile)
                next.set(path, { ...entry, slots: [...slots] })
            }
            if (!uniqueIds(next.values(), cleanup.values())) {
                throw new Error('Anki returned the same new note ID more than once. Verify the pending exports before retrying.')
            }
            return results.length > 0
        })
    }

    intendMany(items: readonly { path: string; writtenHash: string; sourceHash?: string }[], profile: string): Promise<void> {
        return this.update(next => {
            let changed = false
            for (const { path, writtenHash, sourceHash } of items) {
                const entry = next.get(path)
                if (!entry || !isHash(writtenHash) || writtenHash === entry.sourceHash || !entry.slots.some(isId) ||
                    (sourceHash !== undefined && sourceHash !== entry.sourceHash) ||
                    (entry.writtenHash !== undefined && entry.writtenHash !== writtenHash && sourceHash === undefined)) {
                    throw new Error(`Cannot verify the intended Markdown IDs for ${path}.`)
                }
                requireRecoveryProfile(entry, profile)
                if (entry.writtenHash === writtenHash) continue
                next.set(path, { ...entry, writtenHash })
                changed = true
            }
            return changed
        })
    }

    settle(path: string, currentHash: string, profile: string): Promise<void> {
        return this.settleMany([{ path, currentHash }], profile)
    }

    settleMany(items: readonly { path: string; currentHash: string }[], profile: string): Promise<void> {
        return this.update((next, cleanup) => {
            let changed = false
            for (const { path, currentHash } of items) {
                const entry = next.get(path)
                if (!entry) continue
                requireRecoveryProfile(entry, profile)
                if (entry.slots.includes('unknown')) continue
                const expected = entry.slots.some(isId) ? entry.writtenHash : entry.sourceHash
                if (currentHash === expected) {
                    this.queueCleanup(entry, profile, cleanup)
                    next.delete(path)
                    changed = true
                }
            }
            return changed
        })
    }

    settleLinked(path: string, confirmedLinkedIds: readonly number[], profile: string): Promise<void> {
        return this.update((next, cleanup) => {
            const entry = next.get(path)
            if (!entry) return false
            requireRecoveryProfile(entry, profile)
            if (!hasRecoveredLinks(entry, confirmedLinkedIds)) return false
            this.queueCleanup(entry, profile, cleanup)
            return next.delete(path)
        })
    }

    private queueCleanup(entry: RecoveryEntry, profile: string, cleanup: Map<string, RecoveryCleanup>): void {
        if (entry.tagVersion !== 1) return
        for (const [index, slot] of entry.slots.entries()) {
            if (!isId(slot)) continue
            const tag = recoveryTag(entry, index)
            if (!tag || cleanup.has(tag)) throw new Error('Ambiguous Anki recovery tag cleanup.')
            cleanup.set(tag, { tag, noteId: slot, ankiProfile: profile })
        }
    }

    private update(change: (next: Map<string, RecoveryEntry>, cleanup: Map<string, RecoveryCleanup>) => boolean): Promise<void> {
        const operation = this.writes.then(async () => {
            if (this.failed) throw new Error('The pending Anki export journal could not be saved. Reload Obsidian before creating new notes.')
            const next = new Map(this.entries)
            const cleanup = new Map(this.cleanup)
            if (!change(next, cleanup)) return
            const revision = this.revision + 1
            const path = `${this.basePath}.${revision % 2}`
            const text = JSON.stringify({ version: 1, revision, entries: Array.from(next.values()),
                ...(cleanup.size ? { cleanup: Array.from(cleanup.values()) } : {}) })
            try {
                await this.storage.write(path, text)
                if (await this.storage.read(path) !== text) throw new Error('readback mismatch')
            } catch {
                this.failed = true
                throw new Error(`Could not verify the pending Anki export journal at ${path}. New notes were not retried.`)
            }
            this.entries = next
            this.cleanup = cleanup
            this.revision = revision
            this.lookupIndexes = undefined
        })
        this.writes = operation.catch(() => {})
        return operation
    }
}
