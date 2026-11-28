// SPDX-License-Identifier: GPL-3.0-only
'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setImmediate: settle } = require('node:timers/promises')
const { load } = require('./benchmark/migration-modules.cjs')
const createClassList = require('./dom-class-list.cjs')

class Element {
    constructor(tag, options = {}) {
        this.tag = tag
        this.text = options.text
        this.attrs = options.attr ?? {}
        this.value = options.value ?? ''
        this.classList = createClassList()
        this.children = []
    }
    empty() { this.children = [] }
    createEl(tag, options) {
        const child = new Element(tag, options)
        this.children.push(child)
        return child
    }
    createDiv(options) { return this.createEl('div', options) }
    createSpan(options) { return this.createEl('span', options) }
    setText(text) { this.text = text }
    setAttribute(key, val) { this.attrs[key] = val }
    focus() { this.focused = true }
    nodes() { return [this, ...this.children.flatMap(child => child.nodes())] }
}

const path = 'Dictionary/Внешний вид.md'
const block = '!--\nEnDic26\n-FW: LOOK YOUNG\nID: 1778136066587\n!---'
const ready = { id: 1778136066587, profile: 'Main', modelName: 'EnDic26', block, path, line: 22, maxLine: 22,
    fields: { '-FW': 'LOOK YOUNG', File: 'Obsidian' }, tags: [], suggestedPaths: [path], targetReason: 'file-link' }

async function fixture(plan, lang = 'en') {
    class TFile { constructor(name) { this.path = name; this.extension = 'md' } }
    const state = { plan, prepared: [], copied: [], commits: 0, restored: 0, opened: [] }
    class AnkiSourceRestoreError extends Error {
        constructor(code, msg) { super(msg); this.code = code }
    }
    class FuzzySuggestModal {
        constructor(app) { this.app = app }
        setPlaceholder(text) { this.placeholder = text }
        open() { state.picker = this }
    }
    class Modal {
        constructor(app) { this.app = app; this.modalEl = this.contentEl = new Element('main'); this.titleEl = new Element('h2') }
        open() { state.modal = this; this.onOpen() }
        close() { this.onClose() }
    }
    const api = {
        TFile, Modal, FuzzySuggestModal, AnkiSourceRestoreError, installModalLayout() {}, uiDiagnostic: error => error.message,
        uiFor: () => (en, ru) => lang === 'en' ? en : ru, syncAuditDeckKey: deck => deck,
        isSyncAuditReportPath: path => path === 'report.md', setIcon: (button, icon) => { button.icon = icon },
        prepareAnkiSourceRestore: async (_plugin, _id, _profile, options) => {
            state.prepared.push(options.path)
            if (state.error) throw Error(state.error)
            return state.plan
        },
        restoreInsertionContext: (current, line) => Number.isSafeInteger(line) && line > 0 && line <= current.maxLine
            ? { before: line > 1 ? [`previous ${line - 1}`] : [], after: line < current.maxLine ? [`following ${line}`] : [],
                blockLine: line === 1 ? 1 : line + 1 } : undefined,
        openAuditAnkiNote: async (id, profile) => state.opened.push([id, profile.active]),
        commitAnkiSourceRestore: async (_plugin, current, signal, edit) => {
            assert.equal(current, state.plan)
            state.commits++
            assert.equal(signal.aborted, false)
            state.saved = [edit.line, edit.block]
            if (state.commitError) throw new AnkiSourceRestoreError(state.commitError.code, state.commitError.message)
            return { path, line: 22 }
        },
    }
    const globals = { navigator: { clipboard: { writeText(text) {
        if (state.copyError) throw Error('Clipboard unavailable')
        state.copied.push(text)
    } } } }
    const modules = await load(['anki-source-restore-ui', 'copy-block'], api, {}, globals)
    const plugin = { app: { vault: { getMarkdownFiles: () => [new TFile(path), new TFile('Work/Other.md'), new TFile('report.md')] } }, settings: {} }
    modules['anki-source-restore-ui'].openAnkiSourceRestore(plugin, ready.id, ready.profile, 'Dictionary',
        () => { state.restored++ }, () => {})
    await settle()
    const nodes = () => state.modal.contentEl.nodes()
    return { state, element: tag => nodes().find(el => el.tag === tag), find: text => nodes().find(el => el.text === text || el.attrs['aria-label'] === text),
        button: label => nodes().find(el => el.tag === 'button' && (el.text === label || el.attrs['aria-label'] === label)) }
}

