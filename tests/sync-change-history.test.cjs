// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')
const ready = load(['sync-change-history'], {})
const change = (noteId, overrides = {}) => ({ mode: 'one-way', action: 'edit', direction: 'to-anki',
    path: 'История/Крепости.md', profile: 'User', noteId, fields: [{ name: 'Front', before: '', after: '<img src=x>' }], ...overrides })

function host() {
    const files = new Map(), accesses = []
    const adapter = {
        async exists(path) { accesses.push('exists'); return files.has(path) },
        async read(path) { accesses.push('read'); return files.get(path) },
        async write(path, text) { accesses.push('write'); files.set(path, text) },
        async remove(path) { accesses.push('remove'); files.delete(path) },
    }
    const plugin = { settings: {}, manifest: { id: 'plugin' }, app: { vault: { configDir: '.my-config', adapter } } }
    return { files, adapter, accesses, plugin }
}

test('only opt-in records changes; before/after preserve literal markup and empty vs unavailable values', async () => {
    const lib = (await ready)['sync-change-history']
    const { plugin, files, accesses } = host()
    await lib.recordSyncChanges(plugin, [change(1)])
    assert.deepEqual(accesses, [])
    plugin.settings.SYNC_CHANGE_HISTORY = true
    const edits = [change(2), change(3, { mode: 'two-way', direction: 'to-obsidian', fields: [{ name: 'Back', after: '' }] })]
    const saved = lib.recordSyncChanges(plugin, edits)
    edits[0].fields[0].after = 'later'
    await saved
    const [toVault, toAnki] = await lib.readSyncChanges(plugin)
    assert.equal(toVault.fields[0].before, undefined)
    assert.equal(toVault.fields[0].after, '')
    assert.equal(toAnki.fields[0].before, '')
    assert.equal(toAnki.fields[0].after, '<img src=x>')
    assert.equal(toAnki.profile, 'User')
    assert.equal(toVault.mode, 'two-way')
    assert.equal(toVault.direction, 'to-obsidian')
    assert.ok(Date.parse(toVault.at))
    assert.match([...files.keys()][0], /^\.my-config\/plugins\/plugin\/sync-change-history/)
    plugin.settings.SYNC_CHANGE_HISTORY = false
    const before = accesses.length
    await lib.recordSyncChanges(plugin, [change(4)])
    assert.equal(accesses.length, before)
    assert.deepEqual(Array.from(await lib.readSyncChanges(plugin), row => row.noteId), [3, 2])
})

test('an attachment upload and a local ID date update can be reopened after restart', async () => {
    const api = (await ready)['sync-change-history']
    const { plugin } = host()
    plugin.settings.SYNC_CHANGE_HISTORY = true
    await api.recordSyncChanges(plugin, [
        { ...change(11), action: 'media', direction: 'to-anki' },
        { ...change(12), action: 'id-date', direction: 'local' },
    ])
    const rows = await api.readSyncChanges({ ...plugin })
    assert.deepEqual(Array.from(rows, row => [row.noteId, row.action, row.direction]), [
        [12, 'id-date', 'local'], [11, 'media', 'to-anki'],
    ])
})

test('concurrent changes ordered around reads and explicit clearing; disabled history is still clearable', async () => {
    const lib = (await ready)['sync-change-history']
    const { plugin, files, accesses } = host()
    plugin.settings.SYNC_CHANGE_HISTORY = true
    const writes = [lib.recordSyncChanges(plugin, [change(1)]), lib.recordSyncChanges(plugin, [change(2)])]
    const before = lib.readSyncChanges(plugin)
    writes.push(lib.recordSyncChanges(plugin, [change(3)]))
    const clear = lib.clearSyncChanges(plugin)
    writes.push(lib.recordSyncChanges(plugin, [change(4)]))
    await Promise.all([...writes, clear])
    assert.deepEqual(Array.from(await before, row => row.noteId), [2, 1])
    assert.deepEqual(Array.from(await lib.readSyncChanges(plugin), row => row.noteId), [4])
    assert.equal(accesses.filter(value => value === 'write').length, 3)
    plugin.settings.SYNC_CHANGE_HISTORY = false
    await lib.clearSyncChanges(plugin)
    assert.equal(files.size, 0)
})

