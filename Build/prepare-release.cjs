// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { scanTree, validateManifest, diffFiles, safePath, sha256, hashFile, regularBytes, readDirectoryEntries, writeZip, readZip, extractSourceZip, cleanupTemporaryDirectory } = require("./workflow-files.cjs");

const pluginId = "rudonium-anki-toolkit";
const json = data => JSON.stringify(data, null, 2) + "\n";
const readJson = (root, name) => JSON.parse(fs.readFileSync(safePath(root, name), "utf8"));
const writeNew = (root, name, content) => fs.writeFileSync(safePath(root, name), content, {flag: "wx"});
const exists = file => !!fs.lstatSync(file, {throwIfNoEntry: false});
function check(condition, message) { if (!condition) throw new Error(message); }
function validVersion(version) {
    check(typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), "Invalid three-part version.");
    return version;
}
const installName = version => `Rudonium-${validVersion(version)}-Install.zip`;
const sourceName = version => `Rudonium-${validVersion(version)}-Repository.zip`;

function inventory(root) {
    const files = Object.create(null);
    function visit(parent, prefix) {
        for (const entry of readDirectoryEntries(parent)) {
            const name = prefix + entry.name;
            const filename = safePath(root, name);
            if (entry.stat.isDirectory()) visit(filename, name + "/");
            else files[name] = hashFile(filename);
        }
    }
    visit(root, "");
    return files;
}
function sameFiles(expected, actual, label) {
    check(expected && actual && typeof expected === "object" && typeof actual === "object", label);
    const paths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    const differences = paths.filter(name => expected[name] !== actual[name]);
    check(!differences.length, label + ": " + differences.slice(0, 20).join(", "));
}
const sourceNotices = new Set(["LICENSE", "NOTICE.md", "AUTHORS.md", "TRADEMARKS.md", "LICENSING-ru.md"]);
const isNotice = name => sourceNotices.has(name) || name === "PROVENANCE.json" ||
    name.startsWith("LICENSES/") || name.startsWith("UPSTREAM-SNAPSHOT/");
function checkRuntime(build, version, sources, legacy) {
    const runtime = safePath(build, legacy ? "install/" + pluginId : "install");
    const assets = inventory(runtime);
    const notices = legacy ? assets : inventory(safePath(build, "notices"));
    const manifest = readJson(runtime, "manifest.json");
    check(manifest.version === version && manifest.id === pluginId, "The installed manifest identifies another version or plugin.");
    if (!legacy) {
        const expected = ["main.js", "manifest.json"];
        if (sources.files["styles.css"]) expected.push("styles.css");
        check(fs.readdirSync(runtime).sort().join("\n") === expected.sort().join("\n"), "Unexpected or missing files in install/.");
        check(Object.keys(notices).every(isNotice), "Unexpected distribution notice.");
    }
    for (const [name, digest] of Object.entries(sources.files)) {
        // The builder regenerates provenance and dependency notices for the actual build.
        if (name.startsWith("LICENSES/dependencies/") || name === "PROVENANCE.json") continue;
        if (isNotice(name)) check(notices[name] === digest, "Built file differs from source: " + name);
        if (name === "manifest.json" || name === "styles.css") check(assets[name] === digest, "Built file differs from source: " + name);
    }
    check(assets["main.js"] && fs.statSync(safePath(runtime, "main.js")).size > 0, "Missing or empty built main.js.");
    return {assets, notices};
}
function zipMatchesInstaller(zipFile, assets) {
    const entries = readZip(zipFile);
    const hashes = Object.create(null);
    for (const [name, bytes] of entries) {
        if (name === "INSTALL.txt") continue;
        check(name.startsWith(pluginId + "/"), "Unexpected installer file: " + name);
        hashes[name.slice(pluginId.length + 1)] = sha256(bytes);
    }
    sameFiles(assets, hashes, "Installer ZIP differs from install/");
}
function checkSource(actual, want) {
    validateManifest(want);
    if (actual.id !== want.id) throw new Error("Source contents changed: " + diffFiles(want, actual).slice(0, 20).join(", "));
}

