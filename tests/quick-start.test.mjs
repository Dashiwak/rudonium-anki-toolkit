// SPDX-License-Identifier: GPL-3.0-only
import createClassList from './dom-class-list.cjs'
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'

const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const modules = {}
const source = name => stripTypeScriptTypes(readFileSync(overlay.file(name + '.ts'), 'utf8'), { mode: 'transform' })
function register(name, code) {
    modules[name] = url(code.replace(/from '(?:\.\/)?([\w/-]+)'/g, (match, dep) => {
        assert.ok(modules[dep], 'Missing dependency ' + dep)
        return 'from ' + JSON.stringify(modules[dep])
    }))
}
register('obsidian', `
const createClassList = ${createClassList}
export class Notice {}
export const modals = []
export function setIcon(element, icon) { element.icon = icon }
export class Element {
    constructor(tag = 'div', options = {}) { this.tag = tag; this.text = options.text; this.attr = options.attr || {}; this.children = []; this.classList = createClassList(); this.options = []; this.isConnected = true; this.value = options.value || '' }
    empty() { this.children = [] }
    setText(value) { this.text = value }
    setAttribute(key, value) { this.attr[key] = value }
    getAttribute(key) { return this.attr[key] ?? null }
    querySelectorAll(selector) {
        if (selector === 'details[data-rudonium-settings-group]') return this.all().filter(el => el.tag === 'details' && el.attr['data-rudonium-settings-group'])
        throw new Error('Unexpected selector: ' + selector)
    }
    focus() { this.focused = true }
    scrollIntoView() { this.scrolled = true }
    createEl(tag, options) { const child = new Element(tag, options); child.parent = this; this.children.push(child); return child }
    createSpan(options) { return this.createEl('span', options) }
    createDiv(options) { return this.createEl('div', options) }
    all() { return [this, ...this.children.flatMap(child => child.all())] }
    setValue(value) { this.value = value; return this }
    onChange(callback) { this.change = callback; return this }
    onClick(callback) { this.onclick = callback; return this }
    setDisabled(value) { this.disabled = value; return this }
    setButtonText(value) { this.text = value; return this }
    addOption(value) { this.options.push(value); return this }
}
export class Modal {
    constructor() { this.contentEl = new Element(); this.titleEl = new Element() }
    open() { modals.push(this); this.onOpen?.() }
    close() { modals.pop(); this.onClose() }
}
export class Setting {
    constructor(container) { this.element = container.createEl('setting') }
    setName(value) { this.element.text = value; return this }
    setDesc(value) { this.element.hint = value; return this }
    addDropdown(render) { render(this.element.createEl('select')); return this }
    addText(render) { const input = this.element.createEl('input'); input.inputEl = input; render(input); return this }
    addTextArea(render) { const area = this.element.createEl('textarea'); area.inputEl = area; render(area); return this }
    addToggle(render) { render(this.element.createEl('toggle')); return this }
    addButton(render) { render(this.element.createEl('button')); return this }
}
`)
register('first-run-formats', source('first-run-formats'))
register('anki-profile', "export class AnkiProfileError extends Error { constructor(reason) { super(reason); this.reason=reason } }; export const profileProblemText = err => err.message; export const expectedAnkiProfile = () => undefined; export const checkPinnedAnkiProfile = async name => { if (await profile.read() !== name) throw new AnkiProfileError('mismatch'); }; export const profile = { read: async () => 'Default profile' }; export const readActiveAnkiProfile = () => profile.read()")
register('anki-study-state', "export const deckKind = { read: async () => 'ordinary' }; export const readAnkiDeckKind = name => deckKind.read(name)")
register('card-preview-render', 'export const readCardTemplateVariants = () => {}; export const buildBasicCardVariants = () => []')
register('card-preview-ui', 'export const openCardPreview = () => {}; export const previewFieldText = (_document, html) => html')
register('modal-layout', 'export const installModalLayout = () => {}')
register('sync-audit', `
export const schema = {names: ['Basic','Other'], fields: {Basic: ['Front','Back','Source'], Other: ['Q','A']}}
export async function auditRead(action, params) {
    if (action === 'deckNames') return ['Default','Cities']
    if (action === 'modelNames') return [...schema.names]
    if (action === 'multi') return params.actions.map(a => ({error: null, result: [...schema.fields[a.params.modelName]]}))
    throw Error('Unexpected Anki action: ' + action)
}`)
register('fast-scan', 'export const withFastScanReadLock = async (_plugin, task) => task(); export const savePluginDataInOrder = async (_plugin, task) => task()')
register('settings-layout', source('settings-layout'))
register('custom-regexp-worker', `export const customRegexpKey = p => p.source; export const matchCustomRegexps = async (sample, [p]) => new Map([[p.source, [...sample.matchAll(new RegExp(p.source, p.flags))]]])`)
register('rule-note-preview', 'export const previewRuleOnNote = (...args) => args[0].previewRule(...args.slice(1)); export const showRuleReport = (el, result) => el.setText(result.path)')
register('folder-tree', `
export const vaultFolderEntries = () => [{path:'Cards'},{path:'Special'}]
export function createFolderTree(parent, options) {
    for (const entry of options.entries) options.renderAction(parent, parent, entry)
    return {focus() {}}
}`)
register('page-migration-context', "export const detectMigrationFolders = async () => ['Cards']")
register('page-migration', `
export const previewPageMigration = async (plugin, options, signal, progress) => plugin.preview(options, signal, progress)
export const migrationBackupDirectory = async () => '/backups/test vault'
export const applyPageMigration = async (plugin, ...args) => plugin.apply(...args)
`)
for (const name of ['interface-language', 'sync-outcome', 'page-id-location', 'plugin-identity', 'copy-block', 'card-format-presets', 'note-type-rules', 'delimited-rule', 'regexp-wizard', 'note-type-rule-ui', 'page-migration-ui', 'note-type-refresh', 'first-connection']) register(name, source(name))

const { modals, Element } = await import(modules.obsidian)
const { cardFormatPresets } = await import(modules['card-format-presets'])
const { installNoteTypeRules } = await import(modules['note-type-rule-ui'])
const { registerSetupCommand, verifyFirstConnection } = await import(modules['first-connection'])
const { schema } = await import(modules['sync-audit'])
const { profile, AnkiProfileError } = await import(modules['anki-profile'])
function offline(t) {
    const original = profile.read
    profile.read = async () => { throw new AnkiProfileError('unreachable') }
    t.after(() => { profile.read = original })
}
const row = (el, name) => { const found = el.all().find(item => item.text === name); assert.ok(found, 'control: ' + name); return found }
const select = (el, label, value) => row(el, label).children[0].change(value)
const click = (el, label) => row(el, label).onclick()
function openRuleTools(el, label = 'Rule tools') {
    const details = row(el, label).parent
    assert.equal(details.tag, 'details')
    details.open = true
    return details
}
const settle = () => setImmediate()
const id = 'rudonium-anki-toolkit'

