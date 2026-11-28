// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const test = require("node:test");

async function loadFormatter() {
    const modules = new Map();
    for (const [name, exports] of [["marked", require("marked")], ["highlight.js", { default: require("highlight.js") }]]) {
        modules.set(name, new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }));
    }
    for (const name of ["format", "anki-markdown-renderer", "markdown-pipeline", "constants"]) {
        const code = fs.readFileSync(path.join(__dirname, "../../src", name + ".ts"), "utf8");
        modules.set("./" + name, new vm.SourceTextModule(stripTypeScriptTypes(code), { identifier: name }));
    }
    const entry = modules.get("./format");
    await entry.link(id => modules.get(id));
    await entry.evaluate();
    return entry.namespace.FormatConverter;
}

test("Markdown export matches both complete HTML fields from the upstream Anki fixture", async () => {
    const FormatConverter = await loadFormatter();
    const formatter = new FormatConverter({}, "Vault");
    const markdown = fs.readFileSync(path.join(__dirname, "../defaults/test_vault_suites/markdown_test/markdown_test.md"), "utf8")
        .replace(/\r\n/g, "\n").split("START\nBasic\n")[1].split("\nTags:")[0].split("\n\nBack: ");
    const upstream = fs.readFileSync(path.join(__dirname, "../anki/test_markdown_test.py"), "utf8");
    const fields = [...upstream.matchAll(/^\s*assert note1\.fields\[\d+\] == (".*")\s*$/gm)]
        .map(match => JSON.parse(match[1].replace(/\\'/g, "'")));
    assert.equal(fields.length, 2);
    assert.deepEqual(markdown.map(field => formatter.format(field.trimEnd(), false, false)), fields);
});

test("Markdown export preserves stored HTML for block, single-line, cloze, media and link fields", async () => {
    const FormatConverter = await loadFormatter();
    const formatter = new FormatConverter({
        embeds: [{ original: "![[cats/cat.png]]", link: "cats/cat.png", displayText: "cat.png" }],
        links: [{ original: "[[City|Wien]]", link: "City", displayText: "Wien" }],
    }, "Vault");
    for (const [markdown, expected] of [
        ["Восток-1", "Восток-1"], ["**мир**", "<strong>мир</strong>"],
        ["Question?  \nWhat's next?", "Question?  <br />\nWhat's next?"],
        ["or\nelse", "or<br />\nelse"], ["==mark==", "<mark>mark</mark>"],
        ["Inline $x = 5$", "Inline \\(x = 5\\)"],
        ["[[City|Wien]]", '<a href="obsidian://open?vault=Vault&file=City">Wien</a>'],
        ["![[cats/cat.png]]", '<img src="cat.png" alt="cat.png">'],
        ["![alt](http://example.com/cat.png)", '<img src="http://example.com/cat.png" alt="alt" />'],
        ["a | b\n:---: | ---:\nx | y", '<table>\n<thead>\n<tr>\n<th style="text-align:center;">a</th>\n<th style="text-align:right;">b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td style="text-align:center;">x</td>\n<td style="text-align:right;">y</td>\n</tr>\n</tbody>\n</table>'],
        ["> One\n> Two", "<blockquote>\n  <p>One<br />\n  Two</p>\n</blockquote>"],
        ["- one\n  - two\n- three", "<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>"],
        ["1. one\n   - two\n2. last", "<ol>\n<li>one</li>\n</ol>\n<ul>\n<li>two</li>\n</ul>\n<ol>\n<li>last</li>\n</ol>"],
        ["- one\n    - two\n        - three\n- four", "<ul>\n<li>one<ul>\n<li>two<ul>\n<li>three</li></ul></li></ul></li>\n<li>four</li>\n</ul>"],
        ["```plaintext\n- item\n  - literal\n```", '<link href="https://cdn.jsdelivr.net/npm/highlightjs-themes@1.0.0/arta.css" rel="stylesheet"><pre><code class="hljs plaintext language-plaintext">- item\n  - literal\n</code></pre>'],
        ["# Same\n# Same", '<h1 id="same">Same</h1>\n<h1 id="same-1">Same</h1>'],
        ["Header\nA | B\n-|-\n*1* | 2", "Header<br />\nA | B<br />\n-|-<br />\n<em>1</em> | 2"],
        ["Examples\n1) *first*\n2) second", "Examples<br />\n1) <em>first</em><br />\n2) second"],
        ["1) item", "1) item"],
        ["Wait... **really...**", "Wait… <strong>really…</strong>"],
        ["One\u00a0word; A\tB\tC", "One&nbsp;word; A    B   C"],
        ["[Open...](https://example.org/v.../a)", '<a href="https://example.org/v.../a">Open…</a>'],
        ["`...` and \\.\\.\\.", "<code>...</code> and ..."],
        ["# Same", '<h1 id="same">Same</h1>'],
        ["first\n\nmore\n    ", "first</p>\n<p>more"],
    ]) assert.equal(formatter.format(markdown, false, false), expected, markdown);
    assert.equal(formatter.format("Capital of {Austria} is ==Vienna==.", true, true), "Capital of {{c1::Austria}} is {{c2::Vienna}}.");
});

test("installed glob matcher preserves patterns used by Obsidian_to_Anki", async () => {
    const { default: multimatch } = await import("multimatch");
    const vault = ["A.md", "Cards/Space/Q.md", "Cards/Art/X.md", "Cards/Art/Skip.md", "Cards/Data/X.txt"];
    assert.deepEqual(multimatch(vault, ["**/*.md", "!Cards/Art/**"]), ["A.md", "Cards/Space/Q.md"]);
    assert.deepEqual(multimatch(vault, ["Cards/{Art,Space}/[QX].md"]), ["Cards/Space/Q.md", "Cards/Art/X.md"]);
    assert.deepEqual(multimatch(vault, ["Cards/@(Art|Space)/*.md", "!**/Skip.md"]), ["Cards/Space/Q.md", "Cards/Art/X.md"]);
});
