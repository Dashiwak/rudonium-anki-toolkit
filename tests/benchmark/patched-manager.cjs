// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { stripTypeScriptTypes } = require('node:module')
const vm = require('node:vm')

// Exercise the methods installed in FileManager, including its real write dispatcher.
// The caller supplies AnkiConnect and the desktop host for the scenario.
function managerType(api) {
    const source = readFileSync(join(__dirname, '../../Build/patch-manager.cjs'), 'utf8')
    const extract = (start, end) => {
        const at = source.indexOf(start)
        assert.ok(at >= 0)
        const cut = source.indexOf(end, at + start.length)
        assert.ok(cut > at)
        return vm.runInNewContext(source.slice(at + start.length, cut))
    }
    const fields = extract('source = source.slice(0, firstMember) + ', ' + source.slice(firstMember)')
    const methods = extract('source = source.slice(0, generate.getStart(latest)) + ', ' + source.slice(initialise.end)')
    const requests = extract('editBody("requests_1", () => ', ');\n\n    const oldMethods =')
    const src = 'class Manager {\n' + fields + methods + '\nasync requests_1() {' + requests + '\n}}'
    return new Function(...Object.keys(api), stripTypeScriptTypes(src, { mode: 'transform' }) + ';return Manager')(...Object.values(api))
}

module.exports = { managerType }
