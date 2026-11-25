// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { managerType } = require('./benchmark/patched-manager.cjs')
const { load } = require('./benchmark/migration-modules.cjs')
const noop = () => {}
const hash = s => createHash('md5').update(s).digest('hex')
const marker = { 'Delete Note Line': 'Retire.?' }
const input = '## Cards\n- A :: B\nRetire.?\n<!--ID: 7 -->\n- Keep :: This\nID: 8\n- C :: D\nRetire.?\nID: 9\n'
const allNames = ['suspend-label', 'archived-card', 'markdown-pipeline', 'deletion-source', 'bidirectional-blocks', 'bidirectional-markdown', 'linked-bullets', 'page-card',
    'card-format-presets', 'export-recovery', 'anki-id-marker', 'duplicate-markers', 'id-marker-literals', 'anki', 'export-plan', 'export-batch', 'anki-transport']
async function fixture(text = input, options = {}) {
    const vaultFile = { path: 'cards.md', text }
    const h = { active: 'personal', present: new Set([7,8,9]), writes: [], backups: [], trash: [], ...options }
    const check = async profile => { if (h.active !== profile) throw Error('Anki profile switched'); return profile }
    const readSnapshot = ids => new Map(ids.filter(id => h.present.has(id)).map(id => [id, { modelName: 'Basic', noteId: id, cards:[id+100], tags:[], fields:{Front:{value:"Question " + id}} }]))
    const call = async (action, params) => {
        assert.equal(action, 'multi')
        return params.actions.map(request => {
            assert.equal(request.action, 'deleteNotes')
            h.writes.push([...request.params.notes])
            if (!h.error) for (const id of request.params.notes) if (h.refuseId !== id) h.present.delete(id)
            return { result: null, error: h.error ?? null }
        })
    }
    const api = { Md5: { hashStr: hash }, isRecoveryTag: () => false, checkPinnedAnkiProfile: check, transport: call,
        checkAnkiNoteExistence: async ids => new Map(ids.map(id => [id, h.present.has(id)])) }
    const modules = await load(allNames, api, { anki: "import { transport } from './host'; export const invoke = transport" })
    const { explicitDeletes } = modules['deletion-source']
    const app = { vault: { configDir: '.obsidian', adapter: {
        exists: async path => path === '.obsidian/app.json' && h.preferences !== undefined,
        read: async () => JSON.stringify(h.preferences) },
        read: async f => { if (h.switchOnTrashRead && h.writes.length) h.active = 'other'; return f.text },
        process: async (f,change) => { if (h.failProcess) throw Error('disk busy'); f.text = change(f.text) },
        getAbstractFileByPath: path => !h.trash.length && path === vaultFile.path ? vaultFile : null,
    }, fileManager: { trashFile: async f => h.trash.push(f.path) } }
    const Manager = managerType({ ...api, ...modules['anki-id-marker'], ...modules['suspend-label'], ...modules['duplicate-markers'], ...modules['deletion-source'], ...modules['export-plan'], ...modules['export-batch'], AnkiConnect: {invoke: call},
        AnkiProfileError: class extends Error {}, readReviewedNoteSnapshots: async ids => readSnapshot(ids),
        snapshotKey: n => JSON.stringify([n.noteId,n.modelName]), snapshotFields: note => Object.entries(note.fields).map(([name, field]) => [name, field.value]),
        matchesReviewedAnkiEvidence: (n,e) => n && JSON.stringify([n.noteId,n.modelName]) === e.snapshot,
        recoverySlotLines: () => [], planMedia: async () => [], applyMedia: async () => new Set(), plannedMediaAliases: () => new Map(),
        verifyExistingNoteFieldWrites: noop, readFilteredAnkiDecks: async () => new Map(), conflictingDeckDirective: noop,
        fastResult: envelope => envelope?.error === null ? envelope.result : undefined,
        checkFastResponses: (_requests, res, errors) => { for (const r of res) if (r.error) errors.push(r.error) },
    })
    h.run = async selected => {
        const plan = explicitDeletes(vaultFile.text, marker, { Basic: '@page' })
        if (!plan && !h.spacing) return
        const m = Object.assign(new Manager(), { app, files: [vaultFile], data: { id_date: h.dates === true, custom_regexps: { Basic: '@page' } },
            diagnosticSyntax: marker, ankiProfile:'personal', checkAnkiProfile: () => check('personal'),
            onSyncChange:h.onSyncChange, afterDeleteMode: h.mode ?? (h.clean !== false ? 'remove' : h.archiveLabel ? 'mark' : 'keep'),
            trashDeletedPages: h.trashPages ?? true, deletedArchiveLabel: h.archiveLabel,
            deletionOwnership: async () => { if (h.duplicate) throw Error('duplicate owner') },
            beforeDeletion: async () => { if (h.failBackup) throw Error('backup failed'); h.backups.push(vaultFile.text) },
            prepareExistingUpdates:noop, importErrors:[], getRecovery: async () => ({ get: noop, records: () => [] }),
            ownFiles: [{ path: vaultFile.path, target_deck:'deck', global_tags:'', original_file:vaultFile.text, file:vaultFile.text,
                all_notes_to_add:[], id_indexes:[], inline_id_indexes:[], regex_id_indexes:[], notes_to_delete:(plan?.directives ?? []).map(d => d.id), notes_to_edit: (h.dateIds ?? []).map(identifier => ({ identifier, note: { fields: {}, tags: [] } })), note_ids:[], formatter:{detectedMedia:new Set()} }],
        })
        m.deleteEffects.set(m.ownFiles[0], new Map((plan?.directives ?? []).map(d => [d.id,
            modules['deletion-source'].localDeleteEffect(d,m.afterDeleteMode,m.trashDeletedPages)])))
        if (h.spacing) {
            const file = m.ownFiles[0]
            const note = { modelName: 'Basic', fields: { Front: 'Казематы' }, tags: [] }
            file.notes_to_edit = [{ identifier: 8, note }]
            file.separatorRepairs = new Map([[note, modules['card-format-presets'].separatorRepair(h.spacing, true)]])
        }
        if (selected) {
            await m.reviewDeletions(m.ownFiles, true)
            if (h.dates) m.reviewDateMarkers(m.ownFiles[0], modules['anki-id-marker'].formatLocalIdDate(new Date()), true)
            const keys = m.previewOperations.get(vaultFile.path).filter(op => selected.includes(op.id)).map(op => op.key)
            m.previewSelection = { paths: new Map([[vaultFile.path,new Set(keys)]]), conflicts: new Set() }
        }
        await m.requests_1()
        return m
    }
    h.file = vaultFile
    h.archives = modules['archived-card'].archivedCardRanges
    return h
}

