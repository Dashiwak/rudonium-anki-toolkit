// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import overlay from '../Build/overlay-source.cjs'
import pageFile from './benchmark/page-file.cjs'
import patched from './benchmark/patched-manager.cjs'
import { loadSync } from './benchmark/load-sync.mjs'
import { MarkdownView, useHost } from './benchmark/host.mjs'

globalThis.require = createRequire(import.meta.url)
const module = path => import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(readFileSync(overlay.file(path + '.ts'), 'utf8'))))
const { delimitedRule } = await module('delimited-rule')
const id = 1750000000001
function fixture(runtime, options) {
    const { names, body, values, rule } = options
    const file = { path: 'Dictionary.md', text: '## City\r\n' + body + '\r\n<!--ID: ' + id + ' -->\r\n\r\nDraft',
        stat: { ctime: 1, mtime: 1, size: 1 } }
    const notes = { modelName: 'Basic', noteId: id, tags: [], cards: [id + 60], fields: Object.fromEntries(names.map((key, index) =>
        [key, { order: index, value: values[index] }])) }
    let onModify
    function edit(text) { file.text = text; file.stat.size = Buffer.byteLength(text); file.stat.mtime++; onModify?.(file) }
    const store = new Map()
    const host = { plain: true, runtime, capturedFields: names, metrics: { parses: 0, regexpFiles: 0 },
        expressions: { Basic: rule }, notices: [], dialog: null, requests: [], writes: [], fail: false, trash: false,
        backup: async () => file.text,
        request: async (action, params) => {
            host.requests.push(action)
            if (action === 'getActiveProfile') return 'QA'
            if (action === 'guiSelectedNotes') return []
            if (action === 'modelTemplates') return { Card: { Front: '{{' + names[0] + '}}', Back: '{{' + names[1] + '}}' } }
            if (action === 'notesInfo') return structuredClone(params.notes.map(key => key === id && !host.trash ? notes : {}))
            if (action === 'findNotes') return host.trash ? [] : [id]
            if (action === 'areSuspended') return params.cards.map(() => false)
            if (action === 'multi') return Promise.all(params.actions.map(async op => ({ result: await host.request(op.action, op.params), error: null })))
            if (action === 'updateNoteFields') {
                host.writes.push(params.note)
                for (const [name, value] of Object.entries(params.note.fields)) notes.fields[name].value = value
                return null
            }
            throw Error(action)
        } }
    const leaves = []
    const plugin = { manifest: { id: 'rudonium' }, app: { vault: { configDir: '.obsidian', getName: () => 'QA',
        getMarkdownFiles: () => [file], getAbstractFileByPath: path => path === file.path ? file : null,
        read: async () => file.text, process: async (_, cb) => { if (host.fail) throw Error('simulated disk full'); edit(cb(file.text)) },
        on(name, fn) { if (name === 'modify') onModify = fn },
        adapter: { exists: async path => store.has(path), read: async path => store.get(path), write: async (path, v) => { store.set(path, v) } } },
        workspace: { getActiveFile: () => file, getLeavesOfType: () => leaves, on() {}, onLayoutReady(cb) { cb() } },
        metadataCache: { getCache: () => null } }, addCommand() {}, registerEvent() {}, registerView() {}, register() {},
        settings: { BIDIRECTIONAL_SYNC: true, REQUIRE_ANKI_PROFILE: true, EXPECTED_ANKI_PROFILE: 'QA', SKIP_SYNC_ERRORS: true,
            AFTER_DELETE_MODE: 'remove', Syntax: {}, CUSTOM_REGEXPS: host.expressions, Defaults: { Deck: 'Knowledge' } },
        fields_dict: { Basic: names } }
    const preview = async () => {
        useHost(host); host.dialog = null
        await runtime.previewBidirectionalSync(plugin, { currentOnly: true })
        assert.ok(host.dialog, host.notices.join('\n'))
        return host.dialog
    }
    return { file, edit, notes, host, leaves, plugin, preview }
}

test('Clearing Bahnhof in Anki leaves a linked empty answer in Knowledge and RemNote, with no empty drafts', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { knowledgeBulletExpression, remNoteExpression, cardRegexpWithSuffix } = await module('card-format-presets')
    const question = 'Как по-немецки «вокзал»?'
    const body = '- ' + question + ' :: Bahnhof :: B=de_DE'
    for (const rule of [knowledgeBulletExpression, remNoteExpression]) {
        const names = rule === knowledgeBulletExpression ? ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang'] : ['Front', 'Back']
        const h = fixture(runtime, { rule, names, body, values: [question, 'Bahnhof', '', '', 'de_DE'] })
        if (rule === remNoteExpression) {
            // Real dictionaries can be claimed by the built-in linked-bullet reader inside a Cards section.
            h.edit(h.file.text.replace('## City', '## Карточки'))
            h.host.includeUnclaimedRegex = true
        }
        const original = h.file.text
        assert.ok(!new RegExp(cardRegexpWithSuffix(rule, '', ''), 'gm').test(body.replace('Bahnhof', '')))
        const seed = await h.preview()
        await seed.apply(new Map())
        h.notes.fields.Back.value = '<div><br></div>'
        const inbound = await h.preview()
        const change = inbound.preview.rows.flatMap(row => row.changes ?? []).find(row => row.field === 'Back')
        assert.equal(change?.decision, 'anki', JSON.stringify(inbound.preview))
        await inbound.apply(new Map())
        assert.equal(h.file.text, original.replace('Bahnhof', ''))
        assert.equal(h.host.writes.length, 0)
        assert.equal((await h.preview()).preview.canApply, false)
        h.notes.fields.Back.value = 'Hauptbahnhof'
        await (await h.preview()).apply(new Map())
        assert.equal(h.file.text, original.replace('Bahnhof', 'Hauptbahnhof'))
        h.edit(h.file.text.replace('Hauptbahnhof', ''))
        await (await h.preview()).apply(new Map())
        assert.deepEqual(h.host.writes.map(op => [op.id, { ...op.fields }]), [[id, { Back: '' }]])
        assert.equal((await h.preview()).preview.canApply, false)
    }
})

