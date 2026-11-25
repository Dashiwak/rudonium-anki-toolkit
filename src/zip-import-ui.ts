/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { hashes as crypto } from './desktop-io'
import { Modal, Notice, Setting, TFile } from 'obsidian'
import type MyPlugin from '../main'
import { previewVaultExport } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { openObsidianFile } from './obsidian-navigation'
import { applyZipImport, compareZipImport, inspectZipImportRecovery, prepareZipImport, recoverZipImport } from './zip-import'
import type { ZipImportArchive, ZipImportPlan, ZipImportProgress, ZipImportRow } from './zip-import'
import { preparePhonePackage } from './zip-transfer-package'
import { archiveScopeSignature, previewArchiveFiles, readArchiveSettings } from './archive-settings'
import { archiveSize, describeArchiveScope, installArchiveSettings, openArchiveFolders } from './archive-settings-ui'
import { installBackupSettings, openVaultBackups } from './backup-settings-ui'
import { inspectVaultBackupSource } from './vault-backup'

export interface ZipImportOpenOptions { sourcePath?: string; prefix?: string; target?: string }

type ImportResult = { paths: string[]; markdownPaths: string[]; backupPath: string; folder?: string }
type Stage = 'idle' | 'reading' | 'comparing' | 'applying'
const current = new WeakMap<MyPlugin, ZipImportModal>()
const packages = new WeakMap<MyPlugin, PhonePackageModal>()
const exchanges = new WeakMap<MyPlugin, Modal>()
const lastResults = new WeakMap<MyPlugin, ImportResult>()
const pageSize = 25
const comparisonLimit = 256 * 1024

function bytes(value: number): string {
    return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB`
        : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value.toLocaleString()} B`
}

