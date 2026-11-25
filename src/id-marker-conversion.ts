/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { paths as path, temporaryDirectory, hashes as crypto, fileOperations as fs, fileFlags as constants, bytes as binary, fileErrorCode } from './desktop-io'
import { MarkdownView, TFile } from 'obsidian'
import type MyPlugin from '../main'
import { withFastScanReadLock } from './fast-scan'
import { resolveSyncScope, syncScopeSignature } from './sync-profiles'
import { convertIdMarkerText } from './id-marker-format'
import type { IdMarkerDirection } from './id-marker-format'
import { findIdMarkers } from './duplicate-markers'
import { writeVaultZip, verifyVaultZip } from './vault-backup-zip'
import { uiFor } from './interface-language'
import { sameEditorText } from './markdown-pipeline'

export interface IdMarkerConversionFile {
    path: string
    count: number
    examples: Array<{ line: number; before: string; after: string }>
}

export interface IdMarkerConversionPlan {
    direction: IdMarkerDirection
    scope: 'current' | 'profile'
    label: string
    files: readonly IdMarkerConversionFile[]
    totalMarkers: number
    scannedFiles: number
}

interface Source { path: string; before: string; after: string; beforeHash: string; afterHash: string }
interface StoredPlan { plugin: MyPlugin; root: string; signature: string; sources: Source[] }
const plans = new WeakMap<IdMarkerConversionPlan, StoredPlan>()
const maximumBytes = 256 * 1024 * 1024

function desktop(plugin: MyPlugin) {
    const adapter = plugin.app.vault.adapter as typeof plugin.app.vault.adapter & { getBasePath?(): string }
    if (typeof adapter.getBasePath !== 'function') throw new Error(uiFor(plugin.settings)(
        'ID conversion requires a local desktop vault.', 'Для преобразования ID нужно локальное настольное хранилище.'))
    return { fs, constants, path, crypto, base: adapter.getBasePath() }
}

function digest(text: string): string { return crypto.createHash('sha256').update(text).digest('hex') }
function signature(plugin: MyPlugin): string { return JSON.stringify([plugin.settings.Syntax, syncScopeSignature(plugin.settings)]) }

function safeRelative(relative: string): boolean {
    return !!relative && relative.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[\\:\p{Cc}]/u.test(part))
}

async function checkedPath(root: string, relative: string, create = false): Promise<string> {
    if (!safeRelative(relative)) throw new Error('Invalid conversion file path. / Недопустимый путь файла преобразования.')
    let absolute = root
    const parts = relative.split('/')
    for (let index = 0; index < parts.length; index++) {
        absolute = path.join(absolute, parts[index])
        let info = await fs.lstat(absolute).catch((error: unknown) => { if (fileErrorCode(error) === 'ENOENT') return undefined; throw error })
        if (!info && create) { await fs.mkdir(absolute); info = await fs.lstat(absolute) }
        if (!info || info.isSymbolicLink() || index < parts.length - 1 && !info.isDirectory()) {
            throw new Error('A linked or missing conversion path was found. / Обнаружен отсутствующий путь или символическая ссылка.')
        }
    }
    return absolute
}

function unsaved(plugin: MyPlugin, path: string): boolean {
    return plugin.app.workspace.getLeavesOfType('markdown').some(leaf => {
        const view = leaf.view
        return view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source' && !sameEditorText(view.getViewData(), view.data)
    })
}

async function readSource(plugin: MyPlugin, root: string, relative: string, maximum = 32 * 1024 * 1024): Promise<string> {
    const { fs, constants } = desktop(plugin)
    const absolute = await checkedPath(root, relative)
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > maximum) throw new Error(uiFor(plugin.settings)(
            'The note exceeds the supported 32 MiB conversion size.', 'Заметка превышает поддерживаемый размер преобразования 32 МиБ.'))
        const bytes = await handle.readFile(), after = await handle.stat(), text = bytes.toString('utf8')
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs || !binary.from(text, 'utf8').equals(bytes)) throw new Error(uiFor(plugin.settings)(
                'The note changed while reading or is not valid UTF-8.', 'Заметка изменилась при чтении или сохранена не в UTF-8.'))
        return text
    } finally { await handle.close() }
}

/** Verify the exact UTF-8 bytes, including a possible BOM, and reject changed or linked paths. */
export async function verifyPageMoveSource(plugin: MyPlugin, relative: string, expected: string): Promise<void> {
    const { fs, base } = desktop(plugin)
    if (await readSource(plugin, await fs.realpath(base), relative, Infinity) !== expected) {
        throw new Error(uiFor(plugin.settings)(`The saved note changed: ${relative}.`, `Сохранённая заметка изменилась: ${relative}.`))
    }
}

