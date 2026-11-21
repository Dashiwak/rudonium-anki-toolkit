// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')

const settings = { CUSTOM_REGEXPS: { Knowledge: '@page' }, FILE_LINK_FIELDS: { Knowledge: 'Source' },
    CONTEXT_FIELDS: { Knowledge: 'Heading' } }
const models = { Knowledge: ['Вопрос', 'Ответ', 'Пример', 'BackLang', 'Text', 'Source', 'Heading',
    'File', 'Context', 'ID', 'Tags', 'constructor', 'Bad:label', '> quoted', '- list', 'Field #anki-page', ' trailing', ''] }
const marker = '<!--anki-fields-->'
const privacy = '<!--rudonium-answer-end-->'
const savedId = 1700000007777
let choices, edit, read, pageBlock, importFields, markdown
before(async () => {
    const m = await load(['page-field-insertion','page-card','anki-id-marker','id-marker-literals',
        'duplicate-markers','card-format-presets','export-recovery','bidirectional-markdown','bidirectional-blocks'], {})
    choices = m['page-field-insertion'].pageFieldChoices
    edit = m['page-field-insertion'].insertPageField
    importFields = m['page-field-insertion'].planPageFieldInsertion
    pageBlock = m['page-card'].pageBlock
    markdown = m['bidirectional-markdown']
    read = text => m['page-card'].readPageCard(text, settings.CUSTOM_REGEXPS)
})
const insert = (text, cfg, schema, name, value) => {
    const { offset, insert } = edit(text, cfg, schema, name, value)
    return text.slice(0, offset) + insert + text.slice(offset)
}

test('the cached model supplies only representable, unused, user-owned fields in Anki order', () => {
    const text = '# Frage\nAntwort #anki-page'
    assert.deepEqual(Array.from(choices(text,settings,models).fields), ['Пример','BackLang','Text'])
    assert.deepEqual(Array.from(choices(text,{...settings, CUSTOM_REGEXPS:{}, PAGE_MODEL:'Knowledge'},models).fields), ['Пример','BackLang','Text'])
    assert.equal(choices('# Heading\nAnswer', settings, models), undefined)
    assert.throws(() => choices(text, settings, {}), /Refresh/)
    const assigned = insert(text,settings,models,'BackLang','de_DE')
    assert.deepEqual(Array.from(choices(assigned,settings,models).fields), ['Пример','Text'])
    assert.throws(() => edit(assigned,settings,models,'BackLang','de_DE'),/unavailable/)
})

test('append a first and subsequent field before private notes and the dated ID with exact surrounding bytes', () => {
    for (const layout of ['heading','yaml','after-answer','unlinked']) for (const eol of ['\n','\r\n']) {
        const yaml = ['\uFEFF---','author: keep', ...(layout === 'yaml' ? ["anki-page-ID: '"+savedId+"' # | 2025-11-01"] : []),
            'tags: [anki-page, study]','---', '# Frage', ...(layout === 'heading' ? ['<!--ID: '+savedId+' | 2025-11-01-->'] : []),
            'Antwort: as written  '].join(eol)
        const end = eol + (layout === 'after-answer' ? '<!--ID: '+savedId+' | 2025-11-01 @page-->'+eol : '') +
            eol + privacy + eol + 'ID: 42' + eol + 'Пример: private' + eol
        const text = yaml + end
        const withField = insert(text,settings,models,'Пример','erste Zeile\nzweite Zeile')
        assert.equal(withField, yaml+eol+eol+marker+eol+'Пример: erste Zeile'+eol+'zweite Zeile'+end)
        const final = insert(withField,settings,models,'Text','Third')
        assert.equal(final, withField.replace('zweite Zeile','zweite Zeile'+eol+'Text: Third'))
        assert.equal(read(final).id, layout === 'unlinked' ? undefined : savedId)
        assert.equal(read(final).idLocation, layout === 'unlinked' ? undefined : layout)
        assert.equal(read(final).back, read(text).back)
        assert.equal(read(final).namedFields.get('Пример').value, 'erste Zeile\nzweite Zeile')
        assert.equal(read(final).namedFields.get('Text').value, 'Third')
    }
})