function cleanPath(value: string): string {
    const path = value.trim()
    return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

function progressText(progress: ZipImportProgress, t: UiText): string {
    const label: Record<string, string> = {
        read: t('Reading archive', 'Чтение архива'), enumerate: t('Checking archive entries', 'Проверка содержимого архива'),
        verify: t('Verifying archive', 'Проверка архива'), restore: t('Unpacking archive', 'Распаковка архива'),
        compare: t('Comparing files', 'Сравнение файлов'), backup: t('Saving previous versions', 'Сохранение прежних версий'),
        apply: t('Applying selected changes', 'Применение выбранных изменений'),
        recovery: t('Recovering the interrupted import', 'Восстановление после прерванного импорта'),
        write: t('Preparing ZIP', 'Подготовка ZIP'),
    }
    return `${label[progress.phase] ?? t('Processing files', 'Обработка файлов')} · ${progress.files.toLocaleString()}` +
        (progress.totalFiles ? ` / ${progress.totalFiles.toLocaleString()}` : '') +
        (progress.bytes ? ` · ${bytes(progress.bytes)}` : '') + (progress.path ? `\n${progress.path}` : '')
}

function stateText(row: ZipImportRow, t: UiText): string {
    if (row.status === 'different' && row.changeOrigin) {
        return row.changeOrigin === 'phone' ? t('Changed in incoming ZIP', 'Изменён во входящем ZIP')
            : row.changeOrigin === 'desktop' ? t('Changed on computer', 'Изменён на компьютере')
                : t('Changed on both devices', 'Изменён с обеих сторон')
    }
    const states: Record<ZipImportRow['status'], string> = {
        new: t('New', 'Новый'), same: t('Identical', 'Совпадает'), different: t('Different · choose a version', 'Отличается · требуется выбор'),
        'already-imported': t('Already imported', 'Уже импортирован'), blocked: t('Needs attention', 'Требует проверки'),
    }
    return states[row.status]
}

function selectable(row: ZipImportRow): boolean { return row.status === 'new' || row.status === 'different' }

function zipDiagnostic(error: unknown, t: UiText): string {
    if (error instanceof Error && error.name === 'AbortError') return t('Reading cancelled.', 'Чтение отменено.')
    const message = error instanceof Error ? error.message : String(error)
    if (t('en', 'ru') === 'en') return message
    const bilingual = message.search(/ \/ (?=[А-ЯЁ])/u)
    if (bilingual >= 0) return message.slice(bilingual + 3)
    const rules: Array<[RegExp, string]> = [
        [/^ZIP import requires desktop Obsidian\.$/u, 'Для импорта ZIP нужен настольный Obsidian.'],
        [/^Choose an absolute path to a ZIP archive\.$/u, 'Выберите ZIP кнопкой или укажите полный путь к архиву.'],
        [/^Choose a ZIP file\.$/u, 'Выберите ZIP-файл.'],
        [/^The ZIP archive is larger than the supported 2 GiB import size\.$/u, 'Архив превышает поддерживаемый размер 2 ГиБ. Разделите его на несколько пакетов.'],
        [/^The ZIP changed while it was being read\.$/u, 'Архив изменился во время чтения. Выберите его заново.'],
        [/^The extracted ZIP file changed: (.+)$/u, 'Изменился распакованный файл $1. Прочитайте архив заново.'],
        [/^A Markdown file exceeds the supported 16 MiB import size: (.+)$/u, 'Markdown-файл $1 превышает поддерживаемый размер 16 МиБ.'],
        [/^The ZIP transfer metadata is too large\.$/u, 'Служебные данные пакета превышают поддерживаемый размер.'],
        [/^The ZIP import contains an unsupported extracted file\.$/u, 'В распакованном архиве обнаружен неподдерживаемый файл.'],
        [/^Markdown in the ZIP is not valid UTF-8: (.+)$/u, 'Markdown-файл $1 сохранён в неподдерживаемой кодировке. Используйте UTF-8.'],
        [/^Markdown in the ZIP contains a NUL character: (.+)$/u, 'Markdown-файл $1 содержит недопустимый нулевой символ.'],
        [/^The ZIP has no supported Markdown notes or attachments to import\.$/u, 'В ZIP нет поддерживаемых заметок Markdown и вложений для импорта.'],
        [/^Reopen the ZIP archive before importing\.$/u, 'Перед импортом прочитайте ZIP заново.'],
        [/^This file is outside the checked ZIP import\.$/u, 'Этот файл находится за пределами проверенного архива.'],
        [/^ZIP contains a path that cannot be safely restored: (.+)$/u, 'В ZIP обнаружен недопустимый путь $1.'],
        [/^ZIP contains conflicting paths: (.+)$/u, 'В ZIP повторяются или конфликтуют пути $1.'],
        [/^ZIP links and special files are unsupported\.$/u, 'Архив содержит ссылки или специальные файлы.'],
        [/^The ZIP contains an encrypted, multi-disk or unsupported entry\.$/u, 'Архив содержит зашифрованные, многотомные или неподдерживаемые файлы.'],
        [/^ZIP checksum or length mismatch: (.+)$/u, 'Не совпала контрольная сумма или длина файла $1.'],
        [/^This is not a complete ZIP archive\.$/u, 'ZIP-архив неполный или повреждён.'],
        [/^This ZIP is an Anki collection backup\. Choose Obsidian\.zip for vault transfer; restore Anki\.zip in Anki\.$/u,
            'Это резервная копия коллекции Anki. Для переноса заметок выберите Obsidian.zip; Anki.zip восстанавливается в Anki.'],
    ]
    for (const [pattern, translation] of rules) if (pattern.test(message)) return message.replace(pattern, translation)
    return uiDiagnostic(error, t)
}

function comparisonPane(parent: HTMLElement, title: string, text: string | undefined,
    other: string | undefined, t: UiText): void {
    const pane = parent.createDiv()
    pane.classList.add('rudonium-shrink')
    pane.createEl('h3', { text: title })
    if (text === undefined) {
        pane.createEl('p', { text: t('This version is unavailable.', 'Эта версия недоступна.') })
        return
    }
    const visible = text.slice(0, comparisonLimit)
    const allLines = visible.split(/\r\n|\r|\n/u)
    const lines = allLines.slice(0, 1500)
    const comparison = other?.slice(0, comparisonLimit).split(/\r\n|\r|\n/u).slice(0, 1500) ?? []
    let first = 0
    while (first < lines.length && first < comparison.length && lines[first] === comparison[first]) first++
    let tail = 0
    while (tail < lines.length - first && tail < comparison.length - first &&
        lines[lines.length - 1 - tail] === comparison[comparison.length - 1 - tail]) tail++
    const pre = pane.createEl('pre', { attr: { tabindex: '0' } })
    pre.classList.add('rudonium-zip-import-pre')
    for (let index = 0; index < lines.length; index++) {
        const line = pre.createSpan({ text: `${index + 1}  ${lines[index]}\n` })
        if (index >= first && index < lines.length - tail) {
            line.classList.add('rudonium-zip-import-line')
        }
    }
    if (text.length > comparisonLimit || allLines.length > lines.length) pane.createEl('p', {
        text: t('Only the beginning is displayed. The import compares the complete file.',
            'Показано начало файла. При импорте сравнивается файл целиком.'),
    })
}

class ZipComparisonModal extends Modal {
    private closed = false
    private readonly objectUrls: string[] = []
    constructor(private readonly plugin: MyPlugin, private readonly archive: ZipImportArchive,
        private readonly row: ZipImportRow) { super(plugin.app) }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Compare ZIP File', 'Сравнение файла из ZIP'))
        this.modalEl.classList.add('rudonium-modal-72rem')
        installModalLayout(this, t)
        this.contentEl.createEl('p', { text: this.row.path }).classList.add('rudonium-wrap-anywhere')
        void this.load()
    }

    private async load(): Promise<void> {
        const t = uiFor(this.plugin.settings)
        try {
            if (!this.row.markdown) {
                await this.showAttachment(t)
                return
            }
            let archived = this.row.archiveText
            if (archived === undefined && this.row.size <= comparisonLimit) {
                archived = new TextDecoder('utf-8', { fatal: true }).decode(await this.archive.read(this.row.archivePath))
            }
            let local = this.row.currentText
            const file = this.plugin.app.vault.getAbstractFileByPath(this.row.path)
            if (local === undefined && file instanceof TFile && file.stat.size <= comparisonLimit) {
                local = await this.plugin.app.vault.read(file)
            }
            if (this.closed) return
            if (archived === undefined && this.row.size > comparisonLimit) {
                this.contentEl.createEl('p', { text: t(
                    'This file is too large for the text viewer. Its complete content is still verified before import.',
                    'Файл слишком большой для просмотра текста. Перед импортом его содержимое проверяется целиком.') })
            }
            const panes = this.contentEl.createDiv()
            panes.classList.add('rudonium-zip-import-panes')
            comparisonPane(panes, t('Current Obsidian file', 'Сейчас в Obsidian'), local, archived, t)
            comparisonPane(panes, t('Incoming ZIP file', 'Во входящем ZIP'), archived, local, t)
        } catch (error) {
            if (!this.closed) this.contentEl.createEl('p', { text: zipDiagnostic(error, t), attr: { role: 'alert' } })
        }
    }

    private async showAttachment(t: UiText): Promise<void> {
        const current = this.plugin.app.vault.getAbstractFileByPath(this.row.path)
        const file = current instanceof TFile ? current : undefined
        const local = file && file.stat.size <= 8 * 1024 * 1024
            ? new Uint8Array(await this.plugin.app.vault.readBinary(file)) : undefined
        const incoming = this.row.size <= 8 * 1024 * 1024 ? await this.archive.read(this.row.archivePath) : undefined
        if (this.closed) return
        this.contentEl.createEl('p', { text: t(
            'Selecting this file for import replaces its complete contents. Review both versions before selecting it.',
            'Выбор файла для импорта заменяет его содержимое целиком. Сверьте обе версии перед выбором.') })
        const panes = this.contentEl.createDiv()
        panes.classList.add('rudonium-zip-import-panes')
        const extension = /\.([^.]+)$/u.exec(this.row.archivePath)?.[1].toLowerCase()
        const rasterTypes: Record<string, string> = { png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' }
        const type = extension && rasterTypes[extension]
        for (const [title, data, size] of [[t('Current Obsidian file', 'Сейчас в Obsidian'), local, file?.stat.size],
            [t('Incoming ZIP file', 'Во входящем ZIP'), incoming, this.row.size]] as const) {
            const pane = panes.createDiv()
            pane.classList.add('rudonium-shrink')
            pane.createEl('h3', { text: title })
            pane.createEl('p', { text: size === undefined ? t('No current file', 'Файл отсутствует') : bytes(size) })
            if (data) {
                const digest = crypto.createHash('sha256').update(data).digest('hex')
                pane.createEl('p', { text: `SHA-256 · ${digest}` }).classList.add('rudonium-wrap-anywhere')
                if (type) {
                    const url = URL.createObjectURL(new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type }))
                    this.objectUrls.push(url)
                    const image = pane.createEl('img', { attr: { src: url, alt: title } })
                    image.classList.add('rudonium-zip-import-image')
                }
            } else if (size !== undefined) pane.createEl('p', { text: t('Preview is limited to 8 MiB per attachment.', 'Предпросмотр ограничен 8 МиБ на вложение.') })
        }
    }

    onClose(): void {
        this.closed = true
        for (const url of this.objectUrls) URL.revokeObjectURL(url)
        this.objectUrls.length = 0
    }
}

