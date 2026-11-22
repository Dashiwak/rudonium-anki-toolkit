// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import pageFile from './benchmark/page-file.cjs'
import { loadSync } from './benchmark/load-sync.mjs'
import { useHost } from './benchmark/host.mjs'

const modes = ['keep', 'remove', 'mark', 'strike', 'hidden']
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
    let changed
    const edit = text => {
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
            case 'deleteNotes':
                for (const key of params.notes) assert.ok(notes.delete(key), 'must not delete an already absent note')
                return null
            default: throw Error('Unexpected Anki action ' + action)
            }
        } }
    const app = { vault: { configDir: '.obsidian', getName: () => 'QA', getMarkdownFiles: () => [file],
        getAbstractFileByPath: key => key === file.path ? file : null, read: async f => f.text,
        process: async (f, change) => { assert.equal(f, file); edit(change(f.text)) },
        on(name, callback) { if (name === 'modify') changed = callback },
        adapter: { exists: async path => checkpoints.has(path), read: async path => checkpoints.get(path),
            write: async (path, value) => { checkpoints.set(path, value) } } }, metadataCache: { getCache: () => null },
        workspace: { getActiveFile: () => file, getLeavesOfType: () => [], on() {}, onLayoutReady(cb) { cb() } } }
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
    return { host, file, plugin, preview, apply, edit }
}

test('preview off syncs an independent card and keeps deletion or conflict for manual review', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    for (const kind of ['conflict','marked','missing']) {
        const h = fixture(runtime, 'remove')
        await h.apply()
        if (kind === 'marked') h.edit(commanded)
        else if (kind === 'missing') h.host.notes.delete(id)
        else {
            h.edit(initial.replace('Old :: Answer','Old :: Changed locally'))
            h.host.notes.get(id).fields.Back.value = 'Edited in Anki'
        }
        h.host.notes.get(sibling).fields.Back.value = 'New independent answer'
        h.host.dialog = undefined
        assert.equal(await runtime.scanVaultFast(h.plugin,false,true),'completed',kind)
        assert.equal(h.host.dialog, undefined, kind)
        assert.match(h.file.text,/Neighbor :: New independent answer/,kind)
        assert.equal(h.host.calls.some(call=>call.action==='deleteNotes'),false)
        assert.match(h.host.notices.at(-1), /Confirmed 1 of 1/, kind)
        assert.doesNotMatch(h.host.notices.join(' '), /awaiting review|Preview now/i)
        h.host.notices.length = 0
        assert.equal(await runtime.scanVaultFast(h.plugin, false, true), 'completed', kind)
        assert.equal(h.host.dialog, undefined, kind)
        assert.match(h.host.notices.at(-1), /Linked notes checked: 2\. No changes applied\.$/, kind)
        h.host.notices.length = 0
        assert.equal(await runtime.scanVaultFast(h.plugin, 'scheduled'), 'completed', kind)
        assert.deepEqual(h.host.notices, [], 'a timer must not repeat a prompt for an unresolved item')
        assert.equal(h.host.dialog, undefined, kind)
        const review = await h.preview()
        assert.ok(review,kind)
        assert.equal(review.preview.scopeLabel,h.file.path)
        assert.equal(typeof review.preview.mountPreference,'function')
        const decisions = review.preview.rows.filter(row=>row.id===id).flatMap(row=>row.changes)
        if (kind === 'conflict') {
            assert.match(h.file.text,/Old :: Changed locally/)
            assert.equal(h.host.notes.get(id).fields.Back.value,'Edited in Anki')
            assert.equal(decisions[0].decision,'conflict')
        } else {
            assert.ok(h.file.text.includes('Old :: Answer'),kind)
            assert.equal(decisions[0].key,id + (kind==='marked' ? ':delete' : ':deletion'))
        }
    }
})

