// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const createClassList = require('./dom-class-list.cjs');
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./benchmark/migration-modules.cjs");
const { setImmediate: settle } = require("node:timers/promises");
const t = en => en;
const names = ["frozen-fields", "migration-markdown", "card-format-presets", "export-recovery", "duplicate-markers", "page-card", "archived-card", "id-marker-literals", "anki-id-marker", "markdown-pipeline"];
const modules = load(names, {});
const normal = /^FROZEN - (.+?):\r?\n([\s\S]*?)(?:\r?\n\r?\n|(?![\s\S]))/gm;
const schema = ["Front", "Back", "Source", "Источник [книга]"];
const apply = (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);

function change(plan, field, value) {
    const fields = new Map(plan.values);
    if (value) fields.set(field, value);
    else fields.delete(field);
    return plan.replaceAll([...fields]);
}

test("preview, add, replace and remove exact fields with a custom literal marker and CRLF YAML", async () => {
    const { prepareFrozenFields } = (await modules)["frozen-fields"];
    const pattern = /^\[Общее\]\* - (.+?):\r?\n([\s\S]*?)(?:\r?\n\r?\n|(?![\s\S]))/gm;
    const prepare = text => prepareFrozenFields(text, "[Общее]*", "My model", schema, pattern, t);
    const original = "\ufeff---\r\ntags: [history]\r\n---\r\n# Chapter\r\nA note.";
    const edit = change(prepare(original), "Источник [книга]", "Book A: §2");
    assert.equal(edit.preview, "[Общее]* - My model:\r\nИсточник [книга]: Book A: §2");
    prepare(original).verify(edit);
    const text = apply(original, edit);
    assert.match(text, /^\ufeff---\r\ntags: \[history\]\r\n---\r\n\r\n\[Общее\]/);
    assert.ok(text.endsWith("\r\n\r\n# Chapter\r\nA note."));
    const existing = prepare(text);
    assert.equal(existing.values.get("Источник [книга]"), "Book A: §2");
    assert.equal(change(existing, "Источник [книга]", "Book A: §2"), undefined);
    const two = apply(text, change(existing, "Back", "NB"));
    const revised = apply(two, change(prepare(two), "Источник [книга]", "Book B"));
    assert.match(revised, /Источник \[книга\]: Book B\r\nBack: NB/);
    const one = apply(revised, change(prepare(revised), "Back", ""));
    assert.ok(one.includes("Book B"));
    assert.doesNotMatch(one, /Back:/);
    const removal = change(prepare(one), "Источник [книга]", "");
    prepare(one).verify(removal);
    const removed = apply(one, removal);
    assert.doesNotMatch(removed, /\[Общее\]/);
    assert.equal(apply(removed, change(prepare(removed), "Источник [книга]", "Book A: §2")), text);
});
test("no ambiguous edit and no inserted value that changes field boundaries", async () => {
    const { prepareFrozenFields } = (await modules)["frozen-fields"];
    const block = "FROZEN - Basic:\nSource: Lecture\n\n";
    const prepare = text => prepareFrozenFields(text, "FROZEN", "Basic", schema, normal, t);
    for (const text of ["---\ntags: open", block + block,
        "```md\n" + block + "```", "<!--\n" + block + "-->", "FROZEN - Basic:\nSource: a\nline two\n\n",
        "FROZEN - Basic:\nUnknown: a\n\n", "FROZEN - Basic:\nSource: a\nSource: b\n\n"]) {
        assert.throws(() => prepare(text));
    }
    const bom = "\ufeffbody";
    const insert = change(prepare(bom), "Back", "x");
    prepare(bom).verify(insert);
    assert.match(apply(bom, insert), /^\ufeff\nFROZEN/);
    const withOther = "FROZEN - Cloze:\nText: abc\n\n" + block + "Other text";
    const plan = prepare(withOther);
    assert.throws(() => change(plan, "Front", "x\nBack: changed"));
    assert.throws(() => change(plan, "Another field", "x"));
    assert.equal(apply(withOther, change(plan, "Source", "Book A")), withOther.replace("Lecture", "Book A"));
    const mismatch = prepareFrozenFields("", "FROZEN", "Basic", schema, /UNRELATED (.*)\n(.*)/g, t);
    assert.throws(() => change(mismatch, "Back", "x"));
});