function setupCommand(plugin) {
    let command
    plugin.addCommand = value => {command = value}
    plugin.app.workspace ??= {onLayoutReady() {}}
    registerSetupCommand(plugin, task => task(), () => !!plugin.stopped)
    assert.equal(command.id, 'ankiconnect-first-run')
    return command
}
function freshSetup(settings, save) {
    const plugin = {manifest: {id}, app: {}, settings, fields_dict: {}, note_types: [], register() {},
        saveAllData: async () => save({settings: plugin.settings, fields_dict: plugin.fields_dict})}
    const command = setupCommand(plugin)
    command.callback()
    return plugin
}
test('Quick Start opens after layout once per session and reopens after a dismissed window on the next launch', async () => {
    let ready
    const plugin = {settings:{Defaults:{Deck:'Default'}}, fields_dict:{}, register(){}, app:{workspace:{onLayoutReady(cb){ready=cb}}}}
    const before = modals.length
    const command = setupCommand(plugin)
    assert.equal(command.name,'Quick Start')
    assert.equal(modals.length,before)
    ready(); await settle()
    assert.equal(modals.length,before + 1)
    assert.equal(modals.at(-1).titleEl.text,'Quick Start')
    modals.at(-1).close()
    setupCommand(plugin)
    ready(); await settle()
    assert.equal(modals.length,before)
    command.callback()
    assert.equal(modals.length,before + 1)
    modals.at(-1).close()
    const reopened = {...plugin}
    setupCommand(reopened)
    ready(); await settle()
    assert.equal(modals.length, before + 1)
    modals.at(-1).close()
    reopened.stopped=true
    ready(); await settle()
    assert.equal(modals.length,before)
})
test('opting out while offline persists without saving a deck or format, and can be reversed in manual setup', async t => {
    offline(t)
    let saved, ready
    const launch = () => {
        const plugin = { settings: structuredClone(saved ?? {Defaults:{Deck:'Default'}, QUICK_START_STATUS:'pending'}),
            fields_dict: {}, app:{workspace:{onLayoutReady(cb){ ready=cb }}}, register(){},
            async saveAllData() { saved = structuredClone(this.settings) } }
        const command = setupCommand(plugin)
        ready()
        return command
    }
    const before = modals.length
    const checkbox = () => row(modals.at(-1).contentEl, 'Don’t show Quick Start automatically').parent.children[0]
    launch(); await settle()
    checkbox().checked = true; checkbox().onchange(); await settle()
    assert.deepEqual(saved,{Defaults:{Deck:'Default'}, QUICK_START_STATUS:'dismissed'})
    modals.at(-1).close()
    const manual = launch()
    assert.equal(modals.length,before)
    manual.callback(); await settle()
    assert.equal(checkbox().checked, true)
    checkbox().checked = false; checkbox().onchange(); await settle()
    modals.at(-1).close()
    launch()
    assert.equal(modals.length,before+1)
    modals.at(-1).close()
})

test('legacy block-only profile retains its custom delimiters, optional fields and export settings after Quick Start', async t => {
    const originalFields = schema.fields, originalNames = schema.names
    schema.names = ['Basic','EnDic26']
    schema.fields = {Basic:['Front','Back'], EnDic26:['Word','Translation','File','Context']}
    t.after(() => { schema.fields = originalFields; schema.names = originalNames })
    const settings = { Defaults:{Deck:'Cities',Tag:'vocabulary','Add File Link':true,'Add Context':true,'Scheduling Interval':15},
        Syntax:{'Begin Note':'CARD','End Note':'ENDCARD'}, CUSTOM_REGEXPS:{Basic:'',EnDic26:''},
        FILE_LINK_FIELDS:{Basic:'Front',EnDic26:'File'}, CONTEXT_FIELDS:{Basic:'Front',EnDic26:'Context'},
        FOLDER_DECKS:{Cards:'Cities'}, FOLDER_TAGS:{Cards:'study'},
        SYNC_CHANGE_HISTORY:false, BIDIRECTIONAL_SYNC:false, INTERFACE_LANGUAGE:'ru' }
    let saved
    const plugin = {settings, fields_dict:{}, app:{}, note_types:[], register(){},
        async saveAllData() { saved = structuredClone(settings) } }
    const before = structuredClone(settings)
    setupCommand(plugin).callback()
    const modal = modals.at(-1)
    await settle()
    const types = row(modal.contentEl, 'Типы записей').parent
    assert.equal(types.tag,'fieldset')
    assert.equal(row(types, 'EnDic26').hint, 'CARD / ENDCARD')
    assert.ok(!modal.contentEl.all().some(el => ['Basic', 'Формат карточки', 'Поле ссылки на файл', 'Поле контекста'].includes(el.text)))
    click(modal.contentEl,'Изменить')
    const editor = modals.at(-1).contentEl
    assert.equal(row(editor, 'Формат карточки').children[0].value, 'explicit')
    assert.equal(row(editor, 'Поле ссылки на файл').children[0].value, 'File')
    assert.equal(row(editor, 'Поле контекста').children[0].value, 'Context')
    assert.ok(editor.all().some(el => el.text?.startsWith('CARD\nEnDic26\nWord: На каком корабле') && el.text.endsWith('Восток-1\nENDCARD')))
    click(editor, 'Отмена')
    click(modal.contentEl,'Сохранить настройки'); await settle()
    for (const [key,value] of Object.entries(before)) assert.deepEqual(saved[key], value, key)
    assert.equal(saved.QUICK_START_STATUS,'complete')
})

