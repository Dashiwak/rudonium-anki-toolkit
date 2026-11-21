// SPDX-License-Identifier: GPL-3.0-only
import createClassList from './dom-class-list.cjs'
// Реальные временные файлы, исходный код переноса и модель окна Obsidian.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import overlay from '../Build/overlay-source.cjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const kit = overlay.directory;
const temporary = mkdtempSync(join(tmpdir(), 'rudonium-id-migration-'));
const require = createRequire(import.meta.url);
globalThis.require = require;

const hostFile = join(temporary, 'obsidian.mjs');
const linkedFile = join(temporary, 'image-receipts.mjs');
writeFileSync(linkedFile, 'export const setImageReceiptDirectory = (app, folder) => { app.receiptDirectory = folder };');
writeFileSync(hostFile, `
const createClassList = ${createClassList}
export const modals = [];
export const notices = [];
export class FileSystemAdapter { constructor(root) { this.root = root } getBasePath() { return this.root } }
class Element {
    constructor(tag, attr = {}) { this.tag = tag; this.attr = attr; this.children = []; this.classList = createClassList(); this.text = attr.text ?? ''; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    setText(text) { this.text = text; }
    empty() { this.children.length = 0; }
    createEl(tag, attr) { const el = new Element(tag, attr); this.children.push(el); return el; }
    createDiv(attr) { return this.createEl('div', attr); }
    createSpan(attr) { return this.createEl('span', attr); }
    insertBefore(el, before) { this.children.splice(this.children.indexOf(el), 1); this.children.splice(this.children.indexOf(before), 0, el); }
    querySelector() {}
    setAttribute() {}
}
export class Notice { constructor(message) { notices.push(message); } }
export const setIcon = () => {};
export class Modal {
    constructor() { this.titleEl = new Element('title'); this.modalEl = new Element('modal'); this.contentEl = new Element('content'); }
    open() { this.onOpen?.(); modals.push(this); }
    close() { const index = modals.indexOf(this); if (index >= 0) modals.splice(index, 1); }
}`);
for (const name of ['plugin-migration','plugin-identity','interface-language','modal-layout']) {
    const code = stripTypeScriptTypes(readFileSync(join(kit, name + '.ts'), 'utf8'), { mode: 'transform' })
        .replaceAll("from 'obsidian'", "from './obsidian.mjs'")
        .replaceAll("from './export-image-replacement'", "from './image-receipts.mjs'")
        .replace(/from '(\.\/[a-z0-9-]+)'/g, "from '$1.mjs'");
    writeFileSync(join(temporary, name + '.mjs'), code);
}
const { FileSystemAdapter, modals, notices } = await import(pathToFileURL(hostFile));
const { pauseForMigration } = await import(pathToFileURL(join(temporary,'plugin-migration.mjs')));
const previousError = console.error;
// Контролируемые отказы видны в проверяемом Notice. При неожиданном исключении сохраняем стек.
console.error = (...args) => {
    if (typeof args[0] === 'string' && /Migration error|Could not verify migration/.test(args[0])) return;
    previousError(...args);
};
const oldId = 'obsidian-to-anki-plugin';
const previous = 'rupos-anki-toolkit';
const id = 'rudonium-anki-toolkit';
const sourceState = {
    settings: { CUSTOM_REGEXPS: {}, Syntax: {}, Defaults: {} }, 'Added Media': [], 'File Hashes': { 'note.md': 'md5' },
    fields_dict: { Basic: ['Front', 'Back'] },
};
const digest = value => createHash('sha256').update(value).digest('hex');

