// SPDX-License-Identifier: GPL-3.0-only
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { test } = require("node:test");

test("default settings wait for storage, and shutdown reports a failed queued write", async () => {
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