test('Knowledge and RemNote keep bold text editable in both directions for the Marian column card', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { knowledgeBulletExpression, remNoteExpression } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    const question = 'В память о каких событиях поставили **Мариинскую колонну** на главной площади?'
    const answer = 'В связи со свадьбами двух единокровных сестёр императора Леопольда I.'
    const render = value => value.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    for (const rule of [knowledgeBulletExpression, remNoteExpression]) {
        const h = fixture(runtime, { rule, names, body: '- ' + question + ' :: ' + answer,
            values: [render(question).replaceAll('strong>', 'b>'), answer, '', '', ''] })
        const decorate = note => { for (const name of Object.keys(note.fields)) note.fields[name] = render(note.fields[name]) }
        h.host.decorateRegexNote = decorate
        h.host.decorateFields = decorate
        if (rule === remNoteExpression) {
            h.host.includeUnclaimedRegex = true
            h.edit(h.file.text.replace('## City', '## Карточки'))
        }
        const original = h.file.text
        const seed = await h.preview()
        assert.ok(seed.preview.canApply, JSON.stringify(seed.preview))
        assert.deepEqual(seed.preview.rows.flatMap(row => row.issues ?? []), [])
        await seed.apply(new Map())
        assert.equal(h.file.text, original)
        assert.equal(h.host.writes.length, 0)
        h.notes.fields.Front.value = render(question.replace('событиях', 'торжествах'))
        const inbound = await h.preview()
        assert.equal(inbound.preview.rows.flatMap(row => row.changes).find(c => c.field === 'Front')?.decision, 'anki')
        await inbound.apply(new Map())
        assert.equal(h.file.text, original.replace('событиях', 'торжествах'))
        h.edit(h.file.text.replace('Мариинскую колонну', 'колонну Марии'))
        await (await h.preview()).apply(new Map())
        assert.deepEqual(h.host.writes.map(note => Object.keys(note.fields)), [['Front']])
        assert.equal(h.notes.fields.Front.value, render(question.replace('событиях', 'торжествах').replace('Мариинскую колонну', 'колонну Марии')))
        assert.equal((await h.preview()).preview.canApply, false)
        assert.deepEqual(h.notes.cards, [id + 60])
    }
})

test('Conflicting local replacement and Anki clearing wait for explicit selection on the linked ID', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { knowledgeBulletExpression: rule } = await module('card-format-presets')
    const body = '- Вокзал? :: Bahnhof :: B=de_DE'
    const h = fixture(runtime, { rule, body, names: ['Front', 'Back', 'R', 'F', 'B'], values: ['Вокзал?', 'Bahnhof', '', '', 'de_DE'] })
    await (await h.preview()).apply(new Map())
    h.edit(h.file.text.replace('Bahnhof', 'Hauptbahnhof'))
    h.notes.fields.Back.value = ''
    const conflict = await h.preview()
    const change = conflict.preview.rows.flatMap(row => row.changes).find(row => row.field === 'Back')
    assert.equal(change.decision, 'conflict')
    const local = h.file.text
    await conflict.apply(new Map())
    assert.equal(h.file.text, local)
    await (await h.preview()).apply(new Map([[change.key, 'anki']]))
    assert.equal(h.file.text, local.replace('Hauptbahnhof', ''))
    assert.equal(h.host.writes.length, 0)
})

test('A fresh one-way export preserves the existing ID and optional positions after clearing the second capture', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { knowledgeBulletExpression: rule } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Reverse', 'FL', 'BL']
    const Manager = patched.managerType({ ...runtime.portableParser, ...runtime.delta })
    const question = 'Как по-немецки «вокзал»?'
    for (const suffix of ['', ' :: R :: F=ru_RU :: B=de_DE']) {
        const optional = suffix ? ['R', 'ru_RU', 'de_DE'] : ['', '', '']
        const h = fixture(runtime, { rule, names, body: '- ' + question + ' :: Bahnhof' + suffix, values: [question, 'Bahnhof', ...optional] })
        const { plugin, host, file, notes, edit } = h
        const never = /(?!)/
        const data = { fields_dict: { Basic: names }, custom_regexps: { Basic: rule }, template: { deckName: 'Knowledge', tags: [] },
            folder_decks: {}, folder_tags: {}, NOTE_REGEXP: never, INLINE_REGEXP: never, EMPTY_REGEXP: never }
        const run = async () => {
            useHost(host)
            const parsed = await runtime.parsePortableMarkdown(plugin.app, data, file, file.text, [id], { trackRanges: true })
            assert.deepEqual(parsed.notes_to_edit.map(x => x.identifier), [id])
            assert.equal(parsed.all_notes_to_add.length, 0)
            // Reopen the on-disk field receipts as after a plugin restart.
            const history = await runtime.openOneWayHistory(plugin, 'QA')
            const manager = Object.assign(new Manager(), { app: plugin.app, data, oneWayHistory: history,
                ownFiles: [parsed], linkedSnapshots: new Map([[id, notes]]) })
            await manager.prepareExistingUpdates()
            assert.deepEqual([...manager.retryMessages], [])
            const updates = manager.existingChanges.get(file.path) ?? []
            for (const action of updates) await host.request(action.action, action.params)
            await runtime.delta.verifyExistingNoteFieldWrites(manager.existingChanges, (_path, message) => assert.fail(message), {
                models: new Map([[id, 'Basic']]), namedLayouts: manager.namedLayouts, capture: receipt => manager.oneWayReceipts.push(receipt),
            })
            history.apply(manager.oneWayReceipts)
            await history.flush()
            return updates.length
        }
        assert.equal(await run(), 0)
        edit(file.text.replace('Bahnhof', '').replace(' :: \r\n', ' ::\r\n'))
        assert.equal(await run(), 1)
        assert.equal(notes.fields.Back.value, '')
        assert.deepEqual(host.writes.map(change => [change.id, { ...change.fields }]), [[id, { Back: '' }]])
        assert.equal(await run(), 0)
        await (await h.preview()).apply(new Map())
        notes.fields.Back.value = 'Bahnhof'
        await (await h.preview()).apply(new Map())
        assert.ok(file.text.includes(' :: Bahnhof' + suffix + '\r\n'))
    }
})

