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