test('Quick Start offers a complete local AnkiConnect example and copies only the selected value', async t => {
    offline(t)
    let reject = false
    const copied = []
    const clipboard = { async writeText(text) {
        if (reject) throw new Error('permission denied')
        copied.push(text)
    } }
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    t.after(() => original ? Object.defineProperty(navigator, 'clipboard', original) : delete navigator.clipboard)
    for (const [lang, title, check, copy, manual] of [
        ['en', 'Set up AnkiConnect', 'Check Connection', 'Copied.', 'Select the text above and copy it manually.'],
        ['ru', 'Как настроить AnkiConnect', 'Проверить соединение', 'Скопировано.', 'Выделите текст выше и скопируйте его вручную.'],
    ]) {
        freshSetup({ INTERFACE_LANGUAGE: lang, Defaults: { Deck: 'Default' }, CUSTOM_REGEXPS: {} },
            () => assert.fail('Reading setup instructions must not change settings'))
        const modal = modals.at(-1)
        await settle()
        const guide = row(modal.contentEl, title).parent
        const linkText = lang === 'en' ? 'Quick Start guide' : 'Руководство по быстрому старту'
        assert.equal(row(modal.contentEl, linkText).attr.href,
            'https://github.com/Dashiwak/rudonium-anki-toolkit/blob/HEAD/docs/' + lang + '/quick-start.md')
        const elements = guide.all()
        const [addon, origin, json] = elements.filter(el => el.tag === 'code').map(el => el.text)
        const readme = readFileSync(new URL('../' + (lang === 'en' ? 'README.md' : 'README.ru.md'), import.meta.url), 'utf8')
        const jsonBlock = readme.match(/```json\s*([\s\S]*?)```/)
        assert.ok(jsonBlock, lang + ' README must include an AnkiConnect configuration example')
        const example = JSON.parse(jsonBlock[1])
        assert.equal(addon, '2055492159')
        assert.equal(origin, '"app://obsidian.md"')
        assert.deepEqual(JSON.parse(json), example)
        assert.deepEqual(elements.filter(el => el.tag === 'a').map(el => el.attr.href), [
            'https://apps.ankiweb.net/', 'https://ankiweb.net/shared/info/2055492159'])
        const buttons = elements.filter(el => el.tag === 'button')
        const labels = lang === 'en'
            ? ['Copy add-on code', 'Copy Obsidian address', 'Copy example JSON']
            : ['Скопировать код дополнения', 'Скопировать адрес Obsidian', 'Скопировать пример JSON']
        assert.deepEqual(buttons.map(button => button.attr['aria-label']), labels)
        const statuses = elements.filter(el => el.attr.role === 'status')
        assert.equal(copied.length, 0)
        for (const [index, button] of buttons.entries()) {
            assert.equal(button.text, undefined)
            assert.equal(button.icon, 'copy')
            assert.equal(button.attr.type, 'button')
            assert.equal(button.attr.title, labels[index])
            assert.equal(button.parent.children[0].children[0].text, [addon, origin, json][index])
            button.onclick()
            await settle()
            assert.equal(statuses[index].text, copy)
        }
        assert.deepEqual(copied.splice(0), [addon, origin, json])
        reject = true
        buttons[2].onclick()
        await settle()
        assert.equal(statuses[2].text, manual)
        assert.equal(copied.length, 0)
        assert.equal(row(modal.contentEl, check).disabled, false)
        reject = false
        modal.close()
    }
})
test('opening Quick Start automatically checks Anki once, offers help only after failure and retries in place', async t => {
    const original = profile.read
    t.after(() => { profile.read = original })
    for (const [language, check, help, checking, offline, connected] of [
        ['en', 'Check Connection', 'Set up AnkiConnect', 'Checking Anki connection…', 'No connection to Anki', 'Connected to Anki'],
        ['ru', 'Проверить соединение', 'Как настроить AnkiConnect', 'Проверяем соединение с Anki…', 'Нет соединения с Anki', 'Соединение с Anki установлено'],
    ]) {
        let rejectCheck
        profile.read = () => new Promise((_resolve, reject) => { rejectCheck = reject })
        freshSetup({INTERFACE_LANGUAGE:language, Defaults:{Deck:'Default'}}, () => assert.fail('check must be read-only'))
        const modal = modals.at(-1), el = modal.contentEl
        assert.ok(row(el,checking))
        assert.ok(!el.all().some(item => item.text === help || item.text === check))
        rejectCheck(new AnkiProfileError('unreachable')); await settle()
        assert.ok(row(el,offline))
        assert.match(row(el,offline).parent.children[1].text, /AnkiConnect/)
        assert.equal(row(el,help).parent.open,false)
        profile.read = original
        click(el,check); await settle()
        assert.ok(row(el,connected))
        assert.equal(row(el,language === 'en' ? 'Deck' : 'Колода').children[0].value, 'Default')
        assert.ok(!el.all().some(item => item.text === help || item.text === check))
        modal.close()
    }
})
test('closing Quick Start while the automatic check is running never opens another window or saves', async t => {
    const original = profile.read
    let resume
    profile.read = () => new Promise(resolve => { resume = resolve })
    t.after(() => { profile.read = original })
    const before = modals.length
    freshSetup({Defaults:{}}, () => assert.fail())
    const modal = modals.at(-1)
    modal.close()
    profile.read = original
    resume('Default profile'); await settle()
    assert.equal(modals.length, before)
    assert.equal(modal.contentEl.children.length,0)
})
test('the same profile recovers pending choices after an offline Save; switching profiles resets the draft', async t => {
    const original = profile.read
    t.after(() => { profile.read = original })
    const plugin = freshSetup({ Defaults: { Deck: 'Default' }, CUSTOM_REGEXPS: {} }, () => assert.fail('read-only check'))
    const modal = modals.at(-1), el = modal.contentEl
    try {
        await settle()
        select(el,'Deck','Cities')
        click(el,'Add note type')
        const editor = modals.at(-1).contentEl
        select(editor,'Note type','Other'); click(editor,'Save rule'); await settle()
        assert.ok(row(el,'Other'))
        profile.read = async () => { throw new AnkiProfileError('unreachable') }
        click(el,'Save Setup'); await settle()
        assert.ok(row(el,'No connection to Anki'))
        assert.ok(!el.all().some(item => item.text === 'Save Setup'))
        profile.read = original
        click(el,'Check Connection'); await settle()
        assert.equal(row(el,'Deck').children[0].value,'Cities')
        assert.ok(row(el,'Other'))
        profile.read = async () => 'Another profile'
        click(el,'Save Setup'); await settle()
        click(el,'Check Connection'); await settle()
        assert.equal(row(el,'Deck').children[0].value,'Default')
        assert.ok(!el.all().some(item => item.text === 'Other'))
        assert.deepEqual(plugin.settings,{ Defaults: { Deck: 'Default' }, CUSTOM_REGEXPS: {} })
    } finally { modal.close() }
})
test('first setup saves the verified schema and deck without silently assigning a format', async () => {
    const before = modals.length
    let written
    const plugin = freshSetup({Defaults:{Deck:'Default'},CUSTOM_REGEXPS:{}}, data => { written = data })
    const modal = modals.at(-1), el = modal.contentEl
    await settle()
    select(el,'Deck','Cities')
    const types = row(el, 'Note types').parent
    assert.equal(types.tag, 'fieldset')
    assert.ok(row(types,'Add note type'))
    assert.ok(!el.all().some(item => ['Card format','Note type','File link field','More options','Migrate existing card files','Regular expression wizard'].includes(item.text)))
    click(el,'Save Setup'); await settle()
    assert.deepEqual(plugin.note_types,schema.names)
    assert.equal(written.settings.QUICK_START_STATUS,'complete')
    assert.equal(written.settings.Defaults.Deck,'Cities')
    assert.deepEqual(written.settings.CUSTOM_REGEXPS,{Basic:'',Other:''})
    assert.equal(written.settings.NOTE_TYPE_RULE_MODELS,undefined)
    assert.equal(modals.length,before)
})
test('Cancel or failed Save does not persist staged rules, deck, schema, or profile', async () => {
    const settings = { Defaults: { Deck: 'Default' }, CUSTOM_REGEXPS: { Basic: '', Other: 'Q=(.+)' },
        FILE_LINK_FIELDS: { Other: 'Q' }, CONTEXT_FIELDS: { Basic: 'Source' }, NOTE_TYPE_RULE_MODELS: ['Basic'],
        EXPECTED_ANKI_PROFILE: 'Default profile', REQUIRE_ANKI_PROFILE: true }
    const snapshot = structuredClone(settings)
    const plugin = { settings, fields_dict: schema.fields, app: {}, register() {}, saveAllData: async () => { throw Error('write failed') } }
    const cmd = setupCommand(plugin)
    for (const attemptSave of [false, true]) {
        cmd.callback(); await settle()
        const modal = modals.at(-1), el = modal.contentEl
        click(el,'Edit')
        const editor = modals.at(-1).contentEl
        select(editor,'Card format','page')
        click(editor,'Save rule'); await settle()
        select(el,'Deck','Cities')
        assert.deepEqual(settings,snapshot)
        if (attemptSave) {
            click(el,'Save Setup'); await settle()
            assert.ok(row(el,'write failed'))
        }
        modal.close()
        assert.deepEqual(settings,snapshot)
        assert.equal(plugin.fields_dict,schema.fields)
    }
})
test('schema drift aborts a save and a retry loads current fields before accepting another edit', async t => {
    const fields = schema.fields
    t.after(() => { schema.fields = fields })
    let saved
    freshSetup({ Defaults:{Deck:'Cities'}, CUSTOM_REGEXPS:{} }, data => { saved = data })
    const modal = modals.at(-1), el = modal.contentEl
    await settle()
    click(el,'Add note type')
    select(modals.at(-1).contentEl,'File link field','Source')
    click(modals.at(-1).contentEl,'Save rule'); await settle()
    schema.fields = { ...fields, Basic: ['Front','Back','Link'] }
    click(el,'Save Setup'); await settle()
    assert.equal(saved,undefined)
    assert.ok(row(el,'The Anki note types changed. Check the connection again.'))
    click(el,'Check Connection'); await settle()
    assert.ok(!el.all().some(item => item.text === 'Basic'))
    click(el,'Add note type')
    const editor = modals.at(-1).contentEl
    select(editor,'File link field','Link')
    click(editor,'Save rule'); await settle()
    click(el,'Save Setup'); await settle()
    assert.equal(saved.settings.FILE_LINK_FIELDS.Basic,'Link')
    assert.deepEqual(saved.fields_dict.Basic,schema.fields.Basic)
})
test('a deck removed after opening allows a reconnect and a closed Anki during verification shows the offline view', async t => {
    const { deckKind } = await import(modules['anki-study-state'])
    const original = profile.read, readKind = deckKind.read
    t.after(() => { profile.read = original; deckKind.read = readKind })
    let saved
    freshSetup({Defaults:{Deck:'Cities'},CUSTOM_REGEXPS:{}}, data => { saved = data })
    const modal = modals.at(-1), el = modal.contentEl
    await settle()
    deckKind.read = async () => 'missing'
    click(el,'Save Setup'); await settle()
    assert.equal(saved,undefined)
    assert.ok(row(el,'The selected deck is no longer available. Check the connection again.'))
    click(el,'Check Connection'); await settle()
    deckKind.read = async () => {
        profile.read = async () => { throw new AnkiProfileError('unreachable') }
        throw Error('network request failed')
    }
    click(el,'Save Setup'); await settle()
    assert.ok(row(el,'No connection to Anki'))
    assert.ok(!el.all().some(item => item.text === 'Save Setup'))
    assert.equal(saved,undefined)
    modal.close()
})
test('another settings edit during Quick Start keeps its value and requires a fresh draft', async () => {
    const plugin = freshSetup({Defaults:{Deck:'Default'},CUSTOM_REGEXPS:{}}, () => assert.fail('stale write'))
    const modal = modals.at(-1), el = modal.contentEl
    await settle()
    click(el,'Add note type'); click(modals.at(-1).contentEl,'Save rule'); await settle()
    plugin.settings.CUSTOM_REGEXPS.Other = 'Q=(.+)'
    click(el,'Save Setup'); await settle()
    assert.ok(el.all().some(item => item.text?.startsWith('The setup changed while Quick Start was open.')))
    assert.equal(plugin.settings.CUSTOM_REGEXPS.Other,'Q=(.+)')
    assert.equal(plugin.settings.QUICK_START_STATUS,undefined)
    modal.close()
})
test('rule editor adds one rule and cancels a later edit without touching existing regex or metadata', async () => {
    const settings = { CUSTOM_REGEXPS: { Basic: '', Other: 'Q=(.+)' }, FILE_LINK_FIELDS: { Basic: 'Front', Other: 'Q' } }
    let writes = 0
    const plugin = { settings, fields_dict: schema.fields, saveAllData: async () => { writes++ } }
    const container = new Element()
    installNoteTypeRules(container, plugin)
    click(container, 'Add note type')
    select(modals.at(-1).contentEl, 'Card format', 'qa')
    select(modals.at(-1).contentEl, 'File link field', 'Source')
    click(modals.at(-1).contentEl, 'Save rule'); await settle()
    assert.equal(writes, 1)
    assert.equal(settings.CUSTOM_REGEXPS.Basic, cardFormatPresets.find(p => p.id === 'qa').expression)
    assert.deepEqual(settings.FILE_LINK_FIELDS, { Basic: 'Source', Other: 'Q' })
    const before = structuredClone(settings)
    click(container, 'Edit')
    select(modals.at(-1).contentEl, 'File link field', 'Back')
    click(modals.at(-1).contentEl, 'Cancel')
    assert.deepEqual(settings, before)
    assert.equal(writes, 1)
})

