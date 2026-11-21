// SPDX-License-Identifier: GPL-3.0-only
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const overlay = require("./overlay-source.cjs");
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
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, item.name);
            if (blocked.has(item.name) || /^\.env\./.test(item.name) || /\.(?:zip|apkg|colpkg|anki2|log)$/i.test(item.name) ||
                (!item.isDirectory() && !item.isFile())) {
                throw new Error("Unexpected file in prepared sources: " + path.relative(repository, filename) +
                    ". Use a clean official upstream source directory.");
            }
            if (item.isDirectory()) visit(filename);
            else count++;
        }
    }
    visit(repository);
    return count;
}

async function stageRelease(repository, releaseDirectory, scratch, manifest, onSourcesChecked) {
    // This is the builder's private staging copy. These files are generated again by Rollup and TypeScript.
    for (const name of ["main.js.map", ".rpt2_cache", ".rollup.cache", "tsconfig.tsbuildinfo"]) {
        fs.rmSync(path.join(repository, name), { recursive: true, force: true });
    }
    const assets = checkRepository(repository, manifest);
    const fileCount = checkSourceTree(repository);
    const archiveRoot = path.join(scratch, "zip-input");
    const runtime = path.join(archiveRoot, manifest.id);
    fs.mkdirSync(runtime, { recursive: true });
    for (const name of [...assets, ...notices]) {
        fs.cpSync(path.join(repository, name), path.join(runtime, name), { recursive: true, force: false, errorOnExist: true });
    }
    const installGuide = [
        manifest.name + " " + manifest.version + " beta", "",
        "With Obsidian closed, copy the rudonium-anki-toolkit folder into <vault>/.obsidian/plugins/.",
        "For an update, merge the folder and replace main.js, manifest.json and any supplied styles.css together.",
        "Keep existing data.json, caches and journals. Reopen Obsidian and enable the plugin.", "",
        "Закройте Obsidian и скопируйте папку rudonium-anki-toolkit в <хранилище>/.obsidian/plugins/.",
        "При обновлении объедините папки и замените main.js, manifest.json и приложенный styles.css из этого выпуска вместе.",
        "Сохраните существующие data.json, кеш и журналы. Откройте Obsidian и включите плагин.", "",
    ].join("\r\n");
    fs.writeFileSync(path.join(archiveRoot, "INSTALL.txt"), installGuide, { flag: "wx" });
    // main.js принадлежит вложению релиза. Сборка из опубликованного дерева должна заново дать те же байты.
    fs.unlinkSync(path.join(repository, "main.js"));
    onSourcesChecked?.();
    runNode(path.join(repository, "Build", "verify-rebuild.cjs"), [repository, runtime]);
    fs.mkdirSync(releaseDirectory);
    const zipName = "Rudonium-" + manifest.version + ".zip";
    const archive = path.join(releaseDirectory, zipName);
    const zip = await import(pathToFileURL(overlay.file("vault-backup-zip.ts")).href);
    const written = await zip.writeVaultZip(archiveRoot, archive);
    const checked = await zip.verifyVaultZip(archive);
    if (written.files !== checked.files || written.bytes !== checked.bytes) throw new Error("Incomplete install ZIP.");
    fs.writeFileSync(path.join(releaseDirectory, "SHA256SUMS.txt"),
        sha256(fs.readFileSync(archive)) + "  " + zipName + "\n", { flag: "wx" });
    // Оставляем пользователю те же проверенные файлы, которые только что вошли в ZIP.
    const installDirectory = path.join(path.dirname(releaseDirectory), "install");
    fs.mkdirSync(installDirectory);
    fs.renameSync(runtime, path.join(installDirectory, manifest.id));
    return fileCount - 1; // main.js lives in the install ZIP and unpacked install folder.
}

