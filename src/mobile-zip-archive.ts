/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
export interface MobileZipProgress {
    phase: string
    files: number
    bytes: number
    totalFiles: number
    totalBytes: number
    path?: string
}

export interface MobileZipEntry {
    path: string
    size: number
    hash: string
    markdown: boolean
}

export interface MobileZipArchive {
    readonly name: string
    readonly token: string
    readonly files: readonly MobileZipEntry[]
    readonly prefixes: readonly string[]
    readonly metadataPaths: readonly string[]
    readonly ignoredFiles: number
    readonly disposed: boolean
    read(path: string): Promise<Uint8Array>
    readMetadata(path: string): Promise<Uint8Array | undefined>
    dispose(): Promise<void>
}

export interface MobileZipFile { path: string; bytes: Uint8Array }

export const mobileZipLimits = Object.freeze({
    archiveBytes: 64 * 1024 * 1024,
    totalBytes: 128 * 1024 * 1024,
    entryBytes: 16 * 1024 * 1024,
    markdownBytes: 4 * 1024 * 1024,
    metadataBytes: 128 * 1024,
    directoryBytes: 8 * 1024 * 1024,
    files: 50_000,
})

type Progress = (progress: MobileZipProgress) => void
type CheckedEntry = { path: string; size: number; compressed: number; offset: number; dataStart: number;
    method: number; flags: number; crc: number; directory: boolean }
type Inflater = new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
const utf8 = 0x0800
const max32 = 0xffffffff
const max16 = 0xffff
const signatures = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, end64: 0x06064b50, locator: 0x07064b50 }
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)
    return value >>> 0
})

function problem(english: string, russian: string): Error { return new Error(`${english} / ${russian}`) }
function abort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
}
function pathKey(path: string): string { return path.normalize('NFC').toLowerCase() }
function pause(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)) }

function report(progress: Progress | undefined, phase: string, files: number, bytes: number,
    totalFiles: number, totalBytes: number, path?: string): void {
    progress?.({ phase, files, bytes, totalFiles, totalBytes, path })
}

export function validateMobileZipPath(name: string, directory = false): string {
    const clean = directory && name.endsWith('/') ? name.slice(0, -1) : name
    if (encoder.encode(clean).length > 4096 || clean.split('/').some(part => !part || part === '.' || part === '..' ||
        /[\\:<>|"*?\x00-\x1f\x7f]/u.test(part) || /[ .]$/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(part))) {
        throw problem(`Unsafe ZIP path: ${name}`, `Недопустимый путь в ZIP: ${name}`)
    }
    return clean
}

export function isSupportedMobileZipPath(path: string): boolean {
    return !path.split('/').some(part => part.startsWith('.') || part === '__MACOSX') &&
        /\.(?:md|jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif|apng|mp3|wav|ogg|opus|m4a|aac|flac|mp4|webm|mov|pdf)$/iu.test(path)
}
export const isSupportedMobilePath = isSupportedMobileZipPath

function metadata(path: string): boolean {
    return !path.split('/').some(part => part.startsWith('.') || part === '__MACOSX') &&
        /(?:^|\/)rupos-transfer\.json$/u.test(path)
}

export async function mobileSha256(bytes: Uint8Array): Promise<string> {
    if (!globalThis.crypto?.subtle) throw problem('This device has no Web Crypto API.', 'На устройстве недоступен Web Crypto API.')
    const input = new Uint8Array(bytes.byteLength)
    input.set(bytes)
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input.buffer))
    return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('')
}

function token(): string {
    if (!globalThis.crypto?.getRandomValues) throw problem('Secure random values are unavailable.', 'Недоступен защищённый генератор идентификаторов.')
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
}

function number64(view: DataView, offset: number): number {
    if (offset < 0 || offset + 8 > view.byteLength) throw problem('Truncated ZIP64 record.', 'Обрезана запись ZIP64.')
    const result = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000
    if (!Number.isSafeInteger(result)) throw problem('ZIP position exceeds the supported range.', 'Позиция ZIP превышает допустимый диапазон.')
    return result
}