export function previewIdMarkerConversion(plugin: MyPlugin, direction: IdMarkerDirection, scope: 'current' | 'profile' = 'current',
    onProgress?: (files: number, total: number) => void): Promise<IdMarkerConversionPlan> {
    return withFastScanReadLock(plugin, async () => {
        if (direction !== 'to-comment' && direction !== 'to-plain') throw new Error('Invalid conversion direction.')
        const { fs, base } = desktop(plugin), root = await fs.realpath(base), selected = resolveSyncScope(plugin)
        const active = plugin.app.workspace.getActiveFile()
        if (scope === 'current' && (!(active instanceof TFile) || active.extension.toLowerCase() !== 'md' || !selected.contains(active.path))) {
            throw new Error(uiFor(plugin.settings)('Open a Markdown note within the active sync profile.', 'Откройте Markdown-заметку в области текущего профиля синхронизации.'))
        }
        const files = scope === 'current' ? [active!] : selected.files
        const syntax = plugin.settings.Syntax, initial = signature(plugin), sources: Source[] = [], rows: IdMarkerConversionFile[] = []
        let bytes = 0, scanned = 0
        for (const file of files) {
            if (unsaved(plugin, file.path)) throw new Error(uiFor(plugin.settings)(`Save the open edits before converting ${file.path}.`, `Сохраните открытые правки перед преобразованием ${file.path}.`))
            const before = await readSource(plugin, root, file.path)
            bytes += binary.byteLength(before)
            if (bytes > maximumBytes) throw new Error(uiFor(plugin.settings)(
                'The conversion preview exceeds 256 MiB. Select a smaller sync profile.', 'Предпросмотр преобразования превышает 256 МиБ. Выберите меньший профиль папок.'))
            const changed = convertIdMarkerText(before, direction, syntax)
            if (changed.text !== before) {
                const previousIds = findIdMarkers(before, syntax).map(marker => [marker.id, marker.line])
                if (JSON.stringify(previousIds) !== JSON.stringify(findIdMarkers(changed.text, syntax).map(marker => [marker.id, marker.line]))) {
                    throw new Error(uiFor(plugin.settings)(`Conversion could not preserve all ID markers in ${file.path}.`, `Преобразование не сохраняет все маркеры ID в ${file.path}.`))
                }
                sources.push({ path: file.path, before, after: changed.text, beforeHash: digest(before), afterHash: digest(changed.text) })
                rows.push({ path: file.path, count: changed.markers.length, examples: changed.markers.slice(0, 3).map(marker => ({
                    line: marker.line, before: marker.text, after: direction === 'to-comment' ? `<!--${marker.inner}-->` : marker.inner,
                })) })
            }
            onProgress?.(++scanned, files.length)
        }
        if (signature(plugin) !== initial) throw new Error(uiFor(plugin.settings)('Settings changed. Preview the conversion again.', 'Настройки изменились. Откройте предпросмотр преобразования заново.'))
        const plan: IdMarkerConversionPlan = { direction, scope, label: scope === 'current' ? active!.path : selected.label,
            files: rows, totalMarkers: rows.reduce((sum, row) => sum + row.count, 0), scannedFiles: scanned }
        plans.set(plan, { plugin, root, signature: initial, sources })
        return plan
    })
}

export interface IdMarkerConversionResult { files: number; markers: number; backupPath: string }

