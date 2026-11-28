// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')

test('current note rule comparison finds lost IDs, new fields and collisions between handwritten models without writes', async () => {
    const original = '^Q=(.+?)[|](.*)$'
    const draft = '^Q=(new [^|]+) *[|] *(.*)$'
    const second = '^Q=(new .+?)[|](.*)$'
    const text = 'Q=old|answer\nID: 42\nQ=new item | Answer\n<!--ID: 93-->\nQ=new town | Graz'
    const file = {path:'Dictionary.md',extension:'md'}
    const plugin = { settings:{CUSTOM_REGEXPS:{Basic:original,Other:second}, Syntax:{}},
        fields_dict:{Basic:['F','B'],Other:['F','B']},
        app:{workspace:{getActiveFile:()=>file, getActiveViewOfType:()=>({file,editor:{getValue:()=>text}})},
            metadataCache:{getCache:()=>({})},vault:{cachedRead:()=>assert.fail('use open editor')}}}
    let worker, marker, reads=0
    const api = {uiFor:()=>en=>en, editorPreviewMetadata:()=>({}), scanProfileFreeSettings:s=>s,
        settingToData:(_app,settings,_fields,ids)=>{
            assert.equal(ids.length,0)
            return {custom_regexps:settings.CUSTOM_REGEXPS}
        },
        parsePortableMarkdown:async (_app,data,f,md,ids,options)=>{
            assert.equal(f,file)
            assert.equal(md,text)
            assert.equal(options.preview,true)
            assert.deepEqual([...ids],[42,93])
            reads++
            const [[model,expression]]=Object.entries(data.custom_regexps)
            const pattern={source:expression,flags:'gm',label:model}
            const matched=await worker.matchCustomRegexps(md,[pattern],options.regexpOptions)
            const cards=matched.get(worker.customRegexpKey(pattern)).map(([raw,front,back])=>{
                const start=md.indexOf(raw), end=start+raw.length
                const id=marker.parseAnkiIdMarker(md.slice(end+1).split('\n')[0])?.id
                return {start,end,identifier:id,note:{modelName:model,fields:{F:front,B:back}}}
            })
            return {previewCandidates:cards}
        },
    }
    const modules=await load(['rule-note-preview','custom-regexp-worker','anki-id-marker','id-marker-literals','note-type-rules','card-format-presets'],api)
    worker=modules['custom-regexp-worker']; marker=modules['anki-id-marker']
    const report=await modules['rule-note-preview'].previewRuleOnNote(plugin,
        {model:'Basic',expression:draft,file:'',context:''},new AbortController().signal)
    assert.equal(report.path,'Dictionary.md')
    assert.equal(reads,3)
    assert.deepEqual(Array.from(report.changes, c=>[c.kind,c.card.identifier,c.other]),[
        ['lost',42,undefined],['changed',93,undefined],['overlap',93,'Other'],['changed',undefined,undefined],['overlap',undefined,'Other']])
    assert.equal(plugin.settings.CUSTOM_REGEXPS.Basic,original)
    const fresh=await modules['rule-note-preview'].previewRuleOnNote(plugin,
        {model:'Basic',expression:'^(Q)=(.+)$|^(ID: )(42)$',file:'',context:''},new AbortController().signal)
    assert.ok(fresh.changes.some(c=>c.kind==='added'))
})

test('linked ID survives a shifted match start and duplicate ownership remains explicit', async () => {
    const { 'rule-note-preview': rules } = await load(['rule-note-preview'],{})
    const card = (start,identifier) => ({start,end:start+1,identifier,note:{fields:{Front:'a',Back:'b'}}})
    const before = [card(3,12),card(10,13),card(13,13),card(19,undefined)]
    const after = [card(1,12),card(10,13),card(19,undefined)]
    assert.deepEqual(Array.from(rules.compareRuleMatches(before,after,[]),x=>x.kind),['moved','duplicate'])
})

test('forum regressions: manual Basic and Cloze overlap, Dataview status is visible as a new RemNote match',async () => {
    const result = await load(['rule-note-preview','custom-regexp-worker','card-format-presets'],{})
    const worker = result['custom-regexp-worker'], compare = result['rule-note-preview'].compareRuleMatches
    const source='This {{c1::is}} a card\nStatus:: In Progress'
    const collision = {Basic:'^(.+?)::(.+)$',Cloze:'^(.*\\{\\{c\\d+::)(.+)$',RemNote:result['card-format-presets'].remNoteExpression}
    const patterns=Object.entries(collision).map(([label,source])=>({source,flags:'gm',label}))
    const found=await worker.matchCustomRegexps(source,patterns)
    const [basic,cloze,remnote]=patterns.map(p=>found.get(worker.customRegexpKey(p)).map(match=>({
        start:match.index,end:match.index+match[0].length,note:{fields:{F:match[1],B:match[2]}}})))
    const matches=compare([],remnote,[])
    assert.ok(matches.some(row=>row.kind==='added' && row.card.note.fields.F==='Status' && row.card.note.fields.B==='In Progress'))
    const overlap=compare(basic,basic,[['Cloze',cloze]])
    assert.deepEqual(Array.from(overlap,x=>[x.kind,x.other,x.card.start]),[['overlap','Cloze',0]])
})

