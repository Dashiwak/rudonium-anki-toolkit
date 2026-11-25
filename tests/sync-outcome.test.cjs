/*! SPDX-License-Identifier: GPL-3.0-only */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SyncOutcome, checkedCount, deferredNotes, skippedFiles, unconfirmedNotes } = require('../src/sync-outcome.ts')
const ru = (_en, ru) => ru
const en = en => en

test('sync outcomes count actual note IDs once per operation and inflect Russian numerals', () => {
    for (const [count, changed, added, notes] of [
        [1, 'Изменена', 'Добавлена', 'запись'], [2, 'Изменены', 'Добавлены', 'записи'],
        [5, 'Изменено', 'Добавлено', 'записей'], [11, 'Изменено', 'Добавлено', 'записей'],
        [12, 'Изменено', 'Добавлено', 'записей'], [21, 'Изменена', 'Добавлена', 'запись'],
        [22, 'Изменены', 'Добавлены', 'записи'], [111, 'Изменено', 'Добавлено', 'записей'],
    ]) {
        const message = new SyncOutcome()
        for (let id = 1; id <= count; id++) {
            message.record('add', id, 'Anki')
            message.record('edit', id + count, 'Obsidian')
            message.record('edit', id + count, 'Obsidian')
        }
        assert.equal(message.message(ru), `${added} ${count} ${notes} в Anki.\n${changed} ${count} ${notes} в Obsidian.`)
        const english = count === 1 ? 'note' : 'notes'
        assert.equal(message.message(en), `Added ${count} ${english} to Anki.\nUpdated ${count} ${english} in Obsidian.`)
    }
})

test('sync notices distinguish checked, skipped, recovered and verified operations', () => {
    const outcome = new SyncOutcome()
    assert.equal(outcome.message(ru), '')
    assert.equal(checkedCount(19, 'note', ru), 'Проверено 19 записей.')
    assert.equal(skippedFiles(1, ru), 'Часть записей пропущена. Проверьте 1 файл.')
    assert.equal(deferredNotes(2, ru), 'Отложены 2 записи для проверки.')
    assert.equal(unconfirmedNotes(2, ru), 'Не удалось подтвердить изменения для 2 записей.')
    for (const kind of ['delete', 'suspend', 'resume', 'edit']) outcome.record(kind, 101, 'Anki')
    for (const kind of ['edit', 'cleanup', 'link']) outcome.record(kind, 101, 'Obsidian')
    assert.deepEqual(outcome.message(en).split('\n'), [
        'Updated 1 note in Anki.', 'Updated 1 note in Obsidian.',
        'Paused reviews for 1 note in Anki.', 'Resumed reviews for 1 note in Anki.', 'Deleted 1 note from Anki.',
        'Updated Obsidian after deletion of 1 note from Anki.', 'Restored Anki links for 1 note in Obsidian.',
    ])
})
