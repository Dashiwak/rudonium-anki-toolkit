// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { file, note, host } = require('./benchmark/lost-id-host.cjs')

test('Lost-ID recovery ignores archived sources, restores an active neighbor using raw offsets, and preserves user strikethrough', async () => {
    const retired = ['<!--RUDONIUM-ARCHIVE:81-->', '- Retired :: Answer', '<!--ID: 81-->', '', '**Удалено из Anki**', '<!--/RUDONIUM-ARCHIVE:81-->'].join('\r\n')
    const lines = ['## Cards', retired, '', '- Still ~~important~~ :: Answer', '', '- Linked :: Answer', '<!--ID: 84-->', '']
    const source = file('Knowledge/Atlas.md', lines.join('\r\n'))
    const original = source.text
    const pageLines = ['---','title: Historic','---','<!--RUDONIUM-ARCHIVE:91-->','# Old page #anki-page','<!--ID: 91-->', '',
        '- Hidden example :: Answer', '', '**Deleted from Anki**','<!--/RUDONIUM-ARCHIVE:91-->','']
    const page = file('Knowledge/Archive.md', pageLines.join('\r\n'))
    const env = await host([source, page], [note(82, 'Still ~~important~~'), note(84, 'Linked'), note(99, 'Hidden example')])
    const plan = await env.scan()
    const selected = plan.rows.filter(row => row.status === 'match')
    assert.deepEqual(Array.from(selected, row => row.id), [82])
    assert.equal(plan.unlinked, 1)
    const result = await env.apply(plan, new Map(selected.map(row => [row.key, row.id])))
    assert.equal(result.stopped, undefined, result.stopped)
    assert.equal(result.restored, 1)
    assert.equal(source.text, original.replace('~~important~~ :: Answer', '~~important~~ :: Answer\r\n<!--ID: 82-->'))
    assert.equal((await env.scan()).unlinked, 0)
    assert.equal(page.text, pageLines.join('\r\n'))
})

test('Cold and warm deck audit inventories exclude archived IDs even when the same number reappears in an active note', async () => {
    const { load } = require('./benchmark/migration-modules.cjs')
    const retired = ['<!--RUDONIUM-ARCHIVE:81-->', '- Historical :: A', '<!--ID: 81-->', '', '**Deleted from Anki**', '<!--/RUDONIUM-ARCHIVE:81-->'].join('\n')
    const sources = [file('Cards/history.md', '## Cards\n' + retired + '\n' + '- New :: Value\n<!--ID: 82-->\n'), file('Cards/live.md', '## Cards\n- Current :: A\n<!--ID: 81-->\n')]
    const snapshots = new Map(sources.map(f => [f.path, f.text]))
    const queried = []
    const api = {
        withFastScanReadLock: async (_p, cb) => cb(() => 0, () => 0, () => 0),
        resolveSyncScope: () => ({ allFiles: sources, paths: new Set(snapshots.keys()), signature: 'all', label: 'All' }),
        syncScopeSignature: () => 'all', settingsWithoutAuditMode: s => ({...s}), scanProfileFreeSettings: s => s,
        expectedAnkiProfile: () => 'QA', readActiveAnkiProfile: async () => 'QA', cachedImageAliases: async () => new Map(),
        settingToData: (_app, _s, dict) => ({ fields_dict: dict, custom_regexps: {}, NOTE_REGEXP: /(?!)/g, INLINE_REGEXP: /(?!)/g, EMPTY_REGEXP: /(?!)/g }),
        FileManager: class { parseMarkdown(_f, _s, _ids, _audit, _models, bullets) {
            return { notes_to_edit: [], notes_to_delete: [], all_notes_to_add: [], auditNoteRanges: [],
                global_tags: '', target_deck: undefined, formatter: { detectedMedia: new Set() } }
        } },
        readRecoveryMarker: () => undefined, authoredCardTagOverrides: () => undefined, syncAuditDeckKey: x => x,
        AuditNoteSnapshots: class { remember() {} }, parseExistingNoteSnapshot: () => undefined,
        classifyAuditFieldChanges: () => {}, attachmentDeckMembers: () => undefined, rememberAuditAttachmentSources: () => {},
        auditRead: (action, {notes}) => {
            assert.equal(action, 'notesInfo')
            queried.push(...notes)
            return notes.map(id => ({ noteId: id, modelName: 'Basic', fields: { Front: {}, Back: {} } }))
        },
        runSyncAudit: inventory => ({...inventory, ankiErrors: [], ankiInventoryComplete: true, vaultInventoryComplete: true}),
    }
    const real = ['vault-sync-audit', 'anki-id-marker', 'id-marker-literals', 'duplicate-markers', 'linked-bullets']
    const mods = await load([...real, 'anki'], api, { anki: 'export {}' })
    const plugin = { settings: { Defaults: { Deck: 'Knowledge' }, Syntax: {} }, fields_dict: { Basic:['Front','Back'] }, app: {
        vault: { getName: () => 'QA', read: f => f.text }, workspace: { getLeavesOfType: () => [], getActiveFile: () => null } } }
    for (let pass = 0; pass < 2; pass++) {
        const result = await mods['vault-sync-audit'].auditPluginSync(plugin)
        assert.deepEqual(Array.from(result.fileErrors, v => v.message), [])
        assert.deepEqual(Array.from(result.sources, v => [v.path, v.id]), [['Cards/history.md',82], ['Cards/live.md',81]])
        assert.equal(result.duplicateIds.length, 0)
        assert.equal(result.unlinked.length, 0)
        assert.equal(result.unparsedIds.length, 0)
        for (const source of sources) assert.equal(source.text, snapshots.get(source.path))
    }
    assert.deepEqual([...new Set(queried)].sort(), [81,82])
})
