// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { load } = require('./benchmark/migration-modules.cjs')

const request = (action, params) => ({ action, params })
const model = 'Basic'
const source = (fields = {}, tags = []) => ({ id: 1001, modelName: model, path: 'New.md', deck: 'Geo', fields, tags })
const methods = {
    updateNoteFields: (id, fields) => request('updateNoteFields', { note: { id, fields } }),
    addTags: (notes, tags) => request('addTags', { notes, tags }),
    removeTags: (notes, tags) => request('removeTags', { notes, tags }),
    readFilteredAnkiDecks: async () => new Map(),
    isProtectedAnkiTag: tag => ['marked','leech'].includes(tag) || tag.startsWith('rudonium::recovery::'),
    Md5: { hashStr: value => createHash('md5').update(value).digest('hex') },
}
const all = load(['portable-parser','anki-delta','anki-card-impact','anki-field-value','oneway-history',
    'anki','constants','export-batch','anki-transport','deck-routes'], methods, {
    anki: "import { updateNoteFields,addTags,removeTags } from './host'; export {updateNoteFields,addTags,removeTags};",
    constants: 'export const empty = 1;',
})

const storage = () => {
    const files = new Map()
    return { exists: async path => files.has(path), read: async path => files.get(path),
        write: async (path, data) => { files.set(path, data) } }
}
const fieldsInAnki = fields => Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,{value:v}]))
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
async function plan(api, history, note, remote, tags, capture = ()=>{}) {
    return api['anki-delta'].prepareExistingNoteChanges([note], (_,why)=>assert.fail(why),
        new Map([[note.id,{modelName:model,tags,fields:fieldsInAnki(remote),cards:[111]}]]),undefined,
        {history, allowDeckMoves:false, capture})
}

test('one-way: custom captures still export generated file, context and shared values, leaving remote-only fields alone', async () => {
    const api = await all
    const old = {Front:'Q',Back:'A',File:'obsidian://anki-card?file=Old.md',Context:'Old heading',Shared:'old shared'}
    const next = {...old,File:'obsidian://anki-card?file=New.md',Context:'New heading',Shared:'new shared',Extra:''}
    const get = () => ({fields:Object.fromEntries(Object.entries(old).map(([k,v])=>[k,api['oneway-history'].oneWayFieldDigest(v)]))})
    for (const pageCard of [undefined, {model,front:'Q',back:'A'}]) {
        const file = {pageCard, original_file:'Q:A'}
        const candidate = {start:0,end:3,authoredFields:['Front','Back'],note:{modelName:model,fields:next}}
        const note = {...source(next), authoredFields:api['portable-parser'].authoredFieldNames(file,candidate,next)}
        const actions = (await plan(api,{get}, note, {...old,Extra:'only in Anki'}, [])).get('New.md')
        assert.deepEqual(plain(actions?.[0]?.params.note.fields ?? {}),{File:next.File,Context:next.Context,Shared:next.Shared})
        const protectedPage = {pageCard:{fieldPair:['Front','Back'],linkedRoute:{}}, original_file:'Q:A'}
        assert.deepEqual([...api['portable-parser'].authoredFieldNames(protectedPage,candidate,next)],['Front','Back'])
    }
})

test('one-way: drop and re-add an inherited Anki tag, including empty source, remote-only and Anki study tags', async () => {
    const api = await all
    const history = await api['oneway-history'].OneWayHistory.open(storage(),'history','Profile')
    const capture = receipt => history.apply([receipt])
    const remote = ['Geo','AnkiOnly','marked','leech']
    await plan(api,history,source({},['geo']),{},remote,capture)
    const drop = await plan(api,history,source({},[]),{},remote,capture)
    assert.equal(drop.size,0)
    const again = await plan(api,history,source({},['GEO']),{},remote.slice(1),capture)
    assert.deepEqual(plain(again.get('New.md')), [request('addTags',{notes:[1001],tags:'GEO'})])
    capture({id:1001,modelName:model,addedTags:['GEO']})
    const removeOwned = await plan(api,history,source({},[]),{},remote,capture)
    assert.deepEqual(plain(removeOwned.get('New.md')), [request('removeTags',{notes:[1001],tags:'Geo'})])
})

