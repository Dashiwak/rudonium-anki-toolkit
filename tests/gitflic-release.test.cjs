// SPDX-License-Identifier: GPL-3.0-only
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { stageRelease, checkRepository } = require("../Build/prepare-gitflic.cjs");
const { bundleNotice } = require("../Build/release-rollup.cjs");

function fixture(dir) {
    const repository = path.join(dir, "repository");
    const manifest = require("../manifest.json");
    const put = (file, bytes) => {
        fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
        fs.writeFileSync(path.join(repository, file), typeof bytes === "string" ? bytes : JSON.stringify(bytes));
    };
    const source = bundleNotice(manifest, "GPL-3.0-only") + "\nmodule.exports = 'fixture';\n";
    put("main.ts", source);
    put("main.js", source);
    put("main.js.map", "stale");
    put(".rollup.cache/cache", "obsolete");
    put("src/content.ts", "export {};");
    for (const name of ["verify-rebuild.cjs", "workflow-files.cjs"]) {
        put("Build/" + name, fs.readFileSync(path.join(__dirname, "../Build", name), "utf8"));
    }
    for (const name of ["LICENSE", "NOTICE.md", "AUTHORS.md", "TRADEMARKS.md", "LICENSING-ru.md"]) put(name, "test " + name);
    for (const name of ["UPSTREAM-SNAPSHOT/origin.json", "UPSTREAM-SNAPSHOT/source-hashes.json"]) put(name, {});
    for (const name of ["docs/en/quick-start.md", "docs/ru/quick-start.md", "docs/releases/" + manifest.version + ".md"]) put(name, "test guide");
    put("pack.cjs", "const fs = require('fs'); fs.copyFileSync('main.ts','main.js')");
    put("package.json", { name: manifest.id, version: manifest.version, license: "GPL-3.0-only", scripts: { build: "node pack.cjs" } });
    put("package-lock.json", { name: manifest.id, version: manifest.version, lockfileVersion: 3,
        packages: { "": { name: manifest.id, version: manifest.version } } });
    put("versions.json", { [manifest.version]: manifest.minAppVersion });
    put("manifest.json", manifest);
    put("styles.css", ".fixture {}");
    const record = name => {
        const data = fs.readFileSync(path.join(repository, name));
        return { path: name, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
    };
    const catalogs = ["NOTICES.txt", "PACKAGE-METADATA.txt"].map(name => {
        const file = "LICENSES/dependencies/" + name;
        put(file, "fixture " + name);
        return { ...record(file), path: name };
    });
    const inventory = "LICENSES/dependencies/inventory.json";
    put(inventory, { schemaVersion: 2, catalogs });
    put("PROVENANCE.json", { release: { id: manifest.id, version: manifest.version, license: "GPL-3.0-only" },
        dependencies: { inventorySha256: record(inventory).sha256 },
        sourceFiles: ["main.ts", "src/content.ts", "package-lock.json"].map(record),
        artifacts: ["main.js", "manifest.json", "styles.css"].map(record) });
    return { repository, manifest };
}

test("Flat install and rebuilt source agree; stale outputs, mixed versions and a missing stylesheet are caught", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-publisher-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { repository, manifest } = fixture(dir);
    const release = path.join(dir, "release");
    const css = path.join(repository, "styles.css");
    assert.throws(() => checkRepository(repository, { ...manifest, version: "1.6.6" }), /Inconsistent/);
    fs.unlinkSync(css);
    assert.throws(() => checkRepository(repository, manifest), /declared provenance/);
    fs.writeFileSync(css, ".fixture {}");
    fs.appendFileSync(path.join(repository, "src/content.ts"), " extra");
    assert.throws(() => checkRepository(repository, manifest), /hash mismatch/);
    fs.writeFileSync(path.join(repository, "src/content.ts"), "export {};");
    const notices = path.join(repository, "LICENSES/dependencies/NOTICES.txt");
    fs.appendFileSync(notices, " tampered");
    assert.throws(() => checkRepository(repository, manifest), /hash mismatch/);
    fs.writeFileSync(notices, "fixture NOTICES.txt");
    const fileCount = await stageRelease(repository, dir, dir, manifest);
    assert.equal(fileCount, fs.readdirSync(repository, { withFileTypes: true, recursive: true }).filter(file => file.isFile()).length);
    assert.equal(fs.existsSync(path.join(repository, "main.js")), false);
    assert.equal(fs.existsSync(path.join(repository, "main.js.map")), false);
    assert.equal(fs.existsSync(path.join(repository, ".rollup.cache")), false);
    assert.equal(fs.existsSync(release), false);
    const runtime = path.join(dir, "install"), evidence = path.join(dir, "notices");
    assert.deepEqual(fs.readdirSync(runtime).sort(), ["main.js", "manifest.json", "styles.css"]);
    for (const file of ["manifest.json", "styles.css"]) {
        assert.deepEqual(fs.readFileSync(path.join(runtime, file)), fs.readFileSync(path.join(repository, file)));
    }
    for (const file of ["LICENSE", "UPSTREAM-SNAPSHOT/origin.json", "LICENSES/dependencies/inventory.json", "PROVENANCE.json"]) {
        assert.deepEqual(fs.readFileSync(path.join(evidence, file)), fs.readFileSync(path.join(repository, file)));
    }
    assert.equal(fs.readFileSync(path.join(runtime, "main.js"), "utf8"), fs.readFileSync(path.join(repository, "main.ts"), "utf8"));
});

