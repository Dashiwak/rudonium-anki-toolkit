// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import { loadSync } from './benchmark/load-sync.mjs'
import { useHost } from './benchmark/host.mjs'
import pageFile from './benchmark/page-file.cjs'
import migrationModules from './benchmark/migration-modules.cjs'
import managerHarness from './benchmark/patched-manager.cjs'
import { createHash } from 'node:crypto'

const id = 1750000000001, sibling = id + 1
const prefix = '## Cards\r\n'
const original = '- Old :: Answer\r\n<!--ID: ' + id + ' -->\r\n'
const surrounding = '- Neighbor :: Still here\r\n<!--ID: ' + sibling + ' -->\r\n\r\nUnpublished draft :: pending\r\n'
const initial = prefix + original + surrounding
const command = 'Retire.[x]?'
const commanded = initial.replace('<!--ID: ' + id, command + '\r\n<!--ID: ' + id)
function note(noteId, front, back) {
    return { noteId, modelName: 'Basic', deckName: 'Knowledge', cards: [noteId + 100],
        tags: [], fields: { Front: { order: 0, value: front }, Back: { order: 1, value: back } } }
}
function fixture(runtime, mode) {
    const notes = new Map([[id, note(id, 'Old', 'Answer')], [sibling, note(sibling, 'Neighbor', 'Still here')]])
    const calls = [], checkpoints = new Map(), backups = []
    const file = { path: 'Cards/Dictionary.md', text: initial,
        stat: { ctime: 1, mtime: 1, size: Buffer.byteLength(initial) } }
    const b = {path:'Cards/Other.md', text: prefix, stat: {ctime:1,mtime:1,size:Buffer.byteLength(prefix)}}
    const files = [file,b]
    let active = file
    let changed
    const editFile = (file, text) => {
        file.text = text
        file.stat.mtime++
        file.stat.size = Buffer.byteLength(text)
        changed?.(file)
    }
    const host = { runtime, metrics: { parses: 0 }, mixed: true, expressions: {}, notices: [],
        profile: 'QA', failGlobal: false, notes, calls, backups,
        backup: async () => { backups.push(file.text); return 'backup.zip' },
        request: async (action, params) => {
            calls.push({ action, params })
            switch (action) {
            case 'getActiveProfile': return host.profile
            case 'guiSelectedNotes': return []
            case 'findNotes':
                if (host.failGlobal) throw Error('Simulated network failure')
                assert.match(params.query, /^nid:[\d,]+$/)
                return params.query.slice(4).split(',').map(Number).filter(key => notes.has(key))
            case 'notesInfo': return structuredClone(params.notes.map(key => notes.get(key) ?? {}))
            case 'areSuspended': return params.cards.map(key => [...notes.values()].some(n => n.cards.includes(key)) ? false : null)
            case 'updateNoteFields':
                for(const [name,value] of Object.entries(params.note.fields)) notes.get(params.note.id).fields[name].value=value
                return null
            case 'deleteNotes':
                for (const key of params.notes) assert.ok(notes.delete(key), 'must not delete an already absent note')
                return null
            default: throw Error('Unexpected Anki action ' + action)
            }
        } }
    const app = { vault: { configDir: '.obsidian', getName: () => 'QA', getMarkdownFiles: () => files,
        getAbstractFileByPath: key => files.find(f => f.path===key) ?? null, read: async f => f.text,
        process: async (f, change) => { editFile(f,change(f.text)) },
        on(name, callback) { if (name === 'modify') changed = callback },
        adapter: { exists: async path => checkpoints.has(path), read: async path => checkpoints.get(path),
            write: async (path, value) => { checkpoints.set(path, value) } } }, metadataCache: { getCache: () => null },
        workspace: { getActiveFile: () => active, getLeavesOfType: () => [], on() {}, onLayoutReady(cb) { cb() } } }
    const plugin = { app, manifest: { id: 'rudonium' }, addCommand() {}, registerEvent() {}, registerView() {}, register() {},
        settings: { AFTER_DELETE_MODE: mode, EXPECTED_ANKI_PROFILE: 'QA', REQUIRE_ANKI_PROFILE: true,
            BIDIRECTIONAL_SYNC: true, SKIP_SYNC_ERRORS: true, CUSTOM_REGEXPS: {}, Syntax: { 'Delete Note Line': command },
            Defaults: { Deck: 'Knowledge' } }, fields_dict: { Basic: ['Front','Back'] } }
    const preview = async () => {
        useHost(host)
        host.dialog = null
        await runtime.previewBidirectionalSync(plugin, { currentOnly: true })
        assert.ok(host.dialog, host.notices.join('\n'))
        return host.dialog
    }
    const apply = async () => {
        const dialog = await preview()
        assert.ok(dialog.preview.canApply, JSON.stringify(dialog.preview))
        return dialog.apply(new Map())
    }
    return { host, file, b, plugin, preview, apply, editFile, focus(f) { active=f }, checkpoints }
}

