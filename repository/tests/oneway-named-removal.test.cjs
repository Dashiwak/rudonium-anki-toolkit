// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { load } = require('./benchmark/migration-modules.cjs')

const model = 'Knowledge', id = 1700000020012
const names = ['Question', 'Answer', 'Импортированный', 'Notes', 'Anki only', 'Origin', 'Shared', 'Text', 'Add Reverse']
const extra = 'Импортированный'
const settings = {fields_dict:{[model]:names},file_link_fields:{[model]:'Origin'}}
const disk = () => {
    const values = new Map()
    return {exists:async key=>values.has(key),read:async key=>values.get(key),write:async (k,v)=>values.set(k,v)}
}

async function setup(format) {
    const values = Object.fromEntries(names.map(name=>[name,'']))
    Object.assign(values,{Question:'Q',Answer:'A',[extra]:'Да','Anki only':'Remote value'})
    let ignoreUpdate = false, browsing = false
    const row = () => ({noteId:id,modelName:model,tags:[],cards:[id+1],fields:Object.fromEntries(
        Object.entries(values).map(([name,value],order)=>[name,{value,order}]))})
    const api = await load(['anki-delta','anki-field-value','anki-card-impact','anki-transport','export-plan','oneway-history',
        'portable-parser','card-export-diagnostics','bidirectional-blocks','anki','constants'], {
        Md5:{hashStr: text=>createHash('md5').update(text).digest('hex')},
        readFilteredAnkiDecks:async()=>new Map(),isProtectedAnkiTag:()=>false,
        read:async(action,params)=>{
            if(action==='guiSelectedNotes') return browsing ? [id] : []
            assert.equal(action,'notesInfo');assert.deepEqual(Array.from(params.notes),[id]);return [row()]
        },
        update:(noteId,fields)=>({action:'updateNoteFields',params:{note:{id:noteId,fields}}}),
        ankiBrowseMessage:noteId=>'Close the Anki browser editor for note '+noteId,
    },{anki:"import { read, update } from './host'; export { read as invoke, update as updateNoteFields }",constants:'export {}'})
    const store=disk()
    const history=profile=>api['oneway-history'].OneWayHistory.open(store,'oneway.json',profile)
    function source(fields,path='Before.md',customFrozen=['Shared']) {
        const fieldsInNote=Object.entries(fields).map(([n,v])=>n+': '+v).join('\n')
        const text=format==='page'?'# Q #anki-page\nA\n<!--anki-fields-->\n'+fieldsInNote:
            ['START',model,'Question: Q','Answer: A',fieldsInNote,'END'].filter(Boolean).join('\n')
        const file={original_file:text,namedSyncFrozenFields:()=>new Set(customFrozen)}
        if(format==='page') file.pageCard={model, front:'Q',back:'A',namedFields:new Map(Object.entries(fields))}
        const noteFields={Question:'Q',Answer:'A',...fields}
        const candidate={start:0,end:text.length,note:{modelName:model,fields:noteFields},explicitNoteBlock:format==='block'}
        const namedLayout=api['portable-parser'].oneWayNamedLayout(file,candidate,settings)
        const available = [extra,'Notes','Anki only']
        assert.deepEqual(Array.from(namedLayout.eligible),available.filter(name=>!customFrozen.includes(name)))
        assert.deepEqual(Array.from(namedLayout.present),Object.keys(fields).filter(k=>namedLayout.eligible.includes(k)))
        return {id,path,deck:'Knowledge',modelName:model,fields:noteFields,
            authoredFields:Object.keys(noteFields),tags:[],namedLayout}
    }
    async function plan(hist,note,reviewOperation) {
        const errors=[],conflicts=[]
        const changes=await api['anki-delta'].prepareExistingNoteChanges([note],(_path,reason)=>errors.push(reason),
            new Map([[id,row()]]),undefined,{history:hist,capture:r=>hist.apply([r]),allowDeckMoves:false,reviewOperation,
                onFieldConflict:conflict=>conflicts.push(conflict)})
        return {changes,errors,conflicts}
    }
    async function verify(hist,note,changes,created) {
        if(!ignoreUpdate) for(const req of changes.get(note.path)??[]) {
            assert.equal(req.action,'updateNoteFields')
            assert.equal(req.params.note.id,id)
            Object.assign(values,req.params.note.fields)
        }
        return api['anki-delta'].verifyExistingNoteFieldWrites(changes,undefined,{
            models:new Map([[id,model]]),created:created?[note]:[],namedLayouts:new Map([[id,note.namedLayout]]),
            capture:r=>hist.apply([r])})
    }
    return {source,history,plan,verify,values,holdWrite(value){ignoreUpdate=value},selectInAnki(value){browsing=value}}
}

