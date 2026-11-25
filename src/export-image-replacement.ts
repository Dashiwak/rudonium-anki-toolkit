/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { files as fs, paths as path, hashes as crypto } from './desktop-io'
import type { DesktopFiles as FileSystem, DesktopPaths, DesktopHashes } from './desktop-io'
import type { App, FileSystemAdapter, TFile } from 'obsidian'
import { rudoniumPluginId } from './plugin-identity'
import type { ImageOptimizationSettings } from './image-optimizer'

export interface ImageReplacementDimensions {
    originalWidth: number
    originalHeight: number
    width: number
    height: number
}

export interface ImageReplacementReceipt extends Partial<ImageReplacementDimensions> {
    sourceHash: string
    outputHash: string
    beforeBytes: number
    afterBytes: number
    backupPath?: string
}

interface StoredReceipt extends ImageReplacementReceipt {
    version: 1
    path: string
}

interface DesktopFiles {
    fs: FileSystem
    path: DesktopPaths
    crypto: DesktopHashes
    root: string
}

const hashPattern = /^[a-f0-9]{64}$/
const staleImage = 'The original image changed before replacement. Preview the export again.'

async function desktopFiles(app: App): Promise<DesktopFiles | undefined> {
    const adapter = app.vault.adapter as Partial<FileSystemAdapter>
    if (typeof adapter.getBasePath !== 'function') return undefined
    return { fs, path, crypto, root: await fs.promises.realpath(adapter.getBasePath()) }
}

function inside(files: DesktopFiles, root: string, target: string): boolean {
    const relative = files.path.relative(root, target)
    return !!relative && !files.path.isAbsolute(relative) && relative.split(files.path.sep)[0] !== '..'
}

function childPath(files: DesktopFiles, root: string, vaultPath: string): string {
    const parts = vaultPath.split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
        throw new Error('Invalid path for image replacement.')
    }
    const target = files.path.resolve(root, ...parts)
    if (!inside(files, root, target)) throw new Error('The image path resolved outside its directory.')
    return target
}

const receiptDirectories = new WeakMap<App, string>()

export function setImageReceiptDirectory(app: App, pluginDirectory: string): void {
    receiptDirectories.set(app, pluginDirectory)
}

function receiptPath(files: DesktopFiles, app: App, vaultPath: string): string {
    const key = files.crypto.createHash('sha256').update(vaultPath).digest('hex')
    const configured = receiptDirectories.get(app)
    if (!configured && !app.vault.configDir) throw new Error('The vault configuration directory is unavailable.')
    const directory = configured ?? `${app.vault.configDir}/plugins/${rudoniumPluginId}`
    return childPath(files, files.root, `${directory}/image-replacements/${key}.json`)
}

function bytesHash(files: DesktopFiles, bytes: ArrayBuffer): string {
    return files.crypto.createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
}

