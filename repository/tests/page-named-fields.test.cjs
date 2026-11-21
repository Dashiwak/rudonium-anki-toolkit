// SPDX-License-Identifier: GPL-3.0-only
const { before, test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')
const pageFile = require('./benchmark/page-file.cjs')
let File, page
before(async () => {
    const modules = await load(['file','page-card','anki-id-marker','id-marker-literals','duplicate-markers','card-format-presets','export-recovery'], {},
        {file:pageFile().replace(/\.mjs'/g,"'")})
    File = modules.file.AllFile
    page = modules['page-card']
})
const marker = '<!--anki-fields-->'
const end = '<!--rudonium-answer-end-->'
const q = '# Вопрос #anki-page\n'
const id = 1700000000100
const names = ['Вопрос', 'Ответ', 'Пример', 'Text', 'BackLang', 'File', 'Context', 'Служебное']
function file(text) {
    const f = new File(text)
    f.custom_regexps = { Knowledge: '@page' }
    f.data.fields_dict = { Knowledge: names }
    return f
}

test('a manual typo suggests exact unused fields without binding it or exporting a partial page', async () => {
    const f = file(q + 'Ответ\n' + marker + '\nText: existing\nПриемр: wrong\n')
    f.data.file_link_fields = { Knowledge: 'Служебное' }
    await assert.rejects(f.scanFile(), error => {
        assert.match(error.message, /Unknown field “Приемр” in “Knowledge”/)
        assert.match(error.message, /Available fields: Пример, BackLang/)
        assert.match(error.message, /Доступные поля: Пример, BackLang/)
        assert.doesNotMatch(error.message, /Text|Служебное|File|Context/)
        return true
    })
    assert.equal(f.all_notes_to_add.length, 0)
    assert.equal(f.notes_to_edit.length, 0)
    const noFields = file(q + 'Ответ\n' + marker + '\nOnlyExtra: contents\nExammple: error')
    noFields.data.fields_dict.Knowledge = ['Question','Answer','OnlyExtra']
    await assert.rejects(noFields.scanFile(), /No unused additional fields are available/)
})
test('opt-in fields export in any order, with multiline values, language and remote-only fields preserved on update', async () => {
    for (const placement of ['heading','yaml','after-answer']) for (const eol of ['\n','\r\n']) {
        const source = [q.trim(), 'Ответ: это предложение', 'вторая строка.', marker, 'BackLang: de_DE',
            'Пример: строка 1', 'строка 2', 'https://example.org', 'Text:', end, 'Личные записи:', marker, 'bad: do not export'].join(eol)
        const draft = file(source)
        draft.data.page_id_location = placement
        await draft.scanFile()
        const initial = draft.all_notes_to_add[0]
        assert.equal(initial.fields['Ответ'], 'Ответ: это предложение\nвторая строка.')
        assert.equal(initial.fields['Пример'],'строка 1\nстрока 2\nhttps://example.org')
        assert.equal(initial.fields.BackLang,'de_DE')
        assert.equal(initial.fields.Text,'')
        assert.deepEqual([...draft.previewCandidates[0].authoredFields], ['Вопрос','Ответ','BackLang','Пример','Text'])
        draft.note_ids = [id]
        draft.writeIDs()
        const update = file(draft.file.replace('строка 2','третья строка'))
        await update.scanFile()
        assert.equal(update.notes_to_edit[0].identifier,id)
        assert.equal(update.all_notes_to_add.length,0)
        assert.deepEqual({...update.notes_to_edit[0].note.fields},{'Вопрос':'Вопрос','Ответ':'Ответ: это предложение\nвторая строка.',
            BackLang:'de_DE','Пример':'строка 1\nтретья строка\nhttps://example.org',Text:''})
        assert.ok(draft.file.endsWith([end, 'Личные записи:', marker, 'bad: do not export'].join(eol)))
    }
})
test('ordinary answers, examples of a fields marker and field-like text inside Markdown code remain literal', async () => {
    const answer = ['Пример: это часть ответа.','```md',marker,'Text: literal','```','> '+marker].join('\n')
    let source = q + answer
    const plain = file(source)
    await plain.scanFile()
    assert.equal(plain.all_notes_to_add[0].fields['Ответ'], answer)
    source += '\n'+marker+'\nПример: code\n```yaml\nFlag: yes\n```\n> Literal: quotation\n\nBackLang: ru_RU'
    const extra = file(source)
    await extra.scanFile()
    assert.equal(extra.all_notes_to_add[0].fields['Ответ'], answer)
    assert.equal(extra.all_notes_to_add[0].fields['Пример'], 'code\n```yaml\nFlag: yes\n```\n> Literal: quotation')
})
test('known model, unique user-owned labels and a real answer are required before any write', async () => {
    for (const [source,pattern] of [
        [q+'A\n'+marker+'\nDoes not exist: oops',/Does not exist/],
        [q+'A\n'+marker+'\nПример: one\nПример: two', /повторяется/],
        [q+'A\n'+marker+'\nОтвет: два', /зарезервировано/],
        [q+'A\n'+marker+'\nContext: invalid', /Context/],
        [q+'A\n'+marker+'\nСлужебное: bad', /автоматически/],
        [q+marker+'\nText: bad', /напишите ответ/i],
        [q+'A\n'+marker+'\nplain\nText: bad', /названия поля/],
        [q+'A\n'+marker+'\nText: ok\n'+marker+'\nBackLang: de_DE', /один раздел/],
    ]) {
        const f=file(source)
        f.data.file_link_fields = {Knowledge:'Служебное'}
        await assert.rejects(f.scanFile(),pattern, source)
        assert.equal(f.all_notes_to_add.length+f.notes_to_edit.length,0)
    }
})
test('a real #anki-page tag inside a named field designates the page and stays outside its Anki value', async () => {
    const source = '# Вопрос\nОтвет\n'+marker+'\nПример: начало #anki-page конец'
    const p = page.readPageCard(source,{Knowledge:'@page'})
    assert.equal(p.front,'Вопрос')
    assert.equal(p.back,'Ответ')
    assert.equal(p.namedFields.get('Пример').value, 'начало конец')
    assert.equal(source.slice(p.namedFields.get('Пример').start,p.namedFields.get('Пример').end), 'начало #anki-page конец')
})
test('foreign integration keys remain protected when an imported Anki model has reordered fields', async () => {
    const standard = '# A #anki-page\nID: '+id+'\n<!--rudonium-page-route: ["Forge","Knowledge"]-->\n<!--rudonium-page-layout: linked-front-back-->\nB\n'+marker+'\n'
    const f=file(standard+'ForgeKey: wrong')
    f.data.fields_dict.Forge=['SecondaryKey','Front','Back','ForgeKey','Пример']
    await assert.rejects(f.scanFile(), /ForgeKey/)
    assert.equal(f.notes_to_edit.length,0)
    const second=file(standard+'Пример: restored')
    second.data.fields_dict.Forge=f.data.fields_dict.Forge
    second.data.file_link_fields={Forge:'ForgeKey'}
    await second.scanFile()
    assert.deepEqual({...second.notes_to_edit[0].note.fields},{Front:'A',Back:'B','Пример':'restored'})
})
