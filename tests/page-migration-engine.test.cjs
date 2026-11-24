// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { load } = require("./benchmark/migration-modules.cjs");
const uiFor = () => en => en;
class Notice { setMessage() {} hide() {} }

test("verified migration archive restores old vault metadata, original Markdown and binary content", async t => {
    const dir = fs.mkdtempSync(path.join(fs.existsSync(os.tmpdir()) ? os.tmpdir() : process.cwd(), "rudonium-migration-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const root = path.join(dir, "Vault");
    const content = { "Папка/Заметка.md": Buffer.from("# Вопрос\r\n\r\nОтвет\r\n"), ".obsidian/plugins/yanki/data.json": Buffer.from('{"previous":true}'), "Images/pic.png": Buffer.from([0, 255, 8, 15]) };
    for (const [name, value] of Object.entries(content)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), value);
    }
    const plugin = { settings: {}, app: { vault: { adapter: { getBasePath: () => root } } } };
    const modules = await load(["vault-backup", "vault-backup-zip"], { uiFor, Notice });
    const backup = modules["vault-backup"];
    assert.equal(await backup.fullMigrationBackupDirectory(plugin), path.join(dir, "Obsidian Anki Backups", "Vault"));
    await assert.rejects(backup.createFullMigrationBackup(plugin, path.join(root, "unsafe")), /outside the vault/);
    const archive = await backup.createFullMigrationBackup(plugin);
    assert.equal(path.basename(archive), "Obsidian.zip");
    const restored = path.join(dir, "Restore");
    await modules["vault-backup-zip"].restoreVaultZip(archive, restored);
    for (const [name, value] of Object.entries(content)) assert.deepEqual(fs.readFileSync(path.join(restored, name)), value);
});

function fixture(path, front, id, source = "flashcards") {
    return { path, doc: JSON.stringify({ front, back: "Answer", id, source, status: "candidate" }) };
}
const row = (p, name) => p.rows.find(r => r.path === name);

