// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const reserved = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu;
const checksum = /^[a-f0-9]{64}$/u;
const privateNames = new Set([".git", ".obsidian", ".trash", ".npmrc", ".env", "node_modules", ".npm", ".idea", ".vscode",
    "__pycache__", ".pytest_cache", ".ruff_cache", ".ds_store", "thumbs.db", "desktop.ini"]);
const rootGenerated = new Set(["main.js", "main.js.map", "dist", "coverage", "logs", ".rollup.cache", ".rpt2_cache"]);

// These rules apply equally to the reference, the live tree, staging and restoration.
// All other files are project files, independent of Git tracking and ignore rules.
function excluded(relative) {
    const parts = relative.toLowerCase().split("/");
    return parts.some(name => privateNames.has(name) || /^\.env\./u.test(name) ||
        /\.(?:zip|apkg|colpkg|anki2(?:-wal|-shm)?|log|tsbuildinfo|ffs_(?:db|lock|tmp)|pyc|pfx|pem|key)$/u.test(name)) ||
        rootGenerated.has(parts[0]) || /^release-\d+\.\d+\.\d+$/u.test(parts[0]) ||
        (parts[0] === "build" && (parts[1] === "build-error.txt" || /^\.build-/u.test(parts[1] || ""))) ||
        (parts[0] === "tests" && ["specs_gen", "test_outputs", "test_vault", "test_config"].includes(parts[1])) ||
        (parts[0] === "tests" && parts[1] === "defaults" && parts[2] === "test_config");
}

function partsOf(relative) {
    if (typeof relative !== "string" || !relative || relative !== relative.normalize("NFC")) {
        throw new Error("Invalid or non-NFC relative path: " + relative);
    }
    const parts = relative.split("/");
    for (const part of parts) {
        if (!part || part === "." || part === ".." || /[\\:<>|"*?\x00-\x1f\x7f]/u.test(part) ||
            /[. ]$/u.test(part) || reserved.test(part)) throw new Error("Unsafe relative path: " + relative);
    }
    return parts;
}

// Also rejects naming a directory and a regular file with the same (possibly folded) name.
function registerPath(names, name, directory) {
    const parts = partsOf(name);
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
        prefix += (i ? "/" : "") + parts[i];
        const key = prefix.toLowerCase();
        const dir = i < parts.length - 1 || directory;
        const previous = names.get(key);
        if (previous && (previous.name !== prefix || previous.dir !== dir || !dir)) {
            throw new Error("Duplicate or conflicting path: " + prefix);
        }
        names.set(key, {name: prefix, dir});
    }
}

function realDirectory(dir) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Expected a real directory: " + dir);
}

// Windows cloud directories can have incomplete type hints in a directory listing.
// Inspect each named entry without following links before deciding how to traverse it.
function readDirectoryEntries(directory) {
    realDirectory(directory);
    return fs.readdirSync(directory).sort().map(name => {
        const filename = path.join(directory, name);
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink()) throw new Error("Unexpected symbolic link or junction: " + filename);
        if (!stat.isDirectory() && !stat.isFile()) throw new Error("Unsupported filesystem entry: " + filename);
        return {name, stat};
    });
}

function safePath(root, relative) {
    realDirectory(root);
    const parts = partsOf(relative);
    let dest = root;
    for (let i = 0; i < parts.length; i++) {
        dest = path.join(dest, parts[i]);
        const stat = fs.lstatSync(dest, {throwIfNoEntry: false});
        if (stat && (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))) {
            throw new Error("Unsafe path component: " + dest);
        }
    }
    return dest;
}

