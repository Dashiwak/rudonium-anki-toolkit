/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { MarkdownView, Modal, Notice, TFile, TFolder } from 'obsidian'
import { openObsidianFile } from './obsidian-navigation'
import type { App } from 'obsidian'
import { Md5 } from 'ts-md5'
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

export interface CloudFolderIssue { path: string; reason: string }

export interface CloudFolderResult {
    folder: string
    checked: number
    unchanged: number
    changed: CloudFolderIssue[]
    unindexed: CloudFolderIssue[]
    unavailable: CloudFolderIssue[]
    complete: boolean
}

interface CloudFolderOptions {
    expectedHash: (path: string) => string | undefined
    pathRevision: (path: string) => number
    include?: (path: string) => boolean
    t?: UiText
}

type Progress = (completed: number, total: number) => void
type RunCheck = (folder: string, signal: AbortSignal, report: Progress) => Promise<CloudFolderResult>
type EntryOutcome = { status: 'unchanged' } | { status: 'changed' | 'unindexed' | 'unavailable'; reason: string }

interface Snapshot {
    file: TFile
    path: string
    mtime: number
    ctime: number
    size: number
    revision: number
}

const readBatchSize = 8
const rowsPerPage = 40
const activeChecks = new WeakMap<App, Modal>()

function cancelled(): DOMException {
    return new DOMException('Folder check cancelled', 'AbortError')
}

function waitForRead<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending
    let abort: () => void
    return new Promise<T>((resolve, reject) => {
        abort = () => reject(cancelled())
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void pending.then(resolve, reject)
    }).finally(() => signal.removeEventListener('abort', abort))
}

function dirtyMarkdownPaths(app: App): Set<string> {
    const dirty = new Set<string>()
    for (const { view } of app.workspace.getLeavesOfType('markdown')) {
        if (view instanceof MarkdownView && view.file && view.getMode() === 'source' &&
            view.getViewData().replace(/\r\n/g, '\n') !== view.data.replace(/\r\n/g, '\n')) dirty.add(view.file.path)
    }
    return dirty
}

/** Сопоставляет сохранённый Markdown с подтверждённым экспортом без предположений на основе времени файла. */
export async function checkCloudFolder(app: App, folder: string, options: CloudFolderOptions,
    signal?: AbortSignal, onProgress?: Progress): Promise<CloudFolderResult> {
    if (signal?.aborted) throw cancelled()
    const { vault } = app
    const t = options.t ?? englishUi
    const changedDuringCheck = t('The file changed during the check. Run the check again.',
        'Файл изменился во время проверки. Запустите её повторно.')
    const unsavedEdits = t('This editor has unsaved changes. Save the note and check again.',
        'В редакторе есть несохранённые изменения. Сохраните заметку и повторите проверку.')
    const directory = folder ? vault.getAbstractFileByPath(folder) : null
    if (folder && !(directory instanceof TFolder)) throw new Error(t(`Folder is unavailable: ${folder}`, `Папка недоступна: ${folder}`))
    const folderRevision = folder ? options.pathRevision(folder) : undefined
    const prefix = folder ? `${folder}/` : ''
    const inFolder = (file: TFile) => file.path.startsWith(prefix) && (options.include?.(file.path) ?? true)
    const same = (snapshot: Snapshot) => {
        const { file, path, mtime, ctime, size, revision } = snapshot
        return file.path === path && options.pathRevision(path) === revision &&
            file.stat.mtime === mtime && file.stat.ctime === ctime && file.stat.size === size
    }
    const snapshots = vault.getMarkdownFiles().filter(inFolder).map(file => {
        const { path, stat: { mtime, ctime, size } } = file
        return { file, path, mtime, ctime, size, revision: options.pathRevision(path) }
    })
    const initiallyDirty = dirtyMarkdownPaths(app)
    const statuses: EntryOutcome[] = []
    onProgress?.(0, snapshots.length)

    for (let start = 0; start < snapshots.length; start += readBatchSize) {
        if (signal?.aborted) throw cancelled()
        const batch = await waitForRead(Promise.all(snapshots.slice(start, start + readBatchSize).map(async snapshot => {
            const { path, file } = snapshot
            if (initiallyDirty.has(path)) return { status: 'unavailable', reason: unsavedEdits } as const
            if (!same(snapshot)) return { status: 'unavailable', reason: changedDuringCheck } as const
            try {
                const text = await vault.read(file)
                if (signal?.aborted || !same(snapshot)) return { status: 'unavailable', reason: changedDuringCheck } as const
                const expected = options.expectedHash(path)
                if (expected === undefined) return { status: 'unindexed', reason: t('No confirmed export is recorded for this file.', 'Для файла ещё нет подтверждённого экспорта.') } as const
                return Md5.hashStr(text) === expected
                    ? { status: 'unchanged' } as const
                    : { status: 'changed', reason: t('Saved text differs from the last confirmed export.', 'Текст отличается от последнего подтверждённого экспорта.') } as const
            } catch (error) {
                return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) } as const
            }
        })), signal)
        statuses.push(...batch)
        onProgress?.(Math.min(start + readBatchSize, snapshots.length), snapshots.length)
    }

    if (signal?.aborted) throw cancelled()
    const result: CloudFolderResult = { folder, checked: 0, unchanged: 0, changed: [], unindexed: [], unavailable: [], complete: true }
    const finallyDirty = dirtyMarkdownPaths(app)
    const live = new Map<string, TFile>()
    for (const file of vault.getMarkdownFiles()) if (inFolder(file)) live.set(file.path, file)
    if (folder && (vault.getAbstractFileByPath(folder) !== directory || options.pathRevision(folder) !== folderRevision)) {
        result.unavailable.push({ path: folder, reason: t('The selected folder changed during the check. Pick the folder again.', 'Папка изменилась во время проверки. Выберите её заново.') })
    }
    for (let i = 0; i < snapshots.length; i++) {
        const snapshot = snapshots[i]
        const { path, file } = snapshot
        let outcome = statuses[i]
        if (finallyDirty.has(path)) outcome = { status: 'unavailable', reason: unsavedEdits }
        else if (live.get(path) !== file || !same(snapshot)) outcome = { status: 'unavailable', reason: changedDuringCheck }
        live.delete(path)
        if (outcome.status === 'unchanged') result.unchanged++
        else result[outcome.status].push({ path, reason: outcome.reason })
        if (outcome.status !== 'unavailable') result.checked++
    }
    for (const path of live.keys()) {
        result.unavailable.push({ path, reason: t('The file appeared during the check. Run the check again.', 'Файл появился во время проверки. Запустите её повторно.') })
    }
    result.complete = result.unavailable.length === 0
    return result
}