test("failed rebuild does not expose an unpacked plugin or a release ZIP", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-failed-rebuild-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { repository, manifest } = fixture(dir);
    fs.writeFileSync(path.join(repository, "Build", "verify-rebuild.cjs"), "process.exitCode = 1");
    await assert.rejects(stageRelease(repository, dir, dir, manifest), /verify-rebuild/);
    assert.equal(fs.existsSync(path.join(dir, "install")), false);
    assert.equal(fs.existsSync(path.join(dir, "release")), false);
});

test("upstream Anki backups and Obsidian test profiles do not block the GitFlic release", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-upstream-profiles-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { repository: source, manifest } = fixture(dir);
    const { prepareRepository } = require("../Build/build-main.cjs");
    const { captureUpstream } = require("../Build/release-provenance.cjs");
    const kit = path.resolve(__dirname, "..");
    const write = (relative, contents) => {
        const file = path.join(source, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    };
    const backup = "tests/defaults/test_config/.local/share/Anki2/User 1/backups/backup-2023-03-06-00.48.36.colpkg";
    const state = [
        backup,
        "sync.ffs_db",
        "tests/defaults/test_vault_suites/basic_para/sync.ffs_lock",
        "tests/defaults/test_vault_suites/basic_para/.obsidian/workspace.json",
        "tests/defaults/test_vault_suites/basic_para/.obsidian/plugins/example/LICENSE",
        "tests/defaults/test_vault_suites/other/.trash/nested/removed.md",
        "tests/test_vault_suites/example/nested/.obsidian/config.json",
        "tests/test_config/.local/share/Anki2/User 1/collection.anki2",
        "tests/defaults/test_vault/.obsidian/plugins/fixture/LICENSE",
        "tests/test_vault/.obsidian/workspace.json",
    ];
    const retained = [
        "tests/defaults/test_vault_suites/basic_para/cards.md",
        "tests/defaults/test_vault_suites/basic_para/.obsidian-example.md",
        "tests/defaults/test_vault/QA.md", "tests/specs/example.ts", "tests/test_config_parser.cjs",
        "tests/defaults/test_vault/.obsidian-example.md",
    ];
    for (const name of [...state, ...retained]) write(name, "fixture: " + name);
    // Assembly creates its rebuild script and captures genuine license notices from the original tree.
    fs.rmSync(path.join(source, "Build/verify-rebuild.cjs"));
    fs.rmSync(path.join(source, "UPSTREAM-SNAPSHOT"), { recursive: true });
    fs.copyFileSync(path.join(kit, "LICENSE"), path.join(source, "LICENSE"));
    const origin = captureUpstream(source, kit, {
        expectedCommit: "2dd39fefd26f3141a4e02105b1172a5a3eb2611f",
        repository: "https://github.com/ObsidianToAnki/Obsidian_to_Anki", acquisition: "local-directory",
    });
    assert.equal(origin.capturedFiles.some(row => state.includes(row.sourcePath)), false);
    const repository = path.join(dir, "public");
    prepareRepository(source, repository);
    for (const file of ["scripts/verify-rebuild.cjs", "Build/Build-Windows.cmd", "Build/LICENSE"])
        assert.equal(fs.existsSync(path.join(repository, file)), false);
    assert.deepEqual(fs.readdirSync(repository).filter(name => name.toLowerCase() === "tests"), ["tests"]);
    for (const name of state) {
        assert.ok(fs.existsSync(path.join(source, name)));
        assert.equal(fs.existsSync(path.join(repository, name)), false);
    }
    for (const name of retained) assert.equal(fs.readFileSync(path.join(repository, name), "utf8"), "fixture: " + name);
    for (const name of ["tests/gitflic-release.test.cjs", "Prepare-Release.cmd", "Build/prepare-release.cjs",
        ".github/workflows/review-candidate.yml", "eslint.config.mjs"]) {
        assert.deepEqual(fs.readFileSync(path.join(repository, name)), fs.readFileSync(path.join(kit, name)));
    }
    const stray = path.join(repository, "tests/specs/private.colpkg");
    fs.writeFileSync(stray, "private file");
    const release = path.join(dir, "release");
    await assert.rejects(stageRelease(repository, dir, dir, manifest), /Unexpected file in prepared sources.*private\.colpkg/);
    fs.unlinkSync(stray);
    await stageRelease(repository, dir, dir, manifest);
    assert.equal(fs.existsSync(release), false);
    assert.ok(fs.existsSync(path.join(dir,"install","main.js")));
});

