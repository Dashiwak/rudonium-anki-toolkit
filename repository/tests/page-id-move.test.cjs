// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

async function command() {
    const notices = [], commands = []
    const modules = await load(['id-marker-conversion-ui', 'page-id-location', 'page-id-move', 'page-card', 'page-frontmatter',
        'duplicate-markers', 'anki-id-marker', 'id-marker-literals', 'card-format-presets', 'export-recovery', 'interface-language'],
        { Modal: class {}, Notice: class { constructor(message) { notices.push(message) } },
            withFastScanReadLock: (_, operation) => operation() })
    const plugin = { settings: { PAGE_ID_LOCATION: 'yaml', Defaults: { 'ID Comments': true } },
        addCommand: value => commands.push(value), register() {} }
    modules['id-marker-conversion-ui'].registerIdMarkerConversion(plugin)
    const action = commands.find(value => value.id === 'move-this-page-id')
    assert.ok(action)
    return { plugin, notices, action }
}

function buffer(original) {
    return { text: original, edits: [], getValue() { return this.text }, offsetToPos: offset => offset,
        replaceRange(value, start, end) {
            this.edits.push(this.text)
            this.text = this.text.slice(0, start) + value + this.text.slice(end)
        } }
}
const settled = () => new Promise(resolve => setImmediate(resolve))

test('editor command moves only the page link in one undoable edit and preserves the original ID and date', async () => {
    const { plugin, action, notices } = await command()
    for (const eol of ['\r\n', '\n']) {
        const parts = ['\uFEFF---','tags: [travel]', '# Keep this comment','---','','# Question #anki-page',
            '<!--ID: 1700000000101 | 2026-11-20-->','<!-- anki-bidirectional-tags: ["old"]-->',
            '<!--rudonium-page-route: ["Custom","Deck"]-->','','Answer', '## Sources', '[[Note]]', '']
        parts.splice(6, 0, 'SUSPEND_1')
        const before = parts.join(eol)
        const editor = buffer(before)
        plugin.settings.PAGE_ID_LOCATION = 'yaml'
        action.editorCallback(editor)
        await settled()
        assert.equal(editor.edits.length, 1, notices.at(-1))
        assert.equal(editor.edits[0], before)
        assert.ok(editor.text.includes("anki-page-ID: '1700000000101' # | 2026-11-20" + eol + '---'))
        assert.ok(editor.text.endsWith(parts.slice(8).join(eol)))
        action.editorCallback(editor)
        await settled()
        assert.equal(editor.edits.length, 1)
        plugin.settings.PAGE_ID_LOCATION = 'heading'
        action.editorCallback(editor)
        await settled()
        assert.equal(editor.text, before, notices.at(-1))
    }
})

test('editor command preserves an annotated or conflicting ID, pending export and ordinary note', async () => {
    const { plugin, action, notices } = await command()
    for (const [location, source] of [
        ['yaml', '# Q #anki-page\n<!--ID: 11--> my data\nA'],
        ['yaml', '# Q #anki-page\nID: 11 | 2026-11-20 ✓\nA'],
        ['heading', "---\nanki-page-ID: '11' # custom comment\n---\n# Q #anki-page\nA"],
        ['heading', "---\nanki-page-ID: '11'\n---\n# Q #anki-page\nID: 12\nA"],
        ['yaml', '# Q #anki-page\nID: 11\nA\n\n<!-- Obsidian-to-Anki pending ' + 'a'.repeat(32) + ' -->'],
        ['yaml', '# Chapter\nID: 12\nA'],
    ]) {
        const editor = buffer(source)
        plugin.settings.PAGE_ID_LOCATION = location
        const count = notices.length
        action.editorCallback(editor)
        await settled()
        assert.equal(editor.text, source)
        assert.equal(editor.edits.length, 0)
        assert.equal(notices.length, count + 1)
    }
})

