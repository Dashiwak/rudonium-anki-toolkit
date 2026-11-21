// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const assert = require('node:assert/strict')
const { test, before } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
let read, write, validate, labels, linked, blocks, pages, ids, presets, source

before(async () => {
    const modules = await load(['suspend-marker', 'suspend-label', 'linked-bullets', 'bidirectional-blocks', 'page-card',
        'card-format-presets', 'duplicate-markers', 'export-recovery', 'anki'], {}, { anki: 'export {}' })
    ;({ readSuspendMarkers: read, rewriteSuspendMarkers: write, suspendLabelProblem: validate } = modules['suspend-marker'])
    labels = modules['suspend-label']
    linked = modules['linked-bullets'].findLinkedBullets
    blocks = modules['bidirectional-blocks'].findBidirectionalBlocks
    pages = modules['page-card']
    ;({ findIdMarkers: ids, readDuplicateSource: source } = modules['duplicate-markers'])
    presets = modules['card-format-presets'].cardFormatPresets
})
const syntax = { 'Suspend Line': 'Моя_пауза[+]', 'Suspend Line Aliases': '["PAUSE","PA"]' }

test('Literal custom and historical markers accept a bare line or one-based ordinals and preserve exact bytes', () => {
    for (const eol of ['\n', '\r\n']) {
        const a = ['## Cards', '- Q :: A', '  мОя_ПаУзА[+] 3, 1', '  <!-- ID: 8 | 2026-11-19 -->',
            '- Other :: Card', 'PAUSE_2', 'ID: 9', ''].join(eol)
        const marked = read(a, syntax)
        assert.deepEqual(Array.from(marked.get(8).selection), [1, 3])
        assert.deepEqual(Array.from(marked.get(9).selection), [2])
        assert.equal(a.slice(marked.get(8).start, marked.get(8).end), '  мОя_ПаУзА[+] 3, 1' + eol)
        assert.equal(write(a, new Map([[8, [3, 1]], [9, [2]]]), syntax), a)
        const b = write(a, new Map([[8, null], [9, [3, 1]]]), syntax)
        assert.equal(b, a.replace('  мОя_ПаУзА[+] 3, 1' + eol, '').replace('PAUSE_2', 'Моя_пауза[+]_1,3'))
        assert.equal(write(b, new Map([[8, 'all']]), syntax), b.replace('  <!-- ID:', '  Моя_пауза[+]' + eol + '  <!-- ID:'))
    }
    for (const current of ['PA', 'PAUSE']) {
        const aliases = { 'Suspend Line': current, 'Suspend Line Aliases': '["PA","PAUSE"]' }
        for (const line of ['PA_2', 'pause 2']) assert.deepEqual(Array.from(labels.readSuspendLine(line, aliases)), [2])
    }
    assert.equal(validate('Моя_пауза[+]', syntax), undefined)
    for (const bad of ['FROZEN', 'id:', 'PA_2', 'a\nb', ' Моя ', 'START', '### Heading']) assert.ok(validate(bad, syntax), bad)
})

test('Invalid ordinals, ambiguous controls, missing or inline IDs stop edits while code and prose stay untouched', () => {
    for (const bad of ['SUSPEND_0', 'SUSPEND_-1', 'SUSPEND_2,2', 'SUSPEND_1,',
        'SUSPEND_', 'SUSPEND_A', 'SUSPEND_999999999999999999999']) assert.throws(() => read(bad + '\nID: 7'), /card numbers/)
    for (const raw of ['DELETE\nSUSPEND\nID: 7', 'SUSPEND\nDELETE\nID: 7', 'SUSPEND\nDELETE <!--ID: 7-->',
        'SUSPEND\nSUSPEND_2\nID: 7', 'ID: 7\nSUSPEND\nID: 7', 'SUSPEND\nID: 7\nID: 7']) assert.throws(() => read(raw), /Conflicting/)
    for (const raw of ['---\nSUSPEND\nID: 7\n---', '~~~\nSUSPEND\nID: 7\n~~~', '$$\nSUSPEND\nID: 7\n$$',
        '<!--\nSUSPEND\nID: 7\n-->', '    SUSPEND\n    ID: 7', 'suspend delivery\nID: 7', '> SUSPEND\nID: 7',
        'PAUSE\nID: 7', '<pre>\nSUSPEND\nID: 7\n</pre>', ' \tSUSPEND\nID: 7', 'SUSPEND\nID: x', 'SUSPEND\n\nID: 7']) assert.equal(read(raw).size, 0, raw)
    for (const raw of ['~~~\nID: 7\n~~~', 'here <!--ID: 7-->', 'DELETE\nID: 7', 'ID: 7\nID: 7', 'ID: 6']) {
        assert.throws(() => write(raw, new Map([[7, 'all']])), /unique standalone/)
    }
    assert.throws(() => read('SUSPEND_2\nSTARTI [Basic] X | Y | ENDI <!--ID: 7-->'), /standalone/)
    assert.equal(write('\ufeffSUSPEND\r\nID: 7', new Map([[7, null]])), '\ufeffID: 7')
})

