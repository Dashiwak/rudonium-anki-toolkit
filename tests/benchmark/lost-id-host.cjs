// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const { load } = require("./migration-modules.cjs");
const pageFile = require("./page-file.cjs");

const file = (path, text) => ({ path, text, stat: { mtime: 1, ctime: 1, size: Buffer.byteLength(text) } });
function note(id, front, back = "Answer", model = "Basic", deck = "Knowledge") {
    return { deck, note: { noteId: id, modelName: model, fields: {
        Front: { order: 0, value: front }, Back: { order: 1, value: back },
    }, tags: [], cards: [id + 1_000_000] } };
}

// The native whole-page reader and ID writer come from the production overlay.
// The upstream renderer's regular line syntax is represented by one plain-text
// fixture format. It exposes the same candidate references and ID insertion slots.
function fixtureFile() {
    return pageFile().replace("from './page-card.mjs'", "from './page-card'")
        .replace("this.regularScanned = true", String.raw`
            this.regularScanned = true;
            if (pageOnly) return;
            this.notes_to_add = []; this.inline_notes_to_add = []; this.id_indexes = []; this.inline_id_indexes = [];
            const rows = /^- ([^\r\n]+?) :: ([^\r\n]+)(?:\r?\n<!--[ ]*ID: (\d+)[ ]*-->)?/gm;
            for (const match of this.file.matchAll(rows)) {
                const start = match.index, end = start + match[0].length;
                const note = { modelName: 'Basic', deckName: this.target_deck, fields: { Front: match[1], Back: match[2] }, tags: [] };
                const identifier = match[3] ? Number(match[3]) : undefined;
                this.previewCandidates?.push({ note, start, end, identifier });
                if (identifier) this.notes_to_edit.push({ identifier, note });
                else { this.regex_notes_to_add.push(note); this.regex_id_indexes.push(end); }
            }
            this.all_notes_to_add = [...this.regex_notes_to_add];
        `).replace("this.regularWrote = true", String.raw`
            for (let i = this.note_ids.length - 1; i >= 0; i--) {
                if (!this.note_ids[i]) continue;
                const offset = this.regex_id_indexes[i];
                const newline = this.file.includes('\r\n') ? '\r\n' : '\n';
                this.file = this.file.slice(0, offset) + newline + '<!--ID: ' + this.note_ids[i] + '-->' + this.file.slice(offset);
            }
        `).replace("getContextAtIndex(i)", `
            removeUnsafeNewCards(excluded) {
                const selected = this.regex_notes_to_add.map((note, i) => ({ note, at: this.regex_id_indexes[i] }))
                    .filter(({ note }) => !excluded.has(note));
                this.all_notes_to_add = this.regex_notes_to_add = selected.map(item => item.note);
                this.regex_id_indexes = selected.map(item => item.at);
            }
            getContextAtIndex(i)`);
}

