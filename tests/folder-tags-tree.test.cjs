// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const createClassList = require('./dom-class-list.cjs');
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { folderTagStorageKey } = require('../Build/install.cjs')
const { load } = require('./benchmark/migration-modules.cjs')

test('installer resolves the real exporter map and the legacy editor accessor', () => {
    assert.equal(folderTagStorageKey('result.folder_tags = settings.FOLDER_TAGS', ''), 'FOLDER_TAGS')
    assert.equal(folderTagStorageKey('result["folder_tags"] = settings["Folder Tags"]', ''), 'Folder Tags')
    assert.equal(folderTagStorageKey('', 'const tags = plugin.settings["Folder Tags"]'), 'Folder Tags')
    assert.throws(() => folderTagStorageKey('', 'const x = settings.Defaults'))
})

class Element {
    constructor(tag, options = {}) {
        this.tagName = tag.toUpperCase()
        this.attr = options.attr ?? {}
        this.textContent = options.text ?? ''
        this.children = []
        this.classList = createClassList()
        this.value = ''
    }
    createEl(tag, opts) {
        const el = new Element(tag, opts)
        el.parentElement = this
        this.children.push(el)
        return el
    }
    createDiv(opts) { return this.createEl('div', opts) }
    createSpan(opts) { return this.createEl('span', opts) }
    addEventListener(type, handler) { this['on' + type] = handler }
    prepend(el) { this.children.splice(this.children.indexOf(el), 1); this.children.unshift(el) }
    empty() { this.children = [] }
    setText(text) { this.textContent = text }
    click() { if (!this.disabled) this.onclick?.() }
    setAttribute(name, value) { this.attr[name] = value }
    focus() { Element.focused = this }
    scrollIntoView() {}
    elements() { return [this, ...this.children.flatMap(node => node.elements())] }
}

class TFolder {
    constructor(path, ...children) { this.path = path; this.children = children }
}

test('folder tags mount on demand, survive toggles, and edit only the selected path', async () => {
    const nested = 'Страны/Австрия'
    const root = new TFolder('/', new TFolder('Страны', new TFolder(nested)), new TFolder('constructor'), new TFolder('__proto__'))
    const saved = { Страны: 'places', [nested]: 'de_AT', 'Moved/Elsewhere': 'untouched' }
    let reads = 0, writes = 0
    // Exercise a customized upstream storage key. Display and export must read the very same map.
    const tagKey = folderTagStorageKey('result.folder_tags = settings["Configured Fields for Folders"]', '')
    const local = new Map()
    const plugin = { settings: { [tagKey]: saved }, app: {
        loadLocalStorage: key => structuredClone(local.get(key)),
        saveLocalStorage: (key, value) => local.set(key, structuredClone(value)), vault: { getRoot() { reads++; return root } } },
        async saveAllData() { writes++ } }
    const mods = await load(['settings-search','folder-tree'], {
        uiFor: () => (_en, ru) => ru, uiDiagnostic: String, setIcon() {}, TFolder,
        createSettingsGroup: container => container.createEl('details').createDiv(),
    })
    const host = new Element('div')
    const show = (owner = plugin) => {
        mods['settings-search'].installFolderTagSettings(host, owner, tagKey)
        const details = host.children.at(-1)
        details.open = true
        details.ontoggle()
        return details
    }
    const details = show()
    const find = (attr, value, scope = details) => scope.elements().find(el => el.attr[attr] === value)
    const field = (path, scope) => find('aria-label', 'Теги папки ' + path, scope)
    assert.equal(reads, 1)
    assert.equal(writes, 0)
    assert.equal(field(nested), undefined)
    assert.equal(field('Страны').value, 'places')
    assert.equal(field('constructor').value, '')
    find('aria-label', 'Развернуть Страны').click()
    const edit = field(nested)
    assert.equal(edit.value, 'de_AT')
    edit.value = 'wien innenstadt'
    edit.oninput()
    await edit.onchange()
    assert.equal(writes, 1)
    assert.deepEqual(saved, { Страны: 'places', [nested]: 'wien innenstadt', 'Moved/Elsewhere': 'untouched' })
    const reopened = show()
    assert.equal(field(nested, reopened).value, 'wien innenstadt')
    const search = find('type', 'search', reopened)
    search.value = 'австрия'
    search.oninput()
    assert.ok(field(nested, reopened))
    assert.equal(field('constructor', reopened), undefined)
    search.onkeydown({ key: 'Escape', preventDefault(){}, stopPropagation(){} })
    const special = field('__proto__', reopened)
    special.value = 'local'
    special.oninput()
    await special.onchange()
    assert.equal(Object.getPrototypeOf(saved), Object.prototype)
    assert.equal(Object.getOwnPropertyDescriptor(saved, '__proto__').value, 'local')
    const cleared = field(nested, reopened)
    cleared.value = ''
    cleared.oninput()
    await cleared.onchange()
    assert.equal(Object.hasOwn(saved, nested), false)
    assert.equal(saved.Страны, 'places')
    const empty = new Element('div')
    mods['settings-search'].installFolderTagSettings(empty, plugin, tagKey)
    assert.equal(reads, 2, 'closed settings do not scan the vault')
    const fresh = show({ ...plugin })
    const initial = [...local.values()][0]?.includes('Страны') ?? false
    assert.equal(!!field(nested, fresh), initial)
    fresh.elements().find(el => el.attr['aria-expanded'] !== undefined).click()
    assert.equal(!!field(nested, show({ ...plugin })), !initial)

})

