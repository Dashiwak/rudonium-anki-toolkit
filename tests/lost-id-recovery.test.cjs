// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { file, host, note } = require("./benchmark/lost-id-host.cjs");

function confirmed(rows) { return new Map(rows.map(r => [r.key, r.id])); }
const writable = plan => plan.rows.filter(r => r.status === "match");
const counts = (state, kind) => state.events.filter(item => item.kind === kind);
async function expectRefused(work) {
    let result;
    try { result = await work(); } catch (error) { assert.ok(String(error).length); return; }
    assert.equal(result.restored, 0);
    assert.ok(result.stopped, "Expected an actionable refusal");
}

test("one-time recovery scans pages and individual lines without changes; confirmation preserves neighbors and original Anki notes", async () => {
    const chapter = file("Knowledge/Dictionary.md", "## Wörter\r\n- Straße :: Road\r\n- Буква :: Letter\r\n- Unfinished :: Draft\r\n");
    const page = file("Knowledge/City.md", "# Столица? #anki-page\r\n\r\nВена\r\n");
    const notes = [note(101, "Straße", "Road"), note(102, "Буква", "Letter"), note(103, "Столица?", "Вена")];
    const texts = [chapter.text, page.text], savedNotes = structuredClone(notes);
    const h = await host([chapter, page], notes);
    h.plugin.settings.PAGE_ID_LOCATION = "heading";
    const plan = await h.scan({ deck: "Knowledge" });
    assert.equal(plan.unlinked, 4); assert.equal(plan.unmatched, 1);
    assert.deepEqual(Array.from(writable(plan), r => r.id).sort(), [101, 102, 103]);
    assert.equal(writable(plan).find(r => r.id === 102).line, 3);
    assert.ok(new Set(plan.rows.map(r => r.key)).size === plan.rows.length, "Each card in this file needs its own key");
    assert.equal(h.state.events.some(item => ["write", "backup"].includes(item.kind)), false);
    assert.deepEqual([chapter.text, page.text], texts);
    const selected = writable(plan).filter(r => r.id !== 101);
    const result = await h.apply(plan, confirmed(selected));
    assert.equal(result.stopped, undefined, result.stopped);
    assert.equal(result.restored, 2); assert.equal(result.archive, "/Backups/Obsidian.zip");
    assert.deepEqual(h.state.archive, texts);
    assert.equal(counts(h.state, "backup").length, 1);
    assert.equal(chapter.text, texts[0].replace("Letter", "Letter\r\n<!--ID: 102-->"));
    assert.equal(page.text, texts[1].replace("#anki-page", "#anki-page\r\n<!--ID: 103-->"));
    assert.deepEqual(notes, savedNotes);
    const second = await h.scan({ deck: "Knowledge" });
    assert.deepEqual(Array.from(writable(second), r => r.id), [101]);
    assert.equal(second.unmatched, 1);
});

test("one-time recovery writes the existing note ID to page properties and keeps the original note", async () => {
    const source = file("Knowledge/City.md", "---\r\nregion: city\r\n---\r\n# Question #anki-page\r\nAnswer\r\n");
    const notes = [note(105,"Question","Answer")], before = structuredClone(notes);
    const h = await host([source],notes);
    // The default destination for a newly recovered page link is YAML.
    const plan = await h.scan({ deck:"Knowledge" });
    assert.deepEqual(Array.from(writable(plan),row=>row.id),[105]);
    const result = await h.apply(plan,confirmed(writable(plan)));
    assert.equal(result.restored,1,result.stopped);
    assert.ok(source.text.includes("anki-page-ID: '105'"));
    assert.ok(source.text.includes("region: city\r\n"));
    assert.ok(!source.text.includes("ID: 105"));
    assert.deepEqual(notes,before);
    assert.equal(writable(await h.scan({deck:"Knowledge"})).length,0);
});

test("strict recovery separates new cards from unique links and withholds duplicates, occupied IDs and mismatched fields", async () => {
    const source = file("Knowledge/Deck.md", ["Exact", "Answer differs", "Deck differs", "Model differs", "Ambiguous",
        "Already claimed", "Competing", "Competing", "New"].map(q => "- " + q + " :: Answer\n").join(""));
    const outside = file("Elsewhere/Owner.md", "- Other :: Answer\n<!--ID: 9007-->\n");
    const notes = [note(9001, "Exact"), note(9002, "Answer differs", "Different"),
        note(9003, "Deck differs", "Answer", "Basic", "Other"), note(9004, "Model differs", "Answer", "Other"),
        note(9005, "Ambiguous"), note(9006, "Ambiguous"), note(9007, "Already claimed"), note(9008, "Competing")];
    const h = await host([source, outside], notes), plan = await h.scan({ deck: "Knowledge" });
    assert.deepEqual(Array.from(writable(plan), r => r.id), [9001]);
    for (const q of ["Ambiguous", "Already claimed", "Competing"]) assert.equal(plan.rows.find(row => row.front === q)?.status, "review", q);
    assert.ok(plan.unmatched > 0);
    const row = writable(plan)[0];
    await expectRefused(() => h.apply(plan, new Map([[row.key, 9002]])));
    assert.deepEqual(counts(h.state, "write"), []);
    assert.equal(counts(h.state, "backup").length, 0);
});

