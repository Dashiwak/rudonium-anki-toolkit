// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test'
import { checkSuspension } from './benchmark/suspend-sync.mjs'
import { checkCursorSync } from './benchmark/cursor-sync.mjs'

test('two-way change history preserves field values, directions and skipped conflicts', async () => {
    await checkCursorSync(8, 2, true)
})

test('two-way history covers suspension, unknown writes and both sides of an explicit deletion', async () => {
    await checkSuspension(9, false, false, true, true)
})

test('single-file bidirectional suspension respects sibling ordinals, cursor scope, retry, and opt-in deletion', async () => {
    await checkSuspension(11)
})

test('Bidirectional delete archives a retained block only after confirmation, supports a remote deletion and skips both on later sync', async () => {
    await checkSuspension(9, false, false, true)
})

test('cursor-only two-way sync isolates IDs, neighbors and checkpoints; guards conflicts and stale or duplicate links', async () => {
    await checkCursorSync(8)
})
