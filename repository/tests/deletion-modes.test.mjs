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
    const storedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', {configurable:true, value:{
        createElement: tag => ({tag}),
        createDocumentFragment: () => ({append(text, button) { this.text = text.textContent; this.button = button }}),
    }})
    t.after(() => {
        if (storedDocument) Object.defineProperty(globalThis, 'document', storedDocument)
        else delete globalThis.document
    })
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
        assert.equal(await runtime.scanVaultFast(h.plugin,false,true),'stopped',kind)
        assert.equal(h.host.dialog, undefined, kind)
        assert.match(h.file.text,/Neighbor :: New independent answer/,kind)
        assert.equal(h.host.calls.some(call=>call.action==='deleteNotes'),false)
        const notice = h.host.notices.at(-1)
        assert.ok(notice.text.includes('review'),kind)
        assert.equal(notice.button.textContent,'Open preview')
        await notice.button.onclick({stopPropagation(){}})
        const review = h.host.dialog
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
