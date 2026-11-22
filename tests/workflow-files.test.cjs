// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {sha256, scanTree, safePath, validateManifest, diffFiles, copyTree, writeZip, readZip, extractSourceZip} = require("../Build/workflow-files.cjs");

function temp(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "рудониум workflow "));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return root;
}
function put(root, name, value) {
    const p = path.join(root, name);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, value);
}
function fixtures(root) {
    put(root, "manifest.json", '{"id":"rudonium-anki-toolkit"}\n');
    put(root, "src/русский ответ.ts", Buffer.from([0, 255, 10]));
    put(root, ".github/workflows/build.yml", "\r\n");
}

test("all project files including new hidden files count, machine state is excluded, bytes remain exact", t => {
    const root = temp(t);
    fixtures(root);
    put(root, "main.js", "built");
    put(root, ".git", "gitdir: ../user-path");
    put(root, ".npmrc", "machine");
    put(root, ".env.local", "local");
    put(root, "node_modules/module/index.js", "load");
    put(root, "Build/.build-run/log.txt", "temp");
    put(root, ".gitignore", "*.custom");
    const a = scanTree(root);
    assert.deepEqual(Object.keys(a.files), [".github/workflows/build.yml", ".gitignore", "manifest.json", "src/русский ответ.ts"]);
    put(root, "new.custom", "new data");
    put(root, ".github/workflows/build.yml", "\n");
    const b = scanTree(root);
    assert.deepEqual(diffFiles(a, b), [".github/workflows/build.yml", "new.custom"]);
    assert.throws(() => validateManifest({...b, id: "0".repeat(64)}), /identity/);
    assert.throws(() => validateManifest({...b, files: {...b.files, ".git/config": sha256("x")}}), /entry/);
});

test("source snapshots from an archive preserve private files outside the matching subtree", t => {
    const work = temp(t);
    const source = path.join(work, "local"), target = path.join(work, "restored");
    fixtures(source);
    const snapshot = scanTree(source);
    const prefix = "GitFlic-0.10.4/repository/";
    const entries = Object.keys(snapshot.files).map(name => ({name: prefix + name, data: fs.readFileSync(path.join(source, name))}));
    entries.push({name: prefix + ".git", data: Buffer.from("gitdir: private")},
        {name: "GitFlic-0.10.4/install/rudonium-anki-toolkit/manifest.json", data: Buffer.from("{}")});
    const a = path.join(work, "a.zip"), b = path.join(work, "b.zip");
    writeZip(a, entries); writeZip(b, entries.reverse());
    assert.deepEqual(fs.readFileSync(a), fs.readFileSync(b));
    assert.deepEqual(extractSourceZip(a, target, [snapshot]), snapshot);
    assert.deepEqual(scanTree(target), snapshot);
    assert.equal(fs.existsSync(path.join(target, ".git")), false);
    assert.throws(() => extractSourceZip(a, target, [snapshot]), /must be empty/);
    copyTree(target, path.join(work, "copied"), snapshot);
    assert.deepEqual(scanTree(path.join(work, "copied")), snapshot);
    put(source, "new.md", "untracked");
    assert.throws(() => copyTree(source, path.join(work, "changed"), snapshot), /new.md/);
});

test("archive paths and payload corruption are rejected, before extraction", t => {
    const work = temp(t);
    const zip = path.join(work, "source.zip");
    for (const name of ["../bad", "/root", "A:stream", "NUL.txt", "end.", "sub\\one", "A/../file"]) {
        assert.throws(() => writeZip(zip, [{name,data:Buffer.from("x")}]), /Unsafe relative path/);
        assert.equal(fs.existsSync(zip), false);
    }
    for (const pair of [["a","A"], ["Docs/X","docs/Y"], ["dir","dir/a"]]) {
        assert.throws(() => writeZip(zip, pair.map(name => ({name,data:Buffer.from("x")}))), /Duplicate or conflicting/);
    }
    writeZip(zip, [{name:"aa", data:Buffer.from("value")}]);
    const original = fs.readFileSync(zip);
    const central = original.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    const escaped = Buffer.from(original);
    escaped.write("..", 30); escaped.write("..", central+46);
    fs.writeFileSync(zip, escaped);
    assert.throws(() => readZip(zip), /Unsafe relative path/);
    const symlink = Buffer.from(original);
    symlink.writeUInt32LE((0o120777 * 0x10000) >>> 0, central+38);
    fs.writeFileSync(zip, symlink);
    assert.throws(() => readZip(zip), /unsupported ZIP/);
    const bad = Buffer.from(original); bad[33] ^= 0x33;
    fs.writeFileSync(zip, bad);
    assert.throws(() => readZip(zip));
    for (const name of ["../dest", ".git/../dest", "x/NUL.log"]) {
        assert.throws(() => safePath(work,name), /Unsafe relative path/);
    }
});