// Called only on the builder's newly-created private staging directory, after its successful exit.
function recordBuild(build, {version, baseVersion, baseId, sourceManifest}) {
    validVersion(version); validVersion(baseVersion);
    check(/^[a-f0-9]{64}$/.test(baseId), "Invalid published base hash.");
    validateManifest(sourceManifest);
    const {assets, notices} = checkRuntime(build, version, sourceManifest, false);
    const info = {schema: 2, pluginId, version, baseVersion, baseId, sourceId: sourceManifest.id,
        result: "built", assets, notices};
    writeNew(build, "SOURCE-MANIFEST.json", json(sourceManifest));
    writeNew(build, "BUILD-INFO.json", json(info));
    return info;
}
function verifyBuild(build, {version, baseVersion, baseId, sourceManifest}) {
    validVersion(version); validateManifest(sourceManifest);
    const stored = readJson(build, "SOURCE-MANIFEST.json");
    validateManifest(stored);
    const info = readJson(build, "BUILD-INFO.json");
    check((info.schema === 1 || info.schema === 2) && info.pluginId === pluginId && info.version === version &&
        info.sourceId === stored.id && info.result === "built", "Invalid build evidence.");
    checkSource(sourceManifest, stored);
    validVersion(info.baseVersion);
    check(/^[a-f0-9]{64}$/.test(info.baseId), "Invalid base hash in build record.");
    if (baseVersion !== undefined) check(info.baseVersion === baseVersion, "Build records another base release.");
    if (baseId !== undefined) check(info.baseId === baseId, "Build records another base hash.");
    const {assets, notices} = checkRuntime(build, version, sourceManifest, info.schema === 1);
    sameFiles(info.assets, assets, "Changed or missing installation files");
    if (info.schema === 1) {
        const installer = safePath(build, "install/" + installName(version));
        check(info.installer?.name === installName(version) && hashFile(installer) === info.installer.sha256, "Changed installation ZIP.");
    } else {
        sameFiles(info.notices, notices, "Changed or missing distribution notices");
    }
    return info;
}

const restore = Buffer.from("# Восстановление исходников Rudonium\n\nРаспакуйте ZIP в отдельную папку. Здесь находятся полные исходники, включая скрытые файлы проекта. SOURCE-MANIFEST.json рядом с каталогом содержит SHA-256 проектных файлов. Для установки используйте отдельный Install.zip. Для сборки нужны Node.js от 22.18, npm и зависимости из lock-файла. История Git хранится отдельно.\n", "utf8");

function gitEvidence(repo, entries) {
    const env = {...process.env, GIT_CEILING_DIRECTORIES:path.dirname(repo)};
    for (const key of ["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_COMMON_DIR","GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_PREFIX"]) delete env[key];
    function git(args) {
        const result = spawnSync("git", ["--no-optional-locks", "-C", repo, ...args], {env, encoding:"utf8", windowsHide:true, maxBuffer:32*1024*1024});
        return result.status === 0 ? result.stdout : "";
    }
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    if (!top || fs.realpathSync(top) !== repo) return {observedHead:null, releaseCommit:null};
    const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) return {observedHead:null, releaseCommit:null};
    const records = git(["ls-tree", "--full-tree", "-r", "-z", head]).split("\0").filter(Boolean);
    const blobs = new Map();
    for (const row of records) {
        const record = /^(?:100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (!record) return {observedHead:head, releaseCommit:null};
        blobs.set(record[2], record[1]);
    }
    const matches = records.length === entries.length && entries.every(({name, data}) => {
        const hash = createHash(head.length === 40 ? "sha1" : "sha256").update("blob " + data.length + "\0").update(data).digest("hex");
        return blobs.get(name) === hash;
    });
    return {observedHead:head, releaseCommit:matches ? head : null};
}
function notes(repo, version) {
    const file = safePath(repo, `docs/releases/${version}.md`);
    const text = exists(file) ? fs.readFileSync(file, "utf8").trimEnd() : "# Rudonium Anki Toolkit " + version;
    const publishable = text.replaceAll("(../../PUBLISHING.md)", "(https://github.com/Dashiwak/rudonium-anki-toolkit/blob/" + version + "/PUBLISHING.md)");
    return publishable + "\n\n## Комплект для публикации\n\nНа GitHub и GitFlic приложите установочный ZIP, полный Repository.zip и SHA256SUMS.txt. Для каталога Obsidian загрузите на GitHub также отдельные main.js, manifest.json и styles.css (если используется).\n";
}
function releaseAssets(build, info) {
    const names = ["main.js", "manifest.json"];
    if (info.assets["styles.css"]) names.push("styles.css");
    const root = info.schema === 1 ? "install/" + pluginId : "install";
    return Object.fromEntries(names.map(name => [name, safePath(build, root + "/" + name)]));
}
function installGuide(version) {
    return Buffer.from([
        "Rudonium Anki Toolkit " + version, "",
        "Close Obsidian. Copy the rudonium-anki-toolkit folder to <vault>/.obsidian/plugins/.",
        "For an update, merge the folder and replace the supplied files together. Keep your data.json, caches and journals.", "",
        "Закройте Obsidian и скопируйте папку rudonium-anki-toolkit в <хранилище>/.obsidian/plugins/.",
        "При обновлении объедините папки и замените файлы этого выпуска вместе. Сохраните свой data.json, кеш и журналы.", "",
    ].join("\r\n"), "utf8");
}
function createInstaller(build, info, destination) {
    if (info.schema === 1) {
        fs.copyFileSync(safePath(build, "install/" + installName(info.version)), destination, fs.constants.COPYFILE_EXCL);
        return;
    }
    const entries = [{name:"INSTALL.txt", data:installGuide(info.version)}];
    for (const [folder, files] of [["install", info.assets], ["notices", info.notices]]) {
        for (const [name, expected] of Object.entries(files)) {
            const data = regularBytes(safePath(build, folder + "/" + name));
            check(sha256(data) === expected, "File changed while preparing the installation ZIP: " + name);
            entries.push({name:pluginId + "/" + name, data});
        }
    }
    writeZip(destination, entries);
}
function sums(files) {
    return Object.keys(files).sort().map(name => files[name] + "  " + name + "\n").join("");
}
function keepInIncoming(incoming, filename, archive, expected) {
    const dest = safePath(incoming, filename);
    if (!exists(dest)) {
        // Stage on the destination filesystem; use exclusive creation to protect an existing release.
        const temp = fs.mkdtempSync(path.join(incoming, ".rudonium-release-"));
        const copy = path.join(temp, "source.zip");
        try {
            fs.copyFileSync(archive, copy, fs.constants.COPYFILE_EXCL);
            check(hashFile(copy) === expected, "Full source ZIP copy failed verification.");
            try {
                fs.linkSync(copy, dest);
            } catch (error) {
                if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) {
                    // Some removable Windows volumes do not support hard links.
                    try { fs.copyFileSync(copy, dest, fs.constants.COPYFILE_EXCL); }
                    catch (e) { if (e.code !== "EEXIST") throw e; }
                } else if (error.code !== "EEXIST") throw error;
            }
        } finally { cleanupTemporaryDirectory(temp); }
    }
    check(hashFile(dest) === expected, "A different source archive already exists at " + dest);
}

