// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

class Element {
    constructor(tag = 'div', options = {}) {
        this.tag = tag
        this.text = options.text ?? ''
        this.children = []
        this.classList = { add() {}, toggle() {} }
    }
    createDiv(options) { return this.createEl('div', options) }
    createEl(tag, options) {
        const el = new Element(tag, options)
        this.children.push(el)
        return el
    }
    empty() { this.children = []; this.text = '' }
    setText(text) { this.empty(); this.text = text }
    nodes() { return [this, ...this.children.flatMap(el => el.nodes())] }
}

async function fixture(settings = {}, lang = 'en') {
    const calls = []
    const host = { read: () => { throw Error('failed to issue request') } }
    class Modal {
        constructor() { this.titleEl = new Element('h2'); this.contentEl = new Element() }
        open() { host.modal = this; this.onOpen() }
        close() { this.onClose() }
    }
    const api = {
        invoke: async action => { calls.push(action); return host.read() },
        Modal, installModalLayout() {}, uiFor: () => (en, ru) => lang === 'ru' ? ru : en,
        uiDiagnostic: error => String(error),
    }
    const mods = await load(['anki', 'anki-transport', 'anki-profile', 'anki-profile-ui'], api, {
        anki: "import { invoke } from './anki-mock'; export { invoke }",
    }, { window: { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 40)), clearTimeout } })
    const plugin = { settings, app: {} }
    const check = (pinned, signal) => mods['anki-profile'].requireExpectedAnkiProfile(plugin, pinned, signal)
    async function openProblem(stage = 'before-write', details) {
        const problem = await check().then(() => assert.fail('expected a profile error'), error => error)
        mods['anki-profile-ui'].showAnkiProfileProblem(plugin, problem, stage, details)
    }
    const buttons = () => host.modal.contentEl.nodes().filter(el => el.tag === 'button')
    const text = () => [host.modal.titleEl.text, ...host.modal.contentEl.nodes().map(el => el.text)].join('\n')
    return { host, calls, check, openProblem, buttons, text }
}

test('offline has priority in automatic, bound and unconfigured modes; each check makes just one read', async () => {
    for (const settings of [{}, { REQUIRE_ANKI_PROFILE: true, EXPECTED_ANKI_PROFILE: 'Main' }, { REQUIRE_ANKI_PROFILE: true }]) {
        const { host, calls, check } = await fixture(Object.freeze(settings))
        await assert.rejects(check(), { reason: 'unreachable' })
        host.read = () => new Promise(() => {})
        await assert.rejects(check(), { reason: 'unreachable' })
        assert.deepEqual(calls, ['getActiveProfile', 'getActiveProfile'])
    }
})

test('when Anki responds, distinguish closed collection, unsupported add-on, missing binding, changed settings and wrong pinned profile', async () => {
    const settings = { REQUIRE_ANKI_PROFILE: true }
    const { host, check, calls } = await fixture(settings)
    host.read = () => null
    await assert.rejects(check(), { reason: 'unavailable' })
    host.read = () => { throw Error('collection is not available') }
    await assert.rejects(check(), { reason: 'unavailable' })
    host.read = () => { throw Error('unsupported action') }
    await assert.rejects(check(), { reason: 'unsupported' })
    host.read = () => 'Other'
    await assert.rejects(check(), { reason: 'unconfigured', actual: 'Other' })
    host.read = () => { settings.EXPECTED_ANKI_PROFILE = 'Main'; return 'Other' }
    await assert.rejects(check(), { reason: 'changed' })
    host.read = () => 'Other'
    await assert.rejects(check(), { reason: 'mismatch', expected: 'Main', actual: 'Other' })
    settings.REQUIRE_ANKI_PROFILE = false
    await assert.rejects(check('Main'), { reason: 'mismatch', expected: 'Main', actual: 'Other' })
    assert.equal(await check(), 'Other')
    assert.deepEqual(calls, Array(8).fill('getActiveProfile'))
})

test('offline → online and unbound in Russian: offer binding only after a verified response', async () => {
    const { host, openProblem, buttons, calls, text } = await fixture(Object.freeze({ REQUIRE_ANKI_PROFILE: true }), 'ru')
    await openProblem()
    assert.equal(host.modal.titleEl.text, 'Нет соединения с Anki')
    assert.match(text(), /Запустите Anki на компьютере/)
    assert.doesNotMatch(text(), /Не выбран|Не подтверждён|настройки профиля/i)
    assert.deepEqual(buttons().map(el => el.text), ['Проверить соединение'])
    host.read = () => 'Main'
    await buttons()[0].onclick()
    assert.equal(host.modal.titleEl.text, 'Настройте профиль Anki')
    assert.match(text(), /Открыт в Anki · Main/)
    assert.deepEqual(buttons().map(el => el.text), ['Открыть настройки профиля'])
    assert.deepEqual(calls, ['getActiveProfile', 'getActiveProfile'])
})

test('offline → mismatch → offline → online: retry updates actions and preserves interrupted-operation details without resuming writes', async () => {
    const { host, openProblem, buttons, calls, text } = await fixture(Object.freeze({ REQUIRE_ANKI_PROFILE: true, EXPECTED_ANKI_PROFILE: 'Main' }))
    await openProblem('in-progress', 'Two requests had already been submitted.')
    assert.deepEqual(buttons().map(el => el.text), ['Check Connection'])
    host.read = () => 'Other'
    await buttons()[0].onclick()
    assert.match(text(), /Expected · Main\nActive in Anki · Other/)
    assert.deepEqual(buttons().map(el => el.text), ['Check Again', 'Open Profile Settings'])
    host.read = () => { throw Error('failed to issue request') }
    await buttons()[0].onclick()
    assert.deepEqual(buttons().map(el => el.text), ['Check Connection'])
    assert.doesNotMatch(text(), /Other|Expected ·/)
    host.read = () => 'Main'
    await buttons()[0].onclick()
    assert.equal(host.modal.titleEl.text, 'Connected to Anki')
    assert.match(text(), /Two requests had already been submitted/)
    assert.match(text(), /run the operation again/)
    assert.deepEqual(buttons().map(el => el.text), ['Close'])
    assert.deepEqual(calls, Array(4).fill('getActiveProfile'))
})

test('repeat clicks and closing during retry issue one read and do not reopen or mutate the dialog', async () => {
    const { host, openProblem, buttons, calls } = await fixture()
    await openProblem()
    let reply
    host.read = () => new Promise(resolve => { reply = resolve })
    const check = buttons()[0]
    const pending = check.onclick()
    await check.onclick()
    await new Promise(setImmediate)
    host.modal.close()
    reply('Main')
    await pending
    assert.deepEqual(buttons(), [])
    assert.deepEqual(calls, ['getActiveProfile', 'getActiveProfile'])
})

test('an empty schema on first export preserves the typed connection failure for the calling command', async () => {
    const notices = [], log = []
    class AnkiProfileError extends Error {}
    const problem = new AnkiProfileError()
    const { 'scan-state': scan } = await load(['scan-state'], {
        AnkiProfileError, Notice: class { constructor(text) { notices.push(text) } }, uiFor: () => en => en,
    })
    const plugin = { settings: {}, fields_dict: {} }
    scan.states.set(plugin, { refreshInitialSchema: async () => { throw problem } })
    await assert.rejects(scan.prepareInitialSchema(plugin, async line => log.push(line)), error => error === problem)
    assert.deepEqual(notices, [])
    assert.deepEqual(log, [])
})