for (const hook of ['beforeSend','preparePacket']) {
    test('one-way: earlier accepted creations survive a thrown '+hook+' before packet two', async () => {
        const api = await all
        const actions = Array.from({length:501},(_,index)=>request('addNote',{note:{fields:{Front:String(index)}}}))
        const seen = []
        let sent=0
        const guard = async () => {if(sent) throw Error('connection to Anki was closed'); return hook==='preparePacket'? {} : undefined}
        const confirmed = await api['export-batch'].sendExportBatches(actions,async packet=>{
            sent += packet.length
            return packet.map((_,i)=>({result:2001+i,error:null}))
        },undefined,hook==='beforeSend'? guard : undefined,{
            reviewEveryPacket:true,preparePacket:hook==='preparePacket'? guard : undefined,
            observeJournalResponse:(_req,row,unsent)=>seen.push([row.result,unsent]),
        })
        assert.equal(sent,500)
        assert.equal(confirmed.responses[499].result,2500)
        assert.equal(confirmed.uncertain,false)
        assert.match(confirmed.problem,/connection to Anki/)
        assert.equal(api['export-batch'].isUnsentExportResponse(confirmed.responses[500]),true)
        assert.deepEqual(seen[499],[2500,false])
        assert.deepEqual(seen[500],[null,true])
    })
}

test('one-way: canonically equivalent YAML, folder and note tags are sent once on creation', async () => {
    const api = await all
    const note = {tags:['Café','cafe\u0301','']};
    const scanned = {all_notes_to_add:[note],notes_to_edit:[],global_tags:''}
    api['portable-parser'].applyAuthoredTags(scanned,'Q :: A',[],['CAFÉ','Wien'])
    assert.deepEqual([...note.tags],['Café','Wien'])
})

test('one-way: 768 mixed local/remote updates, conflicts and untouched fields use the correct file and ID', async () => {
    const api = await all, total=768, notes=[], snapshots=new Map(), records=new Map(), expected=new Map()
    const digest = api['oneway-history'].oneWayFieldDigest
    const expectedConflicts = new Set()
    for(let i=0;i<total;i++) {
        const id = 80000+i
        const modelName=i%2 ? 'Vocab' : 'Basic'
        const path=(i%2?'Moved/':'Old/')+(i%31)+'.md'
        const old='base-'+id, local='local-'+id, remote='remote-'+id
        const wanted=[local,old,local,'',local,old,''][i%7]
        const actual=[old,remote,remote,old,local,old,remote][i%7]
        const fields={Front:'question-'+id,Back:wanted,Extra:''}
        notes.push({id,modelName,path,deck:'Geo',fields,authoredFields:['Front','Back'],tags:[]})
        snapshots.set(id,{modelName,tags:['marked','Private'],cards:[id+90000],fields:fieldsInAnki({...fields,Back:actual,Extra:'Anki only '+id})})
        records.set(id,{fields:{Front:digest(fields.Front),Back:digest(old)}})
        if ([0,2,3].includes(i%7)) expected.set(id,{path,fields:{Back:wanted}})
        if(i%7===6) expectedConflicts.add(id)
    }
    const conflicts=new Set()
    const changes=await api['anki-delta'].prepareExistingNoteChanges(notes,()=>{},
        snapshots,undefined,{history:{get:id=>records.get(id)},allowDeckMoves:false,onFieldConflict:row=>conflicts.add(row.id)})
    assert.deepEqual(conflicts,expectedConflicts)
    for(const [path,actions] of changes) for(const action of actions) {
        assert.equal(action.action,'updateNoteFields')
        const id=action.params.note.id, row=expected.get(id)
        assert.equal(path,row?.path)
        assert.deepEqual(plain(action.params.note.fields),row.fields)
        expected.delete(id)
    }
    assert.equal(expected.size,0)
})

