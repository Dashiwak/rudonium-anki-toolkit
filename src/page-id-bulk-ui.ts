// SPDX-License-Identifier: GPL-3.0-only
import { checkedCount } from './sync-outcome'
import { Modal, Notice, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { uiDiagnostic, uiFor } from './interface-language'
import { installModalLayout } from './modal-layout'
import { pageIdLocation, pageIdLocationLabel, pageIdLocations } from './page-id-location'
import { applyPageIdBulk, previewPageIdBulk } from './page-id-bulk'
import type { PageIdBulkPlan, PageIdBulkSource, PageIdPlace } from './page-id-bulk'

const openDialogs = new WeakMap<MyPlugin, PageIdBulkModal>()
const pageSize = 30

class PageIdBulkModal extends Modal {
    private source: PageIdBulkSource = 'all'
    private target: PageIdPlace
    private plan?: PageIdBulkPlan
    private selected = new Set<string>()
    private busy = false
    private closed = false
    private status!: HTMLElement
    private controls!: HTMLElement
    private results!: HTMLElement
    private applyButton!: HTMLButtonElement

    constructor(private readonly plugin: MyPlugin) {
        super(plugin.app)
        this.target = pageIdLocation(plugin.settings.PAGE_ID_LOCATION)
    }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        installModalLayout(this, t)
        this.titleEl.setText(t('Move page IDs across the vault', 'Перенести ID страниц во всём хранилище'))
        this.contentEl.createEl('p', { text: t('A verified ZIP of the entire vault is saved before the first edit. The move keeps each Anki ID and edits only the selected Markdown pages.',
            'Перед первой правкой будет сохранён и проверен ZIP всего хранилища. Перенос сохраняет каждый ID Anki и меняет только выбранные Markdown-страницы.') })
        this.controls = this.contentEl.createDiv()
        this.status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        this.status.classList.add('rudonium-wrapped-text')
        this.results = this.contentEl.createDiv()
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        this.applyButton = footer.createEl('button', { cls: 'mod-cta' })
        this.applyButton.onclick = () => { void this.apply() }
        this.filters()
        this.update()
    }

    private filters(): void {
        const t = uiFor(this.plugin.settings)
        this.controls.empty()
        new Setting(this.controls).setName(t('From', 'Из формата')).addDropdown(control => {
            control.addOption('all', t('All other formats', 'Все остальные форматы'))
            for (const value of pageIdLocations) if (value !== this.target) control.addOption(value, pageIdLocationLabel(value, t))
            control.setValue(this.source).onChange(value => {
                if (this.busy || value === this.source) return
                this.source = value === 'all' ? value : pageIdLocation(value)
                this.clearPlan()
            })
        })
        new Setting(this.controls).setName(t('To', 'В формат')).addDropdown(control => {
            for (const value of pageIdLocations) control.addOption(value, pageIdLocationLabel(value, t))
            control.setValue(this.target).onChange(value => {
                if (this.busy || value === this.target) return
                this.target = pageIdLocation(value)
                if (this.source === this.target) this.source = 'all'
                this.clearPlan()
                this.filters()
            })
        }).addButton(button => button.setButtonText(t('Preview', 'Предпросмотр')).onClick(() => this.preview()))
    }

    private clearPlan(): void {
        this.plan = undefined
        this.selected.clear()
        this.status.setText('')
        this.results.empty()
        this.update()
    }

    private update(): void {
        const t = uiFor(this.plugin.settings)
        for (const control of Array.from(this.controls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select'))) control.disabled = this.busy
        for (const control of Array.from(this.results.querySelectorAll<HTMLInputElement>('input'))) control.disabled = this.busy
        this.applyButton.disabled = this.busy || !this.plan || !this.selected.size
        const count = this.selected.size ? ' (' + this.selected.size + ')' : ''
        this.applyButton.setText(t('Back up and move', 'Создать ZIP и перенести') + count)
    }

    private failure(error: unknown): void {
        const message = uiDiagnostic(error, uiFor(this.plugin.settings))
        if (this.closed) { new Notice(message, 15000); return }
        this.status.classList.add('rudonium-text-error')
        this.status.setText(message)
    }

    private async preview(): Promise<void> {
        if (this.busy) return
        const t = uiFor(this.plugin.settings)
        this.busy = true
        this.clearPlan()
        this.status.classList.remove('rudonium-text-error')
        this.status.setText(t('Checking the vault…', 'Проверяем хранилище…'))
        try {
            const plan = await previewPageIdBulk(this.plugin, this.source, this.target, (done, total) => {
                if (!this.closed && (done % 64 === 0 || done === total)) this.status.setText(t(
                    `Reading notes · ${done}/${total}`, `Чтение заметок · ${done}/${total}`))
            })
            if (this.closed) return
            this.plan = plan
            this.selected = new Set(plan.files.map(file => file.path))
            this.renderPlan(plan)
        } catch (error) { this.failure(error) }
        finally { this.busy = false; if (!this.closed) this.update() }
    }

    private renderPlan(plan: PageIdBulkPlan): void {
        const t = uiFor(this.plugin.settings)
        this.results.empty()
        this.status.setText(checkedCount(plan.scanned, 'file', t) + ' ' + t(`Ready to move: ${plan.files.length}. For review: ${plan.skipped.length}.`,
            `Готовы к переносу: ${plan.files.length}. Требуют проверки: ${plan.skipped.length}.`))
        if (plan.files.length) {
            const tools = this.results.createDiv({ cls: 'modal-button-container' })
            tools.createEl('button', { text: t('Select all', 'Выбрать все') }).onclick = () => {
                if (!this.busy) { this.selected = new Set(plan.files.map(row => row.path)); this.renderPlan(plan); this.update() }
            }
            tools.createEl('button', { text: t('Clear selection', 'Снять выделение') }).onclick = () => {
                if (!this.busy) { this.selected.clear(); this.renderPlan(plan); this.update() }
            }
            this.showPage(this.results, plan.files, (list, row) => {
                const label = list.createDiv().createEl('label')
                const box = label.createEl('input', { attr: { type: 'checkbox' } })
                box.checked = this.selected.has(row.path)
                label.createSpan({ text: ' ' + row.path + ' · ID ' + row.id + ' · ' + pageIdLocationLabel(row.from, t) + ' → ' + pageIdLocationLabel(plan.target, t) })
                box.onchange = () => {
                    if (this.busy) return
                    if (box.checked) this.selected.add(row.path)
                    else this.selected.delete(row.path)
                    this.update()
                }
            })
        }
        if (plan.skipped.length) {
            const review = this.results.createEl('details')
            review.createEl('summary', { text: t(`Files requiring review (${plan.skipped.length})`, `Файлы для проверки (${plan.skipped.length})`) })
            this.showPage(review, plan.skipped, (list, row) => list.createEl('p', { text: row.path + ' — ' + row.reason }))
        }
    }

    private showPage<T>(container: HTMLElement, rows: readonly T[], render: (list: HTMLElement, item: T) => void): void {
        const t = uiFor(this.plugin.settings)
        const list = container.createDiv()
        list.classList.add('rudonium-wrap-anywhere')
        let page = 0
        const pages = Math.ceil(rows.length / pageSize)
        const draw = () => {
            list.empty()
            for (const row of rows.slice(page * pageSize, (page + 1) * pageSize)) render(list, row)
            if (pages < 2) return
            const nav = list.createDiv({ cls: 'modal-button-container' })
            const previous = nav.createEl('button', { text: t('Previous', 'Назад') })
            previous.disabled = page === 0
            previous.onclick = () => { if (!this.busy && page > 0) { page--; draw() } }
            nav.createSpan({ text: `${page + 1}/${pages}` })
            const next = nav.createEl('button', { text: t('Next', 'Далее') })
            next.disabled = page + 1 >= pages
            next.onclick = () => { if (!this.busy && page + 1 < pages) { page++; draw() } }
        }
        draw()
    }

    private async apply(): Promise<void> {
        const plan = this.plan
        if (this.busy || !plan || !this.selected.size) return
        const t = uiFor(this.plugin.settings)
        this.busy = true
        this.update()
        this.status.classList.remove('rudonium-text-error')
        this.status.setText(t('Backing up the vault, verifying the ZIP and moving IDs…', 'Создаём копию хранилища, проверяем ZIP и переносим ID…'))
        try {
            const result = await applyPageIdBulk(this.plugin, plan, new Set(this.selected))
            const message = t(`Pages updated: ${result.changed}.`, `Изменено страниц: ${result.changed}.`) +
                (result.backupPath ? '\n' + t('Vault backup: ', 'Копия хранилища: ') + result.backupPath : '')
            if (this.closed) new Notice(message, 15000)
            else { this.clearPlan(); this.status.setText(message) }
        } catch (error) {
            if (!this.closed) this.clearPlan()
            this.failure(error)
        } finally { this.busy = false; if (!this.closed) this.update() }
    }

    onClose(): void {
        this.closed = true
        if (openDialogs.get(this.plugin) === this) openDialogs.delete(this.plugin)
    }
}

export function openPageIdBulk(plugin: MyPlugin): void {
    if (openDialogs.has(plugin)) return
    const dialog = new PageIdBulkModal(plugin)
    openDialogs.set(plugin, dialog)
    dialog.open()
}

export function registerPageIdBulk(plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    plugin.addCommand({ id: 'move-vault-page-ids', name: t('Move page IDs across the vault', 'Перенести ID страниц во всём хранилище'),
        callback: () => openPageIdBulk(plugin) })
    plugin.register(() => openDialogs.get(plugin)?.close())
}