async function host(files, collection) {
    const state = { files, collection, events: [], leaves: [], hooks: {}, profile: "Original", rev: 0 };
    const lookup = new Map(files.map(f => [f.path, f]));
    const callbacks = new Set();
    class MarkdownView {}
    class TFolder {}
    for (const root of ["Knowledge", "Elsewhere"]) lookup.set(root, new TFolder());
    const vault = {
        getName: () => "Vault", configDir: ".obsidian", getMarkdownFiles: () => files,
        getAbstractFileByPath: path => lookup.get(path), read: async f => f.text, cachedRead: async f => f.text,
        on: (event, fn) => { const ref = { event, fn }; callbacks.add(ref); return ref; },
        offref: ref => callbacks.delete(ref),
        async process(f, fn) {
            assert.ok(state.archive, "Rewrites require a completed backup");
            state.hooks.beforeWrite?.(f);
            const next = fn(f.text);
            state.events.push({ kind: "write", path: f.path });
            f.text = next; f.stat.mtime++; f.stat.size = Buffer.byteLength(next); state.rev++;
            for (const { event, fn } of callbacks) if (event === "modify") fn(f);
        },
    };
    const plugin = { fields_dict: { Basic: ["Front", "Back"], Other: ["Front", "Back"] },
        manifest: { id: "rudonium-anki-toolkit" },
        settings: { PAGE_MODEL: "Basic", CUSTOM_REGEXPS: {}, Syntax: {}, Defaults: { Deck: "Knowledge", "ID Comments": true },
            ACTIVE_SYNC_FOLDER_PROFILE: "work", SYNC_FOLDER_PROFILES: [{ id: "work", name: "Work", folders: ["Knowledge"], excludedFolders: [] }] },
        app: { vault, workspace: { getLeavesOfType: () => state.leaves }, metadataCache: { getCache: () => ({}) } } };
    const api = {
        MarkdownView, TFolder, parseYaml: () => ({}), settingsWithoutAuditMode: s => s,
        settingToData: (_app, s, fields) => ({ template: { deckName: s.Defaults.Deck, tags: [] }, fields_dict: fields,
            custom_regexps: s.CUSTOM_REGEXPS, page_model: s.PAGE_MODEL, page_id_location: s.PAGE_ID_LOCATION, comment: true, id_date: s.Defaults["Add Date to Anki IDs"] === true, add_context: false, add_file_link: false,
            folder_tags: {}, folder_decks: {}, NOTE_REGEXP: /(?!)/g, INLINE_REGEXP: /(?!)/g, EMPTY_REGEXP: /(?!)/g }),
        hasPendingAnkiWrite: () => false, hasPendingBidirectionalWrite: () => false,
        withFastScanReadLock: async (_plugin, work) => work(() => state.rev),
        requireExpectedAnkiProfile: async (_p, pinned) => {
            assert.ok(!pinned || pinned === state.profile, "Anki profile changed");
            return state.profile;
        },
        fullMigrationBackupDirectory: async () => "/Backups",
        createFullMigrationBackup: async () => {
            state.events.push({ kind: "backup" });
            const before = files.map(f => f.text);
            if (state.hooks.backup) await state.hooks.backup();
            state.archive = before;
            return "/Backups/Obsidian.zip";
        },
        async auditRead(action, params) {
            state.events.push({ kind: action, count: params.notes?.length ?? params.cards?.length });
            if (action === "modelFieldNames") return plugin.fields_dict[params.modelName];
            if (action === "modelTemplates") return { Card: { Front: "{{Front}}", Back: "{{Back}}" } };
            if (action === "findNotes") return collection.map(({ note }) => note.noteId);
            if (action === "notesInfo") {
                const byId = new Map(collection.map(item => [item.note.noteId, item.note]));
                return params.notes.map(id => structuredClone(byId.get(id) ?? null));
            }
            if (action === "getDecks") {
                const byCard = new Map(collection.flatMap(item => item.note.cards.map(id => [id, item.cardDecks?.[id] ?? item.deck])));
                const decks = {};
                for (const id of params.cards) (decks[byCard.get(id)] ??= []).push(id);
                return decks;
            }
            assert.fail("Unexpected or mutating AnkiConnect action: " + action);
        },
    };
    const real = ["lost-id-recovery", "page-migration", "portable-parser", "page-card", "migrate-rudonium-page",
        "migration-markdown", "anki-id-marker", "id-marker-literals", "audit-repair-match", "card-preview-metadata", "markdown-pipeline",
        "export-rules", "interface-language", "sync-profiles", "card-format-presets", "deck-routes", "card-source-link-fields",
        "card-export-diagnostics", "bidirectional-markdown", "bidirectional-blocks", "bidirectional-fields", "duplicate-markers",
        "export-recovery", "linked-bullets", "page-migration-router", "migrate-forge-bridge", "migrate-ast-exporter",
        "migrate-deck", "migrate-yanki", "migrate-flashcards", "file", "anki", "constants"];
    const modules = await load(real, api, { file: fixtureFile(), anki: "export {}", constants: "export {}" });
    const engine = modules["lost-id-recovery"];
    return { state, plugin, scan: (scope, signal) => engine.scanLostIds(plugin, scope, signal),
        apply: (plan, confirmed, signal) => engine.applyLostIds(plugin, plan, confirmed, signal),
        edit(f, value) { state.leaves.push({ view: Object.assign(new MarkdownView(), { file: f,
            data: f.text, getMode: () => "source", getViewData: () => value }) }); } };
}
module.exports = { host, file, note };
