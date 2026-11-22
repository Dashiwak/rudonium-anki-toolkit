// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const fs = require("node:fs");

// Change only the type hints returned by directory listing. The actual files, lstat and reads are real.
function overrideDirectoryHints(t, describe) {
    const readdir = fs.readdirSync;
    t.mock.method(fs, "readdirSync", (dir, options) => {
        const entries = readdir(dir, options);
        if (!options?.withFileTypes) return entries;
        return entries.map(entry => {
            const type = describe(dir, entry.name);
            if (!type) return entry;
            return {name: entry.name, isDirectory: () => type === "directory",
                isFile: () => type === "file", isSymbolicLink: () => false};
        });
    });
}

module.exports = {overrideDirectoryHints};
