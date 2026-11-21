// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { managerType } = require('./benchmark/patched-manager.cjs')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')

const hash = text => createHash('md5').update(text).digest('hex')
const noop = () => {}
const zero = () => false
const map = () => new Map()

async function fixture(allowDelete = false, schema = ['Front', 'Back']) {
    const deleted = [], backups = []
    const journal = new Map(), notices = [], reads = [], calls = [], written = [], regular = [], dialogs = []
    const cards = new Map([[701, { note: 7, ord: 2, suspended: false }], [702, { note: 7, ord: 0, suspended: true }],
        [703, { note: 7, ord: 3, suspended: false }], [801, { note: 8, ord: 0, suspended: false }],
        [901, { note: 9, ord: 0, suspended: false }]])
    const flush = id => ({ noteId: id, modelName: 'Basic', tags: [], fields: { Front: { value: 'Q' }, Back: { value: 'A' } },
        cards: [...cards].filter(([, row]) => row.note === id).map(([card]) => card) })
    const invoke = async (action, params) => {
        calls.push(action)
        if (action === 'multi' && allowDelete) {
            return params.actions.map(request => {
                assert.equal(request.action, 'deleteNotes')
                deleted.push(...request.params.notes)
                for (const [key, card] of cards) if (request.params.notes.includes(card.note)) cards.delete(key)
                return { error: null, result: null }
            })
        }
        if (action === 'modelFieldNames') return [...schema]
        if (action === 'getActiveProfile') return 'Demo'
        if (action === 'notesInfo') return params.notes.map(flush)
        if (action === 'findNotes') return params.query.slice(4).split(',').map(Number)
        if (action === 'areSuspended') return params.cards.map(id => cards.get(id).suspended)
        if (action === 'cardsInfo') return params.cards.map(cardId => ({ cardId, note: cards.get(cardId).note, ord: cards.get(cardId).ord }))
        if (action === 'suspend') { written.push([...params.cards]); params.cards.forEach(id => cards.get(id).suspended = true); return true }
        throw Error('Unexpected Anki call ' + action)
    }
    const file = (path, text) => ({ path, text, stat: { size: text.length, mtime: 1, ctime: 1 }, extension: 'md' })
    const marked = file('multi.md', '## Cards\n- Q7 :: A\nPause_3\n<!--ID: 7 -->\n- Q8 :: A\nPause\n<!--ID: 8 -->\n')
    const plain = file('plain.md', '## Cards\n- Q9 :: A\n<!--ID: 9 -->\n')
    const files = [marked, plain], paths = new Set(files.map(f => f.path))
    const app = { workspace: { on: noop, getActiveViewOfType: () => null, onLayoutReady: fn => fn(), getLeavesOfType: () => [] },
        vault: { getName: () => 'Vault', configDir: '.obsidian', getMarkdownFiles: () => files, on: noop,
            read: async file => { reads.push(file.path); return file.text },
            getAbstractFileByPath: path => files.find(file => file.path === path) ?? null,
            process: (f, change) => {
                assert.ok(allowDelete, 'Suspension must preserve Markdown')
                f.text = change(f.text); f.stat.size = Buffer.byteLength(f.text); f.stat.mtime++
            },
            adapter: { exists: async key => journal.has(key), read: async key => journal.get(key), write: async (key, data) => journal.set(key, data) } } }
    const plugin = () => ({ app, manifest: { id: 'rudonium' }, settings: { Syntax: { 'Suspend Line': 'Pause' }, Defaults: { Deck: 'Deck' },
        EXPECTED_ANKI_PROFILE: 'Demo', REQUIRE_ANKI_PROFILE: true }, fields_dict: { Basic: ['Front', 'Back'] },
        file_hashes: {}, added_media: [], register: noop, registerEvent: noop, addCommand: noop, saveAllData: noop })
    let Manager
    const createManager = (app, data, files, file_hashes, media) => Object.assign(new Manager(), { app, data, files, file_hashes,
        added_media_set: new Set(media), getHashes() { return Object.fromEntries(this.sourceHashes) },
        async prepareExistingUpdates() { regular.push(this.ownFiles.flatMap(f => f.notes_to_edit.map(e => e.identifier))) },
        parseMarkdown(file, text, ids, _audit, _models, bullets) {
            this.parseCount++
            const page = text.includes('#anki-page') && modules['page-card'].readPageCard(text, this.data.custom_regexps || {}, this.diagnosticSyntax)
            const ranges = page ? [{ identifier: page.id, start: page.idLocation === 'yaml' ? 0 : page.start, end: page.end, note: { modelName: page.model, deckName: 'Deck', fields: { Front: page.front, Back: page.back } } }] :
                bullets.map(b => ({ identifier: b.id, start: b.start, end: b.end, note: { modelName: 'Basic', deckName: 'Deck', fields: {} } }))
            return { path: file.path, file: text, original_file: text, notes_to_edit: ranges.map(r => ({ identifier: r.identifier, note: r.note })),
                all_notes_to_add: [], id_indexes: [], inline_id_indexes: [], regex_id_indexes: [], notes_to_delete: [], markdownWarningLines: [], previewCandidates: ranges, global_tags: '', target_deck: 'Deck',
                formatter: { detectedMedia: new Set() }, removeUnsafeNewCards: noop }
        } })
    const api = { transport: invoke, Md5: { hashStr: hash }, FileManager: function(...args) { return createManager(...args) },
        uiFor: () => en => en, Notice: class {constructor(s) { notices.push(String(s)) }}, MarkdownView: class {}, TFolder: class {},
        DuplicatePreflight: class {}, registerRecordReview: noop, dismissMissingCardReview: noop, requireSettledZipImport: noop,
        createFullMigrationBackup: async () => { backups.push(marked.text); return 'backup.zip' },
        hasActiveLegacyPlugin: zero, hasPendingBidirectionalWrite: zero, readBackupSettings: () => ({ enabled: false }),
        resolveSyncScope: () => ({ allFiles: files, files, paths, contains: path => paths.has(path), label: 'Vault', signature: 'same' }),
        syncScopeSignature: () => 'same', scanProfileFreeSettings: value => value, changedMediaNotes: () => new Set(),
        isSyncAuditReportPath: zero, openExportPreview: (_app, rows, apply) => { dialogs.push({ rows, apply }) },
        checkCursorEditors: noop, readImageOptimization: noop, reconcileMediaNotes: zero, loadMediaIndex: noop,
        OneWayHistory: { open: async () => ({ flush: noop }) }, operationJournalPath: () => 'journal',
        ExportOperationJournal: class { async confirmFiles() {} async prepare() {} observe() {} }, ExportRecovery: { open: () => ({ get: noop, records: () => [] }) },
        settingToData: async (_app, settings, fields_dict) => ({ fields_dict, custom_regexps: settings.CUSTOM_REGEXPS || {} }),
        checkAnkiNoteExistence: async ids => new Map(ids.map(id => [id, [...cards.values()].some(c => c.note === id)])),
        checkWarmAnkiNoteExistence: async ids => new Map(ids.map(id => [id, true])), showAnkiProfileProblem: noop,
        parseExistingNoteSnapshot: row => row, parseExplicitLinkedField: noop, localizeExportError: x => x,
        auditRead: invoke, auditDeckForFile: noop, singleAuditDeck: noop, uiDiagnostic: (_text, message) => message,
    }
    const names = ['delimited-rule', 'bidirectional-sync', 'bidirectional-state', 'bidirectional-fields', 'anki-study-state', 'suspend-merge', 'deletion-policy', 'export-batch', 'archived-card', 'fast-scan', 'suspend-anki', 'anki-profile', 'anki-transport', 'anki', 'suspend-marker', 'suspend-label', 'anki-id-marker',
        'id-marker-literals', 'duplicate-markers', 'oneway-suspend', 'export-plan', 'linked-bullets', 'cursor-card', 'image-field-links', 'vault-id-index', 'deletion-source', 'card-export-diagnostics', 'markdown-pipeline', 'bidirectional-blocks',
        'bidirectional-markdown', 'page-card', 'card-format-presets', 'export-recovery']
    const modules = await load(names, api, { anki: "import { transport } from './mock-transport'; export const invoke = transport" })
    Manager = managerType({ ...api, ...modules['export-batch'], ...modules['suspend-marker'], AnkiConnect: {invoke},
        fastResult: value => value.error === null ? value.result : undefined,
        checkFastResponses: (_requests, response, errors) => errors.push(...response.flatMap(v => v.error ? [v.error] : [])),
        matchesReviewedAnkiEvidence: (row, evidence) => row && hash(JSON.stringify(row)) === evidence.snapshot, ...modules['card-export-diagnostics'], ...modules['deletion-source'], ...modules['oneway-suspend'], ...modules['cursor-card'],
        cardAtOffset: (file, _content, offset) => file.previewCandidates.find(r => r.start <= offset && offset < r.end),
        ...modules['linked-bullets'], ...modules['suspend-anki'],
        ...modules['export-plan'], snapshotKey: row => hash(JSON.stringify(row)),
        snapshotFields: row => Object.entries(row.fields).map(([name, field]) => [name, field.value]),
        AnkiProfileError: modules['anki-profile'].AnkiProfileError,
        recoverySlotLines: () => [], readRecoveryMarker: noop, frontmatterTags: () => [], collectNoteIds: t => modules['duplicate-markers'].findIdMarkers(t).map(m => m.id),
        findMarkdownSyntaxSpans: () => ({ code: [], math: [] }), diagnosticPatterns: {},
        frontmatterBounds: modules['markdown-pipeline'].frontmatterBounds, applyAuthoredTags: noop, mediaNames: v => new Set(v), readReviewedNoteSnapshots: async ids => new Map(ids.map(id => [id, flush(id)])),
        readFilteredAnkiDecks: map, plannedMediaAliases: map, planMedia: async () => [], applyMedia: async () => new Set(),
        sendExportBatches: allowDelete ? modules['export-batch'].sendExportBatches : async actions => { assert.equal(actions.length, 0); return { responses: [] } },
        verifyExistingNoteFieldWrites: noop, conflictingDeckDirective: noop, portableFileExportRules: noop,
    })
    return { register: modules['fast-scan'].registerFastScan, scan: modules['fast-scan'].scanVaultFast, preview: modules['fast-scan'].previewVaultExport,
        idle: modules['fast-scan'].waitForFastScanIdle, configuration: modules['cursor-card'].cursorConfiguration,
        delimitedRule: modules['delimited-rule'].delimitedRule, dialogs, plugin, calls, marked, plain, written, cards, reads, notices, regular,
        journal, deleted, backups, State: modules['bidirectional-state'].BidirectionalState, archive: modules['archived-card'] }
}

