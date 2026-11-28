/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Modal, Notice, Setting } from 'obsidian'
import type { ButtonComponent, ToggleComponent } from 'obsidian'
import { requireExpectedAnkiProfile } from './anki-profile'
import { readSyncAuditDeckNames } from './sync-audit'
import type MyPlugin from '../main'
import { savePluginDataInOrder, withFastScanReadLock } from './fast-scan'
import { createBackupNow, listVaultBackups, readBackupSettings, restoreVaultBackup } from './vault-backup'
import type { BackupSettings } from './vault-backup'
import type { SavedVaultBackup } from './vault-backup'
import { readArchiveSettings, saveArchiveSettings } from './archive-settings'
import { uiDiagnostic, uiFor } from './interface-language'
import { installModalLayout } from './modal-layout'
import { createSettingsGroup } from './settings-layout'

const maxDays = 365
const backupDialogs = new WeakMap<MyPlugin, VaultRestoreModal>()
const registeredDialogs = new WeakSet<MyPlugin>()

export interface BackupSettingsActions {
    transfer?(path: string): void
    chooseFolders?(saved: () => void): void
}

function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
}

function unpackPath(input: string): string {
    const path = input.trim()
    return path.length > 1 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

class VaultRestoreModal extends Modal {
    private closed = false

    constructor(private readonly plugin: MyPlugin, private readonly actions: BackupSettingsActions = {}) { super(plugin.app) }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Saved Backups', 'Резервные копии'))
        installModalLayout(this, t)
        this.contentEl.createEl('p', {
            text: t('Use the same Obsidian ZIP for file transfer or restore it to a new folder. Transfer opens a comparison and never replaces files automatically. Anki.zip is a separate collection backup and is restored in Anki.', 'Один ZIP Obsidian подходит и для переноса файлов, и для восстановления в новую папку. Перенос открывает сравнение и не заменяет файлы автоматически. Anki.zip — отдельная копия коллекции для восстановления в Anki.'),
        })
        const list = this.contentEl.createEl('select', { attr: { 'aria-label': t('Available vault backups', 'Доступные резервные копии') } })
        list.classList.add('rudonium-backup-list')
        list.disabled = true
        list.createEl('option', { text: t('Loading vault backups…', 'Загрузка списка резервных копий…'), value: '' })
        const label = this.contentEl.createEl('label', { text: t('Backup ZIP path', 'Путь к ZIP-архиву') })
        const input = label.createEl('input', {
            attr: { type: 'text', placeholder: t('Paste an absolute path to the ZIP file', 'Вставьте полный путь к ZIP-файлу'), spellcheck: 'false' },
        })
        input.classList.add('rudonium-backup-input')
        const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        status.classList.add('rudonium-wrap-anywhere')
        const details = this.contentEl.createEl('p')
        details.classList.add('rudonium-wrap-anywhere')
        const saved = new Map<string, SavedVaultBackup>()
        const actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
        actions.classList.add('rudonium-wrap-controls')
        const restore = actions.createEl('button', { text: t('Restore to New Folder', 'Восстановить в новую папку'), cls: 'mod-cta' })
        const transfer = this.actions.transfer ? actions.createEl('button', { text: t('Use for Transfer', 'Использовать для переноса') }) : undefined
        let restoring = false
        let listing = true

        const update = () => {
            const path = unpackPath(input.value)
            const valid = isAbsolutePath(path) && /\.zip$/i.test(path)
            if (path && !valid) input.setAttribute('aria-invalid', 'true')
            else input.removeAttribute('aria-invalid')
            restore.disabled = restoring || !valid
            if (transfer) transfer.disabled = restoring || !valid
            input.disabled = restoring
            list.disabled = restoring || listing || list.children.length < 2
            const entry = saved.get(path)
            details.setText(entry ? t(
                `${entry.scope === 'selected' ? 'Selected folders' : 'Full vault'} · ${new Date(entry.completedAt).toLocaleString()} · Obsidian ZIP. ${entry.scope === 'selected' ? 'Only the saved selection can be restored or transferred.' : 'Transfer imports supported notes and media; vault settings remain unchanged.'}`,
                `${entry.scope === 'selected' ? 'Выбранные папки' : 'Полное хранилище'} · ${new Date(entry.completedAt).toLocaleString()} · ZIP Obsidian. ${entry.scope === 'selected' ? 'Доступны только файлы, вошедшие в эту копию.' : 'При переносе импортируются заметки и поддерживаемые вложения; настройки хранилища сохраняются.'}`)
                : t('Choose Obsidian.zip or a regular vault ZIP. Different existing files require an explicit choice.',
                    'Выберите Obsidian.zip или обычный ZIP хранилища. Замена отличающихся файлов требует явного выбора.'))
            if (entry?.deckName) details.append(t(` Anki deck package: ${entry.deckName} (Deck.apkg).`,
                ` Пакет колоды Anki: ${entry.deckName} (Deck.apkg).`))
        }
        list.onchange = () => { if (list.value) input.value = list.value; update() }
        input.oninput = () => { list.value = ''; update() }
        if (transfer) transfer.onclick = () => {
            if (transfer.disabled) return
            const path = unpackPath(input.value)
            this.actions.transfer?.(path)
            this.close()
        }
        restore.onclick = async () => {
            if (restore.disabled) return
            restoring = true
            const path = unpackPath(input.value)
            status.classList.remove('rudonium-text-error')
            status.setText(t('Restoring and verifying your ZIP…', 'Восстановление и проверка ZIP-архива…'))
            update()
            try {
                const folder = await restoreVaultBackup(this.plugin, path)
                if (this.closed) {
                    new Notice(t(`Vault restored to ${folder}`, `Хранилище восстановлено в папку ${folder}`), 12000)
                    return
                }
                this.contentEl.empty()
                this.contentEl.createEl('p', { text: t('Open the restored folder in Obsidian using Open folder as vault.', 'Откройте восстановленную папку командой Obsidian «Открыть папку как хранилище».') })
                const result = this.contentEl.createEl('p', { text: folder, attr: { role: 'status' } })
                result.classList.add('rudonium-wrap-anywhere')
                const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
                const copy = footer.createEl('button', { text: t('Copy Folder Path', 'Скопировать путь к папке') })
                copy.onclick = async () => {
                    try {
                        await navigator.clipboard.writeText(folder)
                        copy.setText(t('Copied', 'Скопировано'))
                    } catch {
                        new Notice(t('Select and copy the displayed folder path.', 'Выделите показанный путь к папке и скопируйте его.'))
                    }
                }
            } catch (error) {
                const reason = uiDiagnostic(error, t)
                if (this.closed) {
                    new Notice(t(`Could not restore the vault. ${reason}`, `Не удалось восстановить хранилище. ${reason}`), 12000)
                    return
                }
                status.classList.add('rudonium-text-error')
                status.setText(reason)
            } finally {
                restoring = false
                if (!this.closed) update()
            }
        }
        update()
        void (async () => {
            try {
                const backups = await listVaultBackups(this.plugin)
                if (this.closed) return
                list.empty()
                list.createEl('option', { text: backups.length ? t('Choose a saved backup', 'Выберите резервную копию') : t('No backups in the configured folder', 'В заданной папке пока нет резервных копий'), value: '' })
                for (const backup of backups) { saved.set(backup.path, backup); list.createEl('option', { text: backup.name, value: backup.path }) }
            } catch (error) {
                if (this.closed) return
                list.empty()
                list.createEl('option', { text: t('Backups could not be listed', 'Не удалось получить список резервных копий'), value: '' })
                if (!restoring) {
                    const reason = uiDiagnostic(error, t)
                    status.setText(t(`${reason} You can paste the path to a ZIP file above.`, `${reason} Можно вставить путь к ZIP-файлу в поле выше.`))
                }
            } finally {
                listing = false
                if (!this.closed) update()
            }
        })()
    }

    onClose(): void {
        this.closed = true
        this.contentEl.empty()
        if (backupDialogs.get(this.plugin) === this) backupDialogs.delete(this.plugin)
    }
}

