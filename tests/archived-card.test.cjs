// SPDX-License-Identifier: GPL-3.0-only
'use strict'
const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { load } = require('./benchmark/migration-modules.cjs')
let archive, markers, linked, blocks, page, presets
before(async () => {
    const modules = await load(['archived-card','duplicate-markers','linked-bullets','bidirectional-blocks','page-card',
        'card-format-presets','anki'], {}, { anki: 'export {}' })
    archive = modules['archived-card']; markers = modules['duplicate-markers'].findIdMarkers
    linked = modules['linked-bullets'].findLinkedBullets
    blocks = modules['bidirectional-blocks'].findBidirectionalBlocks
    page = modules['page-card'].readPageCard
    presets = modules['card-format-presets']
})

test('Archive boundaries preserve Markdown, author strike, unchanged neighbors and stable positions', () => {
    for (const eol of ['\n','\r\n']) for (const trailing of ['', eol]) {
        const raw = ['- ~~Q~~ :: A','<!-- ID: 42 | 2026-11-19 -->'].join(eol) + trailing
        const wrapped = archive.wrapArchivedCard(raw, 42, 'Удалено из Anki', false, eol)
        assert.ok(wrapped.includes(raw))
        assert.equal(wrapped.endsWith(eol), !!trailing)
        const text = '## Cards' + eol + wrapped + eol + '- ~~Live~~ :: answer' + eol + 'ID: 43'
        const active = archive.activeCardMarkdown(text)
        const [range] = archive.archivedCardRanges(text)
        assert.equal(range.id, 42)
        assert.equal(text.slice(range.bodyStart, range.bodyEnd), raw.trimEnd())
        assert.equal(active.length, text.length)
        assert.equal(active.slice(text.indexOf('- ~~Live')), text.slice(text.indexOf('- ~~Live')))
        assert.deepEqual(Array.from(linked(text), x => x.id), [43])
        assert.deepEqual(Array.from(markers(text), x => x.id), [43])
        assert.ok(!active.includes('ID: 42'))
        for (const changed of [wrapped.replace('**Удалено из Anki**', '**Eigener Text**'),
            wrapped.replace('**Удалено из Anki**'+eol, ''), wrapped.replace('**Удалено из Anki**','plain label')]) {
            assert.equal(archive.archivedCardRanges(changed).length,1)
            assert.equal(markers(changed).length,0)
        }
    }
})

test('An archived page preserves properties, heading and body, and its old Anki note remains inactive', () => {
    const eol = '\r\n'
    const yaml = '\uFEFF---'+eol+'area: maps'+eol+'---'+eol
    const body = '# Vienna #anki-page'+eol+'<!--ID: 17-->'+eol+'A. ~~historical~~'
    const wrapped = archive.wrapArchivedCard(yaml+body,17,'Deleted from Anki',true)
    assert.ok(wrapped.startsWith(yaml+'<!--RUDONIUM-ARCHIVE:17:mark-->'))
    const [r] = archive.archivedCardRanges(wrapped)
    assert.equal(wrapped.slice(r.bodyStart,r.bodyEnd),body)
    assert.equal(archive.activeCardMarkdown(wrapped).slice(0,yaml.length),yaml)
    assert.equal(page(wrapped, { Basic: presets.pageCardExpression }), undefined)
    const explicit = 'START\nBasic\nFront: Q\nBack: A\nID: 77\nEND'
    assert.equal(blocks(archive.wrapArchivedCard(explicit,77,'Deleted from Anki')).length,0)
})

test('Mismatched, duplicate, unclosed and cross-owned archives fail closed; literal samples stay literal', () => {
    const raw = 'Q.\nID: 55'
    const wrap = archive.wrapArchivedCard(raw,55,'Deleted from Anki')
    for (const bad of [wrap.replace('/RUDONIUM-ARCHIVE:55','/RUDONIUM-ARCHIVE:56'), wrap.replace('ID: 55','ID: 56'),
        wrap.replace('ID: 55','ID: 55\nID: 56'),wrap.replace('<!--RUDONIUM-ARCHIVE:55:mark-->',''),
        wrap.replace('<!--/RUDONIUM-ARCHIVE:55-->',''),wrap+'\n'+wrap]) {
        assert.throws(() => archive.activeCardMarkdown(bad), /archive boundaries/)
    }
    for (const sample of ['~~~md\n'+wrap+'\n~~~','---\nexamples: |\n'+wrap.split('\n').map(x=>'    '+x).join('\n')+'\n---',
        '<pre>\n'+wrap+'\n</pre>','`'+wrap+'`','$$\n'+wrap+'\n$$','%%\n'+wrap+'\n%%']) {
        assert.equal(archive.activeCardMarkdown(sample),sample)
    }
})

test('New mark uses a visible caption; legacy strike presentation remains recognizable without rewriting old notes', () => {
    const marked = archive.wrapArchivedCard('- q :: a\nID: 19', 19, 'Deleted from Anki')
    const old = marked.replace('RUDONIUM-ARCHIVE:19:mark-->', 'RUDONIUM-ARCHIVE:19-->')
    assert.equal(archive.archivedCardRanges(marked)[0].style, 'mark')
    assert.equal(archive.archivedCardRanges(old)[0].style, 'legacy')
    assert.ok(marked.includes('**Deleted from Anki**'))
    assert.deepEqual(Array.from(markers(old)), [])
})

