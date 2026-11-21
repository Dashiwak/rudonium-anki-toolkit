/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import type MyPlugin from '../main'
import type { TFile } from 'obsidian'
import { withFastScanReadLock } from './fast-scan'
import { findIdMarkers } from './duplicate-markers'
import { sameEditorText } from './markdown-pipeline'
import { uiFor } from './interface-language'
import { prepareZipImportArchive } from './zip-import-archive'
import type { ZipImportArchive, ZipImportProgress } from './zip-import-archive'
import { readTransferBaseline } from './zip-transfer-package'

export type { ZipImportArchive, ZipImportProgress } from './zip-import-archive'

export interface ZipImportRow {
    path: string
    archivePath: string
    status: 'new' | 'same' | 'different' | 'already-imported' | 'blocked'
    reason?: string
    markdown: boolean
    size: number
    archiveText?: string
    currentText?: string
    changeOrigin?: 'phone' | 'desktop' | 'both'
}

export interface ZipImportPlan {
    id: string
    archive: ZipImportArchive
    options: { prefix: string; target: string }
    rows: ZipImportRow[]
    baselineReason?: string
}

export interface ZipImportResult {
    paths: string[]
    markdownPaths: string[]
    backupPath: string
}

type Progress = (progress: ZipImportProgress) => void
type RecordItem = { path: string; hash: string; transaction: string }
type Receipts = { version: 1; root: string; entries: Record<string, RecordItem> }
type Before = { hash: string | null; ids: number[] }
type CheckedRow = { sourceHash: string; before: Before; ids: number[]; archivePath: string; markdown: boolean; allowed: boolean }
type StoredPlan = { plugin: MyPlugin; root: string; settings: string; rows: Map<string, CheckedRow> }
type JournalEntry = { path: string; before: string | null; after: string; markdown: boolean; sourceHash: string }
type Journal = { version: 1; id: string; root: string; entries: JournalEntry[]; status: 'pending' | 'committed' | 'restored' }

const plans = new WeakMap<ZipImportPlan, StoredPlan>()
const pendingName = 'pending.json'
const receiptsName = 'receipts.json'
const digestPattern = /^[0-9a-f]{64}$/u
const transactionPattern = /^[0-9a-f-]{36}$/u
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const textPreviewBudget = 8 * 1024 * 1024
const previewFileLimit = 256 * 1024
const maxMarkdownBytes = 16 * 1024 * 1024
type DirectoryNames = Map<string, { stamp: string; names: Map<string, string[]> }>

function desktop() {
    return {
        fs: require('fs') as typeof import('fs'),
        path: require('path') as typeof import('path'),
        crypto: require('crypto') as typeof import('crypto'),
    }
}

function hash(bytes: Uint8Array | string): string {
    return desktop().crypto.createHash('sha256').update(bytes).digest('hex')
}

function failure(plugin: MyPlugin, english: string, russian: string): Error {
    return new Error(uiFor(plugin.settings)(english, russian))
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function key(path: string): string { return path.normalize('NFC').toLowerCase() }
function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanFolder(input: string): string {
    const folder = input.trim().replace(/\/+$/u, '')
    if (!folder) return ''
    if (folder.split('/').some(part => !part || part.startsWith('.') || part === '__MACOSX' ||
        /[\\:<>|"*?\u0000-\u001f\u007f]/u.test(part) || /[ .]$/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(part))) {
        throw new Error('Choose an ordinary vault folder with a relative path. / Выберите обычную папку хранилища с относительным путём.')
    }
    return folder
}

function safeFilePath(input: string): boolean {
    try { return cleanFolder(input) === input && input.length > 0 } catch { return false }
}

/** Проверка каждого родителя исключает попадание через ссылку в чужое хранилище. */
async function checkedPath(root: string, relative: string, allowPrivate = false, cache?: DirectoryNames): Promise<string> {
    const { fs, path } = desktop()
    if (!allowPrivate && !safeFilePath(relative)) throw new Error('The vault path is invalid. / Недопустимый путь в хранилище.')
    const parts = relative.split('/')
    let current = root
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index]
        if (!part || part === '.' || part === '..' || /[\\\u0000]/u.test(part)) throw new Error('Invalid path. / Недопустимый путь.')
        const directoryStat = await fs.promises.lstat(current).catch(error => {
            if (missing(error)) return undefined
            throw error
        })
        if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) throw new Error(`Unsupported directory: ${relative}`)
        const stamp = directoryStat ? [directoryStat.dev, directoryStat.ino, directoryStat.mtimeMs, directoryStat.ctimeMs, directoryStat.size].join(':') : ''
        let known = cache?.get(current)
        if (!known || known.stamp !== stamp) {
            const siblings = await fs.promises.readdir(current).catch(error => {
                if (missing(error)) return []
                throw error
            })
            const names = new Map<string, string[]>()
            for (const name of siblings) {
                const normalized = key(name)
                const previous = names.get(normalized) ?? []
                previous.push(name)
                names.set(normalized, previous)
            }
            known = { stamp, names }
            cache?.set(current, known)
        }
        if (known.names.get(key(part))?.some(name => name !== part)) {
            throw new Error(`A file or folder differs only by case: ${relative} / Путь отличается только регистром или формой символов.`)
        }
        current = path.join(current, part)
        const stat = await fs.promises.lstat(current).catch(error => {
            if (missing(error)) return undefined
            throw error
        })
        if (stat && (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory() ||
            index === parts.length - 1 && !stat.isFile() && !stat.isDirectory())) {
            throw new Error(`A linked or unsupported vault path was found: ${relative} / Обнаружена ссылка или неподдерживаемый путь.`)
        }
    }
    return current
}

