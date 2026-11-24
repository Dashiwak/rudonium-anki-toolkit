/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'
import { constants, promises as fs } from 'fs'
import { MarkdownView, TFile } from 'obsidian'
import type { FileSystemAdapter } from 'obsidian'
import type MyPlugin from '../main'
import { withFastScanReadLock } from './fast-scan'
import { sameEditorText } from './markdown-pipeline'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { isSupportedZipImportPath, zipImportLimits } from './zip-import-archive'
import type { ZipImportArchive } from './zip-import-archive'
import { verifyVaultZip, writeVaultZip } from './vault-backup-zip'
import { mobileZipLimits, prepareMobileZip } from './mobile-zip-archive'
import { archiveScopeSignature, previewArchiveFiles, readArchiveSettings } from './archive-settings'

export interface TransferPackageProgress {
    phase: string
    files: number
    totalFiles: number
    bytes: number
    totalBytes: number
    path?: string
}

export interface TransferPackageOptions { folder: string; output: string; mobileCompatible?: boolean; useSavedScope?: boolean; changedOnly?: boolean }
export interface TransferPackageResult { id: string; output: string; files: number; unchanged?: boolean; scopedFiles?: number }
export interface TransferBaselineFile { hash: string; text?: string }
export interface TransferBaseline {
    id: string
    files: ReadonlyMap<string, TransferBaselineFile>
    reason?: string
}

interface StoredBaseline {
    kind: 'rupos-transfer-baseline'
    version: 1
    id: string
    folder: string
    vaultRoot: string
    createdAt: number
    files: { path: string; hash: string }[]
}

interface ArchiveChangeIndex {
    kind: 'rupos-archive-index'
    version: 1
    vaultRoot: string
    scope: string
    packageId: string
    files: { path: string; hash: string }[]
}

const markerName = 'rupos-transfer.json'
const tokenPattern = /^[a-f\d]{32}$/u
const hashPattern = /^[a-f\d]{64}$/u
const maxBaselineBytes = 16 * 1024 * 1024

function abort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
}

function safeRelative(raw: string, t: UiText): string {
    const path = raw.trim().replace(/\/$/u, '')
    if (!path || path === '/') return ''
    if (path.split('/').some(part => !part || part.startsWith('.') || /[\\:\p{Cc}]/u.test(part))) {
        throw new Error(t('Choose a visible vault folder using its path relative to the vault.',
            'Выберите обычную папку хранилища и укажите путь относительно его корня.'))
    }
    return path
}

function desktop(plugin: MyPlugin) {
    const t = uiFor(plugin.settings)
    const adapter = plugin.app.vault.adapter as Partial<FileSystemAdapter>
    if (typeof adapter.getBasePath !== 'function') {
        throw new Error(t('ZIP transfer requires desktop Obsidian and a local vault.',
            'Для переноса ZIP нужен настольный Obsidian с локальным хранилищем.'))
    }
    return { fs, path, crypto, os, base: adapter.getBasePath(), t }
}

function inside(path: typeof import('path'), root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

function dirty(plugin: MyPlugin, paths: ReadonlySet<string>): boolean {
    return plugin.app.workspace.getLeavesOfType('markdown').some(({ view }) =>
        view instanceof MarkdownView && view.file && paths.has(view.file.path) &&
        view.getMode() === 'source' && !sameEditorText(view.getViewData(), view.data))
}

function pluginStorage(plugin: MyPlugin, root: string, path: typeof import('path')): string {
    const configured = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
    if (path.isAbsolute(configured) || configured.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
        throw new Error(uiFor(plugin.settings)('The plugin storage path is invalid.', 'Путь хранения данных плагина некорректен.'))
    }
    const result = path.join(root, ...configured.split('/'), 'zip-transfer-packages')
    if (!inside(path, root, result)) throw new Error('Invalid plugin storage path')
    return result
}

async function checkedPath(root: string, target: string, createFolders = false): Promise<void> {
    if (!inside(path, root, target)) throw new Error('Path is outside the vault')
    let cursor = root
    const parts = path.relative(root, target).split(path.sep).filter(Boolean)
    for (let index = 0; index < parts.length; index++) {
        cursor = path.join(cursor, parts[index])
        const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return undefined
        })
        if (!stat) {
            if (!createFolders) throw new Error(`Missing path: ${cursor}`)
            await fs.mkdir(cursor)
        } else if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) {
            throw new Error(`Linked or invalid path: ${cursor}`)
        }
    }
}