test('ordinary export forces custom numbered/all markers again after restart, without exporting unchanged siblings or touching unmarked files', async () => {
    const h = await fixture(), plugin = h.plugin()
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[701, 801]])
    assert.equal(h.cards.get(702).suspended, true)
    assert.equal(h.cards.get(703).suspended, false)
    assert.equal(h.cards.get(901).suspended, false)
    const restarted = h.plugin()
    restarted.file_hashes = { ...plugin.file_hashes }
    h.cards.get(701).suspended = false
    h.calls.length = 0; h.reads.length = 0; h.regular.length = 0
    assert.equal(await h.scan(restarted), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[701, 801], [701]])
    assert.deepEqual(h.reads, ['multi.md'])
    assert.deepEqual(h.regular, [[]])
    assert.equal(await h.scan(restarted), 'completed', h.notices.join('\n'))
    assert.equal(h.written.length, 2)
    assert.ok(!h.calls.includes('unsuspend'))
    h.marked.text = h.marked.text.replace(/Pause(?:_3)?\n/g, '')
    h.marked.stat.mtime++; h.marked.stat.size = h.marked.text.length
    h.calls.length = 0
    assert.equal(await h.scan(restarted), 'completed')
    assert.ok(!h.calls.includes('areSuspended'))
    h.calls.length = 0; h.reads.length = 0
    assert.equal(await h.scan(restarted), 'completed')
    assert.deepEqual(h.reads, [])
    assert.ok(!h.calls.includes('areSuspended'))
})

