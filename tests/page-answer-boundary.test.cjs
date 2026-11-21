// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
const pageFile = require('./benchmark/page-file.cjs')
const mark = '<!--rudonium-answer-end-->'
const settings = { Basic: '@page' }
const noteId = 1700000000373
const signed = '<!--ID: ' + noteId + ' @page-->'
const dated = '<!--ID: ' + noteId + ' | 2026-11-19 @page-->'
let pages, edits, marker, scan, recovery, AllFile

before(async () => {
    const modules = await load(['page-card', 'page-frontmatter', 'anki-id-marker', 'id-marker-literals', 'bidirectional-markdown',
        'bidirectional-blocks', 'duplicate-markers', 'export-recovery', 'card-format-presets', 'file'], {},
        { file: pageFile().replace(/\.mjs'/g, "'") })
    pages = modules['page-card']
    edits = modules['bidirectional-markdown']
    marker = modules['anki-id-marker']
    scan = modules['duplicate-markers']
    recovery = modules['export-recovery']
    AllFile = modules.file.AllFile
})

test('a page exports and previews only its answer and keeps local notes byte-for-byte on a return edit', async () => {
    for (const eol of ['\n', '\r\n']) for (const location of ['heading', 'yaml']) {
        const id = 1700000000419
        const start = ['\uFEFF---', 'tags: [reading]', '---', '# Capital? #anki-page'].join(eol)
        const privatePart = [mark + '  ', '', '## Reading notes', 'Private [[source]]', '- Draft :: Also private',
            'DELETE', 'ID: 1700000000100', ''].join(eol)
        const text = [start, '', 'Vienna', '', privatePart].join(eol)
        const unlinked = new AllFile(text)
        unlinked.data.page_id_location = location
        await unlinked.scanFile()
        assert.deepEqual({ ...unlinked.all_notes_to_add[0].fields }, { Front: 'Capital?', Back: 'Vienna' })
        assert.equal(unlinked.previewCandidates[0].note.fields.Back, 'Vienna')
        unlinked.note_ids = [id]
        unlinked.writeIDs()
        const linked = new AllFile(unlinked.file)
        await linked.scanFile()
        assert.equal(linked.all_notes_to_add.length, 0)
        assert.equal(linked.notes_to_edit[0].identifier, id)
        const page = pages.readPageCard(unlinked.file, settings)
        assert.equal(page.idLocation, location)
        assert.equal(page.end, unlinked.file.length)
        assert.equal(unlinked.file.slice(page.answerBoundary), privatePart)
        const block = pages.pageBlock(page)
        assert.equal(block.answerBoundary, page.answerBoundary)
        const next = edits.applyMarkdownPatches(unlinked.file,
            edits.planExplicitBlockPatches(unlinked.file, block, { Back: 'Changed\nSecond line' }))
        assert.equal(next, unlinked.file.replace('Vienna', 'Changed' + eol + 'Second line'))
        assert.equal(pages.readPageCard(next, settings).id, id)
        assert.throws(() => edits.planExplicitBlockPatches(unlinked.file, block, { Back: 'from Anki\n' + mark + '\nextra' }))
        assert.equal(edits.readEditableAnkiBlockField('Changed<br>&lt;!--rudonium-answer-end--&gt;', block), undefined)
    }
})

test('duplicate true boundaries and an empty public answer stop the export before a note can be created', async () => {
    for (const body of [mark + '\nOnly local notes', 'A\n' + mark + '\nB\n' + mark]) {
        const parser = new AllFile('# Q #anki-page\n' + body)
        await assert.rejects(parser.scanFile(), /answer/i)
        assert.equal(parser.all_notes_to_add.length, 0)
        assert.equal(parser.previewCandidates.length, 0)
    }
})

test('documentation and quoted or nested markup never become a page boundary', () => {
    const passages = [
        ['````markdown', '```', mark, '````'], ['~~~', mark, '~~~'],
        ['`inline', mark, 'example`'], ['$$', mark, '$$'], ['\\[', mark, '\\]'],
        ['<!-- example', mark, '-->'], ['%%', mark, '%%'], ['<pre>', mark, '</pre>'],
        ['<div>', '<div>', '</div>', mark, '</div>'], ['<blockquote>', mark, '</blockquote>'],
        ['> ' + mark], ['    ' + mark], ['- ' + mark], ['Mention ' + mark], [mark + ' trailing'],
    ]
    for (const rows of passages) {
        const body = ['Public', ...rows, 'Still public'].join('\n')
        const text = '# Q #anki-page\n' + body
        assert.equal(pages.readPageCard(text, settings).back, body)
        assert.equal(pages.readPageCard(text + '\n' + mark + '\nPrivate', settings).back, body)
    }
})

test('signed footer survives default changes, dates, return edits, EOF styles and write retry', async () => {
    const rules = { Basic: '@page' }
    for (const eol of ['\n','\r\n']) for (const tail of ['',eol,eol+eol+mark+eol+'DELETE'+eol+'ID: 88'+eol+'Private :: Memo'+eol]) {
        const draft = ['\uFEFF---','aliases: [One]','---','','# Q #anki-page ^anchor','','A', 'Second  '].join(eol) + tail
        const file = new AllFile(draft)
        file.data.page_id_location = 'after-answer'
        file.data.comment = false
        file.data.id_date = false
        await file.scanFile()
        assert.deepEqual({...file.all_notes_to_add[0].fields}, { Front:'Q', Back:'A\nSecond  ' })
        file.note_ids = [noteId]
        file.writeIDs()
        const after = draft.replace('Second  ', 'Second  ' + eol + signed)
        assert.equal(file.file, after)
        file.writeIDs()
        assert.equal(file.file, after)
        const second = new AllFile(after)
        second.data.page_id_location = 'yaml'
        await second.scanFile()
        assert.equal(second.all_notes_to_add.length, 0)
        assert.equal(second.notes_to_edit[0].identifier,noteId)
        assert.equal(second.notes_to_edit[0].note.fields.Back,'A\nSecond  ')
        const card = pages.readPageCard(after, rules)
        assert.equal(card.idLocation, 'after-answer')
        assert.equal(after.slice(card.idStart,card.idEnd), signed)
        const block = pages.pageBlock(card)
        const changed = edits.applyMarkdownPatches(after, edits.planExplicitBlockPatches(after, block, { Front:'New Q', Back:'New answer' }))
        assert.equal(changed, after.replace('# Q ', '# New Q ').replace('A'+eol+'Second  ', 'New answer'))
        const marks = scan.findIdMarkers(after)
        assert.deepEqual([...marks].map(x => x.id),[noteId])
        const addDate = marker.dateLinkedMarkers(after, marks, new Set([noteId]),'2026-11-19')
        assert.equal(addDate,after.replace(signed,dated))
        assert.equal(pages.readPageCard(addDate,rules).id,noteId)
    }
})

test('a malformed, conflicting, moved or detached signed footer stops page creation', async () => {
    const h = '# Question #anki-page\n'
    for (const source of [
        h+'A\n<!--ID: 0 @page-->', h+'A\n<!--ID: abc @page-->', h+'A\n<!--ID: 12 @page',
        h+'A\n<!--ID: 12 | 2025-02-29 @page-->',h+'A\nID: 12 @page', h+'A\n'+signed+'\nMore', h+'A '+signed,
        h+signed+'\nA', h+'A\n'+signed+'\n'+signed, h+'ID: 42\nA\n'+signed,
        '---\nanki-page-ID: 12\n---\n'+h+'A\n'+signed,'# Missing tag\nA\n'+signed,
        h+'A\n<!--ID: 12-->', // unsigned block ID is reserved, never attached as a page footer
        h+'A\n```markdown\nunterminated example', h+'A\n<!-- unfinished text'
    ]) {
        const file = new AllFile(source)
        file.data.page_id_location = 'after-answer'
        await assert.rejects(file.scanFile(), error => typeof error.message === 'string', source)
        assert.equal(file.all_notes_to_add.length, 0, source)
    }
})

test('footer examples inside documentation or private text do not bind an Anki note', async () => {
    for (const lines of [
        ['```markdown',signed,'```'], ['`example',signed,'end`'],
        ['<div>',signed,'</div>'], ['<!-- example',signed,'-->'], ['%%',signed,'%%'],
        ['$$',signed,'$$'], ['> '+signed],['    '+signed],
        [mark,'private',signed]
    ]) {
        const draft = '# Q #anki-page\nA\n'+lines.join('\n')
        assert.equal(marker.pageFooterId(draft),undefined,draft)
        assert.deepEqual([...scan.findIdMarkers(draft)].map(x=>x.id),[],draft)
        const file = new AllFile(draft)
        file.data.page_id_location='after-answer'
        await file.scanFile()
        assert.equal(file.all_notes_to_add.length,1,draft)
    }
})

test('recovery writes a signed footer before the pending journal and can retry without creating another note', async () => {
    const draft = '# Q #anki-page\nA'
    const token = 'ab'.repeat(16)
    const journaled = recovery.addRecoveryMarker(draft,token)
    const file = new AllFile(journaled); file.data.page_id_location = 'after-answer'
    await file.scanFile(); file.note_ids = [noteId]; file.writeIDs()
    const written = file.file
    assert.equal(written,recovery.addRecoveryMarker(draft+'\n'+dated,token))
    file.writeIDs(); assert.equal(file.file,written)
    const reread = new AllFile(written); await reread.scanFile(); assert.equal(reread.notes_to_edit[0].identifier,noteId)
})

test('detached page controls apply only to an existing page ID and never become a newly created Anki field', async () => {
    for (const command of ['SUSPEND_2','DELETE','delete']) {
        const body = '# Q #anki-page\n'+command+'\nA'
        for (const setting of [undefined,'heading','yaml','after-answer']) {
            const create = new AllFile(body)
            create.data.page_id_location = setting
            await assert.rejects(create.scanFile(), /Link this page/)
            assert.equal(create.all_notes_to_add.length,0)
        }
        const source = body+'\n'+signed
        const linked = new AllFile(source)
        await linked.scanFile()
        assert.equal(linked.notes_to_edit[0].identifier,noteId)
        assert.equal(linked.notes_to_edit[0].note.fields.Back,'A')
        const parsed = pages.readPageCard(source, { Basic:'@page' })
        assert.equal(source.slice(parsed.idStart,parsed.idEnd), signed)
        assert.equal(parsed.tagAnchor,body.indexOf(command) + command.length)
    }
    const local = '# Q #anki-page\nПАУЗА_2\nA\n'+signed
    assert.equal(pages.readPageCard(local, { Basic:'@page' }, { 'Suspend Line':'ПАУЗА' }).back, 'A')
})