async function fileHash(files: DesktopFiles, path: string): Promise<string> {
    const hash = files.crypto.createHash('sha256')
    for await (const chunk of files.fs.createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
}

function isMissing(error: unknown): boolean {
    return (error as { code?: string } | undefined)?.code === 'ENOENT'
}

async function ensureChildDirectory(files: DesktopFiles, root: string, directory: string): Promise<void> {
    const relative = files.path.relative(root, directory)
    if (!relative) return
    if (!inside(files, root, directory)) throw new Error('The replacement directory leads outside its root.')
    let current = root
    for (const part of relative.split(files.path.sep)) {
        current = files.path.join(current, part)
        try {
            await files.fs.promises.mkdir(current)
        } catch (error) {
            if ((error as { code?: string })?.code !== 'EEXIST') throw error
        }
        if (!(await files.fs.promises.lstat(current)).isDirectory()) {
            throw new Error('The image replacement folder contains a symbolic link or a non-folder entry.')
        }
    }
}

function checkedReceipt(value: unknown, path: string): StoredReceipt {
    const record = value as Partial<StoredReceipt> | null
    if (!record || record.version !== 1 || record.path !== path ||
        typeof record.sourceHash !== 'string' || !hashPattern.test(record.sourceHash) ||
        typeof record.outputHash !== 'string' || !hashPattern.test(record.outputHash) ||
        typeof record.beforeBytes !== 'number' || !Number.isSafeInteger(record.beforeBytes) ||
        typeof record.afterBytes !== 'number' || !Number.isSafeInteger(record.afterBytes) ||
        record.afterBytes < 1 || record.beforeBytes <= record.afterBytes ||
        (record.backupPath !== undefined && typeof record.backupPath !== 'string') ||
        [record.originalWidth, record.originalHeight, record.width, record.height].some(
            dimension => dimension !== undefined && (!Number.isSafeInteger(dimension) || dimension < 1))) {
        throw new Error(`The image replacement receipt is damaged for ${path}.`)
    }
    return record as StoredReceipt
}

export async function readImageReplacement(app: App, path: string, currentSourceHash: string): Promise<ImageReplacementReceipt | undefined> {
    const files = await desktopFiles(app)
    if (!files) return undefined
    const target = receiptPath(files, app, path)
    try {
        const stat = await files.fs.promises.lstat(target)
        if (!stat.isFile() || stat.size > 16_384 || !inside(files, files.root, await files.fs.promises.realpath(target))) {
            throw new Error(`The image replacement receipt is unavailable for ${path}.`)
        }
        const record = checkedReceipt(JSON.parse(await files.fs.promises.readFile(target, 'utf8')), path)
        return record.outputHash === currentSourceHash ? record : undefined
    } catch (error) {
        if (isMissing(error)) return undefined
        throw error
    }
}

async function writeExclusive(files: DesktopFiles, path: string, bytes: Uint8Array | string, mode = 0o600): Promise<void> {
    const handle = await files.fs.promises.open(path, 'wx', mode)
    try {
        try {
            await handle.writeFile(bytes)
            await handle.sync()
        } finally {
            await handle.close()
        }
    } catch (error) {
        await files.fs.promises.rm(path, { force: true }).catch(() => {})
        throw error
    }
}

function uniqueSuffix(files: DesktopFiles): string {
    return files.crypto.randomBytes(8).toString('hex')
}

async function saveOriginal(files: DesktopFiles, path: string, folder: string,
    original: ArrayBuffer, sourceHash: string): Promise<string> {
    const chosen = folder.trim()
    if (!files.path.isAbsolute(chosen) || chosen.includes('\0')) {
        throw new Error('Choose an absolute folder for saved originals in Image Optimization.')
    }
    await files.fs.promises.mkdir(chosen, { recursive: true })
    const directory = await files.fs.promises.realpath(chosen)
    const originalPath = childPath(files, directory, path)
    const destination = files.path.dirname(originalPath)
    await ensureChildDirectory(files, directory, destination)
    const resolved = await files.fs.promises.realpath(destination)
    if (files.path.relative(directory, resolved) && !inside(files, directory, resolved)) {
        throw new Error('The originals folder leads outside the configured directory.')
    }
    const ext = files.path.extname(originalPath)
    const stem = Array.from(files.path.basename(originalPath, ext)).slice(0, 40).join('')
    const target = files.path.join(resolved, `${stem}--${sourceHash}${ext}`)
    try {
        await writeExclusive(files, target, new Uint8Array(original))
    } catch (error) {
        if ((error as { code?: string })?.code !== 'EEXIST') throw error
    }
    if (!(await files.fs.promises.lstat(target)).isFile() || await fileHash(files, target) !== sourceHash) {
        throw new Error('Could not verify the saved original image.')
    }
    return target
}

async function writeReceipt(files: DesktopFiles, app: App, record: StoredReceipt): Promise<void> {
    const target = receiptPath(files, app, record.path)
    const directory = files.path.dirname(target)
    await ensureChildDirectory(files, files.root, directory)
    if (!inside(files, files.root, await files.fs.promises.realpath(directory))) {
        throw new Error('The image replacement state folder leads outside the vault.')
    }
    const staged = files.path.join(directory, `.receipt-${uniqueSuffix(files)}.tmp`)
    await writeExclusive(files, staged, JSON.stringify(record))
    try {
        await files.fs.promises.rename(staged, target)
    } finally {
        await files.fs.promises.rm(staged, { force: true }).catch(() => {})
    }
}

function hasImageFormat(path: string, buffer: ArrayBuffer): boolean {
    const bytes = new Uint8Array(buffer)
    if (/\.jpe?g$/i.test(path)) return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    return /\.png$/i.test(path) && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
}

export async function prepareImageReplacement(app: App, file: TFile, original: ArrayBuffer, output: ArrayBuffer,
    settings: ImageOptimizationSettings, expectedSource: string, expectedOutput: string,
    dimensions?: ImageReplacementDimensions, stillAllowed?: () => boolean | Promise<boolean>,
    shouldStop?: () => boolean): Promise<ImageReplacementReceipt> {
    const files = await desktopFiles(app)
    if (!files) throw new Error('Replacing original images requires desktop Obsidian and a local vault.')
    const path = file.path
    const target = childPath(files, files.root, path)
    if (output.byteLength >= original.byteLength || !hasImageFormat(path, original) || !hasImageFormat(path, output) ||
        bytesHash(files, original) !== expectedSource || bytesHash(files, output) !== expectedOutput) {
        throw new Error('The prepared replacement image could not be verified.')
    }
    const identity = await files.fs.promises.lstat(target)
    if (!identity.isFile() || !inside(files, files.root, await files.fs.promises.realpath(target))) throw new Error(staleImage)
    const current = async () => {
        if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file || await fileHash(files, target) !== expectedSource) {
            return false
        }
        const latest = await files.fs.promises.lstat(target)
        return latest.isFile() && latest.dev === identity.dev && latest.ino === identity.ino &&
            latest.size === identity.size && latest.mtimeMs === identity.mtimeMs && latest.ctimeMs === identity.ctimeMs &&
            file.path === path && app.vault.getAbstractFileByPath(path) === file
    }
    if (!await current()) throw new Error(staleImage)
    const staged = files.path.join(files.path.dirname(target), `.anki-image-${uniqueSuffix(files)}.tmp`)
    await writeExclusive(files, staged, new Uint8Array(output), identity.mode & 0o777)
    try {
        if (await fileHash(files, staged) !== expectedOutput) throw new Error('Could not verify the staged replacement image.')
        const backupPath = settings.keepOriginal ? await saveOriginal(files, path, settings.originalsFolder, original, expectedSource) : undefined
        const receipt: StoredReceipt = {
            version: 1, path, sourceHash: expectedSource, outputHash: expectedOutput,
            beforeBytes: original.byteLength, afterBytes: output.byteLength, ...dimensions, backupPath,
        }
        await writeReceipt(files, app, receipt)
        if (stillAllowed && !await stillAllowed()) throw new Error('Export stopped before replacing the original image.')
        if (!await current()) throw new Error(staleImage)
        if (shouldStop?.()) throw new Error('Export stopped before replacing the original image.')
        await files.fs.promises.rename(staged, target)
        if (await fileHash(files, target) !== expectedOutput || file.path !== path) {
            throw new Error('Could not confirm the replacement image in Obsidian.')
        }
        return receipt
    } finally {
        await files.fs.promises.rm(staged, { force: true }).catch(() => {})
    }
}