class PhonePackageModal extends Modal {
    private controller?: AbortController
    private closed = false
    private busy = false
    private previewRevision = 0
    private savedScope = true
    constructor(private readonly plugin: MyPlugin) { super(plugin.app) }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Create Transfer ZIP', 'Создать ZIP для переноса'))
        installModalLayout(this, t)
        this.contentEl.createEl('p', { text: t(
            'Review the chosen files before creating a ZIP. The package preserves vault-relative paths and Anki IDs. The reference snapshot stays on this computer.',
            'Проверьте состав перед созданием ZIP. Пакет сохраняет пути хранилища и Anki ID. Исходный снимок остаётся на этом компьютере.') })
        const settings = readArchiveSettings(this.plugin.settings.ARCHIVE_TRANSFER)
        let previewReady = false
        let previewKey = ''
        let update = () => {}
        const selection = this.contentEl.createEl('p')
        const preview = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        status.classList.add('rudonium-wrapped-text')
        const folders = new Setting(this.contentEl).setName(t('Use saved folder selection', 'Использовать сохранённый выбор папок'))
        let savedToggle!: { setDisabled(value: boolean): unknown }
        const folderLabel = this.contentEl.createEl('label', { text: t('Single vault folder', 'Одна папка в хранилище') })
        const folder = folderLabel.createEl('input', { attr: { type: 'text', placeholder: 'Vocabulary', spellcheck: 'false' } })
        folder.classList.add('rudonium-zip-import-folder')
        const scopeHelp = this.contentEl.createEl('p')
        const currentKey = () => JSON.stringify([this.savedScope, this.savedScope ? '' : folder.value.trim(),
            this.savedScope ? archiveScopeSignature(readArchiveSettings(this.plugin.settings.ARCHIVE_TRANSFER)) : ''])
        const updatePreview = () => {
            const revision = ++this.previewRevision
            previewReady = false
            update()
            const current = readArchiveSettings(this.plugin.settings.ARCHIVE_TRANSFER)
            const key = currentKey()
            selection.setText(this.savedScope ? describeArchiveScope(current, t)
                : folder.value.trim() ? t(`Folder · ${folder.value.trim()}`, `Папка · ${folder.value.trim()}`) : t('All vault folders', 'Все папки хранилища'))
            folderLabel.hidden = this.savedScope
            scopeHelp.setText(t(
                'Excluded folders and attachments stay outside the ZIP. Images omitted from a package must already exist at the destination for their links to work.',
                'Исключённые папки и вложения остаются за пределами ZIP. Для работы ссылок пропущенные изображения уже должны находиться в месте назначения.'))
            void previewArchiveFiles(this.plugin, { folder: this.savedScope ? '' : folder.value.trim(), useSavedScope: this.savedScope }).then(result => {
                if (this.closed || revision !== this.previewRevision) return
                previewKey = key
                previewReady = result.totalFiles > 0
                preview.setText(t(
                    `${result.totalFiles.toLocaleString()} files · Markdown ${result.markdownFiles.toLocaleString()} · attachments ${result.attachments.toLocaleString()} · ${archiveSize(result.totalBytes)}. Excluded ${result.excludedFiles.toLocaleString()} files.`,
                    `Файлов ${result.totalFiles.toLocaleString()} · Markdown ${result.markdownFiles.toLocaleString()} · вложений ${result.attachments.toLocaleString()} · ${archiveSize(result.totalBytes)}. Исключено файлов ${result.excludedFiles.toLocaleString()}.`))
                update()
            }, error => { if (!this.closed && revision === this.previewRevision) { previewReady = false; preview.setText(zipDiagnostic(error, t)); update() } })
        }
        folders.addToggle(control => {
            savedToggle = control
            control.setValue(this.savedScope).onChange(value => { if (!this.busy) { this.savedScope = value; updatePreview() } })
        }).addButton(button => button.setButtonText(t('Choose Folders', 'Выбрать папки')).onClick(() => openArchiveFolders(this.plugin, updatePreview)))
        folder.oninput = updatePreview
        let changedOnly = this.savedScope && settings.changedOnly
        let changedToggle!: { setDisabled(value: boolean): unknown }
        new Setting(this.contentEl).setName(t('Only changed files', 'Только изменённые файлы'))
            .setDesc(t('The first package for this selection includes every selected file.', 'Первый пакет для этого выбора содержит все выбранные файлы.'))
            .addToggle(control => { changedToggle = control; control.setValue(changedOnly).onChange(value => { if (!this.busy) changedOnly = value }) })
        const outputLabel = this.contentEl.createEl('label', { text: t('Save ZIP to an absolute path outside the vault', 'Полный путь для сохранения ZIP за пределами хранилища') })
        const output = outputLabel.createEl('input', { attr: { type: 'text', placeholder: t('For example C:\\Transfers\\Archive.zip', 'Например C:\\Перенос\\Архив.zip'), spellcheck: 'false' } })
        if (settings.outputDirectory) {
            const directory = settings.outputDirectory.replace(/[\\/]$/u, '')
            const separator = directory.includes('\\') ? '\\' : '/'
            output.value = `${directory}${separator}Rudonium-${new Date().toISOString().replace(/[:.]/gu, '-')}.zip`
        }
        output.classList.add('rudonium-zip-import-output')
        const actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
        const cancel = actions.createEl('button', { text: t('Cancel Preparation', 'Отменить подготовку') })
        cancel.hidden = true
        cancel.onclick = () => this.controller?.abort()
        const create = actions.createEl('button', { text: t('Save Package', 'Сохранить пакет'), cls: 'mod-cta' })
        update = () => {
            create.disabled = this.busy || !cleanPath(output.value) || !previewReady
            folder.disabled = output.disabled = this.busy
            savedToggle.setDisabled(this.busy)
            changedToggle.setDisabled(this.busy)
        }
        output.oninput = update
        create.onclick = async () => {
            if (create.disabled) return
            if (previewKey !== currentKey()) {
                updatePreview()
                status.setText(t('The archive selection changed. Review the updated file count before saving.',
                    'Выбор папок изменился. Проверьте обновлённый состав перед сохранением.'))
                return
            }
            this.busy = true
            this.controller = new AbortController()
            cancel.hidden = false
            update()
            try {
                const result = await preparePhonePackage(this.plugin, {
                    folder: this.savedScope ? '' : folder.value.trim(), output: cleanPath(output.value), useSavedScope: this.savedScope, changedOnly,
                }, progress => { if (!this.closed) status.setText(progressText(progress, t)) }, this.controller.signal)
                const message = result.unchanged ? t('No files changed since the last successful package. A new ZIP is not needed.',
                    'После последнего успешного пакета файлы не изменились. Новый ZIP не требуется.')
                    : t(`Package saved · ${result.files.toLocaleString()} files\n${result.output}`,
                        `Пакет сохранён · файлов: ${result.files.toLocaleString()}\n${result.output}`)
                if (this.closed) new Notice(message, 12000)
                else status.setText(message)
            } catch (error) {
                if (!this.closed) status.setText(zipDiagnostic(error, t))
            } finally {
                this.busy = false
                if (!this.closed) { cancel.hidden = true; update() }
            }
        }
        updatePreview()
        update()
    }

    onClose(): void {
        this.closed = true
        this.previewRevision++
        this.controller?.abort()
        if (packages.get(this.plugin) === this) packages.delete(this.plugin)
    }
}