test('Human-readable portable comment and strikethrough round-trip Unicode, literal terminators, markup and line endings', () => {
    for (const eol of ['\n','\r\n']) for (const tail of ['',eol]) for (const style of ['hidden','strike']) {
        const yaml = '\uFEFF---' + eol + 'title: Wien' + eol + '---' + eol
        const body = ['# Вена 🏔️ #anki-page', '<!--ID: 42 | 2026-11-19-->', 'Цена &amp; &#45; &#37; <i>7</i> --> --!> %%пример%%',
            '', '~~~md', '<script>x</script>', '~~~', '| A | B |', '| --- | --- |', '[[Ратуша]] ![[а.jpg]] $x^2$ ~~вчера~~', 'line\u2028| test'].join(eol) + tail
        const wrapped = archive.wrapArchivedCard(yaml + body, 42, 'Удалено из Anki', true, eol, style)
        const [r] = archive.archivedCardRanges(wrapped)
        assert.equal(r.style,style)
        assert.equal(archive.archivedCardSource(wrapped,r),body)
        const comment = wrapped.slice(r.start,r.sourceEnd)
        assert.ok(comment.startsWith('<!--RUDONIUM-ARCHIVE:42:' + style + ':'))
        assert.equal(comment.indexOf('-->'),comment.length - 3, 'embedded HTML cannot close the archive')
        assert.ok(comment.includes('| # Вена 🏔️ #anki-page'))
        assert.ok(comment.includes('| &lt;!&#45;&#45;ID: 42'))
        assert.equal(wrapped.slice(0,r.start),yaml)
        assert.equal(archive.activeCardMarkdown(wrapped).trim(),yaml.trim())
        if (style === 'hidden') assert.equal(wrapped.slice(r.sourceEnd),tail)
        else {
            const visible = wrapped.slice(r.bodyStart,r.bodyEnd)
            assert.match(visible,/^<del data-rudonium="RUDONIUM-ARCHIVE:42">/)
            assert.match(visible,/<br>/)
            assert.ok(visible.endsWith('</del>'))
            assert.doesNotMatch(visible,/ID:|<script|<i>|\[\[|\$x|~~~|\| ---|<img/iu)
            const plain = visible.replace(/^<del [^>]+>|<\/del>$/gu,'').replaceAll('<br>', '\n')
                .replace(/&#(\d+);/gu, (_,n) => String.fromCharCode(+n))
            assert.equal(plain,body.split(eol).filter(row => !row.startsWith('<!--ID: 42')).join('\n').replace(/\n$/u,''))
        }
        const combined = wrapped + (tail ? '' : eol) + '## Cards' + eol + '- Следом :: вопрос' + eol + '<!--ID: 43-->'
        assert.deepEqual(Array.from(markers(combined),m=>m.id),[43])
        assert.deepEqual(Array.from(linked(combined),m=>m.id),[43])
    }
})

test('Portable archive corruption fails before scanning; code and HTML literal examples retain normal semantics', () => {
    for (const style of ['hidden','strike']) {
        const original = '- Bahnhof :: station\r\nID: 44'
        const wrapped = archive.wrapArchivedCard(original,44,'Deleted from Anki',false,'\r\n',style)
        const [r] = archive.archivedCardRanges(wrapped)
        const changed = [wrapped.replace('| - Bahnhof','- Bahnhof'), wrapped.replace('station','night'),
            wrapped.replace('/RUDONIUM-ARCHIVE:44-->', '/RUDONIUM-ARCHIVE:45-->'), wrapped.slice(0,wrapped.indexOf('/RUDONIUM-ARCHIVE')),
            wrapped + '\r\n' + wrapped, wrapped.replace('ID: 44','ID: 45')]
        if (style === 'strike') changed.push(wrapped.slice(0,r.sourceEnd), wrapped.slice(r.bodyStart), wrapped.replace('</del>','<img></del>'))
        for (const bad of changed) {
            assert.throws(()=>archive.activeCardMarkdown(bad), /archive boundaries/)
        }
        const lf = wrapped.replaceAll('\r\n','\n')
        assert.equal(archive.archivedCardSource(lf,archive.archivedCardRanges(lf)[0]), original.replaceAll('\r\n','\n'))
        for (const literal of ['~~~md\n'+wrapped+'\n~~~', '<pre>\n'+wrapped+'\n</pre>', '%%\n'+wrapped+'\n%%']) {
            assert.equal(archive.activeCardMarkdown(literal),literal)
        }
    }
})

test('A matching ID quoted inside a code sample remains in the visible struck text', () => {
    const raw = '# Example #anki-page\r\n<!--ID: 47-->\r\n~~~md\r\n<!--ID: 47-->\r\n~~~'
    const result = archive.wrapArchivedCard(raw,47,'Deleted',true,'\r\n','strike')
    const [range] = archive.archivedCardRanges(result)
    const shown = result.slice(range.bodyStart, range.bodyEnd).replace(/&#(\d+);/gu, (_m,n) => String.fromCharCode(+n))
    assert.equal((shown.match(/<!--ID: 47-->/gu) ?? []).length,1)
    assert.match(shown, /~~~md<br><!--ID: 47--><br>~~~/u)
})
