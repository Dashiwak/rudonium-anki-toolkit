// SPDX-License-Identifier: GPL-3.0-only
// Exercise production review controllers with a small desktop host and isolated Anki data.
"use strict";
const assert = require("node:assert/strict");
const overlay = require("../Build/overlay-source.cjs");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const { SourceTextModule, SyntheticModule } = require("node:vm");
const { test } = require("node:test");
const english = text => text;

class Element {
    constructor(tag, options = {}) {
        this.tag = tag;
        this.text = options.text || "";
        this.children = [];
        this.style = {};
        this.ownerDocument = page;
        this.disabled = false;
        this.isConnected = true;
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(" "); }
    set textContent(text) { this.text = text; this.children = []; }
    append(...children) {
        for (const child of children) {
            if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
            child.parent = this;
            this.children.push(child);
        }
    }
    createEl(tag, options) { const el = new Element(tag, options); this.append(el); return el; }
    createSpan(options) { return this.createEl("span", options); }
    createDiv(options) { return this.createEl("div", options); }
    setText(text) { this.textContent = text; }
    focus() { this.ownerDocument.focused = this; }
    empty() { this.text = ""; this.children = []; }
    match(predicate) { return predicate(this) ? this : this.children.map(child => child.match(predicate)).find(Boolean); }
    button(label) { return this.match(el => el.tag === "button" && el.text === label); }
}
const page = {
    createDocumentFragment: () => new Element("fragment"),
    createElement: tag => new Element(tag),
    defaultView: { focus() {}, requestAnimationFrame: callback => callback() },
};
class TFile { constructor(path) { this.path = path; } }
class MarkdownView {
    containerEl = new Element("editor");
    editor = {
        lineCount: () => 2, getLine: line => line === 0 ? "Question :: Answer" : "<!--ID: 101-->",
        setSelection: (from, to) => { this.selection = { from, to }; }, scrollIntoView() {}, focus() {},
    };
    getMode() { return "source"; }
}
class Modal {
    constructor(app) {
        this.app = app;
        this.modalEl = new Element("modal");
        this.titleEl = this.modalEl.createDiv();
        this.contentEl = this.modalEl.createDiv();
    }
    open() { this.app.modal = this; this.onOpen?.(); }
    close() { this.app.modal = undefined; this.onClose?.(); }
}
class ItemView {
    constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = new Element("pane"); }
}
const notices = [];
class Notice {
    constructor(fragment, duration) { this.el = fragment; this.duration = duration; notices.push(this); }
    hide() { this.hidden = true; }
}

async function loadModules(search) {
    const names = ["obsidian-navigation", "export-review-ui", "sync-difference-ui", "audit-repair-ui"];
    const modules = new Map();
    const sourceTexts = new Map();
    for (const name of names) {
        const raw = readFileSync(overlay.file(name + ".ts"), "utf8");
        const code = stripTypeScriptTypes(raw, { mode: "transform" });
        sourceTexts.set("./" + name, code);
        modules.set("./" + name, new SourceTextModule(code));
    }
    const api = {
        Modal, ItemView, Notice, MarkdownView, TFile, uiFor: () => english, englishUi: english,
        installModalLayout() {}, setIcon(el, name) { el.icon = name; },
        exportCardIssueText: issue => "Missing ID " + issue.id, localizeExportError: text => String(text),
        readPendingAuditRepairs: async () => [], searchAuditRepairMatches: async () => search,
        sameFieldValue: (a, b) => a === b,
    };
    const imports = new Map([["./anki", new Set()]]);
    for (const source of sourceTexts.values()) {
        for (const [, bindings, path] of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
            if (modules.has(path)) continue;
            const keys = imports.get(path) || new Set();
            for (const key of bindings.split(",").map(k => k.trim()).filter(Boolean)) keys.add(key);
            imports.set(path, keys);
        }
    }
    for (const [path, names] of imports) {
        modules.set(path, new SyntheticModule([...names], function() {
            for (const key of names) this.setExport(key, api[key] ?? (() => { throw new Error("Unexpected host call: " + key); }));
        }));
    }
    for (const mod of modules.values()) {
        if (mod.status === "unlinked") await mod.link(path => { assert.ok(modules.has(path), path); return modules.get(path); });
        if (mod.status === "linked") await mod.evaluate();
    }
    return Object.fromEntries([...modules.entries()].filter(([id]) => sourceTexts.has(id)).map(([id, mod]) => [id, mod.namespace]));
}

function makeHost() {
    const file = new TFile("Test.md");
    const leaves = [];
    const setting = {
        containerEl: new Element("settings"), activeTab: { id: "rudonium-anki-toolkit", containerEl: new Element("tab") },
        close() { this.containerEl.isConnected = this.activeTab.containerEl.isConnected = false; },
        open() { this.containerEl.isConnected = this.activeTab.containerEl.isConnected = true; }, openTabById(id) { this.opened = id; },
    };
    const app = { vault: { getAbstractFileByPath: path => path === file.path ? file : null }, setting };
    let makeView;
    app.workspace = {
        getLeaf() {
            const view = new MarkdownView();
            const leaf = { view, openFile: async file => { view.file = file; }, getViewState: () => ({ state: { source: true } }) };
            leaves.push(leaf);
            return leaf;
        },
        getRightLeaf() {
            const leaf = {
                app, async setViewState() { this.view = makeView(this); await this.view.onOpen(); },
                detach() { this.detached = true; void this.view.onClose(); },
            };
            leaves.push(leaf);
            return leaf;
        },
        getLeavesOfType: type => leaves.filter(leaf => !leaf.detached && leaf.view?.getViewType?.() === type),
        revealLeaf: async () => {}, setActiveLeaf(leaf) { this.active = leaf; },
    };
    const plugin = { app, settings: {}, manifest: { id: setting.activeTab.id }, registerView(_, make) { makeView = make; }, register() {} };
    return { plugin, file, leaves };
}

