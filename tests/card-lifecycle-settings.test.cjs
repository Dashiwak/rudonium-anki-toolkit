// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
const { patchInterfaceSettings } = require('../Build/install.cjs')

async function screen(settings = {}) {
    const rows = [], notices = []
    class Control {
        addOption(key, label) { (this.options ??= []).push([key, label]); return this }
        setValue(value) { this.value = value; return this }
        setDisabled(value) { this.disabled = value; return this }
        onChange(change) { this.change = change; return this }
        setButtonText(label) { this.label = label; return this }
        onClick(click) { this.click = click; return this }
    }
    class Setting {
        constructor() { rows.push(this) }
        setName(name) { this.name = name; return this }
        setDesc(desc) { this.desc = desc; return this }
        addDropdown(cb) { cb(this.dropdown = new Control()); return this }
        addToggle(cb) { cb(this.toggle = new Control()); return this }
        addText(cb) { cb(this.text = new Control()); return this }
        addButton(cb) { cb(this.button = new Control()); return this }
    }
    let saved = { checkpoint: 'keep', settings: {} }, opened = 0
    let error = false
    const plugin = { settings: { Syntax: { 'Delete Note Line': 'REMOVE' }, ...settings }, loadData: async () => saved,
        saveData: async data => { if (error) throw Error('write failed'); saved = data } }
    const modules = await load(['card-lifecycle-settings', 'suspend-label', 'deletion-policy'], {
        Setting, Notice: class { constructor(message) { notices.push(message) } }, uiFor: () => en => en,
        uiDiagnostic: error => String(error), createSettingsGroup: () => ({}),
        openFrozenFields: target => { assert.equal(target, plugin); opened++ },
        withFastScanReadLock: (_plugin, run) => run(), savePluginDataInOrder: (_plugin, run) => run(),
    })
    const api = modules['card-lifecycle-settings']
    api.installCardLifecycleSettings({}, plugin)
    return { rows, notices, plugin, api, opened: () => opened, saved: () => saved, fail: () => { error = true } }
}

test('Renaming a suspension marker previews literal ordinals, retains aliases and saves only on request', async () => {
    const state = await screen()
    const [row] = state.rows
    assert.equal(row.text.value, 'SUSPEND')
    assert.equal(row.button.disabled, true)
    row.text.change('REMOVE')
    assert.equal(row.button.disabled, true)
    row.text.change('ПАУЗА[x]')
    assert.equal(row.button.disabled, false)
    assert.match(row.desc, /ПАУЗА\[x\]_2/u)
    assert.equal(state.plugin.settings.Syntax['Suspend Line'], undefined)
    await row.button.click()
    assert.equal(state.saved().checkpoint, 'keep')
    assert.equal(state.saved().settings.Syntax['Suspend Line'], 'ПАУЗА[x]')
    assert.deepEqual(JSON.parse(state.plugin.settings.Syntax['Suspend Line Aliases']), ['SUSPEND'])
    assert.equal(state.api.allowSyntaxEdit(state.plugin, 'Delete Note Line', 'ПАУЗА[x]'), false)
    assert.equal(state.api.allowSyntaxEdit(state.plugin, 'Delete Note Line', 'SUSPEND'), false)
    row.text.change('SUSPEND')
    await row.button.click()
    assert.deepEqual(JSON.parse(state.plugin.settings.Syntax['Suspend Line Aliases']), ['ПАУЗА[x]'])
})

test('Cleanup defaults protect blocks and pages, master opt-out disarms both, failed saves leave state intact', async () => {
    const state = await screen()
    const [, blocks, pages, shared] = state.rows
    assert.equal(blocks.dropdown.value, 'keep')
    assert.equal(pages.toggle.disabled, true)
    await blocks.dropdown.change('remove')
    assert.equal(pages.toggle.disabled, false)
    await pages.toggle.change(true)
    assert.equal(state.plugin.settings.TRASH_DELETED_PAGES, true)
    await blocks.dropdown.change('keep')
    assert.equal(pages.toggle.value, false)
    assert.equal(state.saved().settings.TRASH_DELETED_PAGES, false)
    await shared.button.click()
    assert.equal(state.opened(), 1)
    state.fail()
    await blocks.dropdown.change('remove')
    assert.equal(blocks.dropdown.value, 'keep')
    assert.equal(pages.toggle.disabled, true)
    assert.match(state.notices.at(-1), /write failed/)
})

test('Installer connects the settings group once and keeps historical marker aliases out of the editable syntax list', () => {
    const patched = patchInterfaceSettings('this.setup_workflows()\nfor (let key of Object.keys(plugin.settings["Syntax"])) {\ntext => text.setValue(plugin.settings["Syntax"][key]).onChange((value) => { plugin.settings["Syntax"][key] = value\nplugin.saveAllData() })\n}')
    assert.match(patched, /installCardLifecycleSettings\(this.containerEl/)
    assert.match(patched, /key === 'Suspend Line Aliases'\) continue/)
    assert.match(patched, /text => bindSyntaxEdit\(text, plugin, key\)/)
})