export function preparePhonePackage(plugin: MyPlugin, options: TransferPackageOptions,
    onProgress?: (progress: TransferPackageProgress) => void, signal?: AbortSignal): Promise<TransferPackageResult> {
    return withFastScanReadLock(plugin, async () => {
        const { fs, path, crypto, os, base, t } = desktop(plugin)
        const limits = options.mobileCompatible ? mobileZipLimits : { ...zipImportLimits, totalBytes: zipImportLimits.archiveBytes }
        const folder = safeRelative(options.folder, t)
        const savedScope = readArchiveSettings(options.useSavedScope ?
            (plugin.settings as MyPlugin['settings'] & { ARCHIVE_TRANSFER?: unknown }).ARCHIVE_TRANSFER : undefined)
        const changedOnly = options.changedOnly ?? (options.useSavedScope === true && savedScope.changedOnly)
        const scope = JSON.stringify([folder, archiveScopeSignature(savedScope)])
        const root = await fs.realpath(base)
        const folderPath = folder ? path.join(root, ...folder.split('/')) : root
        await checkedPath(root, folderPath)
        if (!(await fs.stat(folderPath)).isDirectory()) throw new Error(t('Choose a vault folder.', 'Выберите папку хранилища.'))
        if (!path.isAbsolute(options.output) || !/\.zip$/iu.test(options.output)) {
            throw new Error(t('Enter an absolute path ending in .zip outside the vault.',
                'Укажите полный путь к ZIP-файлу за пределами хранилища.'))
        }
        const parent = await fs.realpath(path.dirname(options.output))
        const output = path.join(parent, path.basename(options.output))
        if (inside(path, root, output)) throw new Error(t('Save the phone package outside the vault.',
            'Сохраните пакет для телефона за пределами хранилища.'))
        const summary = await previewArchiveFiles(plugin, { folder, settings: savedScope })
        const files = summary.files
        const selectedPaths = new Set(files.map(file => file.path))
        const missing = savedScope.includeFolders.filter(name => summary.missingFolders.includes(name))
        if (missing.length) throw new Error(t(`Included archive folders were not found: ${missing.join(', ')}`,
            `Не найдены включённые в архив папки: ${missing.join(', ')}`))
        const requireSavedEditors = () => {
            if (dirty(plugin, selectedPaths)) throw new Error(t('Save the selected notes before preparing the archive.',
                'Сохраните выбранные заметки перед подготовкой архива.'))
        }
        requireSavedEditors()
        if (!files.length) throw new Error(t('This folder has no supported notes or attachments.',
            'В папке нет поддерживаемых заметок и вложений.'))
        if (files.length > limits.files) throw new Error(t('Split this folder into smaller phone packages.',
            'Разделите папку на несколько меньших пакетов для телефона.'))
        const totalBytes = summary.totalBytes
        const storage = pluginStorage(plugin, root, path)
        const scopeHash = crypto.createHash('sha256').update(scope).digest('hex')
        const indexPath = path.join(storage, `archive-${scopeHash}.json`)
        let previous: ArchiveChangeIndex | undefined
        if (changedOnly) {
            const indexStat = await fs.lstat(indexPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error
                return undefined
            })
            if (indexStat) {
                await checkedPath(root, indexPath)
                if (!indexStat.isFile() || indexStat.size > maxBaselineBytes) throw new Error(t('Create a full archive to replace the invalid change index.',
                    'Создайте полный архив, чтобы заменить повреждённый индекс изменений.'))
                const value = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Partial<ArchiveChangeIndex>
                if (value.kind !== 'rupos-archive-index' || value.version !== 1 || value.vaultRoot !== root || value.scope !== scope ||
                    typeof value.packageId !== 'string' || !tokenPattern.test(value.packageId) || !Array.isArray(value.files) ||
                    value.files.length > zipImportLimits.files || value.files.some(file => !file || typeof file.path !== 'string' ||
                        !isSupportedZipImportPath(file.path) || typeof file.hash !== 'string' || !hashPattern.test(file.hash)) ||
                    new Set(value.files.map(file => file.path)).size !== value.files.length) throw new Error(t(
                    'Create a full archive to replace the invalid change index.', 'Создайте полный архив, чтобы заменить повреждённый индекс изменений.'))
                previous = value as ArchiveChangeIndex
            }
        }
        const previousHashes = new Map(previous?.files.map(file => [file.path, file.hash]) ?? [])
        const id = crypto.randomBytes(16).toString('hex')
        const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'rupos-phone-'))
        const baseline: StoredBaseline = { kind: 'rupos-transfer-baseline', version: 1, id, folder,
            vaultRoot: root, createdAt: Date.now(), files: [] }
        let copiedBytes = 0
        let payloadBytes = 0
        let payloadFiles = 0
        let createdOutput = false
        let baselinePath: string | undefined
        const progress = (phase: string, count: number, entry?: string) => {
            abort(signal)
            onProgress?.({ phase, files: count, totalFiles: files.length, bytes: copiedBytes, totalBytes, path: entry })
        }
        const readSource = async (file: TFile): Promise<Buffer> => {
            const source = path.join(root, ...file.path.split('/'))
            await checkedPath(root, source)
            const handle = await fs.open(source, constants.O_RDONLY |
                (constants.O_NOFOLLOW ?? 0))
            try {
                const stat = await handle.stat()
                const limit = /\.md$/iu.test(file.path) ? limits.markdownBytes : limits.entryBytes
                if (!stat.isFile() || stat.size > limit) throw new Error(t(`Unsupported file size: ${file.path}`,
                    `Неподдерживаемый размер файла: ${file.path}`))
                const bytes = await handle.readFile()
                const after = await handle.stat()
                if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
                    throw new Error(t('A source file changed. Prepare the package again.', 'Исходный файл изменился. Подготовьте пакет заново.'))
                }
                return bytes
            } finally { await handle.close() }
        }
        try {
            progress('copy', 0)
            for (const file of files) {
                abort(signal)
                const relative = folder ? file.path.slice(folder.length + 1) : file.path
                const bytes = await readSource(file)
                const hash = crypto.createHash('sha256').update(bytes).digest('hex')
                if (!changedOnly || previousHashes.get(relative) !== hash) {
                    payloadBytes += bytes.length
                    if (payloadBytes > limits.totalBytes) throw new Error(t('This archive exceeds the supported expanded size.',
                        'Архив превышает поддерживаемый размер после распаковки.'))
                    const destination = path.join(stage, 'files', ...relative.split('/'))
                    await fs.mkdir(path.dirname(destination), { recursive: true })
                    await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
                    payloadFiles++
                }
                baseline.files.push({ path: relative, hash })
                copiedBytes += bytes.length
                progress('copy', baseline.files.length, file.path)
            }
            for (let index = 0; index < files.length; index++) {
                progress('check', index, files[index].path)
                if (plugin.app.vault.getAbstractFileByPath(files[index].path) !== files[index] ||
                    crypto.createHash('sha256').update(await readSource(files[index])).digest('hex') !== baseline.files[index].hash) {
                    throw new Error(t('The source folder changed. Prepare the package again.', 'Исходная папка изменилась. Подготовьте пакет заново.'))
                }
            }
            const after = await previewArchiveFiles(plugin, { folder, settings: savedScope })
            if (after.files.length !== files.length || after.files.some((file, index) => file !== files[index])) {
                throw new Error(t('The archive selection changed. Prepare it again.', 'Состав выбранных файлов изменился. Подготовьте архив заново.'))
            }
            requireSavedEditors()
            if (!payloadFiles) return { id: '', output: '', files: 0, unchanged: true, scopedFiles: files.length }
            await fs.writeFile(path.join(stage, markerName), JSON.stringify({ kind: 'rupos-transfer', version: 1, id }), { flag: 'wx' })
            await writeVaultZip(stage, output, value => { abort(signal); onProgress?.({ ...value, phase: 'write' }) })
            createdOutput = true
            if ((await fs.stat(output)).size > limits.archiveBytes) {
                throw new Error(t('Split this folder into smaller phone packages.',
                    'Разделите папку на несколько меньших пакетов для телефона.'))
            }
            await verifyVaultZip(output, value => { abort(signal); onProgress?.({ ...value, phase: 'verify' }) }, {
                maxFiles: limits.files, maxTotalBytes: limits.totalBytes,
                maxEntryBytes: limits.entryBytes, signal,
            })
            if (options.mobileCompatible) {
                const mobile = await prepareMobileZip(new Uint8Array(await fs.readFile(output)), value => {
                    onProgress?.({ ...value, phase: 'verify' })
                }, signal)
                await mobile.dispose()
            }
            abort(signal)
            await checkedPath(root, storage, true)
            baselinePath = path.join(storage, `${id}.json`)
            const text = JSON.stringify(baseline)
            if (Buffer.byteLength(text) > maxBaselineBytes) throw new Error(t('The source folder index is too large.',
                'Индекс исходной папки превышает поддерживаемый размер.'))
            await fs.writeFile(baselinePath, text, { flag: 'wx', mode: 0o600 })
            abort(signal)
            const index: ArchiveChangeIndex = { kind: 'rupos-archive-index', version: 1, vaultRoot: root, scope, packageId: id, files: baseline.files }
            const temporaryIndex = `${indexPath}.${id}.tmp`
            try {
                await fs.writeFile(temporaryIndex, JSON.stringify(index), { flag: 'wx', mode: 0o600 })
                requireSavedEditors()
                await fs.rename(temporaryIndex, indexPath)
            } finally { await fs.unlink(temporaryIndex).catch(() => undefined) }
            try { onProgress?.({ phase: 'complete', files: payloadFiles, totalFiles: payloadFiles, bytes: payloadBytes, totalBytes: payloadBytes }) } catch { /* Интерфейс может уже закрыться. */ }
            return { id, output, files: payloadFiles, scopedFiles: files.length }
        } catch (error) {
            if (createdOutput) await fs.unlink(output).catch(() => undefined)
            if (baselinePath) await fs.unlink(baselinePath).catch(() => undefined)
            throw error
        } finally {
            await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
        }
    })
}

