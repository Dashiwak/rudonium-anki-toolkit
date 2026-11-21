// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
const { patchMarkdownConstants } = require('../Build/format-patches.cjs')
const constants = patchMarkdownConstants(['OBS_INLINE_MATH_REGEXP','OBS_DISPLAY_MATH_REGEXP','OBS_CODE_REGEXP','OBS_DISPLAY_CODE_REGEXP']
    .map(key => 'export const ' + key + ' = /x/g').join('\n'))
const ready = load(['delimited-rule', 'card-export-diagnostics', 'markdown-pipeline','anki-transport','constants','wizard-card-ownership'],
    {}, { constants })

test('multiline wizard exports exact capture groups, preserving paragraphs and note ID, for LF and CRLF', async () => {
    const { delimitedRule, readDelimitedRule } = (await ready)['delimited-rule']
    for (const eol of ['\n','\r\n']) for (const n of [2,3,4,8]) for (const sep of [':','||','[?]','🙂']) {
        const header = Array.from({length:n-1}, (_, i) => n === 2 ? 'Q: capital?' : 'value ' + i)
        const answer = ['First: §', '', ' - example', '  indented line.'].join(eol)
        const card = [':::anki',header.join(' ' + sep + ' '),answer,':::'].join(eol)
        const pattern = delimitedRule(n,sep,true)
        const format = readDelimitedRule(pattern)
        assert.equal(format.count,n);assert.equal(format.multiline,true);assert.equal(format.separator,n === 2 ? ':' : sep)
        const captures = new RegExp(pattern + '\\r?\\nTags: (.+)\\r?\\n<!--ID: (\\d+)-->','gmd')
            .exec([card,'Tags: tested','<!--ID: 321-->'].join(eol))
        assert.deepEqual(captures.slice(1), [...header, answer, 'tested','321'])
        for(const [idx,capture] of captures.slice(1).entries()) assert.equal(captures.input.slice(...captures.indices[idx+1]),capture)
        const unclosed = [':::anki',header.join(sep),'old answer',card].join(eol)
        const found = [...unclosed.matchAll(new RegExp(pattern,'gm'))]
        assert.equal(found.length,1);assert.equal(found[0].index,unclosed.indexOf(card))
    }
})

test('multiline ownership rejects overlapping models and incomplete cards before a write', async () => {
    const mods = await ready
    const { delimitedRule } = mods['delimited-rule']
    const { multilineOwnership } = mods['wizard-card-ownership']
    const rules = { Basic: delimitedRule(2,':',true), OneLine: delimitedRule(2,':') }
    const card = ':::anki\nQuestion\nExample: Vienna\n\nMore.\n:::'
    const second = card.replace('Question','Question 2')
    const text = card + '\n<!--ID: 213-->\n' + second
    const overlaps = multilineOwnership(text,rules,[])
    assert.equal(overlaps(0,card.length,'Basic'),false);assert.equal(overlaps(0,card.length,'OneLine'),true)
    assert.equal(overlaps(0,text.indexOf(second)-1,'Basic'),false);assert.equal(overlaps(0,text.length,'Basic'),true)
    const inside = /Example: Vienna/.exec(card).index
    assert.equal(overlaps(inside,inside+10,'OneLine'),true)
    assert.equal(overlaps(text.indexOf(second),text.length,'Basic'),false)
    for (const invalid of [card.slice(0,-3), card.slice(0,-3) + card, card.replace('Question','ID: 123'), card.replace('Example: Vienna','\t')]) {
        assert.throws(()=>multilineOwnership(invalid,rules,[]),/Multiline card, line 1/)
    }
    assert.throws(()=>multilineOwnership(card.replace('Question','Front : Another'),{...rules, Three:delimitedRule(3,':',true)},[]),/Two note types/)
    assert.throws(()=>multilineOwnership(card,rules,[/^Example: .+$/gm]),/directive overlaps/)
    assert.equal(multilineOwnership('~~~text\n'+card+'\n~~~\n<!--\n'+card+'\n-->',rules,[]),undefined)
})

