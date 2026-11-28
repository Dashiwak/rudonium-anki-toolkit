import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

const rudoniumUpstreamConfig = {
  input: 'main.ts',
  output: {
    file: 'main.js',
    format: 'cjs',
    exports: "default"
  },
  plugins: [nodeResolve(), commonjs(), typescript()],
  external: ["obsidian", "path"]
};

import { builtinModules as rudoniumBuiltins } from "module";
import { readFileSync as rudoniumReadFile } from "fs";
const rudoniumManifest = JSON.parse(rudoniumReadFile(new URL("./manifest.json", import.meta.url), "utf8"));
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

export default rudoniumRollupConfig(rudoniumUpstreamConfig, bundleNotice(rudoniumManifest, "GPL-3.0-only"), rudoniumManifest.version, new Set(rudoniumBuiltins));
