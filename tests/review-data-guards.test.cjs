// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { load } = require('./benchmark/migration-modules.cjs')
const { invoke, parse } = require('../src/anki.ts')

test('AnkiConnect rejects malformed or non-success responses; multi preserves per-note errors', async t => {
    class Request {
        constructor() { this.listeners = {} }
        addEventListener(name, run) { this.listeners[name] = run }
        open(method, url) { assert.equal(method, 'POST'); assert.equal(url, 'http://127.0.0.1:8765') }
        send(raw) {
            assert.deepEqual(JSON.parse(raw), { action: 'multi', version: 6, params: { actions: [] } })
            this.status = status
            this.responseText = text
            this.listeners[event]()
        }
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
    Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: Request })
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'XMLHttpRequest', previous)
        else delete globalThis.XMLHttpRequest
    })
    let status = 200, event = 'load'
    const results = [{ error: null, result: null }, { error: 'cannot create note because it is a duplicate', result: null }]
    let text = JSON.stringify({ result: results, error: null })
    const request = () => invoke('multi', { actions: [] })
    assert.deepEqual(await request(), results)
    assert.equal(parse(results[0]), null)
    assert.throws(() => parse(results[1]), /duplicate/)
    for (const value of [{ result: null, error: false }, { error: null, extra: null }, [], null, { result: [], error: null, other: 1 }]) {
        text = JSON.stringify(value)
        await assert.rejects(request(), Error)
    }
    text = JSON.stringify({ result: true, error: null })
    status = 503
    await assert.rejects(request(), /HTTP 503/)
    event = 'abort'
    await assert.rejects(request(), /aborted/)
    event = 'error'
    await assert.rejects(request(), /failed to issue request/)
})

test('interrupted ZIP import rollback preserves an edited file and trashes only the unchanged imported file', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rudonium-zip-rollback-'))
    t.after(() => fs.rm(root, {recursive: true, force: true}))
    const relative = 'new.md', id = crypto.randomUUID()
    const target = path.join(root, relative)
    const journals = path.join(root, '.custom', 'plugins', 'rudonium-anki-toolkit', 'zip-imports')
    const journalPath = path.join(journals, id, 'transaction.json')
    await fs.mkdir(path.dirname(journalPath), { recursive: true })
    const original = 'imported text', after = crypto.createHash('sha256').update(original).digest('hex')
    const journal = { version: 1, root, id, status: 'pending',
        entries: [{ path: relative, before: null, after, markdown: true, sourceHash: after }] }
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await fs.writeFile(path.join(journals, 'pending.json'), JSON.stringify({ id }))
    class TFile {}
    const file = Object.assign(new TFile(), {path: relative, extension:'md'})
    let indexed = file
    const plugin = {manifest: {id:'rudonium-anki-toolkit'}, settings: {}, app: {
        workspace: {getLeavesOfType: () => []},
        vault: {configDir: '.custom', adapter: {getBasePath: () => root},
            getAbstractFileByPath: p => p === relative ? indexed : null,
            readBinary: () => fs.readFile(target)},
        fileManager: {trashFile: async f => {
            assert.equal(f, file)
            await fs.rename(target, path.join(root, 'saved-in-trash'))
            indexed = null
        }},
    }}
    const api = {TFile, withFastScanReadLock: (_plugin, work) => work(), uiFor: () => english => english}
    const mod = (await load(['zip-import'], api))['zip-import']
    await fs.writeFile(target, 'user edit')
    await assert.rejects(mod.recoverZipImport(plugin), /changed after/)
    assert.equal(await fs.readFile(target, 'utf8'), 'user edit')
    await fs.writeFile(target, original)
    indexed = { path: relative, extension: 'md' }
    await assert.rejects(mod.recoverZipImport(plugin), /has not indexed/)
    indexed = file
    const recovered = await mod.recoverZipImport(plugin)
    assert.deepEqual([...recovered.paths], [relative])
    assert.equal(await fs.readFile(path.join(root, 'saved-in-trash'), 'utf8'), original)
    assert.equal(await mod.inspectZipImportRecovery(plugin), undefined)
})
