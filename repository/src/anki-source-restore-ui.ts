/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal, Notice, TFile } from 'obsidian'
import type MyPlugin from '../main'
import { commitAnkiSourceRestore, prepareAnkiSourceRestore } from './anki-source-restore'
import type { AnkiSourceRestorePlan } from './anki-source-restore'
import { openAuditSource } from './sync-difference-ui'
import { syncAuditDeckKey } from './sync-audit'
import { isSyncAuditReportPath } from './sync-profiles'
import { uiDiagnostic, uiFor } from './interface-language'
import { installModalLayout } from './modal-layout'

const fileLimit = 80

function searchKey(value: string): string {
    return value.normalize('NFKC').toLowerCase()
}

class AnkiSourceRestoreModal extends Modal {
    private readonly t: ReturnType<typeof uiFor>
    private readonly abort = new AbortController()
    private plan?: AnkiSourceRestorePlan
    private choosingFile = false
    private busy = false

    constructor(private readonly plugin: MyPlugin, private readonly id: number, private readonly profile: string,
        private readonly auditDeck: string, private readonly onRestored: () => void, private readonly recheck: () => void) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.modalEl.style.width = 'min(48rem, calc(100vw - 2rem))'
        installModalLayout(this, this.t)
        this.titleEl.setText(this.t('Restore Source in Obsidian', 'Восстановить источник в Obsidian'))
        void this.load()
    }

    onClose(): void {
        this.abort.abort()
        this.contentEl.empty()
    }

    private header(): void {
        this.contentEl.createEl('p', { text: this.t(`Anki note ${this.id} · Profile ${this.profile}`,
            `Запись Anki ${this.id} · Профиль «${this.profile}»`) }).style.overflowWrap = 'anywhere'
    }

    private footer(showCancel = true): HTMLElement {
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        buttons.style.flexWrap = 'wrap'
        if (showCancel) buttons.createEl('button', { text: this.t('Cancel', 'Отмена') }).onclick = () => this.close()
        return buttons
    }

    private errorMessage(error: unknown): string {
        return uiDiagnostic(error, this.t)
    }

    private pending(label: string): void {
        this.contentEl.empty()
        this.header()
        this.contentEl.createEl('p', { text: label, attr: { role: 'status' } })
        this.footer()
    }

    private async load(path?: string): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return
        this.busy = true
        const t = this.t
        this.pending(t('Reading the Anki record and checking its source…', 'Читаю запись Anki и проверяю её источник…'))
        try {
            const plan = await prepareAnkiSourceRestore(this.plugin, this.id, this.profile, { path, signal: this.abort.signal })
            if (this.abort.signal.aborted) return
            this.plan = plan
            this.choosingFile = !plan.path
            this.render()
        } catch (error) {
            if (!this.abort.signal.aborted) this.render(this.errorMessage(error), path)
        } finally {
            this.busy = false
        }
    }

    private render(error?: string, failedPath?: string): void {
        const t = this.t
        this.contentEl.empty()
        this.header()
        if (error) {
            this.contentEl.createEl('p', { text: error, attr: { role: 'alert' } }).style.color = 'var(--text-error)'
        }
        const plan = this.plan
        if (!plan) {
            if (this.choosingFile) {
                this.filePicker([], failedPath)
                return
            }
            const footer = this.footer()
            footer.createEl('button', { text: t('Choose Existing File', 'Выбрать существующий файл') }).onclick = () => {
                this.choosingFile = true
                this.render()
            }
            footer.createEl('button', { text: t('Refresh Preview', 'Обновить предпросмотр'), cls: 'mod-cta' })
                .onclick = () => { void this.load(failedPath) }
            return
        }
        const facts = [plan.modelName]
        if (plan.tags.length) facts.push(t(`Tags · ${plan.tags.join(', ')}`, `Теги · ${plan.tags.join(', ')}`))
        this.contentEl.createEl('p', { text: facts.join(' · ') }).style.overflowWrap = 'anywhere'
        if (this.choosingFile) {
            this.filePicker(plan.suggestedPaths, failedPath ?? plan.path)
            return
        }
        if (plan.path === undefined || plan.line === undefined || plan.block === undefined) return
        const path = plan.path
        this.contentEl.createEl('p', { text: t(`Destination · ${path}, line ${plan.line}`,
            `Куда добавить · ${path}, строка ${plan.line}`) }).style.overflowWrap = 'anywhere'
        if (plan.targetReason === 'file-link') this.contentEl.createEl('p', { text: t('Found using the Anki File link.', 'Файл найден по ссылке File в Anki.') })
        else if (plan.targetReason === 'context') this.contentEl.createEl('p', { text: t('Found using the path in Anki Context.', 'Файл найден по пути из Context в Anki.') })
        if (plan.targetDeck && syncAuditDeckKey(plan.targetDeck) !== syncAuditDeckKey(this.auditDeck)) {
            this.contentEl.createEl('p', { text: t(`File export deck · ${plan.targetDeck}. Audited deck · ${this.auditDeck}.`,
                `Колода для экспорта этого файла · ${plan.targetDeck}. Проверяемая колода · ${this.auditDeck}.`) }).style.overflowWrap = 'anywhere'
        }
        for (const warning of plan.warnings ?? []) this.contentEl.createEl('p', { text: warning })
        const preview = this.contentEl.createEl('pre', { text: plan.block, attr: { tabindex: '0', 'aria-label':
            t('Markdown to append', 'Markdown для добавления в конец файла') } })
        Object.assign(preview.style, { maxHeight: 'min(35vh, 18rem)', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
        this.showOriginalFields(plan)
        this.contentEl.createEl('p', { text: t('The block will be appended to this file with the existing Anki ID.',
            'Блок будет добавлен в конец этого файла с существующим ID Anki.') })
        const footer = this.footer()
        footer.createEl('button', { text: t('Choose Another File', 'Выбрать другой файл') }).onclick = () => {
            this.choosingFile = true
            this.render()
        }
        footer.createEl('button', {
            text: error ? t('Refresh Preview', 'Обновить предпросмотр') : t('Restore in Obsidian', 'Восстановить в Obsidian'),
            cls: 'mod-cta',
        }).onclick = error ? () => { void this.load(path) } : () => { void this.commit(plan) }
    }

    private showOriginalFields(plan: AnkiSourceRestorePlan): void {
        const details = this.contentEl.createEl('details')
        details.createEl('summary', { text: this.t('Original Anki Fields', 'Исходные поля Anki') })
        const fields = details.createEl('dl')
        Object.assign(fields.style, { maxHeight: 'min(30vh, 15rem)', overflow: 'auto', overflowWrap: 'anywhere' })
        for (const [name, value] of Object.entries(plan.fields)) {
            fields.createEl('dt', { text: name })
            fields.createEl('dd', { text: value.length > 4000 ? `${value.slice(0, 4000)}…` : value })
        }
    }

    private filePicker(suggestedPaths: readonly string[], preferred?: string): void {
        const t = this.t
        this.contentEl.createEl('p', { text: t('Choose the existing Markdown file where this card belongs.',
            'Выберите существующий Markdown-файл, в котором должна находиться карточка.') })
        if (this.plan) this.showOriginalFields(this.plan)
        const label = this.contentEl.createEl('label', { text: t('Search Markdown Files', 'Поиск Markdown-файлов') })
        const search = label.createEl('input', { attr: { type: 'search', autocomplete: 'off', placeholder: t('File or folder name', 'Имя файла или папки') } })
        Object.assign(search.style, { display: 'block', width: '100%' })
        const list = this.contentEl.createEl('select', { attr: { size: 10, 'aria-label': t('Markdown files', 'Файлы Markdown') } })
        Object.assign(list.style, { display: 'block', width: '100%', maxHeight: '34vh', overflowY: 'auto' })
        const feedback = this.contentEl.createEl('p', { attr: { role: 'status' } })
        const footer = this.footer()
        if (this.plan?.path) {
            footer.createEl('button', { text: t('Back to Preview', 'Назад к предпросмотру') }).onclick = () => {
                this.choosingFile = false
                this.render()
            }
        }
        const button = footer.createEl('button', { text: t('Preview in Selected File', 'Предпросмотр в выбранном файле'), cls: 'mod-cta' })
        const suggested = new Set(suggestedPaths)
        const files = this.app.vault.getMarkdownFiles()
            .filter(file => file instanceof TFile && file.extension.toLowerCase() === 'md' && !isSyncAuditReportPath(file.path))
            .map(file => ({ path: file.path, key: searchKey(file.path), suggested: suggested.has(file.path) }))
            .sort((left, right) => Number(right.suggested) - Number(left.suggested) || left.path.localeCompare(right.path, undefined, { numeric: true }))
        let visible: string[] = []
        const refresh = (selected?: string) => {
            const words = searchKey(search.value.trim()).split(/\s+/)
            const matches = files.filter(file => words.every(word => file.key.includes(word)))
            visible = matches.slice(0, fileLimit).map(file => file.path)
            list.empty()
            for (const path of visible) list.createEl('option', { value: path, text: path, title: path })
            list.selectedIndex = selected ? visible.indexOf(selected) : -1
            if (list.selectedIndex >= 0) list.value = visible[list.selectedIndex]
            button.disabled = list.selectedIndex < 0
            feedback.setText(matches.length > fileLimit
                ? t(`Showing ${fileLimit} of ${matches.length} files. Narrow the search to see other matches.`,
                    `Показано ${fileLimit} из ${matches.length} файлов. Уточните запрос, чтобы найти нужный.`)
                : t(`Files found · ${matches.length}`, `Найдено файлов · ${matches.length}`))
        }
        const confirm = () => {
            if (visible.includes(list.value)) void this.load(list.value)
        }
        search.oninput = () => refresh()
        search.onkeydown = event => {
            if (event.isComposing || event.key !== 'ArrowDown' || !visible.length) return
            event.preventDefault()
            list.selectedIndex = 0
            list.value = visible[0]
            button.disabled = false
            list.focus()
        }
        list.onchange = () => { button.disabled = !visible.includes(list.value) }
        list.onkeydown = event => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault()
                confirm()
            }
        }
        button.onclick = confirm
        refresh(preferred)
        search.focus()
    }

    private async commit(plan: AnkiSourceRestorePlan): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return
        this.busy = true
        const t = this.t
        this.pending(t('Checking the preview and saving the Markdown…', 'Проверяю предпросмотр и сохраняю Markdown…'))
        try {
            const source = await commitAnkiSourceRestore(this.plugin, plan, this.abort.signal)
            this.onRestored()
            if (this.abort.signal.aborted) return
            this.contentEl.empty()
            this.header()
            this.contentEl.createEl('p', { text: t(`Restored in ${source.path}, line ${source.line}.`,
                `Восстановлено в файле ${source.path}, строка ${source.line}.`), attr: { role: 'status' } }).style.overflowWrap = 'anywhere'
            const buttons = this.footer(false)
            buttons.createEl('button', { text: t('Recheck Deck', 'Перепроверить колоду') }).onclick = () => {
                this.close()
                this.recheck()
            }
            const open = buttons.createEl('button', { text: t('Open Restored Source', 'Открыть восстановленный блок'), cls: 'mod-cta' })
            open.onclick = async () => {
                open.disabled = true
                try {
                    await openAuditSource(this.app, source, { modal: this, isClosed: () => this.abort.signal.aborted }, t)
                } catch (error) {
                    if (!this.abort.signal.aborted) new Notice(this.errorMessage(error))
                } finally {
                    open.disabled = false
                }
            }
            open.focus()
        } catch (error) {
            if (!this.abort.signal.aborted) this.render(this.errorMessage(error))
        } finally {
            this.busy = false
        }
    }
}

export function openAnkiSourceRestore(plugin: MyPlugin, id: number, profile: string, auditDeck: string,
    onRestored: () => void, recheck: () => void): void {
    new AnkiSourceRestoreModal(plugin, id, profile, auditDeck, onRestored, recheck).open()
}
