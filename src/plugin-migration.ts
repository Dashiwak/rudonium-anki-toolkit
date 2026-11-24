/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { Modal, Notice } from 'obsidian'
import type { FileSystemAdapter, Plugin } from 'obsidian'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { setImageReceiptDirectory } from './export-image-replacement'
import { hasActiveLegacyPlugin, previousRudoniumId, rudoniumPluginId, upstreamPluginId } from './plugin-identity'

const sources = [previousRudoniumId, upstreamPluginId] as const
type SourceId = typeof sources[number]
const pendingName = 'rupos-migration-pending.json'
const readyName = 'rupos-migration-complete.json'
const specialFiles = new Set(['data.json', 'fast-scan-index.json', 'last-export-report.json'])
const stateFile = /^(?:(?:pending-new-notes|export-operation-journal)\.json\.[01]|one-way-history\.json\.[a-f0-9]{32}\.[01]|bidirectional-sync\.json\.[a-f0-9]{32}\.(?:[01]|staged|journal\.(?:[01]|staged))|audit-repair-intent-[a-f0-9]{32}\.json)$/
const stateDirectories = /^(?:image-replacements|zip-transfer-packages|(?:zip-imports|id-marker-conversions)(?:\/[a-f0-9-]{36})?)$/
const nestedState = /^(?:image-replacements\/[a-f0-9]{64}\.json|zip-transfer-packages\/(?:[a-f0-9]{32}|archive-[a-f0-9]{64})\.json|zip-imports\/(?:pending\.json|receipts\.json|[a-f0-9-]{36}\/(?:transaction\.json|[0-9]+\.(?:before|after)))|id-marker-conversions\/[a-f0-9-]{36}\/(?:conversion\.json|Obsidian\.zip))$/
const digestPattern = /^[a-f0-9]{64}$/
type FileSystem = typeof import('fs')
type PathTools = typeof import('path')
type Crypto = typeof import('crypto')
type Entry = { path: string; hash: string }

type MigrationContext = {
    fs: FileSystem
    path: PathTools
    crypto: Crypto
    config: string
    plugin: Plugin
    isStopped: () => boolean
    plugins: string
    destination: string
    t: UiText
}

type MigrationPlan =
    | { kind: 'ready' }
    | { kind: 'legacy-enabled' }
    | { kind: 'preview'; sourceId: SourceId; files: Entry[]; cachedFiles: number; indexedIds?: number; interrupted: boolean }

type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const knownFile = (path: string) => specialFiles.has(path) || stateFile.test(path) || nestedState.test(path)
const missing = (error: unknown) => object(error) && error.code === 'ENOENT'

async function regularPath(fs: FileSystem, path: string): Promise<boolean> {
    try {
        if (!(await fs.promises.lstat(path)).isFile()) throw new Error('A migration file is not a regular file.')
        return true
    } catch (error) {
        if (missing(error)) return false
        throw error
    }
}

async function regularDirectory(fs: FileSystem, directory: string): Promise<boolean> {
    try {
        if (!(await fs.promises.lstat(directory)).isDirectory()) throw new Error('A migration folder is not a regular directory.')
        return true
    } catch (error) {
        if (missing(error)) return false
        throw error
    }
}

async function readJson(fs: FileSystem, target: string): Promise<unknown> {
    return await regularPath(fs, target) ? JSON.parse(await fs.promises.readFile(target, 'utf8')) : undefined
}

async function hashFile(context: MigrationContext, target: string): Promise<string> {
    const digest = context.crypto.createHash('sha256')
    for await (const data of context.fs.createReadStream(target)) digest.update(data)
    return digest.digest('hex')
}

function inside(base: string, relative: string, path: PathTools): string {
    const target = path.resolve(base, relative)
    const child = path.relative(base, target)
    if (!child || path.isAbsolute(child) || child.split(path.sep)[0] === '..') {
        throw new Error('A plugin directory was found outside this vault.')
    }
    return target
}

async function legacyEnabled(context: MigrationContext): Promise<boolean> {
    if (hasActiveLegacyPlugin(context.plugin.app)) return true
    const configured = await readJson(context.fs, context.path.join(context.config, 'community-plugins.json'))
    if (configured === undefined) return false
    if (!Array.isArray(configured) || configured.some(id => typeof id !== 'string')) {
        throw new Error('The enabled community plugin list could not be verified.')
    }
    for (const id of sources) {
        if (configured.includes(id) && await regularDirectory(context.fs, context.path.join(context.plugins, id))) return true
    }
    return false
}