test('a valid handwritten rule saves in Quick Start with empty optional sample and invalid syntax still blocks saving', async () => {
    let saved
    freshSetup({Defaults:{}, CUSTOM_REGEXPS:{}}, data => { saved = data })
    const modal = modals.at(-1)
    await settle()
    click(modal.contentEl, 'Add note type')
    const editor = modals.at(-1)
    select(editor.contentEl, 'Card format', 'custom')
    select(editor.contentEl, 'Regular expression', '@page')
    click(editor.contentEl, 'Save rule'); await settle()
    assert.ok(row(editor.contentEl, 'Select Whole page to use @page.'))
    const tools = row(editor.contentEl,'Rule tools').parent
    assert.equal(tools.open,false)
    for (const label of ['Regular expression wizard','Sample Markdown','Test sample','Check current note']) assert.ok(row(tools,label))
    assert.ok(!editor.contentEl.all().some(el => el.text === 'RemNote regular expression'))
    assert.equal(row(tools, 'Sample Markdown').children[0].value,'')
    select(editor.contentEl, 'Regular expression', 'no captures')
    click(editor.contentEl, 'Save rule'); await settle()
    assert.ok(row(editor.contentEl, 'Add a capture group for the first Anki field.'))
    assert.ok(!tools.all().some(el => el.text === 'Add a capture group for the first Anki field.'))
    select(editor.contentEl, 'Regular expression', '^Q=(.+) A=(.+)$')
    click(editor.contentEl, 'Save rule'); await settle()
    assert.equal(saved, undefined)
    click(modal.contentEl, 'Save Setup'); await settle()
    assert.equal(saved.settings.CUSTOM_REGEXPS.Basic, '^Q=(.+) A=(.+)$')
})

