// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
let helpers, parser, markers
before(async () => {
    const modules = await load(['page-frontmatter', 'page-card', 'duplicate-markers', 'anki-id-marker',
        'id-marker-literals','card-format-presets','export-recovery','anki-transport','markdown-pipeline'], {})
    helpers = modules['page-frontmatter']
    parser = modules['page-card']
    markers = modules['duplicate-markers']
})

const model = { Basic: '@page' }
const id = 1700000000555
const question = '# Question #anki-page'
const answer = 'A\nsecond line'
const document = rows => ['---', ...rows, '---', question, answer].join('\n')
test('page ID property is inserted losslessly with BOM, original LF/CRLF and original nested properties', () => {
    for (const eol of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
        for (const head of [[], ['---','tags:','- sample','- other','aliases: [a, b]','# leave me','private: |','  anki-page-ID: 37','---']]) {
            const body = [question,'','First sentence','', '## Detail','Second sentence'].join(eol)
            const raw = bom + (head.length ? head.join(eol) + eol : '') + body
            const page = parser.readPageCard(raw,model)
            const result = parser.writePageId(raw,page,id,true,'2026-11-20','yaml')
            const row = "anki-page-ID: '" + id + "' # | 2026-11-20"
            const expected = head.length ? [...head.slice(0,-1),row,'---'] : ['---',row,'---']
            assert.equal(result,bom + expected.join(eol) + eol + body)
            assert.equal(parser.writePageId(result,page,id,false,undefined,'yaml'),result)
            const found = parser.readPageCard(result,model)
            assert.equal(found.id,id)
            assert.equal(found.idLocation,'yaml')
            assert.equal(found.back,page.back)
            assert.equal(result.slice(found.idStart,found.idEnd),row)
            assert.equal(parser.pageBlock(found).start,0)
            const marker = helpers.pageYamlId(result)
            assert.equal(result.slice(marker.digitsStart,marker.digitsEnd),String(id))
            assert.equal(result.slice(marker.bodyStart).trim(),result.slice(found.backStart).trim())
            assert.deepEqual(Array.from(markers.findIdMarkers(result),m=>[m.id,m.line,m.location]),[[id,marker.line,'yaml']])
        }
    }
})

test('manual scalar syntax and comments retain the original ID; display preferences never relocate it', () => {
    for (const key of ['anki-page-ID', '"anki-page-ID"', "'anki-page-ID'"]) for (const value of [String(id), '"'+id+'"', "'"+id+"'"]) {
        const file = document([key+': '+value+' # personal note'])
        assert.equal(parser.readPageCard(file,model).id,id)
        assert.equal(helpers.pageYamlId(file).id,id)
    }
    const legacy=[question,'SUSPEND_2','<!--ID: '+id+' | 2020-01-01!-->','A'].join('\n')
    assert.equal(parser.readPageCard(legacy,model).idLocation,'heading')
    assert.throws(()=>helpers.insertPageYamlId(legacy,id))
})

test('malformed or ambiguous links block creating a second note and positive IDs remain reserved in the vault index', () => {
    for (const value of ['','0','-12','1e3','12.5','"001"','9007199254740992','[123]','*source','12#suffix']) {
        assert.throws(()=>parser.readPageCard(document(['anki-page-ID: '+value]),model))
    }
    for (const rows of [['anki-page-ID: 123',"'anki-page-ID': 456"],['anki-page-ID: 123','anki-page-ID: broken'],
        ['defaults: &defaults','  anki-page-ID: 123','<<: *defaults'], ['{"anki-page-ID":"123"}'],['- entry','anki-page-ID: 123']]) {
        assert.throws(()=>parser.readPageCard(document(rows),model))
    }
    assert.deepEqual(Array.from(markers.findIdMarkers(document(['anki-page-ID: 123',"'anki-page-ID': 456"])),m=>m.id),[123,456])
    const flow = document(['{', '  "anki-page-ID": "789"', '}'])
    assert.throws(()=>parser.readPageCard(flow,model))
    assert.deepEqual(Array.from(markers.findIdMarkers(flow),m=>[m.id,m.line]),[[789,3]])
    const nestedFlow=document(['tags: [','   "anki-page-ID: 55",','   travel]','anki-page-ID: 101'])
    assert.equal(parser.readPageCard(nestedFlow,model).id,101)
    const dual=document(['anki-page-ID: 123']).replace(question,question+'\nID: 123')
    assert.throws(()=>parser.readPageCard(dual,model),/one page ID/u)
    for (const rows of [['hello'],['- list item'],['-'],['[one, two]'], ['tags: [open'], ['title: "unclosed'], ['{"tags":[]}']]) {
        assert.throws(()=>helpers.validatePageYamlPlacement(document(rows)))
    }
    assert.throws(()=>helpers.insertPageYamlId([question,'ID: 123','Answer'].join('\n'),124))
})

test('unmarked notes, examples and private tails cannot acquire a second Anki identity', () => {
    assert.throws(()=>parser.readPageCard(document(['anki-page-ID: 123']).replace('#anki-page',''),model),/#anki-page/u)
    assert.throws(()=>parser.readPageCard(document(['anki-page-ID: 123']),{Basic:'other'}),/@page/u)
    const text = document(['title: Example','props:','  anki-page-ID: 123'])
    assert.equal(parser.readPageCard(text,model).id,undefined)
    assert.deepEqual(Array.from(markers.findIdMarkers(text)),[])
    const example = document([])+'\n\n```yaml\nanki-page-ID: 222\n```'
    assert.equal(helpers.pageYamlId(example),undefined)
    const privateText = document(['anki-page-ID: 123'])+'\n<!--rudonium-answer-end-->\nID: 789\n<!--rudonium-page-route: invalid-->\n'
    assert.deepEqual(Array.from(markers.findIdMarkers(privateText),m=>m.id),[123])
    assert.equal(parser.readPageCard(privateText,model).back,answer)
})