function maintainedCheckout(dir) {
    const { repository: checkout, manifest } = fixture(dir);
    const { captureUpstream } = require("../Build/release-provenance.cjs");
    const kit = path.resolve(__dirname, "..");
    const write = (name, bytes) => fs.writeFileSync(path.join(checkout, name), bytes);
    const json = name => JSON.parse(fs.readFileSync(path.join(checkout, name), "utf8"));
    // A miniature locked, offline npm installation supplies the tsc command on all platforms.
    const fixturePath = "vendor/typescript";
    fs.mkdirSync(path.join(checkout, fixturePath), { recursive: true });
    const tool = { name: "typescript", version: "1.0.0", bin: { tsc: "cli.cjs" } };
    write(fixturePath + "/package.json", JSON.stringify(tool));
    write(fixturePath + "/cli.cjs", "#!/usr/bin/env node\nprocess.exitCode = process.argv.includes('--noEmit') ? 0 : 1;\n");
    fs.chmodSync(path.join(checkout, fixturePath, "cli.cjs"), 0o755);
    const pkg = json("package.json");
    pkg.devDependencies = { typescript: "file:" + fixturePath };
    write("package.json", JSON.stringify(pkg));
    const lock = json("package-lock.json");
    lock.packages[""].devDependencies = pkg.devDependencies;
    lock.packages[fixturePath] = tool;
    lock.packages["node_modules/typescript"] = { resolved: fixturePath, link: true };
    write("package-lock.json", JSON.stringify(lock));
    fs.rmSync(path.join(checkout, "UPSTREAM-SNAPSHOT"), { recursive: true });
    fs.copyFileSync(path.join(kit, "LICENSE"), path.join(checkout, "LICENSE"));
    captureUpstream(checkout, kit, {
        expectedCommit: "2dd39fefd26f3141a4e02105b1172a5a3eb2611f",
        repository: "https://github.com/ObsidianToAnki/Obsidian_to_Anki", acquisition: "local-directory",
    });
    return { checkout, manifest, write, kit };
}

