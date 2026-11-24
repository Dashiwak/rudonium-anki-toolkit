/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cleanupTemporaryDirectory } = require("./workflow-files.cjs");
const overlay = require("./overlay-source.cjs");
const { copySuppliedSource } = require("./upstream-source.cjs");
const { bundleNotice, configureRollup } = require("./release-rollup.cjs");
const { isUpstreamTestState, isFreeFileSyncState, captureUpstream, applyReleaseMetadata, collectDependencyNotices, finalizeProvenance } = require("./release-provenance.cjs");

const upstreamCommit = "2dd39fefd26f3141a4e02105b1172a5a3eb2611f";
const upstreamArchive = "https://codeload.github.com/ObsidianToAnki/Obsidian_to_Anki/tar.gz/" + upstreamCommit;
const pluginId = "obsidian-to-anki-plugin";
const kit = path.resolve(__dirname, "..");
const releaseManifest = path.join(kit, "manifest.json");
const output = path.join(kit, "main.js");
const releaseLicense = "GPL-3.0-only";
const errorReport = path.join(__dirname, "build-error.txt");
const legalFiles = ["LICENSE", "NOTICE.md", "AUTHORS.md", "TRADEMARKS.md", "LICENSING-ru.md"];

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.error) throw new Error(command + ": " + result.error.message);
    if (result.status !== 0) {
        throw new Error(command + " " + args.join(" ") + " exited with " + (result.status ?? result.signal));
    }
}

function npm(args, cwd, checkTypeErrors = false) {
    const windows = process.platform === "win32";
    const command = windows ? process.env.ComSpec || "cmd.exe" : "npm";
    const parameters = windows ? ["/d", "/s", "/c", "npm " + args.join(" ")] : args;
    if (checkTypeErrors) {
        const result = spawnSync(command, parameters, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error) throw result.error;
        if (/\bTS\d{4,5}\s*:/.test((result.stdout ?? "") + (result.stderr ?? ""))) {
            const error = new Error("TypeScript diagnostics prevented installing the new main.js.");
            error.details = [result.stdout, result.stderr].join("\n").split(/\r?\n/)
                .filter(line => /\bTS\d{4,5}\s*:/.test(line)).slice(0, 30).join("\n");
            throw error;
        }
        if (result.status !== 0) throw new Error("npm " + args.join(" ") + " exited with " + (result.status ?? result.signal));
        return;
    }
    run(command, parameters, cwd);
}

async function getSource(temp, source, suppliedDirectory) {
    if (suppliedDirectory) {
        return copySuppliedSource(suppliedDirectory, source, upstreamCommit);
    }

    console.log("Downloading the official Export to Anki 3.6.0 source...");
    let response;
    try {
        response = await fetch(upstreamArchive, { signal: AbortSignal.timeout(90_000) });
    } catch (error) {
        throw new Error("GitHub source download failed: " + (error.cause?.message ?? error.message));
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error("GitHub source download failed (HTTP " + response.status + "). " +
            "If you already have the unpacked official Export to Anki 3.6.0 source, pass its folder to " +
            "Build-Windows.cmd or Build/build-main.cjs.");
    }
    const archive = path.join(temp, "source.tar.gz");
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    fs.mkdirSync(source);
    run("tar", ["-xzf", archive, "--strip-components", "1", "-C", source], temp);
    return { acquisition: "downloaded-pinned-url" };
}

function copyReleaseStyles(source) {
    const styles = path.join(source, "styles.css");
    if (!fs.existsSync(styles)) return;
    const stage = path.join(kit, `.rudonium-styles-${process.pid}.css`);
    try {
        fs.copyFileSync(styles, stage, fs.constants.COPYFILE_EXCL);
        fs.renameSync(stage, path.join(kit, "styles.css"));
    } finally {
        fs.rmSync(stage, { force: true });
    }
}

function verifyRuntimeManifest(script, packaged, expected) {
    if (!packaged.equals(expected)) throw new Error("The compiled distribution contains a different manifest.json.");
    const release = JSON.parse(expected.toString("utf8"));
    // Rollup derives both its visible settings version and its banner from this manifest.
    // The JS expression may be inlined by a minifier, while the release notice must survive.
    if (!script.includes(bundleNotice(release, releaseLicense))) {
        throw new Error("The version in main.js does not match the release manifest.json.");
    }
}

function nameBuildPackage(source, manifest) {
    applyReleaseMetadata(source, manifest, releaseLicense);
}

function copyLegalDocuments(source) {
    for (const name of legalFiles) fs.copyFileSync(path.join(kit, name), path.join(source, name));
    fs.copyFileSync(path.join(kit, "LICENSES", "README.md"), path.join(source, "LICENSES", "README.md"));
}

