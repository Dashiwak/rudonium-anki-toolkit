// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const kit = path.resolve(process.env.RUDONIUM_COMPARE_KIT || path.join(__dirname, '..'))
const { load } = require(path.join(kit, 'tests/benchmark/migration-modules.cjs'))
const pageFile = require(path.join(kit, 'tests/benchmark/page-file.cjs'))

test('Anki Sync #29: invalid and reused creation IDs cannot attach two Markdown files to one note', async () => {
    const api = await load(['export-batch', 'export-recovery', 'anki-transport'], {})
    const { sendExportBatches, isUnsentExportResponse } = api['export-batch']
    for (const crossPacket of [false, true]) {
        const count = crossPacket ? 1001 : 5
        const repeatAt = crossPacket ? 500 : 2
        const notes = Array.from({length: count}, (_, i) =>
            ({action: 'addNote', params: {note: {fields: {Front: 'Q' + i}}}}))
        const files = notes.map(action => ({action: 'multi', params: {actions: [action]}}))
        let offset = 0
        const observed = []
        const result = await sendExportBatches(files, async packet => packet.map(() => {
            const i = offset++
            return {result: i === repeatAt ? 7000 : i === repeatAt + 1 ? 'undefined' : 7000 + i, error: null}
        }), undefined, undefined, {observeJournalResponse: (_action, row) => observed.push(row.result)})
        const slot = i => api['export-recovery'].readRecoverySlots(result.responses[i], 1, isUnsentExportResponse)[0]
        assert.equal(result.uncertain, true)
        assert.equal(slot(0), 'unknown')
        assert.equal(slot(1), 7001)
        assert.equal(slot(repeatAt), 'unknown')
        assert.equal(slot(repeatAt + 1), 'unknown')
        assert.equal(observed[0], null)
        assert.equal(observed[repeatAt], null)
        if (crossPacket) {
            assert.equal(offset, 1000)
            assert.equal(slot(1000), null)
        }
    }
})

test('Simple Anki Sync #25: a routed multilingual note moves its own study card IDs, not its note ID', async () => {
    const deck = 'Обсидиан::Математика'
    const initial = 'Исходная колода'
    const note = {id: 12, modelName: 'Учебная', path: 'Математика/A.md', fields: {}, tags: [],
        deck, deckRule: {origin: 'folder', folder: 'Математика'}}
    const cards = [7001, 8022, 9055]
    const current = new Map([[7001, initial], [8022, initial], [9055, deck]])
    const invoke = async (action, params) => {
        if (action === 'multi') return Promise.all(params.actions.map(async req =>
            ({result: await invoke(req.action, req.params), error: null})))
        if (action === 'findCards') return []
        if (action === 'getDeckConfig') return {dyn: false}
        if (action === 'getDecks') {
            const groups = {}
            for (const id of params.cards) (groups[current.get(id)] ??= []).push(id)
            return groups
        }
        assert.fail(action)
    }
    const api = await load(['anki-delta', 'anki-study-state', 'anki-transport', 'anki-card-impact', 'anki-field-value', 'anki'],
        {invoke, changeDeck: (cards, deck) => ({action: 'changeDeck', params: {cards, deck}})},
        {anki: "import { invoke, changeDeck } from './host'; export { invoke, changeDeck };"})
    const snapshots = new Map([[note.id, {modelName: note.modelName, fields: {}, tags: [], cards}]])
    const plan = () => api['anki-delta'].prepareExistingNoteChanges([note], (_path, reason) => assert.fail(reason), snapshots)
    const proposed = (await plan()).get(note.path)
    assert.equal(proposed.length, 1)
    assert.equal(proposed[0].action, 'changeDeck')
    assert.equal(proposed[0].params.deck, deck)
    assert.deepEqual([...proposed[0].params.cards], cards.slice(0, 2))
    for (const id of proposed[0].params.cards) current.set(id, deck)
    assert.equal((await plan()).size, 0)
})

test('AnkiBridge #51 and Awesome Flashcard #9: a localized whole-page model preserves YAML and literal Markdown rules', async () => {
    const model = 'Обычная'
    const fields = ['Вопрос', 'Ответ']
    const api = await load(['file', 'page-card', 'anki-id-marker', 'duplicate-markers', 'id-marker-literals',
        'markdown-pipeline', 'export-recovery', 'anki-transport', 'card-format-presets', 'card-export-diagnostics', 'interface-language'],
        {}, {file: pageFile().replace("from './page-card.mjs'", "from './page-card'")})
    const { AllFile } = api.file
    for (const eol of ['\n','\r\n']) {
        const yaml = ['---', 'aliases: [Карточка]', '---'].join(eol) + eol
        const body = ['Первый абзац', '', '---', '', 'Второй абзац'].join(eol)
        const source = yaml + '# Вопрос? #anki-page' + eol + eol + body
        const scan = async text => {
            const file = new AllFile(text)
            file.data.fields_dict = {[model]: fields}
            file.custom_regexps = {[model]: '@page'}
            await file.scanFile()
            return file
        }
        const file = await scan(source)
        assert.deepEqual(Object.entries(file.all_notes_to_add[0].fields), [['Вопрос', 'Вопрос?'], ['Ответ', body.replaceAll(eol, '\n')]])
        file.note_ids = [7001]
        file.writeIDs()
        assert.ok(file.file.startsWith(['---', 'aliases: [Карточка]', "anki-page-ID: '7001'", ''].join(eol).trimEnd()))
        assert.ok(file.file.endsWith(body))
        const rescan = await scan(file.file)
        assert.equal(rescan.all_notes_to_add.length, 0)
        assert.equal(rescan.notes_to_edit[0].identifier, 7001)
    }
})

test('AnkiSync+ #5: the active profile reports a missing folder and explicitly distinguishes out-of-scope notes', async () => {
    class TFolder {}
    const { 'sync-profiles': profiles, 'interface-language': language } = await load(['sync-profiles', 'interface-language'], {TFolder})
    const folders = new Map([['Карточки', new TFolder()], ['Карточки/Вложения', new TFolder()]])
    const files = ['Карточки/A.md','Карточки/Подпапка/B.md','Карточки/Вложения/Описание.md','Карточки2/C.md']
    const plugin = {settings: {ACTIVE_SYNC_FOLDER_PROFILE: 'study', SYNC_FOLDER_PROFILES: [
        {id: 'study', name: 'Study', folders: ['Карточки'], excludedFolders: ['Карточки/Вложения']}]},
        app: {vault: {getAbstractFileByPath: p => folders.get(p), getMarkdownFiles: () => files.map(path => ({path}))}}}
    assert.deepEqual([...profiles.resolveSyncScope(plugin).paths], files.slice(0, 2))
    files.forEach((path, i) => assert.equal(profiles.describeSyncPath(plugin, path).included, i < 2))
    folders.delete('Карточки')
    assert.throws(() => profiles.resolveSyncScope(plugin), error => {
        assert.match(language.uiDiagnostic(error, en => en), /missing folders: Карточки/)
        assert.match(language.uiDiagnostic(error, (_en, ru) => ru), /В профиле «Study» не найдены папки: Карточки/)
        return true
    })
})
