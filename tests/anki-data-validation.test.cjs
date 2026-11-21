// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

test('attachment index keeps legacy receipts, ignores damaged aliases and quarantines duplicate names', async () => {
    const { 'media-sync': media } = await load(['media-sync', 'anki', 'image-optimizer'], {
        encodeAnkiMediaFilename: encodeURIComponent,
    }, { anki: 'export {}', 'image-optimizer': 'export function imageHash() {} export function optimizeImage() {}' })
    const receipt = filename => ({ filename, path: 'assets/' + filename, stamp: [1, 2, 3], digest: 'a'.repeat(64), notes: ['Cards.md'] })
    const good = receipt('Sound.mp3')
    const index = new Map()
    media.loadMediaIndex(index, [
        null, 1, good, { ...receipt('bad.jpg'), sourceFilename: { name: 'x' } },
        { ...receipt('bad-note.jpg'), pendingNotes: [1] }, { ...receipt('bad-reference.jpg'), sourceReferences: [null] },
        { ...receipt('bad-image.jpg'), image: {} }, receipt('Twin.jpg'), receipt('twin.jpg'), receipt('Twin.jpg'),
    ])
    assert.deepEqual([...index], [['sound.mp3', good]])
})

test('suspension refuses sparse flags, wrong owners and malformed card IDs before any write', async () => {
    const replies = new Map()
    const actions = []
    const { 'suspend-anki': suspend } = await load(['suspend-anki', 'anki'], {
        checkPinnedAnkiProfile: async () => 'Demo',
        withAnkiDeadline: action => action(),
        readTestAction: action => { actions.push(action); return replies.get(action) },
    }, { anki: "import { readTestAction } from './test-anki'; export const invoke = readTestAction" })
    const notes = new Map([[42, [101]]]), numbered = new Set([42])
    replies.set('areSuspended', Array(1))
    await assert.rejects(suspend.readSuspendCards('Demo', notes, numbered), /could not confirm/)
    replies.set('areSuspended', [false])
    replies.set('cardsInfo', [{ cardId: 101, note: 5, ord: 0 }])
    await assert.rejects(suspend.readSuspendCards('Demo', notes, numbered), /could not confirm/)
    replies.set('cardsInfo', [{ cardId: 101, note: 42, ord: 0 }])
    const cards = await suspend.readSuspendCards('Demo', notes, numbered)
    assert.equal(cards.get(42)[0].number, 1)
    replies.set('notesInfo', [{ noteId: 42, cards: ['101'] }])
    await assert.rejects(suspend.verifySuspendCards('Demo', cards), /could not confirm/)
    assert.ok(actions.every(action => ['areSuspended', 'cardsInfo', 'notesInfo'].includes(action)))
})