test('Wizard and manual layouts preview exact Markdown, keep ID, preserve CRLF and other fields, reject stale state and recover disk failure', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(() => runtime.dispose())
    for (const [rule, body, names, local, field, after] of [
        [delimitedRule(4, ':'), 'Term : Old : Example : Source', ['Term','Meaning','Example','Origin'], ['Term','Old','Example','Source'], 'Example', 'Vienna'],
        ['^Q=(.+?) -> A=(.+)$', 'Q=Term -> A=Old', ['Front','Back'], ['Term','Old'], 'Back', 'New'],
        [delimitedRule(2, ':', true), ':::anki\r\nQuestion: who?\r\nOld\r\n\r\nParagraph\r\n:::', ['Front','Back'],
            ['Question: who?','Old<br><br>Paragraph'], 'Back', 'First<br><br>Second'],
    ]) {
        const h = fixture(runtime, { rule, body, names, values: local })
        const initial = h.file.text
        const first = await h.preview()
        assert.ok(first.preview.canApply, JSON.stringify(first.preview)); await first.apply(new Map())
        h.notes.fields[field].value = after
        const next = await h.preview()
        const change = next.preview.rows.flatMap(r => r.changes).find(c => c.field === field)
        assert.ok(change, JSON.stringify(next.preview))
        assert.equal(change.decision, 'anki')
        const patch = change.markdown()
        assert.equal(patch.before, body + '\r\n<!--ID: ' + id + ' -->')
        const index = names.indexOf(field), previous = local[index].replaceAll('<br>', '\r\n')
        assert.equal(patch.after, patch.before.replace(previous, after.replaceAll('<br>', '\r\n')))
        assert.equal(h.file.text, initial)
        h.edit(h.file.text + ' changed draft')
        await assert.rejects(next.apply(new Map()))
        assert.ok(h.file.text.includes(previous))
        const retry = await h.preview()
        h.host.fail = true
        await retry.apply(new Map()).catch(() => {})
        assert.ok(h.file.text.includes(previous))
        h.host.fail = false
        const recovered = await h.preview()
        await recovered.apply(new Map())
        assert.equal(h.file.text, initial.replace(previous, after.replaceAll('<br>', '\r\n')) + ' changed draft')
        const settled = await h.preview(); assert.equal(settled.preview.canApply, false)
        assert.equal(h.host.writes.length, 0)
    }
})

test('Conflicting values require a selection. A replacement containing the delimiter is diagnosed before applying.', async t => {
    const runtime = await loadSync(overlay.directory); t.after(() => runtime.dispose())
    const h = fixture(runtime, { rule: delimitedRule(2, '|'), names: ['Front','Back'], body: 'Word | Old', values: ['Word','Old'] })
    await (await h.preview()).apply(new Map())
    h.edit(h.file.text.replace('Old', 'Local')); h.notes.fields.Back.value = 'Remote'
    const conflict = await h.preview()
    const row = conflict.preview.rows.flatMap(r => r.changes)[0]
    assert.equal(row.decision, 'conflict'); assert.match(row.markdown().after, /Word \| Remote/)
    await conflict.apply(new Map()); assert.ok(h.file.text.includes('Local')); assert.equal(h.notes.fields.Back.value,'Remote')
    await (await h.preview()).apply(new Map([[row.key,'anki']]))
    assert.ok(h.file.text.includes('Remote'))
    h.notes.fields.Back.value = 'Part|Second'
    const unsafe = await h.preview()
    assert.equal(unsafe.preview.canApply, false)
    const change = unsafe.preview.rows.flatMap(row => row.changes).find(c => c.field === 'Back')
    assert.deepEqual([change.decision, change.allowedSide, change.canChooseDirection, change.recommendedSide],
        ['conflict', 'obsidian', false, undefined])
    assert.match(JSON.stringify(unsafe.preview.rows), /separator/)
    const stable = h.file.text
    await unsafe.apply(new Map())
    assert.equal(h.notes.fields.Back.value, 'Part|Second')
    await (await h.preview()).apply(new Map([[change.key, 'anki']]))
    assert.equal(h.file.text, stable)
    assert.equal(h.notes.fields.Back.value, 'Part|Second')
    await (await h.preview()).apply(new Map([[change.key, 'obsidian']]))
    assert.equal(h.notes.fields.Back.value, 'Remote')
    assert.equal(h.file.text, stable)
    assert.equal((await h.preview()).preview.canApply, false)
})

test('Dirty unrelated editor permits verified external deletion, dirty editor containing the affected ID blocks deletion', async t => {
    const runtime = await loadSync(overlay.directory); t.after(() => runtime.dispose())
    for (const mentions of [true,false]) {
        const h = fixture(runtime, { rule: '', names: ['Front','Back'], body: '- Word :: Old', values: ['Word','Old'] })
        h.host.mixed = true; h.host.plain = false
        h.edit(h.file.text.replace('## City', '## Cards'))
        await (await h.preview()).apply(new Map())
        h.host.trash = true
        const view = Object.assign(new MarkdownView(), { file: { path: 'Other.md' }, data: 'draft',
            getMode: () => 'source', getViewData: () => mentions ? 'Moved\n<!--ID: '+id+' -->' : 'an unrelated draft edit' })
        h.leaves.push({ view })
        const pending = await h.preview()
        assert.ok(pending.preview.canApply,JSON.stringify(pending.preview))
        await pending.apply(new Map()).catch(() => {})
        assert.equal(h.file.text.includes(String(id)),mentions)
    }
})

test('Proposed Markdown is parsed before either side is written; conflicting ownership and stale model order block the edit', async t => {
    const runtime = await loadSync(overlay.directory); t.after(() => runtime.dispose())
    const h = fixture(runtime, { rule: delimitedRule(2, '|'), names: ['Front','Back'], body: 'Word | Old', values: ['Word','Old'] })
    await (await h.preview()).apply(new Map())
    h.notes.fields.Back.value = 'Vienna'
    h.host.decorateRegexNote = note => { if (note.fields.Back === 'Vienna') note.deckName = 'Other' }
    const before = h.file.text
    const proposed = await h.preview()
    await assert.rejects(proposed.apply(new Map()), /card structure/)
    assert.equal(h.host.writes.length,0)
    assert.equal(h.file.text,before)
    delete h.host.decorateRegexNote
    h.notes.fields.Front.order = 1
    h.notes.fields.Back.order = 0
    const bad = await h.preview()
    assert.equal(bad.preview.canApply,false)
    assert.ok(bad.preview.rows.some(r => r.issues?.length))
})

test('A generated backlink in Front preserves the live Anki field order check', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const h = fixture(runtime, { rule: delimitedRule(2, '|'), names: ['Front', 'Back', 'Other'],
        body: 'Word | Old', values: ['Word', 'Old', ''] })
    const suffix = '<br><a href="obsidian://anki-card?vault=QA&amp;file=Dictionary.md&amp;nid=' + id + '" class="obsidian-link">Obsidian</a>'
    h.host.sourceSettings = { add_file_link: true, file_link_fields: { Basic: 'Front' } }
    h.host.decorateRegexNote = note => { note.fields.Front += suffix }
    h.notes.fields.Front.value += suffix
    await (await h.preview()).apply(new Map())
    h.notes.fields.Front.order = 2
    h.notes.fields.Other.order = 0
    h.notes.fields.Back.value = 'Changed'
    const next = await h.preview()
    assert.equal(next.preview.canApply, false, JSON.stringify(next.preview))
    assert.match(next.preview.rows.flatMap(row => row.issues ?? []).join(' '), /order/)
    assert.equal(h.host.writes.length, 0)
    assert.ok(h.file.text.includes('Word | Old'))
})