class ZipImportModal extends Modal {
    private closed = false
    private stage: Stage = 'idle'
    private archive?: ZipImportArchive
    private plan?: ZipImportPlan
    private controller?: AbortController
    private selectedFile?: File
    private readonly selected = new Set<string>()
    private page = 0
    private query = ''
    private source!: HTMLInputElement
    private picker!: HTMLInputElement
    private prefix!: HTMLSelectElement
    private target!: HTMLInputElement
    private status!: HTMLElement
    private progress!: HTMLProgressElement
    private table!: HTMLElement
    private actions!: HTMLElement
    private cancel!: HTMLButtonElement
    private load!: HTMLButtonElement
    private compare!: HTMLButtonElement
    private browse!: HTMLButtonElement
    private recovery!: HTMLElement
    private sourceInfo!: HTMLElement
    private initialPrefix?: string

    constructor(private readonly plugin: MyPlugin, private readonly openOptions: ZipImportOpenOptions = {}) {
        super(plugin.app)
        this.initialPrefix = openOptions.prefix
    }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Import Changes from ZIP', 'Импорт изменений из ZIP'))
        this.modalEl.classList.add('rudonium-modal-64rem')
        installModalLayout(this, t)
        this.contentEl.createEl('p', { text: t(
            'Open an Obsidian backup or transfer ZIP and choose the files to update. Different files require your selection. Settings are not imported. Anki.zip is restored separately in Anki. After import, review the Anki export plan.',
            'Откройте резервную копию Obsidian или ZIP для переноса и выберите файлы для обновления. Отличающиеся файлы нужно отметить вручную. Настройки не импортируются. Anki.zip восстанавливается отдельно в Anki. После импорта откроется предпросмотр экспорта в Anki.') })
        this.showPreviousResult()
        this.recovery = this.contentEl.createDiv()
        this.buildSourceForm()
        this.sourceInfo = this.contentEl.createEl('p', { attr: { role: 'status' } })
        this.sourceInfo.classList.add('rudonium-wrap-anywhere')
        this.status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        this.status.classList.add('rudonium-wrapped-text')
        this.progress = this.contentEl.createEl('progress', { attr: { 'aria-label': t('ZIP import progress', 'Ход импорта ZIP') } })
        this.progress.classList.add('rudonium-full-width')
        this.progress.hidden = true
        this.table = this.contentEl.createDiv()
        this.actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
        this.actions.classList.add('rudonium-wrap-controls')
        if (this.openOptions.sourcePath) {
            this.source.value = this.openOptions.sourcePath
            this.target.value = this.openOptions.target ?? ''
            this.updateControls()
        }
        void (async () => {
            const pending = await this.checkRecovery()
            if (this.closed) return
            if (!pending && this.openOptions.sourcePath) await this.read()
        })()
    }

    private showPreviousResult(): void {
        const previous = lastResults.get(this.plugin)
        if (!previous) return
        const t = uiFor(this.plugin.settings)
        const details = this.contentEl.createEl('details')
        details.createEl('summary', { text: t(`Last import · ${previous.paths.length} files`, `Последний импорт · файлов: ${previous.paths.length}`) })
        details.createEl('p', { text: t(`Previous versions · ${previous.backupPath}`, `Предыдущие версии · ${previous.backupPath}`) }).classList.add('rudonium-wrap-anywhere')
        const actions = details.createDiv({ cls: 'modal-button-container' })
        actions.classList.add('rudonium-wrap-controls')
        actions.createEl('button', { text: t('Preview Anki Export', 'Предпросмотр экспорта в Anki') }).onclick = () => { void this.openExport(previous) }
        actions.createEl('button', { text: t('Save Updated ZIP', 'Сохранить обновлённый ZIP') }).onclick = () => openArchivePackage(this.plugin)
        for (const path of previous.paths.slice(0, pageSize)) {
            const line = details.createEl('p', { text: path })
            line.classList.add('rudonium-wrap-anywhere')
        }
    }

    private buildSourceForm(): void {
        const t = uiFor(this.plugin.settings)
        const source = new Setting(this.contentEl).setName(t('Incoming ZIP', 'Входящий ZIP'))
        this.source = source.controlEl.createEl('input', { attr: { type: 'text', placeholder: t('Choose a ZIP or paste its full path', 'Выберите ZIP или вставьте полный путь'), spellcheck: 'false' } })
        this.source.classList.add('rudonium-zip-import-source')
        this.picker = source.controlEl.createEl('input', { attr: { type: 'file', accept: '.zip,application/zip' } })
        this.picker.hidden = true
        this.browse = source.controlEl.createEl('button', { text: t('Choose ZIP', 'Выбрать ZIP') })
        this.browse.onclick = () => this.picker.click()
        this.load = source.controlEl.createEl('button', { text: t('Read ZIP', 'Прочитать ZIP') })
        this.load.onclick = () => { void this.read() }
        this.source.oninput = () => { this.selectedFile = undefined; this.sourceChanged() }
        this.picker.onchange = () => {
            const file = this.picker.files?.[0]
            if (file) { this.selectedFile = file; this.source.value = file.name; this.sourceChanged() }
        }
        const mapping = new Setting(this.contentEl).setName(t('Archive folder', 'Папка внутри архива'))
            .setDesc(t('Its contents will be placed in the destination folder below.', 'Её содержимое попадёт в указанную ниже папку хранилища.'))
        this.prefix = mapping.controlEl.createEl('select', { attr: { 'aria-label': t('Archive folder', 'Папка внутри архива') } })
        this.prefix.createEl('option', { text: t('Whole archive', 'Весь архив'), value: '' })
        this.prefix.onchange = () => this.invalidateComparison()
        const destination = new Setting(this.contentEl).setName(t('Destination in this vault', 'Папка назначения в хранилище'))
            .setDesc(t('Use a vault-relative folder. Leave empty for the vault root.', 'Укажите путь внутри хранилища. Пустое поле означает корень.'))
        this.target = destination.controlEl.createEl('input', { attr: { type: 'text', placeholder: 'Vocabulary', spellcheck: 'false', 'aria-label': t('Destination folder', 'Папка назначения') } })
        this.target.oninput = () => this.invalidateComparison()
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        this.cancel = buttons.createEl('button', { text: t('Cancel Reading', 'Отменить чтение') })
        this.cancel.hidden = true
        this.cancel.onclick = () => this.controller?.abort()
        this.compare = buttons.createEl('button', { text: t('Compare Files', 'Сравнить файлы') })
        this.compare.disabled = true
        this.compare.onclick = () => { void this.compareFiles() }
        this.updateControls()
    }

    private updateControls(): void {
        const busy = this.stage !== 'idle'
        this.source.disabled = this.picker.disabled = this.browse.disabled = busy
        this.prefix.disabled = this.target.disabled = busy
        this.load.disabled = busy || !(this.selectedFile || cleanPath(this.source.value))
        this.compare.disabled = busy || !this.archive
        this.cancel.hidden = this.stage !== 'reading'
        if (this.progress) this.progress.hidden = !busy
    }

    private invalidateComparison(): void {
        this.plan = undefined
        this.selected.clear()
        if (this.table) this.table.empty()
        if (this.actions) this.actions.empty()
    }

    private sourceChanged(): void {
        this.initialPrefix = undefined
        this.sourceInfo?.setText('')
        this.invalidateComparison()
        void this.disposeArchive()
        this.status?.setText(uiFor(this.plugin.settings)('Read the selected ZIP before comparing.', 'Прочитайте выбранный ZIP перед сравнением.'))
        this.updateControls()
    }

    private report = (progress: ZipImportProgress): void => {
        if (this.closed) return
        const t = uiFor(this.plugin.settings)
        this.status.classList.remove('rudonium-text-error')
        this.status.setText(progressText(progress, t))
        if (progress.totalBytes > 0) { this.progress.max = progress.totalBytes; this.progress.value = progress.bytes }
        else if (progress.totalFiles > 0) { this.progress.max = progress.totalFiles; this.progress.value = progress.files }
        else this.progress.removeAttribute('value')
    }

    private fail(error: unknown): void {
        if (this.closed) return
        this.status.classList.add('rudonium-text-error')
        this.status.setText(zipDiagnostic(error, uiFor(this.plugin.settings)))
    }

    private async disposeArchive(): Promise<void> {
        const archive = this.archive
        this.archive = undefined
        try { await archive?.dispose() } catch (error) { console.warn('[Rudonium Anki Toolkit] ZIP staging cleanup', error) }
    }

    private async read(): Promise<void> {
        if (this.stage !== 'idle') return
        this.stage = 'reading'
        this.controller = new AbortController()
        this.invalidateComparison()
        this.updateControls()
        try {
            await this.disposeArchive()
            const source = this.selectedFile ?? cleanPath(this.source.value)
            const backup = typeof source === 'string' ? await inspectVaultBackupSource(this.plugin, source) : undefined
            const archive = await prepareZipImport(this.plugin, source, this.report, this.controller.signal)
            if (this.closed) { await archive.dispose(); return }
            this.archive = archive
            const t = uiFor(this.plugin.settings)
            this.prefix.empty()
            for (const prefix of new Set(['', ...archive.prefixes])) {
                this.prefix.createEl('option', { value: prefix, text: prefix || t('Whole archive', 'Весь архив') })
            }
            this.prefix.value = this.initialPrefix ?? (backup ? '' : archive.transferPrefix ?? '')
            this.initialPrefix = undefined
            this.sourceInfo.setText(backup ? t(
                `${backup.scope === 'selected' ? 'Selected-folder' : 'Full-vault'} Obsidian backup · ${new Date(backup.completedAt).toLocaleString()}. Transfer preserves the vault settings and never imports Anki.zip.`,
                `Резервная копия Obsidian · ${backup.scope === 'selected' ? 'выбранные папки' : 'всё хранилище'} · ${new Date(backup.completedAt).toLocaleString()}. Перенос сохраняет настройки хранилища и не импортирует Anki.zip.`) : t('Ordinary ZIP · differences require your choice when no verified reference snapshot is available.',
                    'Обычный ZIP · при отсутствии проверенного исходного снимка отличия требуют вашего выбора.'))
            this.status.setText(t(`Archive read · ${archive.files.length.toLocaleString()} supported files, ${archive.ignoredFiles.toLocaleString()} other files skipped. Choose the folders and compare.`,
                `Архив прочитан · поддерживаемых файлов: ${archive.files.length.toLocaleString()}, остальных пропущено: ${archive.ignoredFiles.toLocaleString()}. Выберите папки и запустите сравнение.`))
        } catch (error) { this.fail(error) }
        finally { this.stage = 'idle'; if (this.closed) await this.disposeArchive(); else this.updateControls() }
    }

    private async compareFiles(): Promise<void> {
        if (this.stage !== 'idle' || !this.archive) return
        this.stage = 'comparing'
        this.invalidateComparison()
        this.updateControls()
        try {
            const plan = await compareZipImport(this.plugin, this.archive, { prefix: this.prefix.value, target: this.target.value.trim() }, this.report)
            if (this.closed) return
            this.plan = plan
            this.page = 0
            for (const row of plan.rows) if (row.status === 'new') this.selected.add(row.path)
            this.renderPlan()
        } catch (error) { this.fail(error) }
        finally { this.stage = 'idle'; if (this.closed) await this.disposeArchive(); else { this.updateControls(); this.renderActions() } }
    }

    private renderPlan(): void {
        if (!this.plan) return
        const t = uiFor(this.plugin.settings)
        this.table.empty()
        const counts = new Map<string, number>()
        for (const row of this.plan.rows) counts.set(stateText(row, t), (counts.get(stateText(row, t)) ?? 0) + 1)
        this.status.classList.remove('rudonium-text-error')
        this.status.setText([...counts].map(([name, count]) => `${name} · ${count.toLocaleString()}`).join('    '))
        if (this.plan.baselineReason) this.table.createEl('p', { text: this.plan.baselineReason })
        this.table.createEl('p', { text: t(
            'Only new files are selected initially. Selecting a different file replaces its complete contents with the ZIP version.',
            'Изначально отмечены только новые файлы. Выбор отличающегося файла заменяет его содержимое целиком версией из ZIP.') })
        const filter = this.table.createEl('input', { attr: { type: 'search', placeholder: t('Find a file or reason', 'Найти файл или причину'), 'aria-label': t('Find a file or reason', 'Найти файл или причину') } })
        filter.value = this.query
        filter.classList.add('rudonium-zip-import-filter')
        const rows = this.table.createDiv()
        const renderRows = () => this.renderRows(rows)
        filter.oninput = () => { this.query = filter.value; this.page = 0; renderRows() }
        renderRows()
        this.renderActions()
    }

    private renderRows(container: HTMLElement): void {
        if (!this.plan || !this.archive) return
        const t = uiFor(this.plugin.settings)
        container.empty()
        const query = this.query.trim().toLocaleLowerCase()
        const rows = this.plan.rows.filter(row => !query || `${row.path}\n${row.reason ?? ''}\n${stateText(row, t)}`.toLocaleLowerCase().includes(query))
        this.page = Math.min(this.page, Math.max(0, Math.ceil(rows.length / pageSize) - 1))
        const scroll = container.createDiv()
        scroll.classList.add('rudonium-zip-import-scroll')
        const table = scroll.createEl('table')
        table.classList.add('rudonium-full-width')
        const head = table.createEl('thead').createEl('tr')
        for (const name of [t('Import', 'Импорт'), t('File', 'Файл'), t('State', 'Состояние'), t('Review', 'Проверка')]) head.createEl('th', { text: name })
        const body = table.createEl('tbody')
        for (const row of rows.slice(this.page * pageSize, (this.page + 1) * pageSize)) {
            const tr = body.createEl('tr')
            const select = tr.createEl('td').createEl('input', { attr: { type: 'checkbox', 'aria-label': t(`Import ${row.path}`, `Импортировать ${row.path}`) } })
            select.checked = this.selected.has(row.path)
            select.disabled = !selectable(row) || this.stage === 'applying'
            select.onchange = () => { if (select.checked) this.selected.add(row.path); else this.selected.delete(row.path); this.renderActions() }
            tr.createEl('td', { text: row.path }).classList.add('rudonium-wrap-anywhere')
            const state = tr.createEl('td', { text: stateText(row, t) })
            state.createEl('small', { text: `\n${bytes(row.size)}` })
            if (row.reason) state.createEl('p', { text: row.reason }).classList.add('rudonium-wrap-anywhere')
            if (row.status === 'blocked' || row.changeOrigin === 'both') state.classList.add('rudonium-text-error')
            const review = tr.createEl('td')
            review.createEl('button', { text: t('Compare', 'Сравнить') }).onclick = () => {
                if (this.archive) new ZipComparisonModal(this.plugin, this.archive, row).open()
            }
            if (row.markdown && this.plugin.app.vault.getAbstractFileByPath(row.path) instanceof TFile) {
                review.createEl('button', { text: t('Open in Obsidian', 'Показать в Obsidian') }).onclick = () => {
                    void openObsidianFile(this.plugin.app, row.path, { modal: this, isClosed: () => this.closed })
                        .catch(error => this.fail(error))
                }
            }
        }
        if (!rows.length) container.createEl('p', { text: t('No matching files.', 'Подходящих файлов нет.') })
        const paging = container.createDiv({ cls: 'modal-button-container' })
        const previous = paging.createEl('button', { text: t('Previous', 'Назад') })
        previous.disabled = !this.page
        previous.onclick = () => { this.page--; this.renderRows(container) }
        paging.createSpan({ text: `${this.page + 1} / ${Math.max(1, Math.ceil(rows.length / pageSize))} · ${rows.length.toLocaleString()}` })
        const next = paging.createEl('button', { text: t('Next', 'Далее') })
        next.disabled = (this.page + 1) * pageSize >= rows.length
        next.onclick = () => { this.page++; this.renderRows(container) }
    }

    private renderActions(): void {
        if (!this.actions || !this.plan) return
        const t = uiFor(this.plugin.settings)
        this.actions.empty()
        const chooseNew = this.actions.createEl('button', { text: t('Select New Files', 'Выбрать новые файлы') })
        chooseNew.disabled = this.stage !== 'idle'
        chooseNew.onclick = () => { for (const row of this.plan!.rows) if (row.status === 'new') this.selected.add(row.path); this.renderPlan() }
        const clear = this.actions.createEl('button', { text: t('Clear Selection', 'Снять выделение') })
        clear.disabled = this.stage !== 'idle'
        clear.onclick = () => { this.selected.clear(); this.renderPlan() }
        const apply = this.actions.createEl('button', { text: t(`Import Selected (${this.selected.size})`, `Импортировать выбранные (${this.selected.size})`), cls: 'mod-cta' })
        apply.disabled = this.stage !== 'idle' || !this.selected.size
        apply.onclick = () => { void this.apply() }
    }

    private async apply(): Promise<void> {
        if (this.stage !== 'idle' || !this.plan || !this.selected.size) return
        this.stage = 'applying'
        this.updateControls()
        this.renderActions()
        try {
            const result = await applyZipImport(this.plugin, this.plan, new Set(this.selected), this.report)
            lastResults.set(this.plugin, { ...result, folder: this.plan.options.target })
            const t = uiFor(this.plugin.settings)
            new Notice(t(`Imported ${result.paths.length} files. Previous versions are saved in ${result.backupPath}`,
                `Импортировано файлов: ${result.paths.length}. Предыдущие версии сохранены в ${result.backupPath}`), 12000)
            if (!this.closed) await this.openExport(result)
        } catch (error) { this.fail(error); if (!this.closed) void this.checkRecovery() }
        finally { this.stage = 'idle'; if (this.closed) await this.disposeArchive(); else { this.updateControls(); this.renderActions() } }
    }

    private async openExport(result: ImportResult): Promise<void> {
        if (!result.paths.length) return
        this.close()
        const paths = result.markdownPaths.length === result.paths.length ? new Set(result.markdownPaths) : undefined
        try { await previewVaultExport(this.plugin, undefined, paths) }
        catch (error) { new Notice(uiDiagnostic(error, uiFor(this.plugin.settings)), 12000) }
    }

    private async checkRecovery(): Promise<boolean> {
        const t = uiFor(this.plugin.settings)
        try {
            const pending = await inspectZipImportRecovery(this.plugin)
            if (this.closed) return true
            this.recovery.empty()
            if (!pending) return false
            this.recovery.createEl('p', { text: pending.committed ? t(
                'The files were imported. Complete the saved-result check to finish the interrupted cleanup.',
                'Файлы импортированы. Подтвердите сохранённый результат, чтобы закончить прерванное завершение операции.') : t(
                `An interrupted import needs review · ${pending.paths.length} files. Restore its previous file versions before another import.`,
                `Требует проверки прерванный импорт · файлов: ${pending.paths.length}. Восстановите предыдущие версии перед новым импортом.`) }).classList.add('rudonium-text-error')
            this.recovery.createEl('p', { text: pending.backupPath }).classList.add('rudonium-wrap-anywhere')
            const restore = this.recovery.createEl('button', { text: pending.committed ? t('Confirm Imported Files', 'Подтвердить импортированные файлы')
                : t('Restore Previous Versions', 'Восстановить предыдущие версии') })
            restore.onclick = async () => {
                if (this.stage !== 'idle') return
                this.stage = 'applying'
                restore.disabled = true
                this.updateControls()
                try {
                    const result = await recoverZipImport(this.plugin, this.report)
                    if (!this.closed) {
                        this.recovery.empty()
                        this.status.setText(pending.committed ? t('The imported files are confirmed. Compare the ZIP again.',
                            'Импортированные файлы подтверждены. Сравните ZIP заново.')
                            : t(`Recovered ${result.paths.length} files. Compare the ZIP again.`, `Восстановлено файлов: ${result.paths.length}. Сравните ZIP заново.`))
                        this.invalidateComparison()
                    }
                } catch (error) { this.fail(error) }
                finally { this.stage = 'idle'; if (!this.closed) { restore.disabled = false; this.updateControls() } }
            }
            return true
        } catch (error) { this.fail(error); return true }
    }

    onClose(): void {
        this.closed = true
        this.controller?.abort()
        if (current.get(this.plugin) === this) current.delete(this.plugin)
        if (this.stage === 'idle') void this.disposeArchive()
    }
}