function capture(repo, manifest) {
    return Object.entries(manifest.files).map(([name, expected]) => {
        const data = fs.readFileSync(safePath(repo, name));
        check(sha256(data) === expected, "Source changed during release preparation: " + name);
        return {name, data};
    });
}
function checkSourceArchiveEntries(archive, manifest) {
    const entries = readZip(archive);
    const expected = Object.fromEntries(Object.entries(manifest.files).map(([key,digest]) => [pluginId + "/" + key, digest]));
    expected["SOURCE-MANIFEST.json"] = sha256(Buffer.from(json(manifest)));
    expected["RESTORE.md"] = sha256(restore);
    sameFiles(expected, Object.fromEntries([...entries].map(([key,data]) => [key,sha256(data)])), "Unexpected source ZIP contents");
}
function verifySourceArchive(archive, manifest, work) {
    checkSourceArchiveEntries(archive, manifest);
    const extracted = path.join(work, "extracted");
    extractSourceZip(archive, extracted, [manifest]);
    checkSource(scanTree(extracted), manifest);
}
function validCommit(value) {
    return value === null || (typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value));
}
// Files from a previous revision may be replaced only after validating its complete inventory.
// In particular, unexpected user files or empty directories must never disappear during the swap.
function verifyReplaceableBuild(build, params) {
    const info = verifyBuild(build, params);
    const legacy = info.schema === 1;
    const expected = new Set(["BUILD-INFO.json", "SOURCE-MANIFEST.json"]);
    for (const name of Object.keys(info.assets)) expected.add((legacy ? "install/" + pluginId + "/" : "install/") + name);
    if (legacy) expected.add("install/" + info.installer.name);
    else for (const name of Object.keys(info.notices)) expected.add("notices/" + name);
    const release = safePath(build, "release");
    if (exists(release)) {
        const descriptor = readJson(release, "RELEASE-INFO.json");
        check(descriptor.schema === 1 && descriptor.status === "prepared" && descriptor.pluginId === pluginId &&
            descriptor.version === info.version && descriptor.baseVersion === info.baseVersion &&
            descriptor.baseId === info.baseId && descriptor.sourceId === info.sourceId, "Invalid previous release descriptor.");
        const source = sourceName(info.version), install = installName(info.version);
        const hashes = Object.fromEntries(Object.keys(releaseAssets(build, info)).map(name => [name,info.assets[name]]));
        hashes[source] = hashFile(safePath(release, source));
        checkSourceArchiveEntries(safePath(release, source), params.sourceManifest);
        const installer = safePath(release, install);
        zipMatchesInstaller(installer, {...info.assets, ...info.notices});
        hashes[install] = hashFile(installer);
        if (legacy) check(hashes[install] === info.installer.sha256, "Previous release differs from its built installer.");
        hashes["RELEASE-NOTES.md"] = hashFile(safePath(release, "RELEASE-NOTES.md"));
        sameFiles(hashes, descriptor.sha256, "Inconsistent previous release checksums");
        hashes["RELEASE-INFO.json"] = hashFile(safePath(release, "RELEASE-INFO.json"));
        hashes["SHA256SUMS.txt"] = sha256(Buffer.from(sums(hashes)));
        sameFiles(hashes, inventory(release), "Changed previous release files");
        for (const name of Object.keys(hashes)) expected.add("release/" + name);
    }
    const expectedDirs = new Set(["install"]);
    if (!legacy) expectedDirs.add("notices");
    for (const name of expected) {
        let parent = path.posix.dirname(name);
        while (parent !== ".") {
            expectedDirs.add(parent);
            parent = path.posix.dirname(parent);
        }
    }
    function visit(dir, prefix) {
        for (const {name, stat} of readDirectoryEntries(dir)) {
            const relative = prefix + name;
            if (stat.isDirectory()) {
                check(expectedDirs.has(relative), "Unexpected build directory: " + relative);
                visit(safePath(build, relative), relative + "/");
            } else check(expected.has(relative), "Unexpected build file: " + relative);
        }
    }
    visit(build, "");
    return info;
}
function incomingDestination(incoming, builds, version, source, digest) {
    const filename = sourceName(version);
    const canonical = safePath(incoming, filename);
    if (!exists(canonical)) return filename;
    const existingHash = hashFile(canonical);
    if (existingHash === digest) return filename;
    // A verified release from an earlier revision may already occupy the canonical name.
    // Preserve both source archives and make the source ID distinguish them in Incoming.
    const fail = "A different full source archive already exists at " + canonical;
    let old;
    try { old = JSON.parse(readZip(canonical).get("SOURCE-MANIFEST.json")); validateManifest(old); }
    catch { throw new Error(fail); }
    const history = safePath(builds, "previous-releases/" + version + "-" + old.id);
    check(old.id !== source.id && exists(history), fail);
    const oldInfo = readJson(history, "RELEASE-INFO.json");
    check(oldInfo.sourceId === old.id && oldInfo.version === version && oldInfo.sha256?.[filename] === existingHash &&
        hashFile(safePath(history, filename)) === oldInfo.sha256[filename], fail);
    return "Rudonium-" + version + "-" + source.id.slice(0, 12) + "-Repository.zip";
}
function prepareLocked(repo, family, builds, expected) {
    const manifest = readJson(repo, "manifest.json");
    const version = validVersion(manifest.version);
    check(manifest.id === pluginId, "Select the permanent Rudonium project.");
    if (expected.version) check(version === expected.version, "This package requires version " + expected.version + ". Restore the selected version first.");
    const source = scanTree(repo);
    if (expected.id) check(source.id === expected.id, "Working files differ from the selected update package. Restore or build the required version first.");
    const build = safePath(builds, version);
    check(exists(build), "No checked build for " + version + ". First run Apply-Update.cmd for this version.");
    const info = verifyBuild(build, {version, sourceManifest:source});
    const assets = releaseAssets(build, info);
    const install = installName(version), repository = sourceName(version);
    const incoming = safePath(family, "Rudonium-Incoming");
    fs.mkdirSync(incoming, {recursive:true});
    const destination = safePath(build, "release");
    const previous = exists(destination);

    const work = fs.mkdtempSync(path.join(build, ".prepare-release-"));
    const output = previous ? destination : path.join(work, "release");
    try {
        if (!previous) fs.mkdirSync(output);
        const entries = capture(repo, source);
        const commits = gitEvidence(repo, entries);
        const archive = safePath(output, repository);
        if (!previous) {
            for (const [name, file] of Object.entries(assets)) fs.copyFileSync(file, safePath(output, name), fs.constants.COPYFILE_EXCL);
            createInstaller(build, info, safePath(output, install));
            writeZip(archive, [
                ...entries.map(({name,data}) => ({name:pluginId + "/" + name,data})),
                {name:"SOURCE-MANIFEST.json",data:Buffer.from(json(source))},
                {name:"RESTORE.md",data:restore}
            ]);
        }
        verifySourceArchive(archive, source, work);
        // Preserve the first checked archive bytes, including after the working tree is committed.
        const hashes = Object.fromEntries(Object.keys(assets).map(name => [name, info.assets[name]]));
        const installerFile = safePath(output, install);
        zipMatchesInstaller(installerFile, {...info.assets, ...info.notices});
        hashes[install] = hashFile(installerFile);
        if (info.schema === 1) check(hashes[install] === info.installer.sha256, "Changed installation ZIP.");
        hashes[repository] = hashFile(archive);
        const releaseNotes = notes(repo, version);
        hashes["RELEASE-NOTES.md"] = sha256(Buffer.from(releaseNotes));
        const common = {schema:1, status:"prepared", pluginId, version, baseVersion:info.baseVersion,
            baseId:info.baseId, sourceId:source.id};
        if (!previous) {
            writeNew(output, "RELEASE-NOTES.md", releaseNotes);
            writeNew(output, "RELEASE-INFO.json", json({...common, ...commits, sha256:hashes}));
        }
        const descriptor = readJson(output, "RELEASE-INFO.json");
        for (const [key,value] of Object.entries(common)) check(descriptor[key] === value, "Inconsistent release descriptor: " + key);
        check(validCommit(descriptor.observedHead) && validCommit(descriptor.releaseCommit) &&
            (!descriptor.releaseCommit || descriptor.releaseCommit === descriptor.observedHead), "Inconsistent recorded Git commit.");
        sameFiles(hashes, descriptor.sha256, "Inconsistent release descriptor checksums");
        hashes["RELEASE-INFO.json"] = hashFile(safePath(output, "RELEASE-INFO.json"));
        const checksums = sums(hashes);
        if (!previous) writeNew(output, "SHA256SUMS.txt", checksums);
        hashes["SHA256SUMS.txt"] = sha256(Buffer.from(checksums));
        sameFiles(hashes, inventory(output), "Changed or unexpected release files");
        checkSource(scanTree(repo), source);
        verifyBuild(build, {version, sourceManifest:source});
        const incomingName = incomingDestination(incoming, builds, version, source, hashes[repository]);
        const archiveCopy = safePath(incoming, incomingName);
        if (exists(archiveCopy)) check(hashFile(archiveCopy) === hashes[repository],
            "A different full source archive already exists at " + archiveCopy);
        if (!previous) {
            check(!exists(destination), "The release directory appeared during preparation. Retry to verify it.");
            fs.renameSync(output, destination);
        }
        keepInIncoming(incoming, incomingName, safePath(destination, repository), hashes[repository]);
        return {version, directory:destination, repositoryArchive:archiveCopy, releaseCommit:commits.releaseCommit};
    } finally { cleanupTemporaryDirectory(work); }
}
async function prepareRelease(repo, expected = {}) {
    repo = fs.realpathSync(repo);
    if (expected.version) validVersion(expected.version);
    if (expected.id) check(/^[a-f0-9]{64}$/.test(expected.id), "Invalid selected source hash.");
    const family = path.dirname(repo), builds = safePath(family, "Rudonium-Builds");
    check(exists(builds), "No Rudonium-Builds folder next to this repository. Apply and verify the update first.");
    const {withWorkspaceLock, pendingRecovery} = require("./workflow-transaction.cjs");
    return withWorkspaceLock({repo, builds}, () => {
        check(!pendingRecovery({repo,builds}), "An interrupted update requires recovery. Run Apply-Update.cmd first.");
        return prepareLocked(repo, family, builds, expected);
    });
}
function options(argv) {
    const options = {};
    const known = {"--repo":"repo", "--expect-version":"version", "--expect-id":"id"};
    for (let i = 0; i < argv.length; i++) {
        const key = known[argv[i]];
        check(key && argv[i+1] && !argv[i+1].startsWith("--") && !Object.hasOwn(options,key), "Invalid arguments. Use --repo <folder> [--expect-version <version> --expect-id <SHA256>].");
        options[key] = argv[++i];
    }
    return options;
}
if (require.main === module) {
    (async () => {
        const args = options(process.argv.slice(2));
        const result = await prepareRelease(args.repo || path.join(__dirname, ".."), args);
        console.log("Релиз " + result.version + " подготовлен.\n" + result.directory + "\nПолные исходники: " + result.repositoryArchive);
        if (result.releaseCommit) console.log("Проверенный коммит для описания публикации: " + result.releaseCommit);
    })().catch(error => { console.error("Prepare-Release: " + error.message); process.exitCode = 1; });
}
module.exports = {recordBuild, verifyBuild, verifyReplaceableBuild, prepareRelease};