function prepareDistribution(source, release) {
    const destination = path.join(kit, "Release-" + release.version);
    const stage = fs.mkdtempSync(path.join(kit, ".rudonium-release-"));
    const backup = stage + "-previous";
    let movedPrevious = false;
    try {
        for (const name of ["main.js", "manifest.json", "styles.css", ...legalFiles,
            "PROVENANCE.json", "UPSTREAM-SNAPSHOT", "LICENSES"]) {
            const file = path.join(source, name);
            if (name === "styles.css" && !fs.existsSync(file)) continue;
            fs.cpSync(file, path.join(stage, name), { recursive: true, errorOnExist: true, force: false });
        }
        if (fs.existsSync(destination)) {
            const info = fs.lstatSync(destination);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The release output is not a regular directory.");
            fs.renameSync(destination, backup);
            movedPrevious = true;
        }
        try { fs.renameSync(stage, destination); }
        catch (error) { if (movedPrevious) fs.renameSync(backup, destination); throw error; }
        if (movedPrevious) cleanupTemporaryDirectory(backup);
        console.log("Distribution with license notices: " + destination);
    } finally { cleanupTemporaryDirectory(stage); }
}

function prepareRepository(source, directory) {
    const destination = path.resolve(directory);
    if (fs.existsSync(destination)) throw new Error("The repository destination already exists.");
    const stage = fs.mkdtempSync(path.join(path.dirname(destination), ".rudonium-repository-"));
    try {
        fs.cpSync(source, stage, { recursive: true, filter: target => {
            const relative = path.relative(source, target).split(path.sep).join("/");
            const rootEntry = relative.split("/", 1)[0];
            return !["node_modules", ".git", ".github"].includes(rootEntry) && !isUpstreamTestState(relative) && !isFreeFileSyncState(relative);
        } });
        for (const name of ["README.md", "README.ru.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ...legalFiles, "CHANGELOG.md", "PUBLISHING.md", "versions.json", ".gitignore", ".gitattributes",
            "Prepare-Release.cmd", "Prepare-GitFlic.cmd", "eslint.config.mjs"]) {
            fs.copyFileSync(path.join(kit, name), path.join(stage, name));
        }
        fs.cpSync(path.join(kit, ".github"), path.join(stage, ".github"), { recursive: true });
        fs.cpSync(path.join(kit, "docs"), path.join(stage, "docs"), { recursive: true });
        // Both the pinned upstream and the fork use lowercase tests/ on all filesystems.
        fs.cpSync(path.join(kit, "tests"), path.join(stage, "tests"), {
            recursive: true,
            filter(from, to) {
                const existing = fs.lstatSync(to, { throwIfNoEntry: false });
                if (!existing) return true;
                const entry = fs.lstatSync(from);
                if (entry.isDirectory() && existing.isDirectory()) return true;
                if (entry.isFile() && existing.isFile() && fs.readFileSync(from).equals(fs.readFileSync(to))) return false;
                throw new Error("An upstream test conflicts with a Rudonium test: " + path.relative(stage, to));
            },
        });
        // Keep the source-kit tooling available with one canonical copy of the TypeScript files in src/.
        const buildTools = path.join(stage, "Build");
        fs.mkdirSync(buildTools, { recursive: true });
        for (const name of fs.readdirSync(__dirname)) {
            const filename = path.join(__dirname, name);
            if (name.endsWith(".cjs") && fs.lstatSync(filename).isFile())
                fs.copyFileSync(filename, path.join(buildTools, name));
        }
        fs.writeFileSync(path.join(buildTools, "overlay-files.json"), JSON.stringify(overlay.names(), null, 2) + "\n");
        if (fs.existsSync(destination)) throw new Error("The repository destination already exists.");
        fs.renameSync(stage, destination);
    } finally {
        cleanupTemporaryDirectory(stage);
    }
    console.log("Source tree assembled: " + destination);
}

