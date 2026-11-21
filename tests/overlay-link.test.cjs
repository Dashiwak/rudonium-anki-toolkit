// SPDX-License-Identifier: GPL-3.0-only
// Links every fork module before evaluating any Obsidian or Anki code.
// Build/build-main.cjs separately type-checks the overlay against the pinned upstream.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const overlaySource = require("../Build/overlay-source.cjs");
const { stripTypeScriptTypes } = require("node:module");
const { test } = require("node:test");
const { SourceTextModule, SyntheticModule } = require("node:vm");

test("All desktop overlay modules link with their real local exports", async () => {
    const overlay = new Map();
    for (const name of overlaySource.names()) {
        const source = fs.readFileSync(overlaySource.file(name), "utf8");
        const identifier = "./" + name.slice(0, -3);
        overlay.set(identifier, new SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }), { identifier }));
    }
    // Only these dependencies come from the pinned repository or desktop host.
    const externals = {
        "./anki": [],
        "./constants": ["OBS_DISPLAY_CODE_REGEXP", "OBS_CODE_REGEXP", "OBS_DISPLAY_MATH_REGEXP", "OBS_INLINE_MATH_REGEXP"],
        "./file": ["AllFile"],
        "./files-manager": ["FileManager", "frontmatterTags", "mergeTags"],
        "./setting-to-data": ["settingToData"],
        "obsidian": ["ItemView", "MarkdownView", "Modal", "Notice", "Setting", "TFile", "TFolder",
            "editorInfoField", "parseLinktext", "parseYaml", "sanitizeHTMLToDom", "setIcon"],
        "ts-md5": ["Md5"],
        "fs": Object.keys(require("node:fs")),
        "path": Object.keys(require("node:path")),
    };
    const hosts = new Map(Object.entries(externals).map(([id, names]) => [id, new SyntheticModule(names, () => {}, { identifier: id })]));
    const resolveModule = (id, importer) => {
        const mod = overlay.get(id) || hosts.get(id);
        assert.ok(mod, importer.identifier + " imports an unknown module: " + id);
        return mod;
    };
    for (const mod of overlay.values()) {
        if (mod.status === "unlinked") await mod.link(resolveModule);
    }
    assert.ok(overlay.size > 0);
});
