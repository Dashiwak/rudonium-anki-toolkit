/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import * as fs from 'fs'
import * as nodePath from 'path'
import { Modal, Notice, TFile, TFolder } from 'obsidian'
import type { App, FileSystemAdapter } from 'obsidian'
import type MyPlugin from '../main'
import { withFastScanReadLock } from './fast-scan'
import { imageHash, optimizeImage, readImageOptimization } from './image-optimizer'
import type { ImageOptimizationSettings } from './image-optimizer'
import { optimizedImageFolder } from './media-sync'
import { resolveSyncScope, syncScopeSignature } from './sync-profiles'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

type Scope = { mode: 'profile' } | { mode: 'folder'; path: string }
type FileIssue = { path: string; message: string }
type Progress = (done: number, total: number) => void
type FileStamp = readonly [mtime: number, ctime: number, size: number, revision: number]

interface ImageCandidate {
    file: TFile
    path: string
    references: string[]
}

interface PreviewRow extends ImageCandidate {
    stamp: FileStamp
    sourceHash: string
    outputHash: string
    before: number
    after: number
    originalWidth: number
    originalHeight: number
    width: number
    height: number
}

interface Preview {
    scope: Scope
    label: string
    scopeSignature?: string
    settings: ImageOptimizationSettings
    total: number
    rows: PreviewRow[]
    issues: FileIssue[]
}

const copiesFolder = optimizedImageFolder.toLowerCase()
const pageSize = 40
const active = new WeakMap<App, Modal>()
const staleImage = (t: UiText) => t('This image changed after preview. Preview it again.', 'Изображение изменилось после предпросмотра. Откройте предпросмотр снова.')

function optimizeSettings(plugin: MyPlugin): ImageOptimizationSettings {
    return { ...readImageOptimization(plugin.settings.IMAGE_OPTIMIZATION), enabled: true }
}

function recipe(settings: ImageOptimizationSettings): string {
    return JSON.stringify([settings.maxWidth, settings.maxHeight, settings.targetKb])
}

function isImage(path: string): boolean {
    return !path.toLowerCase().startsWith(`${copiesFolder}/`) && /\.(?:jpe?g|png)$/i.test(path)
}

function foldersIn(app: App): string[] {
    const folders: string[] = []
    const remaining = [app.vault.getRoot()]
    while (remaining.length) {
        const folder = remaining.pop()!
        folders.push(folder.path === '/' ? '' : folder.path)
        for (const child of folder.children) if (child instanceof TFolder) remaining.push(child)
    }
    return folders.sort((a, b) => a.localeCompare(b))
}

function discover(plugin: MyPlugin, scope: Scope, t: UiText) {
    const { vault, metadataCache } = plugin.app
    const links = metadataCache.resolvedLinks ?? {}
    const candidates = new Map<string, ImageCandidate>()
    const selected = scope.mode === 'profile' ? resolveSyncScope(plugin) : undefined
    const add = (file: TFile) => {
        if (!candidates.has(file.path) && isImage(file.path)) {
            candidates.set(file.path, { file, path: file.path, references: [] })
        }
    }
    if (selected) {
        for (const file of selected.files) {
            for (const path of Object.keys(links[file.path] ?? {})) {
                if (!isImage(path) || candidates.has(path)) continue
                const image = vault.getAbstractFileByPath(path)
                if (image instanceof TFile) add(image)
            }
        }
    } else if (scope.mode === 'folder') {
        const folder = scope.path ? vault.getAbstractFileByPath(scope.path) : vault.getRoot()
        if (!(folder instanceof TFolder)) throw new Error(t(`Folder unavailable: ${scope.path}`, `Папка недоступна: ${scope.path}`))
        const remaining = [folder]
        while (remaining.length) {
            for (const child of remaining.pop()!.children) {
                if (child instanceof TFolder) {
                    if (child.path.toLowerCase() !== copiesFolder) remaining.push(child)
                } else if (child instanceof TFile) add(child)
            }
        }
    }
    for (const [note, targets] of Object.entries(links)) {
        if (/\.md$/i.test(note)) for (const path of Object.keys(targets)) candidates.get(path)?.references.push(note)
    }
    const label = selected ? t(`Images linked from ${selected.label}`, `Изображения, связанные с заметками · ${selected.profileId ? selected.label : 'всё хранилище'}`) :
        scope.mode === 'folder' && scope.path ? t(`Images in ${scope.path}`, `Изображения в папке ${scope.path}`) : t('Images in the entire vault', 'Изображения во всём хранилище')
    return { candidates, label, scopeSignature: selected?.signature }
}

