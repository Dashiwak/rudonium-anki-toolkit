// SPDX-License-Identifier: GPL-3.0-only
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const overlay = require("../Build/overlay-source.cjs");
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
    put("Build/verify-rebuild.cjs", fs.readFileSync(path.resolve(__dirname, "../Build/verify-rebuild.cjs"), "utf8"));
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

test("GitFlic ZIP and rebuilt source agree; stale outputs, mixed versions and a missing stylesheet are caught", async t => {
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
    const fileCount = await stageRelease(repository, release, dir, manifest);
    assert.equal(fileCount, fs.readdirSync(repository, { withFileTypes: true, recursive: true }).filter(file => file.isFile()).length);
    assert.equal(fs.existsSync(path.join(repository, "main.js")), false);
    assert.equal(fs.existsSync(path.join(repository, "main.js.map")), false);
    assert.equal(fs.existsSync(path.join(repository, ".rollup.cache")), false);
    const name = "Rudonium-" + manifest.version + ".zip";
    const archiveFile = path.join(release, name);
    assert.equal(fs.readFileSync(path.join(release, "SHA256SUMS.txt"), "utf8"),
        crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex") + "  " + name + "\n");
    const zip = await import(pathToFileURL(overlay.file("vault-backup-zip.ts")).href);
    const unpack = path.join(dir, "fresh vault");
    await zip.restoreVaultZip(archiveFile, unpack);
    assert.ok(fs.readFileSync(path.join(unpack, "INSTALL.txt"), "utf8").includes(manifest.version));
    const install = path.join(unpack, manifest.id);
    const ready = path.join(dir, "install", manifest.id);
    const files = folder => fs.readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => path.relative(folder, path.join(entry.parentPath, entry.name))).sort();
    assert.deepEqual(files(ready), files(install));
    for (const file of files(install)) {
        assert.deepEqual(fs.readFileSync(path.join(ready, file)), fs.readFileSync(path.join(install, file)), file);
    }
    for (const file of ["manifest.json", "styles.css", "LICENSE", "UPSTREAM-SNAPSHOT/origin.json",
        "LICENSES/dependencies/inventory.json", "PROVENANCE.json"]) {
        assert.deepEqual(fs.readFileSync(path.join(install, file)), fs.readFileSync(path.join(repository, file)));
    }
    assert.equal(fs.readFileSync(path.join(install, "main.js"), "utf8"), fs.readFileSync(path.join(repository, "main.ts"), "utf8"));
});

test("failed rebuild does not expose an unpacked plugin or a release ZIP", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-failed-rebuild-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { repository, manifest } = fixture(dir);
    fs.writeFileSync(path.join(repository, "Build", "verify-rebuild.cjs"), "process.exitCode = 1");
    await assert.rejects(stageRelease(repository, path.join(dir, "release"), dir, manifest), /verify-rebuild/);
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
    assert.ok(fs.existsSync(path.join(repository, "tests/gitflic-release.test.cjs")));
    const stray = path.join(repository, "tests/specs/private.colpkg");
    fs.writeFileSync(stray, "private file");
    const release = path.join(dir, "release");
    await assert.rejects(stageRelease(repository, release, dir, manifest), /Unexpected file in prepared sources.*private\.colpkg/);
    fs.unlinkSync(stray);
    await stageRelease(repository, release, dir, manifest);
    assert.ok(fs.existsSync(path.join(release, "Rudonium-" + manifest.version + ".zip")));
});

test("a maintained checkout builds edited sources and refreshes provenance without patching upstream again", t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-edited-checkout-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { repository: checkout, manifest } = fixture(dir);
    const { buildCheckout } = require("../Build/prepare-gitflic.cjs");
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
    fs.mkdirSync(path.join(checkout, "tests/defaults/test_vault_suites/basic_para/.obsidian"), { recursive: true });
    write("tests/defaults/test_vault_suites/basic_para/.obsidian/workspace.json", "{}");
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
    // Exercise the same entry point that the permanent Windows launcher invokes.
    fs.cpSync(path.join(kit, "Build"), path.join(checkout, "Build"), { recursive: true });
    fs.copyFileSync(overlay.file("vault-backup-zip.ts"), path.join(checkout, "src/vault-backup-zip.ts"));
    const run = () => require("node:child_process").spawnSync(process.execPath,
        [path.join(checkout, "Build", "prepare-gitflic.cjs")], { encoding: "utf8", cwd: dir });
    const builds = path.join(dir, "Rudonium-Builds");
    const output = path.join(builds, manifest.version + ".1");
    pkg.rudoniumBuild = 0;
    write("package.json", JSON.stringify(pkg));
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /positive integer rudoniumBuild/);
    assert.equal(fs.existsSync(builds), false);
    pkg.rudoniumBuild = 1;
    write("package.json", JSON.stringify(pkg));
    const prepared = run();
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(fs.readdirSync(output).sort(), ["install", "release"]);
    const main = path.join(output, "install", manifest.id, "main.js");
    const verified = fs.readFileSync(main);
    assert.ok(prepared.stdout.includes(main));
    assert.ok(verified.toString().includes("// local edit"));
    assert.ok(fs.existsSync(path.join(output, "release", "Rudonium-" + manifest.version + ".zip")));
    const repeated = run();
    assert.notEqual(repeated.status, 0);
    assert.ok(repeated.stderr.includes(output));
    assert.deepEqual(fs.readFileSync(main), verified);
    pkg.rudoniumBuild = 2;
    write("package.json", JSON.stringify(pkg));
    write("pack.cjs", "process.exit(1)");
    const failed = run();
    assert.notEqual(failed.status, 0);
    assert.deepEqual(fs.readdirSync(builds), [manifest.version + ".1"]);
    assert.deepEqual(fs.readFileSync(main), verified);
});

test("Prepare prints the final GitFlic folder and keeps checked sources separately if the release rebuild fails", t => {
    const { spawnSync } = require("node:child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-prepare-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { repository: input, manifest } = fixture(dir);
    const kit = path.join(dir, "test kit");
    const build = path.join(kit, "Build");
    fs.mkdirSync(build, { recursive: true });
    fs.mkdirSync(path.join(kit, "src"));
    for (const file of ["prepare-gitflic.cjs", "release-rollup.cjs", "overlay-source.cjs"]) {
        fs.copyFileSync(path.join(__dirname, "../Build", file), path.join(build, file));
    }
    fs.copyFileSync(overlay.file("vault-backup-zip.ts"), path.join(kit, "src/vault-backup-zip.ts"));
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
        assert.ok(ok.stdout.includes(path.join(publish, "install", manifest.id, asset)));
    }
    assert.ok(ok.stdout.includes(path.join(publish, "release", "Rudonium-" + manifest.version + ".zip")));
    const profile = fs.readFileSync(path.join(publish, "Compare.ffs_gui"), "utf8");
    assert.ok(profile.includes(path.join(publish,"repository").replaceAll("&", "&amp;")));
    assert.match(profile, /<Right\/>/);
    assert.match(profile, /RightOnly="none"/);
    assert.match(profile, /<Item>\/\.git<\/Item>/);
    assert.ok(fs.existsSync(path.join(publish, "release", "Rudonium-" + manifest.version + ".zip")));
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
