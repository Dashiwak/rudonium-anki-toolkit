// SPDX-License-Identifier: GPL-3.0-only
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { regularBytes, readDirectoryEntries, cleanupTemporaryDirectory } = require("./workflow-files.cjs");
const { bundleNotice } = require("./release-rollup.cjs");

const kit = path.resolve(__dirname, "..");
const notices = ["LICENSE", "NOTICE.md", "AUTHORS.md", "TRADEMARKS.md", "LICENSING-ru.md",
    "PROVENANCE.json", "UPSTREAM-SNAPSHOT", "LICENSES"];
const requiredAssets = ["main.js", "manifest.json"];
const readJson = filename => JSON.parse(fs.readFileSync(filename, "utf8"));
const sha256 = data => createHash("sha256").update(data).digest("hex");

function runNode(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(path.basename(script) + " failed (" + (result.status ?? result.signal) + ").");
}

function checkRecordedFile(repository, record) {
    const filename = record.path;
    if (!filename || /[\\:\x00-\x1f]/u.test(filename) || filename.split("/").some(p => !p || p === "." || p === "..")) {
        throw new Error("Invalid file path in PROVENANCE.json.");
    }
    const data = fs.readFileSync(path.join(repository, filename));
    if (data.length !== record.bytes || sha256(data) !== record.sha256) throw new Error("Release hash mismatch: " + filename);
}

function checkRepository(repository, manifest) {
    const json = name => readJson(path.join(repository, name));
    const actual = json("manifest.json"), pkg = json("package.json"), lock = json("package-lock.json");
    const provenance = json("PROVENANCE.json");
    if (actual.id !== "rudonium-anki-toolkit" || actual.id !== manifest.id || actual.version !== manifest.version ||
        pkg.version !== actual.version || lock.version !== pkg.version || pkg.name !== actual.id || lock.name !== pkg.name ||
        (lock.packages?.[""] && lock.packages[""].version !== pkg.version) || pkg.license !== "GPL-3.0-only" ||
        json("versions.json")[pkg.version] !== actual.minAppVersion || provenance.release.id !== actual.id ||
        provenance.release.version !== actual.version || provenance.release.license !== pkg.license) {
        throw new Error("Inconsistent package, manifest or provenance for the requested release.");
    }
    for (const rel of ["main.ts", "UPSTREAM-SNAPSHOT/origin.json", "UPSTREAM-SNAPSHOT/source-hashes.json",
        "LICENSES/dependencies/inventory.json", "docs/en/quick-start.md", "docs/ru/quick-start.md",
        "docs/releases/" + actual.version + ".md"]) {
        if (!fs.lstatSync(path.join(repository, rel)).isFile()) throw new Error("Missing release input: " + rel);
    }
    const inventoryPath = "LICENSES/dependencies/inventory.json";
    const inventoryBytes = fs.readFileSync(path.join(repository, inventoryPath));
    if (provenance.dependencies?.inventorySha256 !== sha256(inventoryBytes)) throw new Error("Dependency inventory hash mismatch.");
    const inventory = JSON.parse(inventoryBytes);
    const catalogs = inventory.catalogs;
    const names = new Set(["NOTICES.txt", "PACKAGE-METADATA.txt", "ORIGINALS.bin"]);
    if (inventory.schemaVersion !== 2 || !Array.isArray(catalogs) ||
        !["NOTICES.txt", "PACKAGE-METADATA.txt"].every(name => catalogs.some(file => file.path === name))) {
        throw new Error("Missing dependency notice catalogs.");
    }
    for (const file of catalogs) {
        if (!names.delete(file.path)) throw new Error("Invalid dependency catalog path.");
        checkRecordedFile(repository, { ...file, path: "LICENSES/dependencies/" + file.path });
    }
    if (!fs.lstatSync(path.join(repository, "src")).isDirectory() ||
        !provenance.sourceFiles?.some(file => file.path === "main.ts") ||
        !provenance.sourceFiles?.some(file => file.path.startsWith("src/"))) {
        throw new Error("The expanded source repository is required.");
    }
    const assets = requiredAssets.slice();
    if (fs.existsSync(path.join(repository, "styles.css"))) assets.push("styles.css");
    if (provenance.artifacts.length !== assets.length ||
        !assets.every(name => provenance.artifacts.some(item => item.path === name))) {
        throw new Error("Runtime files differ from the declared provenance.");
    }
    for (const record of [...provenance.sourceFiles, ...provenance.artifacts]) checkRecordedFile(repository, record);
    if (!fs.readFileSync(path.join(repository, "main.js"), "utf8").includes(bundleNotice(manifest, pkg.license))) {
        throw new Error("The compiled plugin does not carry this release's version and license banner.");
    }
    return assets;
}