test('approved one-way DELETE removes the chosen block only; a failed partial Anki deletion retains its source', async () => {
    const h = await fixture()
    await h.run([7])
    assert.deepEqual(h.writes, [[7]])
    assert.equal(h.file.text, input.replace('- A :: B\nRetire.?\n<!--ID: 7 -->\n',''))
    assert.equal(h.backups[0],input)
    h.refuseId = 9
    const stale = h.file.text
    const result = await h.run()
    assert.equal(h.file.text, stale)
    assert.ok(result.retryPaths.has(h.file.path))
    delete h.refuseId
    await h.run()
    assert.equal(h.file.text,'## Cards\n- Keep :: This\nID: 8\n')
})

test('retry completes local cleanup after failed write without sending deleteNotes a second time', async () => {
    const h = await fixture(input, { failProcess:true })
    await h.run()
    assert.equal(h.file.text,input)
    assert.equal(h.writes.length,1)
    h.failProcess = false
    await h.run()
    assert.equal(h.writes.length,1)
    assert.equal(h.file.text,'## Cards\n- Keep :: This\nID: 8\n')
})

test('backup, unique ownership and Anki errors preserve authored commands', async () => {
    for (const flag of ['failBackup','duplicate']) {
        const h = await fixture(input, { [flag]:true })
        await assert.rejects(h.run())
        assert.equal(h.writes.length,0)
        assert.equal(h.file.text,input)
    }
    const h = await fixture(input, { error:'Anki refused' })
    await h.run()
    assert.equal(h.file.text,input)
})

test('whole-page DELETE verifies profile after the last vault read, retries using the Obsidian trash preference', async () => {
    const page = '# Capital #anki-page\nRetire.?\nID: 7\nParis'
    const h = await fixture(page,{switchOnTrashRead:true})
    await h.run()
    assert.deepEqual(h.trash,[])
    assert.equal(h.file.text,page)
    h.switchOnTrashRead = false
    h.active = 'personal'
    await h.run()
    assert.deepEqual(h.trash,[h.file.path])
    assert.equal(h.writes.length,1)
})

