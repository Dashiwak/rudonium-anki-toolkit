// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import overlay from '../Build/overlay-source.cjs'

// Obsidian provides the parsed frontmatter. Supply its value separately so these
// tests also cover properties that cannot be removed by deleting a scalar line.
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const host = uri('export let props; export const set = value => {props = value}; export const parseYaml = () => { if (props instanceof Error) throw props; return props }')
const { set } = await import(host)
const compiled = stripTypeScriptTypes(readFileSync(overlay.file('migrate-yanki.ts'), 'utf8'), { mode: 'transform' })
const { detectYanki } = await import(uri(compiled.replace("'obsidian'", JSON.stringify(host))))
const automatic = { source: 'auto', t: english => english }
const explicit = { ...automatic, source: 'yanki', folder: 'Study' }
const path = 'Study/Cities/Vienna.md'

test('Yanki Basic converts one real noteId and preserves comments, other YAML, BOM and answer bytes', () => {
    const oldId = 1567890123456
    set({ noteId: oldId, tags: ['geography'], original: true })
    const prefix = '\uFEFF---\r\ntags: [geography]\r\n'
    const suffix = 'original: true\r\n---\r\n'
    const note = prefix + 'noteId: ' + oldId + ' # linked\r\n' + suffix +
        'Which city?\r\n\r\n---\r\n\r\nVienna\r\n\n[[Danube]]\n'
    const card = detectYanki(path, note, { ...automatic, yankiInstalled: true })
    assert.equal(card.status, 'candidate')
    assert.equal(card.id, oldId)
    assert.equal(card.model, 'Yanki - Basic')
    assert.deepEqual(card.fieldNames, ['Front', 'Back'])
    assert.equal(card.front, 'Which city?')
    assert.equal(card.back, 'Vienna\r\n\n[[Danube]]\n')
    assert.equal(card.prefix, prefix + '# linked\r\n' + suffix)
    const again = card.prefix + '# ' + card.front + ' #anki-page\r\n<!--ID: ' + oldId + '-->\r\n\r\n' + card.back
    set({ tags: ['geography'], original: true })
    assert.equal(detectYanki(path, again, explicit), undefined)
})

test('Thematic breaks are not global flashcard markers; folder boundaries and first-time discovery matter', () => {
    const ordinary = 'Question?\n\n---\n\nAnswer'
    assert.equal(detectYanki(path, ordinary, automatic), undefined)
    assert.equal(detectYanki(path, ordinary, { ...automatic, yankiInstalled: true }), undefined)
    assert.equal(detectYanki('Study-extra/Q.md', ordinary, explicit), undefined)
    assert.equal(detectYanki(path, ordinary, { ...automatic, source: 'flashcards' }), undefined)
    assert.equal(detectYanki('Study/Study.md', ordinary, explicit).status, 'review')
    for (const context of [explicit, { ...automatic, yankiFolders: ['Study'] }, { ...explicit, folder: '/' }]) {
        const parsed = detectYanki(path, ordinary, context)
        assert.equal(parsed.status, 'candidate')
        assert.equal(parsed.id, undefined)
        assert.equal(parsed.model, undefined)
    }
    set({ date: '2026-11-19' })
    assert.equal(detectYanki(path, '---\ndate: 2026-11-19\n---\n' + ordinary, automatic), undefined)
    set({ noteId: 100 })
    assert.equal(detectYanki(path, '---\nnoteId: 100\n---\n' + ordinary, automatic), undefined)
})

test('Yanki ambiguous note types and questionable IDs stay in review', () => {
    for (const card of [
        'Title\n---\nAnswer',
        'One\n\n---\n\n---\n\nTwo',
        'Hide ~~this~~\n\n---\n\nExtra',
        'Fill this\n\n---\n\n_ans_',
        'Two\nlines\n\n---\n\nBack',
        'Question\n\n---\n\n',
        'Plain front without a back',
        '# Existing heading\n\n---\nAnswer',
        'Q ^block-id\n\n---\nA',
    ]) assert.equal(detectYanki(path, card, explicit).status, 'review', card)
    for (const [props, raw] of [
        [{ noteId: 0 }, 'noteId: 0'], [{ noteId: '1e2' }, 'noteId: 1e2'], [{ noteId: 'none' }, 'noteId: none'],
        [{ noteId: 12 }, 'noteId: 12\nnoteId: 12'], [{ noteId: 12 }, '<<: *shared'],
        [{ noteId: 12 }, 'noteId: &linked 12'], [{ noteId: 9007199254740992 }, 'noteId: 9007199254740992'],
        [new Error('invalid YAML'), 'noteId: ['],
    ]) {
        set(props)
        assert.equal(detectYanki(path, '---\n' + raw + '\n---\nQ\n\n---\nA', explicit).status, 'review')
    }
})
