// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')

const syntax = { 'Delete Note Line': 'снять.[*]?' }
const label = syntax['Delete Note Line']
const names = ['archived-card', 'markdown-pipeline', 'duplicate-markers', 'anki-id-marker', 'id-marker-literals', 'deletion-source', 'bidirectional-blocks', 'bidirectional-markdown', 'linked-bullets', 'page-card', 'card-format-presets', 'export-recovery']
const api = { Md5: { hashStr: text => createHash('md5').update(text).digest('hex') }, isRecoveryTag: () => false }
const fixtures = load([...names, 'anki'], api, { anki: 'export const invoke = () => { throw new Error() }' })
const modules = fixtures.then(result => result['deletion-source'])
const joined = rows => rows.join('\r\n')
const marked = (input, marker, value) => input.replace(marker, value)

test('custom literal DELETE, CRLF, confirmed IDs only, tags and adjacent cards', async () => {
    const m = await modules
    const first = joined(['- One :: A', label, '<!--ID: 123 -->', '<!-- anki-bidirectional-tags: {"add":["x"],"remove":[]} -->', ''])
    const second = joined(['- Two :: B', label, 'ID: 124', ''])
    const text = '## Cards\r\n' + first + second + 'tail'
    const plan = m.explicitDeletes(text, syntax, {})
    assert.deepEqual([...plan.directives].map(d => d.id), [123, 124])
    assert.equal(plan.masked.length, text.length)
    assert.equal(plan.masked.split('\r\n').length, text.split('\r\n').length)
    assert.equal(m.cleanConfirmedDeletes(text, plan, new Set([123]), 'remove', false).text, '## Cards\r\n' + second + 'tail')
    const retained = m.cleanConfirmedDeletes(text, plan, new Set([123]), 'keep', true).text
    assert.equal(retained, marked(text, label + '\r\n', ''))
    assert.deepEqual([...m.explicitDeletes(retained, syntax, {}).directives].map(d => d.id), [124])
    assert.equal(m.cleanConfirmedDeletes(text, plan, new Set(), 'remove', true).text, text)
})

test('standalone commands leave neighboring prose and clear only on confirmation; ignored literals and duplicate IDs', async () => {
    const m = await modules
    const fenced = joined(['```md', label, 'ID: 1', '```', '$$', label, 'ID: 2', '$$', '%%', label, 'ID: 3', '%%', ''])
    const text = fenced + joined(['', label + ' <!--ID: 4 -->', '', 'regular text'])
    const plan = m.explicitDeletes(text, syntax, {})
    assert.deepEqual([...plan.directives].map(d => d.id), [4])
    assert.equal(m.cleanConfirmedDeletes(text, plan, new Set([4]), 'remove', true).text, fenced + '\r\n\r\nregular text')
    assert.throws(() => m.explicitDeletes(text + '\nID: 4', syntax, {}), /duplicate/i)
    assert.equal(m.explicitDeletes('    DELETE\n    ID: 1\n\tDELETE ID: 2', {}, {}), undefined)
    assert.equal(m.explicitDeletes('DELETE ME\nID: 4', {}, {}), undefined)
})

test('page-local opt-in and full-page fingerprint cover YAML and route; unchanged source in other path is distinct', async () => {
    const m = await modules
    const text = joined(['---', 'tags: local', '---', '# Capitals #anki-page', label, '<!--ID: 77 -->', '', 'London', ''])
    const plan = m.explicitDeletes(text, syntax, { Basic: '@page' })
    assert.equal(plan.directives[0].card.page, true)
    assert.equal(plan.directives[0].card.start, 0)
    assert.equal(plan.directives[0].card.end, text.length)
    const held = m.cleanConfirmedDeletes(text, plan, new Set([77]), 'remove', false)
    assert.equal(held.trash, false)
    assert.equal(held.text, text.replace(label + '\r\n', ''))
    assert.equal(m.cleanConfirmedDeletes(text, plan, new Set([77]), 'remove', true).trash, true)
    assert.equal(m.cleanConfirmedDeletes(text, plan, new Set([77]), 'keep', true).trash, false)
    const card = plan.directives[0].card
    assert.notEqual(m.deletionSignature(text, 'x.md', card), m.deletionSignature(text, 'y.md', card))
    assert.notEqual(m.deletionSignature(text, 'x.md', card), m.deletionSignature(text.replace('local', 'other'), 'x.md', card))
})