test('Plain intraword underscores in both directions preserve a linked note; Markdown emphasis stays in manual review', async t => {
    const runtime = await loadSync(overlay.directory); t.after(() => runtime.dispose())
    const h = fixture(runtime, { rule: '', names: ['Front','Back'], body: '- Locale :: de_DE', values: ['Locale','de_DE'] })
    h.host.mixed = true; h.host.plain = false
    h.edit(h.file.text.replace('## City', '## Cards'))
    const observed = await h.preview(); assert.ok(observed.preview.canApply, JSON.stringify(observed.preview))
    await observed.apply(new Map())
    h.notes.fields.Back.value = 'de_AT'
    const inbound = await h.preview(); await inbound.apply(new Map())
    assert.ok(h.file.text.includes(':: de_AT'))
    h.edit(h.file.text.replace('de_AT','de_CH'))
    const outbound = await h.preview(); await outbound.apply(new Map())
    assert.equal(h.notes.fields.Back.value, 'de_CH')
    h.notes.fields.Back.value = '_emphasis_'
    const marked = await h.preview(); assert.equal(marked.preview.canApply, false)
    assert.ok(h.file.text.includes(':: de_CH'))
})

test('Exact Knowledge rule keeps five capture positions, optional metadata and the original Anki note in both directions', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { knowledgeBulletExpression: rule } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    for (const suffix of ['', ' :: R', ' :: F=ru_RU', ' :: B=de_DE', ' :: B=de\\_DE', ' :: R :: F=ru_RU :: B=de_AT']) {
        const question = 'В каком монастыре Винер-Нойштадта?+++'
        const h = fixture(runtime, { rule, names, body: '- ' + question + ' :: Нойклостер' + suffix,
            values: [question, 'Нойклостер', suffix.includes(' :: R') ? 'R' : '', suffix.includes('F=') ? 'ru_RU' : '',
                suffix.includes('B=') ? suffix.split('B=')[1] : ''] })
        h.edit(h.file.text.replace('## City', '## Карточки'))
        const original = h.file.text
        const baseline = await h.preview()
        assert.ok(baseline.preview.canApply, JSON.stringify(baseline.preview))
        await baseline.apply(new Map())
        h.notes.fields.Front.value = question + '+'
        await (await h.preview()).apply(new Map())
        assert.equal(h.file.text, original.replace(question, question + '+'))
        h.edit(h.file.text.replace('Нойклостер', 'Монастырь Нойклостер'))
        const outbound = await h.preview()
        await outbound.apply(new Map())
        assert.equal(h.notes.fields.Back.value, 'Монастырь Нойклостер')
        assert.equal(h.host.writes.at(-1).id, id)
        assert.deepEqual(Object.keys(h.host.writes.at(-1).fields), ['Back'])
        assert.equal((await h.preview()).preview.canApply, false)
    }
})

test('Knowledge: switching to one-way uses the last verified Front and keeps the Anki ID and review cards', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const { knowledgeBulletExpression: rule } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    const h = fixture(runtime, { rule, names, body: '- Казематы :: Ответ :: R',
        values: ['Казематы', 'Ответ', 'R', '', ''] })
    const cardIds = [...h.notes.cards]
    await (await h.preview()).apply(new Map())
    h.notes.fields.Front.value = 'Казематы+'
    await (await h.preview()).apply(new Map())
    assert.match(h.file.text, /Казематы\+ :: Ответ :: R/)
    h.notes.fields.Front.value = 'Казематы0000'
    const history = await runtime.openOneWayHistory(h.plugin, 'QA')
    async function oneWay() {
        const question = h.file.text.match(/^- (.+?) ::/m)[1]
        const src = {id, path:h.file.path, modelName:'Basic', fields:{Front:question}, authoredFields:['Front'],
            deck:'Knowledge', tags:[]}
        return runtime.delta.prepareExistingNoteChanges([src],(_path,why)=>assert.fail(why),
            new Map([[id,h.notes]]),undefined,{history,allowDeckMoves:false})
    }
    assert.equal((await oneWay()).size,0, 'only the Anki editor changed since the two-way receipt')
    h.edit(h.file.text.replace('Казематы+', 'Казематы++'))
    const both = await h.preview()
    const front = both.preview.rows.flatMap(row => row.changes ?? []).find(field => field.field === 'Front')
    assert.equal(front?.decision, 'conflict')
    h.plugin.settings.BIDIRECTIONAL_SYNC = false
    const changes = await oneWay()
    const [write] = changes.get(h.file.path)
    assert.equal(write.action,'updateNoteFields')
    assert.deepEqual(write.params.note,{id,fields:{Front:'Казематы++'}})
    await h.host.request(write.action,write.params)
    const receipts = []
    assert.deepEqual(await runtime.delta.verifyExistingNoteFieldWrites(changes,(_path,why)=>assert.fail(why), {
        models:new Map([[id,'Basic']]), capture:receipt=>receipts.push(receipt),
    }),[])
    history.apply(receipts)
    await history.flush()
    assert.equal(h.notes.fields.Front.value, 'Казематы++')
    assert.deepEqual(h.notes.cards, cardIds)
    assert.ok(h.file.text.includes('<!--ID: '+id+' -->'))
    assert.equal((await oneWay()).size,0)
    h.plugin.settings.BIDIRECTIONAL_SYNC = true
    h.notes.fields.Front.value = 'Новая правка в Anki'
    const returned = await h.preview()
    assert.equal(returned.preview.rows.flatMap(row => row.changes ?? []).find(row => row.field === 'Front')?.decision, 'anki')
    await returned.apply(new Map())
    assert.ok(h.file.text.includes('Новая правка в Anki :: Ответ :: R'))
})