function fixture(withOld = true) {
    const root = mkdtempSync(join(temporary, 'vault-'));
    const config = join(root, '.obsidian');
    const target = join(config, 'plugins', id);
    const source = join(config, 'plugins', oldId);
    mkdirSync(target, { recursive: true });
    if (withOld) {
        mkdirSync(source);
        writeFileSync(join(source, 'data.json'), JSON.stringify(sourceState));
    }
    const plugin = { manifest: { id, dir: '.obsidian/plugins/' + id }, app: { vault: { configDir: '.obsidian', adapter: new FileSystemAdapter(root) } },
        register(dispose) { this.disposeMigration = dispose }, addCommand() {} };
    let starts = 0;
    return { target, source, config, plugin, pause: review => pauseForMigration(plugin, async () => { starts++; }, review),
        starts: () => starts, enabled: (...ids) => writeFileSync(join(config, 'community-plugins.json'), JSON.stringify(ids)) };
}
const current = () => modals.at(-1);
function click(label) {
    const controls = current().contentEl.children.find(el => el.attr.cls === 'modal-button-container');
    const button = controls.children.find(item => item.text === label);
    assert.ok(button, label);
    button.onclick();
}
async function until(predicate) {
    for (let index = 0; index < 500; index++) {
        if (predicate()) return;
        await setTimeout(10);
    }
    assert.ok(predicate(), 'expected change before timeout');
}