test("a maintained checkout builds edited sources and refreshes provenance without patching upstream again", t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-edited-checkout-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { checkout, manifest, write, kit } = maintainedCheckout(dir);
    const { buildCheckout } = require("../Build/prepare-gitflic.cjs");
    fs.mkdirSync(path.join(checkout, "tests/defaults/test_vault_suites/basic_para/.obsidian"), { recursive: true });
    write("tests/defaults/test_vault_suites/basic_para/.obsidian/workspace.json", "{}");
    const oldProvenance = fs.readFileSync(path.join(checkout, "PROVENANCE.json"));
    fs.appendFileSync(path.join(checkout, "main.ts"), "// local edit\n");
    const built = path.join(dir, "built");
    write("sync.ffs_db", "local comparison");
    buildCheckout(checkout, built, manifest);
    assert.equal(fs.existsSync(path.join(built, "sync.ffs_db")), false);
    assert.equal(fs.existsSync(path.join(built, "tests/defaults/test_vault_suites/basic_para/.obsidian")), false);
    assert.deepEqual(checkRepository(built, manifest), ["main.js", "manifest.json", "styles.css"]);
    assert.match(fs.readFileSync(path.join(built, "main.js"), "utf8"), /local edit/);
    assert.equal(fs.existsSync(path.join(built, "node_modules")), false);
    assert.deepEqual(fs.readFileSync(path.join(checkout, "PROVENANCE.json")), oldProvenance);
    // Exercise the verified builder used by the combined update and by CI.
    fs.cpSync(path.join(kit, "Build"), path.join(checkout, "Build"), { recursive: true });
    const run = (...args) => require("node:child_process").spawnSync(process.execPath,
        [path.join(checkout, "Build", "prepare-gitflic.cjs"), ...args], { encoding: "utf8", cwd: dir });
    const builds = path.join(dir, "Rudonium-Builds");
    const output = path.join(builds, manifest.version);
    write("manifest.json", JSON.stringify({ ...manifest, version: manifest.version + ".1" }));
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid release version/);
    assert.equal(fs.existsSync(builds), false);
    write("manifest.json", JSON.stringify(manifest));
    const prepared = run();
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(fs.readdirSync(output).sort(), ["install", "notices"]);
    const main = path.join(output, "install", "main.js");
    const verified = fs.readFileSync(main);
    assert.ok(prepared.stdout.includes(main));
    assert.ok(verified.toString().includes("// local edit"));
    assert.equal(fs.existsSync(path.join(output, "release")), false);
    const repeated = run();
    assert.notEqual(repeated.status, 0);
    assert.ok(repeated.stderr.includes(output));
    assert.deepEqual(fs.readFileSync(main), verified);
    write("pack.cjs", "process.exit(1)");
    const failed = run("-", path.join(builds, "failed-build"));
    assert.notEqual(failed.status, 0);
    assert.deepEqual(fs.readdirSync(builds), [manifest.version]);
    assert.deepEqual(fs.readFileSync(main), verified);
});

test("locked npm dependencies allow verified publication and retain the actual rebuild error", t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-locked-npm-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
    const { checkout, manifest, write, kit } = maintainedCheckout(dir);
    fs.cpSync(path.join(kit, "Build"), path.join(checkout, "Build"), { recursive: true });
    const temp = path.join(dir, "local temp"), builds = path.join(dir, "Облако !", "Rudonium-Builds");
    fs.mkdirSync(temp);
    const log = path.join(dir, "compiled.jsonl");
    const preload = path.join(__dirname, "fixtures", "locked-npm-folder.cjs");
    const env = {...process.env, TMPDIR:temp, TMP:temp, TEMP:temp, RUDONIUM_TEST_COMPILED:log,
        npm_config_offline:"true", npm_config_cache:path.join(dir, "npm-cache")};
    const run = output => require("node:child_process").spawnSync(process.execPath,
        [path.join(checkout, "Build/prepare-gitflic.cjs"), "-", output],
        {cwd:dir, encoding:"utf8", env:{...env, NODE_OPTIONS:"--require=" + JSON.stringify(preload.split(path.sep).join("/"))}});
    const compile = [
        'const fs = require("node:fs");',
        'fs.copyFileSync("main.ts", "main.js");',
        'fs.appendFileSync(process.env.RUDONIUM_TEST_COMPILED, JSON.stringify(process.cwd()) + "\\n");',
        'console.log("created fixture main.js");',
    ].join("\n");
    write("pack.cjs", compile);
    const destination = path.join(builds, manifest.version);
    const prepared = run(destination);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.match(prepared.stdout, /Both clean builds match the reference assets byte for byte/);
    assert.match(prepared.stderr, /Temporary cleanup deferred:/);
    const compiledIn = fs.readFileSync(log, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(compiledIn.length, 3);
    for (const folder of compiledIn) {
        assert.ok(folder.startsWith(temp + path.sep), "npm must build outside the synced output: " + folder);
        assert.ok(fs.existsSync(path.join(folder, "node_modules")), "simulated live dependency lock: " + folder);
    }
    const expected = fs.readFileSync(path.join(checkout, "main.ts"));
    assert.deepEqual(fs.readdirSync(path.join(destination, "install")).sort(), ["main.js", "manifest.json", "styles.css"]);
    assert.equal(fs.existsSync(path.join(destination, "release")), false);
    assert.deepEqual(fs.readFileSync(path.join(destination, "install", "main.js")), expected);

    write("pack.cjs", compile + '\nif (require("node:path").basename(process.cwd()) === "build-2") fs.appendFileSync("main.js", "// changed");');
    const rejectedOutput = path.join(builds, "mismatched");
    const rejected = run(rejectedOutput);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Build 2 differs[\s\S]*main\.js/);
    assert.match(rejected.stderr, /Temporary cleanup deferred:/);
    assert.equal(fs.existsSync(rejectedOutput), false);
    assert.deepEqual(fs.readFileSync(path.join(destination, "install", "main.js")), expected);
});