const { openPageMigration, installPageMigrationSetting, registerPageMigrationCommand } = await import(modules['page-migration-ui'])
test('migration settings and palette reach one bilingual wizard with scoped preview, ZIP and explicit unlinked confirmation', async () => {
    const calls = []
    const checked = { model: 'Basic', scanned: 4, warnings: [], rows: [
        { path:'Cards/linked.md', source:'yanki', id:101, status:'ready', before:'old', after:'# New #anki-page' },
        { path:'Cards/new.md', source:'yanki', status:'ready', before:'old', after:'# New #anki-page' },
        { path:'Cards/ambiguous.md', source:'flashcards', status:'review', reason:'ambiguous' },
        { path:'Cards/converted.md', source:'Rudonium', status:'already' },
    ] }
    let command
    const plugin = { settings: { CUSTOM_REGEXPS: { Basic:'@page' }, INTERFACE_LANGUAGE:'ru' },
        fields_dict: { Basic:['Front','Back'], Other:['Q','A'] }, app: { vault:{} }, register() {},
        addCommand(spec) { command = spec },
        preview: async options => { calls.push(options); return checked },
        apply: async (plan, selected, directory, _signal, _progress, ack) => {
            calls.push({ paths:[...selected], directory, ack }); assert.equal(plan, checked)
            return { archive:'/backups/old/Obsidian.zip', converted:[...selected] }
        },
    }
    registerPageMigrationCommand(plugin)
    assert.equal(command.id, 'migrate-page-cards')
    assert.equal(command.name, 'Перенести карточки из файлов')
    const group = new Element()
    installPageMigrationSetting(group, plugin)
    click(group, 'Настроить перенос'); const modal = modals.at(-1)
    command.callback(); assert.equal(modals.filter(item => item === modal).length, 1)
    await settle()
    const sourcePicker = row(modal.contentEl, 'Yanki').parent
    sourcePicker.value='yanki'; sourcePicker.onchange()
    click(modal.contentEl, 'Всё хранилище')
    assert.ok(row(modal.contentEl, 'Всё хранилище, включая файлы Yanki без меток'))
    click(modal.contentEl, 'Папки с ID Yanki')
    modal.contentEl.all().find(item => item.attr['aria-label'] === 'Выбрать папку: Cards').onclick()
    click(modal.contentEl, 'Проверить файлы'); await settle()
    assert.deepEqual(calls, [{ model:'Basic', source:'yanki', folder:'Cards' }])
    assert.equal(row(modal.contentEl,'Создать копию и преобразовать').disabled, true)
    click(modal.contentEl, 'Выбрать только файлы с подтверждёнными ID')
    assert.equal(row(modal.contentEl,'Создать копию и преобразовать').disabled, false)
    const all = row(modal.contentEl, ' Выбрать все готовые файлы').parent.children[0]
    all.checked = true; all.onchange()
    assert.equal(row(modal.contentEl,'Создать копию и преобразовать').disabled, true)
    const comparison = row(modal.contentEl,'Сравнить Markdown').parent
    comparison.open = true; comparison.ontoggle(); assert.ok(row(comparison,'# New #anki-page'))
    const backup = row(modal.contentEl,'ZIP всего хранилища · папка для копии вне хранилища').parent.children.find(el => el.tag === 'input')
    assert.equal(backup.placeholder, '/backups/test vault'); backup.value='/outside'; backup.oninput()
    const ack = modal.contentEl.all().find(el => el.tag === 'span' && el.text?.includes('Включить файлы без')).parent.children[0]
    ack.checked=true; ack.onchange()
    assert.equal(row(modal.contentEl,'Создать копию и преобразовать').disabled, false)
    click(modal.contentEl,'Создать копию и преобразовать'); await settle()
    assert.deepEqual(calls[1], { paths:['Cards/linked.md','Cards/new.md'], directory:'/outside', ack:true })
    assert.ok(row(modal.contentEl,'/backups/old/Obsidian.zip')); modal.close()
})

test('an existing non-page regex can coexist with the preferred model for new pages; opening the wizard never edits it', async () => {
    const plugin = { settings: { PAGE_MODEL: 'Existing', CUSTOM_REGEXPS: { Existing: 'Q=(.+)' } },
        fields_dict: { Basic:['Front','Back'], Existing:['Q','A'] }, app: { vault:{} }, register() {} }
    openPageMigration(plugin)
    const modal = modals.at(-1)
    assert.equal(row(modal.contentEl, 'Preview files').disabled,false)
    assert.equal(row(modal.contentEl,'Default Anki note type for unlinked pages').parent.children[1].value, 'Existing')
    assert.equal(plugin.settings.CUSTOM_REGEXPS.Existing, 'Q=(.+)')
    modal.close()
})

test('failed and interrupted conversions keep the wizard open for a fresh preview and display the recovery ZIP', async () => {
    let attempts = 0
    let scans = 0
    const plugin = { settings: { CUSTOM_REGEXPS:{} }, fields_dict:{ Basic:['Front','Back'] }, app:{ vault:{} }, register() {},
        preview: async () => {
            scans++
            return { model:'Basic', scanned:1, warnings:[], rows:[
                { path:'Cards/A.md', source:'yanki', id:101, status:scans === 3 ? 'already' : 'ready' },
            ] }
        },
        apply: async () => {
            if (++attempts === 1) throw new Error('File changed. Refresh the preview.')
            return { archive:'/backups/interrupted.zip', converted:['Cards/A.md'], stopped:'Stopped by user.' }
        },
    }
    openPageMigration(plugin)
    const modal = modals.at(-1)
    click(modal.contentEl,'Preview files'); await settle()
    click(modal.contentEl,'Back up and convert'); await settle()
    assert.ok(row(modal.contentEl,'File changed. Refresh the preview.'))
    click(modal.contentEl,'Refresh preview'); await settle()
    click(modal.contentEl,'Back up and convert'); await settle()
    assert.ok(row(modal.contentEl,'Migration stopped'))
    assert.ok(row(modal.contentEl,'/backups/interrupted.zip'))
    click(modal.contentEl,'Check again'); await settle()
    assert.ok(row(modal.contentEl,'Already supported (1)'))
    assert.equal(row(modal.contentEl,'Back up and convert').hidden,true)
    assert.equal(row(modal.contentEl,'Full vault ZIP · backup folder outside the vault').parent.classList.contains('rudonium-hidden'), true)
    modal.close()
})

test('20,000 preview rows show 25 file comparisons per page and select verified IDs across all pages', async () => {
    const rows = Array.from({length:20000}, (_, index) => ({path:'Cards/'+index+'.md', source:'yanki',
        id:index % 2 ? undefined : index+1, status:'ready', before:'Old text', after:'# New #anki-page'}))
    let submitted
    const plugin = {settings:{CUSTOM_REGEXPS:{}}, fields_dict:{Basic:['Front','Back']}, app:{vault:{}}, register(){},
        preview:async () => ({model:'Basic', scanned:rows.length, warnings:[], rows}),
        apply:async (_plan,paths) => { submitted = paths; return {archive:'/outside/backup.zip', converted:[...paths]} },
    }
    openPageMigration(plugin)
    const modal = modals.at(-1)
    click(modal.contentEl,'Preview files'); await settle()
    assert.equal(modal.contentEl.all().filter(el => el.tag === 'details').length,25)
    assert.equal(modal.contentEl.all().filter(el => el.tag === 'pre').length,0)
    click(modal.contentEl,'Next')
    assert.ok(row(modal.contentEl,' 26–50 / 20000 '))
    click(modal.contentEl,'Select only files with verified IDs')
    click(modal.contentEl,'Back up and convert'); await settle()
    assert.equal(submitted.size,10000)
    assert.ok(submitted.has('Cards/19998.md'))
    assert.ok(!submitted.has('Cards/19999.md'))
    assert.equal(modal.contentEl.all().filter(el => el.tag === 'li').length,25)
    modal.close()
})

