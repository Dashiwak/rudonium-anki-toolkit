// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { load } = require('./benchmark/migration-modules.cjs')

test('Anki backup captures a live SQLite collection and verifies media in the restored ZIP', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rudonium-anki-backup-'))
    let db
    t.after(async () => {
        try { db?.close() }
        finally { await fs.rm(root, { recursive: true, force: true }) }
    })
    const media = path.join(root, 'Profile', 'collection.media')
    await fs.mkdir(media, { recursive: true })
    const attachment = Buffer.from([0, 1, 2, 255])
    await fs.writeFile(path.join(media, 'image.png'), attachment)
    db = new DatabaseSync(path.join(root, 'Profile', 'collection.anki2'))
    db.exec('PRAGMA journal_mode=WAL')
    for (const table of ['col', 'notes', 'cards', 'revlog']) db.exec('CREATE TABLE ' + table + ' (id INTEGER PRIMARY KEY)')
    db.exec('INSERT INTO notes VALUES (123)')
    const modules = await load(['anki', 'anki-backup', 'vault-backup-zip'], {
        getMediaPath: action => { assert.equal(action, 'getMediaDirPath'); return Promise.resolve(media) },
        withAnkiDeadline: run => run(),
        checkPinnedAnkiProfile: name => { assert.equal(name, 'Test'); return Promise.resolve(name) },
    }, { anki: "import { getMediaPath } from './test-connector'; export const invoke = getMediaPath" })

    const archive = path.join(root, 'Anki.zip')
    const result = await modules['anki-backup'].backupAnkiCollection(archive, undefined, 'Test')
    assert.equal(result.profile, 'Test')
    const restored = path.join(root, 'Restored')
    await modules['vault-backup-zip'].restoreVaultZip(archive, restored)
    assert.deepEqual(await fs.readFile(path.join(restored, 'collection.media', 'image.png')), attachment)
    const snapshot = new DatabaseSync(path.join(restored, 'collection.anki2'), { readOnly: true })
    try { assert.equal(snapshot.prepare('SELECT id FROM notes').get().id, 123) }
    finally { snapshot.close() }
})
