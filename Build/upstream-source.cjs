// SPDX-License-Identifier: GPL-3.0-only
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const objectId = /^[0-9a-f]{40}$/;
const maxSourceBytes = 256 * 1024 * 1024;

function readGit(directory, args, options = {}) {
    const result = spawnSync("git", ["--no-replace-objects", "-C", directory, ...args], {
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        ...options,
    });
    if (result.error) throw new Error("Cannot read the local Git checkout: " + result.error.message);
    if (result.status !== 0) throw new Error("Cannot read the pinned upstream revision. " + result.stderr.toString("utf8").trim());
    return result.stdout;
}

function treeEntries(directory, commit) {
    const listing = readGit(directory, ["ls-tree", "--full-tree", "-r", "-t", "-z", commit]);
    const names = new TextDecoder("utf-8", { fatal: true }).decode(listing).split("\0");
    if (names.pop() !== "") throw new Error("Incomplete Git tree listing.");
    return names.map(entry => {
        const match = /^(100644|100755|040000) (blob|tree) ([0-9a-f]{40})\t(.+)$/u.exec(entry);
        if (!match) throw new Error("Unsupported upstream Git entry (expected a regular file or directory).");
        const [, mode, type, id, name] = match;
        if (name.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\:\x00-\x1f]/u.test(part))) {
            throw new Error("Unexpected path in the upstream Git tree.");
        }
        return { name, id, type, mode };
    });
}

function readObjects(directory, objects) {
    const ids = Array.from(objects.keys());
    const output = readGit(directory, ["cat-file", "--batch"], {
        input: ids.join("\n") + "\n",
        maxBuffer: maxSourceBytes,
    });
    let cursor = 0;
    const contents = new Map();
    for (const [id, type] of objects) {
        const newline = output.indexOf(10, cursor);
        if (newline < 0) throw new Error("Incomplete upstream Git object header.");
        const [received, kind, length] = output.toString("ascii", cursor, newline).split(" ");
        const size = Number(length);
        if (received !== id || kind !== type || !Number.isSafeInteger(size) || size < 0 || newline + 1 + size >= output.length) {
            throw new Error("Missing or invalid upstream Git object: " + id);
        }
        const body = output.subarray(newline + 1, newline + 1 + size);
        const hash = crypto.createHash("sha1").update(type + " " + size + "\0").update(body).digest("hex");
        cursor = newline + 1 + size;
        if (hash !== id || output[cursor++] !== 10) throw new Error("Upstream Git object verification failed: " + id);
        contents.set(id, body);
    }
    if (cursor !== output.length) throw new Error("Unexpected trailing Git object data.");
    return contents;
}

function copyPinnedTree(directory, destination, commit) {
    if (!objectId.test(commit)) throw new Error("A full pinned Git commit is required.");
    const tree = readGit(directory, ["rev-parse", "--verify", commit + "^{tree}"]).toString("ascii").trim();
    if (!objectId.test(tree)) throw new Error("Cannot identify the pinned Git tree.");
    const entries = treeEntries(directory, commit);
    const objects = new Map([[commit, "commit"], [tree, "tree"]]);
    for (const entry of entries) objects.set(entry.id, entry.type);
    const contents = readObjects(directory, objects);
    if (!contents.get(commit).subarray(0, 46).equals(Buffer.from("tree " + tree + "\n"))) {
        throw new Error("Unexpected root tree in the pinned commit.");
    }
    fs.mkdirSync(destination);
    for (const entry of entries) {
        const filename = path.join(destination, ...entry.name.split("/"));
        if (entry.type === "tree") fs.mkdirSync(filename);
        else fs.writeFileSync(filename, contents.get(entry.id), { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    return { acquisition: "local-git-objects", verifiedTree: tree };
}

function copySuppliedSource(directory, destination, commit) {
    const root = path.resolve(directory);
    const git = fs.lstatSync(path.join(root, ".git"), { throwIfNoEntry: false });
    if (git) {
        if (!git.isDirectory() && !git.isFile()) throw new Error("Unsupported local .git entry.");
        return copyPinnedTree(root, destination, commit);
    }
    fs.cpSync(root, destination, {
        recursive: true,
        filter(file) {
            if ([".git", "node_modules"].includes(path.basename(file))) return false;
            if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Unexpected symbolic link in the supplied source: " + path.relative(root, file));
            return true;
        },
    });
    return { acquisition: "supplied-directory-unverified" };
}

module.exports = { copySuppliedSource };
