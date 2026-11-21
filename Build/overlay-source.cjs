// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// In the expanded repository src/ also contains upstream modules. Its index
// identifies exactly which files belong to the fork.
const index = path.join(__dirname, "overlay-files.json");
const expanded = fs.existsSync(index);
const directory = path.resolve(__dirname, "../src");
const file = name => path.join(directory, name);
function names() {
    if (expanded) {
        const entries = JSON.parse(fs.readFileSync(index, "utf8"));
        if (!Array.isArray(entries) || !entries.length || !entries.every(name =>
            typeof name === "string" && /^[a-zA-Z0-9_-]+\.ts$/u.test(name))) throw new Error("Invalid overlay file index.");
        return entries;
    }
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
        .map(entry => entry.name).sort();
}
module.exports = { directory, file, names };
