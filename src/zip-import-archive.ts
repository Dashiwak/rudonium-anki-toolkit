/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { restoreVaultZip } from './vault-backup-zip'

export interface ZipImportProgress {
    phase: string
    files: number
    bytes: number
    totalFiles: number
    totalBytes: number
    path?: string
}

export interface ZipImportEntry {
    path: string
    size: number
    hash: string
    markdown: boolean
}

export interface ZipImportArchive {
    readonly token: string
    readonly name: string
    readonly files: readonly ZipImportEntry[]
    readonly prefixes: readonly string[]
    readonly ignoredFiles: number
    readonly metadataPaths: readonly string[]
    readonly transferPrefix?: string
    readonly disposed: boolean
    read(path: string): Promise<Uint8Array>
    readMetadata(path: string): Promise<Uint8Array | undefined>
    dispose(): Promise<void>
}

type Progress = (progress: ZipImportProgress) => void
const maxArchiveBytes = 2 * 1024 * 1024 * 1024
const maxEntryBytes = 128 * 1024 * 1024
const maxMarkdownBytes = 16 * 1024 * 1024
const maxFiles = 50_000
const maxMetadataBytes = 128 * 1024
export const zipImportLimits = Object.freeze({ archiveBytes: maxArchiveBytes, entryBytes: maxEntryBytes,
    markdownBytes: maxMarkdownBytes, files: maxFiles, metadataBytes: maxMetadataBytes })
const markdownExtension = /\.md$/iu
const attachmentExtension = /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif|apng|mp3|wav|ogg|opus|m4a|aac|flac|mp4|webm|mov|pdf)$/iu

function abort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Reading cancelled.', 'AbortError')
}

export function isSupportedZipImportPath(path: string): boolean {
    return !path.split('/').some(part => part.startsWith('.') || part === '__MACOSX') &&
        (markdownExtension.test(path) || attachmentExtension.test(path))
}

function isMetadata(path: string): boolean {
    return !path.split('/').some(part => part.startsWith('.') || part === '__MACOSX') &&
        /(?:^|\/)rupos-transfer\.json$/u.test(path)
}

function report(onProgress: Progress | undefined, phase: string, files: number, bytes: number,
    totalFiles: number, totalBytes: number, path?: string): void {
    onProgress?.({ phase, files, bytes, totalFiles, totalBytes, path })
}

async function copySource(source: string | File, target: string, onProgress?: Progress, signal?: AbortSignal): Promise<string> {
    const output = await fs.promises.open(target, 'wx', 0o600)
    let input: Awaited<ReturnType<typeof fs.promises.open>> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let bytes = 0
    try {
        let size: number
        let name: string
        if (typeof source === 'string') {
            if (!path.isAbsolute(source) || !/\.zip$/iu.test(source)) throw new Error('Choose an absolute path to a ZIP archive.')
            const absolute = await fs.promises.realpath(source)
            input = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
            const initial = await input.stat()
            if (!initial.isFile()) throw new Error('Choose a ZIP file.')
            size = initial.size
            name = path.basename(source)
            if (size > maxArchiveBytes) throw new Error('The ZIP archive is larger than the supported 2 GiB import size.')
            const buffer = Buffer.allocUnsafe(1024 * 1024)
            while (bytes < size) {
                abort(signal)
                const amount = Math.min(buffer.length, size - bytes)
                const { bytesRead } = await input.read(buffer, 0, amount, bytes)
                if (!bytesRead) throw new Error('The ZIP changed while it was being read.')
                await writeFully(output, buffer.subarray(0, bytesRead))
                bytes += bytesRead
                report(onProgress, 'copy', 0, bytes, 1, size)
            }
            const current = await input.stat()
            if (initial.dev !== current.dev || initial.ino !== current.ino || initial.size !== current.size ||
                initial.mtimeMs !== current.mtimeMs || initial.ctimeMs !== current.ctimeMs) {
                throw new Error('The ZIP changed while it was being read.')
            }
        } else {
            if (!source || typeof source.stream !== 'function' || !Number.isSafeInteger(source.size) ||
                source.size < 0 || !/\.zip$/iu.test(source.name)) throw new Error('Choose a ZIP file.')
            size = source.size
            name = source.name.replace(/^.*[\\/]/u, '')
            if (size > maxArchiveBytes) throw new Error('The ZIP archive is larger than the supported 2 GiB import size.')
            reader = source.stream().getReader()
            while (true) {
                abort(signal)
                const part = await reader.read()
                if (part.done) break
                bytes += part.value.length
                if (bytes > size || bytes > maxArchiveBytes) throw new Error('The ZIP changed while it was being read.')
                await writeFully(output, part.value)
                report(onProgress, 'copy', 0, bytes, 1, size)
            }
            if (bytes !== size) throw new Error('The ZIP changed while it was being read.')
        }
        abort(signal)
        report(onProgress, 'copy', 1, bytes, 1, size)
        return name
    } finally {
        if (reader) {
            await reader.cancel().catch(() => undefined)
            reader.releaseLock()
        }
        await input?.close()
        await output.close()
    }
}

