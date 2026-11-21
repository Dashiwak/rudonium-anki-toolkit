// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

test('new notes use the reviewed positional prefix; an unrelated model and custom regex still export', async () => {
    const modules = await load(['delimited-rule'], {})
    const expr = modules['delimited-rule'].delimitedRule(4, ':')
    const names = ['Question','Answer','Example','Source']
    const models = ['Good', 'Reordered', 'Renamed', 'Handwritten']
    const cached = Object.fromEntries(models.map(m => [m, names]))
    const settings = { CUSTOM_REGEXPS: Object.fromEntries(models.map(m => [m, m === 'Handwritten' ? '(.*)' : expr])),
        REGEXP_WIZARD_FIELDS: {Good: names, Reordered: names} }
    const calls = []
    const guard = modules['delimited-rule'].generatedRuleGuard(settings, cached, async m => {
        calls.push(m)
        if (m === 'Renamed') throw new Error('model not found')
        return m === 'Good' ? [...names, 'Optional'] : ['Question','Example','Answer','Source']
    }, en => en)
    const file = modelName => ({ path: modelName+'.md', all_notes_to_add: [{modelName}], notes_to_edit: [] })
    const healthy = file('Good')
    healthy.all_notes_to_add = Array(20000).fill(healthy.all_notes_to_add[0])
    const blocked = await guard([healthy, ...models.slice(1).map(file)])
    assert.deepEqual([...blocked.keys()], ['Reordered.md','Renamed.md'])
    assert.ok(blocked.get('Renamed.md').includes('model not found'))
    assert.deepEqual(calls, ['Good','Reordered','Renamed'])
    await guard([file('Good')])
    assert.equal(calls.length,3)
})