test('unknown adjacent source keeps its ID, mixed/invalid source ranges fail closed', async () => {
    const m = await modules
    const text = 'my-custom Q&A\n' + label + '\nID: 66'
    const plan = m.explicitDeletes(text, syntax, {})
    assert.equal(m.cleanConfirmedDeletes(text, plan, new Set([66]), 'remove', true).text, 'my-custom Q&A\nID: 66')
    const spaced = 'Q? q\nA! a\n\nDELETE\nID: 55'
    const unknown = m.explicitDeletes(spaced, {}, { Basic: '^Q\\? (.+)\\nA! (.+)\\n' })
    assert.equal(unknown.directives[0].detached, false)
    assert.equal(m.cleanConfirmedDeletes(spaced, unknown, new Set([55]), 'remove', false).text, 'Q? q\nA! a\n\nID: 55')
    assert.throws(() => m.withoutRanges(text, [{start:1,end:3},{start:2,end:4}]), /ambiguous/i)
})

test('global deletion evidence requires complete per-ID responses and the same profile before and after Anki reads', async () => {
    const calls = []
    const answers = new Map([[12,true],[13,false]])
    const mod = (await load(['deletion-source'], { ...api,
        checkPinnedAnkiProfile: async profile => { calls.push(profile); if (calls.length === 4) throw Error('profile switched') },
        checkAnkiNoteExistence: async () => answers }))['deletion-source']
    assert.equal((await mod.deletionPresence([12,13], 'First')).get(12), true)
    await assert.rejects(mod.deletionPresence([12], 'First'), /profile switched/)
    await assert.rejects(mod.deletionPresence([99], 'First'), /did not verify/)
})

test('marking scope excludes detached and uncertain cards; explicit and verified remote deletions share one policy', async () => {
    const m = await modules
    const archiveLabel = 'Deleted from Anki'
    const known = '## Cards\n- One :: A\nDELETE\nID: 12\n'
    const standalone = '\nDELETE ID: 13\n'
    const text = known + standalone
    const plan = m.explicitDeletes(text, {}, {})
    const confirmed = new Set([12, 13])
    const result = m.cleanConfirmedDeletes(text, plan, confirmed, 'mark', false, [], archiveLabel)
    assert.equal(result.trash, false)
    assert.ok(result.text.includes('Deleted from Anki'))
    assert.ok(result.text.includes('- One :: A\nID: 12'))
    assert.ok(!result.text.includes('ID: 13'))
    const source = known.replace('DELETE\n', '')
    const implicit = { id: 12, start: source.indexOf('- One'), end: source.length, page: false }
    const archived = m.cleanConfirmedDeletes(source, undefined, new Set([12]), 'mark', false, [implicit], archiveLabel)
    assert.equal(result.text.trimEnd(), archived.text.trimEnd())
    assert.equal(m.cleanConfirmedDeletes(source, undefined, new Set(), 'mark', false, [implicit], archiveLabel).text, source)
    const unknown = 'Q? q\nA! a\n\nDELETE\nID: 15'
    const custom = m.explicitDeletes(unknown, {}, { Basic: '^Q\\? (.+)\\nA! (.+)\\n' })
    assert.equal(m.cleanConfirmedDeletes(unknown, custom, new Set([15]), 'mark', false, [], archiveLabel).text, unknown.replace('DELETE\n', ''))
})

