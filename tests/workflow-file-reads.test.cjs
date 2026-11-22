// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {hashFile, sha256, scanTree, copyTree} = require("../Build/workflow-files.cjs");

const original = "node_modules";
const edited = "NODE_MODULES";
const originalHash = "dba27c31aad935787bb275c3e5e4e957708f15386de599eff1db476022cd7e4c";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "Обновление Rudonium "));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const source = path.join(root, "project");
    fs.mkdirSync(source);
    const file = path.join(source, ".dockerignore");
    fs.writeFileSync(file, original);
    return {root, source, file};
}

// Model a Windows sync provider returning different stable metadata by pathname and by handle.
// All opens, reads, filesystem mutations and SHA-256 calculations still use real files.
function skewPathStats(t, file, unknownIdentity) {
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", function (name, ...options) {
        const result = lstat(name, ...options);
        if (name !== file || !result) return result;
        const value = n => typeof result.size === "bigint" ? BigInt(n) : n;
        result.dev = unknownIdentity ? value(0) : result.dev + value(1);
        result.ino = unknownIdentity ? value(0) : result.ino + value(17);
        for (const key of ["ctimeMs", "mtimeMs"]) result[key] += value(1000);
        for (const key of ["ctimeNs", "mtimeNs"]) {
            if (result[key] !== undefined) result[key] += 1000000000n;
        }
        return result;
    });
}

for (const unknownIdentity of [false, true]) {
    test("source hash and copy tolerate stable path/handle skew, unknown ID = " + unknownIdentity, t => {
        const {source, file, root} = fixture(t);
        const reference = scanTree(source);
        assert.equal(reference.files[".dockerignore"], originalHash);
        skewPathStats(t, file, unknownIdentity);
        assert.equal(hashFile(file), originalHash);
        assert.deepEqual(scanTree(source), reference);
        const out = path.join(root, "working copy");
        copyTree(source, out, reference);
        assert.equal(fs.readFileSync(path.join(out, ".dockerignore"), "utf8"), original);
        fs.writeFileSync(file, edited);
        const blocked = path.join(root, "changed copy");
        assert.throws(() => copyTree(source, blocked, reference), /\.dockerignore/);
        assert.equal(fs.existsSync(path.join(blocked, ".dockerignore")), false);
    });
}

// Every numbered handle read in these tests belongs to the synchronous hash operation.
function afterHandleRead(t, callback) {
    const read = fs.readFileSync;
    t.mock.method(fs, "readFileSync", function (handle, ...options) {
        const bytes = read(handle, ...options);
        if (typeof handle === "number") callback();
        return bytes;
    });
}

test("a one-time replacement during the read yields the new file's bytes", t => {
    const {file, root} = fixture(t);
    const replacement = path.join(root, "replacement");
    fs.writeFileSync(replacement, edited);
    let changed = false;
    afterHandleRead(t, () => {
        if (!changed) {
            changed = true;
            fs.renameSync(file, path.join(root, "previous"));
            fs.renameSync(replacement, file);
        }
    });
    assert.equal(hashFile(file), sha256(edited));
    assert.ok(changed);
});

test("repeated in-place writes stop the reader after bounded retries", t => {
    const {file} = fixture(t);
    let reads = 0;
    afterHandleRead(t, () => {
        reads++;
        assert.ok(reads < 20, "reader failed to stop retrying");
        fs.writeFileSync(file, reads % 2 ? edited : original);
        // A whole second keeps mutations observable even on low-resolution filesystems.
        fs.utimesSync(file, 1700000000 + reads, 1700000000 + reads);
    });
    assert.throws(() => hashFile(file), /\.dockerignore/);
    assert.ok(reads >= 1 && reads < 20);
});

test("same-size edits are detected with missing path identities and frozen timestamps", t => {
    const {file} = fixture(t);
    const fixedStats = (stat, identity) => {
        if (!stat.isFile()) return stat;
        const integer = n => typeof stat.size === "bigint" ? BigInt(n) : n;
        stat.dev = integer(identity);
        stat.ino = integer(identity);
        for (const key of ["mtimeMs", "ctimeMs"]) stat[key] = integer(1700000000000);
        for (const key of ["mtimeNs", "ctimeNs"]) {
            if (stat[key] !== undefined) stat[key] = 1700000000000000000n;
        }
        return stat;
    };
    const lstat = fs.lstatSync, fstat = fs.fstatSync;
    t.mock.method(fs, "lstatSync", (name, ...options) => {
        const value = lstat(name, ...options);
        return name === file ? fixedStats(value, 0) : value;
    });
    t.mock.method(fs, "fstatSync", (fd, ...options) => fixedStats(fstat(fd, ...options), 7));
    let reads = 0;
    afterHandleRead(t, () => {
        reads++;
        assert.ok(reads < 20, "reader failed to stop retrying");
        fs.writeFileSync(file, reads % 2 ? edited : original);
    });
    assert.throws(() => hashFile(file), /\.dockerignore/);
    assert.ok(reads >= 2 && reads < 20);
});

test("a path replaced by a symlink during reading is rejected", t => {
    const {file, root} = fixture(t);
    const target = path.join(root, "external");
    const link = path.join(root, "prepared link");
    fs.writeFileSync(target, edited);
    try { fs.symlinkSync(target, link, "file"); }
    catch (err) {
        if (process.platform === "win32" && err.code === "EPERM") {
            t.skip("Windows denied creation of the test symlink");
            return;
        }
        throw err;
    }
    let changed = false;
    afterHandleRead(t, () => {
        if (!changed) {
            changed = true;
            fs.renameSync(file, path.join(root, "previous"));
            fs.renameSync(link, file);
        }
    });
    assert.throws(() => hashFile(file), /\.dockerignore/);
    assert.ok(changed);
    assert.equal(fs.readFileSync(target, "utf8"), edited);
});
