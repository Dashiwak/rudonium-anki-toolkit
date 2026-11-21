// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import overlay from '../Build/overlay-source.cjs'

const source = stripTypeScriptTypes(readFileSync(overlay.file('suspend-merge.ts'), 'utf8'), { mode: 'transform' })
const { mergeSuspension, acceptAnkiSuspension, SuspensionTopologyChanged, validSuspendBase } =
    await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const slot = (cardId, number, suspended = false) => ({ cardId, number, suspended })
const none = [slot(81, 3), slot(144, 1)]
const pause = (slots, ids) => slots.map(s => ({ ...s, suspended: ids.includes(s.cardId) }))

test('first sync preserves Anki pauses and resolves sparse cloze ordinals independently of cardId order', () => {
    const first = mergeSuspension(pause(none, [144]), [3])
    assert.equal(first.nextMarker, 'all')
    assert.deepEqual(first.target, new Set([144, 81]))
    assert.ok(first.remoteChange && first.localChange && validSuspendBase(first.next))
    assert.throws(() => mergeSuspension(none, [2]), /does not exist/)
    assert.deepEqual(mergeSuspension(none, [3]).target, new Set([81]))
})
test('three-way edits preserve unrelated siblings and a removed marker resumes previously acknowledged cards', () => {
    const base = mergeSuspension(none, [3]).next
    const both = mergeSuspension(pause(none, [81, 144]), null, base)
    assert.deepEqual(both.target, new Set([144]))
    assert.deepEqual(both.nextMarker, [1])
    const resumed = mergeSuspension(none, [3], base)
    assert.equal(resumed.nextMarker, null)
    assert.equal(resumed.remoteChange, false)
    assert.equal(resumed.next, undefined)
})
test('reordered templates retain identity, a new active template is not forced to pause', () => {
    const base = mergeSuspension(none, [3]).next
    const reordered = mergeSuspension([slot(144, 3), slot(81, 1, true)], [3], base)
    assert.deepEqual(reordered.nextMarker, [1])
    assert.equal(reordered.remoteChange, false)
    const all = mergeSuspension(none, 'all').next
    const added = mergeSuspension([...pause(none, [144, 81]), slot(10, 4)], 'all', all)
    assert.deepEqual(added.nextMarker, [1, 3])
    assert.equal(added.remoteChange, false)
})
test('recreated paused cards require explicit acceptance and accepting Anki never changes an Anki card', () => {
    const base = mergeSuspension(none, [3]).next
    const replaced = [slot(500, 3), slot(144, 1, true)]
    assert.throws(() => mergeSuspension(replaced, [3], base), SuspensionTopologyChanged)
    const accepted = acceptAnkiSuspension(replaced, [3])
    assert.deepEqual(accepted.nextMarker, [1])
    assert.deepEqual(accepted.target, new Set([144]))
    assert.equal(accepted.remoteChange, false)
    assert.equal(mergeSuspension(replaced, [1], accepted.next).changed, false)
})
test('equivalent markers and all-active sources do not create writes', () => {
    const slots = pause(none, [81, 144])
    const stored = mergeSuspension(slots, [1, 3]).next
    assert.deepEqual(stored.marker, [1, 3])
    assert.equal(mergeSuspension(slots, [1, 3], stored).changed, false)
    assert.equal(mergeSuspension(none, null).changed, false)
    assert.equal(validSuspendBase({ cards: [[81, 3, true], [81, 1, false]], marker: [3] }), false)
})