test('retired page properties never dispatch edits, deletion, suspension or creation in either sync mode', async t => {
    const runtime = await loadSync(overlay.directory, pageFile)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'remove')
    const {host,plugin,file} = h
    host.parseYaml = raw => Object.fromEntries(raw.trim().split(/\r?\n/).map(line => line.split(/:\s*/, 2)))
    host.expressions = plugin.settings.CUSTOM_REGEXPS = { Basic:'@page' }
    const data = { template:{ deckName:'Knowledge', tags:[] }, fields_dict:plugin.fields_dict, custom_regexps:host.expressions,
        folder_tags:{}, folder_decks:{}, NOTE_REGEXP:/(?!)/, INLINE_REGEXP:/(?!)/, EMPTY_REGEXP:/(?!)/, vault_name:'QA' }
    host.sourceSettings = data
    const retired = '---\nrudonium-id: '+id+'\n---\n# Old #anki-page\n'
    const stop = /rudonium-id.*anki-page-ID/u
    for (const control of ['', 'SUSPEND_2\n', command+'\n']) {
        const raw = retired+control+'Answer'
        h.editFile(file,raw)
        await assert.rejects(runtime.parsePortableMarkdown(plugin.app,data,file,raw,[],{trackRanges:true}),stop)
        const dialog = await h.preview()
        assert.equal(dialog.preview.canApply,false)
        assert.match(JSON.stringify(dialog.preview),stop)
        assert.equal(file.text,raw)
        assert.equal(host.calls.filter(c=>['addNote','addNotes','updateNoteFields','deleteNotes','suspend','unsuspend'].includes(c.action)).length,0)
    }
    const clean = answer => '---\nanki-page-ID: '+sibling+'\n---\n# Neighbor #anki-page\n'+answer
    h.editFile(h.b,clean('Still here'))
    h.focus(h.b)
    await h.apply()
    h.editFile(h.b,clean('Edited neighbor'))
    // The checked file may be held for review without cancelling a different ID in the same vault.
    await runtime.previewBidirectionalSync(plugin, { force:true })
    const mixed = host.dialog
    assert.match(mixed.preview.issues.join(' '),stop)
    assert.equal(mixed.preview.canApply,true)
    await mixed.apply(new Map())
    assert.equal(host.notes.get(sibling).fields.Back.value,'Edited neighbor')
    assert.equal(host.notes.get(id).fields.Back.value,'Answer')
    assert.deepEqual(host.calls.filter(c=>c.action==='updateNoteFields').map(c=>c.params.note.id),[sibling])
    assert.equal(file.text,retired+command+'\nAnswer')

    h.editFile(h.b,clean('One-way neighbor'))
    const api = { Md5:{ hashStr:x => createHash('md5').update(x).digest('hex') },
        update:(id,fields) => ({action:'updateNoteFields',params:{note:{id,fields}}}),
        readFilteredAnkiDecks:async () => new Map() }
    const modules = await migrationModules.load(['anki-delta','anki-field-value','anki-card-impact','oneway-history','anki',
        'anki-id-marker','card-export-diagnostics','markdown-pipeline','duplicate-markers','export-recovery','portable-parser',
        'suspend-marker','archived-card','anki-transport','constants'],api,
        {constants:'export {}',anki:"import { update } from './host'; export const updateNoteFields = update;"})
    const Manager = managerHarness.managerType({...api, ...modules['card-export-diagnostics'],...modules['suspend-marker'],
        collectNoteIds:modules['anki-id-marker'].ankiIdNumberTokens,readRecoveryMarker:modules['export-recovery'].readRecoveryMarker,
        readLinkedBulletModels:async () => new Map(),findLinkedBullets:()=>[],frontmatterTags:()=>[],explicitDeletes:()=>undefined,
        findMarkdownSyntaxSpans:()=>({code:[],math:[]}),diagnosticPatterns:{},frontmatterBounds:modules['markdown-pipeline'].frontmatterBounds,
        applyAuthoredTags:()=>{},mediaNames:links=>new Set(links),parsePortableMarkdown:async (...args) => {
            const result = await runtime.parsePortableMarkdown(...args)
            return Object.assign(result,{markdownWarningLines:[],formatter:{detectedMedia:new Set()}})
        }})
    const manager = Object.assign(new Manager(), {app:plugin.app, data, files:[file,h.b], file_hashes:{}})
    const resolved = []
    await manager.initialiseFiles(async ids => {resolved.push(...ids); return [...ids]})
    assert.deepEqual(resolved,[sibling])
    assert.equal(manager.scanErrors.length,1,manager.scanErrors.join('\n'))
    assert.match(manager.scanErrors[0],stop)
    assert.deepEqual(manager.files,[h.b])
    const [scanned] = manager.ownFiles
    assert.equal(scanned.all_notes_to_add.length+scanned.notes_to_delete.length,0)
    const sources = scanned.notes_to_edit.map(({identifier,note}) => ({id:identifier,path:h.b.path,
        modelName:note.modelName,deck:note.deckName,tags:note.tags,fields:note.fields,
        authoredFields:modules['portable-parser'].authoredFieldNames(scanned,scanned.previewCandidates[0],note.fields)}))
    const prior = {fields:Object.fromEntries(Object.entries(host.notes.get(sibling).fields).map(([name,field]) =>
        [name,modules['oneway-history'].oneWayFieldDigest(field.value)]))}
    const requests = await modules['anki-delta'].prepareExistingNoteChanges(sources,(_,m)=>assert.fail(m),host.notes,
        undefined,{allowDeckMoves:false,history:{get:key=>key===sibling ? prior : undefined}})
    const outbound = requests.get(h.b.path)
    assert.equal(outbound.length,1)
    assert.equal(outbound[0].params.note.id,sibling)
    await host.request(outbound[0].action,outbound[0].params)
    assert.equal(host.notes.get(sibling).fields.Back.value,'One-way neighbor')
    assert.equal(host.notes.get(id).fields.Back.value,'Answer')
    h.focus(file)
    h.editFile(file,(retired+'Answer').replace('rudonium-id:', 'anki-page-ID:'))
    const resumed = await runtime.parsePortableMarkdown(plugin.app,data,file,file.text,[id],{trackRanges:true})
    assert.equal(resumed.all_notes_to_add.length,0)
    assert.equal(resumed.notes_to_edit[0].identifier,id)
    await h.apply()
    assert.equal(host.notes.get(id).cards[0],id+100)
})

