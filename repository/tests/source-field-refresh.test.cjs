// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { stripTypeScriptTypes } = require('node:module')
const { load } = require('./benchmark/migration-modules.cjs')
const { createHash } = require('node:crypto')
const { patchLinkedBulletFile, patchSourceFieldWriters } = require('../Build/install.cjs')

test('refresh disables only lost named fields and shows the type, field, and how to reselect', async () => {
    let click, status, redraws = 0
    class Setting {
        setName() { return this }
        setDesc() { return this }
        addButton(build) {
            build({ setButtonText() { return this }, setClass() { return this }, setDisabled() { return this },
                onClick(handler) { click = handler; return this } })
            return this
        }
    }
    const ui = { querySelector: () => null, createEl: () => ({ setText(value) { status = value } }), contains: () => true }
    const current = { Basic: ['Front', 'Back', 'Source'], Other: ['Front', 'Back'] }
    const plugin = { settings: { CUSTOM_REGEXPS: { Basic:'abc', Other:'' },
        FILE_LINK_FIELDS: { Basic:'Renamed file', Other:'Back' }, CONTEXT_FIELDS: { Basic:'Source', Other:'Renamed context' } },
        note_types: ['Basic','Other'], fields_dict: { Basic:['Renamed file','Source'], Other:['Renamed context','Back'] } }
    const writes = []
    plugin.saveData = async data => { writes.push(JSON.parse(JSON.stringify(data))) }
    const { 'note-type-refresh': refresh } = await load(['note-type-refresh','card-format-presets'], {
        Setting, uiFor: () => en => en, withFastScanReadLock: (_plugin, fn) => fn(),
        savePluginDataInOrder: (_plugin, fn) => fn(), readActiveAnkiProfile: () => 'Profile',
        checkPinnedAnkiProfile: () => 'Profile', expectedAnkiProfile: () => 'Profile',
        auditRead: (action, params) => {
            if (action === 'modelNames') return Object.keys(current)
            assert.equal(action, 'multi')
            return params.actions.map(item => ({ error: null, result: current[item.params.modelName] }))
        },
    })
    refresh.installNoteTypeRefresh(ui, ui, plugin, () => redraws++)
    await click()
    assert.equal(redraws, 1)
    assert.match(status, /Basic · file link · Renamed file/)
    assert.match(status, /Other · context · Renamed context/)
    assert.match(status, /Choose replacements/)
    assert.deepEqual(writes[0].settings.FILE_LINK_FIELDS, { Basic:'', Other:'Back' })
    assert.deepEqual(writes[0].settings.CONTEXT_FIELDS, { Basic:'Source', Other:'' })
    assert.deepEqual(JSON.parse(JSON.stringify(plugin.settings)), writes[0].settings)
    await click()
    assert.equal(writes.length, 1)
    assert.match(status, /No changes/)
    plugin.settings.FILE_LINK_FIELDS.Basic = 'Source'
    assert.equal((await refresh.refreshNoteTypes(plugin)).disabled.length, 0)
    assert.equal(plugin.settings.FILE_LINK_FIELDS.Basic, 'Source')
})

test('both stock note parsers skip empty or missing source destinations and honor a valid independent mapping', () => {
    const method = `write(data, url, context) {
        const template = {fields: { Front: 'Q', Back: 'A', Source: '' }}
        if (url) {
            const name = data.file_link_fields[this.note_type] || 'Front'
            template.fields[name] += url
        }
        if (context) {
            const name = data.context_fields[this.note_type]
            template.fields[name] += context
        }
        return template.fields
    }`
    const source = `class Block { note_type = 'Basic'; ${method} } class Regex { note_type = 'Basic'; ${method} }`
    const classes = Function(stripTypeScriptTypes(patchSourceFieldWriters(source)) + '\nreturn [Block, Regex]')()
    for (const Parser of classes) {
        const parser = new Parser()
        const fields = (link, context) => parser.write({ file_link_fields: {Basic:link}, context_fields:{Basic:context} }, 'url','ctx')
        assert.deepEqual(fields('', 'Source'), {Front:'Q', Back:'A', Source:'ctx'})
        assert.deepEqual(fields('Back', 'Gone'), {Front:'Q', Back:'Aurl', Source:''})
        assert.deepEqual(fields('Gone', ''), {Front:'Q', Back:'A', Source:''})
        assert.deepEqual(fields('Front', 'Front'), {Front:'Qurlctx', Back:'A', Source:''})
    }
})