test('Scheduling diagnostics display the selected language and retain the Markdown path', async () => {
    const { 'interface-language': { uiDiagnostic, englishUi, russianUi } } = await load(['interface-language'], {})
    const message = 'Cards/Linz.md: Invalid numbers. / Проверьте номера.'
    assert.equal(uiDiagnostic(message, englishUi), 'Cards/Linz.md: Invalid numbers.')
    assert.equal(uiDiagnostic(message, russianUi), 'Cards/Linz.md: Проверьте номера.')
})

test('A partially entered deletion marker stays inactive until committed and an invalid rename restores the saved marker', async () => {
    const state = await screen(), events = {}
    let saved
    const input = { inputEl: { addEventListener: (name, cb) => { events[name] = cb } },
        getValue() { return this.val }, setValue(value) { this.val = value; return this },
        setDisabled(value) { this.disabled = value; if (!value) saved(); return this } }
    state.api.bindSyntaxEdit(input, state.plugin, 'Delete Note Line')
    async function blur() {
        const settled = new Promise(resolve => { saved = resolve })
        events.blur()
        await settled
    }
    input.val = 'RE'
    assert.equal(state.plugin.settings.Syntax['Delete Note Line'], 'REMOVE')
    input.val = 'SUSPEND'
    await blur()
    assert.equal(input.val, 'REMOVE')
    input.val = 'END'
    await blur()
    assert.equal(input.val, 'REMOVE')
    assert.match(state.notices.at(-1), /deletion marker/)
    input.val = 'УДАЛИТЬ'
    await blur()
    assert.equal(state.plugin.settings.Syntax['Delete Note Line'], 'УДАЛИТЬ')
})

test('Generated upstream settings type accepts both optional syntax keys for old and new vaults', () => {
    const { patchIdDateInterfaces } = require('../Build/install.cjs')
    const src = 'export interface PluginSettings {\n    Syntax: {\n        "Frozen Fields Line": string\n    },\n    Defaults: {\n        "ID Comments": boolean,\n        "Deck": string\n    }\n}\ninterface FileData {\n    comment: boolean\n    tag: string\n}'
    const patched = patchIdDateInterfaces(src)
    assert.match(patched, /"Suspend Line"\?: string,/)
    assert.match(patched, /"Suspend Line Aliases"\?: string,/)
})

test('Existing removal preferences survive upgrade, marking disarms page trash and keeps both options exclusive', async () => {
    const s = await screen({ CLEAN_DELETED_BLOCKS: true, TRASH_DELETED_PAGES: true })
    const [, mode, pages] = s.rows
    assert.equal(mode.dropdown.value, 'remove')
    assert.equal(pages.toggle.value, true)
    await mode.dropdown.change('mark')
    assert.equal(s.saved().settings.MARK_DELETED_BLOCKS, true)
    assert.equal(s.saved().settings.CLEAN_DELETED_BLOCKS, false)
    assert.equal(s.saved().settings.TRASH_DELETED_PAGES, false)
    assert.equal(pages.toggle.disabled, true)
    await mode.dropdown.change('remove')
    assert.equal(s.saved().settings.MARK_DELETED_BLOCKS, false)
    assert.equal(pages.toggle.value, false)
    assert.equal(pages.toggle.disabled, false)
})

test('The five mutually exclusive modes retain their order and survive reload without arming page trash', async () => {
    const page = await screen()
    const [, mode, pages] = page.rows
    assert.deepEqual(mode.dropdown.options.map(option => option[0]), ['keep', 'remove', 'mark', 'strike', 'hidden'])
    for (const selected of ['hidden', 'strike', 'mark', 'remove', 'keep']) {
        await mode.dropdown.change(selected)
        const saved = page.saved().settings
        assert.equal(saved.AFTER_DELETE_MODE, selected)
        assert.equal(saved.TRASH_DELETED_PAGES, false)
        assert.equal(mode.dropdown.value, selected)
        assert.equal(pages.toggle.disabled, selected !== 'remove')
        const reopened = await screen(saved)
        assert.equal(reopened.rows[1].dropdown.value, selected)
    }
})
test('Invalid newer settings default to retaining the source, while 0.8.5 settings retain their old mode', async () => {
    for (const [settings, expected] of [
        [{ AFTER_DELETE_MODE: 'unknown', CLEAN_DELETED_BLOCKS: true, TRASH_DELETED_PAGES: true }, 'keep'],
        [{ AFTER_DELETE_MODE: 'hidden', CLEAN_DELETED_BLOCKS: true }, 'hidden'],
        [{ MARK_DELETED_BLOCKS: true }, 'mark'], [{ CLEAN_DELETED_BLOCKS: true }, 'remove'], [{}, 'keep'],
    ]) assert.equal((await screen(settings)).rows[1].dropdown.value, expected)
})
