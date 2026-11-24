// SPDX-License-Identifier: GPL-3.0-only
// Exercise the production desktop preview and apply against in-memory vault and AnkiConnect boundaries.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import overlay from '../../Build/overlay-source.cjs'
import { loadSync } from './load-sync.mjs'
import { useHost } from './host.mjs'

export async function checkSuspension(count, checkDeletion = true, mass = true, checkArchive = false, withHistory = false) {
    assert.ok(Number.isSafeInteger(count) && count >= 4)
    const runtime = await loadSync(overlay.directory)
    const profile = 'Schedule QA'
    const label = 'PAUSE_[x]9'
    const first = 1740000000000
    const target = first + Math.floor(count / 2)
    const notes = new Map()
    const cards = new Map()
    const fragments = []
    // Anki ordinals come from templates (and cloze numbers). Card IDs do not encode their order.
    for (let index = 0; index < count; index++) {
        const id = first + index
        const cardIds = [first + count + index]
        if (id === target) cardIds.unshift(first + count * 2)
        for (let at = 0; at < cardIds.length; at++) {
            const card = cardIds[at]
            cards.set(card, { cardId: card, note: id, ord: at, reps: 6, interval: 40,
                queue: at === 1 ? -1 : 2, deckName: 'Knowledge' })
        }
        notes.set(id, { noteId: id, cards: cardIds, modelName: 'Basic', tags: [], deckName: 'Knowledge',
            fields: { Front: { order: 0, value: 'Question ' + index }, Back: { order: 1, value: 'Answer ' + index } } })
        fragments.push('- Question ' + index + ' :: Answer ' + index + '\r\n<!--ID: ' + id + ' -->\r\n')
    }
    const clean = '## Cards\r\n' + fragments.join('') + '\r\nFree text outside cards.\r\n'
    const file = { path: 'Cards/Dictionary.md', text: clean,
        stat: { size: Buffer.byteLength(clean), ctime: 1, mtime: 1 } }
    const calls = []
    const output = []
    const checkpoint = new Map()
    const backupTexts = []
    const writeLog = []
    const marker = '<!--ID: ' + target + ' -->'
    const link = (source, line) => source.replace(marker, line + '\r\n' + marker)
    const targetCards = notes.get(target).cards
    const suspended = () => targetCards.map(id => cards.get(id).queue === -1)
    let changed
    let failNextStatus = false
    let failFind = false
    let activeProfile = profile
    let switchAfterBrowse = false
    let switchOnFileRead = false
    const edit = text => {
        file.text = text
        file.stat.mtime++
        file.stat.size = Buffer.byteLength(text)
        changed?.(file)
    }
    const host = { runtime, expressions: {}, mixed: true, metrics: { parses: 0 }, notices: [], dialog: null,
        backup: async () => { backupTexts.push(file.text); return 'backup/Obsidian.zip' },
        request: async (action, params) => {
            calls.push({ action, params })
            switch (action) {
            case 'getActiveProfile': return activeProfile
            case 'guiSelectedNotes':
                switchOnFileRead = switchAfterBrowse
                return []
            case 'notesInfo':
                return structuredClone(params.notes.map(id => notes.get(id) ?? {}))
            case 'deleteNotes':
                for (const id of params.notes) {
                    const value = notes.get(id)
                    assert.ok(value, 'cannot delete missing note ' + id)
                    for (const card of value.cards) cards.delete(card)
                    notes.delete(id)
                }
                return null
            case 'findNotes':
                if (failFind) throw Error('Temporary read failure')
                assert.match(params.query, /^nid:[\d,]+$/)
                return params.query.slice(4).split(',').map(Number).filter(id => notes.has(id))
            case 'areSuspended':
                assert.ok(params.cards.length <= 5000 && params.cards.length > 0)
                return params.cards.map(id => cards.has(id) ? cards.get(id).queue === -1 : null)
            case 'cardsInfo':
                assert.ok(params.cards.length <= 500 && params.cards.length > 0)
                return params.cards.map(id => structuredClone(cards.get(id))).filter(Boolean).reverse()
            case 'suspend':
            case 'unsuspend': {
                const value = action === 'suspend' ? -1 : 2
                const changed = params.cards.filter(id => cards.get(id).queue !== value)
                for (const id of changed) cards.get(id).queue = value
                if (failNextStatus) { failNextStatus = false; throw Error('Simulated lost acknowledgement') }
                return changed.length > 0
            }
            default: throw new Error('Unexpected Anki action ' + action)
            }
        } }
    const vault = { configDir: '.obsidian', getName: () => 'QA', getMarkdownFiles: () => [file],
        getAbstractFileByPath: path => path === file.path ? file : null, read: async f => {
            if (switchOnFileRead) { activeProfile = 'Other Anki user'; switchOnFileRead = false }
            return f.text
        },
        process: async (f, change) => { assert.equal(f, file); edit(change(f.text)); writeLog.push(f.text) },
        on(name, fn) { if (name === 'modify') changed = fn },
        adapter: { exists: async path => checkpoint.has(path), read: async path => checkpoint.get(path),
            write: async (path, value) => { checkpoint.set(path, value) } } }
    const app = { vault, metadataCache: { getCache: () => null }, workspace: { getActiveFile: () => file,
        getLeavesOfType: () => [], on() {}, onLayoutReady(cb) { cb() } } }
    const plugin = { app, manifest: { id: 'rudonium-anki-toolkit' }, addCommand() {}, registerEvent() {}, registerView() {}, register() {},
        settings: { EXPECTED_ANKI_PROFILE: profile, REQUIRE_ANKI_PROFILE: true, BIDIRECTIONAL_SYNC: true, SKIP_SYNC_ERRORS: true,
            CUSTOM_REGEXPS: {}, Syntax: { 'Suspend Line': label, 'Delete Note Line': 'RETIRE[x]' }, Defaults: { Deck: 'Knowledge' } },
        fields_dict: { Basic: ['Front', 'Back'] } }
    useHost(host)
    if (withHistory) plugin.settings.SYNC_CHANGE_HISTORY = true
    const measure = async (scope, callback) => {
        const begin = performance.now()
        const offset = calls.length
        const writes = writeLog.length
        const result = await callback()
        const audit = calls.slice(offset)
        const actionCount = name => audit.filter(c => c.action === name).length
        const status = audit.filter(c => c.action === 'areSuspended')
        output.push({ scenario: scope, ms: Math.round((performance.now() - begin) * 10) / 10,
            requests: audit.length, statusRequests: status.length, statusIds: status.reduce((n, c) => n + c.params.cards.length, 0),
            ordinalRequests: actionCount('cardsInfo'), suspend: actionCount('suspend'), unsuspend: actionCount('unsuspend'), fileWrites: writeLog.length - writes })
        return result
    }
    const preview = async (atCursor = false) => {
        host.dialog = null
        host.notices = []
        const text = file.text.replace(/\r\n/g, '\n')
        const card = atCursor ? { path: file.path, text, offset: text.indexOf(marker) + 10, id: target,
            profile, model: 'Basic', deck: 'Knowledge', configuration: runtime.cursorConfiguration(plugin) } : undefined
        await runtime.previewBidirectionalSync(plugin, { currentOnly: true, card })
        assert.ok(host.dialog, host.notices.join('\n'))
        return host.dialog
    }
    const apply = async (cursor = false) => {
        const dialog = await preview(cursor)
        assert.deepEqual(dialog.preview.issues, [])
        assert.ok(dialog.preview.canApply, JSON.stringify(dialog.preview.rows.slice(0, 2)))
        return dialog.apply(new Map())
    }
    try {
        await measure('cold-file-preview-and-apply', () => apply())
        assert.equal(file.text, link(clean, label + '_2'), 'ord=1 imports the second card only')
        assert.deepEqual(suspended(), [false, true])
        await measure('warm-file-preview', async () => {
            const dialog = await preview()
            assert.equal(dialog.preview.scanned, count)
            assert.equal(dialog.preview.canApply, false)
        })
        assert.equal(output.at(-1).statusIds, cards.size, 'warm sync checks every existing card')
        cards.get(targetCards[1]).queue = 2
        await measure('cursor-import-resumed', () => apply(true))
        assert.equal(file.text, clean, 'a resume in Anki clears only the matching control line')
        edit(link(clean, label + '_2'))
        await measure('cursor-export-numbered-suspend', () => apply(true))
        assert.deepEqual(suspended(), [false, true])
        assert.deepEqual(calls.filter(c => c.action === 'suspend').flatMap(c => c.params.cards), [targetCards[1]])
        assert.equal(file.text, link(clean, label + '_2'))
        edit(clean)
        failNextStatus = true
        await measure('cursor-interrupted-resume', () => apply(true).catch(() => undefined))
        if (withHistory) {
            const rows = await runtime.readSyncChanges(plugin)
            assert.ok(rows.some(r => r.action === 'unknown' && r.noteId === target && r.detail === 'unsuspend'))
            assert.ok(rows.some(r => r.action === 'suspend' && r.noteId === target && r.direction === 'to-anki'))
            for (const [action, before, after] of [['suspend', '', '2'], ['unsuspend', '2', '']]) {
                const entry = rows.find(row => row.action === action && row.noteId === target && row.direction === 'to-obsidian')
                assert.deepEqual(entry?.fields, [{ name: 'SUSPEND', before, after }])
            }
        }
        assert.deepEqual(suspended(), [false, false])
        await measure('cursor-retry-after-lost-acknowledgement', async () => {
            const dialog = await preview(true)
            if (dialog.preview.canApply) await dialog.apply(new Map())
            assert.equal((await preview(true)).preview.canApply, false)
        })
        assert.equal(file.text, clean)
        assert.equal(calls.filter(c => c.action === 'unsuspend').length, 1, 'retry must recognise an applied write')
        if (mass) {
            for (const card of cards.values()) card.queue = -1
            await measure('mass-inbound-suspension', () => apply())
            assert.equal(file.text, clean.replaceAll('<!--ID:', label + '\r\n<!--ID:'))
            assert.equal(output.at(-1).fileWrites, 1, 'all inbound changes to one file must be coalesced')
            edit(clean)
            const before = calls.length
            await measure('mass-outbound-resume', () => apply())
            assert.equal(file.text, clean)
            const updates = calls.slice(before).filter(c => c.action === 'unsuspend').map(c => c.params.cards)
            assert.ok(updates.every(ids => ids.length > 0 && ids.length <= 500))
            assert.deepEqual(new Set(updates.flat()), new Set(cards.keys()))
            assert.ok([...cards.values()].every(card => card.queue === 2))
            assert.equal((await preview()).preview.canApply, false)
        }
        if (checkArchive) {
            plugin.settings.CLEAN_DELETED_BLOCKS = false
            plugin.settings.MARK_DELETED_BLOCKS = true
            assert.equal((await preview()).preview.canApply, false, 'switching policy preserves already verified history')
            const explicit = target + 1
            const original = fragments[explicit - first]
            const command = 'RETIRE[x]\r\n'
            const requested = clean.replace(original, original.replace('<!--ID:', command + '<!--ID:'))
            edit(requested)
            await measure('custom-delete-archive', () => apply())
            assert.ok(!notes.has(explicit))
            if (withHistory) {
                const rows = (await runtime.readSyncChanges(plugin)).filter(r => r.noteId === explicit)
                assert.ok(rows.some(r => r.action === 'delete' && r.direction === 'to-anki' && r.fields.some(f => f.name === 'Back' && f.before)))
                assert.ok(rows.some(r => r.action === 'edit' && r.direction === 'to-obsidian' && r.fields.some(f => f.after.includes('RUDONIUM-ARCHIVE'))))
            }
            assert.ok(file.text.includes(original), 'original fields and ID must remain author-readable')
            assert.ok(!file.text.includes(command))
            const envelope = id => [`<!--RUDONIUM-ARCHIVE:${id}:mark-->`, `<!--/RUDONIUM-ARCHIVE:${id}-->`]
            assert.ok(envelope(explicit).every(line => file.text.includes(line)))
            assert.ok(file.text.includes('**Deleted from Anki**'))
            const archivedFirst = file.text
            notes.delete(target)
            const candidate = await preview()
            assert.ok(candidate.preview.canApply)
            failFind = true
            await candidate.apply(new Map())
            assert.equal(file.text, archivedFirst, 'failed global existence lookup leaves archived+live neighbors unchanged')
            failFind = false
            await measure('confirmed-remote-deletion-archive', () => apply())
            assert.ok(envelope(target).every(line => file.text.includes(line)))
            assert.ok(file.text.includes(fragments[target - first]))
            assert.deepEqual(Array.from(file.text.matchAll(/<!--RUDONIUM-ARCHIVE:(\d+):mark-->/gu), m => Number(m[1])).sort((a,b) => a-b), [target, explicit])
            assert.ok(backupTexts.some(t => t === requested))
            const archived = file.text
            const offset = calls.length
            await measure('warm-archived-file', async () => {
                const repeated = await preview()
                assert.deepEqual(repeated.preview.issues, [])
                assert.equal(repeated.preview.canApply, false)
                assert.equal(repeated.preview.scanned, count - 2)
            })
            const queried = calls.slice(offset).filter(call => call.action === 'notesInfo').flatMap(call => call.params.notes)
            assert.equal(new Set(queried).size, count - 2)
            assert.ok(!queried.includes(target) && !queried.includes(explicit))
            assert.equal(file.text, archived)
            notes.get(first).fields.Back.value = 'Longer updated adjacent answer'
            await apply()
            assert.equal(file.text, archived.replace(' :: Answer 0\r\n', ' :: Longer updated adjacent answer\r\n'))
        }
        if (checkDeletion) {
            const snapshot = notes.get(target)
            notes.delete(target)
            const kept = await preview()
            assert.equal(kept.preview.canApply, true)
            assert.ok(kept.preview.rows.some(row => row.id === target && row.changes.some(change =>
                change.key === target + ':deletion' && change.anki === 'Keep text and ID')))
            assert.equal(file.text, clean)
            notes.set(target, snapshot)
            plugin.settings.CLEAN_DELETED_BLOCKS = true
            assert.equal((await preview()).preview.canApply, false, 'default keep mode already established deletion evidence')
            notes.delete(target)
            const candidate = await preview()
            assert.ok(candidate.preview.canApply, JSON.stringify(candidate.preview.rows))
            failFind = true
            const firstAttempt = await candidate.apply(new Map())
            assert.match(firstAttempt, /changed.*Preview the sync again/isu)
            assert.doesNotMatch(firstAttempt, /Deleted [1-9]|Updated Obsidian after deletion/u)
            assert.equal(file.text, clean, 'failed global lookup cannot authorize cleanup')
            failFind = false
            await measure('confirmed-remote-deletion', () => apply())
            assert.ok(backupTexts.length >= 1)
            assert.ok(backupTexts.every(text => text === clean))
            assert.equal(file.text, clean.replace(fragments[target - first], ''))
            const retained = file.text
            const explicit = target + 1
            const marker = '<!--ID: ' + explicit + ' -->'
            edit(retained.replace(marker, 'RETIRE[x]\r\n' + marker))
            plugin.settings.CLEAN_DELETED_BLOCKS = false
            const commandText = file.text
            const switched = await preview()
            switchAfterBrowse = true
            await switched.apply(new Map()).catch(() => undefined)
            assert.notEqual(activeProfile, profile)
            assert.equal(file.text, commandText, 'profile switch during source verification keeps the command')
            assert.ok(notes.has(explicit), 'profile switch during source verification must prevent deleteNotes')
            switchAfterBrowse = false
            activeProfile = profile
            const sibling = notes.get(first)
            const editedBack = 'A longer answer supplied by Anki'
            sibling.fields.Back.value = editedBack
            cards.get(sibling.cards[0]).queue = -1
            const afterDeletion = retained.replace(' :: Answer 0\r\n', ' :: ' + editedBack + '\r\n' + label + '\r\n')
            const countWrites = calls.filter(c => c.action === 'deleteNotes').length
            await measure('explicit-custom-delete-source-retained', () => apply())
            assert.equal(file.text, afterDeletion, 'confirmed command is removed, neighboring inbound fields and status shift offsets safely')
            assert.ok(!notes.has(explicit))
            const sent = calls.filter(c => c.action === 'deleteNotes').slice(countWrites)
            assert.deepEqual(sent.map(call => call.params.notes), [[explicit]])
            assert.equal((await preview()).preview.canApply, false)
        }
        if (count < 100) {
            const id = first + count * 4
            const [one, three] = [id + 4, id + 2]
            const fields = { Text: { value: '{{c1::one}} and {{c3::three}}', order: 0 }, 'Back Extra': { value: 'Keep it', order: 1 } }
            const bytes = 'START\r\nCloze\r\nText: {{c1::one}} and {{c3::three}}\r\nBack Extra: Keep it\r\n<!--ID: ' + id + ' -->\r\nEND'
            host.explicit = true
            plugin.settings.CLEAN_DELETED_BLOCKS = false
            plugin.fields_dict.Cloze = Object.keys(fields)
            edit(bytes)
            notes.set(id, { noteId: id, cards: [three, one], modelName: 'Cloze', tags: [], fields, deckName: 'Knowledge' })
            for (const [cid, ord] of [[one, 0], [three, 2]]) {
                cards.set(cid, { cardId: cid, note: id, ord, queue: ord === 2 ? -1 : 2, reps: 7, interval: 80, deckName: 'Knowledge' })
            }
            await apply()
            assert.equal(file.text, bytes.replace('<!--ID:', label + '_3\r\n<!--ID:'))
            edit(bytes)
            await apply()
            assert.ok(cards.get(three).queue !== -1)
            assert.equal(cards.get(one).queue, 2)
            assert.equal(file.text, bytes, 'Cloze fields and original ID position must survive')
            cards.get(three).queue = -1
            await apply()
            const previousSource = file.text
            const newId = three + 11
            notes.get(id).cards = [one, newId]
            cards.set(newId, { ...cards.get(three), cardId: newId, queue: 2 })
            cards.delete(three)
            const changed = await preview()
            assert.equal(changed.preview.rows.flatMap(row => row.changes).find(change => change.key === id + ':suspension')?.decision, 'conflict')
            const schedulerWrites = calls.filter(c => c.action === 'suspend' || c.action === 'unsuspend').length
            await changed.apply(new Map())
            assert.equal(file.text, previousSource, 'a recreated ordinal requires an explicit decision')
            await (await preview()).apply(new Map([[id + ':suspension', 'anki']]))
            assert.equal(file.text, bytes)
            assert.equal(cards.get(newId).queue, 2, 'a different card with the same ordinal must stay active')
            assert.equal(calls.filter(c => c.action === 'suspend' || c.action === 'unsuspend').length, schedulerWrites)
        }
        return { notes: count, cards: count + 1, node: process.version, measurements: output }
    } finally { runtime.dispose() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(JSON.stringify(await checkSuspension(Number(process.argv[2] ?? 20000)), null, 2))
}
