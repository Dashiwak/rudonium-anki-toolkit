// SPDX-License-Identifier: GPL-3.0-only
import type MyPlugin from '../main'

const actions = ['add', 'edit', 'delete', 'move', 'tags', 'suspend', 'unsuspend', 'link', 'unlink', 'skip', 'error', 'unknown', 'normalize', 'cleanup', 'media', 'id-date', 'check'] as const
const directions = ['to-anki', 'to-obsidian', 'local', 'none'] as const

export interface SyncHistoryField {
    name: string
    before?: string
    after?: string
}

export interface SyncHistoryChange {
    mode: 'one-way' | 'two-way'
    direction: typeof directions[number]
    action: typeof actions[number]
    path: string
    noteId?: number
    profile?: string
    title?: string
    fields?: readonly SyncHistoryField[]
    detail?: string
}

export interface SyncHistoryRow extends SyncHistoryChange {
    at: string
    omittedFields?: number
}

interface Snapshot {
    version: 1
    revision: number
    rows: SyncHistoryRow[]
}

export const syncHistoryLimit = 500
const byteBudget = 1024 * 1024
const fieldLimit = 32
const encoder = new TextEncoder()
const queues = new WeakMap<MyPlugin, Promise<unknown>>()
const failed = new WeakSet<MyPlugin>()
const batches = new WeakMap<MyPlugin, { rows: SyncHistoryRow[]; done: Promise<void> }>()

export function syncHistoryEnabled(plugin: MyPlugin): boolean {
    return plugin.settings.SYNC_CHANGE_HISTORY === true
}

export function syncHistoryWriteFailed(plugin: MyPlugin): boolean {
    return failed.has(plugin)
}

function clip(value: string, limit: number): string {
    if (value.length <= limit) return value
    const prefix = value.slice(0, limit - 1)
    return prefix.replace(/[\uD800-\uDBFF]$/u, '') + '…'
}

function snapshot(change: SyncHistoryChange, at: string): SyncHistoryRow {
    const fields = change.fields?.slice(0, fieldLimit).map(({ name, before, after }) => ({
        name: clip(name, 256),
        before: before === undefined ? undefined : clip(before, 2048),
        after: after === undefined ? undefined : clip(after, 2048),
    }))
    return {
        at, mode: change.mode, direction: change.direction, action: change.action,
        path: clip(change.path, 2048), noteId: Number.isSafeInteger(change.noteId) && change.noteId > 0 ? change.noteId : undefined,
        profile: change.profile && clip(change.profile, 256),
        title: change.title && clip(change.title, 256),
        detail: change.detail && clip(change.detail, 1024),
        fields, omittedFields: change.fields && change.fields.length > fieldLimit ? change.fields.length - fieldLimit : undefined,
    }
}

function inOrder<T>(plugin: MyPlugin, run: () => Promise<T>): Promise<T> {
    const prior = queues.get(plugin)
    const current = (prior?.catch(() => {}) ?? Promise.resolve()).then(run)
    queues.set(plugin, current)
    return current.finally(() => {
        if (queues.get(plugin) === current) queues.delete(plugin)
    })
}

function historyPath(plugin: MyPlugin, slot: number): string {
    const dir = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
    return `${dir}/sync-change-history.json.${slot}`
}

function validRow(raw: unknown): raw is SyncHistoryRow {
    if (!raw || typeof raw !== 'object') return false
    const row = raw as SyncHistoryRow
    const optional = (value: unknown) => value === undefined || typeof value === 'string'
    return typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) &&
        (row.mode === 'one-way' || row.mode === 'two-way') && actions.includes(row.action) &&
        directions.includes(row.direction) && typeof row.path === 'string' &&
        optional(row.profile) && optional(row.title) && optional(row.detail) &&
        (row.noteId === undefined || Number.isSafeInteger(row.noteId) && row.noteId > 0) &&
        (row.omittedFields === undefined || Number.isSafeInteger(row.omittedFields) && row.omittedFields > 0) &&
        (row.fields === undefined || Array.isArray(row.fields) && row.fields.length <= fieldLimit &&
            row.fields.every(field => field && typeof field.name === 'string' && optional(field.before) && optional(field.after)))
}

async function load(plugin: MyPlugin): Promise<Snapshot> {
    const adapter = plugin.app.vault.adapter
    let latest: Snapshot = { version: 1, revision: 0, rows: [] }
    let found = false
    for (const slot of [0, 1]) {
        const path = historyPath(plugin, slot)
        if (!await adapter.exists(path)) continue
        found = true
        const bytes = await adapter.read(path)
        if (bytes.length > byteBudget) continue
        let candidate: Snapshot
        try { candidate = JSON.parse(bytes) as Snapshot } catch { continue }
        if (candidate?.version === 1 && Number.isSafeInteger(candidate.revision) && candidate.revision % 2 === slot &&
            candidate.revision > latest.revision && Array.isArray(candidate.rows) && candidate.rows.length <= syncHistoryLimit &&
            candidate.rows.every(validRow)) latest = candidate
    }
    if (found && !latest.revision) throw new Error('Cannot read the sync change history.')
    return latest
}

function trim(rows: SyncHistoryRow[]): SyncHistoryRow[] {
    let size = 128
    let start = rows.length
    while (start > 0 && start > rows.length - syncHistoryLimit) {
        size += encoder.encode(JSON.stringify(rows[start - 1])).length + 1
        if (size > byteBudget) break
        --start
    }
    return rows.slice(start)
}

export function recordSyncChanges(plugin: MyPlugin, changes: readonly SyncHistoryChange[]): Promise<void> {
    if (!syncHistoryEnabled(plugin) || !changes.length) return Promise.resolve()
    const at = new Date().toISOString()
    const rows = changes.slice(-syncHistoryLimit).map(change => snapshot(change, at))
    const pending = batches.get(plugin)
    if (pending) {
        pending.rows = pending.rows.slice(Math.max(0, pending.rows.length + rows.length - syncHistoryLimit)).concat(rows)
        return pending.done
    }
    const batch = { rows, done: Promise.resolve() }
    batches.set(plugin, batch)
    batch.done = inOrder(plugin, async () => {
        if (batches.get(plugin) === batch) batches.delete(plugin)
        if (!syncHistoryEnabled(plugin)) return
        const previous = await load(plugin)
        const next: Snapshot = { version: 1, revision: previous.revision + 1, rows: trim(previous.rows.concat(batch.rows)) }
        await plugin.app.vault.adapter.write(historyPath(plugin, next.revision % 2), JSON.stringify(next))
    }).catch(() => { failed.add(plugin) })
    return batch.done
}

export function readSyncChanges(plugin: MyPlugin): Promise<SyncHistoryRow[]> {
    batches.delete(plugin)
    return inOrder(plugin, async () => (await load(plugin)).rows.reverse())
}

export function clearSyncChanges(plugin: MyPlugin): Promise<void> {
    batches.delete(plugin)
    return inOrder(plugin, async () => {
        const adapter = plugin.app.vault.adapter
        for (const slot of [0, 1]) {
            const path = historyPath(plugin, slot)
            if (await adapter.exists(path)) await adapter.remove(path)
        }
        failed.delete(plugin)
    })
}
