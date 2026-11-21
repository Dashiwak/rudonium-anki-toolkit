// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import patched from './benchmark/patched-manager.cjs'
import { loadSync } from './benchmark/load-sync.mjs'
import { useHost } from './benchmark/host.mjs'

globalThis.require = createRequire(import.meta.url)

const knowledge = String.raw`^- (?=\S)((?:(?!::)[^\r\n])+?)[ \t]+::[ \t]+(?=\S)((?:(?!::)[^\r\n])+?)(?:[ \t]+::[ \t]+(R))?(?:[ \t]+::[ \t]+F=([a-z]{2,3}_[A-Z]{2}))?(?:[ \t]+::[ \t]+B=([a-z]{2,3}_[A-Z]{2}))?[ \t]*\r?$`

for (const eol of ['\n', '\r\n']) {
    test('one-way export ignores retired 0.9.7 metadata even with an existing named-field receipt (' +
        (eol === '\n' ? 'LF' : 'CRLF') + ')', async t => {
        const runtime = await loadSync(overlay.directory)
        t.after(runtime.dispose)
        const names = ['Front','Back','Direction','Question locale','Answer locale','Импортированный','Other','Origin']
        const id = 1700000000412, second = id + 1
        const profile = 'English', disk = new Map()
        const rows = new Map([id, second].map((n, i) => [n, {noteId:n, modelName:'Basic', tags:[], cards:[n+100],
            fields:Object.fromEntries(names.map((name, order) => [name, {order, value: name === 'Other' ? 'Only Anki' :
                name === 'Front' ? 'Q' + i : name === 'Back' ? 'A' + i : ''}]))}]))
        const host = {runtime, plain:true, capturedFields:names, expressions:{Basic:knowledge}, metrics:{parses:0,regexpFiles:0},
            async request(action, params) {
                if (action === 'guiSelectedNotes') return []
                if (action === 'notesInfo') return params.notes.map(n => structuredClone(rows.get(n)))
                if (action === 'updateNoteFields') {
                    for (const [field,value] of Object.entries(params.note.fields)) rows.get(params.note.id).fields[field].value = value
                    return null
                }
                throw Error('Unexpected Anki request ' + action)
            },
        }
        useHost(host)
        const file = {path:'Cards.md'}
        const plugin = {manifest:{id:'test'},app:{vault:{configDir:'.obsidian',getName:()=>'Vault',adapter:{
            exists:async path=>disk.has(path),read:async path=>disk.get(path),write:async(path,value)=>disk.set(path,value),
        }},metadataCache:{getCache:()=>({})}}}
        const never = /(?!)/
        const data = {fields_dict:{Basic:names},custom_regexps:{Basic:knowledge},template:{deckName:'Knowledge',tags:[]},
            folder_decks:{},folder_tags:{},file_link_fields:{Basic:'Origin'},NOTE_REGEXP:never,INLINE_REGEXP:never,EMPTY_REGEXP:never}
        const source = (labels = []) => ['- Q0 :: A0','<!--ID: '+id+' -->',...labels,'',
            '- Q1 :: A1','<!--ID: '+second+' -->',''].join(eol)
        const open = '<!--anki-fields-->', close = '<!--/anki-fields-->'
        const parse = text => runtime.parsePortableMarkdown(plugin.app,data,file,text,[id,second],{trackRanges:true})
        const run = async text => {
            const parsed = await parse(text)
            const history = await runtime.openOneWayHistory(plugin,profile)
            const Manager = patched.managerType({...runtime.portableParser,...runtime.delta})
            const manager = Object.assign(new Manager(), {app:plugin.app,data,oneWayHistory:history,
                ownFiles:[parsed],linkedSnapshots:new Map(rows)})
            await manager.prepareExistingUpdates()
            assert.deepEqual([...manager.retryMessages],[])
            const requests = manager.existingChanges.get(file.path) ?? []
            for (const req of requests) {
                assert.equal(req.action,'updateNoteFields')
                await host.request(req.action,req.params)
            }
            await runtime.delta.verifyExistingNoteFieldWrites(manager.existingChanges, (_path,msg)=>assert.fail(msg), {
                models:new Map([[id,'Basic'],[second,'Basic']]),namedLayouts:manager.namedLayouts,
                capture:receipt=>manager.oneWayReceipts.push(receipt),
            })
            history.apply(manager.oneWayReceipts)
            await history.flush()
            return requests.map(req => req.params.note)
        }
        const old = await runtime.openOneWayHistory(plugin, profile)
        old.apply([{id, modelName: 'Basic', fields: {'Импортированный': 'Было'},
            namedLayout: {eligible: ['Импортированный'], present: ['Импортированный']} }])
        await old.flush()
        rows.get(id).fields['Импортированный'].value = 'Было'
        const labeled = source([open,'Импортированный: Значение только в заметке','- Third :: ignored',close])
        const parsed = await parse(labeled)
        assert.equal(parsed.original_file,labeled)
        assert.equal(parsed.notes_to_edit.length,2)
        assert.equal(parsed.all_notes_to_add.length,0)
        assert.equal(runtime.portableParser.cardAtOffset(parsed,labeled,labeled.indexOf('Third')),undefined)
        assert.equal(parsed.previewCandidates[0].namedLayout,undefined)
        assert.deepEqual(await run(labeled),[])
        assert.deepEqual(await run(source()),[])
        assert.equal(rows.get(id).fields['Импортированный'].value,'Было')
        assert.equal(rows.get(second).fields.Other.value,'Only Anki')
        assert.equal(rows.size,2)
    })
}