type SavedPlan = { sourceId: SourceId; files: Entry[] }
function readSavedPlan(value: unknown): SavedPlan | undefined {
    if (value === undefined) return undefined
    if (!object(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.files) || !value.files.length ||
        !value.files.every((row: unknown): row is Entry => object(row) && typeof row.path === 'string' && knownFile(row.path) &&
            typeof row.hash === 'string' && digestPattern.test(row.hash)) ||
        new Set(value.files.map(row => row.path)).size !== value.files.length ||
        !value.files.some(row => row.path === 'data.json')) throw new Error('The migration checkpoint is damaged.')
    const sourceId = value.version === 1 ? upstreamPluginId : value.sourceId
    if (sourceId !== previousRudoniumId && sourceId !== upstreamPluginId) throw new Error('Unknown migration source.')
    return { sourceId, files: value.files }
}

async function statePaths(context: MigrationContext, root: string): Promise<string[]> {
    const paths: string[] = []
    const visit = async (directory: string, prefix: string) => {
        for (const name of await context.fs.promises.readdir(directory)) {
            const relative = prefix + name
            const file = context.path.join(directory, name)
            if (knownFile(relative)) {
                if (!await regularPath(context.fs, file)) throw new Error('The list of plugin files changed.')
                paths.push(relative)
            } else if (stateDirectories.test(relative)) {
                if (!await regularDirectory(context.fs, file)) throw new Error('A state directory changed.')
                await visit(file, relative + '/')
            }
        }
    }
    await visit(root, '')
    return paths.sort()
}

function isLegacyData(value: unknown): value is JsonObject {
    return object(value) && object(value.settings) &&
        object(value.settings.Syntax) && object(value.settings.Defaults) && object(value.settings.CUSTOM_REGEXPS) &&
        object(value.fields_dict) && Object.values(value.fields_dict).every(fields =>
            Array.isArray(fields) && fields.every(field => typeof field === 'string')) &&
        object(value['File Hashes']) && Object.values(value['File Hashes']).every(hash => typeof hash === 'string') &&
        Array.isArray(value['Added Media']) && value['Added Media'].every(name => typeof name === 'string')
}