test('migration looks up absent IDs only on request, keeps the folder and requires separate confirmation', async () => {
    const calls = []
    const plugin = { settings:{CUSTOM_REGEXPS:{}}, fields_dict:{Basic:['Front','Back']}, app:{vault:{}}, register(){},
        preview:async options => {
            calls.push(options)
            const known = {path:'Cards/Linked.md', source:'anki-forge', id:12, status:'ready'}
            const lost = {path:'Cards/Lost.md', source:'anki-forge', status:'unchecked'}
            return {model:'Basic', scanned:2, warnings:[], rows:[known, options.checkMissingIds
                ? {...lost, status:'link', link:{id:34, model:'Basic', deck:'D', front:'Q', back:'A'}} : lost]}
        },
    }
    openPageMigration(plugin)
    const modal = modals.at(-1), view = modal.contentEl
    click(view, 'Entire vault')
    view.all().find(item => item.attr['aria-label'] === 'Choose folder: Cards').onclick()
    assert.equal(calls.length, 0)
    click(view,'Preview files'); await settle()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].checkMissingIds, undefined)
    assert.ok(row(view,'Not checked (1)'))
    let all = row(view,' Select all ready files').parent.children[0]
    all.checked = false; all.onchange()
    click(view,'Check cards without an ID'); await settle()
    assert.deepEqual(calls[1], {...calls[0], checkMissingIds:true})
    assert.equal(calls[1].folder, 'Cards')
    assert.equal(row(view,' Link to this note').parent.children[0].checked, false)
    assert.equal(row(view,'Back up and convert').disabled, true)
    assert.ok(!view.all().some(el => el.text === 'Check cards without an ID'))
    click(view,'Change selection criteria')
    click(view,'Preview files'); await settle()
    assert.deepEqual(calls[2], calls[0])
    modal.close()
})

test('recovery shows real Anki fields and records consent per path and ID across pages', async () => {
    const rows = Array.from({length: 30}, (_, i) => ({
        path: 'Cards/Q' + i + '.md', source: 'rudonium', status: 'link',
        before: 'old Q', after: 'new Q', link: {id: 700 + i, front: 'Remote Q' + i, back: 'Remote A' + i, model: 'Basic', deck: 'Cities'},
    }))
    rows.unshift({path:'Cards/Known.md', source:'anki-forge', id:2000, status:'ready'})
    let applied
    const plugin = {settings:{CUSTOM_REGEXPS:{}}, fields_dict:{Basic:['Front','Back']}, app:{vault:{}}, register(){},
        preview:async () => ({model:'Basic', scanned:rows.length, warnings:[], rows}),
        apply:async (_plan,selected,_dir,_signal,_progress,ack,links) => {
            applied = { paths:[...selected], ack, links:[...links] }
            return {archive:'/outside/backup.zip', converted:[...selected]}
        },
    }
    openPageMigration(plugin)
    const modal = modals.at(-1), view = modal.contentEl
    for (const source of ['Anki Forge','Anki Bridge','Anki AST Sync','Anki Exporter']) {
        assert.ok(view.all().some(el => el.tag === 'option' && el.text === source))
    }
    for (const native of ['Rudonium (@page)', 'Obsidian_to_Anki', 'Spaced Repetition']) assert.ok(!view.all().some(el => el.tag === 'option' && el.text === native))
    click(view,'Preview files'); await settle()
    const choices = () => view.all().filter(el => el.tag === 'input' && el.attr['aria-label']?.startsWith('Link '))
    assert.equal(choices().length, 24)
    assert.ok(choices().every(choice => !choice.checked))
    const groupCheck = row(view, ' Select all ready files').parent.children[0]
    groupCheck.checked = false
    groupCheck.onchange()
    assert.equal(row(view,'Back up and convert').disabled,true)
    groupCheck.checked = true
    groupCheck.onchange()
    assert.ok(choices().every(choice => !choice.checked))
    const filter = row(view,'Exact Anki match (30)').parent
    filter.value = 'link'; filter.onchange()
    const detail = row(view,'Anki ID 700 · Remote Q0').parent
    detail.open = true; detail.ontoggle()
    assert.ok(row(detail,'Remote Q0')); assert.ok(row(detail,'Remote A0'))
    assert.ok(row(view,'Note type · Basic   /   Deck · Cities'))
    choices()[0].checked = true; choices()[0].onchange()
    click(view,'Next')
    choices()[2].checked = true; choices()[2].onchange()
    click(view,'Previous')
    assert.equal(choices()[0].checked,true)
    choices()[0].checked = false; choices()[0].onchange()
    click(view,'Back up and convert'); await settle()
    assert.deepEqual(applied, {paths:['Cards/Known.md','Cards/Q27.md'],ack:false,links:[['Cards/Q27.md',727]]})
    modal.close()
})

test('a fresh preview resets individual recovery consent even when the file path stays the same', async () => {
    let remoteId = 10, requested
    const plugin = {settings:{CUSTOM_REGEXPS:{}, INTERFACE_LANGUAGE:'ru'}, fields_dict:{Basic:['Front','Back']}, app:{vault:{}}, register(){},
        preview:async () => ({model:'Basic',scanned:1,warnings:[],rows:[{path:'A.md',source:'anki-bridge',status:'link',
            link:{id:remoteId,model:'Basic',deck:'Vienna',front:'Вопрос',back:'Ответ'}}]}),
        apply:async (_plan,paths,_dir,_signal,_progress,allow,links) => {
            requested = {paths:[...paths],allow,links:[...links]}
            return {archive:'/outside/backup.zip',converted:[...paths]}
        },
    }
    openPageMigration(plugin)
    const modal = modals.at(-1), view = modal.contentEl
    click(view,'Проверить файлы'); await settle()
    const commit = () => row(view,'Создать копию и преобразовать')
    assert.equal(commit().hidden,false); assert.equal(commit().disabled,true)
    const checkbox = () => row(view,' Связать с этой записью').parent.children[0]
    checkbox().checked = true; checkbox().onchange()
    assert.equal(commit().disabled,false)
    click(view,'Изменить условия поиска')
    remoteId = 20
    click(view,'Проверить файлы'); await settle()
    assert.equal(commit().disabled,true); assert.equal(checkbox().checked,false)
    assert.equal(checkbox().attr['aria-label'],'Связать A.md с записью Anki 20')
    checkbox().checked = true; checkbox().onchange()
    click(view,'Создать копию и преобразовать'); await settle()
    assert.deepEqual(requested,{paths:['A.md'],allow:false,links:[['A.md',20]]})
    modal.close()
})

