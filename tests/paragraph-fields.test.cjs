// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

test('Explicit block accepts interior paragraphs from Anki, preserves CRLF and rejects injected field boundaries', async () => {
    const m = await load(['bidirectional-markdown','bidirectional-blocks','anki-id-marker','bidirectional-fields','card-format-presets'], {})
    const {readEditableAnkiBlockField,writeEditableAnkiBlockField,planExplicitBlockPatches,applyMarkdownPatches} = m['bidirectional-markdown']
    const {findBidirectionalBlocks} = m['bidirectional-blocks']
    const raw = 'START\r\nBasic\r\nFront: City?\r\nBack: Old\r\n\r\nParagraph\r\n<!--ID: 1750000000001 -->\r\nEND'
    const [card] = findBidirectionalBlocks(raw)
    assert.equal(card.back, 'Old\n\nParagraph')
    for (const html of ['First<br><br>Second','<p>First</p>\n<p>Second</p>']) {
        assert.equal(readEditableAnkiBlockField(html, card), 'First\n\nSecond')
        assert.equal(writeEditableAnkiBlockField('First\n\nSecond',card),'First<br><br>Second')
        const patches=planExplicitBlockPatches(raw, card, { Back: 'First\n\nSecond' })
        assert.equal(applyMarkdownPatches(raw,patches), raw.replace('Old\r\n\r\nParagraph','First\r\n\r\nSecond'))
    }
    assert.equal(readEditableAnkiBlockField('<p><b>bold</b></p>', card), '**bold**')
    assert.equal(writeEditableAnkiBlockField('A **bold** answer', card), 'A <strong>bold</strong> answer')
    for (const bad of ['First<br><br>Front: wrong','First<br><br>END','<b class="x">bold</b>', '<b> X </b>',
        '<b>a<i>x</i></b>', '<b>x</strong>', '<img src="x">', '<b>A</b>&#42;&#42;foo&#42;&#42;',
        'literal **stars**', '<b>bold</b><b>adjacent</b>', '<br>First','First<br>']) {
        assert.equal(readEditableAnkiBlockField(bad, card), undefined)
    }
})

test('Anki-only block fields land before tags and IDs, with two adjacent cards and either line ending', async () => {
    const modules = await load(['bidirectional-markdown', 'bidirectional-blocks', 'anki-id-marker', 'card-format-presets'], {})
    const { findBidirectionalBlocks, explicitBlockNamedFields } = modules['bidirectional-blocks']
    const { planExplicitBlockPatches, applyMarkdownPatches } = modules['bidirectional-markdown']
    const syntax = { 'Begin Note': 'НАЧАЛО', 'End Note': 'КОНЕЦ', 'Suspend Line': 'ПАУЗА' }
    const names = ['Вопрос', 'Ответ', 'Перевод', 'Пример', 'Пусто', 'Источник', 'File', 'Context']
    const models = { Study: names }
    const control = 'ПАУЗА_2'
    const tail = ['НАЧАЛО', 'Study', 'Вопрос: Второй', 'Ответ: Другой', 'ID: 124', 'КОНЕЦ']
    for (const eol of ['\n', '\r\n']) for (const external of [false, true]) for (const tags of [[], ['Tags: one two']]) {
        const header = ['НАЧАЛО', 'Study', 'Вопрос: Первый', 'Ответ: Старый', 'Источник:']
        const footer = external ? ['КОНЕЦ', control, '<!--ID: 123 -->'] : [control, '<!--ID: 123 -->', 'КОНЕЦ']
        const text = [...header, ...tags, ...footer, ...tail].join(eol)
        const [first, second] = findBidirectionalBlocks(text, syntax, models)
        assert.deepEqual([...first.fieldPair], names.slice(0, 2))
        assert.equal(first.extra.Источник, '')
        const chunks = planExplicitBlockPatches(text, first, {
            Back: 'Новый', Пример: 'Первая\n\nВторая', Источник: 'Первый источник', Перевод: 'Wien', Пусто: '',
        })
        const saved = applyMarkdownPatches(text, chunks)
        assert.equal(saved, [...header.slice(0, -2), 'Ответ: Новый', 'Источник: Первый источник',
            'Пример: Первая', '', 'Вторая', 'Перевод: Wien', ...tags, ...footer, ...tail].join(eol))
        const [newFirst, newSecond] = findBidirectionalBlocks(saved, syntax, models)
        assert.equal(newFirst.id, first.id)
        assert.equal(newSecond.id, second.id)
        assert.deepEqual({ ...newFirst.extra }, { Источник: 'Первый источник', Пример: 'Первая\n\nВторая', Перевод: 'Wien' })
        assert.deepEqual([...explicitBlockNamedFields(eol + saved.slice(0, newFirst.end) + eol, 'Study', names, syntax)],
            ['Источник', 'Пример', 'Перевод'])
        assert.deepEqual([...explicitBlockNamedFields(['НАЧАЛО','Study', 'Вопрос: Первый', 'Ответ: Старый','КОНЕЦ'].join(eol),
            'Study', names, syntax)], [])
        assert.deepEqual([...explicitBlockNamedFields([...header, ...tags, 'КОНЕЦ'].join(eol), 'Study', names, syntax)], ['Источник'])
        for (const changes of [{ Пример: 'Значение\nПАУЗА_2' }, { Пример: 'Значение\nID: 5' },
            { 'Bad:Name': 'Text' }, { 'A #anki-page': 'Text' }, { File: 'file.md' }, { ForgeKey: '123' }, { Tags: 'anki' }, { Пример: 'Значение\nКОНЕЦ' }]) {
            assert.throws(() => planExplicitBlockPatches(text, first, changes))
        }
        assert.throws(() => planExplicitBlockPatches(text.replace('ID: 123', 'ID: 999'), first, { Пример: 'Text' }))
    }
})

test('One-way optional field ownership requires an unambiguous recognized block', async () => {
    const { explicitBlockNamedFields } = (await load(['bidirectional-blocks', 'anki-id-marker'], {}))['bidirectional-blocks']
    const names = ['Front', 'Back', 'Импортированный', 'Context', 'Tags']
    const rows = ['START','Basic','Front: Q','Back: A','Импортированный: Да','END']
    const read = value => explicitBlockNamedFields(value, 'Basic', names)
    assert.deepEqual([...read(rows.join('\n'))], ['Импортированный'])
    assert.deepEqual([...read(rows.filter(row => !row.startsWith('Импортированный')).join('\n'))], [])
    for (const add of ['Импортированный: Повтор', 'Unknown: Typo', 'END\nSTART\nBasic', '```', 'ID: 124\nFront: F']) {
        assert.equal(read([...rows.slice(0,-1), add, 'END'].join('\n')), undefined)
    }
    assert.equal(read('Question :: Answer\nID: 123'), undefined)
})