test('export preview includes independent suspension checkboxes and an empty selection has no side effects', async () => {
    const h = await fixture(), plugin = h.plugin()
    await h.preview(plugin)
    assert.equal(h.dialogs.length, 1, h.notices.join('\n'))
    const { rows, apply } = h.dialogs[0]
    assert.equal(rows.length, 1)
    assert.deepEqual(Array.from(rows[0].operations, op => [op.kind, op.id]), [['suspend', 7], ['suspend', 8]])
    assert.deepEqual(h.written, [])
    apply({ paths: new Map(), conflicts: new Set() })
    assert.deepEqual(h.written, [])
    const key = rows[0].operations.find(op => op.id === 8).key
    const select = { paths: new Map([[h.marked.path, new Set([key])]]), conflicts: new Set() }
    const outcome = await h.scan(plugin, false, false, new Set([h.marked.path]), new Map(), {
        expectedPreviewHashes: new Map([[h.marked.path, hash(h.marked.text)]]), previewSelection: select,
        omittedPreviewPaths: new Set([h.marked.path]),
    }, undefined, 'Demo')
    assert.deepEqual(h.written, [[801]], h.notices.join('\n'))
    assert.equal(h.cards.get(701).suspended, false)
    assert.equal(outcome, 'completed', h.notices.join('\n'))
})

