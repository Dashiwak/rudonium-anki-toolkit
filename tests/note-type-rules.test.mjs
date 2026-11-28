// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const load = name => stripTypeScriptTypes(readFileSync(overlay.file(name + '.ts'), 'utf8'), { mode: 'transform' })
const presets = moduleUrl(load('card-format-presets'))
const rules = moduleUrl(load('note-type-rules').replace("'./card-format-presets'", JSON.stringify(presets)))
const { cardFormatPresets, pageCardExpression } = await import(presets)
const { configuredModels, presetId, readRule, ruleProblem, withRule } = await import(rules)
const t = en => en
const fields = { Basic: ['Front', 'Back', 'Source'], Legacy: ['Question', 'Answer', 'Context'], Other: ['Front', 'Back'] }

test('existing patterns and metadata survive edits and removal of a different rule', () => {
    const initial = { CUSTOM_REGEXPS: { Basic: '', Legacy: 'Q=(.+)' }, FILE_LINK_FIELDS: { Basic: 'Front', Legacy: 'Question' },
        CONTEXT_FIELDS: { Legacy: 'Context' } }
    assert.deepEqual(configuredModels(initial, fields), ['Legacy'])
    assert.equal(presetId(initial.CUSTOM_REGEXPS.Legacy), 'custom')
    const draft = readRule(initial, 'Basic')
    const updated = withRule(initial, { ...draft, file: 'Source' })
    assert.deepEqual(configuredModels(updated, fields), ['Basic', 'Legacy'])
    assert.equal(initial.FILE_LINK_FIELDS.Basic, 'Front')
    assert.deepEqual(readRule(updated, 'Legacy'), readRule(initial, 'Legacy'))
    const removed = withRule(updated, readRule(updated, 'Basic'), true)
    assert.deepEqual(configuredModels(removed, fields), ['Legacy'])
    assert.deepEqual(readRule(removed, 'Legacy'), readRule(initial, 'Legacy'))
    assert.deepEqual(readRule(removed, 'Basic'), { model: 'Basic', expression: '', file: '', context: '' })
})
test('upstream defaults for both selectors never create rules, with every combination of global export switches', () => {
    const fields = { Basic: ['Front', 'Back'], Reversed: ['Q', 'A'], EnDic26: ['-FW', '-NW', 'File', 'Context'] }
    for (const fileEnabled of [false, true]) for (const contextEnabled of [false, true]) {
        for (const [file, context, expression, expected] of [
            ['-FW', '-FW', '', []], ['-FW', undefined, '', []], ['File', '-FW', '', ['EnDic26']],
            ['-FW', 'Context', '', ['EnDic26']], ['File', 'Context', '', ['EnDic26']],
            ['-FW', '-FW', '^Q:(.+)$', ['EnDic26']], ['removed field', '-FW', '', []],
        ]) {
            const settings = { Defaults: { 'Add File Link': fileEnabled, 'Add Context': contextEnabled },
                CUSTOM_REGEXPS: { Basic: '', Reversed: '', EnDic26: expression },
                FILE_LINK_FIELDS: { Basic: 'Front', Reversed: 'Q', EnDic26: file },
                CONTEXT_FIELDS: { Basic: 'Front', ...(context ? { EnDic26: context } : {}) } }
            const original = structuredClone(settings)
            assert.deepEqual(configuredModels(settings, fields), expected)
            assert.deepEqual(configuredModels(structuredClone(settings), fields), expected)
            assert.deepEqual(settings, original)
            // Rules explicitly saved in Rudonium survive even when both mappings use the first field.
            const pinned = withRule(settings, readRule(settings, 'Basic'))
            assert.deepEqual(configuredModels(pinned, fields), ['Basic', ...expected])
        }
    }
})

test('rule validation rejects malformed patterns, conflicting assignments and stale fields', () => {
    const empty = readRule({}, 'Basic')
    for (const preset of cardFormatPresets) {
        assert.equal(presetId(preset.expression), preset.id)
        assert.equal(ruleProblem({}, fields, { ...empty, expression: preset.expression }, t), '')
    }
    assert.match(ruleProblem({}, fields, { ...empty, expression: '([' }, t), /Check the regular expression/)
    assert.match(ruleProblem({}, fields, { ...empty, expression: '^constant$' }, t), /capture group/)
    assert.match(ruleProblem({}, fields, { ...empty, file: 'removed-field' }, t), /Choose a field/)
    assert.match(ruleProblem({}, fields, { ...empty, model: 'deleted' }, t), /current model/)
    assert.match(ruleProblem({ CUSTOM_REGEXPS: { Legacy: pageCardExpression } }, fields, { ...empty, expression: pageCardExpression }, t), /another note type/)
    assert.equal(ruleProblem({}, fields, { ...empty, expression: '(?<=x)(.+)' }, t), '')
})
test('selecting a START/END-only model is persistent and key-safe', () => {
    const strange = Object.fromEntries([['__proto__', ['Front', 'Back']]])
    const selected = withRule({}, readRule({}, '__proto__'))
    assert.deepEqual(configuredModels(selected, strange), ['__proto__'])
    assert.equal(Object.hasOwn(selected.FILE_LINK_FIELDS, '__proto__'), true)
    assert.equal(Object.getPrototypeOf(selected.FILE_LINK_FIELDS), Object.prototype)
})
test('optional display names are independent of the Anki model and disappear on removal', () => {
    const saved = withRule({}, { ...readRule({}, 'Basic'), name: '  Vocabulary  ' })
    assert.deepEqual(saved.NOTE_TYPE_RULE_NAMES, { Basic: 'Vocabulary' })
    assert.equal(readRule(saved, 'Basic').model, 'Basic')
    const renamed = withRule(saved, { ...readRule(saved, 'Basic'), name: ' German ' })
    assert.equal(readRule(renamed, 'Basic').name, 'German')
    assert.deepEqual(renamed.CUSTOM_REGEXPS, saved.CUSTOM_REGEXPS)
    assert.deepEqual(withRule(renamed, { ...readRule(renamed, 'Basic'), name: '  ' }).NOTE_TYPE_RULE_NAMES, {})
    assert.equal(readRule(withRule(renamed, readRule(renamed, 'Basic'), true), 'Basic').name, undefined)
    const keyed = withRule({}, { ...readRule({}, '__proto__'), name: 'Odd' })
    assert.equal(readRule(keyed, '__proto__').name, 'Odd')
    assert.equal(Object.getPrototypeOf(keyed.NOTE_TYPE_RULE_NAMES), Object.prototype)
})