async function host(files, notes = []) {
    const state = { events: [], deckRequests: [], profile: "User 1", rev: 0, notes, leaves: [], hooks: {}, files, enabled: new Set() };
    const types = { Basic: ["Front", "Back"], "Yanki - Basic": ["Front", "Back", "YankiNamespace"] };
    const handlers = new Set();
    const byPath = new Map(files.map(f => [f.path, f]));
    class MarkdownView {}
    const vault = {
        getName: () => "Vault", getMarkdownFiles: () => files, read: async f => f.doc,
        getAbstractFileByPath: path => byPath.get(path),
        on: (kind, fn) => { const ref = { kind, fn }; handlers.add(ref); return ref; },
        offref: ref => handlers.delete(ref),
        async process(f, fn) {
            state.events.push("process " + f.path);
            if (state.hooks.beforeWrite) await state.hooks.beforeWrite(f);
            f.doc = fn(f.doc);
            state.rev++;
            for (const h of handlers) if (h.kind === "modify") h.fn(f);
            if (state.hooks.afterWrite) await state.hooks.afterWrite(f);
        },
    };
    const plugin = { fields_dict: types, settings: { CUSTOM_REGEXPS: { Basic: "existing rule" } },
        app: { vault, workspace: { getLeavesOfType: () => state.leaves }, plugins: { enabledPlugins: state.enabled } },
        saveAllData: async () => {state.events.push("save");} };
    const byId = () => new Map(notes.map(n => [n.id, n]));
    const api = { uiFor, MarkdownView, pageCardExpression: "@page", sameEditorText: (a, b) => a === b,
        sourcePageFields: (source, names) => ['anki-forge', 'anki-bridge'].includes(source) && names?.includes('Front') && names.includes('Back') ? ['Front', 'Back'] : undefined,
        isDeckPageSchema: () => false, isRecoveryTag: t => /^ota-recovery::/u.test(t),
        hasPendingAnkiWrite: () => false, hasPendingBidirectionalWrite: () => false,
        withFastScanReadLock: async (plugin, run) => run(() => state.rev),
        settingsWithoutAuditMode: s => s, scanProfileFreeSettings: s => s, isSyncAuditReportPath: () => false,
        editorPreviewMetadata: () => ({}), settingToData: async (app, s) => s, portableFileExportRules: () => [],
        conflictingDeckDirective: () => false, findIdMarkers: () => [], detectMigrationContext: async () => ({ yankiInstalled: true, yankiFolders: [] }),
        foreignMigrationKeys: str => JSON.parse(str).externalKey ? [JSON.parse(str).externalKey] : [],
        foreignMigrationIds: str => JSON.parse(str).id ? [JSON.parse(str).id] : [],
        inspectMigrationFile: (path, str) => { const n = JSON.parse(str); return n.converted ? { status: "already", source: "rudonium", id: n.id } : n; },
        renderMigrationPage: (before, candidate) => JSON.stringify({ ...candidate, converted: true }),
        parsePortableMarkdown: async (app, data, f, str) => {
            const n = JSON.parse(str);
            if (!n.converted && !n.native) return {previewCandidates: []};
            return { previewCandidates: [{ identifier: n.id, note: { modelName: n.linkedRoute?.model ?? data.PAGE_MODEL,
                deckName: n.linkedRoute?.deck ?? "Default", fields: { Front: n.front, Back: n.back }, tags: n.preservedTags ?? [] } }] };
        },
        auditRepairFieldKey: str => str.trim().replace(/<[^>]+>/g, ""), auditRepairNoteSnapshot: n => n,
        requireExpectedAnkiProfile: async (p, pinned) => { if (pinned && pinned !== state.profile) throw Error("changed profile"); return state.profile; },
        auditRead: async (action, params) => {
            state.events.push(action);
            if (state.hooks.beforeAnkiRead) await state.hooks.beforeAnkiRead(action);
            if (action === "modelFieldNames") return types[params.modelName];
            if (action === "modelTemplates") return state.templates ?? { Card: { Front: "{{Front}}", Back: "{{FrontSide}}<hr>{{Back}}" } };
            if (action === "findNotes") return notes.map(n => n.id);
            if (action === "notesInfo") {
                const notesById = byId();
                return params.notes.map(id => {
                const n = notesById.get(id);
                if (!n) return null;
                const fields = types[n.model];
                const values = { ...n.extra, Front: n.front, Back: n.back ?? "Answer" };
                return { id: n.id, fields: values, modelName: n.model, fieldNames: fields, firstField: values[fields[0]], tags: n.tags ?? [],
                    cards: [n.id + 1000], signature: JSON.stringify(n) };
                });
            }
            if (action === "getDecks") {
                state.deckRequests.push([...params.cards]);
                const byNoteId = byId(), groups = {};
                for (const card of params.cards) {
                    const deck = byNoteId.get(card - 1000)?.deck;
                    if (deck) (groups[deck] ??= []).push(card);
                }
                return groups;
            }
            throw Error("Unexpected Anki operation " + action);
        },
        createFullMigrationBackup: async () => {
            state.events.push("backup");
            if (state.hooks.backup) await state.hooks.backup();
            state.archive = files.map(f => f.doc);
            return "/Backups/Obsidian.zip";
        }, fullMigrationBackupDirectory: async () => "/Backups",
    };
    const engine = (await load(["page-migration"], api))["page-migration"];
    return { state, plugin,
        preview: (folder = "", model = "Basic") => engine.previewPageMigration(plugin, { model, folder, checkMissingIds: true }),
        previewFiles: (folder = "", model = "Basic", source) => engine.previewPageMigration(plugin, { model, folder, source }),
        apply: (plan, paths, allowUnlinked = false, links) => engine.applyPageMigration(plugin, plan, new Set(paths), undefined, undefined, undefined, allowUnlinked, links),
        editor: (f, text) => Object.assign(new MarkdownView(), { file: f, getViewData: () => text, data: f.doc, getMode: () => "source" }),
    };
}

