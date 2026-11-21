// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
const pageFile = require('./benchmark/page-file.cjs')
const rules = { Basic: '@page' }
let pages, scanner, props, AllFile
before(async () => {
    const modules = await load(['page-card','page-frontmatter','duplicate-markers','anki-id-marker','card-format-presets',
        'export-recovery','file'],{}, {file: pageFile().replace(/\.mjs'/gu, "'")})
    pages = modules['page-card']; props = modules['page-frontmatter']
    scanner = modules['duplicate-markers']; AllFile = modules.file.AllFile
})

test('explicit page tag at all public positions and in real YAML tags; stable question and answer', () => {
    for (const text of [
        '# Q #anki-page\nAnswer', '# #anki-page Q\nAnswer', '# Q\nAnswer #AnKi-PaGe', '# Q\n#anki-page Answer',
        '#anki-page\n\n# Q\nAnswer', '#learn #anki-page\n# Q\nAnswer', '# Q\n#anki-page\nAnswer',
        '# Q\nAnswer\n#anki-page', '# Q\nAnswer\r\n#anki-page\r\n',
        '# Q\nAnswer\n\n#anki-page\n', '# Q\nAnswer\n#anki-page\n\n#anki-page\n',
        ...["tags: anki-page","tags: [other, AnKi-PaGe]","tags: ['#anki-page', travel]",
            "tags:\n  - travel\n  - 'anki-page'","tags:\n- anki-page","tags: [one,\n  anki-page]"].map(row =>
                '---\n' + row + '\n---\n# Q\nAnswer')
    ]) {
        const page = pages.readPageCard(text,rules)
        assert.equal(page?.front,'Q',text); assert.equal(page?.back,'Answer',text)
    }
    const inner = '# The #anki-page question?\nA #anki-page value\n#anki-page\nlast'
    const page = pages.readPageCard(inner,rules)
    assert.equal(page.front,'The question?'); assert.equal(page.back,'A value\nlast')
    assert.equal(page.frontSpan.pageSource,'The #anki-page question?')
    assert.throws(()=>pages.readPageCard('# Q\n#anki-page\n', rules),/answer/i)
})

test('literal tag-looking text cannot create a page', () => {
    const headings=['# Q\n']
    for (const extra of ['---\ntags: [work]\nother: anki-page\n---\n','---\nother:\n  tags: [anki-page]\n---\n',
        '---\nbody: |\n  tags: [anki-page]\n---\n','---\ntags: ["comma, anki-page, example"]\n---\n'])
        assert.equal(pages.readPageCard(extra+'# Q\nAnswer', rules),undefined)
    for (const body of ['Example `#anki-page`', '~~~md\n#anki-page\n~~~', '    #anki-page', '<!-- #anki-page -->',
        '%% #anki-page %%', '<pre>#anki-page</pre>', '[[Other#anki-page]]', '[[x|#anki-page]]', '[#anki-page](work)',
        'https://example.org/#anki-page', '#anki-page/beta', '#anki-page-old', '#anki-page🌍', 'word#anki-page','\\#anki-page', '$x #anki-page$'])
        for (const h of headings) assert.equal(pages.readPageCard(h+body,rules),undefined,body)
    assert.throws(()=>pages.readPageCard('Unrelated visible content\n# Q\nAnswer #anki-page',rules),/first-level/i)
})

test('only anki-page-ID can authorize a page operation; retired IDs reserve marked pages without becoming links', async () => {
    const page = (rows, tag = 'tags: [anki-page]') => ['---',tag,...rows,'---','# Question','Answer'].filter(Boolean).join('\n')
    const valid = page(['ID: 99', 'anki-page-ID: 12345'])
    assert.equal(pages.readPageCard(valid,rules).id,12345)
    assert.deepEqual(Array.from(scanner.findIdMarkers(valid),m=>m.id),[12345])
    for (const legacy of ['rudonium-id: 12345', '"rudonium-id": "12345" # old', "'rudonium-id': 12345"]) {
        const retired = page([legacy])
        for (const invalid of [retired, retired+'\nID: 98765', retired.replace('# Question','# Question\nDELETE')]) {
            const file = new AllFile(invalid)
            await assert.rejects(file.scanFile(), /rudonium-id.*anki-page-ID/u)
            assert.equal(file.all_notes_to_add.length,0)
            assert.equal(file.notes_to_edit.length,0)
            assert.equal(file.notes_to_delete.length,0)
            assert.equal(file.file,invalid)
        }
        assert.deepEqual(Array.from(scanner.findIdMarkers(retired),m=>m.id),[12345])
        assert.deepEqual(Array.from(scanner.findIdMarkers(page([legacy],'')+'\n<!--rudonium-answer-end-->\n#anki-page'),m=>m.id),[12345])
        assert.throws(()=>props.insertPageYamlId(retired,99999),/rudonium-id/)
        const ordinary = page([legacy],'')+'\n- Word :: Meaning\nID: 82'
        assert.equal(pages.readPageCard(ordinary,rules),undefined)
        assert.equal(props.pageYamlId(ordinary),undefined)
        assert.deepEqual(Array.from(scanner.findIdMarkers(ordinary),m=>m.id),[82])
    }
    for (const id of [12345,22222]) {
        const mixed = page(['rudonium-id: 12345', 'anki-page-ID: '+id])
        assert.throws(()=>pages.readPageCard(mixed,rules),/Both rudonium-id and anki-page-ID/)
        assert.deepEqual(Array.from(props.pageYamlClaims(mixed),x=>x.id),[12345,id])
    }
    const unrelated = ['example: |','  rudonium-id: 12345','local:','  rudonium-id: other']
    assert.equal(pages.readPageCard(page(unrelated),rules).id,undefined)
    assert.deepEqual(Array.from(scanner.findIdMarkers(page(unrelated)),m=>m.id),[])
    assert.equal(props.insertPageYamlId(page(['ID: 99']),12345),page(['ID: 99',"anki-page-ID: '12345'"]))
})

test('the only tag may be in the private appendix, no private content becomes a field or ID', async () => {
    for (const placement of ['yaml','heading','after-answer']) {
        const privateText='<!--rudonium-answer-end-->\nPrivate #anki-page\nID: 98765\n<!--anki-fields-->\nExtra: private'
        const raw='# Question\nVisible answer\n'+privateText
        const first=new AllFile(raw); first.data.page_id_location=placement; first.data.id_date=false
        await first.scanFile()
        assert.deepEqual({...first.all_notes_to_add[0].fields},{Front:'Question',Back:'Visible answer'})
        first.note_ids=[12345]; first.writeIDs(); const saved=first.file
        assert.ok(saved.endsWith(privateText)); assert.equal(pages.readPageCard(saved,rules).id,12345)
        const again=new AllFile(saved); await again.scanFile()
        assert.equal(again.all_notes_to_add.length,0)
        assert.equal(again.notes_to_edit[0].identifier,12345)
        assert.deepEqual(Array.from(scanner.findIdMarkers(saved),m=>m.id),[12345])
    }
})
