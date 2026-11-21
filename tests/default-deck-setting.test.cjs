// SPDX-License-Identifier: GPL-3.0-only
const createClassList = require('./dom-class-list.cjs');
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: settle } = require('node:timers/promises')
const { load } = require('./benchmark/migration-modules.cjs')

async function settings({ offline = false, russian = false } = {}) {
    class Element {
        constructor(options = {}) { Object.assign(this, options); this.children = []; this.classList = createClassList(); this.isConnected = true }
        createEl(tag, options) { const child = new Element(options); this.children.push(child); return child }
        createDiv(options) { return this.createEl('div', options) }
        setText(text) { this.text = text }
        empty() { this.children.length = 0 }
    }
    let row
    class Setting {
        constructor(element) { row = this; this.settingEl = element; this.descEl = element.createDiv(); this.controlEl = element.createDiv() }
        setName(name) { this.name = name; return this }
        setDesc(text) { this.description = text; return this }
    }
    class AnkiProfileError extends Error {
        constructor(reason) { super(reason); this.reason = reason }
    }
    const host = { profile: 'A', offline, saves: [], failure: false,
        decks: ['Knowledge::Deutsch::Verben', 'Knowledge', 'Base', 'Knowledge::Deutsch'] }
    const plugin = { settings: { Defaults: { Deck: 'Former deck' }, INTERFACE_LANGUAGE: russian ? 'ru' : 'en' },
        async saveAllData() {
            if (host.failure) throw Error('Disk unavailable')
            host.saves.push(this.settings.Defaults.Deck)
        } }
    const m = await load(['default-deck-setting', 'interface-language'], { Setting, setIcon() {}, AnkiProfileError,
        requireExpectedAnkiProfile: async (_, pinned) => {
            if (host.offline) throw new AnkiProfileError('unreachable')
            if (pinned && pinned !== host.profile) throw new AnkiProfileError('mismatch')
            return host.profile
        }, expectedAnkiProfile: () => undefined,
        readSyncAuditDeckNames: async () => host.decks })
    m['default-deck-setting'].installDefaultDeckSetting(new Element(), plugin)
    await settle()
    const [list, refresh] = row.controlEl.children
    return { list, refresh, status: row.descEl.children[0], plugin, host }
}

test('default deck keeps saved/offline values and then saves exact nested Anki deck names', async () => {
    const { list, refresh, status, plugin, host } = await settings({ offline: true, russian: true })
    assert.equal(list.disabled, true)
    assert.equal(list.value, 'Former deck')
    assert.match(status.text, /AnkiConnect/)
    host.offline = false
    await refresh.onclick()
    assert.deepEqual(list.children.map(o => o.text), ['Former deck', 'Base', 'Knowledge', 'Knowledge::Deutsch', 'Knowledge::Deutsch::Verben'])
    assert.match(status.text, /нет в этом профиле/)
    assert.deepEqual(host.saves, [])
    list.value = 'Knowledge::Deutsch::Verben'
    await list.onchange()
    assert.equal(plugin.settings.Defaults.Deck, 'Knowledge::Deutsch::Verben')
    assert.deepEqual(host.saves, ['Knowledge::Deutsch::Verben'])
})

test('default deck refuses choices from a switched profile, reloads, and restores the saved choice on write failure', async () => {
    const { list, refresh, status, host, plugin } = await settings()
    host.profile = 'B'
    host.decks = ['Languages::German']
    list.value = 'Knowledge'
    await list.onchange()
    assert.equal(list.disabled, true)
    assert.match(status.text, /profile changed/)
    assert.deepEqual(host.saves, [])
    await refresh.onclick()
    assert.deepEqual(list.children.map(o => o.text), ['Former deck', 'Languages::German'])
    host.failure = true
    list.value = 'Languages::German'
    await list.onchange()
    assert.equal(plugin.settings.Defaults.Deck, 'Former deck')
    assert.equal(list.value, 'Former deck')
    assert.match(status.text, /Could not save/)
})
