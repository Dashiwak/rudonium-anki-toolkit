// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')
const en = text => text
const ru = (_, text) => text
async function fixture() {
    const state = { calls: [], checks: 0, responses: [[765], [765]], focused: true }
    const doc = { activeElement: {}, hasFocus: () => state.focused }
    const api = { invoke: async (action, params) => {
        state.calls.push([action, params.query])
        state.onBrowse?.()
        return state.responses.shift()
    } }
    const modules = await load(['anki-browser', 'anki-transport'], api, {}, { window: { activeDocument: doc, setTimeout, clearTimeout } })
    const verify = async () => { state.checks++; state.onCheck?.() }
    return { doc, state, open: (id = 999, t = en) => modules['anki-browser'].browseAnkiNote(id, t, verify) }
}
test('an already-open Anki browser receives one request to raise it if Obsidian kept focus', async () => {
    const { open, state } = await fixture()
    assert.match(await open(), /Switch to Anki/)
    assert.deepEqual(state.calls, [['guiBrowse','nid:999'],['guiBrowse','nid:999']])
    assert.equal(state.checks, 2)
})
test('first-open focus transfer, a change of control and empty searches issue no second request', async () => {
    for (const reason of ['focus', 'element', 'empty']) {
        const { doc, open, state } = await fixture()
        if (reason === 'focus') state.onBrowse = () => { state.focused = false }
        if (reason === 'element') state.onBrowse = () => { doc.activeElement = {} }
        if (reason === 'empty') state.responses = [[]]
        const message = await open(123, ru)
        assert.match(message, reason === 'empty' ? /нет карточек/ : /открыта/)
        assert.equal(state.calls.length, 1)
        assert.equal(state.checks, 1)
    }
})
test('invalid note, malformed card results, and changed profile cannot trigger a focus retry', async () => {
    const { open, state } = await fixture()
    await assert.rejects(open(-1), /invalid/)
    assert.deepEqual(state.calls, [])
    state.responses = [['invalid']]
    await assert.rejects(open(), /valid card list/)
    assert.equal(state.calls.length, 1)
    state.responses = [[765]]
    state.onCheck = () => { if (state.checks === 3) throw new Error('profile changed') }
    await assert.rejects(open(), /profile changed/)
    assert.equal(state.calls.length, 2)
})