test('page archive preserves YAML, original ID and Markdown body; opt-in page trash takes precedence with cleanup', async () => {
    const m = await modules
    const source = '\ufeff---\r\ntags: geography\r\n---\r\n# Capital #anki-page\r\nDELETE\r\nID: 9\r\n\r\n~~old~~ Paris'
    const plan = m.explicitDeletes(source, {}, {Basic:'@page'})
    const marked = m.cleanConfirmedDeletes(source, plan, new Set([9]), 'mark', false, [], 'Deleted from Anki')
    assert.equal(marked.trash, false)
    assert.ok(marked.text.startsWith('\ufeff---\r\ntags: geography\r\n---\r\n'))
    assert.ok(marked.text.includes('# Capital #anki-page\r\nID: 9\r\n\r\n~~old~~ Paris'))
    assert.ok(marked.text.includes('Deleted from Anki'))
    assert.equal(m.cleanConfirmedDeletes(source, plan, new Set([9]), 'remove', true, [], 'Deleted from Anki').trash, true)
})

test('consuming the command puts the ID directly below the card and keeps its authored indentation', async () => {
    const m = await modules
    for (const eol of ['\n', '\r\n']) for (const id of ['ID: 7', '<!--ID: 7 -->']) {
        const expected = ['## Cards','- Front :: Back','  ' + id,'','Tail'].join(eol)
        for (const separate of [true, false]) {
            const line = separate ? '  ' + label + '  ' + eol + '  ' + id : '  ' + label + ' \t ' + id
            const text = ['## Cards','- Front :: Back',line,'','Tail'].join(eol)
            const plan = m.explicitDeletes(text, syntax, {})
            assert.equal(m.cleanConfirmedDeletes(text, plan, new Set([7]), 'keep', false).text, expected)
            assert.equal(m.explicitDeletes(expected, syntax, {}), undefined)
        }
    }
})

test('YAML page commands leave properties intact, archived IDs reserved, and remove only on confirmation', async () => {
    const m = await modules
    const props = '\ufeff---\r\narea: test\r\nanki-page-ID: "33" # link\r\n---\r\n'
    const content = props + '# Q #anki-page\r\n' + label + '\r\nA\r\n'
    const clean = content.replace(label + '\r\n', '')
    const expr = {Basic: '@page'}
    const plan = m.explicitDeletes(content, syntax, expr)
    assert.equal(plan.directives.length, 1)
    assert.equal(plan.directives[0].card.page, true)
    const id = new Set([33])
    assert.equal(m.cleanConfirmedDeletes(content, plan, new Set(), 'remove', true).text, content)
    assert.equal(m.cleanConfirmedDeletes(content, plan, id, 'keep', true).text, clean)
    assert.equal(m.cleanConfirmedDeletes(content, plan, id, 'remove', false).text, clean)
    assert.equal(m.cleanConfirmedDeletes(content, plan, id, 'remove', true).trash, true)
    const libs = await load(['archived-card','duplicate-markers'])
    for (const mode of ['mark','strike','hidden']) {
        const { text, trash } = m.cleanConfirmedDeletes(content, plan, id, mode, true)
        assert.equal(trash, false)
        assert.ok(text.startsWith(props))
        assert.equal(libs['archived-card'].archivedCardRanges(text)[0].id, 33)
        assert.deepEqual(Array.from(libs['duplicate-markers'].findIdMarkers(text)), [])
        assert.equal(libs['duplicate-markers'].archivedIdMarkers(text)[0].id, 33)
        assert.throws(() => libs['archived-card'].activeCardMarkdown(text.replace('"33"', '"34"')), /archive boundaries/)
    }
    assert.equal(m.explicitDeletes(clean + 'notes: ' + label, syntax, expr), undefined)
    assert.throws(() => m.explicitDeletes(content, syntax, {}), /@page/)
    assert.throws(() => m.explicitDeletes(content.replace('A\r\n', 'SUSPEND\r\nA\r\n'), syntax, expr), /[Cc]onflict/)
    assert.throws(() => m.explicitDeletes(content.replace('A\r\n', 'ID: 99\r\nA\r\n'), syntax, expr), /[Cc]onflict/)
})

