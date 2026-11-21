/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import type { Stats } from 'fs'
import type { FileHandle } from 'fs/promises'

export interface VaultZipResult {
    files: number
    bytes: number
}

export interface VaultZipProgress extends VaultZipResult {
    phase: 'enumerate' | 'write' | 'verify' | 'restore'
    totalFiles: number
    totalBytes: number
    path?: string
}

export type VaultZipProgressCallback = (progress: VaultZipProgress) => void

/** Фильтр отсекает папку до обхода её содержимого. */
export interface VaultZipWriteOptions {
    include?: (relativePath: string, directory: boolean) => boolean
}

/** Дополнительные ограничения нужны при чтении пользовательского архива импорта. */
export interface VaultZipReadOptions {
    maxFiles?: number
    maxTotalBytes?: number
    maxEntryBytes?: number
    signal?: AbortSignal
}

type Candidate = { path: string; diskPath: string; stat: Stats; directory: boolean }
type ZipEntry = {
    name: string
    directory: boolean
    size: number
    compressed: number
    offset: number
    method: number
    flags: number
    crc: number
    time: number
    date: number
}

const max32 = 0xffffffff
const max16 = 0xffff
const utf8 = 0x0800
const stored = 0
const deflated = 8
const versions = { standard: 20, large: 45 }
const signatures = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, end64: 0x06064b50, locator: 0x07064b50 }
const textExtension = /\.(?:md|txt|json|ya?ml|csv|xml|svg|css|html?|m?js|ts|log)$/i
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    return value >>> 0
})

