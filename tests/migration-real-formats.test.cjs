// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const pageFile = require("./benchmark/page-file.cjs");
const { load } = require("./benchmark/migration-modules.cjs");

const real = [
    "page-migration", "page-migration-router", "page-migration-context", "migrate-rudonium-page",
    "migrate-yanki", "migrate-flashcards", "migrate-deck", "migrate-forge-bridge", "migrate-ast-exporter",
    "migration-markdown", "page-card", "card-format-presets", "portable-parser", "audit-repair-match",
    "markdown-pipeline", "duplicate-markers", "id-marker-literals", "anki-id-marker", "card-preview-metadata",
    "export-recovery", "bidirectional-markdown", "bidirectional-blocks", "bidirectional-fields", "linked-bullets",
    "export-rules", "deck-routes", "card-source-link-fields", "card-export-diagnostics", "interface-language",
    "constants", "anki", "file",
];
// Data models belong to this test collection, including layouts whose first field is a service key.
const layouts = {
    Basic: ["Front", "Back"], Archive: ["Front", "Back", "Source"],
    Forge: ["ForgeKey", "Context", "Front", "Back"], Bridge: ["CardKey", "Question", "Answer", "Context"],
    "Yanki - Basic": ["Front", "Back"], "Obsidian-basic": ["Front", "Back"],
    "ob-deck-basic": ["ob-deck-id", "ob-deck-front", "ob-deck-back"],
};
function pairFor(model) {
    if (model === "ob-deck-basic") return ["ob-deck-front", "ob-deck-back"];
    return model === "Bridge" ? ["Question", "Answer"] : ["Front", "Back"];
}
function remote(id, model, deck, front, back, tags = ["retained"]) {
    const [frontName, backName] = pairFor(model);
    const fields = Object.fromEntries(layouts[model].map((name, order) => [name, {
        order, value: name === frontName ? front : name === backName ? back : "unchanged service data",
    }]));
    return { deck, note: { noteId: id, modelName: model, fields, tags, cards: [id + 1000] } };
}
const base = { template: { deckName: "Knowledge", tags: [] }, folder_tags: {}, folder_decks: {}, add_file_link: false,
    add_context: false, NOTE_REGEXP: /(?!)/g, INLINE_REGEXP: /(?!)/g, EMPTY_REGEXP: /(?!)/g };

// Obsidian supplies YAML parsing; this fixture uses only its documented scalar and string-array properties.
function parseYaml(raw) {
    const props = {};
    for (const line of raw.trim().split(/\r?\n/u).filter(Boolean)) {
        const match = /^([\w-]+):\s*(.*?)\s*$/u.exec(line);
        assert.ok(match, "Unexpected fixture YAML " + line);
        props[match[1]] = match[2].startsWith("[") || match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
    }
    return props;
}

