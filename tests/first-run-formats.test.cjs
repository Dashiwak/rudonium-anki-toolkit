// SPDX-License-Identifier: GPL-3.0-only
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {load} = require('./benchmark/migration-modules.cjs')
const { removeStartupSchemaFetch } = require('../Build/install.cjs')

test('Quick Start eligibility only uses saved settings, including block-only profiles with no regexp', async () => {
    const { 'first-run-formats': { needsFormatSetup } } = await load(['first-run-formats'], {})
    const fresh = { CUSTOM_REGEXPS: {} }
    assert.equal(needsFormatSetup(fresh, {}), true)
    for (const configured of [
        { CUSTOM_REGEXPS: { EnDic26: '' } },
        { CUSTOM_REGEXPS: { Basic: '@page' } },
        { NOTE_TYPE_RULE_MODELS: ['Basic'] },
        { FILE_LINK_FIELDS: { EnDic26: 'File' }, CONTEXT_FIELDS: { EnDic26: 'Context' } },
    ]) assert.equal(needsFormatSetup(configured, {}), false)
    assert.equal(needsFormatSetup(fresh, { EnDic26: ['Front', 'Back', 'File', 'Context'] }), false)

    for (const status of ['complete', 'dismissed']) {
        assert.equal(needsFormatSetup({ ...fresh, QUICK_START_STATUS: status }, {}), false)
    }
    // Fetching fields during an incomplete setup is not evidence of a successful save.
    assert.equal(needsFormatSetup({ ...fresh, QUICK_START_STATUS: 'pending' }, { Basic: ['Front', 'Back'] }), true)
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
