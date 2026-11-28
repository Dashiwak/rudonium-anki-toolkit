/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-28. See NOTICE.md for component attribution and licenses.
 */
import { FuzzySuggestModal, Modal, Notice } from 'obsidian'
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiSourceRestoreError, commitAnkiSourceRestore, prepareAnkiSourceRestore, restoreInsertionContext } from './anki-source-restore'
import type { AnkiSourceRestorePlan } from './anki-source-restore'
import { openAuditAnkiNote, openAuditSource } from './sync-difference-ui'
import { syncAuditDeckKey } from './sync-audit'
import { isSyncAuditReportPath } from './sync-profiles'
import { uiDiagnostic, uiFor } from './interface-language'
import { installModalLayout } from './modal-layout'
import { addCopyButton } from './copy-block'

class RestoreFilePicker extends FuzzySuggestModal<TFile> {
    constructor(plugin: MyPlugin, private readonly suggested: readonly string[], private readonly choose: (file: TFile) => void) {
        super(plugin.app)
        this.setPlaceholder(uiFor(plugin.settings)('Find a Markdown file by name or folder…', 'Найти Markdown-файл по имени или папке…'))
    }

    getItems(): TFile[] {
        const preferred = new Set(this.suggested)
        return this.app.vault.getMarkdownFiles().filter(file => !isSyncAuditReportPath(file.path))
            .sort((a, b) => Number(preferred.has(b.path)) - Number(preferred.has(a.path)) || a.path.localeCompare(b.path))
    }

    getItemText(file: TFile): string { return file.path }
    onChooseItem(file: TFile): void { this.choose(file) }
}

class AnkiSourceRestoreModal extends Modal {
    private readonly t: ReturnType<typeof uiFor>
    private readonly abort = new AbortController()
    private plan?: AnkiSourceRestorePlan
    private line?: number
    private editedDraft?: string
    private lastBlock?: string
    private busy = false

