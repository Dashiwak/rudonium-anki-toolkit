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
            message.record('add', id)
            message.record('edit', id + count)
            message.record('edit', id + count)
        }
        assert.equal(message.message(ru), `${added} ${count} ${notes}.\n${changed} ${count} ${notes}.`)
        const english = count === 1 ? 'note' : 'notes'
        assert.equal(message.message(en), `Added ${count} ${english}.\nUpdated ${count} ${english}.`)
    }
})

test('sync notices distinguish checked, skipped, recovered and verified operations', () => {
    const outcome = new SyncOutcome()
    assert.equal(outcome.message(ru), '')
    assert.equal(checkedCount(19, 'note', ru), 'Проверено: 19 записей.')
    assert.equal(skippedFiles(1, ru), 'Часть записей пропущена. Проверьте 1 файл.')
    assert.equal(deferredNotes(2, ru), 'Отложены 2 записи для проверки.')
    assert.equal(unconfirmedNotes(2, ru), 'Не удалось подтвердить изменения для 2 записей.')
    const spacing = new SyncOutcome()
    for (let i = 1; i <= 11; i++) {
        spacing.record('normalize', i)
        if ([1, 2, 11].includes(i)) assert.equal(spacing.message(ru), 'Исправлены пробелы в ' + i + (i === 1 ? ' записи.' : ' записях.'))
    }
    for (const kind of ['delete', 'cleanup', 'suspend', 'resume', 'link', 'normalize']) outcome.record(kind, 101)
    assert.deepEqual(outcome.message(en).split('\n'), [
        'Paused reviews for 1 note.', 'Resumed reviews for 1 note.', 'Deleted 1 note from Anki.', 'Updated Obsidian after deletion of 1 note from Anki.',
        'Restored links to 1 note.', 'Fixed separator spacing in 1 note.',
    ])
})