test('Page, explicit, linked and preset readers preserve field boundaries and original marker coordinates', () => {
    for (const eol of ['\n', '\r\n']) {
        const page = ['# Q #anki-page', 'PA_1', '<!--ID: 17-->', '', 'Answer', 'continued'].join(eol)
        const p = pages.readPageCard(page, { Basic: '@page' }, syntax)
        assert.equal(p.front, 'Q')
        assert.equal(p.back, 'Answer\ncontinued')
        assert.equal(page.slice(p.insertion, p.idEnd), '<!--ID: 17-->')
        assert.equal(page.slice(p.backStart, p.backEnd), 'Answer' + eol + 'continued')
        const bullet = ['## Cards', '- Q :: A', 'Моя_пауза[+]_3', '<!--ID: 17-->', '- Z :: Ω', 'ID: 99'].join(eol)
        const b = linked(bullet, true, syntax)
        assert.deepEqual(Array.from(b, card => [card.id, card.markerLine, card.back]), [[17, 4, 'A'], [99, 6, 'Ω']])
        assert.equal(bullet.slice(0, b[0].end).endsWith('<!--ID: 17-->'), true)
        assert.equal(source(bullet, ids(bullet)[0], syntax).front, 'Q')
        for (const tail of [['PAUSE', '<!--ID: 31-->', 'END'], ['END', 'PAUSE', '<!--ID: 31-->']]) {
            const raw = ['START', 'Basic', 'Front: Face', 'Back: Answer', ...tail].join(eol)
            const [block] = blocks(raw, syntax)
            assert.equal(block.back, 'Answer')
            assert.equal(raw.slice(block.idStart, block.idStart + 13), '<!--ID: 31-->')
            assert.equal(raw.slice(block.explicitFields.get('Back').start, block.explicitFields.get('Back').end), 'Answer')
        }
        const preset = presets.find(p => p.id === 'remnote')
        assert.ok(preset)
        const raw = ['Question :: Answer', 'PA_1', 'ID: 81'].join(eol)
        const readers = pages.presetReaders({ Basic: preset.expression })
        const [r] = pages.findPresetBlocks(raw, readers, ids(raw), undefined, syntax)
        assert.equal(r.front, 'Question')
        assert.equal(r.back, 'Answer')
        assert.equal(r.eol, eol)
        assert.equal(r.line, 1)
        assert.equal(r.endLine, 3)
    }
})

test('annotation delimiters after a standalone ID do not hide the pause or the adjacent card', () => {
    for (const suffix of ['?!', ' #important', '%%', '<!--', '\u0060', '$$', '-->', ' # | 2024-02-29', ' <!--ID: 300-->']) {
        const text = ['## Cards', '- Q :: A', 'PAUSE_2', 'ID: 8' + suffix, '- Q2 :: A2', '<!--ID: 9--> ' + suffix].join('\r\n')
        assert.deepEqual(Array.from(ids(text), m => m.id), [8,9], suffix)
        assert.deepEqual(Array.from(linked(text, true, syntax), m => m.id), [8,9], suffix)
        assert.deepEqual(Array.from(read(text, syntax).get(8).selection), [2], suffix)
        assert.equal(write(text, new Map([[8, null]]), syntax), text.replace('PAUSE_2\r\n', ''), suffix)
    }
})

