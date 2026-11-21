// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const { before, test } = require("node:test");
const { SourceTextModule, SyntheticModule } = require("node:vm");
const overlay = require("../Build/overlay-source.cjs");

const yamlFixtures = new Map();
const automatic = { source: "auto", yankiInstalled: true, t: en => en };
const file = "Study/Vienna.md";
const id = 1700000000123;
let router, pages, tags, presets, markers, markdown;

test("restore an orphaned page with a separate page tag, named fields and private notes in each ID layout", () => {
    const text = "# Question\n#anki-page\nAnswer\n<!--anki-fields-->\nOrigin: Source\nLine two\n<!--rudonium-answer-end-->\nPersonal";
    const candidate = router.inspectMigrationFile(file, text, automatic);
    assert.equal(candidate.source, "rudonium");
    assert.equal(candidate.status, "candidate");
    for (const location of ["heading", "yaml", "after-answer"]) {
        const updated = router.renderMigrationPage(text, { ...candidate, id }, "Basic", true, location);
        const page = pages.readPageCard(updated, { Basic: "@page" });
        assert.equal(page.id, id);
        assert.equal(page.idLocation, location);
        assert.equal(page.front, "Question");
        assert.equal(page.back, "Answer");
        assert.equal(page.namedFields.get("Origin").value, "Source\nLine two");
        assert.ok(updated.includes("#anki-page\n"));
        assert.ok(updated.endsWith("<!--rudonium-answer-end-->\nPersonal"));
    }
});

before(async () => {
    const modules = new Map();
    // Only the desktop YAML service and unused recovery-hash dependency are supplied by the host.
    modules.set("obsidian", new SyntheticModule(["parseYaml"], function () {
        this.setExport("parseYaml", raw => {
            assert.ok(yamlFixtures.has(raw), "unexpected fixture YAML: " + raw);
            return yamlFixtures.get(raw);
        });
    }));
    modules.set("ts-md5", new SyntheticModule(["Md5"], function () { this.setExport("Md5", {}); }));
    function resolve(specifier) {
        if (!modules.has(specifier)) {
            assert.match(specifier, /^\.\/[\w-]+$/u);
            const source = readFileSync(overlay.file(specifier.slice(2) + ".ts"), "utf8");
            modules.set(specifier, new SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }), { identifier: specifier }));
        }
        return modules.get(specifier);
    }
    const names = ["page-migration-router", "page-card", "bidirectional-markdown", "card-format-presets", "duplicate-markers", "migration-markdown"];
    const imported = [];
    for (const name of names) {
        const mod = resolve("./" + name);
        if (mod.status === "unlinked") await mod.link(resolve);
        if (mod.status === "linked") await mod.evaluate();
        imported.push(mod.namespace);
    }
    [router, pages, tags, presets, markers, markdown] = imported;
});

function yaml(lines, value, body) {
    yamlFixtures.set(lines, value);
    return "---\r\n" + lines + "---\r\n" + body;
}

