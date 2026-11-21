// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
const pageFile = require('./benchmark/page-file.cjs')

test('a file has one verified deck for both preview and export', async () => {
    // Simulate an upstream scanner which selects even a directive inside a Markdown example.
    const fileSource = pageFile().replace("from './page-card.mjs'", "from './page-card'")
        .replace('this.regularScanned = true', 'this.target_deck = /TARGET DECK: (.+)/u.exec(this.file)?.[1] ?? this.target_deck')
    const constants = [
        'export const OBS_DISPLAY_CODE_REGEXP = /^\x60\x60\x60[^\\n]*\\n[\\s\\S]*?^\x60\x60\x60/gm;',
        'export const OBS_CODE_REGEXP = /\x60[^\x60\\n]*\x60/g;',
        'export const OBS_DISPLAY_MATH_REGEXP = /\\$\\$[\\s\\S]*?\\$\\$/g;',
        'export const OBS_INLINE_MATH_REGEXP = /\\$[^$\\n]*\\$/g;',
    ].join('\n')
    const real = ['export-recovery','suspend-label','portable-parser','page-card','card-format-presets','markdown-pipeline','card-export-diagnostics',
        'id-marker-literals','anki-id-marker','duplicate-markers','bidirectional-markdown','bidirectional-blocks',
        'bidirectional-fields','linked-bullets','deck-routes','card-preview-metadata','interface-language','constants','file','anki']
    const modules = await load(real, { parseYaml: () => ({}) }, {file: fileSource, constants, anki: 'export {}'})
    const parse = (content, preview = false, pageLocation = 'heading') => modules['portable-parser'].parsePortableMarkdown(
        {metadataCache:{getCache:()=>({})}}, { template:{deckName:'Default',tags:[]},folder_decks:{Cards:'Folder'},
            folder_tags:{},fields_dict:{Basic:['Front','Back']},custom_regexps:{}, page_model:'Basic', page_id_location:pageLocation, DECK_REGEXP:/^TARGET DECK: ([^\r\n]+)/gm,
            NOTE_REGEXP:/(?!)/g,INLINE_REGEXP:/(?!)/g,EMPTY_REGEXP:/(?!)/g },
        {path:'Cards/test.md'}, content, [], {preview})
    for (const location of ['heading','yaml']) {
        const id = 1700000000118
        const prefix = location === 'yaml' ? "---\nanki-page-ID: '" + id + "'\n---\n" : ''
        const marker = location === 'yaml' ? '' : 'ID: ' + id + '\n'
        const privateText = ['<!--rudonium-answer-end-->', 'TARGET DECK: Private deck', 'FILE TAGS: private_tag',
            'FROZEN - Basic:', 'Front: private prompt', 'DELETE', 'ID: 44', 'ID: not-a-number', '- Secret :: Never export',
            'START', 'Basic', 'Front: Other card', 'Back: Secret', 'END', '![[private.png]]'].join('\n')
        const source = prefix + '# Title #anki-page\n' + marker + 'Public answer\n' + privateText
        for (const preview of [true,false]) {
            const restored = await parse(source,preview,location)
            assert.equal(restored.original_file,source)
            assert.equal(restored.file,source)
            assert.equal(restored.target_deck,'Folder')
            assert.equal(restored.notes_to_edit.length,1)
            assert.equal(restored.notes_to_edit[0].identifier,id)
            assert.deepEqual({...restored.notes_to_edit[0].note.fields}, {Front:'Title',Back:'Public answer'})
            assert.equal(restored.notes_to_edit[0].note.tags.includes('private_tag'),false)
            assert.equal(restored.notes_to_delete.length,0)
            assert.equal(restored.all_notes_to_add.length,0)
            if(preview) assert.equal(restored.previewCandidates.length,1)
        }
    }
    const source = 'TARGET DECK: First\r\nQ :: A\r\nTARGET DECK: Other\r\nX :: Y'
    for (const preview of [true,false]) {
        await assert.rejects(parse(source,preview), /lines 1 .*First.* and 3 .*Other/)
        assert.equal((await parse(source.replace('Other','FIRST'),preview)).target_deck,'First')
        for (const example of ['%%\nTARGET DECK: Wrong\n%%','<!--\nTARGET DECK: Wrong\n-->','```markdown\nTARGET DECK: Wrong\n```','---\nTARGET DECK: Wrong\n---','$$\nTARGET DECK: Wrong\n$$']) {
            assert.equal((await parse(example+'\nQ :: A',preview)).target_deck,'Folder')
            assert.equal((await parse(example+'\nTARGET DECK: Valid\nQ :: A',preview)).target_deck,'Valid')
        }
    }
})