async function inspectMigration(context: MigrationContext): Promise<MigrationPlan> {
    const { fs, path, destination } = context
    if (await legacyEnabled(context)) return { kind: 'legacy-enabled' }
    const ready = await readJson(fs, path.join(destination, readyName))
    if (ready !== undefined) {
        if (!object(ready) || ready.version !== 1 || !['copied', 'fresh'].includes(String(ready.mode)) ||
            ready.mode === 'copied' && !await regularPath(fs, path.join(destination, 'data.json'))) {
            throw new Error('Could not verify the completed migration.')
        }
        return { kind: 'ready' }
    }

    const saved = readSavedPlan(await readJson(fs, path.join(destination, pendingName)))
    if (!saved && await regularPath(fs, path.join(destination, 'data.json'))) return { kind: 'ready' }

    let sourceId: SourceId | undefined
    for (const id of saved ? [saved.sourceId] : sources) {
        const folder = path.join(context.plugins, id)
        if (!await regularDirectory(fs, folder)) continue
        const hasData = await regularPath(fs, path.join(folder, 'data.json'))
        if (id === previousRudoniumId) {
            const previousReady = await readJson(fs, path.join(folder, readyName))
            if (previousReady !== undefined && (!object(previousReady) || previousReady.version !== 1 ||
                !['copied', 'fresh'].includes(String(previousReady.mode)) || previousReady.mode === 'copied' && !hasData)) {
                throw new Error('The previous fork has an inconsistent migration checkpoint.')
            }
            if (previousReady === undefined && await regularPath(fs, path.join(folder, pendingName))) {
                throw new Error('Finish the interrupted migration in the previous version before upgrading.')
            }
            if (!hasData && object(previousReady) && previousReady.mode === 'fresh') {
                if ((await statePaths(context, folder)).length) throw new Error('Previous sync state exists without data.json.')
                break
            }
        }
        if (hasData) { sourceId = id; break }
        if ((await statePaths(context, folder)).length) throw new Error('Previous sync state exists without data.json.')
    }
    if (!sourceId) {
        if (saved) throw new Error('The selected source is missing during migration.')
        if ((await statePaths(context, destination)).length) throw new Error('Destination sync state exists without data.json.')
        return { kind: 'ready' }
    }
    const origin = path.join(context.plugins, sourceId)
    const data = await readJson(fs, path.join(origin, 'data.json'))
    if (!isLegacyData(data)) throw new Error('Could not read the previous plugin settings.')
    const language = (data.settings as JsonObject).INTERFACE_LANGUAGE
    context.t = uiFor({ INTERFACE_LANGUAGE: language === 'ru' ? 'ru' : 'en' })
    const files: Entry[] = []
    for (const relative of await statePaths(context, origin)) {
        files.push({ path: relative, hash: await hashFile(context, path.join(origin, relative)) })
    }
    if (saved && JSON.stringify(saved.files) !== JSON.stringify(files)) {
        throw new Error('The previous plugin files changed after migration began.')
    }
    const expected = new Map(files.map(entry => [entry.path, entry.hash] as const))
    for (const relative of await statePaths(context, destination)) {
        if (!saved || !expected.has(relative) || await hashFile(context, path.join(destination, relative)) !== expected.get(relative)) {
            throw new Error('A destination file does not belong to the same migration plan: ' + relative)
        }
    }

    let indexedIds: number | undefined
    try {
        const index = await readJson(fs, path.join(origin, 'fast-scan-index.json'))
        if (object(index) && Array.isArray(index.idsByPath)) {
            const ids = new Set<number>()
            for (const row of index.idsByPath) {
                if (!Array.isArray(row)) continue
                const stored: unknown = row[1]
                if (!Array.isArray(stored) || !Array.isArray(stored[3])) continue
                const linked: readonly unknown[] = stored[3]
                for (const id of linked) if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ids.add(id)
            }
            indexedIds = ids.size
        }
    } catch {
    }
    return { kind: 'preview', sourceId, files, cachedFiles: Object.keys(data['File Hashes'] as JsonObject).length,
        indexedIds, interrupted: saved !== undefined }
}

async function statePath(context: MigrationContext, root: string, relative: string, create: boolean): Promise<string> {
    if (!knownFile(relative) || await context.fs.promises.realpath(root) !== root) throw new Error('Invalid state path.')
    const parts = relative.split('/')
    let parent = root
    for (const part of parts.slice(0, -1)) {
        parent = context.path.join(parent, part)
        if (!await regularDirectory(context.fs, parent)) {
            if (!create) throw new Error('A source folder disappeared.')
            await context.fs.promises.mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
                if (!object(error) || error.code !== 'EEXIST') throw error
            })
            if (!await regularDirectory(context.fs, parent)) throw new Error('Invalid destination folder.')
        }
    }
    return context.path.join(parent, parts[parts.length - 1])
}

function checkMigrationActive(context: MigrationContext): void {
    if (context.isStopped() || hasActiveLegacyPlugin(context.plugin.app)) {
        throw new Error('Migration paused. Keep the previous plugins disabled and open the new plugin to resume.')
    }
}

async function publishExclusive(context: MigrationContext, target: string,
    prepare: (stage: string) => Promise<void>): Promise<void> {
    checkMigrationActive(context)
    const { fs, crypto } = context
    const staged = target + '.migration-stage-' + crypto.randomBytes(12).toString('hex')
    try {
        await prepare(staged)
        const handle = await fs.promises.open(staged, 'r+')
        try { await handle.sync() } finally { await handle.close() }
        checkMigrationActive(context)
        try { await fs.promises.link(staged, target) }
        catch (error) {
            if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(String((error as NodeJS.ErrnoException).code))) throw error
            await fs.promises.copyFile(staged, target, fs.constants.COPYFILE_EXCL)
        }
    } finally { await fs.promises.rm(staged, { force: true }).catch(() => {}) }
}

async function writeCheckpoint(context: MigrationContext, name: string, value: object): Promise<void> {
    const target = context.path.join(context.destination, name)
    const bytes = JSON.stringify(value)
    await publishExclusive(context, target, async stage => {
        await context.fs.promises.writeFile(stage, bytes, { flag: 'wx', mode: 0o600 })
    })
    if (await context.fs.promises.readFile(target, 'utf8') !== bytes) throw new Error('Incomplete migration checkpoint.')
}