test('one-way archive preserves exact authored block, ID, neighbors and original strikethrough; retry cannot delete twice', async () => {
    const sample = input.replace('A :: B', 'A :: ~~old~~ B').replaceAll('\n', '\r\n')
    const h = await fixture(sample, { clean: false, archiveLabel: 'Удалено из Anki', failProcess: true })
    await h.run([7])
    assert.deepEqual(h.writes, [[7]])
    assert.equal(h.file.text, sample)
    h.failProcess = false
    await h.run([7])
    assert.deepEqual(h.writes, [[7]])
    assert.equal(h.backups[0], sample)
    assert.match(h.file.text, /Удалено из Anki/u)
    assert.equal(h.file.text.includes('- A :: ~~old~~ B\r\n<!--ID: 7 -->'), true)
    assert.ok(h.file.text.endsWith(sample.slice(sample.indexOf('- Keep :: This'))))
    const refused = await fixture(sample, { clean: false, archiveLabel: 'Deleted from Anki', refuseId: 7 })
    await refused.run([7])
    assert.equal(refused.file.text, sample, 'retaining a live ID cannot add archival metadata')
})

test('unrepresentable archive aborts before dispatching deleteNotes', async () => {
    const page = '# Capital #anki-page\nRetire.?\nID: 7\n\nParis\n~~~text\nunfinished example'
    const h = await fixture(page, { clean: false, archiveLabel: 'Deleted from Anki' })
    await assert.rejects(h.run(), /archive|архив/i)
    assert.equal(h.file.text, page)
    assert.equal(h.writes.length, 0)
    assert.equal(h.present.has(7), true)
})

test('an active full-page DELETE cannot include a previously archived card in its source', async () => {
    const archive = '<!--RUDONIUM-ARCHIVE:8-->\n- Saved :: A\nID: 8\n\n**Deleted from Anki**\n<!--/RUDONIUM-ARCHIVE:8-->'
    const page = '# Current #anki-page\nRetire.?\nID: 7\n\nAnswer\n\n' + archive
    const h = await fixture(page, { clean: true, trashPages: true })
    await assert.rejects(h.run(), /overlaps an archived card/)
    assert.equal(h.file.text, page)
    assert.equal(h.writes.length, 0)
    assert.deepEqual(h.trash, [])
})

for (const mode of ['strike','hidden']) {
    test('explicit one-way ' + mode + ' is applied only after a confirmed Anki deletion; retry never changes a sibling', async () => {
        const source = '## Cards\r\n- Front :: ~~author markup~~ 🗺️\r\nRetire.?\r\n<!--ID: 7 -->\r\n- Keep :: This\r\nID: 8\r\n'
        const h = await fixture(source, { mode, refuseId: 7, archiveLabel: 'Удалено из Anki' })
        await h.run([7])
        assert.deepEqual(h.writes, [[7]])
        assert.equal(h.file.text, source)
        delete h.refuseId
        h.failProcess = true
        await h.run([7])
        assert.equal(h.present.has(7), false)
        assert.equal(h.file.text, source)
        h.failProcess = false
        const retry = await h.run([7])
        assert.deepEqual(h.writes, [[7], [7]], 'retry after disk failure performs no second remote deletion')
        assert.equal(h.archives(h.file.text)[0]?.style, mode, JSON.stringify([h.file.text, [...retry.retryPaths], retry.importErrors]))
        assert.ok(h.file.text.endsWith('- Keep :: This\r\nID: 8\r\n'))
        const archived = h.file.text
        await h.run()
        assert.equal(h.file.text, archived)
        assert.deepEqual(h.trash, [])
    })
}

test('one-way preview writes only the selected date or DELETE and preserves other IDs', async () => {
    const initial = input.replace('ID: 8','ID: 8!? | 2024-02-29 #keep').replace('ID: 9','ID: 9?!')
    const rows = []
    const h = await fixture(initial, { dates:true, dateIds:[8], clean:false, onSyncChange:row=>rows.push(row) })
    await h.run([8])
    assert.equal(h.file.text, initial.replace('8!? | 2024-02-29','8 | 2024-02-29!?'))
    assert.deepEqual(h.writes,[])
    assert.deepEqual(rows.map(row=>[row.noteId,row.action,row.direction]),[[8,'id-date','local']])
    assert.ok(rows[0].fields[0].after.includes('2024-02-29'))
    await h.run([9])
    assert.deepEqual(h.writes,[[9]])
    assert.ok(h.file.text.includes('- C :: D\nID: 9?!\n'))
})

