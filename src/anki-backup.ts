/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { files as fs, paths as path, fileErrorCode } from './desktop-io'
import type { DesktopFiles as NodeFiles, DesktopPaths as NodePath, FileStat } from './desktop-io'
import * as AnkiConnect from './anki'
import { withAnkiDeadline } from './anki-transport'
import { checkPinnedAnkiProfile, readActiveAnkiProfile } from './anki-profile'
import { verifyVaultZip, writeVaultZip } from './vault-backup-zip'
import type { VaultZipProgressCallback } from './vault-backup-zip'

interface BackupDatabase {
    close(): void
    prepare(sql: string): { get(): Record<string, unknown> | undefined; all(): Record<string, unknown>[] }
}

interface OnlineSqlite {
    DatabaseSync: new (filename: string, options: { readOnly: boolean; timeout?: number }) => BackupDatabase
    backup(db: BackupDatabase, destination: string, options: {
        rate: number
        progress: (value: { totalPages: number; remainingPages: number }) => void
    }): Promise<number>
}

interface MediaFile {
    relative: string
    stat: FileStat
}

const mediaDirectory = 'collection.media'
const collectionFilename = 'collection.anki2'
const connectorTimeoutMs = 15_000

function hasBuiltinLoader(value: unknown): value is { getBuiltinModule(name: string): unknown } {
    return typeof value === 'object' && value !== null && 'getBuiltinModule' in value &&
        typeof value.getBuiltinModule === 'function'
}

function sqliteBackupApi(): OnlineSqlite {
    const runtime: unknown = typeof process === 'undefined' ? undefined : process
    const module = hasBuiltinLoader(runtime) ? runtime.getBuiltinModule('node:sqlite') : undefined
    if (module && typeof module === 'object' && 'DatabaseSync' in module && typeof module.DatabaseSync === 'function' &&
        'backup' in module && typeof module.backup === 'function') return module as OnlineSqlite
    throw new Error('Anki backup requires desktop Obsidian with the Node SQLite online backup API (Node 22.16 or later).')
}

async function readConnector(action: 'getMediaDirPath'): Promise<unknown> {
    return withAnkiDeadline(() => AnkiConnect.invoke(action), 'AnkiConnect ' + action, connectorTimeoutMs)
}

export async function activeAnkiBackupProfile(): Promise<string> {
    return readActiveAnkiProfile()
}

async function profileMediaPath(fs: NodeFiles, path: NodePath): Promise<string> {
    const value = await readConnector('getMediaDirPath')
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.basename(value).toLowerCase() !== mediaDirectory) {
        throw new Error('AnkiConnect did not return a local collection.media folder. Run Anki on this computer.')
    }
    const stat = await fs.promises.lstat(value)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Anki backup needs a real collection.media folder on this computer.')
    }
    return fs.promises.realpath(value)
}

export async function ankiProfileDirectory(profile: string): Promise<string> {
    const media = await profileMediaPath(fs, path)
    await checkPinnedAnkiProfile(profile)
    return path.dirname(media)
}