function fileStamp(file: TFile, revision: number): FileStamp {
    return [file.stat.mtime, file.stat.ctime, file.stat.size, revision]
}

function current(app: App, row: ImageCandidate, stamp: FileStamp, revision: (path: string) => number): boolean {
    return app.vault.getAbstractFileByPath(row.path) === row.file && row.file.path === row.path &&
        fileStamp(row.file, revision(row.path)).every((value, index) => value === stamp[index])
}

function checkActive(signal: AbortSignal, t: UiText): void {
    if (signal.aborted) throw new DOMException(t('Image optimization cancelled', 'Оптимизация изображений отменена'), 'AbortError')
}

async function scanImages(plugin: MyPlugin, scope: Scope, signal: AbortSignal, progress: Progress, t: UiText): Promise<Preview> {
    return withFastScanReadLock(plugin, async (_revision, pathRevision) => {
        checkActive(signal, t)
        const settings = optimizeSettings(plugin)
        const { candidates, label, scopeSignature } = discover(plugin, scope, t)
        const rows: PreviewRow[] = []
        const issues: FileIssue[] = []
        let completed = 0
        progress(completed, candidates.size)
        for (const candidate of candidates.values()) {
            checkActive(signal, t)
            try {
                const { path, file } = candidate
                const stamp = fileStamp(file, pathRevision(path))
                const original = await plugin.app.vault.readBinary(file)
                const result = await optimizeImage(original, file.name, settings)
                if (result) {
                    const sourceHash = await imageHash(original)
                    const outputHash = await imageHash(result.bytes)
                    if (!current(plugin.app, candidate, stamp, pathRevision)) throw new Error(staleImage(t))
                    const { originalWidth, originalHeight, width, height } = result
                    rows.push({ ...candidate, stamp, sourceHash, outputHash, before: original.byteLength,
                        after: result.bytes.byteLength, originalWidth, originalHeight, width, height })
                }
            } catch (error) {
                issues.push({ path: candidate.path, message: String(error) })
            }
            progress(++completed, candidates.size)
        }
        checkActive(signal, t)
        rows.sort((a, b) => (b.before - b.after) - (a.before - a.after) || a.path.localeCompare(b.path))
        return { scope, label, scopeSignature, settings, total: candidates.size, rows, issues }
    })
}

interface BackupWriter {
    directory: string
    write(path: string, bytes: ArrayBuffer, hash: string): Promise<void>
}

function desktopAdapter(app: App, t: UiText): FileSystemAdapter {
    const adapter = app.vault.adapter as Partial<FileSystemAdapter>
    if (typeof adapter.getBasePath !== 'function' || typeof app.vault.modifyBinary !== 'function') {
        throw new Error(t('Optimizing original images requires desktop Obsidian and a local vault.', 'Для оптимизации исходных изображений нужны настольный Obsidian и локальное хранилище.'))
    }
    return adapter as FileSystemAdapter
}