async function readAt(source: Blob, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > source.size) {
        throw problem('Truncated ZIP archive.', 'ZIP-архив обрезан.')
    }
    return new Uint8Array(await source.slice(offset, offset + length).arrayBuffer())
}

function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

async function directory(source: Blob): Promise<{ start: number; size: number; count: number }> {
    if (source.size < 22) throw problem('Incomplete ZIP archive.', 'Неполный ZIP-архив.')
    const tailStart = Math.max(0, source.size - 22 - max16)
    const tail = await readAt(source, tailStart, source.size - tailStart)
    const data = view(tail)
    for (let index = tail.length - 22; index >= 0; index--) {
        if (data.getUint32(index, true) !== signatures.end || index + 22 + data.getUint16(index + 20, true) !== tail.length) continue
        if (data.getUint16(index + 4, true) || data.getUint16(index + 6, true) ||
            data.getUint16(index + 8, true) !== data.getUint16(index + 10, true)) {
            throw problem('Multi-disk ZIP is unsupported.', 'Многотомный ZIP не поддерживается.')
        }
        let count = data.getUint16(index + 10, true)
        let size = data.getUint32(index + 12, true)
        let start = data.getUint32(index + 16, true)
        let end = tailStart + index
        if (count === max16 || size === max32 || start === max32) {
            const locator = view(await readAt(source, end - 20, 20))
            if (locator.getUint32(0, true) !== signatures.locator || locator.getUint32(4, true) || locator.getUint32(16, true) !== 1) {
                throw problem('Invalid ZIP64 locator.', 'Некорректный указатель ZIP64.')
            }
            const offset = number64(locator, 8)
            const record = view(await readAt(source, offset, 56))
            if (record.getUint32(0, true) !== signatures.end64 || number64(record, 4) < 44 ||
                offset + 12 + number64(record, 4) !== end - 20 || record.getUint32(16, true) ||
                record.getUint32(20, true) || number64(record, 24) !== number64(record, 32)) {
                throw problem('Invalid ZIP64 directory.', 'Некорректный каталог ZIP64.')
            }
            count = number64(record, 32)
            size = number64(record, 40)
            start = number64(record, 48)
            end = offset
        }
        if (count > mobileZipLimits.files || size > mobileZipLimits.directoryBytes || start + size !== end || count * 46 > size) {
            throw problem('The ZIP directory exceeds the mobile limits or is invalid.', 'Каталог ZIP повреждён или превышает мобильные ограничения.')
        }
        return { start, size, count }
    }
    throw problem('The ZIP directory was not found.', 'Каталог ZIP не найден.')
}

function zip64Sizes(extra: Uint8Array, size: number, compressed: number, offset: number): { size: number; compressed: number; offset: number } {
    if (size !== max32 && compressed !== max32 && offset !== max32) return { size, compressed, offset }
    const data = view(extra)
    for (let at = 0; at + 4 <= extra.length;) {
        const length = data.getUint16(at + 2, true)
        if (at + 4 + length > extra.length) break
        if (data.getUint16(at, true) === 1) {
            const values = new DataView(extra.buffer, extra.byteOffset + at + 4, length)
            let cursor = 0
            const next = () => { const result = number64(values, cursor); cursor += 8; return result }
            return { size: size === max32 ? next() : size, compressed: compressed === max32 ? next() : compressed,
                offset: offset === max32 ? next() : offset }
        }
        at += 4 + length
    }
    throw problem('The ZIP64 entry sizes are missing.', 'В записи ZIP64 отсутствуют размеры.')
}

