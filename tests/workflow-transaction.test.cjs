// SPDX-License-Identifier: GPL-3.0-only
"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const transaction = require("../Build/workflow-transaction.cjs");
const {overrideDirectoryHints} = require("./fixtures/directory-hints.cjs");

const pluginId = "rudonium-anki-toolkit";
const runtimeFile = "install/" + pluginId + "/main.js";
const before = {f: "old", "r/d": "removed", m: "file becomes dir", "k/v/name": "dir becomes file", same: "untouched"};
const after = {f: "new", "new.bin": Buffer.from([0, 255, 1, 0]), "m/sub/v": "new child", k: "new file", same: "untouched"};
const crashCodes = {"crash-before-publish": 78, "crash-after-publish": 79, "crash-mid-write": 80, "crash-mid-rollback": 81};

function paths(root) {
    const builds = path.join(root, "Rudonium-Builds");
    return {
        repo: path.join(root, "permanent"), builds,
        stagedSource: path.join(builds, "stage", "source"),
        stagedBuild: path.join(builds, "stage", "result"),
        outputDir: path.join(builds, "0.10.6")
    };
}

function put(root, relative, bytes) {
    const name = path.join(root, relative);
    fs.mkdirSync(path.dirname(name), {recursive: true});
    fs.writeFileSync(name, bytes);
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "Rudonium тест & "));
    t.after(() => fs.rmSync(root, {recursive: true, force: true, maxRetries: 3}));
    const ctx = paths(root);
    for (const [name, bytes] of Object.entries(before)) put(ctx.repo, name, bytes);
    for (const [name, bytes] of Object.entries(after)) put(ctx.stagedSource, name, bytes);
    put(ctx.stagedBuild, runtimeFile, "BUILT");
    put(ctx.repo, ".git/index", "do not change");
    return {root, ctx};
}

function hashes(files) {
    return Object.fromEntries(Object.entries(files).map(([name, data]) =>
        [name, crypto.createHash("sha256").update(data).digest("hex")]));
}

function checkSource(repo, expected) {
    const files = [];
    function visit(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name === ".git") continue;
            const name = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(name);
            else files.push(path.relative(repo, name).split(path.sep).join("/"));
        }
    }
    visit(repo);
    assert.deepEqual(files.sort(), Object.keys(expected).sort());
    for (const [name, bytes] of Object.entries(expected)) {
        assert.deepEqual(fs.readFileSync(path.join(repo, name)), Buffer.from(bytes));
    }
    assert.equal(fs.readFileSync(path.join(repo, ".git/index"), "utf8"), "do not change");
}

function apply(ctx, mode) {
    return transaction.withWorkspaceLock(ctx, () => {
        transaction.recover(ctx);
        transaction.commitUpdate({
            ...ctx, fromFiles: hashes(before), toFiles: hashes(after),
            previousBuildId: mode.startsWith("revision-") ? transaction.replaceableBuildId(ctx.outputDir) : undefined,
            verifySource() {
                if (mode === "crash-before-publish") process.exit(crashCodes[mode]);
                if (mode === "manual-edit") {
                    put(ctx.repo, "f", "user edit after updating");
                    throw new Error("forced failure");
                }
                checkSource(ctx.repo, after);
            },
            verifyBuild(dir) {
                assert.equal(fs.readFileSync(path.join(dir, runtimeFile), "utf8"), "BUILT");
                if (dir !== ctx.outputDir) return;
                if (mode === "crash-after-publish") process.exit(crashCodes[mode]);
                if (mode === "revision-crash-after-publication") process.exit(83);
                if (mode === "revision-reject") throw new Error("revision check failed");
                if (mode === "reject-build" || mode === "crash-mid-rollback") throw new Error("postpublication check failed");
            }
        });
    });
}

function child(root, mode) {
    return spawnSync(process.execPath, [__filename, "worker", root, mode], {encoding: "utf8"});
}

async function worker(root, mode) {
    const ctx = paths(root);
    if (mode === "lock") return transaction.withWorkspaceLock(ctx, () => {});

    // Inject faults only in the child, after the real filesystem operation.
    if (mode === "revision-crash-after-detach") {
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
            rename(from, to);
            if (from === ctx.outputDir && path.basename(to) === "previous-result") process.exit(82);
        };
    }
    if (mode === "crash-mid-write") {
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
            rename(from, to);
            if (to.endsWith(".old") && path.basename(from) === "f") process.exit(crashCodes[mode]);
        };
    }
    if (mode === "crash-mid-rollback") {
        const write = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => {
            write(file, ...args);
            if (path.basename(path.dirname(file)) === "undone") process.exit(crashCodes[mode]);
        };
    }
    return apply(ctx, mode);
}

