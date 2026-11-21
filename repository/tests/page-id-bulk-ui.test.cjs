// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setImmediate: settle } = require('node:timers/promises')
const { load } = require('./benchmark/migration-modules.cjs')

class Element {
    constructor(tag, options = {}) {
        this.tag = tag; this.text = options.text || ''; this.children = []; this.style = {}
    }
    createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el }
    createDiv(options) { return this.createEl('div', options) }
    createSpan(options) { return this.createEl('span', options) }
    empty() { this.children.length = 0 }
    setText(text) { this.text = text }
    all() { return [this, ...this.children.flatMap(child => child.all())] }
    querySelectorAll(names) { return this.all().filter(el => names.split(',').includes(el.tag)) }
}

class Setting {
    constructor(parent) { this.el = parent.createDiv() }
    setName(name) { this.el.text = name; return this }
    addDropdown(set) {
        const control = this.el.createEl('select')
        control.options = {}
        control.addOption = (key, value) => { control.options[key] = value; return control }
        control.setValue = value => { control.value = value; return control }
        control.onChange = fn => { control.change = fn; return control }
        set(control); return this
    }
    addButton(set) {
        const btn = this.el.createEl('button')
        btn.setButtonText = name => { btn.text = name; return btn }
        btn.onClick = fn => { btn.onclick = fn; return btn }
        set(btn); return this
    }
}

async function screen(lang = 'en', fail = false) {
    const modals = [], calls = [], commands = [], notices = []
    const plugin = { app: {}, settings: {INTERFACE_LANGUAGE: lang}, addCommand: cmd => commands.push(cmd), register() {} }
    class Modal {
        constructor() { this.contentEl = new Element('main'); this.titleEl = new Element('h2') }
        open() { modals.push(this); this.onOpen() }
        close() { this.onClose() }
    }
    const modules = await load(['page-id-bulk-ui', 'interface-language'], { Modal, Setting, installModalLayout() {},
        Notice: class { constructor(text) { notices.push(text) } },
        previewPageIdBulk: async (_, source, target, progress) => {
            calls.push(['preview', source, target])
            progress(32, 32)
            return { source, target, scanned: 32, files: Array.from({length:31}, (_, i) => ({
                path: i + '.md', id: 1000+i, from: source === 'all' ? 'heading' : source
            })), skipped: [{path:'ambiguous.md', reason:'Two IDs'}] }
        },
        applyPageIdBulk: async (_, plan, selected) => {
            calls.push(['apply', plan.source, plan.target, [...selected]])
            if (fail) throw Error('Источник изменён после предпросмотра.\nПроверенная ZIP-копия хранилища: /outside/vault.zip')
            return { changed: selected.size, backupPath: '/outside/vault.zip' }
        }
    })
    modules['page-id-bulk-ui'].registerPageIdBulk(plugin)
    assert.equal(commands[0].id,'move-vault-page-ids')
    commands[0].callback(); commands[0].callback()
    assert.equal(modals.length,1)
    const content = modals[0].contentEl
    return { calls, notices, modals, content, all: tag => content.all().filter(el => el.tag === tag),
        find: name => content.all().find(el => el.text === name) }
}

test('whole-vault command opens a read-only preview, shows exclusions, pages the list and confirms the selected files', async () => {
    const h = await screen()
    assert.equal(h.calls.length,0)
    assert.ok(h.find('Back up and move').disabled)
    const [source, target] = h.all('select')
    assert.equal(source.value,'all'); assert.equal(target.value,'yaml')
    target.change('after-answer')
    const [freshSource] = h.all('select')
    assert.equal(freshSource.options['after-answer'],undefined)
    freshSource.change('yaml')
    await h.find('Preview').onclick()
    assert.deepEqual(h.calls,[['preview','yaml','after-answer']])
    assert.ok(h.find('ambiguous.md — Two IDs'))
    assert.equal(h.all('input').length,30)
    const first = h.all('input')[0]; first.checked=false; first.onchange()
    h.find('Next').onclick(); assert.equal(h.all('input').length,1)
    h.find('Clear selection').onclick()
    assert.ok(h.find('Back up and move').disabled)
    h.find('Select all').onclick()
    h.find('Next').onclick()
    const last = h.all('input')[0]; last.checked=false; last.onchange()
    const applyButton=h.find('Back up and move (30)')
    applyButton.onclick(); applyButton.onclick()
    await settle()
    assert.equal(h.calls.length,2)
    assert.equal(h.calls[1][3].length,30)
    assert.ok(!h.calls[1][3].includes('30.md'))
    assert.ok(h.find('Pages updated: 30.\nVault backup: /outside/vault.zip'))
    assert.ok(h.find('Back up and move').disabled)
})

test('a change of target invalidates the preview, errors retain the full backup path and require another preview', async () => {
    const h = await screen('ru',true)
    await h.find('Предпросмотр').onclick()
    assert.equal(h.find('Создать ZIP и перенести (31)').disabled,false)
    h.all('select')[1].change('heading')
    assert.equal(h.find('Создать ZIP и перенести').disabled,true)
    assert.equal(h.all('input').length,0)
    assert.equal(h.calls.length,1)
    await h.find('Предпросмотр').onclick()
    h.find('Создать ZIP и перенести (31)').onclick()
    await settle()
    assert.ok(h.content.all().some(el => el.text.includes('/outside/vault.zip')))
    assert.equal(h.find('Создать ZIP и перенести').disabled,true)
})
