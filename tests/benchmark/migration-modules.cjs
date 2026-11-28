// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const fs = require("node:fs");
const { isBuiltin, stripTypeScriptTypes } = require("node:module");
const vm = require("node:vm");
const overlay = require("../../Build/overlay-source.cjs");

async function load(names, api, generated = {}, globals = {}) {
    const context = vm.createContext({ require, process, Buffer, performance, URL, structuredClone, TextEncoder, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, window: { setTimeout, clearTimeout, setInterval, clearInterval }, ...globals });
    const modules = new Map(), imports = new Map();
    const needed = new Set(names);
    for (const name of needed) {
        const raw = Object.hasOwn(generated, name) ? generated[name] : fs.readFileSync(overlay.file(name + ".ts"), "utf8");
        const source = stripTypeScriptTypes(raw, { mode: "transform" });
        modules.set("./" + name, new vm.SourceTextModule(source, { context }));
        for (const [, bindings, id] of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
            if (id === "./desktop-io" || id === "./block-field-tags") needed.add(id.slice(2));
            if (id === "./sync-change-history" || id === "./sync-outcome") needed.add(id.slice(2));
            if (id === "./card-format-presets") needed.add("card-format-presets");
            if (name === "bidirectional-markdown" && id === "./markdown-pipeline") needed.add("markdown-pipeline");
            if (id === "./legacy-field-sections" || id === "./id-marker-literals" || id === "./page-named-fields" || id === "./page-id-location" || id === "./page-frontmatter" || id === "./suspend-label" || id === "./suspend-marker" || id === "./archived-card" || id === "./delimited-rule" || id === "./bidirectional-fields") needed.add(id.slice(2));
            if (name === "archived-card") {
                for (const dependency of ["anki-id-marker", "id-marker-literals", "markdown-pipeline"]) needed.add(dependency);
            }
            if (name === "suspend-marker") {
                for (const dependency of ["duplicate-markers", "anki-id-marker", "id-marker-literals"]) needed.add(dependency);
            }
            if (isBuiltin(id)) continue;
            const keys = imports.get(id) || new Set();
            for (const key of bindings.split(",").map(v => v.trim()).filter(Boolean)) keys.add(key);
            imports.set(id, keys);
        }
    }
    for (const source of modules.values()) {
        for (const id of source.dependencySpecifiers || []) {
            if (!isBuiltin(id) || modules.has(id)) continue;
            const builtin = require(id);
            const keys = Object.keys(builtin);
            modules.set(id, new vm.SyntheticModule(keys, function () {
                for (const key of keys) this.setExport(key, builtin[key]);
            }, { context }));
        }
    }
    for (const [id, keys] of imports) if (!modules.has(id)) {
        modules.set(id, new vm.SyntheticModule([...keys], function () {
            for (const key of keys) this.setExport(key, api[key] ?? (() => { throw Error("Unexpected call " + key); }));
        }, { context }));
    }
    for (const mod of modules.values()) {
        if (mod.status === "unlinked") await mod.link(id => { if (!modules.has(id)) throw Error("Missing migration fixture module " + id); return modules.get(id); });
        if (mod.status === "linked") await mod.evaluate();
    }
    return Object.fromEntries(names.map(name => [name, modules.get("./" + name).namespace]));
}
module.exports = { load };
