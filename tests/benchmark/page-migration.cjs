// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const { performance } = require("node:perf_hooks");
const { SourceTextModule, SyntheticModule } = require("node:vm");
const source = require("../../Build/overlay-source.cjs");

async function load() {
    const cache = new Map();
    cache.set("obsidian", new SyntheticModule(["parseYaml"], function () {
        this.setExport("parseYaml", raw => {
            const props = {};
            for (const row of raw.trim().split(/\r?\n/u)) {
                const pair = /^(noteId|deckID|deckType): (\d+|card)$/u.exec(row);
                if (!pair) throw new Error("Unexpected YAML: " + row);
                props[pair[1]] = pair[2] === "card" ? "card" : Number(pair[2]);
            }
            return props;
        });
    }));
    cache.set("ts-md5", new SyntheticModule(["Md5"], function () { this.setExport("Md5", {}); }));
    const get = specifier => {
        if (!cache.has(specifier)) {
            const ts = readFileSync(source.file(specifier.slice(2) + ".ts"), "utf8");
            cache.set(specifier, new SourceTextModule(stripTypeScriptTypes(ts, { mode: "transform" }), { identifier: specifier }));
        }
        return cache.get(specifier);
    };
    const router = get("./page-migration-router");
    await router.link(get);
    await router.evaluate();
    return { ...router.namespace, ...get("./page-card").namespace };
}

const family = [
    ["yanki", "Yanki - Basic", (q, a, id) => "---\nnoteId: " + id + "\n---\n" + q + "\n\n---\n\n" + a],
    ["flashcards", "Obsidian-basic", (q, a, id) => q + "::" + a + " ^" + id],
    ["deck-to-anki", "ob-deck-basic", (q, a, id) => "---\ndeckType: card\ndeckID: " + id + "\n---\n" + q + "\n---\n" + a],
    ["obsidian-to-anki", "Basic", (q, a, id) => "START\nBasic\nFront: " + q + "\nBack: " + a + "\n<!--ID: " + id + "-->\nEND"],
];
const data = Array.from({ length: 20_000 }, (_, index) => {
    const [origin, model, format] = family[index % family.length];
    const path = "Cards/" + index + ".md";
    const id = 1700000000000 + index;
    const front = "Вопрос о городе " + index + "?";
    const back = "Город " + index;
    return { origin, path, id, front, back, text: format(front, back, id), route: { model, deck: "World::Cities" } };
});
const auto = { source: "auto", yankiInstalled: true, t: en => en };
const rules = { Basic: "some-existing-regexp" };
function measure(runtime, data) {
    const beginning = performance.now();
    const items = data.map(sample => runtime.inspectMigrationFile(sample.path, sample.text, auto));
    const scanned = performance.now();
    const texts = items.map((item, i) => {
        const sample = data[i];
        if (item?.status !== "candidate" || item.source !== sample.origin || item.id !== sample.id) throw Error("Source " + sample.path);
        return runtime.renderMigrationPage(sample.text, { ...item, linkedRoute: sample.route, preservedTags: ["cities"] }, "Fallback");
    });
    const converted = performance.now();
    const seen = new Set();
    for (const [i, text] of texts.entries()) {
        const sample = data[i];
        const page = runtime.readPageCard(text, rules, undefined, "Fallback");
        const repeat = runtime.inspectMigrationFile(sample.path, text, auto);
        if (repeat.status !== "already" || repeat.id !== sample.id || page.id !== sample.id ||
            page.model !== sample.route.model || page.linkedRoute.deck !== sample.route.deck ||
            page.front !== sample.front || page.back !== sample.back || seen.has(page.id)) throw Error("Second scan " + sample.path);
        seen.add(page.id);
    }
    assert.equal(seen.size, data.length);
    const done = performance.now();
    return { discovery: scanned - beginning, renderWithValidation: converted - scanned, rereadAndRepeat: done - converted, total: done - beginning };
}

(async () => {
    const runtime = await load();
    measure(runtime, data.slice(0, 400));
    const rounds = [];
    for (let run = 0; run < 5; run++) { if (global.gc) global.gc(); rounds.push(measure(runtime, data)); }
    const ms = {};
    for (const key of Object.keys(rounds[0])) {
        const times = rounds.map(run => run[key]).sort((a, b) => a - b);
        ms[key] = { min: +times[0].toFixed(1), median: +times[2].toFixed(1), max: +times[4].toFixed(1) };
    }
    console.log(JSON.stringify({ node: process.version, cards: data.length, rounds: rounds.length, ms }, null, 2));
})().catch(err => { console.error(err); process.exitCode = 1; });
