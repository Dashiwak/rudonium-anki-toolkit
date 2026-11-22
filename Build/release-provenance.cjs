// SPDX-License-Identifier: GPL-3.0-only
"use strict";

// Уведомления собираются только при подготовке сборки. Работа плагина и экспорт
// карточек не читают эти файлы и не отправляют дополнительных запросов.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isUtf8 } = require("node:buffer");
const { regularBytes } = require("./workflow-files.cjs");

const snapshotDirectory = "UPSTREAM-SNAPSHOT";
const dependenciesDirectory = "LICENSES/dependencies";
const producer = "Rudonium release provenance";
const limits = Object.freeze({
    depth: 48,
    files: 20000,
    packageCount: 10000,
    jsonBytes: 16 * 1024 * 1024,
    noticeBytes: 8 * 1024 * 1024,
    snapshotBytes: 64 * 1024 * 1024,
    sourceBytes: 256 * 1024 * 1024,
    dependencyBytes: 128 * 1024 * 1024,
});
const noticeName = /^(?:(?:licen[cs]e|copying|notice|authors?|copyright)(?:[._ -].*)?|third[-_ ]party[-_ ](?:notices?|licen[cs]es?)(?:[._ -].*)?)$/i;
const legalDirectory = /^(?:licen[cs]es?|legal|notices?)$/i;
const rootReadme = /^readme(?:[._ -].*)?$/i;

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function jsonBytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8"); }
function fail(message) { throw new Error("Release provenance: " + message); }

function rootDirectory(directory) {
    const absolute = path.resolve(directory);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("a real directory is required.");
    return fs.realpathSync(absolute);
}

function parts(relative) {
    if (typeof relative !== "string" || !relative || relative.length > 4096 ||
        relative.split("/").some(part => !part || part === "." || part === ".." || /[\\:\u0000-\u001f]/u.test(part))) {
        fail("invalid relative path.");
    }
    return relative.split("/");
}

// Не переходим по ссылкам, в том числе по ссылке в промежуточном каталоге.
function checked(root, relative, optional = false) {
    let absolute = root;
    const segments = parts(relative);
    for (let index = 0; index < segments.length; index++) {
        absolute = path.join(absolute, segments[index]);
        let info;
        try { info = fs.lstatSync(absolute); }
        catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }
        if (info.isSymbolicLink()) fail("symbolic link is not allowed: " + relative);
        if (index < segments.length - 1 && !info.isDirectory()) fail("a path component is not a directory: " + relative);
    }
    return absolute;
}

function readRegular(root, relative, maximum = limits.noticeBytes) {
    return regularBytes(checked(root, relative), maximum);
}

