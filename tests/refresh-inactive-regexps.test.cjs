// SPDX-License-Identifier: GPL-3.0-only
const {test} = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = process.env.RUDONIUM_COMPARE_KIT || path.resolve(__dirname,'..')
const {load} = require(path.join(root,'tests/benchmark/migration-modules.cjs'))

test('refresh keeps authored rules recoverable across profile changes, restart and partial save failure',async()=>{
    let names = ['Other'], saved
    const oldNames = ['constructor','__proto__','Empty']
    const fields = ['Q','A']
    const values = oldNames.map((model,i)=>[model, i===2?'':model+'=(.+)'])
    let profile = 'B'
    const plugin = {settings:{CUSTOM_REGEXPS:Object.fromEntries(values)},fields_dict:Object.fromEntries(oldNames.map(n=>[n,fields])),
        note_types:oldNames,saveData:async d=>{saved=JSON.parse(JSON.stringify(d))}}
    const host = {uiFor:()=>e=>e,readActiveAnkiProfile:()=>profile,checkPinnedAnkiProfile:()=>profile,
        expectedAnkiProfile:()=>undefined,withFastScanReadLock:(_,op)=>op(),savePluginDataInOrder:(_,op)=>op(),
        auditRead:(action)=> action==='modelNames'?names:names.map(()=>({error:null,result:fields}))}
    const { 'note-type-refresh': api, 'note-type-rules': rules } = await load(['note-type-refresh','note-type-rules','card-format-presets'],host)
    await api.refreshNoteTypes(plugin)
    assert.deepEqual(Object.keys(saved.settings.CUSTOM_REGEXPS),['Other'])
    assert.deepEqual(Object.keys(saved.settings.INACTIVE_CUSTOM_REGEXPS || {}).sort(),['__proto__','constructor'])
    plugin.settings=saved.settings
    names=['Renamed other','__proto__']
    profile='A'
    const before = JSON.stringify(plugin.settings)
    const write=plugin.saveData
    plugin.saveData=()=>{throw Error('disk full')}
    await assert.rejects(()=>api.refreshNoteTypes(plugin),/disk full/)
    assert.equal(JSON.stringify(plugin.settings),before)
    plugin.saveData=write
    await api.refreshNoteTypes(plugin)
    assert.equal(saved.settings.CUSTOM_REGEXPS.__proto__,'__proto__=(.+)')
    assert.equal(saved.settings.CUSTOM_REGEXPS['Renamed other'],'')
    assert.deepEqual(Object.keys(saved.settings.INACTIVE_CUSTOM_REGEXPS),['constructor'])
    names.push('constructor')
    plugin.settings.CUSTOM_REGEXPS['Renamed other']='constructor=(.+)'
    await api.refreshNoteTypes(plugin)
    assert.equal(plugin.settings.CUSTOM_REGEXPS.constructor,'')
    assert.equal(plugin.settings.INACTIVE_CUSTOM_REGEXPS.constructor,'constructor=(.+)')
    Object.assign(plugin.settings,rules.withRule(plugin.settings,rules.readRule(plugin.settings,'constructor'),true))
    plugin.settings.CUSTOM_REGEXPS['Renamed other']=''
    await api.refreshNoteTypes(plugin)
    assert.equal(plugin.settings.CUSTOM_REGEXPS.constructor,'')
    assert.deepEqual(Object.keys(plugin.settings.INACTIVE_CUSTOM_REGEXPS||{}),[])
})