test('wizard colon format skips reserved tag and ID lines both plain and in lists', async () => {
    const mods = await ready
    const { wizardStartGuard } = mods['card-export-diagnostics']
    const text = ['Tags: Cities','- Tags: city','* ID: 123','+ <!--ID: 123-->','- id : identity','- Vienna : Austria'].join('\r\n')
    const rule = mods['delimited-rule'].delimitedRule(2,':')
    const excluded = wizardStartGuard(text,[],[])
    assert.deepEqual([...text.matchAll(new RegExp(rule,'gm'))].filter(m=>!excluded(m.index)).map(m=>m.slice(1)),[['id','identity'],['Vienna','Austria']])
})

test('installed parser reserves the whole block before scanning other models or service commands', async () => {
    const { pageMethods, patchAcceptedMatches } = require('../Build/custom-regexp-patch.cjs')
    const { stripTypeScriptTypes } = require('node:module')
    const vm = require('node:vm')
    const m = await ready
    const check = await load(['anki-id-marker'],{})
    const loop = patchAcceptedMatches(`for (const match of this.file.matchAll(regexp)) {
        accepted.push(match[0])
    }`).code
    const compiled = stripTypeScriptTypes(`class Parser {
        ${pageMethods()}
        data = {}; ignore_spans = []; idDateWarnings = []
        scanBlockFormats() { this.scanned = true }
        linkedBulletOverlap() { return false }
        search(note_type, regexp) {
            const search_id = false, accepted = [], matches = [...this.file.matchAll(regexp)];
            ${loop}
            return accepted
        }
    }; Parser`)
    const Parser = vm.runInNewContext(compiled,{readPageCard:()=>null,
        multilineOwnership:m['wizard-card-ownership'].multilineOwnership,
        checkedCustomAnkiMatches:check['anki-id-marker'].checkedCustomAnkiMatches})
    const rules={Short:m['delimited-rule'].delimitedRule(2,':'),Long:m['delimited-rule'].delimitedRule(2,':',true)}
    const parser = new Parser()
    parser.custom_regexps=rules;parser.file=parser.original_file='outside: one\n:::anki\nQ\ninside: content\n\nadditional\n:::'
    await parser.scanFile()
    assert.equal(parser.scanned,true)
    assert.deepEqual(Array.from(parser.search('Short',new RegExp(rules.Short,'gm'))),['outside: one'])
    assert.deepEqual(Array.from(parser.search('Long',new RegExp(rules.Long,'gm'))),[parser.file.slice(parser.file.indexOf(':::anki'))])
    parser.data.EMPTY_REGEXP=/^inside: .+/gm
    parser.scanned=false
    await assert.rejects(parser.scanFile(),/directive overlaps/)
    assert.equal(parser.scanned,false)
})

test('overlapping generated row formats have a diagnostic independent of Anki model ordering', async () => {
    const mods = await ready
    const {delimitedRule} = mods['delimited-rule']
    const {checkWizardRowModels} = mods['wizard-card-ownership']
    const text='Q : A\nSide | note\nAmbiguous : answer | another'
    let calls = 0
    const results = (_model, expression) => { calls++; return [...text.matchAll(new RegExp(expression,'gm'))] }
    const available = { Basic:delimitedRule(2,':'), Vocabulary:delimitedRule(2,'|') }
    for(const rules of [available, Object.fromEntries(Object.entries(available).reverse())]) {
        assert.throws(()=>checkWizardRowModels(text,rules,results,()=>()=>false),/Two Anki models match line 3/)
        checkWizardRowModels(text,rules,results,()=>idx=>idx===text.indexOf('Ambiguous'))
    }
    calls=0
    checkWizardRowModels(text,{Basic:available.Basic,Page:'@page'},results,()=>()=>{throw Error('unexpected')})
    assert.equal(calls,0)
})