test('one-way: the edited Markdown question wins on a tracked ID; destructive, rich and untracked differences await review', async () => {
    const api = await all
    const digest = api['oneway-history'].oneWayFieldDigest
    const cases = [
        ['Казематы', 'Казематы+', 'Казематы0000', true],
        ['Old', 'New', 'Old', true],
        ['Old', '', 'Old', true],
        ['Old', 'Old', 'Anki edit', false],
        ['Old', 'New', 'New', false],
        ['Old', 'New', 'Remote<img src="ink.png">', false],
        ['Old', '', 'Remote', false],
        ['Old', 'New', '', false],
        ['Old', 'New', '[sound:record.mp3]', false],
        ['Old', 'New', '{{c1::Cloze}}', false],
        ['{{c1::Old}}', '{{c1::Local}}', '{{c1::Anki}}', false],
        ['{{c1::Old}}', '{{c1::Local}}', '{{c1::Old}}', true],
        ['Old', 'New', String.raw`\(E=mc^2\)`, false],
        ['Old', String.raw`\[a+b\]`, 'Remote', false],
        ['Old', 'New', '[latex]x^2[/latex]', false],
        ['Old', 'New', '[$$]x^2[/$$]', false],
        ['Old', 'New', '[$]x^2[/$]', false],
        ['Old', 'The fee is $2.50', 'The fee is $3.00', true],
        [undefined, 'New', 'Remote', false],
    ]
    for (const [old,local,anki,changed] of cases) {
        const src = source({ Front:local })
        src.authoredFields = ['Front']
        const available = old !== undefined ? {fields:{Front:digest(old)}} : undefined
        const note = {modelName:model,tags:[],fields:fieldsInAnki({Front:anki,Extra:'From Anki'}),cards:[2201]}
        const errors = []
        const changes = await api['anki-delta'].prepareExistingNoteChanges([src], (_,reason) => errors.push(reason),
            new Map([[src.id,note]]),undefined,{history:{get:()=>available},allowDeckMoves:false})
        const actions = changes.get(src.path) ?? []
        assert.deepEqual(plain(actions), changed ? [request('updateNoteFields',{note:{id:src.id,fields:{Front:local}}})] : [])
        const review = !changed && local !== old && local !== anki
        assert.equal(errors.length, review ? 1 : 0, String(local)+' vs '+anki)
        if (review) assert.match(errors[0], /Preview Export/)
    }
})

test('one-way: moving an ordinary note into a folder named constructor does not block export', async () => {
    const parse = (await all)['portable-parser'].portableFileData
    for(const name of ['constructor','__proto__','toString','Atlas']) {
        const file = {path:name+'/Note.md',parent:{path:name,parent:{path:'/',parent:null}}}
        const settings = {folder_tags:{},template:{tags:['global'],deckName:'Geo'},
            NOTE_REGEXP:/x/g,INLINE_REGEXP:/y/g,EMPTY_REGEXP:/z/g}
        assert.deepEqual([...parse(settings,file,[1001]).template.tags],['global'])
        settings.folder_tags = Object.fromEntries([[name,'places travel']])
        assert.deepEqual([...parse(settings,file,[1001]).template.tags],['places','travel','global'])
    }
})

test('folder tags follow ancestors, a cleared child still inherits, and siblings stay separate', async () => {
    const parse = (await all)['portable-parser'].portableFileData
    const root = { path: '/', parent: null }
    const country = { path: 'Страны', parent: root }
    const city = { path: 'Страны/Австрия', parent: country }
    const file = { path: city.path + '/Вена.md', parent: city }
    const tags = { 'Страны': 'places', 'Страны/Австрия': 'austria de_AT', 'Страны/Италия': 'italy' }
    const settings = { folder_tags: tags, template: { tags: ['global'], deckName: 'Geo' },
        NOTE_REGEXP: /x/g, INLINE_REGEXP: /y/g, EMPTY_REGEXP: /z/g }
    assert.deepEqual([...parse(settings, file, []).template.tags], ['austria', 'de_AT', 'places', 'global'])
    delete tags[city.path]
    assert.deepEqual([...parse(settings, file, []).template.tags], ['places', 'global'])
})

test('one-way: unchanged receipts do not checkpoint; a changed field and tag survive restart and stay in their profile', async () => {
    const api = await all
    const disk = storage()
    let count=0
    const write=disk.write
    disk.write=async (...args)=>{count++;await write(...args)}
    const {OneWayHistory,oneWayFieldDigest} = api['oneway-history']
    const receipt = {id:77,modelName:model,fields:{Front:'Ä',Back:'A'},addedTags:['X','Y']}
    const hist=await OneWayHistory.open(disk,'history','Alpha')
    hist.apply([receipt]); await hist.flush()
    const old=hist.get(77,model)
    hist.apply([{...receipt,fields:{Front:'A\u0308',Back:'A'},matchedTags:['y','x']}])
    await hist.flush()
    assert.equal(count,1)
    hist.apply([{id:77,modelName:model,fields:{Back:''},removedTags:['x']}])
    await hist.flush()
    assert.equal(count,2)
    assert.equal(old.fields.Back,oneWayFieldDigest('A'))
    const saved=(await OneWayHistory.open(disk,'history','Alpha')).get(77,model)
    assert.equal(saved.fields.Front,oneWayFieldDigest('Ä'))
    assert.equal(saved.fields.Back,oneWayFieldDigest(''))
    assert.deepEqual([...saved.managedTags],['y'])
    assert.equal((await OneWayHistory.open(disk,'history','Beta')).get(77,model),undefined)
})
