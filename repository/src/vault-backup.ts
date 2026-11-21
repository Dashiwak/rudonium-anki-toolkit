/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Notice } from 'obsidian'
import type { FileSystemAdapter } from 'obsidian'
import type MyPlugin from '../main'
import { activeAnkiBackupProfile, backupAnkiCollection } from './anki-backup'
import { AnkiProfileError, checkPinnedAnkiProfile, requireExpectedAnkiProfile } from './anki-profile'
import { restoreVaultZip, verifyVaultZip, writeVaultZip } from './vault-backup-zip'
import type { VaultZipProgress } from './vault-backup-zip'
import { withFastScanReadLock } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { archiveFolderIncluded, archiveScopeSignature, readArchiveSettings } from './archive-settings'

interface BackupScope {
    kind: 'selected'
    signature: string
    includeFolders: string[]
    excludeFolders: string[]
    includeAttachments: boolean
}

export interface BackupSettings {
    enabled: boolean
    intervalDays: number
    directory: string
    includeAnki: boolean
}

export interface BackupCheck {
    created: boolean
    profile?: string
}

interface BackupManifest {
    version: 1
    completedAt: number
    vaultRoot: string
    profile?: string
    vaultBytes: number
    ankiBytes?: number
    scope?: BackupScope
}

interface SavedBackup {
    path: string
    name: string
    manifest: BackupManifest
}

/** Метаданные общей копии: сам Obsidian.zip подходит и для восстановления, и для переноса. */
export interface SavedVaultBackup {
    path: string
    name: string
    scope: 'full' | 'selected'
    completedAt: number
    vaultRoot: string
    bytes: number
    includeAnki: boolean
    selection?: {
        includeFolders: string[]
        excludeFolders: string[]
        includeAttachments: boolean
    }
}

const backupPrefix = 'Obsidian-Backup-'
const dayMs = 24 * 60 * 60 * 1_000
const maxManifestBytes = 16 * 1024 * 1024

function selectedBackupScope(plugin: MyPlugin): BackupScope | undefined {
    const settings = readArchiveSettings(plugin.settings.ARCHIVE_TRANSFER)
    return settings.useForBackups ? {
        kind: 'selected', signature: archiveScopeSignature(settings),
        includeFolders: [...settings.includeFolders], excludeFolders: [...settings.excludeFolders],
        includeAttachments: settings.includeAttachments,
    } : undefined
}

/** Папки-предки нужны для прохода к выбранному корню; исключения действуют на всё поддерево. */
function includedInBackup(scope: BackupScope, relative: string, directory: boolean): boolean {
    const candidate = relative.normalize('NFC')
    if (candidate.split('/').some(part => part.startsWith('.') || part === '__MACOSX') ||
        scope.excludeFolders.some(path => candidate === path || candidate.startsWith(`${path}/`))) return false
    if (directory) return archiveFolderIncluded(candidate, scope) || scope.includeFolders.some(path => path.startsWith(`${candidate}/`))
    return archiveFolderIncluded(candidate, scope) && (scope.includeAttachments || /\.md$/iu.test(candidate))
}

function checkedBackupScope(raw: unknown): BackupScope | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const value = raw as Partial<BackupScope>
    if (value.kind !== 'selected' || typeof value.signature !== 'string' ||
        typeof value.includeAttachments !== 'boolean' || !Array.isArray(value.includeFolders) ||
        !Array.isArray(value.excludeFolders) || value.includeFolders.some(path => typeof path !== 'string') ||
        value.excludeFolders.some(path => typeof path !== 'string')) return undefined
    const settings = readArchiveSettings(value)
    if (archiveScopeSignature(settings) !== value.signature ||
        JSON.stringify(settings.includeFolders) !== JSON.stringify(value.includeFolders) ||
        JSON.stringify(settings.excludeFolders) !== JSON.stringify(value.excludeFolders)) return undefined
    return value as BackupScope
}

function sameBackupScope(left: BackupScope | undefined, right: BackupScope | undefined): boolean {
    return left?.signature === right?.signature && left?.kind === right?.kind
}

