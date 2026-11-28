// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const test = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')

const id = 1778136066587
const model = 'EnDic26'
const path = '1 Dictionary/1.1.2. Внешний вид.md'
const link = file => 'obsidian://open?vault=Vault&file=' + encodeURIComponent(file)
const fields = {
    '-FW': 'LOOK YOUNG', '-NW': 'выглядеть молодо', '-FO': '', '-NO': '!',
    '-FE': 'She still <b>looks young</b> for her age.', '-FS': 'appear young... seem young, look youthful',
    '-FM': '🟩 2k Neutral', '-L': '<a href="' + link('chat_superactive') + '">chat_superactive</a>',
    File: '<br><a href="' + link(path) + '" class="obsidian-link">Obsidian</a>', Context: path + ' > look young',
}

async function fixture(values = fields) {
    const note = { noteId: id, modelName: model, tags: ['grammar'], fields: Object.fromEntries(
        Object.entries(values).map(([name, value], order) => [name, { value, order }])) }
    const file = { path, text: '# look young\r\n', stat: { ctime: 1, mtime: 1, size: 14 } }
    const plugin = { fields_dict: { [model]: Object.keys(values) }, settings: {
        Defaults: { 'Add File Link': true, 'Add Context': true, Tag: '', Deck: 'Vocabulary' },
        FILE_LINK_FIELDS: { [model]: 'File' }, CONTEXT_FIELDS: { [model]: 'Context' }, CUSTOM_REGEXPS: {}, FOLDER_TAGS: {}, FOLDER_DECKS: {},
        Syntax: { 'Begin Note': '!--', 'End Note': '!---', 'Begin Inline Note': 'STARTI', 'End Inline Note': 'ENDI',
            'Frozen Fields Line': 'FROZEN', 'File Tags Line': 'FILE TAGS', 'Target Deck Line': 'TARGET DECK', 'Delete Note Line': 'DELETE' },
    }, app: { workspace: { getLeavesOfType: () => [] }, metadataCache: { getCache: () => ({}) }, vault: {
        getMarkdownFiles: () => [file], getAbstractFileByPath: p => p === path ? file : undefined,
        getName: () => 'Vault', read: async f => f.text, process: async (f, fn) => { f.text = fn(f.text) },
    } } }
    const api = {
        uiFor: () => en => en, activeExportRules: () => [], isProtectedAnkiTag: () => false,
        isRecoveryTag: () => false, parseYaml: () => ({}), hasPendingAnkiWrite: () => false, hasPendingBidirectionalWrite: () => false,
        isSyncAuditReportPath: () => false, describeSyncPath: () => ({ included: true }),
        settingsWithoutAuditMode: s => s, scanProfileFreeSettings: s => s,
        withFastScanReadLock: async (_p, fn) => fn(() => 1, () => 1),
        requireExpectedAnkiProfile: async (_p, profile) => { assert.equal(profile, 'User') },
        auditRead: async (action, args) => { assert.equal(action, 'notesInfo'); assert.deepEqual([...args.notes], [id]); return [note] },
        // Only the last Markdown rendering step is simulated. Data, explicit note
        // parsing, File/Context insertion and replacement of cached links are production code.
        renderAnkiMarkdown: field => field.trim().replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'),
    }
    const modules = await load(['anki-source-restore', 'anki-source-restore-format', 'anki-id-marker', 'vault-id-index',
        'duplicate-markers','card-preview-metadata','linked-bullets','card-source-link-fields','setting-to-data',
        'anki','constants','format','note','file','portable-parser','bidirectional-blocks','card-export-diagnostics',
        'markdown-pipeline','card-format-presets','page-card','deck-routes','page-id-location','bidirectional-markdown'], api,
        { anki: 'export {}' })
    return { ...modules['anki-source-restore'], plugin, file, note }
}