test('whole-page export and two-way sync refresh the origin with the same Anki ID after moving and changing the H1', async t => {
    const runtime = await loadSync(overlay.directory, pageFile)
    t.after(runtime.dispose)
    const h = fixture(runtime,'keep')
    const {host,plugin,file} = h
    const note = host.notes.get(id), fileField = 'Исходник', contextField = 'Раздел'
    host.expressions = { Basic: '@page' }
    plugin.settings.CUSTOM_REGEXPS = host.expressions
    plugin.fields_dict.Basic.push(fileField,contextField,'Remote-only')
    for (const [name,value] of [[fileField,''],[contextField,''],['Remote-only','preserve']])
        note.fields[name] = { order: Object.keys(note.fields).length, value }
    const data = { template: { deckName:'Knowledge', tags:[] }, fields_dict: plugin.fields_dict,
        folder_tags:{}, folder_decks:{}, custom_regexps:host.expressions, NOTE_REGEXP:/(?!)/,
        INLINE_REGEXP:/(?!)/, EMPTY_REGEXP:/(?!)/, vault_name:'QA', add_context:true, add_file_link:true,
        file_link_fields:{ Basic:fileField }, context_fields:{ Basic:contextField } }
    host.sourceSettings = data
    const source = '# Old #anki-page\r\n<!--ID: ' + id + '-->\r\nAnswer\r\n<!--rudonium-answer-end-->\r\n## Private'
    h.editFile(file,source)
    const parse = async (f, settings) => {
        const result = await runtime.parsePortableMarkdown(plugin.app,settings,f,f.text,[id],{trackRanges:true})
        assert.equal(result.all_notes_to_add.length,0)
        assert.equal(result.notes_to_edit.length,1)
        assert.equal(result.notes_to_edit[0].identifier,id)
        return result
    }
    const api = { readFilteredAnkiDecks:async () => new Map(),
        Md5:{ hashStr:x => createHash('md5').update(x).digest('hex') },
        update:(id,fields) => ({action:'updateNoteFields',params:{note:{id,fields}}}) }
    const vm = await migrationModules.load(['anki-delta','anki-field-value','anki-card-impact','oneway-history','anki','portable-parser','constants'],
        api,{constants:"export {}",anki:"import { update } from './host'; export const updateNoteFields = update;"})
    for (const enabledLink of [false,true]) for (const enabledContext of [false,true]) {
        const result = await parse(file,{...data,add_file_link:enabledLink,add_context:enabledContext})
        const fields = result.notes_to_edit[0].note.fields
        assert.equal(!!fields[fileField],enabledLink)
        assert.equal(!!fields[contextField],enabledContext)
        assert.equal(fields.Front,'Old')
        assert.equal(fields.Back,'Answer')
        if (enabledLink) assert.ok(fields[fileField].includes('file=Cards%2FDictionary.md&amp;nid='+id))
        if (enabledContext) assert.equal(fields[contextField],'Cards/Dictionary.md > Old')
    }
    const originalResult = await parse(file,data)
    const originalFields = originalResult.notes_to_edit[0].note.fields
    for (const markdown of [
        "---\nanki-page-ID: '" + id + "'\n---\n# Old\nAnswer\n#anki-page",
        '# Old #anki-page\nAnswer\n<!--ID: ' + id + ' @page-->',
    ]) {
        const result = await parse({...file,text:markdown},data)
        assert.deepEqual(result.notes_to_edit[0].note.fields,originalFields)
    }
    const markup = { ...file,path:'A&B/Map.md',text:source.replace('Old','A < B & C') }
    const escaped = (await parse(markup,data)).notes_to_edit[0].note.fields
    assert.equal(escaped[contextField],'A&amp;B/Map.md > A &lt; B &amp; C')
    const prior = { fields:Object.fromEntries(Object.entries(originalFields).map(([name,value])=>
        [name,vm['oneway-history'].oneWayFieldDigest(value)])) }
    await h.apply()
    assert.equal(note.fields[fileField].value,originalFields[fileField])
    assert.equal(note.fields[contextField].value,originalFields[contextField])
    const syncedSource = file.text
    assert.match(syncedSource, /Remote-only: preserve\r\n<!--rudonium-answer-end-->/)
    h.editFile(file,'ordinary text')
    h.editFile(h.b,syncedSource)
    h.focus(h.b)
    const moved = await parse(h.b,data), fields = moved.notes_to_edit[0].note.fields
    const authoredFields = vm['portable-parser'].authoredFieldNames(moved,moved.previewCandidates[0],fields)
    const one = await vm['anki-delta'].prepareExistingNoteChanges([{id,path:h.b.path,modelName:'Basic',
        fields,authoredFields,tags:[],deck:'Knowledge'}],(_,m)=>assert.fail(m),new Map([[id,note]]),
        undefined,{history:{get:()=>prior},allowDeckMoves:false})
    const change = one.get(h.b.path)
    assert.deepEqual(Object.keys(change[0].params.note.fields).sort(),[fileField,contextField].sort())
    assert.equal(change[0].params.note.id,id)
    const calls = host.calls.length
    await h.apply()
    const writes = host.calls.slice(calls).filter(c=>c.action==='updateNoteFields')
    assert.equal(writes.length,1)
    assert.deepEqual(Object.keys(writes[0].params.note.fields).sort(),[fileField,contextField].sort())
    assert.equal(note.fields[contextField].value,h.b.path+' > Old')
    assert.ok(note.fields[fileField].value.includes('file=Cards%2FOther.md&amp;nid='+id))
    h.editFile(h.b,h.b.text.replace('Old','New heading'))
    await h.apply()
    assert.equal(note.fields.Front.value,'New heading')
    assert.equal(note.fields[contextField].value,h.b.path+' > New heading')
    assert.deepEqual(note.cards,[id+100])
    assert.equal(note.fields['Remote-only'].value,'preserve')
    assert.equal((await h.preview()).preview.canApply,false)
})