test('a vault with only an unresolved field gives a quiet completion on every manual run', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep')
    useHost(h.host)
    h.edit(prefix + original)
    h.host.notes.get(id).fields.Front.value = 'Edited in Anki'
    for (let attempt = 0; attempt < 2; attempt++) {
        h.host.notices.length = 0
        assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
        assert.match(h.host.notices.at(-1) ?? '', /Linked notes checked: 1\. No changes applied\.$/)
        assert.equal(h.host.dialog, undefined)
        assert.equal(h.file.text, prefix + original)
        assert.equal(h.host.notes.get(id).fields.Front.value, 'Edited in Anki')
    }
})

test('first bidirectional run keeps ambiguous fields quiet; both manual and enabled previews remain available', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'remove')
    useHost(h.host)
    h.host.notes.get(id).fields.Back.value = 'Different answer in Anki'
    assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
    assert.equal(h.host.dialog, undefined)
    assert.equal(h.file.text, initial)
    assert.equal(h.host.notes.get(id).fields.Back.value, 'Different answer in Anki')
    assert.doesNotMatch(h.host.notices.at(-1), /Back|awaiting review|Preview now/i)
    h.plugin.settings.INTERFACE_LANGUAGE = 'ru'
    assert.equal(await runtime.scanVaultFast(h.plugin, true), 'completed')
    assert.match(h.host.notices.at(-1), /Связанных записей проверено: 2.*Изменения не применялись/u)
    assert.equal(h.host.dialog, undefined)
    for (const explicit of [true, false]) {
        h.plugin.settings.BIDIRECTIONAL_PREVIEW = !explicit
        h.host.dialog = undefined
        if (explicit) await runtime.previewBidirectionalSync(h.plugin, {currentOnly:true})
        else assert.equal(await runtime.scanVaultFast(h.plugin, false, true), 'stopped')
        assert.ok(h.host.dialog.preview.rows.some(row => row.id === id && row.changes.some(change => change.decision === 'conflict')))
    }
})

test('manual sync rereads a same-size external edit in the active note before reusing its cached mapping', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    for (const currentOnly of [false, true]) {
        const h = fixture(runtime, 'keep')
        await h.apply()
        const request = h.host.request
        h.host.request = async (action, params) => {
            if (action === 'updateNoteFields') {
                assert.equal(params.note.id, id)
                assert.deepEqual(params.note.fields, { Front: 'New' })
                h.host.notes.get(id).fields.Front.value = params.note.fields.Front
                return null
            }
            return request(action, params)
        }
        const stamp = { ...h.file.stat }
        // A sync provider can preserve both timestamps until Obsidian receives its modify event.
        h.file.text = initial.replace('Old :: Answer', 'New :: Answer')
        assert.equal(Buffer.byteLength(h.file.text), stamp.size)
        assert.equal(await runtime.scanVaultFast(h.plugin, false, currentOnly), 'completed')
        assert.equal(h.host.notes.get(id).fields.Front.value, 'New')
        assert.deepEqual(h.host.notes.get(id).cards, [id + 100])
        assert.deepEqual(h.file.stat, stamp)
        assert.equal(h.host.notes.get(sibling).fields.Front.value, 'Neighbor')
        const parses = h.host.metrics.parses
        assert.equal(await runtime.scanVaultFast(h.plugin, false, currentOnly), 'completed')
        assert.equal(h.host.metrics.parses, parses, 'saved, unchanged text keeps its parsed field mapping')
    }
})

test('a manual check catches duplicated IDs introduced without a vault modification event', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep')
    await h.apply()
    h.file.text = initial.replace(String(id), String(sibling))
    h.host.notes.get(sibling).fields.Back.value = 'New Anki value'
    assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
    assert.match(h.host.notices.at(-1), /No changes applied/)
    const dialog = await h.preview()
    assert.ok(dialog.preview.rows.some(row => row.issues?.some(issue => issue.includes('Duplicate Anki ID'))))
    assert.equal(h.file.text, initial.replace(String(id), String(sibling)))
    assert.deepEqual(h.host.notes.get(sibling).cards, [sibling + 100])
    assert.equal(h.host.notes.get(id).fields.Back.value, 'Answer')
})

