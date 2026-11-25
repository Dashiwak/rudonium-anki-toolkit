// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const overlay = require('../Build/overlay-source.cjs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { stripTypeScriptTypes } = require('node:module');
const pageFile = require('./benchmark/page-file.cjs');

test('literal equals in a linked field round-trip while highlight delimiters stay protected', async () => {
    const { load } = require('./benchmark/migration-modules.cjs');
    const modules = await load(['bidirectional-markdown', 'markdown-pipeline'], {});
    const pattern = modules['markdown-pipeline'].markdownHighlightPattern();
    const { readEditableAnkiField, writeEditableAnkiField } = modules['bidirectional-markdown'];
    for (const literal of ['Казематы===-', 'Казематы====-', 'Казематы====.', 'Казематы========', 'Казематы====!',
        'Казематы==', 'a == b', 'x===y', 'x===y====z', 'de_DE-42%', 'Размер №3 (50%)']) {
        assert.equal(literal.replace(pattern, '<mark>$1</mark>'), literal);
        assert.equal(readEditableAnkiField(literal), literal);
        assert.equal(writeEditableAnkiField(literal), literal);
    }
    assert.equal('x====- ==выделено=='.replace(pattern, '<mark>$1</mark>'), 'x====- <mark>выделено</mark>');
    assert.equal('**Казематы**====-'.replace(pattern, '<mark>$1</mark>'), '**Казематы**====-');
    assert.equal(readEditableAnkiField('<b>Казематы</b>====-'), '**Казематы**====-');
    assert.equal(writeEditableAnkiField('**Казематы**====-'), '<strong>Казематы</strong>====-');
    for (const markup of ['==выделено==', 'x ==a=b==', '===', '---', 'a :: b', '<b>bad', '[[Wiki]]', 'a\u0000b']) {
        assert.equal(readEditableAnkiField(markup), undefined);
        assert.throws(() => writeEditableAnkiField(markup));
    }
});

