// SPDX-License-Identifier: GPL-3.0-only
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { cleanupTemporaryDirectory } = require("./workflow-files.cjs");

const assets = ["main.js", "manifest.json", "styles.css"];

function readAsset(directory, name) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat && name === "styles.css") return null;
    if (!stat || !stat.isFile() || (!stat.size && name !== "styles.css")) {
        throw new Error("Expected a regular " + name + " in " + directory + (stat ? "." : " (file missing)."));
    }
    return fs.readFileSync(file);
}

function sha256(buffer) {
    return buffer === null ? "(absent)" : createHash("sha256").update(buffer).digest("hex");
}

function runNpm(args, cwd) {
    const windows = process.platform === "win32";
    const command = windows ? (process.env.ComSpec || "cmd.exe") : "npm";
    const parameters = windows ? ["/d", "/c", "npm " + args.join(" ")] : args;
    const result = spawnSync(command, parameters, { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("npm " + args.join(" ") + " failed (" + (result.status ?? result.signal) + ").");
}

function verifyRebuild(repository, releaseDirectory, upstreamDirectory) {
    const source = fs.realpathSync(repository);
    const packageFile = path.join(source, "package.json");
    if (!fs.lstatSync(packageFile, { throwIfNoEntry: false })?.isFile()) {
        throw new Error("Pass the source kit or prepared repository containing package.json.");
    }
    const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (typeof pkg.scripts?.build !== "string" || !pkg.scripts.build.trim()) {
        throw new Error("The source must define npm run build.");
    }
    const kit = pkg.name === "rudonium-anki-toolkit-source-kit" &&
        pkg.scripts.build === "node Build/build-main.cjs";
    if (kit && !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Invalid source kit version.");
    if (!kit && !fs.lstatSync(path.join(source, "package-lock.json"), { throwIfNoEntry: false })?.isFile()) {
        throw new Error("The prepared repository requires package-lock.json.");
    }
    if (upstreamDirectory && !kit) throw new Error("Only a source kit accepts an upstream directory.");
    const supplied = upstreamDirectory && fs.realpathSync(upstreamDirectory);
    const output = "Release-" + pkg.version;
    const defaultRelease = kit && fs.existsSync(path.join(source, output)) ? path.join(source, output) : source;
    const release = fs.realpathSync(releaseDirectory ?? defaultRelease);
    const expected = assets.map(name => readAsset(release, name));
    const tempRoot = fs.realpathSync(os.tmpdir());
    const relativeTemp = path.relative(source, tempRoot);
    if (!path.isAbsolute(relativeTemp) && relativeTemp.split(path.sep)[0] !== "..") {
        throw new Error("Choose a temporary directory outside the prepared repository.");
    }
    const temp = fs.mkdtempSync(path.join(tempRoot, "rudonium-verify-"));
    try {
        for (let number = 1; number <= 2; number++) {
            const worktree = path.join(temp, "build-" + number);
            fs.cpSync(source, worktree, {
                recursive: true,
                filter(file) {
                    if (file === source) return true;
                    const name = path.basename(file);
                    if (kit && (file === supplied ||
                        path.dirname(file) === source && (/^Release-\d+\.\d+\.\d+$/.test(name) || name === "styles.css") ||
                        path.dirname(file) === path.join(source, "Build") && (name.startsWith(".build-") || name === "build-error.txt"))) return false;
                    if ([".git", "node_modules", ".rpt2_cache", ".rollup.cache"].includes(name) ||
                        name.endsWith(".tsbuildinfo") || file === path.join(source, "main.js") ||
                        (source !== release && file === release)) return false;
                    const stat = fs.lstatSync(file);
                    if (!stat.isDirectory() && !stat.isFile()) {
                        throw new Error("Clean builds require regular files and directories: " + path.relative(source, file));
                    }
                    return true;
                },
            });
            console.log("Clean build " + number + "/2: " + (kit ? "source kit with locked upstream dependencies" : "npm ci, npm run build"));
            if (kit) {
                const args = [path.join(worktree, "Build", "build-main.cjs")];
                if (supplied) args.push(supplied);
                const result = spawnSync(process.execPath, args, { cwd: worktree, stdio: "inherit" });
                if (result.error) throw result.error;
                if (result.status !== 0) throw new Error("Source-kit build failed (" + (result.status ?? result.signal) + ").");
            } else {
                runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], worktree);
                runNpm(["run", "build"], worktree);
            }
            for (const [index, name] of assets.entries()) {
                const actual = readAsset(kit ? path.join(worktree, output) : worktree, name);
                const reference = expected[index];
                const equal = actual === null || reference === null ? actual === reference : actual.equals(reference);
                if (!equal) {
                    throw new Error("Build " + number + " differs from " + release + " for " + name +
                        "\nExpected SHA-256: " + sha256(reference) + "\nActual SHA-256:   " + sha256(actual));
                }
            }
        }
        console.log("Both clean builds match the reference assets byte for byte.");
        for (const [index, name] of assets.entries()) console.log(name + "  " + sha256(expected[index]));
    } finally {
        cleanupTemporaryDirectory(temp);
    }
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length < 1 || args.length > 3) throw new Error("Usage: node " + path.basename(__filename) +
            " <source-kit-or-prepared-repository> [release-directory] [upstream-directory-for-source-kit]");
        verifyRebuild(...args);
    } catch (error) {
        console.error("Build verification failed: " + error.message);
        process.exitCode = 1;
    }
}