test("missing-ID notice keeps the current record on Show, advances on Skip, and opens repair for the current deck, ID and source", async () => {
    global.document = page;
    const modules = await loadModules();
    const { plugin, leaves } = makeHost();
    modules["./obsidian-navigation"].registerRecordReview(plugin);
    const report = modules["./export-review-ui"];
    const cards = [101, 102, 103].map(id => ({ path: "Test.md", issue: { id, line: 2, code: "missing-id", deck: "D" + id } }));
    let repair;
    const show = () => report.showMissingAnkiCardNotice(plugin.app, cards, english, (deck, target) => { repair = { deck, ...target }; });
    const click = (notice, label) => notice.el.button(label).onclick({ stopPropagation() {} });
    show();
    const first = notices.at(-1);
    assert.equal(first.duration, 0);
    assert.match(first.el.textContent, /Missing ID 101/);
    assert.doesNotMatch(first.el.textContent, /102|103|Other missing/);
    await click(first, "Show Note");
    assert.equal(first.hidden, undefined);
    assert.deepEqual(leaves[0].view.selection.from, { line: 1, ch: 0 });
    assert.equal(plugin.app.setting.containerEl.isConnected, false);
    leaves[1].view.contentEl.button("Return to settings").onclick();
    assert.equal(plugin.app.setting.opened, "rudonium-anki-toolkit");
    await click(first, "Skip");
    assert.equal(first.hidden, true);
    const second = notices.at(-1);
    assert.match(second.el.textContent, /Missing ID 102/);
    assert.equal(second.el.button("Run Audit"), undefined);
    await click(second, "Review Repair");
    assert.deepEqual(repair, { deck: "D102", id: 102, path: "Test.md" });
    show();
    for (const id of [101, 102, 103]) {
        const current = notices.at(-1);
        assert.match(current.el.textContent, new RegExp("Missing ID " + id));
        await click(current, "Skip");
    }
    assert.equal(notices.at(-1).hidden, true);
});

test("a visible settings tab without a shell provides a return path and a hidden cached tab is ignored", async () => {
    const modules = await loadModules();
    const nav = modules["./obsidian-navigation"];
    const { plugin, file, leaves } = makeHost();
    const settings = plugin.app.setting;
    delete settings.containerEl;
    const tab = settings.activeTab.containerEl;
    let open = true, closes = 0;
    tab.getClientRects = () => open ? [{}] : [];
    settings.open = () => { open = true; };
    settings.close = () => { open = false; closes++; };
    nav.registerRecordReview(plugin);
    await nav.openObsidianFile(plugin.app, file.path);
    assert.equal(closes, 1);
    assert.ok(leaves[1].view.contentEl.button("Return to settings"));
    await nav.openObsidianFile(plugin.app, file.path);
    assert.equal(closes, 1);
    assert.equal(leaves.length, 2);
});

test("repair review docks with live state, keeps page content, and closes with its workspace tab", async () => {
    global.document = page;
    global.DOMParser = class { parseFromString(text) { return { body: { textContent: text } }; } };
    const { plugin, leaves } = makeHost();
    const row = id => ({
        id, source: { id, path: "Test.md", line: 1, endLine: 2, markerLine: 2, fields: { Front: "Question" }, firstField: "Question" },
        candidates: [],
    });
    const rows = [row(101), row(102)];
    rows[1].source.wholePage = true;
    const modules = await loadModules({ rows, deck: "D", profile: "P" });
    modules["./obsidian-navigation"].registerRecordReview(plugin);
    const result = { deck: "D", ankiProfile: { active: "P" }, obsidianOnly: [] };
    modules["./audit-repair-ui"].openAuditRepair(plugin, result, () => {}, 101);
    await new Promise(resolve => setImmediate(resolve));
    const modal = plugin.app.modal;
    const content = modal.contentEl;
    assert.ok(content.textContent.includes("Record 1 of 2"));
    assert.ok(content.textContent.includes("No match in Anki"));
    assert.equal(content.button("Delete Card in Anki"), undefined);
    assert.ok(content.button("Delete Card in Obsidian"));
    await content.button("Show Record in Obsidian").onclick();
    assert.equal(plugin.app.modal, undefined);
    const dock = modal.dock;
    assert.ok(dock.contentEl.children.includes(content));
    assert.equal(plugin.app.workspace.active, leaves[0]);
    content.button("Next").onclick();
    assert.ok(content.textContent.includes("Record 2 of 2"));
    assert.equal(content.button("Delete Card in Obsidian"), undefined);
    content.button("Select multiple").onclick();
    assert.equal(content.button("Delete Card in Obsidian"), undefined);
    content.button("Review one record").onclick();
    content.button("Previous").onclick();
    content.button("Delete Card in Obsidian").onclick();
    assert.ok(content.button("Confirm Action"));
    assert.ok(content.button("Back to Records"));
    content.button("Back to Records").onclick();
    await content.button("Show Record in Obsidian").onclick();
    assert.equal(leaves.length, 2);
    dock.leaf.detach();
    assert.equal(modal.dock, undefined);
    assert.equal(content.children.length, 0);
});
