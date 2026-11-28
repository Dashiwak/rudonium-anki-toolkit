// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('./benchmark/migration-modules.cjs')

const id = 1778136066587
const fieldNames = ['-FW', '-NW', '-NO']
const modelName = 'EnDic26'
const schema = { [modelName]: fieldNames }
const syntax = { 'Begin Note': '!--', 'End Note': '!---' }
const fields = { '-FW': 'LOOK YOUNG', '-NW': 'выглядеть молодо', '-NO': '&#x21;' }
const modules = load(['anki-source-restore-format', 'note', 'bidirectional-blocks', 'bidirectional-markdown',
    'anki-id-marker'], { isRecoveryTag: tag => tag.startsWith('anki-recovery-') })

function parse(mods, markdown, addTags) {
    const { Note } = mods.note
    const body = markdown.trim().split(/\r?\n/u).slice(1, -1).join('\n')
    const converter = { format: text => text }
    return new Note(body, schema, false, false, converter).parse('Vocabulary', '', {}, {
        template: { fields: {}, tags: [], options: {} }, add_obs_tags: addTags,
    }, '')
}

test('restored inline tags parse as tags with indexing on or off, preserving visible field text and ID', async () => {
    const mods = await modules
    const { formatAnkiSourceRestore, sameRestoredAnkiField } = mods['anki-source-restore-format']
    const tags = ['2col', '2COL', 'Язык::Глава2', '123', 'a/b', 'x.y', 'anki-recovery-private']
    const { markdown } = formatAnkiSourceRestore({ fields, modelName, tags, fieldNames, syntax, id, idAsComment: true })
    assert.ok(markdown.includes('-FW: LOOK YOUNG #2col #Язык/Глава2\n'))
    assert.ok(markdown.includes('-NO: !\nTags: 123 a/b x.y\n<!--ID: ' + id + ' @field-tags-->'))
    for (const setting of [false, true]) {
        const parsed = parse(mods, markdown, setting)
        assert.equal(parsed.identifier, id)
        assert.equal(parsed.note.fields['-FW'], 'LOOK YOUNG')
        assert.equal(parsed.note.fields['-NO'], '!')
        assert.ok(sameRestoredAnkiField(parsed.note.fields['-NO'], '&#33;'))
        assert.deepEqual([...parsed.note.tags].sort(), ['123', '2col', 'a/b', 'x.y', 'Язык::Глава2'].sort())
    }
})

test('only a signed ID enables inline suffix parsing; tags can be edited and unrelated hashtags retain their semantics', async () => {
    const mods = await modules
    const { formatAnkiSourceRestore } = mods['anki-source-restore-format']
    const { markdown } = formatAnkiSourceRestore({ fields, modelName, tags: ['2col'], fieldNames, syntax, id })
    assert.equal(parse(mods, markdown.replace('#2col', '#новый/раздел'), false).note.tags[0], 'новый::раздел')
    const original = markdown.replace(' @field-tags', '')
    assert.equal(parse(mods, original, false).note.fields['-FW'], 'LOOK YOUNG #2col')
    assert.deepEqual([...parse(mods, original, false).note.tags], [])
    assert.deepEqual([...parse(mods, original, true).note.tags], ['2col'])
    const noTags = formatAnkiSourceRestore({ id, modelName, fieldNames, fields, tags: [], syntax })
    assert.doesNotMatch(noTags.markdown, /@field-tags|Tags: /u)
    const literal = formatAnkiSourceRestore({ id, modelName, fieldNames, syntax,
        fields: { ...fields, '-FW': 'literal #word' }, tags: ['2col'] })
    for (const setting of [false, true]) {
        const parsed = parse(mods, literal.markdown, setting)
        assert.deepEqual([...parsed.note.tags], ['2col'])
        assert.ok(mods['anki-source-restore-format'].sameRestoredAnkiField(parsed.note.fields['-FW'], 'literal #word'))
    }
})

