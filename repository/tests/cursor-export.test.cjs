// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { before, test } = require('node:test');
const vm = require('node:vm');
const overlay = require('../Build/overlay-source.cjs');

let cursor, Manager, retainNew, recovery;
const parserHost = {};
const hash = text => require('node:crypto').createHash('md5').update(text).digest('hex');
const md5 = { hashStr: hash };
before(async () => {
    const modules = new Map();
    for (const name of ['cursor-card', 'legacy-field-sections', 'bidirectional-fields', 'archived-card', 'markdown-pipeline', 'image-field-links', 'export-recovery', 'anki-transport', 'suspend-marker', 'suspend-label',
        'page-frontmatter', 'duplicate-markers', 'id-marker-literals', 'anki-id-marker', 'oneway-suspend', 'export-plan']) {
        const text = readFileSync(overlay.file(name + '.ts'), 'utf8');
        modules.set('./' + name, new vm.SourceTextModule(stripTypeScriptTypes(text, { mode: 'transform' })));
    }
    modules.set('ts-md5', new vm.SyntheticModule(['Md5'], function () { this.setExport('Md5', md5); }));
    for (const mod of modules.values()) {
        if (mod.status === 'unlinked') await mod.link(id => modules.get(id));
        if (mod.status === 'linked') await mod.evaluate();
    }
    cursor = modules.get('./cursor-card').namespace;
    recovery = modules.get('./export-recovery').namespace;
    // Compile the actual FileManager methods emitted by the overlay installer.
    const installer = readFileSync(join(__dirname, '../Build/patch-manager.cjs'), 'utf8');
    const prefix = 'source = source.slice(0, generate.getStart(latest)) + ';
    const start = installer.indexOf(prefix);
    assert.ok(start !== -1);
    const emitted = vm.runInNewContext(installer.slice(start + prefix.length, installer.indexOf(' + source.slice(initialise.end)', start)));
    const sourceFile = readFileSync(join(__dirname, '../Build/format-patches.cjs'), 'utf8');
    const remove = sourceFile.slice(sourceFile.indexOf('    removeUnsafeNewCards('), sourceFile.indexOf('    private pushPreviewNote'));
    retainNew = new Function(stripTypeScriptTypes('class Bind {\n' + remove + '\n}', { mode: 'transform' }) + '\nreturn Bind.prototype.removeUnsafeNewCards;')();
    Object.assign(parserHost, cursor, modules.get('./archived-card').namespace, modules.get('./suspend-marker').namespace, modules.get('./oneway-suspend').namespace, { Md5: md5,
        explicitDeletes: () => undefined, frontmatterTags: () => [], findLinkedBullets: () => [], collectNoteIds: () => [7, 8],
        mayHaveCardMarkers: () => false, applyAuthoredTags() {}, readRecoveryMarker: recovery.readRecoveryMarker,
        readLinkedBulletModels: async () => new Map(), mediaNames: values => new Set(values),
        cardAtOffset: (file, source, at) => {
            assert.equal(file.original_file, source);
            const cards = file.previewCandidates.filter(card => card.start <= at && at < card.end);
            assert.equal(cards.length, 1);
            return cards[0];
        },
    });
    Manager = new Function(...Object.keys(parserHost), stripTypeScriptTypes('class FileManager {\n' + emitted + '\n}', { mode: 'transform' }) + '\nreturn FileManager;')(...Object.values(parserHost));
});

const path = 'Atlas/Dictionary.md';
const sample = ['подсказка 💬', 'linked7', 'new1', 'new2', 'linked8', 'DELETE', 'ID: 111'].join('\r\n');
function bindFixture(source, at, id) {
    const candidates = ['linked7', 'new1', 'new2', 'linked8'].map((label, i) => {
        const start = source.indexOf(label);
        const format = i === 2 ? '<img src="two%20words.png">' : i === 0 ? '[sound:chosen.mp3]' : '<img src="neighbor.jpg">';
        return { start, end: start + label.length, identifier: i === 0 ? 7 : i === 3 ? 8 : undefined,
            note: { modelName: 'Basic', deckName: 'Atlas', fields: { Front: label, Back: format } } };
    });
    const additions = candidates.filter(card => card.identifier === undefined);
    const parsed = { path, original_file: source, previewCandidates: candidates,
        notes_to_edit: candidates.filter(card => card.identifier !== undefined).map(card => ({ identifier: card.identifier, note: card.note })),
        notes_to_delete: [111], notes_to_add: [], id_indexes: [], inline_notes_to_add: [], inline_id_indexes: [],
        regex_notes_to_add: additions.map(card => card.note), regex_id_indexes: additions.map(card => card.end),
        all_notes_to_add: additions.map(card => card.note), markdownWarningLines: [], removeUnsafeNewCards: retainNew,
        formatter: { detectedMedia: new Set(['Travel/chosen.mp3', 'two words.png', 'Photos/neighbor.jpg']) },
    };
    const text = source.replaceAll('\r\n', '\n');
    const expected = { path, text, offset: text.indexOf(at), id, model: 'Basic', deck: 'Atlas', profile: 'User', configuration: '{}' };
    return { parsed, expected };
}