test('saved migration route picks its own model, protects internal keys and keeps existing named fields', () => {
    const text = '# Frage #anki-page\nID: '+savedId+'\n<!--rudonium-page-route: ["Migrated","Deck"]-->\n' +
        '<!--rudonium-page-layout: linked-question-answer-->\nAntwort\n'+marker+'\nExtra: keep'
    const schema = {...models, Migrated: ['UUID','Question','Answer','ForgeKey','CardKey','ob-deck-meta','Extra','Пример','BackLang']}
    const options = {...settings, CONTEXT_FIELDS:{Migrated:'BackLang'}}
    assert.equal(choices(text,options,schema).model,'Migrated')
    assert.deepEqual(Array.from(choices(text,options,schema).fields),['Пример'])
    const updated = insert(text,options,schema,'Пример','Erstes')
    assert.equal(updated,text+'\nПример: Erstes')
    for (const protectedKey of ['UUID','Question','Answer','ForgeKey','CardKey','ob-deck-meta','Extra','BackLang']) {
        assert.throws(() => edit(text,options,schema,protectedKey,'x'),/unavailable/)
    }
    assert.throws(() => choices(text,options,{Migrated:['Question','Word','Extra']}),/layout/)
})

test('the command refuses empty values and structural payloads, permits literal code and URLs in a field', () => {
    const text = '# Q\nAnswer #anki-page'
    for (const value of ['', ' \t\n', 'first\nText: other', 'first\nID: 42', 'first\n'+marker+'\nText: bad',
        'first\n'+privacy+'\nhidden', 'first #anki-page', 'first\n\n<!-- Obsidian-to-Anki pending '+ 'a'.repeat(32) +' -->']) {
        assert.throws(() => edit(text,settings,models,'Пример',value))
    }
    for (const value of ['first\nhttps://example.org/', 'first\n    Text: literal', '~~~\nText: literal\n~~~']) {
        assert.equal(read(insert(text,settings,models,'Пример',value)).namedFields.get('Пример').value,value)
    }
    const pending = text+'\n\n<!-- Obsidian-to-Anki pending '+ 'a'.repeat(32) +' -->'
    assert.throws(() => edit(pending,settings,models,'Пример','x'),/pending/)
    for (const ending of ['', '\n', '\n\n  ', '\r\n']) {
        const updated = insert('# Q #anki-page\nAnswer'+ending,settings,models,'Пример','value')
        assert.ok(updated.endsWith('Пример: value'+ending))
    }
})

test('page writeback inserts several named fields at once, preserving all ID placements, line endings and private notes', () => {
    for (const place of ['yaml', 'heading', 'after-answer']) for (const eol of ['\n', '\r\n']) {
        for (const existingSection of [true, false]) {
            const header = place === 'yaml' ? ['---', 'anki-page-ID: '+savedId, '---'] : []
            const rows = [...header, '# Вопрос #anki-page', ...(place === 'heading' ? ['ID: '+savedId] : []),
                'Ответ', ...(existingSection ? [marker] : []), ...(place === 'after-answer' ? ['<!--ID: '+savedId+' @page-->'] : []),
                privacy, 'Text: эта строка личная', '']
            const text = rows.join(eol)
            const page = read(text)
            assert.equal(page.back, 'Ответ')
            assert.equal(page.namedFields?.size ?? 0, 0)
            const block = pageBlock(page, [...models.Knowledge, 'Детали'])
            assert.ok(block.pageOptionalFieldNames.includes('Пример'))
            assert.ok(!block.pageOptionalFieldNames.includes('Ответ'))
            const fields = {Пример: 'Из Anki\nВторая строка', Детали: 'Другое поле'}
            const patches = markdown.planExplicitBlockPatches(text, block, fields)
            assert.equal(patches.length, 1)
            const updated = markdown.applyMarkdownPatches(text, patches)
            const after = read(updated)
            assert.equal(after.id, savedId)
            assert.equal(after.idLocation, place)
            assert.equal(after.back, page.back)
            assert.equal(after.namedFields.get('Пример').value, fields.Пример)
            assert.equal(after.namedFields.get('Детали').value, fields.Детали)
            assert.equal(updated.slice(after.answerBoundary), text.slice(page.answerBoundary))
            assert.equal(updated.split(marker).length, 2)
            assert.ok(updated.includes('Пример: Из Anki'+eol+'Вторая строка'+eol+'Детали: Другое поле'))
            assert.throws(() => importFields(text,block,{File:'must remain generated'}))
            assert.throws(() => importFields(text,block,{Детали:'строка\nПример: новое поле'}))
        }
    }
})
test('a remote update to an existing empty final field and a new page field can share a byte offset', () => {
    for (const trailing of ['', ' ', '\r\n']) {
        const text = '# Вопрос #anki-page\r\nID: '+savedId+'\r\nОтвет\r\n'+marker+'\r\nПример:'+trailing
        const block = pageBlock(read(text), [...models.Knowledge, 'Детали'])
        for (const changed of [{Пример:'a', Детали:'b'}, {Детали:'b', Пример:'a'}]) {
            const next = markdown.applyMarkdownPatches(text, markdown.planExplicitBlockPatches(text,block,changed))
            assert.equal(read(next).namedFields.get('Пример').value,'a')
            assert.equal(read(next).namedFields.get('Детали').value,'b')
        }
    }
})
