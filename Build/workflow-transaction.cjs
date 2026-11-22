// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const fs = require("node:fs");
const {cleanupTemporaryDirectory, hashFile, readDirectoryEntries, safePath} = require("./workflow-files.cjs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const sum = data => crypto.createHash("sha256").update(data).digest("hex");
const host = sum(os.hostname()).slice(0, 16);
const exists = file => fs.lstatSync(file, {throwIfNoEntry: false});
const journal = builds => path.join(builds, ".rudonium-transaction");
const nonce = () => crypto.randomUUID();
const hashPattern = /^[a-f0-9]{64}$/;
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function forceDisk(file, directory = false) {
    let fd;
    try {
        fd = fs.openSync(file, directory ? "r" : "r+");
        fs.fsyncSync(fd);
    } catch (error) {
        if (!directory || !["EPERM","EISDIR","EACCES","ENOTSUP","EINVAL","EBADF"].includes(error.code)) throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeMarker(file, data = "") {
    fs.writeFileSync(file, data, {flag: "wx", mode: 0o600});
    forceDisk(file); forceDisk(path.dirname(file), true);
}

function normalDirectory(dir) {
    const info = exists(dir);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Expected an ordinary directory: " + dir);
    return fs.realpathSync(dir);
}

// Independent claim names keep one process from unlinking the lock of a newer owner.
async function withWorkspaceLock({repo, builds}, action) {
    normalDirectory(repo);
    fs.mkdirSync(builds, {recursive: true});
    builds = normalDirectory(builds);
    const prefix = ".rudonium-lock-";
    const claim = prefix + host + "-" + process.pid + "-" + nonce();
    const own = path.join(builds, claim);
    writeMarker(own, JSON.stringify({pid: process.pid, repo, created: new Date().toISOString()}));
    try {
        for (const name of fs.readdirSync(builds)) {
            if (name === claim || !name.startsWith(prefix)) continue;
            const match = /^\.rudonium-lock-([a-f0-9]{16})-(\d+)-([a-f0-9-]{36})$/.exec(name);
            const other = path.join(builds, name);
            if (match && match[1] === host) {
                try { process.kill(Number(match[2]), 0); }
                catch (error) {
                    if (error.code === "ESRCH") { fs.rmSync(other, {force: true}); continue; }
                    if (error.code !== "EPERM") throw error;
                }
            }
            if (exists(other)) throw new Error("An update or release preparation holds the workspace lock: " + other);
        }
        return await action();
    } finally { fs.rmSync(own, {force: true}); }
}

function relativeKey(key) {
    const parts = typeof key === "string" ? key.split("/") : [];
    if (!parts.length || parts.some(p => !p || p === "." || p === ".." || /[<>:"\\|?*\x00-\x1f]/.test(p) ||
        /[. ]$/.test(p) || /^\.git$/i.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
        throw new Error("Invalid transaction path: " + key);
    }
    return parts;
}

function fileAt(root, key, mkdir = false) {
    const parts = relativeKey(key);
    let dir = normalDirectory(root);
    for (const part of parts.slice(0, -1)) {
        dir = path.join(dir, part);
        const st = exists(dir);
        if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new Error("Unsafe parent directory: " + dir);
        if (!st && mkdir) fs.mkdirSync(dir);
    }
    return path.join(dir, parts.at(-1));
}

function fileHash(file) {
    const st = exists(file);
    if (!st) return null;
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("Expected an ordinary file: " + file);
    return hashFile(file);
}

function expectHash(file, hash) {
    if (fileHash(file) !== hash) throw new Error("File changed unexpectedly: " + file);
}

function treeHashes(root, includeDirectories = false) {
    const files = [];
    function walk(dir, prefix) {
        for (const entry of readDirectoryEntries(dir)) {
            const name = prefix + entry.name;
            relativeKey(name);
            const filename = safePath(root, name);
            if (entry.stat.isDirectory()) {
                if (includeDirectories) files.push([name + "/", null]);
                walk(filename, name + "/");
            } else files.push([name, hashFile(filename)]);
        }
        // A directory may have been replaced while one of its children was being read.
        normalDirectory(dir);
    }
    root = normalDirectory(root);
    walk(root, "");
    return sum(JSON.stringify(files));
}

// Include directories for replacement. Original journal hashes of new builds remain readable.
const replaceableBuildId = root => treeHashes(root, true);

function copyExact(from, to, hash) {
    expectHash(from, hash);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    const mode = fs.statSync(from).mode & 0o777;
    fs.chmodSync(to, mode | 0o200);
    forceDisk(to);
    fs.chmodSync(to, mode);
    expectHash(to, hash);
}

function installNew(temp, dest) {
    // Hard links (NTFS/POSIX) publish complete bytes without overwriting concurrent files.
    try { fs.linkSync(temp, dest); }
    catch (error) {
        if (!["EPERM","EOPNOTSUPP","ENOSYS","EXDEV"].includes(error.code)) throw error;
        copyExact(temp, dest, fileHash(temp));
    }
    forceDisk(path.dirname(dest), true);
}

function sidecars(dest, token, index) {
    const base = path.join(path.dirname(dest), ".rudonium-" + token + "-" + index);
    return {original: base + ".old", incoming: base + ".new"};
}

function detachJournal(tx) {
    const done = path.join(path.dirname(tx), ".rudonium-cleanup-" + nonce());
    fs.renameSync(tx, done); forceDisk(path.dirname(tx), true);
    cleanupTemporaryDirectory(done);
}

function pendingRecovery({builds}) { return !!exists(journal(builds)); }

function requirePlan(plan, repo) {
    if (!plan || ![1, 2].includes(plan.schema) || plan.repo !== repo || !semver.test(plan.outputName) ||
        !/^[a-f0-9-]{36}$/.test(plan.token) || !Array.isArray(plan.ops) ||
        typeof plan.publish !== "boolean" || !hashPattern.test(plan.buildId)) throw new Error("Invalid recovery journal.");
    if (plan.schema === 2 && (!plan.publish || !hashPattern.test(plan.previousBuildId))) throw new Error("Invalid former build in recovery journal.");
    const keys = new Set();
    for (const op of plan.ops) {
        relativeKey(op.key);
        if (keys.has(op.key) || op.before === op.after || [op.before,op.after].some(h => h !== null && !hashPattern.test(h)))
            throw new Error("Invalid recovery journal entry: " + op.key);
        keys.add(op.key);
    }
}

// A tracked file may become a directory or the reverse. Remove only directories
// that used to contain listed files and are now empty. Unknown contents survive.
function clearFormerDirectory(repo, key, sourceKeys) {
    const dirs = new Set();
    const prefix = key + "/";
    for (const former of sourceKeys) {
        if (!former.startsWith(prefix)) continue;
        let parent = former.slice(0, former.lastIndexOf("/"));
        while (parent === key || parent.startsWith(prefix)) {
            dirs.add(parent);
            parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
        }
    }
    if (!dirs.has(key)) throw new Error("A directory occupies a file path: " + key);
    for (const relative of [...dirs].sort((a,b) => b.length - a.length)) {
        const member = fileAt(repo, relative);
        const st = exists(member);
        if (st) {
            if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unexpected directory contents: " + member);
            fs.rmdirSync(member);
        }
    }
}

// Recover one started operation. Unknown edits prevent cleanup; original bytes remain available.
function undo(repo, tx, plan, index) {
    const op = plan.ops[index];
    const dest = fileAt(repo, op.key, op.before !== null);
    const {original, incoming} = sidecars(dest, plan.token, index);
    if (exists(dest)?.isDirectory() && op.before !== null) {
        clearFormerDirectory(repo, op.key, plan.ops.filter(item => item.after !== null).map(item => item.key));
    }
    const current = fileHash(dest), captured = fileHash(original);
    const desired = captured ?? op.before;
    if (current !== desired && current !== null && current !== op.after)
        throw new Error("A local edit requires review before rollback: " + dest);
    if (current !== desired) {
        const restore = captured !== null ? original : path.join(tx, "before", String(index));
        if (desired !== null) expectHash(restore, desired);
        if (current !== null) fs.unlinkSync(dest);
        if (desired !== null) installNew(restore, dest);
        expectHash(dest, desired);
    }
    if (exists(original)) { expectHash(dest, captured); fs.unlinkSync(original); }
    // This per-operation temporary belongs to our exclusive, UUID-named journal.
    if (exists(incoming)) fs.unlinkSync(incoming);
    if (exists(path.dirname(dest))) forceDisk(path.dirname(dest), true);
}

function recover({repo, builds}) {
    repo = normalDirectory(repo); builds = normalDirectory(builds);
    const tx = journal(builds);
    if (!exists(tx)) return "";
    normalDirectory(tx);
    const plan = JSON.parse(fs.readFileSync(path.join(tx, "plan.json"), "utf8"));
    requirePlan(plan, repo);
    if (exists(path.join(tx, "done"))) { detachJournal(tx); return "Completed update journal cleaned."; }
    const output = path.join(builds, plan.outputName);
    if (plan.publish && exists(path.join(tx, "publishing")) && !exists(path.join(tx, "result")) && exists(output)) {
        if (treeHashes(output) !== plan.buildId) throw new Error("Changed published result retained for review: " + output);
        fs.renameSync(output, path.join(tx, "result")); forceDisk(builds, true);
    }
    const previous = path.join(tx, "previous-result");
    if (plan.schema === 2 && exists(previous)) {
        // A crash can occur on either side of publishing the replacement. Never displace unknown files.
        if (exists(output)) throw new Error("The former build cannot be restored over an unexpected directory: " + output);
        fs.renameSync(previous, output);
        forceDisk(builds, true);
    }
    for (let i = plan.ops.length - 1; i >= 0; --i) {
        const restored = path.join(tx, "undone", String(i));
        if (exists(path.join(tx, "started", String(i))) && !exists(restored)) {
            undo(repo, tx, plan, i);
            writeMarker(restored);
        }
    }
    detachJournal(tx);
    return "Recovered the source files preceding the interrupted update.";
}

function planOps(from, to) {
    const ops = [];
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
        const before = Object.hasOwn(from, key) ? from[key] : null;
        const after = Object.hasOwn(to, key) ? to[key] : null;
        if (before !== after) ops.push({key, before, after});
    }
    // Remove old paths before introducing new names.
    return ops.sort((a,b) => Number(a.after !== null) - Number(b.after !== null) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function commitUpdate({repo, builds, stagedSource, stagedBuild, outputDir, fromFiles, toFiles, verifySource, verifyBuild, previousBuildId}) {
    repo = normalDirectory(repo); builds = normalDirectory(builds); stagedSource = normalDirectory(stagedSource);
    outputDir = path.resolve(outputDir);
    if (path.dirname(outputDir) !== builds || !semver.test(path.basename(outputDir))) throw new Error("Invalid build destination");
    if (typeof verifySource !== "function" || typeof verifyBuild !== "function") throw new Error("Missing verification callbacks");
    if (pendingRecovery({builds})) throw new Error("Previous transaction requires recovery in " + journal(builds));
    if (previousBuildId !== undefined) {
        if (!stagedBuild || !hashPattern.test(previousBuildId) || replaceableBuildId(outputDir) !== previousBuildId)
            throw new Error("The previous verified build changed: " + outputDir);
    } else if (stagedBuild && exists(outputDir)) throw new Error("Build destination already exists: " + outputDir);
    const result = normalDirectory(stagedBuild || outputDir);
    if (stagedBuild && !result.startsWith(builds + path.sep)) throw new Error("Build result must be staged inside " + builds);
    verifyBuild(result);
    const plan = {schema: 1, token: nonce(), repo, outputName: path.basename(outputDir), publish: !!stagedBuild,
        buildId: treeHashes(result), ops: planOps(fromFiles, toFiles)};
    if (previousBuildId !== undefined) {
        plan.schema = 2;
        plan.previousBuildId = previousBuildId;
    }
    requirePlan(plan, repo);
    const draft = fs.mkdtempSync(path.join(builds, ".rudonium-prepare-"));
    const tx = journal(builds);
    try {
        for (const name of ["before","after","started","undone"]) fs.mkdirSync(path.join(draft, name));
        plan.ops.forEach((op,i) => {
            if (op.before !== null) copyExact(fileAt(repo, op.key), path.join(draft, "before", String(i)), op.before);
            if (op.after !== null) copyExact(fileAt(stagedSource, op.key), path.join(draft, "after", String(i)), op.after);
        });
        writeMarker(path.join(draft, "plan.json"), JSON.stringify(plan));
        if (plan.publish) fs.renameSync(result, path.join(draft, "result"));
        fs.renameSync(draft, tx); forceDisk(builds, true);
    } catch (error) { cleanupTemporaryDirectory(draft); throw error; }

    try {
        plan.ops.forEach((op,i) => {
            const dest = fileAt(repo, op.key, op.after !== null);
            const {original, incoming} = sidecars(dest, plan.token, i);
            if (exists(original) || exists(incoming)) throw new Error("Unexpected temporary file near: " + dest);
            if (op.before === null && exists(dest)?.isDirectory()) {
                clearFormerDirectory(repo, op.key, Object.keys(fromFiles));
            }
            expectHash(dest, op.before);
            writeMarker(path.join(tx, "started", String(i)));
            if (op.after !== null) copyExact(path.join(tx, "after", String(i)), incoming, op.after);
            if (op.before !== null) {
                fs.renameSync(dest, original);
                expectHash(original, op.before);
            }
            if (op.after !== null) installNew(incoming, dest);
            expectHash(dest, op.after);
            if (op.before !== null) { expectHash(original, op.before); fs.unlinkSync(original); }
            if (op.after !== null) fs.unlinkSync(incoming);
            forceDisk(path.dirname(dest), true);
        });
        verifySource();
        if (plan.publish) {
            if (plan.schema === 2) {
                if (replaceableBuildId(outputDir) !== previousBuildId) throw new Error("The previous build changed during the update: " + outputDir);
            } else if (exists(outputDir)) throw new Error("Build destination appeared during the update: " + outputDir);
            writeMarker(path.join(tx, "publishing"));
            if (plan.schema === 2) {
                fs.renameSync(outputDir, path.join(tx, "previous-result"));
                forceDisk(builds, true);
                forceDisk(tx, true);
            }
            if (exists(outputDir)) throw new Error("Build destination appeared during publication: " + outputDir);
            fs.renameSync(path.join(tx, "result"), outputDir);
            forceDisk(builds, true);
        }
        verifyBuild(outputDir);
        if (treeHashes(outputDir) !== plan.buildId) throw new Error("Build files changed during publication: " + outputDir);
        verifySource();
        if (plan.schema === 2 && replaceableBuildId(path.join(tx, "previous-result")) !== previousBuildId)
            throw new Error("The previous build changed during publication.");
        writeMarker(path.join(tx, "done"));
    } catch (error) {
        try { recover({repo, builds}); }
        catch (rollback) { throw new Error(error.message + "\nRecovery requires attention: " + rollback.message + "\nKeep: " + tx, {cause: error}); }
        throw error;
    }
    detachJournal(tx);
}

module.exports = {withWorkspaceLock, pendingRecovery, recover, commitUpdate, replaceableBuildId};
