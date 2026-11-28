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

async function deckBackupFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rudonium-deck-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const vault = path.join(root, 'vault')
    const collection = path.join(root, 'deck-contents')
    await fs.mkdir(vault)
    await fs.mkdir(collection)
    await fs.writeFile(path.join(vault, 'Card.md'), 'Question :: Answer')
    const database = new DatabaseSync(path.join(collection, 'collection.anki2'))
    try { database.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)') } finally { database.close() }
    await fs.writeFile(path.join(collection, 'media'), '{}')
    const media = path.join(root, 'User', 'collection.media')
    await fs.mkdir(media, { recursive: true })
    const directory = path.join(root, 'backups')
    const plugin = { app: { vault: { adapter: { getBasePath: () => vault } } },
        settings: { Defaults: { Deck: 'Default' }, VAULT_BACKUP: { enabled: true, includeAnki: false, directory } } }
    const state = { profile: 'User', decks: ['Default', 'Science::Space'], exports: [], profileChecks: 0 }
    const modules = await load(['anki', 'anki-backup', 'vault-backup', 'vault-backup-zip', 'anki-profile', 'interface-language'], {
        withFastScanReadLock: (_, action) => action(), withAnkiDeadline: action => action(),
        readArchiveSettings: () => ({ useForBackups: false }), Notice: class { hide() {} },
        connector: async (action, params) => {
            if (action === 'getActiveProfile') { state.profileChecks++; return state.profile }
            if (action === 'getMediaDirPath') return media
            if (action === 'deckNames') return state.decks
            assert.equal(action, 'exportPackage')
            state.exports.push(params)
            if (state.rejectExport) return false
            if (state.badPackage) await fs.writeFile(params.path, 'broken archive')
            else await modules['vault-backup-zip'].writeVaultZip(collection, params.path)
            if (state.switchAfterExport) state.profile = 'Other'
            return true
        },
    }, { anki: "import { connector } from './test-connector'; export const invoke = connector" })
    return { plugin, state, backups: modules['vault-backup'], collection, media, directory, settings: plugin.settings.VAULT_BACKUP }
}

test('deck packages are opt-in and a previous vault-only backup does not cover a newly chosen deck', async t => {
    const { plugin, state, backups, settings } = await deckBackupFixture(t)
    assert.equal(backups.readBackupSettings({}).includeDeck, false)
    const vaultOnly = await backups.createBackupNow(plugin)
    assert.deepEqual(await fs.readdir(vaultOnly), ['Obsidian.zip', 'backup.json'])
    assert.equal(state.profileChecks, 0)
    settings.includeDeck = true
    assert.equal((await backups.ensureScheduledBackup(plugin)).created, true)
    assert.equal(state.exports.length, 1)
    assert.equal(state.exports[0].deck, 'Default')
    assert.equal(state.exports[0].includeSched, true)
    assert.equal((await backups.ensureScheduledBackup(plugin)).created, false)
    settings.selectedDeck = { profile: 'User', name: 'Science::Space' }
    assert.equal((await backups.ensureScheduledBackup(plugin)).created, true)
    const saved = (await backups.listVaultBackups(plugin)).find(item => item.deckName === 'Science::Space')
    assert.ok(saved)
    const file = path.join(path.dirname(saved.path), 'Deck.apkg')
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'backup.json'), 'utf8'))
    assert.deepEqual(manifest.deck, { profile: 'User', name: 'Science::Space', bytes: (await fs.stat(file)).size })
    assert.equal(saved.includeAnki, false)
    assert.equal((await backups.ensureScheduledBackup(plugin)).created, false)
    await fs.unlink(file)
    assert.equal((await backups.ensureScheduledBackup(plugin)).created, true)
})

test('deck exports fail before publication for missing deck, damaged package, rejection or profile changes', async t => {
    const { plugin, state, backups, directory, settings } = await deckBackupFixture(t)
    Object.assign(settings, { includeDeck: true, selectedDeck: { profile: 'User', name: 'Science::Space' } })
    state.profile = 'Other'
    await assert.rejects(backups.createBackupNow(plugin), /belongs to Anki profile/)
    assert.equal(state.exports.length, 0)
    state.profile = 'User'
    state.decks = ['Default']
    await assert.rejects(backups.createBackupNow(plugin), /missing from the open Anki profile/)
    assert.equal(state.exports.length, 0)
    state.decks.push('Science::Space')
    state.rejectExport = true
    await assert.rejects(backups.createBackupNow(plugin), /could not export/)
    state.rejectExport = false
    state.badPackage = true
    await assert.rejects(backups.createBackupNow(plugin), /ZIP/)
    state.badPackage = false
    state.switchAfterExport = true
    await assert.rejects(backups.createBackupNow(plugin), /Expected Anki profile/)
    assert.deepEqual(await fs.readdir(directory), [])
})


test('deck-only backups reject a destination inside an Anki profile before any backup files are created', async t => {
    const { plugin, state, backups, directory, settings, media } = await deckBackupFixture(t)
    settings.includeDeck = true
    const alias = directory + '-alias'
    await fs.symlink(media, alias, 'junction')
    for (const folder of [path.dirname(media), media, path.join(alias, 'nested')]) {
        settings.directory = folder
        await assert.rejects(backups.createBackupNow(plugin), /outside the active Anki profile/)
        await assert.rejects(backups.ensureScheduledBackup(plugin), /outside the active Anki profile/)
    }
    assert.deepEqual(await fs.readdir(path.dirname(media)), ['collection.media'])
    assert.deepEqual(await fs.readdir(media), [])
    assert.equal(state.exports.length, 0)
})

test('deck backup validates legacy and modern Anki package headers and rejects ordinary ZIPs', async t => {
    const { plugin, backups, collection, directory, settings } = await deckBackupFixture(t)
    settings.includeDeck = true
    const original = await fs.readFile(path.join(collection, 'collection.anki2'))
    await fs.rename(path.join(collection, 'collection.anki2'), path.join(collection, 'other.txt'))
    await assert.rejects(backups.createBackupNow(plugin), /missing its collection or media index/)
    await fs.writeFile(path.join(collection, 'collection.anki2'), 'an ordinary text file')
    await assert.rejects(backups.createBackupNow(plugin), /invalid collection/)
    await fs.unlink(path.join(collection, 'collection.anki2'))
    await fs.rename(path.join(collection, 'other.txt'), path.join(collection, 'collection.anki21'))
    await fs.unlink(path.join(collection, 'media'))
    await assert.rejects(backups.createBackupNow(plugin), /missing its collection or media index/)
    assert.deepEqual(await fs.readdir(directory), [])
    await fs.writeFile(path.join(collection, 'media'), '{}')
    await backups.createBackupNow(plugin)
    const { zstdCompressSync } = require('node:zlib')
    await fs.unlink(path.join(collection, 'collection.anki21'))
    await fs.writeFile(path.join(collection, 'collection.anki21b'), zstdCompressSync(original))
    await fs.writeFile(path.join(collection, 'media'), zstdCompressSync(Buffer.alloc(0)))
    await backups.createBackupNow(plugin)
    assert.equal((await backups.listVaultBackups(plugin)).length, 2)
})