test("a file recognized by an active export rule stays native in automatic and explicit migration", async () => {
    const f = fixture("Cards/Overlap.md", "Question", 11);
    f.doc = JSON.stringify({ ...JSON.parse(f.doc), native: true });
    const original = f.doc;
    const h = await host([f]);
    for (const source of ["auto", "flashcards"]) {
        const plan = await h.previewFiles("", "Basic", source);
        assert.equal(row(plan, f.path).status, "already");
        assert.match(row(plan, f.path).reason, /active export rule/);
        await assert.rejects(h.apply(plan, [f.path]), /stale/);
        assert.equal(f.doc, original);
    }
    assert.deepEqual(h.state.events, []);
    for (const source of ["rudonium", "obsidian-to-anki", "spaced-repetition"]) {
        await assert.rejects(h.previewFiles("", "Basic", source), /Unknown source/);
    }
});

test("migration defers all files without IDs until a manual lookup and reads only explicit IDs on normal preview", async () => {
    const files = [fixture("Cards/Lost.md", "Recover me"), fixture("Cards/New.md", "New"),
        fixture("Cards/Linked.md", "Linked", 11)];
    const h = await host(files, [{ id: 10, model: "Basic", deck: "Default", front: "Recover me" },
        { id: 11, model: "Basic", deck: "Default", front: "Linked" }]);
    const first = await h.previewFiles();
    assert.deepEqual([...first.rows].map(r => r.status), ["unchecked", "unchecked", "ready"]);
    assert.equal(h.state.events.includes("findNotes"), false);
    assert.deepEqual(h.state.deckRequests, [[1011]]);
    await assert.rejects(h.apply(first, [files[0].path], true, new Map([[files[0].path, 10]])), /stale/);
    const checked = await h.preview();
    assert.deepEqual([...checked.rows].map(r => r.status), ["link", "ready", "ready"]);
    assert.equal(row(checked, files[0].path).link.id, 10);
    assert.equal(h.state.events.filter(e => e === "findNotes").length, 1);
    assert.equal(h.state.events.includes("backup"), false);
    h.state.events.length = 0;
    const again = await h.previewFiles();
    assert.equal(row(again, files[0].path).status, "unchecked");
    assert.equal(h.state.events.includes("findNotes"), false);

    const only = await host(files.slice(0, 2));
    const local = await only.previewFiles();
    assert.ok(local.rows.every(r => r.status === "unchecked"));
    assert.deepEqual(only.state.events, []);

    only.state.hooks.beforeAnkiRead = action => { if (action === "findNotes") throw new Error("Anki offline"); };
    const retryable = await only.preview();
    assert.ok(retryable.rows.every(r => r.status === "unchecked"));
    assert.match(retryable.warnings[0], /Anki offline/);
    delete only.state.hooks.beforeAnkiRead;
    assert.ok((await only.preview()).rows.every(r => r.status === "ready"));
});

test("mixed models and new pages preserve original route, tags and independent regex; rerun is idempotent", async () => {
    const files = [fixture("A.md", "Question", 10, "yanki"), fixture("B.md", "Brand new")];
    const initial = files.map(f => f.doc);
    const h = await host(files, [{ id: 10, model: "Yanki - Basic", deck: "History", front: "Question", tags: ["source::tag"] }]);
    const preview = await h.preview();
    assert.deepEqual([...preview.rows].map(r => r.status), ["ready", "ready"]);
    assert.equal(h.state.archive, undefined);
    assert.deepEqual(files.map(f => f.doc), initial);
    await assert.rejects(h.apply(preview, files.map(f => f.path)), /Confirm the unlinked/);
    const result = await h.apply(preview, files.map(f => f.path), true);
    assert.equal(result.stopped, undefined);
    assert.deepEqual([...result.converted], ["A.md", "B.md"]);
    assert.deepEqual(h.state.archive, initial);
    assert(h.state.events.indexOf("backup") < h.state.events.indexOf("save"));
    assert.deepEqual(JSON.parse(files[0].doc).linkedRoute, { model: "Yanki - Basic", deck: "History" });
    assert.deepEqual(JSON.parse(files[0].doc).preservedTags, ["source::tag"]);
    assert.equal(h.plugin.settings.CUSTOM_REGEXPS.Basic, "existing rule");
    assert.equal(h.plugin.settings.PAGE_MODEL, "Basic");
    await assert.rejects(h.apply(preview, ["A.md"]), /stale/);
    assert.deepEqual([...(await h.preview()).rows].map(r => r.status), ["already", "already"]);
});

