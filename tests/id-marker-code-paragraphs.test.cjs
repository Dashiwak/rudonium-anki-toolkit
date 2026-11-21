// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const root = process.env.RUDONIUM_COMPARE_KIT || path.resolve(__dirname, '..')
const { load } = require(path.join(root, 'tests/benchmark/migration-modules.cjs'))

test('unmatched code delimiters in different paragraphs preserve Anki IDs during audit and preview', async () => {
    const api = await load(['anki-id-marker','id-marker-literals'])
    const tokens = text => Array.from(api['anki-id-marker'].ankiIdNumberTokens(text))
    for (const eol of ['\n','\r\n']) {
        const text = ['an unfinished `', '  ', 'Q :: A', 'ID: 1770000000001', '\t', 'another literal `'].join(eol)
        assert.deepEqual(tokens(text), [1770000000001])
        // Newlines without a paragraph break remain valid inside an inline code span.
        assert.deepEqual(tokens(['example `x', 'ID: 1770000000001', 'y`'].join(eol)), [])
    }
})

test('an incomplete less-than expression in prose cannot hide later Anki IDs', async () => {
    const api = await load(['anki-id-marker','id-marker-literals'])
    const tokens = text => Array.from(api['anki-id-marker'].ankiIdNumberTokens(text))
    for (const marker of ['ID: 1770000000001', '<!--ID: 1770000000001 -->']) {
        assert.deepEqual(tokens('Choose x <y when possible.\n\nQuestion :: answer\n' + marker), [1770000000001])
    }
    const attribute = '<span title="Example\nID: 1770000000002\n">actual content</span>'
    assert.deepEqual(tokens(attribute + '\nID: 1770000000001'), [1770000000001])
})
