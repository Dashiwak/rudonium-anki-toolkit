// SPDX-License-Identifier: GPL-3.0-only
// Links every fork module before evaluating any Obsidian or Anki code.
// Build/build-main.cjs separately type-checks the overlay against the pinned upstream.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const overlaySource = require("../Build/overlay-source.cjs");
const { isBuiltin, stripTypeScriptTypes } = require("node:module");
const { test } = require("node:test");
const { SourceTextModule, SyntheticModule } = require("node:vm");

test("All desktop overlay modules link with their real local exports", async () => {
    const overlay = new Map();
    const names = new Set(overlaySource.names());
    if (fs.existsSync(overlaySource.file("constants.ts"))) names.add("constants.ts");
    for (const name of names) {
        const source = fs.readFileSync(overlaySource.file(name), "utf8");
        const identifier = "./" + name.slice(0, -3);
        overlay.set(identifier, new SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }), { identifier }));
    }
    // Pin the boundary to the upstream renderer and desktop APIs.
    const externals = {
        "./anki": ["invoke"],
        "./constants": ["OBS_DISPLAY_CODE_REGEXP", "OBS_CODE_REGEXP", "OBS_DISPLAY_MATH_REGEXP", "OBS_INLINE_MATH_REGEXP", "escapeRegex"],
        "./file": ["AllFile"],
        "./files-manager": ["FileManager", "frontmatterTags", "mergeTags"],
        "./setting-to-data": ["settingToData"],
        "obsidian": ["App", "FuzzySuggestModal", "ItemView", "MarkdownView", "Modal", "Notice",
            "Setting", "TFile", "TFolder", "editorInfoField", "editorLivePreviewField",
            "parseLinktext", "parseYaml", "sanitizeHTMLToDom", "setIcon"],
        "@codemirror/language": ["syntaxTree", "syntaxTreeAvailable"],
        "@codemirror/state": ["Prec", "StateEffect"],
        "@codemirror/view": ["Decoration", "EditorView", "ViewPlugin", "WidgetType"],
        "ts-md5": ["Md5"],
        "marked": ["Marked", "Renderer"],
        "highlight.js": ["default"],
    };
    const hosts = new Map(Object.entries(externals).map(([id, names]) => [id, new SyntheticModule(names, () => {}, { identifier: id })]));
    const resolveModule = (id, importer) => {
        if (isBuiltin(id) && !hosts.has(id)) {
            hosts.set(id, new SyntheticModule(Object.keys(require(id)), () => {}, { identifier: id }));
        }
        const mod = overlay.get(id) || hosts.get(id);
        assert.ok(mod, importer.identifier + " imports an unknown module: " + id);
        return mod;
    };
    for (const mod of overlay.values()) {
        if (mod.status === "unlinked") await mod.link(resolveModule);
    }
    assert.ok(overlay.size > 0);
});