test('one-way linked parser and export planner refresh only the configured source fields after a move', async () => {
    const api = {
        readFilteredAnkiDecks: async () => new Map(),
        Md5: { hashStr: s => createHash('md5').update(s).digest('hex') },
        update: (id, fields) => ({ action: 'updateNoteFields', params: { note: { id, fields } } }),
    }
    const modules = await load(['anki-delta','anki-field-value','anki-card-impact','oneway-history','anki',
        'linked-bullets','card-source-link-fields'], api, { anki: "import { update } from './host'; export const updateNoteFields = update;" })
    // Exercise the linked-card scan method injected into the upstream parser.
    const patched = patchLinkedBulletFile('export class AllFile extends AbstractFile { scan(){ this.scanInlineNotes() } }')
        .replace(/^import .*\n/gm, '').replace('export class AllFile', 'class AllFile')
    class AbstractFile { scanInlineNotes() {} }
    class RegexNote {
        constructor(match, model, fieldMap) { this.match=match; this.model=model; this.names=fieldMap[model] }
        parse(deckName, url, frozen, data, context) {
            const fields=Object.fromEntries(this.names.map((name,index)=>[name,this.match[index+1]]))
            if (url) fields[data.file_link_fields.Basic]+='<br><a href="'+url+'" class="obsidian-link">Obsidian</a>'
            if (context) fields[data.context_fields.Basic]+=context
            return { identifier:Number(this.match.at(-1)), note:{ modelName:this.model, fields, deckName, tags:[] } }
        }
    }
    const AllFile = new Function('AbstractFile','RegexNote','linkedBulletSourceFields',
        stripTypeScriptTypes(patched)+';return AllFile')(AbstractFile,RegexNote,modules['linked-bullets'].linkedBulletSourceFields)
    const id=10000001, model={name:'Basic',fieldNames:new Set(['Front','Back','File','Context'])}
    const parse = (path,heading) => {
        const source='- Q :: A'
        const url='obsidian://open?vault=QA&file='+encodeURIComponent(path)
        const file=Object.assign(new AllFile(), {file:source, url, target_deck:'Knowledge', notes_to_edit:[], ignore_spans:[],
            linkedBullets:[{id, model, front:'Q',back:'A',start:0,end:source.length,metadata:{}}],
            data:{file_link_fields:{Basic:'File'},context_fields:{Basic:'Context'},add_context:true},
            getContextAtIndex:()=>path+' > '+heading })
        file.scan()
        const fields=modules['card-source-link-fields'].linkFieldsToCard(file.notes_to_edit[0].note.fields,url,'QA',path,id,'File')
        return { id, path, fields, tags:[], deck:'Knowledge', modelName:'Basic', authoredFields:Object.keys(fields) }
    }
    const old=parse('Old.md','Former'), next=parse('New.md','Current')
    const prior={ fields:Object.fromEntries(Object.entries(old.fields).map(([name,text])=>[name,modules['oneway-history'].oneWayFieldDigest(text)])) }
    const remote={ modelName:'Basic', tags:[], cards:[321], fields:Object.fromEntries(
        Object.entries(old.fields).map(([name,value])=>[name,{value}])) }
    const changes=await modules['anki-delta'].prepareExistingNoteChanges([next],(_,message)=>assert.fail(message),
        new Map([[id,remote]]), undefined,{ history:{get:()=>prior}, allowDeckMoves:false })
    const [request]=changes.get('New.md')
    assert.equal(request.action,'updateNoteFields')
    assert.equal(request.params.note.id,id)
    assert.deepEqual(Object.keys(request.params.note.fields).sort(),['Context','File'])
    assert.equal(request.params.note.fields.Context,'New.md > Current')
    assert.match(request.params.note.fields.File,/file=New.md&amp;nid=10000001/)
})