export function readBackupSettings(raw: unknown): BackupSettings {
    const value = raw && typeof raw === 'object' ? raw as Partial<BackupSettings> : {}
    const days = value.intervalDays
    return {
        enabled: value.enabled === true,
        intervalDays: typeof days === 'number' && Number.isSafeInteger(days) && days >= 1 && days <= 365 ? days : 7,
        directory: typeof value.directory === 'string' ? value.directory.trim() : '',
        includeAnki: value.includeAnki !== false,
    }
}

function desktop(plugin: MyPlugin) {
    const adapter = plugin.app.vault.adapter as Partial<FileSystemAdapter>
    if (typeof require !== 'function' || typeof adapter.getBasePath !== 'function') {
        throw new Error('Vault Backup requires desktop Obsidian and a local vault.')
    }
    const fs = (require('fs') as typeof import('fs')).promises
    const path: typeof import('path') = require('path')
    return { fs, path, base: adapter.getBasePath() }
}

function isIn(path: typeof import('path'), root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate)
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function missing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as {code: unknown}).code === 'ENOENT'
}

async function destination(plugin: MyPlugin, settings: BackupSettings, create: boolean) {
    const { fs, path, base } = desktop(plugin)
    const root = await fs.realpath(base)
    const configured = settings.directory || path.join(path.dirname(root), 'Obsidian Anki Backups', path.basename(root))
    if (!path.isAbsolute(configured)) throw new Error('Set the backup folder to an absolute path outside the vault.')
    const folder = path.resolve(configured)
    if (isIn(path, root, folder)) throw new Error('Choose a backup folder outside the vault.')
    // Перед mkdir проверяем ближайшего существующего предка. Точка подключения может вести обратно в хранилище.
    for (let probe = folder;; probe = path.dirname(probe)) {
        try {
            const parent = await fs.realpath(probe)
            if (isIn(path, root, path.resolve(parent, path.relative(probe, folder)))) {
                throw new Error('The backup folder resolves inside the vault.')
            }
            break
        } catch (error) {
            if (!missing(error) || path.dirname(probe) === probe) throw error
        }
    }
    if (create) await fs.mkdir(folder, { recursive: true })
    const actual = await fs.realpath(folder).catch(error => {
        if (!create && missing(error)) return folder
        throw error
    })
    if (isIn(path, root, actual)) throw new Error('The backup folder resolves inside the vault.')
    return { fs, path, root, directory: actual }
}

function displayProgress(title: string, t: UiText) {
    const notice = new Notice(title, 0)
    let previous = 0
    let stage = ''
    const phases: Record<VaultZipProgress['phase'], string> = {
        enumerate: t('enumerate', 'собираем список файлов'),
        write: t('write', 'записываем архив'),
        verify: t('verify', 'проверяем архив'),
        restore: t('restore', 'восстанавливаем файлы'),
    }
    return {
        update(label: string, progress?: VaultZipProgress) {
            const phase = progress ? `${label} · ${phases[progress.phase]}` : label
            const now = performance.now()
            const complete = progress && progress.totalFiles > 0 && progress.files >= progress.totalFiles
            if (!complete && phase === stage && now - previous < 120) return
            previous = now
            stage = phase
            let detail = ''
            if (progress?.totalFiles) {
                const ratio = progress.totalBytes ? progress.bytes / progress.totalBytes : progress.files / progress.totalFiles
                detail = ` · ${progress.files}/${progress.totalFiles} ${t('files', 'файлов')} · ${Math.min(100, Math.floor(100 * ratio))}%`
            }
            const found = progress?.phase === 'enumerate' && !progress.totalFiles
                ? t(` · ${progress.files} files found`, ` · найдено файлов: ${progress.files}`) : ''
            notice.setMessage?.(`${title}\n${phase}${detail}${found}`)
        },
        close() { notice.hide() },
    }
}

function checkedManifest(raw: unknown): BackupManifest | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const value = raw as Partial<BackupManifest>
    if (value.version !== 1 || typeof value.vaultRoot !== 'string' || !value.vaultRoot ||
        typeof value.completedAt !== 'number' || !Number.isSafeInteger(value.completedAt) || value.completedAt <= 0 ||
        typeof value.vaultBytes !== 'number' || !Number.isSafeInteger(value.vaultBytes) || value.vaultBytes <= 0 ||
        (value.profile !== undefined && (typeof value.profile !== 'string' || !value.profile.trim() ||
            typeof value.ankiBytes !== 'number' || !Number.isSafeInteger(value.ankiBytes) || value.ankiBytes <= 0)) ||
        value.scope !== undefined && !checkedBackupScope(value.scope)) return undefined
    return value as BackupManifest
}