test('first two-way sync consults only verified one-way fields in the same profile and model', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    for (const [oldProfile, oldModel, question, remote, direction] of [
        ['QA','Basic','Казематы+', 'Казематы', 'obsidian'],
        ['QA','Basic','Казематы', 'Казематы0000', 'anki'],
        ['QA','Basic','Казематы+', 'Казематы0000', 'conflict'],
        ['Other','Basic','Казематы+', 'Казематы', 'conflict'],
        ['QA','Other','Казематы+', 'Казематы', 'conflict'],
    ]) {
        const h = fixture(runtime, {rule:'^Q=(.+?) -> A=(.+)$', names:['Front','Back'],
            body:'Q='+question+' -> A=Ответ',values:[remote,'Ответ']})
        const history = await runtime.openOneWayHistory(h.plugin, oldProfile)
        history.apply([{id,modelName:oldModel,fields:{Front:'Казематы',Back:'Ответ'}}])
        await history.flush()
        const first = await h.preview()
        assert.equal(first.preview.rows.flatMap(row => row.changes ?? []).find(field => field.field === 'Front')?.decision, direction)
        await first.apply(new Map())
        assert.ok(h.file.text.includes('Q='+(direction === 'anki' ? remote : question)+' -> A=Ответ'))
        assert.equal(h.notes.fields.Front.value, direction === 'obsidian' ? question : remote)
        assert.deepEqual(h.notes.cards,[id+60])
    }
})

test('Two-way table remains linked with a blank line under the last row and updates only its intended cell', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { cardFormatPresets } = await module('card-format-presets')
    const table = cardFormatPresets.find(format => format.id === 'table')
    const h = fixture(runtime, { rule: table.expression, names: ['Front', 'Back'],
        body: table.example.replaceAll('\n', '\r\n') + '\r\n', values: [table.front,table.back] })
    const before = h.file.text
    const preview = await h.preview()
    assert.ok(preview.preview.canApply, JSON.stringify(preview.preview))
    await preview.apply(new Map())
    h.notes.fields.Back.value = 'Wien'
    await (await h.preview()).apply(new Map())
    assert.equal(h.file.text, before.replace(table.back, 'Wien'))
    assert.equal(h.host.writes.length, 0)
})

test('enabling the ID date moves an existing date before punctuation on a verified link, preserves CRLF and never changes Anki fields', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(() => runtime.dispose())
    const h = fixture(runtime, { rule: '^Q=(.+?) -> A=(.+)$', body: 'Q=Term -> A=Old',
        names: ['Front','Back'], values: ['Term','Old'] })
    const before = h.file.text.replace(' -->', '! --> #keep | 2024-02-29!')
    h.edit(before)
    const baseline = await h.preview()
    await baseline.apply(new Map())
    assert.equal(h.file.text, before)
    h.plugin.settings.Defaults['Add Date to Anki IDs'] = true
    const dated = await h.preview()
    assert.ok(dated.preview.canApply, JSON.stringify(dated.preview))
    await dated.apply(new Map())
    assert.equal(h.file.text, before.replace('! --> #keep | 2024-02-29', ' | 2024-02-29! --> #keep'))
    assert.equal((await h.preview()).preview.canApply, false)
    h.plugin.settings.Defaults['Add Date to Anki IDs'] = false
    assert.equal((await h.preview()).preview.canApply, false)
    assert.deepEqual(h.host.writes, [])
})

test('Whole-page two-way sync uses localized model fields and retains hidden source notes and service fields', async t => {
    const runtime = await loadSync(overlay.directory, pageFile); t.after(runtime.dispose)
    const h = fixture(runtime, { rule: '@page', names: ['Вопрос','Ответ','Источник'], body: '', values: ['Где?','Вена','Archive'] })
    h.plugin.settings.FILE_LINK_FIELDS = { Basic: 'Источник' }
    const before = '%% Личная заметка %%\r\n# Где? #anki-page ^origin\r\n<!--ID: ' + id + ' -->\r\n\r\nВена\r\n'
    h.edit(before)
    const initial = await h.preview()
    assert.ok(initial.preview.canApply, JSON.stringify(initial.preview))
    await initial.apply(new Map())
    h.notes.fields['Ответ'].value = 'Австрия'
    await (await h.preview()).apply(new Map())
    assert.equal(h.file.text,before.replace('Вена','Австрия'))
    h.edit(h.file.text.replace('Где?', 'Какая страна?'))
    await (await h.preview()).apply(new Map())
    assert.deepEqual(h.host.writes.map(r=>r.fields),[{ 'Вопрос': 'Какая страна?' }])
    assert.equal(h.notes.fields['Источник'].value,'Archive')
})

test('a remote-only field on a regex card stays in Anki after upgrade; the old appendix stays verbatim', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { remNoteExpression } = await module('card-format-presets')
    const h = fixture(runtime, { rule: remNoteExpression, body:'Word :: Meaning',
        names:['Front','Back','Импортированный'], values:['Word','Meaning','Из Anki'] })
    const original = h.file.text
    const run = async () => {
        const dialog = await h.preview()
        assert.ok(!dialog.preview.rows.some(row => row.changes?.some(change => change.field === 'Импортированный')))
        if (dialog.preview.canApply) await dialog.apply(new Map())
    }
    await run()
    assert.equal(h.file.text,original)
    const saved = original.replace(' -->', ' -->\r\n<!--anki-fields-->\r\nИмпортированный: Только здесь\r\n<!--/anki-fields-->')
    h.edit(saved)
    await run()
    assert.equal(h.file.text,saved)
    h.edit(original)
    await run()
    assert.equal(h.notes.fields['Импортированный'].value,'Из Anki')
    assert.deepEqual(h.host.writes,[])
})

test('an interrupted 0.9.7 annex write releases only the absent field and resumes the pending answer', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { remNoteExpression } = await module('card-format-presets')
    const h = fixture(runtime, {rule: remNoteExpression, body:'Word :: Old', names:['Front','Back','Импортированный'],
        values:['Word','New','Keep Anki']})
    const path = '.obsidian/plugins/rudonium/bidirectional-sync.json'
    const state = await runtime.BidirectionalState.open(h.plugin.app.vault.adapter, path, 'QA')
    const value = (back, extra) => ({front:'Word', back, tags:[], extra:{'Импортированный':extra}})
    await state.checkpoint([[id, { pending:{
        obsidian:value('Old',''), anki:value('New','Keep Anki'), target:value('New','Keep Anki'),
        extraDirections:{'Импортированный':'both'}
    }}]])
    const before = h.file.text
    const dialog = await h.preview()
    assert.match(await dialog.apply(new Map()), /Updated 1 note in (?:Anki|Obsidian)\./)
    assert.equal(h.file.text, before.replace(':: Old',':: New'))
    assert.deepEqual(h.host.writes,[])
    assert.equal((await h.preview()).preview.canApply,false)
    assert.equal(h.notes.fields['Импортированный'].value,'Keep Anki')
})

