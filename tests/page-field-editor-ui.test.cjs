// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const createClassList = require('./dom-class-list.cjs');
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

const source = "---\ntags: [anki-page]\nanki-page-ID: '127'\n---\n# Вопрос?\nОтвет.\n<!--rudonium-answer-end-->\nЛичное."
class Element {
    constructor(tag, options = {}) {
        this.tag = tag
        this.text = options.text
        this.value = options.value ?? ''
        this.type = options.attr?.type
        this.classList = createClassList()
        this.children = []
    }
    createEl(tag, options) {
        const child = new Element(tag, options)
        this.children.push(child)
        child.parent = this
        if (this.tag === 'select' && this.children.length === 1) this.value = child.value
        return child
    }
    createDiv(options) { return this.createEl('div', options) }
    all() { return [this, ...this.children.flatMap(child => child.all())] }
    focus() { this.focused = true }
    setText(text) { this.text = text }
    empty() { this.children = [] }
    click() {
        if (this.type === 'submit') {
            let form = this.parent
            while (form.tag !== 'form') form = form.parent
            form.onsubmit({ preventDefault() {} })
        } else this.onclick()
    }
}

async function fixture(text = source, lang = 'en') {
    const state = { text, modals: [], notices: [], edits: [], leaves: [] }
    const file = { path: 'Vocabulary.md' }
    class MarkdownView {}
    const editor = {
        getValue: () => state.text,
        offsetToPos: index => index,
        replaceRange(insert, at) { state.edits.push({ insert, at }); state.text = state.text.slice(0,at) + insert + state.text.slice(at) },
    }
    const view = Object.assign(new MarkdownView(), { file, editor, getMode: () => 'source' })
    state.active = view
    state.diskFile = file
    state.leaves.push({ view })
    class Modal {
        constructor() { this.contentEl = new Element('main'); this.titleEl = new Element('h2'); state.modals.push(this) }
        open() {}
        close() { this.closed = true }
    }
    const plugin = { settings: { INTERFACE_LANGUAGE: lang, CUSTOM_REGEXPS: { Knowledge: '@page' },
        FILE_LINK_FIELDS: { Knowledge: 'File' }, CONTEXT_FIELDS: { Knowledge: 'Context' } },
        fields_dict: { Knowledge: ['Front','Back','Example','BackLang','File','Context'] },
        addCommand(c) { this.command = c }, app: { vault: { getAbstractFileByPath: () => state.diskFile },
            workspace: { getActiveViewOfType: () => state.active, getLeavesOfType: () => state.leaves } } }
    const modules = await load(['page-field-editor-ui','page-field-insertion','page-card','card-format-presets','anki-id-marker',
        'id-marker-literals','duplicate-markers','export-recovery','markdown-pipeline','interface-language'],
        { MarkdownView, Modal, Notice: class { constructor(text) { state.notices.push(text) } } })
    modules['page-field-editor-ui'].registerPageFieldEditor(plugin)
    const open = () => {
        const previous = state.modals.length
        plugin.command.editorCallback(editor, view)
        if (state.modals.length === previous) return
        const modal = state.modals.at(-1)
        const nodes = modal.contentEl.all()
        const select = nodes.find(el => el.tag === 'select')
        const input = nodes.find(el => el.tag === 'textarea')
        const submit = nodes.find(el => el.type === 'submit')
        return { modal, select, input, submit,
            status: nodes.find(el => el.tag === 'p' && !el.text), cancel: nodes.find(el => el.type === 'button'),
            another: nodes.filter(el => el.type === 'button')[1],
            fill(text) { input.value = text; input.oninput() } }
    }
    return { state, view, file, plugin, open, MarkdownView }
}