async function context(plugin: MyPlugin) {
    const { fs, path } = desktop()
    const adapter = plugin.app.vault.adapter as typeof plugin.app.vault.adapter & { getBasePath?: () => string }
    const base = adapter.getBasePath?.()
    if (!base || !path.isAbsolute(base)) throw failure(plugin, 'ZIP import needs a local desktop vault.', 'Импорт ZIP требует локального хранилища на компьютере.')
    const root = await fs.promises.realpath(base)
    const directory = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
    const relative = `${directory}/zip-imports`
    if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) {
        throw failure(plugin, 'Could not verify the plugin data folder.', 'Не удалось проверить папку данных плагина.')
    }
    const names: DirectoryNames = new Map()
    const folder = await checkedPath(root, relative, true, names)
    return { ...desktop(), root, relative, folder, names }
}

async function ensureFolder(root: string, relative: string, privateFolder = false): Promise<string> {
    const { fs, path } = desktop()
    let accumulated = ''
    for (const part of relative.split('/')) {
        if (!part) continue
        accumulated = accumulated ? `${accumulated}/${part}` : part
        const target = await checkedPath(root, accumulated, privateFolder)
        await fs.promises.mkdir(target, { mode: 0o700 }).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
        if (!(await fs.promises.lstat(target)).isDirectory()) throw new Error(`A folder became a file: ${accumulated}`)
    }
    return path.join(root, ...relative.split('/'))
}

async function jsonFile(path: string): Promise<unknown> {
    const { fs } = desktop()
    try {
        const info = await fs.promises.lstat(path)
        if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('The ZIP import journal is invalid. / Повреждён журнал импорта ZIP.')
        return JSON.parse(await fs.promises.readFile(path, 'utf8')) as unknown
    } catch (error) {
        if (missing(error)) return undefined
        throw error
    }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
    const { fs, crypto } = desktop()
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    const handle = await fs.promises.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    try { await fs.promises.rename(temporary, path) } finally { await fs.promises.unlink(temporary).catch(() => undefined) }
}

async function readReceipts(ctx: Awaited<ReturnType<typeof context>>): Promise<Receipts> {
    const value = await jsonFile(ctx.path.join(ctx.folder, receiptsName))
    if (value === undefined) return { version: 1, root: ctx.root, entries: {} }
    if (!object(value) || value.version !== 1 || value.root !== ctx.root || !object(value.entries) ||
        Object.entries(value.entries).some(([id, row]) => !digestPattern.test(id) || !object(row) ||
            typeof row.path !== 'string' || !safeFilePath(row.path) || typeof row.hash !== 'string' ||
            !digestPattern.test(row.hash) || typeof row.transaction !== 'string' || !transactionPattern.test(row.transaction))) {
        throw new Error('Could not verify the ZIP import receipts. / Не удалось проверить квитанции импорта ZIP.')
    }
    return value as unknown as Receipts
}