test('mode switches preserve a deliberate revert and independent edits after a newer one-way export', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    for (const [local, remote, direction, legacy] of [
        ['First', 'Second', 'obsidian', false],
        ['Second', 'First', 'anki', false],
        ['First', 'Third', 'conflict', false],
        ['Third', 'First', 'conflict', false],
        ['First', 'Second', 'conflict', true],
    ]) {
        const h = fixture(runtime, {rule:'^Q=(.+?) -> A=(.+)$', names:['Front','Back'],
            body:'Q=First -> A=Answer', values:['First','Answer']})
        await (await h.preview()).apply(new Map())
        const path = '.obsidian/plugins/rudonium/bidirectional-sync.json'
        if (legacy) {
            const state = await runtime.BidirectionalState.open(h.plugin.app.vault.adapter,path,'QA')
            const previous = { ...state.get(id) }
            delete previous.pairReceipt
            await state.checkpoint([[id,previous]])
        }
        // Send and verify an actual export, including its receipt, before returning to two-way sync.
        h.plugin.settings.BIDIRECTIONAL_SYNC = false
        h.edit(h.file.text.replace('Q=First', 'Q=Second'))
        const history = await runtime.openOneWayHistory(h.plugin, 'QA')
        const source = {id, path:h.file.path, modelName:'Basic', fields:{Front:'Second'}, authoredFields:['Front'],
            deck:'Knowledge', tags:[]}
        const actions = await runtime.delta.prepareExistingNoteChanges([source],(_path,why)=>assert.fail(why),
            new Map([[id,h.notes]]),undefined,{history,allowDeckMoves:false})
        for (const request of actions.get(h.file.path)) await h.host.request(request.action, request.params)
        const receipts = []
        const issues = await runtime.delta.verifyExistingNoteFieldWrites(actions,(_path,why)=>assert.fail(why),
            {models:new Map([[id,'Basic']]),capture:receipt=>receipts.push(receipt)})
        assert.deepEqual(issues, [])
        history.apply(receipts)
        await history.flush()
        h.edit(h.file.text.replace('Q=Second', 'Q='+local))
        h.notes.fields.Front.value = remote
        h.plugin.settings.BIDIRECTIONAL_SYNC = true
        const dialog = await h.preview()
        const row = dialog.preview.rows.flatMap(note => note.changes).find(field => field.field === 'Front')
        assert.equal(row?.decision, direction, JSON.stringify([local,remote,legacy]))
        await dialog.apply(new Map())
        const pending = direction === 'conflict'
        const expected = direction === 'anki' ? remote : local
        assert.ok(h.file.text.includes('Q='+(pending ? local : expected)+' -> A=Answer'))
        assert.equal(h.notes.fields.Front.value, pending ? remote : expected)
        assert.deepEqual(h.notes.cards,[id+60])
        assert.ok(h.file.text.includes('<!--ID: '+id+' -->'))
    }
})

test('an undated dictionary bullet uses its actual custom export rule on the first sync', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const { knowledgeBulletExpression } = await module('card-format-presets')
    const rule = knowledgeBulletExpression.replace('^- ', '^[-] ')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    const question = 'Казематы', back = 'Сводчатые помещения внутри крепостных укреплений'
    const h = fixture(runtime, { rule, names, body: '- ' + question + ' :: ' + back + ' :: R',
        values: [question, back, 'R', '', ''] })
    const original = h.file.text.replace('## City\r\n', '').replace(' -->', '-->')
    h.edit(original)
    const history = await runtime.openOneWayHistory(h.plugin, 'QA')
    history.apply([{ id, modelName: 'Basic', fields: { Front: question, Back: back } }])
    await history.flush()
    h.notes.fields.Front.value = 'Новые казематы'
    const inbound = await h.preview()
    assert.equal(inbound.preview.rows.flatMap(row => row.changes).find(change => change.field === 'Front')?.decision, 'anki')
    await inbound.apply(new Map())
    assert.equal(h.file.text, original.replace(question, 'Новые казематы'))
    h.edit(h.file.text.replace(back, 'Обновлённое описание'))
    await (await h.preview()).apply(new Map())
    assert.deepEqual(h.host.writes.map(op => [op.id, op.fields]), [[id, { Back: 'Обновлённое описание' }]])

    // The source is now cached. Unsupported remote formatting must not be reported as a missing Markdown rule.
    await h.preview()
    h.notes.fields.Front.value = '<table><tr><td>Сложная разметка</td></tr></table>'
    const blocked = await h.preview()
    assert.equal(blocked.preview.canApply, false)
    assert.ok(blocked.preview.rows.some(row => row.issues?.some(reason => reason.includes('formatting'))))
})

test('legacy dictionary syntax cannot claim a different export range or model', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const { knowledgeBulletExpression } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    for (const wrongRange of [false, true]) {
        const rule = knowledgeBulletExpression.replace('^- ', wrongRange ? '^## City\\r?\\n- ' : '^[-] ')
        const h = fixture(runtime, { rule, names, body: '- Казематы :: Ответ :: R', values: ['Поздняя правка', 'Ответ', 'R', '', ''] })
        if (!wrongRange) h.host.decorateRegexNote = note => { note.modelName = 'Other' }
        const plan = await h.preview()
        assert.equal(plan.preview.canApply, false)
        assert.ok(plan.preview.rows.some(row => row.issues?.length))
        assert.deepEqual(h.host.writes, [])
    }
})

test('a Knowledge rule assigned to another model keeps the existing linked dictionary owner', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const { knowledgeBulletExpression } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    const h = fixture(runtime, { rule: '', names, body: '- Казематы :: Ответ :: R', values: ['Обновлено в Anki', 'Ответ', 'R', '', ''] })
    h.host.expressions = h.plugin.settings.CUSTOM_REGEXPS = { Other: knowledgeBulletExpression }
    h.plugin.fields_dict.Other = names
    h.edit(h.file.text.replace('## City', '## Карточки'))
    const original = h.file.text
    const history = await runtime.openOneWayHistory(h.plugin, 'QA')
    history.apply([{ id, modelName: 'Basic', fields: { Front: 'Казематы', Back: 'Ответ' } }])
    await history.flush()
    const plan = await h.preview()
    assert.equal(plan.preview.rows.flatMap(row => row.changes).find(change => change.field === 'Front')?.decision, 'anki')
    await plan.apply(new Map())
    assert.equal(h.file.text, original.replace('Казематы', 'Обновлено в Anki'))
    assert.deepEqual(h.host.writes, [])
})