test("global ownership, collection duplicates, markup differences and missing IDs stay in review", async () => {
    const files = [fixture("In/a.md", "Duplicate ID", 10), fixture("Outside/b.md", "Other", 10),
        fixture("In/c.md", "Same front"), fixture("In/d.md", "Missing", 11), fixture("In/e.md", "Markup", 13),
        fixture("In/f.md", "Same new"), fixture("In/g.md", "Same new"), fixture("In/h.md", "Reserved", 14),
        fixture("In/i.md", "Unsaved duplicate", 15), fixture("Outside/draft.md", "Draft")];
    const h = await host(files, [{ id: 12, model: "Basic", deck: "D", front: "Same front" }, { id: 13, model: "Basic", deck: "D", front: "<b>Markup</b>" },
        { id: 14, model: "Basic", deck: "D", front: "Reserved", tags: ["ota-recovery::" + "a".repeat(32) + "-1"] }]);
    h.state.leaves.push({ view: h.editor(files[9], fixture("Outside/draft.md", "Draft", 15).doc) });
    const preview = await h.preview("In");
    assert(preview.rows.every(r => r.status === "review"));
    assert.match(row(preview, "In/a.md").reason, /Another Markdown/);
    assert.match(row(preview, "In/c.md").reason, /already contains/);
    assert.match(row(preview, "In/d.md").reason, /missing/);
    assert.match(row(preview, "In/e.md").reason, /differs/);
    assert.match(row(preview, "In/f.md").reason, /same question/);
    assert.match(row(preview, "In/h.md").reason, /recovery tags/);
    assert.match(row(preview, "In/i.md").reason, /Another Markdown/);
});

test("active source, stale disk content, unsaved editors, or failed backup leave every file untouched", async () => {
    const f = fixture("A.md", "Question", 10), h = await host([f], [{ id: 10, model: "Basic", deck: "D", front: "Question" }]);
    h.state.enabled.add("better-flashcards");
    let p = await h.preview();
    assert(p.warnings.some(msg => msg.includes("better-flashcards")));
    await assert.rejects(h.apply(p, [f.path]), /better-flashcards/);
    h.state.enabled.clear();
    h.state.leaves.push({ view: h.editor(f, fixture("A.md", "Unsaved", 10).doc) });
    await assert.rejects(h.apply(p, [f.path]), /stale/);
    h.state.leaves.length = 0;
    const before = f.doc;
    f.doc += "\n";
    await assert.rejects(h.apply(p, [f.path]), /stale/);
    f.doc = before;
    h.state.hooks.backup = () => { throw Error("disk full"); };
    await assert.rejects(h.apply(p, [f.path]), /disk full/);
    assert.equal(h.plugin.settings.PAGE_MODEL, undefined);
    assert.equal(f.doc, before);
    h.state.hooks.backup = () => { h.state.profile = "Changed"; };
    const stopped = await h.apply(p, [f.path]);
    assert.match(stopped.stopped, /changed profile/);
    assert.equal(stopped.archive, "/Backups/Obsidian.zip");
    assert.deepEqual([...stopped.converted], []);
    assert.equal(f.doc, before);
});

