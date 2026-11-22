// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = process.env.RUDONIUM_COMPARE_KIT || path.resolve(__dirname, '..')
const { load } = require(path.join(root, 'tests/benchmark/migration-modules.cjs'))
const get = async () => load(['linked-bullets', 'card-format-presets', 'anki-id-marker', 'anki'], {}, {anki:'export {}'})
const real = 1770000000001
const example = 1770000000002
const row = (id, q) => '- ' + q + ' :: answer\n<!--ID: ' + id + ' -->\n'

test('escaped Obsidian locale is a language value in both new and previously linked RemNote cards', async () => {
    const modules = await get()
    const { findLinkedBullets } = modules['linked-bullets']
    const presets = modules['card-format-presets']
    const input = 'Wirtshaus :: трактир :: B=de\\_DE :: F=ru_RU.'
    const result = new RegExp(presets.remNoteExpression, 'm').exec(input)
    assert.ok(result, 'new RemNote row')
    const fields = {}
    presets.applyRemNoteMetadata(presets.remNoteExpression, result[0], fields, ['BackLang','FrontLang'])
    assert.deepEqual(fields, { BackLang: 'de_DE', FrontLang: 'ru_RU' })
    const [card] = findLinkedBullets('## Cards\n- ' + input + '\nID: ' + real + '\n')
    assert.ok(card, 'existing linked row')
    assert.equal(card.metadata.BackLang, 'de_DE')
    assert.equal(card.metadata.FrontLang, 'ru_RU')
    // A saved stock 0.8.8 expression follows the current built-in; a custom one stays verbatim.
    const legacy088 = presets.legacyRemNoteExpression.replace(/\[ \\t\]\*\(\?=\\r\?\$\)$/, '') +
        String.raw`(?:[ \t]*::[ \t]*(?:R|[FB]=[a-z]{2,3}_[A-Z]{2}\.?))*[ \t]*(?=\r?$)`
    assert.equal(presets.currentCardExpression(legacy088), presets.remNoteExpression)
    assert.equal(presets.currentCardExpression('handwritten'), 'handwritten')
})

for (const delimiter of ['%%', '$$']) test('literal cards within ' + delimiter + ' are not active', async () => {
    const { findLinkedBullets } = (await get())['linked-bullets']
    const input = ['## Cards', delimiter, row(example, 'Example').trimEnd(), delimiter, row(real, 'Live')].join('\n')
    assert.deepEqual(Array.from(findLinkedBullets(input, true), card => [card.id, card.markerLine]), [[real, 7]])
})

test('a code fence written inside an HTML or Obsidian comment does not swallow later linked cards', async () => {
    const { findLinkedBullets } = (await get())['linked-bullets']
    for (const [opening, closing] of [['<!--','-->'],['%%','%%']]) {
        const input = ['## Cards', opening, '```example', closing, row(real, 'Live')].join('\r\n')
        assert.deepEqual(Array.from(findLinkedBullets(input, true), card => card.id), [real])
    }
})

test('configured block delimiters preserve END prefixes, explicit note IDs and neighboring inline notes under LF and CRLF', async () => {
    const mods = await load(['setting-to-data', 'note', 'constants', 'card-format-presets', 'bidirectional-blocks', 'anki-id-marker', 'anki'], {
        activeExportRules: () => [],
    }, { anki: 'export {}' })
    const fields = { Basic: ['Front', 'Back'] }, formatter = { format: text => text }
    for (const [begin, end] of [['START', 'END'], ['[[BEGIN]]', 'END.*']]) {
        const syntax = {
            'Begin Note': begin, 'End Note': end, 'Begin Inline Note': 'STARTI', 'End Inline Note': 'ENDI',
            'Delete Note Line': 'DELETE', 'Frozen Fields Line': 'FROZEN', 'Target Deck Line': 'TARGET DECK', 'File Tags Line': 'FILE TAGS',
        }
        const data = await mods['setting-to-data'].settingToData({ vault: { getName: () => 'Vault' } },
            { Syntax: syntax, Defaults: {} }, fields, [real])
        for (const eol of ['\n', '\r\n']) {
            const lines = [begin, 'Basic', 'Front: Station?', 'Back: Bahnhof', end + 'URANCE', end + 'I',
                end + ' extra', '    ' + end, '<!--ID: ' + real + ' 2026-11-22 local -->', '  ' + end + '  \t', 'STARTI [Basic] Q Back: A ENDI']
            const source = lines.join(eol), matches = [...source.matchAll(data.NOTE_REGEXP)]
            assert.equal(matches.length, 1)
            const note = new mods.note.Note(matches[0][1], fields, false, false, formatter)
            assert.equal(note.identifier, real)
            assert.equal(note.note_type, 'Basic')
            assert.equal(note.getFields().Back, ['Bahnhof', end + 'URANCE', end + 'I', end + ' extra', '    ' + end].join('\n'))
            const reverse = mods['bidirectional-blocks'].findBidirectionalBlocks(source, syntax, fields)
            assert.equal(reverse.length, 1)
            assert.equal(reverse[0].id, real)
            assert.equal(reverse[0].back, note.getFields().Back)
            assert.equal([...source.matchAll(data.INLINE_REGEXP)].length, 1)
            const nested = [begin, 'Basic', 'Front: Unfinished', begin + '  ', 'Basic', 'Front: Intact', 'Back: Kept',
                '<!--ID: ' + real + '-->', end].join(eol)
            const nestedMatches = [...nested.matchAll(data.NOTE_REGEXP)]
            assert.equal(nestedMatches.length, 1)
            assert.equal(nestedMatches[0].index, nested.indexOf(begin + '  '))
            assert.equal(mods['bidirectional-blocks'].findBidirectionalBlocks(nested, syntax, fields)[0]?.start, nestedMatches[0].index)
            assert.equal(new mods.note.Note(nestedMatches[0][1], fields, false, false, formatter).getFields().Front, 'Intact')
        }
    }
})

test('explicit notes keep literal field IDs, and actual block or inline markers keep their own linked ID', async () => {
    const { note: { Note, InlineNote } } = await load(['note'], {})
    const fields = { Basic: ['Front', 'Back'] }, formatter = { format: value => value }
    const body = 'Basic\nFront: Q\nBack: Номер ID: ' + example
    for (const suffix of ['', '\nID: ' + real + ' | 2026-11-22 свои заметки', '\n  <!-- ID:' + real + ' | 2026-11-22 свои заметки -->']) {
        const card = new Note(body + suffix, fields, false, false, formatter)
        assert.equal(card.identifier, suffix ? real : null)
        assert.equal(card.getFields().Back, 'Номер ID: ' + example)
    }
    const inline = '[Basic] Front: Q Back: Номер ID: ' + example
    for (const tail of [' ID: ' + real + ' | 2026-11-22 ссылка ID: 37', ' <!-- ID:' + real + ' | 2026-11-22 -->']) {
        const card = new InlineNote(inline + tail, fields, false, false, formatter)
        assert.equal(card.identifier, real)
        assert.equal(card.getFields().Back, 'Номер ID: ' + example)
    }
    assert.throws(() => new InlineNote(inline + ' ID: ' + real, fields, false, false, formatter), /Ambiguous inline Anki ID/)
    const literal = new InlineNote('[Basic] Front: Q Back: ObjectID: ' + example, fields, false, false, formatter)
    assert.equal(literal.identifier, null)
    assert.equal(literal.getFields().Back, 'ObjectID: ' + example)
})