// В staging попадает только что созданный репозиторий. Не распространяем кеш,
// личное хранилище или посторонний архив из локальной копии исходной основы.
function checkSourceTree(repository) {
    let count = 0;
    const blocked = new Set([".git", ".obsidian", ".trash", "node_modules", ".npmrc", ".env", ".DS_Store", "Thumbs.db"]);
    function visit(directory) {
        for (const item of readDirectoryEntries(directory)) {
            const filename = path.join(directory, item.name);
            if (blocked.has(item.name) || /^\.env\./.test(item.name) || /\.(?:zip|apkg|colpkg|anki2|log)$/i.test(item.name)) {
                throw new Error("Unexpected file in prepared sources: " + path.relative(repository, filename) +
                    ". Use a clean official upstream source directory.");
            }
            if (item.stat.isDirectory()) visit(filename);
            else count++;
        }
    }
    visit(repository);
    return count;
}

async function stageRelease(repository, output, scratch, manifest, onSourcesChecked) {
    // This is the builder's private staging copy. Rollup and TypeScript regenerate these outputs.
    for (const name of ["main.js.map", ".rpt2_cache", ".rollup.cache", "tsconfig.tsbuildinfo"]) {
        fs.rmSync(path.join(repository, name), { recursive: true, force: true });
    }
    const assets = checkRepository(repository, manifest);
    const fileCount = checkSourceTree(repository);
    const runtime = fs.mkdtempSync(path.join(scratch, "verified-runtime-"));
    try {
        for (const name of assets) {
            fs.writeFileSync(path.join(runtime, name), regularBytes(path.join(repository, name)), {flag: "wx"});
        }
        // Both clean rebuilds must reproduce the original assets without a bundled main.js in the sources.
        fs.unlinkSync(path.join(repository, "main.js"));
        onSourcesChecked?.();
        runNode(path.join(repository, "Build", "verify-rebuild.cjs"), [repository, runtime]);
        const evidence = path.join(output, "notices");
        fs.mkdirSync(evidence);
        for (const name of notices) {
            fs.cpSync(path.join(repository, name), path.join(evidence, name), {recursive: true, force: false, errorOnExist: true});
        }
        fs.renameSync(runtime, path.join(output, "install"));
        return fileCount - 1;
    } finally {
        cleanupTemporaryDirectory(runtime);
    }
}

// A published checkout already contains all patched sources. Rebuild a private copy of it
// so local edits are released and previous evidence and working files stay intact.
function buildCheckout(checkout, repository, manifest) {
    const { isUpstreamTestState, isFreeFileSyncState, collectDependencyNotices, finalizeProvenance } = require("./release-provenance.cjs");
    const { npm } = require("./build-main.cjs");
    const tempRoot = fs.realpathSync(os.tmpdir());
    if (inside(fs.realpathSync(checkout), tempRoot)) {
        throw new Error("Choose a temporary directory outside the source checkout.");
    }
    const scratch = fs.mkdtempSync(path.join(tempRoot, "rudonium-compile-"));
    try {
        const transient = new Set(["node_modules", "main.js.map", ".rpt2_cache", ".rollup.cache", "tsconfig.tsbuildinfo"]);
        const generated = new Set([...transient, ".git", "dist", "main.js", "PROVENANCE.json", "LICENSES/dependencies", "Build/build-error.txt"]);
        fs.cpSync(checkout, scratch, { recursive: true, filter(filename) {
            const relative = path.relative(checkout, filename).split(path.sep).join("/");
            return !generated.has(relative) && !isUpstreamTestState(relative) && !isFreeFileSyncState(relative) &&
                !/^Release-\d+\.\d+\.\d+$/.test(relative) && !/^Build\/\.build-/.test(relative);
        } });
        checkSourceTree(scratch);
        npm(["ci", "--no-audit", "--no-fund"], scratch);
        npm(["exec", "--offline", "--", "tsc", "--noEmit"], scratch, true);
        npm(["run", "build"], scratch, true);
        runNode("--check", [path.join(scratch, "main.js")]);
        collectDependencyNotices(scratch);

        // Include the notices derived from installed dependencies, without ever copying node_modules to the release stage.
        fs.cpSync(scratch, repository, { recursive: true, force: false, errorOnExist: true,
            filter: filename => !transient.has(path.relative(scratch, filename))
        });
        checkSourceTree(repository);
        finalizeProvenance(repository, { release: manifest, license: "GPL-3.0-only" });
    } finally {
        cleanupTemporaryDirectory(scratch);
    }
}

function inside(parent, child) {
    const rel = path.relative(parent, child);
    return !rel || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep));
}

