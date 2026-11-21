// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import pageFile from './benchmark/page-file.cjs'
import patched from './benchmark/patched-manager.cjs'
import { loadSync } from './benchmark/load-sync.mjs'
import { useHost } from './benchmark/host.mjs'
import migrationModules from './benchmark/migration-modules.cjs'

test('reverse edits preserve the only page tag when filling or clearing a labeled field', async () => {
    const modules = await migrationModules.load(['page-card', 'bidirectional-markdown', 'bidirectional-blocks',
        'anki-id-marker', 'duplicate-markers', 'card-format-presets', 'export-recovery'], {})
    const page = modules['page-card'], markdown = modules['bidirectional-markdown']
    const head = '# Question\r\nID: 1700000000403\r\nAnswer\r\n<!--anki-fields-->\r\nExample: '
    const read = text => page.pageBlock(page.readPageCard(text, { Basic: '@page' }), ['Front','Back','Example'])
    const replace = (text, value) => markdown.applyMarkdownPatches(text,
        markdown.planExplicitBlockPatches(text, read(text), { Example: value }))
    const empty = head + '#anki-page'
    const filled = replace(empty, 'New description')
    assert.equal(read(filled).extra.Example, 'New description')
    assert.equal(read(replace(filled, '')).extra.Example, '')
    const embedded = head + 'One #anki-page two'
    const cleared = replace(embedded, '')
    assert.equal(read(cleared).extra.Example, '')
    assert.equal(read(replace(cleared, 'Another answer')).extra.Example, 'Another answer')
    assert.throws(() => replace(embedded, 'Original line\nID: 1700000000499'))
    const stale = embedded.replace('One', 'Two')
    assert.throws(() => markdown.planExplicitBlockPatches(stale, read(embedded), { Example: 'Replacement' }))
})

// Stand-in for the upstream START/END renderer. The plugin's own scanner, field
// boundaries, preview, merger, writer, ID checks and persisted journal stay live.
function explicitFile() {
    return String.raw`export class AllFile {
        all_notes_to_add = []; notes_to_edit = []; notes_to_delete = []; global_tags = ''
        constructor(text, path, _url, data) { this.original_file = this.file = text; this.path = path; this.data = data }
        scanFile() {
            for (const match of this.file.matchAll(/^START\r?\n(\w+)\r?\n([\s\S]*?)\r?\n<!--ID: (\d+) -->\r?\nEND$/gm)) {
                const [,modelName,rows,rawId] = match
                const fields = Object.fromEntries(this.data.fields_dict[modelName].map(name => [name, '']))
                let last
                for (const row of rows.split(/\r?\n/)) {
                    const colon = row.indexOf(':')
                    if (colon > 0 && Object.hasOwn(fields, row.slice(0,colon))) {
                        last = row.slice(0,colon)
                        fields[last] = row.slice(colon + 1).trimStart()
                    } else if (last) fields[last] += '<br>' + row
                }
                const identifier = Number(rawId), note = {modelName, deckName:'Knowledge', tags:[], fields}
                const start = match.index, end = start + match[0].length
                this.notes_to_edit.push({identifier, note})
                this.previewCandidates?.push({identifier, note, start, end, explicitNoteBlock:true})
                this.auditNoteRanges?.push([start, end])
            }
        }
    }`
}