test("remote field/tag changes after backup stop migration with the external ZIP retained", async () => {
    const f = fixture("A.md", "Q", 10), n = { id: 10, model: "Basic", deck: "D", front: "Q" };
    const h = await host([f], [n]), p = await h.preview();
    h.state.hooks.backup = () => { n.tags = ["recent"]; };
    const result = await h.apply(p, [f.path]);
    assert.match(result.stopped, /original Anki note changed/);
    assert.equal(h.plugin.settings.PAGE_MODEL, undefined);
    assert.equal(result.archive, "/Backups/Obsidian.zip");
});

test("failure mid-batch exposes partial progress; retry skips converted files", async () => {
    const files = [fixture("A.md", "One"), fixture("B.md", "Two")];
    const h = await host(files);
    h.state.hooks.beforeWrite = file => { if (file.path === "B.md") throw Error("read-only"); };
    const result = await h.apply(await h.preview(), files.map(f => f.path), true);
    assert.deepEqual([...result.converted], ["A.md"]);
    assert.equal(result.archive, "/Backups/Obsidian.zip");
    assert.match(result.stopped, /read-only/);
    assert.equal(h.plugin.settings.PAGE_MODEL, "Basic");
    assert.equal(JSON.parse(files[1].doc).converted, undefined);
    const retry = await h.preview();
    assert.equal(row(retry, "A.md").status, "already");
    assert.equal(row(retry, "B.md").status, "ready");
    delete h.state.hooks.beforeWrite;
    const finish = await h.apply(retry, ["B.md"], true);
    assert.equal(finish.stopped, undefined);
    assert.deepEqual([...finish.converted], ["B.md"]);
});

test("rollback setting on a first write failure, keeping it when an acknowledged error follows a real write", async () => {
    for (const mode of ["beforeWrite", "afterWrite"]) {
        const f = fixture("A.md", "New"), h = await host([f]);
        h.state.hooks[mode] = () => { throw Error("I/O error"); };
        const result = await h.apply(await h.preview(), [f.path], true);
        assert.match(result.stopped, /I\/O error/);
        assert.equal(h.plugin.settings.PAGE_MODEL, mode === "beforeWrite" ? undefined : "Basic");
        assert.deepEqual([...result.converted], mode === "beforeWrite" ? [] : ["A.md"]);
    }
});

test("reverse, cloze and non-question default templates hold only unlinked notes for review", async () => {
    for (const templates of [{ A: { Front: "{{Front}}", Back: "{{Back}}" }, B: { Front: "{{Back}}", Back: "{{Front}}" } },
        { Cloze: { Front: "{{cloze:Front}}", Back: "{{Back}}" } }, { Wrong: { Front: "{{Back}}", Back: "{{Front}}" } }]) {
        const h = await host([fixture("Q.md", "Existing", 10, "yanki"), fixture("U.md", "New")],
            [{ id: 10, model: "Yanki - Basic", deck: "D", front: "Existing" }]);
        h.state.templates = templates;
        const plan = await h.preview("/");
        assert.equal(row(plan, "Q.md").status, "ready");
        assert.equal(row(plan, "U.md").status, "review");
        assert.match(row(plan, "U.md").reason, /single forward template/);
        assert(!h.state.events.includes("findNotes"));
    }
});

test("link is opt-in per file and exact note ID; a new page never uses that consent", async () => {
    const f = fixture("A.md", "Question");
    const h = await host([f], [{ id: 51, model: "Basic", deck: "Default", front: "<p>Question</p>", tags: ["old::tag"] }]);
    const before = f.doc, p = await h.preview();
    const proposal = row(p, f.path);
    assert.equal(proposal.status, "link");
    assert.equal(proposal.id, undefined);
    assert.deepEqual({ ...proposal.link }, { id: 51, model: "Basic", deck: "Default", front: "<p>Question</p>", back: "Answer" });
    assert.equal(JSON.parse(proposal.after).id, 51);
    for (const links of [undefined, new Map([["Other.md", 51]]), new Map([[f.path, 52]])]) {
        await assert.rejects(h.apply(p, [f.path], true, links), /Confirm each proposed/);
        assert.equal(h.state.archive, undefined);
        assert.equal(f.doc, before);
    }
    const result = await h.apply(p, [f.path], false, new Map([[f.path, 51]]));
    assert.deepEqual([...result.converted], [f.path]);
    assert.deepEqual(h.state.archive, [before]);
    assert.equal(JSON.parse(f.doc).id, 51);
    assert.deepEqual(JSON.parse(f.doc).preservedTags, ["old::tag"]);
    assert.equal(row(await h.preview(), f.path).status, "already");
    assert.equal(h.state.events.filter(e => e === "findNotes").length, 2);
    assert.equal(h.state.events.filter(e => e === "getDecks").length, 2);
});