test("linked pages from four sources retain their ID, route, tags and editable offsets on a second scan", () => {
    const front = "Which city?";
    const back = "Vienna";
    const samples = [
        { source: "yanki", model: "Yanki - Basic", text: yaml("noteId: " + id + "\r\n", { noteId: id }, front + "\r\n\r\n---\r\n\r\n" + back) },
        { source: "flashcards", model: "Obsidian-basic", text: front + "::" + back + " ^" + id },
        { source: "deck-to-anki", model: "ob-deck-basic", text: yaml("deckType: card\r\ndeckID: " + id + "\r\n",
            { deckType: "card", deckID: id }, front + "\r\n---\r\n" + back) },
        { source: "obsidian-to-anki", model: "Basic", text: "START\nBasic\nFront: " + front + "\nBack: " + back +
            "\n<!--ID: " + id + " | 2026-11-19-->\nEND" },
    ];
    const deck = 'Cities::"Central" <Europe>';
    for (const { source, model, text } of samples) {
        const item = router.inspectMigrationFile(file, text, automatic);
        assert.equal(item.source, source);
        assert.equal(item.status, "candidate");
        assert.equal(item.id, id);
        const route = { model, deck };
        const migrated = router.renderMigrationPage(text, { ...item, linkedRoute: route, preservedTags: ["Europe::Austria", "A<B>", "Europe::Austria"] }, "Fallback",true,"heading");
        const page = pages.readPageCard(migrated, { "New cards": "@page" });
        assert.deepEqual(page.linkedRoute, route);
        assert.equal(page.model, model);
        assert.equal(page.front, front);
        assert.equal(page.back, back);
        assert.equal(page.id, id);
        const block = pages.pageBlock(page);
        for (const [name, expected] of [["Front", front], ["Back", back]]) {
            const span = block.explicitFields.get(name);
            assert.equal(migrated.slice(span.start, span.end), expected);
        }
        assert.deepEqual(tags.reconcileCardTags(["inherited"], tags.readCardTagOverride(migrated, block)), ["inherited", "Europe::Austria", "A<B>"]);
        assert.deepEqual(router.inspectMigrationFile(file, migrated, automatic), { source: "rudonium", status: "already", id });
        if (source === "deck-to-anki") assert.deepEqual(page.fieldPair, ["ob-deck-front", "ob-deck-back"]);
        if (source === "flashcards") assert.match(migrated, /#anki-page \^1700000000123/u);
        if (source === "obsidian-to-anki") assert.match(migrated, /<!--ID: 1700000000123 \| 2026-11-19-->/u);
    }
});

test("a fallback page model coexists with a regular expression and an existing @page rule takes precedence", () => {
    const remnote = presets.cardFormatPresets.find(preset => preset.id === "remnote");
    const rules = { Basic: remnote.expression };
    const source = "## Capital? #card\nVienna";
    const candidate = router.inspectMigrationFile(file, source, automatic);
    const migrated = router.renderMigrationPage(source, candidate, "Page note");
    assert.equal(pages.readPageCard(migrated, rules), undefined);
    const page = pages.readPageCard(migrated, rules, undefined, "Page note");
    assert.deepEqual([page.model, page.front, page.back, page.id], ["Page note", "Capital?", "Vienna", undefined]);
    assert.equal(pages.readPageCard(migrated, { ...rules, Explicit: "@page" }, undefined, "Page note").model, "Explicit");
    assert.throws(() => pages.readPageCard(migrated, { A: "@page", B: "@page" }, undefined, "Page note"));
    const linked = pages.writePageId(migrated, page, id, false, undefined, "heading");
    assert.match(linked, /#anki-page\nID: 1700000000123\n/u);
    assert.deepEqual(router.inspectMigrationFile(file, linked, automatic), { source: "rudonium", status: "already", id });

    const ordinary = "Capital? :: Vienna\n<!--ID: " + id + "-->";
    assert.equal(pages.readPageCard(ordinary, rules, undefined, "Page note"), undefined);
    assert.equal(router.inspectMigrationFile(file, ordinary, automatic), undefined);
    const records = pages.findPresetBlocks(ordinary, pages.presetReaders(rules), markers.findIdMarkers(ordinary));
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].id, records[0].model, records[0].front, records[0].back], [id, "Basic", "Capital?", "Vienna"]);
});

test("mixed sources, scheduling data and invalid marked pages stay outside the conversion path", () => {
    const mixed = "## Capital? #card\nVienna\n<!--SR:!2026-11-23,5,250-->";
    const reviewed = [
        mixed,
        "Q::A <!--SR:!2026-11-23,5,250-->",
        "START\nBasic (and reversed card)\nFront: Q\nBack: A\nEND",
        "START\nBasic\nFront: Q\nBack: A\nEND\n\nAdditional note outside the card.",
        "# Broken #anki-page\nID: invalid\nAnswer",
        "# Broken #anki-page\nID: 12\n<!--rudonium-page-route: [\"Basic\"]-->\nAnswer",
        "# Broken #anki-page\nID: 12\nAnswer\nID: 13",
    ];
    const vault = new Map(reviewed.map((text, index) => ["Study/" + index + ".md", text]));
    for (const [path, input] of vault) {
        const result = router.inspectMigrationFile(path, input, automatic);
        assert.equal(result?.status, "review", input);
        assert.ok(result.reason);
        assert.throws(() => router.renderMigrationPage(input, result, "Basic"));
    }
    assert.deepEqual([...vault.values()], reviewed);
    assert.match(router.inspectMigrationFile(file, mixed, automatic).reason, /several source formats/iu);
    assert.equal(router.inspectMigrationFile(file, "# My notebook\n\nText.", automatic), undefined);
    assert.equal(router.inspectMigrationFile(file, mixed, { ...automatic, source: "flashcards" }).status, "review");
    const twoIds = yaml("noteId: 42\r\n", { noteId: 42 }, "START\nBasic\nFront: Q\nBack: A\n<!--ID: 37-->\nEND");
    assert.match(router.inspectMigrationFile(file, twoIds, { ...automatic, source: "obsidian-to-anki" }).reason, /another source ID/iu);
    const foreign = "---\nnoteId: 42\ndeckID: 11\nflashcards: { q-123: { nid: 11 } }\n---\nQ::A ^" + id;
    assert.deepEqual(router.foreignMigrationIds(foreign), [42, 11, id]);
});

