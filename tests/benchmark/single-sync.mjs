// SPDX-License-Identifier: GPL-3.0-only
// Usage: node tests/benchmark/single-sync.mjs [source directory] [card count] [repeats] [--one-file] [--all-changed] [--remnote | --plain-remnote | --knowledge] [--with-archives | --archive-style=mark|strike|hidden]
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import overlay from '../../Build/overlay-source.cjs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import { loadSync, syncSourceDirectory } from './load-sync.mjs'
import { useHost } from './host.mjs'

const sourceDirectory = syncSourceDirectory(resolve(process.argv[2] || overlay.directory))
const size = Number(process.argv[3] || 20000)
const repeats = Number(process.argv[4] || 3)
assert.ok(Number.isSafeInteger(size) && size >= 10)
assert.ok(Number.isSafeInteger(repeats) && repeats >= 1)
const runtime = await loadSync(sourceDirectory)
const flags = new Set(process.argv.slice(5))
const packed = flags.has('--one-file')
const knowledge = flags.has('--knowledge')
const plain = knowledge || flags.has('--plain-remnote')
const fieldNames = knowledge ? ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang'] : ['Front', 'Back']
const archiveStyle = [...flags].find(flag => flag.startsWith('--archive-style='))?.split('=')[1]
if (archiveStyle) assert.ok(['mark', 'strike', 'hidden'].includes(archiveStyle))
const withArchives = flags.has('--with-archives') || !!archiveStyle
const archivedFragments = new Map()
const expressions = {}
if (plain || flags.has('--remnote')) {
    globalThis.require = createRequire(import.meta.url)
    const code = stripTypeScriptTypes(readFileSync(resolve(sourceDirectory, 'card-format-presets.ts'), 'utf8'), { mode: 'transform' })
    const { cardFormatPresets, knowledgeBulletExpression } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
    expressions.Basic = knowledge ? knowledgeBulletExpression : cardFormatPresets.find(preset => preset.id === 'remnote').expression
}
const profile = 'Benchmark'
const firstId = 1795000000000
const checkpoint = new Map()
const notes = new Map()
const files = []
const answers = []
let modified
const host = { runtime, expressions, plain, capturedFields: fieldNames, mixed: withArchives, metrics: {}, notices: [], dialog: null, failNextWrite: false, request }
const reset = () => { host.metrics = { reads: 0, parses: 0, localWrites: 0, ankiWrites: 0, requests: 0, queried: 0, maxBatch: 0, regexpFiles: 0 } }
function source(i, back) {
    const prefix = knowledge ? '- ' : plain ? '' : '## Cards\n- '
    const suffix = knowledge ? (i % 2 ? ' :: R' : '') + (i % 3 ? ' :: F=ru_RU' : '') + (i % 5 ? ' :: B=de_DE' : '') : ''
    const active = `${prefix}Question ${i} :: ${back}${suffix}\n<!--ID: ${firstId + i} -->\n`
    if (!withArchives || i % 10) return active
    const archivedId = firstId + 3 * size + i
    if (archiveStyle) {
        if (!archivedFragments.has(i)) {
            const block = `- Archived ${i} :: left untouched\n<!--ID: ${archivedId} -->\n`
            archivedFragments.set(i, runtime.wrapArchivedCard(block, archivedId, 'Deleted from Anki', false, '\n', archiveStyle))
        }
        return archivedFragments.get(i) + active
    }
    return `<!--RUDONIUM-ARCHIVE:${archivedId}-->\n- Archived ${i} :: left untouched\n<!--ID: ${archivedId} -->\n\n**Deleted from Anki**\n<!--/RUDONIUM-ARCHIVE:${archivedId}-->\n` + active
}
for (let i = 0; i < size; i++) {
    const id = firstId + i
    const answer = 'Answer ' + i
    const text = source(i, answer)
    answers.push(answer)
    files.push({ path: `Cards/${i}.md`, text, stat: { mtime: 1, ctime: 1, size: Buffer.byteLength(text) } })
    const languageFields = knowledge ? {
        'Add Reverse': { order: 2, value: i % 2 ? 'R' : '' },
        FrontLang: { order: 3, value: i % 3 ? 'ru_RU' : '' },
        BackLang: { order: 4, value: i % 5 ? 'de_DE' : '' },
    } : {}
    notes.set(id, { noteId: id, modelName: 'Basic', fields: { Front: { order: 0, value: 'Question ' + i },
        Back: { order: 1, value: answer }, ...languageFields }, tags: [], cards: [id + size], deckName: 'Knowledge' })
}
function modify(file, text) {
    file.text = text
    file.stat.mtime++
    file.stat.size = Buffer.byteLength(text)
    modified(file)
}
async function request(action, params, nested = false) {
    if (!nested) host.metrics.requests++
    if (action === 'multi') {
        assert.ok(params.actions.length > 0 && params.actions.length <= 500)
        const responses = []
        for (const action of params.actions) {
            try { responses.push({result: await request(action.action, action.params, true), error: null}) }
            catch (error) { responses.push({result: null, error: error.message}) }
        }
        if (host.afterPacket) return host.afterPacket(params.actions, responses)
        return responses
    }
    if (action === 'getActiveProfile') return profile
    if (action === 'guiSelectedNotes') return host.browsing ?? []
    if (action === 'areSuspended') {
        assert.ok(params.cards.length >= 1 && params.cards.length <= 5000)
        host.metrics.statusRequests = (host.metrics.statusRequests ?? 0) + 1
        return params.cards.map(card => notes.has(card - size) ? false : null)
    }
    if (action === 'notesInfo') {
        if (withArchives) assert.ok(params.notes.every(id => id < firstId + 3 * size), 'must never look up an archived record')
        host.metrics.queried += params.notes.length
        host.metrics.maxBatch = Math.max(host.metrics.maxBatch, params.notes.length)
        assert.ok(params.notes.length > 0 && params.notes.length <= 500)
        // Each response is independent of subsequent Anki edits, as with real HTTP JSON.
        return JSON.parse(JSON.stringify(params.notes.map(id => notes.get(id) ?? {})))
    }
    if (action === 'updateNoteFields') {
        if (host.failId === params.note.id) throw new Error('injected row rejection')
        if (host.failNextWrite) { host.failNextWrite = false; throw new Error('Simulated temporary write failure') }
        assert.deepEqual(Object.keys(params.note.fields), ['Back'])
        notes.get(params.note.id).fields.Back.value = params.note.fields.Back
        host.metrics.ankiWrites++
        return null
    }
    throw new Error('Unexpected transport operation: ' + action)
}
const focusIndex = Math.floor(size / 2)
function sourceForFocus(back) {
    if (!packed) return source(focusIndex, back)
    return answers.map((answer, i) => source(i, i === focusIndex ? back : answer)).join('')
}
if (packed) {
    const text = sourceForFocus(answers[focusIndex])
    files.length = 1
    Object.assign(files[0], { path: 'Cards/All.md', text, stat: { mtime: 1, ctime: 1, size: Buffer.byteLength(text) } })
}
const focus = files[packed ? 0 : focusIndex]
const uncachedDense = packed && focus.text.length > 64 * 1024
const focusId = firstId + focusIndex
const app = {
    metadataCache: { getCache() { return null } },
    workspace: { getLeavesOfType: () => [], getActiveFile: () => focus, on() {}, onLayoutReady(callback) { callback() } },
    vault: {
        configDir: '.obsidian', getName: () => 'Benchmark', getMarkdownFiles: () => files,
        on(type, listener) { if (type === 'modify') modified = listener },
        adapter: { exists: async path => checkpoint.has(path), read: async path => checkpoint.get(path),
            write: async (path, value) => { checkpoint.set(path, value) } },
        read: async file => { host.metrics.reads++; return file.text },
        process: async (file, fn) => { modify(file, fn(file.text)); host.metrics.localWrites++ },
    },
}
const plugin = { app, manifest: { id: 'rudonium-anki-toolkit' }, addCommand() {}, registerEvent() {}, registerView() {}, register() {},
    settings: { BIDIRECTIONAL_SYNC: true, BIDIRECTIONAL_PREVIEW: true, EXPECTED_ANKI_PROFILE: profile, REQUIRE_ANKI_PROFILE: true,
        SKIP_SYNC_ERRORS: true, CUSTOM_REGEXPS: expressions, Syntax: {}, Defaults: { Deck: 'Knowledge' } }, fields_dict: { Basic: fieldNames } }