for(const format of ['page','block']) {
    test(format+': verified creation then deleted label clears once after restart/move, preserving protected and never-owned fields',async()=>{
        const h=await setup(format)
        const first=h.source({[extra]:'Да',Notes:''})
        const history=await h.history('Profile')
        assert.equal((await h.verify(history,first,new Map(),true)).length,0)
        await history.flush()
        const resumed=await h.history('Profile')
        assert.deepEqual(Array.from(resumed.get(id,model).namedFields),[extra,'Notes'])
        const next=h.source({},'Moved.md')
        assert.equal((await h.plan(await h.history('Other profile'),next)).changes.size,0)
        const frozen=h.source({},'Moved.md',[extra,'Shared'])
        assert.equal((await h.plan(resumed,frozen)).changes.size,0)
        const preview=[]
        const skipped=await h.plan(resumed,next,(_path,operation)=>{preview.push(operation);return false})
        assert.equal(skipped.changes.size,0)
        assert.deepEqual({...preview[0].values[0]},{name:extra,before:'Да',after:''})
        let planned=await h.plan(resumed,next)
        assert.deepEqual({...planned.changes.get(next.path)[0].params.note.fields},{[extra]:''})
        assert.equal(planned.errors.length,0)
        h.holdWrite(true)
        h.selectInAnki(true)
        assert.match((await h.verify(resumed,next,planned.changes,false))[0],/Anki browser editor/)
        await resumed.flush()
        const retry=await h.history('Profile')
        assert.deepEqual(Array.from(retry.get(id,model).namedFields),[extra])
        h.holdWrite(false)
        h.selectInAnki(false)
        planned=await h.plan(retry,next)
        assert.equal((await h.verify(retry,next,planned.changes,false)).length,0)
        await retry.flush()
        assert.equal(h.values[extra],'')
        assert.equal(h.values['Anki only'],'Remote value')
        assert.equal(h.values.Question,'Q')
        h.values[extra]='Anki subsequently added a new value'
        assert.equal((await h.plan(await h.history('Profile'),next)).changes.size,0)
    })
    test(format+': remote changes conflict with confirmed local removal; unconfirmed stale history cannot clear a field',async()=>{
        const h=await setup(format)
        const hist=await h.history('Profile')
        hist.apply([{id,modelName:model,fields:{[extra]:'Да'}}]) // A 0.9.5 receipt had no label ownership.
        const removed=h.source({})
        assert.equal((await h.plan(hist,removed)).changes.size,0)
        const present=h.source({[extra]:'Да'})
        assert.equal((await h.plan(hist,present)).changes.size,0)
        await hist.flush()
        h.values[extra]='Concurrent remote edit'
        const result=await h.plan(await h.history('Profile'),removed)
        assert.equal(result.changes.size,0); assert.equal(result.conflicts.length,1)
        assert.equal(result.conflicts[0].name,extra)
        assert.equal(h.values[extra],'Concurrent remote edit')
        const nowFrozen=h.source({},'After.md',[extra,'Shared'])
        assert.equal((await h.plan(hist,nowFrozen)).changes.size,0)
    })
}
