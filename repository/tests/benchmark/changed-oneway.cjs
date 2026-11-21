// SPDX-License-Identifier: GPL-3.0-only
// Compares the production delta planner and packet sender with an independent Anki state model.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')

async function exercise(kit, size, files = size, fault = false) {
    const {load} = require(path.resolve(kit, 'tests/benchmark/migration-modules.cjs'))
    const remote = new Map(), prior = new Map(), expected = new Map(), sources = []
    const idBase = 1784500000000
    let seed = 12571687
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const host = {
        Md5: { hashStr: s => createHash('md5').update(s).digest('hex') },
        read: async (action, p) => {
            if (action === 'notesInfo') return p.notes.map(id => structuredClone(remote.get(id) ?? {})).reverse()
            throw Error('unexpected read ' + action)
        },
    }
    const shim = `import {read} from './host';
        export const invoke=read;
        export const updateNoteFields=(id,fields)=>({action:'updateNoteFields',params:{note:{id,fields}}});
        export const addTags=(notes,tags)=>({action:'addTags',params:{notes,tags}});
        export const removeTags=(notes,tags)=>({action:'removeTags',params:{notes,tags}});`
    const m = await load(['anki-delta','anki-field-value','anki-card-impact','oneway-history','anki-study-state','export-recovery',
        'export-batch','anki-transport','anki'],host,{anki:shim})
    const digest = m['oneway-history'].oneWayFieldDigest
    for (let i = 0; i < size; i++) {
        const id = idBase + i, kind = next() % 4, salt = next().toString(36)
        const modelName = i % 2 ? 'Dictionary' : 'Facts'
        const initialTags = ['old', 'RemoteOnly', ...(i % 7 === 0 ? ['leech','marked'] : [])]
        const tags = kind < 2 ? ['old', 'unit::' + salt] : []
        const fields = {Front: 'Q ' + i, Back: 'A ' + i, Extra: 'remote only ' + salt}
        const wanted = 'Updated ' + i + ' ' + salt
        const meta = {modelName, cards:[id+size], deckName:'Knowledge'}
        remote.set(id,{...meta,noteId:id,fields:Object.fromEntries(Object.entries(fields).map(([name,value],order)=>[name,{value,order}])),tags:initialTags})
        prior.set(id,{modelName,fields:{Front:digest(fields.Front),Back:digest(fields.Back)},matchedTags:['old'],managedTags:['old']})
        sources.push({id, modelName, deck:'Knowledge', fields:{Front:fields.Front,Back:wanted,Extra:''},
            authoredFields:['Front','Back'],tags,path:'Queue/' + (i % files) + '.md'})
        expected.set(id,{Back:wanted,Extra:fields.Extra,tags:[...new Set([...tags,...initialTags.filter(t=>t!=='old')])].sort()})
    }
    const plan = async () => {
        const notes = [], observations = []
        const changes = await m['anki-delta'].prepareExistingNoteChanges(sources,(where,why)=>notes.push([where,why]),new Map(),undefined,
            {history:{get:id=>prior.get(id)},allowDeckMoves:false,capture:x=>observations.push(x)})
        assert.deepEqual(notes, [])
        return [...changes.values()].flat()
    }
    let packetCount = 0, writes = 0, fieldsWritten = 0, interrupted = false, replayed = false, peakPacket = 0
    const seenFields = new Set()
    const send = async actions => {
        packetCount++
        peakPacket = Math.max(peakPacket, actions.length)
        assert.ok(actions.length && actions.length<=500)
        for (const {action,params} of actions) {
            const id = action === 'updateNoteFields' ? params.note.id : params.notes[0]
            const row = remote.get(id); assert.ok(row)
            if (action === 'updateNoteFields') {
                assert.deepEqual(Object.keys(params.note.fields),['Back'])
                if (seenFields.has(id)) replayed = true
                seenFields.add(id)
                row.fields.Back.value = params.note.fields.Back
                fieldsWritten++
            } else if (action === 'addTags') {
                row.tags = [...new Set([...row.tags, ...params.tags.split(' ')])]
            } else {
                assert.equal(action,'removeTags')
                const remove = new Set(params.tags.split(' '))
                row.tags = row.tags.filter(tag=>!remove.has(tag))
            }
            writes++
        }
        if (fault && !interrupted && packetCount === 2) {interrupted = true; throw Error('lost packet acknowledgement after commit')}
        return actions.map(()=>({result:null,error:null}))
    }
    const start = performance.now()
    const first = await m['export-batch'].sendExportBatches(await plan(),send)
    if (interrupted) {
        assert.equal(first.uncertain,true)
        const second = await m['export-batch'].sendExportBatches(await plan(),send)
        assert.equal(second.problem,undefined)
    } else assert.equal(first.problem,undefined)
    const elapsed = performance.now()-start
    for (const [id,want] of expected) {
        const actual=remote.get(id)
        assert.equal(actual.fields.Back.value,want.Back)
        assert.equal(actual.fields.Extra.value,want.Extra)
        assert.deepEqual([...actual.tags].sort(),want.tags)
        assert.deepEqual(actual.cards,[id+size])
    }
    assert.equal(replayed,false)
    assert.equal(fieldsWritten,size)
    assert.equal((await plan()).length,0)
    return {size,files,seed:12571687,writes,fieldsWritten,packetCount,peakPacket,interrupted,elapsedMs:Math.round(elapsed*10)/10}
}
module.exports = {exercise}
if (require.main===module) exercise(process.argv[2],Number(process.argv[3]),Number(process.argv[4]),process.argv[5]==='fault')
    .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})