test('restore the upstream dictionary note at its linked path with its ID, fields and custom markers', async () => {
    const { prepareAnkiSourceRestore, commitAnkiSourceRestore, plugin, file } = await fixture()
    const before = file.text
    const plan = await prepareAnkiSourceRestore(plugin, id, 'User')
    assert.equal(plan.manualReason, undefined)
    assert.equal(plan.path, path)
    assert.equal(plan.targetReason, 'file-link')
    assert.equal(plan.targetDeck, 'Vocabulary')
    assert.equal(file.text, before)
    assert.match(plan.block, /^!--\r?\nEnDic26\r?\n-FW: LOOK YOUNG/)
    assert.match(plan.block, /-L: \[\[chat_superactive\]\]/)
    assert.match(plan.block, /-FS: appear young&#46;\.\. seem young, look youthful/)
    assert.match(plan.block, /-FE: She still \*\*looks young\*\* for her age\./)
    assert.doesNotMatch(plan.block, /(?:File|Context):/)
    assert.match(plan.block, /-FW: LOOK YOUNG #grammar\r?\n/)
    assert.match(plan.block, /ID: 1778136066587 @field-tags\r?\n!---$/)
    await commitAnkiSourceRestore(plugin, plan)
    assert.ok(file.text.startsWith(before))
    assert.equal(file.text.split(String(id)).length, 2)
    await assert.rejects(prepareAnkiSourceRestore(plugin, id, 'User'), e => ['duplicate', 'stale'].includes(e.code))
})

test('unsupported field markup yields a complete reviewable block, with Context as its destination', async () => {
    const { prepareAnkiSourceRestore, commitAnkiSourceRestore, plugin, file } = await fixture({
        ...fields, File: '', '-L': '<span style="color:red">Manual</span>',
    })
    const before = file.text
    const draft = await prepareAnkiSourceRestore(plugin, id, 'User')
    assert.equal(draft.path, path)
    assert.equal(draft.targetReason, 'context')
    assert.match(draft.manualReason, /-L/)
    assert.match(draft.block, /Manual/)
    assert.ok(draft.block.includes(String(id)))
    assert.ok(draft.fields['-L'].includes('style='))
    await assert.rejects(commitAnkiSourceRestore(plugin, draft), e => e.code === 'stale')
    assert.equal(file.text, before)
})

test('conflicting File and Context paths allow preview and copy before choosing an existing destination', async () => {
    const other = { path: 'Renamed.md', text: '', stat: { ctime: 1, mtime: 1, size: 0 } }
    const { prepareAnkiSourceRestore, commitAnkiSourceRestore, plugin, note, file } = await fixture({
        ...fields, File: '<br><a href="' + link(other.path) + '" class="obsidian-link">Obsidian</a>',
    })
    const vault = plugin.app.vault
    vault.getMarkdownFiles = () => [file, other]
    vault.getAbstractFileByPath = p => [file, other].find(f => f.path === p)
    const initial = await prepareAnkiSourceRestore(plugin, id, 'User')
    assert.deepEqual(new Set(initial.suggestedPaths), new Set([path, other.path]))
    assert.equal(initial.path, undefined)
    assert.ok(initial.block.includes('LOOK YOUNG'))
    await assert.rejects(commitAnkiSourceRestore(plugin, initial), e => e.code === 'stale')
    const selected = await prepareAnkiSourceRestore(plugin, id, 'User', { path })
    assert.equal(selected.targetReason, 'selection')
    assert.equal(selected.manualReason, undefined)
    note.fields['-FW'].value = 'NEW WORD'
    await assert.rejects(commitAnkiSourceRestore(plugin, selected), e => e.code === 'stale')
    assert.equal(file.text, '# look young\r\n')
    assert.equal(other.text, '')
})

test('edited manual draft inserts before the selected line and keeps its surrounding text intact', async () => {
    const { prepareAnkiSourceRestore, restoreInsertionContext, commitAnkiSourceRestore, plugin, file } = await fixture({
        ...fields, '-L': '<span style="color:red">Manual</span>',
    })
    file.text = 'intro\r\nsecond\r\nthird\r\nfourth'
    const plan = await prepareAnkiSourceRestore(plugin, id, 'User')
    assert.equal(plan.line, 5)
    assert.equal(plan.maxLine, 5)
    const context = restoreInsertionContext(plan, 3)
    assert.deepEqual([...context.before], ['intro', 'second'])
    assert.deepEqual([...context.after], ['third', 'fourth'])
    assert.equal(context.blockLine, 4)
    const block = plan.block.replace(/^-L:.*$/m, '-L: [[Manual]]').replace('LOOK YOUNG', 'LOOK WELL')
    const result = await commitAnkiSourceRestore(plugin, plan, undefined, { line: 3, block })
    assert.equal(result.line, context.blockLine)
    assert.equal(file.text, 'intro\r\nsecond\r\n\r\n' + block.replace(/\r\n?|\n/g, '\r\n') + '\r\n\r\nthird\r\nfourth')
})

test('invalid draft or location cannot overwrite a file or introduce another card or directive', async () => {
    const { prepareAnkiSourceRestore, restoreInsertionContext, commitAnkiSourceRestore, plugin, file } = await fixture()
    const source = file.text = '# heading\n\n!--\nEnDic26\n-FW: ANOTHER CARD\n!---\n\n~~~markdown\ncode\n~~~\n\n<!-- comment\ncontinues -->\n'
    const plan = await prepareAnkiSourceRestore(plugin, id, 'User')
    const commit = (line, block = plan.block) => commitAnkiSourceRestore(plugin, plan, undefined, { line, block })
    for (const line of [0, -1, 1.5, NaN, Infinity, plan.maxLine + 1]) {
        assert.equal(restoreInsertionContext(plan, line), undefined)
        await assert.rejects(commit(line), error => error.code === 'position')
    }
    for (const line of [4, 5, 9, 10, 13]) {
        await assert.rejects(commit(line), error => error.code === 'position', 'protected line ' + line)
    }
    for (const draft of [plan.block.replace(String(id), '999'), plan.block.replace(model, 'Basic'),
        plan.block + '\n' + plan.block, plan.block.replace('-FE:', 'TARGET DECK: Wrong\n-FE:'),
        'outside text\n' + plan.block, plan.block + '\noutside text']) {
        await assert.rejects(commit(1, draft), error => error.code === 'draft')
    }
    assert.equal(file.text, source)
    await commit(1)
    assert.ok(file.text.endsWith('\n\n' + source))
})

test('file properties and stale edits are preserved when the user picks an insertion line', async () => {
    const { prepareAnkiSourceRestore, commitAnkiSourceRestore, plugin, file } = await fixture()
    const original = file.text = '---\nword: example\n---\n\nText\n'
    const plan = await prepareAnkiSourceRestore(plugin, id, 'User')
    for (const line of [1, 2, 3]) {
        await assert.rejects(commitAnkiSourceRestore(plugin, plan, undefined, { line, block: plan.block }),
            error => error.code === 'position')
    }
    assert.equal(file.text, original)
    file.text += 'concurrent edit'
    await assert.rejects(commitAnkiSourceRestore(plugin, plan, undefined, { line: 4, block: plan.block }),
        error => error.code === 'stale')
    assert.equal(file.text, original + 'concurrent edit')
})

test('the default line appends with a blank separator for each existing line ending and for empty files', async () => {
    for (const [source, prefix, maxLine] of [
        ['', '', 1], ['first', 'first\n\n', 2], ['first\n', 'first\n\n', 2],
        ['first\r\n\r\n', 'first\r\n\r\n', 3], ['first\rsecond', 'first\rsecond\r\r', 3],
    ]) {
        const { prepareAnkiSourceRestore, restoreInsertionContext, commitAnkiSourceRestore, plugin, file } = await fixture()
        file.text = source
        const plan = await prepareAnkiSourceRestore(plugin, id, 'User')
        assert.equal(plan.line, maxLine)
        assert.equal(plan.maxLine, maxLine)
        const result = await commitAnkiSourceRestore(plugin, plan, undefined, { line: plan.line, block: plan.block })
        assert.ok(file.text.startsWith(prefix + '!--'))
        assert.equal(result.line, prefix.split(/\r\n?|\n/).length)
        assert.equal(restoreInsertionContext(plan, plan.line), undefined)
    }
})

test('the final vault transaction refuses a change made after validation', async () => {
    const { prepareAnkiSourceRestore, commitAnkiSourceRestore, plugin, file } = await fixture()
    const plan = await prepareAnkiSourceRestore(plugin, id, 'User')
    plugin.app.vault.process = async (target, apply) => {
        target.text = 'Changed during Add\n'
        target.text = apply(target.text)
    }
    await assert.rejects(commitAnkiSourceRestore(plugin, plan, undefined, { line: 1, block: plan.block }),
        error => error.code === 'stale')
    assert.equal(file.text, 'Changed during Add\n')
})

test('a reviewed block cannot duplicate an existing card with matching edited fields', async () => {
    const { prepareAnkiSourceRestore, commitAnkiSourceRestore, plugin, file } = await fixture()
    file.text = '!--\nEnDic26\n-FW: LOOK HAPPY\n!---\n'
    const plan = await prepareAnkiSourceRestore(plugin, id, 'User')
    const block = ['!--', model, '-FW: LOOK HAPPY', 'ID: ' + id, '!---'].join('\n')
    await assert.rejects(commitAnkiSourceRestore(plugin, plan, undefined, { line: 1, block }),
        error => error.code === 'duplicate')
    assert.equal(file.text, '!--\nEnDic26\n-FW: LOOK HAPPY\n!---\n')
})
