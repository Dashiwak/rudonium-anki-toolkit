// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const overlay = require('../Build/overlay-source.cjs')
const { load } = require('./benchmark/migration-modules.cjs')

const lines = ['Active before', '<!--RUDONIUM-ARCHIVE:123-->', 'First line', 'Second line',
    '<!--ID: 123-->', '', '**Удалено из Anki**', '<!--/RUDONIUM-ARCHIVE:123-->', 'Active after']
const archived = lines.join('\r\n')
const bodyClass = 'rudonium-archived-card-body', statusClass = 'rudonium-archived-card-status'
function classList() {
    const set = new Set()
    return { contains: name => set.has(name), remove: name => set.delete(name), add: name => set.add(name) }
}

test('Reading View strikes only proven legacy sections and preserves the status, neighboring sections and markup', async () => {
    const { 'archived-card-display': { registerArchivedCardDisplay }, 'archived-card': { wrapArchivedCard } } =
        await load(['archived-card-display', 'archived-card'], {})
    let post, unload, attached = 0
    const children = []
    const doc = { head: { appendChild() { attached++ } }, createElement() { return { remove() { attached-- } } } }
    const element = { ownerDocument: doc, classList: classList(), closest: () => null, querySelectorAll: () => children,
        querySelector: selector => selector === '.' + statusClass ? children.find(node => node.classList.contains(statusClass)) : undefined }
    registerArchivedCardDisplay({ register: fn => { unload = fn }, registerMarkdownPostProcessor: fn => { post = fn } })
    const draw = (first, last, text = archived) => post(element, { sourcePath: 'Dictionary.md',
        getSectionInfo: () => ({ text, lineStart: first, lineEnd: last }) })
    draw(2, 4)
    assert.equal(element.classList.contains(bodyClass), true)
    draw(0, 4)
    assert.equal(element.classList.contains(bodyClass), false, 'mixed section containing adjacent active text')
    draw(2, 8)
    assert.equal(element.classList.contains(bodyClass), false, 'the section includes the following active card')
    const status = { textContent: 'Удалено из Anki', classList: classList() }
    children.push(status)
    draw(1, 7)
    assert.equal(element.classList.contains(bodyClass), true)
    assert.equal(status.classList.contains(statusClass), true)
    draw(6, 7)
    assert.equal(element.classList.contains(bodyClass), false, 'status alone is always legible')
    assert.equal(status.classList.contains(statusClass), false)
    draw(2, 4, archived.replace('<!--ID: 123-->', '<!--ID: 321-->'))
    assert.equal(element.classList.contains(bodyClass), false, 'damaged source cannot strike nearby text')
    draw(3, 5, '```\n' + archived + '\n```')
    assert.equal(element.classList.contains(bodyClass), false, 'code examples remain ordinary code')
    const newMark = archived.replace('ARCHIVE:123-->', 'ARCHIVE:123:mark-->')
    draw(2, 4, newMark)
    assert.equal(element.classList.contains(bodyClass), false, 'the label-only option never strikes the retained text')
    draw(3, 4, newMark + '\n' + archived.replaceAll('123', '456'))
    assert.equal(element.classList.contains(bodyClass), false, 'a legacy block elsewhere cannot style a new mark')
    draw(11, 13, newMark + '\n' + archived.replaceAll('123', '456'))
    assert.equal(element.classList.contains(bodyClass), true, '0.8.5 archives keep their appearance beside new mark-only blocks')
    for (const mode of ['mark', 'strike', 'hidden']) {
        const text = wrapArchivedCard('Native card\nID: 678', 678, 'Deleted from Anki', false, '\n', mode)
        const withLegacy = text + '\n' + archived
        const end = text.split('\n').length - 1
        for (let line = 0; line <= end; line++) {
            draw(line, line, withLegacy)
            assert.equal(element.classList.contains(bodyClass), false, mode + ' has its own native presentation')
        }
    }
    assert.equal(attached, 0, 'the bundled stylesheet handles every document without inserting a style node')
    unload()
    assert.equal(attached, 0)
})

test('Live Preview restricts legacy formatting to visible text and leaves native modes and Source mode intact', async () => {
    const raw = fs.readFileSync(overlay.file('archived-card-display.ts'), 'utf8')
    const injected = "import { runtime } from './display-host'\n" + raw.replace(/\brequire\(/gu, 'runtime(')
    let viewClass
    const live = {}, effect = { define: () => ({ of: value => value }) }
    const cm = { Decoration: { none: [], set: spans => spans, mark: () => ({ range: (from, to) => [from, to] }) },
        ViewPlugin: { fromClass: klass => (viewClass = klass) }, EditorView: { baseTheme: value => value } }
    const api = { runtime: name => name === 'obsidian' ? { editorLivePreviewField: live } :
        name === '@codemirror/state' ? { StateEffect: effect } : cm }
    const { 'archived-card-display': { registerArchivedCardDisplay } } = await load(['archived-card-display'], api, { 'archived-card-display': injected })
    registerArchivedCardDisplay({ registerEditorExtension: () => {} })
    const mkView = (text, isLive, visibleRanges = [{ from: 0, to: text.length }]) => {
        const stats = { copies: 0, iterations: [] }
        const doc = { length: text.length, toString() { stats.copies++; return text }, iterRange(from, to) {
            stats.iterations.push(to - from)
            const values = text.slice(from, to).split('\n')
            let i = -1
            return { get value() { return values[i] }, next() { return { done: ++i >= values.length } } }
        } }
        return { stats, visibleRanges, state: { doc, field: () => isLive } }
    }
    const view = mkView(archived, true)
    const liveView = new viewClass(view)
    assert.deepEqual(JSON.parse(JSON.stringify(liveView.decorations)), [[archived.indexOf('First line'), archived.indexOf('<!--ID: 123-->') + '<!--ID: 123-->'.length]])
    const clipped = mkView(archived, true, [{ from: archived.indexOf('Second line'), to: archived.indexOf('Second line') + 6 }])
    liveView.update({ docChanged: false, viewportChanged: true, state: clipped.state, startState: view.state, view: clipped, transactions: [] })
    assert.deepEqual(JSON.parse(JSON.stringify(liveView.decorations)), [[clipped.visibleRanges[0].from, clipped.visibleRanges[0].to]])
    const source = mkView(archived, false)
    liveView.update({ state: source.state, view: source })
    assert.equal(liveView.decorations.length, 0)
    const plainText = '- active\n'.repeat(20000)
    const plain = mkView(plainText, true)
    const ordinary = new viewClass(plain)
    assert.equal(plain.stats.copies, 0)
    plain.stats.iterations = []
    ordinary.update({ docChanged: true, state: plain.state, startState: plain.state, view: plain, transactions: [],
        changes: { iterChangedRanges: callback => callback(2000, 2003, 2000, 2004) } })
    assert.equal(plain.stats.copies, 0)
    assert.ok(plain.stats.iterations.every(length => length < 96), 'only the edited area was visited')
    const newStyle = mkView(archived.replace('ARCHIVE:123-->', 'ARCHIVE:123:mark-->'), true)
    const newMarkView = new viewClass(newStyle)
    assert.equal(newMarkView.decorations.length, 0, 'new labels are native Markdown')
    assert.equal(newStyle.stats.copies, 0, 'native styles do not trigger an extra copy of the document')
    newMarkView.destroy()
    ordinary.destroy()
    liveView.destroy()
})