test('an answer boundary protects private notes and properties through both deletion paths', async () => {
    const m = await modules
    const libs = await load(['page-card','card-format-presets','duplicate-markers','export-recovery','anki'], {}, {anki:'export {}'})
    const expr = {Basic:'@page'}, id = new Set([33])
    for (const location of ['heading','yaml']) {
        const top = '\ufeff---\r\nnotes: keep\r\n'
        const props = top + (location === 'yaml' ? 'anki-page-ID: 33\r\n' : '') + '---\r\n'
        const prefix = props + '# Q #anki-page\r\n'
        const content = prefix + label + '\r\n' + (location === 'heading' ? 'ID: 33\r\n' : '') +
            'Visible answer.\r\n<!--rudonium-answer-end-->\r\n'
        const tail = '\r\n## Private\r\nKeep these notes.\r\n'
        const live = content + tail, clean = live.replace(label+'\r\n','')
        const local = m.explicitDeletes(live, syntax, expr)
        const card = libs['page-card'].readPageCard(clean, expr, syntax)
        const removal = m.sourceRemoval(clean, {...card, format:'page'})
        assert.equal(removal.bounded,true)
        for (const mode of ['keep','mark','strike','hidden','remove']) {
            for (const trashPages of [true,false]) {
                const result = m.cleanConfirmedDeletes(live,local,id,mode,trashPages)
                const remote = m.cleanConfirmedDeletes(clean,undefined,id,mode,trashPages,[removal])
                assert.equal(result.text,remote.text)
                assert.equal(result.trash,false)
                assert.ok(result.text.endsWith(tail))
                if (mode === 'remove' || mode === 'keep') assert.equal(result.text,clean)
                else {
                    assert.ok(result.text.startsWith(props))
                    assert.equal(libs['duplicate-markers'].findIdMarkers(result.text).length,0)
                    const active = (await load(['archived-card']))['archived-card'].activeCardMarkdown(result.text)
                    assert.ok(!active.includes('Keep these notes.'))
                }
            }
        }
    }
})

test('whole-page controls, date and archive share one owner for YAML tags and tags in the answer', async () => {
    const deletion = await modules
    const libs = await load(['archived-card', 'duplicate-markers', 'anki-id-marker', 'id-marker-literals', 'suspend-marker'])
    const archive = libs['archived-card'], markers = libs['duplicate-markers'], dates = libs['anki-id-marker']
    const suspend = libs['suspend-marker'], rules = { Basic: '@page' }
    for (const tag of ['yaml', 'inline', 'private', 'before-control']) {
        const yaml = ['---','ID: 71', ...(tag === 'yaml' ? ['tags: [travel, ANKI-PAGE]'] : []),
            'anki-page-ID: "33" # note', '---', ''].join('\r\n')
        const question = '# Question?\r\n' + (tag === 'before-control' ? '#anki-page\r\n' : '')
        const answer = 'Answer' + (tag === 'inline' ? ' #anki-page' : '') + '\r\n'
        const privateTail = '<!--rudonium-answer-end-->\r\n' + (tag === 'private' ? '#anki-page\r\n' : '') + 'ID: 99\r\nDELETE\r\nSUSPEND_1\r\n'
        const source = yaml + question + answer + privateTail
        assert.deepEqual(Array.from(dates.ankiIdNumberTokens(source)), [33])
        const dated = dates.dateLinkedMarkers(source, markers.findIdMarkers(source), new Set([33]), '2026-11-20')
        assert.equal(dated, source.replace('# note', '# | 2026-11-20 note'))
        const paused = suspend.rewriteSuspendMarkers(source, new Map([[33, [2]]]), {})
        assert.equal(paused, source.replace(question, question + 'SUSPEND_2\r\n'))
        assert.equal(Array.from(suspend.readSuspendMarkers(paused).get(33).selection).join(','), '2')
        assert.equal(suspend.rewriteSuspendMarkers(paused, new Map([[33, null]])), source)
        assert.equal(deletion.explicitDeletes(source, {}, rules), undefined)
        const requested = source.replace(question, question + 'DELETE\r\n')
        const plan = deletion.explicitDeletes(requested, {}, rules)
        assert.deepEqual(Array.from(plan.directives, d => [d.id, d.card.bounded]), [[33, true]])
        assert.equal(deletion.cleanConfirmedDeletes(requested, plan, new Set([33]), 'remove', true).text, source)
        for (const mode of ['mark','strike','hidden']) {
            const result = deletion.cleanConfirmedDeletes(requested, plan, new Set([33]), mode, true)
            assert.equal(result.trash, false)
            const [range] = archive.archivedCardRanges(result.text)
            assert.equal(range.id, 33)
            assert.equal(range.privateTail, true)
            assert.equal(result.text.slice(range.yamlStart, range.yamlEnd), 'anki-page-ID: "33" # note')
            assert.deepEqual(Array.from(markers.findIdMarkers(result.text)), [])
            assert.deepEqual(Array.from(markers.archivedIdMarkers(result.text), row => row.id), [33])
            assert.ok(result.text.endsWith('ID: 99\r\nDELETE\r\nSUSPEND_1\r\n'))
            assert.ok(!archive.activeCardMarkdown(result.text).includes('ID: 99'))
        }
    }
})

