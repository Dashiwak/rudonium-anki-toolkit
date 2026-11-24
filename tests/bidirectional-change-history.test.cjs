// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

test('partial multi response logs only values read back, and an outstanding write is never probed or declared applied', async () => {
    const modules = await load(['bidirectional-change-history', 'sync-change-history'], {})
    const store = new Map()
    const plugin = { settings: { SYNC_CHANGE_HISTORY: true }, manifest: { id: 'test' }, app: { vault: {
        configDir: '.obsidian', adapter: { exists: async key => store.has(key), read: async key => store.get(key),
            write: async (key, value) => store.set(key, value) },
    } } }
    const journal = new modules['bidirectional-change-history'].BidirectionalChanges(plugin, 'Study')
    const old = { modelName: 'Basic', tags: ['old'], fields: { Back: { value: 'Before' } } }
    const request = id => ({ id, path: 'same.md', title: 'Question ' + id, before: old, request: {
        action: 'updateNoteFields', params: { note: { id, fields: { Back: 'After' } } },
    } })
    const fail = () => { throw new Error('batch failed') }
    const saved = { ...old, fields: { Back: { value: 'After' } } }
    await assert.rejects(journal.remoteWrite([request(1), request(2)], fail,
        async () => new Map([[1, saved], [2, old]]), () => false), /batch failed/)
    let probed = false
    await assert.rejects(journal.remoteWrite([request(3)], fail, async () => { probed = true }, () => true), /batch failed/)
    assert.equal(probed, false)
    const tags = { ...request(4), request: { action: 'addTags', params: { notes: [4], tags: 'new' } } }
    await journal.remoteWrite([tags], async () => {}, async () => new Map([[4, { ...old, tags: ['old', 'new'] }]]), () => false)
    await journal.flush()
    const events = Array.from(await modules['sync-change-history'].readSyncChanges(plugin)).reverse()
    assert.deepEqual(events.map(row => [row.noteId, row.action]), [[1, 'edit'], [2, 'unknown'], [3, 'unknown'], [4, 'tags']])
    assert.deepEqual(JSON.parse(JSON.stringify(events[0].fields)), [{ name: 'Back', before: 'Before', after: 'After' }])
    assert.deepEqual(JSON.parse(JSON.stringify(events[3].fields)), [{ name: 'Tags', before: 'old', after: 'old new' }])
})