useHost(host)
if (flags.has('--offline-start')) {
    plugin.note_types = []
    const schema = plugin.fields_dict
    plugin.fields_dict = {}
    let attempts = 0
    reset()
    runtime.registerFastScan(plugin, undefined, async () => {
        if (++attempts === 1) throw new Error('Anki is offline')
        plugin.fields_dict = schema
        plugin.note_types = Object.keys(schema)
    })
    assert.equal(attempts,0)
    assert.equal(host.metrics.requests,0)
    assert.equal(await runtime.scanVaultFast(plugin,false,true),'failed')
    assert.equal(host.metrics.requests,0)
    assert.equal(host.metrics.ankiWrites,0)
    await preview(true)
    assert.equal(attempts,2)
    await preview(true)
    assert.equal(attempts,2)
}
async function preview(currentOnly = false) {
    host.dialog = null
    await runtime.scanVaultFast(plugin, false, currentOnly)
    const { dialog } = host
    assert.ok(dialog, host.notices.join('\n') || 'Missing preview')
    assert.deepEqual(dialog.preview.issues.slice(0, 2), [])
    assert.equal(dialog.preview.scanned, currentOnly && !packed ? 1 : size)
    return dialog
}
const runs = []
async function measure(scenario, run) {
    reset()
    const start = performance.now()
    await run()
    const ms = Math.round((performance.now() - start) * 10) / 10
    runs.push({ scenario, ms, ...host.metrics })
}
function checkAll() {
    assert.equal(notes.size, size)
    for (let i = 0; i < size; i++) {
        const note = notes.get(firstId + i)
        assert.equal(note.fields.Front.value, 'Question ' + i)
        assert.equal(note.fields.Back.value, answers[i])
        assert.equal(note.modelName, 'Basic')
        if (knowledge) {
            assert.equal(note.fields['Add Reverse'].value, i % 2 ? 'R' : '')
            assert.equal(note.fields.FrontLang.value, i % 3 ? 'ru_RU' : '')
            assert.equal(note.fields.BackLang.value, i % 5 ? 'de_DE' : '')
        }
        assert.equal(note.deckName, 'Knowledge')
        assert.deepEqual(note.tags, [])
        assert.deepEqual(note.cards, [firstId + i + size])
        if (!packed) assert.equal(files[i].text, source(i, answers[i]))
    }
    if (packed) assert.equal(focus.text, sourceForFocus(answers[focusIndex]))
}
function assertWrites(local, anki) {
    assert.equal(host.metrics.localWrites, local)
    assert.equal(host.metrics.ankiWrites, anki)
}
function expectChange(dialog, decision) {
    assert.equal(dialog.preview.rows.length, 1)
    const [row] = dialog.preview.rows
    assert.equal(row.id, focusId)
    assert.deepEqual(row.changes.map(change => [change.field, change.decision]), [['Back', decision]])
}
async function applyOne(dialog, choices = new Map()) {
    assert.equal(await dialog.apply(choices), 'Updated 1 note.')
}
async function steady(currentOnly) {
    const dialog = await preview(currentOnly)
    assert.deepEqual(dialog.preview.rows, [])
    assert.equal(dialog.preview.canApply, false)
    assertWrites(0, 0)
}
async function checkCheckpointIntegrity() {
    const files = new Map()
    const storage = { exists: async path => files.has(path), read: async path => files.get(path),
        write: async (path, text) => { files.set(path, text) } }
    const open = (profile = 'A') => runtime.BidirectionalState.open(storage, 'state', profile)
    await (await open()).checkpoint([[1, { base: { front: 'Q', back: 'A', tags: [] } }]])
    await open()
    const callerCopy = await open()
    callerCopy.get(1).base.back = 'mutated caller copy'
    assert.equal((await open()).get(1).base.back, 'A')
    assert.equal((await open('B')).get(1), undefined)
    const before = new Map(files)
    const fresh = await open()
    const stale = await open()
    await fresh.checkpoint([[1, { base: { front: 'Q', back: 'B', tags: [] } }]])
    await assert.rejects(stale.checkpoint([[1, undefined]]), /checkpoint changed/)
    // Simulate failure between staging revision 2 and committing its numbered slot.
    const newestSlot = [...files.keys()].find(path => path.endsWith('.0'))
    files.delete(newestSlot)
    await open()
    assert.equal((await open()).get(1).base.back, 'B')
    await (await open()).checkpoint([[2, { base: { front: 'Q2', back: 'C', tags: [] } }]])
    assert.equal((await open()).get(2).base.back, 'C')
    // The cached path and file sizes are identical, but the two saved copies have been edited externally.
    files.clear()
    for (const [path, text] of before) files.set(path, text)
    await open()
    for (const [path, text] of files) files.set(path, text.replace('"back":"A"', '"back":"Z"'))
    await assert.rejects(open(), /verify/)
}
try {
    await checkCheckpointIntegrity()
    await measure(packed ? 'dense.cold' : 'vault.cold', async () => {
        const dialog = await preview(packed)
        assert.equal(dialog.preview.rows.length, 0)
        assert.equal(dialog.preview.canApply, true)
        assert.equal(await dialog.apply(new Map()), 'No changes.')
        assertWrites(0, 0)
    })
    for (const currentOnly of (packed ? [true] : [false, true])) {
        const scope = packed ? 'dense' : currentOnly ? 'current' : 'vault'
        for (let iteration = 0; iteration < repeats; iteration++) {
            // After a remote write, populate the cache outside the timing window for the warm no-op.
            reset()
            await steady(currentOnly)
            await measure(scope + '.unchanged', async () => {
                await steady(currentOnly)
                assert.equal(host.metrics.reads, 1, 'manual checks read the active note even when its timestamps did not change')
                assert.equal(host.metrics.parses, uncachedDense ? 1 : 0)
                assert.equal(host.metrics.queried, currentOnly && !packed ? 1 : size)
            })
            answers[focusIndex] = 'Local change ' + scope + iteration
            modify(focus, sourceForFocus(answers[focusIndex]))
            await measure(scope + '.outbound', async () => {
                const dialog = await preview(currentOnly)
                expectChange(dialog, 'obsidian')
                await applyOne(dialog)
                assertWrites(0, 1)
            })
            assert.equal(notes.get(focusId).fields.Back.value, answers[focusIndex])
            answers[focusIndex] = 'Remote change ' + scope + iteration
            notes.get(focusId).fields.Back.value = answers[focusIndex]
            await measure(scope + '.inbound', async () => {
                const dialog = await preview(currentOnly)
                expectChange(dialog, 'anki')
                await applyOne(dialog)
                assertWrites(1, 0)
            })
            assert.equal(focus.text, sourceForFocus(answers[focusIndex]))
        }
    }
    checkAll()
    if (!packed) await measure('vault.afterCurrent', async () => {
        await steady(false)
        // The final inbound edit invalidates the active source. Other files have not changed.
    })
    if (flags.has('--browse-collision')) {
        assert.ok(packed)
        const other = (focusIndex + 1) % size, otherId = firstId + other
        const old = answers[focusIndex]
        answers[focusIndex] = 'Pending local'
        answers[other] = 'Updated independently'
        modify(focus, sourceForFocus(answers[focusIndex]))
        let dialog = await preview(true)
        host.browsing = [focusId]
        reset()
        const partial = await dialog.apply(new Map())
        assert.match(partial, new RegExp('Anki Browse: ID ' + focusId))
        assert.match(partial, /Question /)
        assert.equal(notes.get(focusId).fields.Back.value, old)
        assert.equal(notes.get(otherId).fields.Back.value, answers[other])
        assertWrites(0, 1)
        host.browsing = []
        dialog = await preview(true)
        reset()
        await applyOne(dialog)
        assertWrites(0, 1)
        notes.get(focusId).fields.Back.value = 'Edit from Anki Browse'
        host.browsing = [focusId]
        dialog = await preview(true)
        reset()
        await applyOne(dialog)
        answers[focusIndex] = notes.get(focusId).fields.Back.value
        assertWrites(1, 0)
        checkAll()
        host.browsing = []
        reset()
        await steady(true)
    }
    if (flags.has('--packet-faults')) {
        assert.equal(size,130)
        for (const fault of ['row','short','browse','external']) {
            for (let i = 0; i < size; i++) {
                answers[i] = fault + ' updated ' + i
                if (!packed) modify(files[i], source(i,answers[i]))
            }
            if (packed) modify(focus, sourceForFocus(answers[focusIndex]))
            const dialog = await preview(packed)
            let packets = 0, laterId
            const writes = []
            let edited
            host.afterPacket = (actions, replies) => {
                packets++
                writes.push(...actions.map(action => action.params.note.id))
                if (packets === 1) {
                    laterId = [...notes.keys()].find(id => !writes.includes(id))
                    if (fault === 'row') host.failId = laterId
                    if (fault === 'short') return replies.slice(1)
                    if (fault === 'browse') host.browsing = [laterId]
                    if (fault === 'external') {
                        edited = notes.get(laterId).fields.Back.value
                        notes.get(laterId).fields.Back.value = 'Changed in Anki after first packet'
                    }
                }
                return replies
            }
            reset()
            const report = await dialog.apply(new Map())
            assert.match(report, /fresh preview/, report)
            assert.ok(host.metrics.ankiWrites >= 64 && host.metrics.ankiWrites < size)
            if (fault === 'external') {
                assert.equal(notes.get(laterId).fields.Back.value,'Changed in Anki after first packet')
                notes.get(laterId).fields.Back.value = edited
            }
            if (fault === 'browse') assert.ok(!writes.includes(laterId))
            delete host.afterPacket; delete host.browsing; delete host.failId
            const outstanding = [...notes.values()].filter((note,i) => note.fields.Back.value !== answers[i]).length
            const retry = await preview(packed)
            reset()
            await retry.apply(new Map())
            assert.equal(host.metrics.ankiWrites, outstanding, fault + ': retry must write only remaining fields')
            checkAll()
            reset()
            await steady(packed)
        }
    }
    if (flags.has('--all-changed')) {
        const scope = packed ? 'dense' : 'vault'
        for (const direction of ['outbound', 'inbound']) {
            for (let i = 0; i < size; i++) {
                answers[i] = `Changed ${direction} ${i} Wörterbuch`
                if (direction === 'inbound') notes.get(firstId + i).fields.Back.value = answers[i]
                else if (!packed) modify(files[i], source(i, answers[i]))
            }
            if (direction === 'outbound' && packed) modify(focus, sourceForFocus(answers[focusIndex]))
            await measure(scope + '.all-' + direction, async () => {
                const dialog = await preview(packed)
                assert.equal(dialog.preview.rows.length, size)
                assert.equal(await dialog.apply(new Map()), `Updated ${size} ${size === 1 ? 'note' : 'notes'}.`)
                assertWrites(direction === 'inbound' ? files.length : 0, direction === 'outbound' ? size : 0)
            })
            checkAll()
        }
    }
    // Disagreeing edits must wait for an explicit choice; ignoring a conflict writes nothing.
    modify(focus, sourceForFocus('Local conflict'))
    notes.get(focusId).fields.Back.value = 'Remote conflict'
    reset()
    let dialog = await preview(true)
    expectChange(dialog, 'conflict')
    assert.equal(await dialog.apply(new Map()), 'There are no changes with a confirmed choice.')
    assertWrites(0, 0)
    answers[focusIndex] = 'Remote conflict'
    await applyOne(dialog, new Map([[`${focusId}:back`, 'anki']]))
    assertWrites(1, 0)
    // A later edit invalidates the open plan.
    modify(focus, sourceForFocus('Before preview'))
    dialog = await preview(true)
    reset()
    answers[focusIndex] = 'After preview'
    modify(focus, sourceForFocus(answers[focusIndex]))
    await assert.rejects(dialog.apply(new Map()), /changed/)
    assertWrites(0, 0)
    // A failed outbound request leaves a checkpoint; a fresh plan recovers exactly once.
    dialog = await preview(true)
    host.failNextWrite = true
    assert.match(await dialog.apply(new Map()), /Could not confirm changes to 1 note\.\n.*Simulated temporary write failure/)
    assertWrites(0, 0)
    dialog = await preview(true)
    await applyOne(dialog)
    assertWrites(0, 1)
    reset()
    await steady(true)
    // The absent Anki rows stay in the vault and never cause writes, deletion or automatic recreation.
    const missing = Array.from({ length: 8 }, (_, i) => firstId + size - 8 + i)
    const originals = missing.map(id => notes.get(id))
    missing.forEach(id => notes.delete(id))
    reset()
    dialog = await preview()
    assert.deepEqual(dialog.preview.rows.map(row => row.id).sort((a,b) => a-b), missing)
    if (runtime.forgetConfirmedAnkiDeletions) {
        assert.ok(dialog.preview.rows.every(row => row.changes.length === 1 &&
            row.changes[0].key === row.id + ':deletion' && row.changes[0].anki === 'Keep text and ID'))
        assert.equal(dialog.preview.canApply, true)
    } else {
        assert.ok(dialog.preview.rows.every(row => row.recoverable === true && row.issues?.length))
        assert.equal(dialog.preview.canApply, false)
    }
    assertWrites(0, 0)
    originals.forEach(note => notes.set(note.noteId, note))
    checkAll()
    if (!packed) {
        // A same-size/same-mtime external edit reported by the vault must invalidate the preserved source.
        const other = files[0]
        answers[0] = 'answer 0'
        other.text = source(0, answers[0])
        modified(other)
        reset()
        await steady(true)
        dialog = await preview()
        assert.deepEqual(dialog.preview.rows.map(row => row.id), [firstId])
        await applyOne(dialog)
        assertWrites(0, 1)
        checkAll()
        const previous = other.text
        modify(other, previous.replace(String(firstId), String(focusId)))
        reset()
        dialog = await preview(true)
        assert.equal(dialog.preview.rows[0].duplicates.length, 2)
        assert.equal(dialog.preview.canApply, false)
        assertWrites(0, 0)
        modify(other, previous)
        checkAll()
    }
    const version = JSON.parse(readFileSync(resolve(dirname(sourceDirectory), 'manifest.json'))).version
    console.log(JSON.stringify({ version, size, ...(withArchives ? { extraArchivedBlocks: Math.ceil(size / 10), archiveStyle: archiveStyle || 'legacy' } : {}), files: files.length, style: knowledge ? 'five-capture Knowledge' : plain ? 'plain RemNote' : expressions.Basic ? 'linked bullets with RemNote' : 'linked bullets', repeats, node: process.version, runs,
        verified: ['allFieldsAndIds','scope','conflict','stalePlan','failedWriteAndRetry','missingEight','checkpointIntegrity',
            ...(packed ? [] : ['cachedExternalEdit', 'outOfScopeDuplicate'])] }, null, 2))
} finally {
    runtime.dispose()
}