async function setup(files, collection) {
    const calls = [], backups = [], handlers = new Map();
    const platforms = new Set([".obsidian-anki-bridge/data.json", ".obsidian/plugins/anki-forge/data.json", ".obsidian/plugins/yanki/manifest.json"]);
    let revision = 0;
    const byPath = new Map(files.map(f => [f.path, f]));
    const vault = {
        configDir: ".obsidian", getName: () => "Vault", getMarkdownFiles: () => files, read: async f => f.text,
        getAbstractFileByPath: p => byPath.get(p), adapter: { exists: async p => platforms.has(p),
            read: async p => { assert.equal(p, ".obsidian/plugins/yanki/manifest.json"); return JSON.stringify({ id: "yanki" }); } },
        on(kind, handler) { const ref = { kind, handler }; handlers.set(ref, ref); return ref; },
        offref(ref) { handlers.delete(ref); },
        async process(f, modify) {
            assert.ok(backups.length, "Every file write must follow the backup");
            f.text = modify(f.text); revision++;
            for (const { kind, handler } of handlers.values()) if (kind === "modify") handler(f);
        },
    };
    const plugin = { fields_dict: layouts, settings: { CUSTOM_REGEXPS: { Basic: "other format" }, Defaults: { Deck: "Knowledge" }, Syntax: {} },
        saveAllData: async () => {}, app: { vault, metadataCache: { getCache: () => ({}) },
            workspace: { getLeavesOfType: () => [] }, plugins: { enabledPlugins: new Set() } } };
    const api = {
        parseYaml, MarkdownView: class {}, hasPendingAnkiWrite: () => false, hasPendingBidirectionalWrite: () => false,
        settingsWithoutAuditMode: s => s, scanProfileFreeSettings: s => s, isSyncAuditReportPath: () => false,
        settingToData: (_app, s, fields) => ({ ...base, fields_dict: fields, page_model: s.PAGE_MODEL, custom_regexps: s.CUSTOM_REGEXPS, page_id_location: s.PAGE_ID_LOCATION }),
        withFastScanReadLock: async (_p, fn) => fn(() => revision),
        requireExpectedAnkiProfile: async (_p, expected) => { if (expected) assert.equal(expected, "User"); return "User"; },
        createFullMigrationBackup: async () => { backups.push(files.map(f => f.text)); return "/verified/Obsidian.zip"; },
        async auditRead(action, params) {
            calls.push(action);
            if (action === "modelFieldNames") return layouts[params.modelName];
            if (action === "modelTemplates") {
                const pair = pairFor(params.modelName);
                return { Card: { Front: "{{" + pair[0] + "}}", Back: "{{FrontSide}}<hr>{{" + pair[1] + "}}" } };
            }
            if (action === "findNotes") return collection.map(({ note }) => note.noteId);
            if (action === "notesInfo") return params.notes.map(id => structuredClone(collection.find(r => r.note.noteId === id)?.note || null));
            if (action === "getDecks") {
                const groups = {};
                for (const card of params.cards) {
                    const { deck } = collection.find(r => r.note.cards.includes(card));
                    (groups[deck] ??= []).push(card);
                }
                return groups;
            }
            assert.fail("Unexpected or mutating AnkiConnect call " + action);
        },
    };
    // Execute the actual injected AllFile page methods. Replace only upstream RegexNote's HTML renderer.
    const modules = await load(real, api, { file: pageFile().replace("from './page-card.mjs'", "from './page-card'"), anki: "export {}" });
    const engine = modules["page-migration"];
    return { plugin, backups, calls,
        preview: (folder, model = "Basic") => engine.previewPageMigration(plugin, { folder, model, checkMissingIds: true }),
        apply: (plan, paths, links) => engine.applyPageMigration(plugin, plan, new Set(paths), undefined, undefined, undefined, false, links),
        read: text => modules["page-card"].readPageCard(text, {}, undefined, plugin.settings.PAGE_MODEL),
        portable: f => modules["portable-parser"].parsePortableMarkdown(plugin.app, api.settingToData(null, plugin.settings, layouts), f, f.text,
            [modules["page-card"].readPageCard(f.text, {}, undefined, plugin.settings.PAGE_MODEL).id], { preview: true }),
    };
}
const file = (path, text) => ({ path, text });