async function build() {
    const args = process.argv.slice(2);
    const prepare = args[0] === "--prepare-repository";
    const validArgs = prepare ? args.length === 3 : args.length <= 1 && !args[0]?.startsWith("--");
    if (!validArgs) throw new Error("Usage: node build-main.cjs [unpacked-official-source-directory]\n" +
        "       node build-main.cjs --prepare-repository <unpacked-official-source-directory or -> <new-repository-directory>");
    if (prepare && fs.existsSync(path.resolve(args[2]))) throw new Error("The repository destination already exists.");
    const releaseBytes = fs.readFileSync(releaseManifest);
    const release = JSON.parse(releaseBytes.toString("utf8"));
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(kit, "package.json"), "utf8"));
    if (packageMetadata.version !== release.version) {
        throw new Error("The source-kit package.json version must match manifest.json.");
    }
    const versions = JSON.parse(fs.readFileSync(path.join(kit, "versions.json"), "utf8"));
    if (typeof release.minAppVersion !== "string" || versions[release.version] !== release.minAppVersion) {
        throw new Error("versions.json must map the release version to the minAppVersion from manifest.json.");
    }
    if (release.id !== "rudonium-anki-toolkit" || release.name !== "Rudonium Anki Toolkit" ||
        !/^\d+\.\d+\.\d+$/.test(release.version) || release.isDesktopOnly !== true || packageMetadata.license !== releaseLicense) {
        throw new Error("Invalid Rudonium Anki Toolkit release manifest.");
    }

    try { fs.unlinkSync(errorReport); }
    catch (error) { if (error.code !== "ENOENT") console.warn("Could not clear Build/build-error.txt."); }

    const temp = fs.mkdtempSync(path.join(__dirname, ".build-"));
    let stage = "Acquire upstream source";
    try {
        const source = path.join(temp, "source");
        const directory = prepare ? args[1] : args[0];
        const acquired = await getSource(temp, source, directory === "-" ? undefined : directory);

        stage = "Verify upstream source";
        const manifestPath = path.join(source, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (manifest.id !== pluginId || manifest.version !== "3.6.0") {
            throw new Error("This kit expects the official Export to Anki 3.6.0 source.");
        }
        captureUpstream(source, kit, {
            expectedCommit: upstreamCommit,
            repository: "https://github.com/ObsidianToAnki/Obsidian_to_Anki",
            ...acquired,
        });
        nameBuildPackage(source, release);

        stage = "Install locked dependencies";
        console.log("Installing locked build dependencies...");
        npm(["ci", "--no-audit", "--no-fund", "--loglevel=http"], source);
        stage = "Collect dependency notices";
        collectDependencyNotices(source);
        copyLegalDocuments(source);
        console.log(`Applying ${release.name} ${release.version} patches...`);
        stage = "Apply source patches";
        require("./install.cjs").install(source);
        configureRollup(source, release, releaseLicense);
        fs.writeFileSync(manifestPath, releaseBytes);
        console.log("Checking TypeScript...");
        stage = "TypeScript";
        npm(["exec", "--offline", "--", "tsc", "--noEmit"], source, true);
        const built = path.join(source, "main.js");
        fs.rmSync(built, { force: true });
        console.log("Building the plugin...");
        stage = "Rollup";
        npm(["run", "build"], source, true);

        stage = "Verify compiled plugin";
        const artifact = fs.lstatSync(built, { throwIfNoEntry: false });
        if (!artifact) throw new Error("Rollup did not create a new main.js.");
        if (!artifact.isFile() || !artifact.size) throw new Error("Rollup did not create a nonempty regular main.js.");
        run(process.execPath, ["--check", built], source);

        const script = fs.readFileSync(built, "utf8");
        for (const identifier of [
            "anki-preview-export",
            "anki-preview-current-card",
            "anki-sync-audit-default-deck",
            "anki-sync-audit-choose-deck",
            "fast-scan-index.json",
            "pending-new-notes.json",
            "bidirectional-sync.json",
            "rupos-migration-complete.json",
            "anki-scan-current-note",
            "anki-scan-vault-full",
            "migrate-page-cards",
            "add-anki-page-field",
            "check-cards-without-id",
            "import-zip-changes",
            "prepare-phone-package",
            "anki-open-current-card",
            "convert-anki-ids-to-comments",
            "convert-anki-ids-to-plain",
            "COLLAPSE_ANKI_IDS",
            "open-gitverse-support",
            "rudonium-anki-record-review",
            "@page",
        ]) {
            if (!script.includes(identifier)) throw new Error("The build is missing a required plugin identifier: " + identifier);
        }
        verifyRuntimeManifest(script, fs.readFileSync(manifestPath), releaseBytes);
        finalizeProvenance(source, { release, license: releaseLicense });

        stage = "Write release";
        if (prepare) prepareRepository(source, args[2]);
        else {
            prepareDistribution(source, release);
            copyReleaseStyles(source);
            fs.renameSync(built, output);
            console.log("Install main.js and manifest.json together from Release-" + release.version +
                ". Include styles.css when present.");
        }
    } catch (error) {
        try {
            const text = [
                release.name + " " + release.version, "Stage: " + stage, "Upstream: " + upstreamCommit,
                error.sourceFile && "Source: " + error.sourceFile,
                error.message, error.details,
            ].filter(Boolean).join("\n").replaceAll(temp + path.sep, "").replaceAll(kit + path.sep, "");
            const report = path.join(temp, "build-error.txt");
            fs.writeFileSync(report, text.slice(0, 16384) + "\n", { flag: "wx" });
            fs.renameSync(report, errorReport);
            console.error("Build diagnostics saved to Build/build-error.txt.");
        } catch { console.warn("Could not save Build/build-error.txt."); }
        throw error;
    } finally {
        cleanupTemporaryDirectory(temp);
    }
}

if (require.main === module) build().catch(error => {
    console.error("Build failed: " + (error.cause?.message ?? error.message));
    process.exitCode = 1;
});

module.exports = { prepareRepository, verifyRuntimeManifest, npm };