test('cursor export reviews and applies suspension only to the selected note; competing marker in the same file is untouched', async () => {
    const h = await fixture(), plugin = h.plugin(), file = h.marked
    const card = { path: file.path, text: file.text, offset: file.text.indexOf('Q7'), id: 7,
        model: 'Basic', deck: 'Deck', profile: 'Demo', configuration: h.configuration(plugin) }
    await h.preview(plugin, undefined, undefined, card)
    assert.equal(h.dialogs.length, 1, h.notices.join('\n'))
    const operations = h.dialogs[0].rows[0].operations
    assert.deepEqual(Array.from(operations, op => op.id), [7])
    assert.deepEqual(h.written, [])
    const previewSelection = { paths: new Map([[file.path, new Set([operations[0].key])]]), conflicts: new Set() }
    assert.equal(await h.scan(plugin, false, false, new Set([file.path]), new Map(), {
        expectedPreviewHashes: new Map([[file.path, hash(file.text)]]), previewSelection,
        omittedPreviewPaths: new Set([file.path]), cursorCard: card,
    }, new Map(), 'Demo'), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[701]])
    assert.equal(h.cards.get(702).suspended, true)
    assert.equal(h.cards.get(801).suspended, false)
})

test('an absent ordinal or a changed preview cannot suspend an unreviewed sibling', async () => {
    const h = await fixture(), plugin = h.plugin(), file = h.marked
    await h.preview(plugin)
    const old = h.dialogs[0].rows[0].operations.find(op => op.id === 7)
    h.cards.get(701).ord = 4
    h.cards.get(703).ord = 2
    const previewSelection = { paths: new Map([[file.path, new Set([old.key])]]), conflicts: new Set() }
    const result = await h.scan(plugin, false, false, new Set([file.path]), new Map(), {
        expectedPreviewHashes: new Map([[file.path, hash(file.text)]]), previewSelection,
    }, new Map(), 'Demo')
    assert.equal(result, 'failed')
    assert.deepEqual(h.written, [])
    file.text = file.text.replace('Pause_3', 'Pause_2')
    file.stat.mtime++
    assert.equal(await h.scan(plugin), 'failed')
    assert.deepEqual(h.written, [])
    assert.ok(h.notices.some(text => text.includes('Unknown card number')))
})

