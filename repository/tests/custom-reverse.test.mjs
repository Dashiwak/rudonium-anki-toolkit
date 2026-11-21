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
    assert.equal(unsafe.preview.canApply,false); assert.match(JSON.stringify(unsafe.preview.rows), /boundary/)
    assert.ok(!h.file.text.includes('Part'))
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
    assert.match(await dialog.apply(new Map()), /Confirmed 1 of 1/)
    assert.equal(h.file.text, before.replace(':: Old',':: New'))
    assert.deepEqual(h.host.writes,[])
    assert.equal((await h.preview()).preview.canApply,false)
    assert.equal(h.notes.fields['Импортированный'].value,'Keep Anki')
})