test('retrying a one-way export report after enabling bidirectional sync cannot import an Anki field', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    for (const savedProfile of ['QA', 'Another collection']) {
        const h = fixture(runtime, 'keep')
        h.plugin.settings.REQUIRE_ANKI_PROFILE = false
        await h.apply()
        h.host.notes.get(id).fields.Back.value = 'Edited only in the currently open Anki profile'
        h.host.calls.length = 0
        // Same arguments as the Retry Files action wired by showLastExport/reportRetry.
        const outcome = await runtime.scanVaultFast(h.plugin, false, false, new Set([h.file.path]),
            new Map(), undefined, undefined, savedProfile)
        assert.equal(h.file.text, initial, 'a one-way report must never write Anki text into Markdown')
        assert.equal(outcome, 'stopped')
        assert.match(h.host.notices.at(-1), /one-way/i)
        assert.deepEqual(h.host.calls, [], 'neither collection may be accessed by a stale report')
    }
})

test('a manual sync reports slow work and distinguishes an unlinked draft from unchanged linked cards', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep')
    await h.apply()
    h.host.dialog = undefined
    const request = h.host.request
    let release
    const waiting = new Promise(resolve => { release = resolve })
    h.host.request = async (action, params) => {
        if (action === 'notesInfo') await waiting
        return request(action, params)
    }
    const run = runtime.scanVaultFast(h.plugin)
    try {
        await new Promise(resolve => setTimeout(resolve, 650))
        assert.match(h.host.notices.at(-1), /Checking linked notes/)
    } finally { release() }
    assert.equal(await run, 'completed')
    assert.match(h.host.notices.at(-1), /Linked notes checked: 2.*No changes/)
    h.edit('- New :: Draft\n')
    assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
    assert.match(h.host.notices.at(-1), /No linked notes.*Preview Current Card/)
    assert.equal(h.host.dialog, undefined)
})

test('automatic run reports a real read failure and can retry without opening the preview', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep')
    useHost(h.host)
    const request = h.host.request
    h.host.request = (action, params) => {
        if (action === 'notesInfo') throw Error('Anki connection lost')
        return request(action, params)
    }
    assert.equal(await runtime.scanVaultFast(h.plugin), 'failed')
    assert.equal(h.host.dialog, undefined)
    assert.match(h.host.notices.at(-1), /Anki connection lost/)
    assert.equal(h.file.text, initial)
    h.host.request = request
    assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
    assert.equal(h.host.dialog, undefined)
})

test('Browse allows saved incoming values and protects outbound edits until the selected note is released', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep')
    await h.apply()
    h.host.notes.get(id).fields.Back.value = 'Saved in Browse'
    h.host.notes.get(sibling).fields.Back.value = 'Other card is safe'
    let selection = [id]
    const request = h.host.request
    h.host.request = (action, params) => {
        if (action === 'guiSelectedNotes') return selection
        if (action === 'updateNoteFields') { h.host.notes.get(id).fields.Back.value = params.note.fields.Back; return null }
        return request(action, params)
    }
    h.host.notices.length = 0
    assert.equal(await runtime.scanVaultFast(h.plugin, 'scheduled'), 'completed')
    assert.deepEqual(h.host.notices, [])
    assert.match(h.file.text, /Old :: Saved in Browse/)
    assert.match(h.file.text, /Neighbor :: Other card is safe/)
    const source = h.file.text.replace('Saved in Browse', 'New Markdown')
    h.edit(source)
    assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
    assert.match(h.host.notices.at(-1), /^No changes applied\.$/)
    assert.equal(h.host.notes.get(id).fields.Back.value, 'Saved in Browse')
    assert.match(await h.apply(), /Select another note or close Browse/)
    selection = []
    assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
    assert.equal(h.host.notes.get(id).fields.Back.value, 'New Markdown')
    assert.equal(h.file.text, source)
})