test('ordinary preview states the actual Markdown deletion effect and changes its approval key when opt-ins change', async () => {
    const h = await fixture(), plugin = h.plugin()
    h.marked.text = '## Cards\n- Q :: A\nDELETE\nID: 7\n\nDELETE\nID: 70\n'
    h.plain.text = '# Capitals #anki-page\nDELETE\nID: 9\n\nLondon'
    h.cards.delete(901)
    plugin.settings.CUSTOM_REGEXPS = { Basic: '@page' }
    const review = async (clean, trash) => {
        plugin.settings.CLEAN_DELETED_BLOCKS = clean
        plugin.settings.TRASH_DELETED_PAGES = trash
        await h.preview(plugin)
        const latest = h.dialogs.at(-1)
        assert.ok(latest, h.notices.join('\n'))
        assert.equal(latest.rows.length, 2, JSON.stringify(latest.rows))
        return new Map(Array.from(latest.rows).flatMap(row => Array.from(row.operations || [], op => [op.id, op])))
    }
    const markOnly = await review(false, true)
    assert.deepEqual({ ...markOnly.get(7).deletion }, { local: 'clear-command', alreadyAbsent: false })
    assert.deepEqual({ ...markOnly.get(9).deletion }, { local: 'clear-command', alreadyAbsent: true })
    plugin.settings.MARK_DELETED_BLOCKS = true
    const archived = await review(false, false)
    assert.equal(archived.get(7).deletion.local, 'mark-block')
    assert.equal(archived.get(9).deletion.local, 'mark-block')
    assert.equal(archived.get(70).deletion.local, 'clear-command-and-id')
    assert.notEqual(archived.get(7).key, markOnly.get(7).key)
    plugin.settings.MARK_DELETED_BLOCKS = false
    const blocks = await review(true, false)
    assert.deepEqual({ ...blocks.get(7).deletion }, { local: 'remove-block', alreadyAbsent: false })
    assert.deepEqual({ ...blocks.get(9).deletion }, { local: 'clear-command', alreadyAbsent: true })
    assert.deepEqual({ ...blocks.get(70).deletion }, { local: 'clear-command-and-id', alreadyAbsent: true })
    assert.notEqual(blocks.get(7).key, markOnly.get(7).key)
    const pages = await review(true, true)
    assert.deepEqual({ ...pages.get(9).deletion }, { local: 'trash-page', alreadyAbsent: true })
    assert.notEqual(blocks.get(9).key, pages.get(9).key)
    assert.deepEqual(h.written, [])
})

test('warm check rejects externally replaced bytes with the same size and timestamp and reindexes before retry', async () => {
    const h = await fixture(), plugin = h.plugin()
    assert.equal(await h.scan(plugin), 'completed')
    h.marked.text = h.marked.text.replace('Q7', 'R7')
    h.cards.get(701).suspended = false
    assert.equal(await h.scan(plugin), 'failed')
    assert.deepEqual(h.written, [[701, 801]])
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[701, 801], [701]])
})

test('normal one-way export ignores archived content and its pause marker on both cold and warm passes', async () => {
    const h = await fixture()
    const original = '## Cards\n<!--RUDONIUM-ARCHIVE:7-->\n- Q7 :: old material\nPause_3\n<!--ID: 7 -->\n\n**Deleted from Anki**\n<!--/RUDONIUM-ARCHIVE:7-->\n- Q8 :: ~~still active~~\nPause\n<!--ID: 8 -->\n'
    h.marked.text = original
    h.marked.stat.size = Buffer.byteLength(original)
    const plugin = h.plugin()
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[801]])
    assert.ok(h.regular.flat().includes(8))
    assert.ok(!h.regular.flat().includes(7))
    h.cards.get(801).suspended = false
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[801], [801]])
    assert.equal(h.cards.get(701).suspended, false)
    assert.equal(h.marked.text, original)
})