    constructor(private readonly plugin: MyPlugin, private readonly id: number, private readonly profile: string,
        private readonly auditDeck: string, private readonly onRestored: () => void, private readonly recheck: () => void) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.modalEl.classList.add('rudonium-modal-48rem')
        installModalLayout(this, this.t)
        this.titleEl.setText(this.t('Restore Note in Obsidian', 'Восстановить запись в Obsidian'))
        void this.load()
    }

    onClose(): void {
        this.abort.abort()
        this.contentEl.empty()
    }

    private header(): void {
        this.contentEl.createEl('p', { text: this.t(`Anki note ${this.id} · Profile ${this.profile}`,
            `Запись Anki ${this.id} · Профиль «${this.profile}»`) }).classList.add('rudonium-wrap-anywhere')
    }

    private footer(showCancel = true): HTMLElement {
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        buttons.classList.add('rudonium-wrap-controls')
        if (showCancel) buttons.createEl('button', { text: this.t('Cancel', 'Отмена') }).onclick = () => this.close()
        return buttons
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
        this.plan = undefined
        this.pending(this.t('Reading the Anki note…', 'Читаю запись Anki…'))
        try {
            const plan = await prepareAnkiSourceRestore(this.plugin, this.id, this.profile, { path, signal: this.abort.signal })
            if (this.abort.signal.aborted) return
            this.plan = plan
            this.lastBlock = plan.block
            this.line = plan.line
            this.render()
        } catch (error) {
            if (this.abort.signal.aborted) return
            this.render(uiDiagnostic(error, this.t), true, path)
        } finally {
            this.busy = false
        }
    }

    private chooseFile(): void {
        const picker = new RestoreFilePicker(this.plugin, this.plan?.suggestedPaths ?? [], file => {
            if (!this.abort.signal.aborted) void this.load(file.path)
        })
        picker.open()
    }

    private openAnkiButton(container: HTMLElement): void {
        const button = container.createEl('button', { text: this.t('Open in Anki', 'Открыть в Anki') })
        button.onclick = async () => {
            button.disabled = true
            try {
                await openAuditAnkiNote(this.id, { active: this.profile }, this.t)
            } catch (error) {
                if (!this.abort.signal.aborted) new Notice(uiDiagnostic(error, this.t))
            } finally {
                button.disabled = false
            }
        }
    }

    private render(error?: string, needsRefresh = false, failedPath?: string): void {
        const t = this.t
        this.contentEl.empty()
        this.header()
        const plan = this.plan
        if (plan) {
            const facts = this.contentEl.createDiv({ cls: 'rudonium-restore-facts' })
            facts.createDiv({ text: t(`Note type · ${plan.modelName}`, `Тип записи · ${plan.modelName}`) })
            if (plan.tags.length) facts.createDiv({ text: t(`Tags · ${plan.tags.join(', ')}`, `Теги · ${plan.tags.join(', ')}`) })
        }
        if (error) this.contentEl.createEl('p', { text: error, attr: { role: 'alert' } }).classList.add('rudonium-text-error')
        const path = plan?.path ?? failedPath
        const destination = this.contentEl.createDiv({ cls: 'rudonium-restore-destination' })
        destination.createSpan({ text: path ? t(`Destination · ${path}`, `Файл назначения · ${path}`)
            : t('Select a destination file', 'Выберите файл назначения') })
        destination.createEl('button', { text: path ? t('Choose Another File', 'Выбрать другой файл') : t('Choose File', 'Выбрать файл') })
            .onclick = () => this.chooseFile()
        if (plan?.targetDeck && syncAuditDeckKey(plan.targetDeck) !== syncAuditDeckKey(this.auditDeck)) {
            this.contentEl.createEl('p', { text: t(`File export deck · ${plan.targetDeck}. Audited deck · ${this.auditDeck}.`,
                `Колода для экспорта этого файла · ${plan.targetDeck}. Проверяемая колода · ${this.auditDeck}.`) })
        }
        for (const warning of plan?.warnings ?? []) this.contentEl.createEl('p', { text: warning })
        const position = plan?.maxLine !== undefined ? this.contentEl.createDiv({ cls: 'rudonium-restore-position' }) : undefined
        const draft = this.editedDraft ?? plan?.block ?? this.lastBlock
        const editor = draft !== undefined ? this.editor(draft) : undefined
        if (plan?.manualFields?.length && plan.manualReason) {
            this.contentEl.createEl('p', { text: plan.manualReason, attr: { role: 'status' } })
        } else if (plan?.manualReason) {
            const details = this.contentEl.createEl('details')
            details.createEl('summary', { text: t('Fields to review', 'Поля для проверки') })
            details.createEl('p', { text: plan.manualReason })
        }

        const buttons = this.footer()
        this.openAnkiButton(buttons)
        if (needsRefresh) {
            if (editor) editor.oninput = () => { this.editedDraft = editor.value }
            buttons.createEl('button', { text: t('Refresh Preview', 'Обновить предпросмотр'), cls: 'mod-cta' })
                .onclick = () => { void this.load(path) }
            return
        }
        const add = buttons.createEl('button', { text: t('Add', 'Добавить'), cls: 'mod-cta' })
        const updateAdd = () => {
            add.disabled = !editor?.value.trim() || !plan?.path || !plan.maxLine || this.line === undefined ||
                !Number.isSafeInteger(this.line) || this.line < 1 || this.line > plan.maxLine
        }
        if (position && plan && plan.maxLine !== undefined) this.positionPicker(position, plan, plan.maxLine, updateAdd)
        if (editor) editor.oninput = () => {
            this.editedDraft = editor.value
            updateAdd()
        }
        add.onclick = () => {
            if (!add.disabled && plan && editor && this.line !== undefined) void this.commit(plan, this.line, editor.value)
        }
        updateAdd()
    }

    private editor(draft: string): HTMLTextAreaElement {
        const t = this.t
        const container = this.contentEl.createDiv({ cls: 'rudonium-restore-editor' })
        const toolbar = container.createDiv({ cls: 'rudonium-restore-editor-bar' })
        const label = t('Markdown draft', 'Черновик Markdown')
        toolbar.createEl('strong', { text: label })
        const editor = container.createEl('textarea', { attr: { 'aria-label': label, rows: 9, spellcheck: 'false' } })
        editor.value = draft
        const status = container.createSpan({ cls: 'rudonium-copy-status', attr: { role: 'status' } })
        addCopyButton(toolbar, () => editor.value, t('Copy Markdown', 'Скопировать Markdown'), t, status)
        return editor
    }

    private positionPicker(container: HTMLElement, plan: AnkiSourceRestorePlan, maxLine: number, updateAdd: () => void): void {
        const t = this.t
        const label = container.createEl('label', { cls: 'rudonium-restore-line-label',
            text: t('Insert before line', 'Вставить перед строкой') })
        const input = label.createEl('input', { attr: { type: 'number', min: 1, max: maxLine, step: 1 } })
        input.value = String(this.line ?? '')
        container.createEl('button', { text: t('End of File', 'В конец файла') }).onclick = () => {
            input.value = String(maxLine)
            update()
        }
        const context = container.createDiv({ cls: 'rudonium-restore-context', attr: { 'aria-live': 'polite' } })
        const update = () => {
            this.line = Number(input.value)
            const view = restoreInsertionContext(plan, this.line)
            context.empty()
            if (view) {
                for (const text of view.before) context.createDiv({ cls: 'rudonium-restore-context-line', text })
                context.createDiv({ cls: 'rudonium-restore-insertion', text: t(`Insert note here · line ${view.blockLine}`,
                    `Запись будет вставлена здесь · строка ${view.blockLine}`) })
                for (const text of view.after) context.createDiv({ cls: 'rudonium-restore-context-line', text })
            } else {
                context.createDiv({ text: t(`Enter a line from 1 to ${maxLine}.`, `Введите строку от 1 до ${maxLine}.`) })
            }
            input.setAttribute('aria-invalid', String(!view))
            updateAdd()
        }
        input.oninput = update
        update()
    }

    private async commit(plan: AnkiSourceRestorePlan, line: number, block: string): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return
        this.busy = true
        const t = this.t
        this.pending(t('Checking the draft and saving the note…', 'Проверяю черновик и сохраняю запись…'))
        try {
            const source = await commitAnkiSourceRestore(this.plugin, plan, this.abort.signal, { line, block })
            this.onRestored()
            if (this.abort.signal.aborted) return
            this.contentEl.empty()
            this.header()
            this.contentEl.createEl('p', { text: t(`Added to ${source.path}, line ${source.line}.`,
                `Запись добавлена в файл ${source.path}, строка ${source.line}.`), attr: { role: 'status' } }).classList.add('rudonium-wrap-anywhere')
            const buttons = this.footer(false)
            buttons.createEl('button', { text: t('Recheck Deck', 'Перепроверить колоду') }).onclick = () => {
                this.close()
                this.recheck()
            }
            const open = buttons.createEl('button', { text: t('Open Restored Note', 'Открыть восстановленную запись'), cls: 'mod-cta' })
            open.onclick = async () => {
                open.disabled = true
                try {
                    await openAuditSource(this.app, source, { modal: this, isClosed: () => this.abort.signal.aborted }, t)
                } catch (error) {
                    if (!this.abort.signal.aborted) new Notice(uiDiagnostic(error, t))
                } finally {
                    open.disabled = false
                }
            }
            open.focus()
        } catch (error) {
            if (!this.abort.signal.aborted) {
                const editable = error instanceof AnkiSourceRestoreError && (error.code === 'draft' || error.code === 'position')
                this.render(uiDiagnostic(error, t), !editable)
            }
        } finally {
            this.busy = false
        }
    }
}

export function openAnkiSourceRestore(plugin: MyPlugin, id: number, profile: string, auditDeck: string,
    onRestored: () => void, recheck: () => void): void {
    new AnkiSourceRestoreModal(plugin, id, profile, auditDeck, onRestored, recheck).open()
}
