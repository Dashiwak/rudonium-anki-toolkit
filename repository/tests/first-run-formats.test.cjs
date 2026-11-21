// SPDX-License-Identifier: GPL-3.0-only
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {load} = require('./benchmark/migration-modules.cjs')
const {patchMarkdownConstants} = require('../Build/format-patches.cjs')

const { removeStartupSchemaFetch } = require('../Build/install.cjs')

class TFile {
    constructor(path,text) { this.path = path; this.text = text }
}

async function setup(notes, vaultStorage = new Map()) {
    const names = ['OBS_INLINE_MATH_REGEXP','OBS_DISPLAY_MATH_REGEXP','OBS_CODE_REGEXP','OBS_DISPLAY_CODE_REGEXP']
    const constants = patchMarkdownConstants(names.map(k=>'export const '+k+' = /x/g').join('\n'))
    const api = { TFile, isDuplicateFirstFieldErrorMessage() {} }
    const { 'first-run-formats': formats } = await load(['first-run-formats', 'card-export-diagnostics', 'markdown-pipeline',
        'anki-transport','constants'], api, {constants})
    const files = notes.map((text,i) => new TFile(i+'.md',text))
    const reads=[], scans=[]
    let inFlight=0, max=0
    const app = { loadLocalStorage(key) {return vaultStorage.get(key)}, saveLocalStorage(key, value) {
            if (value === null) vaultStorage.delete(key)
            else vaultStorage.set(key,value)
        },
        vault: { getMarkdownFiles() {scans.push(true);return files}, getAbstractFileByPath(path) {return files.find(f=>f.path===path)},
            async read(file) {reads.push(file.path);max=Math.max(max,++inFlight);await Promise.resolve();--inFlight
                if (file.text instanceof Error) throw file.text
                return file.text} } }
    let stopped=false
    const settings={Syntax:{}, CUSTOM_REGEXPS:{Basic:''}}
    return {needs:()=>formats.needsFormatSetup(app,settings,()=>stopped), ack:()=>formats.acknowledgeFormatSetup(app,settings),
        app,files,scans,reads, settings,max:()=>max,stop:()=>{stopped=true}}
}
test('existing vault missing both rule and complete marker pair prompts once',async()=>{
    const h=await setup(['# Notes','START\nNo closing line', 'Something\nEND',
        '```markdown\nSTART\nBasic\nEND\n```',
        '---\nexample: |\n  START\n  END\n---\n',
        '<!--\nSTART\nBasic\nEND\n-->', '%%\nSTART\nEND\n%%','`STARTI [Basic] Front: text ENDI`'])
    assert.equal(await h.needs(),true);assert.equal(h.reads.length,8);assert.ok(h.max()<=4)
    h.ack();h.reads.length=0
    assert.equal(await h.needs(),false);assert.equal(h.reads.length,0)
})
test('configured regex or @page short-circuits before enumeration; complete custom block or inline pair suppresses prompt',async()=>{
    const h=await setup(Array(12).fill('Other notes'))
    for(const expr of ['@page','Q=(.+)']) {
        h.settings.CUSTOM_REGEXPS.Basic=expr
        assert.equal(await h.needs(),false);assert.equal(h.scans.length,0);assert.equal(h.reads.length,0)
    }
    h.settings.CUSTOM_REGEXPS.Basic=' '
    h.settings.Syntax={'Begin Note':'S.(1)','End Note':'E*', 'Begin Inline Note':'I+','End Inline Note':'/I+'}
    h.files[4].text='S.(1)\r\nBasic\r\nE*'
    assert.equal(await h.needs(),false);assert.equal(h.reads.length,8)
    h.reads.length=0;h.scans.length=0
    assert.equal(await h.needs(),false);assert.deepEqual(h.reads,['4.md']);assert.equal(h.scans.length,0)
    h.files[4].text='';h.files[8].text='Text I+ [Basic] Front: anything /I+'
    assert.equal(await h.needs(),false)
    h.files[8].text='';assert.equal(await h.needs(),true)
})
test('read failure and shutdown are inconclusive; another startup can retry',async()=>{
    const h=await setup([Error('locked')]);assert.equal(await h.needs(),false)
    h.files[0].text='';assert.equal(await h.needs(),true)
    h.stop();h.reads.length=0;assert.equal(await h.needs(),false);assert.equal(h.reads.length,0)
})