test('20,000 exact matches stay opt-in and only the displayed page renders Anki excerpts', async () => {
    const rows = Array.from({length:20000}, (_, index) => ({path:'Notes/' + index + '.md', source:'rudonium', status:'link',
        link:{id:index + 1, model:'Basic', deck:'Knowledge', front:'Q' + index, back:'A' + index}}))
    let consent
    const plugin = {settings:{CUSTOM_REGEXPS:{}}, fields_dict:{Basic:['Front','Back']}, app:{vault:{}}, register(){},
        preview:async () => ({model:'Basic',scanned:rows.length,warnings:[],rows}),
        apply:async (_plan,paths,_dir,_signal,_progress,allow,links) => {
            consent = {size:paths.size,allow,links:[...links]}
            return {archive:'/outside/backup.zip',converted:[...paths]}
        },
    }
    openPageMigration(plugin)
    const modal = modals.at(-1), view = modal.contentEl
    click(view,'Preview files'); await settle()
    assert.ok(row(view,'Exact Anki match (20000)'))
    assert.equal(view.all().filter(el => el.tag === 'summary').length,25)
    assert.equal(row(view,'Back up and convert').disabled,true)
    click(view,'Next')
    const check = view.all().find(el => el.attr['aria-label'] === 'Link Notes/49.md to Anki note 50')
    check.checked = true; check.onchange()
    click(view,'Back up and convert'); await settle()
    assert.deepEqual(consent,{size:1,allow:false,links:[['Notes/49.md',50]]})
    modal.close()
})

test('registering the startup check defers vault reads until layout and preserves existing settings', () => {
    const settings = { Defaults: { Deck: 'Cities' }, CUSTOM_REGEXPS: { Basic: '' }, INTERFACE_LANGUAGE: 'en' }
    const snapshot = structuredClone(settings), before = modals.length
    const plugin = { settings, fields_dict:schema.fields, app:{workspace:{onLayoutReady(){}}, get vault(){throw Error('early vault read')}} }
    setupCommand(plugin)
    assert.deepEqual(settings,snapshot)
    assert.equal(modals.length,before)
})
test('Anki may enumerate models in a different order between preview and verification', async () => {
    const connection = {names:[...schema.names].reverse(), fields:schema.fields, decks:['Cities'], profile:'Default profile'}
    await verifyFirstConnection(connection,'Cities')
})

test('Quick Start generates a four-field literal-colon rule from a live sample and pins field order', async () => {
    let saved
    schema.names.push('Vocabulary')
    schema.fields.Vocabulary = ['Question','Translation','Example','Language']
    try {
        freshSetup({Defaults:{}, CUSTOM_REGEXPS:{}}, data => { saved=data })
        const parent=modals.at(-1)
        await settle()
        click(parent.contentEl,'Add note type')
        const editor = modals.at(-1)
        select(editor.contentEl,'Note type','Vocabulary')
        click(openRuleTools(editor.contentEl),'Regular expression wizard')
        const wizard = modals.at(-1)
        select(wizard.contentEl,'Number of fields','4')
        const sample='- Wirtshaus : трактир : Ein altes Haus : de_DE'
        select(wizard.contentEl,'Sample Markdown line',sample.slice(0,sample.lastIndexOf(':')))
        assert.equal(row(wizard.contentEl,'Use this format').disabled,true)
        select(wizard.contentEl,'Sample Markdown line',sample)
        assert.deepEqual(wizard.contentEl.all().filter(el=>el.tag==='dt').map(x=>x.text),schema.fields.Vocabulary)
        assert.deepEqual(wizard.contentEl.all().filter(el=>el.tag==='dd').map(x=>x.text),['Wirtshaus','трактир','Ein altes Haus','de_DE'])
        click(wizard.contentEl,'Use this format')
        assert.equal(modals.at(-1),editor)
        assert.equal(saved,undefined)
        assert.equal(row(editor.contentEl,'Sample Markdown').children[0].value,sample)
        click(editor.contentEl,'Save rule'); await settle()
        assert.equal(saved,undefined)
        click(parent.contentEl,'Save Setup'); await settle()
        assert.deepEqual(saved.settings.REGEXP_WIZARD_FIELDS.Vocabulary,schema.fields.Vocabulary)
        const pattern=saved.settings.CUSTOM_REGEXPS.Vocabulary
        assert.deepEqual(new RegExp(pattern,'gm').exec(sample).slice(1),['Wirtshaus','трактир','Ein altes Haus','de_DE'])
    } finally {schema.names.pop();delete schema.fields.Vocabulary}
})

test('rule editor keeps edits local; wizard reopens with saved count and literal separator', async () => {
    const settings = {CUSTOM_REGEXPS:{}}, fields = {Basic:['Front','Back','Extra']}
    let saves=0
    const container=new Element()
    installNoteTypeRules(container,{app:{}, settings,fields_dict:fields,saveAllData:async()=>{saves++}})
    click(container,'Add note type')
    click(openRuleTools(modals.at(-1).contentEl), 'Regular expression wizard')
    let wizard=modals.at(-1)
    select(wizard.contentEl,'Field separator','||');select(wizard.contentEl,'Number of fields','3')
    click(wizard.contentEl,'Use this format')
    assert.equal(saves,0)
    click(modals.at(-1).contentEl, 'Save rule');await settle()
    assert.deepEqual(settings.REGEXP_WIZARD_FIELDS.Basic,fields.Basic)
    const before=structuredClone(settings)
    click(container,'Edit');click(openRuleTools(modals.at(-1).contentEl), 'Regular expression wizard')
    wizard=modals.at(-1)
    assert.equal(row(wizard.contentEl,'Field separator').children[0].value,'||')
    assert.equal(row(wizard.contentEl,'Number of fields').children[0].value,'3')
    select(wizard.contentEl,'Field separator','.')
    click(wizard.contentEl,'Cancel');click(modals.at(-1).contentEl, 'Cancel')
    assert.deepEqual(settings,before)
    assert.equal(saves,1)
})

test('generated regexes keep literal punctuation, exact capture count and native tags/ID suffixes', async () => {
    const {delimitedRule,readDelimitedRule}=await import(modules['delimited-rule'])
    for (const separator of [':','::','|','||','.*','(','\\',')','🙂','$','--','[Q]']) {
        const pattern=delimitedRule(4,separator)
        const four=['Вопрос','Ответ','Пример','de_DE']
        const line=four.join(' '+separator+' ')
        assert.deepEqual(readDelimitedRule(pattern),{count:4,separator})
        assert.equal(readDelimitedRule(pattern+'.'),undefined)
        assert.deepEqual(new RegExp(pattern,'gm').exec(line).slice(1),four)
        assert.equal(new RegExp(pattern,'gm').exec(line+' '+separator+' лишнее'),null)
        const extended = new RegExp(pattern+'\\r?\\nTags: (.+)\\r?\\n<!--ID: (\\d+)-->','gm')
        assert.deepEqual(extended.exec(line+'\r\nTags: abc\r\n<!--ID: 1234-->').slice(1),four.concat(['abc','1234']))
    }
    const single=new RegExp(delimitedRule(2,':'),'gm')
    for(const text of ['<!--ID: 12345-->','ID: 12345','-  : B','Q:\nB','x'.repeat(200000)]) assert.equal(single.exec(text),null)
    assert.equal(delimitedRule(2,'\n'),undefined)
    assert.equal(delimitedRule(1,':'),undefined)
})