test('linked separator spacing is silent, follows inbound/outbound field changes, and never rewrites a stale source', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const { knowledgeBulletExpression, remNoteExpression } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    const before = '- Казематы:: Сводчатые помещения :: R'
    const expected = '- Казематы :: Сводчатые помещения :: R'
    for (const rule of [knowledgeBulletExpression, knowledgeBulletExpression.replace('^- ', '^[-] '), remNoteExpression]) {
        const h = fixture(runtime, { rule, names, body: before, values: ['Казематы', 'Сводчатые помещения', 'R', '', ''] })
        h.plugin.settings.SYNC_CHANGE_HISTORY = true
        const original = h.file.text
        const preview = await h.preview()
        assert.equal(h.file.text, original)
        assert.ok(preview.preview.canApply, JSON.stringify(preview.preview))
        assert.deepEqual(preview.preview.rows, [])
        assert.equal(await preview.apply(new Map()), 'No changes.')
        assert.equal(h.file.text, original.replace(before, expected))
        assert.deepEqual(h.host.writes, [])
        assert.equal((await h.preview()).preview.canApply, false)
        h.edit(h.file.text.replace(expected, '- Каземат:: Новый ответ ::R'))
        assert.equal(await (await h.preview()).apply(new Map()), 'Updated 1 note in Anki.')
        assert.ok(h.file.text.includes('- Каземат :: Новый ответ :: R'))
        assert.equal(h.notes.fields.Back.value, 'Новый ответ')
        h.edit(h.file.text.replace(' :: Новый ответ', ' ::Новый ответ'))
        h.notes.fields.Back.value = 'Изменено в Anki'
        assert.equal(await (await h.preview()).apply(new Map()), 'Updated 1 note in Obsidian.')
        assert.ok(h.file.text.includes('- Каземат :: Изменено в Anki :: R'), h.file.text)
        const normalization = (await runtime.readSyncChanges(h.plugin)).find(row => row.action === 'normalize')
        assert.equal(normalization.direction, 'local')
        assert.deepEqual(normalization.fields, [{ name: 'Markdown', before: '- Каземат ::Новый ответ :: R', after: '- Каземат :: Изменено в Anki :: R' }])
        assert.ok(h.file.text.includes('\r\n<!--ID: ' + id + ' -->\r\n\r\nDraft'))
        h.edit(h.file.text.replace(' :: Изменено', ':: Изменено'))
        const stale = await h.preview()
        const latest = h.file.text + '!'
        h.edit(latest)
        await assert.rejects(stale.apply(new Map()))
        assert.equal(h.file.text, latest)
    }
})

test('one-way export synchronizes the repaired note to Anki and leaves an unchanged sibling and unrelated fields alone', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const { knowledgeBulletExpression: rule, separatorRepair } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse']
    const before = '- Казематы:: Ответ ::R'
    const h = fixture(runtime, { rule, names, body: before, values: ['Казематы', 'Правка в Anki', 'R'] })
    const sibling = id + 1
    const siblingData = structuredClone(h.notes)
    siblingData.noteId = sibling
    siblingData.fields.Front.value = 'Сосед'
    const target = { modelName: 'Basic', deckName: 'Knowledge', fields: { Front: 'Казематы', Back: 'Ответ', 'Add Reverse': 'R' }, tags: [] }
    const other = { ...target, fields: { ...target.fields, Front: 'Сосед' } }
    const parsed = { file: h.file.text, original_file: h.file.text, global_tags: '', path: h.file.path,
        separatorRepairs: new Map([[target, separatorRepair(before, true)]]),
        notes_to_edit: [{ identifier: id, note: target }, { identifier: sibling, note: other }] }
    const Manager = patched.managerType({ ...runtime.portableParser, ...runtime.delta })
    const manager = Object.assign(new Manager(), { data: { fields_dict: { Basic: names } }, ownFiles: [parsed],
        linkedSnapshots: new Map([[id, h.notes], [sibling, siblingData]]) })
    manager.deckRouteFor = () => undefined
    useHost(h.host)
    manager.oneWayHistory = await runtime.openOneWayHistory(h.plugin, 'QA')
    manager.oneWayHistory.apply([id, sibling].map((key, i) => ({ id: key, modelName: 'Basic', fields: i ? other.fields : target.fields })))
    await manager.prepareExistingUpdates()
    const requests = manager.existingChanges.get(h.file.path)
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].params.note, { id, fields: { Back: 'Ответ' } })
    await h.host.request(requests[0].action, requests[0].params)
    assert.equal(h.notes.fields.Back.value, 'Ответ')
    assert.equal(siblingData.fields.Back.value, 'Правка в Anki')
    await manager.prepareExistingUpdates()
    assert.equal(manager.existingChanges.size, 0)
})

test('automatic two-way sync silently repairs spacing, merges distinct fields at their destinations, and defers an ambiguous first sync', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const { knowledgeBulletExpression: rule } = await module('card-format-presets')
    const names = ['Front', 'Back', 'Add Reverse', 'FrontLang', 'BackLang']
    const h = fixture(runtime, { rule, names, body: '- Казематы :: Ответ :: R', values: ['Казематы', 'Ответ', 'R', '', ''] })
    useHost(h.host)
    h.plugin.settings.INTERFACE_LANGUAGE = 'ru'
    const run = async () => {
        assert.equal(await runtime.scanVaultFast(h.plugin, false, true), 'completed')
        return h.host.notices.at(-1)
    }
    await run()
    h.edit(h.file.text.replace(' :: Ответ', ':: Ответ'))
    assert.equal(await run(), 'Проверена 1 запись.\nИзменений нет.')
    assert.match(h.file.text, /Казематы :: Ответ/u)
    assert.deepEqual(h.host.writes, [])
    h.edit(h.file.text.replace('Казематы :: Ответ', 'Бастионы:: Ответ'))
    h.notes.fields.Back.value = 'Правка ответа в Anki'
    assert.equal(await run(), 'Проверена 1 запись.\nИзменена 1 запись в Anki.\nИзменена 1 запись в Obsidian.')
    assert.match(h.file.text, /Бастионы :: Правка ответа в Anki/u)
    assert.deepEqual(h.host.writes.at(-1), { id, fields: { Front: 'Бастионы' } })

    const fresh = fixture(runtime, { rule, names, body: '- Казематы:: Ответ :: R', values: ['Чужая правка', 'Ответ', 'R', '', ''] })
    fresh.file.stat.mtime = Date.now()
    fresh.notes.mod = Math.floor(fresh.file.stat.mtime / 1000) - 20
    useHost(fresh.host)
    assert.equal(await runtime.scanVaultFast(fresh.plugin, false, true), 'completed')
    assert.deepEqual(fresh.host.writes, [])
    assert.match(fresh.host.notices.at(-1), /Deferred 1 note for review/u)
    assert.match(fresh.file.text, /Казематы:: Ответ/u)
})