test('the saved first-run decision survives reload and stays scoped to its vault and marker syntax', async () => {
    const key = 'rudonium-anki-toolkit:format-check-v1'
    const syntax = JSON.stringify(['START','END','STARTI','ENDI'])
    const storage = new Map([[key, {syntax, shown:true}], ['other-plugin', 'keep']])
    const previous = await setup(['unrelated text'], storage)
    assert.equal(await previous.needs(), false)
    assert.deepEqual(previous.scans, [])
    const other = await setup(['unrelated text'])
    assert.equal(await other.needs(), true)
    previous.settings.Syntax['Begin Note'] = 'CARD'
    assert.equal(await previous.needs(), true)
    previous.ack()
    const reloaded = await setup(['unrelated text'], storage)
    reloaded.settings.Syntax['Begin Note'] = 'CARD'
    assert.equal(await reloaded.needs(), false)
    assert.equal(reloaded.reads.length, 0)
    reloaded.settings.CUSTOM_REGEXPS.Basic = '@page'
    assert.equal(await reloaded.needs(), false)
    assert.deepEqual([...storage.entries()], [['other-plugin','keep']])
})

test('malformed caches, missing methods and local storage failures do not prevent format detection', async () => {
    const storage = new Map([['rudonium-anki-toolkit:format-check-v1',
        {syntax: JSON.stringify(['START','END','STARTI','ENDI']), shown: 'true', path: 7}]])
    const h = await setup(['unrelated text'], storage)
    assert.equal(await h.needs(), true)
    h.app.loadLocalStorage = () => { throw Error('unavailable') }
    h.app.saveLocalStorage = () => { throw Error('unavailable') }
    assert.doesNotThrow(h.ack)
    assert.equal(await h.needs(), true)
    delete h.app.loadLocalStorage
    delete h.app.saveLocalStorage
    h.files[0].text = 'START\nBasic\nEND'
    assert.equal(await h.needs(), false)
})

test('the upstream new-install template has an empty tag before any save or Anki request', () => {
    const {offlineDefaults}=require('../Build/install.cjs')
    const body=offlineDefaults(`const settings = {Defaults: {"Tag": "Obsidian_to_Anki"}}
        /*Making settings from scratch, so need note types*/ throw Error('network');
        return settings`)
    const plugin={}
    const settings=Function(body).call(plugin)
    assert.equal(settings.Defaults.Tag,'')
    assert.deepEqual(plugin.fields_dict,{})
    assert.deepEqual(plugin.note_types,[])
})

test('offline startup reaches command registration for both empty and existing schemas · LF and CRLF', async () => {
    const AsyncFunction = (async () => {}).constructor
    const upstream = `this.fields_dict = await this.loadFieldsDict()
        if (Object.keys(this.fields_dict).length == 0) {
            new Notice('Need to connect to Anki to generate fields dictionary...')
            try {
                this.fields_dict = await this.generateFieldsDict()
                new Notice('Fields dictionary successfully generated!')
            } catch (error) { new Notice("Couldn't connect to Anki!"); return }
        }
        this.added_media = await this.loadAddedMedia()
        this.registerCommands()`
    for (const newline of ['\n','\r\n']) for (const fields of [{}, {Basic:['Front','Back']}]) {
        let registered=0
        const plugin={loadFieldsDict:async()=>fields,loadAddedMedia:async()=>['existing.ogg'],registerCommands(){registered++}}
        const code = removeStartupSchemaFetch(upstream.replaceAll('\n',newline))
        await new AsyncFunction(code).call(plugin)
        assert.equal(registered,1)
        assert.strictEqual(plugin.fields_dict,fields)
        assert.deepEqual(plugin.added_media,['existing.ogg'])
    }
})