function desktop() {
    // Desktop Obsidian provides require; the standalone release tool imports this module as native Node ESM.
    const load = typeof require === 'function' ? require : typeof process !== 'undefined'
        ? (process as typeof process & { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule : undefined
    if (!load) throw new Error('ZIP backups require desktop Obsidian.')
    return {
        fs: load('fs') as typeof import('fs'),
        path: load('path') as typeof import('path'),
        stream: load('stream') as typeof import('stream'),
        zlib: load('zlib') as typeof import('zlib'),
    }
}

function error(message: string): Error {
    return new Error(message)
}

function checkZipCancellation(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Reading cancelled.', 'AbortError')
}

function validNumber(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw error('ZIP size or position exceeds the supported range.')
    return value
}

function u64(buffer: Buffer, offset: number): number {
    return validNumber(buffer.readUInt32LE(offset) + buffer.readUInt32LE(offset + 4) * 0x100000000)
}

function put64(buffer: Buffer, offset: number, value: number): void {
    validNumber(value)
    buffer.writeUInt32LE(value % 0x100000000, offset)
    buffer.writeUInt32LE(Math.floor(value / 0x100000000), offset + 4)
}

function extra64(values: number[]): Buffer {
    if (!values.length) return Buffer.alloc(0)
    const extra = Buffer.alloc(4 + values.length * 8)
    extra.writeUInt16LE(1, 0)
    extra.writeUInt16LE(values.length * 8, 2)
    values.forEach((value, index) => put64(extra, index * 8 + 4, value))
    return extra
}

function updateCrc(crc: number, chunk: Uint8Array): number {
    for (let index = 0; index < chunk.length; index++) {
        crc = crcTable[(crc ^ chunk[index]) & 255] ^ (crc >>> 8)
    }
    return crc
}

function report(onProgress: VaultZipProgressCallback | undefined, phase: VaultZipProgress['phase'],
    total: VaultZipResult) {
    let last = 0
    return (files: number, bytes: number, path?: string, immediate = false) => {
        const now = Date.now()
        if (!onProgress || (!immediate && now - last < 125)) return
        last = now
        onProgress({ phase, files, bytes, totalFiles: total.files, totalBytes: total.bytes, path })
    }
}

function validateName(name: string, directory: boolean): string {
    const clean = directory && name.endsWith('/') ? name.slice(0, -1) : name
    for (const part of clean.split('/')) {
        if (!part || part === '.' || part === '..' || /[\\:<>|"*?\u0000-\u001f\u007f]/.test(part) ||
            /[ .]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i.test(part)) {
            throw error(`ZIP contains a path that cannot be safely restored: ${name}`)
        }
    }
    return clean
}

function comparePathKey(path: string): string {
    return path.normalize('NFC').toLowerCase()
}

function sameFile(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
        left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function isInside(directory: string, target: string, path: typeof import('path')): boolean {
    const relative = path.relative(directory, target)
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function enumerate(root: string, onProgress?: VaultZipProgressCallback,
    include?: VaultZipWriteOptions['include']): Promise<{ candidates: Candidate[]; total: VaultZipResult }> {
    const { fs, path } = desktop()
    const progress = report(onProgress, 'enumerate', { files: 0, bytes: 0 })
    progress(0, 0, undefined, true)
    const candidates: Candidate[] = []
    const pending = [{ relative: '', absolute: root }]
    const names = new Set<string>()
    const total = { files: 0, bytes: 0 }
    while (pending.length) {
        const dir = pending.pop()!
        const rows = await fs.promises.readdir(dir.absolute, { withFileTypes: true })
        rows.sort((left, right) => left.name.localeCompare(right.name, 'en'))
        for (const row of rows) {
            const relative = dir.relative ? `${dir.relative}/${row.name}` : row.name
            if (include && !include(relative, row.isDirectory() || row.isSymbolicLink())) continue
            const diskPath = path.join(dir.absolute, row.name)
            validateName(relative, false)
            const key = comparePathKey(relative)
            if (names.has(key)) throw error(`Conflicting paths in the vault: ${relative}`)
            names.add(key)
            const stat = await fs.promises.lstat(diskPath)
            if (!stat.isFile() && !stat.isDirectory()) throw error(`The vault contains a linked or unsupported file: ${relative}`)
            const directory = stat.isDirectory()
            candidates.push({ path: relative, diskPath, stat, directory })
            if (directory) pending.push({ relative, absolute: diskPath })
            else {
                total.files++
                total.bytes = validNumber(total.bytes + stat.size)
            }
            progress(total.files, total.bytes, relative)
        }
    }
    progress(total.files, total.bytes, undefined, true)
    return { candidates, total }
}

async function writeAt(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
    for (let at = 0; at < buffer.length;) {
        const { bytesWritten } = await file.write(buffer, at, buffer.length - at, position + at)
        if (!bytesWritten) throw error('The ZIP output stopped accepting bytes.')
        at += bytesWritten
    }
}

async function readAt(file: FileHandle, size: number, position: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size)
    for (let at = 0; at < size;) {
        const { bytesRead } = await file.read(buffer, at, size - at, position + at)
        if (!bytesRead) throw error('The ZIP archive ended unexpectedly.')
        at += bytesRead
    }
    return buffer
}

function zipDate(stat: Stats): { time: number; date: number } {
    const mtime = stat.mtime
    const year = Math.min(2107, Math.max(1980, mtime.getFullYear()))
    return {
        time: (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate(),
    }
}

function localHeader(entry: ZipEntry, large: boolean, name: Buffer): Buffer {
    const extra = extra64(large ? [entry.size, entry.compressed] : [])
    const header = Buffer.alloc(30 + name.length + extra.length)
    header.writeUInt32LE(signatures.local, 0)
    header.writeUInt16LE(large ? versions.large : versions.standard, 4)
    header.writeUInt16LE(entry.flags, 6)
    header.writeUInt16LE(entry.method, 8)
    header.writeUInt16LE(entry.time, 10)
    header.writeUInt16LE(entry.date, 12)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(large ? max32 : entry.compressed, 18)
    header.writeUInt32LE(large ? max32 : entry.size, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(extra.length, 28)
    name.copy(header, 30)
    extra.copy(header, 30 + name.length)
    return header
}

function centralHeader(entry: ZipEntry): Buffer {
    const name = Buffer.from(entry.name, 'utf8')
    const largeSize = entry.size >= max32 || entry.compressed >= max32
    const largeOffset = entry.offset >= max32
    const extra = extra64([...(largeSize ? [entry.size, entry.compressed] : []), ...(largeOffset ? [entry.offset] : [])])
    const header = Buffer.alloc(46 + name.length + extra.length)
    const version = extra.length ? versions.large : versions.standard
    header.writeUInt32LE(signatures.central, 0)
    header.writeUInt16LE((3 << 8) | version, 4)
    header.writeUInt16LE(version, 6)
    header.writeUInt16LE(entry.flags, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(entry.time, 12)
    header.writeUInt16LE(entry.date, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(largeSize ? max32 : entry.compressed, 20)
    header.writeUInt32LE(largeSize ? max32 : entry.size, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(extra.length, 30)
    header.writeUInt32LE(entry.directory ? 0x41ed0010 : 0x81a40000, 38)
    header.writeUInt32LE(largeOffset ? max32 : entry.offset, 42)
    name.copy(header, 46)
    extra.copy(header, 46 + name.length)
    return header
}

function endRecords(entries: number, start: number, size: number): Buffer {
    const end = Buffer.alloc(22)
    end.writeUInt32LE(signatures.end, 0)
    const large = entries >= max16 || start >= max32 || size >= max32
    end.writeUInt16LE(Math.min(entries, max16), 8)
    end.writeUInt16LE(Math.min(entries, max16), 10)
    end.writeUInt32LE(Math.min(size, max32), 12)
    end.writeUInt32LE(Math.min(start, max32), 16)
    if (!large) return end
    const zip64 = Buffer.alloc(56)
    zip64.writeUInt32LE(signatures.end64, 0)
    put64(zip64, 4, 44)
    zip64.writeUInt16LE(versions.large, 12)
    zip64.writeUInt16LE(versions.large, 14)
    put64(zip64, 24, entries)
    put64(zip64, 32, entries)
    put64(zip64, 40, size)
    put64(zip64, 48, start)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(signatures.locator, 0)
    put64(locator, 8, start + size)
    locator.writeUInt32LE(1, 16)
    return Buffer.concat([zip64, locator, end])
}

/** Записывает отдельный ZIP и проверяет, что хранилище не изменилось за время создания снимка. */
export async function writeVaultZip(source: string, archive: string, onProgress?: VaultZipProgressCallback,
    options: VaultZipWriteOptions = {}): Promise<VaultZipResult> {
    const { fs, path, stream, zlib } = desktop()
    const root = await fs.promises.realpath(source)
    if (!(await fs.promises.stat(root)).isDirectory()) throw error('The vault path is not a directory.')
    const outputParent = await fs.promises.realpath(path.dirname(archive))
    const target = path.join(outputParent, path.basename(archive))
    if (isInside(root, target, path)) throw error('Choose a backup location outside the vault.')
    const { candidates, total } = await enumerate(root, onProgress, options.include)
    const progress = report(onProgress, 'write', total)
    progress(0, 0, undefined, true)
    const output = await fs.promises.open(target, 'wx', 0o600)
    let successful = false
    let position = 0
    let files = 0
    let bytes = 0
    const entries: ZipEntry[] = []
    try {
        for (const candidate of candidates) {
            const { diskPath, stat, directory } = candidate
            const name = directory ? candidate.path + '/' : candidate.path
            const nameBytes = Buffer.from(name, 'utf8')
            if (nameBytes.length > max16) throw error(`The vault path is too long for ZIP: ${candidate.path}`)
            // Медиа и очень большие файлы сохраняем напрямую. Для Markdown и настроек используем быстрое сжатие Deflate.
            const method = !directory && stat.size > 128 && stat.size < max32 - 16 * 1024 * 1024 &&
                textExtension.test(name) ? deflated : stored
            const entry: ZipEntry = { name, directory, size: directory ? 0 : stat.size, compressed: 0,
                offset: position, method, flags: utf8, crc: 0, ...zipDate(stat) }
            const large = entry.size >= max32
            const provisional = localHeader(entry, large, nameBytes)
            await writeAt(output, provisional, position)
            position += provisional.length
            if (!directory) {
                const input = await fs.promises.open(diskPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
                try {
                    if (!sameFile(stat, await input.stat())) throw error(`File changed during backup: ${candidate.path}`)
                    const start = position
                    let crc = 0xffffffff
                    let length = 0
                    // Читаем объём, зафиксированный при обходе. Последующая проверка метаданных обнаружит уменьшение или рост файла.
                    if (stat.size) {
                        const sourceStream = fs.createReadStream(diskPath, {
                            fd: input.fd, autoClose: false, start: 0, end: stat.size - 1,
                        })
                        const checksum = new stream.Transform({
                            transform(chunk: Buffer, _encoding, callback) {
                                try {
                                    crc = updateCrc(crc, chunk)
                                    length += chunk.length
                                    bytes += chunk.length
                                    progress(files, bytes, candidate.path)
                                    callback(null, chunk)
                                } catch (failure) {
                                    callback(failure instanceof Error ? failure : error(String(failure)))
                                }
                            },
                        })
                        const sink = new stream.Writable({
                            write(chunk: Buffer, _encoding, callback) {
                                void writeAt(output, chunk, position).then(() => {
                                    position += chunk.length
                                    callback()
                                }, callback)
                            },
                        })
                        if (method === deflated) {
                            await stream.promises.pipeline(sourceStream, checksum, zlib.createDeflateRaw({ level: 1 }), sink)
                        } else {
                            await stream.promises.pipeline(sourceStream, checksum, sink)
                        }
                    }
                    if (length !== stat.size || !sameFile(stat, await input.stat())) {
                        throw error(`File changed during backup: ${candidate.path}`)
                    }
                    entry.compressed = validNumber(position - start)
                    entry.crc = (crc ^ 0xffffffff) >>> 0
                    if (entry.compressed >= max32 && !large) throw error('The compressed ZIP entry unexpectedly needs ZIP64.')
                    await writeAt(output, localHeader(entry, large, nameBytes), entry.offset)
                } finally {
                    await input.close()
                }
                files++
                progress(files, bytes, candidate.path)
            }
            entries.push(entry)
        }
        // Заключительный обход выявляет новые файлы и файлы, изменённые после их чтения.
        const after = await enumerate(root, undefined, options.include)
        const original = new Map(candidates.map(candidate => [candidate.path, candidate]))
        if (after.candidates.length !== candidates.length || after.candidates.some(candidate => {
            const initial = original.get(candidate.path)
            return !initial || initial.directory !== candidate.directory || !sameFile(initial.stat, candidate.stat)
        })) throw error('The vault changed during backup. Retry before importing.')
        const centralStart = position
        let headers: Buffer[] = []
        let headerBytes = 0
        const flush = async () => {
            if (!headers.length) return
            await writeAt(output, Buffer.concat(headers, headerBytes), position)
            position += headerBytes
            headers = []
            headerBytes = 0
        }
        for (const entry of entries) {
            const header = centralHeader(entry)
            headers.push(header)
            headerBytes += header.length
            if (headerBytes >= 512 * 1024) await flush()
        }
        await flush()
        await writeAt(output, endRecords(entries.length, centralStart, position - centralStart), position)
        await output.sync()
        progress(files, bytes, undefined, true)
        successful = true
        return total
    } finally {
        await output.close()
        if (!successful) await fs.promises.unlink(target).catch(() => undefined)
    }
}

async function directoryPosition(file: FileHandle, length: number) {
    if (length < 22) throw error('This is not a complete ZIP archive.')
    const tailStart = Math.max(0, length - (22 + max16))
    const tail = await readAt(file, length - tailStart, tailStart)
    for (let index = tail.length - 22; index >= 0; index--) {
        if (tail.readUInt32LE(index) !== signatures.end || index + 22 + tail.readUInt16LE(index + 20) !== tail.length) continue
        if (tail.readUInt16LE(index + 4) || tail.readUInt16LE(index + 6) ||
            tail.readUInt16LE(index + 8) !== tail.readUInt16LE(index + 10)) throw error('Multi-disk ZIP archives are unsupported.')
        let entries = tail.readUInt16LE(index + 10)
        let size = tail.readUInt32LE(index + 12)
        let start = tail.readUInt32LE(index + 16)
        let end = tailStart + index
        if (entries === max16 || size === max32 || start === max32) {
            if (end < 20) throw error('The ZIP64 locator is missing.')
            const locator = await readAt(file, 20, end - 20)
            if (locator.readUInt32LE(0) !== signatures.locator ||
                locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) throw error('The ZIP64 locator is invalid.')
            const start64 = u64(locator, 8)
            if (start64 > end - 20 - 56) throw error('The ZIP64 directory is truncated.')
            const zip64 = await readAt(file, 56, start64)
            if (zip64.readUInt32LE(0) !== signatures.end64 || u64(zip64, 4) < 44 ||
                start64 + 12 + u64(zip64, 4) !== end - 20 || zip64.readUInt32LE(16) ||
                zip64.readUInt32LE(20) || u64(zip64, 24) !== u64(zip64, 32)) throw error('The ZIP64 directory is invalid.')
            entries = u64(zip64, 32)
            size = u64(zip64, 40)
            start = u64(zip64, 48)
            end = start64
        }
        if (start + size !== end || entries > 1_000_000 || size > 128 * 1024 * 1024 || entries * 46 > size) {
            throw error('The ZIP directory is invalid or too large to check.')
        }
        return { entries, size, start }
    }
    throw error('The ZIP directory is missing or incomplete.')
}

function readZip64Extra(extra: Buffer): Buffer {
    for (let offset = 0; offset + 4 <= extra.length;) {
        const length = extra.readUInt16LE(offset + 2)
        if (offset + 4 + length > extra.length) break
        if (extra.readUInt16LE(offset) === 1) return extra.subarray(offset + 4, offset + 4 + length)
        offset += 4 + length
    }
    throw error('A large ZIP entry has no ZIP64 sizes.')
}

function readSizes(extra: Buffer, size: number, compressed: number, offset: number) {
    if (size !== max32 && compressed !== max32 && offset !== max32) return { size, compressed, offset }
    const values = readZip64Extra(extra)
    let index = 0
    const next = () => {
        if (index + 8 > values.length) throw error('A ZIP64 entry is truncated.')
        const value = u64(values, index)
        index += 8
        return value
    }
    return {
        size: size === max32 ? next() : size,
        compressed: compressed === max32 ? next() : compressed,
        offset: offset === max32 ? next() : offset,
    }
}

type CheckedEntry = ZipEntry & { safeName: string; dataStart: number }

async function checkedDirectory(file: FileHandle, length: number, onProgress?: VaultZipProgressCallback,
    options: VaultZipReadOptions = {}) {
    const central = await directoryPosition(file, length)
    checkZipCancellation(options.signal)
    if (options.maxFiles !== undefined && central.entries > options.maxFiles) throw error('The ZIP contains too many entries to import.')
    const directory = await readAt(file, central.size, central.start)
    const progress = report(onProgress, 'enumerate', { files: central.entries, bytes: 0 })
    progress(0, 0, undefined, true)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const names = new Map<string, CheckedEntry>()
    const entries: CheckedEntry[] = []
    let total = { files: 0, bytes: 0 }
    let cursor = 0
    for (let index = 0; index < central.entries; index++) {
        checkZipCancellation(options.signal)
        if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== signatures.central) {
            throw error('The ZIP directory contains an invalid entry.')
        }
        const flags = directory.readUInt16LE(cursor + 8)
        const method = directory.readUInt16LE(cursor + 10)
        const time = directory.readUInt16LE(cursor + 12)
        const date = directory.readUInt16LE(cursor + 14)
        const crc = directory.readUInt32LE(cursor + 16)
        const nameLength = directory.readUInt16LE(cursor + 28)
        const extraLength = directory.readUInt16LE(cursor + 30)
        const commentLength = directory.readUInt16LE(cursor + 32)
        const nameOffset = cursor + 46
        const extraOffset = nameOffset + nameLength
        const next = extraOffset + extraLength + commentLength
        if (flags & ~(utf8 | 8 | 6) || (method !== stored && method !== deflated) ||
            directory.readUInt16LE(cursor + 34) || !nameLength || next > directory.length) {
            throw error('The ZIP contains an encrypted, multi-disk or unsupported entry.')
        }
        const nameBytes = directory.subarray(nameOffset, extraOffset)
        const name = decoder.decode(nameBytes)
        const attrs = directory.readUInt32LE(cursor + 38)
        const system = directory.readUInt8(cursor + 5)
        const unixType = system === 3 || system === 19 ? (attrs >>> 16) & 0xf000 : 0
        if (unixType && unixType !== 0x4000 && unixType !== 0x8000) throw error('ZIP links and special files are unsupported.')
        const isDirectory = name.endsWith('/') || unixType === 0x4000 || Boolean(attrs & 0x10)
        const safeName = validateName(name, isDirectory)
        const key = comparePathKey(safeName)
        if (names.has(key)) throw error(`ZIP contains conflicting paths: ${safeName}`)
        const { size, compressed, offset } = readSizes(directory.subarray(extraOffset, extraOffset + extraLength),
            directory.readUInt32LE(cursor + 24), directory.readUInt32LE(cursor + 20), directory.readUInt32LE(cursor + 42))
        if (options.maxEntryBytes !== undefined && size > options.maxEntryBytes) throw error(`The ZIP entry is too large to import: ${safeName}`)
        if ((isDirectory && (size !== 0 || crc !== 0)) || (method === stored && compressed !== size) ||
            offset > central.start - 30) throw error(`Invalid sizes in ZIP entry: ${safeName}`)
        cursor = next

        const local = await readAt(file, 30, offset)
        const localNameLength = local.readUInt16LE(26)
        const dataStart = offset + 30 + localNameLength + local.readUInt16LE(28)
        if (local.readUInt32LE(0) !== signatures.local || local.readUInt16LE(6) !== flags ||
            local.readUInt16LE(8) !== method || localNameLength !== nameLength ||
            dataStart + compressed > central.start ||
            !nameBytes.equals(await readAt(file, localNameLength, offset + 30))) {
            throw error(`Local header does not match the ZIP directory: ${safeName}`)
        }
        const entry = { name, safeName, directory: isDirectory, size, compressed, offset, dataStart, flags, method, crc, time, date }
        names.set(key, entry)
        entries.push(entry)
        if (!isDirectory) total = { files: total.files + 1, bytes: validNumber(total.bytes + size) }
        if (options.maxTotalBytes !== undefined && total.bytes > options.maxTotalBytes) throw error('The ZIP expands beyond the supported import size.')
        progress(index + 1, 0, safeName)
    }
    if (cursor !== directory.length) throw error('The ZIP directory has unexpected trailing records.')
    // Учитываем неявные родительские каталоги, поскольку некоторые ZIP-архиваторы опускают записи о папках.
    const directories = new Map<string, string>()
    for (const entry of entries) if (entry.directory) directories.set(comparePathKey(entry.safeName), entry.safeName)
    for (const entry of entries) {
        const name = entry.safeName
        for (let index = name.indexOf('/'); index >= 0; index = name.indexOf('/', index + 1)) {
            const directory = name.slice(0, index)
            const key = comparePathKey(directory)
            const ancestor = names.get(key)
            const known = directories.get(key)
            if ((ancestor && !ancestor.directory) || (known && known !== directory)) {
                throw error(`Conflicting directory name in the ZIP archive: ${entry.safeName}`)
            }
            directories.set(key, directory)
        }
    }
    const ordered = [...entries].sort((left, right) => left.offset - right.offset)
    for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1]
        if (ordered[index].offset < previous.dataStart + previous.compressed) {
            throw error('The ZIP archive contains overlapping file data.')
        }
    }
    return { entries, total }
}

function restoredTime(entry: ZipEntry): Date {
    const day = entry.date & 31
    const month = (entry.date >>> 5) & 15
    return day && month ? new Date((entry.date >>> 9) + 1980, month - 1, day,
        entry.time >>> 11, (entry.time >>> 5) & 63, (entry.time & 31) * 2) : new Date()
}

async function readArchive(archive: string, destination: string | undefined,
    onProgress?: VaultZipProgressCallback, options: VaultZipReadOptions = {}): Promise<VaultZipResult> {
    const { fs, path, stream, zlib } = desktop()
    const realArchive = await fs.promises.realpath(archive)
    const file = await fs.promises.open(realArchive, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    let target: string | undefined
    let targetStat: Stats | undefined
    let successful = false
    try {
        const stat = await file.stat()
        if (!stat.isFile()) throw error('Choose a ZIP file.')
        const phase = destination === undefined ? 'verify' : 'restore'
        const { entries, total } = await checkedDirectory(file, stat.size, onProgress, options)
        checkZipCancellation(options.signal)
        if (destination !== undefined) {
            const parent = await fs.promises.realpath(path.dirname(destination))
            const newRoot = path.join(parent, path.basename(destination))
            await fs.promises.mkdir(newRoot, { mode: 0o700 })
            target = newRoot
            targetStat = await fs.promises.lstat(target)
        }
        const progress = report(onProgress, phase, total)
        progress(0, 0, undefined, true)
        let files = 0
        let bytes = 0
        for (const entry of entries) {
            checkZipCancellation(options.signal)
            const outputPath = target && path.join(target, ...entry.safeName.split('/'))
            if (entry.directory && outputPath) await fs.promises.mkdir(outputPath, { recursive: true, mode: 0o700 })
            else if (outputPath) await fs.promises.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })

            let expanded = 0
            let crc = 0xffffffff
            const output = outputPath && !entry.directory
                ? await fs.promises.open(outputPath, 'wx', 0o600) : undefined
            try {
                if (entry.compressed) {
                    const source = fs.createReadStream(realArchive, {
                        fd: file.fd, autoClose: false, start: entry.dataStart, end: entry.dataStart + entry.compressed - 1,
                    })
                    const sink = new stream.Writable({
                        write(chunk: Buffer, _encoding, callback) {
                            try {
                                checkZipCancellation(options.signal)
                                const position = expanded
                                expanded += chunk.length
                                if (expanded > entry.size) throw error(`ZIP entry exceeded its declared size: ${entry.safeName}`)
                                crc = updateCrc(crc, chunk)
                                bytes += chunk.length
                                progress(files, bytes, entry.safeName)
                                if (output) void writeAt(output, chunk, position).then(() => callback(), callback)
                                else callback()
                            } catch (failure) {
                                callback(failure instanceof Error ? failure : error(String(failure)))
                            }
                        },
                    })
                    if (entry.method === deflated) await stream.promises.pipeline(source, zlib.createInflateRaw(), sink, { signal: options.signal })
                    else await stream.promises.pipeline(source, sink, { signal: options.signal })
                }
                if (expanded !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
                    throw error(`ZIP checksum or length mismatch: ${entry.safeName}`)
                }
            } finally {
                await output?.close()
            }
            if (!entry.directory) {
                if (outputPath) {
                    const modified = restoredTime(entry)
                    await fs.promises.utimes(outputPath, modified, modified)
                }
                progress(++files, bytes, entry.safeName)
            }
        }
        if (!sameFile(stat, await file.stat())) throw error('The ZIP changed during verification or restoration.')
        if (target) for (const entry of [...entries].reverse()) {
            if (entry.directory) {
                const modified = restoredTime(entry)
                await fs.promises.utimes(path.join(target, ...entry.safeName.split('/')), modified, modified)
            }
        }
        successful = true
        progress(files, bytes, undefined, true)
        return total
    } finally {
        await file.close()
        if (!successful && target && targetStat) {
            const actual = await fs.promises.lstat(target).catch(() => undefined)
            if (actual?.isDirectory() && actual.dev === targetStat.dev && actual.ino === targetStat.ino) {
                await fs.promises.rm(target, { recursive: true, force: true })
            }
        }
    }
}

/** Читает и проверяет заголовки и контрольные суммы всех файлов без создания хранилища. */
export function verifyVaultZip(archive: string, onProgress?: VaultZipProgressCallback,
    options?: VaultZipReadOptions): Promise<VaultZipResult> {
    return readArchive(archive, undefined, onProgress, options)
}

/** Распаковывает в новую соседнюю или выбранную папку. Существующие каталоги сохраняются. */
export function restoreVaultZip(archive: string, newDirectory: string,
    onProgress?: VaultZipProgressCallback, options?: VaultZipReadOptions): Promise<VaultZipResult> {
    return readArchive(archive, newDirectory, onProgress, options)
}