test('YAML page suspension edits only the command below the marked heading', () => {
    for (const eol of ['\n', '\r\n']) {
        const prefix = ['\ufeff---', 'example: PAUSE', 'anki-page-ID: "18" # saved', '---', '# Question #anki-page', ''].join(eol)
        const text = prefix + 'Answer' + eol + 'Other PAUSE words.'
        const wanted = write(text, new Map([[18, [3, 1]]]), syntax)
        assert.equal(wanted, prefix + 'Моя_пауза[+]_1,3' + eol + text.slice(prefix.length))
        const mark = read(wanted, syntax).get(18)
        assert.deepEqual(Array.from(mark.selection), [1, 3])
        assert.equal(wanted.slice(mark.start, mark.end), 'Моя_пауза[+]_1,3' + eol)
        assert.equal(write(wanted, new Map([[18, [1, 3]]]), syntax), wanted)
        assert.equal(write(wanted, new Map([[18, null]]), syntax), text)
        assert.throws(() => read(prefix + ['DELETE', 'PAUSE', 'Answer'].join(eol), syntax), /Conflicting/)
        assert.throws(() => read(prefix + ['PAUSE', 'DELETE', 'Answer'].join(eol), syntax), /Conflicting/)
        assert.throws(() => read(prefix + ['PAUSE', 'ID: 18', 'Answer'].join(eol), syntax), /[Cc]onflict/)
        assert.equal(read(text.replace(' #anki-page', '') + eol + 'PAUSE', syntax).size, 0)
    }
})


test('a page footer takes suspension commands only directly below its first marked heading', () => {
    for (const eol of ['\n','\r\n']) {
        const top = ['\ufeff---','example: PAUSE','---','# Question #anki-page',''].join(eol)
        const raw = top + ['Paragraph','PAUSE_7','<!--ID: 18 @page-->','<!--rudonium-answer-end-->','PAUSE_5','ID: 19'].join(eol)
        assert.equal(read(raw, syntax).size, 0)
        const paused = write(raw, new Map([[18, [2]]]), syntax)
        assert.equal(paused, top + 'Моя_пауза[+]_2' + eol + raw.slice(top.length))
        const observed = read(paused, syntax)
        assert.equal(observed.size,1)
        assert.deepEqual(Array.from(observed.get(18).selection), [2])
        assert.equal(write(paused, new Map([[18, null]]), syntax), raw)
        assert.throws(() => read(paused.replace('Paragraph', 'DELETE'), syntax), /[Cc]onflict/)
        const orphan = raw.replace(' #anki-page','')
        assert.throws(() => read(orphan, syntax), /signed ID|heading/)
        assert.throws(() => write(orphan, new Map([[18, 'all']]), syntax))
    }
})

test('page command recognition, field spans and private examples agree for every ID location', () => {
    const options = { 'Suspend Line': 'Пауза+[*]', 'Delete Note Line': 'Убрать[.]' }
    const eol = '\r\n', rules = { Basic:'@page' }
    for (const position of ['heading','yaml','after-answer']) {
        const body = (command, answer = 'Answer') => [
            ...(position === 'yaml' ? ['---','anki-page-ID: 27','---'] : []),
            '# Q', command, '#anki-page', ...(position === 'heading' ? ['<!--ID: 27-->'] : []),
            answer, '<!--anki-fields-->', 'Example: Убрать[.]', ...(position === 'after-answer' ? ['<!--ID: 27 @page-->'] : []),
            '<!--rudonium-answer-end-->','Пауза+[*]_3','ID: 77'
        ].join(eol)
        for (const [word, expected] of [['пАуЗа+[*]_1,2', [1,2]], ['уБрАтЬ[.]', undefined]]) {
            const text = body(word), page = pages.readPageCard(text, rules, options)
            assert.equal(page.front, 'Q')
            assert.equal(page.back, 'Answer')
            assert.equal(page.namedFields.get('Example').value, 'Убрать[.]')
            const marks = read(text, options)
            if (expected) {
                assert.deepEqual(Array.from(marks.get(27).selection), expected)
                assert.equal(write(text,new Map([[27, null]]),options), text.replace(word + eol,''))
            } else assert.equal(marks.size,0)
        }
        for (const commands of ['Пауза+[*]\r\nУбрать[.]', 'Убрать[.]\r\n#anki-page\r\nПауза+[*]_2']) {
            assert.throws(() => pages.readPageCard(body(commands), rules, options), /[Cc]onflict/)
        }
        if (position !== 'heading') {
            for (const literal of ['    Убрать[.]', '<!-- Пауза+[*] -->', '> Убрать[.]']) {
                const text = body(literal), page = pages.readPageCard(text, rules, options)
                assert.ok(page.back.includes(literal), literal)
                assert.equal(read(text, options).size, 0)
            }
        }
    }
})
