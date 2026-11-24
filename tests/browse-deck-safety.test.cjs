// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')
const { managerType } = require('./benchmark/patched-manager.cjs')

test('100 destination decks including duplicates use two requests and isolate one failed configuration', async () => {
    const { 'anki-study-state': state } = await load(['anki-study-state'], {})
    const decks = Array.from({length: 100}, (_, index) => 'Deck ' + index)
    const calls = [], unverified = new Set()
    const filtered = await state.readFilteredAnkiDecks([...decks, ...decks], async (action, {actions}) => {
        assert.equal(action, 'multi')
        calls.push(actions.length)
        return actions.map(({action, version, params: {deck}}) => {
            assert.equal(action, 'getDeckConfig')
            assert.equal(version, 6)
            return deck === 'Deck 7' ? {error: 'temporary failure', result: null} :
                {error: null, result: {dyn: deck === 'Deck 9' ? 1 : 0}}
        })
    }, undefined, unverified)
    assert.deepEqual(calls, [64, 36])
    assert.deepEqual([...unverified], ['deck 7'])
    assert.deepEqual(Array.from(filtered, ([key, name]) => [key,name]), [['deck 9', 'Deck 9']])
})

test('destination creation separates a genuine new deck, a case variant, a missing inventory and a cancelled packet', async () => {
    const { 'anki-study-state': state } = await load(['anki-study-state'], {})
    const filter = state.readFilteredAnkiDecks
    const unknown = new Set(), calls = []
    const filtered = await filter(['NEW', 'exam'], async (action, params) => {
        calls.push(action)
        if (action === 'multi') return [{error: null, result: false},{error: null, result: false}]
        if (action === 'deckNamesAndIds') return {Exam: 42}
        assert.equal(params.deck, 'Exam')
        return {dyn: true}
    }, undefined, unknown)
    assert.deepEqual(calls, ['multi', 'deckNamesAndIds', 'getDeckConfig'])
    assert.deepEqual(Array.from(filtered, ([key, name]) => [key,name]), [['exam','Exam']])
    assert.equal(unknown.size, 0)
    await filter(['New'], async act => act === 'getDeckConfig' ? false : undefined, undefined, unknown)
    assert.deepEqual([...unknown], ['new'])
    const deferred = new Set()
    await filter(['A', 'B'], () => assert.fail('cancelled'), () => true, deferred)
    assert.deepEqual([...deferred], ['a','b'])
})