test('filling or updating the first field from Anki leaves its hashtag outside the bidirectional edit span', async () => {
    const mods = await modules
    for (const front of ['LOOK YOUNG', '']) {
        const { markdown } = mods['anki-source-restore-format'].formatAnkiSourceRestore({
            id, modelName, fieldNames, fields: { ...fields, '-FW': front }, tags: ['2col'], syntax,
        })
        const content = markdown.replaceAll('\n', '\r\n')
        const [block] = mods['bidirectional-blocks'].findBidirectionalBlocks(content, syntax, schema)
        assert.equal(block.front, front)
        const [patch] = mods['bidirectional-markdown'].planExplicitBlockPatches(content, block, { Front: 'look older' })
        const updated = content.slice(0, patch.start) + patch.text + content.slice(patch.end)
        assert.ok(updated.includes('-FW: look older #2col\r\n'))
        assert.deepEqual([...parse(mods, updated, false).note.tags], ['2col'])
    }
})

test('restoration decodes one layer of text entities without losing the ID or introducing an unintended hashtag', async () => {
    const mods = await modules
    const { formatAnkiSourceRestore, sameRestoredAnkiField } = mods['anki-source-restore-format']
    for (const [anki, visible] of [['!', '!'], ['&#33;', '!'], ['[word]', '[word]'], ['&hellip;', '…'], ['&quot;вперёд!&quot;', '"вперёд!"'],
        ['2 &lt; 3 &amp; 5 &gt; 4', '2 < 3 & 5 > 4'], ['&#x1F680;', '🚀'], ['50% плюс $2', '50% плюс $2']]) {
        const { markdown } = formatAnkiSourceRestore({ id, modelName, fieldNames,
            fields: { ...fields, '-NO': anki }, tags: [], syntax })
        assert.ok(markdown.includes('-NO: ' + visible + '\n'), markdown)
        assert.ok(sameRestoredAnkiField(visible, anki))
    }
    const input = 'literal &amp;copy;'
    const formatted = formatAnkiSourceRestore({ id, modelName, fieldNames, fields: { ...fields, '-NO': input }, tags: [], syntax })
    assert.ok(sameRestoredAnkiField(parse(mods, formatted.markdown, false).note.fields['-NO'], input))
})

test('desktop entity decoding receives only entity tokens and also works inside an unsupported manual field', async () => {
    const inputs = []
    class DOMParser {
        parseFromString(entity, format) {
            assert.equal(format, 'text/html')
            assert.match(entity, /^&[a-z]+;$/iu)
            inputs.push(entity)
            const known = { '&eacute;': 'é', '&euro;': '€', '&rarr;': '→' }
            return { body: { textContent: known[entity] ?? entity } }
        }
    }
    const loaded = await load(['anki-source-restore-format'], { isRecoveryTag: () => false }, {}, { DOMParser })
    const format = value => loaded['anki-source-restore-format'].formatAnkiSourceRestore({
        id, modelName, fieldNames, fields: { ...fields, '-NO': value }, tags: [], syntax,
    })
    const good = format('caf&eacute; &euro; &rarr; &#33; &#x21;')
    assert.deepEqual([...good.manualFields], [])
    assert.ok(good.markdown.includes('-NO: café € → ! !'))
    const manual = format('<span style="color: red">caf&eacute; &euro; &rarr; &#33;</span>')
    assert.deepEqual([...manual.manualFields], ['-NO'])
    assert.ok(manual.markdown.includes('café € → !'))
    assert.equal(manual.fields['-NO'], '<span style="color: red">caf&eacute; &euro; &rarr; &#33;</span>')
    assert.deepEqual([...new Set(inputs)].sort(), ['&eacute;', '&euro;', '&rarr;'])
    const noDom = (await modules)['anki-source-restore-format'].formatAnkiSourceRestore({
        id, modelName, fieldNames, fields: { ...fields, '-NO': '<span style="color:red">&#33; &#x1f680;</span>' },
        tags: [], syntax,
    })
    assert.ok(noDom.markdown.includes('! 🚀'))
})
