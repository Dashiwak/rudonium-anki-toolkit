// SPDX-License-Identifier: GPL-3.0-only
// Уведомления о происхождении: NOTICE.md в корне комплекта.
"use strict";

// Изолированная проверка общего формата ID. Obsidian и Anki не запускаются.
const assert = require("node:assert/strict");
const overlay = require("../Build/overlay-source.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { stripTypeScriptTypes } = require("node:module");
const { spawnSync } = require("node:child_process");

async function run() {
    if (typeof stripTypeScriptTypes !== "function") throw new Error("Tests require Node.js 22.18 or newer.");
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-id-tests-"));
    try {
        const modulePath = path.join(temporary, "anki-id-marker.mjs");
        for (const name of ["suspend-label", "page-frontmatter", "id-marker-literals", "anki-id-marker"]) {
            const source = fs.readFileSync(overlay.file(name + ".ts"), "utf8")
                .replace(/from '([.]\/[^']+)'/g, "from '$1.mjs'");
            fs.writeFileSync(path.join(temporary, name + ".mjs"), stripTypeScriptTypes(source));
        }
        const { ankiIdRegexpSource, dateLinkedMarkers: applyDates, parseAnkiIdMarker: parse, compatibleAnkiIdRegexp: upgrade, ankiIdNumberTokens: numbers } = await import(pathToFileURL(modulePath).href);
        const nid = 1700000000104;
        let checks = 0;
        for (const shell of ["ID: %", "<!--ID: %-->", "  <!-- ID: % -->  "]) {
            for (const suffix of ["", " 2026-11-19", " | 2026-11-19", "|2026-11-19", "| 2026-11-19"]) {
                const text = shell.replace("%", nid + suffix);
                const marker = parse(text);
                assert.equal(marker.id, nid);
                assert.equal(marker.warning, undefined);
                assert.equal(text.slice(marker.idFrom, marker.idTo), String(nid));
                checks++;
            }
        }
        for (const value of ["1", "123456789012", "12345678901234", "9007199254740991"]) {
            assert.equal(parse("ID: " + value).digits, value); checks++;
        }
        for (const value of ["0", "-123", "+123", "123.45", "123e3", "9007199254740992", "Infinity", ""]) {
            assert.equal(parse("ID: " + value), undefined); checks++;
        }
        for (const date of ["", "bad-date", "2026-02-30", "1900-02-29"]) {
            const marker = parse(`<!--ID: ${nid} | ${date}-->`);
            assert.equal(marker.id, nid);
            assert.ok(marker.warning); checks++;
        }
        assert.equal(parse(`ID: ${nid} | 2000-02-29`).date, "2000-02-29"); checks++;
        for (const eol of ['\n','\r\n']) for (const suffix of ['!?',' * ☆ (важно)', 'слово', '#tag', ':', ' | пометка', ' ! 2024-02-29 конец', '! | 2024-02-29#tag']) {
            for (const [prefix, close] of [['',''], ['<!--','-->']]) {
                const row = prefix + 'ID: ' + nid + suffix + close;
                const marker = parse(row);
                assert.equal(marker.id, nid, row);
                const before = ['- Q :: A', 'SUSPEND_2', row, '- next :: value', 'ID: 64'].join(eol);
                const date = suffix.includes('2024') ? '2024-02-29' : '2026-11-20';
                const annotation = suffix.replace(/(?: \| | )2024-02-29/u,'');
                const after = before.replace(row, prefix + 'ID: ' + nid + ' | ' + date + annotation + close);
                const marked = [{id:nid,line:3},{id:64,line:5}];
                const once = applyDates(before, marked, new Set([nid]), '2026-11-20');
                assert.equal(once, after);
                assert.equal(applyDates(once, marked, new Set([nid]), '2027-01-01'), after);
                checks++;
            }
        }
        const external = '<!--ID: 24 --> #old | 2024-02-29!';
        assert.equal(applyDates(external,[{id:24,line:1}], new Set([24]), '2026-11-20'), '<!--ID: 24 | 2024-02-29 --> #old!');
        checks++;
        const linkedPattern = require('../Build/install.cjs').patchRegexNoteId('const id_str = search_id ? ID_REGEXP_STR : ""');
        const rhs = linkedPattern.match(/const id_str = ([^\n]+)/u)[1];
        const generatedSuffix = new Function('ankiIdRegexpSource', 'search_id', 'return ' + rhs)(ankiIdRegexpSource, true);
        for (const marker of ['ID: 141!?','<!--ID: 141-->#saved','ID: 141 | 2022-05-01/ok']) {
            const raw = 'Q: x\r\n ' + marker;
            const match = new RegExp('^Q: (.+)$' + generatedSuffix, 'gm').exec(raw);
            assert.equal(match[0], raw);
            assert.deepEqual(match.slice(1), ['x','141']); checks++;
        }
        const stock = /^START\n(Basic)\n([^\n]+)\n([^\n]+)\nEND(?:\nID: (\d+))?$/gm;
        for (const marker of [`ID: ${nid}|`, `<!--ID: ${nid} | bad-date-->`, `ID: ${nid} 2026-11-19`]) {
            const match = [...`START\nBasic\nQ\nA\nEND\n${marker}`.matchAll(upgrade(stock))][0];
            assert.deepEqual(match.slice(1), ["Basic", "Q", "A", String(nid)]); checks++;
        }
        for (const literal of ['<span title="<!--ID: 123-->">example</span>', String.raw`\<!--ID: 123-->`, '<span\n title="<!--ID: 123-->">example</span>']) {
            assert.deepEqual(numbers(literal + `\n<!--ID: ${nid} | 2026-11-19-->`), [nid]); checks++;
        }
        const installer = fs.readFileSync(path.join(__dirname, "../Build/install.cjs"), "utf8");
        const writer = /function formatLocalIdDate\(date: Date\): string \{[\s\S]*?\n\}/.exec(fs.readFileSync(overlay.file("anki-id-marker.ts"), "utf8"));
        assert.ok(writer && installer.includes("import { formatLocalIdDate }"), "The installer must use the shared local-date writer.");
        const dateCode = stripTypeScriptTypes(writer[0]) + '\nprocess.stdout.write(formatLocalIdDate(new Date("2026-11-19T00:30:00Z")));';
        for (const [zone, expected] of [["Europe/Vienna", "2026-11-19"], ["America/Los_Angeles", "2026-11-18"]]) {
            const result = spawnSync(process.execPath, ["-e", dateCode], { encoding: "utf8", env: { ...process.env, TZ: zone } });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, expected); checks++;
        }
        console.log(`PASS ${checks} ID-format cases. Native TypeScript, Rollup and desktop acceptance are separate checks.`);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
