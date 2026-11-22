// SPDX-License-Identifier: GPL-3.0-only
"use strict";

// Все сценарии используют настоящие временные файлы. В проверках облачной папки моделируются только свойства файловой системы.
// Компилятор, npm и сеть не подменяются и не запускаются.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const build = path.resolve(process.argv[2] || path.join(__dirname, "../Build"));
const { captureUpstream, applyReleaseMetadata, collectDependencyNotices, finalizeProvenance } = require(path.join(build, "release-provenance.cjs"));
const temporary = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "rudonium-provenance-tests-"));
const gpl = fs.readFileSync(path.join(build, "../LICENSE"));
const options = { expectedCommit: "2dd39fefd26f3141a4e02105b1172a5a3eb2611f", repository: "https://github.com/ObsidianToAnki/Obsidian_to_Anki", acquisition: "local-directory; revision not independently verified" };
const release = { id: "rudonium-anki-toolkit", name: "Rudonium Anki Toolkit", version: JSON.parse(fs.readFileSync(path.join(build, "../manifest.json"), "utf8")).version };
const license = "GPL-3.0-only";
let fixtures = 0, passed = 0, skipped = 0;
let symlinksAvailable = true, symlinkReason = "";
try {
    const file = path.join(temporary, "symlink-probe.txt"), directory = path.join(temporary, "symlink-probe-directory");
    fs.writeFileSync(file, "probe"); fs.mkdirSync(directory);
    fs.symlinkSync(file, path.join(temporary, "symlink-probe-file-link"), "file");
    fs.symlinkSync(directory, path.join(temporary, "symlink-probe-directory-link"), "dir");
} catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) throw error;
    symlinksAvailable = false; symlinkReason = error.code;
}
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function write(root, relative, bytes) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
function read(root, relative) { return fs.readFileSync(path.join(root, ...relative.split("/"))); }
function json(root, relative) { return JSON.parse(read(root, relative)); }
function fixture() {
    const root = path.join(temporary, "fixture-" + ++fixtures), source = path.join(root, "source"), kit = path.join(root, "kit");
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(kit);
    write(source, "LICENSE", gpl); write(kit, "LICENSE", gpl);
    write(source, "README.md", "# Upstream\r\nOriginal attribution: Pseudonium and contributors.\r\n");
    write(source, "README-ru.md", "Исходная инструкция\r\n");
    write(source, "COPYRIGHT", "Copyright retained verbatim\r\n");
    write(source, "LICENSES/asset.txt", "Original asset notice\r\n");
    write(source, "package.json", JSON.stringify({ name: "obsidian-to-anki-plugin", version: "3.6.0", license: "MIT", dependencies: { one: "1.0.0" } }, null, 4) + "\r\n");
    write(source, "package-lock.json", JSON.stringify({ name: "obsidian-to-anki-plugin", version: "3.6.0", license: "MIT", lockfileVersion: 3,
        packages: { "": { name: "obsidian-to-anki-plugin", version: "3.6.0", license: "MIT", dependencies: { one: "1.0.0" } },
            "node_modules/one": { version: "1.0.0", license: "MIT", resolved: "https://registry.npmjs.org/one/-/one-1.0.0.tgz", integrity: "sha512-test-origin" } } }, null, 2));
    write(source, "main.ts", "// Original attribution\r\nexport const old = 1\r\n");
    write(source, "src/keep.ts", "// Keep original comment\nexport const keep = 1\n");
    write(source, "src/remove.ts", "export const removed = true\n");
    write(source, "manifest.json", JSON.stringify({ id: "obsidian-to-anki-plugin", version: "3.6.0" }));
    write(source, "styles.css", "/* original styling */\n");
    return { root, source, kit };
}
function snapshot(state) { return captureUpstream(state.source, state.kit, options); }
function packageAt(state, directory, metadata = {}, notices = { LICENSE: "MIT notice\r\n" }) {
    write(state.source, directory + "/package.json", JSON.stringify({ name: "one", version: "1.0.0", license: "MIT", ...metadata }));
    for (const [name, bytes] of Object.entries(notices)) write(state.source, directory + "/" + name, bytes);
}
function outputTree(root, relative) {
    const result = {};
    const walk = directory => {
        for (const name of fs.readdirSync(path.join(root, directory)).sort()) {
            const child = directory + "/" + name, info = fs.lstatSync(path.join(root, child));
            if (info.isDirectory()) walk(child);
            else result[child.slice(relative.length + 1)] = read(root, child).toString("base64");
        }
    }; walk(relative); return result;
}
function pass(label) { console.log("PASS " + label); passed++; }