test('a private-only page tag survives local and remote deletion in all layouts without exposing private IDs', async () => {
    const deletion = await modules
    const libs = await load(['page-card','card-format-presets','archived-card','duplicate-markers','anki-id-marker','id-marker-literals','export-recovery'], api)
    const archive = libs['archived-card'], markers = libs['duplicate-markers'], rules = { Basic: '@page' }
    for (const layout of ['heading','yaml','after-answer']) {
        const properties = ('---\n' + (layout === 'yaml' ? 'anki-page-ID: 101\n' : '') + '---\n')
        const content = '# Q\n' + (layout === 'heading' ? 'ID: 101\n' : '') + 'Back\n<!--anki-fields-->\nHint: A hint\n'
            + (layout === 'after-answer' ? '<!--ID: 101 @page-->\n' : '') + '<!--rudonium-answer-end-->\n'
        const privateNotes = '\nMy #anki-page\nDELETE\nID: 202\n'
        const clean = properties + content + privateNotes
        const pending = clean.replace('# Q\n', '# Q\nDELETE\n')
        const page = libs['page-card'].readPageCard(clean, rules)
        assert.equal(page.id,101)
        assert.equal(page.namedFields.get('Hint').value, 'A hint')
        const plan = deletion.explicitDeletes(pending, {}, rules)
        const removal = deletion.sourceRemoval(clean, {...page, format:'page'})
        for (const mode of ['keep','remove','mark','hidden','strike']) {
            const local = deletion.cleanConfirmedDeletes(pending, plan, new Set([101]), mode, true)
            const remote = deletion.cleanConfirmedDeletes(clean, undefined, new Set([101]), mode, true,[removal])
            assert.equal(remote.trash, false)
            assert.equal(remote.text, local.text)
            assert.ok(local.text.endsWith(privateNotes))
            if (mode === 'keep' || mode === 'remove') continue
            const [range] = archive.archivedCardRanges(local.text)
            const original = archive.archivedCardSource(local.text, range).trimEnd()
            assert.equal(original, content.trimEnd())
            const restored = properties + original + '\n' + privateNotes
            assert.equal(libs['page-card'].readPageCard(restored, rules).id, 101)
            assert.deepEqual(Array.from(markers.findIdMarkers(restored), e=>e.id), [101])
            assert.deepEqual(Array.from(markers.findIdMarkers(local.text)), [])
        }
    }
})

