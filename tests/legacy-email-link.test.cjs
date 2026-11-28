// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { load } = require("./benchmark/migration-modules.cjs");

test("numeric entities on an exported mailto link do not make the field look edited", async () => {
    const { "anki-field-value": { sameFieldValue } } = await load(["anki-field-value"], {});
    const oldLink = '<a href="&#109;ailto&#58;us&#101;r&#64;site.org">user&#x40;site&#x2e;org</a>';
    const current = '<a href="mailto:user@site.org">user@site.org</a>';
    assert.ok(sameFieldValue("Email " + oldLink, "Email " + current));
    assert.ok(!sameFieldValue(oldLink, current.replaceAll("user", "other")));
    assert.ok(!sameFieldValue(oldLink.replace("us&#101;r", "other"), current));
    assert.ok(!sameFieldValue(oldLink, current.replace("<a ", '<a title="A" ')));
    assert.ok(!sameFieldValue("&#x40;", "@"));
});