test("removing source YAML retains inline comments and leaves ambiguous scalars for review", () => {
    const raw = ["---", "test: 'what # value' # question", "flashcards:", "  note: {nid: 12} # old link",
        "cards-deck: \"A # deck\" # deck", "description: original # user setting", "---", ""].join("\r\n");
    const keys = new Set(["test", "flashcards", "cards-deck"]);
    assert.equal(markdown.withoutMigrationKeys(raw, keys), ["---", "# question", "# old link", "# deck",
        "description: original # user setting", "---", ""].join("\r\n"));
    assert.equal(markdown.withoutMigrationKeys("---\ntest: &shared question\nkeep: *shared\n---\n", keys), undefined);
    assert.equal(markdown.withoutMigrationKeys("---\ntest: |-\n  # literal heading\n---\n", keys), undefined);
});

test("recovering a native page keeps the original heading, route, tag overrides, body and line endings", () => {
    const end = "\r\n";
    const header = "\uFEFF---\r\naliases: [Vienna]\r\n---\r\n\r\n  #  Which city?  #anki-page ^travel  " + end;
    const route = { model: "Original", deck: "Cities" };
    const metadata = '<!-- anki-bidirectional-tags: {"add":["Europe"],"remove":[]} -->' + end +
        '<!--rudonium-page-route: ["Original","Cities"]-->' + end;
    const body = end + "Vienna" + end + end + "  Second paragraph." + end;
    const source = header + metadata + body;
    const candidate = router.inspectMigrationFile(file, source, automatic);
    assert.equal(candidate.source, "rudonium");
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.recoverOnly, true);
    assert.equal(candidate.needsLink, true);
    assert.deepEqual(candidate.linkedRoute, route);
    assert.equal(candidate.front, "Which city?");
    assert.equal(candidate.back, "Vienna\n\n  Second paragraph.");
    const restored = router.renderMigrationPage(source, { ...candidate, id, preservedTags: ["Europe"] }, "Fallback", true, "heading");
    assert.equal(restored, header + "<!--ID: " + id + "-->" + end + metadata + body);
    assert.deepEqual(router.inspectMigrationFile(file, restored, automatic), {source:"rudonium", status:"already", id});
    assert.equal(router.inspectMigrationFile(file, header + body, automatic).needsLink, false);
    assert.equal(router.inspectMigrationFile(file, header + "ID: damaged" + end + body, automatic).status, "review");
    assert.equal(router.inspectMigrationFile(file, header + metadata + metadata + body, automatic).status, "review");
    assert.equal(router.inspectMigrationFile(file, header + '<!-- anki-note-id: 123 -->' + end + body, automatic).status, "review");
});

test("external tracking IDs are indexed independently of scope and numeric Anki note IDs", () => {
    const uuid = "A30655E6-1F3E-4C73-8B3B-653CC56FAC74";
    const source = "Q::A\r\n^af-k3f8x2m1qz\r\n<!--anki-id: " + uuid + "-->\r\n<!-- anki-note-id: 1712345678910 -->";
    assert.deepEqual(router.foreignMigrationIds(source), [1712345678910]);
    assert.deepEqual(router.foreignMigrationKeys(source), ["af-k3f8x2m1qz",uuid.toLowerCase()]);
});

test("auto discovery uses a distinct Forge anchor and leaves conflicting source identities for review", () => {
    const card = "City? #card\nVienna\n^af-rudonium082";
    const detected = router.inspectMigrationFile(file, card, automatic);
    assert.equal(detected.status, "candidate");
    assert.equal(detected.source, "anki-forge");
    assert.equal(detected.externalKey, "af-rudonium082");
    const conflicting = yaml("cards-deck: A\r\n", { "cards-deck":"A" }, card);
    assert.equal(router.inspectMigrationFile(file, conflicting, automatic).status, "review");
});