export function openVaultBackups(plugin: MyPlugin, actions: BackupSettingsActions = {}): void {
    const active = backupDialogs.get(plugin)
    if (active) { active.modalEl.focus(); return }
    if (!registeredDialogs.has(plugin)) {
        registeredDialogs.add(plugin)
        plugin.register(() => { backupDialogs.get(plugin)?.close(); registeredDialogs.delete(plugin) })
    }
    const modal = new VaultRestoreModal(plugin, actions)
    backupDialogs.set(plugin, modal)
    modal.open()
}

export function installBackupSettings(container: HTMLElement, plugin: MyPlugin, actions: BackupSettingsActions = {}, embedded = false): () => void {
    const t = uiFor(plugin.settings)
    const section = embedded
        ? createSettingsGroup(container, plugin, 'backup-recovery', t('Backup and Recovery', 'Резервное копирование и восстановление'))
        : container.createDiv({ cls: 'anki-vault-backup' })
    section.addClass('anki-vault-backup')
    if (!embedded) new Setting(section).setName(t('Backup and Recovery', 'Резервное копирование и восстановление')).setHeading()
    section.createEl('p', { text: t('Obsidian.zip is also a transfer archive. It is a complete snapshot of its saved scope, even when transfer packages use Only changed files.',
        'Obsidian.zip подходит и для переноса. Копия содержит полный снимок выбранной области, даже если для переносимых пакетов включено «Только изменённые файлы».') })
    let auto!: ToggleComponent
    let anki!: ToggleComponent
    let deckToggle!: ToggleComponent
    let refreshDecks!: ButtonComponent
    let deckNames: string[] = []
    let listedProfile: string | undefined
    let loadingDecks = false
    let selectedScope!: ToggleComponent
    let interval!: HTMLInputElement
    let directory!: HTMLInputElement
    let saveButton!: HTMLButtonElement
    let backupButton!: HTMLButtonElement
    let restoreButton!: HTMLButtonElement
    let transferButton: HTMLButtonElement | undefined
    let latestBackupPath: string | undefined
    let saving = false
    let backingUp = false
    let feedback: { message: string; error?: boolean } | undefined

    const scopeDescription = section.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
    new Setting(section).setName(t('Use selected folders for Obsidian backups', 'Использовать выбранные папки в резервных копиях Obsidian'))
        .setDesc(t('Off: full vault with settings. On: the same included folders, exclusions and attachment choice as transfer. Anki backup still covers its collection.',
            'Выключено: всё хранилище с настройками. Включено: те же папки, исключения и выбор вложений, что и для переноса. Копия Anki по-прежнему охватывает коллекцию.'))
        .addToggle(toggle => { selectedScope = toggle; toggle.onChange(value => { void saveScope(value) }) })
    if (actions.chooseFolders) new Setting(section).setName(t('Shared folder selection', 'Общий выбор папок'))
        .addButton(button => button.setButtonText(t('Choose Folders', 'Выбрать папки')).onClick(() => actions.chooseFolders?.(() => render())))

    new Setting(section).setName(t('Automatic backup before export', 'Автоматическая копия перед экспортом'))
        .setDesc(t('Back up before the first export with changes after the interval has elapsed.', 'Создавать копию перед первым экспортом с изменениями после заданного интервала.'))
        .addToggle(toggle => { auto = toggle; toggle.onChange(value => save({ enabled: value })) })
    new Setting(section).setName(t('Backup interval (days)', 'Интервал копирования (дни)'))
        .setDesc(t('Count whole days from the last successful backup.', 'Количество полных дней после последней успешной копии.'))
        .addText(field => {
            interval = field.inputEl
            interval.setAttribute('type', 'number')
            interval.setAttribute('min', '1')
            interval.setAttribute('max', String(maxDays))
            interval.setAttribute('step', '1')
            interval.setAttribute('aria-label', t('Backup interval in days', 'Интервал копирования в днях'))
        })
    new Setting(section).setName(t('Backup folder', 'Папка для резервных копий'))
        .setDesc(t('Use an absolute path outside the vault. Leave blank for the default folder beside the vault.', 'Укажите полный путь вне хранилища. Пустое поле означает папку рядом с хранилищем.'))
        .addText(field => {
            directory = field.inputEl
            directory.setAttribute('aria-label', t('Backup folder', 'Папка для резервных копий'))
            directory.setAttribute('placeholder', t('Default folder beside the vault', 'Папка рядом с хранилищем'))
        })
    new Setting(section).setName(t('Include Anki collection', 'Включить коллекцию Anki'))
        .setDesc(t('Save the active Anki collection and its media alongside the vault backup.', 'Сохранить открытую коллекцию Anki и её медиафайлы рядом с копией хранилища.'))
        .addToggle(toggle => { anki = toggle; toggle.onChange(value => save({ includeAnki: value })) })
    new Setting(section).setName(t('Include an Anki deck package', 'Сохранять отдельную колоду Anki'))
        .setDesc(t('Save the selected deck with its review schedule as Deck.apkg alongside Obsidian.zip. Import the package in Anki to restore the deck.',
            'Сохранять выбранную колоду с расписанием повторений в Deck.apkg рядом с Obsidian.zip. Для восстановления импортируйте пакет в Anki.'))
        .addToggle(toggle => { deckToggle = toggle; toggle.onChange(value => save({ includeDeck: value })) })
    const deckRow = new Setting(section).setName(t('Deck to back up', 'Колода для резервной копии'))
        .setDesc(t('Use Rudonium’s default deck or load the decks from the open Anki profile to choose one.',
            'Используйте колоду Rudonium по умолчанию или загрузите список колод из открытого профиля Anki.'))
    const deckList = deckRow.controlEl.createEl('select', { cls: 'dropdown', attr: {
        'aria-label': t('Deck to back up', 'Колода для резервной копии'),
    } })
    deckRow.addButton(button => {
        refreshDecks = button.setButtonText(t('Load decks', 'Загрузить колоды')).onClick(async () => {
            if (loadingDecks || backingUp || saving) return
            loadingDecks = true
            feedback = undefined
            render()
            try {
                const profile = await requireExpectedAnkiProfile(plugin)
                const names = await readSyncAuditDeckNames(undefined, 5000)
                await requireExpectedAnkiProfile(plugin, profile)
                listedProfile = profile
                deckNames = [...new Set(names)].sort((a, b) => a.localeCompare(b))
            } catch (error) {
                listedProfile = undefined
                deckNames = []
                feedback = { message: uiDiagnostic(error, t), error: true }
            } finally {
                loadingDecks = false
                render()
            }
        })
    })
    deckList.onchange = () => {
        if (!deckList.value) { void save({ selectedDeck: undefined }); return }
        const name = deckNames[Number(deckList.value)]
        if (name && listedProfile) void save({ selectedDeck: { name, profile: listedProfile } })
    }
    new Setting(section).setName(t('Backup options', 'Параметры копирования'))
        .addButton(button => {
            saveButton = button.setButtonText(t('Save Backup Options', 'Сохранить параметры')).buttonEl
            button.onClick(() => {
                const { values, valid } = readInputs()
                if (valid) return save(values)
            })
        })
    new Setting(section).setName(t('Run backup or restore', 'Копирование и восстановление'))
        .addButton(button => {
            backupButton = button.setButtonText(t('Create Backup Now', 'Создать резервную копию')).buttonEl
            button.onClick(async () => {
                if (backupButton.disabled) return
                backingUp = true
                feedback = undefined
                render()
                try {
                    const location = await createBackupNow(plugin)
                    latestBackupPath = location.replace(/[\\/]+$/u, '') + (location.includes('\\') ? '\\' : '/') + 'Obsidian.zip'
                    feedback = { message: t(`Backup complete. ${location}`, `Резервная копия создана. ${location}`) }
                } catch (error) {
                    const reason = uiDiagnostic(error, t)
                    feedback = { message: t(`Could not create the backup. ${reason}`, `Не удалось создать резервную копию. ${reason}`), error: true }
                } finally {
                    backingUp = false
                    render()
                }
            })
        })
        .addButton(button => {
            restoreButton = button.setButtonText(t('Saved Backups', 'Резервные копии')).buttonEl
            button.onClick(() => { if (!restoreButton.disabled) openVaultBackups(plugin, actions) })
        })
    if (actions.transfer) new Setting(section).setName(t('Last created backup', 'Последняя созданная копия'))
        .setDesc(t('Open its Obsidian.zip directly, without creating another archive.', 'Открыть её Obsidian.zip напрямую, без создания ещё одного архива.'))
        .addButton(button => {
            transferButton = button.setButtonText(t('Use Last Backup for Transfer', 'Перенести из последней копии')).buttonEl
            button.onClick(() => { if (latestBackupPath && !transferButton?.disabled) actions.transfer?.(latestBackupPath) })
        })
    const status = section.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
    status.classList.add('rudonium-wrap-anywhere')

    for (const input of [interval, directory]) {
        input.oninput = () => { feedback = undefined; render() }
        input.onkeydown = event => {
            if (event.key !== 'Enter' || event.isComposing || saveButton.disabled) return
            event.preventDefault()
            saveButton.click()
        }
    }

    function readInputs(): { values: Pick<BackupSettings, 'intervalDays' | 'directory'>; valid: boolean } {
        const intervalDays = Number(interval.value)
        const path = unpackPath(directory.value)
        const validDays = interval.value.trim() !== '' && Number.isInteger(intervalDays) && intervalDays >= 1 && intervalDays <= maxDays
        const validPath = !path || isAbsolutePath(path)
        if (validDays) interval.removeAttribute('aria-invalid')
        else interval.setAttribute('aria-invalid', 'true')
        if (validPath) directory.removeAttribute('aria-invalid')
        else directory.setAttribute('aria-invalid', 'true')
        return { values: { intervalDays, directory: path }, valid: validDays && validPath }
    }

    function render(resetInputs = false): void {
        const settings = readBackupSettings(plugin.settings.VAULT_BACKUP)
        const busy = saving || backingUp || loadingDecks
        if (resetInputs) {
            interval.value = String(settings.intervalDays)
            directory.value = settings.directory
        }
        auto.setValue(settings.enabled)
        auto.setDisabled?.(busy)
        anki.setValue(settings.includeAnki)
        anki.setDisabled?.(busy)
        deckToggle.setValue(settings.includeDeck)
        deckToggle.setDisabled(busy)
        deckRow.settingEl.hidden = !settings.includeDeck
        deckList.disabled = busy
        refreshDecks.setDisabled(busy)
        deckList.empty()
        const defaultDeck = plugin.settings.Defaults.Deck
        deckList.createEl('option', { value: '', text: t(`Rudonium default · ${defaultDeck}`, `По умолчанию в Rudonium · ${defaultDeck}`) })
        const selected = settings.selectedDeck
        if (selected && (selected.profile !== listedProfile || !deckNames.includes(selected.name))) {
            deckList.createEl('option', { value: 'saved', text: `${selected.name} · ${selected.profile}` }).selected = true
        }
        deckNames.forEach((name, index) => {
            const option = deckList.createEl('option', { value: String(index), text: name })
            if (selected?.name === name && selected.profile === listedProfile) option.selected = true
        })
        try {
            const archive = readArchiveSettings(plugin.settings.ARCHIVE_TRANSFER)
            selectedScope.setValue(archive.useForBackups)
            selectedScope.setDisabled(busy)
            scopeDescription.classList.remove('rudonium-text-error')
            scopeDescription.setText(archive.useForBackups ? t(
                `Selected backup · ${archive.includeFolders.length ? archive.includeFolders.join(', ') : 'all visible folders'} · exclusions ${archive.excludeFolders.length} · ${archive.includeAttachments ? 'with attachments' : 'Markdown only'}. Restore and transfer can use only these saved files.`,
                `Выборочная копия · ${archive.includeFolders.length ? archive.includeFolders.join(', ') : 'все обычные папки'} · исключений ${archive.excludeFolders.length} · ${archive.includeAttachments ? 'с вложениями' : 'только Markdown'}. Для восстановления и переноса доступны только вошедшие в копию файлы.`)
                : t('Full backup · all vault files and settings. Transfer imports supported notes and attachments without replacing settings.',
                    'Полная копия · все файлы и настройки хранилища. При переносе импортируются заметки и поддерживаемые вложения без замены настроек.'))
        } catch (error) {
            selectedScope.setDisabled(true)
            scopeDescription.classList.add('rudonium-text-error')
            scopeDescription.setText(uiDiagnostic(error, t))
        }
        interval.disabled = directory.disabled = busy
        const { values, valid } = readInputs()
        const edited = values.intervalDays !== settings.intervalDays || values.directory !== settings.directory
        saveButton.disabled = busy || !valid || !edited
        backupButton.disabled = restoreButton.disabled = busy || !valid || edited
        if (transferButton) transferButton.disabled = busy || !latestBackupPath
        status.classList.toggle('rudonium-text-error', Boolean((!valid || feedback?.error) && !busy))
        status.setText(saving ? t('Saving…', 'Сохранение…') : backingUp ? t('Creating and verifying the backup…', 'Создание и проверка резервной копии…')
            : !valid ? t(`Enter a whole number from 1 to ${maxDays} and use an absolute folder path.`, `Введите целое число от 1 до ${maxDays} и полный путь к папке.`)
                : feedback?.message ?? (edited ? t('Save the backup options before running a backup or restore.', 'Сохраните параметры перед копированием или восстановлением.') : ''))
        status.hidden = !status.textContent
    }

    async function save(patch: Partial<BackupSettings>): Promise<void> {
        if (saving || backingUp) return
        saving = true
        feedback = undefined
        render()
        try {
            await withFastScanReadLock(plugin, () => savePluginDataInOrder(plugin, async () => {
                if (patch.selectedDeck) await requireExpectedAnkiProfile(plugin, patch.selectedDeck.profile)
                const settings = plugin.settings
                const current = readBackupSettings(settings.VAULT_BACKUP)
                const next = { ...current, ...patch }
                if (JSON.stringify(next) === JSON.stringify(current)) return
                const saved = await plugin.loadData() as unknown
                const previous = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {}
                await plugin.saveData({
                    ...previous,
                    settings: { ...settings, VAULT_BACKUP: next },
                    'Added Media': plugin.added_media,
                    'File Hashes': plugin.file_hashes,
                    fields_dict: plugin.fields_dict,
                })
                settings.VAULT_BACKUP = next
            }))
            feedback = { message: t('Backup options saved.', 'Параметры копирования сохранены.') }
        } catch (error) {
            const reason = uiDiagnostic(error, t)
            feedback = { message: t(`Could not save backup options. ${reason}`, `Не удалось сохранить параметры копирования. ${reason}`), error: true }
        } finally {
            saving = false
            render()
        }
    }

    async function saveScope(enabled: boolean): Promise<void> {
        if (saving || backingUp) return
        saving = true
        feedback = undefined
        render()
        try {
            const current = readArchiveSettings(plugin.settings.ARCHIVE_TRANSFER)
            await saveArchiveSettings(plugin, { ...current, useForBackups: enabled }, current)
            feedback = { message: t('Backup contents saved.', 'Состав резервной копии сохранён.') }
        } catch (error) {
            feedback = { message: uiDiagnostic(error, t), error: true }
        } finally { saving = false; render() }
    }

    render(true)
    return () => render()
}