test("selection writes multiple lost IDs to the same note in one transaction and refuses a repeat", async () => {
    const source = file("Knowledge/Items.md", "- A :: Answer\n- Linked :: Answer\n<!--ID: 77-->\n- B :: Answer\n");
    const initial = source.text;
    const h = await host([source], [note(71, "A"), note(72, "B"), note(77, "Linked")]);
    const plan = await h.scan(), choice = confirmed(writable(plan));
    const result = await h.apply(plan, choice);
    assert.equal(result.stopped, undefined);
    assert.equal(result.restored, 2);
    assert.equal(counts(h.state, "write").length, 1);
    assert.equal(source.text, initial.replace("- A :: Answer", "- A :: Answer\n<!--ID: 71-->")
        .replace("- B :: Answer", "- B :: Answer\n<!--ID: 72-->"));
    await expectRefused(() => h.apply(plan, choice));
    assert.equal(counts(h.state, "write").length, 1);
});

test("backup errors, changed Anki fields/profile, edited Markdown and unsaved outside claims cannot overwrite the source", async () => {
    for (const scenario of ["backup failed", "remote edited", "profile changed", "source edited", "outside claimed", "dirty before write", "new competing draft"]) {
        const source = file("Knowledge/Source.md", "# Title\n- Target :: Answer\n"), owner = file("Elsewhere/Source.md", "Unrelated\n");
        const n = note(24, "Target"), h = await host([source, owner], [n]);
        const plan = await h.scan(), pick = confirmed(writable(plan));
        assert.equal(pick.size, 1, scenario);
        const original = source.text;
        const claim = () => h.edit(owner, owner.text + "<!--ID: 24-->\n");
        if (scenario === "backup failed") h.state.hooks.backup = () => { throw Error("test backup failure"); };
        if (scenario === "remote edited") h.state.hooks.backup = () => { n.note.fields.Back.value = "changed"; };
        if (scenario === "profile changed") h.state.hooks.backup = () => { h.state.profile = "Another"; };
        if (scenario === "outside claimed") h.state.hooks.backup = claim;
        if (scenario === "dirty before write") h.state.hooks.beforeWrite = claim;
        if (scenario === "new competing draft") h.state.hooks.beforeWrite = () => h.edit(owner, "- Target :: Answer\n");
        if (scenario === "source edited") source.text = source.text.replace("Answer", "intervening edit");
        const current = source.text;
        await expectRefused(() => h.apply(plan, pick));
        assert.equal(source.text, current, scenario);
        assert.equal(counts(h.state, "write").length, 0, scenario);
        if (scenario === "remote edited") assert.equal(n.note.fields.Back.value, "changed");
        if (scenario !== "source edited" && scenario !== "backup failed") assert.deepEqual(h.state.archive, [original, owner.text]);
    }
});

test("20,000-card note checks lost IDs with bounded Anki reads and leaves 19,999 neighbors intact", async t => {
    const size = 20_000, lost = 9999, draft = 5999;
    const lines = Array.from({ length: size }, (_, i) => "- Word " + i + " :: Answer\n" +
        (i === lost || i === draft ? "" : "<!--ID: " + (10_000 + i) + "-->\n"));
    const source = file("Knowledge/Dictionary.md", lines.join(""));
    const notes = Array.from({ length: size }, (_, i) => note(10_000 + i, "Word " + i)).filter(n => n.note.noteId !== 10_000 + draft);
    const initial = source.text, h = await host([source], notes);
    const start = performance.now(), plan = await h.scan(), previewMs = performance.now() - start;
    const links = writable(plan);
    assert.deepEqual(Array.from(links, r => r.id), [10_000 + lost]);
    assert.equal(plan.unlinked, 2); assert.equal(plan.unmatched, 1);
    const inventoryReads = counts(h.state, "notesInfo").length;
    assert.ok(inventoryReads <= 40, "A 20,000-note inventory should need at most 40 batches");
    assert.equal(counts(h.state, "getDecks").reduce((n, e) => n + e.count, 0), 1);
    const applying = performance.now(), result = await h.apply(plan, confirmed(links));
    const applyMs = performance.now() - applying;
    assert.equal(result.stopped, undefined, result.stopped); assert.equal(result.restored, 1);
    assert.equal(source.text, initial.replace("- Word " + lost + " :: Answer\n", "- Word " + lost + " :: Answer\n<!--ID: " + (10_000 + lost) + "-->\n"));
    assert.equal(counts(h.state, "write").length, 1);
    t.diagnostic("20,000 cards with two missing markers; one confirmed restoration. Scan " + previewMs.toFixed(0) +
        " ms, apply " + applyMs.toFixed(0) + " ms. Desktop, AnkiConnect, renderer and ZIP simulated.");
});