test('malformed browser selection holds an outbound update until Anki confirms its selection', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep')
    await h.apply()
    h.host.dialog = undefined
    h.edit(initial.replace('Old :: Answer', 'Old :: Saved in Obsidian'))
    const request = h.host.request
    let selected = [String(id)]
    h.host.request = (action, params) => {
        if (action === 'guiSelectedNotes') return selected
        if (action === 'updateNoteFields') { h.host.notes.get(id).fields.Back.value = params.note.fields.Back; return null }
        return request(action, params)
    }
    assert.equal(await runtime.scanVaultFast(h.plugin), 'failed')
    assert.match(h.host.notices.at(-1), /invalid browser selection/)
    assert.equal(h.host.dialog, undefined)
    assert.equal(h.host.notes.get(id).fields.Back.value, 'Answer')
    selected = []
    assert.equal(await runtime.scanVaultFast(h.plugin), 'completed')
    assert.equal(h.host.notes.get(id).fields.Back.value, 'Saved in Obsidian')
})

function assertSource(runtime, file, mode) {
    assert.ok(file.text.startsWith(prefix) && file.text.endsWith(surrounding), 'surrounding bytes and draft must survive')
    assert.ok(!file.text.includes(command))
    if (mode === 'keep' || mode === 'remove') {
        assert.equal(file.text, mode === 'keep' ? initial : prefix + surrounding)
        return
    }
    const ranges = runtime.archivedCardRanges(file.text)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0].id, id)
    assert.equal(ranges[0].style, mode)
    const live = runtime.activeCardMarkdown(file.text)
    assert.ok(!live.includes('Old :: Answer') && !live.includes(String(id)))
    assert.ok(live.endsWith(surrounding))
    if (mode === 'hidden') {
        // HTML comments cannot nest. A raw ID comment inside this representation would terminate it prematurely.
        const visible = file.text.slice(prefix.length, -surrounding.length).replace(/<!--[\s\S]*?-->/g, '').trim()
        assert.equal(visible, '')
    } else if (mode === 'strike') {
        const projection = file.text.slice(prefix.length, -surrounding.length).replace(/<!--[\s\S]*?-->/g, '')
        assert.match(projection, /<del\b[\s\S]*Old[\s\S]*Answer[\s\S]*<\/del>/i)
    }
}

test('Two-way sync acts on a previously observed deletion for each policy, preserves the draft and ignores retained archives', async () => {
    const runtime = await loadSync(overlay.directory)
    try {
        for (const mode of modes) {
            const h = fixture(runtime, mode)
            await h.apply() // Checkpoint is written by the actual successful preview/apply.
            h.host.notes.delete(id)
            const lost = await h.preview()
            assert.ok(lost.preview.rows.some(r => r.id === id && r.changes.some(c => c.key === id + ':deletion')), mode)
            const applied = await lost.apply(new Map())
            assertSource(runtime, h.file, mode)
            assert.equal(h.host.backups.includes(initial), mode !== 'keep', applied)
            const saved = h.file.text
            const before = h.host.calls.length
            const again = await h.preview()
            assert.equal(again.preview.canApply, false)
            const queried = h.host.calls.slice(before).filter(c => c.action === 'notesInfo').flatMap(c => c.params.notes)
            assert.equal(queried.includes(id), mode === 'keep')
            assert.equal(h.file.text, saved)
            assert.equal(h.host.calls.filter(c => c.action === 'deleteNotes').length, 0)
            for (const next of modes) {
                h.plugin.settings.AFTER_DELETE_MODE = next
                const switched = await h.preview()
                assert.equal(switched.preview.canApply, false, mode + ' → ' + next)
                assert.equal(h.file.text, saved)
            }
            assertSource(runtime, h.file, mode)
        }
    } finally { runtime.dispose() }
})