test('Preset export, page ID insertion, repeated scan and verified two-way edits', async t => {
    const temp = fs.mkdtempSync(path.join(tmpdir(), 'rudonium-formats-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    for (const name of ['legacy-field-sections', 'page-frontmatter', 'page-named-fields', 'page-field-insertion', 'page-card', 'delimited-rule', 'archived-card', 'suspend-label', 'card-format-presets', 'anki-id-marker', 'id-marker-literals',
        'duplicate-markers', 'card-export-diagnostics', 'markdown-pipeline', 'interface-language', 'export-recovery', 'anki-transport', 'bidirectional-markdown', 'bidirectional-blocks', 'bidirectional-fields']) {
        const code = stripTypeScriptTypes(fs.readFileSync(overlay.file(name + '.ts'), 'utf8'))
            .replace(/from '(.\/[^']+)'/g, "from '$1.mjs'")
            .replace("from 'ts-md5'", "from './unused-md5.mjs'");
        fs.writeFileSync(path.join(temp, name + '.mjs'), code);
    }
    fs.writeFileSync(path.join(temp, 'unused-md5.mjs'), 'export class Md5 {}');
    const load = name => import(pathToFileURL(path.join(temp, name + '.mjs')).href);
    const { cardFormatPresets, applyRemNoteMetadata, currentCardExpression, legacyRemNoteExpression } = await load('card-format-presets');
    const { readPageCard, pageBlock, presetReaders, findPresetBlocks, deckPageLayoutMarker } = await load('page-card');
    const { findIdMarkers } = await load('duplicate-markers');
    const { addRecoveryMarker } = await load('export-recovery');
    const { applyMarkdownPatches, planExplicitBlockPatches, readCardTagOverride } = await load('bidirectional-markdown');
    const settings = { Basic: '@page' };
    const id = 1700000000103;
    fs.writeFileSync(path.join(temp, 'parser.mjs'), stripTypeScriptTypes(pageFile()));
    const { AllFile } = await load('parser');
    await t.test('page properties survive create, rescan, date updates and field writeback', async () => {
        const eol = '\r\n';
        const draft = ['---', 'tags: [travel]', 'theme: blue # keep', '---', '# Capital? #anki-page', 'Vienna', ''].join(eol);
        const first = new AllFile(draft);
        first.data.page_id_location = 'yaml';
        await first.scanFile();
        assert.equal(first.all_notes_to_add.length, 1);
        first.note_ids = [id];
        first.writeIDs();
        const saved = first.file;
        first.writeIDs();
        assert.equal(first.file, saved);
        const { dateLinkedMarkers, ankiIdNumberTokens } = await load('anki-id-marker');
        const { inspectCardSources } = await load('card-export-diagnostics');
        assert.deepEqual(ankiIdNumberTokens(saved), [id]);
        const markers = findIdMarkers(saved);
        assert.deepEqual(markers.map(m => m.id), [id]);
        const second = new AllFile(saved);
        second.data.page_id_location = 'heading';
        await second.scanFile();
        assert.deepEqual(second.auditNoteRanges, [[0, saved.length]]);
        assert.deepEqual(second.notes_to_edit.map(n => n.identifier), [id]);
        assert.equal(second.all_notes_to_add.length, 0);
        assert.deepEqual(second.notes_to_edit[0].note.fields, {Front:'Capital?', Back:'Vienna'});
        const missing = inspectCardSources({text:saved, ranges:second.previewCandidates, noteTypes:new Set(['Basic']),
            existingIds:new Set(),duplicateIds:new Map(),frontmatterEnd:saved.indexOf('# Capital')});
        assert.ok(missing.issues.some(issue => issue.id === id && issue.code === 'missing-id'));
        const unDated = saved.replace(' # | 2026-11-19', ' # an old annotation');
        const withDate = dateLinkedMarkers(unDated,findIdMarkers(unDated),new Set([id]),'2026-11-20');
        assert.ok(withDate.includes("# | 2026-11-20 an old annotation"));
        assert.equal(dateLinkedMarkers(withDate,findIdMarkers(withDate),new Set([id]),'2027-01-01'),withDate);
        const block = pageBlock(readPageCard(withDate, settings));
        const changed = applyMarkdownPatches(withDate, planExplicitBlockPatches(withDate,block,{Front:'City?',Back:'Wien'}));
        assert.equal(changed, withDate.replace('Capital?', 'City?').replace('Vienna','Wien'));
        assert.deepEqual(ankiIdNumberTokens(changed),[id]);
        assert.equal(readPageCard(changed,settings).id,id);
    });
    for (const eol of ['\n', '\r\n']) {
        const yaml = '\uFEFF---' + eol + 'tags: [travel]' + eol + '---' + eol + eol;
        const raw = yaml + '# Capital? #anki-page' + eol + eol + 'Vienna' + eol;
        const created = new AllFile(raw);
        created.data.page_id_location = 'heading';
        await created.scanFile();
        assert.equal(created.all_notes_to_add.length, 1);
        assert.deepEqual(created.all_notes_to_add[0].fields, { Front: 'Capital?', Back: 'Vienna' });
        assert.equal(created.all_notes_to_add[0].deckName, 'Knowledge');
        assert.equal(created.all_notes_to_add[0].context, '');
        assert.equal(created.previewCandidates[0].start, yaml.length);
        assert.equal(created.regex_id_indexes[0], raw.indexOf(eol, yaml.length) + eol.length);
        created.note_ids = [id]; created.writeIDs();
        const marker = '<!--ID: ' + id + ' | 2026-11-19-->';
        assert.equal(created.file, raw.replace('#anki-page' + eol, '#anki-page' + eol + marker + eol));
        const firstWrite = created.file;
        created.writeIDs();
        assert.equal(created.file, firstWrite);
        const linked = new AllFile(created.file);
        await linked.scanFile();
        assert.equal(linked.all_notes_to_add.length, 0);
        assert.deepEqual(linked.notes_to_edit.map(x => x.identifier), [id]);
        assert.deepEqual(linked.auditNoteRanges, [[yaml.length, created.file.length]]);
        const routed = new AllFile(linked.file.replace(marker, marker + eol +
            '<!--rudonium-page-route: ["Obsidian-basic","Atlas::Cities"]-->'));
        routed.custom_regexps = { Basic: 'some existing expression' };
        routed.data.page_model = 'Basic';
        routed.data.fields_dict['Obsidian-basic'] = ['Front', 'Back', 'Source', 'Context'];
        routed.data.file_link_fields = { 'Obsidian-basic': 'Source' };
        routed.data.context_fields = { 'Obsidian-basic': 'Context' };
        routed.data.add_file_link = true;
        await routed.scanFile();
        const editedNote = routed.notes_to_edit[0].note;
        assert.equal(editedNote.modelName, 'Obsidian-basic');
        assert.equal(editedNote.deckName, 'Atlas::Cities');
        assert.deepEqual(editedNote.fields, { Front: 'Capital?', Back: 'Vienna',
            Source: '<br><a href="obsidian://example" class="obsidian-link">Obsidian</a>', Context: 'Card.md > Capital?' });
        assert.deepEqual(routed.previewCandidates[0].authoredFields, ['Front', 'Back']);
        assert.equal(editedNote.url, 'obsidian://example');
        assert.equal(editedNote.context, 'Card.md > Capital?');
        assert.throws(() => readPageCard(routed.file, {}), /one Anki note type/);
        const deckExpressions = { 'ob-deck-basic': '@page' };
        const legacyFields = ['ob-deck-id', 'ob-deck-head', 'ob-deck-front', 'ob-deck-back', 'ob-deck-tags'];
        const legacy = linked.file.replace(marker, marker + eol + deckPageLayoutMarker);
        const archived = new AllFile(legacy);
        archived.custom_regexps = deckExpressions;
        archived.data.fields_dict = { 'ob-deck-basic': legacyFields };
        archived.data.file_link_fields = { 'ob-deck-basic': 'ob-deck-head' };
        archived.data.context_fields = { 'ob-deck-basic': 'ob-deck-tags' };
        await archived.scanFile();
        assert.deepEqual(archived.notes_to_edit[0].note.fields, { 'ob-deck-front': 'Capital?', 'ob-deck-back': 'Vienna' });
        assert.deepEqual(archived.previewCandidates[0].authoredFields, ['ob-deck-front','ob-deck-back']);
        assert.equal(archived.notes_to_edit[0].identifier, id);
        assert.equal(archived.notes_to_edit[0].note.url, '');
        assert.equal(archived.notes_to_edit[0].note.context, '');
        const importedBlock = pageBlock(readPageCard(legacy, deckExpressions));
        const tagged = applyMarkdownPatches(legacy, planExplicitBlockPatches(legacy, importedBlock,
            { Back: 'Updated' }, { inherited: [], effective: ['deck'] }));
        const taggedPage = readPageCard(tagged, deckExpressions);
        assert.deepEqual(taggedPage.fieldPair, ['ob-deck-front','ob-deck-back']);
        assert.equal(taggedPage.back, 'Updated');
        assert.equal(taggedPage.id, id);
        assert.ok(tagged.indexOf(deckPageLayoutMarker) > tagged.indexOf('anki-bidirectional-tags:'));
        for (const malformed of [legacy.replace(marker + eol, ''), legacy + deckPageLayoutMarker, legacy.replace(deckPageLayoutMarker, 'Answer' + eol + deckPageLayoutMarker)]) {
            assert.throws(() => readPageCard(malformed, deckExpressions), /layout/);
        }
        const wrongModel = new AllFile(legacy);
        await assert.rejects(wrongModel.scanFile(), /layout/);
        const withoutMarker = new AllFile(linked.file);
        withoutMarker.custom_regexps = deckExpressions;
        withoutMarker.data.fields_dict = archived.data.fields_dict;
        await assert.rejects(withoutMarker.scanFile(), /layout/);
        const block = pageBlock(readPageCard(linked.file, settings));
        const updated = applyMarkdownPatches(linked.file, planExplicitBlockPatches(linked.file, block,
            { Front: 'New question', Back: 'New answer' }, { inherited: [], effective: ['travel'] }));
        const page = readPageCard(updated, settings);
        assert.equal(page.front, 'New question'); assert.equal(page.back, 'New answer');
        assert.ok(updated.startsWith(yaml));
        assert.equal(updated.split(eol).filter(row => row === marker).length, 1);
        assert.deepEqual(readCardTagOverride(updated, pageBlock(page)), { add: ['travel'], remove: [] });
        assert.throws(() => planExplicitBlockPatches(linked.file, block, { Front: 'one\ntwo' }), /manual/);
        assert.equal(readPageCard(addRecoveryMarker(updated, 'a'.repeat(32)), settings).back, 'New answer');
        assert.throws(() => readPageCard(created.file + 'ID: 123', settings), /only one Anki ID/);
        assert.throws(() => readPageCard(created.file.replace(marker, 'ID: bad'), settings), /Invalid page ID/);
        assert.throws(() => readPageCard(raw, { Basic: '@page', Other: '@page' }), /one Anki note type/);
        assert.throws(() => readPageCard('# Empty #anki-page' + eol, settings), /Add an answer/);
        assert.equal(readPageCard(raw, {}), undefined);
        assert.equal(readPageCard('~~~' + eol + raw + eol + '~~~', settings), undefined);
        const prose = new AllFile('A normal page mentions #anki-page.');
        await assert.rejects(prose.scanFile(), /first-level/u);
        assert.equal(prose.all_notes_to_add.length, 0);
        const mixed = new AllFile('# Whole #anki-page' + eol + 'START' + eol + 'Basic' + eol + 'Front: Q' + eol + 'END');
        await mixed.scanFile(); assert.equal(mixed.all_notes_to_add.length, 1);
        for (const preset of cardFormatPresets.filter(f => f.id !== 'page' && f.expression)) {
            const regex = new RegExp(preset.expression, 'gm');
            const body = preset.example.replaceAll('\n', eol);
            assert.deepEqual(regex.exec(body).slice(1), [preset.front, preset.back], preset.id);
            const text = body + eol + marker;
            const readers = presetReaders({ Basic: preset.expression });
            const [editable] = findPresetBlocks(text, readers, findIdMarkers(text));
            assert.equal(editable.id, id);
            const edited = applyMarkdownPatches(text, planExplicitBlockPatches(text, editable, { Front: 'New question', Back: 'New answer' }));
            regex.lastIndex = 0;
            assert.deepEqual(regex.exec(edited).slice(1), ['New question', 'New answer']);
            assert.equal(findIdMarkers(edited)[0].id, id);
        }
    }
    const { presetStartGuard } = await load('card-export-diagnostics');
    const note = '---\nkey: A :: B\n---\n%%\nC :: D\n%%\n~~~\nE :: F\n~~~\nG :: H';
    const blocked = presetStartGuard(note, [[note.indexOf('~~~'), note.lastIndexOf('~~~') + 3]]);
    for (const sample of ['key:', 'C ::', 'E ::']) assert.equal(blocked(note.indexOf(sample)), true);
    assert.equal(blocked(note.indexOf('G ::')), false);
    const rem = cardFormatPresets.find(x => x.id === 'remnote');
    const restaurant = '**Карточки**\r\n- Как называется ресторан у подножия Ракса?+++ :: Wirtshaus zum Raxkönig :: B=de_DE';
    const [line, q, a] = new RegExp(rem.expression, 'gm').exec(restaurant);
    assert.equal(q, 'Как называется ресторан у подножия Ракса?+++');
    assert.equal(a, 'Wirtshaus zum Raxkönig');
    assert.equal(currentCardExpression(legacyRemNoteExpression), rem.expression);
    assert.equal(currentCardExpression('my own expression'), 'my own expression');
    const basic = { Front: q, Back: a };
    assert.deepEqual(applyRemNoteMetadata(rem.expression, line, basic, ['Front','Back']), []);
    assert.deepEqual(basic, { Front: q, Back: a });
    assert.deepEqual(applyRemNoteMetadata(legacyRemNoteExpression, line, basic, ['Front','Back','BackLang']), ['BackLang']);
    assert.equal(basic.BackLang, 'de_DE');
    assert.equal(new RegExp(rem.expression, 'gm').exec('Question :: Answer :: accidental text'), null);
    assert.throws(() => applyRemNoteMetadata(rem.expression, 'Q :: A :: B=ru_RU :: B=de_DE', {}, ['BackLang']), /Repeated/);
    const withId = restaurant + '\r\nID: ' + id;
    const [restaurantBlock] = findPresetBlocks(withId, presetReaders({ Basic: legacyRemNoteExpression }), findIdMarkers(withId));
    assert.equal(restaurantBlock.id, id);
    const modified = applyMarkdownPatches(withId, planExplicitBlockPatches(withId, restaurantBlock, { Back: 'Новый ответ' }));
    assert.ok(modified.includes('+++ :: Новый ответ :: B=de_DE\r\nID: ' + id));
    const table = cardFormatPresets.find(x => x.id === 'table');
    assert.equal(new RegExp(table.expression, 'gm').exec(table.example + '\n| extra | row |'), null);
    for (const format of cardFormatPresets.filter(x => x.expression && x.id !== 'page')) {
        const rx = new RegExp(format.expression, 'gm');
        assert.equal(rx.exec('| Front | Back |\n| --- | --- |\n| q |' + ' '.repeat(75000) + 'x'), null);
    }
    await t.test('Table ID whitespace, formatting conflicts, protected examples, and page properties/comments', async () => {
        const { tableIdSpacing, tableCardExpression, cardRegexpWithSuffix } = await load('card-format-presets')
        const { patchIdWrites } = require('../Build/format-patches.cjs')
        const insertion = patchIdWrites('function string_insert(text: string, inserts: Array<[number,string]>): string {\n    throw Error("stock");\n}\nexport { string_insert }')
        fs.writeFileSync(path.join(temp, 'insert.mjs'), stripTypeScriptTypes(insertion.replace(/from '(.\/[^']+)'/g, "from '$1.mjs'")))
        const { string_insert } = await load('insert')
        const { tableIdConflicts, inspectCardSources } = await load('card-export-diagnostics')
        const { ankiIdRegexpSource } = await load('anki-id-marker')
        for (const eol of ['\n','\r\n']) {
            const markdown = table.example.replaceAll('\n', eol)
            for (const marker of ['ID: ' + id, '<!--ID: ' + id + ' | 2026-11-19-->']) {
                for (const opening of [eol, '']) {
                    const source = markdown + opening
                    const formatted = source + tableIdSpacing(source, source.length, eol + marker)
                    assert.equal(formatted, markdown + eol + eol + marker)
                    const pairs = [[source.length, eol + marker]]
                    assert.equal(string_insert(source, pairs, new Set([source.length])), formatted)
                    assert.equal(string_insert(source, pairs), source + eol + marker)
                    for (const gap of ['',eol,' \t'+eol]) {
                        const file = markdown + eol + gap + marker
                        const result = new RegExp(cardRegexpWithSuffix(tableCardExpression,'',String.raw`(?:\r?\n[ \t]*)?` + ankiIdRegexpSource),'gm').exec(file)
                        assert.equal(result?.at(-1), String(id))
                        const [block] = findPresetBlocks(file, presetReaders({ Basic: tableCardExpression }),findIdMarkers(file))
                        assert.equal(block?.back, table.back)
                        assert.equal(block.eol,eol)
                    }
                }
                const insideCell = markdown.replace(table.back, marker.startsWith('<!--')
                    ? table.back + ' ' + marker + ' ★ checked' : marker + ' ★ checked')
                for (const literal of [markdown.replace(table.back, 'Example `' + marker + '`'), markdown.replace(table.back, 'Example | `' + marker + '` |')]) {
                    assert.deepEqual(tableIdConflicts(literal), [])
                }
                for (const damaged of [markdown + eol + '| ' + marker + ' |', markdown.replace(table.back, marker), insideCell]) {
                    const issues = tableIdConflicts(damaged)
                    assert.deepEqual(issues.map(row=>row.id),[id])
                    const diag = inspectCardSources({ text: damaged, tableIdWarnings: issues, ranges: [], existingIds: new Set(),
                        duplicateIds: new Map(), noteTypes: new Set(['Basic']) })
                    assert.equal(diag.issues[0].code, 'unmatched-id')
                    assert.deepEqual(tableIdConflicts(damaged, () => true),[])
                }
            }
            const preamble = ['---','alias: Vienna','---','', '<!-- credits -->','%% private','draft %%',''].join(eol) + eol
            const whole = preamble + '# Вопрос #anki-page ^local' + eol + eol + 'Ответ' + eol
            const first = new AllFile(whole); first.data.page_id_location = 'heading'; await first.scanFile()
            assert.equal(first.all_notes_to_add[0].fields.Front, 'Вопрос')
            first.note_ids = [id]; first.writeIDs()
            assert.ok(first.file.startsWith(preamble + '# Вопрос #anki-page ^local' + eol + '<!--ID:'))
            assert.equal(readPageCard(first.file,settings).id,id)
            const custom = pageBlock(readPageCard(first.file,settings),['Вопрос','Ответ','Источник'])
            assert.deepEqual(custom.fieldPair,['Вопрос','Ответ'])
            assert.equal(applyMarkdownPatches(first.file,planExplicitBlockPatches(first.file,custom,{ Back: 'Раз\n\nДва' })),
                first.file.replace('Ответ', 'Раз'+eol+eol+'Два'))
            for (const prefix of ['visible'+eol,'<!-- c --> visible'+eol+'<!-- c -->'+eol]) {
                assert.throws(() => readPageCard(prefix + '# test #anki-page'+eol+'answer',settings), /first-level/u)
            }
            assert.equal(readPageCard('%% unclosed'+eol+'# test #anki-page'+eol+'answer',settings), undefined)
        }
    })
    await t.test('wizard colon formats skip active deck, tags, frozen fields and per-card tag lines and respect renamed syntax', async () => {
        const { wizardStartGuard } = await load('card-export-diagnostics')
        const source = ['---', 'title: Frontmatter', '---', 'TARGET DECK: MyDeck', 'FILE TAGS: coffee', 'Tags: ingredient',
            'назначение: Колода', 'FROZEN - Basic:', 'Front: общая часть', 'Back: подпись', '',
            'Кофе: Coffee', '%%', 'ignored: comment', '%%'].join('\r\n')
        const blocked = wizardStartGuard(source, [], [/^(?:TARGET DECK|назначение):[^\r\n]+/gm, /^FILE TAGS:[^\r\n]+/gm,
            /^FROZEN - (.+?):\r?\n([\s\S]*?)(?:\r?\n\r?\n|(?![\s\S]))/gm])
        const matches = Array.from(source.matchAll(/^([^:\r\n]+):[ \t]*([^:\r\n]+)$/gm))
        assert.deepEqual(matches.filter(m => !blocked(m.index)).map(m=>m[1].trim()), ['Кофе'])
    })
});

