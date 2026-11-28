/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function bundleNotice(release, license) {
    return [
        "/*!",
        " * " + release.name + " " + release.version + " — modified 2026-11-28.",
        " * SPDX-License-Identifier: " + license,
        " * Rudonium additions: Copyright (C) 2026 dashiwak. GNU GPLv3. Original component permissions and notices are retained.",
        " * Derived from Obsidian_to_Anki 3.6.0 by Pseudonium and contributors.",
        " * See LICENSE, NOTICE.md, UPSTREAM-SNAPSHOT and LICENSES in the matching distribution.",
        " * Complete corresponding source must accompany distribution or be provided as the GPL permits.",
        " * Without warranty. This notice is not an upstream relicensing permission.",
        " */",
    ].join("\n");
}

function rudoniumRollupConfig(config, notice, version, builtins) {
    if (Array.isArray(config)) return config.map(entry => rudoniumRollupConfig(entry, notice, version, builtins));

    function withReleaseNotice(output) {
        const prepend = (value, prefix) => {
            const combine = text => text ? prefix + "\n" + text : prefix;
            return typeof value === "function"
                ? async function (...args) { return combine(await value.apply(this, args)); }
                : combine(value);
        };
        return { ...output, banner: prepend(output?.banner, notice),
            intro: prepend(output?.intro, "const RUDONIUM_BUILD_VERSION = " + JSON.stringify(version) + ";") };
    }

    const inherited = config.external;
    const rules = Array.isArray(inherited) ? inherited : inherited ? [inherited] : [];
    return {
        ...config,
        onwarn(warning, show) {
            if (config.onwarn) config.onwarn.call(this, warning, show);
            else show(warning);
            throw new Error("Rollup " + (warning.code || "warning") + ": " + warning.message);
        },
        output: Array.isArray(config.output) ? config.output.map(withReleaseNotice) : withReleaseNotice(config.output),
        external(id, ...args) {
            if (builtins.has(id) || id.startsWith("node:") || id.startsWith("@codemirror/")) return true;
            if (typeof inherited === "function") return inherited.call(this, id, ...args);
            return rules.some(rule => typeof rule === "string" ? rule === id : rule.test(id));
        },
    };
}

function configureRollup(sourceDirectory, release, license) {
    const file = path.join(sourceDirectory, "rollup.config.js");
    const text = fs.readFileSync(file, "utf8");
    const esm = /^[ \t]*export\s+default\s+/m;
    const commonjs = /^[ \t]*module\.exports\s*=\s*/m;
    if (text.includes("const rudoniumUpstreamConfig =")) throw new Error("Release Rollup configuration already applied.");
    const declaration = esm.test(text) ? esm : commonjs.test(text) ? commonjs : null;
    if (!declaration) throw new Error("Unrecognized upstream Rollup configuration export.");
    const exporter = declaration === esm ? "export default" : "module.exports =";
    const original = text.replace(declaration, "const rudoniumUpstreamConfig = ");
    const readManifest = declaration === esm
        ? 'import { builtinModules as rudoniumBuiltins } from "module";\n' +
            'import { readFileSync as rudoniumReadFile } from "fs";\n' +
            'const rudoniumManifest = JSON.parse(rudoniumReadFile(new URL("./manifest.json", import.meta.url), "utf8"));'
        : 'const { builtinModules: rudoniumBuiltins } = require("module");\n' +
            'const rudoniumManifest = require("./manifest.json");';
    const config = original + "\n" + readManifest + "\n" + bundleNotice.toString() + "\n" +
        rudoniumRollupConfig.toString() + "\n\n" +
        exporter + " rudoniumRollupConfig(rudoniumUpstreamConfig, bundleNotice(rudoniumManifest, " +
        JSON.stringify(license) + "), rudoniumManifest.version, new Set(rudoniumBuiltins));\n";
    fs.writeFileSync(file, config);
}

module.exports = { bundleNotice, configureRollup };