async function writeFully(file: import('fs/promises').FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0
    while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null)
        if (!bytesWritten) throw new Error('The temporary ZIP file could not be written.')
        offset += bytesWritten
    }
}

async function readChecked(root: string, entry: Pick<ZipImportEntry, 'path' | 'size'>, expectedHash?: string): Promise<Buffer> {
    const filename = path.join(root, ...entry.path.split('/'))
    const file = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
        const initial = await file.stat()
        if (!initial.isFile() || initial.size !== entry.size || initial.size > maxEntryBytes) {
            throw new Error(`The extracted ZIP file changed: ${entry.path}`)
        }
        const bytes = await file.readFile()
        const after = await file.stat()
        if (initial.dev !== after.dev || initial.ino !== after.ino || initial.size !== after.size ||
            initial.mtimeMs !== after.mtimeMs || initial.ctimeMs !== after.ctimeMs || bytes.length !== entry.size ||
            expectedHash && crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
            throw new Error(`The extracted ZIP file changed: ${entry.path}`)
        }
        return bytes
    } finally { await file.close() }
}

export async function prepareZipImportArchive(source: string | File, onProgress?: Progress,
    signal?: AbortSignal): Promise<ZipImportArchive> {
    abort(signal)
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rupos-zip-import-'))
    await fs.promises.chmod(temporary, 0o700)
    const staging = path.join(temporary, 'files')
    let successful = false
    try {
        const archive = path.join(temporary, 'source.zip')
        const name = await copySource(source, archive, onProgress, signal)
        await restoreVaultZip(archive, staging, onProgress, {
            maxFiles, maxTotalBytes: maxArchiveBytes, maxEntryBytes, signal,
        })
        abort(signal)
        const pending = ['']
        const candidates: Array<Pick<ZipImportEntry, 'path' | 'size'>> = []
        let ignoredFiles = 0
        let totalBytes = 0
        let containsAnkiCollection = false
        while (pending.length) {
            const relative = pending.pop()!
            const rows = await fs.promises.readdir(path.join(staging, relative), { withFileTypes: true })
            for (const row of rows) {
                abort(signal)
                const relativePath = relative ? `${relative}/${row.name}` : row.name
                if (row.isDirectory()) pending.push(relativePath)
                else if (row.isFile() && (isSupportedZipImportPath(relativePath) || isMetadata(relativePath))) {
                    const stat = await fs.promises.lstat(path.join(staging, relativePath))
                    if (!stat.isFile()) throw new Error(`The extracted ZIP file changed: ${relativePath}`)
                    if (markdownExtension.test(relativePath) && stat.size > maxMarkdownBytes) {
                        throw new Error(`A Markdown file exceeds the supported 16 MiB import size: ${relativePath}`)
                    }
                    if (isMetadata(relativePath) && stat.size > maxMetadataBytes) throw new Error('The ZIP transfer metadata is too large.')
                    candidates.push({ path: relativePath, size: stat.size })
                    totalBytes += stat.size
                } else if (row.isFile()) {
                    ignoredFiles++
                    if (/^collection\.anki(?:2|21|21b)$/iu.test(row.name) && relative.split('/').filter(Boolean).length <= 1) {
                        containsAnkiCollection = true
                    }
                }
                else throw new Error('The ZIP import contains an unsupported extracted file.')
            }
        }
        if (containsAnkiCollection) throw new Error('This ZIP is an Anki collection backup. Choose Obsidian.zip for vault transfer; restore Anki.zip in Anki.')
        const files: ZipImportEntry[] = []
        const metadata: ZipImportEntry[] = []
        const prefixes = new Set([''])
        let bytes = 0
        const decoder = new TextDecoder('utf-8', { fatal: true })
        for (const candidate of candidates.sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
            abort(signal)
            const data = await readChecked(staging, candidate)
            const markdown = markdownExtension.test(candidate.path)
            if (markdown || isMetadata(candidate.path)) {
                let text: string
                try { text = decoder.decode(data) } catch { throw new Error(`Markdown in the ZIP is not valid UTF-8: ${candidate.path}`) }
                if (text.includes('\u0000')) throw new Error(`Markdown in the ZIP contains a NUL character: ${candidate.path}`)
            }
            const entry = Object.freeze({ ...candidate, markdown, hash: crypto.createHash('sha256').update(data).digest('hex') })
            if (isMetadata(candidate.path)) metadata.push(entry)
            else {
                files.push(entry)
                for (let slash = candidate.path.indexOf('/'); slash >= 0; slash = candidate.path.indexOf('/', slash + 1)) {
                    prefixes.add(candidate.path.slice(0, slash))
                }
            }
            bytes += data.length
            report(onProgress, 'read', files.length, bytes, candidates.length, totalBytes, candidate.path)
        }
        if (!files.length) throw new Error('The ZIP has no supported Markdown notes or attachments to import.')
        const transferPrefixes: string[] = []
        for (const entry of metadata) {
            if (entry.size > 4096) continue
            try {
                const marker: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readChecked(staging, entry, entry.hash)))
                if (!marker || typeof marker !== 'object') continue
                const value = marker as { kind?: unknown; version?: unknown; id?: unknown }
                const prefix = entry.path.slice(0, -'rupos-transfer.json'.length) + 'files'
                if (value.kind === 'rupos-transfer' && value.version === 1 && typeof value.id === 'string' &&
                    /^[a-f\d]{32}$/u.test(value.id) && prefixes.has(prefix)) transferPrefixes.push(prefix)
            } catch { /* Повреждённый маркер не разрешает угадывать корень архива. */ }
        }
        let disposed = false
        const entries = new Map([...files, ...metadata].map(entry => [entry.path, entry]))
        const session: ZipImportArchive = Object.freeze({
            token: crypto.randomUUID(), name, files: Object.freeze(files),
            prefixes: Object.freeze([...prefixes].sort()), ignoredFiles,
            metadataPaths: Object.freeze(metadata.map(entry => entry.path)),
            transferPrefix: transferPrefixes.length === 1 ? transferPrefixes[0] : undefined,
            get disposed() { return disposed },
            async read(relative: string) {
                if (disposed) throw new Error('Reopen the ZIP archive before importing.')
                const entry = entries.get(relative)
                if (!entry) throw new Error('This file is outside the checked ZIP import.')
                return readChecked(staging, entry, entry.hash)
            },
            async readMetadata(relative: string) {
                if (disposed) throw new Error('Reopen the ZIP archive before importing.')
                const entry = metadata.find(item => item.path === relative)
                return entry ? readChecked(staging, entry, entry.hash) : undefined
            },
            async dispose() {
                if (disposed) return
                disposed = true
                await fs.promises.rm(temporary, { recursive: true, force: true })
            },
        })
        successful = true
        return session
    } finally {
        if (!successful) await fs.promises.rm(temporary, { recursive: true, force: true })
    }
}
