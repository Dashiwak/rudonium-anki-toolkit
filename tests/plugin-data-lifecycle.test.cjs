// SPDX-License-Identifier: GPL-3.0-only
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { test } = require("node:test");

async function loadPlugin(host = {}) {
    const notices = [], errors = [];
    const context = vm.createContext({ console: { log() {}, error(...args) { errors.push(args); } } });
    const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, "../main.ts"), "utf8"), { mode: "transform" });
    const entry = new vm.SourceTextModule(source, { context });
    const {load} = require("./benchmark/migration-modules.cjs");
    const { "sync-profiles": profiles } = await load(["sync-profiles"], {});
    const supplied = {
        ...host,
        importLegacyScanScope: profiles.importLegacyScanScope,
        Plugin: class {},
        Notice: class { constructor(message) { notices.push(message); } },
        uiFor: () => (_en, ru) => ru,
    };
    await entry.link(id => {
        if (id === "multimatch")
            return new vm.SyntheticModule(["default"], function () { this.setExport("default", () => { throw Error("unexpected scan"); }); }, {context});
        const names = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)]
            .filter(match => match[2] === id).flatMap(match => match[1].split(",").map(name => name.trim()));
        return new vm.SyntheticModule(names, function () {
            for (const name of names) this.setExport(name, supplied[name]);
        }, { context });
    });
    await entry.evaluate();
    const plugin = new entry.namespace.default();
    return { plugin, errors, notices };
}

test("startup waits for migration and a disabled plugin cannot register late commands", async () => {
    let finishMigration;
    const pending = new Promise(resolve => { finishMigration = resolve; });
    const { plugin, notices, errors } = await loadPlugin({ pauseForMigration: () => pending });
    let initialized = 0;
    plugin.initializeRudonium = async () => { initialized++; };
    assert.equal(plugin.onload(), undefined);
    assert.equal(initialized, 0);
    plugin.onunload();
    finishMigration(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(initialized, 0);
    assert.deepEqual(notices, []);
    assert.deepEqual(errors, []);
});

test("startup displays a migration error once and supports migration-free initialization", async () => {
    const error = new Error("settings could not be migrated");
    const failed = await loadPlugin({ pauseForMigration: async () => { throw error; } });
    failed.plugin.onload();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed.errors.length, 1);
    assert.equal(failed.errors[0][1], error);
    assert.deepEqual(failed.notices, ["Не удалось запустить Rudonium. Подробности в консоли."]);

    const ready = await loadPlugin({ pauseForMigration: async () => false });
    let initialized = 0;
    ready.plugin.initializeRudonium = async () => { initialized++; };
    ready.plugin.onload();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(initialized, 1);
    assert.deepEqual(ready.errors, []);
});

test("default settings wait for storage, and shutdown reports a failed queued write", async () => {
    const { plugin, errors, notices } = await loadPlugin();
    let accept, completed = false;
    const write = new Promise(resolve => { accept = resolve; });
    plugin.saveData = async data => {
        assert.deepEqual(Object.keys(data).sort(), ["Added Media", "File Hashes", "fields_dict", "settings"]);
        assert.equal(data.settings.BIDIRECTIONAL_SYNC, false);
        assert.equal(data.settings.BIDIRECTIONAL_PREVIEW, false);
        assert.equal(data.settings.BIDIRECTIONAL_CONFLICT_POLICY, "latest");
        await write;
    };
    const result = plugin.saveDefault().then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    accept();
    await result;
    assert.equal(completed, true);

    plugin.rudoniumInitialized = true;
    const failure = new Error("storage unavailable");
    plugin.saveAllData = async () => { throw failure; };
    await plugin.onunload();
    assert.equal(plugin.rudoniumStopped, true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], failure);
    assert.deepEqual(notices, ["Не удалось сохранить настройки Rudonium."]);
});

test("startup reads one consistent legacy snapshot and preserves newer settings and cache keys", async () => {
    const { plugin } = await loadPlugin();
    const snapshot = {
        settings: { CUSTOM_REGEXPS: {Basic: "@page"}, Defaults: {Tag: null, Deck: "A::B", "Scan Directory": "old"},
            Syntax: {"Begin Note": "BEGIN"}, FOLDER_TAGS: {Cards: "Mine"}, INTERFACE_LANGUAGE: "ru",
            CUSTOM_NEW_KEY: {version: 8}, BIDIRECTIONAL_SYNC: true, IGNORED_FILE_GLOBS: ["*.tmp"] },
        fields_dict: {Basic: ["Front", "Back"]}, "Added Media": ["clip.mp3"], "File Hashes": {"Cards.md": "abc"},
        "third-party": {enabled: true},
    };
    let reads = 0;
    plugin.loadData = async () => { reads++; return snapshot; };
    plugin.saveData = async () => { throw new Error("unexpected write"); };
    const settings = await plugin.loadSettings();
    assert.equal(reads, 1);
    assert.equal(settings.Defaults.Deck, "A::B");
    assert.equal(settings.Defaults.Tag, "");
    assert.equal(settings.Defaults["Scan Directory"], undefined);
    assert.equal(settings.IGNORED_FILE_GLOBS, undefined);
    assert.deepEqual([...settings.LEGACY_IGNORED_FILE_GLOBS], ["*.tmp"]);
    assert.equal(settings.ACTIVE_SYNC_FOLDER_PROFILE, settings.SYNC_FOLDER_PROFILES[0].id);
    assert.deepEqual([...settings.SYNC_FOLDER_PROFILES[0].folders], ["old"]);
    assert.equal(settings.Syntax["Begin Note"], "BEGIN");
    assert.equal(settings.Syntax["End Note"], "END");
    assert.equal(settings.BIDIRECTIONAL_SYNC, true);
    assert.equal(settings.BIDIRECTIONAL_PREVIEW, false);
    assert.equal(settings.BIDIRECTIONAL_CONFLICT_POLICY, "latest");
    assert.deepEqual(settings.CUSTOM_NEW_KEY, {version: 8});
    assert.equal(plugin.fields_dict, snapshot.fields_dict);
    assert.equal(plugin.added_media, snapshot["Added Media"]);
    assert.equal(plugin.file_hashes, snapshot["File Hashes"]);
    assert.equal(plugin.rudoniumDataExtras["third-party"], snapshot["third-party"]);
    plugin.loadData = async () => ({...snapshot, settings: {...snapshot.settings, BIDIRECTIONAL_CONFLICT_POLICY: "skip"}});
    assert.equal((await plugin.loadSettings()).BIDIRECTIONAL_CONFLICT_POLICY, "skip");
    for (const bad of [
        {...snapshot, "Added Media": [7]}, {...snapshot, "File Hashes": {bad: null}},
        {...snapshot, fields_dict: {Basic: [null]}}, {...snapshot, settings: {...snapshot.settings, BIDIRECTIONAL_SYNC: "false"}},
        {...snapshot, settings: {...snapshot.settings, CUSTOM_REGEXPS: {Basic: {}}}},
    ]) {
        plugin.loadData = async () => bad;
        await assert.rejects(plugin.loadSettings(), {name: "InvalidRudoniumPluginData"});
    }
});