test("a pending source command beside an external anchor stays untouched in migration", () => {
    for (const command of ["SUSPEND", "DELETE", "FROZEN"]) {
        const original = "Which city? #card\nVienna\n" + command + "\n^af-a1b2c3";
        const detected = router.inspectMigrationFile(file, original, { ...automatic, source:"anki-forge" });
        assert.equal(detected.status, "review");
        assert.throws(() => router.renderMigrationPage(original, detected, "Basic"));
    }
});

test("whole-file migration and recovery preserve archived contents and only reserve live foreign identities", () => {
    const end = "\r\n";
    const foreign = 1700000000456;
    const archived = [
        "<!--RUDONIUM-ARCHIVE:" + id + "-->",
        "# Old question #anki-page",
        "<!--ID: " + id + "-->",
        "Old answer",
        "<!--anki-note-id: " + id + "-->",
        "^af-archivedcard",
        "**Deleted from Anki**",
        "<!--/RUDONIUM-ARCHIVE:" + id + "-->",
    ].join(end);
    const page = "\uFEFF---" + end + "noteId: " + id + end + "---" + end + archived;
    assert.equal(router.inspectMigrationFile(file, page, automatic), undefined);
    assert.deepEqual(router.foreignMigrationIds(page), []);
    assert.deepEqual(router.foreignMigrationKeys(page), []);
    const mixed = "## An active question #card" + end + "Active answer" + end + end + archived;
    assert.equal(router.inspectMigrationFile(file, mixed, { ...automatic, source: "flashcards" }).status, "review");
    const links = archived + end + "<!--anki-note-id: " + foreign + "-->" + end + "^af-livekey";
    assert.deepEqual(router.foreignMigrationIds(links), [foreign]);
    assert.deepEqual(router.foreignMigrationKeys(links), ["af-livekey"]);
    assert.throws(() => router.renderMigrationPage(mixed, { source: "flashcards", status: "candidate", front: "Q", back: "A" }, "Basic"), /archived/iu);
});

test("a Flashcards v2 page keeps its anchor, aliases, formatting and verified note ID in frontmatter", () => {
    const crlf = "\r\n", anchor = "q-4e5ca";
    const properties = "aliases: [Capital]\r\n# keep comment\r\nflashcards:\r\n  " + anchor + ":\r\n    nid: " + id + crlf;
    const original = "\uFEFF" + yaml(properties, {aliases:["Capital"], flashcards:{[anchor]:{nid:id}}},
        "## Which city? #card\r\nVienna\r\n^" + anchor + crlf);
    const item = router.inspectMigrationFile(file, original, automatic);
    assert.equal(item.status, "candidate", item.reason);
    const migrated = router.renderMigrationPage(original, item, "Obsidian-basic", true, "yaml");
    assert.ok(migrated.startsWith("\uFEFF---\r\n"));
    assert.ok(migrated.includes("aliases: [Capital]\r\n# keep comment\r\n"));
    assert.ok(migrated.includes("# Which city? #anki-page ^" + anchor + crlf));
    assert.doesNotMatch(migrated, /^(?:flashcards:|ID:|<!--ID:)/mu);
    assert.deepEqual(router.inspectMigrationFile(file,migrated,automatic),{source:"rudonium",status:"already",id});
    const page = pages.readPageCard(migrated,{Basic:"@page"});
    assert.deepEqual([page.front,page.back,page.id], ["Which city?","Vienna",id]);
});

test("migration preserves an author's annotation after a legacy HTML marker when YAML or a footer is preferred", () => {
    const annotated = "<!--ID: " + id + " | 2026-11-19--> ^keep-anchor";
    const text = ["START", "Basic", "Front: Which city?", "Back: Vienna", annotated, "END"].join("\r\n");
    const item = router.inspectMigrationFile(file, text, automatic);
    assert.equal(item.status, "candidate", item.reason);
    for (const preferred of ["yaml", "after-answer"]) {
        const result = router.renderMigrationPage(text,item,"Basic",true,preferred);
        assert.ok(result.includes("# Which city? #anki-page\r\n" + annotated + "\r\n"));
        assert.doesNotMatch(result, /^(?:rudonium-id|anki-page-ID):| @page-->/mu);
        assert.deepEqual(router.inspectMigrationFile(file,result,automatic), {source:"rudonium",status:"already",id});
    }
});