test('edits, copies, previews the chosen line, opens the verified Anki note and adds exactly once', async () => {
    const { state, find, element, button } = await fixture({ ...ready, tags: ['2col', 'vocabulary'] })
    assert.equal(state.modal.titleEl.text, 'Restore Note in Obsidian')
    assert.ok(find('Note type · EnDic26'))
    assert.ok(find('Tags · 2col, vocabulary'))
    assert.ok(find('Destination · ' + path))
    const input = element('input')
    assert.equal(input.value, '22')
    assert.ok(find('Insert note here · line 23'))
    input.value = '7'
    input.oninput()
    assert.ok(find('previous 6'))
    assert.ok(find('following 7'))
    input.value = '23'
    input.oninput()
    assert.equal(button('Add').disabled, true)
    assert.ok(find('Enter a line from 1 to 22.'))
    input.value = '2'
    input.oninput()
    const draft = element('textarea')
    const edited = block.replace('LOOK YOUNG', 'look young #2col')
    draft.value = edited
    draft.oninput()
    button('Copy Markdown').onclick()
    await button('Open in Anki').onclick()
    assert.deepEqual(state.opened, [[ready.id, ready.profile]])
    assert.deepEqual(state.copied, [edited])
    assert.equal(state.commits, 0)
    const add = button('Add')
    assert.equal(add.disabled, false)
    add.onclick()
    add.onclick()
    await settle()
    assert.deepEqual(state.saved, [2, edited])
    assert.equal(state.commits, 1)
    assert.equal(state.restored, 1)
    assert.ok(button('Open Restored Note'))
})

test('manual review keeps editable Markdown and clipboard fallback; no tags label when empty', async () => {
    const { state, element, find, button } = await fixture({ ...ready, manualReason: 'Проверьте поле «-L».', manualFields: ['-L'] }, 'ru')
    assert.equal(state.modal.titleEl.text, 'Восстановить запись в Obsidian')
    assert.equal(find('Проверьте поле «-L».').attrs.role, 'status')
    assert.equal(element('details'), undefined)
    assert.ok(find('Тип записи · EnDic26'))
    assert.ok(!state.modal.contentEl.nodes().some(el => el.text?.startsWith('Теги')))
    assert.equal(element('textarea').value, block)
    assert.equal(button('Добавить').disabled, false)
    state.copyError = true
    button('Скопировать Markdown').onclick()
    await settle()
    assert.ok(find('Выделите текст выше и скопируйте его вручную.'))
    const input = element('input')
    input.value = '1'
    input.oninput()
    assert.ok(find('Запись будет вставлена здесь · строка 1'))
    button('В конец файла').onclick()
    assert.equal(input.value, '22')
    state.commitError = { code: 'draft', message: 'ID записи изменён.' }
    button('Добавить').onclick()
    await settle()
    assert.ok(find('ID записи изменён.'))
    assert.equal(button('Добавить').disabled, false)
    assert.equal(state.restored, 0)
})

test('file picker searches full paths; choosing a file keeps the draft and defaults to the end of that file', async () => {
    const noFile = { ...ready, path: undefined, line: undefined, maxLine: undefined }
    const { state, find, element, button } = await fixture(noFile)
    assert.equal(button('Add').disabled, true)
    const edited = block.replace('YOUNG', 'OLD')
    element('textarea').value = edited
    element('textarea').oninput()
    button('Choose File').onclick()
    const files = state.picker.getItems()
    assert.deepEqual(files.map(file => state.picker.getItemText(file)), [path, 'Work/Other.md'])
    state.plan = ready
    state.picker.onChooseItem(files[0])
    await settle()
    assert.deepEqual(state.prepared, [undefined, path])
    assert.equal(element('textarea').value, edited)
    element('input').value = '2'
    element('input').oninput()
    button('Choose Another File').onclick()
    state.plan = { ...ready, path: 'Work/Other.md', line: 11, maxLine: 11 }
    state.picker.onChooseItem(files[1])
    await settle()
    assert.ok(find('Destination · Work/Other.md'))
    assert.equal(element('input').value, '11')
    assert.equal(element('textarea').value, edited)
    assert.equal(state.commits, 0)
})

test('stale preview blocks saving; edited Markdown survives a failed refresh and retry', async () => {
    const { state, find, element, button } = await fixture(ready)
    const edited = block.replace('YOUNG', 'WELL')
    element('textarea').value = edited
    element('textarea').oninput()
    state.commitError = { code: 'stale', message: 'File changed.' }
    button('Add').onclick()
    await settle()
    assert.ok(find('File changed.'))
    assert.equal(button('Add'), undefined)
    const secondEdit = edited.replace('WELL', 'OLDER')
    element('textarea').value = secondEdit
    element('textarea').oninput()
    state.error = 'Anki offline'
    button('Refresh Preview').onclick()
    await settle()
    assert.ok(find('Anki offline'))
    assert.equal(element('textarea').value, secondEdit)
    assert.equal(button('Add'), undefined)
    state.error = undefined
    state.commitError = undefined
    button('Refresh Preview').onclick()
    await settle()
    assert.equal(element('textarea').value, secondEdit)
    button('Add').onclick()
    await settle()
    assert.deepEqual(state.saved, [22, secondEdit])
    assert.equal(state.restored, 1)
})

test('refresh adopts updated Anki fields when the user has not edited the draft', async () => {
    const { state, element, button } = await fixture(ready)
    state.commitError = { code: 'stale', message: 'Anki note changed.' }
    button('Add').onclick()
    await settle()
    state.error = 'Anki offline'
    button('Refresh Preview').onclick()
    await settle()
    assert.equal(element('textarea').value, block)
    state.error = undefined
    state.plan = { ...ready, block: block.replace('LOOK YOUNG', 'CURRENT IN ANKI') }
    button('Refresh Preview').onclick()
    await settle()
    assert.equal(element('textarea').value, state.plan.block)
})