function receiptKey(path: string, digest: string): string { return hash(JSON.stringify([path, digest])) }

function readText(bytes: Uint8Array): string {
    if (bytes.byteLength > maxMarkdownBytes) throw new Error('A Markdown file is too large to compare. / Файл Markdown слишком большой для сравнения.')
    const text = textDecoder.decode(bytes)
    if (text.includes('\0')) throw new Error('A Markdown file contains a NUL character. / В Markdown найден нулевой символ.')
    return text
}

function idsOf(plugin: MyPlugin, text: string): number[] {
    return findIdMarkers(text, plugin.settings.Syntax).map(marker => marker.id).sort((a, b) => a - b)
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index])
}

function dirtyPaths(plugin: MyPlugin): Set<string> {
    const result = new Set<string>()
    for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view as unknown as { file?: TFile; data?: string; getViewData?: () => string }
        if (view.file && view.getViewData && !sameEditorText(view.getViewData(), view.data)) result.add(view.file.path)
    }
    return result
}

function editorTexts(plugin: MyPlugin): Map<string, string[]> {
    const values = new Map<string, string[]>()
    for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view as unknown as { file?: TFile; getViewData?: () => string }
        if (view.file && view.getViewData) {
            const previous = values.get(view.file.path) ?? []
            previous.push(view.getViewData())
            values.set(view.file.path, previous)
        }
    }
    return values
}

async function currentBytes(plugin: MyPlugin, path: string, prepared?: Awaited<ReturnType<typeof context>>): Promise<Uint8Array | undefined> {
    const ctx = prepared ?? await context(plugin)
    const absolute = await checkedPath(ctx.root, path, false, ctx.names)
    const info = await ctx.fs.promises.lstat(absolute).catch(error => {
        if (missing(error)) return undefined
        throw error
    })
    if (!info) return undefined
    if (!info.isFile()) throw failure(plugin, `The target is a folder: ${path}`, `По этому пути находится папка: ${path}`)
    if (info.size > 128 * 1024 * 1024) throw failure(plugin, `The current file is too large to import: ${path}`, `Текущий файл слишком большой для импорта: ${path}`)
    const file = plugin.app.vault.getAbstractFileByPath(path)
    if (!file || !('extension' in file)) throw failure(plugin,
        `Obsidian has not indexed this file yet: ${path}`, `Obsidian ещё не проиндексировал этот файл: ${path}`)
    return new Uint8Array(await plugin.app.vault.readBinary(file as TFile))
}

function tick(progress: Progress | undefined, phase: string, files: number, totalFiles: number, path?: string): void {
    progress?.({ phase, files, totalFiles, bytes: 0, totalBytes: 0, path })
}

/** Чтение архива не меняет файлы хранилища или записи Anki. */
export function prepareZipImport(_plugin: MyPlugin, source: string | File, progress?: Progress,
    signal?: AbortSignal): Promise<ZipImportArchive> {
    return prepareZipImportArchive(source, progress, signal)
}

