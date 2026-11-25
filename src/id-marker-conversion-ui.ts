/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { checkedCount } from './sync-outcome'
import { Modal, Notice, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { previewIdMarkerConversion, applyIdMarkerConversion } from './id-marker-conversion'
import type { IdMarkerConversionPlan } from './id-marker-conversion'
import type { IdMarkerDirection } from './id-marker-format'
import { uiFor, uiDiagnostic } from './interface-language'
import { installModalLayout } from './modal-layout'
import { openObsidianFile } from './obsidian-navigation'
import { movePageId } from './page-id-move'
import { pageIdLocation } from './page-id-location'
import { withFastScanReadLock } from './fast-scan'

const dialogs = new WeakMap<MyPlugin, IdMarkerConversionModal>()
const pageSize = 30

class IdMarkerConversionModal extends Modal {
    private closed = false
    private busy = false
    private conversionScope: 'current' | 'profile' = 'current'
    private plan?: IdMarkerConversionPlan
    private readonly selected = new Set<string>()
    private page = 0
    private controls!: HTMLElement
    private status!: HTMLElement
    private results!: HTMLElement
    private apply!: HTMLButtonElement

    constructor(private readonly plugin: MyPlugin, private readonly direction: IdMarkerDirection) { super(plugin.app) }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(this.direction === 'to-comment' ? t('Convert IDs to Comments', 'Перевести ID в комментарии')
            : t('Remove ID Comment Wrappers', 'Убрать оболочку комментариев у ID'))
        this.modalEl.classList.add('rudonium-modal-58rem')
        installModalLayout(this, t)
        this.contentEl.createEl('p', { text: t(
            'Only the HTML wrapper of recognized ID markers changes. Numbers, dates, card content and Anki stay unchanged. A verified ZIP of all selected original files is saved before any replacement.',
            'Меняется только HTML-оболочка распознанных маркеров ID. Числа, даты, содержимое карточек и Anki сохраняются. До первой замены создаётся и проверяется ZIP всех выбранных исходных файлов.') })
        this.controls = this.contentEl.createDiv()
        new Setting(this.controls).setName(t('Scope', 'Область'))
            .addDropdown(control => control.addOption('current', t('Current note', 'Текущая заметка'))
                .addOption('profile', t('Active sync profile', 'Текущий профиль синхронизации'))
                .setValue(this.conversionScope).onChange(value => {
                    if (this.busy || value !== 'current' && value !== 'profile') return
                    this.conversionScope = value; this.plan = undefined; this.selected.clear(); this.results.empty(); this.status.setText(''); this.update()
                }))
            .addButton(control => control.setButtonText(t('Preview', 'Предпросмотр')).onClick(() => this.preview()))
        this.status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        this.status.classList.add('rudonium-wrap-anywhere')
        this.results = this.contentEl.createDiv()
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        this.apply = footer.createEl('button', { text: t('Back Up and Apply Selected', 'Создать копию и применить выбранное'), cls: 'mod-cta' })
        this.apply.onclick = () => { void this.applySelected() }
        this.update()
    }

    private update(): void {
        for (const control of Array.from(this.controls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select'))) control.disabled = this.busy
        this.results.setAttribute('aria-busy', String(this.busy))
        this.results.classList.toggle('rudonium-ignore-pointer', this.busy)
        this.apply.disabled = this.busy || !this.plan || !this.selected.size
    }

    private selectionStatus(): void {
        const plan = this.plan
        if (!plan) return
        const t = uiFor(this.plugin.settings)
        this.status.setText(checkedCount(plan.scannedFiles, 'file', t) + ' ' + t(`${plan.totalMarkers} markers in ${plan.files.length} files · selected ${this.selected.size}.`,
            `Маркеров: ${plan.totalMarkers} · файлов с изменениями: ${plan.files.length} · выбрано: ${this.selected.size}.`))
    }

    private async preview(): Promise<void> {
        if (this.busy) return
        const t = uiFor(this.plugin.settings)
        this.busy = true; this.plan = undefined; this.results.empty(); this.selected.clear(); this.status.classList.remove('rudonium-text-error'); this.update()
        try {
            const plan = await previewIdMarkerConversion(this.plugin, this.direction, this.conversionScope, (done, total) => {
                if (!this.closed) this.status.setText(t(`Reading notes · ${done}/${total}`, `Чтение заметок · ${done}/${total}`))
            })
            if (this.closed) return
            this.plan = plan; this.page = 0
            for (const file of plan.files) this.selected.add(file.path)
            this.render()
        } catch (error) { if (!this.closed) { this.status.classList.add('rudonium-text-error'); this.status.setText(uiDiagnostic(error, t)) } }
        finally { this.busy = false; if (!this.closed) this.update() }
    }

    private render(): void {
        const plan = this.plan
        if (!plan) return
        const t = uiFor(this.plugin.settings)
        this.results.empty()
        this.selectionStatus()
        if (!plan.files.length) { this.results.createEl('p', { text: t('No ID wrappers need changing.', 'Маркеров для такого преобразования нет.') }); return }
        const all = this.results.createDiv({ cls: 'modal-button-container' })
        all.createEl('button', { text: t('Select All', 'Выбрать все') }).onclick = () => {
            if (this.busy) return
            for (const row of plan.files) this.selected.add(row.path)
            this.render(); this.update()
        }
        all.createEl('button', { text: t('Select None', 'Снять выделение') }).onclick = () => { if (!this.busy) { this.selected.clear(); this.render(); this.update() } }
        for (const row of plan.files.slice(this.page * pageSize, (this.page + 1) * pageSize)) {
            const section = this.results.createEl('section')
            const label = section.createEl('label')
            const checkbox = label.createEl('input', { attr: { type: 'checkbox' } })
            checkbox.checked = this.selected.has(row.path)
            label.createSpan({ text: ` ${row.path} · ${row.count}` })
            checkbox.onchange = () => { if (this.busy) return; if (checkbox.checked) this.selected.add(row.path); else this.selected.delete(row.path); this.selectionStatus(); this.update() }
            const open = section.createEl('button', { text: t('Open in Obsidian', 'Показать в Obsidian') })
            open.onclick = () => { if (!this.busy) void openObsidianFile(this.plugin.app, row.path, { modal: this, isClosed: () => this.closed })
                .catch(error => new Notice(uiDiagnostic(error, t))) }
            for (const example of row.examples) {
                section.createEl('p', { text: t(`Line ${example.line}`, `Строка ${example.line}`) })
                const before = section.createEl('pre', { text: t('Before: ', 'Было: ') + example.before })
                const after = section.createEl('pre', { text: t('After: ', 'Станет: ') + example.after })
                before.classList.add('rudonium-pre-wrap')
                after.classList.add('rudonium-pre-wrap')
            }
        }
        const pages = Math.ceil(plan.files.length / pageSize)
        if (pages > 1) {
            const paging = this.results.createDiv({ cls: 'modal-button-container' })
            const previous = paging.createEl('button', { text: t('Previous', 'Назад') })
            previous.disabled = this.page === 0
            previous.onclick = () => { if (!this.busy && this.page) { this.page--; this.render() } }
            paging.createSpan({ text: `${this.page + 1}/${pages}` })
            const next = paging.createEl('button', { text: t('Next', 'Далее') })
            next.disabled = this.page >= pages - 1
            next.onclick = () => { if (!this.busy && this.page < pages - 1) { this.page++; this.render() } }
        }
    }

    private async applySelected(): Promise<void> {
        if (this.busy || !this.plan || !this.selected.size) return
        const t = uiFor(this.plugin.settings)
        this.busy = true; this.status.classList.remove('rudonium-text-error'); this.status.setText(t('Saving and verifying the backup, then updating selected notes…',
            'Сохраняем и проверяем резервную копию, затем изменяем выбранные заметки…')); this.update()
        try {
            const result = await applyIdMarkerConversion(this.plugin, this.plan, new Set(this.selected))
            const message = t(`Updated ${result.files} files, ${result.markers} markers. Backup: ${result.backupPath}`,
                `Изменено файлов: ${result.files}, маркеров: ${result.markers}. Резервная копия: ${result.backupPath}`)
            if (this.closed) { new Notice(message, 15000); return }
            this.plan = undefined; this.selected.clear(); this.results.empty(); this.status.setText(message)
            this.results.createEl('p', { text: t('To restore selected original files, open this Obsidian.zip with Import ZIP and review the replacements. No Anki export was started.',
                'Для восстановления выбранных исходников откройте этот Obsidian.zip через «Импорт ZIP» и проверьте замены. Экспорт в Anki не запускался.') })
            this.results.createEl('button', { text: t('Copy Backup Path', 'Скопировать путь к копии') }).onclick = () => {
                void navigator.clipboard.writeText(result.backupPath).catch(() => new Notice(t('Select and copy the displayed path.', 'Выделите и скопируйте показанный путь.')))
            }
        } catch (error) {
            const message = uiDiagnostic(error, t)
            if (this.closed) new Notice(message, 15000)
            else { this.status.classList.add('rudonium-text-error'); this.status.setText(message) }
        } finally { this.busy = false; if (!this.closed) this.update() }
    }

    onClose(): void { this.closed = true; if (dialogs.get(this.plugin) === this) dialogs.delete(this.plugin) }
}

export function openIdMarkerConversion(plugin: MyPlugin, direction: IdMarkerDirection): void {
    if (dialogs.has(plugin)) { new Notice(uiFor(plugin.settings)('Close the current ID conversion window first.', 'Сначала закройте текущее окно преобразования ID.')); return }
    const modal = new IdMarkerConversionModal(plugin, direction)
    dialogs.set(plugin, modal); modal.open()
}

export function registerIdMarkerConversion(plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    plugin.addCommand({ id: 'convert-anki-ids-to-comments', name: t('Convert Anki IDs to HTML Comments', 'Перевести ID Anki в HTML-комментарии'),
        callback: () => openIdMarkerConversion(plugin, 'to-comment') })
    plugin.addCommand({ id: 'convert-anki-ids-to-plain', name: t('Remove HTML Wrappers from Anki IDs', 'Убрать HTML-оболочку у ID Anki'),
        callback: () => openIdMarkerConversion(plugin, 'to-plain') })
    plugin.addCommand({ id: 'move-this-page-id', name: t('Move this page ID', 'Перенести ID этой страницы'),
        editorCallback: editor => {
            void withFastScanReadLock(plugin, async () => {
                const text = editor.getValue()
                const location = pageIdLocation(plugin.settings.PAGE_ID_LOCATION)
                const changed = movePageId(text, location, plugin.settings.Defaults?.['ID Comments'] !== false, plugin.settings.Syntax, t)
                if (text === changed) {
                    new Notice(t('The ID is already in the selected location.', 'ID уже находится в выбранном месте.'))
                    return
                }
                // One edit keeps Undo available and leaves the answer and local notes outside the edited range.
                let start = 0, oldEnd = text.length, newEnd = changed.length
                while (start < oldEnd && start < newEnd && text[start] === changed[start]) start++
                while (oldEnd > start && newEnd > start && text[oldEnd - 1] === changed[newEnd - 1]) { oldEnd--; newEnd-- }
                editor.replaceRange(changed.slice(start, newEnd), editor.offsetToPos(start), editor.offsetToPos(oldEnd))
                new Notice(location === 'yaml' ? t('Moved the ID to properties.', 'ID перенесён в свойства.')
                    : location === 'after-answer' ? t('Moved the ID after the answer.', 'ID перенесён после ответа.')
                    : t('Moved the ID below the heading.', 'ID перенесён под заголовок.'))
            }).catch(error => new Notice(uiDiagnostic(error, t)))
        } })
    plugin.register(() => { dialogs.get(plugin)?.close() })
}