test('one-way export deletes only the page, even with another DELETE command below the private boundary', async () => {
    const tail = '<!--rudonium-answer-end-->\r\nPrivate :: Translation\r\nRetire.?\r\nID: 8\r\n'
    for (const location of ['heading','yaml','after-answer']) for (const mode of ['keep','mark','strike','hidden','remove']) {
        const props = ['---','topic: example',...(location === 'yaml' ? ['anki-page-ID: "7"'] : []),'---',''].join('\r\n')
        const content = props + '# Question #anki-page\r\nRetire.?\r\n' +
            (location === 'heading' ? 'ID: 7\r\n' : '') + 'Answer\r\n' + (location === 'after-answer' ? '<!--ID: 7 @page-->\r\n' : '') + tail
        const h = await fixture(content,{mode, archiveLabel:'Deleted from Anki'})
        await h.run([7])
        assert.deepEqual(h.writes,[[7]])
        assert.ok(!h.present.has(7) && h.present.has(8))
        assert.deepEqual(h.trash,[])
        assert.ok(h.file.text.endsWith(tail.slice(tail.indexOf('\r\n')+2)))
        h.mode = 'remove'
        await h.run()
        h.mode = 'keep'
        await h.run()
        assert.deepEqual(h.writes,[[7]])
    }
})


test('a DELETE word at the end of the public answer is ordinary text above a signed footer', async () => {
    const source = ['# Q #anki-page','Answer','Retire.?','<!--ID: 7 @page-->',''].join('\n')
    const h = await fixture(source)
    await h.run()
    assert.deepEqual(h.writes,[])
    assert.ok(h.present.has(7))
    assert.equal(h.file.text,source)
})

test('export history records verified deletions and distinguishes later local cleanup from repeating a deletion', async () => {
    const rows = []
    const h = await fixture(input, {failProcess:true, onSyncChange:row => rows.push(row)})
    await h.run()
    assert.deepEqual(rows.map(row => [row.action,row.direction,row.noteId]), [['delete','to-anki',7],['delete','to-anki',9]])
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0].fields)), [{name:'Front',before:'Question 7'}])
    h.failProcess = false
    await h.run()
    assert.deepEqual(rows.slice(2).map(row => [row.action,row.direction,row.noteId]), [['cleanup','local',7],['cleanup','local',9]])
    assert.equal(h.writes.length,1)
})

test('one-way dispatch writes and logs the verified spacing correction only after the Markdown write succeeds', async () => {
    const line = '- Казематы:: Сводчатые помещения :: R'
    const input = '## Карточки\r\n' + line + '\r\n<!--ID: 8-->\r\n'
    const rows = []
    const h = await fixture(input, { spacing: line, failProcess: true, onSyncChange: row => rows.push(row) })
    const failed = await h.run()
    assert.ok(failed.retryPaths.has(h.file.path))
    assert.equal(h.file.text, input)
    assert.deepEqual(rows, [])
    h.failProcess = false
    await h.run()
    const after = line.replace('ы::', 'ы ::')
    assert.equal(h.file.text, input.replace(line, after))
    assert.deepEqual(rows.map(({ action, direction, fields, noteId }) => [action, direction, noteId, fields]),
        [['normalize', 'local', 8, [{ name: 'Markdown', before: line, after }]]])
    await h.run()
    assert.equal(rows.length, 1)
    assert.deepEqual(h.writes, [])
})

test('whole-page cleanup keeps a recoverable source when Obsidian is configured for permanent deletion', async () => {
    const page = '# Capital #anki-page\nRetire.?\nID: 7\nParis'
    const h = await fixture(page, { preferences: { trashOption: 'none' } })
    const failed = await h.run()
    assert.deepEqual(h.trash, [])
    assert.equal(h.file.text, page)
    assert.ok(failed.retryPaths.has(h.file.path))
    h.preferences.trashOption = 'system'
    await h.run()
    assert.deepEqual(h.trash, [h.file.path])
})
