// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import overlay from '../Build/overlay-source.cjs'

const uri = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const code = name => stripTypeScriptTypes(readFileSync(overlay.file(name + '.ts'), 'utf8'))
const yamlHost = uri('export const fixtures = new Map(); export function parseYaml(raw) { if (!fixtures.has(raw)) throw Error("bad YAML"); return fixtures.get(raw) }')
const literals = JSON.stringify(uri(code('id-marker-literals')))
const frontmatter = JSON.stringify(uri(code('page-frontmatter').replace("'./id-marker-literals'", literals)
    .replace("'./suspend-label'", JSON.stringify(uri(code('suspend-label'))))))
const ids = uri(code('anki-id-marker').replace("'./page-frontmatter'", frontmatter).replace("'./id-marker-literals'", literals))
const { detectFlashcards, detectObsidianToAnki } = await import(uri(code('migrate-flashcards')
    .replace("'obsidian'", JSON.stringify(yamlHost)).replace("'./anki-id-marker'", JSON.stringify(ids))
    .replace("'./migration-markdown'", JSON.stringify(uri(code('migration-markdown'))))))
const { fixtures } = await import(yamlHost)
const ctx = { t: en => en }
const file = 'Study/Word.md'
const flash = (text, source) => detectFlashcards(file, text, { ...ctx, source })
const ota = text => detectObsidianToAnki(file, text, ctx)
const sampleId = 1700000000123
function withProps(raw, props, body, eol = '\n') {
    const header = raw.replace(/\n/gu, eol) + eol
    fixtures.set(header, props)
    return '---' + eol + header + '---' + eol + body
}

test('Flashcards preserves the v2 nid, Markdown backlink, explicit deck, BOM, CRLF and unrelated YAML', () => {
    const properties = { flashcards: { 'q-v4p9': { nid: sampleId, hash: 'aa', sync: 'bb' } }, 'cards-deck': 'Study::Topic', tags: ['plants'] }
    const text = '\uFEFF' + withProps('tags: [plants] # preserve\ncards-deck: Study::Topic\nflashcards:\n  q-v4p9: { nid: 1700000000123, hash: aa, sync: bb }',
        properties, '## Question? #card ^q-v4p9\r\n\r\nAnswer.\r\n\r\n### Details\r\n![[Image.png]]\r\n', '\r\n')
    const card = flash(text)
    assert.equal(card.status, 'candidate')
    assert.equal(card.anchor, 'q-v4p9')
    assert.equal(card.id, sampleId)
    assert.equal(card.model, 'Obsidian-basic')
    assert.equal(card.front, 'Question?')
    assert.equal(card.back, 'Answer.\r\n\r\n### Details\r\n![[Image.png]]')
    assert.equal(card.deck, 'Study::Topic')
    assert.equal(card.prefix, '\uFEFF---\r\ntags: [plants] # preserve\r\n---\r\n')
})

test('Flashcards v1 anchors retain their Anki note ID and partially migrated v1 hash-only maps work', () => {
    for (const body of ['Question::Answer\n^' + sampleId, 'Question::Answer ^' + sampleId, '## Question #card\n^' + sampleId + '\nAnswer',
        '## Question\n\n#card ^' + sampleId + '\nAnswer', '## Question #card\nAnswer ^' + sampleId]) {
        const card = flash(body)
        assert.equal(card.status, 'candidate')
        assert.equal(card.front, 'Question')
        assert.equal(card.back, 'Answer')
        assert.equal(card.id, sampleId)
        assert.equal(card.anchor, String(sampleId))
    }
    const mapped = withProps('flashcards:\n  1700000000123: { hash: abc }', { flashcards: { [sampleId]: { hash: 'abc' } } }, 'Q::A\n^' + sampleId)
    assert.equal(flash(mapped).id, sampleId)
})

test('whole-file Flashcards supports atomic questions, section hashtags, fenced fields and callouts', () => {
    for (const [old, front, back] of [
        ['## Question?\n\n#card\n\nAnswer.\n\n### Extra\nSomething', 'Question?', 'Answer.\n\n### Extra\nSomething'],
        ['Question? #card\nThe first line\nand the second.', 'Question?', 'The first line\nand the second.'],
        ['> [!CARD]+ : Question?\n> First.\n>\n> Second::part', 'Question?', 'First.\n\nSecond::part'],
        ['```flashcard\nback: Answer\ncontinued\nfront: Question?\ntype: basic\n```', 'Question?', 'Answer\ncontinued'],
        [withProps('test: title', { test: 'title' }, 'Text on\ntwo lines.'), 'Word', 'Text on\ntwo lines.'],
        [withProps('test:\n  - Another question', { test: ['Another question'] }, 'Answer'), 'Another question', 'Answer'],
        ['Question? :: Answer', 'Question?', 'Answer'],
    ]) {
        const card = flash(old, 'flashcards')
        assert.equal(card.status, 'candidate', old)
        assert.equal(card.front, front)
        assert.equal(card.back, back)
        assert.equal(card.id, undefined)
    }
    const owned = withProps('test: title\ncards-deck: Biology', { test: 'title', 'cards-deck': 'Biology' }, 'Answer')
    assert.equal(flash(owned).status, 'candidate')
    assert.equal(flash('Question? :: Answer'), undefined)
    assert.equal(flash(withProps('test: title', { test: 'title' }, 'Answer')).status, 'review')
})