test("Prepare prints the final GitFlic folder and keeps checked sources separately if the release rebuild fails", t => {
    const { spawnSync } = require("node:child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-prepare-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { repository: input, manifest } = fixture(dir);
    const kit = path.join(dir, "test kit");
    const build = path.join(kit, "Build");
    fs.mkdirSync(build, { recursive: true });
    for (const file of ["prepare-gitflic.cjs", "release-rollup.cjs", "workflow-files.cjs"]) {
        fs.copyFileSync(path.join(__dirname, "../Build", file), path.join(build, file));
    }
    fs.copyFileSync(path.join(input, "manifest.json"), path.join(kit, "manifest.json"));
    fs.writeFileSync(path.join(build, "build-main.cjs"), [
        'const fs = require("node:fs");',
        'const [flag, from, to] = process.argv.slice(2);',
        'if (flag !== "--prepare-repository") throw new Error("wrong mode");',
        'fs.cpSync(from, to, {recursive: true});',
    ].join("\n"));
    const publish = path.join(dir, "GitFlic & source");
    const prepare = () => spawnSync(process.execPath, [path.join(build, "prepare-gitflic.cjs"), input, publish],
        { encoding: "utf8" });
    const ok = prepare();
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes(path.join(publish, "repository")));
    for (const asset of ["main.js", "manifest.json", "styles.css"]) {
        assert.ok(ok.stdout.includes(path.join(publish, "install", asset)));
    }
    const profile = fs.readFileSync(path.join(publish, "Compare.ffs_gui"), "utf8");
    assert.ok(profile.includes(path.join(publish,"repository").replaceAll("&", "&amp;")));
    assert.match(profile, /<Right\/>/);
    assert.match(profile, /RightOnly="none"/);
    assert.match(profile, /<Item>\/\.git<\/Item>/);
    assert.equal(fs.existsSync(path.join(publish, "release")), false);
    fs.renameSync(publish, path.join(dir, "previous output"));
    fs.writeFileSync(path.join(input, "pack.cjs"), "process.exit(1)");
    const failed = prepare();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Sources saved:/);
    const saved = fs.readdirSync(dir).filter(name => name.startsWith("Sources-" + manifest.version + "-"));
    assert.equal(saved.length, 1);
    const recovered = path.join(dir, saved[0], "repository");
    assert.ok(fs.existsSync(path.join(recovered, "main.ts")));
    assert.equal(fs.existsSync(path.join(recovered, "main.js")), false);
    assert.equal(fs.existsSync(publish), false);
    assert.ok(fs.readFileSync(path.join(build, "build-error.txt"), "utf8").includes(recovered));
    // Unexpected content outside the known test-vault paths must still block both outputs.
    fs.writeFileSync(path.join(input, "private.anki2"), "unrelated");
    const blocked = prepare();
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Unexpected file.*private.anki2/);
    assert.equal(fs.readdirSync(dir).filter(name => name.startsWith("Sources-")).length, 1);
});

test("the checkout supplies release notes matching its manifest before a clean build starts", () => {
    const root = path.resolve(__dirname, "..");
    const version = require("../manifest.json").version;
    const notes = `docs/releases/${version}.md`;
    assert.ok(fs.statSync(path.join(root, notes)).isFile());
    assert.ok(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").includes(`(${notes})`));
    for (const filename of ["README.md", "README.ru.md"]) {
        assert.ok(fs.readFileSync(path.join(root, filename), "utf8").includes("(CHANGELOG.md)"));
    }
});
