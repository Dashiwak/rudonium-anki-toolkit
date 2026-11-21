// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import pageFile from './benchmark/page-file.cjs'
import { loadSync } from './benchmark/load-sync.mjs'
import { useHost } from './benchmark/host.mjs'

const layouts = [
    { model: 'ob-deck-basic', marker: 'deck-to-anki', front: 'ob-deck-front', back: 'ob-deck-back',
        service: { 'ob-deck-id': '1200:4', 'ob-deck-head': 'Retain heading', 'ob-deck-tree': '<p>Tree</p>',
            'ob-deck-tags': 'legacy', 'ob-deck-backlink': '<a href="obsidian://open?file=Question">Open</a>' } },
    { model: 'Imported type 1', marker: 'linked-front-back', front: 'Front', back: 'Back',
        service: { ForgeKey: 'af-123example', Context: 'Original heading' } },
    { model: 'Imported type 2', marker: 'linked-question-answer', front: 'Question', back: 'Answer',
        service: { CardKey: 'keep-this-key', Source: 'Keep this source', Context: 'Headings' } },
]

const cases = [...layouts, { ...layouts[1], yaml: true }, { ...layouts[1], footer: true }]
for (const { model, marker, front, back, service, yaml, footer } of cases) test('single-file two-way sync preserves service fields for ' + marker +
    (yaml ? ' with a YAML ID' : footer ? ' with an after-answer ID' : ''), async t => {
    const runtime = await loadSync(overlay.directory, pageFile)
    t.after(runtime.dispose)
    const id = 1700000000123
    const profile = 'User'
    const property = yaml ? "anki-page-ID: '" + id + "' # keep this comment\r\n" : ''
    const properties = '---\r\nregion: Wien\r\n' + property + '---\r\n'
    const heading = properties + '# A question #anki-page'
    const meta = '\r\n' + (yaml || footer ? '' : '<!--ID: ' + id + '-->\r\n') + '<!--rudonium-page-route: ["' + model + '","Legacy deck"]-->\r\n<!--rudonium-page-layout: ' + marker + '-->\r\n'
    const savedFooter = footer ? '<!--ID: ' + id + ' | 2026-11-20 @page-->\r\n' : ''
    const tail = yaml ? '<!--rudonium-answer-end-->\r\nTARGET DECK: Private deck\r\nFILE TAGS: private_tag\r\nLocal notes\r\n' : ''
    const file = { path: 'Cards/Question.md', text: heading + meta + 'An answer\r\n' + savedFooter + tail, stat: { mtime: 1, ctime: 1, size: 0 } }
    file.stat.size = Buffer.byteLength(file.text)
    const values = { ...service, [front]: 'A question', [back]: 'An answer' }
    const fields = Object.fromEntries(Object.entries(values).map(([name, value], order) => [name, { value, order }]))
    const snapshot = { noteId: id, modelName: model, fields, cards: [id + 4], tags: [] }
    const requests = []
    let paused = false
    let present = true
    let activeProfile = profile
    let switchAfterFind = false
    let switchOnRead = false
    let trashed = false
    const backups = []
    const host = { runtime, expressions: { Basic: '@page' }, metrics: { parses: 0 }, notices: [],
        parseYaml(text) {
            const line = /^region: (Wien|edited)$/u.exec(text.replace(property, '').trim())
            assert.ok(line, 'unexpected fixture YAML: ' + text)
            return { region: line[1] }
        },
        backup: async () => { backups.push(file.text); return 'test/Obsidian.zip' },
        async request(action, params) {
            if (action === 'getActiveProfile') return activeProfile
            if (action === 'guiSelectedNotes') return []
            if (action === 'suspend' || action === 'unsuspend') {
                assert.deepEqual(params.cards, snapshot.cards)
                paused = action === 'suspend'
                return true
            }
            if (action === 'areSuspended') { assert.deepEqual(params.cards, snapshot.cards); return [paused] }
            if (action === 'notesInfo') { assert.deepEqual(params.notes, [id]); return [present ? structuredClone(snapshot) : {}] }
            if (action === 'findNotes') {
                assert.equal(params.query, 'nid:' + id)
                switchOnRead = switchAfterFind
                return present ? [id] : []
            }
            if (action === 'updateNoteFields') {
                assert.equal(params.note.id, id)
                requests.push(params.note.fields)
                for (const [name, value] of Object.entries(params.note.fields)) fields[name].value = value
                return null
            }
            assert.fail('Unexpected AnkiConnect request ' + action)
        } }
    const checkpoint = new Map()
    let modified
    function edit(text) {
        file.text = text
        file.stat.mtime++
        file.stat.size = Buffer.byteLength(text)
        modified(file)
    }
    const app = {
        metadataCache: { getCache() { return null } },
        workspace: { getLeavesOfType: () => [], getActiveFile: () => file, on() {}, onLayoutReady(callback) { callback() } },
        vault: { getMarkdownFiles: () => trashed ? [] : [file],
            getAbstractFileByPath: path => !trashed && path === file.path ? file : null,
            trash: async (f, system) => { assert.equal(f, file); assert.equal(system, false); trashed = true },
            getName: () => 'Vault', configDir: '.obsidian',
            on(type, listener) { if (type === 'modify') modified = listener },
            adapter: { exists: async p => checkpoint.has(p), read: async p => checkpoint.get(p),
                write: async (p, value) => checkpoint.set(p, value) },
            read: async () => {
                if (switchOnRead) { activeProfile = 'Other profile'; switchOnRead = false }
                return file.text
            }, process: async (_file, fn) => edit(fn(file.text)) } }
    const plugin = { app, manifest: { id: 'rudonium-anki-toolkit' }, addCommand() {}, registerEvent() {}, registerView() {}, register() {},
        settings: { BIDIRECTIONAL_SYNC: true, BIDIRECTIONAL_PREVIEW: true, EXPECTED_ANKI_PROFILE: profile, REQUIRE_ANKI_PROFILE: true,
            SKIP_SYNC_ERRORS: true, CUSTOM_REGEXPS: host.expressions, Defaults: { Deck: 'Knowledge' }, Syntax: { 'Suspend Line': 'PAUSE_[card]9' } },
        fields_dict: { Basic: ['Front', 'Back'], [model]: Object.keys(values) } }
    useHost(host)
    async function preview() {
        host.dialog = undefined
        await runtime.previewBidirectionalSync(plugin, {currentOnly: true})
        assert.ok(host.dialog, host.notices.join('\n'))
        assert.deepEqual(host.dialog.preview.issues, [])
        return host.dialog
    }
    // An ID in a file, or a read-only preview of a live Anki note, cannot authorize cleanup.
    plugin.settings.AFTER_DELETE_MODE = 'mark'
    present = false
    assert.equal((await preview()).preview.canApply, false)
    present = true
    assert.ok((await preview()).preview.canApply)
    present = false
    assert.equal((await preview()).preview.canApply, false)
    present = true
    plugin.settings.AFTER_DELETE_MODE = 'keep'
    let dialog = await preview()
    assert.deepEqual(dialog.preview.rows, [])
    assert.match(await dialog.apply(new Map()), /Confirmed 1 of 1/)
    const openState = () => runtime.BidirectionalState.open(app.vault.adapter,
        '.obsidian/plugins/rudonium-anki-toolkit/bidirectional-sync.json', profile)
    const history = await openState()
    const record = history.get(id)
    assert.ok(record.base && record.deletionSource, 'an applied ordinary keep sync records the verified source')
    await history.checkpoint([[id, { base: record.base }]]) // Older releases can have synchronized text but no raw-source proof.
    plugin.settings.AFTER_DELETE_MODE = 'mark'
    present = false
    assert.equal((await preview()).preview.canApply, false, 'legacy text baseline alone is not a deletion receipt')
    present = true
    plugin.settings.AFTER_DELETE_MODE = 'keep'
    assert.match(await (await preview()).apply(new Map()), /Confirmed 1 of 1/)
    edit(file.text.replace('A question', 'A revised question').replace('An answer', 'An answer from Obsidian'))
    dialog = await preview()
    assert.deepEqual(dialog.preview.rows[0].changes.map(change => change.decision), ['obsidian', 'obsidian'])
    assert.match(await dialog.apply(new Map()), /Confirmed 1 of 1/)
    assert.deepEqual(requests, [{ [front]: 'A revised question', [back]: 'An answer from Obsidian' }])
    fields[front].value = 'Front from Anki'
    fields[back].value = 'Back from Anki'
    dialog = await preview()
    assert.deepEqual(dialog.preview.rows[0].changes.map(change => change.decision), ['anki', 'anki'])
    assert.match(await dialog.apply(new Map()), /Confirmed 1 of 1/)
    assert.equal(file.text, properties + '# Front from Anki #anki-page' + meta + 'Back from Anki\r\n' + savedFooter + tail)
    // Normal command bypasses the dialog by default, in both a no-op and a safe inbound write.
    delete plugin.settings.BIDIRECTIONAL_PREVIEW
    host.dialog = undefined
    assert.equal(await runtime.scanVaultFast(plugin, false, true), 'completed')
    assert.equal(host.dialog, undefined)
    fields[back].value = 'Edited in Anki with auto apply'
    assert.equal(await runtime.scanVaultFast(plugin, false, true), 'completed')
    assert.equal(host.dialog, undefined)
    assert.ok(file.text.includes('Edited in Anki with auto apply'))
    fields[back].value = 'Back from Anki'
    edit(file.text.replace('Edited in Anki with auto apply', 'Concurrent Markdown edit'))
    const conflict = await preview()
    assert.ok(conflict.preview.rows.some(row => row.changes.some(change => change.decision === 'conflict')))
    assert.ok(file.text.includes('Concurrent Markdown edit'))
    await conflict.apply(new Map([[id + ':back', 'anki']]))
    assert.ok(file.text.includes('Back from Anki'))
    const expectProvenAbsence = async () => {
        // Switching modes after the last successful observation cannot manufacture or discard proof.
        present = false
        plugin.settings.AFTER_DELETE_MODE = 'mark'
        const absent = await preview()
        assert.ok(absent.preview.canApply, JSON.stringify(absent.preview.rows))
        present = true
        plugin.settings.AFTER_DELETE_MODE = 'keep'
    }
    await expectProvenAbsence() // Known deletions require review, even when preview is off.
    plugin.settings.BIDIRECTIONAL_PREVIEW = true
    assert.deepEqual((await preview()).preview.rows, [])
    for (const [name, value] of Object.entries(service)) assert.equal(fields[name].value, value)
    assert.equal(requests.length, 1)
    if (yaml) {
        edit(file.text.replace('Local notes', 'Local correction'))
        const privateOnly = await preview()
        assert.ok(!privateOnly.preview.rows.some(row => row.changes.some(change => change.decision === 'obsidian')))
        if (privateOnly.preview.canApply) await privateOnly.apply(new Map())
        assert.equal(requests.length,1)
        assert.ok(file.text.includes('Local correction'))
        assert.ok(file.text.includes(property), 'normal sync keeps the property in place and preserves its annotation');
        assert.equal((file.text.match(/anki-page-ID:/g) || []).length, 1);
    }
    const beforePause = file.text
    paused = true
    dialog = await preview()
    assert.ok(dialog.preview.canApply, JSON.stringify(dialog.preview.rows))
    await dialog.apply(new Map())
    const withPause = beforePause.replace('#anki-page\r\n', '#anki-page\r\nPAUSE_[card]9\r\n')
    assert.equal(file.text, withPause)
    await expectProvenAbsence() // importing the SUSPEND marker also refreshes evidence on confirmed content
    assert.equal((await preview()).preview.canApply, false)
    paused = false
    await (await preview()).apply(new Map())
    assert.equal(file.text, beforePause)
    edit(withPause)
    await (await preview()).apply(new Map())
    assert.equal(paused, true)
    assert.equal((await preview()).preview.canApply, false)
    edit(beforePause)
    await (await preview()).apply(new Map())
    assert.equal(paused, false)
    assert.equal(file.text, beforePause)
    assert.equal(requests.length, 1, 'changing suspension must not modify fields or migrated metadata')
    if (yaml) return // dedicated private-page deletion cases also cover this storage format
    for (const mode of ['strike', 'hidden']) {
        plugin.settings.AFTER_DELETE_MODE = mode
        present = false
        edit(beforePause.replace('region: Wien', 'region: edited'))
        assert.equal((await preview()).preview.canApply, false, 'unrelated YAML edit protects a page from automatic archival')
        edit(beforePause)
        dialog = await preview()
        assert.ok(dialog.preview.canApply)
        await dialog.apply(new Map())
        assert.equal(trashed, false)
        assert.ok(file.text.startsWith(properties), 'archiving a whole page keeps the YAML header in place')
        const [range] = runtime.archivedCardRanges(file.text)
        assert.equal(range.id, id)
        assert.equal(range.style, mode)
        assert.equal(runtime.archivedCardSource(file.text, range), beforePause.slice(properties.length))
        assert.ok(!runtime.activeCardMarkdown(file.text).includes('#anki-page'))
        assert.ok(!runtime.activeCardMarkdown(file.text).includes('ID: ' + id))
        assert.equal((await preview()).preview.canApply, false)
        present = true
        edit(beforePause)
        plugin.settings.AFTER_DELETE_MODE = 'keep'
        assert.ok((await preview()).preview.canApply, 'simulate a restored copy and establish new proof')
        await (await preview()).apply(new Map())
    }
    delete plugin.settings.AFTER_DELETE_MODE
    plugin.settings.CLEAN_DELETED_BLOCKS = true
    assert.equal((await preview()).preview.canApply, false)
    present = false
    dialog = await preview()
    assert.ok(dialog.preview.rows.some(row => row.id === id && row.changes.some(change => change.anki === 'Keep text and ID')))
    const revisionBeforeKeep = file.stat.mtime
    await dialog.apply(new Map())
    assert.equal(trashed, false, 'block cleanup alone cannot trash a page')
    assert.equal(file.stat.mtime, revisionBeforeKeep, 'keeping the page does not write Markdown')
    assert.equal(file.text, beforePause)
    assert.equal((await preview()).preview.canApply, false, 'acknowledged keep cannot be reapplied')
    present = true
    plugin.settings.TRASH_DELETED_PAGES = true
    await (await preview()).apply(new Map())
    present = false
    dialog = await preview()
    assert.ok(dialog.preview.canApply, JSON.stringify(dialog.preview.rows))
    // A restored note between preview and apply invalidates the destructive action.
    present = true
    await dialog.apply(new Map())
    assert.equal(trashed, false)
    present = false
    dialog = await preview()
    switchAfterFind = true
    await dialog.apply(new Map()).catch(() => undefined)
    assert.notEqual(activeProfile, profile)
    assert.equal(trashed, false, 'profile switched after presence recheck and before trash')
    activeProfile = profile
    switchAfterFind = false
    await (await preview()).apply(new Map())
    assert.equal(trashed, true)
    assert.equal(file.text, beforePause)
    assert.ok(backups.every(value => value === beforePause) && backups.length > 0)
    // Reopen the unchanged mock page for the existing damaged-layout regression cases.
    trashed = false
    present = true
    plugin.settings.CLEAN_DELETED_BLOCKS = false
    plugin.settings.TRASH_DELETED_PAGES = false
    snapshot.modelName += '++'
    dialog = await preview()
    assert.ok(dialog.preview.rows[0].issues.length)
    assert.equal(dialog.preview.canApply, false)
    if (marker !== 'deck-to-anki') {
        snapshot.modelName = model
        const saved = file.text
        const originalSchema = plugin.fields_dict[model]
        const otherPair = front === 'Front' ? ['Question', 'Answer'] : ['Front', 'Back']
        plugin.fields_dict[model] = [...originalSchema, ...otherPair]
        for (const name of otherPair) fields[name] = { value: 'Keep', order: Object.keys(fields).length }
        host.dialog = undefined
        await runtime.scanVaultFast(plugin, false, true)
        assert.equal(host.dialog.preview.canApply, false, 'ambiguous pairs')
        for (const name of otherPair) delete fields[name]
        plugin.fields_dict[model] = originalSchema
        for (const damaged of [saved.replace(/<!--rudonium-page-route:[^\n]*\n/u, ''),
            saved.replace(/<!--rudonium-page-layout:[^\n]*\n/u, ''),
            saved.replace(footer ? savedFooter : '<!--ID: ' + id + '-->\r\n', '')]) {
            assert.notEqual(damaged, saved)
            edit(damaged)
            host.dialog = undefined
            await runtime.scanVaultFast(plugin, false, true)
            assert.equal(host.dialog?.preview.canApply ?? false, false)
        }
        assert.equal(requests.length, 1)
    }
})