test('20,000 local matches keep the initial report small and reveal captured values only when expanded',async () => {
    let fieldsRendered=0
    const api=await load(['rule-note-preview'],{previewFieldText:(_document,value)=>{fieldsRendered++;return value}})
    class Node {
        constructor(tag,opts={}){this.tag=tag;this.text=opts.text;this.children=[];this.events={}}
        createEl(tag,opts){const child=new Node(tag,opts);this.children.push(child);return child}
        createDiv(){return this.createEl('div')}
        addEventListener(key,callback){this.events[key]=callback}
        empty(){this.children=[]}
        all(){return [this,...this.children.flatMap(child=>child.all())]}
    }
    const report={path:'Dictionary.md',text:'Q\n'.repeat(20000),changes:[],warnings:[],
        cards:Array.from({length:20000},(_,i)=>({start:i*2,end:i*2+1,identifier:i+10,note:{fields:{Front:'Q',Back:'A'}}}))}
    const container=new Node('form')
    api['rule-note-preview'].showRuleReport(container,report,en=>en)
    assert.equal(container.all().filter(el=>el.tag==='summary').length,21)
    assert.equal(fieldsRendered,0)
    const detail=container.all().find(el=>el.tag==='details' && el.children.some(child=>child.text?.startsWith('Line 1 ·')))
    detail.open=true; detail.events.toggle(); detail.events.toggle()
    assert.equal(fieldsRendered,2)
    const more=container.all().find(el=>el.tag==='button')
    more.onclick()
    assert.equal(container.all().filter(el=>el.tag==='summary').length,41)
    assert.equal(fieldsRendered,2)
})

test('a broken saved expression or peer cannot hide repaired matches or claim that their IDs are new', async () => {
    const text = 'Q: river\nID: 123'
    const file = {path: 'Words.md', extension: 'md'}
    const plugin = {settings: {CUSTOM_REGEXPS: {Basic: '(', BrokenPeer: '[', Other: '^(Q):(.+)$'}, Syntax: {}},
        fields_dict: {Basic: ['F', 'B'], BrokenPeer: ['F', 'B'], Other: ['F', 'B']},
        app: {workspace: {getActiveFile: () => file, getActiveViewOfType: () => null},
            metadataCache: {getCache: () => ({})}, vault: {cachedRead: async () => text}}}
    let worker
    const host = {uiFor: () => en => en, editorPreviewMetadata: () => ({}), scanProfileFreeSettings: s => s,
        settingToData: (_app, settings) => ({custom_regexps: settings.CUSTOM_REGEXPS}),
        parsePortableMarkdown: async (_app, data, _file, source, _ids, options) => {
            const [[model, expression]] = Object.entries(data.custom_regexps)
            const pattern = {source: expression, flags: 'gm', label: model}
            const matches = await worker.matchCustomRegexps(source, [pattern], options.regexpOptions)
            return {previewCandidates: matches.get(worker.customRegexpKey(pattern)).map(m => ({
                start: m.index, end: m.index + m[0].length, identifier: 123, note: {modelName: model, fields: {F: m[1], B: m[2]}}
            }))}
        }}
    const api = await load(['rule-note-preview','anki-id-marker','id-marker-literals','custom-regexp-worker','note-type-rules','card-format-presets'], host)
    worker = api['custom-regexp-worker']
    const review = api['rule-note-preview'].previewRuleOnNote
    const draft = {model: 'Basic', expression: '^(Q): (.+)$', file: '', context: ''}
    const report = await review(plugin, draft, new AbortController().signal)
    assert.equal(report.cards[0].identifier, 123)
    assert.deepEqual(Array.from(report.changes, c => [c.kind, c.other]), [['overlap', 'Other']])
    assert.match(report.warnings.join(' '), /previous|saved/i)
    assert.match(report.warnings.join(' '), /BrokenPeer/)
    await assert.rejects(review(plugin, {...draft, expression: '('}, new AbortController().signal))
    await assert.rejects(review(plugin, draft, AbortSignal.abort()))
})

test('a restricted Node loader still allows regex matching in the browser worker', async () => {
    const blobs = new Map()
    class WorkerURL extends URL {
        static createObjectURL(blob) { blobs.set('blob:regexp-test', blob); return 'blob:regexp-test' }
        static revokeObjectURL(url) { blobs.delete(url) }
    }
    class BrowserWorker extends EventTarget {
        constructor(url) {
            super()
            this.blob = blobs.get(url)
            assert.ok(this.blob)
        }
        async postMessage(value) {
            const self = {
                postMessage: data => this.dispatchEvent(new MessageEvent('message', { data })),
                addEventListener: (name, handler) => { assert.equal(name, 'message'); handler({ data: value }) },
            }
            require('node:vm').runInNewContext(await this.blob.text(), { self })
        }
        terminate() {}
    }
    // The desktop host may expose process while blocking worker_threads in the renderer.
    const env = { process: { getBuiltinModule() { throw new Error('Disabled in renderer') } },
        Worker: BrowserWorker, Blob, URL: WorkerURL }
    const modules = await load(['custom-regexp-worker'], {}, {}, env)
    const worker = modules['custom-regexp-worker']
    const pattern = { source: '^(.+) :: (.+)$', flags: 'gm' }
    const result = await worker.matchCustomRegexps('Question :: Answer', [pattern])
    const [match] = result.get(worker.customRegexpKey(pattern))
    assert.deepEqual(Array.from(match).slice(1), ['Question', 'Answer'])
})
