// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { load } = require('./benchmark/migration-modules.cjs')

test('multi-chunk ZIP write, restore, cancellation and retry for stored and compressed entries', async t => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'rudonium-zip-streams-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const vault = path.join(root, 'Vault'), archive = path.join(root, 'Vault.zip')
    const target = path.join(root, 'Restored')
    const markdown = 'Обсидиан и Anki\n'.repeat(40_000)
    const binary = Buffer.alloc(512 * 1024, 0xfd)
    await fs.mkdir(vault)
    await fs.writeFile(path.join(vault, 'Cards.md'), markdown)
    await fs.writeFile(path.join(vault, 'picture.png'), binary)
    let clock = 0
    class Clock extends Date { static now() { return clock += 250 } }
    const { 'vault-backup-zip': zip } = await load(['vault-backup-zip'], {}, {}, { Date: Clock })
    const { files, bytes } = await zip.writeVaultZip(vault, archive)
    assert.equal(files, 2)
    assert.equal(bytes, Buffer.byteLength(markdown) + binary.length)
    assert.ok((await fs.stat(archive)).size < bytes)
    for (const name of ['Cards.md', 'picture.png']) {
        const cancel = new AbortController()
        await assert.rejects(zip.restoreVaultZip(archive, target, progress => {
            if (progress.path === name && progress.phase === 'restore' && progress.bytes) cancel.abort()
        }, { signal: cancel.signal }), { name: 'AbortError' })
        await assert.rejects(fs.stat(target), { code: 'ENOENT' })
    }
    assert.equal((await zip.verifyVaultZip(archive)).files, 2)
    await zip.restoreVaultZip(archive, target)
    assert.equal(await fs.readFile(path.join(target, 'Cards.md'), 'utf8'), markdown)
    assert.deepEqual(await fs.readFile(path.join(target, 'picture.png')), binary)
})