async function existingOwners(plugin: MyPlugin, wanted: ReadonlySet<number>, progress?: Progress): Promise<Map<number, Set<string>>> {
    const owners = new Map<number, Set<string>>()
    if (!wanted.size) return owners
    const files = plugin.app.vault.getMarkdownFiles()
    const editors = editorTexts(plugin)
    let index = 0
    for (const file of files) {
        const content = await plugin.app.vault.read(file)
        const ids = new Set([content, ...editors.get(file.path) ?? []].flatMap(text => idsOf(plugin, text)))
        for (const id of ids) if (wanted.has(id)) {
            const paths = owners.get(id) ?? new Set<string>()
            paths.add(file.path)
            owners.set(id, paths)
        }
        tick(progress, 'ids', ++index, files.length, file.path)
        if (index % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    return owners
}

function configuration(plugin: MyPlugin): string { return JSON.stringify(plugin.settings.Syntax) }

export async function compareZipImport(plugin: MyPlugin, archive: ZipImportArchive,
    options: { prefix: string; target: string }, progress?: Progress): Promise<ZipImportPlan> {
    return withFastScanReadLock(plugin, async () => {
        if (archive.disposed) throw failure(plugin, 'Reopen the ZIP archive.', 'Откройте ZIP-архив заново.')
        const prefix = cleanFolder(options.prefix)
        const target = cleanFolder(options.target)
        const ctx = await context(plugin)
        if (await pendingJournal(ctx)) throw failure(plugin,
            'A previous ZIP import needs recovery before another import.', 'Сначала восстановите незавершённый импорт ZIP.')
        const receipts = await readReceipts(ctx)
        const baseline = await readTransferBaseline(plugin, archive, prefix, target)
        const rows: ZipImportRow[] = []
        const checked = new Map<string, CheckedRow>()
        const dirty = dirtyPaths(plugin)
        const selected = archive.files.filter(file => !prefix || file.path.startsWith(`${prefix}/`))
        const incomingOwners = new Map<number, Set<string>>()
        let budget = textPreviewBudget
        for (const file of selected) {
            const relative = prefix ? file.path.slice(prefix.length + 1) : file.path
            const path = target ? `${target}/${relative}` : relative
            const row: ZipImportRow = { path, archivePath: file.path, status: 'blocked', markdown: file.markdown, size: file.size }
            rows.push(row)
            try {
                if (!safeFilePath(path)) throw failure(plugin, 'The mapped path is invalid.', 'Недопустимый путь назначения.')
                const incoming = await archive.read(file.path)
                const sourceHash = hash(incoming)
                if (sourceHash !== file.hash) throw failure(plugin, 'The staged ZIP entry changed.', 'Файл из архива изменился после чтения.')
                const current = await currentBytes(plugin, path, ctx)
                const beforeHash = current === undefined ? null : hash(current)
                const sourceText = file.markdown ? readText(incoming) : undefined
                const currentText = file.markdown && current ? readText(current) : undefined
                const ids = sourceText === undefined ? [] : idsOf(plugin, sourceText)
                const beforeIds = currentText === undefined ? [] : idsOf(plugin, currentText)
                checked.set(path, { sourceHash, before: { hash: beforeHash, ids: beforeIds }, ids,
                    archivePath: file.path, markdown: file.markdown, allowed: false })
                if (sourceText !== undefined && incoming.byteLength <= previewFileLimit && budget >= incoming.byteLength + (current?.byteLength ?? 0)) {
                    row.archiveText = sourceText
                    row.currentText = currentText
                    budget -= incoming.byteLength + (current?.byteLength ?? 0)
                }
                if (dirty.has(path)) throw failure(plugin, 'Save or close the edited note before importing.', 'Сохраните или закройте редактируемую заметку перед импортом.')
                if (receipts.entries[receiptKey(path, sourceHash)]) {
                    if (current === undefined) throw failure(plugin,
                        'This version was imported before, but its target was moved or deleted. Locate its existing source before importing again.',
                        'Эта версия уже импортировалась, но файл перемещён или удалён. Найдите прежний источник перед повторным импортом.')
                    row.status = 'already-imported'
                    row.reason = uiFor(plugin.settings)('This ZIP version was already imported. Current local changes and IDs are preserved.',
                        'Эта версия файла уже импортирована. Текущие правки и ID сохранены.')
                    continue
                }
                if (ids.length !== new Set(ids).size) throw failure(plugin, 'This file contains a repeated Anki ID.', 'В файле повторяется Anki ID.')
                if (beforeHash !== null && !sameIds(ids, beforeIds)) throw failure(plugin,
                    'The Anki IDs differ or are missing. Merge the note manually to preserve its links.',
                    'Anki ID отличаются или отсутствуют. Объедините заметку вручную, сохранив её связи.')
                row.status = beforeHash === null ? 'new' : beforeHash === sourceHash ? 'same' : 'different'
                const original = baseline?.files.get(path)
                if (beforeHash === null && original) {
                    row.status = 'different'
                    row.changeOrigin = original.hash === sourceHash ? 'desktop' : 'both'
                    row.reason = uiFor(plugin.settings)('This file existed in the phone package and is now missing on the computer. Restoring it requires your selection.',
                        'Файл был в исходном пакете и теперь отсутствует на компьютере. Для восстановления выберите его явно.')
                }
                if (row.status === 'different' && original) {
                    row.changeOrigin = original.hash === beforeHash ? 'phone' : original.hash === sourceHash ? 'desktop' : 'both'
                }
                for (const id of ids) {
                    const paths = incomingOwners.get(id) ?? new Set<string>()
                    paths.add(path)
                    incomingOwners.set(id, paths)
                }
            } catch (error) {
                row.status = 'blocked'
                row.reason = error instanceof Error ? error.message : String(error)
            }
            tick(progress, 'compare', rows.length, selected.length, path)
        }
        const owners = await existingOwners(plugin, new Set(incomingOwners.keys()), progress)
        for (const row of rows) {
            if (row.status === 'blocked' || row.status === 'already-imported') continue
            const conflicts = checked.get(row.path)!.ids.filter(id => (incomingOwners.get(id)?.size ?? 0) > 1 ||
                [...owners.get(id) ?? []].some(path => path !== row.path))
            if (conflicts.length) {
                row.status = 'blocked'
                row.reason = uiFor(plugin.settings)(`Anki ID is used in another note: ${conflicts.join(', ')}`,
                    `Anki ID используется в другой заметке: ${conflicts.join(', ')}`)
            }
        }
        for (const row of rows) {
            const saved = checked.get(row.path)
            if (saved) saved.allowed = row.status === 'new' || row.status === 'different'
        }
        const plan: ZipImportPlan = { id: ctx.crypto.randomUUID(), archive, options: { prefix, target }, rows,
            baselineReason: baseline?.reason }
        plans.set(plan, { plugin, root: ctx.root, settings: configuration(plugin), rows: checked })
        return plan
    })
}

function readJournal(value: unknown, root: string): Journal {
    if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || !transactionPattern.test(value.id) ||
        value.root !== root || !['pending', 'committed', 'restored'].includes(String(value.status)) || !Array.isArray(value.entries) ||
        !value.entries.length || value.entries.some(row => !object(row) || typeof row.path !== 'string' || !safeFilePath(row.path) ||
            row.before !== null && (typeof row.before !== 'string' || !digestPattern.test(row.before)) ||
            typeof row.after !== 'string' || !digestPattern.test(row.after) || typeof row.sourceHash !== 'string' ||
            !digestPattern.test(row.sourceHash) || typeof row.markdown !== 'boolean') ||
        new Set(value.entries.map(row => key(row.path))).size !== value.entries.length) {
        throw new Error('Could not verify the ZIP import recovery journal. / Не удалось проверить журнал восстановления ZIP.')
    }
    return value as unknown as Journal
}

async function pendingJournal(ctx: Awaited<ReturnType<typeof context>>): Promise<Journal | undefined> {
    const pointer = await jsonFile(ctx.path.join(ctx.folder, pendingName))
    if (pointer === undefined) return undefined
    if (!object(pointer) || typeof pointer.id !== 'string' || !transactionPattern.test(pointer.id)) throw new Error('Invalid pending ZIP import. / Повреждён незавершённый импорт ZIP.')
    const folder = await checkedPath(ctx.root, `${ctx.relative}/${pointer.id}`, true)
    const journal = readJournal(await jsonFile(ctx.path.join(folder, 'transaction.json')), ctx.root)
    if (journal.id !== pointer.id) throw new Error('Invalid ZIP import transaction. / Неверный идентификатор импорта ZIP.')
    return journal
}

export async function inspectZipImportRecovery(plugin: MyPlugin): Promise<{ id: string; paths: string[]; backupPath: string; committed: boolean } | undefined> {
    const ctx = await context(plugin)
    const journal = await pendingJournal(ctx)
    return journal && { id: journal.id, paths: journal.entries.map(row => row.path), backupPath: ctx.path.join(ctx.folder, journal.id),
        committed: journal.status === 'committed' }
}

async function rememberCreatedPath(ctx: Awaited<ReturnType<typeof context>>, relative: string): Promise<void> {
    const parent = ctx.path.dirname(ctx.path.join(ctx.root, ...relative.split('/')))
    const cached = ctx.names.get(parent)
    if (!cached) return
    const parts = relative.split('/')
    const name = parts[parts.length - 1]
    const names = cached.names.get(key(name)) ?? []
    if (!names.includes(name)) names.push(name)
    cached.names.set(key(name), names)
    const stat = await ctx.fs.promises.lstat(parent)
    cached.stamp = [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size].join(':')
}

async function vaultParents(plugin: MyPlugin, path: string, prepared?: Awaited<ReturnType<typeof context>>): Promise<void> {
    const ctx = prepared ?? await context(plugin)
    const parts = path.split('/').slice(0, -1)
    let relative = ''
    for (const part of parts) {
        relative = relative ? `${relative}/${part}` : part
        await checkedPath(ctx.root, relative, false, ctx.names)
        if (!plugin.app.vault.getAbstractFileByPath(relative)) {
            await plugin.app.vault.createFolder(relative)
            await rememberCreatedPath(ctx, relative)
        }
    }
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

async function writeVaultFile(plugin: MyPlugin, entry: JournalEntry, bytes: Uint8Array, expected: string | null,
    prepared?: Awaited<ReturnType<typeof context>>): Promise<void> {
    const { vault } = plugin.app
    const ctx = prepared ?? await context(plugin)
    await checkedPath(ctx.root, entry.path, false, ctx.names)
    if (dirtyPaths(plugin).has(entry.path)) throw failure(plugin, 'The note has unsaved changes.', 'В заметке есть несохранённые изменения.')
    const current = await currentBytes(plugin, entry.path, ctx)
    if ((current === undefined ? null : hash(current)) !== expected) throw failure(plugin,
        'A file changed after preview. Compare the ZIP again.', 'Файл изменился после предпросмотра. Сравните ZIP заново.')
    if (expected === null) {
        await vaultParents(plugin, entry.path, ctx)
        if (entry.markdown) await vault.create(entry.path, readText(bytes))
        else await vault.createBinary(entry.path, asArrayBuffer(bytes))
        await rememberCreatedPath(ctx, entry.path)
    } else {
        const file = vault.getAbstractFileByPath(entry.path) as TFile
        if (entry.markdown) {
            await vault.process(file, text => {
                if (hash(Buffer.from(text, 'utf8')) !== expected || dirtyPaths(plugin).has(entry.path)) {
                    throw failure(plugin, 'A note changed while applying the import.', 'Заметка изменилась во время импорта.')
                }
                return readText(bytes)
            })
        } else await vault.modifyBinary(file, asArrayBuffer(bytes))
    }
    const actual = await currentBytes(plugin, entry.path, ctx)
    if (!actual || hash(actual) !== hash(bytes)) throw failure(plugin,
        'The imported file could not be confirmed. Use ZIP recovery.', 'Не удалось подтвердить запись файла. Используйте восстановление импорта ZIP.')
}

export async function applyZipImport(plugin: MyPlugin, plan: ZipImportPlan, selected: ReadonlySet<string>,
    progress?: Progress): Promise<ZipImportResult> {
    return withFastScanReadLock(plugin, async (revision, pathRevision) => {
        const startRevision = revision()
        const stored = plans.get(plan)
        const ctx = await context(plugin)
        if (!stored || stored.plugin !== plugin || stored.root !== ctx.root || stored.settings !== configuration(plugin) || plan.archive.disposed) {
            throw failure(plugin, 'Compare the ZIP again before importing.', 'Сравните ZIP заново перед импортом.')
        }
        if (await pendingJournal(ctx)) throw failure(plugin, 'Recover the unfinished ZIP import first.', 'Сначала восстановите незавершённый импорт ZIP.')
        const rows = [...selected].map(path => ({ path, saved: stored.rows.get(path) }))
        if (!rows.length || rows.some(row => !row.saved?.allowed)) {
            throw failure(plugin, 'Select new or changed files from the current preview.', 'Выберите новые или изменённые файлы текущего предпросмотра.')
        }
        const incomingOwners = new Map<number, Set<string>>()
        const dirty = dirtyPaths(plugin)
        const originalPaths = new Set(plugin.app.vault.getMarkdownFiles().map(file => file.path))
        // Все проверки проходят до создания журнала и первой правки в хранилище.
        for (const row of rows) {
            const checked = row.saved
            if (!checked || dirty.has(row.path)) throw failure(plugin, 'A selected file is being edited. Save it and compare again.', 'Выбранный файл редактируется. Сохраните его и сравните заново.')
            const incoming = await plan.archive.read(checked.archivePath)
            const current = await currentBytes(plugin, row.path, ctx)
            if (hash(incoming) !== checked.sourceHash || (current === undefined ? null : hash(current)) !== checked.before.hash) {
                throw failure(plugin, 'A source or target changed after preview.', 'Источник или файл назначения изменился после предпросмотра.')
            }
            for (const id of checked.ids) {
                const paths = incomingOwners.get(id) ?? new Set<string>()
                paths.add(row.path)
                incomingOwners.set(id, paths)
            }
        }
        const owners = await existingOwners(plugin, new Set(incomingOwners.keys()), progress)
        for (const [id, paths] of incomingOwners) if (paths.size > 1 || [...owners.get(id) ?? []].some(path => !paths.has(path))) {
            throw failure(plugin, `Anki ID ${id} is used in another file.`, `Anki ID ${id} используется в другом файле.`)
        }
        if (revision() !== startRevision) throw failure(plugin, 'The vault changed during ID verification. Compare again.', 'Хранилище изменилось во время проверки ID. Сравните заново.')
        await ensureFolder(ctx.root, ctx.relative, true)
        const id = ctx.crypto.randomUUID()
        const transaction = await ensureFolder(ctx.root, `${ctx.relative}/${id}`, true)
        const journal: Journal = { version: 1, id, root: ctx.root, entries: [], status: 'pending' }
        for (const [index, row] of rows.entries()) {
            const checked = stored.rows.get(row.path)!
            const bytes = await plan.archive.read(checked.archivePath)
            const current = await currentBytes(plugin, row.path, ctx)
            if ((current === undefined ? null : hash(current)) !== checked.before.hash) throw failure(plugin,
                'A selected file changed before backup.', 'Выбранный файл изменился перед резервным копированием.')
            if (current) await ctx.fs.promises.writeFile(ctx.path.join(transaction, `${index}.before`), current, { flag: 'wx', mode: 0o600 })
            await ctx.fs.promises.writeFile(ctx.path.join(transaction, `${index}.after`), bytes, { flag: 'wx', mode: 0o600 })
            journal.entries.push({ path: row.path, before: checked.before.hash, after: checked.sourceHash,
                sourceHash: checked.sourceHash, markdown: checked.markdown })
        }
        if (revision() !== startRevision) throw failure(plugin, 'The vault changed before importing. Compare again.', 'Хранилище изменилось перед импортом. Сравните заново.')
        await atomicJson(ctx.path.join(transaction, 'transaction.json'), journal)
        // Маркер публикуется раньше первой записи. После сбоя восстановление проверит реальные хеши.
        await atomicJson(ctx.path.join(ctx.folder, pendingName), { id })
        try {
            for (const [index, entry] of journal.entries.entries()) {
                const bytes = new Uint8Array(await ctx.fs.promises.readFile(ctx.path.join(transaction, `${index}.after`)))
                if (hash(bytes) !== entry.after) throw failure(plugin, 'A staged import file changed.', 'Подготовленный файл импорта изменился.')
                await writeVaultFile(plugin, entry, bytes, entry.before, ctx)
                tick(progress, 'apply', index + 1, journal.entries.length, entry.path)
            }
            // Обновлённые нами имена кешируются на время записи. Финальная проверка перечитывает каталоги.
            ctx.names.clear()
            for (const entry of journal.entries) await checkedPath(ctx.root, entry.path, false, ctx.names)
            // Свои записи меняют ревизию. Проверяем отдельно остальные Markdown-файлы и новые пути.
            if ([...originalPaths].some(path => !selected.has(path) && pathRevision(path) > startRevision) ||
                plugin.app.vault.getMarkdownFiles().some(file => !selected.has(file.path) && !originalPaths.has(file.path))) {
                throw failure(plugin, 'Other notes changed during import. Review the saved import recovery.', 'Другие заметки изменились во время импорта. Проверьте сохранённое восстановление импорта.')
            }
            const receipts = await readReceipts(ctx)
            for (const entry of journal.entries) receipts.entries[receiptKey(entry.path, entry.sourceHash)] = {
                path: entry.path, hash: entry.sourceHash, transaction: id,
            }
            await atomicJson(ctx.path.join(ctx.folder, receiptsName), receipts)
            journal.status = 'committed'
            await atomicJson(ctx.path.join(transaction, 'transaction.json'), journal)
            await ctx.fs.promises.unlink(ctx.path.join(ctx.folder, pendingName))
            plans.delete(plan)
            return { paths: journal.entries.map(entry => entry.path), markdownPaths: journal.entries.filter(entry => entry.markdown).map(entry => entry.path),
                backupPath: transaction }
        } catch (error) {
            throw failure(plugin, `The ZIP import stopped. Its recovery journal is saved in ${transaction}. ${String(error)}`,
                `Импорт ZIP остановлен. Журнал восстановления сохранён в ${transaction}. ${String(error)}`)
        }
    })
}

/** Возврат затрагивает только файлы с подтверждённым результатом именно этого импорта. */
export async function recoverZipImport(plugin: MyPlugin, progress?: Progress): Promise<ZipImportResult> {
    return withFastScanReadLock(plugin, async () => {
        const ctx = await context(plugin)
        const journal = await pendingJournal(ctx)
        if (!journal) throw failure(plugin, 'There is no unfinished ZIP import.', 'Незавершённого импорта ZIP нет.')
        const folder = ctx.path.join(ctx.folder, journal.id)
        if (journal.status === 'committed' || journal.status === 'restored') {
            const receipts = await readReceipts(ctx)
            if (journal.status === 'committed' && journal.entries.some(entry =>
                receipts.entries[receiptKey(entry.path, entry.sourceHash)]?.transaction !== journal.id)) {
                throw failure(plugin, 'The completed import receipts could not be verified.', 'Не удалось подтвердить квитанции завершённого импорта.')
            }
            await ctx.fs.promises.unlink(ctx.path.join(ctx.folder, pendingName))
            return { paths: journal.entries.map(entry => entry.path), markdownPaths: journal.entries.filter(entry => entry.markdown).map(entry => entry.path),
                backupPath: folder }
        }
        const changes: { entry: JournalEntry; index: number; current: string | null; bytes?: Uint8Array }[] = []
        for (const [index, entry] of journal.entries.entries()) {
            if (dirtyPaths(plugin).has(entry.path)) throw failure(plugin, 'Save the edited note before recovery.', 'Сохраните редактируемую заметку перед восстановлением.')
            const current = await currentBytes(plugin, entry.path, ctx)
            const digest = current === undefined ? null : hash(current)
            if (digest !== entry.before && digest !== entry.after) throw failure(plugin,
                `This file changed after the interrupted import: ${entry.path}. Restore it manually from ${folder}.`,
                `Файл изменился после прерванного импорта: ${entry.path}. Восстановите его вручную из ${folder}.`)
            const bytes = entry.before === null ? undefined : new Uint8Array(await ctx.fs.promises.readFile(ctx.path.join(folder, `${index}.before`)))
            if (bytes && hash(bytes) !== entry.before) throw failure(plugin, 'An original import backup is damaged.', 'Повреждена резервная копия исходного файла.')
            changes.push({ entry, index, current: digest, bytes })
        }
        for (const [index, item] of changes.entries()) {
            if (item.current !== item.entry.before) {
                if (item.bytes) await writeVaultFile(plugin, item.entry, item.bytes, item.entry.after, ctx)
                else {
                    const current = await currentBytes(plugin, item.entry.path, ctx)
                    if (!current || hash(current) !== item.entry.after || dirtyPaths(plugin).has(item.entry.path)) throw failure(plugin,
                        'A new file changed during recovery.', 'Новый файл изменился во время восстановления.')
                    await plugin.app.vault.delete(plugin.app.vault.getAbstractFileByPath(item.entry.path) as TFile)
                }
            }
            tick(progress, 'recover', index + 1, changes.length, item.entry.path)
        }
        const receipts = await readReceipts(ctx)
        for (const [id, row] of Object.entries(receipts.entries)) if (row.transaction === journal.id) delete receipts.entries[id]
        await atomicJson(ctx.path.join(ctx.folder, receiptsName), receipts)
        journal.status = 'restored'
        await atomicJson(ctx.path.join(folder, 'transaction.json'), journal)
        await ctx.fs.promises.unlink(ctx.path.join(ctx.folder, pendingName))
        return { paths: journal.entries.map(entry => entry.path), markdownPaths: journal.entries.filter(entry => entry.markdown).map(entry => entry.path),
            backupPath: folder }
    })
}
