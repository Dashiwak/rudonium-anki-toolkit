// SPDX-License-Identifier: GPL-3.0-only
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { copySuppliedSource } = require("../Build/upstream-source.cjs");
const { captureUpstream } = require("../Build/release-provenance.cjs");

const kit = path.resolve(__dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-source-"));
const repository = "https://github.com/ObsidianToAnki/Obsidian_to_Anki";
const source = path.join(base, "checkout with spaces");
const testGit = spawnSync("git", ["--version"], { encoding: "utf8" });
const hasGit = !testGit.error && testGit.status === 0;
const content = Buffer.from([0, 255, 9, 13, 10, 6, 0]);
fs.mkdirSync(source);

function git(args) {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

try {
    fs.writeFileSync(path.join(source, "LICENSE"), fs.readFileSync(path.join(kit, "LICENSE")));
    for (const name of ["package.json", "package-lock.json"]) fs.writeFileSync(path.join(source, name), JSON.stringify({ license: "MIT" }));
    fs.writeFileSync(path.join(source, "manifest.json"), '{"id":"obsidian-to-anki-plugin","version":"3.6.0"}');
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src", "sample.bin"), content);
    fs.mkdirSync(path.join(source, "node_modules"));
    fs.writeFileSync(path.join(source, "node_modules", "local"), "ignored");
    const plain = path.join(base, "plain");
    const expectedCommit = "1111111111111111111111111111111111111111";
    const unverified = copySuppliedSource(source, plain, expectedCommit);
    assert.equal(unverified.acquisition, "supplied-directory-unverified");
    assert.ok(!fs.existsSync(path.join(plain, "node_modules")));
    assert.deepEqual(fs.readFileSync(path.join(plain, "src", "sample.bin")), content);
    const origin = captureUpstream(plain, kit, { repository, expectedCommit, ...unverified });
    assert.ok(!origin.verifiedCommit);
    assert.match(origin.revisionVerification, /does not independently verify/);
    console.log("PASS plain extracted source is copied and labelled unverified");

    const download = path.join(base, "download");
    copySuppliedSource(source, download, expectedCommit);
    const downloaded = captureUpstream(download, kit, { repository, expectedCommit, acquisition: "downloaded-pinned-url" });
    assert.ok(!downloaded.verifiedCommit);
    assert.match(downloaded.revisionVerification, /does not independently verify/);
    console.log("PASS provenance of a pinned download does not claim Git-object verification");

    const wrong = path.join(base, "different plugin");
    fs.mkdirSync(wrong);
    const disposable = path.join(base, "release-kit");
    fs.cpSync(path.join(kit, "Build"), path.join(disposable, "Build"), {
        recursive: true, filter: name => path.basename(name) !== "overlay-files.json" && !path.basename(name).startsWith(".build-"),
    });
    for (const file of ["manifest.json", "package.json", "versions.json", "LICENSE"]) fs.copyFileSync(path.join(kit, file), path.join(disposable, file));
    const builder = path.join(disposable, "Build/build-main.cjs");
    const report = path.join(disposable, "Build/build-error.txt");
    const refuse = path.join(base, "refused-download.cjs");
    fs.writeFileSync(refuse, "globalThis.fetch = async () => ({ ok: false, status: 503 });\n");
    const versionsFile = path.join(disposable, "versions.json");
    const originalVersions = fs.readFileSync(versionsFile);
    fs.writeFileSync(versionsFile, "{}");
    const missingMapping = spawnSync(process.execPath, ["--require", refuse, builder], { encoding: "utf8" });
    assert.equal(missingMapping.status, 1);
    assert.match(missingMapping.stderr, /versions.json must map the release version/u);
    assert.doesNotMatch(missingMapping.stdout, /Downloading the official/u);
    fs.writeFileSync(versionsFile, originalVersions);
    const networkFailure = spawnSync(process.execPath, ["--require", refuse, builder], { encoding: "utf8" });
    assert.equal(networkFailure.status, 1);
    assert.match(fs.readFileSync(report, "utf8"), /Stage: Acquire upstream source[\s\S]*HTTP 503/u);
    for (const manifest of [{ id: "other-plugin", version: "3.6.0" }, { id: "obsidian-to-anki-plugin", version: "3.5.0" }]) {
        fs.writeFileSync(path.join(wrong, "manifest.json"), JSON.stringify(manifest));
        const rejected = spawnSync(process.execPath, [path.join(disposable, "Build/build-main.cjs"), wrong], { encoding: "utf8" });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /expects the official Export to Anki 3.6.0/);
        assert.match(fs.readFileSync(report, "utf8"), /Stage: Verify upstream source[\s\S]*official Export to Anki 3.6.0/u);
        assert.doesNotMatch(rejected.stdout, /Installing locked build dependencies/);
        assert.ok(!fs.existsSync(path.join(disposable, "main.js")));
    }
    console.log("PASS normal build rejects unrelated plugin and wrong upstream version before npm");
    const installed = path.join(disposable, "main.js");
    fs.writeFileSync(installed, "previous verified bundle");
    const missingNpm = spawnSync(process.execPath, [builder, source], {
        encoding: "utf8", env: { ...process.env, PATH: base, ComSpec: path.join(base, "missing-cmd.exe") },
    });
    assert.equal(missingNpm.status, 1);
    assert.match(fs.readFileSync(report, "utf8"), /Stage: Install locked dependencies/u);
    assert.equal(fs.readFileSync(installed, "utf8"), "previous verified bundle");
    console.log("PASS download and npm failures persist the stage, replace stale diagnostics, and preserve previous main.js");

    if (!hasGit) {
        console.log("SKIP Git checkout tests: git executable unavailable");
    } else {
        git(["-c", "init.defaultBranch=main", "init", "-q"]);
        git(["config", "user.name", "Release test"]); git(["config", "user.email", "test@example.invalid"]);
        git(["config", "core.hooksPath", path.join(base, "no-hooks")]);
        git(["config", "core.autocrlf", "false"]); git(["config", "commit.gpgSign", "false"]);
        fs.writeFileSync(path.join(source, ".gitattributes"), "src/sample.bin -text export-ignore\n");
        git(["add", ".gitattributes", "src", "manifest.json", "package.json", "package-lock.json", "LICENSE"]);
        git(["commit", "-qm", "Pinned version"]);
        const commit = git(["rev-parse", "HEAD"]), tree = git(["rev-parse", "HEAD^{tree}"]);
        const clean = path.join(base, "clean");
        assert.deepEqual(copySuppliedSource(source, clean, commit), { acquisition: "local-git-objects", verifiedTree: tree });
        assert.deepEqual(fs.readFileSync(path.join(clean, "src", "sample.bin")), content);
        assert.ok(!fs.existsSync(path.join(clean, ".git")));
        assert.ok(!fs.existsSync(path.join(clean, "node_modules")));
        console.log("PASS clean commit includes the tracked binary even with export-ignore");

        fs.writeFileSync(path.join(source, "manifest.json"), '{"version":"9.9.9"}');
        git(["add", "manifest.json"]); git(["commit", "-qm", "Different HEAD"]);
        const later = git(["rev-parse", "HEAD"]);
        git(["replace", commit, later]);
        fs.writeFileSync(path.join(source, "src", "sample.bin"), "unsaved user binary");
        fs.writeFileSync(path.join(source, "extra.txt"), "untracked");
        const dirty = path.join(base, "dirty");
        const acquired = copySuppliedSource(source, dirty, commit);
        assert.equal(acquired.verifiedTree, tree);
        assert.deepEqual(fs.readFileSync(path.join(dirty, "src", "sample.bin")), content);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dirty, "manifest.json"))).version, "3.6.0");
        assert.ok(!fs.existsSync(path.join(dirty, "extra.txt")));
        assert.equal(fs.readFileSync(path.join(source, "src", "sample.bin"), "utf8"), "unsaved user binary");
        const verified = captureUpstream(dirty, kit, { repository, expectedCommit: commit, ...acquired });
        assert.equal(verified.verifiedCommit, commit);
        assert.equal(verified.verifiedTree, tree);
        assert.equal(verified.licenseEvidence.packageLicense, "MIT");
        assert.match(verified.revisionVerification, /No author signature was checked/);
        console.log("PASS different HEAD, replacement refs, working-tree changes and untracked files are excluded");

        const linked = path.join(base, "linked worktree");
        git(["worktree", "add", "-q", "--detach", linked, later]);
        const fromLinked = path.join(base, "from-linked");
        assert.equal(copySuppliedSource(linked, fromLinked, commit).verifiedTree, tree);
        assert.deepEqual(fs.readFileSync(path.join(fromLinked, "src", "sample.bin")), content);
        console.log("PASS linked Git worktree exports the pinned objects");

        const missing = path.join(base, "missing");
        assert.throws(() => copySuppliedSource(source, missing, expectedCommit), /pinned upstream revision/);
        assert.ok(!fs.existsSync(missing));
        assert.throws(() => copySuppliedSource(source, missing, "HEAD"), /full pinned Git commit/);
        console.log("PASS missing pinned commit or non-hash revision cannot fall back to a directory");
    }
} finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 2 });
}
