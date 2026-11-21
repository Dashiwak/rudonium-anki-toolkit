// SPDX-License-Identifier: GPL-3.0-only
import { Notice } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, profileProblemText } from './anki-profile'
import { previewFieldText } from './card-preview-ui'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { applyLostIds, scanLostIds } from './lost-id-recovery'
import type { LostIdOptions, LostIdPlan, LostIdRow } from './lost-id-recovery'
import { installModalLayout } from './modal-layout'
import { ReviewModal } from './obsidian-navigation'
import { openAuditSource } from './sync-difference-ui'

type ReturnToAudit = (changed: boolean) => void
const active = new WeakMap<MyPlugin, LostIdReview>()
const pageSize = 20

function commandTitle(t: UiText): string {
    return t('Check cards without an ID', 'Проверить карточки без ID')
}

function button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
    const el = parent.createEl('button', { text, attr: { type: 'button' } })
    el.onclick = action
    return el
}

class LostIdReview extends ReviewModal {
    private readonly t: UiText
    private controller = new AbortController()
    private closed = false
    private applying = false
    private changed = false
    private readonly selected = new Map<string, number>()

    constructor(private readonly plugin: MyPlugin, private readonly searchScope: LostIdOptions, private readonly back?: ReturnToAudit) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.titleEl.setText(commandTitle(this.t))
        installModalLayout(this, this.t)
        void this.scan()
    }

    protected releaseReview(): void {
        this.closed = true
        this.controller.abort()
        this.contentEl.empty()
        active.delete(this.plugin)
    }

    close(): void {
        if (this.applying) {
            this.controller.abort()
            return
        }
        super.close()
    }

    dispose(): void {
        this.applying = false
        this.close()
    }

    private finishButton(parent: HTMLElement): void {
        const t = this.t
        button(parent, this.back ? t('Back to audit', 'Вернуться к аудиту') : t('Done', 'Готово'), () => {
            this.close()
            this.back?.(this.changed)
        })
    }

    private busy(message: string): HTMLProgressElement {
        this.contentEl.empty()
        const status = this.contentEl.createEl('p', { text: message, attr: { role: 'status' } })
        const bar = this.contentEl.createEl('progress', { attr: { 'aria-label': message } })
        const stop = button(this.contentEl.createDiv({ cls: 'modal-button-container' }), this.t('Stop', 'Остановить'), () => {
            this.controller.abort()
        })
        this.controller.signal.addEventListener('abort', () => {
            stop.disabled = true
            status.setText(this.t('Stopping after the current operation…', 'Остановка после текущей операции…'))
        }, { once: true })
        return bar
    }

    private async scan(): Promise<void> {
        const t = this.t
        this.selected.clear()
        this.controller = new AbortController()
        const signal = this.controller.signal
        const bar = this.busy(t('Looking for existing Anki notes for cards without an ID…',
            'Ищу в Anki существующие записи для карточек без ID…'))
        try {
            const plan = await scanLostIds(this.plugin, this.searchScope, signal, (done, total) => {
                if (!this.closed && !signal.aborted && total > 0) { bar.max = total; bar.value = done }
            })
            if (!this.closed) this.showPlan(plan)
        } catch (error) {
            if (!this.closed) this.showError(error)
        }
    }

    private showError(error: unknown): void {
        const t = this.t
        this.contentEl.empty()
        const message = this.controller.signal.aborted ? t('Check stopped.', 'Проверка остановлена.')
            : error instanceof AnkiProfileError ? profileProblemText(error, t)
            : error instanceof Error ? error.message : String(error)
        this.contentEl.createEl('p', { text: message, attr: { role: 'status' } })
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        button(footer, t('Check again', 'Проверить снова'), () => { void this.scan() })
        this.finishButton(footer)
    }

    private showPlan(plan: LostIdPlan): void {
        const t = this.t
        const body = this.contentEl
        body.empty()
        const folder = plan.folderLabel || t('Entire vault', 'Всё хранилище')
        const scope = [t(`Folders · ${folder}`, `Папки · ${folder}`), plan.profile && t(`Anki profile · ${plan.profile}`, `Профиль Anki · ${plan.profile}`),
            this.searchScope.deck && t(`Deck · ${this.searchScope.deck}`, `Колода · ${this.searchScope.deck}`)].filter(Boolean)
        body.createEl('p', { text: scope.join(' · ') })
        const matches = plan.rows.filter(row => row.status === 'match' && row.id !== undefined)
        const reviews = plan.rows.filter(row => row.status === 'review')
        const summary = body.createEl('p', { attr: { role: 'status' } })
        summary.setText(plan.unlinked === 0 && reviews.length ? t('Some files could not be checked. Review the details below.',
            'Часть файлов не удалось проверить. Подробности указаны ниже.')
            : plan.unlinked === 0 ? t('No cards without an ID in this scope.', 'В этой области нет карточек без ID.')
            : t(`Cards without an ID · ${plan.unlinked}. No exact match · ${plan.unmatched}.`,
                `Карточек без ID — ${plan.unlinked}. Без точного совпадения — ${plan.unmatched}.`))
        if (plan.unmatched > 0) body.createEl('p', { text: t('These may be new drafts or cards whose fields, note type or deck have changed. Recovery skips them.',
            'Здесь могут быть новые черновики или карточки с изменёнными полями, типом записи или колодой. При восстановлении они будут пропущены.') })
        let updateSelection = () => {}
        if (matches.length) {
            body.createEl('h3', { text: t(`Ready to restore · ${matches.length}`, `Можно восстановить — ${matches.length}`) })
            body.createEl('p', { text: t('Question, answer, note type and deck match a single available Anki note. Select each ID you want to restore.',
                'Вопрос, ответ, тип записи и колода совпали с одной свободной записью Anki. Отметьте ID, которые хотите восстановить.') })
            this.showRows(body, matches, () => updateSelection())
        }
        if (reviews.length) {
            const details = body.createEl('details')
            details.createEl('summary', { text: t(`Needs manual review · ${reviews.length}`, `Нужна ручная проверка — ${reviews.length}`) })
            if (!matches.length) details.open = true
            this.showRows(details, reviews)
        }
        if (matches.length) body.createEl('small', { text: t('Restoring writes IDs to Markdown after backing up the vault to ZIP. Existing Anki notes keep their review history.',
            'Перед записью ID в Markdown плагин сохранит хранилище в ZIP. История повторений в Anki сохранится.') })
        const footer = body.createDiv({ cls: 'modal-button-container' })
        if (matches.length) {
            const count = footer.createSpan({ attr: { 'aria-live': 'polite' } })
            const apply = button(footer, t('Restore selected IDs', 'Восстановить выбранные ID'), () => { void this.apply(plan) })
            apply.classList.add('mod-cta')
            updateSelection = () => {
                count.setText(t(`Selected · ${this.selected.size}`, `Выбрано — ${this.selected.size}`))
                apply.disabled = this.selected.size === 0
            }
            updateSelection()
        }
        this.finishButton(footer)
    }

    private showRows(parent: HTMLElement, rows: LostIdRow[], selectionChanged?: () => void): void {
        const t = this.t
        const list = parent.createEl('ul')
        let page = 0
        const pages = Math.ceil(rows.length / pageSize)
        const nav = parent.createDiv({ cls: 'modal-button-container' })
        nav.hidden = pages < 2
        const prev = button(nav, t('Previous', 'Назад'), () => { page--; render() })
        const counter = nav.createSpan({ attr: { 'aria-live': 'polite' } })
        const next = button(nav, t('Next', 'Дальше'), () => { page++; render() })
        const render = () => {
            list.empty()
            for (const row of rows.slice(page * pageSize, (page + 1) * pageSize)) {
                const item = list.createEl('li')
                item.classList.add('rudonium-wrap-anywhere')
                const text = (html: string) => previewFieldText(item.ownerDocument, html, t('[image]', '[изображение]'))
                const title = text(row.front)
                if (row.id !== undefined && selectionChanged) {
                    const id = row.id
                    const label = item.createEl('label')
                    const box = label.createEl('input', { attr: { type: 'checkbox' } })
                    box.checked = this.selected.get(row.key) === id
                    box.onchange = () => {
                        if (box.checked) this.selected.set(row.key, id)
                        else this.selected.delete(row.key)
                        selectionChanged()
                    }
                    label.createSpan({ text: ` ${title} · ID ${id}` })
                } else if (title) item.createEl('strong', { text: title })
                const source = item.createDiv().createEl('a', { text: t(`${row.path} · line ${row.line}`, `${row.path} · строка ${row.line}`), attr: { href: '#' } })
                source.onclick = async event => {
                    event.preventDefault()
                    try { await openAuditSource(this.app, { path: row.path, line: row.line }, { modal: this, isClosed: () => this.closed }, t) }
                    catch (error) { new Notice(error instanceof Error ? error.message : String(error)) }
                }
                if (row.reason) item.createDiv({ text: row.reason })
                if (!row.back && !row.model && !row.deck) continue
                const details = item.createEl('details')
                details.createEl('summary', { text: t('Answer, note type and deck', 'Ответ, тип записи и колода') })
                details.ontoggle = () => {
                    if (!details.open) return
                    details.ontoggle = null
                    details.createEl('p', { text: text(row.back) }).classList.add('rudonium-pre-wrap')
                    details.createEl('p', { text: t(`Note type · ${row.model} · Deck · ${row.deck}`, `Тип записи · ${row.model} · Колода · ${row.deck}`) })
                }
            }
            prev.disabled = page === 0
            next.disabled = page === pages - 1
            counter.setText(`${page + 1} / ${pages}`)
        }
        render()
    }

    private async apply(plan: LostIdPlan): Promise<void> {
        if (this.applying || !this.selected.size) return
        this.applying = true
        this.controller = new AbortController()
        const t = this.t
        this.busy(t('Creating a vault ZIP, rechecking selected IDs and restoring the links…',
            'Создаю ZIP хранилища, перепроверяю выбранные ID и восстанавливаю связи…'))
        try {
            const result = await applyLostIds(this.plugin, plan, new Map(this.selected), this.controller.signal)
            if (this.closed) return
            this.changed ||= result.restored > 0
            const body = this.contentEl
            body.empty()
            body.createEl('p', { text: t(`Restored IDs · ${result.restored}.`, `Восстановлено ID — ${result.restored}.`), attr: { role: 'status' } })
            if (result.stopped) body.createEl('p', { text: result.stopped })
            if (result.archive) body.createEl('p', { text: t(`Vault ZIP · ${result.archive}`, `ZIP хранилища · ${result.archive}`) }).classList.add('rudonium-wrap-anywhere')
            const footer = body.createDiv({ cls: 'modal-button-container' })
            if (result.stopped) button(footer, t('Check again', 'Проверить снова'), () => { void this.scan() })
            this.finishButton(footer)
        } catch (error) {
            if (!this.closed) this.showError(error)
        } finally {
            this.applying = false
        }
    }
}

export function openLostIdRecovery(plugin: MyPlugin, scope: LostIdOptions = {}, back?: ReturnToAudit, leaveAudit?: () => void): void {
    const existing = active.get(plugin)
    if (existing) {
        if (leaveAudit) new Notice(uiFor(plugin.settings)('A one-time ID check is already open. Finish it before checking this deck.',
            'Разовая проверка ID уже открыта. Завершите её, затем проверьте эту колоду.'))
        else if (existing.dock) void plugin.app.workspace.revealLeaf(existing.dock.leaf)
        return
    }
    leaveAudit?.()
    const modal = new LostIdReview(plugin, scope, back)
    active.set(plugin, modal)
    modal.open()
}

export function registerLostIdRecoveryCommand(plugin: MyPlugin): void {
    plugin.register(() => active.get(plugin)?.dispose())
    plugin.addCommand({ id: 'check-cards-without-id', name: commandTitle(uiFor(plugin.settings)),
        callback: () => openLostIdRecovery(plugin) })
}
