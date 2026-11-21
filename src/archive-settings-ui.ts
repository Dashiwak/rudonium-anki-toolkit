/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal, Notice, Setting } from 'obsidian'
import type { ToggleComponent } from 'obsidian'
import type MyPlugin from '../main'
import { archivePathIncluded, previewArchiveFiles, readArchiveSettings, saveArchiveSettings } from './archive-settings'
import type { ArchiveTransferSettings } from './archive-settings'
import { createFolderTree, vaultFolderEntries } from './folder-tree'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

interface ArchiveActions {
    create(): void
    import(): void
    changed?(): void
}

const dialogs = new WeakMap<MyPlugin, Modal>()

export function archiveSize(bytes: number): string {
    return bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
        : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
            : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes.toLocaleString()} B`
}

export function describeArchiveScope(settings: ArchiveTransferSettings, t: UiText): string {
    const included = settings.includeFolders.length
        ? t(`Selected folders · ${settings.includeFolders.length}`, `Выбрано папок · ${settings.includeFolders.length}`)
        : t('All vault folders', 'Все папки хранилища')
    const excluded = settings.excludeFolders.length
        ? t(` · exclusions · ${settings.excludeFolders.length}`, ` · исключений · ${settings.excludeFolders.length}`) : ''
    return included + excluded + (settings.includeAttachments ? t(' · with attachments', ' · с вложениями')
        : t(' · Markdown only', ' · только Markdown'))
}

/** В окне редактируется копия правил. Сохранение проверяет, что настройки не менялись параллельно. */
class ArchiveFoldersModal extends Modal {
    private readonly initial: ArchiveTransferSettings
    private readonly draft: ArchiveTransferSettings
    private closed = false
    private busy = false
    private timerWindow?: Window
    private timer?: number
    private previewRevision = 0

    constructor(private readonly plugin: MyPlugin, private readonly saved?: () => void) {
        super(plugin.app)
        this.initial = readArchiveSettings(plugin.settings.ARCHIVE_TRANSFER)
        this.draft = { ...this.initial, includeFolders: [...this.initial.includeFolders], excludeFolders: [...this.initial.excludeFolders] }
    }

    onOpen(): void {
        const { plugin, contentEl, draft } = this
        const t = uiFor(plugin.settings)
        this.titleEl.setText(t('Archive Folder Selection', 'Папки для архивирования'))
        this.modalEl.classList.add('rudonium-modal-56rem')
        installModalLayout(this, t)
        contentEl.createEl('p', { text: t(
            'Include several folders and exclude subfolders such as Photos. An included folder includes its descendants. Exclusions always take precedence. With no included folders, all vault folders are considered.',
            'Включите несколько папок и исключите подпапки, например фотографии. Выбранная папка включает вложенные папки. Исключение имеет приоритет. Если включённых папок нет, рассматривается всё хранилище.') })
        const summary = contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        const preview = contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        const feedback = contentEl.createEl('p', { attr: { role: 'alert' } })
        feedback.classList.add('rudonium-wrap-anywhere')
        const found = vaultFolderEntries(plugin.app.vault)
        const known = new Set(found.map(entry => entry.path))
        const entries = [...found]
        for (const path of [...draft.includeFolders, ...draft.excludeFolders]) {
            if (!known.has(path)) { entries.push({ path, keywords: t('Missing folder', 'Отсутствующая папка') }); known.add(path) }
        }
        const controls = contentEl.createDiv({ cls: 'modal-button-container' })
        const all = controls.createEl('button', { text: t('Include All Folders', 'Включить все папки') })
        const clearExclusions = controls.createEl('button', { text: t('Clear Exclusions', 'Снять исключения') })
        const treeContainer = contentEl.createDiv()
        let tree!: { setDisabled(value: boolean): void }
        const indicators = new Map<string, { select: HTMLSelectElement; label: HTMLElement }>()
        const refreshIndicators = () => {
            for (const [path, item] of indicators) {
                item.select.value = draft.excludeFolders.includes(path) ? 'exclude' : draft.includeFolders.includes(path) ? 'include' : 'inherit'
                item.label.setText(archivePathIncluded(`${path}/archive-example.md`, draft)
                    ? t('Included', 'Входит в архив') : t('Excluded', 'Пропускается'))
            }
        }
        const updateSummary = () => {
            summary.setText(describeArchiveScope(draft, t))
            const revision = ++this.previewRevision
            if (this.timer !== undefined) this.timerWindow?.clearTimeout(this.timer)
            this.timerWindow = this.contentEl.ownerDocument.defaultView ?? window
            this.timer = this.timerWindow.setTimeout(() => {
                void previewArchiveFiles(plugin, { useSavedScope: true, settings: draft }).then(result => {
                    if (this.closed || revision !== this.previewRevision) return
                    preview.setText(t(
                        `${result.totalFiles.toLocaleString()} files · Markdown ${result.markdownFiles.toLocaleString()} · attachments ${result.attachments.toLocaleString()} · ${archiveSize(result.totalBytes)}. Excluded ${result.excludedFiles.toLocaleString()} files (${archiveSize(result.excludedBytes)}).`,
                        `Файлов ${result.totalFiles.toLocaleString()} · Markdown ${result.markdownFiles.toLocaleString()} · вложений ${result.attachments.toLocaleString()} · ${archiveSize(result.totalBytes)}. Исключено файлов ${result.excludedFiles.toLocaleString()} (${archiveSize(result.excludedBytes)}).`))
                    feedback.setText(result.missingFolders.length ? t(`Missing folders · ${result.missingFolders.join(', ')}`,
                        `Отсутствующие папки · ${result.missingFolders.join(', ')}`) : '')
                }, error => { if (!this.closed && revision === this.previewRevision) feedback.setText(uiDiagnostic(error, t)) })
            }, 100)
        }
        const renderTree = () => {
            treeContainer.empty()
            tree = createFolderTree(treeContainer, {
                entries, t, initiallyVisible: [...draft.includeFolders, ...draft.excludeFolders],
                label: t('Archive folders', 'Папки архива'),
                renderAction: (row, label, entry) => {
                    const control = row.createEl('select', { attr: { 'aria-label': t(`Archive rule for ${entry.path}`, `Правило архива для ${entry.path}`) } })
                    control.createEl('option', { value: 'inherit', text: t('Inherit', 'Наследовать') })
                    control.createEl('option', { value: 'include', text: t('Include', 'Включить') })
                    control.createEl('option', { value: 'exclude', text: t('Exclude', 'Исключить') })
                    control.value = draft.excludeFolders.includes(entry.path) ? 'exclude' : draft.includeFolders.includes(entry.path) ? 'include' : 'inherit'
                    const indicator = label.createEl('small')
                    indicator.classList.add('rudonium-block')
                    indicator.setText(archivePathIncluded(`${entry.path}/archive-example.md`, draft)
                        ? t('Included', 'Входит в архив') : t('Excluded', 'Пропускается'))
                    indicators.set(entry.path, { select: control, label: indicator })
                    control.onchange = () => {
                        if (this.busy) return
                        draft.includeFolders = draft.includeFolders.filter(path => path !== entry.path)
                        draft.excludeFolders = draft.excludeFolders.filter(path => path !== entry.path)
                        if (control.value === 'include') draft.includeFolders.push(entry.path)
                        if (control.value === 'exclude') draft.excludeFolders.push(entry.path)
                        refreshIndicators()
                        updateSummary()
                    }
                    return control
                },
            })
        }
        all.onclick = () => { if (this.busy) return; draft.includeFolders = []; refreshIndicators(); updateSummary() }
        clearExclusions.onclick = () => { if (this.busy) return; draft.excludeFolders = []; refreshIndicators(); updateSummary() }
        renderTree()
        let attachmentsToggle!: ToggleComponent
        new Setting(contentEl).setName(t('Include attachments', 'Включать вложения'))
            .setDesc(t('Images, audio, video and PDF in included folders.', 'Изображения, аудио, видео и PDF из выбранных папок.'))
            .addToggle(control => {
                attachmentsToggle = control
                control.setValue(draft.includeAttachments).onChange(value => { if (!this.busy) { draft.includeAttachments = value; updateSummary() } })
            })
        const actions = contentEl.createDiv({ cls: 'modal-button-container' })
        const save = actions.createEl('button', { text: t('Save Selection', 'Сохранить выбор'), cls: 'mod-cta' })
        save.onclick = async () => {
            if (this.busy) return
            this.busy = true
            save.disabled = all.disabled = clearExclusions.disabled = true
            tree.setDisabled(true)
            attachmentsToggle.setDisabled(true)
            try {
                await saveArchiveSettings(plugin, draft, this.initial)
                this.saved?.()
                this.close()
            } catch (error) {
                if (!this.closed) feedback.setText(uiDiagnostic(error, t))
            } finally {
                this.busy = false
                if (!this.closed) { save.disabled = all.disabled = clearExclusions.disabled = false; tree.setDisabled(false); attachmentsToggle.setDisabled(false) }
            }
        }
        updateSummary()
    }

    onClose(): void {
        this.closed = true
        this.previewRevision++
        if (this.timer !== undefined) this.timerWindow?.clearTimeout(this.timer)
        if (dialogs.get(this.plugin) === this) dialogs.delete(this.plugin)
    }
}

export function openArchiveFolders(plugin: MyPlugin, saved?: () => void): void {
    if (dialogs.has(plugin)) return
    try {
        const modal = new ArchiveFoldersModal(plugin, saved)
        dialogs.set(plugin, modal)
        modal.open()
    } catch (error) { new Notice(uiDiagnostic(error, uiFor(plugin.settings))) }
}

export function installArchiveSettings(container: HTMLElement, plugin: MyPlugin, actions: ArchiveActions): () => void {
    const t = uiFor(plugin.settings)
    const section = container.createDiv({ cls: 'rupos-archive-settings' })
    let queue = Promise.resolve()
    const save = (patch: Partial<ArchiveTransferSettings>) => {
        queue = queue.then(async () => {
            const latest = readArchiveSettings(plugin.settings.ARCHIVE_TRANSFER)
            await saveArchiveSettings(plugin, { ...latest, ...patch }, latest)
            render()
            actions.changed?.()
        }).catch(error => { new Notice(uiDiagnostic(error, t)); render() })
    }
    const render = () => {
        section.empty()
        new Setting(section).setName(t('Transfer contents', 'Состав переноса')).setHeading()
        let current: ArchiveTransferSettings
        try { current = readArchiveSettings(plugin.settings.ARCHIVE_TRANSFER) }
        catch (error) {
            section.createEl('p', { text: uiDiagnostic(error, t), attr: { role: 'alert' } }).classList.add('rudonium-text-error')
            section.createEl('p', { text: t('Reset only the archive selection to use all visible folders again.',
                'Сбросьте только параметры архива, чтобы снова выбирать из всех обычных папок.') })
            const reset = section.createEl('button', { text: t('Reset Archive Settings', 'Сбросить параметры архива') })
            reset.onclick = async () => {
                reset.disabled = true
                try { await saveArchiveSettings(plugin, readArchiveSettings(undefined)); render(); actions.changed?.() }
                catch (failure) { new Notice(uiDiagnostic(failure, t)); reset.disabled = false }
            }
            return
        }
        section.createEl('p', { text: describeArchiveScope(current, t) })
        const row = new Setting(section).setName(t('Archive contents', 'Состав архива'))
            .setDesc(t('Save the folder selection once and reuse it for later ZIP packages.', 'Сохраните выбор папок один раз и используйте его для следующих ZIP-пакетов.'))
        row.addButton(button => button.setButtonText(t('Choose Folders', 'Выбрать папки')).onClick(() => openArchiveFolders(plugin, () => { render(); actions.changed?.() })))
            .addButton(button => button.setButtonText(t('Create ZIP', 'Создать ZIP')).onClick(() => actions.create()))
            .addButton(button => button.setButtonText(t('Import ZIP', 'Импорт ZIP')).onClick(() => actions.import()))
        new Setting(section).setName(t('Only changed files', 'Только изменённые файлы'))
            .setDesc(t('Compare with the last successful package for this selection. The first package includes the full selection.',
                'Сравнивать с последним успешным пакетом для этого выбора папок. Первый пакет содержит весь выбранный состав.'))
            .addToggle(control => control.setValue(current.changedOnly).onChange(value => { void save({ changedOnly: value }) }))
        new Setting(section).setName(t('Include attachments', 'Включать вложения'))
            .setDesc(t('Turn off to create Markdown-only transfer packages.', 'Выключите для переноса только Markdown.'))
            .addToggle(control => control.setValue(current.includeAttachments).onChange(value => { void save({ includeAttachments: value }) }))
        let directory = current.outputDirectory
        new Setting(section).setName(t('Default ZIP folder', 'Папка сохранения ZIP по умолчанию'))
            .setDesc(t('An absolute folder outside the vault. Each new ZIP gets a separate name.', 'Полный путь к папке за пределами хранилища. Каждый ZIP получает отдельное имя.'))
            .addText(control => control.setValue(directory).onChange(value => { directory = value }))
            .addButton(button => button.setButtonText(t('Save Folder', 'Сохранить папку')).onClick(() => { void save({ outputDirectory: directory }) }))
    }
    render()
    return render
}