test('one-way dispatch defers the selected note by ID, continues its neighbour and retries only the outstanding field', async () => {
    const path = 'Монастырь.md', q = 'В каком монастыре Винер-Нойштадта похоронена Элеонора?'
    const src = [{ id: 3001, front: q }, { id: 3002, front: 'Что находится рядом?' }]
    const target = 'новый ответ'
    const remote = new Map(src.map(n => [n.id, 'прежний ответ']))
    const selected = new Set([3001]), sent = [], history = []
    const read = async (action, params) => {
        if (action === 'guiSelectedNotes') return [...selected]
        if (action === 'notesInfo') return params.notes.map(noteId => ({ noteId, modelName: 'Knowledge', tags: [], cards: [noteId + 55],
            fields: {Front:{value:src.find(row => row.id === noteId).front},Back:{value:remote.get(noteId)}} }))
        assert.equal(action, 'multi')
        return params.actions.map(request => {
            const { id, fields } = request.params.note
            assert.equal(selected.has(id), false)
            sent.push(id); remote.set(id, fields.Back)
            return {result: null, error: null}
        })
    }
    const noop = () => {}
    const raw = { transport: read, isRecoveryTag: () => false }
    const mod = await load(['anki','anki-delta','anki-field-value','anki-transport','export-batch','interface-language','card-export-diagnostics'], raw,
        {anki:"import { transport } from './host'; export const invoke = transport"})
    const delta = mod['anki-delta'], lang = mod['interface-language']
    const title = lang.ankiBrowseMessage(3001, q)
    const Manager = managerType({
        ...mod['export-batch'], ...delta, ...lang, AnkiConnect: {invoke:read}, AnkiProfileError: class extends Error {},
        readFilteredAnkiDecks: async () => new Map(), recoverySlotLines: () => [],
        plannedMediaAliases: () => new Map(), planMedia: async () => [], applyMedia: async () => new Set(),
        conflictingDeckDirective: noop,
        fastResult: row => row?.error === null ? row.result : undefined,
        checkFastResponses: (_req, rows, errors) => rows.forEach(r => { if (r.error) errors.push(r.error.replace('This action was not sent. ','')) }),
    })
    const file = {path, text:''}
    async function sync() {
        const m = new Manager()
        Object.assign(m, { data:{fields_dict:{Knowledge:['Front','Back']}}, files:[file], app:{vault:{getAbstractFileByPath: () => file}},
            ankiProfile:'A', checkAnkiProfile:async () => 'A', onSyncChange: row => history.push(row), getRecovery:async () => ({get:noop,records:()=>[]}),
            ownFiles:[{path,global_tags:'',all_notes_to_add:[], notes_to_delete:[],notes_to_edit:src.map(row => ({
                identifier:row.id,note:{modelName:'Knowledge',fields:{Front:row.front,Back:target}}
            })),note_ids:[],file:'',original_file:'',formatter:{detectedMedia:new Set()}}],
            prepareExistingUpdates: async () => {
                m.existingChanges.set(path, src.filter(row => remote.get(row.id) !== target).map(row => {
                    const request = {action:'updateNoteFields',version:6,params:{note:{id:row.id, fields:{Back:target}}}}
                    m.reviewedRequests.set(request, [{id:row.id, modelName:'Knowledge', fields:[['Back',remote.get(row.id)]]}])
                    return request
                }))
            },
        })
        await m.requests_1()
        return [...m.retryMessages]
    }
    const errors = await sync()
    assert.deepEqual(sent,[3002])
    assert.ok(errors.some(msg => msg.includes(title)), errors)
    const russian = mod['card-export-diagnostics'].localizeExportError(errors[0], lang.russianUi)
    assert.ok(russian.includes('В окне «Обзор» Anki выбрана запись ID 3001') && russian.includes(q), russian)
    assert.ok(russian.includes('Выберите другую запись'))
    selected.clear()
    assert.deepEqual(await sync(),[])
    assert.deepEqual(sent,[3002,3001])
    assert.deepEqual(history.map(row => [row.noteId, row.action]), [[3001, 'skip'], [3002, 'edit'], [3001, 'edit']])
    for (const row of history.filter(row => row.action === 'edit')) {
        assert.equal(row.path, path)
        assert.equal(row.direction, 'to-anki')
        assert.deepEqual(JSON.parse(JSON.stringify(row.fields)), [{name:'Back',before:'прежний ответ',after:target}])
    }
    assert.deepEqual(await sync(), [])
    assert.equal(history.length, 3)
})

test('a mismatched field readback without a selected note does not blame the browser', async () => {
    const read = async action => action === 'notesInfo' ? [{noteId:5, modelName:'Basic',tags:[],cards:[8],fields:{Back:{value:'old'}}}] : []
    const mod = await load(['anki','anki-delta','anki-field-value','anki-transport','interface-language'], {transport:read},
        {anki:"import { transport } from './host'; export const invoke = transport"})
    const changes = new Map([['Sample.md',[{action:'updateNoteFields',params:{note:{id:5,fields:{Back:'new'}}}}]]])
    const [error] = await mod['anki-delta'].verifyExistingNoteFieldWrites(changes)
    assert.match(error,/ID 5: fields differ after saving \(Back\)/)
    assert.doesNotMatch(error,/browse/i)
})

test('a failed deck holds only its cards in a mixed file; after restart the journal binds the original line', async () => {
    const { 'anki-study-state': state } = await load(['anki-study-state'], {})
    const Manager = managerType({...state, withAnkiDeadline: fn => fn(), noteRecoverySignature: note => note.fields.Front,
        recoverySlotLines: file => file.all_notes_to_add.map(note => note.line),
        AnkiConnect: {invoke: async () => [{error: 'offline',result:null},{error:null,result:{dyn:0}}]}})
    const path = 'Two decks.md'
    const source = () => ({path,all_notes_to_add:[{deckName:'Exam',line:3,fields:{Front:'Q1'}},{deckName:'Study',line:7,fields:{Front:'Q2'}}],
        removeUnsafeNewCards(held) { this.all_notes_to_add = this.all_notes_to_add.filter(note => !held.has(note)) }})
    const manager = new Manager(), file = source()
    manager.sourceHashes.set(path,'same')
    assert.equal((await manager.blockedCreationFiles([file])).size,0)
    assert.deepEqual(file.all_notes_to_add.map(n => n.line),[7])
    assert.match([...manager.retryMessages][0],/Deck type unverified: Exam/)
    const entry = {path,sourceHash:'same',slotLines:[7],signatures:['Q2']}
    const resumed = source()
    assert.equal(manager.matchesRecoverySource(resumed,entry),true)
    assert.deepEqual(resumed.all_notes_to_add.map(n => n.line),[7])
    const ambiguous = source()
    ambiguous.all_notes_to_add.push({...ambiguous.all_notes_to_add[1]})
    assert.equal(manager.matchesRecoverySource(ambiguous,entry),false)
    assert.equal(ambiguous.all_notes_to_add.length,3)
    assert.equal(manager.matchesRecoverySource(source(),{...entry,sourceHash:'other'}),false)
})