test('ordinary one-way export executes the custom DELETE command using each of the five source policies', async () => {
    const del = 'Retire.[x]?'
    const source = '- Q7 :: A\r\n<!--ID: 7 -->\r\n'
    const neighbor = '- Q8 :: A\r\n<!--ID: 8 -->\r\n\r\nUnpublished draft :: leave alone\r\n'
    for (const mode of ['keep', 'remove', 'mark', 'strike', 'hidden']) {
        const h = await fixture(true), plugin = h.plugin()
        plugin.settings.AFTER_DELETE_MODE = mode
        plugin.settings.Syntax['Delete Note Line'] = del
        h.marked.text = '## Cards\r\n' + source.replace('<!--ID:', del + '\r\n<!--ID:') + neighbor
        h.marked.stat.size = Buffer.byteLength(h.marked.text)
        const before = h.marked.text
        // Older two-way confirmation must retire before one-way cleanup consumes the command.
        const statePath = '.obsidian/plugins/rudonium/bidirectional-sync.json'
        const store = await h.State.open(plugin.app.vault.adapter, statePath, 'Demo')
        const record = { base: { front: 'Q7', back: 'A', tags: [] }, deletionSource: 'a'.repeat(32) }
        await store.checkpoint([[7, record], [8, record]])
        assert.equal(await h.scan(plugin), 'completed', mode + '\n' + h.notices.join('\n'))
        assert.deepEqual(h.deleted, [7], mode)
        assert.ok(!h.cards.has(701) && !h.cards.has(702) && !h.cards.has(703))
        assert.ok(h.cards.has(801), mode)
        assert.ok(h.marked.text.endsWith(neighbor))
        assert.ok(!h.marked.text.includes(del), mode)
        if (mode === 'keep') assert.equal(h.marked.text, before.replace(del+'\r\n',''))
        else if (mode === 'remove') assert.equal(h.marked.text,'## Cards\r\n'+neighbor)
        else {
            assert.deepEqual(Array.from(h.archive.archivedCardRanges(h.marked.text), r => [r.id, r.style]), [[7,mode]])
            assert.ok(!h.archive.activeCardMarkdown(h.marked.text).includes('Q7 :: A'))
            assert.ok(h.backups.includes(before))
        }
        const saved = h.marked.text
        const after = await h.State.open(plugin.app.vault.adapter, statePath, 'Demo')
        assert.equal(after.get(7), undefined)
        assert.equal(after.get(8).deletionSource, record.deletionSource)
        for (const next of ['keep','remove','mark','strike','hidden']) {
            plugin.settings.AFTER_DELETE_MODE = next
            await h.scan(plugin)
            assert.equal(h.marked.text, saved, mode + ' → ' + next)
        }
        assert.deepEqual(h.deleted, [7])
    }
})


test('ordinary export detects an external space in the active saved file despite stale stats and absent events', async () => {
    const h = await fixture(), plugin = h.plugin()
    plugin.app.workspace.getActiveFile = () => h.plain
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    const before = plugin.file_hashes[h.plain.path]
    h.reads.length = 0
    h.plain.text = h.plain.text.replace('Q9', 'Q 9')
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.ok(h.reads.includes(h.plain.path))
    assert.notEqual(plugin.file_hashes[h.plain.path], before)
    assert.equal(plugin.file_hashes[h.plain.path], hash(h.plain.text))
    plugin.app.workspace.getActiveFile = () => null
    h.plain.text += ' '
    h.plain.stat.size++
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.equal(plugin.file_hashes[h.plain.path], hash(h.plain.text))
})

test('current-note scan reports an unmatched source by path', async () => {
    const h = await fixture(), plugin = h.plugin()
    plugin.app.workspace.getActiveFile = () => h.plain
    h.plain.text = 'No recognized card in this file.'
    h.plain.stat.size = Buffer.byteLength(h.plain.text)
    assert.equal(await h.scan(plugin, false, true), 'completed', h.notices.join('\n'))
    assert.ok(h.notices.some(text => text.includes('plain.md') && text.includes('No cards matched')), h.notices.join('\n'))
})

test('current file command pins its Markdown file before waiting, including both cards and excluding the next tab', async () => {
    const h = await fixture(), plugin = h.plugin()
    const commands = new Map()
    plugin.addCommand = cmd => commands.set(cmd.id, cmd)
    let active = h.marked
    plugin.app.workspace.getActiveFile = () => active
    h.register(plugin)
    const command = commands.get('anki-scan-current-note')
    assert.equal(command.name, 'Sync Current File with Anki')
    const run = command.callback()
    active = h.plain
    await run
    assert.deepEqual(h.written, [[701, 801]], h.notices.join('\n'))
    assert.equal(h.cards.get(901).suspended, false)
    assert.equal(Object.hasOwn(plugin.file_hashes, h.plain.path), false)
    active = null
    await command.callback()
    assert.match(h.notices.at(-1), /Open a Markdown file/)
    assert.equal(h.written.length, 1)
})