function folderChoices(app: App): string[] {
    const folders = new Set([''])
    // Obsidian предоставляет дерево хранилища. Пути папок также можно получить из путей файлов Markdown.
    const root = app.vault.getRoot?.()
    if (root) {
        const queue = [root]
        while (queue.length) {
            const parent = queue.pop()!
            for (const item of parent.children) {
                if (!(item instanceof TFolder)) continue
                folders.add(item.path)
                queue.push(item)
            }
        }
    } else {
        for (const { path } of app.vault.getMarkdownFiles()) {
            for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) folders.add(path.slice(0, i))
        }
    }
    return Array.from(folders).sort((a, b) => a.localeCompare(b))
}

class CloudFolderModal extends Modal {
    private readonly abort = new AbortController()
    private readonly run: RunCheck
    private readonly preferred: string

    constructor(app: App, run: RunCheck, preferred: string, private readonly t: UiText) {
        super(app)
        this.run = run
        this.preferred = preferred
    }

    onOpen(): void {
        this.titleEl.setText(this.t('Check Folder after Cloud Sync', 'Проверка папки после облачной синхронизации'))
        this.modalEl.classList.add('rudonium-modal-48rem')
        installModalLayout(this, this.t)
        this.showPicker()
    }

    onClose(): void {
        this.abort.abort()
        if (activeChecks.get(this.app) === this) activeChecks.delete(this.app)
        this.contentEl.empty()
    }

    private footer(): HTMLElement { return this.contentEl.createDiv({ cls: 'modal-button-container' }) }