async function checkedEntries(source: Blob, progress?: Progress, signal?: AbortSignal): Promise<{ entries: CheckedEntry[]; total: number }> {
    const central = await directory(source)
    const bytes = await readAt(source, central.start, central.size)
    const data = view(bytes)
    const entries: CheckedEntry[] = []
    const names = new Map<string, CheckedEntry>()
    let cursor = 0
    let total = 0
    for (let index = 0; index < central.count; index++) {
        abort(signal)
        if (cursor + 46 > bytes.length || data.getUint32(cursor, true) !== signatures.central) {
            throw problem('Invalid ZIP directory entry.', 'Некорректная запись каталога ZIP.')
        }
        const flags = data.getUint16(cursor + 8, true)
        const method = data.getUint16(cursor + 10, true)
        const length = data.getUint16(cursor + 28, true)
        const extraLength = data.getUint16(cursor + 30, true)
        const next = cursor + 46 + length + extraLength + data.getUint16(cursor + 32, true)
        if (flags & ~(utf8 | 8 | 6) || ![0, 8].includes(method) || !length || next > bytes.length || data.getUint16(cursor + 34, true)) {
            throw problem('Encrypted or unsupported ZIP entry.', 'ZIP содержит зашифрованную или неподдерживаемую запись.')
        }
        const filename = bytes.subarray(cursor + 46, cursor + 46 + length)
        let name: string
        try { name = decoder.decode(filename) } catch { throw problem('ZIP names must be UTF-8.', 'Имена файлов ZIP должны использовать UTF-8.') }
        const attrs = data.getUint32(cursor + 38, true)
        const system = data.getUint8(cursor + 5)
        const unixType = [3, 19].includes(system) ? attrs >>> 16 & 0xf000 : 0
        if (unixType && unixType !== 0x4000 && unixType !== 0x8000) throw problem('ZIP links are unsupported.', 'Ссылки и специальные файлы ZIP не поддерживаются.')
        const isDirectory = name.endsWith('/') || unixType === 0x4000 || Boolean(attrs & 0x10)
        const path = validateMobileZipPath(name, isDirectory)
        if (names.has(pathKey(path))) throw problem(`Conflicting ZIP paths: ${path}`, `Конфликтующие пути в ZIP: ${path}`)
        const sizes = zip64Sizes(bytes.subarray(cursor + 46 + length, cursor + 46 + length + extraLength),
            data.getUint32(cursor + 24, true), data.getUint32(cursor + 20, true), data.getUint32(cursor + 42, true))
        const crc = data.getUint32(cursor + 16, true)
        if (sizes.size > mobileZipLimits.entryBytes || sizes.compressed > mobileZipLimits.archiveBytes ||
            isDirectory && (sizes.size !== 0 || crc !== 0) || method === 0 && sizes.compressed !== sizes.size || sizes.offset > central.start - 30) {
            throw problem(`Invalid or oversized ZIP entry: ${path}`, `Неверный размер записи ZIP: ${path}`)
        }
        total += sizes.size
        if (total > mobileZipLimits.totalBytes) throw problem('Expanded ZIP exceeds 128 MiB.', 'Распакованный ZIP превышает 128 МиБ.')
        const localBytes = await readAt(source, sizes.offset, 30 + length)
        const local = view(localBytes)
        const start = sizes.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true)
        if (local.getUint32(0, true) !== signatures.local || local.getUint16(6, true) !== flags || local.getUint16(8, true) !== method ||
            local.getUint16(26, true) !== length || start + sizes.compressed > central.start ||
            !sameBytes(filename, localBytes.subarray(30))) {
            throw problem(`ZIP header mismatch: ${path}`, `Заголовок ZIP расходится с каталогом: ${path}`)
        }
        const entry: CheckedEntry = { path, ...sizes, dataStart: start, crc, method, flags, directory: isDirectory }
        entries.push(entry)
        names.set(pathKey(path), entry)
        cursor = next
        report(progress, 'enumerate', index + 1, 0, central.count, total, path)
        if (index % 64 === 0) await pause()
    }
    if (cursor !== bytes.length) throw problem('Unexpected ZIP directory records.', 'Лишние записи в каталоге ZIP.')
    const parents = new Map<string, string>()
    for (const entry of entries) if (entry.directory) parents.set(pathKey(entry.path), entry.path)
    for (const entry of entries) for (let slash = entry.path.indexOf('/'); slash >= 0; slash = entry.path.indexOf('/', slash + 1)) {
        const parent = entry.path.slice(0, slash)
        const key = pathKey(parent)
        if (names.get(key) && !names.get(key)!.directory || parents.has(key) && parents.get(key) !== parent) {
            throw problem(`Conflicting ZIP folder: ${entry.path}`, `Конфликтующая папка в ZIP: ${entry.path}`)
        }
        parents.set(key, parent)
    }
    const ordered = [...entries].sort((left, right) => left.offset - right.offset)
    for (let index = 1; index < ordered.length; index++) if (ordered[index].offset < ordered[index - 1].dataStart + ordered[index - 1].compressed) {
        throw problem('Overlapping ZIP entries.', 'Записи ZIP перекрываются.')
    }
    return { entries, total }
}