test('Historical evidence and current collection must agree before a missing ID is processed', async () => {
    const runtime = await loadSync(overlay.directory)
    try {
        const h = fixture(runtime, 'hidden')
        const old = h.host.notes.get(id)
        old.cards.push(id + 200)
        h.host.notes.delete(id)
        const first = await h.preview()
        assert.ok(first.preview.rows.some(r => r.id === id && r.issues?.some(issue => /no previous confirmed sync/i.test(issue)) && !r.changes?.length))
        if (first.preview.canApply) await first.apply(new Map()) // may checkpoint the healthy sibling
        assert.equal(h.file.text, initial)
        h.host.notes.set(id, old)
        await h.apply()
        old.cards.pop()
        const oneSiblingRemoved = await h.preview()
        assert.ok(!oneSiblingRemoved.preview.rows.some(r => r.id === id && r.changes?.some(c => c.key === id + ':deletion')),
            'removing only a study card cannot delete its source note')
        old.deckName = 'New deck'
        const moved = await h.preview()
        assert.ok(!moved.preview.rows.some(r => r.id === id && r.changes?.some(c => c.key === id + ':deletion')))
        h.host.notes.delete(id)
        let lost = await h.preview()
        h.host.failGlobal = true
        await lost.apply(new Map()).catch(() => {})
        assert.equal(h.file.text, initial, 'global query failed')
        h.host.failGlobal = false
        lost = await h.preview()
        h.host.profile = 'Different person'
        await lost.apply(new Map()).catch(() => {})
        assert.equal(h.file.text, initial, 'profile changed')
        h.host.profile = 'QA'
        lost = await h.preview()
        h.plugin.settings.AFTER_DELETE_MODE = 'remove'
        await lost.apply(new Map()).catch(() => {})
        assert.equal(h.file.text, initial, 'changing hidden to destructive removal invalidates a preview')
        h.plugin.settings.AFTER_DELETE_MODE = 'hidden'
        h.edit(initial.replace('Old :: Answer','Old :: Author edited the answer'))
        const changed = await h.preview()
        assert.ok(!changed.preview.rows.some(r => r.id === id && r.changes?.some(c => c.key === id + ':deletion')))
        assert.match(h.file.text,/Author edited the answer/)
        h.edit(initial)
        lost = await h.preview()
        h.host.notes.set(id, old)
        await lost.apply(new Map()).catch(() => {})
        assert.equal(h.file.text, initial, 'Anki Undo or move between preview and apply preserves source')
        h.edit(commanded)
        const explicit = await h.preview()
        assert.ok(explicit.preview.rows.some(r => r.id === id && r.changes?.some(c => c.key === id + ':delete')))
        await explicit.apply(new Map())
        assertSource(runtime, h.file, 'hidden')
        assert.deepEqual(h.host.calls.filter(c => c.action === 'deleteNotes').map(c => c.params.notes), [[id]])
    } finally { runtime.dispose() }
})