test("recover known source model and declared deck, including independently identified files", async () => {
    const f = fixture("A.md", "Question");
    f.doc = JSON.stringify({ ...JSON.parse(f.doc), externalKey: "old-uuid", recoveryModel: "Yanki - Basic", deck: "Archive" });
    const notes = [{ id: 65, model: "Yanki - Basic", deck: "Archive", front: "Question" },
        { id: 66, model: "Basic", deck: "Archive", front: "Question" }, { id: 67, model: "Yanki - Basic", deck: "Default", front: "Question" }];
    const h = await host([f], notes), p = await h.preview();
    assert.equal(row(p, f.path).link.id, 65);
    const result = await h.apply(p, [f.path], false, new Map([[f.path, 65]]));
    assert.equal(result.stopped, undefined);
    assert.deepEqual(JSON.parse(f.doc).linkedRoute, { model: "Yanki - Basic", deck: "Archive" });
});

test("exact matching guards markup, both fields, model, deck, external IDs and all claimants", async () => {
    const candidate = () => fixture("Folder/Q.md", '<img src="a.png">Question');
    const n = { id: 18, model: "Basic", deck: "Default", front: '<img src="a.png">Question' };
    for (const [notes, another] of [
        [[{ ...n, front: '<img src="b.png">Question' }]], [[{ ...n, back: "New answer" }]], [[{ ...n, model: "Yanki - Basic" }]],
        [[{ ...n, deck: "Other" }]], [[n, { ...n, id: 19 }]],
        [[n], fixture("Elsewhere/Q.md", "Different", 18)], [[n], fixture("Folder/Other.md", n.front)],
    ]) {
        const f = candidate();
        const h = await host(another ? [f, another] : [f], notes), p = await h.preview("Folder");
        assert.equal(row(p, f.path).status, "review", JSON.stringify(notes));
        assert.equal(row(p, f.path).link, undefined);
    }
    const f = candidate(), sibling = fixture("Elsewhere/X.md", "Unrelated");
    f.doc = JSON.stringify({ ...JSON.parse(f.doc), externalKey: "af-abcd" });
    sibling.doc = JSON.stringify({ ...JSON.parse(sibling.doc), externalKey: "af-abcd" });
    const h = await host([f, sibling], [n]);
    assert.match(row(await h.preview("Folder"), f.path).reason, /same source key/);
    sibling.doc = fixture("Elsewhere/X.md", "Unrelated").doc;
    f.doc = JSON.stringify({ ...JSON.parse(f.doc), recoveryIdentity: { tag: "source::abcd" } });
    assert.match(row(await h.preview("Folder"), f.path).reason, /identity/);
    n.tags = ["source::abcd"];
    assert.equal(row(await h.preview("Folder"), f.path).status, "link");
});