for (const [fileField,contextField] of [['Front','Front'],['Back','Front'],['File','Context']]) {
    test('moving note and changing heading refresh configured fields with same ID: ' + fileField + '/' + contextField, async t => {
        const runtime = await loadSync(overlay.directory)
        t.after(runtime.dispose)
        const h = fixture(runtime, 'keep')
        const {host,plugin} = h
        for (const r of host.notes.values()) {
            r.fields.File = {order: 2, value: ''}
            r.fields.Context = {order: 3, value: ''}
        }
        plugin.fields_dict.Basic.push('File','Context')
        host.sourceSettings = { add_context: true, add_file_link: true, vault_name: 'QA',
            file_link_fields: { Basic:fileField }, context_fields: { Basic:contextField } }
        host.decorateFields = (note,bullet,path,source) => {
            const url='obsidian://open?vault=QA&file='+encodeURIComponent(path)
            note.fields[fileField]=(note.fields[fileField]??'')+'<br><a href="'+url+'" class="obsidian-link">Obsidian</a>'
            note.fields[contextField]=(note.fields[contextField]??'')+path+' > '+source.split('\n')[0].trim().slice(3)
        }
        await h.apply()
        assert.match(host.notes.get(id).fields[fileField].value,/Dictionary/)
        const calls=host.calls.length
        h.editFile(h.file,prefix+surrounding)
        h.editFile(h.b,'## New heading\r\n'+prefix+original)
        h.focus(h.b)
        await h.apply()
        const card=host.notes.get(id)
        assert.match(card.fields[contextField].value,/Cards\/Other.md > New heading$/)
        assert.match(card.fields[fileField].value,/file=Cards%2FOther.md/)
        assert.equal(host.calls.slice(calls).filter(c=>c.action==='updateNoteFields').length,1)
        assert.deepEqual(card.cards,[id+100])
        h.editFile(h.b,h.b.text.replace('New heading','Heading two'))
        // An Anki edit made at the same time is retained, including if the backlink sits on Back.
        card.fields.Back.value=card.fields.Back.value.replace('Answer','Edited')
        await h.apply()
        assert.match(h.b.text,/Old :: Edited/)
        assert.match(card.fields[contextField].value,/Heading two$/)
        assert.equal((await h.preview()).preview.canApply,false)
    })
}