for (const location of ["heading", "yaml", "after-answer"]) test("preview, confirm, apply, export and rerun for seven foreign source plugins with ID in " + location, async () => {
    const bridgeDeck = name => "Obsidian Flashcards::Vault::Bridge::" + name;
    const uuid = "91abe107-bcfe-47ad-b008-775faff1f444";
    const source = [
        file("General/Native.md", "# Native Q #anki-page\r\n<!--rudonium-page-route: [\"Archive\",\"Personal::Saved\"]-->\r\n\r\nNative A\r\n"),
        file("General/Exporter.md", "<!-- anki-note-id:2002 -->\nExporter Q :: Exporter A\n"),
        file("General/AST.md", "---\nAnkiSync: on\ntarget_anki_deck: Cities\n---\n#### AST Q\n:::\nAST A\n<!--anki-id: " + uuid + "-->\n"),
        file("Forge/Word.md", "---\nanki-deck: Vocabulary\n---\nForge Q::Forge A\n^af-k3f8x2m1qz\n"),
        file("Bridge/Basic.md", "Bridge Q ⇢%%oab:basic:v1%% Bridge A\n"),
        file("Bridge/Dump.md", "Dump Q ⇢{%%oab:dump:v1%%\nOne line\nTwo lines\n}⇠%%oab:end:v1%%\n"),
        file("Other/Yanki.md", "---\nnoteId: 2007\naliases: [\"kept\"]\n---\nYanki Q\n\n---\n\nYanki A\n"),
        file("Other/Flashcards.md", "Flash Q::Flash A ^1700000000208\n"),
        file("Other/Deck.md", "---\ndeckType: card\ndeckID: 2009\n---\nDeck Q\n---\nDeck A\n"),
        file("Other/OTA.md", "START\nBasic\nFront: OTA Q\nBack: OTA A\n<!--ID: 2010 | 2026-11-19-->\nEND\n"),
    ];
    const collection = [
        remote(2001, "Archive", "Personal::Saved", "Native Q", "Native A"), remote(2002, "Archive", "Exports", "Exporter Q", "Exporter A"),
        remote(2003, "Basic", "Cities", "AST Q", "AST A"), remote(2004, "Forge", "Vocabulary", "Forge Q", "Forge A"),
        remote(2005, "Bridge", bridgeDeck("Basic"), "Bridge Q", "Bridge A"), remote(2006, "Bridge", bridgeDeck("Dump"), "Dump Q", "One line\nTwo lines"),
        remote(2007, "Yanki - Basic", "Cities", "Yanki Q", "Yanki A"),
        remote(1700000000208, "Obsidian-basic", "Cities", "Flash Q", "Flash A"),
        remote(2009, "ob-deck-basic", "Cities", "Deck Q", "Deck A"),
        remote(2010, "Basic", "Cities", "OTA Q", "OTA A"),
    ];
    const saved = structuredClone(collection);
    const h = await setup(source, collection);
    h.plugin.settings.PAGE_ID_LOCATION = location;
    for (const [scope, model] of [["General", "Basic"], ["Forge", "Forge"], ["Bridge", "Bridge"], ["Other", "Basic"]]) {
        const originals = source.map(f => f.text);
        const scoped = source.filter(f => f.path.startsWith(scope + "/"));
        const touched = scoped.filter(f => f !== source[0] && f !== source[9]);
        const plan = await h.preview(scope, model);
        assert.equal(plan.rows.length, scoped.length);
        for (const f of scoped.filter(f => !touched.includes(f))) assert.equal(plan.rows.find(r => r.path === f.path).status,"already");
        const links = new Map();
        for (const f of touched) {
            const index = source.indexOf(f), row = plan.rows.find(r => r.path === f.path);
            assert.equal(row.status, index === 1 || index >= 6 ? "ready" : "link", f.path + " — " + row.reason);
            if (row.link) { assert.equal(row.link.id, collection[index].note.noteId); links.set(f.path, row.link.id); }
        }
        if (links.size) await assert.rejects(h.apply(plan, touched.map(f => f.path)), /Confirm each proposed/);
        assert.deepEqual(source.map(f => f.text), originals);
        const result = await h.apply(plan, touched.map(f => f.path), links);
        assert.equal(result.stopped, undefined, result.stopped);
        assert.deepEqual([...result.converted], touched.map(f => f.path));
        assert.deepEqual(h.backups.at(-1), originals);
        for (const f of touched) {
            const { deck, note } = collection[source.indexOf(f)];
            const page = h.read(f.text);
            assert.equal(page.id, note.noteId);
            assert.equal(page.idLocation,location);
            assert.deepEqual({ ...page.linkedRoute }, { model: note.modelName, deck });
            assert.equal(f.text, plan.rows.find(row => row.path === f.path).after);
            if (location === "yaml") {
                assert.match(f.text, new RegExp("^anki-page-ID: ['\"]?" + String(note.noteId) + "['\"]?(?: #.*)?$", "m"));
                assert.doesNotMatch(f.text, /<!--ID:|^ID:/mu);
            } else assert.equal(f.text.match(/ID: \d+/gu)?.length, 1);
            const parsed = await h.portable(f);
            const edit = parsed.notes_to_edit;
            assert.equal(edit.length, 1);
            assert.equal(edit[0].identifier, page.id);
            const values = edit[0].note.fields;
            const wanted = pairFor(note.modelName).sort();
            assert.deepEqual(Object.keys(values).sort(), wanted);
            for (const name of wanted) assert.equal(values[name], note.fields[name].value);
            assert.ok(edit[0].note.tags.includes("retained"));
            assert.equal(parsed.all_notes_to_add.length, 0);
        }
        const second = await h.preview(scope, model);
        assert.ok(second.rows.every(row => row.status === "already"));
    }
    assert.equal(source[0].text, "# Native Q #anki-page\r\n<!--rudonium-page-route: [\"Archive\",\"Personal::Saved\"]-->\r\n\r\nNative A\r\n");
    assert.ok(source[6].text.includes('aliases: ["kept"]'));
    assert.match(source[9].text, /^START\n[\s\S]*<!--ID: 2010 \| 2026-11-19-->\nEND\n$/u);
    assert.match(source[3].text, /#anki-page \^af-k3f8x2m1qz/u);
    assert.deepEqual(collection, saved);
});

test("foreign Markdown and exact remote duplicates block linking in the integrated migration path", async () => {
    const ast = (q, id) => "---\nAnkiSync: on\ntarget_anki_deck: Cities\n---\n#### " + q + "\n:::\nA\n<!--anki-id: " + id + "-->\n";
    const candidates = [
        file("In/Occupied.md", ast("Occupied", "e1f28055-a4a7-415f-8a7e-4eda432829b3")),
        file("In/Ambiguous.md", ast("Ambiguous", "dfb2f81d-c437-40e7-a8b5-0ea97d433223")),
        file("Other/Owner.md", "<!-- anki-note-id:3101 -->\nOccupied :: A\n"),
    ];
    const collection = [remote(3101, "Basic", "Cities", "Occupied", "A"),
        remote(3102, "Basic", "Cities", "Ambiguous", "A"), remote(3103, "Basic", "Cities", "Ambiguous", "A")];
    const originals = candidates.map(f => f.text);
    const h = await setup(candidates, collection), p = await h.preview("In");
    assert.deepEqual([...p.rows].map(r => r.status), ["review", "review"]);
    assert.match(p.rows[0].reason, /another Markdown/i);
    assert.match(p.rows[1].reason, /multiple|unique|more than one|several/i);
    await assert.rejects(h.apply(p, [candidates[0].path], new Map([[candidates[0].path, 3101]])), /stale/i);
    assert.deepEqual(candidates.map(f => f.text), originals);
    assert.equal(h.backups.length, 0);
});

test("an archived ID remains occupied when its Anki note reappears after Undo", async () => {
    const { wrapArchivedCard } = (await load(["archived-card"], {}))["archived-card"];
    for (const mode of ["mark", "strike", "hidden"]) {
        const archived = wrapArchivedCard("- Former question :: A\n<!--ID: 3101-->", 3101, "Deleted from Anki", false, "\n", mode);
        const documents = [
            file("In/Relink.md", "---\nAnkiSync: on\ntarget_anki_deck: Cities\n---\n#### Occupied\n:::\nA\n<!--anki-id: e1f28055-a4a7-415f-8a7e-4eda432829b3-->\n"),
            file("Archive/Old.md", archived),
        ];
        const h = await setup(documents, [remote(3101, "Basic", "Cities", "Occupied", "A")]);
        const preview = await h.preview("In");
        assert.equal(preview.rows.length, 1);
        assert.equal(preview.rows[0].status, "review");
        assert.match(preview.rows[0].reason, /another Markdown/i);
        assert.equal(documents[1].text, archived);
        assert.deepEqual(h.backups, []);
    }
});

test("copied page IDs are reserved across the chosen folder, including existing and malformed pages", async () => {
    const docs = [
        file("In/Native.md", "---\nanki-page-ID: '2751'\n---\n# Original #anki-page\nAnswer\n"),
        file("In/Foreign.md", "<!-- anki-note-id:2751 -->\nOriginal :: Answer\n"),
        file("In/Invalid.md", "---\nanki-page-ID: invalid\n---\n# Broken #anki-page\nAnswer\n"),
        file("In/Orphan.md", "---\nanki-page-ID: '2752'\n---\n# Lost marker\nAnswer\n"),
        file("Elsewhere/Legacy.md", "# Copy #anki-page\nID: 2751\nAnswer\n"),
    ];
    const h = await setup(docs, [remote(2751, "Basic", "Original", "Original", "Answer")]);
    const original = docs.map(f => f.text);
    const preview = await h.preview("In");
    assert.equal(preview.rows.length, 4);
    for (const row of preview.rows) {
        assert.equal(row.status, "review", row.path + " " + row.reason);
        assert.ok(row.reason);
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(docs.map(f => f.text), original);
    assert.deepEqual(h.backups, []);
});

test("native blocks containing local-notes boundaries remain untouched", async () => {
    const answer = "Vienna\n<!--rudonium-answer-end-->\nAnother paragraph to keep";
    const before = ["START", "Basic", "Front: Which city?", "Back: " + answer, "<!--ID: 2012-->", "END"].join("\n");
    const source = file("In/Old.md", before);
    const collection = [remote(2012, "Basic", "Cities", "Which city?", answer)];
    const snapshot = structuredClone(collection), h = await setup([source], collection);
    for (const placement of ["heading", "yaml", "after-answer"]) {
        h.plugin.settings.PAGE_ID_LOCATION = placement;
        const plan = await h.preview("In");
        assert.equal(plan.rows.length, 1);
        assert.equal(plan.rows[0].status, "already");
        assert.equal(plan.rows[0].after, undefined);
        await assert.rejects(h.apply(plan, [source.path]), /stale/i);
    }
    assert.equal(source.text, before);
    assert.deepEqual(collection, snapshot);
    assert.deepEqual(h.backups, []);
});
