// SPDX-License-Identifier: GPL-3.0-only
import type MyPlugin from '../main'
import type { AnkiConnectRequest } from './anki'
import type { NoteSnapshot } from './anki-delta'
import { recordSyncChanges, syncHistoryLimit } from './sync-change-history'
import type { SyncHistoryChange } from './sync-change-history'

type Entry = Omit<SyncHistoryChange, 'mode' | 'profile'>
export interface LoggedRequest {
    id: number
    path: string
    title: string
    before: NoteSnapshot
    request: AnkiConnectRequest
}

function fieldValue(note: NoteSnapshot, name: string): string | undefined {
    const field = note.fields[name] as { value?: unknown } | undefined
    return typeof field?.value === 'string' ? field.value : undefined
}

export class BidirectionalChanges {
    private rows: SyncHistoryChange[] = []

    constructor(private plugin: MyPlugin, private profile: string) {}

    add(entry: Entry): void {
        this.rows.push({ ...entry, mode: 'two-way', profile: this.profile })
        if (this.rows.length >= 2 * syncHistoryLimit) this.rows.splice(0, this.rows.length - syncHistoryLimit)
    }

    async flush(): Promise<void> {
        if (this.rows.length) await recordSyncChanges(this.plugin, this.rows.slice(-syncHistoryLimit))
    }

    async remoteWrite(requests: LoggedRequest[], write: () => Promise<void>,
        readBack: () => Promise<ReadonlyMap<number, NoteSnapshot>>, pending: () => boolean): Promise<void> {
        try {
            await write()
        } finally {
            let observed: ReadonlyMap<number, NoteSnapshot> | undefined
            if (!pending()) {
                try { observed = await readBack() } catch { /* The write outcome remains unknown. */ }
            }
            for (const { id, path, title, before, request } of requests) {
                const common = { path, title, noteId: id, direction: 'to-anki' } as const
                const after = observed?.get(id)
                if (!after || after.modelName !== before.modelName) {
                    this.add({ ...common, action: 'unknown', detail: request.action })
                    continue
                }
                if (request.action === 'updateNoteFields') {
                    const fields = []
                    const unconfirmed = []
                    for (const [name, wanted] of Object.entries(request.params.note.fields)) {
                        const old = fieldValue(before, name)
                        const saved = fieldValue(after, name)
                        if (saved !== wanted) unconfirmed.push(name)
                        else if (old !== saved) fields.push({ name, before: old, after: saved })
                    }
                    if (fields.length) this.add({ ...common, action: 'edit', fields })
                    if (unconfirmed.length) this.add({ ...common, action: 'unknown', detail: unconfirmed.join(', ') })
                } else if (request.action === 'addTags' || request.action === 'removeTags') {
                    const lower = (values: string[]) => values.map(value => value.toLowerCase()).sort()
                    const wanted = new Set(lower(before.tags))
                    for (const tag of lower(request.params.tags.split(/\s+/).filter(Boolean))) {
                        if (request.action === 'addTags') wanted.add(tag)
                        else wanted.delete(tag)
                    }
                    const actual = lower(after.tags)
                    if (JSON.stringify([...wanted].sort()) !== JSON.stringify(actual)) this.add({ ...common, action: 'unknown', detail: request.action })
                    else if (JSON.stringify(lower(before.tags)) !== JSON.stringify(actual))
                        this.add({ ...common, action: 'tags', fields: [{ name: 'Tags', before: before.tags.join(' '), after: after.tags.join(' ') }] })
                }
            }
        }
    }
}