test('0.8.6 receipt and legacy separate fields, move before first 0.8.7 sync', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep'), { host, plugin } = h
    await h.apply() // receipt format of 0.8.6: only source hash and common Q/A
    const remote = host.notes.get(id)
    const source = h.file.path, cardIds = [...remote.cards]
    const url = path => 'obsidian://open?vault=QA&file=' + encodeURIComponent(path)
    const anchor = path => '<br><a href="' + url(path) + '" class="obsidian-link">Obsidian</a>'
    remote.fields.File = { order: 2, value: anchor(source) }
    remote.fields.Context = { order: 3, value: source + ' > Old heading' }
    plugin.fields_dict.Basic.push('File', 'Context')
    host.sourceSettings = { add_context:true, add_file_link:true, vault_name:'QA',
        file_link_fields:{ Basic:'File' }, context_fields:{ Basic:'Context' } }
    host.decorateFields = (note,bullet,path) => {
        note.fields.File=anchor(path)
        note.fields.Context=path + ' > New heading'
    }
    h.editFile(h.file,prefix+surrounding)
    h.editFile(h.b,'## New heading\r\n'+prefix+original)
    h.focus(h.b)
    const old = remote.fields.Context.value
    remote.fields.Context.value='User notes.md > Preserve manually entered text'
    const blocked = await h.preview()
    assert.equal(blocked.preview.canApply,false)
    assert.match(blocked.preview.rows[0].issues.join(' '), /generated source field/)
    assert.match(remote.fields.Context.value, /Preserve manually/)
    remote.fields.Context.value=old
    await h.apply()
    assert.match(remote.fields.File.value,/file=Cards%2FOther.md/)
    assert.equal(remote.fields.Context.value,h.b.path + ' > New heading')
    assert.deepEqual(remote.cards,cardIds)
    remote.fields.Context.value='Anki user changed context'
    h.editFile(h.b,h.b.text.replace('New heading','Other heading'))
    assert.equal((await h.preview()).preview.canApply,false)
    assert.equal(remote.fields.Context.value,'Anki user changed context')
})

