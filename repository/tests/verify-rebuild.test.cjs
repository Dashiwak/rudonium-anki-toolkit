// SPDX-License-Identifier: GPL-3.0-only
"use strict";

// Настоящие npm ci и npm run build в автономном мини-проекте без внешних зависимостей.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const verify = path.resolve(__dirname, "../Build/verify-rebuild.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudonium-cli-test-"));
const repo = path.join(root, "repo with spaces");
const release = path.join(root, "reference");
const temp = path.join(root, "clean trees");
const text = "const release = true;\n";

function run(...args) {
    const result = spawnSync(process.execPath, [verify, ...args], {
        encoding: "utf8", env: {
            ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, npm_config_offline: "true",
            npm_config_cache: path.join(root, "npm-cache"),
        },
    });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    assert.deepEqual(fs.readdirSync(temp).filter(name => name.startsWith("rudonium-verify-")), [],
        "temporary build trees must be removed on every exit");
    assert.equal(fs.readFileSync(path.join(repo, "main.js"), "utf8"), text);
    return { status: result.status, output };
}

try {
    for (const dir of [repo, release, temp]) fs.mkdirSync(dir);
    const pkg = { name: "npm-build-verification-fixture", version: "1.0.0", scripts: { build: "node build.cjs" } };
    const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
        "": { name: pkg.name, version: pkg.version },
    } };
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify(lock));
    for (const dir of [repo, release]) {
        fs.writeFileSync(path.join(dir, "main.js"), text);
        fs.writeFileSync(path.join(dir, "manifest.json"), '{"version":"1.0.0"}\n');
    }
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "stale"), "stale");
    fs.mkdirSync(path.join(repo, ".git"));
    const script = [
        'const fs = require("node:fs");',
        'if (["main.js", "node_modules/stale", ".git"].some(f => fs.existsSync(f))) throw Error("Unclean source copy");',
        'fs.writeFileSync("main.js", ' + JSON.stringify(text) + ');',
    ].join("\n");
    const file = path.join(repo, "build.cjs");
    fs.writeFileSync(file, script);
    const self = run(repo);
    assert.equal(self.status, 0, self.output);
    assert.match(self.output, /Both clean builds match/);
    assert.match(self.output, /styles\.css\s+\(absent\)/);
    console.log("PASS checked-in reference, fresh main.js and two offline npm builds");

    for (const dir of [repo, release]) fs.writeFileSync(path.join(dir, "styles.css"), "body {}\n");
    const external = run(repo, release);
    assert.equal(external.status, 0, external.output);
    console.log("PASS external reference including optional stylesheet");

    fs.writeFileSync(file, script + '\nif (require("node:path").basename(process.cwd()) === "build-2") fs.appendFileSync("main.js", "// different");');
    const stale = run(repo, release);
    assert.notEqual(stale.status, 0);
    assert.match(stale.output, /Build 2 differs[\s\S]*main\.js[\s\S]*Expected SHA-256:[\s\S]*Actual SHA-256:/);
    console.log("PASS rejected second-build nondeterminism");

    fs.writeFileSync(file, "// Produced no output\n");
    const missing = run(repo, release);
    assert.notEqual(missing.status, 0);
    assert.match(missing.output, /main\.js[\s\S]*file missing/);
    console.log("PASS rejected a build that left no main.js");

    fs.writeFileSync(file, script);
    fs.unlinkSync(path.join(release, "styles.css"));
    const styles = run(repo, release);
    assert.notEqual(styles.status, 0);
    assert.match(styles.output, /differs[\s\S]*styles\.css/);
    console.log("PASS rejected unexpected stylesheet");

    fs.writeFileSync(path.join(release, "styles.css"), "body {}\n");
    fs.writeFileSync(path.join(release, "manifest.json"), '{"version":"0.9.0"}\n');
    const manifest = run(repo, release);
    assert.notEqual(manifest.status, 0);
    assert.match(manifest.output, /differs[\s\S]*manifest\.json/);
    console.log("PASS rejected reference from a different release");

    const kit = path.join(root, "source kit");
    const upstream = path.join(kit, "official source with spaces");
    const outputName = "Release-0.9.0";
    const kitReference = path.join(kit, outputName);
    for (const dir of [path.join(kit, "Build"), upstream, kitReference]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(kit, "package.json"), JSON.stringify({
        name: "rudonium-anki-toolkit-source-kit", version: "0.9.0", scripts: { build: "node Build/build-main.cjs" },
    }));
    fs.writeFileSync(path.join(kitReference, "manifest.json"), '{"version":"0.9.0"}\n');
    fs.copyFileSync(path.join(kitReference, "manifest.json"), path.join(kit, "manifest.json"));
    fs.writeFileSync(path.join(kitReference, "main.js"), text);
    fs.writeFileSync(path.join(upstream, "source.js"), text);
    fs.writeFileSync(path.join(kit, "main.js"), "previous build");
    fs.writeFileSync(path.join(kit, "styles.css"), "stale style");
    const kitScript = [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'if (["Release-0.9.0", "main.js", "styles.css", "official source with spaces"].some(f => fs.existsSync(f))) throw Error("Unclean source kit");',
        'fs.mkdirSync("Release-0.9.0");',
        'fs.copyFileSync("manifest.json", "Release-0.9.0/manifest.json");',
        'fs.copyFileSync(path.join(process.argv[2], "source.js"), "Release-0.9.0/main.js");',
    ].join("\n");
    const kitBuilder = path.join(kit, "Build", "build-main.cjs");
    fs.writeFileSync(kitBuilder, kitScript);
    const kitResult = run(kit, kitReference, upstream);
    assert.equal(kitResult.status, 0, kitResult.output);
    assert.match(kitResult.output, /Clean build 2\/2[\s\S]*Both clean builds match/);
    fs.appendFileSync(kitBuilder, '\nif (path.basename(process.cwd()) === "build-2") fs.appendFileSync("Release-0.9.0/main.js", "changed");');
    const badKit = run(kit, kitReference, upstream);
    assert.notEqual(badKit.status, 0);
    assert.match(badKit.output, /Build 2 differs[\s\S]*main\.js/);
    console.log("PASS source-kit verification exercises two clean outputs, excludes stale files and preserves the reference");
} finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