test("multi-field edit validates all changes together and preserves unchanged original lines and unrelated blocks", async () => {
    const { prepareFrozenFields } = (await modules)["frozen-fields"];
    const before = "FROZEN - Cloze:\r\nText:  Keep\r\n\r\nFROZEN - Basic:\r\nSource:old  \r\nBack:keep verbatim  \r\n\r\nbody";
    const plan = prepareFrozenFields(before, "FROZEN", "Basic", schema, normal, t);
    assert.throws(() => plan.replaceAll([["Source","Old"],["Source","New"]]));
    assert.throws(() => plan.replaceAll([["Source",""]]));
    assert.throws(() => plan.replaceAll([["Source","New"],["missing","other"]]));
    assert.equal(plan.replaceAll([...plan.values]), undefined);
    const edit = plan.replaceAll([["Source","Library"],["Back","keep verbatim  "],["Front","Context"]]);
    plan.verify(edit);
    assert.equal(apply(before, edit), before.replace("Source:old  ", "Source: Library").replace("Back:keep verbatim  ", "Back:keep verbatim  \r\nFront: Context"));
    const clear = plan.replaceAll([]);
    plan.verify(clear);
    assert.equal(apply(before, clear), "FROZEN - Cloze:\r\nText:  Keep\r\n\r\nbody");
});

test("archived examples are excluded from shared fields, mixed live blocks preserve archived bytes, and archived pages stay untouched", async () => {
    const loaded = await modules;
    const { wrapArchivedCard } = loaded["archived-card"];
    const prepare = text => loaded["frozen-fields"].prepareFrozenFields(text, "FROZEN", "Basic", schema, normal, t);
    for (const style of ["mark", "hidden", "strike"]) {
        const archive = wrapArchivedCard("START\r\nBasic\r\nFront: old\r\nBack: example\r\n\r\nFROZEN - Basic:\r\nSource: Never export\r\n\r\n<!--ID: 40-->\r\nEND", 40, "Deleted from Anki", false, "\r\n", style);
        const yaml = "\ufeff---\r\ntags: [notes]\r\n---\r\n";
        const mixed = yaml + archive + "\r\n\r\nFROZEN - Basic:\r\nBack: Live\r\n\r\n# Study";
        const live = prepare(mixed);
        assert.equal(live.values.size, 1); assert.equal(live.values.get("Back"), "Live");
        const updated = live.replaceAll([["Back","Revised"],["Source","Lecture"]]);
        live.verify(updated);
        assert.equal(apply(mixed, updated), mixed.replace("Back: Live", "Back: Revised\r\nSource: Lecture"));
        const onlyArchivedExample = yaml + archive;
        const newPlan = prepare(onlyArchivedExample);
        const fresh = newPlan.replaceAll([["Source","New"]]);
        newPlan.verify(fresh);
        assert.ok(apply(onlyArchivedExample, fresh).endsWith(archive));
        const archivedPage = wrapArchivedCard(yaml + "# Question #anki-page\r\n<!--ID: 41-->\r\nAnswer", 41, "Удалено из Anki", true, "\r\n", style);
        assert.throws(() => prepare(archivedPage), /page card is archived/);
    }
});