try {
    const clean = fixture(false);
    assert.equal(await clean.pause(), false);
    assert.equal(clean.plugin.app.receiptDirectory, '.obsidian/plugins/' + id);
    assert.deepEqual(readdirSync(clean.target), []);
    console.log('PASS fresh startup performs no migration writes');


    for (const hasOld of [true,false]) {
        const loading = fixture(hasOld);
        const inspection = loading.pause();
        assert.equal(typeof loading.plugin.disposeMigration,'function');
        loading.plugin.disposeMigration();
        assert.equal(await inspection,true);
        assert.equal(loading.starts(),0);
        assert.equal(current(),undefined);
        assert.deepEqual(readdirSync(loading.target),[]);
    }
    console.log('PASS unloading during initial asynchronous inspection suppresses normal initialization and migration UI for both fresh and upgraded vaults');

    const regular = fixture();
    const names = ['data.json', 'fast-scan-index.json', 'pending-new-notes.json.0',
        'one-way-history.json.' + 'a'.repeat(32) + '.1', 'bidirectional-sync.json.' + 'b'.repeat(32) + '.staged',
        ...['0', '1', 'staged'].map(slot => 'bidirectional-sync.json.' + 'b'.repeat(32) + '.journal.' + slot),
        'audit-repair-intent-' + 'c'.repeat(32) + '.json', 'last-export-report.json',
        'image-replacements/' + 'd'.repeat(64) + '.json'];
    mkdirSync(join(regular.source, 'image-replacements'));
    for (const path of names.slice(1)) writeFileSync(join(regular.source, path),
        path === 'fast-scan-index.json' ? JSON.stringify({ idsByPath: [['note.md', [1, 2, 3, [123, 456]]] ] }) : path);
    writeFileSync(join(regular.source, 'unrelated.txt'), 'stay behind');
    regular.enabled(oldId, id);
    assert.equal(await regular.pause(), true);
    assert.match(current().contentEl.textContent, /Disable.*Export to Anki/);
    assert.deepEqual(readdirSync(regular.target), []);
    regular.enabled(id);
    click('Check again');
    await until(() => current().contentEl.textContent.includes('Anki IDs recorded in the previous index: 2'));
    assert.deepEqual(readdirSync(regular.target), []);
    click('Copy settings and state');
    await until(() => regular.starts() === 1 && !current());
    for (const path of names) assert.deepEqual(readFileSync(join(regular.target, path)), readFileSync(join(regular.source, path)));
    assert.equal(existsSync(join(regular.target, 'unrelated.txt')), false);
    assert.equal(await regular.pause(), false);
    console.log('PASS legacy-enabled guard and read-only preview followed by explicit bytes-verified import');

    const stale = fixture();
    assert.equal(await stale.pause(), true);
    writeFileSync(join(stale.source, 'data.json'), JSON.stringify({ ...sourceState, 'File Hashes': { 'other.md': 'new' } }));
    click('Copy settings and state');
    await until(() => current().contentEl.textContent.includes('Migration could not finish'));
    assert.deepEqual(readdirSync(stale.target), []);
    current().close();
    console.log('PASS changed source is rejected before copying');

    const resumed = fixture();
    const settings = readFileSync(join(resumed.source, 'data.json'));
    const index = '{}';
    writeFileSync(join(resumed.source, 'fast-scan-index.json'), index);
    writeFileSync(join(resumed.target, 'data.json'), settings);
    writeFileSync(join(resumed.target, 'rupos-migration-pending.json'), JSON.stringify({
        version: 1, files: [{ path: 'data.json', hash: digest(settings) }, { path: 'fast-scan-index.json', hash: digest(index) }],
    }));
    assert.equal(await resumed.pause(), true);
    click('Resume migration');
    await until(() => resumed.starts() === 1 && !current());
    assert.deepEqual(readFileSync(join(resumed.target, 'data.json')), settings);
    assert.equal(readFileSync(join(resumed.target, 'fast-scan-index.json'), 'utf8'), index);
    console.log('PASS interrupted import resumes with verified files and preserves the existing copy');

    const existing = fixture();
    writeFileSync(join(existing.target, 'data.json'), 'installed settings');
    assert.equal(await existing.pause(), false);
    assert.equal(readFileSync(join(existing.target, 'data.json'), 'utf8'), 'installed settings');
    console.log('PASS subsequent activation leaves preexisting settings alone');

    const fromFork = fixture();
    const predecessor = join(fromFork.config, 'plugins', previous);
    mkdirSync(predecessor);
    const metadata = { ...sourceState, customExtra: { configured: true } };
    writeFileSync(join(predecessor, 'data.json'), JSON.stringify(metadata));
    const uuid = '55443322-abcd-1abc-9fff-012345678901';
    const folders = ['zip-transfer-packages', 'zip-imports/'+uuid, 'id-marker-conversions/'+uuid];
    for (const folder of folders) mkdirSync(join(predecessor, folder), {recursive:true});
    const deep = ['export-operation-journal.json.0','export-operation-journal.json.1',
        'zip-imports/pending.json','zip-imports/receipts.json','zip-imports/'+uuid+'/transaction.json',
        'zip-imports/'+uuid+'/0.before','zip-imports/'+uuid+'/0.after',
        'id-marker-conversions/'+uuid+'/Obsidian.zip','id-marker-conversions/'+uuid+'/conversion.json',
        'zip-transfer-packages/'+'b'.repeat(32)+'.json','zip-transfer-packages/archive-'+'c'.repeat(64)+'.json'];
    for (const [index, name] of deep.entries()) writeFileSync(join(predecessor, name), Buffer.from([0,255,index]));
    for (const name of ['manifest.json','main.js','styles.css','unrelated.txt']) writeFileSync(join(predecessor, name), 'do not copy');
    writeFileSync(join(predecessor,'rupos-migration-complete.json'), JSON.stringify({ version:1, mode:'copied' }));
    writeFileSync(join(predecessor,'rupos-migration-pending.json'), JSON.stringify({ member:'old upstream plan' }));
    assert.equal(await fromFork.pause(), true);
    assert.match(current().contentEl.textContent, /Source plugin folder: rupos-anki-toolkit/);
    click('Copy settings and state');
    await until(() => fromFork.starts() === 1 && !current());
    assert.deepEqual(JSON.parse(readFileSync(join(fromFork.target,'data.json'))),metadata);
    for (const name of deep) assert.deepEqual(readFileSync(join(fromFork.target,name)),readFileSync(join(predecessor,name)));
    for (const name of ['manifest.json','main.js','styles.css','unrelated.txt']) assert.equal(existsSync(join(fromFork.target,name)),false);
    assert.equal(JSON.parse(readFileSync(join(fromFork.target,'rupos-migration-complete.json'))).sourceId,previous);
    console.log('PASS previous fork wins over upstream; settings extras, operation journals, receipts, archive baselines and binary backups are retained');

    const partial = fixture();
    const old = join(partial.config,'plugins',previous); mkdirSync(old);
    const settingsBytes = JSON.stringify(metadata);
    writeFileSync(join(old,'data.json'),settingsBytes);
    writeFileSync(join(old,'export-operation-journal.json.0'),'op');
    writeFileSync(join(partial.target,'rupos-migration-pending.json'),JSON.stringify({version:2,sourceId:previous,
        files:[{path:'data.json',hash:digest(settingsBytes)},{path:'export-operation-journal.json.0',hash:digest('op')}]}));
    writeFileSync(join(partial.target,'data.json'),settingsBytes);
    assert.equal(await partial.pause(),true);click('Resume migration');
    await until(()=>partial.starts()===1&&!current());
    assert.equal(readFileSync(join(partial.target,'export-operation-journal.json.0'),'utf8'),'op');
    console.log('PASS resumed new checkpoint stays attached to the chosen fork even when upstream exists');

    const orphan = fixture();
    const dropped = join(orphan.config,'plugins',previous);mkdirSync(dropped);
    writeFileSync(join(dropped,'rupos-migration-pending.json'),'{}');
    assert.equal(await orphan.pause(),true);
    assert.match(notices.at(-1),/interrupted migration/i);
    assert.deepEqual(readdirSync(orphan.target),[]);
    console.log('PASS incomplete migration in the previous fork cannot silently fall back to upstream');

    const conflicted = fixture();
    writeFileSync(join(conflicted.target,'export-operation-journal.json.1'),'preserve');
    assert.equal(await conflicted.pause(),true);
    assert.deepEqual(readdirSync(conflicted.target),['export-operation-journal.json.1']);
    assert.equal(readFileSync(join(conflicted.target,'export-operation-journal.json.1'),'utf8'),'preserve');
    console.log('PASS existing destination journal outside the incoming plan is protected');

    const dual = fixture(false);
    dual.plugin.app.plugins={enabledPlugins:new Set([previous]),plugins:{}};
    assert.equal(await dual.pause(),true);
    assert.match(current().contentEl.textContent,/Disable/);
    assert.deepEqual(readdirSync(dual.target),[]);
    dual.plugin.app.plugins.enabledPlugins.clear();click('Check again');
    await until(()=>dual.starts()===1&&!current());
    console.log('PASS a live prior plugin blocks startup even when the configuration file has not been written yet');

    const misplaced=fixture(false);
    mkdirSync(misplaced.source);
    misplaced.plugin.manifest.dir='.obsidian/plugins/'+oldId;
    assert.equal(await misplaced.pause(),true);
    assert.match(notices.at(-1),/cannot be verified/);
    assert.deepEqual(readdirSync(misplaced.source),[]);
    console.log('PASS installing the new manifest in the former folder stops before writing');

    const cleanChoice=fixture();
    assert.equal(await cleanChoice.pause(),true);click('Use new settings');
    await until(()=>cleanChoice.starts()===1&&!current());
    assert.equal(JSON.parse(readFileSync(join(cleanChoice.target,'rupos-migration-complete.json'))).mode,'fresh');
    assert.equal(existsSync(join(cleanChoice.target,'data.json')),false);
    assert.equal(await cleanChoice.pause(),false);
    console.log('PASS explicitly choosing fresh settings skips copying and does not reopen migration on restart');

    const interruptedSource = fixture();
    writeFileSync(join(interruptedSource.target,'rupos-migration-pending.json'),JSON.stringify({version:2, sourceId:previous,
        files:[{path:'data.json',hash:digest(JSON.stringify(sourceState))}]}));
    assert.equal(await interruptedSource.pause(),true);
    assert.match(notices.at(-1),/selected source is missing/);
    assert.equal(existsSync(join(interruptedSource.target,'data.json')),false);
    console.log('PASS lost source of a partial transfer cannot be silently replaced by a different plugin');

    const forged = fixture();
    writeFileSync(join(forged.target,'rupos-migration-pending.json'),JSON.stringify({version:2, sourceId:oldId,
        files:[{path:'data.json',hash:digest(JSON.stringify(sourceState))},{path:'../escape',hash:digest('bad')}]}));
    assert.equal(await forged.pause(),true);
    assert.match(notices.at(-1),/checkpoint is damaged/);
    assert.deepEqual(readdirSync(forged.target),['rupos-migration-pending.json']);
    console.log('PASS a checkpoint path outside the allowed state files is rejected before copying');

    const fallback = fixture();
    const fsp = require('node:fs').promises;
    const originalLink = fsp.link;
    try {
        fsp.link = async () => { throw Object.assign(new Error('unsupported'),{code:'ENOTSUP'}); };
        assert.equal(await fallback.pause(),true);click('Copy settings and state');
        await until(()=>fallback.starts()===1&&!current());
        assert.deepEqual(readFileSync(join(fallback.source,'data.json')),readFileSync(join(fallback.target,'data.json')));
        console.log('PASS an unsupported hard-link operation falls back to verified exclusive copy');
    } finally { fsp.link = originalLink; }

    const halted = fixture();
    let intercepted = false;
    const originalCopyFile = fsp.copyFile;
    assert.equal(await halted.pause(),true);
    try {
        fsp.copyFile = async (...args) => {
            const result = await originalCopyFile(...args);
            if (!intercepted && args[0]===join(halted.source,'data.json')) { intercepted=true; halted.plugin.disposeMigration(); }
            return result;
        };
        click('Copy settings and state');
        await until(()=>intercepted&&!current());
        await until(()=>!readdirSync(halted.target).some(file=>file.includes('migration-stage-')));
        assert.equal(halted.starts(),0);
        assert.deepEqual(readdirSync(halted.target),['rupos-migration-pending.json']);
        console.log('PASS unloading during copy leaves a resumable checkpoint and does not publish unfinished state');
    } finally { fsp.copyFile = originalCopyFile; }
    assert.equal(await halted.pause(),true);click('Resume migration');await until(()=>halted.starts()===1&&!current());

    const withCards = fixture();
    let openedReview = false;
    assert.equal(await withCards.pause(() => { openedReview = true; }),true);
    const cardOption = current().contentEl.children.find(el => el.tag === 'label').children[0];
    assert.equal(openedReview, false);
    cardOption.checked = true; cardOption.onchange();
    click('Copy settings and state');
    await until(()=>openedReview && withCards.starts() === 1 && !current());
    assert.ok(existsSync(join(withCards.target,'data.json')));
    console.log('PASS optional card migration opens only after successful legacy settings import');

    const localized = fixture();
    writeFileSync(join(localized.source,'data.json'),JSON.stringify({...sourceState,settings:{...sourceState.settings,INTERFACE_LANGUAGE:'ru'}}));
    assert.equal(await localized.pause(),true);
    assert.match(current().contentEl.textContent,/Папка прежнего плагина/);click('Перенести настройки и данные');
    await until(()=>localized.starts()===1&&!current());
    console.log('PASS the migration preview uses a saved Russian language preference');

    const external = fixture();
    const unrelated = join(temporary, 'external.json');
    writeFileSync(unrelated, 'outside plugin');
    rmSync(join(external.source, 'data.json'));
    let symlinkSupported = true;
    try { symlinkSync(unrelated, join(external.source, 'data.json'), 'file'); }
    catch (error) {
        if (!['EPERM','EACCES','ENOTSUP'].includes(error.code)) throw error;
        symlinkSupported = false;
        console.log('SKIP source symbolic link: file system does not permit creating a symlink');
    }
    if (symlinkSupported) {
        assert.equal(await external.pause(), true);
        assert.match(notices.at(-1), /Could not verify plugin files/);
        assert.deepEqual(readdirSync(external.target), []);
        console.log('PASS symbolic link in old state stops migration without writes');
    }
} finally {
    console.error = previousError;
    rmSync(temporary, { recursive: true, force: true });
}