test('editor command inserts one chosen model field, multiline, in a single undoable change', async () => {
    const h = await fixture(source, 'ru')
    assert.equal(h.plugin.command.id, 'add-anki-page-field')
    assert.equal(h.plugin.command.name, 'Добавить поле страницы Anki…')
    const dialog = h.open()
    assert.ok(dialog.submit.disabled)
    assert.deepEqual(dialog.select.children.map(el=>el.value), ['Example','BackLang'])
    dialog.fill('  ')
    dialog.submit.click()
    assert.equal(h.state.edits.length, 0)
    dialog.fill('Первая строка\nВторая строка')
    assert.equal(dialog.submit.disabled, false)
    dialog.input.onkeydown({ key:'Enter', ctrlKey:true, preventDefault() {} })
    assert.equal(h.state.edits.length, 1)
    assert.ok(dialog.modal.closed)
    assert.match(h.state.text, /Example: Первая строка\nВторая строка/)
    assert.ok(h.state.text.endsWith('<!--rudonium-answer-end-->\nЛичное.'))
    assert.ok(h.state.text.includes("anki-page-ID: '127'"))
    dialog.submit.click()
    assert.equal(h.state.edits.length, 1)
    const next = h.open()
    assert.deepEqual(next.select.children.map(el=>el.value), ['BackLang'])
    assert.equal(next.input.focused, true)
    next.cancel.click()
    assert.equal(h.state.edits.length, 1)
})

test('several fields use the same dialog; each confirmed value is a separate editor change', async () => {
    for (const last of ['insert','cancel','stale']) {
        const h = await fixture(), dialog = h.open()
        assert.equal(dialog.another.hidden, false)
        dialog.fill('first value')
        dialog.another.click()
        assert.equal(h.state.modals.length, 1)
        assert.equal(dialog.modal.closed, undefined)
        assert.equal(h.state.edits.length, 1)
        assert.deepEqual(dialog.select.children.map(el=>el.value), ['BackLang'])
        assert.equal(dialog.input.value, '')
        assert.equal(dialog.input.focused, true)
        assert.equal(dialog.another.hidden, true)
        dialog.another.click()
        assert.equal(h.state.edits.length, 1)
        dialog.fill('de_DE')
        if (last === 'cancel') dialog.cancel.click()
        else {
            if (last === 'stale') h.state.text += '\nRecent edit'
            dialog.submit.click()
        }
        const placed = last === 'insert'
        assert.equal(h.state.edits.length, placed ? 2 : 1)
        assert.equal(h.state.text.includes('BackLang: de_DE'), placed)
        assert.equal(h.state.text.split('<!--anki-fields-->').length, 2)
        assert.ok(h.state.text.includes('Example: first value'))
        if (last === 'stale') assert.match(dialog.status.text, /changed/)
        else assert.ok(dialog.modal.closed)
    }
})

test('source changes, simultaneous edits, file changes and schema changes never commit the pending value', async () => {
    const cases = [
        h => { h.state.text += '\nДругой текст.' },
        h => { h.file.path = 'Moved.md' },
        h => { h.state.diskFile = null },
        h => { h.state.active = {} },
        h => { h.plugin.fields_dict.Knowledge[0] = 'NewFront' },
        h => { h.state.leaves.push({ view: Object.assign(new h.MarkdownView(), { file: h.file, getMode: ()=>'source',
            editor: { getValue: ()=>'another edit' }, getViewData: ()=>'another edit', data: source }) }) },
    ]
    for (const change of cases) {
        const h = await fixture(), dialog = h.open()
        dialog.fill('Keep my draft')
        change(h)
        dialog.submit.click()
        assert.equal(h.state.edits.length, 0)
        assert.equal(dialog.modal.closed, undefined)
        assert.equal(dialog.submit.disabled, true)
        assert.match(dialog.status.text, /changed/)
        assert.equal(dialog.input.value, 'Keep my draft')
    }
})

test('current validation is shown in the modal and ordinary notes receive a clear notice', async () => {
    const h = await fixture(), dialog = h.open()
    dialog.fill('example')
    h.plugin.settings.FILE_LINK_FIELDS.Knowledge = 'Example'
    dialog.submit.click()
    assert.equal(h.state.edits.length, 0)
    assert.ok(dialog.status.text.length)
    const other = await fixture('# Ordinary\nRemaining Markdown')
    assert.equal(other.open(), undefined)
    assert.match(other.state.notices[0], /#anki-page/)
    assert.equal(other.state.edits.length, 0)
})