class Element {
    constructor(tag, opts = {}) { this.tag = tag; this.children = []; this.value = opts.value || ""; this.text = opts.text; this.classList = createClassList(); }
    setText(text) { this.text = text; }
    addClass() {}
    focus() {}
    empty() { this.children = []; this.value = ""; }
    createDiv() { return this.createEl("div"); }
    createEl(tag, opts) {
        const el = new Element(tag, opts);
        this.children.push(el);
        if (this.tag === "select" && tag === "option" && this.children.length === 1) this.value = el.value;
        return el;
    }
    find(tag) { return [this, ...this.children.flatMap(el => el.all())].filter(el => el.tag === tag); }
    all() { return [this, ...this.children.flatMap(el => el.all())]; }
}
test("settings targets the current Markdown editor; previews, detects changed buffers, and applies a single undoable edit", async () => {
    let modal, buffer = "A", writes = 0, active = null;
    const notices = [], file = { path: "chapter.md" }, commands = [];
    class MarkdownView {}
    const view = Object.assign(new MarkdownView(), { file, getMode: () => "source", editor: {
        getValue: () => buffer, offsetToPos: n => n, replaceRange: (value, a, b) => { writes++; buffer = buffer.slice(0, a) + value + buffer.slice(b); },
    } });
    class Modal {
        constructor() { modal = this; this.contentEl = new Element("main"); this.titleEl = new Element("h2"); }
        open() {} close() { this.closed = true; }
    }
    const api = { MarkdownView, Modal, Notice: class { constructor(msg) { notices.push(msg); } }, uiFor: () => t,
        settingToData: async () => ({ FROZEN_REGEXP: normal }) };
    const loaded = await load([...names, "frozen-fields-ui"], api);
    const plugin = { app: { workspace: { getActiveViewOfType: () => active, getActiveFile: () => file, getLeavesOfType: () => [{ view }] } },
        settings: { Syntax: { "Frozen Fields Line": "FROZEN" } }, fields_dict: { Basic: schema }, addCommand: c => commands.push(c) };
    loaded["frozen-fields-ui"].registerFrozenFieldsCommand(plugin);
    const open = async () => { commands[0].callback(); await settle(); return modal.contentEl; };
    const input = async content => {
        const [, field] = content.find("select");
        field.value = "Source"; field.onchange();
        const [value] = content.find("input"); value.value = "Handbook"; value.oninput();
        assert.equal(content.find("pre")[0].text, "FROZEN - Basic:\nSource: Handbook");
        return content.find("button").find(button => button.text === "Save in note");
    };
    const first = await open(), button = await input(first);
    assert.equal(writes, 0);
    buffer = "Other changes";
    button.onclick();
    assert.equal(writes, 0); assert.equal(button.disabled, true);
    const second = await open();
    (await input(second)).onclick();
    assert.equal(writes, 1); assert.equal(buffer, "FROZEN - Basic:\nSource: Handbook\n\nOther changes");
    const buttonByText = (node, label) => node.find("button").find(button => button.text === label);
    buffer = "FROZEN - Basic:\nSource: Handbook\nBack:  Chapter 1  \n\nBody";
    const baseline = buffer;
    const multi = await open();
    assert.deepEqual(multi.find("select").slice(1).map(field => field.value), ["Source", "Back"]);
    assert.deepEqual(multi.find("input").map(input => input.value), ["Handbook", " Chapter 1  "]);
    assert.equal(multi.find("pre")[0].text, baseline.split("\n\n")[0]);
    buttonByText(multi, "+ Add field").onclick();
    assert.deepEqual(multi.find("select").at(-1).children.map(o => o.value), ["Front", "Источник [книга]"]);
    const newField = multi.find("select").at(-1);
    newField.value = "Источник [книга]"; newField.onchange();
    const inputs = multi.find("input");
    inputs[0].value = "Atlas"; inputs[0].oninput();
    assert.equal(buttonByText(multi, "Save in note").disabled, true, "an unfinished extra row cannot be saved");
    inputs[2].value = "Bibliothek"; inputs[2].oninput();
    assert.equal(writes, 1);
    assert.equal(multi.find("pre")[0].text, "FROZEN - Basic:\nSource: Atlas\nBack:  Chapter 1  \nИсточник [книга]: Bibliothek");
    buttonByText(multi, "Save in note").onclick();
    assert.equal(writes, 2);
    assert.equal(buffer, "FROZEN - Basic:\nSource: Atlas\nBack:  Chapter 1  \nИсточник [книга]: Bibliothek\n\nBody");
    const saved = buffer;
    const last = await open();
    for (let i = 0; i < 3; i++) buttonByText(last, "Remove field").onclick();
    assert.equal(buffer, saved);
    assert.ok(buttonByText(last, "Remove block"));
    buttonByText(last, "Cancel").onclick();
    assert.equal(buffer, saved);
    assert.equal(writes, 2);
    const changedSchema = await open();
    const old = changedSchema.find("input")[0];
    old.value = "New book"; old.oninput();
    schema.push("New field");
    buttonByText(changedSchema, "Save in note").onclick();
    schema.pop();
    assert.equal(buffer, saved); assert.equal(writes, 2);
    const removeAll = await open();
    while (buttonByText(removeAll, "Remove field")) buttonByText(removeAll, "Remove field").onclick();
    buttonByText(removeAll, "Remove block").onclick();
    assert.equal(writes, 3); assert.equal(buffer, "Body");
    plugin.settings.CUSTOM_REGEXPS = { Basic: "@page" };
    plugin.settings.Syntax["Frozen Fields Line"] = "[Общее]*";
    buffer = "# Question #anki-page\r\n<!--ID: 20 -->\r\nAnswer\r\n<!--rudonium-answer-end-->\r\nPrivate";
    const pageUI = await open();
    const selectors = pageUI.find("select");
    assert.deepEqual(selectors[1].find("option").map(o => o.value), ["Source"]);
    pageUI.find("input")[0].value = "Vienna";
    pageUI.find("input")[0].oninput();
    assert.equal(pageUI.find("pre")[0].text, "[Общее]* - Basic:\r\nSource: Vienna");
    buttonByText(pageUI, "Save in note").onclick();
    assert.equal(buffer, "# Question #anki-page\r\n<!--ID: 20 -->\r\n[Общее]* - Basic:\r\nSource: Vienna\r\n\r\nAnswer\r\n<!--rudonium-answer-end-->\r\nPrivate");
    const unfreeze = await open();
    buttonByText(unfreeze, "Remove field").onclick();
    buttonByText(unfreeze, "Remove block").onclick();
    assert.equal(buffer, "# Question #anki-page\r\n<!--ID: 20 -->\r\nAnswer\r\n<!--rudonium-answer-end-->\r\nPrivate");
    assert.equal(writes, 5);
    active = Object.assign(new MarkdownView(), { file, getMode: () => "preview" });
    await open();
    assert.match(notices[0], /editing mode/); assert.equal(writes, 5);
});