async function copyMigration(context: MigrationContext, expected: Extract<MigrationPlan, { kind: 'preview' }>): Promise<void> {
    const actual = await inspectMigration(context)
    if (actual.kind !== 'preview' || actual.sourceId !== expected.sourceId || JSON.stringify(actual.files) !== JSON.stringify(expected.files)) {
        throw new Error('The migration plan changed. Check the old plugin and preview again.')
    }
    const { fs, path, destination } = context
    const origin = path.join(context.plugins, actual.sourceId)
    if (!actual.interrupted) await writeCheckpoint(context, pendingName,
        { version: 2, sourceId: actual.sourceId, files: actual.files })
    for (const entry of actual.files) {
        const target = await statePath(context, destination, entry.path, true)
        if (!await regularPath(fs, target)) {
            const source = await statePath(context, origin, entry.path, false)
            if (!await regularPath(fs, source)) throw new Error('A migration source file is missing.')
            await publishExclusive(context, target, async stage => {
                await fs.promises.copyFile(source, stage, fs.constants.COPYFILE_EXCL)
                if (await hashFile(context, stage) !== entry.hash) throw new Error('The source changed after preview.')
            })
        }
    }
    const confirmed = await inspectMigration(context)
    if (confirmed.kind !== 'preview' || confirmed.sourceId !== actual.sourceId || JSON.stringify(confirmed.files) !== JSON.stringify(actual.files)) {
        throw new Error('The old plugin files changed during migration.')
    }
    for (const entry of actual.files) {
        if (!await regularPath(fs, await statePath(context, destination, entry.path, false))) throw new Error('A migrated file is missing.')
    }
    await writeCheckpoint(context, readyName, { version: 1, mode: 'copied', sourceId: actual.sourceId })
}

async function migrationContext(plugin: Plugin, isStopped: () => boolean): Promise<MigrationContext> {
    const { app, manifest } = plugin
    const adapter = app.vault.adapter as Partial<FileSystemAdapter>
    if (typeof adapter.getBasePath !== 'function') {
        throw new Error('Migration requires a desktop file-system vault.')
    }
    const root = await fs.promises.realpath(adapter.getBasePath())
    const config = inside(root, app.vault.configDir, path)
    const plugins = path.join(config, 'plugins')
    const relative = manifest.dir ?? `${app.vault.configDir}/plugins/${rudoniumPluginId}`
    const destination = inside(root, relative, path)
    if (destination !== path.join(plugins, rudoniumPluginId) || await fs.promises.realpath(destination) !== destination ||
        await fs.promises.realpath(plugins) !== plugins) {
        throw new Error('The plugin directory cannot be verified for migration.')
    }
    setImageReceiptDirectory(app, relative)
    const t = uiFor()
    return { fs, path, crypto, config, plugins, plugin, isStopped, destination, t }
}

class MigrationModal extends Modal {
    busy = false
    constructor(plugin: Plugin, private readonly context: MigrationContext,
        private readonly plan: Exclude<MigrationPlan, { kind: 'ready' }>,
        private readonly actions: { refresh: () => Promise<void>; finish: () => Promise<void> }) {
        super(plugin.app)
    }