test('one-way command verifies generated-rule fields once per model; reordering prevents writes and preserves retry', async () => {
    const live = ['Back', 'Front']
    const h = await fixture(false, live), plugin = h.plugin()
    plugin.settings.CUSTOM_REGEXPS = { Basic: h.delimitedRule(2, ':') }
    plugin.settings.REGEXP_WIZARD_FIELDS = { Basic: ['Front', 'Back'] }
    assert.equal(await h.scan(plugin), 'failed')
    assert.equal(h.calls.filter(action => action === 'modelFieldNames').length, 1)
    assert.equal(h.written.length, 0, 'nothing from the affected file was sent')
    assert.ok(!plugin.file_hashes[h.marked.path], 'file can be retried without another edit')
    const report = JSON.parse([...h.journal].find(([p]) => p.endsWith('last-export-report.json'))[1])
    assert.ok(report.files.every(row => row.errors.some(msg => msg.includes('rule wizard'))))
    // Refreshing a cached schema alone must not silently rebind the positional data.
    plugin.fields_dict.Basic = [...live]
    assert.equal(await h.scan(plugin), 'failed')
    assert.equal(h.written.length, 0)
    plugin.fields_dict.Basic = ['Front', 'Back']
    live.splice(0, live.length, 'Front', 'Back', 'Optional new field')
    assert.equal(await h.scan(plugin), 'completed')
    assert.ok(h.written.length)
})


test('one-way page export suspends only the requested template with a signed footer and private examples', async () => {
    const h = await fixture(), plugin = h.plugin()
    plugin.settings.CUSTOM_REGEXPS = { Basic: '@page' }
    const rows = ['# Q #anki-page', 'Pause_3', 'Answer', '<!--ID: 7 @page-->', '<!--rudonium-answer-end-->', 'Pause', 'ID: 8']
    const set = text => { h.marked.text = text; h.marked.stat.size = Buffer.byteLength(text); h.marked.stat.mtime++ }
    const initial = rows.join('\r\n')
    set(initial)
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[701]], h.notices.join('\n'))
    assert.equal(h.marked.text, initial)
    set(initial.replace('Pause_3\r\n',''))
    assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
    assert.deepEqual(h.written, [[701]])
    assert.equal(h.cards.get(801).suspended,false)
    assert.ok(!h.calls.includes('unsuspend'))
})


for (const placement of ['heading', 'yaml', 'after-answer']) {
    test('one-way page commands target only the linked note, with an ID at ' + placement, async () => {
        const h = await fixture(true), plugin = h.plugin()
        plugin.settings.CUSTOM_REGEXPS = { Basic: '@page' }
        plugin.settings.AFTER_DELETE_MODE = 'keep'
        plugin.settings.Syntax['Delete Note Line'] = 'Метка[.]'
        const shell = [...(placement === 'yaml' ? ['---', 'anki-page-ID: "7" # keep', '---'] : []),
            '# Q', 'COMMAND', ...(placement === 'heading' ? ['<!--ID: 7 -->'] : []), 'A',
            ...(placement === 'after-answer' ? ['<!--ID: 7 @page-->'] : []),
            '<!--rudonium-answer-end-->', '#anki-page', 'Метка[.]', 'ID: 8'].join('\r\n')
        const edit = command => {
            h.marked.text = shell.replace('COMMAND\r\n', command ? command + '\r\n' : '')
            h.marked.stat.size = Buffer.byteLength(h.marked.text)
            h.marked.stat.mtime++
        }
        edit('pAuSe_3')
        assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
        assert.deepEqual(h.written, [[701]], h.notices.join('\n'))
        edit(undefined)
        assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
        assert.ok(h.cards.get(701).suspended)
        edit('мЕТкА[.]')
        assert.equal(await h.scan(plugin), 'completed', h.notices.join('\n'))
        assert.deepEqual(h.deleted, [7])
        assert.equal(h.marked.text, shell.replace('COMMAND\r\n', ''))
        assert.ok(h.cards.has(801))
        assert.ok(!h.calls.includes('unsuspend'))
        await h.scan(plugin)
        assert.deepEqual(h.deleted, [7])
    })
}
