// SPDX-License-Identifier: GPL-3.0-only
const { before, test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')
let del, ids, linked, suspend, archived, wizard
before(async () => {
    const modules = await load(['card-export-diagnostics', 'anki-transport', 'deletion-source', 'archived-card', 'suspend-marker', 'suspend-label', 'duplicate-markers',
        'anki-id-marker', 'id-marker-literals', 'linked-bullets', 'bidirectional-blocks', 'bidirectional-markdown', 'page-card',
        'card-format-presets', 'delimited-rule', 'markdown-pipeline', 'export-recovery', 'anki'], {}, { anki: 'export {}' })
    del = modules['deletion-source']
    wizard = modules['delimited-rule'].delimitedRule
    ids = text => Array.from(modules['duplicate-markers'].findIdMarkers(text), m => m.id)
    linked = text => Array.from(modules['linked-bullets'].findLinkedBullets(text), m => m.id)
    archived = modules['archived-card']
    suspend = modules['suspend-marker']
})

test('a configured DELETE equal to the real END delimiter cannot delete the linked Anki note', () => {
    const source = 'START\nBasic\nFront: Q\nBack: A\nEND\nID: 55'
    assert.throws(() => del.explicitDeletes(source, { 'Delete Note Line':'END' }, {}), /deletion marker/i)
})
test('two identical pending DELETE directives cannot replay after the first successful deletion', () => {
    for (const cmd of ['DELETE\nDELETE\nID: 7', 'DELETE\nDELETE <!--ID: 7-->']) {
        assert.throws(() => del.explicitDeletes('## Cards\n- Q :: A\n'+cmd, {}, {}), /repeated deletion/i)
    }
})
test('two ordinary prices cannot hide an intervening ID and its requested suspension', () => {
    const source = 'Cost $5\n\n## Cards\n- How much? :: 5 dollars\nSUSPEND_2\nID: 25\n\nNew price $10'
    assert.deepEqual(ids(source), [25])
    assert.deepEqual(Array.from(suspend.readSuspendMarkers(source).get(25).selection), [2])
    assert.deepEqual(ids('$$\nID: 1\n$$\nID: 2'), [2])
    assert.deepEqual(ids('Cost $5 STARTI [Basic] X | Y | ENDI ID: 8 for $10'), [8])
    assert.deepEqual(ids('Cost $5. '+Array(3000).fill('$11').join(', ')+'\nID: 25'), [25])
})
test('examples of linked cards inside Obsidian comments, HTML raw text or math stay inactive', () => {
    for (const [open,close] of [['%%','%%'],['<pre>','</pre>'],['$$','$$'],['<!-- comment','-->']]) {
        const source = ['## Cards',open,'- sample :: sample','ID: 17',close,'- real :: actual','ID: 28'].join('\n')
        assert.deepEqual(linked(source), [28], open)
    }
})
test('a fence printed inside a comment cannot hide a subsequent ownership or deletion marker', () => {
    for (const [open,close] of [['%%','%%'],['<!--','-->']]) {
        const source = [open,'```',close,'## Cards','- real :: actual','DELETE','ID: 28'].join('\n')
        assert.deepEqual(ids(source), [28])
        assert.equal(del.explicitDeletes(source, {}, {}).directives[0].id, 28)
    }
})
test('file signature survives stand-alone deletion; the ID on a BOM-prefixed first line remains owned', () => {
    for (const eol of ['\n','\r\n']) {
        const source = '\ufeffDELETE'+eol+'ID: 7'+eol+'Other text'
        const plan = del.explicitDeletes(source, {}, {})
        assert.equal(del.cleanConfirmedDeletes(source, plan, new Set([7]), 'keep', false).text, '\ufeffOther text')
        assert.deepEqual(ids('\ufeffID: 11'+eol+'Other text'), [11])
        assert.equal(suspend.rewriteSuspendMarkers('\ufeffID: 11'+eol+'Other text',new Map([[11,'all']])), '\ufeffSUSPEND'+eol+'ID: 11'+eol+'Other text')
    }
})

test('mixed lifecycle actions apply to precisely the confirmed IDs and survive settings changes', () => {
    const syntax = { 'Delete Note Line': 'УБРАТЬ.[x]', 'Suspend Line': 'ПАУЗА' }
    let state = 211
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
    const modes = ['keep', 'mark', 'remove', 'strike', 'hidden']
    for (const eol of ['\r\n','\n']) for (const mode of modes) for (let round = 0; round < 4; round++) {
        const before = '---'+eol+'title: Tests'+eol+'---'+eol+'## Cards'+eol
        const after = '> Keep this prose exactly'+eol
        const explicit = [], remote = [], confirmed = new Set()
        const cardData = []
        for (let i=0; i<48; i++) {
            const id = round * 1000 + i + 1
            const selected = random() % 3 === 0
            const marker = i % 2 ? '<!-- ID: '+id+' | 2026-11-20 -->' : 'ID: '+id
            const text = '- Пункт '+id+' :: Antwort '+i
            const clean = text+eol+marker+eol
            const input = text+eol+(i % 2 ? syntax['Delete Note Line']+' '+marker : syntax['Delete Note Line']+eol+marker)+eol
            const command = i % 5 !== 0
            cardData.push({id, clean, input, command})
            explicit.push(command ? input : clean); remote.push(clean)
            if (command && selected) confirmed.add(id)
        }
        const src = before + explicit.join('') + after
        const old = before + remote.join('') + after
        const plan = del.explicitDeletes(src, syntax, {})
        const local = del.cleanConfirmedDeletes(src,plan,confirmed,mode,false)
        assert.ok(local.text.startsWith(before) && local.text.endsWith(after))
        let offset = before.length
        const candidates = []
        for (const {id,clean,input,command} of cardData) {
            if (confirmed.has(id)) candidates.push({id,start:offset,end:offset+clean.length,page:false})
            else assert.ok(local.text.includes(command ? input : clean))
            offset += clean.length
        }
        const external = del.cleanConfirmedDeletes(old, undefined, confirmed, mode, false, candidates)
        const masked = archived.activeCardMarkdown(local.text)
        for (const {id,clean} of cardData) if (confirmed.has(id)) {
            if (mode === 'keep') {
                assert.ok(local.text.includes(clean))
                assert.ok(external.text.includes(clean))
            } else {
                assert.ok(!masked.includes(clean))
                assert.ok(!archived.activeCardMarkdown(external.text).includes(clean))
            }
        }
        const left = del.explicitDeletes(local.text,syntax,{})
        assert.deepEqual(Array.from(left?.directives ?? [],d=>d.id),
            cardData.filter(c => c.command && !confirmed.has(c.id)).map(c=>c.id))
        assert.equal(del.cleanConfirmedDeletes(local.text,left,confirmed,modes[(modes.indexOf(mode)+1)%modes.length],true).text,local.text)
        assert.equal(del.cleanConfirmedDeletes(external.text,undefined,new Set(), 'remove',true).text,external.text)
    }
})

test('explicit delete inside a frozen instruction stays inert and cleanup cannot consume deck metadata above the command', () => {
    const patterns = [/^КОЛОДА: [^\r\n]+/gm, /^FILE TAGS: [^\r\n]+/gm,
        /^ОБЩИЕ - (.+?):\r?\n([\s\S]*?)(?:\r?\n\r?\n|(?![\s\S]))/gm]
    const expression = { Basic: wizard(2, ':') }
    const source = 'ОБЩИЕ - Basic:\r\nSource: value\r\nDELETE\r\nID: 777\r\n\r\n'
    assert.equal(del.explicitDeletes(source, {}, expression, undefined, patterns), undefined)
    const head = 'КОЛОДА: Geography\r\n'
    const item = head + 'DELETE\r\nID: 88'
    const plan = del.explicitDeletes(item, {}, expression, undefined, patterns)
    assert.equal(plan.directives[0].card, undefined)
    assert.equal(del.cleanConfirmedDeletes(item, plan, new Set([88]),'remove',false).text, head+'ID: 88')
    for (const mode of ['keep','remove','mark','hidden','strike']) {
        const card = 'Question: Answer\r\nDELETE\r\nID: 88'
        const plan = del.explicitDeletes(source+card, {}, expression, undefined, patterns)
        assert.deepEqual(Array.from(plan.directives,d=>d.id), [88])
        assert.equal(plan.directives[0].card.start,source.length)
        const local = del.cleanConfirmedDeletes(source+card,plan,new Set([88]),mode,false)
        assert.ok(local.text.startsWith(source))
        if (mode === 'remove') assert.equal(local.text,source)
        if (mode === 'keep') assert.equal(local.text,source+'Question: Answer\r\nID: 88')
    }
})
