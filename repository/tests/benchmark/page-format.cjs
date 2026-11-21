// SPDX-License-Identifier: GPL-3.0-only
// node --experimental-vm-modules tests/benchmark/page-format.cjs [files per layout, default 20000]
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { load } = require('./migration-modules.cjs')

async function fixtures(root, size, layout) {
    const directory = path.join(root, layout)
    await fs.mkdir(directory)
    const files = []
    for (let start = 0; start < size; start += 32) {
        await Promise.all(Array.from({ length: Math.min(32, size - start) }, async (_, offset) => {
            const i = start + offset, eol = i % 4 < 2 ? '\n' : '\r\n', id = 1700000000000 + i
            const front = 'Question ' + i, back = 'Answer ' + i + '\nFollow-up ' + i
            const rows = ['---', 'tags: [study]', 'topic: ' + (i % 11)]
            if (layout === 'yaml') rows.push("anki-page-ID: '" + id + "'")
            rows.push('---', '# ' + front + ' #anki-page')
            if (layout === 'heading') rows.push('<!--ID: ' + id + '-->')
            rows.push('', ...back.split('\n'))
            if (i % 2) rows.push('', '<!--rudonium-answer-end-->', 'Private notes ' + i, 'ID: ' + (id + size))
            const text = rows.join(eol) + eol, name = i + '.md'
            await fs.writeFile(path.join(directory, name), text)
            files[i] = { path: name, stat: { ctime: 0, mtime: 0, size: Buffer.byteLength(text) }, id, front, back }
        }))
    }
    return { files, plugin: { app: { vault: { read: file => fs.readFile(path.join(directory, file.path), 'utf8') } } } }
}

async function main() {
    const size = Number(process.argv[2] ?? 20000)
    assert.ok(Number.isSafeInteger(size) && size >= 2 && size <= 100000)
    const modules = await load(['page-card', 'vault-id-index', 'duplicate-markers', 'card-format-presets', 'export-recovery'], {})
    const { readPageCard } = modules['page-card'], { indexVaultIds } = modules['vault-id-index']
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rudonium-pages-'))
    try {
        const data = {}, results = { heading: [], yaml: [] }
        for (const layout of Object.keys(results)) data[layout] = await fixtures(root, size, layout)
        const rules = { Basic: '@page' }, revision = () => 0
        for (let run = 0; run < 4; run++) {
            for (const layout of run % 2 ? ['yaml', 'heading'] : ['heading', 'yaml']) {
                const { plugin, files } = data[layout]
                const start = performance.now()
                const found = await indexVaultIds(plugin, files, {}, revision, { force: true,
                    onFile(file, _path, markers, text) {
                        const page = readPageCard(text, rules)
                        assert.equal(markers.length, 1)
                        assert.equal(markers[0].id, file.id)
                        assert.equal(page.id, file.id)
                        assert.equal(page.idLocation, layout)
                        assert.equal(page.front, file.front)
                        assert.equal(page.back, file.back)
                    } })
                const elapsed = performance.now() - start
                assert.deepEqual([...found.errors].slice(0, 1), [])
                assert.ok(found.complete && found.reads === size && found.first.size === size && !found.duplicates.size)
                for (const file of files) assert.equal(found.first.get(file.id)?.path, file.path)
                if (run) results[layout].push(Math.round(elapsed))
            }
        }
        for (const [layout, runsMs] of Object.entries(results)) {
            console.log(JSON.stringify({ node: process.version, layout, files: size, withPrivateNotes: Math.floor(size / 2),
                scope: 'filesystem read + vault ID index + page parser + field assertions', runsMs, medianMs: [...runsMs].sort((a,b) => a-b)[1] }))
        }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