test('repeated two-way scans keep bounded private drafts and foreign DELETE/ID lines out of Anki', async t => {
    const runtime = await loadSync(overlay.directory, () => pageFile().replace('this.regularScanned = true',
        "if (this.file.includes('Private :: Translation')) throw Error('Private appendix reached regular export rules'); this.regularScanned = true"))
    t.after(runtime.dispose)
    for (const scenario of ['local', 'remote']) for (const storage of ['heading', 'yaml', 'after-answer']) for (const mode of modes) {
        const h = fixture(runtime, mode)
        h.host.parseYaml = () => ({topic:'example'})
        h.host.expressions = h.plugin.settings.CUSTOM_REGEXPS = {Basic:'@page'}
        h.plugin.settings.TRASH_DELETED_PAGES = true
        const initial = ['---', 'topic: example', ...(storage === 'yaml' ? ['anki-page-ID: "'+id+'"'] : []),
            '---', '# Old #anki-page', ...(storage === 'heading' ? ['ID: '+id] : []), 'Answer', ...(storage === 'after-answer' ? ['<!--ID: '+id+' @page-->'] : []),
            '<!--rudonium-answer-end-->', 'Private :: Translation', command, 'ID: '+sibling, ''].join('\r\n')
        h.edit(initial)
        const parsed = async () => {
            useHost(h.host)
            return runtime.parsePortableMarkdown(h.plugin.app, { template: {deckName:'Knowledge',tags:[]},
                folder_tags:{}, NOTE_REGEXP:/(?!)/, INLINE_REGEXP:/(?!)/, EMPTY_REGEXP:/(?!)/, fields_dict:h.plugin.fields_dict, custom_regexps:h.host.expressions }, h.file, h.file.text, [id],
                {preview:true, syntax:h.plugin.settings.Syntax})
        }
        assert.equal((await parsed()).notes_to_edit[0].note.fields.Back, 'Answer')
        const checkpoint = await h.preview()
        assert.ok(checkpoint.preview.canApply, JSON.stringify(checkpoint.preview))
        await checkpoint.apply(new Map())
        if (scenario === 'remote') h.host.notes.delete(id)
        else h.edit(initial.replace('# Old #anki-page\r\n', '# Old #anki-page\r\n' + command + '\r\n'))
        const confirmed = await h.preview()
        assert.ok(confirmed.preview.canApply, JSON.stringify(confirmed.preview))
        await confirmed.apply(new Map())
        assert.ok(h.host.notes.has(sibling))
        assert.ok(h.file.text.endsWith('Private :: Translation\r\n'+command+'\r\nID: '+sibling+'\r\n'))
        if (mode === 'remove' || mode === 'keep') assert.equal(h.file.text, initial)
        else assert.equal(runtime.archivedCardRanges(h.file.text)[0].id,id)
        for (const nextMode of [mode, 'keep', 'remove']) {
            h.plugin.settings.AFTER_DELETE_MODE = nextMode
            const again = await parsed()
            assert.equal(again.all_notes_to_add.length,0)
            assert.ok(again.notes_to_edit.every(edit => edit.identifier === id && edit.note.fields.Back === 'Answer'))
            const preview = await h.preview()
            assert.ok(preview.preview.rows.every(row => row.id !== sibling))
            assert.ok(h.host.calls.every(call => !JSON.stringify(call.params).includes('Private :: Translation')))
            assert.ok(h.host.calls.filter(call => call.action === 'deleteNotes').every(call =>
                call.params.notes.length === 1 && call.params.notes[0] === id))
        }
    }
})