if (process.argv[2] === "worker") {
    worker(process.argv[3], process.argv[4]).catch(error => {
        console.error(error.message);
        process.exitCode = 3;
    });
} else {
    test("publishes the verified build and updates added, modified and removed source files", async t => {
        const {ctx} = fixture(t);
        await apply(ctx, "success");
        checkSource(ctx.repo, after);
        assert.ok(fs.existsSync(ctx.outputDir));
    });

    for (const hint of ["file", "unknown"]) {
        test("publishes a real installation directory listed as " + hint, async t => {
            const {ctx} = fixture(t);
            overrideDirectoryHints(t, (dir, name) => {
                if (path.basename(dir) === "install" && name === pluginId) return hint;
                if (path.basename(dir) === pluginId && name === "main.js") return "directory";
            });
            await apply(ctx, "success");
            checkSource(ctx.repo, after);
            assert.equal(fs.readFileSync(path.join(ctx.outputDir, runtimeFile), "utf8"), "BUILT");
            assert.equal(transaction.pendingRecovery(ctx), false);
        });
    }

    test("a misleading directory hint does not prevent rollback after publication", async t => {
        const {ctx} = fixture(t);
        overrideDirectoryHints(t, (dir, name) => {
            if (dir === path.join(ctx.outputDir, "install") && name === pluginId) return "file";
        });
        await assert.rejects(apply(ctx, "reject-build"), /postpublication check failed/);
        checkSource(ctx.repo, before);
        assert.equal(fs.existsSync(ctx.outputDir), false);
        assert.equal(transaction.pendingRecovery(ctx), false);
    });

    test("a listed build file disappearing before inspection stops before source transfer", async t => {
        const {ctx} = fixture(t);
        const directory = path.join(ctx.stagedBuild, "install", pluginId);
        put(directory, "companion.txt", "part of the verified build");
        const read = fs.readdirSync;
        let deleted = false;
        t.mock.method(fs, "readdirSync", (dir, options) => {
            const entries = read(dir, options);
            if (!deleted && dir === directory) {
                fs.unlinkSync(path.join(directory, "companion.txt"));
                deleted = true;
            }
            return entries;
        });
        await assert.rejects(apply(ctx, "success"), /companion\.txt/);
        assert.equal(deleted, true);
        checkSource(ctx.repo, before);
        assert.equal(fs.existsSync(ctx.outputDir), false);
        assert.equal(transaction.pendingRecovery(ctx), false);
    });

    test("rejects a linked installation entry even when listed as a directory", async t => {
        const {root, ctx} = fixture(t);
        const outside = path.join(root, "outside");
        put(outside, "private", "retained");
        const plugin = path.join(ctx.stagedBuild, "install", pluginId);
        const alias = path.join(plugin, "outside-alias");
        try { fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir"); }
        catch (error) {
            if (process.platform === "win32" && error.code === "EPERM") return t.skip("Windows denied the test junction");
            throw error;
        }
        overrideDirectoryHints(t, (dir, name) => {
            if (dir === plugin && name === "outside-alias") return "directory";
        });
        await assert.rejects(apply(ctx, "success"), /outside-alias/);
        checkSource(ctx.repo, before);
        assert.equal(fs.readFileSync(path.join(outside, "private"), "utf8"), "retained");
        assert.equal(fs.existsSync(ctx.outputDir), false);
        assert.equal(transaction.pendingRecovery(ctx), false);
    });

    test("restores the previous source and withdraws a failed build", async t => {
        const {ctx} = fixture(t);
        await assert.rejects(apply(ctx, "reject-build"), /postpublication/);
        checkSource(ctx.repo, before);
        assert.ok(!fs.existsSync(ctx.outputDir));
    });

    for (const [mode, status] of Object.entries(crashCodes)) {
        test(mode + " recovers on the following run", async t => {
            const {root, ctx} = fixture(t);
            const result = child(root, mode);
            assert.equal(result.status, status, result.stderr);
            assert.ok(transaction.pendingRecovery(ctx));
            await transaction.withWorkspaceLock(ctx, () => assert.match(transaction.recover(ctx), /Recovered/));
            checkSource(ctx.repo, before);
            assert.ok(!fs.existsSync(ctx.outputDir));
            assert.ok(!transaction.pendingRecovery(ctx));
        });
    }

    test("retains manual edits during rollback and resumes after review", async t => {
        const {ctx} = fixture(t);
        await assert.rejects(apply(ctx, "manual-edit"), /Recovery requires attention/);
        assert.equal(fs.readFileSync(path.join(ctx.repo, "f"), "utf8"), "user edit after updating");
        assert.ok(transaction.pendingRecovery(ctx));
        await assert.rejects(transaction.withWorkspaceLock(ctx, () => transaction.recover(ctx)), /local edit/);
        put(ctx.repo, "f", "new");
        await transaction.withWorkspaceLock(ctx, () => transaction.recover(ctx));
        checkSource(ctx.repo, before);
    });

    test("refuses concurrent updates from another process and releases its lock", async t => {
        const {root, ctx} = fixture(t);
        await transaction.withWorkspaceLock(ctx, () => {
            const result = child(root, "lock");
            assert.equal(result.status, 3, result.stderr);
            assert.match(result.stderr, /lock/);
        });
        await transaction.withWorkspaceLock(ctx, () => {});
        assert.ok(!fs.readdirSync(ctx.builds).some(name => name.startsWith(".rudonium-lock")));
    });

    test("leaves a pre-existing output directory intact", async t => {
        const {ctx} = fixture(t);
        put(ctx.outputDir, "retained", "existing");
        await assert.rejects(apply(ctx, "success"), /already exists/);
        checkSource(ctx.repo, before);
        assert.equal(fs.readFileSync(path.join(ctx.outputDir, "retained"), "utf8"), "existing");
    });

    for (const [mode, status] of [["revision-crash-after-detach", 82], ["revision-crash-after-publication", 83]]) {
        test(mode + " restores the former build, its prepared release and the source", async t => {
            const {root, ctx} = fixture(t);
            put(ctx.outputDir, "install/legacy.bin", "previous runtime");
            put(ctx.outputDir, "release/full.zip", "previous prepared files");
            const old = transaction.replaceableBuildId(ctx.outputDir);
            const result = child(root, mode);
            assert.equal(result.status, status, result.stderr);
            await transaction.withWorkspaceLock(ctx, () => transaction.recover(ctx));
            assert.equal(transaction.replaceableBuildId(ctx.outputDir), old);
            assert.equal(transaction.pendingRecovery(ctx), false);
            checkSource(ctx.repo, before);
        });
    }

    test("replaces only the verified version in place and rolls it back on a failed final check", async t => {
        for (const success of [false, true]) {
            const {ctx} = fixture(t);
            put(ctx.outputDir, "install/legacy.bin", "previous runtime");
            const old = transaction.replaceableBuildId(ctx.outputDir);
            if (!success) {
                await assert.rejects(apply(ctx, "revision-reject"), /revision check failed/);
                assert.equal(transaction.replaceableBuildId(ctx.outputDir), old);
                checkSource(ctx.repo, before);
            } else {
                await apply(ctx, "revision-ok");
                checkSource(ctx.repo, after);
                assert.equal(fs.existsSync(path.join(ctx.outputDir, "install/legacy.bin")), false);
                assert.equal(fs.readFileSync(path.join(ctx.outputDir, runtimeFile), "utf8"), "BUILT");
            }
        }
    });

    test("detects additions in an existing output before replacement, including empty directories", t => {
        const {ctx} = fixture(t);
        put(ctx.outputDir, "install/legacy.bin", "previous runtime");
        const id = transaction.replaceableBuildId(ctx.outputDir);
        fs.mkdirSync(path.join(ctx.outputDir, "work-in-progress"));
        assert.throws(() => transaction.commitUpdate({...ctx, previousBuildId:id, fromFiles:hashes(before), toFiles:hashes(after),
            verifySource() {}, verifyBuild() {}}), /previous verified build changed/);
        checkSource(ctx.repo, before);
        assert.ok(fs.statSync(path.join(ctx.outputDir, "work-in-progress")).isDirectory());
    });

    test("preserves untracked children when a directory becomes a file", async t => {
        const {ctx} = fixture(t);
        put(ctx.repo, "k/private", "local");
        await assert.rejects(apply(ctx, "success"), /ENOTEMPTY|EEXIST|EPERM/);
        assert.equal(fs.readFileSync(path.join(ctx.repo, "k/private"), "utf8"), "local");
        fs.unlinkSync(path.join(ctx.repo, "k/private"));
        checkSource(ctx.repo, before);
        assert.ok(!fs.existsSync(ctx.outputDir));
    });

    test("refuses a symlink ancestor and keeps the target intact", async t => {
        const {root, ctx} = fixture(t);
        const target = path.join(root, "private");
        fs.renameSync(path.join(ctx.repo, "k"), target);
        try { fs.symlinkSync(target, path.join(ctx.repo, "k"), "dir"); }
        catch (error) {
            if (process.platform === "win32" && error.code === "EPERM") {
                t.skip("Windows denied creation of the test directory symlink");
                return;
            }
            throw error;
        }
        await assert.rejects(apply(ctx, "success"), /directory/);
        assert.equal(fs.readFileSync(path.join(target, "v/name"), "utf8"), "dir becomes file");
        assert.ok(!transaction.pendingRecovery(ctx));
    });
}
