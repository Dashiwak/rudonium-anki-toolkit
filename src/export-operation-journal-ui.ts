/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, profileProblemText, requireExpectedAnkiProfile } from './anki-profile'
import { applyExportUndo, canOfferExportUndo, checkExportOperations, previewExportUndo, readExportOperations } from './export-operation-journal'
import type { ExportOperation, ExportUndoPlan } from './export-operation-journal'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { openObsidianFile } from './obsidian-navigation'

interface JournalActions {
    deck?: string
    preview: () => void
    recover: () => void
}

const active = new WeakMap<MyPlugin, Modal>()
const pageSize = 40

class ExportOperationJournalModal extends Modal {
    private closed = false
    private running = false
    private rows: readonly ExportOperation[] = []
    private verified = new Set<string>()
    private filter: ExportOperation['status'] | 'all' = 'unknown'
    private displayLimit = pageSize
    private loaded = false
    private message = ''
    private problem = false
    private undo?: ExportUndoPlan
    private readonly t: UiText

    constructor(private readonly plugin: MyPlugin, private readonly actions: JournalActions) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.titleEl.setText(this.t('Anki Export Journal', 'Журнал экспорта Anki'))
        this.modalEl.classList.add('rudonium-export-journal-dialog')
        installModalLayout(this, this.t)
        void this.reload()
    }

    onClose(): void {
        this.closed = true
        if (active.get(this.plugin) === this) active.delete(this.plugin)
        this.contentEl.empty()
    }

    private async reload(): Promise<void> {
        try {
            this.rows = await readExportOperations(this.plugin, this.actions.deck)
            if (!this.rows.some(row => row.status === 'unknown')) this.filter = 'all'
        } catch (error) {
            this.message = uiDiagnostic(error, this.t)
            this.problem = true
        }
        this.loaded = true
        this.render()
    }

    private async reconcile(): Promise<void> {
        if (this.running) return
        this.running = true
        this.message = this.t('Checking the active profile…', 'Проверяем открытый профиль…')
        this.problem = false
        this.render()
        try {
            const profile = await requireExpectedAnkiProfile(this.plugin)
            this.rows = await readExportOperations(this.plugin, this.actions.deck)
            this.verified = new Set(await checkExportOperations(this.rows, profile))
            this.message = this.t(
                `The expected result currently matches in Anki for ${this.verified.size} operations in ${profile}.`,
                `В профиле ${profile} результат сейчас совпадает с планом у ${this.verified.size} операций.`,
            )
        } catch (error) {
            this.verified.clear()
            this.problem = true
            this.message = error instanceof AnkiProfileError ? profileProblemText(error, this.t) : uiDiagnostic(error, this.t)
        } finally {
            this.running = false
            this.render()
        }
    }

    private undoError(error: unknown): string {
        if (error instanceof AnkiProfileError) return profileProblemText(error, this.t)
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith('Anki or the journal changed')) {
            return this.t(message, 'Запись в Anki или журнал изменились. Повторно проверьте операцию.')
        }
        if (message.startsWith('Anki did not confirm the undo')) {
            return this.t(message, 'Anki не подтвердила отмену. Сверьте её результат в журнале перед следующим действием.')
        }
        if (message.startsWith('Close Anki Browse')) {
            return this.t(message, 'Закройте эту запись в обозревателе Anki и повторно проверьте операцию.')
        }
        if (message.startsWith('This operation cannot be undone')) {
            return this.t(message, 'Журнал не содержит данных, необходимых для отмены этой операции.')
        }
        return uiDiagnostic(error, this.t)
    }

    private async prepareUndo(key: string): Promise<void> {
        if (this.running) return
        this.running = true
        this.problem = false
        this.undo = undefined
        this.message = this.t('Checking the current Anki values…', 'Проверяем текущие значения в Anki…')
        this.render()
        try {
            this.undo = await previewExportUndo(this.plugin, key)
            this.message = ''
        } catch (error) {
            this.problem = true
            this.message = this.undoError(error)
        } finally {
            this.running = false
            this.render()
        }
    }

    private async submitUndo(plan: ExportUndoPlan): Promise<void> {
        if (this.running || this.undo !== plan) return
        this.running = true
        this.problem = false
        this.undo = undefined
        this.message = this.t('Verifying and undoing the selected operation…', 'Перепроверяем и отменяем выбранную операцию…')
        this.render()
        try {
            await applyExportUndo(this.plugin, plan)
            this.message = this.t('The previous values were restored and verified in Anki.', 'Прежние значения восстановлены и проверены в Anki.')
        } catch (error) {
            this.problem = true
            this.message = this.undoError(error)
        } finally {
            this.running = false
            await this.reload()
        }
    }

    private renderUndo(plan: ExportUndoPlan): void {
        const { t } = this
        const panel = this.contentEl.createEl('section')
        panel.createEl('h3', { text: t('Review Undo', 'Предпросмотр отмены') })
        panel.createEl('p', { text: t(`Anki note ${plan.noteId} · ${plan.profile}`, `Запись Anki ${plan.noteId} · ${plan.profile}`) })
        panel.createEl('p', { text: t('Review the values that will be restored in the Anki record.',
            'Проверьте значения, которые вернутся в запись Anki.') })
        for (const { name, current, previous } of plan.changes) {
            const row = panel.createEl('section')
            row.createEl('strong', { text: name })
            row.createEl('div', { text: t('Current in Anki', 'Сейчас в Anki') })
            row.createEl('pre', { text: current || t('(Empty)', '(Пусто)') }).classList.add('rudonium-pre-wrap')
            row.createEl('div', { text: t('Restore in Anki', 'Восстановить в Anki') })
            row.createEl('pre', { text: previous || t('(Empty)', '(Пусто)') }).classList.add('rudonium-pre-wrap')
        }
        const actions = panel.createDiv({ cls: 'modal-button-container' })
        actions.createEl('button', { text: t('Cancel', 'Отмена') }).onclick = () => {
            this.undo = undefined
            this.render()
        }
        actions.createEl('button', { text: t('Confirm Undo', 'Подтвердить отмену'), cls: 'mod-cta' }).onclick = () => {
            void this.submitUndo(plan)
        }
    }

    private render(): void {
        if (this.closed) return
        const { t } = this
        this.contentEl.empty()
        if (!this.loaded) return
        if (this.actions.deck) this.contentEl.createEl('p', { text: t(`Deck · ${this.actions.deck}`, `Колода · ${this.actions.deck}`) })
        if (this.message) this.contentEl.createEl('p', { text: this.message, attr: { role: this.problem ? 'alert' : 'status' } })
        if (this.undo) {
            this.renderUndo(this.undo)
            return
        }
        if (!this.rows.length) {
            if (!this.problem) this.contentEl.createEl('p', {
                text: t('No export operations have been recorded here.', 'Операций экспорта пока нет.'),
            })
            return
        }
        const toolbar = this.contentEl.createDiv({ cls: 'modal-button-container' })
        const label = toolbar.createEl('label', { text: t('Operations ', 'Операции ') })
        const filter = label.createEl('select')
        const options = {
            all: t('All', 'Все'),
            unknown: t('Outcome unknown', 'Результат неизвестен'),
            confirmed: t('Confirmed', 'Подтверждено'),
            failed: t('Rejected', 'Отклонено'),
        }
        for (const [value, text] of Object.entries(options)) filter.createEl('option', { value, text })
        filter.value = this.filter
        filter.onchange = () => {
            if (!Object.prototype.hasOwnProperty.call(options, filter.value)) return
            this.filter = filter.value as keyof typeof options
            this.displayLimit = pageSize
            this.render()
            this.contentEl.querySelector('select')?.focus()
        }
        const recheck = toolbar.createEl('button', { text: t('Check in Anki', 'Сверить с Anki'), cls: 'mod-cta' })
        recheck.disabled = this.running || !this.rows.some(row => row.status === 'unknown' && row.kind !== 'create')
        recheck.onclick = () => { void this.reconcile() }
        if (this.rows.some(row => row.kind === 'create' && row.status === 'unknown')) {
            toolbar.createEl('button', { text: t('Review Pending Creations', 'Проверить незавершённое создание') }).onclick = () => {
                this.close()
                this.actions.recover()
            }
        }
        toolbar.createEl('button', { text: t('Open Fresh Preview', 'Обновить предпросмотр') }).onclick = () => {
            this.close()
            this.actions.preview()
        }
        const rows = this.rows.filter(row => this.filter === 'all' || row.status === this.filter)
        if (!rows.length) {
            this.contentEl.createEl('p', { text: t('No operations match this filter.', 'Под фильтр не подходит ни одна операция.') })
            return
        }
        const labels: Record<ExportOperation['kind'], string> = {
            create: t('Create', 'Создание'),
            fields: t('Update fields', 'Обновление полей'),
            'add-tags': t('Add tags', 'Добавление тегов'),
            'remove-tags': t('Remove tags', 'Удаление тегов'),
            move: t('Move', 'Перемещение'),
            delete: t('Delete', 'Удаление'),
        }
        const list = this.contentEl.createEl('ul')
        for (const row of rows.slice(0, this.displayLimit)) {
            const item = list.createEl('li')
            const header = [
                row.undoOf ? t('Undo', 'Отмена') : undefined,
                labels[row.kind],
                row.noteId ? t(`Anki note ${row.noteId}`, `Запись Anki ${row.noteId}`) : undefined,
                row.cardId ? t(`Anki card ${row.cardId}`, `Карточка Anki ${row.cardId}`) : undefined,
                this.verified.has(row.key) ? t('Matches in Anki now', 'Сейчас совпадает с Anki') : options[row.status],
            ].filter(Boolean).join(' · ')
            item.createEl('strong', { text: header })
            item.createDiv({
                text: [new Date(row.at).toLocaleString(), row.profile, row.path, row.destination].filter(Boolean).join(' · '),
            }).classList.add('rudonium-wrap-anywhere')
            const names = row.fields?.map(([name]) => name) ?? row.tags
            if (names?.length) item.createDiv({ text: names.join(', ') })
            if (row.reason) item.createDiv({ text: row.reason === 'Undo was not sent.'
                ? t(row.reason, 'Отмена до Anki не отправлена.') : uiDiagnostic(row.reason, t) }).classList.add('rudonium-text-error')
            if (canOfferExportUndo(row, this.rows)) {
                const undo = item.createEl('button', { text: t('Review Undo', 'Проверить отмену') })
                undo.disabled = this.running
                undo.onclick = () => { void this.prepareUndo(row.key) }
            }
            item.createEl('button', { text: t('Open in Obsidian', 'Открыть в Obsidian') }).onclick = async () => {
                try {
                    await openObsidianFile(this.app, row.path, { modal: this, isClosed: () => this.closed })
                } catch (error) {
                    this.problem = true
                    this.message = uiDiagnostic(error, t)
                    this.render()
                }
            }
        }
        if (rows.length > this.displayLimit) {
            this.contentEl.createEl('button', {
                text: t(`Show ${Math.min(pageSize, rows.length - this.displayLimit)} More`, `Показать ещё ${Math.min(pageSize, rows.length - this.displayLimit)}`),
            }).onclick = () => {
                this.displayLimit += pageSize
                this.render()
            }
        }
    }
}

export function showExportOperationJournal(plugin: MyPlugin, actions: JournalActions): void {
    active.get(plugin)?.close()
    const modal = new ExportOperationJournalModal(plugin, actions)
    active.set(plugin, modal)
    modal.open()
}