async function scoped(label, id, options = {}) {
    const { parsed, expected } = bindFixture(sample, label, id);
    const file = { path, stat: { mtime: 1, size: sample.length } };
    const manager = Object.assign(new Manager(), {
        files: [file], cursorCard: expected, data: { fields_dict: { Basic: ['Front', 'Back'] }, custom_regexps: {} },
        file_hashes: {}, scanErrors: [], ownFiles: [], linkedSnapshots: new Map(), recoverySources: new Map(),
        sourceHashes: new Map(), mediaByNote: new Map(), previewSuppressed: new Set(), cardIssues: new Map(),
        retryPaths: new Set(), retryMessages: new Set(), suspensionHints: new Set(), suspensionMarks: new Map(), idDateWarnings: [], parseMarkdown: async () => parsed,
        ...options,
    });
    const asked = [];
    await manager.initialiseFiles(ids => { asked.push(...ids); return [...ids]; }, new Map(), {
        textByPath: new Map([[path, options.storedText ?? sample]]), fullExport: new Set([path]), duplicates: new Map(), conflictingPaths: new Map(),
    });
    return { manager, parsed, expected, asked };
}

test('one-way cursor scope retains one update and just its audio, omitting other edits, two creations and deletion', async () => {
    const { manager, parsed, asked } = await scoped('linked7', 7);
    assert.deepEqual(manager.scanErrors, []);
    assert.deepEqual(asked, [7]);
    assert.deepEqual(parsed.notes_to_edit.map(entry => entry.identifier), [7]);
    assert.equal(parsed.all_notes_to_add.length, 0);
    assert.equal(parsed.notes_to_delete.length, 0);
    assert.deepEqual([...parsed.formatter.detectedMedia], ['Travel/chosen.mp3']);
    assert.equal(manager.ownFiles.length, 1);
});

test('new card under cursor retains its own insertion slot across CRLF and Unicode and never requests adjacent note IDs', async () => {
    const { manager, parsed, expected, asked } = await scoped('new2');
    assert.deepEqual(manager.scanErrors, []);
    assert.deepEqual(asked, []);
    assert.equal(parsed.all_notes_to_add.length, 1);
    assert.equal(parsed.all_notes_to_add[0].fields.Front, 'new2');
    assert.deepEqual(parsed.regex_id_indexes, [sample.indexOf('new2') + 4]);
    assert.equal(parsed.notes_to_edit.length + parsed.notes_to_delete.length, 0);
    assert.deepEqual([...parsed.formatter.detectedMedia], ['two words.png']);
    assert.equal(cursor.cursorCardOffset(expected, path, sample), sample.indexOf('new2'));
    assert.throws(() => cursor.cursorCardOffset(expected, path, sample + '!'));
    const wrong = await scoped('new2', 7);
    assert.equal(wrong.manager.ownFiles.length, 0);
    assert.match(wrong.manager.scanErrors.join(''), /changed/);
});

test('a marked partial creation resumes only its journaled slot; starting a different cursor action is blocked', async () => {
    const token = 'e'.repeat(32);
    const storage = new Map();
    const vaultStore = { exists: async path => storage.has(path), read: async path => storage.get(path), write: async (path, data) => { storage.set(path, data); } };
    const journal = await recovery.ExportRecovery.open(vaultStore, 'state');
    const { parsed, expected } = bindFixture(sample, 'new2');
    const note = parsed.regex_notes_to_add[1];
    const offset = cursor.cursorCardOffset(expected, path, sample);
    await journal.begin([{ path, sourceHash: hash(sample), signatures: [hash(note.fields.Front)], token, tagVersion: 1, cursorOffset: offset }], 'User');
    const reloaded = await recovery.ExportRecovery.open(vaultStore, 'state');
    assert.equal(reloaded.byToken(token).cursorOffset, offset);
    const marked = recovery.addRecoveryMarker(sample, token);
    const retry = { storedText: marked, cursorCard: undefined, cursorRecovery: { path, token }, ankiProfile: 'User', getRecovery: async () => reloaded };
    const resumed = await scoped('new2', undefined, retry);
    assert.deepEqual(resumed.manager.scanErrors, []);
    assert.deepEqual(resumed.parsed.all_notes_to_add.map(note => note.fields.Front), ['new2']);
    assert.deepEqual(resumed.parsed.regex_id_indexes, [sample.indexOf('new2') + 4]);
    assert.equal(resumed.manager.previewSuppressed.has(path), true);
    for (const invalid of [{ ankiProfile: 'Other' }, { storedText: sample }, { cursorRecovery: { path, token: 'a'.repeat(32) } }]) {
        const rejected = await scoped('new2', undefined, { ...retry, ...invalid });
        assert.equal(rejected.manager.ownFiles.length, 0);
        assert.match(rejected.manager.scanErrors.join(''), /changed/);
    }
    const blocked = await scoped('linked7', 7, { storedText: marked });
    assert.equal(blocked.manager.ownFiles.length, 0);
    assert.match(blocked.manager.scanErrors.join(''), /Pending/);
});