async function pageHost(t, format = 'page') {
    const block = format !== 'page'
    const primary = format === 'translated-block' ? ['Вопрос','Ответ'] : block ? ['Front','Back'] : ['Question','Answer']
    const runtime = await loadSync(overlay.directory, block ? explicitFile : pageFile)
    t.after(runtime.dispose)
    const id = 1700000000914, profile = 'Desktop', vaultName = 'Vault'
    const tail = block ? '\r\nA private paragraph after END.\r\n' : '<!--rudonium-answer-end-->\r\nPrivate notes: do not export\r\n'
    const body = block ? ['START','Study',primary[0] + ': Q one',primary[1] + ': Answer one', 'Example: Original example', 'Detail: First','Second','<!--ID: ' + id + ' -->','END'].join('\r\n') : ['---', "anki-page-ID: '" + id + "'", '---', '# Q one', 'Answer one',
        '<!--anki-fields-->', 'Example: Original #anki-page example', 'Detail: First', 'Second', ''].join('\r\n')
    const file = { path: 'Cards/One.md', text: body + tail, stat: { mtime: 1, ctime: 1, size: 0 } }
    let onModify, failLocalWrite = false
    const checkpoint = new Map(), writes = []
    const fields = Object.fromEntries([...primary, 'Example', 'Detail', 'File', 'Context', 'Импортированный']
        .map((name, order) => [name, { value: '', order }]))
    const settings = { vault_name: vaultName, add_file_link: !block, add_context: !block,
        file_link_fields: { Study: 'File' }, context_fields: { Study: 'Context' } }
    const host = { runtime, expressions: block ? {} : { Study: '@page' }, sourceSettings: settings, metrics: { parses: 0 },
        notices: [], templateReads: 0, parseYaml: () => ({ 'anki-page-ID': String(id) }),
        async request(action, params) {
            if (action === 'getActiveProfile') return profile
            if (action === 'guiSelectedNotes') return []
            if (action === 'areSuspended') return [false]
            if (action === 'multi' && params.actions.every(item => item.action === 'modelTemplates' || item.action === 'modelStyling')) {
                host.templateReads++
                return params.actions.map(item => ({ error: null, result: item.action === 'modelTemplates'
                    ? { Forward: { Front: host.questionTemplate ?? '{{' + primary[0] + '}}', Back: '{{' + primary[1] + '}}' + (host.templateExtra ?? '') } } : { css: '' } }))
            }
            if (action === 'notesInfo') return [{ noteId: id, modelName: 'Study', tags: [], cards: [id + 1], fields: structuredClone(fields) }]
            if (action === 'updateNoteFields') {
                assert.equal(params.note.id,id)
                writes.push(params.note.fields)
                for (const [name, value] of Object.entries(params.note.fields)) fields[name].value = value
                return null
            }
            assert.fail('Unexpected AnkiConnect request ' + action)
        } }
    const edit = text => {
        file.text = text
        file.stat.size = Buffer.byteLength(text)
        file.stat.mtime++
        onModify?.(file)
    }
    const vault = { configDir: '.obsidian', getName: () => vaultName, getMarkdownFiles: () => [file],
        getAbstractFileByPath: path => path === file.path ? file : null, read: async () => file.text,
        on(name, cb) { if (name === 'modify') onModify = cb },
        async process(_file, callback) {
            if (failLocalWrite) { failLocalWrite = false; throw Error('Test write interruption') }
            edit(callback(file.text))
        },
        adapter: { exists: async p => checkpoint.has(p), read: async p => checkpoint.get(p),
            write: async (p, value) => checkpoint.set(p, value) } }
    const app = { vault, metadataCache: { getCache: () => null },
        workspace: { getLeavesOfType: () => [], getActiveFile: () => file, on() {}, onLayoutReady(callback) { callback() } } }
    const plugin = { app, added_media: [], file_hashes: {}, manifest: { id: 'rudonium-anki-toolkit' }, addCommand() {}, registerEvent() {}, registerView() {}, register() {},
        fields_dict: { Study: Object.keys(fields) }, settings: { BIDIRECTIONAL_SYNC: true, BIDIRECTIONAL_PREVIEW: true,
            EXPECTED_ANKI_PROFILE: profile, REQUIRE_ANKI_PROFILE: true, CUSTOM_REGEXPS: host.expressions,
            FILE_LINK_FIELDS: settings.file_link_fields, CONTEXT_FIELDS: settings.context_fields, Syntax: {}, Defaults: { Deck: 'Knowledge' } } }
    useHost(host)
    edit(file.text)
    const { settingToData } = await import('./benchmark/host.mjs')
    const data = settingToData(app, plugin.settings, plugin.fields_dict)
    const exported = await runtime.parsePortableMarkdown(app, data, file, file.text, [id], {})
    assert.equal(exported.notes_to_edit.length, 1)
    const authored = exported.notes_to_edit[0].note.fields
    assert.equal(authored.Example, 'Original example')
    if (!block) {
        assert.equal(authored.Context, file.path + ' > Q one')
        assert.ok(authored.File.includes('nid=' + id))
    }
    for (const [name, value] of Object.entries(authored)) fields[name].value = value
    fields['Импортированный'].value = 'Remote only'
    const preview = async (currentOnly = true) => {
        host.dialog = undefined
        await runtime.scanVaultFast(plugin, false, currentOnly)
        assert.ok(host.dialog, host.notices.join('\n'))
        assert.deepEqual(host.dialog.preview.issues, [])
        return host.dialog
    }
    return { runtime, plugin, host, file, fields, edit, preview, writes, authored, tail, id, data,
        interruptWrite: () => { failLocalWrite = true } }
}