function readJson(root, relative) {
    const value = JSON.parse(readRegular(root, relative, limits.jsonBytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("JSON object required: " + relative);
    return value;
}

function ensureDirectory(root, relative) {
    let current = root;
    for (const segment of parts(relative)) {
        current = path.join(current, segment);
        try { fs.mkdirSync(current); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        const info = fs.lstatSync(current);
        if (info.isSymbolicLink() || !info.isDirectory()) fail("unsafe output directory.");
    }
    return current;
}

function writeNew(root, relative, bytes) {
    const segments = parts(relative);
    if (segments.length > 1) ensureDirectory(root, segments.slice(0, -1).join("/"));
    fs.writeFileSync(path.join(root, ...segments), bytes, { flag: "wx", mode: 0o644 });
}

function requireGpl3(bytes, label) {
    const text = bytes.toString("utf8");
    if (bytes.length < 10000 || !/GNU GENERAL PUBLIC LICENSE\s+Version 3,\s+29 June 2007/u.test(text) ||
        !text.includes("END OF TERMS AND CONDITIONS")) fail("an intact GNU GPL version 3 document is required in " + label + ".");
}

// Pinned upstream includes prepared profiles for WebdriverIO and copies them when it runs.
function isUpstreamTestState(relative) {
    const parts = relative.toLowerCase().split(/[\\/]/u);
    if (parts[0] !== "tests") return false;
    const root = parts[1] === "defaults" ? 2 : 1;
    if (parts[root] === "test_config") return true;
    return ["test_vault", "test_vault_suites"].includes(parts[root]) &&
        parts.slice(root + 1).some(name => name === ".obsidian" || name === ".trash");
}

function isFreeFileSyncState(relative) {
    return /\.ffs_(?:db|lock|tmp)$/iu.test(relative);
}

function hashSourcePath(relative) {
    return relative === "main.ts" || relative.startsWith("src/") ||
        !relative.includes("/") && /^(?:manifest\.json|package(?:-lock)?\.json|styles\.css|tsconfig(?:[.-].*)?\.json|rollup\.config\.[cm]?js)$/u.test(relative);
}

function walkSource(root, visit, skipGeneratedDependencies = false) {
    let count = 0;
    const walk = (relative, depth, insideLegal = false) => {
        if (depth > limits.depth) fail("source directory depth limit exceeded.");
        const directory = relative ? checked(root, relative) : root;
        for (const name of fs.readdirSync(directory).sort()) {
            if ([".git", "node_modules", snapshotDirectory].includes(name) && !relative) continue;
            if (!relative && name.startsWith(".rudonium-provenance-")) continue;
            const child = relative ? relative + "/" + name : name;
            if (isUpstreamTestState(child) || isFreeFileSyncState(child) || skipGeneratedDependencies && child === dependenciesDirectory) continue;
            const target = checked(root, child);
            const info = fs.lstatSync(target);
            if (++count > limits.files) fail("source file count limit exceeded.");
            const legal = insideLegal || legalDirectory.test(name);
            if (info.isDirectory()) walk(child, depth + 1, legal);
            else if (info.isFile()) visit(child, legal || noticeName.test(name), info);
            else fail("unsupported source file type: " + child);
        }
    };
    walk("", 0);
}

/** Сохраняет доказательства происхождения, но не объявляет противоречие лицензий разрешённым. */
function captureUpstream(source, kit, options) {
    const root = rootDirectory(source), kitRoot = rootDirectory(kit);
    if (!options || !/^[a-f\d]{40}$/u.test(options.expectedCommit || "") ||
        typeof options.repository !== "string" || !/^https:\/\/[^\s]+$/u.test(options.repository) ||
        typeof options.acquisition !== "string" || !options.acquisition.trim() || options.acquisition.length > 200) fail("expected commit, HTTPS repository and acquisition description are required.");
    const gitObjects = options.acquisition === "local-git-objects";
    if (gitObjects && !/^[a-f\d]{40}$/u.test(options.verifiedTree || "")) fail("verified Git root tree required.");
    if (fs.existsSync(path.join(root, snapshotDirectory))) fail("upstream snapshot already exists.");
    const license = readRegular(root, "LICENSE");
    requireGpl3(license, "upstream LICENSE");
    requireGpl3(readRegular(kitRoot, "LICENSE"), "source-kit LICENSE");
    const originalPackage = readJson(root, "package.json");
    const originalLock = readJson(root, "package-lock.json");
    const captured = [], hashes = [];
    let copied = 0, hashed = 0;
    const stage = fs.mkdtempSync(path.join(root, ".rudonium-provenance-"));
    try {
        walkSource(root, (relative, legal, info) => {
            const rootName = !relative.includes("/");
            const save = legal || rootName && (rootReadme.test(relative) || ["package.json", "package-lock.json"].includes(relative));
            const hash = hashSourcePath(relative);
            if (!save && !hash) return;
            const maximum = relative.endsWith(".json") ? limits.jsonBytes : save ? limits.noticeBytes : limits.sourceBytes;
            const bytes = readRegular(root, relative, maximum);
            if (hash) {
                hashed += bytes.length;
                if (hashed > limits.sourceBytes) fail("source hash byte limit exceeded.");
                hashes.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
            }
            if (save) {
                copied += bytes.length;
                if (copied > limits.snapshotBytes) fail("upstream notice snapshot byte limit exceeded.");
                writeNew(stage, "files/" + relative, bytes);
                captured.push({ sourcePath: relative, path: "files/" + relative, bytes: bytes.length, sha256: sha256(bytes) });
            }
        });
        hashes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        captured.sort((left, right) => left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0);
        const sourceHashBytes = jsonBytes({ schemaVersion: 1, files: hashes });
        const record = {
            schemaVersion: 1, generatedBy: producer,
            repository: options.repository, expectedCommit: options.expectedCommit, acquisition: options.acquisition,
            revisionVerification: gitObjects
                ? "Pinned commit, trees and tracked blobs verified against Git object IDs. Working-tree edits are excluded. No author signature was checked."
                : "Expected revision recorded; this collector does not independently verify a Git commit or an archive signature.",
            ...(gitObjects ? { verifiedCommit: options.expectedCommit, verifiedTree: options.verifiedTree } : {}),
            licenseEvidence: {
                document: "files/LICENSE", documentSha256: sha256(license),
                packageLicense: originalPackage.license === undefined ? null : originalPackage.license,
                lockLicense: originalLock.license === undefined ? null : originalLock.license,
                lockRootPackageLicense: originalLock.packages && originalLock.packages[""] && originalLock.packages[""].license !== undefined
                    ? originalLock.packages[""].license : null,
                interpretation: "The GPLv3 document and original metadata are preserved as evidence. This collector does not resolve conflicting notices or establish dual licensing.",
            },
            capturedFiles: captured,
            sourceHashManifest: "source-hashes.json",
            sourceHashManifestSha256: sha256(sourceHashBytes),
            sourceHashScope: "main.ts, src/** and selected root build metadata/configuration; not a duplicate source checkout",
        };
        writeNew(stage, "source-hashes.json", sourceHashBytes);
        writeNew(stage, "origin.json", jsonBytes(record));
        if (fs.existsSync(path.join(root, snapshotDirectory))) fail("upstream snapshot destination changed.");
        fs.renameSync(stage, path.join(root, snapshotDirectory));
        return record;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function requireRelease(release, license) {
    if (!release || typeof release.id !== "string" || !/^[a-z\d][a-z\d-]*$/u.test(release.id) ||
        typeof release.name !== "string" || !release.name.trim() || release.name.length > 200 ||
        typeof release.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(release.version)) fail("invalid release metadata.");
    if (license !== "GPL-3.0-only") fail("this release helper expects the declared fork license GPL-3.0-only.");
}

/** Меняет только метаданные корня; отдельные лицензии зависимостей не переписываются. */
function applyReleaseMetadata(source, release, license) {
    requireRelease(release, license);
    const root = rootDirectory(source);
    checked(root, snapshotDirectory + "/origin.json");
    // Имя npm-пакета независимо от ID уже установленного плагина Obsidian.
    const metadata = { name: "rudonium-anki-toolkit", version: release.version, license };
    const packageJson = readJson(root, "package.json"), lock = readJson(root, "package-lock.json");
    if (lock.packages !== undefined && (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages))) fail("invalid package-lock packages object.");
    if (lock.packages && lock.packages[""] !== undefined && (!lock.packages[""] || typeof lock.packages[""] !== "object" || Array.isArray(lock.packages[""]))) fail("invalid root package-lock entry.");
    const { author, bugs, repository, homepage, scripts } = require("../package.json");
    Object.assign(packageJson, metadata, { author, bugs, repository, homepage });
    const releaseTests = scripts.test;
    packageJson.scripts ??= {};
    if (packageJson.scripts.test && packageJson.scripts.test !== releaseTests)
        packageJson.scripts["test:upstream"] ??= packageJson.scripts.test;
    packageJson.scripts.test = releaseTests;
    packageJson.scripts["release:prepare"] = scripts["release:prepare"];
    Object.assign(lock, metadata);
    if (lock.packages && lock.packages[""]) Object.assign(lock.packages[""], metadata);
    const outputs = [["package.json", jsonBytes(packageJson)], ["package-lock.json", jsonBytes(lock)]];
    for (const [relative, bytes] of outputs) fs.writeFileSync(checked(root, relative), bytes);
    return { ...metadata, lockRootPackagePresent: !!lock.packages?.[""] };
}

function errorCode(error) { return typeof error?.code === "string" ? error.code : "UNREADABLE"; }

// Keep original bytes and all attribution paths. Several packages can share one notice.
function writeDependencyCatalogs(stage, entries) {
    const catalogs = [];
    for (const [name, texts] of entries) {
        const contents = [];
        let size = 0;
        for (const { bytes, references } of texts.values()) {
            const header = Buffer.from("\n===== " + references.map(ref => ref.originalPath).join("\n      ") + " =====\n\n");
            size += header.length;
            for (const ref of references) ref.offset = size;
            contents.push(header, bytes);
            size += bytes.length;
        }
        const body = Buffer.concat(contents, size);
        writeNew(stage, name, body);
        catalogs.push({ path: name, bytes: size, sha256: sha256(body) });
    }
    return catalogs;
}

/** Копирует уведомления всех установленных npm-пакетов, включая инструменты сборки. */
function collectDependencyNotices(source) {
    const root = rootDirectory(source), packages = [], issues = [];
    let entries = 0, packageBytesRead = 0;
    const noteIssue = (code, relative, detail) => issues.push({ code, path: relative, ...(detail ? { detail } : {}) });
    const inspect = relative => {
        try { const absolute = checked(root, relative, true); return absolute ? fs.lstatSync(absolute) : undefined; }
        catch (error) { noteIssue("unsafe-or-unreadable-path", relative, errorCode(error)); return undefined; }
    };
    const visitNodeModules = (relative, depth) => {
        if (depth > limits.depth) fail("dependency directory depth limit exceeded.");
        const info = inspect(relative);
        if (!info) { if (depth === 0) noteIssue("node-modules-missing", relative); return; }
        if (!info.isDirectory()) { noteIssue("node-modules-not-directory", relative); return; }
        for (const name of fs.readdirSync(checked(root, relative)).sort()) {
            if (name.startsWith(".")) continue;
            const child = relative + "/" + name, childInfo = inspect(child);
            if (++entries > limits.files) fail("dependency entry limit exceeded.");
            if (!childInfo) continue;
            if (name.startsWith("@")) {
                if (!childInfo.isDirectory()) { noteIssue("invalid-package-scope", child); continue; }
                for (const scoped of fs.readdirSync(checked(root, child)).sort()) visitPackage(child + "/" + scoped, depth + 1);
            } else visitPackage(child, depth + 1);
        }
    };
    const visitPackage = (relative, depth) => {
        if (depth > limits.depth) fail("dependency directory depth limit exceeded.");
        const info = inspect(relative);
        if (!info?.isDirectory()) { if (info) noteIssue("package-not-directory", relative); return; }
        if (packages.length >= limits.packageCount) fail("dependency package count limit exceeded.");
        let metadata, packageBytes;
        try {
            packageBytes = readRegular(root, relative + "/package.json", limits.jsonBytes);
            packageBytesRead += packageBytes.length;
            if (packageBytesRead > limits.dependencyBytes) fail("dependency metadata byte limit exceeded.");
            metadata = JSON.parse(packageBytes.toString("utf8"));
        }
        catch (error) { if (/byte limit exceeded/u.test(error.message)) throw error; noteIssue("package-metadata-unavailable", relative + "/package.json", errorCode(error)); }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
            metadata = {};
            noteIssue("package-metadata-invalid", relative + "/package.json");
        }
        const notices = [];
        const visitLegal = (directory, nestedDepth = 0) => {
            if (nestedDepth > 8) fail("dependency legal-directory depth limit exceeded.");
            for (const name of fs.readdirSync(checked(root, directory)).sort()) {
                if (name === "node_modules") continue;
                const candidate = directory + "/" + name;
                if (nestedDepth === 0 && !noticeName.test(name) && !legalDirectory.test(name)) continue;
                const legalInfo = inspect(candidate);
                if (!legalInfo) continue;
                if (legalInfo.isDirectory()) { if (legalDirectory.test(name) || nestedDepth > 0) visitLegal(candidate, nestedDepth + 1); }
                else if (legalInfo.isFile()) notices.push(candidate);
                else noteIssue("unsupported-notice-type", candidate);
                if (++entries > limits.files) fail("dependency entry limit exceeded.");
            }
        };
        visitLegal(relative);
        if (!notices.length) noteIssue("notice-files-not-found", relative);
        packages.push({ installedPath: relative, metadata, packageBytes, notices: notices.sort() });
        const nested = relative + "/node_modules";
        if (inspect(nested)) visitNodeModules(nested, depth + 1);
    };
    visitNodeModules("node_modules", 0);
    packages.sort((left, right) => left.installedPath < right.installedPath ? -1 : left.installedPath > right.installedPath ? 1 : 0);
    const parent = ensureDirectory(root, "LICENSES"), output = path.join(root, ...dependenciesDirectory.split("/"));
    if (fs.existsSync(output)) fail("dependency notice destination already exists.");
    const stage = fs.mkdtempSync(path.join(parent, ".rudonium-provenance-"));
    let copied = 0;
    try {
        let lock;
        try { lock = readJson(root, "package-lock.json"); }
        catch (error) { noteIssue("package-lock-unavailable", "package-lock.json", errorCode(error)); }
        const inventory = [];
        const entries = new Map([["NOTICES.txt", new Map()], ["PACKAGE-METADATA.txt", new Map()]]);
        for (const item of packages) {
            const copiedFiles = [];
            const collect = (originalPath, catalog, bytes) => {
                copied += bytes.length;
                if (copied > limits.dependencyBytes) fail("dependency notice byte limit exceeded.");
                // A PDF, image or legacy encoding in a legal directory must not corrupt the UTF-8 text catalog.
                if (!isUtf8(bytes) || bytes.includes(0)) catalog = "ORIGINALS.bin";
                if (!entries.has(catalog)) entries.set(catalog, new Map());
                const texts = entries.get(catalog), hash = sha256(bytes);
                if (!texts.has(hash)) texts.set(hash, { bytes, references: [] });
                const ref = { originalPath, path: catalog, bytes: bytes.length, sha256: hash };
                texts.get(hash).references.push(ref);
                copiedFiles.push(ref);
            };
            if (item.packageBytes) collect(item.installedPath + "/package.json", "PACKAGE-METADATA.txt", item.packageBytes);
            for (const filename of item.notices) {
                let bytes;
                try { bytes = readRegular(root, filename); }
                catch (error) { noteIssue("notice-file-unavailable", filename, errorCode(error)); continue; }
                collect(filename, "NOTICES.txt", bytes);
            }
            const lockEntry = lock?.packages?.[item.installedPath];
            inventory.push({
                installedPath: item.installedPath,
                name: typeof item.metadata.name === "string" ? item.metadata.name : null,
                version: typeof item.metadata.version === "string" ? item.metadata.version : null,
                declaredLicense: item.metadata.license === undefined ? null : item.metadata.license,
                declaredLicenses: item.metadata.licenses === undefined ? null : item.metadata.licenses,
                repository: item.metadata.repository === undefined ? null : item.metadata.repository,
                homepage: typeof item.metadata.homepage === "string" ? item.metadata.homepage : null,
                resolved: typeof lockEntry?.resolved === "string" ? lockEntry.resolved : null,
                integrity: typeof lockEntry?.integrity === "string" ? lockEntry.integrity : null,
                files: copiedFiles,
            });
        }
        issues.sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0);
        const record = {
            schemaVersion: 2, generatedBy: producer,
            catalogs: writeDependencyCatalogs(stage, entries),
            scope: "All discovered installed npm packages, including build tools and nested packages; root legal files and legal subdirectories.",
            bundleAssessment: "Not performed. Presence in this inventory does not mean a package is included in main.js; license compatibility and completeness require review.",
            coverageStatus: issues.length ? "requires-review" : "installed-package-notices-captured",
            reviewRequired: true,
            packages: inventory, issues,
        };
        writeNew(stage, "inventory.json", jsonBytes(record));
        if (fs.existsSync(output)) fail("dependency notice destination changed.");
        fs.renameSync(stage, output);
        return record;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

/** Связывает исходный снимок, итоговые файлы и найденные уведомления в один отчёт. */
function finalizeProvenance(source, options) {
    requireRelease(options?.release, options?.license);
    const root = rootDirectory(source), origin = readJson(root, snapshotDirectory + "/origin.json");
    if (origin.generatedBy !== producer || !Array.isArray(origin.capturedFiles) || origin.capturedFiles.length > limits.files) fail("invalid upstream snapshot record.");
    for (const file of origin.capturedFiles) {
        if (!file || typeof file.path !== "string" || !file.path.startsWith("files/") ||
            !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f\d]{64}$/u.test(file.sha256 || "")) fail("invalid captured file record.");
        const content = readRegular(root, snapshotDirectory + "/" + file.path, limits.jsonBytes);
        if (content.length !== file.bytes || sha256(content) !== file.sha256) fail("upstream notice snapshot was changed: " + file.path);
    }
    if (sha256(readRegular(root, snapshotDirectory + "/source-hashes.json", limits.jsonBytes)) !== origin.sourceHashManifestSha256) fail("original source hash manifest was changed.");
    const initial = readJson(root, snapshotDirectory + "/source-hashes.json");
    if (!Array.isArray(initial.files) || initial.files.length > limits.files || initial.files.some(file =>
        !file || typeof file.path !== "string" || !/^[a-f\d]{64}$/u.test(file.sha256 || ""))) fail("invalid original source hash manifest.");
    for (const file of initial.files) parts(file.path);
    if (new Set(initial.files.map(file => file.path)).size !== initial.files.length) fail("duplicate original source hash path.");
    const previous = new Map(initial.files.map(file => [file.path, file.sha256]));
    const files = [];
    let bytes = 0;
    walkSource(root, relative => {
        if (!hashSourcePath(relative)) return;
        const content = readRegular(root, relative, limits.sourceBytes);
        bytes += content.length;
        if (bytes > limits.sourceBytes) fail("prepared source byte limit exceeded.");
        const digest = sha256(content);
        files.push({ path: relative, bytes: content.length, sha256: digest,
            change: !previous.has(relative) ? "added" : previous.get(relative) === digest ? "unchanged" : "modified" });
        previous.delete(relative);
    }, true);
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    let dependencies;
    if (checked(root, dependenciesDirectory + "/inventory.json", true)) dependencies = readJson(root, dependenciesDirectory + "/inventory.json");
    const artifacts = [];
    for (const relative of ["main.js", "manifest.json", "styles.css"]) {
        if (!checked(root, relative, true)) continue;
        const content = readRegular(root, relative, limits.sourceBytes);
        artifacts.push({ path: relative, bytes: content.length, sha256: sha256(content) });
    }
    const record = {
        schemaVersion: 1, generatedBy: producer,
        release: { id: options.release.id, name: options.release.name, version: options.release.version, license: options.license },
        upstream: { repository: origin.repository, expectedCommit: origin.expectedCommit, acquisition: origin.acquisition,
            revisionVerification: origin.revisionVerification, snapshot: snapshotDirectory + "/origin.json",
            originalMetadata: snapshotDirectory + "/files/package.json", sourceHashes: snapshotDirectory + "/source-hashes.json" },
        sourceFiles: files, removedSourceFiles: [...previous.keys()].sort(), artifacts,
        dependencies: { inventory: dependencies ? dependenciesDirectory + "/inventory.json" : null,
            inventorySha256: dependencies ? sha256(readRegular(root, dependenciesDirectory + "/inventory.json", limits.jsonBytes)) : null,
            coverageStatus: dependencies?.coverageStatus || "not-collected", packageCount: dependencies?.packages?.length || 0,
            issueCount: dependencies?.issues?.length || 0, bundleAssessment: dependencies?.bundleAssessment || "Not performed." },
        limitations: ["This record is not a digital signature or a copyright clearance.",
            "Original conflicting license declarations remain recorded; this report does not resolve them.",
            "Compilation, desktop behavior and dependency license compatibility are not asserted by this collector."],
    };
    const output = path.join(root, "PROVENANCE.json");
    if (fs.existsSync(output)) fail("final provenance destination already exists.");
    writeNew(root, "PROVENANCE.json", jsonBytes(record));
    return record;
}

module.exports = { isUpstreamTestState, isFreeFileSyncState, captureUpstream, applyReleaseMetadata, collectDependencyNotices, finalizeProvenance };