test('bidirectional current-file command keeps the initial file across a tab switch and only updates its two changed notes', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep')
    h.plugin.settings.BIDIRECTIONAL_PREVIEW = true
    const commands = new Map()
    h.plugin.addCommand = cmd => commands.set(cmd.id, cmd)
    await h.apply()
    h.editFile(h.file, initial.replace('Answer', 'Changed').replace('Still here', 'Changed too'))
    const otherId = sibling + 1
    h.host.notes.set(otherId, note(otherId, 'Outside', 'Existing'))
    h.editFile(h.b, prefix + '- Outside :: Different\r\n<!--ID: ' + otherId + ' -->\r\n')
    const command = commands.get('anki-scan-current-note')
    h.host.dialog = null
    const run = command.callback()
    h.focus(h.b)
    await run
    const dialog = h.host.dialog
    assert.equal(dialog.preview.scopeLabel, h.file.path)
    assert.deepEqual(dialog.preview.rows.map(r => r.id).sort(), [id,sibling])
    await dialog.apply(new Map())
    assert.equal(h.host.notes.get(id).fields.Back.value, 'Changed')
    assert.equal(h.host.notes.get(sibling).fields.Back.value, 'Changed too')
    assert.equal(h.host.notes.get(otherId).fields.Back.value, 'Existing')
    assert.ok(h.b.text.includes('Different'))
})

test('pure inbound checks the live file, values and profile on both sides of its Markdown write', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    for (const fault of ['none','remote-before','backlink-after','profile-after']) {
        const h = fixture(runtime,'keep')
        await h.apply()
        const remote = h.host.notes.get(id)
        remote.fields.Back.value = 'Remote answer'
        const dialog = await h.preview()
        const before = h.file.text
        const { vault } = h.plugin.app
        const read = vault.read, process = vault.process
        h.host.calls.length = 0
        let writes = 0, lastAnkiRead, preWriteCalls
        vault.read = async file => {
            if (!writes && fault === 'remote-before' && file === h.file) remote.fields.Back.value = 'Concurrent edit'
            return read(file)
        }
        vault.process = async (file, change) => {
            writes++
            // Exactly one observation for the initial global validation and one for
            // the per-file read. A fresh profile confirmation directly precedes writing.
            preWriteCalls = h.host.calls.slice()
            lastAnkiRead = preWriteCalls.length
            await process(file,change)
            if(fault==='profile-after') h.host.profile='Other profile'
            if(fault==='backlink-after') {
                remote.fields.Back.value += '<br><a href="obsidian://anki-card?vault=QA&amp;file=Else.md&amp;nid='+id+'" class="obsidian-link">Obsidian</a>'
            }
        }
        const apply = dialog.apply(new Map())
        let result
        if (fault === 'profile-after') await assert.rejects(apply,error=>error.name==='AnkiProfileError' && error.reason==='mismatch')
        else result = await apply
        if(fault==='remote-before') {
            assert.equal(writes,0)
            assert.equal(h.file.text,before)
        } else {
            assert.equal(writes,1)
            assert.equal(preWriteCalls.filter(c=>c.action==='notesInfo').length,2)
            assert.equal(preWriteCalls.at(-1).action,'getActiveProfile')
            assert.equal(h.file.text,before.replace('Old :: Answer','Old :: Remote answer'))
            assert.equal(h.host.calls.slice(lastAnkiRead).filter(c=>c.action==='notesInfo').length,1)
            assert.ok(h.host.calls.slice(lastAnkiRead).some(c=>c.action==='getActiveProfile'))
        }
        if (fault !== 'profile-after') assert.match(result,fault==='none'? /Confirmed 1 of 1/ : /Confirmed 0 of 1/)
        assert.equal(h.host.calls.some(c=>c.action==='updateNoteFields'),false)
    }
})