function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a, b) {
    return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function regularStat(filename) {
    const stat = fs.lstatSync(filename, {bigint: true});
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected a regular file: " + filename);
    return stat;
}

function readLimited(fd, expectedSize) {
    // One extra byte detects growth or a provider returning more data than its handle reported.
    const buffer = Buffer.allocUnsafe(Number(expectedSize) + 1);
    let used = 0;
    while (used < buffer.length) {
        const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
        if (count === 0) break;
        used += count;
    }
    return buffer.subarray(0, used);
}

function readSample(filename, maximum) {
    const pathBefore = regularStat(filename);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const fd = fs.openSync(filename, flags);
    try {
        const handleBefore = fs.fstatSync(fd, {bigint: true});
        if (!handleBefore.isFile()) throw new Error("Expected a regular file: " + filename);
        if (maximum !== undefined && handleBefore.size > maximum) throw new Error("File exceeds the size limit: " + filename);
        const bytes = maximum === undefined ? fs.readFileSync(fd) : readLimited(fd, handleBefore.size);
        const handleAfter = fs.fstatSync(fd, {bigint: true});
        if (maximum !== undefined && (bytes.length > maximum || handleAfter.size > maximum)) {
            throw new Error("File exceeds the size limit: " + filename);
        }
        const pathAfter = regularStat(filename);
        if (!sameIdentity(pathBefore, pathAfter) || !sameIdentity(handleBefore, handleAfter) ||
            handleAfter.size !== BigInt(bytes.length) || handleBefore.size !== handleAfter.size) {
            return null;
        }
        // Windows sync providers can expose different timestamps and incomplete IDs by path and by handle.
        // Compare each set of timestamps only with a second observation from the same API.
        const identified = pathAfter.ino !== 0n && sameIdentity(pathAfter, handleAfter);
        return {bytes, stable: identified && unchanged(pathBefore, pathAfter) && unchanged(handleBefore, handleAfter)};
    } finally { fs.closeSync(fd); }
}

function regularBytes(filename, maximum) {
    let previous;
    let cause;
    for (let attempt = 0; attempt < 3; attempt++) {
        let sample;
        try { sample = readSample(filename, maximum); }
        catch (error) {
            if (!["ENOENT", "ESTALE", "EAGAIN", "EBUSY"].includes(error.code)) throw error;
            cause = error;
        }
        if (sample && (sample.stable || (previous && sample.bytes.equals(previous)))) return sample.bytes;
        // An independent open confirms content when an ID is unavailable or only metadata fluctuates.
        previous = sample?.bytes;
    }
    throw new Error("Не удалось подтвердить содержимое файла: " + filename +
        ". Дождитесь завершения записи или облачной синхронизации и повторите команду.", {cause});
}

function hashFile(filename) { return sha256(regularBytes(filename)); }

function manifestFromFiles(files) {
    const keys = Object.keys(files).sort();
    const entries = keys.map(key => [key, files[key]]);
    return {schema: 1, id: sha256(Buffer.from(JSON.stringify(entries), "utf8")), files: Object.fromEntries(entries)};
}

function validateManifest(manifest) {
    if (!manifest || manifest.schema !== 1 || !manifest.files || typeof manifest.files !== "object" ||
        Array.isArray(manifest.files) || !checksum.test(manifest.id)) throw new Error("Invalid source manifest");
    const seen = new Map();
    for (const [key, digest] of Object.entries(manifest.files)) {
        registerPath(seen, key, false);
        if (excluded(key) || typeof digest !== "string" || !checksum.test(digest)) {
            throw new Error("Invalid source manifest entry: " + key);
        }
    }
    if (manifestFromFiles(manifest.files).id !== manifest.id) throw new Error("Incorrect source manifest identity");
    return manifest;
}

function scanTree(root) {
    realDirectory(root);
    const files = Object.create(null), seen = new Map();
    function visit(dir, prefix) {
        for (const name of fs.readdirSync(dir)) {
            const key = prefix + name;
            if (excluded(key)) continue;
            const disk = path.join(dir, name);
            const stat = fs.lstatSync(disk);
            registerPath(seen, key, stat.isDirectory());
            if (stat.isDirectory()) visit(disk, key + "/");
            else if (stat.isFile()) files[key] = hashFile(disk);
            else throw new Error("Unsupported project entry: " + key);
        }
    }
    visit(root, "");
    return manifestFromFiles(files);
}

function diffFiles(a, b) {
    return [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort()
        .filter(key => !Object.hasOwn(a.files, key) || !Object.hasOwn(b.files, key) || a.files[key] !== b.files[key]);
}

function emptyDestination(dir) {
    fs.mkdirSync(dir, {recursive: true});
    realDirectory(dir);
    if (fs.readdirSync(dir).length) throw new Error("Output directory must be empty: " + dir);
}

function writeFile(root, key, bytes) {
    const target = safePath(root, key);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes, {flag: "wx"});
}

function copyTree(source, dest, manifest) {
    validateManifest(manifest);
    emptyDestination(dest);
    const before = scanTree(source);
    if (before.id !== manifest.id) throw new Error("Source changed: " + diffFiles(manifest, before).join(", "));
    for (const [key, expected] of Object.entries(manifest.files)) {
        const bytes = regularBytes(safePath(source, key));
        if (sha256(bytes) !== expected) throw new Error("Source changed while copying: " + key);
        writeFile(dest, key, bytes);
    }
    return manifest;
}

// Deterministic ZIP32 with DOS 1980-01-01 timestamps. The source package is ~8 MiB.
// Read regular UTF-8 names only, STORED or DEFLATE, and validate both headers before extracting.
const maxArchive = 512 * 1024 * 1024, maxEntry = 128 * 1024 * 1024;
const crcTable = Uint32Array.from({length: 256}, (_, i) => {
    let n = i;
    for (let j = 0; j < 8; j++) n = (n & 1) ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
    return n >>> 0;
});
function crc32(bytes) {
    let n = 0xffffffff;
    for (const byte of bytes) n = (n >>> 8) ^ crcTable[(n ^ byte) & 255];
    return (n ^ 0xffffffff) >>> 0;
}

function writeZip(zipPath, entries) {
    const files = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (files.length >= 65535) throw new Error("Too many files in source ZIP");
    const locals = [], central = [], names = new Map();
    let offset = 0, expanded = 0;
    for (const {name, data} of files) {
        registerPath(names, name, false);
        const filename = Buffer.from(name, "utf8");
        const bytes = Buffer.from(data);
        expanded += bytes.length;
        if (filename.length > 65535 || bytes.length > maxEntry || expanded > maxArchive) throw new Error("ZIP too large: " + name);
        const packed = zlib.deflateRawSync(bytes);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
        local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
        locals.push(local, filename, packed);
        const item = Buffer.alloc(46);
        item.writeUInt32LE(0x02014b50, 0); item.writeUInt16LE(20, 4);
        local.copy(item, 6, 4, 30);
        item.writeUInt32LE(offset, 42);
        central.push(item, filename);
        offset += local.length + filename.length + packed.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    if (offset + directory.length + end.length > maxArchive) throw new Error("ZIP too large");
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    fs.writeFileSync(zipPath, Buffer.concat([...locals, directory, end]), {flag: "wx"});
}

function readZip(zipPath) {
    const raw = regularBytes(zipPath, maxArchive);
    const invalid = () => { throw new Error("Malformed or unsupported ZIP: " + zipPath); };
    let end = raw.length - 22;
    const lower = Math.max(0, end - 65535);
    for (; end >= lower; end--) {
        if (raw.readUInt32LE(end) === 0x06054b50 && end + 22 + raw.readUInt16LE(end + 20) === raw.length) break;
    }
    if (end < lower || raw.readUInt32LE(end + 4) !== 0) invalid();
    const count = raw.readUInt16LE(end + 10), boundary = raw.readUInt32LE(end + 16);
    if (raw.readUInt16LE(end + 8) !== count || boundary + raw.readUInt32LE(end + 12) !== end) invalid();
    let pos = boundary, expanded = 0;
    const files = new Map(), names = new Map(), explicit = new Set();
    for (let index = 0; index < count; index++) {
        if (pos + 46 > end || raw.readUInt32LE(pos) !== 0x02014b50) invalid();
        const flags = raw.readUInt16LE(pos + 8), method = raw.readUInt16LE(pos + 10);
        const crc = raw.readUInt32LE(pos + 16), packed = raw.readUInt32LE(pos + 20), size = raw.readUInt32LE(pos + 24);
        const nlen = raw.readUInt16LE(pos + 28), xlen = raw.readUInt16LE(pos + 30), clen = raw.readUInt16LE(pos + 32);
        const mode = raw.readUInt32LE(pos + 38) >>> 16, type = mode & 0o170000, at = raw.readUInt32LE(pos + 42);
        const nameBytes = raw.subarray(pos + 46, pos + 46 + nlen), name = nameBytes.toString("utf8");
        if (pos + 46 + nlen + xlen + clen > end || !Buffer.from(name, "utf8").equals(nameBytes) ||
            (flags & ~0x080e) || (method !== 0 && method !== 8) || raw.readUInt16LE(pos + 34) !== 0 ||
            (type && type !== 0o100000 && type !== 0o040000)) invalid();
        const directory = name.endsWith("/");
        if ((directory && (size || type === 0o100000)) || (!directory && type === 0o040000) || explicit.has(name)) invalid();
        explicit.add(name);
        registerPath(names, directory ? name.slice(0, -1) : name, directory);
        if (at + 30 > boundary || raw.readUInt32LE(at) !== 0x04034b50 || raw.readUInt16LE(at + 6) !== flags ||
            raw.readUInt16LE(at + 8) !== method || raw.readUInt16LE(at + 26) !== nlen ||
            !raw.subarray(at + 30, at + 30 + nlen).equals(nameBytes)) invalid();
        if (!(flags & 8) && (raw.readUInt32LE(at + 14) !== crc || raw.readUInt32LE(at + 18) !== packed ||
            raw.readUInt32LE(at + 22) !== size)) invalid();
        const start = at + 30 + nlen + raw.readUInt16LE(at + 28);
        expanded += size;
        if (start + packed > boundary || size > maxEntry || expanded > maxArchive) invalid();
        const compressed = raw.subarray(start, start + packed);
        const bytes = method === 0 ? compressed : zlib.inflateRawSync(compressed, {maxOutputLength: Math.max(1, size)});
        if (bytes.length !== size || crc32(bytes) !== crc) invalid();
        if (!directory) files.set(name, bytes);
        pos += 46 + nlen + xlen + clen;
    }
    if (pos !== end) invalid();
    return files;
}

function extractSourceZip(zipPath, dest, expectedManifests) {
    const allowed = expectedManifests.map(validateManifest);
    const entries = readZip(zipPath);
    const matches = [];
    // A published legacy ZIP can have both an installer and a repository; require the full tree.
    for (const name of entries.keys()) {
        if (name !== "manifest.json" && !name.endsWith("/manifest.json")) continue;
        const prefix = name.slice(0, -"manifest.json".length);
        const files = Object.create(null);
        for (const [full, bytes] of entries) {
            if (!full.startsWith(prefix)) continue;
            const key = full.slice(prefix.length);
            if (!excluded(key)) files[key] = sha256(bytes);
        }
        const snapshot = manifestFromFiles(files);
        if (allowed.some(item => item.id === snapshot.id)) matches.push({snapshot, prefix});
    }
    if (matches.length !== 1) throw new Error("Expected exactly one matching complete source tree in " + zipPath);
    const {snapshot, prefix} = matches[0];
    emptyDestination(dest);
    for (const key of Object.keys(snapshot.files)) writeFile(dest, key, entries.get(prefix + key));
    return snapshot;
}

// Only for private staging paths after their contents are no longer needed.
// Interrupted transactions and integrity checks must be handled before calling this function.
function cleanupTemporaryDirectory(directory, warn = console.warn) {
    try {
        fs.rmSync(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 150});
    } catch (error) {
        warn("Temporary cleanup deferred: " + directory + " (" + (error.code || error.message) + ").");
    }
}

module.exports = {sha256, hashFile, regularBytes, readDirectoryEntries, cleanupTemporaryDirectory, excluded, safePath, scanTree, manifestFromFiles, validateManifest, diffFiles,
    copyTree, readZip, writeZip, extractSourceZip};