    onOpen(): void {
        const { context, plan } = this
        const { t } = context
        installModalLayout(this, t)
        this.titleEl.setText(t('Move settings to Rudonium Anki Toolkit', 'Перенос настроек в Rudonium Anki Toolkit'))
        const content = this.contentEl
        content.empty()
        const status = content.createEl('p', { attr: { role: 'status' } })
        const controls = content.createDiv({ cls: 'modal-button-container' })
        const run = async (action: () => Promise<void>) => {
            if (this.busy) return
            this.busy = true
            try { await action() }
            catch (error) {
                console.error('[Rudonium Anki Toolkit] Migration error', error)
                const message = error instanceof Error ? error.message : String(error)
                status.setText(t('Migration could not finish. Check the previous plugin and open the migration preview again.',
                    'Перенос не завершился. Проверьте прежний плагин и заново откройте окно переноса.') + ' ' + message)
                status.classList.add('rudonium-text-error')
            } finally { this.busy = false }
        }
        controls.createEl('button', { text: t('Check again', 'Проверить ещё раз') }).onclick =
            () => void run(this.actions.refresh)
        if (plan.kind === 'legacy-enabled') {
            status.setText(t('Disable the previous Rudonium plugin and Export to Anki in Community plugins, then check again.',
                'Выключите прежнюю версию Rudonium и Export to Anki в сторонних плагинах, затем нажмите «Проверить ещё раз».'))
            return
        }
        content.insertBefore(content.createEl('p', { text: t('Source plugin folder: ', 'Папка прежнего плагина: ') + plan.sourceId }), controls)
        status.setText(t('Copy your settings and sync history to keep using your existing Markdown cards and Anki note IDs.',
            'Скопируйте настройки и историю синхронизации, чтобы продолжить работу с существующими карточками Markdown и их ID в Anki.'))
        content.insertBefore(content.createEl('p', { text: t(
            `Files to copy: ${plan.files.length}. Saved Markdown hashes: ${plan.cachedFiles}.`,
            `Файлов для переноса — ${plan.files.length}. Сохранённых хешей Markdown — ${plan.cachedFiles}.`) }), controls)
        if (plan.indexedIds !== undefined) content.insertBefore(content.createEl('p', { text: t(
            `Anki IDs recorded in the previous index: ${plan.indexedIds}. The index is not a live Anki check.`,
            `ID Anki в прежнем индексе — ${plan.indexedIds}. Данные взяты из индекса, Anki не подключалась.`) }), controls)
        controls.createEl('button', { text: plan.interrupted ? t('Resume migration', 'Продолжить перенос') :
            t('Copy settings and state', 'Перенести настройки и данные'), cls: 'mod-cta' }).onclick = () => void run(async () => {
            await copyMigration(context, plan)
            await this.actions.finish()
        })
        if (!plan.interrupted) controls.createEl('button', { text: t('Use new settings', 'Начать с новых настроек') }).onclick = () => void run(async () => {
            const current = await inspectMigration(context)
            if (current.kind !== 'preview' || current.sourceId !== plan.sourceId || current.interrupted) throw new Error('The migration plan changed.')
            await writeCheckpoint(context, readyName, { version: 1, mode: 'fresh', sourceId: plan.sourceId })
            await this.actions.finish()
        })
    }
}

export async function pauseForMigration(plugin: Plugin, start: () => Promise<void>): Promise<boolean> {
    if (plugin.manifest.id !== rudoniumPluginId) return false
    let modal: MigrationModal | undefined
    let started = false
    let stopped = false
    plugin.register(() => { stopped = true; modal?.close() })
    try {
        const context = await migrationContext(plugin, () => stopped)
        if (stopped) return true
        const first = await inspectMigration(context)
        if (stopped) return true
        if (first.kind === 'ready') return false
        const finish = async () => {
            if (context.isStopped() || started) return
            checkMigrationActive(context)
            started = true
            try { await start(); modal?.close() }
            catch (error) { started = false; throw error }
        }
        const review = (plan: Exclude<MigrationPlan, { kind: 'ready' }>) => {
            if (stopped || started) return
            modal?.close()
            modal = new MigrationModal(plugin, context, plan, { finish, refresh })
            modal.open()
        }
        const refresh = async () => {
            if (context.isStopped() || started) return
            const next = await inspectMigration(context)
            if (next.kind === 'ready') await finish()
            else review(next)
        }
        plugin.addCommand({ id: 'review-legacy-migration', name: context.t('Review migration', 'Проверить перенос настроек'),
            checkCallback: checking => {
                if (context.isStopped() || started || modal?.busy) return false
                if (!checking) void refresh().catch(error => {
                    console.error('[Rudonium Anki Toolkit] Migration error', error)
                    new Notice(context.t('Could not verify migration. Restart the plugin and check the previous files.',
                        'Не удалось проверить перенос. Перезапустите плагин и проверьте прежние файлы.'))
                })
                return true
            } })
        review(first)
    } catch (error) {
        if (stopped) return true
        console.error('[Rudonium Anki Toolkit] Could not verify migration', error)
        const message = error instanceof Error ? error.message : String(error)
        new Notice('Rudonium Anki Toolkit: Could not verify plugin files for migration. / Не удалось проверить файлы для переноса. ' + message, 12000)
    }
    return true
}