test('both first-card guides document the built-in RemNote rule and a valid linked card', async () => {
    const { load } = require('./benchmark/migration-modules.cjs');
    const modules = await load(['card-format-presets', 'anki-id-marker', 'id-marker-literals'], {});
    const preset = modules['card-format-presets'].cardFormatPresets.find(item => item.id === 'remnote');
    for (const name of ['README.md', 'README.ru.md']) {
        const guide = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
        const expressions = Array.from(guide.matchAll(/^`{3}regex\r?\n([^\r\n]+)\r?\n`{3}/gm), match => match[1]);
        assert.ok(expressions.includes(preset.expression), name + ': the manual rule must match the preset');
        const examples = Array.from(guide.matchAll(/^([ ]*)`{3}markdown\r?\n([\s\S]*?)^\1`{3}/gm),
            match => match[2].trimEnd().split(/\r?\n/).map(line => line.slice(match[1].length)));
        const card = examples.find(lines => lines.length === 1 && new RegExp(preset.expression).test(lines[0]));
        assert.ok(card, name + ': missing new card example');
        const fields = new RegExp(preset.expression).exec(card[0]).slice(1);
        assert.equal(fields.length, 2);
        assert.ok(fields.every(field => field.trim().length > 0));
        const linked = examples.find(lines => lines.length === 2 && lines[0] === card[0]);
        assert.ok(linked, name + ': the export must keep the original line');
        assert.equal(modules['anki-id-marker'].parseAnkiIdMarker(linked[1])?.comment, true);
    }
});