export function applyIdMarkerConversion(plugin: MyPlugin, plan: IdMarkerConversionPlan,
    selectedPaths: ReadonlySet<string>): Promise<IdMarkerConversionResult> {
    return withFastScanReadLock(plugin, async () => {
        const stored = plans.get(plan), t = uiFor(plugin.settings)
        if (!stored || stored.plugin !== plugin || stored.signature !== signature(plugin)) throw new Error(t(
            'The conversion preview is stale. Preview again.', 'Предпросмотр преобразования устарел. Выполните его заново.'))
        const sources = stored.sources.filter(source => selectedPaths.has(source.path))
        if (!sources.length || sources.length !== selectedPaths.size) throw new Error(t('Select files from this preview.', 'Выберите файлы из этого предпросмотра.'))
        const { fs, path, base, crypto } = desktop(plugin)
        if (await fs.realpath(base) !== stored.root) throw new Error('The vault location changed. / Путь хранилища изменился.')
        const check = async (source: Source) => {
            if (unsaved(plugin, source.path) || await readSource(plugin, stored.root, source.path) !== source.before) throw new Error(t(
                `The note changed after the preview: ${source.path}. Preview again.`, `После предпросмотра изменена заметка ${source.path}. Выполните его заново.`))
        }
        for (const source of sources) await check(source)
        const id = crypto.randomUUID(), directory = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
        const parent = await checkedPath(stored.root, `${directory}/id-marker-conversions`, true)
        const transaction = path.join(parent, id)
        await fs.mkdir(transaction, { mode: 0o700 })
        const backupPath = path.join(transaction, 'Obsidian.zip'), manifestPath = path.join(transaction, 'conversion.json')
        const staging = await fs.mkdtemp(path.join(temporaryDirectory(), 'rudonium-id-conversion-'))
        const manifest = { version: 1, kind: 'id-marker-conversion-backup', createdAt: Date.now(), root: stored.root,
            direction: plan.direction, state: 'prepared', files: sources.map(source => ({ path: source.path, beforeHash: source.beforeHash, afterHash: source.afterHash })),
            unresolved: [] as string[] }
        const writeManifest = async () => {
            const raw = JSON.stringify(manifest, null, 2), temporary = manifestPath + '.tmp'
            await fs.writeFile(temporary, raw, { flag: 'wx', mode: 0o600 })
            try {
                if (await fs.readFile(temporary, 'utf8') !== raw) throw new Error('The conversion journal could not be verified.')
                await fs.rename(temporary, manifestPath)
            } finally { await fs.unlink(temporary).catch(() => undefined) }
        }
        const attempted: Source[] = []
        try {
            for (const source of sources) {
                const filename = path.join(staging, ...source.path.split('/'))
                await fs.mkdir(path.dirname(filename), { recursive: true })
                await fs.writeFile(filename, source.before, { flag: 'wx', mode: 0o600 })
            }
            await writeVaultZip(staging, backupPath)
            await verifyVaultZip(backupPath)
            await writeManifest()
            for (const source of sources) await check(source)
            if (stored.signature !== signature(plugin)) throw new Error(t('Settings changed. Preview again.', 'Настройки изменились. Откройте предпросмотр заново.'))
            for (const source of sources) {
                await check(source)
                const file = plugin.app.vault.getAbstractFileByPath(source.path)
                if (!(file instanceof TFile)) throw new Error(t(`The note moved: ${source.path}.`, `Заметка перемещена: ${source.path}.`))
                attempted.push(source)
                await plugin.app.vault.process(file, current => {
                    if (current !== source.before) throw new Error(t('The note changed before writing.', 'Заметка изменилась перед записью.'))
                    return source.after
                })
                if (await readSource(plugin, stored.root, source.path) !== source.after) throw new Error(t('The converted file could not be verified.', 'Не удалось проверить преобразованный файл.'))
            }
            manifest.state = 'applied'; await writeManifest(); plans.delete(plan)
            return { files: sources.length, markers: plan.files.filter(file => selectedPaths.has(file.path)).reduce((sum, file) => sum + file.count, 0), backupPath }
        } catch (failure) {
            for (const source of [...attempted].reverse()) {
                try {
                    const current = await readSource(plugin, stored.root, source.path)
                    if (current === source.before) continue
                    if (current !== source.after || unsaved(plugin, source.path)) { manifest.unresolved.push(source.path); continue }
                    const file = plugin.app.vault.getAbstractFileByPath(source.path)
                    if (!(file instanceof TFile)) { manifest.unresolved.push(source.path); continue }
                    await plugin.app.vault.process(file, latest => {
                        if (latest !== source.after) throw new Error('The note changed before rollback.')
                        return source.before
                    })
                    if (await readSource(plugin, stored.root, source.path) !== source.before) manifest.unresolved.push(source.path)
                } catch { manifest.unresolved.push(source.path) }
            }
            manifest.state = manifest.unresolved.length ? 'needs-review' : 'rolled-back'
            await writeManifest().catch(() => undefined)
            const message = failure instanceof Error ? failure.message : String(failure)
            throw new Error(t(`Conversion stopped. ${message}\nBackup: ${backupPath}${manifest.unresolved.length ? '\nReview these files: ' + manifest.unresolved.join(', ') : ''}`,
                `Преобразование остановлено. ${message}\nРезервная копия: ${backupPath}${manifest.unresolved.length ? '\nПроверьте файлы: ' + manifest.unresolved.join(', ') : ''}`))
        } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined) }
    })
}