test('latest chooses the saved edit of an isolated field and rechecks its clocks before applying', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const epoch = 1_780_000_000
    for (const scenario of ['anki', 'obsidian', 'same-second', 'missing', 'policy-skip', 'other-prose',
        'unmapped-anki-field', 'stale-anki', 'stale-local', 'override', 'notesModTime', 'same-fields-separate-edits',
        'legacy-overlap', 'legacy-separate-edits']) {
        const h = fixture(runtime, 'keep'), live = h.host.notes.get(id)
        const fallback = scenario === 'notesModTime'
        // A confirmed baseline written without a usable file time has the legacy on-disk shape.
        h.file.stat.mtime = scenario.startsWith('legacy-') ? 1 : epoch * 1000
        live.mod = epoch
        const request = h.host.request
        h.host.request = async (action, p) => {
            if (action === 'updateNoteFields') {
                for (const [field, value] of Object.entries(p.note.fields)) live.fields[field].value = value
                return null
            }
            if (action === 'notesModTime') return p.notes.map(key => ({noteId: key, mod: h.host.notes.get(key)?.mod}))
            const result = await request(action, p)
            if (fallback && action === 'notesInfo') for (const row of result) delete row.mod
            return result
        }
        await h.apply()
        if (scenario === 'policy-skip') h.plugin.settings.BIDIRECTIONAL_CONFLICT_POLICY = 'skip'
        let local = initial.replace('Old :: Answer', 'Old :: From Obsidian')
        if (scenario === 'other-prose' || scenario === 'legacy-overlap') local += 'A private paragraph changed later.'
        if (scenario === 'unmapped-anki-field') live.fields.Unmapped = {value: 'changed'}
        const separate = scenario === 'same-fields-separate-edits' || scenario === 'legacy-separate-edits'
        if (separate) local = initial.replace('Old ::', 'Changed question ::')
        h.edit(local)
        h.file.stat.mtime = (epoch + (scenario === 'obsidian' ? 10 : 5)) * 1000 + 740
        live.fields.Back.value = 'From Anki'
        live.mod = epoch + (scenario === 'same-second' ? 5 : 7)
        if (scenario === 'missing') delete live.mod
        const preview = await h.preview()
        const row = preview.preview.rows.find(r => r.id === id)
        assert.ok(row, scenario)
        const back = row.changes.find(c => c.key.endsWith(':back'))
        assert.ok(back.canChooseDirection, scenario)
        const hold = ['same-second','missing','policy-skip','other-prose','unmapped-anki-field','legacy-overlap'].includes(scenario)
        if (separate) {
            assert.equal(back.decision, 'anki')
            await preview.apply(new Map())
            assert.ok(h.file.text.includes('Changed question :: From Anki'))
            assert.equal(live.fields.Front.value,'Changed question')
        } else {
            assert.equal(back.decision, 'conflict', scenario)
            assert.equal(back.recommendedSide, hold ? undefined : scenario === 'obsidian' ? 'obsidian' : 'anki', scenario)
            if (scenario.startsWith('stale-')) {
                if (scenario === 'stale-anki') live.mod++
                else h.file.stat.mtime++
                await assert.rejects(preview.apply(new Map([[back.key,'anki']])),/changed|preview/i)
            } else if (scenario === 'override') {
                await preview.apply(new Map([[back.key,'obsidian']]))
                assert.equal(live.fields.Back.value,'From Obsidian')
            } else {
                await runtime.scanVaultFast(h.plugin, false, true)
                assert.equal(live.fields.Back.value, scenario === 'obsidian' ? 'From Obsidian' : 'From Anki', scenario)
                assert.ok(h.file.text.includes('Old :: ' + (hold || scenario === 'obsidian' ? 'From Obsidian' : 'From Anki')), scenario)
            }
        }
        assert.ok(h.file.text.includes('<!--ID: '+ id +' -->'))
    }
})

test('a first sync uses each linked note time in a shared file, invalid clocks stay manual', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const epoch = 1_780_000_000
    for (const scenario of ['single','multiple','wrong-unit','bad-lookup']) {
        const h = fixture(runtime,'keep')
        if (scenario !== 'multiple') h.edit(prefix + original)
        h.file.stat.mtime = epoch * 1000
        const mod = epoch + 10, n = h.host.notes.get(id)
        n.mod = scenario === 'wrong-unit' ? mod * 1000 : mod
        n.fields.Front.value = 'First edit from Anki'
        if (scenario === 'bad-lookup') {
            delete n.mod
            const previous = h.host.request
            h.host.request = (action, p) => action === 'notesModTime'
                ? [{noteId: id + 9009, mod}] : previous(action, p)
        }
        const dialog = await h.preview()
        const change = dialog.preview.rows.find(row => row.id === id).changes.find(field => field.key === id+':front')
        assert.equal(change.decision, 'conflict')
        const remoteWins = scenario === 'single' || scenario === 'multiple'
        assert.equal(change.recommendedSide, remoteWins ? 'anki' : undefined, scenario)
        await runtime.scanVaultFast(h.plugin,false,true)
        assert.equal(h.file.text.includes('First edit from Anki'), remoteWins, scenario)
    }
})

