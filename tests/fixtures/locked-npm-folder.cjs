// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// The fixture npm script records its working directory after producing main.js.
// Simulate a persistent Windows file lock there, including recursive parent removal.
if (["prepare-gitflic.cjs", "verify-rebuild.cjs"].includes(path.basename(process.argv[1] || ""))) {
    const rm = fs.rmSync;
    fs.rmSync = function (target, options) {
        const log = process.env.RUDONIUM_TEST_COMPILED;
        if (options?.recursive && log && fs.existsSync(log)) {
            for (const row of fs.readFileSync(log, "utf8").trimEnd().split("\n")) {
                const locked = path.join(JSON.parse(row), "node_modules");
                const dir = path.resolve(target);
                if (fs.existsSync(locked) && (locked === dir || locked.startsWith(dir + path.sep))) {
                    const message = "ENOTEMPTY: directory not empty: " + locked;
                    throw Object.assign(new Error(message), {code:"ENOTEMPTY", path:locked});
                }
            }
        }
        return rm.apply(this, arguments);
    };
}
