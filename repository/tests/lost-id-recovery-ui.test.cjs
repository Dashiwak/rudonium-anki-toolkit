// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { setImmediate: settle } = require("node:timers/promises");
const { test } = require("node:test");
const { load } = require("./benchmark/migration-modules.cjs");
const overlay = require("../Build/overlay-source.cjs");
class Element {
    constructor(tag, opts = {}) { this.tag = tag; this.children = []; this.text = opts.text; this.style = {}; this.classList = { add() {} }; }
    empty() { this.children = []; }
    setAttribute() {}
    setText(value) { this.text = value; }
    createEl(tag, opts) { const child = new Element(tag, opts); this.children.push(child); return child; }
    createDiv(opts) { return this.createEl("div", opts); }
    createSpan(opts) { return this.createEl("span", opts); }
    all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
function auditSummary(unlinked) {
    const result = { deck: "Knowledge", ankiProfile: { active: "Original" }, counts: { unlinkedNotes: unlinked }, ankiDeckKind: "ordinary",
        ankiInventoryComplete: true, vaultInventoryComplete: true, vaultName: "Vault" };
    for (const key of ["duplicateIds", "obsidianOnly", "ankiOnly", "unverifiedSourceIds", "outsideAnkiDeck", "outsideObsidianScope",
        "differences", "filteredCards", "deckAssignments", "fileErrors", "ankiErrors", "unlinked", "pendingDeletions", "unparsedIds"]) result[key] = [];
    return result;
}

test("opening or repeating the read-only audit only suggests the check; the explicit action performs one scan and applies only the chosen ID", async () => {
    const open = [], notices = [], scans = [], applied = [], commands = [], plugin = {
        app: {}, settings: { Defaults: { Deck: "Knowledge" }, BIDIRECTIONAL_SYNC: true }, register() {}, addCommand(c) { commands.push(c); } };
    let unlinked = 0;
    class ReviewModal {
        constructor(app) { this.app = app; this.modalEl = this.contentEl = new Element("div"); this.titleEl = new Element("h2"); }
        open() { open.push(this); this.onOpen(); }
        close() { open.splice(open.indexOf(this), 1); this.releaseReview(); }
    }
    const api = { AbortController, ReviewModal, AnkiProfileError: class extends Error {}, Notice: class { constructor(msg) { notices.push(msg); } },
        installModalLayout() {}, hasAuditAttachmentSources: () => false, syncScopeSignature: () => "work-folder", syncAuditDeckKey: x => x,
        auditCardRows: () => [], previewFieldText: (_doc, value) => value, uiFor: () => (_en, ru) => ru,
        auditPluginSync: () => auditSummary(unlinked),
        scanLostIds: async (_p, opts) => {
            scans.push({ ...opts });
            const row = { front: "Q", back: "A", path: "Dictionary.md", line: 2, model: "Basic", deck: "Knowledge" };
            return { unlinked: 4, unmatched: 1, profile: "Original", rows: [
                { ...row, key: "a", id: 1, status: "match" }, { ...row, key: "b", id: 2, status: "match", line: 4 },
                { ...row, key: "c", status: "review", line: 6, reason: "Uncertain" }] };
        },
        applyLostIds: async (_p, _plan, confirmed) => { applied.push([...confirmed]); return { restored: confirmed.size, archive: "/old.zip" }; },
    };
    const names = ["lost-id-recovery-ui", "sync-audit-ui"];
    const code = Object.fromEntries(names.map(n => [n, "import { AbortController } from './test-host';\n" + readFileSync(overlay.file(n + ".ts"), "utf8")]));
    const modules = await load(names, api, code);
    const current = () => open.at(-1).contentEl.all();
    const control = label => current().find(el => el.tag === "button" && el.text === label);
    modules["lost-id-recovery-ui"].registerLostIdRecoveryCommand(plugin);
    assert.equal(commands.length, 1); assert.equal(commands[0].id, "check-cards-without-id"); assert.equal(scans.length, 0);
    modules["sync-audit-ui"].openSyncAudit(plugin);
    await settle();
    assert.equal(control("Проверить карточки без ID"), undefined);
    unlinked = 4;
    assert.ok(control("Проверить повторно"), current().map(el => el.text).filter(Boolean).join(" | "));
    control("Проверить повторно").onclick();
    await settle();
    assert.equal(scans.length, 0, "Audit must not start a matching pass");
    assert.ok(control("Проверить карточки без ID"), current().map(el => el.text).join(" | "));
    control("Проверить карточки без ID").onclick();
    await settle();
    assert.deepEqual(scans, [{ deck: "Knowledge", profile: "Original", scopeSignature: "work-folder" }]);
    assert.equal(control("Восстановить выбранные ID").disabled, true);
    const boxes = current().filter(el => el.tag === "input");
    assert.equal(boxes.length, 2); assert.ok(boxes.every(box => !box.checked));
    boxes[1].checked = true; boxes[1].onchange();
    assert.equal(control("Восстановить выбранные ID").disabled, false);
    control("Восстановить выбранные ID").onclick();
    await settle();
    assert.equal(JSON.stringify(applied), JSON.stringify([[["b", 2]]]));
    control("Вернуться к аудиту").onclick();
    await settle();
    assert.equal(scans.length, 1);
    open.at(-1).close();
    commands[0].callback(); commands[0].callback();
    await settle();
    assert.deepEqual(scans, [{ deck: "Knowledge", profile: "Original", scopeSignature: "work-folder" }, {}]);
    assert.deepEqual(notices, []);
});

test("the export notice opens only the requested repair after rechecking its profile, deck, scope and source", async () => {
    const plugin = { app: {}, settings: { Defaults: { Deck: "Other" } } };
    const repairs = [], checks = [];
    let result = auditSummary(0), modal;
    class ReviewModal {
        constructor() { this.modalEl = this.contentEl = new Element("div"); this.titleEl = new Element("h2"); }
        open() { modal = this; this.onOpen(); }
        close() { this.releaseReview(); }
    }
    const host = { AbortController, ReviewModal, waitForFastScanIdle: async () => {}, installModalLayout() {},
        uiFor: () => en => en, hasAuditAttachmentSources: () => false, auditCardRows: () => [], syncAuditDeckKey: x => x,
        auditPluginSync: async (_plugin, _progress, _signal, scope, signature, target) => {
            checks.push([scope.deck, signature, target.profile]);
            return result;
        },
        openAuditRepair: (_plugin, reviewed, _back, id) => repairs.push([id, reviewed.obsidianOnly.map(g => g.id).join(",")]),
    };
    const code = "import { AbortController } from './test-host';\n" + readFileSync(overlay.file("sync-audit-ui.ts"), "utf8");
    const { "sync-audit-ui": audit } = await load(["sync-audit-ui"], host, { "sync-audit-ui": code });
    const target = { id: 82, path: "Dictionary.md", profile: "Original", scopeSignature: "folders-v1" };
    result.obsidianOnly = [71,82].map(id => ({ id, occurrences: [{ id, path: "Dictionary.md" }] }));
    await audit.openAuditForExportIssue(plugin, "Knowledge", target);
    await settle();
    assert.deepEqual(checks, [["Knowledge", "folders-v1", "Original"]]);
    assert.deepEqual(repairs, [[82, "82"]]);
    result = auditSummary(0);
    await audit.openAuditForExportIssue(plugin, "Knowledge", target);
    await settle();
    assert.equal(repairs.length, 1);
    assert.ok(modal.contentEl.all().some(el => el.text?.includes("Could not confirm missing ID 82 at Dictionary.md")));
});