test("block and regexp notes preserve custom field order, optional captures and separate mutable templates", async () => {
    const { load } = require("./benchmark/migration-modules.cjs");
    const { note: { Note, RegexNote, InlineNote, NOTE_TYPE_ERROR } } = await load(["note"], {});
    const formatter = {format: value => value, format_note_with_url(note, url, key) { note.fields[key] += url; }};
    const fields = { hasOwnProperty: ["Frage", "Antwort", "Quelle"] };
    const template = {deckName: "Default", modelName: "", fields: {}, options: {allowDuplicate: false, duplicateScope: "deck"}, tags: ["default"]};
    const data = { template, file_link_fields: {hasOwnProperty: "Quelle"}, context_fields: {}, add_obs_tags: false };
    const block = new Note("hasOwnProperty\nFrage: Bahn?\nAntwort: Bahnhof", fields, false, false, formatter);
    const result = block.parse("A::B", "file", {}, data, "");
    assert.equal(result.note.fields.Antwort, "Bahnhof");
    assert.equal(result.note.fields.Quelle, "file");
    result.note.tags.push("extra");
    result.note.options.allowDuplicate = true;
    const rx = new RegexNote(["full", "Bahn?", undefined, "link", "unused"], "hasOwnProperty", fields,
        false, false, false, false, formatter);
    const next = rx.parse("A::B", "", {}, data, "").note;
    assert.deepEqual(Object.keys(next.fields), fields.hasOwnProperty);
    assert.equal(next.fields.Antwort, "");
    assert.equal(next.fields.Quelle, "link");
    assert.deepEqual([...next.tags], ["default"]);
    assert.equal(next.options.allowDuplicate, false);
    assert.deepEqual(template.fields, {});
    const malformed = new InlineNote("Question without model", fields, false, false, formatter);
    assert.equal(malformed.parse("Default", "", {}, data, "").identifier, NOTE_TYPE_ERROR);
});


test("imported upstream export scope applies to vault sync and individual paths", async () => {
    class TFolder {}
    const {load} = require("./benchmark/migration-modules.cjs");
    const { "sync-profiles": scope } = await load(["sync-profiles"], {TFolder});
    const dir = new TFolder();
    const settings = { IGNORED_FILE_GLOBS: ["**/*.excalidraw.md"] };
    scope.importLegacyScanScope(settings, {"Scan Directory": "Cards"});
    const files = ["Cards/A.md","Cards/Deep/B.md","Cards/P.excalidraw.md","Other/C.md"].map(path => ({path}));
    const plugin = { settings, app: {vault: {getMarkdownFiles: () => files, getAbstractFileByPath: path => path === "Cards" ? dir : null}},
        matchIgnoredPaths(paths, patterns) {
            assert.deepEqual([...patterns], ["**/*.excalidraw.md"]);
            return paths.filter(path => path.endsWith(".excalidraw.md"));
        } };
    const resolved = scope.resolveSyncScope(plugin);
    assert.deepEqual([...resolved.paths], files.slice(0,2).map(file => file.path));
    for (const file of files) assert.equal(scope.describeSyncPath(plugin, file.path).included, resolved.contains(file.path));
    assert.equal(resolved.excludes("Cards/P.excalidraw.md"), true);
    const original = resolved.signature;
    settings.LEGACY_IGNORED_FILE_GLOBS = [];
    assert.notEqual(scope.syncScopeSignature(settings), original);
    assert.equal(scope.describeSyncPath(plugin, "Cards/P.excalidraw.md").included, true);
    plugin.app.vault.getAbstractFileByPath = () => null;
    assert.throws(() => scope.resolveSyncScope(plugin), /missing folders/);
});

test("the preview action limits export to the selected file and cursor target", async () => {
    const calls = [];
    const { plugin } = await loadPlugin({ previewVaultExport: async (...args) => { calls.push(args); } });
    const target = { id: 19, configuration: "selected card" };
    await plugin.previewCursorExport("Cards/Selected.md", target);
    assert.equal(calls.length, 1);
    const [owner, auditScope, paths, card] = calls[0];
    assert.equal(owner, plugin);
    assert.equal(auditScope, undefined);
    assert.deepEqual([...paths], ["Cards/Selected.md"]);
    assert.equal(card, target);
});
