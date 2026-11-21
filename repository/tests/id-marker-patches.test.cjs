// SPDX-License-Identifier: GPL-3.0-only
// Тестирует точку передачи совпадения штатному парсеру на обеих ветвях установщика.
"use strict";
const assert = require("node:assert/strict");
const overlay = require("../Build/overlay-source.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");
const { pathToFileURL } = require("node:url");
const { patchAcceptedMatches } = require("../Build/custom-regexp-patch.cjs");

const finders = ["findignore(regexp, this.file, this.ignore_spans)", "this.file.matchAll(regexp)"];
const parsers = [
    "const parsed = new RegexNote(match).parse();",
    "const note = new RegexNote(match);\nconst parsed = note.parse();",
];
function fixture(finder, constructor) {
    return `
import { checkedCustomAnkiMatches, copyMatchForRegexNote } from './anki-id-marker.mjs';
import { matchesOutsideSpans } from './markdown-pipeline.mjs';
class RegexNote {
    constructor(match) { RegexNote.lastMatch = match; this.id = match.pop(); }
    parse() { return this.id; }
}
export class Parser {
    idDateWarnings = [];
    ignore_spans = [];
    linkedBulletOverlap = () => false;
    results = [];
    search(matches, search_id) {
        for (const match of ${finder}) {
            ${constructor}
            this.results.push(parsed);
            this.lastMatch = RegexNote.lastMatch;
        }
    }
}`;
}
async function run() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-match-loop-"));
    let count = 0;
    try {
        for (const name of ["suspend-label", "page-frontmatter", "id-marker-literals", "anki-id-marker", "markdown-pipeline"]) {
            const source = fs.readFileSync(overlay.file(name + ".ts"), "utf8")
                .replace(/from '([.]\/[^']+)'/g, "from '$1.mjs'");
            fs.writeFileSync(path.join(directory, name + ".mjs"), stripTypeScriptTypes(source));
        }
        for (const finder of finders) for (const constructor of parsers) for (const eol of ["\n", "\r\n"]) {
            const { code, usesClaimedSpans } = patchAcceptedMatches(fixture(finder, constructor).replaceAll("\n", eol));
            assert.equal(usesClaimedSpans, finder === finders[0]);
            const file = path.join(directory, "parser-" + (++count) + ".mjs");
            fs.writeFileSync(file, code);
            const { Parser } = await import(pathToFileURL(file).href);
            const parser = new Parser();
            const text = "Question :: Answer";
            const id = "1700000000104";
            const capture = (...groups) => Object.assign(groups, { index: 0 });
            const example = "prefix " + text;
            const optional = /(?<question>Question) :: (Answer)(R)?/.exec(example);
            parser.file = example;
            parser.search([optional], false);
            assert.equal(parser.results.at(-1), "", "an absent optional field reaches RegexNote as an empty string");
            assert.equal(parser.lastMatch[0], text);
            assert.equal(parser.lastMatch.index, 7);
            assert.equal(parser.lastMatch.input, example);
            assert.deepEqual(parser.lastMatch.groups, optional.groups);
            assert.deepEqual([...optional], [text, "Question", "Answer", undefined]);
            for (const marker of ["ID: " + id, "<!--ID: " + id + " | 2026-11-19-->", "ID: " + id + " 2026-11-19"]) {
                parser.file = text + " " + marker;
                const untouched = capture(parser.file, "question", "answer", "field3", "field4", "TAGS: geo", id);
                parser.search([untouched], true);
                assert.equal(parser.results.at(-1), id);
                assert.deepEqual([...untouched], [parser.file, "question", "answer", "field3", "field4", "TAGS: geo", id],
                    "A parser consuming the ID must not truncate the field groups used by the linked preview");
            }
            for (const bad of ["123e7", "123.45", "-123", "9007199254740992"]) {
                parser.file = text + " ID: " + bad;
                const original = capture(parser.file, bad.match(/\d+/)[0]);
                assert.throws(() => parser.search([original], true), /Invalid Anki ID/);
                assert.equal(original.length, 2, "Проверка должна предшествовать изменению захватов");
                assert.throws(() => parser.search([capture(text)], false), /Invalid Anki ID/);
            }
            const before = parser.results.length;
            parser.ignore_spans = [[0, parser.file.length]];
            parser.search([capture(text)], false);
            parser.ignore_spans = [];
            parser.linkedBulletOverlap = () => true;
            parser.search([capture(text)], false);
            assert.equal(parser.results.length, before, "Занятые совпадения не должны дать ошибку или новую запись");
            parser.linkedBulletOverlap = () => false;
            parser.file = text;
            parser.search([capture(text)], false);
            assert.equal(parser.results.length, before + 1);
            parser.file = text + " ID: " + id + " | bad-date";
            parser.search([capture(parser.file, id)], true);
            assert.deepEqual(parser.idDateWarnings.map(item => item.id), [Number(id)]);
        }
        assert.throws(() => patchAcceptedMatches(""), /Unexpected Custom Regexp match loop/);
        assert.throws(() => patchAcceptedMatches(finders.join("\n")), /Unexpected Custom Regexp match loop/);
        console.log("PASS " + count + " match-loop/constructor/LF-CRLF combinations: numeric links, malformed markers, warnings, excluded matches, and new cards");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
