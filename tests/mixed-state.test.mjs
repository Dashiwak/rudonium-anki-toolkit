// SPDX-License-Identifier: GPL-3.0-only
// A seeded state machine drives the same preview and apply entry used by the desktop command.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import overlay from '../Build/overlay-source.cjs'
import { loadSync } from './benchmark/load-sync.mjs'
import { useHost } from './benchmark/host.mjs'

for (const seed of [437, 15551]) test('mixed lifecycles, tags and transport recovery, seed ' + seed, async () => {
    const runtime = await loadSync(process.env.RUDONIUM_COMPARE_KIT ? resolve(process.env.RUDONIUM_COMPARE_KIT,'Build') : overlay.directory)
    try {
        let s = seed
        function sample(n) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) % n }
        const studyTag = seed === 437 ? 'TE' : 'Study::words'
        const profile = 'Dictionary', first = 1787000000000, count = 19
        const notes = new Map(), files = [], storage = new Map(), listeners = new Map(), requests = []
        let failAfterWrite = false, done = false, current = 0
        const render = (id, front, back, n) => '## Cards' + n + '- ' + front + ' :: ' + back + n + '<!--ID: ' + id + ' -->' + n
        for (let i=0;i<count;i++) {
            const id = first+i, front = 'Frage ' + i, back = 'Antwort ' + i
            const text = render(id,front,back,i%2 ? '\r\n' : '\n')
            files.push({path:'Study/Card ' + i + '.md',text,stat:{mtime:1,ctime:1,size:Buffer.byteLength(text)}})
            notes.set(id,{noteId:id,modelName:'Basic',deckName:'Knowledge',cards:[id+count],
                fields:{Front:{value:front,order:0},Back:{value:back,order:1}},tags:i%2 ? ['marked'] : ['leech']})
        }
        const mutate = (file,text) => {file.text=text; file.stat.mtime++;file.stat.size=Buffer.byteLength(text);listeners.get('modify')?.(file)}
        const app = {metadataCache:{getCache:()=>null},workspace:{getActiveFile:()=>files[current],getLeavesOfType:()=>[],on(){},onLayoutReady(fn){fn()}},
            vault:{configDir:'.obsidian',getName:()=>profile,getMarkdownFiles:()=>[...files],
                getAbstractFileByPath:path=>files.find(f=>f.path===path),
                on:(key,fn)=>listeners.set(key,fn),read:async f=>f.text,process:async(f,fn)=>mutate(f,fn(f.text)),
                adapter:{exists:async path=>storage.has(path),read:async path=>storage.get(path),write:async(path,text)=>storage.set(path,text)}}}
        const host = {runtime,expressions:{},mixed:true,notices:[],metrics:{parses:0},request:async(action,p)=>{
            if(action==='getActiveProfile') return profile
            if(action==='guiSelectedNotes') return []
            if(action==='notesInfo') return structuredClone(p.notes.map(id=>notes.get(id)??{}).reverse())
            if(action==='areSuspended') return p.cards.map(()=>false)
            assert.ok(['updateNoteFields','addTags','removeTags'].includes(action),'unexpected '+action)
            const id=p.note?.id??p.notes[0], row=notes.get(id)
            if(action==='updateNoteFields') for(const [key,v] of Object.entries(p.note.fields)) row.fields[key].value=v
            if(action==='addTags') row.tags=[...new Set([...row.tags,...p.tags.split(' ')])]
            if(action==='removeTags') row.tags=row.tags.filter(t=>!p.tags.split(' ').includes(t))
            requests.push({id,action,fields:p.note?.fields})
            if(failAfterWrite){ failAfterWrite=false;done=true;throw Error('lost acknowledgement') }
            return null
        }}
        useHost(host)
        const plugin={app,manifest:{id:'rudonium-anki-toolkit'},register(){},registerEvent(){},registerView(){},addCommand(){},
            settings:{BIDIRECTIONAL_SYNC:true,BIDIRECTIONAL_PREVIEW:true,EXPECTED_ANKI_PROFILE:profile,REQUIRE_ANKI_PROFILE:true,SKIP_SYNC_ERRORS:true,
                CUSTOM_REGEXPS:{},Syntax:{},Defaults:{Deck:'Knowledge'}},fields_dict:{Basic:['Front','Back']}}
        async function preview(currentOnly=false) {
            host.dialog=null; await runtime.scanVaultFast(plugin,false,currentOnly)
            assert.ok(host.dialog,host.notices.join('\n'))
            assert.deepEqual(host.dialog.preview.issues,[])
            return host.dialog
        }
        let d=await preview(); await d.apply(new Map())
        const expected=files.map((_,i)=>'Antwort '+i)
        for(let turn=0;turn<15;turn++){
            const ids=new Set()
            while(ids.size<6) ids.add(sample(count))
            const choices=new Map()
            for(const [kind,i] of [...ids].entries()){
                const note=notes.get(first+i), file=files[i], old=expected[i], value='Round '+turn+' value '+i
                if(kind===0 || kind===3 || kind===5) mutate(file,file.text.replace(' :: '+old,' :: '+value))
                if(kind===1 || kind===2 || kind===4 || kind===5) note.fields.Back.value=kind===5 ? value+' Anki' : value
                const desired=kind===5 && turn%2 ? 'anki' : 'obsidian'
                if(kind===5) choices.set((first+i)+':back',desired)
                expected[i]=kind===5 && desired==='anki' ? value+' Anki' : value
                if(kind===2) note.tags=note.tags.includes(studyTag) ? note.tags.filter(t=>t!==studyTag) : [...note.tags,studyTag]
                // Simultaneous changes to two independent fields and tags must converge in one preview.
                if(kind===4 && file.text.includes('anki-bidirectional-tags:')) {
                    mutate(file,file.text.replace(/^.*<!-- anki-bidirectional-tags:[^\n]*\n?/m,''))
                }
            }
            if(turn===4){
                const f=files[3], prev=f.path;f.path='Moved/Card 3.md';listeners.get('rename')?.(f,prev)
            }
            if(turn===7) failAfterWrite=true
            d=await preview()
            assert.equal(d.preview.rows.length,ids.size)
            await d.apply(choices)
            if(turn===7){
                assert.equal(done,true)
                d=await preview()
                if(d.preview.canApply) await d.apply(choices)
            }
            for(let i=0;i<count;i++){
                const n=notes.get(i+first), source=files[i].text, eol=i%2 ? '\r\n' : '\n'
                assert.equal(n.fields.Back.value,expected[i],'remote, step '+turn+', i='+i)
                assert.ok(source.includes(' :: '+expected[i]+eol),'local, step '+turn+', i='+i)
                assert.ok(source.includes('<!--ID: '+(i+first)+' -->'))
                assert.equal(source.includes(studyTag),n.tags.includes(studyTag),'tags, step '+turn+', i='+i)
                assert.ok(n.tags.includes(i%2 ? 'marked' : 'leech'),'Anki study tags')
                assert.ok(!source.includes('marked') && !source.includes('leech'),'Anki study tags stay remote')
            }
            d=await preview();assert.equal(d.preview.canApply,false,'convergence, step '+turn)
        }
        // Removing the local ID cannot direct changes into an unrelated live Anki record.
        current=6; const file=files[current], id=first+current, original=file.text
        mutate(file,original.replace('<!--ID: '+id+' -->',''))
        const before=requests.length,draft=await preview(true)
        assert.equal(draft.preview.scanned,0)
        assert.equal(requests.length,before)
        mutate(file,original)
        const prior=notes.get(id);notes.delete(id)
        const missing=await preview(true)
        assert.deepEqual(missing.preview.rows.map(r=>r.id),[id])
        assert.equal(requests.length,before)
        notes.set(id,prior)
        assert.equal((await preview(true)).preview.canApply,false)
    } finally { runtime.dispose() }
})