export async function readTransferBaseline(plugin: MyPlugin, archive: ZipImportArchive,
    prefix: string, target: string): Promise<TransferBaseline | undefined> {
    const { fs, path, base, t } = desktop(plugin)
    const marker = prefix === 'files' ? markerName : prefix.endsWith('/files')
        ? `${prefix.slice(0, -5)}${markerName}` : undefined
    if (!marker) return undefined
    const bytes = await archive.readMetadata(marker)
    if (!bytes) return undefined
    const invalid = (id = ''): TransferBaseline => ({ id, files: new Map(), reason: t(
        'The original phone package is unknown here. Review differing files manually.',
        'Исходный пакет для телефона здесь неизвестен. Проверьте различающиеся файлы вручную.') })
    try {
        if (bytes.byteLength > 4096) return invalid()
        const markerData: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!markerData || typeof markerData !== 'object') return invalid()
        const metadata = markerData as { kind?: unknown; version?: unknown; id?: unknown }
        if (metadata.kind !== 'rupos-transfer' || metadata.version !== 1 || typeof metadata.id !== 'string' ||
            !tokenPattern.test(metadata.id)) return invalid()
        const root = await fs.realpath(base)
        const stored = path.join(pluginStorage(plugin, root, path), `${metadata.id}.json`)
        await checkedPath(root, stored)
        const stat = await fs.stat(stored)
        if (!stat.isFile() || stat.size > maxBaselineBytes) return invalid(metadata.id)
        const baseline = JSON.parse(await fs.readFile(stored, 'utf8')) as Partial<StoredBaseline>
        const folder = safeRelative(target, t)
        if (baseline.kind !== 'rupos-transfer-baseline' || baseline.version !== 1 || baseline.id !== metadata.id ||
            baseline.folder !== folder || baseline.vaultRoot !== root || !Array.isArray(baseline.files) ||
            baseline.files.length > zipImportLimits.files) return invalid(metadata.id)
        const result = new Map<string, TransferBaselineFile>()
        for (const file of baseline.files) {
            if (!file || typeof file.path !== 'string' || !isSupportedZipImportPath(file.path) ||
                typeof file.hash !== 'string' || !hashPattern.test(file.hash)) return invalid(metadata.id)
            const key = folder ? `${folder}/${file.path}` : file.path
            if (result.has(key)) return invalid(metadata.id)
            result.set(key, { hash: file.hash })
        }
        return { id: metadata.id, files: result }
    } catch { return invalid() }
}