test('only unambiguous Knowledge card separators receive spacing repairs', async () => {
    const { separatorRepair, knowledgeMatchAllowed } = await module('card-format-presets')
    const cases = [
        ['- Казематы:: Сводчатые ::R', true, '- Казематы :: Сводчатые :: R'],
        ['- Казематы::Ответ ::B=de_DE', false, '- Казематы :: Ответ :: B=de_DE'],
        ['- Казематы ::Ответ', true, '- Казематы :: Ответ'],
        ['- Статус:: Готово', false], ['- std::vector', true], ['- [::1] :: IP', true],
        ['- `key:: value` :: R', true], ['- foo::: bar', true], ['- x : Ответ', true],
        ['- Q :: A :: R', true], ['- A:: B :: unknown', true], ['Status:: In Progress', true],
    ]
    for (const [line, linked, expected] of cases) {
        assert.equal(separatorRepair(line, linked)?.after, expected, line)
        if (expected) assert.equal(knowledgeMatchAllowed(line, linked), true, line)
    }
})

test('one-way separator preview and write preserve the ID, Markdown guards and line endings', async () => {
    const { separatorRepair } = await module('card-format-presets')
    const before = '- Казематы:: Ответ ::R', after = '- Казематы :: Ответ :: R'
    const note = { modelName: 'Basic' }
    const repair = separatorRepair(before, true)
    for (const eol of ['\n', '\r\n']) {
        const input = ['## Карточки', before, 'Tags: history', 'SUSPEND', '<!--ID: ' + id + '-->', 'Extra', before].join(eol)
        const Manager = patched.managerType({ findIdMarkers: () => [{ line: 5, id }],
            readSuspendLine: line => line === 'SUSPEND', exportOperationKey: (...args) => JSON.stringify(args) })
        const manager = new Manager()
        const file = { path: 'Cards.md', file: input, notes_to_edit: [{ identifier: id, note }], separatorRepairs: new Map([[note, repair]]) }
        const suggested = manager.reviewSpacing(file, true)
        assert.deepEqual([...suggested.keys()], [id])
        const [op] = manager.previewOperations.get(file.path)
        assert.deepEqual(op.values, [{ name: 'Markdown', before, after }])
        assert.equal(file.file, input)
        manager.previewSelection = { paths: new Map([[file.path, new Set()]]) }
        assert.equal(manager.reviewSpacing(file, false).size, 0)
        manager.previewSelection.paths.get(file.path).add(op.key)
        const approved = manager.reviewSpacing(file, false)
        assert.deepEqual([...manager.saveSpacing(file, approved)], [id])
        assert.equal(file.file, input.replace(before, after))
        assert.equal(manager.saveSpacing(file, approved).size, 0)
        file.file = input.replace(before, before + '!')
        assert.equal(manager.saveSpacing(file, approved).size, 0)
        assert.ok(file.file.endsWith(before))
    }
})

test('a failed first two-way sync records the schema error once; preview and disabled history stay read-only', async t => {
    const runtime = await loadSync(overlay.directory)
    t.after(runtime.dispose)
    const h = fixture(runtime, { rule: '^Q (.+?) A (.+)$', names: ['Front', 'Back'], body: 'Q One A Two', values: ['One', 'Two'] })
    useHost(h.host)
    h.plugin.fields_dict = {}
    runtime.registerFastScan(h.plugin, undefined, async () => { throw new Error('AnkiConnect offline on startup') })
    h.plugin.settings.SYNC_CHANGE_HISTORY = true
    await runtime.previewBidirectionalSync(h.plugin, { currentOnly: true })
    assert.deepEqual(await runtime.readSyncChanges(h.plugin), [])
    assert.equal(await runtime.scanVaultFast(h.plugin, false, true), 'failed')
    const rows = await runtime.readSyncChanges(h.plugin)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].path, h.file.path)
    assert.equal(rows[0].profile, undefined)
    assert.equal(rows[0].action, 'error')
    assert.equal(rows[0].direction, 'none')
    assert.match(rows[0].detail, /note types.*AnkiConnect offline on startup/)
    h.plugin.settings.SYNC_CHANGE_HISTORY = false
    assert.equal(await runtime.scanVaultFast(h.plugin, false, true), 'failed')
    assert.equal((await runtime.readSyncChanges(h.plugin)).length, 1)
})

test('Apply keeps skipped text on both sides and applies the other field of the same note in either direction', async t => {
    const runtime = await loadSync(overlay.directory); t.after(runtime.dispose)
    const { remNoteExpression: rule } = await module('card-format-presets')
    for (const direction of ['obsidian', 'anki']) {
        const h = fixture(runtime, { rule, body: 'Question :: Answer', names: ['Front', 'Back'], values: ['Question', 'Answer'] })
        await (await h.preview()).apply(new Map())
        h.edit(h.file.text.replace('Question :: Answer', 'Local Q :: Local A'))
        h.notes.fields.Front.value = 'Remote Q'
        h.notes.fields.Back.value = 'Remote A'
        const before = h.file.text
        const front = id + ':front', back = id + ':back'
        let dialog = await h.preview()
        assert.equal(dialog.preview.rows[0].changes.filter(change => change.decision === 'conflict').length, 2)
        await dialog.apply(new Map([[front, 'skip'], [back, 'skip']]))
        assert.equal(h.file.text, before)
        assert.deepEqual(h.host.writes, [])
        dialog = await h.preview()
        await dialog.apply(new Map([[front, 'skip'], [back, direction]]))
        assert.equal(h.notes.fields.Front.value, 'Remote Q')
        assert.equal(h.notes.fields.Back.value, direction === 'anki' ? 'Remote A' : 'Local A')
        assert.equal(h.file.text, direction === 'anki' ? before.replace('Local A', 'Remote A') : before)
        const next = await h.preview()
        assert.deepEqual(next.preview.rows.flatMap(row => row.changes).map(change => [change.key, change.decision]), [[front, 'conflict']])
        await next.apply(new Map([[front, 'anki']]))
        assert.ok(h.file.text.includes('Remote Q :: '))
        assert.equal((await h.preview()).preview.rows.flatMap(row => row.changes).length, 0)
    }
})