test('a reversible ordinary field can override the suggested baseline direction in preview', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime,'keep'), live = h.host.notes.get(id)
    await h.apply()
    const previous = h.host.request
    h.host.request = (action, p) => {
        if (action !== 'updateNoteFields') return previous(action,p)
        for (const [key,value] of Object.entries(p.note.fields)) live.fields[key].value = value
        return null
    }
    live.fields.Back.value = 'Anki has a different answer'
    const dialog = await h.preview()
    const back = dialog.preview.rows.find(row => row.id === id).changes.find(item => item.key === id + ':back')
    assert.equal(back.decision,'anki')
    assert.equal(back.canChooseDirection,true)
    await dialog.apply(new Map([[back.key,'obsidian']]))
    assert.equal(live.fields.Back.value,'Answer')
    assert.equal(h.file.text,initial)
})

test('first two-way sync reconciles multiple notes and fields after a verified one-way export', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, 'keep'), epoch = 1_780_000_000
    const live = h.host.notes.get(id), other = h.host.notes.get(sibling)
    useHost(h.host)
    const previous = h.host.request
    h.host.request = async (action, p) => {
        if (action === 'updateNoteFields') {
            const row = h.host.notes.get(p.note.id)
            for (const [key, value] of Object.entries(p.note.fields)) row.fields[key].value = value
            return null
        }
        return previous(action, p)
    }
    // Use the same verified receipts that the one-way exporter persists, before any two-way checkpoint.
    const history = await runtime.openOneWayHistory(h.plugin, 'QA'), receipts = []
    const sources = [...h.host.notes.values()].map(n => ({
        id:n.noteId, path:h.file.path, modelName:n.modelName, deck:'Knowledge', tags:[], authoredFields:['Front','Back'],
        fields:Object.fromEntries(Object.entries(n.fields).map(([name, entry]) => [name, entry.value])),
    }))
    await runtime.delta.prepareExistingNoteChanges(sources, (_path, why) => assert.fail(why), h.host.notes, undefined,
        {history, capture: receipt => receipts.push(receipt), allowDeckMoves:false})
    assert.ok(receipts.some(r => r.id === id && r.fields.Front === 'Old'))
    history.apply(receipts)
    await history.flush()

    h.edit(initial.replace('Old :: Answer','Old :: Local answer').replace('Neighbor :: Still here','Local neighbor :: Local sibling answer'))
    h.file.stat.mtime = epoch * 1000
    // File is newer than this first note. Its Front, however, still matches the last export in
    // Markdown, so the user's later Anki edit to that field wins independently of the file clock.
    live.mod = epoch - 20
    live.fields.Front.value = 'Казематы==='
    live.fields.Back.value = 'Older remote answer'
    live.tags = ['FromAnki']
    // Only receipts and per-note dates are consulted. This sibling has a newer note clock and two conflicts.
    other.mod = epoch + 20
    other.fields.Front.value = 'Remote neighbor'
    other.fields.Back.value = 'Remote sibling answer'
    const preview = await h.preview()
    const first = preview.preview.rows.find(row => row.id === id).changes
    const second = preview.preview.rows.find(row => row.id === sibling).changes
    assert.equal(first.find(c => c.field === 'Front').decision, 'anki')
    assert.equal(first.find(c => c.field === 'Back').recommendedSide, 'obsidian')
    assert.ok(!first.some(c => c.field === 'Tags' && c.decision === 'conflict'))
    assert.deepEqual(second.map(c => c.recommendedSide), ['anki','anki'])
    await runtime.scanVaultFast(h.plugin, false, true)
    assert.ok(h.file.text.includes('Казематы=== :: Local answer'), h.host.notices.join(' / '))
    assert.ok(h.file.text.includes('Remote neighbor :: Remote sibling answer'))
    assert.ok(h.file.text.includes('FromAnki'))
    assert.equal(live.fields.Back.value, 'Local answer')
    assert.deepEqual(live.tags, ['FromAnki'])
    assert.deepEqual(live.cards, [id + 100])
    assert.deepEqual(other.cards, [sibling + 100])
    assert.equal((await h.preview()).preview.canApply, false)
})