test('all six page ID moves preserve the owner, public text, controls, date and private content', async () => {
    const { plugin, action, notices } = await command()
    const formats = ['heading', 'after-answer', 'yaml']
    for (const eol of ['\n', '\r\n']) for (const tail of [false, true]) {
        const original = ['\uFEFF---','aliases: [A]', '# Keep', '---', '# Where? #anki-page',
            'SUSPEND_2','<!--ID: 1750000000001 | 2026-11-20-->','<!--rudonium-page-route: ["Basic","Places"]-->',
            '', 'First', 'Second', ...(tail ? ['','<!--rudonium-answer-end-->','Private :: Draft','ID: 29',''] : [])].join(eol)
        const variants = new Map([['heading', original]])
        for (const target of formats.filter(x => x !== 'heading')) {
            const editor = buffer(original)
            plugin.settings.PAGE_ID_LOCATION = target
            action.editorCallback(editor)
            await settled()
            assert.equal(editor.edits.length, 1, notices.at(-1))
            variants.set(target, editor.text)
        }
        for (const source of formats) for (const target of formats) {
            const editor = buffer(variants.get(source))
            plugin.settings.PAGE_ID_LOCATION = target
            action.editorCallback(editor)
            await settled()
            assert.equal(editor.text, variants.get(target), source + ' → ' + target + ': ' + notices.at(-1))
            assert.equal(editor.edits.length, source === target ? 0 : 1)
            if (target === 'after-answer') {
                assert.ok(editor.text.includes('Second' + eol + '<!--ID: 1750000000001 | 2026-11-20 @page-->'))
                assert.equal(editor.text.endsWith(eol), original.endsWith(eol))
            }
        }
    }
})

test('the move command with no recorded location chooses YAML and ignores ordinary multi-card notes', async () => {
    const { plugin, action } = await command()
    delete plugin.settings.PAGE_ID_LOCATION
    for (const [before, changed] of [['# Q #anki-page\nID: 44\nA', true],
        ['# Q\nQ :: A\n<!--ID: 44-->\nQ2 :: A2\n<!--ID: 55-->', false]]) {
        const editor = buffer(before)
        action.editorCallback(editor)
        await settled()
        assert.equal(editor.edits.length, changed ? 1 : 0)
        if (changed) assert.match(editor.text, /^---\nanki-page-ID: '44'\n---\n# Q #anki-page\nA$/)
        else assert.equal(editor.text, before)
    }
})

test('moving the ID keeps the page tag, all authored named fields, ordinary YAML ID and private text', async () => {
    const { plugin, action, notices } = await command()
    plugin.settings.Defaults['ID Comments'] = false
    const body = ['# Question?', 'SUSPEND_1', 'ID: 41', 'Answer.', '<!--anki-fields-->',
        'Hint: Read twice', 'Another line', 'Comment: Source', '<!--rudonium-answer-end-->', 'Memo: ID: 88'].join('\r\n')
    const source = '---\r\ntags: [travel, anki-page]\r\nID: 19\r\n---\r\n' + body
    const editor = buffer(source)
    for (const target of ['yaml','after-answer','heading']) {
        plugin.settings.PAGE_ID_LOCATION = target
        action.editorCallback(editor)
        await settled()
        if (target === 'yaml') assert.ok(editor.text.includes("anki-page-ID: '41'"), notices.at(-1))
        if (target === 'after-answer') assert.ok(editor.text.includes('Comment: Source\r\n<!--ID: 41 @page-->'), notices.at(-1))
    }
    assert.equal(editor.edits.length, 3, notices.at(-1))
    assert.equal(editor.text, source)
})

test('a real standalone page tag below a signed footer can move; visible or quoted text keeps the footer ambiguous', async () => {
    const { plugin, action, notices } = await command()
    plugin.settings.PAGE_ID_LOCATION = 'yaml'
    const source = '# Q\r\nAnswer\r\n<!--ID: 41 @page-->\r\n#Anki-Page\r\n<!--rudonium-answer-end-->\r\nprivate'
    const editor = buffer(source)
    action.editorCallback(editor)
    await settled()
    assert.equal(editor.edits.length,1,notices.at(-1))
    assert.equal(editor.text,"---\r\nanki-page-ID: '41'\r\n---\r\n" + source.replace('<!--ID: 41 @page-->\r\n',''))
    for (const extra of ['more text', '`#anki-page`', '%% #anki-page %%', '> #anki-page']) {
        const invalid = buffer(source.replace('#Anki-Page', '#Anki-Page\r\n' + extra))
        action.editorCallback(invalid)
        await settled()
        assert.equal(invalid.edits.length,0)
    }
})