async function mediaFiles(fs: NodeFiles, path: NodePath, root: string): Promise<Map<string, MediaFile>> {
    const files = new Map<string, MediaFile>()
    const pending = ['']
    while (pending.length) {
        const relativeDir = pending.pop()!
        const children = await fs.promises.readdir(path.join(root, relativeDir), { withFileTypes: true })
        for (const child of children) {
            const relative = path.join(relativeDir, child.name)
            if (child.isDirectory()) {
                pending.push(relative)
            } else if (child.isFile()) {
                const stat = await fs.promises.lstat(path.join(root, relative))
                if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Anki media changed during the backup: ${relative}`)
                files.set(relative, { relative, stat })
            } else {
                throw new Error(`Anki media contains an unsupported filesystem entry: ${relative}`)
            }
        }
    }
    return files
}

function sameFile(before: FileStat, after: FileStat): boolean {
    return after.isFile() && !after.isSymbolicLink() &&
        before.size === after.size && before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs && before.ino === after.ino && before.dev === after.dev
}

function inside(path: NodePath, candidate: string, directory: string): boolean {
    const relative = path.relative(directory, candidate)
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function dataVersion(db: BackupDatabase): number {
    const value = db.prepare('PRAGMA data_version').get()?.data_version
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error('Could not confirm the Anki database version.')
    }
    return value
}

function verifyCollection(sqlite: OnlineSqlite, path: string): 'sqlite-quick-check' | 'sqlite-core-tables' {
    const copied = new sqlite.DatabaseSync(path, { readOnly: true })
    try {
        const tables = ['col', 'notes', 'cards', 'revlog']
        const found = copied.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('col','notes','cards','revlog')").all()
        if (found.length !== tables.length) throw new Error('The database snapshot is missing Anki collection tables.')
        const verify = (query: string) => {
            const result = copied.prepare(query).all()
            if (result.length !== 1 || result[0].quick_check !== 'ok') {
                throw new Error('The Anki database snapshot did not pass its SQLite consistency check.')
            }
        }
        try {
            verify('PRAGMA quick_check')
            return 'sqlite-quick-check'
        } catch (error) {
            if (!(error instanceof Error) || !/^no such collation sequence: unicase$/i.test(error.message)) throw error
            for (const table of tables) verify(`PRAGMA quick_check('${table}')`)
            return 'sqlite-core-tables'
        }
    } finally {
        copied.close()
    }
}

/** The caller owns the private staging folder and removes it on failure. */
export async function backupAnkiDeck(outputArchive: string, deck: string, profile: string,
    onProgress?: VaultZipProgressCallback): Promise<number> {
    const names = await withAnkiDeadline(() => AnkiConnect.invoke('deckNames'), 'AnkiConnect deckNames', connectorTimeoutMs)
    if (!Array.isArray(names) || !names.includes(deck)) throw new Error(`The backup deck “${deck}” is missing from the open Anki profile.`)
    await checkPinnedAnkiProfile(profile)
    // Wait for Anki to close the package before verifying it or removing the staging folder.
    const exported = await AnkiConnect.invoke('exportPackage', { deck, path: outputArchive, includeSched: true })
    if (exported !== true) throw new Error(`Anki could not export the backup deck “${deck}”.`)
    await checkPinnedAnkiProfile(profile)
    const info = await fs.promises.lstat(outputArchive).catch((error: unknown) => {
        if (fileErrorCode(error) !== 'ENOENT') throw error
        return undefined
    })
    if (!info?.isFile() || info.size <= 0) throw new Error('The exported Anki deck package is empty or missing.')
    const sqliteMagic = new TextEncoder().encode('SQLite format 3\0')
    const zstdMagic = [0x28, 0xb5, 0x2f, 0xfd]
    let hasCollection = false
    let hasMedia = false
    await verifyVaultZip(outputArchive, onProgress, {
        inspectFile(name, size, header) {
            if (name === 'media') hasMedia = size > 0
            if (name !== 'collection.anki2' && name !== 'collection.anki21' && name !== 'collection.anki21b') return
            const magic = name === 'collection.anki21b' ? zstdMagic : sqliteMagic
            if (size <= magic.length || !magic.every((byte, index) => header[index] === byte)) {
                throw new Error('The Anki deck package has an invalid collection.')
            }
            hasCollection = true
        },
    })
    if (!hasCollection || !hasMedia) throw new Error('The Anki deck package is missing its collection or media index.')
    return info.size
}

export async function backupAnkiCollection(outputArchive: string, onProgress?: VaultZipProgressCallback,
    expectedProfile?: string): Promise<{ profile: string; files: number; bytes: number }> {
    const sqlite = sqliteBackupApi()
    const profile = expectedProfile === undefined ? await activeAnkiBackupProfile() : await checkPinnedAnkiProfile(expectedProfile)
    const sourceMedia = await profileMediaPath(fs, path)
    await checkPinnedAnkiProfile(profile)
    const sourceRoot = path.dirname(sourceMedia)
    const sourceDb = path.join(sourceRoot, collectionFilename)
    const sourceStat = await fs.promises.lstat(sourceDb)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error('Could not find a regular collection.anki2 beside the Anki media folder.')
    }
    if (!path.isAbsolute(outputArchive)) throw new Error('Choose an absolute path for the Anki backup.')
    const outputDirectory = await fs.promises.realpath(path.dirname(outputArchive))
    if (inside(path, outputDirectory, sourceRoot)) throw new Error('Choose a backup location outside the active Anki profile.')
    const output = path.join(outputDirectory, path.basename(outputArchive))
    const staging = await fs.promises.mkdtemp(path.join(outputDirectory, '.anki-backup-'))
    let created = false
    let verification: ReturnType<typeof verifyCollection>
    try {
        const stagedDb = path.join(staging, collectionFilename)
        const stagedMedia = path.join(staging, mediaDirectory)
        await fs.promises.mkdir(stagedMedia)
        onProgress?.({ phase: 'enumerate', files: 0, totalFiles: 0, bytes: 0, totalBytes: 0, path: mediaDirectory })
        const db = new sqlite.DatabaseSync(sourceDb, { readOnly: true, timeout: 5000 })
        try {
            const version = dataVersion(db)
            const media = await mediaFiles(fs, path, sourceMedia)
            const totalFiles = 1 + media.size
            const totalMediaBytes = [...media.values()].reduce((sum, file) => sum + file.stat.size, 0)
            const pageSize = db.prepare('PRAGMA page_size').get()?.page_size
            const exactPageSize = typeof pageSize === 'number' && pageSize > 0 ? pageSize : 0
            onProgress?.({ phase: 'write', files: 0, totalFiles, bytes: 0,
                totalBytes: sourceStat.size + totalMediaBytes, path: collectionFilename })
            await sqlite.backup(db, stagedDb, {
                rate: 256,
                progress: ({ totalPages, remainingPages }) => {
                    onProgress?.({ phase: 'write', files: 0, totalFiles,
                        bytes: (totalPages - remainingPages) * exactPageSize,
                        totalBytes: totalPages * exactPageSize + totalMediaBytes, path: collectionFilename })
                },
            })
            const totalBytes = (await fs.promises.stat(stagedDb)).size + totalMediaBytes
            let bytes = totalBytes - totalMediaBytes
            let files = 1
            onProgress?.({ phase: 'verify', files, totalFiles, bytes, totalBytes, path: collectionFilename })
            verification = verifyCollection(sqlite, stagedDb)
            for (const ending of ['-wal', '-shm', '-journal']) {
                const sidecar = await fs.promises.stat(stagedDb + ending).catch((error: unknown) => {
                    if (fileErrorCode(error) !== 'ENOENT') throw error
                    return undefined
                })
                if (sidecar?.size && ending !== '-shm') {
                    throw new Error('Anki backup could not confirm a standalone SQLite snapshot.')
                }
                await fs.promises.rm(stagedDb + ending, { force: true })
            }
            for (const { relative, stat } of media.values()) {
                const source = path.join(sourceMedia, relative)
                const destination = path.join(stagedMedia, relative)
                onProgress?.({ phase: 'write', files, totalFiles, bytes, totalBytes, path: path.join(mediaDirectory, relative) })
                await fs.promises.mkdir(path.dirname(destination), { recursive: true })
                await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
                if (!sameFile(stat, await fs.promises.lstat(source)) || (await fs.promises.stat(destination)).size !== stat.size) {
                    throw new Error(`Anki media changed during the backup: ${relative}`)
                }
                bytes += stat.size
                files++
            }
            const latest = await mediaFiles(fs, path, sourceMedia)
            if (latest.size !== media.size || [...media].some(([name, file]) => {
                const current = latest.get(name)
                return !current || !sameFile(file.stat, current.stat)
            })) throw new Error('Anki media changed during the backup. Retry after the changes finish.')
            if (dataVersion(db) !== version) throw new Error('The Anki collection changed during the backup. Retry after the changes finish.')
            const latestDb = await fs.promises.lstat(sourceDb)
            if (!latestDb.isFile() || latestDb.ino !== sourceStat.ino || latestDb.dev !== sourceStat.dev) {
                throw new Error('The Anki database file was replaced during the backup. Open the original profile and retry.')
            }
        } finally {
            db.close()
        }
        await checkPinnedAnkiProfile(profile)
        if (await profileMediaPath(fs, path) !== sourceMedia) {
            throw new Error('The active Anki profile changed during the backup.')
        }
        await fs.promises.writeFile(path.join(staging, 'anki-backup-info.json'), JSON.stringify({
            format: 'export-to-anki-profile-backup', version: 1, profile, createdAt: new Date().toISOString(), verification,
        }, null, 2) + '\n', { flag: 'wx' })
        await writeVaultZip(staging, output, onProgress)
        created = true
        const result = await verifyVaultZip(output, onProgress)
        await checkPinnedAnkiProfile(profile)
        await fs.promises.rm(staging, { recursive: true, force: true })
        return { profile, ...result }
    } catch (error) {
        if (created) await fs.promises.rm(output, { force: true }).catch(() => {})
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
        throw error
    }
}