async function openBackup(app: App, t: UiText): Promise<BackupWriter> {
    const adapter = desktopAdapter(app, t)
    const vaultRoot = await fs.promises.realpath(adapter.getBasePath())
    const parent = nodePath.dirname(vaultRoot)
    if (parent === vaultRoot) throw new Error(t('The vault needs a parent folder for its image backups.', 'Для резервных копий изображений нужна папка уровнем выше хранилища.'))
    const date = new Date().toISOString().slice(0, 10)
    const directory = await fs.promises.mkdtemp(nodePath.join(parent, `anki-image-backup-${date}-`))
    return {
        directory,
        async write(path, bytes, hash) {
            const relativeParts = path.split('/')
            if (relativeParts.some(part => !part || part === '.' || part === '..')) throw new Error(t('Invalid vault path.', 'Некорректный путь в хранилище.'))
            const target = nodePath.resolve(directory, ...relativeParts)
            const relative = nodePath.relative(directory, target)
            if (!relative || nodePath.isAbsolute(relative) || relative.split(nodePath.sep)[0] === '..') {
                throw new Error(t('The backup path resolved outside its directory.', 'Путь к резервной копии находится вне папки резервных копий.'))
            }
            await fs.promises.mkdir(nodePath.dirname(target), { recursive: true })
            const handle = await fs.promises.open(target, 'wx', 0o600)
            try {
                await handle.writeFile(new Uint8Array(bytes))
                await handle.sync()
            } finally {
                await handle.close()
            }
            const verified = await fs.promises.readFile(target)
            if (await imageHash(Uint8Array.from(verified).buffer) !== hash) throw new Error(t('Could not verify the original backup.', 'Не удалось проверить резервную копию оригинала.'))
        },
    }
}

async function applyImages(plugin: MyPlugin, preview: Preview, selected: readonly PreviewRow[],
    signal: AbortSignal, progress: Progress, t: UiText) {
    return withFastScanReadLock(plugin, async (_revision, pathRevision) => {
        const { app } = plugin
        const { vault } = app
        checkActive(signal, t)
        if (recipe(optimizeSettings(plugin)) !== recipe(preview.settings) ||
            (preview.scope.mode === 'profile' && syncScopeSignature(plugin.settings) !== preview.scopeSignature)) {
            throw new Error(t('Image settings or the sync profile changed. Preview the images again.', 'Настройки изображений или профиль синхронизации изменились. Повторите предпросмотр.'))
        }
        const { candidates } = discover(plugin, preview.scope, t)
        let backup: BackupWriter | undefined
        let confirmed = 0
        let savedBytes = 0
        let completed = 0
        const issues: FileIssue[] = []
        progress(completed, selected.length)
        for (const row of selected) {
            if (signal.aborted) break
            const { file, path } = row
            try {
                if (candidates.get(path)?.file !== file || !current(app, row, row.stamp, pathRevision)) throw new Error(staleImage(t))
                const original = await vault.readBinary(file)
                if (await imageHash(original) !== row.sourceHash) throw new Error(staleImage(t))
                const result = await optimizeImage(original, file.name, preview.settings)
                if (!result || await imageHash(result.bytes) !== row.outputHash) {
                    throw new Error(t('The output differs from the preview. Preview the image again.', 'Итог отличается от предпросмотра. Повторите предпросмотр изображения.'))
                }
                checkActive(signal, t)
                backup ??= await openBackup(app, t)
                await backup.write(path, original, row.sourceHash)
                if (!current(app, row, row.stamp, pathRevision) ||
                    await imageHash(await vault.readBinary(file)) !== row.sourceHash ||
                    !current(app, row, row.stamp, pathRevision)) throw new Error(staleImage(t))
                checkActive(signal, t)
                await vault.modifyBinary(file, result.bytes)
                if (vault.getAbstractFileByPath(path) !== file || await imageHash(await vault.readBinary(file)) !== row.outputHash) {
                    throw new Error(t('Could not confirm the vault write. The original is in the backup folder.', 'Не удалось подтвердить запись в хранилище. Оригинал находится в папке резервных копий.'))
                }
                confirmed++
                savedBytes += row.before - row.after
            } catch (error) {
                if (!signal.aborted) issues.push({ path, message: error instanceof Error ? error.message : String(error) })
            }
            progress(++completed, selected.length)
        }
        return { confirmed, savedBytes, issues, backup: backup?.directory }
    })
}

function formatBytes(bytes: number): string {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
    return `${bytes} B`
}

class LocalImageModal extends Modal {
    private readonly abort = new AbortController()

    private readonly t: UiText