/** Читается только ограниченный обычный файл, а не произвольная ссылка или растущий поток. */
async function readManifest(fs: typeof import('fs').promises, file: string): Promise<BackupManifest> {
    const initial = await fs.lstat(file)
    if (!initial.isFile() || initial.size <= 0 || initial.size > maxManifestBytes) {
        throw new Error('The backup metadata must be a regular file no larger than 16 MiB.')
    }
    const handle = await fs.open(file, 'r')
    try {
        const info = await handle.stat()
        if (!info.isFile() || info.dev !== initial.dev || info.ino !== initial.ino ||
            info.size !== initial.size || info.mtimeMs !== initial.mtimeMs || info.ctimeMs !== initial.ctimeMs) {
            throw new Error('The backup metadata changed while opening it.')
        }
        const bytes = Buffer.alloc(info.size + 1)
        let length = 0
        while (length < bytes.length) {
            const result = await handle.read(bytes, length, bytes.length - length, null)
            if (!result.bytesRead) break
            length += result.bytesRead
        }
        const current = await handle.stat()
        if (length !== info.size || current.size !== info.size || current.mtimeMs !== info.mtimeMs ||
            current.ctimeMs !== info.ctimeMs) throw new Error('The backup metadata changed while reading it.')
        const manifest = checkedManifest(JSON.parse(bytes.subarray(0, length).toString('utf8')))
        if (!manifest) throw new Error('The backup metadata is invalid.')
        return manifest
    } finally {
        await handle.close()
    }
}

function savedBackupMetadata(archive: string, name: string, manifest: BackupManifest, t: UiText): SavedVaultBackup {
    return {
        path: archive,
        name: `${manifest.scope ? t('Selected folders', 'Выбранные папки') : t('Full vault', 'Полное хранилище')} · ${name}`,
        scope: manifest.scope ? 'selected' : 'full', completedAt: manifest.completedAt,
        vaultRoot: manifest.vaultRoot, bytes: manifest.vaultBytes, includeAnki: Boolean(manifest.profile),
        ...(manifest.scope ? { selection: {
            includeFolders: [...manifest.scope.includeFolders], excludeFolders: [...manifest.scope.excludeFolders],
            includeAttachments: manifest.scope.includeAttachments,
        } } : {}),
    }
}

/** Соседний манифест необязателен для внешнего ZIP. Он не заменяет проверку CRC при импорте. */
export async function inspectVaultBackupSource(plugin: MyPlugin, archive: string): Promise<SavedVaultBackup | undefined> {
    const { fs, path } = desktop(plugin)
    const t = uiFor(plugin.settings)
    if (!path.isAbsolute(archive) || !/\.zip$/iu.test(archive)) throw new Error(t(
        'Enter the absolute path of an Obsidian ZIP backup.', 'Укажите полный путь к резервной копии Obsidian в формате ZIP.'))
    if (path.basename(archive).toLowerCase() !== 'obsidian.zip') return undefined
    const folder = path.dirname(archive)
    const metadata = path.join(folder, 'backup.json')
    try {
        await fs.lstat(metadata)
    } catch (error) {
        if (missing(error)) return undefined
        throw error
    }
    try {
        const manifest = await readManifest(fs, metadata)
        const info = await fs.lstat(archive)
        if (!info.isFile() || info.size !== manifest.vaultBytes) throw new Error('The backup ZIP no longer matches its metadata.')
        return savedBackupMetadata(archive, `${new Date(manifest.completedAt).toLocaleString()} · ${path.basename(folder)}`, manifest, t)
    } catch {
        throw new Error(t('The backup metadata is invalid or no longer matches Obsidian.zip. Choose a verified backup or a standalone ZIP without a sidecar.',
            'Метаданные резервной копии повреждены или больше не соответствуют Obsidian.zip. Выберите проверенную копию или отдельный ZIP без сопутствующего манифеста.'))
    }
}