test('caps retained rows, bytes and field text; clears corrupt files and never turns diagnostic failures into sync failures', async () => {
    const lib = (await ready)['sync-change-history']
    const { plugin, adapter, files } = host()
    plugin.settings.SYNC_CHANGE_HISTORY = true
    await lib.recordSyncChanges(plugin, Array.from({length: 820}, (_, i) => change(i + 1)))
    let rows = await lib.readSyncChanges(plugin)
    assert.equal(rows.length, lib.syncHistoryLimit)
    assert.equal(rows.at(-1).noteId, 321)
    const field = { name: 'Back', before: 'я'.repeat(3000), after: 'a'.repeat(3000) }
    await lib.recordSyncChanges(plugin, Array.from({length: 40}, (_, i) => change(i + 821, { fields: Array(40).fill(field) })))
    rows = await lib.readSyncChanges(plugin)
    assert.equal(rows[0].noteId, 860)
    assert.ok(rows.length < 40)
    assert.equal(rows[0].omittedFields, 8)
    assert.match(rows[0].fields[0].before, /…$/u)
    assert.ok(Array.from(files.values()).every(text => Buffer.byteLength(text) <= 1024 * 1024))
    const original = adapter.write
    adapter.write = async (file) => { files.set(file, '{'); throw Error('disk full') }
    await lib.recordSyncChanges(plugin, [change(861)])
    assert.equal(lib.syncHistoryWriteFailed(plugin), true)
    assert.equal((await lib.readSyncChanges(plugin))[0].noteId, 860)
    adapter.write = original
    await lib.recordSyncChanges(plugin, [change(862)])
    assert.equal((await lib.readSyncChanges(plugin))[0].noteId, 862)
    for (const key of files.keys()) files.set(key, '{"version":1,"rows":[{}]}')
    await assert.rejects(lib.readSyncChanges(plugin), /Cannot read/)
    await lib.recordSyncChanges(plugin, [change(863)])
    assert.equal(lib.syncHistoryWriteFailed(plugin), true)
    await lib.clearSyncChanges(plugin)
    assert.equal(lib.syncHistoryWriteFailed(plugin), false)
    assert.equal((await lib.readSyncChanges(plugin)).length, 0)
})

test('history viewer filters modes, directions and IDs, renders field content as text, and confirms clearing', async () => {
    class El {
        constructor(tag = 'div', opts = {}) { this.tag = tag; this.text = opts.text; this.nodes = []; this.value = opts.value ?? ''; this.attrs = opts.attr ?? {} }
        empty() { this.nodes = [] }
        setText(text) { this.text = text }
        focus() {}
        createEl(tag, opts) { const child = new El(tag, opts); this.nodes.push(child); return child }
        createDiv(opts) { return this.createEl('div', opts) }
        descendants() { return [this, ...this.nodes.flatMap(child => child.descendants())] }
    }
    let dialog
    class Modal {
        constructor() { this.titleEl = new El(); this.contentEl = new El(); dialog = this }
        open() { this.onOpen() }
    }
    const { plugin } = host()
    plugin.settings.SYNC_CHANGE_HISTORY = true
    const modules = await load(['sync-change-history', 'sync-change-history-ui'], {
        uiFor: () => (_en, ru) => ru, installModalLayout() {}, Modal,
    })
    const history = modules['sync-change-history']
    await history.recordSyncChanges(plugin, [change(11), change(12, { mode: 'two-way', direction: 'to-obsidian' })])
    modules['sync-change-history-ui'].openSyncChangeHistory(plugin)
    const tick = () => new Promise(resolve => setImmediate(resolve))
    await tick()
    const all = () => dialog.contentEl.descendants()
    const find = (tag, text) => all().find(node => node.tag === tag && node.text === text)
    const count = () => all().filter(node => node.tag === 'summary').length
    assert.equal(count(), 2)
    assert.ok(find('pre', '<img src=x>'))
    assert.ok(find('pre', '(Пусто)'))
    const search = all().find(node => node.tag === 'input')
    const [mode, direction] = all().filter(node => node.tag === 'select')
    mode.value = 'two-way'; mode.onchange()
    assert.equal(count(), 1)
    direction.value = 'to-anki'; direction.onchange()
    assert.equal(count(), 0)
    direction.value = ''; mode.value = ''; search.value = '11'; search.oninput()
    assert.equal(count(), 1)
    assert.ok(all().some(node => node.tag === 'summary' && node.text.includes('ID 11')))
    find('button', 'Очистить журнал').onclick()
    find('button', 'Отмена').onclick()
    await tick()
    assert.equal((await history.readSyncChanges(plugin)).length, 2)
    find('button', 'Очистить журнал').onclick()
    await find('button', 'Удалить журнал').onclick()
    assert.equal((await history.readSyncChanges(plugin)).length, 0)
})