test('two-way page preview and recovery preserve named fields, source metadata and the sole tag', async t => {
    const { preview, fields, file, interruptWrite, edit, writes, authored, tail } = await pageHost(t)
    assert.match(await (await preview()).apply(new Map()), /Confirmed 1 of 1/)
    assert.ok(file.text.includes('Импортированный: Remote only'))
    fields.Question.value = 'Question from Anki'
    fields.Example.value = 'First line<br>Second line'
    let dialog = await preview()
    const changes = dialog.preview.rows.flatMap(row => row.changes)
    assert.deepEqual(changes.map(change => change.field).sort(), ['Context','Example','Question'])
    const example = changes.find(change => change.field === 'Example').markdown()
    assert.doesNotMatch(example.before + example.after, /Private notes/)
    assert.match(example.after, /Example: First line\r\nSecond line #anki-page/)
    interruptWrite()
    await dialog.apply(new Map())
    assert.ok(file.text.includes('Original #anki-page example'))
    assert.equal(fields.Context.value, file.path + ' > Question from Anki', 'new context is written in this same operation')
    assert.deepEqual(writes.map(Object.keys), [['Context']])
    dialog = await preview()
    assert.match(await dialog.apply(new Map()), /Confirmed 1 of 1/)
    assert.ok(file.text.includes('# Question from Anki\r\nAnswer one'))
    assert.ok(file.text.includes('Example: First line\r\nSecond line #anki-page'))
    assert.ok(file.text.endsWith(tail))
    assert.equal((file.text.match(/#anki-page/g) ?? []).length, 1)
    assert.equal(writes.length, 1, 'retry only finishes the pending Markdown update')
    assert.equal((await preview()).preview.canApply, false)
    edit(file.text.replace('Detail: First\r\nSecond', 'Detail: Local\r\ncorrection'))
    dialog = await preview()
    assert.deepEqual(dialog.preview.rows.flatMap(row => row.changes.map(change => change.field)), ['Detail'])
    assert.match(await dialog.apply(new Map()), /Confirmed 1 of 1/)
    assert.equal(fields.Detail.value, 'Local<br>correction')
    assert.equal(fields.File.value, authored.File)
    assert.equal(fields['Импортированный'].value, 'Remote only')
    assert.equal((await preview()).preview.canApply, false)
    const valid = file.text
    fields.Example.value = 'Ignore<br>ID: 1700000000402'
    dialog = await preview()
    assert.ok(dialog.preview.rows.some(row => row.issues?.some(issue => issue.includes('Example'))))
    assert.equal(dialog.preview.canApply, false)
    assert.equal(file.text, valid)
})

test('optional page fields distinguish omitted, emptied and conflicting values across vault, file and cursor commands', async t => {
    const { runtime, plugin, host, id, fields, file, edit, preview, writes } = await pageHost(t)
    const rules = plugin.settings.BIDIRECTIONAL_FIELDS = [
        { model: 'Study', field: 'Example', direction: 'to-anki' },
        { model: 'Study', field: 'Detail', direction: 'to-obsidian' },
        { model: 'Study', field: 'Импортированный', direction: 'both' },
    ]
    const apply = (dialog, choices = new Map()) => dialog.apply(choices)
    const summary = change => [change.field, change.decision, change.allowedSide]
    const initial = await preview(false)
    assert.deepEqual(initial.preview.rows.flatMap(row => row.issues ?? []), [], 'an optional field may be absent from an individual page')
    assert.match(await apply(initial), /Confirmed 1 of 1/)

    edit(file.text.replace('Original #anki-page example', 'Edited in Obsidian #anki-page'))
    fields.Detail.value = 'Edited in Anki'
    fields['Импортированный'].value = 'Remote edit'
    let dialog = await preview()
    assert.deepEqual(dialog.preview.rows.flatMap(row => row.changes.map(summary)), [
        ['Example','obsidian','obsidian'], ['Detail','anki','anki'], ['Импортированный','anki',undefined]])
    assert.match(await apply(dialog), /Confirmed 1 of 1/)
    assert.equal(fields.Example.value, 'Edited in Obsidian')
    assert.ok(file.text.includes('Detail: Edited in Anki'))
    assert.ok(file.text.includes('Импортированный: Remote edit'))

    // This field follows Anki; a newly edited remote value must restore the missing label.
    edit(file.text.replace('Detail: Edited in Anki\r\n', ''))
    fields.Detail.value = 'Available only in Anki'
    const beforeOmission = writes.length
    plugin.settings.BIDIRECTIONAL_PREVIEW = false
    host.dialog = undefined
    assert.equal(await runtime.scanVaultFast(plugin, false, false), 'completed')
    assert.equal(host.dialog, undefined, 'the configured Anki-to-Obsidian direction can restore the field automatically')
    assert.equal(writes.length, beforeOmission)
    assert.equal(fields.Detail.value, 'Available only in Anki')
    assert.ok(file.text.includes('Detail: Available only in Anki'))

    // Empty only the field value. Keep the page marker on its own line.
    edit(file.text.replace('Example: Edited in Obsidian #anki-page','Example:') + '\r\n#anki-page')
    plugin.settings.BIDIRECTIONAL_PREVIEW = true
    dialog = await preview()
    assert.deepEqual(dialog.preview.rows.flatMap(row => row.changes.map(summary)), [['Example','obsidian','obsidian']])
    assert.match(await apply(dialog), /Confirmed 1 of 1/)
    assert.equal(fields.Example.value, '')
    assert.equal(fields.Detail.value, 'Available only in Anki')
    assert.equal(fields['Импортированный'].value, 'Remote edit')

    // A newly authored value and an independent Anki edit require a per-field choice.
    rules[0].direction = 'both'
    edit(file.text.replace('Example:\r\n','Example: Local choice\r\n'))
    fields.Example.value = 'Remote choice'
    const editor = { getValue: () => file.text.replace(/\r\n/gu,'\n'), getCursor: () => ({}),
        posToOffset: () => file.text.replace(/\r\n/gu,'\n').indexOf('Local choice') }
    host.cardDialog = undefined
    await runtime.previewCurrentCard(plugin, editor, file, file.text)
    assert.ok(host.cardDialog?.sync, host.notices.join('\n'))
    host.dialog = undefined
    plugin.settings.BIDIRECTIONAL_PREVIEW = false
    await host.cardDialog.sync()
    assert.equal(host.dialog,undefined, 'a cursor sync respects the new preview preference')
    assert.ok(file.text.includes('Example: Local choice'))
    assert.equal(fields.Example.value,'Remote choice')
    plugin.settings.BIDIRECTIONAL_PREVIEW = true
    await host.cardDialog.sync()
    dialog = host.dialog
    assert.ok(dialog, host.notices.join('\n'))
    const change = dialog.preview.rows.flatMap(row=>row.changes).find(item => item.field === 'Example')
    assert.equal(change.decision,'conflict')
    const conflictWrites = writes.length
    assert.match(await apply(dialog,new Map([[id + ':extra:Example','anki']])), /Confirmed 1 of 1/)
    assert.ok(file.text.includes('Example: Remote choice'))
    assert.equal(fields.Example.value, 'Remote choice')
    assert.equal(writes.length,conflictWrites)
})

test('page field picker supports one-way creation, then removal and update under the same ID in all three layouts', async t => {
    const h = await pageHost(t)
    const modules = await migrationModules.load(['page-field-insertion','page-card','id-marker-literals','duplicate-markers',
        'anki-id-marker','export-recovery','card-format-presets','anki-delta','anki-field-value','anki-card-impact',
        'oneway-history','anki','portable-parser','constants'], {
        readFilteredAnkiDecks: async () => new Map(),
        Md5: { hashStr: text => createHash('md5').update(text).digest('hex') },
        update: (id,fields) => ({action:'updateNoteFields',params:{note:{id,fields}}}),
    }, { constants:'export {}', anki:"import { update } from './host'; export const updateNoteFields = update" })
    const { insertPageField } = modules['page-field-insertion']
    const insert = (text, field, value) => {
        const { offset, insert: addition } = insertPageField(text, h.plugin.settings, h.plugin.fields_dict, field, value)
        return text.slice(0,offset) + addition + text.slice(offset)
    }
    let lastSource
    for (const placement of ['heading','yaml','after-answer']) {
        const data = { ...h.data, page_id_location:placement, comment:true, id_date:false }
        const tail = '<!--rudonium-answer-end-->\r\nPersonal key: do not export\r\n#anki-page'
        const parse = (source, ids) => h.runtime.parsePortableMarkdown(h.plugin.app,data,h.file,source,ids,{trackRanges:true})
        let source = '# Question\r\nAnswer with a literal `#anki-page`\r\n' + tail
        source = insert(source, 'Example', 'Initial')
        source = insert(source, 'Detail', 'Alpha\nBeta')
        const draft = await parse(source, [])
        assert.equal(draft.all_notes_to_add.length,1)
        assert.equal(draft.all_notes_to_add[0].fields.Example,'Initial')
        assert.ok(draft.all_notes_to_add[0].fields.Detail.includes('Beta'))
        draft.note_ids = [h.id]
        draft.writeIDs()
        assert.ok(draft.file.endsWith(tail))
        assert.equal((draft.file.match(/#anki-page/g) ?? []).length,2,'the public renderer tag is never written to Markdown')
        const prior = await parse(draft.file,[h.id])
        const existing = prior.notes_to_edit[0].note.fields
        const priorCandidate = prior.previewCandidates[0]
        const priorLayout = priorCandidate.namedLayout
        assert.deepEqual([...priorLayout.present].sort(), ['Detail','Example'])
        const history = { namedFields: priorLayout.present, fields:Object.fromEntries(Object.entries(existing).map(([name,value]) =>
            [name,modules['oneway-history'].oneWayFieldDigest(value)])) }
        lastSource = draft.file.replace('Example: Initial\r\n','').replace('Detail: Alpha','Detail: Revised')
        const second = await parse(lastSource,[h.id])
        assert.equal(second.all_notes_to_add.length,0)
        assert.equal(second.notes_to_edit.length,1)
        assert.equal(second.notes_to_edit[0].identifier,h.id)
        const next = second.notes_to_edit[0].note.fields
        assert.equal(Object.hasOwn(next,'Example'),false)
        assert.equal(next.Answer,'Answer with a literal `#anki-page`')
        assert.doesNotMatch(JSON.stringify(next),/Personal key/)
        const remote = Object.fromEntries(Object.entries({...existing,'Импортированный':'Private'})
            .map(([name,value],order)=>[name,{order,value}]))
        const delta = report => modules['anki-delta'].prepareExistingNoteChanges(
            [{id:h.id,path:h.file.path,modelName:'Study',deck:'Knowledge',fields:next,tags:[],
                authoredFields:modules['portable-parser'].authoredFieldNames(second,second.previewCandidates[0],next),
                namedLayout:second.previewCandidates[0].namedLayout}],
            report,
            new Map([[h.id,{modelName:'Study',fields:remote,tags:[],cards:[h.id+1]}]]),undefined,
            {history:{get:()=>history},allowDeckMoves:false})
        const response = await delta((_,message) => assert.fail(message))
        assert.deepEqual({...response.get(h.file.path)[0].params.note.fields},{Detail:next.Detail,Example:''})
        remote.Example.value = 'Independently changed in Anki'
        const conflicts = []
        const conflicted = await delta((_,message) => conflicts.push(message))
        assert.deepEqual({...conflicted.get(h.file.path)[0].params.note.fields},{Detail:next.Detail})
        assert.match(conflicts.join('\n'), /Example.*both changed/)
    }
    h.edit(lastSource)
    h.plugin.settings.BIDIRECTIONAL_SYNC = false
    let seenTarget
    h.host.onOneWayPreview = manager => {
        assert.deepEqual(manager.files, [h.file])
        seenTarget = manager.cursorCard
        Object.assign(manager, { ownFiles: [], cardIssues: new Map(), scanErrors: [], retryMessages: [], blockedUpdates: new Map() })
    }
    const editor = { getValue: () => h.file.text.replace(/\r\n/gu,'\n'), getCursor: () => ({}),
        posToOffset: () => h.file.text.replace(/\r\n/gu,'\n').indexOf('Detail: Revised') }
    await h.runtime.previewCurrentCard(h.plugin,editor,h.file,h.file.text)
    assert.equal(h.host.cardDialog?.result.id,h.id)
    assert.equal(typeof h.host.cardDialog?.sync,'function')
    await h.host.cardDialog.sync()
    assert.equal(seenTarget?.id,h.id,h.host.notices.join('\n'))
    assert.equal(seenTarget.path,h.file.path)
    assert.ok(h.host.exportPlan)
})

for (const format of ['block','translated-block','page']) {
    test(format + ' backfills Anki-only fields, clears a deleted last label and resolves simultaneous edits', async t => {
        const {preview, fields, edit, file, writes, id, tail, host} = await pageHost(t, format)
        const allChanges = dialog => dialog.preview.rows.flatMap(row => row.changes)
        const sync = async (dialog, choices = new Map()) => {
            assert.deepEqual(dialog.preview.rows.flatMap(row => row.issues ?? []), [])
            assert.match(await dialog.apply(choices), /Confirmed 1 of 1/)
        }
        // No extra labels or section at first. The Anki model also has unused fields.
        const privateTail = format === 'page' ? tail : '<!--ID: ' + id + ' -->\r\nEND' + tail
        const extras = 'Example: Original' + (format === 'page' ? ' #anki-page' : '') + ' example\r\nDetail: First\r\nSecond\r\n'
        const section = format === 'page' ? '<!--anki-fields-->\r\n' : ''
        let plain = file.text.replace(section + extras, '')
        if (format === 'page') plain = plain.replace('# Q one\r\n','# Q one #anki-page\r\n')
        assert.ok(plain.endsWith(privateTail))
        edit(plain)
        fields.Example.value = ''
        fields.Detail.value = ''
        fields['Импортированный'].value = 'From Anki<br>Second line'
        host.templateExtra = '{{Импортированный}}'
        const templateReads = host.templateReads
        let dialog = await preview()
        assert.deepEqual(allChanges(dialog).map(c => [c.field,c.decision]), [['Импортированный','anki']])
        await sync(dialog)
        const label = 'Импортированный: From Anki\r\nSecond line'
        assert.ok(file.text.includes(label))
        assert.ok(file.text.endsWith(privateTail), 'nothing is written outside the card')
        assert.doesNotMatch(file.text, /^Example:|^Detail:|^Context:|^File:/m)
        assert.equal((await preview()).preview.canApply,false)
        assert.deepEqual(writes,[])
        assert.equal(host.templateReads,templateReads, 'importing an Anki-only value never changes generated cards')
        // An extra displayed on the answer does not control whether Anki generates a card.
        // Keep it on the template for the deletion and refill round trips below.

        // Delete the complete label, leaving an empty section on pages. Clear just that field on the same ID.
        edit(file.text.replace(label + '\r\n', ''))
        assert.doesNotMatch(file.text,/^Импортированный:/m)
        host.questionTemplate = '{{#Импортированный}}Question{{/Импортированный}}'
        const guarded = await preview()
        assert.ok(guarded.preview.rows.some(row => row.issues?.some(issue => issue.includes('generated cards'))))
        assert.deepEqual(writes, [])
        delete host.questionTemplate
        dialog = await preview()
        assert.deepEqual(allChanges(dialog).map(c => [c.field,c.decision]), [['Импортированный','obsidian']])
        await sync(dialog)
        assert.equal(fields['Импортированный'].value,'')
        assert.deepEqual(writes, [{'Импортированный':''}])
        assert.equal((await preview()).preview.canApply,false)

        // Re-populate the missing field in Anki, then modify the source while the preview is open.
        fields['Импортированный'].value = 'Replacement'
        dialog = await preview()
        const changed = file.text.replace('Answer one','Locally edited answer')
        edit(changed)
        await assert.rejects(() => dialog.apply(new Map()), /changed|preview|stale|again/i)
        assert.equal(file.text,changed)
        assert.equal(fields['Импортированный'].value,'Replacement')
        await sync(await preview())
        assert.ok(file.text.includes('Импортированный: Replacement'))

        // Local omission and a remote change need a choice. A remote clear remains empty on the next run.
        edit(file.text.replace('Импортированный: Replacement\r\n',''))
        fields['Импортированный'].value = 'Another device'
        dialog = await preview()
        assert.deepEqual(allChanges(dialog).map(c => [c.field,c.decision]), [['Импортированный','conflict']])
        await sync(dialog, new Map([[id + ':extra:Импортированный','anki']]))
        assert.ok(file.text.includes('Импортированный: Another device'))
        fields['Импортированный'].value = '<div><br></div>'
        await sync(await preview())
        assert.doesNotMatch(file.text,/Another device/)
        assert.ok(file.text.endsWith(privateTail))
        assert.equal((await preview()).preview.canApply,false)
    })
}

test('first two-way comparison of divergent nonempty named fields keeps both versions for review', async t => {
    const { fields, preview, file, writes, id } = await pageHost(t, 'block')
    fields['Импортированный'].value = ''
    fields.Example.value = 'New remote value'
    const before = file.text
    const dialog = await preview()
    assert.deepEqual(dialog.preview.rows.flatMap(row => row.changes.map(c => [c.field,c.decision])),
        [['Example','conflict']])
    assert.equal(file.text,before)
    assert.deepEqual(writes,[])
    assert.match(await dialog.apply(new Map([[id + ':extra:Example','obsidian']])), /Confirmed 1 of 1/)
    assert.equal(fields.Example.value,'Original example')
    assert.equal((await preview()).preview.canApply,false)
})

async function syncExistingOneWay({runtime, host, plugin, file, data, id}) {
    const history = await runtime.openOneWayHistory(plugin,plugin.settings.EXPECTED_ANKI_PROFILE)
    const Manager = patched.managerType({...runtime.portableParser, ...runtime.delta})
    const parsed = await runtime.parsePortableMarkdown(plugin.app,data,file,file.text,[id],{syntax:plugin.settings.Syntax,trackRanges:true})
    const snapshot = (await host.request('notesInfo',{notes:[id]}))[0]
    const manager = Object.assign(new Manager(), {app:plugin.app, data, oneWayHistory:history,
        ownFiles:[parsed], linkedSnapshots:new Map([[id,snapshot]])})
    await manager.prepareExistingUpdates()
    assert.deepEqual([...manager.retryMessages],[])
    const actions = manager.existingChanges.get(file.path)
    for (const action of actions ?? []) {
        assert.equal(action.action,'updateNoteFields')
        assert.equal(action.params.note.id,id)
        await host.request(action.action,action.params)
    }
    await runtime.delta.verifyExistingNoteFieldWrites(manager.existingChanges, (_path,message) => assert.fail(message), {
        models:new Map([[id,'Study']]), namedLayouts:manager.namedLayouts,
        capture:receipt => manager.oneWayReceipts.push(receipt),
    })
    history.apply(manager.oneWayReceipts)
    await history.flush()
    return actions ?? []
}

for (const format of ['block','page']) {
    test(format + ' keeps field ownership while switching between sync modes', async t => {
        const h = await pageHost(t,format)
        const {plugin, file, fields, writes, preview, edit} = h
        const name = 'Импортированный'
        const row = name + ': Remote only\r\n'
        assert.match(await (await preview()).apply(new Map()), /Confirmed 1 of 1/)
        assert.ok(file.text.includes(row))
        edit(file.text.replace(row, ''))

        // Immediately start the one-way planner with a fresh history reader, like a plugin restart.
        plugin.settings.BIDIRECTIONAL_SYNC = false
        const actions = await syncExistingOneWay(h)
        assert.equal(actions.length,1)
        assert.deepEqual({...actions[0].params.note.fields},{[name]:''})
        assert.equal(fields[name].value,'')
        assert.equal(writes.length,1)
        assert.ok(!file.text.includes(row))

        // The user now adds a new value only in Anki; the previous two-way receipt must
        // not resurrect its old value or mistake the completed one-way removal for a conflict.
        fields[name].value = 'Fresh after mode change'
        plugin.settings.BIDIRECTIONAL_SYNC = true
        const next = await preview()
        assert.deepEqual(next.preview.rows.flatMap(r => r.changes.map(c => [c.field,c.decision])),[[name,'anki']])
        assert.match(await next.apply(new Map()), /Confirmed 1 of 1/)
        assert.ok(file.text.includes(name + ': Fresh after mode change'))
        assert.equal(writes.length,1)
        assert.equal((await preview()).preview.canApply,false)
    })
}

for (const format of ['block','page']) {
    for (const remoteChanged of [false,true]) {
        test(format + ' compares a missing field to its one-way receipt on the first two-way run · remote edit ' + remoteChanged, async t => {
            const h = await pageHost(t,format)
            h.fields['Импортированный'].value = ''
            h.plugin.settings.BIDIRECTIONAL_SYNC = false
            assert.equal((await syncExistingOneWay(h)).length,0)
            h.edit(h.file.text.replace('Detail: First\r\nSecond\r\n',''))
            if (remoteChanged) h.fields.Detail.value = 'Edited independently in Anki'
            h.plugin.settings.BIDIRECTIONAL_SYNC = true
            const dialog = await h.preview()
            const decision = remoteChanged ? 'conflict' : 'obsidian'
            assert.deepEqual(dialog.preview.rows.flatMap(row=>row.changes.map(c => [c.field,c.decision])),[['Detail',decision]])
            assert.deepEqual(h.writes,[])
            const choices = remoteChanged ? new Map([[h.id + ':extra:Detail','anki']]) : new Map()
            assert.match(await dialog.apply(choices), /Confirmed 1 of 1/)
            if (remoteChanged) {
                assert.equal(h.fields.Detail.value,'Edited independently in Anki')
                assert.ok(h.file.text.includes('Detail: Edited independently in Anki'))
                assert.deepEqual(h.writes,[])
            } else {
                assert.equal(h.fields.Detail.value,'')
                assert.doesNotMatch(h.file.text,/^Detail:/m)
                assert.deepEqual(h.writes,[{Detail:''}])
            }
            assert.equal((await h.preview()).preview.canApply,false)
        })
    }
}

const firstMergeCases = [
    {title:'Anki cleared the value', remote:'', decision:'anki', final:''},
    {title:'Obsidian changed the value', local:'From Obsidian', decision:'obsidian', final:'From Obsidian'},
    {title:'Anki cleared a locally edited field', local:'From Obsidian', remote:'', decision:'conflict', final:''},
    {title:'both sides supplied different text', local:'From Obsidian', remote:'From Anki', decision:'conflict', final:'From Anki'},
]
for (const format of ['block','page']) {
    for (const sample of firstMergeCases) {
        test(format + ' uses the previous one-way value for an existing label · ' + sample.title, async t => {
            const h = await pageHost(t,format)
            h.fields['Импортированный'].value = ''
            h.plugin.settings.BIDIRECTIONAL_SYNC = false
            assert.equal((await syncExistingOneWay(h)).length,0)
            if (sample.local !== undefined) h.edit(h.file.text.replace('Detail: First\r\nSecond','Detail: ' + sample.local))
            if (sample.remote !== undefined) h.fields.Detail.value = sample.remote
            h.plugin.settings.BIDIRECTIONAL_SYNC = true
            const before = h.file.text
            const dialog = await h.preview()
            assert.deepEqual(dialog.preview.rows.flatMap(r => r.changes.map(c => [c.field,c.decision])), [['Detail',sample.decision]])
            assert.equal(h.file.text,before)
            assert.deepEqual(h.writes,[])
            const choices = sample.decision === 'conflict' ? new Map([[h.id + ':extra:Detail','anki']]) : new Map()
            assert.match(await dialog.apply(choices), /Confirmed 1 of 1/)
            assert.deepEqual(h.writes,sample.decision === 'obsidian' ? [{Detail:sample.final}] : [])
            assert.equal(h.fields.Detail.value,sample.final)
            assert.equal(/^Detail:[ \t]*(.*)$/m.exec(h.file.text)?.[1],sample.final)
            assert.equal((await h.preview()).preview.canApply,false)
        })
    }
    test(format + ' confirms independent clears across a mode switch before Anki fills the missing field again', async t => {
        const h = await pageHost(t,format)
        h.fields['Импортированный'].value = ''
        h.plugin.settings.BIDIRECTIONAL_SYNC = false
        await syncExistingOneWay(h)
        h.edit(h.file.text.replace('Detail: First\r\nSecond\r\n',''))
        h.fields.Detail.value = ''
        h.plugin.settings.BIDIRECTIONAL_SYNC = true
        const empty = await h.preview()
        assert.deepEqual(empty.preview.rows.flatMap(r => r.changes),[])
        assert.match(await empty.apply(new Map()), /Confirmed 1 of 1/)
        assert.doesNotMatch(h.file.text,/^Detail:/m)
        assert.equal((await h.preview()).preview.canApply,false)
        h.fields.Detail.value = 'Fresh value after both cleared'
        const refill = await h.preview()
        assert.deepEqual(refill.preview.rows.flatMap(r => r.changes.map(c => [c.field,c.decision])),[['Detail','anki']])
        assert.match(await refill.apply(new Map()), /Confirmed 1 of 1/)
        assert.ok(h.file.text.includes('Detail: Fresh value after both cleared'))
        assert.deepEqual(h.writes,[])
        assert.equal((await h.preview()).preview.canApply,false)
    })
}

for (const location of ['yaml','heading','after-answer']) {
    test('page shared field exports in both modes and stays outside the answer (' + location + ')', async t => {
        const h = await pageHost(t)
        const {fields, plugin, runtime, file, data, id, tail, edit, preview, writes} = h
        const marker = location === 'heading' ? 'FROZEN' : '[Общее]*'
        plugin.settings.Syntax = {...plugin.settings.Syntax, 'Frozen Fields Line':marker}
        const head = location === 'yaml' ? "---\r\nanki-page-ID: '" + id + "'\r\n---\r\n# Q one #anki-page\r\n" :
            '# Q one #anki-page\r\n' + (location === 'heading' ? '<!--ID: ' + id + ' -->\r\n' : '')
        const footer = location === 'after-answer' ? '<!--ID: ' + id + ' @page-->\r\n' : ''
        edit(head + marker + ' - Study:\r\nExample: First source\r\n\r\nAnswer one\r\n' + footer + tail)
        fields.Example.value = ''
        fields.Detail.value = fields['Импортированный'].value = ''
        const parse = () => runtime.parsePortableMarkdown(plugin.app,data,file,file.text,[id],{syntax:plugin.settings.Syntax,trackRanges:true})
        const parsed = await parse()
        const out = parsed.notes_to_edit[0]
        assert.equal(out.identifier, id)
        assert.equal(out.note.fields.Answer, 'Answer one')
        assert.equal(out.note.fields.Example, 'First source')
        assert.deepEqual([...parsed.namedSyncFrozenFields('Study')],['Example'])
        assert.equal(parsed.pageCard.idLocation, location)
        plugin.settings.BIDIRECTIONAL_SYNC = false
        const outgoing = await syncExistingOneWay(h)
        assert.deepEqual(outgoing.map(a => a.params.note.fields),[{Example:'First source'}])
        assert.equal(fields.Example.value,'First source')
        fields.Example.value = 'foreign'
        assert.equal((await syncExistingOneWay(h)).length,1)
        assert.equal(fields.Example.value,'First source')
        plugin.settings.BIDIRECTIONAL_SYNC = true
        const initial = await preview()
        assert.match(await initial.apply(new Map()), /Confirmed 1 of 1/)
        assert.equal(fields.Example.value,'First source')
        fields.Example.value = 'edited in Anki'
        fields.Answer.value = 'answer changed in Anki'
        const d = await preview()
        assert.deepEqual(d.preview.rows.flatMap(r=>r.changes.map(c=>[c.field,c.decision])).sort(),[['Answer','anki'],['Example','obsidian']])
        assert.match(await d.apply(new Map()), /Confirmed 1 of 1/)
        assert.equal(fields.Example.value,'First source')
        assert.ok(file.text.includes('Example: First source\r\n\r\nanswer changed in Anki'))
        assert.ok(file.text.endsWith(footer + tail))
        assert.equal((await preview()).preview.canApply,false)
        assert.ok(writes.every(update=>Object.keys(update).every(name=>name==='Example')))
        edit(file.text.replace('First source','Second source'))
        const next = await preview()
        await next.apply(new Map())
        assert.equal(fields.Example.value,'Second source')
        assert.equal((await preview()).preview.canApply,false)

        const definition = marker + ' - Study:\r\nExample: Second source\r\n\r\n'
        edit(file.text.replace(definition, ''))
        plugin.settings.BIDIRECTIONAL_SYNC = false
        assert.equal((await syncExistingOneWay(h)).length, 0)
        assert.equal(fields.Example.value, 'Second source')
        plugin.settings.BIDIRECTIONAL_SYNC = true
        const restored = await preview()
        assert.deepEqual(restored.preview.rows.flatMap(row => row.changes.map(change => [change.field, change.decision])), [['Example', 'anki']])
        assert.match(await restored.apply(new Map()), /Confirmed 1 of 1/)
        assert.ok(file.text.includes('Example: Second source'))
        assert.equal((await preview()).preview.canApply,false)
    })
}