test('rule wizard previews multiline Markdown and reopens its layout; directive examples stay disabled', async () => {
    const settings = { CUSTOM_REGEXPS: { Basic: '' } }, fields = { Basic: ['Question','Translation','Example'] }
    const plugin={settings,fields_dict:fields,app:{},saveAllData:async()=>{}}
    const container=new Element()
    installNoteTypeRules(container,plugin)
    click(container,'Add note type')
    click(openRuleTools(modals.at(-1).contentEl), 'Regular expression wizard')
    const wizard=modals.at(-1)
    select(wizard.contentEl,'Sample Markdown line','Tags: geography')
    assert.equal(row(wizard.contentEl,'Use this format').disabled,true)
    select(wizard.contentEl,'Answer layout','block')
    assert.equal(row(wizard.contentEl,'Field separator').children[0].disabled,true)
    select(wizard.contentEl,'Number of fields','3')
    select(wizard.contentEl,'Sample Markdown block',':::anki\nWirtshaus : inn\nA paragraph.\n\nAnother paragraph.\n:::')
    assert.deepEqual(wizard.contentEl.all().filter(x=>x.tag==='dd').map(x=>x.text),['Wirtshaus','inn','A paragraph.\n\nAnother paragraph.'])
    click(wizard.contentEl,'Use this format');click(modals.at(-1).contentEl, 'Save rule');await settle()
    assert.deepEqual(settings.REGEXP_WIZARD_FIELDS.Basic,fields.Basic)
    click(container,'Edit');click(openRuleTools(modals.at(-1).contentEl), 'Regular expression wizard')
    assert.equal(row(modals.at(-1).contentEl,'Answer layout').children[0].value,'block')
    click(modals.at(-1).contentEl,'Cancel');click(modals.at(-1).contentEl, 'Cancel')
})

test('wizard uses the currently typed custom expression when launched without rerendering settings', async () => {
    const settings = {CUSTOM_REGEXPS:{Basic:''}}, fields={Basic:['One','Two','Three']}
    const container=new Element(), plugin={settings,fields_dict:fields,app:{},saveAllData:async()=>{}}
    const {delimitedRule}=await import(modules['delimited-rule'])
    installNoteTypeRules(container,plugin)
    click(container,'Add note type')
    select(modals.at(-1).contentEl, 'Card format','custom')
    select(modals.at(-1).contentEl, 'Regular expression',delimitedRule(3,'||'))
    click(openRuleTools(modals.at(-1).contentEl), 'Regular expression wizard')
    const wizard=modals.at(-1)
    assert.equal(row(wizard.contentEl,'Field separator').children[0].value,'||')
    assert.equal(row(wizard.contentEl,'Number of fields').children[0].value,'3')
    click(wizard.contentEl,'Cancel');click(modals.at(-1).contentEl, 'Cancel')
})

test('rule label falls back to the model, displays Knowledge syntax and previews an unsaved draft', async () => {
    const {knowledgeBulletExpression} = await import(modules['card-format-presets'])
    const settings = {CUSTOM_REGEXPS: {Knowledge:knowledgeBulletExpression}, INTERFACE_LANGUAGE:'ru'}
    let saves=0, checked
    const plugin = {settings, fields_dict: {Knowledge:['Front','Back','Add Reverse','FrontLang','BackLang']},
        saveAllData: async () => { saves++ }, previewRule: async draft => { checked=draft; return {path:'Dictionary.md'} }}
    const view = new Element()
    installNoteTypeRules(view,plugin)
    assert.match(row(view,'Knowledge').hint,/Вопрос :: Ответ/)
    click(view,'Изменить')
    select(modals.at(-1).contentEl, 'Название правила (необязательно)','Основное')
    select(modals.at(-1).contentEl, 'Регулярное выражение','^(a) :: (b)$')
    const editor = modals.at(-1).contentEl
    const tools = openRuleTools(editor,'Инструменты правила')
    select(tools, 'Пример Markdown','a :: b')
    await click(tools,'Проверить пример')
    assert.ok(row(tools, 'a'))
    assert.ok(row(tools, 'b'))
    await click(tools, 'Проверить на текущей заметке')
    assert.equal(checked.expression,'^(a) :: (b)$')
    assert.equal(checked.model,'Knowledge')
    assert.equal(checked.name,'Основное')
    assert.equal(saves,0)
    assert.ok(row(modals.at(-1).contentEl, 'Dictionary.md'))
    click(modals.at(-1).contentEl, 'Сохранить правило'); await settle()
    assert.equal(settings.NOTE_TYPE_RULE_NAMES.Knowledge,'Основное')
    assert.match(row(view,'Основное').hint,/Knowledge/)
})


test('new note types open in a separate editor, show the complete RemNote example and retain a failed save for retry', async () => {
    const container = new Element()
    let fail = true
    const plugin = { app: {}, settings: {CUSTOM_REGEXPS:{}}, fields_dict: schema.fields,
        saveAllData: async () => { if (fail) throw new Error('write failed') } }
    installNoteTypeRules(container, plugin)
    const body = container.all().find(item => Object.hasOwn(item.attr, 'data-anki-note-type-refresh')).parent
    assert.equal(body.children.at(-1).attr['data-anki-note-type-refresh'], '')
    click(container, 'Add note type')
    const editor = modals.at(-1)
    assert.equal(container.all().some(el => el.text === 'Card format'), false)
    assert.deepEqual(row(editor.contentEl, 'Note type').children[0].options, ['Basic', 'Other'])
    select(editor.contentEl, 'Note type', 'Other')
    select(editor.contentEl, 'Card format', 'remnote')
    const rows = editor.contentEl.all()
    assert.ok(rows.some(el => el.attr['aria-label'] === 'Copy RemNote regular expression'))
    assert.ok(rows.some(el => el.tag === 'pre' && el.text?.includes('Yuri Gagarin') && el.text.includes(' :: Vostok 1')))
    assert.ok(row(editor.contentEl, 'Front'))
    assert.ok(row(editor.contentEl, 'Back'))
    assert.ok(row(editor.contentEl, 'Vostok 1'))
    select(editor.contentEl, 'File link field', 'A')
    click(editor.contentEl, 'Save rule'); await settle()
    assert.equal(modals.at(-1), editor)
    assert.ok(row(editor.contentEl, 'write failed'))
    assert.deepEqual(plugin.settings, {CUSTOM_REGEXPS:{}})
    fail = false
    click(editor.contentEl, 'Save rule'); await settle()
    assert.equal(plugin.settings.FILE_LINK_FIELDS.Other, 'A')
    assert.ok(row(container, 'Other'))
})
