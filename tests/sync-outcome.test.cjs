/*! SPDX-License-Identifier: GPL-3.0-only */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SyncOutcome, checkedCount, deferredNotes, skippedExportNotes, unconfirmedNotes } = require('../src/sync-outcome.ts')
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

test('skipped export summary counts distinct linked IDs and unlinked sources, excluding unknown write results', () => {
    const id = 1700000000000
    const bad = { code: 'duplicate-first-field', line: 5, message: 'Repeated first field.' }
    const at = col => ({ ...bad, source: { line: 5, endLine: 5, startColumn: col, endColumn: col + 18 } })
    const duplicate = { code: 'duplicate-id', line: 1, id, message: 'Duplicate ID.' }
    const issues = new Map([
        ['one.md', [duplicate, { ...duplicate, code: 'unmatched-id' }, at(3), at(3), at(29),
            { ...bad, code: 'unconfirmed-response', line: 21 }]],
        ['two.md', [duplicate, at(3)]],
    ])
    assert.equal(skippedExportNotes(new Set([id]), issues, 2, en), 'Skipped 4 notes. Check 2 files.')
    assert.equal(skippedExportNotes(new Set([id]), issues, 2, ru), 'Пропущены 4 записи. Проверьте 2 файла.')
    for (const [count, sentence] of [[1, 'Пропущена 1 запись.'], [5, 'Пропущено 5 записей.'],
        [11, 'Пропущено 11 записей.'], [21, 'Пропущена 21 запись.'], [22, 'Пропущены 22 записи.']]) {
        assert.equal(skippedExportNotes(new Set(Array.from({length:count}, (_, i) => id + i)), new Map(), 151, ru),
            sentence + ' Проверьте 151 файл.')
    }
    assert.equal(skippedExportNotes(new Set([id]), new Map(), 0, en), 'Skipped 1 note.')
    const warnings = new Map([['math.md', [
        { ...bad, code: 'protected-block' }, { ...bad, code: 'conflicting-deck-directive' },
        { ...bad, code: 'unconfirmed-response' },
    ]]])
    assert.equal(skippedExportNotes(new Set(), warnings, 1, ru), 'Проверьте 1 файл.')
})

test('malformed linked blocks and repeated inline cards on one line have distinct, stable skip identities', async () => {
    const { load } = require('./benchmark/migration-modules.cjs')
    const modules = await load(['card-export-diagnostics', 'duplicate-markers', 'markdown-pipeline', 'anki-id-marker'], {})
    const id = 1700000000000
    const source = ['START', 'UnknownModel', 'Text', 'ID: ' + id, 'END',
        'STARTI [Other] a ENDI STARTI [Other] a ENDI'].join('\r\n')
    const { issues } = modules['card-export-diagnostics'].inspectCardSources({ text: source, ranges: [],
        noteTypes: new Set(), existingIds: new Set([id]), duplicateIds: new Map() })
    assert.equal(issues.filter(issue => issue.id === id).length, 2)
    assert.equal(skippedExportNotes(new Set(), new Map([['one.md', issues]]), 1, en), 'Skipped 3 notes. Check 1 file.')
})