// A published checkout already contains all patched sources. Rebuild a private copy of it
// so local edits are released and previous evidence and working files stay intact.
function buildCheckout(checkout, repository, manifest) {
    const { isUpstreamTestState, isFreeFileSyncState, collectDependencyNotices, finalizeProvenance } = require("./release-provenance.cjs");
    const { npm } = require("./build-main.cjs");
    const generated = new Set([".git", "node_modules", "dist", "main.js", "main.js.map", "PROVENANCE.json",
        "LICENSES/dependencies", ".rpt2_cache", ".rollup.cache", "tsconfig.tsbuildinfo", "Build/build-error.txt"]);
    fs.cpSync(checkout, repository, { recursive: true, filter(filename) {
        const relative = path.relative(checkout, filename).split(path.sep).join("/");
        return !generated.has(relative) && !isUpstreamTestState(relative) && !isFreeFileSyncState(relative) && !/^Release-\d+\.\d+\.\d+$/.test(relative) && !/^Build\/\.build-/.test(relative);
    } });
    checkSourceTree(repository);
    npm(["ci", "--no-audit", "--no-fund"], repository);
    npm(["exec", "--offline", "--", "tsc", "--noEmit"], repository, true);
    npm(["run", "build"], repository, true);
    runNode("--check", [path.join(repository, "main.js")]);
    collectDependencyNotices(repository);
    fs.rmSync(path.join(repository, "node_modules"), { recursive: true, force: true });
    finalizeProvenance(repository, { release: manifest, license: "GPL-3.0-only" });
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
    if (args.length > 2) throw new Error("Usage: node Build/prepare-gitflic.cjs [official-source-directory|-] [new-output-directory]");
    const manifest = readJson(path.join(kit, "manifest.json"));
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid release version.");
    const source = args[0] && args[0] !== "-" ? fs.realpathSync(args[0]) : "-";
    const expanded = fs.existsSync(path.join(__dirname, "overlay-files.json"));
    if (expanded && source !== "-") throw new Error("An expanded repository already contains its sources. Pass - for the first argument.");
    const output = path.resolve(args[1] || path.join(kit, "..", "GitFlic-" + manifest.version));
    if (fs.lstatSync(output, { throwIfNoEntry: false })) throw new Error("Destination already exists. Choose a new directory: " + output);
    // Protect against recursively copying a parent directory into its own build or output.
    function inside(parent, child) {
        const rel = path.relative(parent, child);
        return !rel || !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
    }
    if (inside(kit, output) || source !== "-" && (inside(source, output) || inside(source, kit))) {
        throw new Error("Choose separate locations for the kit, official source and output.");
    }
    const stage = fs.mkdtempSync(path.join(path.dirname(output), ".rudonium-gitflic-"));
    const publish = path.join(stage, "publish");
    const repository = path.join(publish, "repository");
    let sourcesChecked = false;
    try {
        fs.mkdirSync(publish);
        console.log("1/3 Preparing the complete source repository for " + manifest.version + "...");
        if (expanded) buildCheckout(kit, repository, manifest);
        else runNode(path.join(__dirname, "build-main.cjs"), ["--prepare-repository", source, repository]);
        console.log("2/3 Checking the runtime against two clean builds and creating the install ZIP...");
        const fileCount = await stageRelease(repository, path.join(publish, "release"), stage, manifest,
            () => { sourcesChecked = true; });
        writeCompareProfile(publish, path.join(output, "repository"));
        if (fs.lstatSync(output, { throwIfNoEntry: false })) throw new Error("Destination appeared while building: " + output);
        fs.renameSync(publish, output);
        console.log("3/3 GitFlic files ready: " + output);
        console.log("Repository (" + fileCount + " files): " + path.join(output, "repository"));
        console.log("FreeFileSync: " + path.join(output, "Compare.ffs_gui"));
        console.log("Compiled plugin: " + path.join(output, "install", manifest.id, "main.js"));
        console.log("Release description: repository/docs/releases/" + manifest.version + ".md");
    } catch (error) {
        // The source tree has passed its checks. A later rebuild or ZIP failure
        // must not take the user's usable sources with it.
        if (sourcesChecked && fs.existsSync(repository)) {
            const saved = fs.mkdtempSync(path.join(path.dirname(output), "Sources-" + manifest.version + "-"));
            fs.renameSync(repository, path.join(saved, "repository"));
            error.message += "\nSources saved: " + path.join(saved, "repository") + "\nRelease verification did not finish.";
        }
        throw error;
    } finally {
        fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
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