try {
    {
        // Standard GPLv3 text distributed with Debian and the original build kit.
        assert.equal(digest(gpl), "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986");
        const notice = fs.readFileSync(path.join(build, "../NOTICE.md"), "utf8");
        assert.ok(notice.includes("**" + release.version + "**"), "NOTICE must identify the manifest version");
        for (const attribution of ["dashiwak", "https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue", "Pseudonium", "GPL-3.0-only"]) {
            assert.ok(notice.includes(attribution), "Missing release attribution: " + attribution);
        }
        pass("release has the verbatim GPLv3 license and separately attributes its current version and authors");
    }
    {
        const state = fixture(), original = read(state.source, "package.json");
        write(state.source, "LICENSES/dependencies/original.txt", "Existing upstream dependency notice\n");
        const result = snapshot(state);
        for (const relative of ["LICENSE", "README.md", "README-ru.md", "package.json", "package-lock.json", "COPYRIGHT", "LICENSES/asset.txt", "LICENSES/dependencies/original.txt"]) {
            assert.deepEqual(read(state.source, "UPSTREAM-SNAPSHOT/files/" + relative), read(state.source, relative));
        }
        assert.equal(result.licenseEvidence.packageLicense, "MIT");
        assert.match(result.licenseEvidence.interpretation, /does not resolve/);
        assert.match(result.revisionVerification, /does not independently verify/);
        assert.equal(fs.existsSync(path.join(state.source, "UPSTREAM-SNAPSHOT/files/src/keep.ts")), false);
        const hash = json(state.source, "UPSTREAM-SNAPSHOT/source-hashes.json").files.find(file => file.path === "src/keep.ts");
        assert.equal(hash.sha256, digest(read(state.source, "src/keep.ts")));
        assert.deepEqual(read(state.source, "package.json"), original);
        pass("upstream bytes, GPL/MIT discrepancy, source hashes and unverified revision are preserved without duplicating source files");
    }
    {
        for (const change of [state => fs.unlinkSync(path.join(state.source, "LICENSE")), state => write(state.source, "LICENSE", "MIT license text"), state => write(state.source, "LICENSE", "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\nEND OF TERMS AND CONDITIONS"), state => write(state.kit, "LICENSE", "MIT")]) {
            const state = fixture(), before = read(state.source, "package.json"); change(state);
            assert.throws(() => snapshot(state));
            assert.equal(fs.existsSync(path.join(state.source, "UPSTREAM-SNAPSHOT")), false);
            assert.deepEqual(read(state.source, "package.json"), before);
            assert.ok(!fs.readdirSync(state.source).some(name => name.startsWith(".rudonium-provenance-")));
        }
        pass("missing, non-GPL and truncated documents stop before metadata changes or snapshot publication");
    }
    {
        for (const invalid of [{ ...options, expectedCommit: "unknown" }, { ...options, repository: "file:///outside" }, { ...options, acquisition: "" }]) {
            const state = fixture(); assert.throws(() => captureUpstream(state.source, state.kit, invalid));
            assert.equal(fs.existsSync(path.join(state.source, "UPSTREAM-SNAPSHOT")), false);
        }
        const state = fixture(); snapshot(state);
        const original = read(state.source, "UPSTREAM-SNAPSHOT/origin.json");
        assert.throws(() => snapshot(state), /already exists/);
        assert.deepEqual(read(state.source, "UPSTREAM-SNAPSHOT/origin.json"), original);
        pass("invalid provenance inputs and an existing snapshot fail without replacement");
    }
    {
        if (symlinksAvailable) {
            for (const name of ["LICENSE", "README.md", "src/linked.ts"]) {
                const state = fixture(), outside = path.join(state.root, "outside.txt");
                fs.writeFileSync(outside, name === "LICENSE" ? gpl : "External sentinel");
                const link = path.join(state.source, name); fs.rmSync(link, { force: true }); fs.symlinkSync(outside, link, "file");
                assert.throws(() => snapshot(state), /symbolic link/);
                assert.equal(fs.existsSync(path.join(state.source, "UPSTREAM-SNAPSHOT")), false);
            }
            const state = fixture(); fs.symlinkSync(state.source, path.join(state.root, "source-link"), "dir");
            assert.throws(() => captureUpstream(path.join(state.root, "source-link"), state.kit, options), /real directory/);
            pass("source, readme and intermediate source links are rejected instead of following external files");
        } else {
            skipped++;
            console.log("SKIP source symlink rejection group: operating system does not permit test symlinks (" + symlinkReason + ")");
        }
    }
    {
        const state = fixture(); snapshot(state);
        const result = applyReleaseMetadata(state.source, release, license), pkg = json(state.source, "package.json"), lock = json(state.source, "package-lock.json");
        for (const root of [pkg, lock, lock.packages[""]]) for (const [key, value] of Object.entries({ name: "rudonium-anki-toolkit", version: release.version, license })) assert.equal(root[key], value);
        assert.equal(pkg.bugs.url, "https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue");
        assert.equal(pkg.homepage, "https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit");
        assert.equal(pkg.repository.url, pkg.homepage + ".git");
        assert.equal(lock.packages["node_modules/one"].license, "MIT");
        assert.equal(json(state.source, "UPSTREAM-SNAPSHOT/files/package.json").license, "MIT");
        assert.deepEqual(pkg.dependencies, { one: "1.0.0" }); assert.equal(result.lockRootPackagePresent, true);
        pass("release license is consistent in all three root metadata entries while original and dependency licenses remain intact");
    }
    {
        const state = fixture(); snapshot(state);
        for (const badLicense of ["MIT", "GPL-3.0-or-later", undefined]) {
            const before = read(state.source, "package.json"); assert.throws(() => applyReleaseMetadata(state.source, release, badLicense));
            assert.deepEqual(read(state.source, "package.json"), before);
        }
        write(state.source, "package-lock.json", JSON.stringify({ packages: [] }));
        const before = read(state.source, "package.json"); assert.throws(() => applyReleaseMetadata(state.source, release, license), /packages object/);
        assert.deepEqual(read(state.source, "package.json"), before);
        write(state.source, "package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: { one: { version: "1.0.0" } } }));
        const result = applyReleaseMetadata(state.source, release, license);
        assert.equal(result.lockRootPackagePresent, false); assert.equal(json(state.source, "package-lock.json").packages, undefined);
        assert.equal(json(state.source, "package-lock.json").license, license);
        pass("invalid metadata is rejected before writes and legacy lockfiles do not gain a fake packages table");
    }
    {
        for (const kind of ["size", "depth"]) {
            const state = fixture();
            if (kind === "size") { write(state.source, "AUTHORS", ""); fs.truncateSync(path.join(state.source, "AUTHORS"), 8 * 1024 * 1024 + 1); }
            else write(state.source, "src/" + Array.from({ length: 49 }, () => "deep").join("/") + "/file.ts", "x");
            assert.throws(() => snapshot(state), /size limit|depth limit/);
            assert.equal(fs.existsSync(path.join(state.source, "UPSTREAM-SNAPSHOT")), false);
            assert.ok(!fs.readdirSync(state.source).some(name => name.startsWith(".rudonium-provenance-")));
        }
        pass("source byte and directory depth limits fail closed and remove partial snapshots");
    }
    {
        const state = fixture();
        packageAt(state, "node_modules/one", { repository: { type: "git", url: "https://example.invalid/one" } }, { LICENSE: "MIT\r\n", NOTICE: "Attribution\r\n", "LICENSES/extra.txt": "Asset grant\n" });
        packageAt(state, "node_modules/@scope/build-tool", { name: "@scope/build-tool", version: "2.0.0", license: "Apache-2.0", dev: true }, { "LICENSE.txt": "Apache notice\n", AUTHORS: "Original authors\n" });
        packageAt(state, "node_modules/one/node_modules/nested", { name: "nested", version: "3.0.0", license: "BSD-2-Clause" }, { COPYING: "BSD notice\n", NOTICE: "Attribution\r\n", "legal/seal": Buffer.from([0, 255, 17]) });
        const inventory = collectDependencyNotices(state.source);
        assert.equal(inventory.packages.length, 3); assert.equal(inventory.coverageStatus, "installed-package-notices-captured");
        assert.equal(inventory.reviewRequired, true); assert.match(inventory.scope, /including build tools/); assert.match(inventory.bundleAssessment, /Not performed/);
        const one = inventory.packages.find(item => item.name === "one");
        assert.equal(one.resolved, "https://registry.npmjs.org/one/-/one-1.0.0.tgz"); assert.equal(one.integrity, "sha512-test-origin");
        for (const item of inventory.packages) for (const file of item.files) {
            const catalog = read(state.source, "LICENSES/dependencies/" + file.path);
            const saved = catalog.subarray(file.offset, file.offset + file.bytes);
            assert.equal(digest(saved), file.sha256); assert.deepEqual(saved, read(state.source, file.originalPath));
        }
        assert.deepEqual(fs.readdirSync(path.join(state.source, "LICENSES/dependencies")).sort(),
            ["NOTICES.txt", "ORIGINALS.bin", "PACKAGE-METADATA.txt", "inventory.json"]);
        const sameNotice = inventory.packages.flatMap(item => item.files).filter(file => file.originalPath.endsWith("/NOTICE"));
        assert.equal(sameNotice.length, 2);
        assert.equal(sameNotice[0].offset, sameNotice[1].offset);
        const readable = read(state.source, "LICENSES/dependencies/NOTICES.txt").toString("utf8");
        for (const file of sameNotice) assert.ok(readable.includes(file.originalPath));
        assert.equal(readable.split("Attribution\r\n").length, 2);
        pass("scoped, nested and build dependencies retain exact legal files, original package metadata and registry origins");
    }
    {
        const state = fixture();
        packageAt(state, "node_modules/one");
        const sourceLicense = path.join(state.source, "LICENSE");
        const dependencyLicense = path.join(state.source, "node_modules", "one", "LICENSE");
        const actualLstat = fs.lstatSync;
        fs.lstatSync = (filename, ...options) => {
            const stat = actualLstat(filename, ...options);
            if (filename === sourceLicense || filename === dependencyLicense) {
                stat.ino = typeof stat.ino === "bigint" ? 0n : 0;
                stat.mtimeMs += typeof stat.mtimeMs === "bigint" ? 1000n : 1000;
                if (stat.mtimeNs !== undefined) stat.mtimeNs += 1000000000n;
            }
            return stat;
        };
        try {
            snapshot(state);
            assert.deepEqual(read(state.source, "UPSTREAM-SNAPSHOT/files/LICENSE"), gpl);
            const inventory = collectDependencyNotices(state.source);
            assert.equal(inventory.coverageStatus, "installed-package-notices-captured");
            const license = inventory.packages[0].files.find(item => item.originalPath === "node_modules/one/LICENSE");
            const catalog = read(state.source, "LICENSES/dependencies/" + license.path);
            assert.deepEqual(catalog.subarray(license.offset, license.offset + license.bytes), read(state.source, license.originalPath));
        } finally { fs.lstatSync = actualLstat; }
        pass("original license files are preserved when a provider reports different path and handle metadata");
    }
    {
        const state = fixture();
        packageAt(state, "node_modules/one");
        const licenseFile = path.join(state.source, "node_modules", "one", "LICENSE");
        const actualLstat = fs.lstatSync, actualOpen = fs.openSync;
        let readOpens = 0;
        fs.lstatSync = (filename, ...options) => {
            const stat = actualLstat(filename, ...options);
            if (filename === licenseFile) stat.ino = typeof stat.ino === "bigint" ? 0n : 0;
            return stat;
        };
        fs.openSync = (filename, flags, ...options) => {
            if (filename === licenseFile && typeof flags === "number" && ++readOpens === 2) {
                fs.truncateSync(filename, 8 * 1024 * 1024 + 1);
            }
            return actualOpen(filename, flags, ...options);
        };
        try {
            const inventory = collectDependencyNotices(state.source);
            assert.ok(readOpens >= 2, "uncertain file identity must trigger an independent read");
            assert.ok(inventory.issues.some(item => item.path === "node_modules/one/LICENSE"));
            assert.ok(!inventory.packages[0].files.some(item => item.originalPath === "node_modules/one/LICENSE"));
        } finally { fs.openSync = actualOpen; fs.lstatSync = actualLstat; }
        pass("a dependency notice that grows past its size limit on retry is reported and excluded");
    }
    {
        const state = fixture();
        packageAt(state, "node_modules/no-notice", { name: "no-notice" }, {});
        write(state.source, "node_modules/invalid/package.json", "not JSON");
        write(state.source, "node_modules/invalid/LICENSE", "Valid standalone notice\n");
        const outside = path.join(state.root, "outside-package"); fs.mkdirSync(outside);
        write(outside, "package.json", JSON.stringify({ name: "external-sentinel" })); write(outside, "LICENSE", "EXTERNAL MUST NOT BE READ");
        if (symlinksAvailable) fs.symlinkSync(outside, path.join(state.source, "node_modules/link"), "dir");
        else console.log("SKIP linked-package subcheck: operating system does not permit test symlinks (" + symlinkReason + ")");
        const inventory = collectDependencyNotices(state.source);
        assert.equal(inventory.coverageStatus, "requires-review");
        assert.ok(inventory.issues.some(issue => issue.code === "notice-files-not-found"));
        assert.ok(inventory.issues.some(issue => issue.code === "package-metadata-unavailable"));
        if (symlinksAvailable) assert.ok(inventory.issues.some(issue => issue.path === "node_modules/link"));
        assert.ok(!inventory.packages.some(item => item.name === "external-sentinel"));
        assert.ok(!JSON.stringify(outputTree(state.source, "LICENSES/dependencies")).includes(Buffer.from("EXTERNAL MUST NOT BE READ").toString("base64")));
        pass("missing notices, broken metadata and symlinked packages are reported as incomplete rather than cleared");
    }
    {
        const absent = fixture(), inventory = collectDependencyNotices(absent.source);
        assert.equal(inventory.coverageStatus, "requires-review"); assert.ok(inventory.issues.some(issue => issue.code === "node-modules-missing"));
        const state = fixture(); packageAt(state, "node_modules/one");
        fs.truncateSync(path.join(state.source, "node_modules/one/LICENSE"), 8 * 1024 * 1024 + 1);
        const limited = collectDependencyNotices(state.source);
        assert.equal(limited.coverageStatus, "requires-review"); assert.ok(limited.issues.some(issue => issue.code === "notice-file-unavailable"));
        if (symlinksAvailable) {
            const linked = fixture(), external = path.join(linked.root, "external-licenses"); fs.mkdirSync(external);
            fs.symlinkSync(external, path.join(linked.source, "LICENSES-link"), "dir");
            fs.rmSync(path.join(linked.source, "LICENSES"), { recursive: true }); fs.renameSync(path.join(linked.source, "LICENSES-link"), path.join(linked.source, "LICENSES"));
            assert.throws(() => collectDependencyNotices(linked.source), /unsafe output/); assert.deepEqual(fs.readdirSync(external), []);
        } else console.log("SKIP linked-output subcheck: operating system does not permit test symlinks (" + symlinkReason + ")");
        pass("absent installations, oversized legal files and unsafe output paths cannot receive a false complete result");
    }
    {
        const first = fixture(), second = fixture();
        for (const state of [first, second]) {
            snapshot(state); applyReleaseMetadata(state.source, release, license);
            packageAt(state, "node_modules/one", {}, { LICENSE: "Same bytes\r\n" });
            collectDependencyNotices(state.source);
        }
        assert.deepEqual(outputTree(first.source, "UPSTREAM-SNAPSHOT"), outputTree(second.source, "UPSTREAM-SNAPSHOT"));
        assert.deepEqual(outputTree(first.source, "LICENSES/dependencies"), outputTree(second.source, "LICENSES/dependencies"));
        assert.ok(!read(first.source, "LICENSES/dependencies/inventory.json").toString().includes(temporary));
        const saved = read(first.source, "LICENSES/dependencies/inventory.json");
        assert.throws(() => collectDependencyNotices(first.source), /already exists/);
        assert.deepEqual(read(first.source, "LICENSES/dependencies/inventory.json"), saved);
        pass("identical trees produce deterministic relative-path inventories and existing collections are preserved");
    }
    {
        const state = fixture(); snapshot(state); applyReleaseMetadata(state.source, release, license);
        packageAt(state, "node_modules/one"); collectDependencyNotices(state.source);
        write(state.source, "main.ts", "// Modified version\nexport const old = 2\n");
        write(state.source, "src/new.ts", "export const added = true\n"); fs.unlinkSync(path.join(state.source, "src/remove.ts"));
        write(state.source, "main.js", "/*! License retained */\nmodule.exports = {};\n");
        const result = finalizeProvenance(state.source, { release, license });
        assert.equal(result.sourceFiles.find(file => file.path === "main.ts").change, "modified");
        assert.equal(result.sourceFiles.find(file => file.path === "src/keep.ts").change, "unchanged");
        assert.equal(result.sourceFiles.find(file => file.path === "src/new.ts").change, "added");
        assert.deepEqual(result.removedSourceFiles, ["src/remove.ts"]);
        assert.equal(result.artifacts.find(file => file.path === "main.js").sha256, digest(read(state.source, "main.js")));
        assert.equal(result.dependencies.packageCount, 1); assert.equal(result.release.license, license);
        assert.match(result.limitations.join(" "), /not a digital signature/);
        assert.equal(json(state.source, "UPSTREAM-SNAPSHOT/files/package.json").license, "MIT");
        assert.throws(() => finalizeProvenance(state.source, { release, license }), /already exists/);
        pass("final provenance links original metadata, prepared source differences and exact artifact hashes without claiming a native build");
    }
    {
        for (const target of ["UPSTREAM-SNAPSHOT/files/README.md", "UPSTREAM-SNAPSHOT/source-hashes.json"]) {
            const state = fixture(); snapshot(state); write(state.source, target, "Changed evidence");
            assert.throws(() => finalizeProvenance(state.source, { release, license }), /snapshot was changed|hash manifest was changed/);
            assert.equal(fs.existsSync(path.join(state.source, "PROVENANCE.json")), false);
        }
        const state = fixture(); snapshot(state); const record = finalizeProvenance(state.source, { release, license });
        assert.equal(record.dependencies.coverageStatus, "not-collected"); assert.equal(record.dependencies.inventory, null);
        pass("altered evidence stops final publication and absent dependency collection stays explicitly unverified");
    }
    console.log("PROVENANCE RESULT " + passed + " real-filesystem groups passed, " + skipped + " symlink groups skipped; no npm, TypeScript, Rollup or network execution.");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
