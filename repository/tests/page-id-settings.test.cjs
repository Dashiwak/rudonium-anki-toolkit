// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
const { patchSettings } = require('../Build/install.cjs')

async function screen(saved, russian = false) {
    const nodes = [], notices = [], rows = []
    class Element {
        createEl(tag, options) {
            const child = Object.assign(new Element(), { tag, text: options?.text })
            nodes.push(child)
            return child
        }
        setText(text) { this.text = text }
    }
    class Control {
        constructor() { this.options = {} }
        setValue(value) { this.value = value; return this }
        addOption(key, text) { this.options[key] = text; return this }
        onChange(fn) { this.change = fn; return this }
        setDisabled(flag) { this.disabled = flag; return this }
        setButtonText(text) { this.text = text; return this }
        onClick(fn) { this.click = fn; return this }
    }
    class Setting {
        constructor() { rows.push(this) }
        setName(name) { this.name = name; return this }
        setDesc(desc) { this.desc = desc; return this }
        addDropdown(fn) { fn(this.dropdown = new Control()); return this }
        addToggle(fn) { fn(this.toggle = new Control()); return this }
        addButton(fn) { fn(this.button = new Control()); return this }
    }
    const plugin = {
        settings: { Defaults: { 'ID Comments': true }, ...saved.settings },
        loadData: async () => saved,
        saveData: async data => { if (plugin.offline) throw Error('write failed'); Object.assign(saved, data) },
    }
    const module = await load(['id-tools-settings-ui'], { Setting, Notice: class { constructor(msg) { notices.push(msg) } },
        createSettingsGroup: () => new Element(), uiFor: () => (en, ru) => russian ? ru : en,
        uiDiagnostic: String, withFastScanReadLock: (_, run) => run(), savePluginDataInOrder: (_, run) => run() })
    let opened = 0
    module['id-tools-settings-ui'].installIdMarkerSettings(new Element(), plugin, {moveVaultPages: () => { opened++ }})
    return { plugin, notices, bulk: rows.find(r => r.button?.text === (russian ? 'Перенести ID страниц…' : 'Move page IDs…')).button, opened: () => opened, row: rows.find(r => r.dropdown), sample: nodes.find(n => n.tag === 'pre') }
}

test('new vaults use YAML and the saved choice, examples and bulk action follow the interface language', async () => {
    const saved = { journal: 'keep', settings: { extra: 42 } }
    const ui = await screen(saved)
    assert.equal(ui.row.dropdown.value, 'yaml')
    assert.match(ui.sample.text, /^---\nanki-page-ID: '123'\n---\n# Question #anki-page/)
    assert.deepEqual(Object.keys(saved.settings), ['extra'])
    ui.bulk.click()
    assert.equal(ui.opened(), 1)
    await ui.row.dropdown.change('after-answer')
    assert.equal(saved.settings.PAGE_ID_LOCATION, 'after-answer')
    assert.equal(saved.settings.extra, 42)
    assert.equal(saved.journal, 'keep')
    assert.equal(ui.sample.text, '# Question #anki-page\n\nAnswer\n<!--ID: 123 @page-->')
    const reopened = await screen(saved, true)
    assert.equal(reopened.row.dropdown.value, 'after-answer')
    assert.deepEqual(Object.values(reopened.row.dropdown.options), ['В свойствах (YAML)', 'Под заголовком', 'После ответа'])
    assert.equal(reopened.sample.text, '# Вопрос #anki-page\n\nОтвет\n<!--ID: 123 @page-->')
    reopened.bulk.click()
    assert.equal(reopened.opened(), 1)
    reopened.plugin.offline = true
    await reopened.row.dropdown.change('heading')
    assert.equal(reopened.row.dropdown.value, 'after-answer')
    assert.equal(saved.settings.PAGE_ID_LOCATION, 'after-answer')
    assert.equal(reopened.row.dropdown.disabled, false)
    assert.match(reopened.notices[0], /write failed/)
    reopened.plugin.offline = false
    await reopened.row.dropdown.change('heading')
    assert.equal(saved.settings.PAGE_ID_LOCATION, 'heading')
    assert.match(reopened.sample.text, /# Вопрос #anki-page\n<!--ID: 123-->/)
    assert.equal((await screen(saved)).row.dropdown.value, 'heading')
})

test('generated setting-to-data passes the vault preference and defaults unset or invalid choices to YAML', async () => {
    const original = `export async function settingToData(app: unknown, settings: any, fields_dict: Record<string, string[]>): Promise<ParsedSettings> {
    const result = {}
    result.EXISTING_IDS = await AnkiConnect.invoke('findNotes', { query: '' }) as number[]
    result.comment = settings.Defaults["ID Comments"]
    return result
}`
    const src = patchSettings(original)
    const mods = await load(['setting-to-data'], { activeExportRules: () => [] }, { 'setting-to-data': src })
    for (const [raw, expected] of [[undefined, 'yaml'], ['other', 'yaml'], ['heading', 'heading'], ['yaml', 'yaml'], ['after-answer', 'after-answer']]) {
        const settings = { Defaults: {}, PAGE_ID_LOCATION: raw }
        const result = await mods['setting-to-data'].settingToData({}, settings, {}, [])
        assert.equal(result.page_id_location, expected)
    }
})