async function* matchingBackups(loc: Awaited<ReturnType<typeof destination>>,
    matches: (manifest: BackupManifest) => boolean): AsyncGenerator<SavedBackup> {
    const { fs, path, directory } = loc
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
        if (missing(error)) return []
        throw error
    })
    // Имена снимков начинаются с времени UTC. Для экспорта по расписанию сперва проверяем самые свежие копии.
    entries.sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(backupPrefix)) continue
        const folder = path.join(directory, entry.name)
        try {
            const manifest = await readManifest(fs, path.join(folder, 'backup.json'))
            if (!manifest || !matches(manifest)) continue
            const archive = path.join(folder, 'Obsidian.zip')
            const info = await fs.lstat(archive)
            if (!info.isFile() || info.size !== manifest.vaultBytes) continue
            if (manifest.profile) {
                const anki = await fs.lstat(path.join(folder, 'Anki.zip'))
                if (!anki.isFile() || anki.size !== manifest.ankiBytes) continue
            }
            yield { path: archive, name: `${new Date(manifest.completedAt).toLocaleString()} · ${entry.name}`, manifest }
        } catch {
            // Незавершённая или повреждённая копия не должна откладывать создание следующей.
        }
    }
}

async function createSnapshot(loc: Awaited<ReturnType<typeof destination>>, profile: string | undefined, t: UiText,
    scope?: BackupScope): Promise<string> {
    const { fs, path, root, directory } = loc
    const status = displayProgress(scope ? t('Backing up selected Obsidian folders', 'Создаём копию выбранных папок Obsidian')
        : t('Creating a full vault backup', 'Создаём полную копию хранилища'), t)
    let stage: string | undefined
    try {
        stage = await fs.mkdtemp(path.join(directory, '.pending-'))
        const vaultArchive = path.join(stage, 'Obsidian.zip')
        const result = await writeVaultZip(root, vaultArchive, p => status.update('Obsidian', p),
            scope ? { include: (relative, directory) => includedInBackup(scope, relative, directory) } : undefined)
        if (scope && !result.files) throw new Error(t('The selected backup folders contain no files.',
            'В выбранных папках резервного копирования нет файлов.'))
        await verifyVaultZip(vaultArchive, p => status.update('Obsidian', p))
        const manifest: BackupManifest = {
            version: 1, completedAt: 0, vaultRoot: root, vaultBytes: (await fs.stat(vaultArchive)).size,
            ...(scope ? { scope } : {}),
        }
        if (profile) {
            status.update(t('Anki · making a consistent copy', 'Anki · создаём согласованную копию'))
            const ankiArchive = path.join(stage, 'Anki.zip')
            const result = await backupAnkiCollection(ankiArchive, p => status.update('Anki', p), profile)
            if (result.profile !== profile) throw new AnkiProfileError('mismatch', profile, result.profile)
            await checkPinnedAnkiProfile(profile)
            manifest.profile = profile
            manifest.ankiBytes = (await fs.stat(ankiArchive)).size
        }
        manifest.completedAt = Date.now()
        await fs.writeFile(path.join(stage, 'backup.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
        const date = new Date(manifest.completedAt).toISOString().replace(/:/g, '-').slice(0, 19)
        const saved = path.join(directory, `${backupPrefix}${date}-${path.basename(stage).slice('.pending-'.length)}`)
        await fs.rename(stage, saved)
        stage = undefined
        return saved
    } finally {
        try {
            if (stage) await fs.rm(stage, { recursive: true, force: true })
        } finally {
            status.close()
        }
    }
}

/** Вызывается под действующей блокировкой экспорта или синхронизации перед фактической записью. */
export async function ensureScheduledBackup(plugin: MyPlugin, expectedProfile?: string): Promise<BackupCheck> {
    const settings = readBackupSettings(plugin.settings.VAULT_BACKUP)
    if (!settings.enabled) return { created: false }
    const t = uiFor(plugin.settings)
    const scope = selectedBackupScope(plugin)
    try {
        const profile = settings.includeAnki
            ? expectedProfile ? await checkPinnedAnkiProfile(expectedProfile) : await activeAnkiBackupProfile() : undefined
        const loc = await destination(plugin, settings, false)
        const now = Date.now()
        const cutoff = now - settings.intervalDays * dayMs
        let created = true
        for await (const _backup of matchingBackups(loc, manifest => manifest.vaultRoot === loc.root &&
            (!profile || manifest.profile === profile) && sameBackupScope(manifest.scope, scope) &&
            manifest.completedAt <= now && manifest.completedAt > cutoff)) {
            created = false
            break
        }
        if (created) {
            const folder = await createSnapshot(await destination(plugin, settings, true), profile, t, scope)
            new Notice(t(`Backup verified. Continuing export.\n${folder}`,
                `Резервная копия проверена. Продолжаем экспорт.\n${folder}`))
        }
        if (profile) await checkPinnedAnkiProfile(profile)
        return { created, profile }
    } catch (error) {
        if (error instanceof AnkiProfileError) throw error
        const detail = uiDiagnostic(error, t)
        throw new Error(t(`Export stopped before writing. Backup failed. ${detail}`,
            `Экспорт остановлен до записи: резервная копия не создана. ${detail}`))
    }
}

/** Shows the external destination before a migration is confirmed. */
export async function fullMigrationBackupDirectory(plugin: MyPlugin): Promise<string> {
    return (await destination(plugin, readBackupSettings(plugin.settings.VAULT_BACKUP), false)).directory
}

/** The caller holds the sync lock. Migration always snapshots the entire vault including its settings. */
export async function createFullMigrationBackup(plugin: MyPlugin, override?: string): Promise<string> {
    const settings = readBackupSettings(plugin.settings.VAULT_BACKUP)
    if (override?.trim()) settings.directory = override.trim()
    const loc = await destination(plugin, settings, true)
    const folder = await createSnapshot(loc, undefined, uiFor(plugin.settings))
    return loc.path.join(folder, 'Obsidian.zip')
}

export function createBackupNow(plugin: MyPlugin): Promise<string> {
    return withFastScanReadLock(plugin, async () => {
        const settings = readBackupSettings(plugin.settings.VAULT_BACKUP)
        const profile = settings.includeAnki ? await requireExpectedAnkiProfile(plugin) : undefined
        return createSnapshot(await destination(plugin, settings, true), profile, uiFor(plugin.settings), selectedBackupScope(plugin))
    })
}

export async function listVaultBackups(plugin: MyPlugin): Promise<SavedVaultBackup[]> {
    const loc = await destination(plugin, readBackupSettings(plugin.settings.VAULT_BACKUP), false)
    const results: SavedBackup[] = []
    for await (const backup of matchingBackups(loc, manifest => manifest.vaultRoot === loc.root)) results.push(backup)
    const t = uiFor(plugin.settings)
    return results.sort((a, b) => b.manifest.completedAt - a.manifest.completedAt)
        .map(({ path, name, manifest }) => savedBackupMetadata(path, name, manifest, t))
}

export function restoreVaultBackup(plugin: MyPlugin, archive: string): Promise<string> {
    return withFastScanReadLock(plugin, async () => {
        const t = uiFor(plugin.settings)
        const { fs, path, base } = desktop(plugin)
        if (!path.isAbsolute(archive) || !/\.zip$/i.test(archive)) throw new Error('Enter the absolute path of an Obsidian ZIP backup.')
        const source = await fs.realpath(archive)
        if (!(await fs.stat(source)).isFile()) throw new Error('The selected backup is not a file.')
        const root = await fs.realpath(base)
        const parent = path.dirname(root)
        if (parent === root) throw new Error('Choose a vault with a parent folder before restoring.')
        const name = `${path.basename(root)}-Restored-${new Date().toISOString().slice(0, 10)}-${globalThis.crypto.randomUUID().slice(0, 8)}`
        const restored = path.join(parent, name)
        const status = displayProgress(t('Restoring Obsidian into a new folder', 'Восстанавливаем Obsidian в новую папку'), t)
        try {
            await restoreVaultZip(source, restored, p => status.update('Obsidian', p))
            return restored
        } finally {
            status.close()
        }
    })
}