export function openZipImport(plugin: MyPlugin, options: ZipImportOpenOptions = {}): void {
    if (current.has(plugin)) {
        if (options.sourcePath) new Notice(uiFor(plugin.settings)('Close the current ZIP comparison before opening another archive.',
            'Закройте текущее окно сравнения ZIP перед открытием другого архива.'))
        return
    }
    const modal = new ZipImportModal(plugin, options)
    current.set(plugin, modal)
    modal.open()
}

export function openArchivePackage(plugin: MyPlugin): void {
    if (packages.has(plugin)) return
    const modal = new PhonePackageModal(plugin)
    packages.set(plugin, modal)
    modal.open()
}

export function openZipExchange(plugin: MyPlugin): void {
    if (exchanges.has(plugin)) return
    const t = uiFor(plugin.settings)
    class ExchangeModal extends Modal {
        onOpen(): void {
            this.titleEl.setText(t('Archives, Backup and Transfer', 'Архивы, резервные копии и перенос'))
            installModalLayout(this, t)
            this.contentEl.createEl('p', { text: t(
                'Choose archive folders, create a ZIP, or compare an incoming package. Review the Anki export after importing changes.',
                'Выберите папки архива, создайте ZIP или сравните входящий пакет. После импорта проверьте предпросмотр экспорта в Anki.') })
            new Setting(this.contentEl).setName(t('Archive contents', 'Состав архива'))
                .addButton(button => button.setButtonText(t('Choose Folders', 'Выбрать папки')).onClick(() => openArchiveFolders(plugin)))
            new Setting(this.contentEl).setName(t('Create ZIP', 'Создать ZIP'))
                .setDesc(t('Use the saved selection and keep a reference snapshot for future comparisons.',
                    'Используйте сохранённый состав и исходный снимок для будущего сравнения.'))
                .addButton(button => button.setButtonText(t('Create ZIP', 'Создать ZIP')).setCta().onClick(() => {
                    this.close()
                    openArchivePackage(plugin)
                }))
            new Setting(this.contentEl).setName(t('Saved Backups', 'Резервные копии'))
                .setDesc(t('Use an existing Obsidian.zip for transfer or restore it to a new folder. No second ZIP is needed.',
                    'Используйте существующий Obsidian.zip для переноса или восстановления в новую папку. Второй ZIP не нужен.'))
                .addButton(button => button.setButtonText(t('Saved Backups', 'Резервные копии')).onClick(() => {
                    this.close()
                    openVaultBackups(plugin, { transfer: sourcePath => openZipImport(plugin, { sourcePath, prefix: '', target: '' }) })
                }))
            new Setting(this.contentEl).setName(t('Import ZIP', 'Импорт ZIP'))
                .setDesc(t('Compare returned files, choose replacements, and open the normal Anki export preview.',
                    'Сравните вернувшиеся файлы, выберите замены и откройте обычный предпросмотр экспорта в Anki.'))
                .addButton(button => button.setButtonText(t('Import ZIP', 'Импорт ZIP')).onClick(() => {
                    this.close()
                    openZipImport(plugin)
                }))
        }
        onClose(): void { if (exchanges.get(plugin) === this) exchanges.delete(plugin) }
    }
    const modal = new ExchangeModal(plugin.app)
    exchanges.set(plugin, modal)
    modal.open()
}

