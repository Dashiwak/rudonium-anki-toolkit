// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { load } = require('./benchmark/migration-modules.cjs')
const md5 = value => createHash('md5').update(value).digest('hex')
const model = load(['bidirectional-state'], { Md5: { hashStr: md5 } })
const row = back => ({ base: { front: 'q', back: String(back), tags: [] } })
const seed = Array.from({ length: 130 }, (_, i) => [i + 1, row(i + 1)])
const host = (files = new Map()) => {
    const calls = []
    const storage = { exists: async key => files.has(key), read: async key => files.get(key),
        write: async (key, text) => { files.set(key, text); calls.push(key) } }
    async function open(profile = 'A') {
        return (await model)['bidirectional-state'].BidirectionalState.open(storage, 'sync', profile)
    }
    return { storage, calls, files, open }
}

test('sparse changes, tombstones, stale preview and profile isolation', async () => {
    const h = host()
    const writer = await h.open()
    await writer.checkpoint(seed)
    const stale = await h.open()
    h.calls.length = 0
    await writer.checkpoint([[1, row('new')], [2, undefined]])
    assert.equal(h.calls.length, 2)
    assert.ok(h.calls.every(key => key.includes('.journal.') && h.files.get(key).length < 700))
    await assert.rejects(stale.checkpoint([[3, undefined]]), /checkpoint changed/)
    const fresh = await host(h.files).open()
    assert.equal(fresh.get(1).base.back, 'new')
    assert.equal(fresh.get(2), undefined)
    assert.equal(fresh.get(3).base.back, '3')
    assert.equal((await h.open('B')).get(1), undefined)
})

test('legacy profile opens without writes and first sparse change promotes it', async () => {
    const h = host()
    const snap = { version: 3, profile: 'A', revision: 1, records: seed }
    const bytes = JSON.stringify({ ...snap, checksum: md5(JSON.stringify(snap)) })
    for (const suffix of ['1', 'staged']) h.files.set('sync.' + md5('A') + '.' + suffix, bytes)
    const state = await h.open()
    assert.equal(state.get(1).base.back, '1')
    assert.deepEqual(h.calls, [])
    await state.checkpoint([[1, row('converted')]])
    assert.equal((await h.open()).get(1).base.back, 'converted')
    h.calls.length = 0
    await state.checkpoint([[2, undefined]])
    assert.ok(h.calls.every(key => key.includes('.journal.')))
})

test('recover every torn write for a sparse checkpoint and snapshot compaction', async () => {
    const original = host()
    const seedWriter = await original.open()
    await seedWriter.checkpoint(seed)
    await seedWriter.checkpoint([[1, row('before')]])
    for (const compact of [false, true]) {
        const changes = compact ? seed.map(([id]) => [id, row('after')]) : [[1, row('after')]]
        for (let failure = 1; failure <= (compact ? 3 : 2); failure++) {
            for (const cut of [0, 0.5, 1]) {
                const h = host(new Map(original.files))
                let writes = 0
                const write = h.storage.write
                h.storage.write = async (key, contents) => {
                    if (++writes !== failure) return write(key, contents)
                    await write(key, contents.slice(0, Math.floor(contents.length * cut)))
                    throw new Error('power interrupted')
                }
                const writer = await h.open()
                await assert.rejects(writer.checkpoint(changes), /power interrupted/)
                const rebooted = host(h.files)
                const restored = await rebooted.open()
                const actual = restored.get(1).base.back
                assert.ok(actual === 'after' || actual === 'before')
                assert.equal(restored.get(130).base.back, compact && actual === 'after' ? 'after' : '130')
                await restored.checkpoint([[2, row('resumed')]])
                assert.equal((await rebooted.open()).get(2).base.back, 'resumed')
            }
        }
    }
})

test('bounded journal compacts; missing baseline or both damaged delta copies block sync', async () => {
    const h = host()
    const s = await h.open()
    await s.checkpoint(seed)
    for (let n = 0; n < 67; n++) await s.checkpoint([[1, row(n)]])
    assert.ok(h.files.size <= 6)
    assert.equal((await host(h.files).open()).get(1).base.back, '66')
    const base = 'sync.' + md5('A')
    const missing = new Map(h.files)
    for (const slot of ['0', '1', 'staged']) missing.delete(base + '.' + slot)
    await assert.rejects(host(missing).open(), /matching full checkpoint/)
    for (const key of h.files.keys()) if (key.includes('.journal.')) h.files.set(key, '{')
    await assert.rejects(h.open(), /Cannot verify/)
})

test('interrupted creation of the first journal restarts from its confirmed empty checkpoint', async () => {
    const h = host()
    const regular = h.storage.write
    h.storage.write = async (key, text) => {
        await regular(key, text)
        if (key.includes('.journal.')) throw new Error('crash after journal allocation')
    }
    await assert.rejects((await h.open()).checkpoint(seed), /crash after journal allocation/)
    const restarted = await host(h.files).open()
    assert.equal(restarted.get(1), undefined)
    await restarted.checkpoint(seed)
    assert.equal((await host(h.files).open()).get(130).base.back, '130')
})