test('Flashcards refuses unresolved identity, multiple cards, outside prose and unsupported directions', () => {
    const body = 'Q::A\n^q-v4p9'
    const map = (s, entry) => withProps('flashcards:\n  ' + s, { flashcards: entry }, body)
    const review = text => assert.equal(flash(text, 'flashcards')?.status, 'review', text)
    for (const old of [body, map('q-v4p9: { hash: abc }', { 'q-v4p9': { hash: 'abc' } })]) {
        const candidate = flash(old, 'flashcards')
        assert.equal(candidate.status, 'candidate')
        assert.equal(candidate.id, undefined)
        assert.equal(candidate.externalKey, 'q-v4p9')
        assert.equal(candidate.recoveryModel, 'Obsidian-basic')
    }
    for (const scalar of ['0x11', '17.0', '1.7e1', '017', '*foreign', '17, nid: 17']) {
        review(map('q-v4p9: { nid: ' + scalar + ' }', { 'q-v4p9': { nid: 17 } }))
    }
    review(map('q-xxxx: { nid: 17 }', { 'q-xxxx': { nid: 17 } }))
    review(map('q-v4p9: { nid: 1 }\n  q-xxxx: { nid: 9 }', { 'q-v4p9': { nid: 1 }, 'q-xxxx': { nid: 9 } }))
    for (const nid of ['0017', 0, -1, 'none', 9007199254740992]) review(map('q-v4p9: { nid: ' + nid + ' }', { 'q-v4p9': { nid } }))
    review(withProps('flashcards:\n  1700000000123: { nid: 17 }', { flashcards: { [sampleId]: { nid: 17 } } }, 'Q::A\n^' + sampleId))
    for (const old of ['Q:::A', '## Q #card-reverse\nA', '## Q #card\nA\n## Unrelated\nOther', 'Q #card\nA\n\nExtra',
        '## Q #card\nA\n^q-one1\n^q-two2', '## Q #card\nA\n### Q2 #card\nB', 'Q #card\nA\n<!--ID: 17-->',
        '> [!CARD] Q\n> A\nUnrelated', '```flashcard\nfront: Q\nback: A\ntype: reversed\n```',
        '```flashcard\nfront: Q\nfront: Q2\nback: A\n```']) review(old)
    for (const cue of ['reversed', 'cloze', ['title', 'Other?'], 'Word']) {
        review(withProps('test: ' + JSON.stringify(cue), { test: cue }, 'Answer'))
    }
    review(withProps('test: title', { test: 'title' }, 'First paragraph\n\nOutside the card'))
    assert.equal(flash('Intro\n\n```md\n# Heading #card\nA\n```'), undefined)
    assert.equal(flash('Intro\n<!--\nQ #card\n-->'), undefined)
    assert.equal(flash('# Q #card\nA', 'obsidian-to-anki'), undefined)
})

test('Obsidian_to_Anki reads official implicit Front and ID before END, explicit Front, two deck directive styles and dated IDs', () => {
    for (const [body, deck] of [
        ['TARGET DECK\nVol 1::History\n\nSTART\nBasic\nQuestion?\nBack: First\n\nSecond\n<!--ID: 1700000000123-->\nEND', 'Vol 1::History'],
        ['START\nBasic\nFront: Question?\nBack: First\n\nSecond\nEND\nID: 1700000000123\n\nTARGET DECK: Vol 1::History', 'Vol 1::History'],
        ['START\nBasic\nFront: Question?\nBack: First\n\nSecond\n<!--ID: 1700000000123 | 2026-11-19-->\nEND', undefined],
    ]) {
        const card = ota('\uFEFF---\r\ntags: [plants]\r\n---\r\n' + body.replaceAll('\n', '\r\n'))
        assert.equal(card.status, 'candidate')
        assert.equal(card.front, 'Question?')
        assert.equal(card.back, 'First\r\n\r\nSecond')
        assert.equal(card.id, sampleId)
        assert.equal(card.model, 'Basic')
        assert.equal(card.deck, deck)
        assert.equal(card.prefix, '\uFEFF---\r\ntags: [plants]\r\n---\r\n')
        assert.deepEqual(card.fieldNames, ['Front', 'Back'])
    }
    assert.equal(ota('START\nBasic\nQuestion?\nBack: Answer\nEND').id, undefined)
})

test('Obsidian_to_Anki leaves mixed files, invalid IDs, other fields and unsupported cards for review', () => {
    const raw = 'START\nBasic\nQuestion?\nBack: Answer\nEND'
    for (const text of [raw + '\nNote outside card', 'Intro\n' + raw, raw + '\n' + raw,
        raw.replace('Question?', 'Question?\nMore front'), raw.replace('Basic', 'Cloze'),
        raw.replace('Basic', 'Basic (and reversed card)'), raw.replace('Basic', 'Other'),
        raw.replace('Question?', 'Extra: Q'), raw.replace('END', 'Tags: tag\nEND'), raw.replace('END', 'Extra: X\nEND'),
        raw.replace('END', '<!--ID: bad-->\nEND'), raw.replace('END', '<!--ID: 7 | invalid-->\nEND'),
        raw.replace('END', 'ID: 1\nID: 2\nEND'), raw.replace('END', 'ID: 1\nEND\nID: 2'),
        raw.replace('END', 'ID: 0001\nEND'), raw.replace('END', 'ID: 9007199254740992\nEND'),
        raw.replace('END', 'END\nTARGET DECK:\n'), raw.replace('START', 'STARTI'), raw.replace('END', ''),
    ]) assert.equal(ota(text)?.status, 'review', text)
    assert.equal(ota('```md\n' + raw + '\n```'), undefined)
    assert.equal(ota('Example\n\n~~~md\n' + raw + '\n~~~'), undefined)
    assert.equal(ota('Ordinary file.'), undefined)
    assert.equal(detectObsidianToAnki(file, raw, { ...ctx, source: 'flashcards' }), undefined)
})
