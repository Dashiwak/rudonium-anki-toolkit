// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { test } = require('node:test')
const overlay = require('../Build/overlay-source.cjs')
const { load } = require('./benchmark/migration-modules.cjs')

for (const placement of ['yaml', 'after-answer']) test('audit repair revalidates a page and changes only the numeric ID in ' + placement, async () => {
    class TFile { path = 'Card.md'; extension = 'md' }
    const file = new TFile()
    const property = 'anki-page-ID: "33" # keep this'
    const footer = '<!-- ID:\t33 | 2026-11-20 @page-->'
    const yaml = placement === 'yaml'
    const origin = ['\ufeff---','title: "33"', ...(yaml ? [property] : []), '---','# Q #anki-page','A',
        ...(!yaml ? [footer] : []), '<!--rudonium-answer-end-->','Private: 33',''].join('\r\n')
    let text = origin
    const plugin = { fields_dict:{ Basic:['Front','Back'] }, settings:{Syntax:{}},
        app:{ vault:{getAbstractFileByPath:path=>path===file.path&&file,read:async()=>text}, workspace:{getLeavesOfType:()=>[]},
            metadataCache:{getCache:()=>null} } }
    const t = english => english
    const api = { TFile, MarkdownView:class {}, settingsWithoutAuditMode:s=>s, scanProfileFreeSettings:s=>s, settingToData:()=>({}),
        isSyncAuditReportPath:()=>false, describeSyncPath:()=>({included:true}), syncAuditDeckKey:s=>s, editorPreviewMetadata:()=>({}) }
    let mods
    api.parsePortableMarkdown = async (_app,_data,_file,markdown) => {
        const page = mods['page-card'].readPageCard(markdown,{Basic:'@page'})
        const note = { modelName:'Basic',deckName:'D', fields:{Front:page.front,Back:page.back} }
        return {pageCard:page,previewCandidates:[{ identifier:page.id, start:0,end:markdown.length,note }]}
    }
    mods = await load(['audit-repair-match','audit-repair-apply','page-card','card-format-presets','duplicate-markers',
        'export-recovery','linked-bullets','anki'],api,{anki:'export {}','audit-repair-apply':
        fs.readFileSync(overlay.file('audit-repair-apply.ts'),'utf8') + '\nexport { readChange as reviewLocalChange }'})
    const source = { id:33, path:file.path, assignedDeck:'D', line:1, markerLine:yaml ? 3 : 6, endLine:8 }
    const reviewed = await mods['audit-repair-match'].inspectAuditRepairSource(plugin,file,text,source)
    assert.ok(reviewed?.wholePage)
    const repair = action => mods['audit-repair-apply'].reviewLocalChange(plugin,reviewed,33,action,1700000000101,t)
    const change = await repair('replace-id')
    const marker = yaml ? property : footer
    assert.equal(change.after, origin.replace(marker,marker.replace('33','1700000000101')))
    assert.equal((await repair('delete-anki')).after, origin.replace(marker + '\r\n',''))
    await assert.rejects(repair('delete-obsidian'), /Open the page/)
    text = origin.replace('Private: 33','An edit after the preview')
    await assert.rejects(repair('replace-id'), /changed/)
})

test('switching text IDs between plain text and HTML leaves the YAML property and private examples untouched', async () => {
    const modules = await load(['id-marker-format','duplicate-markers','anki-id-marker','id-marker-literals'])
    const convert = modules['id-marker-format'].convertIdMarkerText
    for (const location of ['heading','yaml','after-answer']) {
        const text = ['---',...(location === 'yaml' ? ['anki-page-ID: "33" # saved'] : []),
            '---','# Q #anki-page',...(location === 'heading' ? ['ID: 33'] : []),'Answer', ...(location === 'after-answer' ? ['<!--ID: 33 @page-->'] : []),
            '<!--rudonium-answer-end-->','Private :: Notes','ID: 55', '<!--ID: 77-->',''].join('\r\n')
        const asComment = convert(text,'to-comment').text
        assert.equal(asComment,location !== 'heading' ? text : text.replace('ID: 33','<!--ID: 33-->'))
        assert.equal(convert(asComment,'to-plain').text,text)
    }
})


test('dating a verified footer preserves its signature and skips matching IDs in private notes', async () => {
    const mods = await load(['anki-id-marker','duplicate-markers','id-marker-literals'])
    const { pageFooterId, dateLinkedMarkers } = mods['anki-id-marker']
    for (const eol of ['\n', '\r\n']) {
        const raw = ['# Q #anki-page', 'A', '<!--ID: 33 @page-->', '<!--rudonium-answer-end-->',
            'Private example', '<!--ID: 33 @page-->'].join(eol)
        const apply = (text, date) => dateLinkedMarkers(text, mods['duplicate-markers'].findIdMarkers(text), new Set([33]), date)
        const first = apply(raw,'2026-11-20')
        assert.equal(first,raw.replace('33 @page','33 | 2026-11-20 @page'))
        assert.equal(pageFooterId(first).id,33)
        assert.equal(apply(first, '2026-11-21'), first)
    }
})
