// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')

test('audit restore after Anki Undo respects marked, hidden, and struck owners in the warm vault index and in unsaved editors', async () => {
    class MarkdownView {}
    const open = []
    const id = 57
    const { 'vault-id-index': { indexVaultIds }, 'anki-source-restore': { prepareAnkiSourceRestore },
        'archived-card': { wrapArchivedCard } } = await load(
        ['vault-id-index', 'anki-source-restore', 'archived-card', 'duplicate-markers'],
        { MarkdownView, uiFor: () => en => en, hasPendingAnkiWrite: () => false, hasPendingBidirectionalWrite: () => false,
            isSyncAuditReportPath: () => false, settingsWithoutAuditMode: s => s, requireExpectedAnkiProfile: async () => 'User',
            withFastScanReadLock: async (_p, fn) => fn(() => 1, () => 1),
            auditRead: async (action, params) => {
                assert.equal(action, 'notesInfo'); assert.deepEqual(Array.from(params.notes), [id])
                return [{ noteId: id, modelName: 'Basic', tags: [], fields: { Front:{order:0,value:'Old'}, Back:{order:1,value:'Old answer'} } }]
            },
        })
    const forms = new Set()
    for (const mode of ['mark', 'hidden', 'strike']) {
        const archive = wrapArchivedCard('- Бывшая карточка :: Ответ\r\n<!--ID: 57-->', id, 'Deleted from Anki', false, '\r\n', mode)
        assert.ok(!forms.has(archive), mode + ' must produce its own storage form')
        forms.add(archive)
        const make = (path, text) => ({ path, text, stat: { ctime: 1, mtime: 2, size: text.length } })
        const former = make('History.md', '# История\r\n\r\n' + archive + '\r\n'), dest = make('Atlas.md','Atlas')
        const files = [former, dest]
        let reads = 0
        const plugin = { settings: { Syntax:{}, Defaults:{}, FILE_LINK_FIELDS:{}, CONTEXT_FIELDS:{} },
            fields_dict: { Basic:['Front','Back'] }, app: {
                workspace: { getLeavesOfType: () => open }, vault: { getMarkdownFiles: () => files, getName: () => 'Vault',
                    getAbstractFileByPath: p => files.find(f => f.path === p), read: async f => { reads++; return f.text } },
            } }
        const index = await indexVaultIds(plugin, files, {}, () => 1)
        assert.equal(index.first.has(id), false, 'normal inventory must not introduce an active card')
        const oldReads = reads
        const conflict = error => error.code === 'duplicate' && error.message.includes('History.md, line 3')
        await assert.rejects(prepareAnkiSourceRestore(plugin, id, 'User', { path: dest.path }), conflict)
        assert.equal(reads, oldReads, 'reuse the warm index for ownership')
        const editor = Object.assign(new MarkdownView(), { file: former, data: 'No archive on disk', getViewData: () => former.text, getMode: () => 'source' })
        open.push({ view: editor })
        await assert.rejects(prepareAnkiSourceRestore(plugin, id, 'User', { path: dest.path }), conflict)
        open.pop()
        assert.equal(dest.text, 'Atlas')
    }
})