test('one missing note on strict AnkiConnect leaves the other linked notes available at planning, preflight and readback', async () => {
    const modelName = 'Basic', gone = 702, reads = [], receipts = [], problems = []
    const live = new Map([[701,'old'], [703,'old']])
    const wanted = 'edited in Markdown'
    const transport = async (action, params) => {
        reads.push([action, JSON.parse(JSON.stringify(params))])
        if (action === 'findNotes') {
            assert.equal(params.query,'nid:701,702,703')
            return [703,701]
        }
        assert.equal(action,'notesInfo')
        if (params.notes.includes(gone)) throw Error('note was not found: 702')
        return [...params.notes].reverse().map(id => ({noteId:id, modelName, tags:[], cards:[id+1000],
            fields:{Back:{value:live.get(id)}}}))
    }
    const mod = await load(['anki','anki-delta','anki-field-value','anki-card-impact','anki-transport','anki-study-state','oneway-history'],
        {transport, Md5:{hashStr:value=>require('node:crypto').createHash('md5').update(value).digest('hex')},
        update:(id,fields)=>({action:'updateNoteFields',params:{note:{id,fields}}})},
        {anki:"import {transport,update} from './host'; export const invoke=transport,updateNoteFields=update"})
    const api = mod['anki-delta']
    const ids = [701,gone,703], hash = mod['oneway-history'].oneWayFieldDigest('old')
    const source = ids.map(id=>({id,modelName,path:id+'.md',deck:'Default',fields:{Back:wanted},tags:[]}))
    const plan = await api.prepareExistingNoteChanges(source,(path,msg)=>problems.push([path,msg]),new Map(),undefined,
        {history:{get:()=>({fields:{Back:hash}})},allowDeckMoves:false})
    assert.deepEqual([...plan.keys()],['701.md','703.md'])
    assert.deepEqual(problems.map(row=>row[0]),['702.md'])
    assert.equal(plan.get('701.md')[0].params.note.id,701)
    assert.deepEqual([...(await api.readReviewedNoteSnapshots(ids)).keys()].sort(),[701,703])
    const plannedBeforeRemotelyDeletingNote = new Map(source.map(note=>[note.path,[{action:'updateNoteFields',params:{note}}]]))
    for (const id of live.keys()) live.set(id,wanted)
    const issues = await api.verifyExistingNoteFieldWrites(plannedBeforeRemotelyDeletingNote,undefined,
        {models:new Map(ids.map(id=>[id,modelName])),capture:r=>receipts.push(r)})
    assert.deepEqual([...issues],['702.md: could not verify saved fields for Anki note 702'])
    assert.deepEqual(receipts.map(r=>[r.id,r.fields.Back]),[[701,wanted],[703,wanted]])
    assert.deepEqual(reads.map(r=>r[0]),Array(3).fill(['notesInfo','findNotes','notesInfo']).flat())
})

test('strict note lookup refuses an unverified fallback and does not retry transport failures', async () => {
    let reply, error, reads
    const transport = async action => {
        reads.push(action)
        if (action === 'findNotes') return reply
        throw Error(error)
    }
    const mod = await load(['anki','anki-delta','anki-transport'],{transport},{anki:"import {transport} from './host';export const invoke=transport"})
    for (const response of [[811,811],[914],[811,812],[{id:811}],Array(1),'811']) {
        reply = response; error = 'note does not exist'; reads = []
        await assert.rejects(mod['anki-delta'].readReviewedNoteSnapshots([811,812]),/note does not exist/)
        assert.deepEqual(reads,['notesInfo','findNotes'])
    }
    error = 'Connection refused'; reads = []
    await assert.rejects(mod['anki-delta'].readReviewedNoteSnapshots([811,812]),/Connection refused/)
    assert.deepEqual(reads,['notesInfo'])
})
