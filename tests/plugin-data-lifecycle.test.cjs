// SPDX-License-Identifier: GPL-3.0-only
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { test } = require("node:test");

async function loadPlugin() {
    const notices = [], errors = [];
    const context = vm.createContext({ console: { log() {}, error(...args) { errors.push(args); } } });
    const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, "../main.ts"), "utf8"), { mode: "transform" });
    const entry = new vm.SourceTextModule(source, { context });
    const supplied = {
        Plugin: class {},
        Notice: class { constructor(message) { notices.push(message); } },
        uiFor: () => (_en, ru) => ru,
    };
    await entry.link(id => {
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

test("default settings wait for storage, and shutdown reports a failed queued write", async () => {
    const { plugin, errors, notices } = await loadPlugin();
    let accept, completed = false;
    const write = new Promise(resolve => { accept = resolve; });
    plugin.saveData = async data => {
        assert.deepEqual(Object.keys(data).sort(), ["Added Media", "File Hashes", "fields_dict", "settings"]);
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
    assert.equal(settings.Syntax["Begin Note"], "BEGIN");
    assert.equal(settings.Syntax["End Note"], "END");
    assert.equal(settings.BIDIRECTIONAL_SYNC, true);
    assert.equal(settings.BIDIRECTIONAL_PREVIEW, false);
    assert.deepEqual(settings.CUSTOM_NEW_KEY, {version: 8});
    assert.equal(plugin.fields_dict, snapshot.fields_dict);
    assert.equal(plugin.added_media, snapshot["Added Media"]);
    assert.equal(plugin.file_hashes, snapshot["File Hashes"]);
    assert.equal(plugin.rudoniumDataExtras["third-party"], snapshot["third-party"]);
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