test("proposal rechecks uniqueness and ownership after ZIP including edits outside the folder", async () => {
    for (const variation of ["new remote duplicate", "moved deck", "changed tags", "claimed outside", "unsaved outside", "during write"]) {
        const f = fixture("In/Q.md", "Q"), other = fixture("Outside/Other.md", "Other");
        const n = { id: 72, model: "Basic", deck: "Default", front: "Q" };
        const h = await host([f, other], [n]);
        const p = await h.preview("In");
        assert.equal(row(p, f.path).link.id, 72);
        const dirty = () => h.state.leaves.push({ view: h.editor(other, fixture(other.path, "Other", 72).doc) });
        if (variation === "during write") h.state.hooks.beforeWrite = dirty;
        else h.state.hooks.backup = () => {
            if (variation === "new remote duplicate") h.state.notes.push({ ...n, id: 73 });
            if (variation === "moved deck") n.deck = "Other";
            if (variation === "changed tags") n.tags = ["changed"];
            if (variation === "claimed outside") other.doc = fixture(other.path, "Other", 72).doc;
            if (variation === "unsaved outside") dirty();
        };
        const result = await h.apply(p, [f.path], false, new Map([[f.path, 72]]));
        assert.ok(result.stopped, variation); assert.equal(result.archive, "/Backups/Obsidian.zip");
        assert.deepEqual([...result.converted], [], variation);
        assert.equal(JSON.parse(f.doc).id, undefined);
    }
});

test("a newly opened editor cannot claim a verified source ID while its conversion is being written", async () => {
    const linked = fixture("In/Linked.md", "Q", 72), other = fixture("Outside/Copied.md", "Other");
    const h = await host([linked, other], [{id:72, model:"Basic", deck:"Default", front:"Q"}]);
    const original = linked.doc;
    const plan = await h.preview("In");
    assert.equal(row(plan, linked.path).status, "ready");
    h.state.hooks.beforeWrite = () => h.state.leaves.push({ view: h.editor(other, fixture(other.path, "Other", 72).doc) });
    const result = await h.apply(plan, [linked.path]);
    assert.match(result.stopped, /stale/i);
    assert.deepEqual([...result.converted], []);
    assert.equal(linked.doc, original);
});

test("native unlinked pages can recover but are never offered for creation by the migration wizard", async () => {
    const makeNative = (path, front, extra = {}) => ({ path, doc: JSON.stringify({
        front, back: "Answer", source: "rudonium", status: "candidate", recoverOnly: true, ...extra }) });
    const pages = [makeNative("A.md", "A"), makeNative("B.md", "B"), makeNative("C.md", "C", { needsLink: true })];
    const h = await host(pages, [{ id: 7, model: "Basic", deck: "Default", front: "A" }]);
    const p = await h.preview();
    assert.deepEqual([...p.rows].map(r => r.status), ["link", "already", "review"]);
    assert.equal(row(p, "A.md").link.id, 7);
    await assert.rejects(h.apply(p, ["B.md"], true), /stale/);
});

test("20,000-file recovery batches Anki reads and withholds duplicate or occupied matches", async t => {
    const size = 20_000, firstId = 100_000;
    const files = Array.from({ length: size }, (_, i) => fixture("In/" + i + ".md", "Question " + i));
    const notes = Array.from({ length: size }, (_, i) => ({ id: firstId + i, model: "Basic", deck: "Default", front: "Question " + i }));
    // One duplicate in Anki, one ID owned by an out-of-scope file, and two unlinked files claiming the same note.
    notes.push({ ...notes[1], id: firstId + size });
    files.push(fixture("Elsewhere/claimed.md", "Question 2", notes[2].id));
    files[3].doc = files[4].doc;
    const h = await host(files, notes);
    const start = performance.now();
    const plan = await h.preview("In");
    const links = new Map(plan.rows.filter(r => r.link).map(r => [r.path, r.link.id]));
    const previewMs = performance.now() - start;
    assert.equal(links.size, size - 4);
    for (const i of [1, 2, 3, 4]) assert.equal(row(plan, "In/" + i + ".md").status, "review");
    const beforeApply = performance.now();
    const result = await h.apply(plan, [...links.keys()], false, links);
    const applyMs = performance.now() - beforeApply;
    assert.equal(result.stopped, undefined);
    assert.equal(result.converted.length, size - 4);
    for (let i = 0; i < size; i++) {
        const expected = [1, 2, 3, 4].includes(i) ? undefined : firstId + i;
        assert.equal(JSON.parse(files[i].doc).id, expected);
    }
    const chunks = 2 * Math.ceil(notes.length / 500);
    assert.equal(h.state.events.filter(e => e === "notesInfo").length, chunks);
    assert.equal(h.state.events.filter(e => e === "getDecks").length, 2 * Math.ceil(size / 500));
    assert.equal(h.state.events.filter(e => e === "findNotes").length, 2);
    t.diagnostic("20,000 files in scope. Preview " + previewMs.toFixed(0) + " ms; confirmed apply " + applyMs.toFixed(0) +
        " ms. Markdown host, disk/ZIP and AnkiConnect simulated; ownership/eligibility/matching/commit code real.");
});