    constructor(private readonly plugin: MyPlugin) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        const { t } = this
        this.titleEl.setText(t('Optimize Images in Obsidian', 'Оптимизация изображений в Obsidian'))
        this.modalEl.classList.add('rudonium-modal-52rem')
        installModalLayout(this, t)
        this.picker()
    }

    onClose(): void {
        this.abort.abort()
        if (active.get(this.app) === this) active.delete(this.app)
        this.contentEl.empty()
    }

    private footer(): HTMLElement {
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        return footer
    }

    private picker(): void {
        const { t } = this
        this.contentEl.empty()
        try {
            desktopAdapter(this.app, t)
        } catch (error) {
            this.contentEl.createEl('p', { text: error instanceof Error ? error.message : String(error) })
            return
        }
        this.contentEl.createEl('p', { text: t('Preview JPEG and PNG savings. Selected originals can be replaced after a verified backup outside the vault.', 'Оцените экономию места для JPEG и PNG. Перед заменой плагин создаст и проверит резервную копию выбранных оригиналов вне хранилища.') })
        const scope = this.contentEl.createEl('label', { text: t('Images to check', 'Какие изображения проверить') }).createEl('select')
        scope.createEl('option', { value: 'profile', text: t('Linked from the current Sync Profile', 'Связаны с заметками текущего профиля синхронизации') })
        scope.createEl('option', { value: 'folder', text: t('Stored in a folder and its subfolders', 'Лежат в выбранной папке и её подпапках') })
        scope.value = 'profile'
        scope.classList.add('rudonium-local-image-optimization-scope')
        const folderPanel = this.contentEl.createDiv()
        folderPanel.hidden = true
        const search = folderPanel.createEl('label', { text: t('Search folders', 'Поиск папок') })
            .createEl('input', { attr: { type: 'search', autocomplete: 'off' } })
        search.classList.add('rudonium-local-image-optimization-search')
        const list = folderPanel.createEl('select', { attr: { size: 7, 'aria-label': t('Folder', 'Папка') } })
        list.classList.add('rudonium-local-image-optimization-list')
        const more = folderPanel.createEl('button', { text: t('Show More Folders', 'Показать ещё папки') })
        const footer = this.footer()
        const preview = footer.createEl('button', { text: t('Preview Images', 'Предпросмотр изображений'), cls: 'mod-cta' })
        let folders: string[] | undefined
        let folder = ''
        let limit = 80
        const renderFolders = () => {
            const query = search.value.trim().toLowerCase()
            const matches = (folders ?? []).filter(path => (path || t('Entire vault', 'Всё хранилище')).toLowerCase().includes(query))
            const shown = matches.slice(0, limit)
            list.empty()
            for (const path of shown) list.createEl('option', { text: path || t('Entire vault (/)', 'Всё хранилище (/)'), value: path })
            list.value = folder
            if (!shown.includes(folder)) list.selectedIndex = -1
            more.hidden = shown.length === matches.length
            preview.disabled = scope.value === 'folder' && list.selectedIndex === -1
        }
        scope.onchange = () => {
            folderPanel.hidden = scope.value !== 'folder'
            if (!folderPanel.hidden) {
                folders ??= foldersIn(this.app).filter(path => path.toLowerCase() !== copiesFolder &&
                    !path.toLowerCase().startsWith(`${copiesFolder}/`))
                search.focus()
            }
            renderFolders()
        }
        search.oninput = () => { limit = 80; renderFolders() }
        more.onclick = () => { limit += 80; renderFolders() }
        list.onchange = () => { folder = list.value; preview.disabled = list.selectedIndex === -1 }
        preview.onclick = () => {
            if (!preview.disabled) void this.preview(scope.value === 'profile' ? { mode: 'profile' } : { mode: 'folder', path: folder })
        }
        scope.focus()
    }

    private async preview(scope: Scope): Promise<void> {
        const { t } = this
        this.contentEl.empty()
        const status = this.contentEl.createEl('p', { text: t('Reading images…', 'Чтение изображений…'), attr: { role: 'status' } })
        this.footer().createEl('button', { text: t('Cancel', 'Отмена') }).onclick = () => this.close()
        try {
            const result = await scanImages(this.plugin, scope, this.abort.signal,
                (done, total) => status.setText(t(`Checked ${done} of ${total} images`, `Проверено изображений: ${done} из ${total}`)), t)
            if (!this.abort.signal.aborted) this.showPreview(result)
        } catch (error) {
            if (!this.abort.signal.aborted) this.showError(error)
        }
    }

    private showPreview(preview: Preview): void {
        const { t } = this
        this.contentEl.empty()
        this.contentEl.createEl('p', { text: preview.label })
        this.contentEl.createEl('p', { text: t(`${preview.rows.length} smaller images found · ${preview.total} checked`, `Можно уменьшить: ${preview.rows.length} · Проверено: ${preview.total}`) })
        this.showIssues(preview.issues)
        const controls = this.contentEl.createDiv()
        const selectAll = controls.createEl('button', { text: t('Select All', 'Выбрать все') })
        const clear = controls.createEl('button', { text: t('Clear Selection', 'Снять выделение') })
        selectAll.classList.add('rudonium-local-image-optimization-select-all')
        controls.hidden = !preview.rows.length
        const status = this.contentEl.createEl('p', { attr: { role: 'status' } })
        const list = this.contentEl.createDiv()
        list.classList.add('rudonium-image-results')
        const more = this.contentEl.createEl('button', { text: t('Show More Images', 'Показать ещё изображения') })
        const footer = this.footer()
        footer.createEl('button', { text: t('Back', 'Назад') }).onclick = () => this.picker()
        const next = footer.createEl('button', { text: t('Review Selected Images', 'Проверить выбранные изображения'), cls: 'mod-cta' })
        const selected = new Set<string>()
        const inputs = new Map<string, HTMLInputElement>()
        let shown = 0
        let savings = 0
        const possibleSavings = preview.rows.reduce((total, row) => total + row.before - row.after, 0)
        const update = () => {
            status.setText(t(`${selected.size} selected · ${formatBytes(savings)} saved`, `Выбрано: ${selected.size} · Экономия: ${formatBytes(savings)}`))
            selectAll.disabled = selected.size === preview.rows.length
            clear.disabled = next.disabled = selected.size === 0
        }
        const append = () => {
            const limit = Math.min(shown + pageSize, preview.rows.length)
            for (; shown < limit; shown++) {
                const row = preview.rows[shown]
                const label = list.createEl('label')
                label.classList.add('rudonium-local-image-optimization-label')
                const input = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': row.path } })
                label.createEl('strong', { text: ` ${row.path}` })
                label.createEl('span', {
                    text: `${row.originalWidth} × ${row.originalHeight} → ${row.width} × ${row.height} · ${formatBytes(row.before)} → ${formatBytes(row.after)}`,
                }).classList.add('rudonium-block')
                if (row.references.length) {
                    const uses = label.createEl('small', { text: t(`${row.references.length} linked notes · ${row.references.slice(0, 5).join(' · ')}`, `Связанных заметок: ${row.references.length} · ${row.references.slice(0, 5).join(' · ')}`) })
                    uses.title = row.references.length > 5 ? t('First five linked notes shown', 'Показаны первые пять связанных заметок') : ''
                }
                inputs.set(row.path, input)
                input.checked = selected.has(row.path)
                input.onchange = () => {
                    if (input.checked && !selected.has(row.path)) {
                        selected.add(row.path)
                        savings += row.before - row.after
                    } else if (!input.checked && selected.delete(row.path)) savings -= row.before - row.after
                    update()
                }
            }
            more.hidden = shown === preview.rows.length
        }
        selectAll.onclick = () => {
            for (const row of preview.rows) selected.add(row.path)
            for (const input of inputs.values()) input.checked = true
            savings = possibleSavings
            update()
        }
        clear.onclick = () => {
            selected.clear()
            for (const input of inputs.values()) input.checked = false
            savings = 0
            update()
        }
        more.onclick = append
        next.onclick = () => this.confirm(preview, preview.rows.filter(row => selected.has(row.path)))
        append()
        update()
    }

    private confirm(preview: Preview, selected: readonly PreviewRow[]): void {
        const { t } = this
        if (!selected.length) return
        const review = Array.from(this.contentEl.children) as HTMLElement[]
        const previousHidden = review.map(element => element.hidden)
        for (const element of review) element.hidden = true
        const confirm = this.contentEl.createDiv()
        confirm.createEl('h3', { text: t(`Replace ${selected.length} original ${selected.length === 1 ? 'image' : 'images'}?`, `Заменить оригиналы? Выбрано изображений: ${selected.length}.`) })
        confirm.createEl('p', { text: t('Obsidian will keep the existing paths. The backup folder will be created beside the vault.', 'Исходные пути сохранятся. Папка резервных копий будет создана рядом с хранилищем.') })
        const footer = confirm.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        const back = footer.createEl('button', { text: t('Back to Selection', 'Вернуться к выбору') })
        back.onclick = () => {
            confirm.remove()
            review.forEach((element, index) => { element.hidden = previousHidden[index] })
        }
        footer.createEl('button', { text: t('Back Up and Replace', 'Создать копии и заменить'), cls: 'mod-warning' }).onclick = () => { void this.apply(preview, selected) }
        back.focus()
    }

    private async apply(preview: Preview, selected: readonly PreviewRow[]): Promise<void> {
        const { t } = this
        this.contentEl.empty()
        const status = this.contentEl.createEl('p', { text: t('Optimizing selected images…', 'Оптимизация выбранных изображений…'), attr: { role: 'status' } })
        this.footer().createEl('button', { text: t('Stop After Current Image', 'Остановить после текущего изображения') }).onclick = () => this.close()
        try {
            const result = await applyImages(this.plugin, preview, selected, this.abort.signal,
                (done, total) => status.setText(t(`Processed ${done} of ${total} images`, `Обработано изображений: ${done} из ${total}`)), t)
            const summary = t(`Optimized ${result.confirmed} of ${selected.length} images · ${formatBytes(result.savedBytes)} saved`, `Оптимизировано изображений: ${result.confirmed} из ${selected.length} · Экономия: ${formatBytes(result.savedBytes)}`)
            if (this.abort.signal.aborted) {
                if (result.backup) new Notice(t(`${summary}\nBackup: ${result.backup}`, `${summary}\nРезервные копии: ${result.backup}`), 9000)
                return
            }
            this.contentEl.empty()
            this.contentEl.createEl('p', { text: summary })
            if (result.backup) this.contentEl.createEl('p', { text: t(`Backups: ${result.backup}`, `Резервные копии: ${result.backup}`) }).classList.add('rudonium-wrap-anywhere')
            this.showIssues(result.issues)
            const footer = this.footer()
            footer.createEl('button', { text: t('Check More Images', 'Проверить другие изображения') }).onclick = () => this.picker()
        } catch (error) {
            if (!this.abort.signal.aborted) this.showError(error)
        }
    }

    private showIssues(issues: readonly FileIssue[]): void {
        const { t } = this
        if (!issues.length) return
        const details = this.contentEl.createEl('details')
        details.createEl('summary', { text: t(`Could not process ${issues.length} ${issues.length === 1 ? 'image' : 'images'}`, `Не удалось обработать изображения: ${issues.length}`) })
        const list = details.createEl('ul')
        const more = details.createEl('button', { text: t('Show More Issues', 'Показать ещё ошибки') })
        let shown = 0
        const append = () => {
            const limit = Math.min(shown + pageSize, issues.length)
            for (; shown < limit; shown++) {
                const issue = issues[shown]
                list.createEl('li', { text: `${issue.path} · ${issue.message}` }).classList.add('rudonium-wrap-anywhere')
            }
            more.hidden = shown === issues.length
        }
        more.onclick = append
        append()
    }

    private showError(error: unknown): void {
        const { t } = this
        this.contentEl.empty()
        this.contentEl.createEl('p', { text: error instanceof Error ? error.message : String(error) })
        const footer = this.footer()
        footer.createEl('button', { text: t('Back', 'Назад') }).onclick = () => this.picker()
    }
}

export function openLocalImageOptimization(plugin: MyPlugin): void {
    if (active.has(plugin.app)) return
    const modal = new LocalImageModal(plugin)
    active.set(plugin.app, modal)
    modal.open()
}