test('pagination adds only undisplayed rows in expanded branches and never leaves a no-op button', async () => {
    const { 'folder-tree': { createFolderTree } } = await load(['folder-tree'], { TFolder })
    const numbered = (n, prefix) => Array.from({ length: n }, (_, i) => ({ path: prefix + String(i).padStart(3, '0') }))
    for (const language of ['en', 'ru']) {
        const t = (en, ru) => language === 'en' ? en : ru
        const host = new Element('div')
        const entries = [{ path: 'Base' }, ...numbered(43, 'Base/'), { path: 'Core' }, { path: 'Sources' }]
        const setup = entries => createFolderTree(host, { entries, t, renderAction: row => row.createEl('input') })
        setup(entries)
        const rows = () => host.elements().filter(el => el.attr['data-folder-path'])
        // Native theme can style buttons with display:inline-flex even when hidden is true.
        const pagingButtons = () => host.elements().filter(el => el.tagName === 'BUTTON' && el.attr['aria-expanded'] === undefined)
        const rootToggle = () => host.elements().find(el => el.attr['aria-expanded'] !== undefined)
        assert.equal(rows().length, 3)
        assert.deepEqual(pagingButtons(), [])
        rootToggle().click()
        assert.equal(rows().length, 46)
        assert.deepEqual(pagingButtons(), [])

        host.empty()
        const wide = setup([...numbered(161, 'Base/'), { path: 'Base' }])
        assert.deepEqual(pagingButtons(), [])
        rootToggle().click()
        assert.equal(rows().length, 80)
        assert.equal(pagingButtons()[0].textContent, t('Show more folders (+80)', 'Показать ещё папки (+80)'))
        const firstInput = wide.action('Base/000')
        firstInput.value = 'draft'
        pagingButtons()[0].click()
        assert.equal(rows().length, 160)
        assert.equal(firstInput, wide.action('Base/000'))
        assert.equal(firstInput.value, 'draft')
        assert.equal(pagingButtons()[0].textContent, t('Show more folders (+2)', 'Показать ещё папки (+2)'))
        pagingButtons()[0].click()
        assert.equal(rows().length, 162)
        assert.deepEqual(pagingButtons(), [])
        assert.ok(wide.action('Base/160'))

        wide.search.value = 'Base/'
        wide.search.oninput()
        assert.equal(rows().length, 80)
        wide.setDisabled(true)
        assert.equal(pagingButtons()[0].disabled, true)
        wide.setDisabled(false)
        rootToggle().click()
        assert.equal(rows().length, 1)
        assert.deepEqual(pagingButtons(), [])
        wide.search.value = 'missing'
        wide.search.oninput()
        assert.equal(rows().length, 0)
        assert.deepEqual(pagingButtons(), [])
    }
})

test('migration chooses an existing scope in a large vault by mouse or keyboard; editing a search cannot start a scan', async () => {
    let modal
    class Modal {
        contentEl = new Element('div')
        titleEl = new Element('h2')
        open() { modal = this; this.onOpen() }
    }
    const paths = Array.from({ length: 1500 }, (_, i) => new TFolder('Notes/Folder ' + i))
    const root = new TFolder('/', new TFolder('Notes', ...paths), new TFolder('Base', new TFolder('Base/Wien')))
    const calls = []
    const { 'page-migration-ui': wizard } = await load(['page-migration-ui', 'folder-tree'], {
        Modal, TFolder, uiFor: () => en => en, pageIdLocation: () => 'yaml', installModalLayout() {},
        detectMigrationFolders: async () => [], previewPageMigration: async (_plugin, options) => {
            calls.push(options.folder); throw Error('Preview complete')
        },
    })
    const plugin = { settings: {}, app: { vault: { getRoot: () => root } }, fields_dict: { Basic: ['Front','Back'] }, register() {} }
    wizard.openPageMigration(plugin)
    const find = f => modal.contentEl.elements().find(f)
    const text = name => find(e => e.textContent === name)
    const byLabel = name => find(e => e.attr['aria-label'] === name)
    const search = () => find(e => e.attr.type === 'search')
    const key = k => ({key:k, preventDefault(){}, stopPropagation(){}})
    byLabel('Choose folder: Entire vault').click()
    assert.equal(Element.focused, search())
    byLabel('Expand Notes').click()
    assert.equal(modal.contentEl.elements().filter(e => e.attr['data-folder-path']).length,80)
    search().value = 'folder 149'
    search().oninput()
    assert.equal(find(e => e.tagName === 'MARK').textContent,'Folder 149')
    search().onkeydown(key('Enter'))
    text('Preview files').click()
    assert.deepEqual(calls, [])
    search().onkeydown(key('ArrowDown'))
    assert.equal(Element.focused.attr['aria-label'],'Choose folder: Notes/Folder 149')
    Element.focused.onkeydown(key('ArrowDown'))
    assert.equal(Element.focused.attr['aria-label'],'Choose folder: Notes/Folder 1490')
    Element.focused.click()
    byLabel('Choose folder: Notes/Folder 1490').click()
    search().value = 'no such folder'; search().oninput(); search().onkeydown(key('Enter'))
    assert.ok(text('Preview files').disabled)
    text('Cancel').click()
    text('Preview files').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls,['Notes/Folder 1490'])
    byLabel('Choose folder: Notes/Folder 1490').click()
    search().value = 'wien'; search().oninput(); search().onkeydown(key('Enter'))
    text('Preview files').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls,['Notes/Folder 1490','Base/Wien'])
    byLabel('Choose folder: Base/Wien').click()
    text('Entire vault').click()
    text('Preview files').click()
    assert.equal(calls.at(-1),'')
})
