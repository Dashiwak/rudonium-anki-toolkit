// SPDX-License-Identifier: GPL-3.0-only
// The UI fixtures implement the same class operations used by browser DOMTokenList.
module.exports = function createClassList() {
    const names = new Set();
    return {
        add(...items) { for (const name of items) names.add(name); },
        remove(...items) { for (const name of items) names.delete(name); },
        contains(name) { return names.has(name); },
        toggle(name, force = !names.has(name)) {
            if (force) names.add(name);
            else names.delete(name);
            return force;
        },
    };
};