export function registerZipImport(plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    plugin.addCommand({ id: 'phone-zip-exchange', name: t('Archives, Backup and Transfer', 'Архивы, резервные копии и перенос'), callback: () => openZipExchange(plugin) })
    plugin.addCommand({ id: 'import-zip-changes', name: t('Import Changes from ZIP', 'Импортировать изменения из ZIP'), callback: () => openZipImport(plugin) })
    plugin.addCommand({ id: 'prepare-phone-package', name: t('Create Transfer ZIP', 'Создать ZIP для переноса'), callback: () => openArchivePackage(plugin) })
    plugin.register(() => { exchanges.get(plugin)?.close(); current.get(plugin)?.close(); packages.get(plugin)?.close(); lastResults.delete(plugin) })
}

export function installZipImportSettings(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const section = container.createDiv({ cls: 'rupos-archive-backup-settings' })
    new Setting(section).setName(t('Archives, Backup and Transfer', 'Архивы, резервные копии и перенос')).setHeading()
    section.createEl('p', { text: t('Choose folders once for transfer and optional selected backups. An existing Obsidian.zip backup can be opened directly for transfer; full recovery remains available in a new folder.',
        'Выберите папки для переноса и, при необходимости, выборочных резервных копий. Готовый Obsidian.zip можно сразу открыть для переноса; полное восстановление доступно в новую папку.') })
    let refreshBackup: (() => void) | undefined
    const refreshArchive = installArchiveSettings(section, plugin, { create: () => openArchivePackage(plugin), import: () => openZipImport(plugin), changed: () => refreshBackup?.() })
    refreshBackup = installBackupSettings(section, plugin, {
        transfer: sourcePath => openZipImport(plugin, { sourcePath, prefix: '', target: '' }),
        chooseFolders: saved => openArchiveFolders(plugin, () => { saved(); refreshArchive() }),
    }, true)
}