test('existing retired-property archives are readable and never confer an active note ID', async () => {
    const libs = await load(['archived-card','page-card','duplicate-markers','anki-id-marker','card-format-presets','export-recovery'], api)
    const archive = libs['archived-card'], scanner = libs['duplicate-markers']
    for (const style of ['mark','hidden','strike']) {
        const canonical = '---\nanki-page-ID: 33\n---\n# Q #anki-page\nA'
        const historical = archive.wrapArchivedCard(canonical,33,'Deleted',true,'\n',style).replace('anki-page-ID:','rudonium-id:')
        assert.equal(archive.archivedCardRanges(historical)[0].id,33)
        assert.deepEqual(Array.from(scanner.findIdMarkers(historical)),[])
        assert.equal(libs['page-card'].readPageCard(historical,{Basic:'@page'}),undefined)
    }
})

test('a confirmed deletion or archive preserves retired 0.9.7 notes in either tag order', async () => {
    const m = await modules
    const { findIdMarkers } = (await fixtures)['duplicate-markers']
    const { archivedCardRanges, archivedCardSource } = (await fixtures)['archived-card']
    const tags = '<!-- anki-bidirectional-tags: {"add":["review"],"remove":[]} -->'
    const section = ['<!--anki-fields-->', 'Импортированный: Словарь', 'Дополнение: Значение', '<!--/anki-fields-->']
    const tail = joined(['- Next :: Answer', '<!--ID: 125 -->', ''])
    for (const metadata of [[tags,...section],[...section,tags],section]) {
        const first = joined(['- One :: A', 'DELETE', '<!--ID: 124 -->', ...metadata,''])
        const text = '## Cards\r\n' + first + tail
        const plan = m.explicitDeletes(text,{}, {})
        assert.deepEqual(Array.from(plan.directives, d => d.id),[124])
        assert.equal(plan.masked.includes('Словарь'),false)
        const kept = joined([...metadata.slice(metadata.indexOf(section[0])), ''])
        assert.equal(m.cleanConfirmedDeletes(text,plan,new Set([124]),'remove',false).text,'## Cards\r\n' + kept + tail)
        assert.equal(m.cleanConfirmedDeletes(text,plan,new Set([124]),'keep',false).text,text.replace('DELETE\r\n',''))
        for (const mode of ['mark','hidden','strike']) {
            const saved = m.cleanConfirmedDeletes(text,plan,new Set([124]),mode,false).text
            const [range] = archivedCardRanges(saved)
            assert.ok(saved.endsWith(kept + tail))
            assert.ok(archivedCardSource(saved,range).includes('ID: 124'))
            assert.deepEqual(Array.from(findIdMarkers(saved), marker => marker.id),[125])
        }
    }
})

test('regex field values cannot own other records or trigger DELETE', async () => {
    const m = await modules
    const { findIdMarkers } = (await fixtures)['duplicate-markers']
    const text = joined(['## Cards','- One :: A','<!--ID: 124 -->','<!--anki-fields-->',
        'Example: Code','```md','- Draft :: value','DELETE','<!--ID: 125 -->','```','<!--/anki-fields-->',''])
    assert.deepEqual(Array.from(findIdMarkers(text), marker => marker.id),[124])
    assert.equal(m.explicitDeletes(text,{},{}),undefined)
})

test('a page tag inside a regex field cannot select the entire dictionary for deletion', async () => {
    const m = await modules
    const libs = await fixtures
    const source = joined(['# Dictionary', '## Cards', '- One :: A', 'DELETE', 'ID: 124', '<!--anki-fields-->',
        'Example: I saw #anki-page in the manual', '<!--/anki-fields-->', '- Keep :: B', 'ID: 125', ''])
    assert.equal(libs['page-card'].readPageCard(source, { Study: '@page' }), undefined)
    const plan = m.explicitDeletes(source, {}, { Study: '@page' })
    assert.deepEqual(Array.from(plan.directives, row => [row.id,row.card?.page]), [[124,false]])
    const saved = m.cleanConfirmedDeletes(source,plan,new Set([124]),'remove',true)
    assert.equal(saved.trash,false)
    assert.equal(saved.text, joined(['# Dictionary','## Cards','<!--anki-fields-->','Example: I saw #anki-page in the manual','<!--/anki-fields-->','- Keep :: B','ID: 125','']))
})
