// SPDX-License-Identifier: GPL-3.0-only
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { bundleNotice, configureRollup } = require("../Build/release-rollup.cjs");
const { copyMaintainedInputs, verifyRuntimeManifest } = require("../Build/build-main.cjs");
const release = require("../manifest.json");
const license = require("../package.json").license;
const notice = bundleNotice(release, license);

function fixture(t, code, type = "commonjs") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-rollup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type }));
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(release));
    const file = path.join(root, "rollup.config.js");
    fs.writeFileSync(file, code);
    configureRollup(root, release, license);
    return { root, file };
}

function verifyNotice(value, inherited) {
    assert.equal(typeof value, "string");
    assert.equal(value.split(notice).length - 1, 1, "Уведомление Rudonium появляется ровно один раз");
    if (inherited) {
        assert.equal(value.split(inherited).length - 1, 1, "Старое уведомление сохранено один раз");
    }
}

test("Два независимых каталога получают идентичный самодостаточный конфиг", t => {
    const code = 'module.exports = { input: "main.ts", output: { format: "cjs", file: "main.js" } };\n';
    const first = fixture(t, code);
    const second = fixture(t, code);
    assert.deepEqual(fs.readFileSync(first.file), fs.readFileSync(second.file));
    assert.ok(notice.includes(release.name) && notice.includes(release.version));
    assert.ok(notice.includes("Pseudonium") && notice.includes("GPL-3.0-only"));
    const content = require(first.file).output.banner;
    verifyNotice(content);
    assert.equal(require(second.file).output.banner, content);
});

test("ES-модуль сохраняет исходный banner и правила external", async t => {
    const { file } = fixture(t, [
        'const banner = "/*! upstream license */";',
        'export default { input: "main.ts", external: ["obsidian", /^another\\//],',
        '    output: { banner, file: "main.js", format: "cjs", sourcemap: true } };',
    ].join("\n"), "module");
    const config = (await import(pathToFileURL(file))).default;
    verifyNotice(config.output.banner, "/*! upstream license */");
    assert.equal(config.output.sourcemap, true);
    assert.equal(config.output.file, "main.js");
    for (const id of ["obsidian", "another/submodule", "@codemirror/view", "fs", "crypto", "stream", "buffer", "worker_threads", "node:sqlite"]) {
        assert.equal(config.external(id), true);
    }
    assert.equal(config.external("ordinary-module"), false);
});

test("Несколько конфигураций и форматов вывода сохраняют собственные баннеры", t => {
    const { file } = fixture(t, [
        'module.exports = [',
        '  { input: "a", output: [{ file: "a.js", banner: "/*! output A */" }, { file: "b.js" }] },',
        '  { input: "b", output: { file: "c.js", banner: "/*! output C */" } },',
        '];',
    ].join("\n"));
    const configs = require(file);
    const [a, b] = configs[0].output;
    const c = configs[1].output;
    assert.deepEqual([a.file, b.file, c.file], ["a.js", "b.js", "c.js"]);
    verifyNotice(a.banner, "/*! output A */");
    verifyNotice(b.banner);
    verifyNotice(c.banner, "/*! output C */");
    assert.ok(!b.banner.includes("output A") && !a.banner.includes("output C"));
});

for (const qualifier of ["", "async "]) {
    const kind = qualifier ? "асинхронный" : "синхронный";
    test("Сохранён " + kind + " генератор прежнего баннера", async t => {
        const { file } = fixture(t, [
            'module.exports = {',
            '  output: {',
            '    file: "main.js",',
            '    banner: ' + qualifier + 'function (chunk) { return "/*! " + this.tag + ":" + chunk.name + " */"; },',
            '  },',
            '};',
        ].join("\n"));
        const render = require(file).output.banner;
        for (const name of ["first", "second"]) {
            verifyNotice(await render.call({ tag: "project" }, { name }), "/*! project:" + name + " */");
        }
    });
}

test("Ошибка исходного генератора баннера остаётся видимой", async t => {
    const { file } = fixture(t,
        'module.exports = { output: { banner: async () => { throw new Error("upstream banner failed"); } } };');
    await assert.rejects(async () => require(file).output.banner(), /upstream banner failed/);
});

test("Повторное применение к конфигу не дублирует уведомление", t => {
    const { root, file } = fixture(t, 'module.exports = { output: { format: "cjs" } };');
    const original = fs.readFileSync(file);
    assert.throws(() => configureRollup(root, release, license), /already applied/i);
    assert.deepEqual(fs.readFileSync(file), original);
    verifyNotice(require(file).output.banner);
});


test("A new manifest drives the bundle and footer on a rebuild and mixed runtime pairs are refused", async t => {
    const { root, file } = fixture(t,
        'export default { output: { file: "main.js", intro: "const retained = 1;" } };', "module");
    const later = { ...release, version: "0.12.3" };
    const packaged = Buffer.from(JSON.stringify(later));
    fs.writeFileSync(path.join(root, "manifest.json"), packaged);
    const { output } = (await import(pathToFileURL(file))).default;
    assert.ok(output.intro.includes('const retained = 1;'));
    assert.match(output.intro, /const RUDONIUM_BUILD_VERSION = "0\.12\.3";/);
    const script = output.banner + "\n" + output.intro;
    verifyRuntimeManifest(script, packaged, packaged);
    const old = Buffer.from(JSON.stringify({ ...release, version: "1.6.6" }));
    assert.throws(() => verifyRuntimeManifest(script, old, packaged), /different manifest/);
    assert.throws(() => verifyRuntimeManifest(script, old, old), /does not match/);
});

test("Rollup propagates every warning and preserves the upstream diagnostics handler", t => {
    const warning = { code: "UNRESOLVED_IMPORT", message: "Missing module" };
    for (const inherited of [false, true]) {
        const handler = inherited ? 'onwarn(warning, show) { show(warning.code); },' : '';
        const { file } = fixture(t, 'module.exports = { ' + handler + ' output: {} };');
        const config = require(file);
        const observed = [];
        assert.throws(() => config.onwarn(warning, value => observed.push(value)), /Rollup UNRESOLVED_IMPORT: Missing module/);
        assert.deepEqual(observed, [inherited ? warning.code : warning]);
    }
});

test("rebuilding from upstream uses the maintained dependency lock, compiler configuration and source tree", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maintained-rudonium-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const checkout = path.join(root, "checkout"), source = path.join(root, "staging");
    fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    const files = ["package.json", "package-lock.json", "tsconfig.json", "wdio.conf.ts", "rollup.config.js", "styles.css", "main.ts", "src/sync.ts"];
    for (const file of files) fs.writeFileSync(path.join(checkout, file), file + " maintained");
    fs.writeFileSync(path.join(source, "src/obsolete.ts"), "upstream");
    copyMaintainedInputs(checkout, source);
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(source, file)), fs.readFileSync(path.join(checkout, file)));
    assert.equal(fs.existsSync(path.join(source, "src/obsolete.ts")), false);
});