// This interactive FreeFileSync job is kept beside the checkout, outside of Git.
function writeCompareProfile(directory, repository) {
    const left = repository.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const excluded = ["/.git", "*/.git", "/node_modules/", "/.obsidian/", "*.ffs_db", "*.ffs_lock", "*.ffs_tmp"];
    const items = excluded.map(name => "      <Item>" + name + "</Item>").join("\n");
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<FreeFileSync XmlType="GUI" XmlFormat="23">
  <Notes/>
  <Compare><Variant>Content</Variant><Symlinks>Exclude</Symlinks><IgnoreTimeShift/></Compare>
  <Synchronize>
    <Differences LeftOnly="right" LeftNewer="right" RightNewer="right" RightOnly="none"/>
    <DeletionPolicy>RecycleBin</DeletionPolicy><VersioningFolder Style="Replace"/>
  </Synchronize>
  <Filter>
    <Include><Item>*</Item></Include>
    <Exclude>
${items}
    </Exclude>
    <SizeMin Unit="None">0</SizeMin><SizeMax Unit="None">0</SizeMax><TimeSpan Type="None">0</TimeSpan>
  </Filter>
  <FolderPairs><Pair><Left>${left}</Left><Right/></Pair></FolderPairs>
  <Errors Ignore="false" Retry="0" Delay="5"/><PostSyncCommand Condition="Completion"/>
  <LogFolder/><EmailNotification Condition="Always"/><GridViewType>Difference</GridViewType>
</FreeFileSync>
`;
    fs.writeFileSync(path.join(directory, "Compare.ffs_gui"), xml, {flag: "wx"});
}

async function main(args) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 18)) throw new Error("Use Node.js 22.18 or later with npm.");
    if (args.length > 2) throw new Error("Usage: node Build/prepare-gitflic.cjs [official-source-directory|-] [new-output-directory]");
    const manifest = readJson(path.join(kit, "manifest.json"));
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid release version.");
    const source = args[0] && args[0] !== "-" ? fs.realpathSync(args[0]) : "-";
    const expanded = fs.existsSync(path.join(__dirname, "overlay-files.json"));
    if (expanded && source !== "-") throw new Error("An expanded repository already contains its sources. Pass - for the first argument.");
    const defaultOutput = expanded ? path.join(kit, "..", "Rudonium-Builds", manifest.version)
        : path.join(kit, "..", "GitFlic-" + manifest.version);
    const output = path.resolve(args[1] || defaultOutput);
    if (fs.lstatSync(output, { throwIfNoEntry: false })) {
        throw new Error("Destination already exists: " + output + ". Choose a new directory.");
    }
    // Protect against recursively copying a parent directory into its own build or output.
    if (inside(kit, output) || source !== "-" && (inside(source, output) || inside(source, kit))) {
        throw new Error("Choose separate locations for the kit, official source and output.");
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const stage = fs.mkdtempSync(path.join(path.dirname(output), ".rudonium-gitflic-"));
    const publish = path.join(stage, "publish");
    // A maintained checkout is already the source of record. Its staging copy is temporary.
    const repository = path.join(expanded ? stage : publish, "repository");
    let sourcesChecked = false;
    try {
        fs.mkdirSync(publish);
        console.log("1/3 Preparing the sources for " + manifest.version + "...");
        if (expanded) buildCheckout(kit, repository, manifest);
        else runNode(path.join(__dirname, "build-main.cjs"), ["--prepare-repository", source, repository]);
        console.log("2/3 Checking the runtime against two clean builds before staging the installation files...");
        const fileCount = await stageRelease(repository, publish, stage, manifest,
            () => { sourcesChecked = true; });
        if (!expanded) writeCompareProfile(publish, path.join(output, "repository"));
        if (fs.lstatSync(output, { throwIfNoEntry: false })) throw new Error("Destination appeared while building: " + output);
        fs.renameSync(publish, output);
        console.log("3/3 Verified build ready: " + output);
        if (!expanded) {
            console.log("Repository (" + fileCount + " files): " + path.join(output, "repository"));
            console.log("FreeFileSync: " + path.join(output, "Compare.ffs_gui"));
        }
        const install = path.join(output, "install");
        console.log("Verified plugin files:");
        for (const asset of ["main.js", "manifest.json", "styles.css"]) {
            const filename = path.join(install, asset);
            if (fs.existsSync(filename)) console.log("  " + filename);
        }
        console.log("Release description: " + path.join(expanded ? kit : path.join(output, "repository"), "docs", "releases", manifest.version + ".md"));
    } catch (error) {
        // The source tree has passed its checks. A later verification or staging failure
        // must not take the user's usable sources with it.
        if (!expanded && sourcesChecked && fs.existsSync(repository)) {
            const saved = fs.mkdtempSync(path.join(path.dirname(output), "Sources-" + manifest.version + "-"));
            fs.renameSync(repository, path.join(saved, "repository"));
            error.message += "\nSources saved: " + path.join(saved, "repository") + "\nRelease verification did not finish.";
        }
        throw error;
    } finally {
        cleanupTemporaryDirectory(stage);
    }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
    const message = "GitFlic preparation failed: " + error.message;
    console.error(message);
    const report = path.join(__dirname, "build-error.txt");
    if (!(error.message.startsWith("build-main.cjs failed") && fs.existsSync(report))) {
        try { fs.writeFileSync(report, message + "\n"); }
        catch (writeError) { console.error("Could not save the diagnostic: " + writeError.message); }
    }
    process.exitCode = 1;
});
module.exports = { stageRelease, checkRepository, buildCheckout, writeCompareProfile };