test("the real two-way field mapper excludes composed Front/Back and keeps a shared suffix out of an explicit extra field", async () => {
    const { readFileSync } = require("node:fs");
    const overlay = require("../Build/overlay-source.cjs");
    const bidirectional = readFileSync(overlay.file("bidirectional-sync.ts"), "utf8") + "\nexport { readLocalCard }\n";
    const production = await load(["anki", "bidirectional-sync", "bidirectional-markdown", "card-format-presets"], {
        mergeTags: (...groups) => groups.flat(), normalizeSyncTags: tags => tags, portableCardExportRule: () => undefined,
    }, { anki: "", "bidirectional-sync": bidirectional });
    const block = { id: 42, model: "Basic", front: "Question", back: "Answer", end: 0,
        explicitFields: new Map([["Front", {}], ["Back", {}], ["Source", {}]]), extra: { Source: "Chapter" } };
    const fields = { Front: "Question", Back: "Answer", Source: "Chapter" };
    const read = patch => production["bidirectional-sync"].readLocalCard("", block,
        { modelName: "Basic", fields: { ...fields, ...patch }, tags: [] }, [], []);
    assert.equal(read({}).verifiedExtras.has("Source"), true);
    assert.equal(read({ Front: "Question + shared" }), undefined);
    assert.equal(read({ Back: "Answer + shared" }), undefined);
    const guarded = read({ Source: "Chapter + shared" });
    assert.equal(guarded.verifiedExtras.has("Source"), false);
    assert.equal(guarded.obsidian.front, "Question");
});

test("page field boundaries require a blank line, known optional name and only one owner", async () => {
    const api = await modules;
    const page = api['page-card'];
    const head = "# Question #anki-page\nID: 213\n";
    const read = source => page.readPageCard(head + source, {Basic:"@page"});
    const frozen = val => "FROZEN - Basic:\nSource: " + val + "\n\nAnswer";
    const config = {addFile:false, addContext:false};
    assert.throws(() => read("FROZEN - Basic:\nSource: Value\nAnswer"), /blank line/);
    assert.throws(() => read("FROZEN - Other:\nSource: Value\n\nAnswer"), /note type/);
    assert.throws(() => page.pageExportFieldNames(read(frozen("Text") + "\n<!--anki-fields-->\nSource: Second"),
        schema,config), /duplicate label/);
    assert.throws(() => page.pageExportFieldNames(read(frozen("Text").replace("Source:","Front:")),schema,config),/editable additional/);
    assert.throws(() => page.pageExportFieldNames(read(frozen("Text")),schema,{...config,file:"Source"}),/editable additional/);
    for (const body of ["```md\n" + frozen("Example") + "\n```", "Answer\n\n" + frozen("Example")]) {
        const card = read(body);
        assert.equal(card.back,body);
        assert.equal(card.sharedFields,undefined);
    }
});
