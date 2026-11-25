// SPDX-License-Identifier: GPL-3.0-only
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./benchmark/migration-modules.cjs");

test("card field preview sanitizes host HTML before filtering offline content, without changing the source field", async () => {
    const original = "<b>Bahnhof</b><br><img alt='Station' src='station.jpg'>";
    const removed = [];
    const changedText = [];
    function element(localName, properties = {}) {
        const attrs = new Map(Object.entries(properties));
        return {
            localName,
            get attributes() { return Array.from(attrs, ([name, value]) => ({ name, value })); },
            get alt() { return attrs.get("alt"); },
            remove() { removed.push(localName); },
            removeAttribute(name) { attrs.delete(name); },
            append(text) { changedText.push(text); },
            replaceWith(text) { changedText.push(text); },
        };
    }
    const bold = element("b", { class: "emphasis" });
    const image = element("img", { alt: "Station", src: "station.jpg" });
    const dataImage = element("img", { src: "data:image/png;base64,iVBORw==" });
    const link = element("a", { href: "https://example.invalid/", title: "City" });
    const br = element("br");
    const all = [bold, image, dataImage, link, br, element("input")];
    let sanitized = 0;
    // This fragment stands in for the host sanitizer. The additional allowlist belongs to Rudonium.
    const fragment = {
        querySelectorAll(selector) {
            if (selector === "*") return all;
            if (selector === "img") return [image, dataImage];
            return selector === "br" ? [br] : [];
        },
        get textContent() { return "Bahnhof" + changedText.join(""); },
    };
    const previewWindow = {
        createEl(tag) {
            assert.equal(tag, "template");
            let appended;
            return { content: {
                append(result) { appended = result; },
                querySelectorAll(selector) { return appended.querySelectorAll(selector); },
                get textContent() { return appended.textContent; },
            } };
        },
    };
    const api = await load(["card-preview-ui"], {
        Modal: class {},
        sanitizeHTMLToDom(html) {
            assert.equal(html, original);
            sanitized++;
            return fragment;
        },
    }, {}, previewWindow);
    let adopted = false;
    const owner = { adoptNode(template) { adopted = true; return template; } };
    const { previewFieldText } = api["card-preview-ui"];
    assert.equal(previewFieldText(owner, original, "[Image]"), "Bahnhof\nStation[Image]");
    assert.equal(adopted, true);
    assert.equal(sanitized, 1);
    assert.deepEqual(removed, ["input"]);
    assert.deepEqual(bold.attributes, [{ name: "class", value: "emphasis" }]);
    assert.deepEqual(image.attributes, [{ name: "alt", value: "Station" }]);
    assert.equal(dataImage.attributes[0].value, "data:image/png;base64,iVBORw==");
    assert.deepEqual(link.attributes, [{ name: "title", value: "City" }]);
    assert.equal(previewFieldText(undefined, original, "[Image]"), original);
    assert.equal(adopted, true);
    assert.equal(sanitized, 1);
});
