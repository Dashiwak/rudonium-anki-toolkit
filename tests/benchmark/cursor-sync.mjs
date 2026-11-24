// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/benchmark/cursor-sync.mjs 20000
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import overlay from '../../Build/overlay-source.cjs'
import { loadSync } from './load-sync.mjs'
import { MarkdownView, useHost } from './host.mjs'

/** A real sync plan with mock desktop I/O. Record each Anki ID actually read and written. */
export async function checkCursorSync(count, repeats = 1, withHistory = false) {
    assert.ok(Number.isSafeInteger(count) && count >= 3)
    const runtime = await loadSync(overlay.directory)
    const profile = 'Current'
    const first = 1700000000000
    const center = Math.floor(count / 2)
    const id = first + center
    const records = Array.from({ length: count }, (_, index) => ({ front: 'Question ' + index, back: 'Answer ' + index }))
    const outline = () => Array.from(records, ({ front, back }, i) =>
        '- ' + front + ' :: ' + back + '\r\n<!--ID: ' + (first + i) + ' -->\r\n').join('')
    const draft = '- This draft :: must stay local\r\n'
    const markdown = () => '## Cards\r\n' + outline() + draft
    const file = { path: 'Knowledge/Dictionary.md', text: markdown(), stat: { mtime: 1, ctime: 1, size: 0 } }
    file.stat.size = Buffer.byteLength(file.text)
    const remote = records.map(({ front, back }, i) => ({ noteId: first + i, modelName: 'Basic',
        fields: { Front: { order: 0, value: front }, Back: { order: 1, value: back } }, tags: [], cards: [first + count + i] }))
    const other = { path: 'Knowledge/Other.md', text: 'Ordinary text\n', stat: { mtime: 1, ctime: 1, size: 14 } }
    const leaves = []
    let onModify
    let restricted = true
    const store = new Map()
    const edits = []
    const queries = []
    const measurements = []
    function write(file, text) {
        file.text = text
        file.stat.size = Buffer.byteLength(text)
        file.stat.mtime++
        onModify?.(file)
    }
    const host = { runtime, expressions: {}, mixed: true, metrics: { parses: 0 }, notices: [], dialog: null,
        request: async (action, params) => {
            if (action === 'getActiveProfile') return profile
            if (action === 'guiSelectedNotes') return []
            if (action === 'multi' && params.actions?.every(entry => ['modelTemplates', 'modelStyling'].includes(entry.action))) return [
                { error: null, result: { Forward: { Front: '{{Front}}', Back: '{{Back}}' } } },
                { error: null, result: { css: '' } },
            ]
            if (action === 'areSuspended') {
                if (restricted) assert.deepEqual(params.cards, [id + count], 'another card status was requested')
                assert.ok(params.cards.length <= 5000)
                return params.cards.map(card => remote[card - first - count] ? false : null)
            }
            if (action === 'notesInfo') {
                if (restricted) assert.deepEqual(params.notes, [id], 'another Anki note was requested')
                queries.push(...params.notes)
                return structuredClone(params.notes.map(n => remote[n - first] ?? {}))
            }
            if (action === 'updateNoteFields') {
                const { id: n, fields } = params.note
                assert.equal(n, id, 'another Anki note was written')
                edits.push(n)
                for (const [name, text] of Object.entries(fields)) remote[n - first].fields[name].value = text
                return null
            }
            throw new Error('Unexpected Anki operation: ' + action)
        } }
    const vault = { configDir: '.obsidian', getName: () => 'Vault', getMarkdownFiles: () => [file, other],
        getAbstractFileByPath: path => [file, other].find(f => f.path === path),
        adapter: { exists: async p => store.has(p), read: async p => store.get(p), write: async (p, value) => { store.set(p, value) } },
        on(name, fn) { if (name === 'modify') onModify = fn },
        read: async f => f.text, process: async (f, fn) => write(f, fn(f.text)) }
    const app = { vault, metadataCache: { getCache: () => null }, workspace: { getLeavesOfType: () => leaves,
        on() {}, onLayoutReady(fn) { fn() }, getActiveFile: () => file } }
    const plugin = { app, added_media: [], file_hashes: {}, manifest: { id: 'rudonium-anki-toolkit' }, addCommand() {}, registerEvent() {}, registerView() {}, register() {},
        settings: { BIDIRECTIONAL_SYNC: true, BIDIRECTIONAL_PREVIEW: true, SKIP_SYNC_ERRORS: true, EXPECTED_ANKI_PROFILE: profile, REQUIRE_ANKI_PROFILE: true,
            Defaults: { Deck: 'Knowledge' }, CUSTOM_REGEXPS: {}, Syntax: {} }, fields_dict: { Basic: ['Front', 'Back'] } }
    useHost(host)
    if (withHistory) plugin.settings.SYNC_CHANGE_HISTORY = true
    const target = () => {
        // Obsidian's editor exposes LF, while the disk fixture uses CRLF.
        const text = file.text.replace(/\r\n/g, '\n')
        return { path: file.path, text, offset: text.indexOf('<!--ID: ' + id) + 10, id, profile,
            model: 'Basic', deck: 'Knowledge', configuration: runtime.cursorConfiguration(plugin) }
    }
    const preview = async card => {
        host.notices = []
        host.dialog = null
        await runtime.previewBidirectionalSync(plugin, { card, paths: new Set([file.path]) })
        return host.dialog
    }
    const valid = async () => {
        const dialog = await preview(target())
        assert.ok(dialog, host.notices.join('\n'))
        assert.deepEqual(dialog.preview.issues, [])
        assert.equal(dialog.preview.scanned, 1)
        assert.equal(dialog.preview.rows.every(row => row.id === id), true)
        return dialog
    }
    const measure = async (scenario, fn) => {
        const at = queries.length
        const started = performance.now()
        await fn()
        measurements.push({ scenario, ms: Math.round((performance.now() - started) * 10) / 10,
            fetchedNotes: queries.length - at, uniqueIds: new Set(queries.slice(at)).size })
    }
    const apply = async (dialog, choices = new Map()) => {
        assert.equal(await dialog.apply(choices), 'Updated 1 note.')
    }
    try {
        const state = () => runtime.BidirectionalState.open(vault.adapter,
            '.obsidian/plugins/rudonium-anki-toolkit/bidirectional-sync.json', profile)
        const neighbor = id - 1
        const otherNeighbor = id + 1
        // Pending independent local and remote edits must survive all phases of syncing the selected record.
        records[neighbor - first].back = 'Unpublished local draft'
        remote[otherNeighbor - first].fields.Back.value = 'Pending remote correction'
        write(file, markdown())
        // Exercise the complete user-visible flow once. Only host rendering is replaced.
        const editor = { getValue: () => file.text.replace(/\r\n/g, '\n'), getCursor: () => ({}), posToOffset: () => target().offset }
        const captured = async () => {
            host.cardDialog = null
            await runtime.previewCurrentCard(plugin, editor, file, file.text)
            assert.ok(host.cardDialog, host.notices.join('\n'))
            assert.equal(host.cardDialog.result.id, id)
            assert.equal(host.cardDialog.result.modelName, 'Basic')
            assert.ok(host.cardDialog.sync, host.cardDialog.result.cautions.join('\n'))
            return host.cardDialog
        }
        const originalPreview = await captured()
        write(file, file.text + 'intervening edit')
        await assert.rejects(originalPreview.sync(), /changed/)
        write(file, markdown())
        await measure('initial-bound-card', async () => {
            const card = await captured()
            await card.sync()
            assert.ok(host.dialog, host.notices.join('\n'))
            assert.equal(host.dialog.preview.scanned, 1)
            assert.equal(await host.dialog.apply(new Map()), 'No changes.')
        })
        let baseline = await state()
        assert.equal(baseline.get(id).base.back, 'Answer ' + center)
        assert.equal(baseline.get(neighbor), undefined)
        assert.equal(baseline.get(otherNeighbor), undefined)
        if (withHistory) assert.deepEqual(await runtime.readSyncChanges(plugin), [], 'preview and baseline must not invent a change')
        for (let i = 0; i < repeats; i++) {
            await measure('unchanged', async () => { assert.equal((await valid()).preview.canApply, false) })
            records[center].back = 'Local correction ' + i
            write(file, markdown())
            await measure('outbound', async () => apply(await valid()))
            assert.equal(remote[center].fields.Back.value, records[center].back)
            remote[center].fields.Back.value = 'Imported correction ' + i
            await measure('inbound', async () => apply(await valid()))
            records[center].back = remote[center].fields.Back.value
            assert.equal(file.text, markdown())
            if (withHistory) {
                const [inbound, outbound] = await runtime.readSyncChanges(plugin)
                for (const row of [inbound, outbound]) {
                    assert.equal(row.noteId, id)
                    assert.equal(row.path, file.path)
                    assert.equal(row.profile, profile)
                    assert.equal(row.action, 'edit')
                    assert.equal(row.mode, 'two-way')
                }
                assert.equal(outbound.direction, 'to-anki')
                assert.equal(inbound.direction, 'to-obsidian')
                assert.deepEqual(outbound.fields, [{ name: 'Back', before: i ? 'Imported correction ' + (i - 1) : 'Answer ' + center, after: 'Local correction ' + i }])
                assert.deepEqual(inbound.fields, [{ name: 'Back', before: 'Local correction ' + i, after: records[center].back }])
            } else assert.ok(![...store.keys()].some(path => path.includes('sync-change-history')))
        }
        records[center].back = 'Local conflict'
        write(file, markdown())
        remote[center].fields.Back.value = 'Remote conflict'
        const dialog = await valid()
        assert.equal(dialog.preview.rows[0].changes[0].decision, 'conflict')
        assert.equal(await dialog.apply(new Map()), 'There are no changes with a confirmed choice.')
        if (withHistory) assert.equal((await runtime.readSyncChanges(plugin))[0].action, 'skip')
        await apply(dialog, new Map([[id + ':back', 'anki']]))
        records[center].back = 'Remote conflict'
        assert.equal(file.text, markdown())
        for (let i = 0; i < count; i++) {
            assert.equal(remote[i].noteId, first + i)
            assert.deepEqual(remote[i].cards, [first + count + i])
            assert.equal(remote[i].fields.Front.value, 'Question ' + i)
            assert.equal(remote[i].fields.Back.value, i === center ? 'Remote conflict' : i === center + 1 ? 'Pending remote correction' : 'Answer ' + i)
        }
        const stable = file.text
        const writes = edits.length
        const wrong = { ...target(), offset: 0 }
        assert.equal((await preview(wrong))?.preview.canApply ?? false, false)
        assert.equal((await preview({ ...target(), model: 'Cloze' }))?.preview.canApply ?? false, false)
        assert.equal((await preview({ ...target(), deck: 'Different' }))?.preview.canApply ?? false, false)
        assert.equal((await preview({ ...target(), text: target().text + 'changed' }))?.preview.canApply ?? false, false)
        records[center].back = 'Ready to publish'
        write(file, markdown())
        const stale = await valid()
        write(file, markdown() + 'unrelated later edit')
        await assert.rejects(stale.apply(new Map()), /changed/)
        write(file, markdown())
        const dirty = await valid()
        const dirtyView = new MarkdownView()
        Object.assign(dirtyView, { file: other, data: other.text, getMode: () => 'source',
            getViewData: () => 'Copied card\n<!--ID: ' + id + ' -->' })
        leaves.push({ view: dirtyView })
        await assert.rejects(dirty.apply(new Map()), /Save the open edits/)
        leaves.pop()
        write(other, 'Copied card\n<!--ID: ' + id + ' -->\n')
        const duplicate = await preview(target())
        assert.ok(duplicate && !duplicate.preview.canApply)
        assert.equal(duplicate.preview.rows[0].duplicates.length, 2)
        assert.equal(edits.length, writes)
        assert.equal(remote[center].fields.Back.value, 'Remote conflict')
        write(other, 'Ordinary text\n')
        // Reversing the test edit restores all file bytes, including the neighboring local draft.
        write(file, stable)
        baseline = await state()
        assert.equal(baseline.get(id).base.back, 'Remote conflict')
        assert.equal(baseline.get(neighbor), undefined)
        assert.equal(baseline.get(otherNeighbor), undefined)
        restricted = false
        await runtime.previewBidirectionalSync(plugin, { currentOnly: true })
        assert.equal(host.dialog.preview.scanned, count, 'a partial scan polluted the full-file cache')
        assert.ok(host.dialog.preview.rows.some(row => row.id === neighbor))
        assert.ok(host.dialog.preview.rows.some(row => row.id === otherNeighbor))
        // An unlinked card in two-way mode must enter the one-way creation preview with its original target.
        // Also check the ordinary one-way dispatch for a linked card, all the way to FileManager.
        host.previewDraft = draft.trimEnd()
        const seenTargets = []
        host.onOneWayPreview = manager => {
            assert.deepEqual(manager.files, [file])
            seenTargets.push(manager.cursorCard)
            Object.assign(manager, { ownFiles: [], cardIssues: new Map(), scanErrors: [], retryMessages: [], blockedUpdates: new Map() })
        }
        for (const linked of [false, true]) {
            plugin.settings.BIDIRECTIONAL_SYNC = !linked
            const editor = { getValue: () => file.text.replace(/\r\n/g, '\n'), getCursor: () => ({}),
                posToOffset: () => linked ? target().offset : file.text.replace(/\r\n/g, '\n').indexOf(host.previewDraft) }
            if (linked) {
                await runtime.previewCurrentCard(plugin, editor, file, file.text)
            } else {
                const view = Object.assign(new MarkdownView(), { file, editor, data: file.text, getMode: () => 'source' })
                app.workspace.getActiveViewOfType = () => view
                host.cardDialog = null
                await runtime.previewBidirectionalSync(plugin, { currentOnly: true })
                assert.equal(typeof host.dialog.preview.previewNewCard, 'function')
                assert.equal(host.cardDialog, null)
                await host.dialog.preview.previewNewCard()
            }
            assert.ok(host.cardDialog.sync)
            await host.cardDialog.sync()
            assert.equal(seenTargets.length, linked ? 2 : 1, host.notices.join('\n'))
            assert.equal(seenTargets.at(-1).id, linked ? id : undefined)
            assert.equal(seenTargets.at(-1).offset, editor.posToOffset())
            assert.equal(seenTargets.at(-1).profile, profile)
            assert.equal(seenTargets.at(-1).path, file.path)
            assert.ok(host.exportPlan)
            assert.equal(edits.length, writes)
        }
        return { count, node: process.version, measurements }
    } finally { runtime.dispose() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(JSON.stringify(await checkCursorSync(Number(process.argv[2] ?? 20000), Number(process.argv[3] ?? 3)), null, 2))
}