async function crc32(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    let crc = 0xffffffff
    for (let start = 0; start < bytes.length; start += 1024 * 1024) {
        abort(signal)
        const limit = Math.min(bytes.length, start + 1024 * 1024)
        for (let index = start; index < limit; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ crc >>> 8
        if (limit < bytes.length) await pause()
    }
    return (crc ^ 0xffffffff) >>> 0
}

async function expand(source: Blob, entry: CheckedEntry, signal?: AbortSignal): Promise<Uint8Array> {
    abort(signal)
    const part = source.slice(entry.dataStart, entry.dataStart + entry.compressed)
    let result: Uint8Array
    if (entry.method === 0) result = new Uint8Array(await part.arrayBuffer())
    else {
        const Inflate = (globalThis as unknown as { DecompressionStream?: Inflater }).DecompressionStream
        if (!Inflate) throw problem('This Android WebView cannot read compressed ZIP files. Use an uncompressed ZIP or update Android System WebView.',
            'Этот Android WebView не умеет читать сжатый ZIP. Используйте ZIP без сжатия или обновите Android System WebView.')
        let transform: InstanceType<Inflater>
        try { transform = new Inflate('deflate-raw') } catch {
            throw problem('This WebView cannot decompress raw DEFLATE. Update Android System WebView or use an uncompressed ZIP.',
                'WebView не поддерживает raw DEFLATE. Обновите Android System WebView или используйте ZIP без сжатия.')
        }
        const reader = part.stream().pipeThrough(transform).getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
            while (true) {
                abort(signal)
                const chunk = await reader.read()
                if (chunk.done) break
                size += chunk.value.length
                if (size > entry.size) throw problem(`ZIP entry exceeds its declared size: ${entry.path}`, `Запись ZIP превысила объявленный размер: ${entry.path}`)
                chunks.push(chunk.value)
            }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
        result = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
    }
    if (result.length !== entry.size || await crc32(result, signal) !== entry.crc) {
        throw problem(`ZIP checksum mismatch: ${entry.path}`, `Не совпала контрольная сумма ZIP: ${entry.path}`)
    }
    abort(signal)
    return result
}

/** Файл остаётся в Blob. В памяти находится содержимое только одной проверяемой записи. */
export async function prepareMobileZip(input: Blob | Uint8Array, progress?: Progress, signal?: AbortSignal): Promise<MobileZipArchive> {
    abort(signal)
    if (input instanceof Uint8Array && input.byteLength > mobileZipLimits.archiveBytes) {
        throw problem('Choose a ZIP no larger than 64 MiB.', 'Выберите ZIP размером не более 64 МиБ.')
    }
    let source: Blob | undefined = input instanceof Uint8Array ? new Blob([new Uint8Array(input).buffer]) : input
    if (!source || typeof source.slice !== 'function' || source.size > mobileZipLimits.archiveBytes) {
        throw problem('Choose a ZIP no larger than 64 MiB.', 'Выберите ZIP размером не более 64 МиБ.')
    }
    const named = source as Blob & { name?: unknown }
    const archiveName = typeof named.name === 'string' ? named.name : 'Archive.zip'
    const checked = await checkedEntries(source, progress, signal)
    const files: MobileZipEntry[] = []
    const map = new Map<string, { checked: CheckedEntry; hash: string }>()
    const metadataPaths: string[] = []
    const prefixes = new Set([''])
    let bytes = 0
    let ignoredFiles = 0
    for (const entry of checked.entries) {
        abort(signal)
        if (entry.directory) continue
        if (!isSupportedMobileZipPath(entry.path) && !metadata(entry.path)) { ignoredFiles++; continue }
        const markdown = /\.md$/iu.test(entry.path)
        if (markdown && entry.size > mobileZipLimits.markdownBytes || metadata(entry.path) && entry.size > mobileZipLimits.metadataBytes) {
            throw problem(`Text entry exceeds the mobile size limit: ${entry.path}`, `Текстовый файл превышает мобильный предел: ${entry.path}`)
        }
        const data = await expand(source, entry, signal)
        if (markdown || metadata(entry.path)) {
            let text: string
            try { text = decoder.decode(data) } catch { throw problem(`ZIP text must be UTF-8: ${entry.path}`, `Текст ZIP должен быть в UTF-8: ${entry.path}`) }
            if (text.includes('\0')) throw problem(`ZIP text contains a NUL character: ${entry.path}`, `Текст ZIP содержит нулевой символ: ${entry.path}`)
        }
        const hash = await mobileSha256(data)
        abort(signal)
        map.set(entry.path, { checked: entry, hash })
        if (metadata(entry.path)) metadataPaths.push(entry.path)
        else {
            files.push(Object.freeze({ path: entry.path, size: entry.size, hash, markdown }))
            for (let slash = entry.path.indexOf('/'); slash >= 0; slash = entry.path.indexOf('/', slash + 1)) prefixes.add(entry.path.slice(0, slash))
        }
        bytes += entry.size
        report(progress, 'read', files.length, bytes, checked.entries.length, checked.total, entry.path)
        if (files.length % 32 === 0) await pause()
    }
    if (!files.length) throw problem('The ZIP contains no supported notes or attachments.', 'ZIP не содержит поддерживаемых заметок и вложений.')
    let disposed = false
    const read = async (path: string): Promise<Uint8Array> => {
        const entry = map.get(path)
        if (disposed || !source || !entry) throw problem('Reopen the ZIP before reading this file.', 'Откройте ZIP заново перед чтением файла.')
        const data = await expand(source, entry.checked)
        const actualHash = await mobileSha256(data)
        if (disposed || actualHash !== entry.hash) throw problem('The archive content changed or was closed.', 'Содержимое архива изменилось или архив был закрыт.')
        return data
    }
    abort(signal)
    return Object.freeze({
        name: archiveName, token: token(), files: Object.freeze(files), prefixes: Object.freeze([...prefixes].sort()),
        metadataPaths: Object.freeze(metadataPaths), ignoredFiles,
        get disposed() { return disposed },
        read,
        async readMetadata(path: string) { return metadataPaths.includes(path) ? read(path) : undefined },
        async dispose() { disposed = true; source = undefined; map.clear() },
    })
}

function join(parts: readonly Uint8Array[], total: number): Uint8Array {
    const result = new Uint8Array(total)
    let offset = 0
    for (const part of parts) { result.set(part, offset); offset += part.length }
    return result
}

function dated(view: DataView, at: number): void {
    const now = new Date()
    const year = Math.min(2107, Math.max(1980, now.getFullYear()))
    view.setUint16(at, now.getHours() << 11 | now.getMinutes() << 5 | Math.floor(now.getSeconds() / 2), true)
    view.setUint16(at + 2, (year - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate(), true)
}

/** Запись без сжатия совместима с настольным ZIP. Размер результата ограничен до объединения буферов. */
export async function buildMobileZip(input: AsyncIterable<MobileZipFile> | Iterable<MobileZipFile>, progress?: Progress,
    signal?: AbortSignal): Promise<Uint8Array> {
    const body: Uint8Array[] = []
    const directory: Uint8Array[] = []
    const paths = new Set<string>()
    const parents = new Map<string, string>()
    let position = 0
    let centralBytes = 0
    let count = 0
    for await (const file of input) {
        abort(signal)
        const path = validateMobileZipPath(file.path)
        if (paths.has(pathKey(path)) || parents.has(pathKey(path))) throw problem(`Duplicate ZIP path: ${path}`, `Повтор пути в ZIP: ${path}`)
        for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
            const parent = path.slice(0, slash)
            if (paths.has(pathKey(parent)) || parents.has(pathKey(parent)) && parents.get(pathKey(parent)) !== parent) {
                throw problem(`File conflicts with a ZIP folder: ${path}`, `Файл конфликтует с папкой ZIP: ${path}`)
            }
            parents.set(pathKey(parent), parent)
        }
        const name = encoder.encode(path)
        const limit = /\.md$/iu.test(path) ? mobileZipLimits.markdownBytes : metadata(path) ? mobileZipLimits.metadataBytes : mobileZipLimits.entryBytes
        if (file.bytes.length > limit || ++count > mobileZipLimits.files) throw problem('Split this transfer into smaller packages.', 'Разделите перенос на меньшие пакеты.')
        const nextLength = position + 30 + name.length + file.bytes.length
        centralBytes += 46 + name.length
        if (nextLength + centralBytes + 22 > mobileZipLimits.archiveBytes || centralBytes > mobileZipLimits.directoryBytes) {
            throw problem('The phone ZIP exceeds the mobile size limits. Choose fewer files.', 'ZIP телефона превышает мобильные ограничения размера. Выберите меньше файлов.')
        }
        const bytes = new Uint8Array(file.bytes)
        const crc = await crc32(bytes, signal)
        const header = new Uint8Array(30 + name.length)
        const local = view(header)
        local.setUint32(0, signatures.local, true)
        local.setUint16(4, 20, true)
        local.setUint16(6, utf8, true)
        dated(local, 10)
        local.setUint32(14, crc, true)
        local.setUint32(18, bytes.length, true)
        local.setUint32(22, bytes.length, true)
        local.setUint16(26, name.length, true)
        header.set(name, 30)
        const central = new Uint8Array(46 + name.length)
        const record = view(central)
        record.setUint32(0, signatures.central, true)
        record.setUint16(4, 20, true)
        record.setUint16(6, 20, true)
        record.setUint16(8, utf8, true)
        record.setUint16(12, local.getUint16(10, true), true)
        record.setUint16(14, local.getUint16(12, true), true)
        record.setUint32(16, crc, true)
        record.setUint32(20, bytes.length, true)
        record.setUint32(24, bytes.length, true)
        record.setUint16(28, name.length, true)
        record.setUint32(42, position, true)
        central.set(name, 46)
        body.push(header, bytes)
        directory.push(central)
        position = nextLength
        paths.add(pathKey(path))
        report(progress, 'write', count, position, count, position + centralBytes + 22, path)
        if (count % 32 === 0) await pause()
    }
    abort(signal)
    const end = new Uint8Array(22)
    const tail = view(end)
    tail.setUint32(0, signatures.end, true)
    tail.setUint16(8, count, true)
    tail.setUint16(10, count, true)
    tail.setUint32(12, centralBytes, true)
    tail.setUint32(16, position, true)
    const result = join([...body, ...directory, end], position + centralBytes + 22)
    report(progress, 'complete', count, result.length, count, result.length)
    return result
}
