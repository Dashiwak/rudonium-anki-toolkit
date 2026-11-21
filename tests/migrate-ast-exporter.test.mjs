// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import overlay from '../Build/overlay-source.cjs'

const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const compile = name => stripTypeScriptTypes(readFileSync(overlay.file(name + '.ts'), 'utf8'), { mode: 'transform' })
const host = uri('export const fixtures = new Map(); export function parseYaml(text) {if(!fixtures.has(text)) throw Error("YAML"); return fixtures.get(text)}')
const { fixtures } = await import(host)
const { detectAnkiAstSync, detectAnkiExporter } = await import(uri(compile('migrate-ast-exporter')
    .replace("'./migration-markdown'", JSON.stringify(uri(compile('migration-markdown'))))
    .replace("'obsidian'", JSON.stringify(host))))
const auto = { source: 'auto', t: en => en }
const importer = { ...auto, source: 'anki-exporter' }
const path = 'Cards/Example.md'
const uuid = '2520fc2e-526e-4ee3-84e7-ba6de739799c'
function ast(body, props = { AnkiSync: 'on' }, override) {
    const yaml = override ?? Object.entries(props).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') + '\n'
    fixtures.set(yaml, props)
    return detectAnkiAstSync(path, '---\n' + yaml + '---\n' + body, auto)
}

test('Anki Exporter reads the note ID immediately before its row and preserves Markdown metadata', () => {
    const yaml = '\uFEFF---\r\naliases: [Капитал]\r\n---\r\n'
    const card = detectAnkiExporter(path, yaml + '\r\n<!-- anki-note-id:1700123456999 -->\r\nКакой город? :: Вена\r\n', auto)
    assert.equal(card.status, 'candidate')
    assert.equal(card.id, 1700123456999)
    assert.deepEqual([card.front, card.back, card.prefix], ['Какой город?', 'Вена', yaml])
    assert.equal(detectAnkiExporter(path, 'Question :: Answer', auto), undefined)
    assert.equal(detectAnkiExporter(path, 'Question :: Answer', importer).id, undefined)
    for (const raw of ['<!-- anki-note-id:123 -->\n\nQ :: A','<!-- anki-note-id:1e2 -->\nQ :: A','<!-- anki-note-id:9007199254740992 -->\nQ :: A',
        '<!-- anki-note-id:0 -->\nQ :: A', '<!-- anki-note-id:1 -->\nQ :: A\nP :: B','<!-- anki-note-id:1 -->\n<!-- anki-note-id:2 -->\nQ :: A',
        'Q :: A\n<!-- anki-note-id:12 -->', 'Outside prose.\n\nQ :: A', 'Q :: A :: H', 'Q  :: A', 'Q ::  A', 'Q :: A ^1700123456999']) {
        assert.equal(detectAnkiExporter(path, raw, importer)?.status, 'review', raw)
    }
    assert.equal(detectAnkiExporter(path, '```md\n<!-- anki-note-id:123 -->\nQ :: A\n```', auto), undefined)
})

test('AST Sync heading-front and body-front basic cards preserve deck, tags, topic, Unicode, and exact ID semantics', () => {
    const card = ast('#### Quelle ville ? #geography #anki/cardType/basic\n:::\nVienne\n<!--anki-id: ' + uuid + '-->\n',
        { AnkiSync: 'on', target_anki_deck: 'Geography', file_anki_tags: 'cities, capitals', note: 'keep' })
    assert.equal(card.status, 'candidate')
    assert.equal(card.externalKey, uuid)
    assert.equal(card.id, undefined)
    assert.deepEqual([card.front, card.back, card.model, card.deck, ...card.fieldNames], ['Quelle ville ?', 'Vienne', 'Basic', 'Geography', 'Front', 'Back'])
    assert.match(card.prefix, /note: "keep"/u)
    assert.match(card.prefix, /tags: \["geography","cities","capitals"\]/u)
    assert.doesNotMatch(card.prefix, /AnkiSync|file_anki_tags/u)
    const yaml = 'AnkiSync: on # from plugin\r\nnotes: keep\r\n'
    fixtures.set(yaml, { AnkiSync: 'on', notes: 'keep' })
    const body = detectAnkiAstSync(path, '\uFEFF---\r\n' + yaml + '---\r\n#### Места\r\nКакой город?\r\n:::\r\nВена\nВ Австрии.\r\n', auto)
    assert.equal(body.front, 'Какой город?')
    assert.equal(body.back, 'Вена\nВ Австрии.')
    assert.equal(body.prefix, '\uFEFF---\r\n# from plugin\r\nnotes: keep\r\nrudonium-source-heading: "Места"\r\n---\r\n')
    const overridden = ast('## Какой город?\n->\nВена', { AnkiSync: true, delimiter: '->', cardDeclarationHeadingLevel: 2 })
    assert.deepEqual([overridden.status, overridden.front, overridden.back], ['candidate', 'Какой город?', 'Вена'])
})

test('AST source declarations inside code, YAML examples, mixed links or unsupported formats cannot identify a new card', () => {
    assert.equal(detectAnkiAstSync(path, '#### Q\n:::\nA', auto), undefined)
    assert.equal(detectAnkiAstSync(path, '```yaml\nAnkiSync: on\n```', auto), undefined)
    assert.equal(detectAnkiAstSync(path, 'Q :: A\n<!--anki-id:1234-->', auto), undefined)
    assert.equal(ast('#### Q\n:::\nA', { AnkiSync: 'off' }), undefined)
    const block = ast('#### Q\n:::\nAnswer\n```md\n:::r\n#### Example\n```\n##### Details\nMore')
    assert.equal(block.status, 'candidate')
    assert.ok(block.back.includes('#### Example'))
    for (const raw of ['#### Q #anki/noteType/Vocab\n:::\nA','#### Q\n:::r\nA','#### Q\n:::t\nA','#### Q\n::: Name\nA',
        '#### Q\n:::\nA\n#### Another\n:::\nB','#### Q\n:::\nA\n:::\nB','#### Q\n:::\nA\n```\ncode',
        '#### Q\n:::\n![[other#^answer]]','#### Q\n:::\n{{c1::A}}','#### Q\n:::\n<!--ID: 11-->\nA',
        '#### Q\n:::\nA\n<!--anki-id: 1234-->','#### Q\n:::\nA\n<!--anki-id: ' + uuid + '-->\nsuffix',
        '#### Q\n:::\nA\n<!--anki-id: ' + uuid + '-->\n<!--anki-id: ' + uuid + '-->','#### Q\nA\nB\n:::\nC']) {
        assert.equal(ast(raw)?.status, 'review', raw)
    }
    assert.equal(ast('#### Q\n:::\nA', { AnkiSync: true, anki_cardDefault: 'typed' }).status, 'review')
    assert.equal(ast('#### Topic\nQ\n:::\nA', { AnkiSync: true, 'rudonium-source-heading': 'User value' }).status, 'review')
})