test("a known ordinary source and a service-first Bridge model can recover with a non-forward default", async () => {
    const bridge = fixture("Bridge.md", "Bridge question", undefined, "anki-bridge");
    bridge.doc = JSON.stringify({ ...JSON.parse(bridge.doc), needsLink: true, deck: "Original" });
    const yanki = fixture("Yanki.md", "Yanki question", undefined, "yanki");
    yanki.doc = JSON.stringify({ ...JSON.parse(yanki.doc), recoveryModel: "Yanki - Basic", deck: "Archive" });
    const newPage = fixture("New.md", "New", undefined, "obsidian-to-anki");
    const notes = [{ id: 241, model: "Bridge Test", deck: "Original", front: "Bridge question", extra: { CardKey: "uuid" } },
        { id: 242, model: "Yanki - Basic", deck: "Archive", front: "Yanki question" }];
    const h = await host([bridge, yanki, newPage], notes);
    h.plugin.fields_dict["Bridge Test"] = ["CardKey", "Front", "Back"];
    h.state.templates = { Reverse: { Front: "{{Back}}", Back: "{{Front}}" } };
    const plan = await h.preview("", "Bridge Test");
    assert.equal(row(plan, bridge.path).link.id, 241);
    assert.equal(row(plan, yanki.path).link.id, 242);
    assert.equal(row(plan, newPage.path).status, "review");
    const result = await h.apply(plan, [bridge.path, yanki.path], false, new Map([[bridge.path, 241], [yanki.path, 242]]));
    assert.equal(result.stopped, undefined);
    assert.deepEqual(JSON.parse(bridge.doc).fieldNames, ["Front", "Back"]);
    assert.deepEqual(notes[0].extra, { CardKey: "uuid" });
});

test("one rich card in a large model only requests decks for possible matches and distinguishes source backlinks", async () => {
    const front = 'See <a href="https://example.org/a">site</a>';
    const answer = '<img src="map.png"><b>Vienna</b>';
    const link = id => '<br><a href="obsidian://anki-card?vault=Vault&amp;file=Q.md&amp;nid=' + id + '" class="obsidian-link">Obsidian</a>';
    const f = fixture("Q.md", front);
    f.doc = JSON.stringify({ ...JSON.parse(f.doc), back: answer });
    const notes = Array.from({ length: 1234 }, (_, i) => ({ id: 5000 + i, model: "Basic", deck: "Default", front: "Other " + i }));
    notes[2].front = "<p>" + front + link(notes[2].id) + "</p>"; notes[2].back = answer;
    notes[3].front = front; notes[3].back = '<img src="unrelated.png"><b>Vienna</b>';
    notes[4].front = front + link(notes[4].id).replace("Q.md", "Other.md"); notes[4].back = answer;
    const h = await host([f], notes), plan = await h.preview();
    assert.equal(row(plan, f.path).link?.id, notes[2].id);
    assert.deepEqual(h.state.deckRequests, [[notes[2].id + 1000, notes[4].id + 1000]]);
    const result = await h.apply(plan, [f.path], false, new Map([[f.path, notes[2].id]]));
    assert.equal(result.stopped, undefined);
    assert.deepEqual(h.state.deckRequests[1], h.state.deckRequests[0]);
});
