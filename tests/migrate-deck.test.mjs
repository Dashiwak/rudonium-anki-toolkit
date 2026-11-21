// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import overlay from '../Build/overlay-source.cjs'

const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const source = name => stripTypeScriptTypes(readFileSync(overlay.file(name + '.ts'), 'utf8'))
const pipeline = url(source('markdown-pipeline'))
// Supply the values returned by Obsidian's YAML parser for each exact header.
// Detection and surgical preservation of source text run through the real adapter.
const obsidian = url(`export const fixtures = new Map();
export function parseYaml(raw) { if (!fixtures.has(raw)) throw new Error("Invalid YAML"); return fixtures.get(raw); }`)
const { fixtures } = await import(obsidian)
const { detectDeckToAnki } = await import(url(source('migrate-deck')
    .replace("'obsidian'", JSON.stringify(obsidian)).replace("'./markdown-pipeline'", JSON.stringify(pipeline))))
const ctx = { t: english => english }
function detect(header, properties, body, options = {}) {
    const eol = options.eol ?? '\n'
    const yaml = header.join(eol) + eol
    fixtures.set(yaml, properties)
    return detectDeckToAnki(options.path ?? 'Biology/Compound leaf.md',
        (options.bom ?? '') + '---' + eol + yaml + '---' + eol + body, ctx)
}

test('Deck To Anki title/card mode preserves unrelated YAML, line endings, source fields and numeric note ID', () => {
    const body = 'What is a compound leaf?\r\n---\r\nA leaf with distinct leaflets.\r\n\r\n![[plate.png]]\r\n'
    const result = detect(['tags:', '  - plants', "deckType: 'card' # card-mode comment", 'deckID: "1700000000123"', 'aliases: [leaves]'],
        { tags: ['plants'], deckType: 'card', deckID: '1700000000123', aliases: ['leaves'] }, body, { eol: '\r\n', bom: '\uFEFF' })
    assert.equal(result.status, 'candidate')
    assert.equal(result.prefix, '\uFEFF---\r\ntags:\r\n  - plants\r\n# card-mode comment\r\naliases: [leaves]\r\n---\r\n')
    assert.equal(result.front, 'What is a compound leaf?')
    assert.equal(result.back, 'A leaf with distinct leaflets.\r\n\r\n![[plate.png]]\r\n')
    assert.equal(result.id, 1700000000123)
    assert.deepEqual(result.fieldNames, ['ob-deck-front', 'ob-deck-back'])
    const title = detect(['deckType: title'], { deckType: 'title' }, 'Answer\n---\nFurther reading\n')
    assert.equal(title.front, 'Compound leaf')
    assert.equal(title.back, 'Answer\n---\nFurther reading\n')
    assert.equal(title.id, undefined)
    assert.equal(title.fieldNames, undefined)
    assert.equal(detectDeckToAnki('Biology/Compound leaf.md', title.prefix + '# ' + title.front + ' #anki-page\n' + title.back, ctx), undefined)
})

test('Deck To Anki requires explicit page ownership and leaves ambiguous, archived, custom and reversed sources for review', () => {
    const review = (header, data, body = 'Answer') => assert.equal(detect(header, data, body).status, 'review', header.join('; '))
    for (const mode of ['head', 'list', 'file', 'unknown']) review(['deckType: ' + mode], { deckType: mode })
    for (const [key, value] of [['deckStatus', true], ['deckFile', 'Parent.md'], ['deckTemplate', 'ob-deck-basic++'],
        ['deckTemplate', 42], ['deckNumbering', true], ['deckName', 'Plant taxonomy']]) {
        review(['deckType: title', key + ': ' + value], { deckType: 'title', [key]: value })
    }
    for (const id of ['not-an-id', 0, -1, 9007199254740992]) review(['deckType: title', 'deckID: ' + id], { deckType: 'title', deckID: id })
    for (const value of ['0017', '17.0', '0x11', '&stored 17']) review(['deckType: title', 'deckID: ' + value], { deckType: 'title', deckID: 17 })
    review(['deckType: title', 'deckType: card'], { deckType: 'card' }, 'Q\n---\nA')
    review(['deckID: 17'], { deckID: 17 })
    review(['deckType: card'], { deckType: 'card' }, 'Question\nwith two lines\n---\nAnswer')
    review(['deckType: card'], { deckType: 'card' }, 'Question\n---\nAnswer\n---\nAppendix')
    review(['deckType: card'], { deckType: 'card' }, 'Question\n---\n\n')
    review(['deckType: title'], { deckType: 'title' }, 'Body\n<!--ID: 987654-->')
    assert.equal(detectDeckToAnki('Normal.md', '# Topic\n\nContent\n---\nMore content', ctx), undefined)
    assert.equal(detectDeckToAnki('Normal.md', '---\ntags: [test]\n---\ndeckType: title\n', ctx), undefined)
    assert.equal(detectDeckToAnki('Normal.md', '---\ndeckType: title\n---\nBody', { ...ctx, source: 'yanki' }), undefined)
})