test("reserved page answer boundaries in a foreign answer cannot discard original Markdown during migration", () => {
    const input = ["START", "Basic", "Front: Which city?", "Back: Vienna", "<!--rudonium-answer-end-->", "another paragraph", "END"].join("\n");
    const item = router.inspectMigrationFile(file, input, automatic);
    assert.equal(item.status, "candidate", item.reason);
    assert.throws(() => router.renderMigrationPage(input,item,"Basic",true,"yaml"));
});

test("a native suspended page with a custom control and saved route is already linked in all three ID locations", () => {
    const options = {...automatic,syntax:{"Suspend Line":"ПАУЗА"}};
    const heading = "# Question #anki-page\r\nПАУЗА_2\r\n";
    const route = '<!--rudonium-page-route: ["Basic","Cities"]-->\r\nAnswer\r\n';
    for (const text of [heading + "<!--ID: " + id + "-->\r\n" + route,
        "---\r\nanki-page-ID: '" + id + "'\r\n---\r\n" + heading + route,
        heading + route + "<!--ID: " + id + " @page-->\r\n"]) {
        assert.deepEqual(router.inspectMigrationFile(file,text,options),{source:"rudonium",status:"already",id});
    }
});

test("a signed footer with a missing page heading holds back an apparent foreign import", () => {
    const text = "Q::A\n<!--ID: " + id + " @page-->";
    for (const source of ["auto", "flashcards", "rudonium"]) {
        const result = router.inspectMigrationFile(file,text,{...automatic,source});
        assert.equal(result?.source,"rudonium");
        assert.equal(result.status,"review");
    }
});

test("new migrated links default to YAML and native recovery preserves footer-private annotations", () => {
    const original = "START\nBasic\nFront: Q\nBack: A\nID: " + id + "\nEND";
    const candidate = router.inspectMigrationFile(file,original,automatic);
    const linked = router.renderMigrationPage(original,candidate,"Basic");
    assert.equal(pages.readPageCard(linked,{Basic:"@page"}).idLocation,"yaml");
    const local = "<!--rudonium-answer-end-->\n<!-- anki-bidirectional-tags: private example -->\n";
    const source = "# Q #anki-page\nA\n" + local;
    const unlinked = router.inspectMigrationFile(file,source,automatic);
    assert.equal(unlinked.status,"candidate",unlinked.reason);
    assert.equal(unlinked.back,"A");
    const result = router.renderMigrationPage(source,{...unlinked,id},"Basic",true,"after-answer");
    assert.ok(result.endsWith(local));
    assert.equal(pages.readPageCard(result,{Basic:"@page"}).idLocation,"after-answer");
    assert.equal(router.inspectMigrationFile(file,result,automatic).status,"already");
});

test("missing IDs on imported suspended pages are recovered without placing the custom control in Anki fields", () => {
    const eol = "\r\n", syntax = {"Suspend Line":"PAUSE"};
    const route = '<!--rudonium-page-route: ["Other","Foreign"]-->';
    const text = ["# Q #anki-page","PAUSE_2",route,"","A",""].join(eol);
    const item = router.inspectMigrationFile(file,text,{...automatic,syntax});
    assert.equal(item.status,"candidate",item.reason);
    assert.equal(item.back,"A");
    assert.equal(router.renderMigrationPage(text,item,"Basic",true,"yaml",syntax),"# Q #anki-page"+eol+eol+"A"+eol);
    for (const target of ["heading","yaml","after-answer"]) {
        const result = router.renderMigrationPage(text,{...item,id},"Basic",true,target,syntax);
        const page = pages.readPageCard(result,{Basic:"@page"},syntax);
        assert.equal(page.id,id);
        assert.equal(page.idLocation,target);
        assert.equal(page.back,"A");
        assert.ok(result.includes("PAUSE_2"+eol));
    }
});

test('migrating a foreign file with an unexplained retired YAML property requires review', () => {
    const props = yaml('rudonium-id: 8000\r\nnoteId: 8001\r\n', {'rudonium-id':8000,noteId:8001}, 'Q\r\n\r\n---\r\n\r\nAnswer')
    const item = router.inspectMigrationFile(file, props, automatic)
    assert.equal(item.status,'review')
    assert.match(item.reason,/rudonium-id/)
    assert.equal(router.inspectMigrationFile(file, '# Plain\nThe word rudonium-id.', automatic),undefined)
})