    private showPicker(): void {
        this.contentEl.empty()
        this.contentEl.createEl('p', { text: this.t('Compare saved Markdown in a folder and its subfolders with the last confirmed export. This check reads files and does not write to Anki.', 'Сравните сохранённые заметки этой папки и её подпапок с последним подтверждённым экспортом. Проверка открывает файлы только для чтения.') })
        const folders = folderChoices(this.app)
        const names = folders.map(path => {
            const label = path || this.t('Entire vault (/)', 'Всё хранилище (/)')
            return { path, label, search: label.toLocaleLowerCase() }
        })
        const search = this.contentEl.createEl('input', { attr: { type: 'search', placeholder: this.t('Search folders', 'Поиск папок'), 'aria-label': this.t('Search folders', 'Поиск папок') } })
        const list = this.contentEl.createEl('select', { attr: { size: 10, 'aria-label': this.t('Folder to check', 'Папка для проверки') } })
        list.classList.add('rudonium-cloud-folder-check-list')
        const footer = this.footer()
        const check = footer.createEl('button', { text: this.t('Check Folder', 'Проверить папку'), cls: 'mod-cta' })
        let selected = folders.includes(this.preferred) ? this.preferred : ''
        const filter = () => {
            const query = search.value.trim().toLocaleLowerCase()
            const visible = names.filter(row => row.search.includes(query))
            list.empty()
            for (const row of visible) list.createEl('option', { text: row.label, value: row.path })
            if (visible.some(row => row.path === selected)) list.value = selected
            else list.selectedIndex = -1
            check.disabled = list.selectedIndex < 0
        }
        const start = () => {
            if (list.selectedIndex >= 0) void this.check(list.value)
        }
        search.oninput = filter
        list.onchange = () => { selected = list.value; check.disabled = list.selectedIndex < 0 }
        list.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); start() } }
        check.onclick = start
        filter()
        search.focus()
    }

    private async check(path: string): Promise<void> {
        this.contentEl.empty()
        const status = this.contentEl.createEl('p', { text: this.t('Reading saved Markdown…', 'Читаем сохранённые заметки…'), attr: { role: 'status' } })
        this.footer().createEl('button', { text: this.t('Cancel', 'Отмена') }).onclick = () => this.close()
        try {
            let updated = 0
            const result = await this.run(path, this.abort.signal, (completed, total) => {
                const now = performance.now()
                if (!this.abort.signal.aborted && (completed === 0 || completed === total || now - updated >= 80)) {
                    status.setText(this.t(`Checked ${completed} of ${total} files`, `Проверено файлов: ${completed} из ${total}`))
                    updated = now
                }
            })
            if (!this.abort.signal.aborted) this.showResult(result)
        } catch (error) {
            if (this.abort.signal.aborted) return
            status.setText(error instanceof Error ? error.message : String(error))
            this.footer().createEl('button', { text: this.t('Choose Folder', 'Выбрать папку') }).onclick = () => this.showPicker()
        }
    }

    private showResult(result: CloudFolderResult): void {
        this.contentEl.empty()
        this.contentEl.createEl('p', { text: result.folder || this.t('Entire vault (/)', 'Всё хранилище (/)') })
        this.contentEl.createEl('p', { text: this.t(`Checked ${result.checked} · Unchanged ${result.unchanged} · Changed ${result.changed.length} · Unindexed ${result.unindexed.length} · Unavailable ${result.unavailable.length}`,
            `Проверено: ${result.checked} · Без правок: ${result.unchanged} · Изменено: ${result.changed.length} · Без экспорта: ${result.unindexed.length} · Недоступно: ${result.unavailable.length}`) })
        if (!result.complete) this.contentEl.createEl('p', { text: this.t('The check is incomplete. Resolve the unavailable files and run it again.', 'Проверка завершилась частично. Устраните ошибки доступа и повторите её.'), cls: 'mod-warning' })
        this.showIssues(this.t('Changed since last confirmed export', 'Изменены после последнего экспорта'), result.changed)
        this.showIssues(this.t('Unavailable', 'Недоступны'), result.unavailable)
        this.showIssues(this.t('Without a confirmed export', 'Без подтверждённого экспорта'), result.unindexed)
        const footer = this.footer()
        footer.createEl('button', { text: this.t('Choose Folder', 'Выбрать папку') }).onclick = () => this.showPicker()
    }

    private showIssues(title: string, rows: readonly CloudFolderIssue[]): void {
        if (!rows.length) return
        const details = this.contentEl.createEl('details')
        details.open = true
        details.createEl('summary', { text: `${title} · ${rows.length}` })
        const list = details.createEl('ul')
        const more = details.createEl('button')
        let displayed = 0
        const append = () => {
            const end = Math.min(rows.length, displayed + rowsPerPage)
            for (; displayed < end; displayed++) {
                const { path, reason } = rows[displayed]
                const entry = list.createEl('li')
                entry.classList.add('rudonium-wrap-anywhere')
                entry.createEl('strong', { text: path })
                entry.createEl('div', { text: reason })
                if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
                    entry.createEl('button', { text: this.t('Open in Obsidian', 'Открыть в Obsidian') }).onclick = () => { void this.openPath(path) }
                }
            }
            more.hidden = displayed === rows.length
            const remaining = Math.min(rowsPerPage, rows.length - displayed)
            more.setText(this.t(`Show ${remaining} more`, `Показать ещё ${remaining}`))
        }
        more.onclick = append
        append()
    }

    private async openPath(path: string): Promise<void> {
        try {
            await openObsidianFile(this.app, path, { modal: this, isClosed: () => this.abort.signal.aborted })
        } catch (error) {
            if (!this.abort.signal.aborted) new Notice(error instanceof Error ? error.message : String(error))
        }
    }
}

export function openCloudFolderCheck(app: App, run: RunCheck, preferredFolder = '', t: UiText = englishUi): void {
    activeChecks.get(app)?.close()
    const modal = new CloudFolderModal(app, run, preferredFolder, t)
    activeChecks.set(app, modal)
    modal.open()
}