test("a recovered page keeps its original route, metadata, line endings and configured dated marker", async () => {
    const page = file("Knowledge/Existing.md", "# Язык? #anki-page\r\n<!--rudonium-page-route: [\"Other\",\"Archive\"]-->\r\n\r\nНемецкий\r\n");
    const original = page.text, h = await host([page], [note(551, "Язык?", "Немецкий", "Other", "Archive")]);
    h.plugin.settings.PAGE_ID_LOCATION = "heading";
    h.plugin.settings.Defaults["Add Date to Anki IDs"] = true;
    const plan = await h.scan();
    assert.equal(writable(plan)[0]?.id, 551);
    const result = await h.apply(plan, confirmed(writable(plan)));
    assert.equal(result.stopped, undefined, result.stopped);
    assert.match(page.text, /#anki-page\r\n<!--ID: 551 \| \d{4}-\d{2}-\d{2}-->\r\n<!--rudonium-page-route:/u);
    assert.equal(page.text.replace(/<!--ID: 551 \| \d{4}-\d{2}-\d{2}-->\r\n/u, ""), original);
});

test("a linked vault or an empty deck performs no recovery lookup, and cancellation cannot edit Markdown", async () => {
    const f = file("Knowledge/Linked.md", "- Already :: Yes\n<!--ID: 42-->\n");
    const h = await host([f], [note(42, "Already", "Yes")]);
    let plan = await h.scan();
    assert.equal(plan.unlinked, 0); assert.equal(plan.rows.length, 0);
    f.text += "- Question :: Answer\n";
    plan = await h.scan({ deck: "Another" });
    assert.equal(plan.unlinked, 0); assert.equal(plan.rows.length, 0);
    assert.deepEqual(h.state.events, []);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(h.scan(undefined, abort.signal), error => error.name === "AbortError");
    assert.deepEqual(h.state.events, []);
});

test("multiple Anki cards from one note can share a restored ID only if all belong to its target deck", async () => {
    const source = file("Knowledge/Reversed.md", "- Forward and back :: Answer\n- Split across decks :: Answer\n");
    const shared = note(71, "Forward and back"), split = note(72, "Split across decks");
    shared.note.cards.push(1_100_071); split.note.cards.push(1_100_072);
    split.cardDecks = { 1100072: "Archive" };
    const original = source.text, notes = [shared, split], initial = structuredClone(notes);
    const h = await host([source], notes), plan = await h.scan({ deck: "Knowledge" });
    assert.deepEqual(Array.from(writable(plan), r => r.id), [71]);
    assert.equal(plan.rows.find(r => r.front === "Split across decks")?.status, "review");
    const result = await h.apply(plan, confirmed(writable(plan)));
    assert.equal(result.stopped, undefined, result.stopped);
    assert.equal(result.restored, 1);
    assert.equal(source.text, original.replace("Forward and back :: Answer", "Forward and back :: Answer\n<!--ID: 71-->"));
    assert.deepEqual(notes, initial);
});

test('ID recovery in a marked multi-card file inserts only the requested neighbor ID at its raw CRLF offset', async () => {
    const before = ['## Cards', '- First :: Answer', 'HOLD_2', '<!--ID: 77-->', '- Target :: Answer', ''].join('\r\n')
    const source = file('Knowledge/Items.md', before)
    const h = await host([source], [note(77, 'First'), note(78, 'Target')])
    h.plugin.settings.Syntax = { ...h.plugin.settings.Syntax, 'Suspend Line': 'HOLD' }
    const plan = await h.scan()
    assert.deepEqual(Array.from(writable(plan), row => [row.id, row.line]), [[78, 5]])
    const result = await h.apply(plan, confirmed(writable(plan)))
    assert.equal(result.restored, 1, result.stopped)
    assert.equal(source.text, before.replace('- Target :: Answer', '- Target :: Answer\r\n<!--ID: 78-->'))
})

test("one-time recovery restores a dated footer, preserving the page route, properties and private tail", async () => {
    const tail = "<!--rudonium-answer-end-->\r\n## Personal notes\r\nPrivate :: Draft\r\n";
    const before = "---\r\naliases: [Capital]\r\n---\r\n# City? #anki-page\r\nPAUSE_2\r\n" +
        '<!--rudonium-page-route: ["Other","Archive"]-->\r\n\r\nVienna\r\n\r\n' + tail;
    const page = file("Knowledge/City.md", before), notes = [note(553, "City?", "Vienna", "Other", "Archive")];
    const h = await host([page], notes), untouched = structuredClone(notes);
    h.plugin.settings.PAGE_ID_LOCATION = "after-answer";
    h.plugin.settings.Syntax["Suspend Line"] = "PAUSE";
    h.plugin.settings.Defaults["Add Date to Anki IDs"] = true;
    const plan = await h.scan();
    assert.deepEqual(Array.from(writable(plan), row => row.id), [553]);
    const result = await h.apply(plan, confirmed(writable(plan)));
    assert.equal(result.stopped,undefined,result.stopped);
    assert.equal(result.restored,1);
    const marker = /<!--ID: 553 \| \d{4}-\d{2}-\d{2} @page-->\r\n/u;
    assert.match(page.text,marker);
    assert.equal(page.text.replace(marker,""),before);
    assert.ok(page.text.endsWith(tail));
    assert.equal(writable(await h.scan()).length,0);
    assert.deepEqual(notes,untouched);
});
