/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal, Notice } from 'obsidian'
import type { App } from 'obsidian'
import { openAuditAnkiNote, openAuditSource } from './sync-difference-ui'
import type { VaultIdLocation } from './vault-id-index'
import { englishUi, uiDiagnostic } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

export type BidirectionalSide = 'obsidian' | 'anki'

export interface BidirectionalPreviewChange {
    key: string
    field: string
    obsidian: string
    anki: string
    /** Источник сохраняемого значения или поле, которое пользователь должен выбрать вручную. */
    decision: BidirectionalSide | 'merge' | 'conflict'
    merged?: string
    allowedSide?: BidirectionalSide
    markdown?: () => { before: string; after: string }
}

export interface BidirectionalPreviewRow {
    id: number
    path: string
    line?: number
    endLine?: number
    markerLine?: number
    changes: readonly BidirectionalPreviewChange[]
    issues?: readonly string[]
    duplicates?: readonly VaultIdLocation[]
    recoverable?: boolean
}

export interface BidirectionalPreview {
    profile: string
    scopeLabel: string
    scanned: number
    previewNewCard?: () => Promise<void>
    mountPreference?: (container: HTMLElement) => () => void
    rows: readonly BidirectionalPreviewRow[]
    issues?: readonly string[]
    foldRecoverable?: boolean
    /** Есть ли в предпросмотре безопасные изменения или исходное состояние, которое можно сохранить без разрешения конфликтов. */
    canApply: boolean
}

type ApplyPreview = (choices: ReadonlyMap<string, BidirectionalSide>, onPartial?: () => void) => Promise<string | void>
const previews = new WeakMap<App, BidirectionalPreviewModal>()
const pageSize = 24

function showIssues(parent: HTMLElement, issues: readonly string[], t: UiText): void {
    if (!issues.length) return
    const list = parent.createEl('ul')
    for (const issue of issues) {
        const row = list.createEl('li', { text: uiDiagnostic(issue, t) })
        row.style.color = 'var(--text-error)'
        row.style.overflowWrap = 'anywhere'
    }
}

/** Выделяет изменившийся фрагмент по кодовым точкам, чтобы граница выделения не разделяла суррогатную пару. */
function showValues(parent: HTMLElement, change: BidirectionalPreviewChange, t: UiText): void {
    const sides = [Array.from(change.obsidian), Array.from(change.anki)]
    const [left, right] = sides
    const sharedLength = Math.min(left.length, right.length)
    let prefix = 0
    while (prefix < sharedLength && left[prefix] === right[prefix]) prefix++
    let suffix = 0
    while (suffix < sharedLength - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++

    const layout = parent.createDiv()
    layout.style.display = 'grid'
    layout.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))'
    layout.style.gap = '0.65em'
    layout.style.marginBlock = '0.5em'
    for (let index = 0; index < sides.length; index++) {
        const chars = sides[index]
        const pane = layout.createDiv()
        pane.style.minWidth = '0'
        pane.style.padding = '0.65em'
        pane.style.border = '1px solid var(--background-modifier-border)'
        pane.style.borderRadius = 'var(--radius-m)'
        pane.createEl('strong', { text: index === 0 ? 'Obsidian' : 'Anki' })
        const value = pane.createDiv()
        value.style.whiteSpace = 'pre-wrap'
        value.style.overflowWrap = 'anywhere'
        value.style.marginBlockStart = '0.35em'
        if (change.obsidian === change.anki) {
            value.setText(chars.join('') || t('Empty field', 'Пустое поле'))
        } else {
            if (prefix) value.createSpan({ text: chars.slice(0, prefix).join('') })
            const difference = chars.slice(prefix, chars.length - suffix).join('')
            value.createEl('mark', difference ? { text: difference } : {
                text: '∅', title: t('No text at this position', 'В этом месте нет текста'), attr: { 'aria-label': t('No text at this position', 'В этом месте нет текста') },
            })
            if (suffix) value.createSpan({ text: chars.slice(chars.length - suffix).join('') })
        }
    }
}

class BidirectionalPreviewModal extends Modal {
    private readonly preview: BidirectionalPreview
    private readonly apply?: ApplyPreview
    private readonly choices = new Map<string, BidirectionalSide>()
    private readonly controls: Array<HTMLButtonElement | HTMLSelectElement> = []
    private removePreference?: () => void
    private closed = false
    private applied = false
    private busy = false

    constructor(app: App, preview: BidirectionalPreview, private readonly t: UiText, apply?: ApplyPreview) {
        super(app)
        this.preview = preview
        this.apply = apply
    }

    isApplying(): boolean { return this.busy }

    onOpen(): void {
        const { preview, apply, t } = this
        this.titleEl.setText(t('Preview Bidirectional Sync', 'Предпросмотр двусторонней синхронизации'))
        this.modalEl.style.width = 'min(56rem, calc(100vw - 2rem))'
        installModalLayout(this, t)
        this.removePreference = preview.mountPreference?.(this.contentEl)
        const counts = { obsidian: 0, anki: 0, merge: 0, conflict: 0 }
        for (const row of preview.rows) {
            for (const change of row.changes) counts[change.decision]++
        }
        this.contentEl.createEl('p', { text: t(`Sync profile: ${preview.scopeLabel}`, `Профиль синхронизации: ${preview.scopeLabel}`) })
        this.contentEl.createEl('p', { text: t(`Anki profile: ${preview.profile} · ${preview.scanned} linked notes checked`, `Профиль Anki: ${preview.profile} · Связанных записей проверено: ${preview.scanned}`) })
        const merged = counts.merge ? t(` · ${counts.merge} to merge`, ` · Объединение: ${counts.merge}`) : ''
        this.contentEl.createEl('p', {
            text: t(`${counts.obsidian} changes to Anki · ${counts.anki} changes to Obsidian${merged} · ${counts.conflict} conflicts`, `В Anki: ${counts.obsidian} · В Obsidian: ${counts.anki}${merged} · Конфликтов: ${counts.conflict}`),
        })
        if (apply && preview.canApply && !counts.obsidian && !counts.anki && !counts.merge && !counts.conflict) {
            this.contentEl.createEl('p', { text: t('Apply Sync remembers the checked values for the next sync.', 'Кнопка «Применить синхронизацию» сохранит проверенные значения для следующей сверки.') })
        }
        if (apply && counts.conflict) {
            this.contentEl.createEl('p', { text: t('Choose which version to keep for each conflict. Skipped conflicts stay pending.', 'Для каждого конфликта выберите версию, которую нужно сохранить. К пропущенным конфликтам можно вернуться позже.') })
        }
        showIssues(this.contentEl, preview.issues ?? [], t)
        const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        let submit: HTMLButtonElement | undefined
        const update = () => {
            if (submit) submit.disabled = this.applied || this.busy || (!preview.canApply && this.choices.size === 0)
            if (counts.conflict && apply) status.setText(t(`${this.choices.size} of ${counts.conflict} conflicts selected`, `Выбрано конфликтов: ${this.choices.size} из ${counts.conflict}`))
        }
        const skipped = preview.foldRecoverable ? preview.rows.filter(row => row.recoverable) : []
        this.showRows(this.contentEl, skipped.length ? preview.rows.filter(row => !row.recoverable) : preview.rows, update)
        if (skipped.length) {
            const details = this.contentEl.createEl('details')
            details.createEl('summary', { text: t(`Cards skipped: ${skipped.length}. Obsidian and Anki may be out of sync.`,
                `Пропущено карточек: ${skipped.length}. Возможна рассинхронизация Obsidian и Anki.`) })
            details.ontoggle = () => {
                if (!details.open) return
                details.ontoggle = null
                this.showRows(details, skipped, update)
            }
        }
        const actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
        if (preview.previewNewCard) {
            const open = preview.previewNewCard
            const button = actions.createEl('button', { text: t('Preview new card at cursor', 'Новая карточка под курсором…') })
            this.controls.push(button)
            button.onclick = () => void this.navigate(button, open)
        }
        submit = apply ? actions.createEl('button', { text: t('Apply Sync', 'Применить синхронизацию'), cls: 'mod-cta' }) : undefined
        update()
        if (submit && apply) submit.onclick = () => {
            if (submit.disabled) return
            void this.applyOnce(apply, status, submit)
        }
    }

    onClose(): void {
        this.removePreference?.()
        this.closed = true
        if (!this.busy && previews.get(this.app) === this) previews.delete(this.app)
        this.contentEl.empty()
    }

    private showRows(parent: HTMLElement, rows: readonly BidirectionalPreviewRow[], update: () => void): void {
        if (!rows.length) return
        const list = parent.createEl('ol')
        let displayed = 0
        const more = parent.createEl('button', { text: this.t('Show More', 'Показать ещё') })
        this.controls.push(more)
        const append = () => {
            const end = Math.min(rows.length, displayed + pageSize)
            for (; displayed < end; displayed++) this.showRow(list, rows[displayed], update)
            more.style.display = displayed < rows.length ? '' : 'none'
        }
        more.onclick = append
        append()
    }

    private showRow(parent: HTMLElement, row: BidirectionalPreviewRow, update: () => void): void {
        const { t } = this
        const item = parent.createEl('li')
        item.style.marginBlock = '0.7em'
        const details = item.createEl('details')
        const title = details.createEl('summary', { text: `${row.path} · ID ${row.id}` })
        title.style.overflowWrap = 'anywhere'
        title.style.cursor = 'pointer'
        details.open = this.preview.rows.length <= 3
        const expand = () => {
            details.ontoggle = null
            const actions = details.createDiv({ cls: 'modal-button-container' })
            actions.style.flexWrap = 'wrap'
            const source = actions.createEl('button', { text: t('Open in Obsidian', 'Открыть в Obsidian') })
            const anki = actions.createEl('button', { text: t('Open in Anki', 'Открыть в Anki') })
            this.controls.push(source, anki)
            source.onclick = () => {
                if (!this.busy) void this.navigate(source, () =>
                    openAuditSource(this.app, row, { modal: this, isClosed: () => this.closed }, t))
            }
            anki.onclick = () => {
                if (!this.busy) void this.navigate(anki, () => openAuditAnkiNote(row.id, undefined, t))
            }
            showIssues(details, row.issues ?? [], t)
            if (row.duplicates?.length) {
                const sources = details.createEl('ul')
                for (const occurrence of row.duplicates) {
                    const location = sources.createEl('li').createEl('button', {
                        text: t(`${occurrence.path} · line ${occurrence.line}`, `${occurrence.path} · строка ${occurrence.line}`),
                    })
                    location.style.whiteSpace = 'normal'
                    location.style.overflowWrap = 'anywhere'
                    this.controls.push(location)
                    location.onclick = () => {
                        if (!this.busy) void this.navigate(location, () =>
                            openAuditSource(this.app, { ...occurrence, markerLine: occurrence.line },
                                { modal: this, isClosed: () => this.closed }, t))
                    }
                }
            }
            for (const change of row.changes) this.showChange(details, change, update)
        }
        if (details.open) expand()
        else details.ontoggle = () => { if (details.open) expand() }
    }

    private showChange(parent: HTMLElement, change: BidirectionalPreviewChange, update: () => void): void {
        const { t } = this
        const section = parent.createEl('section')
        const decisions = { anki: 'Anki → Obsidian', obsidian: 'Obsidian → Anki', conflict: t('Conflict', 'Конфликт'), merge: t('Merge both sides', 'Объединить обе версии') }
        section.createEl('strong', { text: `${change.field} · ${decisions[change.decision]}` })
        showValues(section, change, t)
        if (change.markdown) {
            const detail = section.createEl('details')
            detail.createEl('summary', { text: t('Preview this field in Markdown', 'Как изменится это поле в Markdown') })
            detail.ontoggle = () => {
                if (!detail.open) return
                detail.ontoggle = null
                const { before, after } = change.markdown!()
                for (const [label, value] of [[t('Before', 'До изменения'), before], [t('With Anki value', 'Со значением из Anki'), after]]) {
                    detail.createEl('strong', { text: label })
                    detail.createEl('pre', { text: value }).style.whiteSpace = 'pre-wrap'
                }
            }
        }
        if (change.decision === 'merge' && change.merged !== undefined) {
            section.createEl('p', { text: t(`Merged result — ${change.merged || 'Empty field'}`, `Результат объединения — ${change.merged || 'Пустое поле'}`) }).style.overflowWrap = 'anywhere'
        }
        if (change.decision !== 'conflict' || !this.apply) return

        const label = section.createEl('label', { text: t('Keep ', 'Сохранить версию ') })
        const choice = label.createEl('select', { attr: { 'aria-label': t(`Resolve ${change.field} conflict`, `Разрешить конфликт поля «${change.field}»`) } })
        choice.createEl('option', { text: t('Skip for now', 'Пропустить'), value: '' })
        if (!change.allowedSide || change.allowedSide === 'obsidian') {
            choice.createEl('option', { text: t('Use Obsidian', 'Из Obsidian'), value: 'obsidian' })
        }
        if (!change.allowedSide || change.allowedSide === 'anki') {
            choice.createEl('option', { text: t('Use Anki', 'Из Anki'), value: 'anki' })
        }
        choice.value = this.choices.get(change.key) ?? ''
        choice.disabled = this.applied || this.busy
        this.controls.push(choice)
        choice.onchange = () => {
            if (this.busy || this.applied) return
            if ((choice.value === 'obsidian' || choice.value === 'anki') &&
                (!change.allowedSide || choice.value === change.allowedSide)) this.choices.set(change.key, choice.value)
            else this.choices.delete(change.key)
            update()
        }
    }

    private async navigate(button: HTMLButtonElement, open: () => Promise<void>): Promise<void> {
        if (button.disabled) return
        button.disabled = true
        try {
            await open()
        } catch (error) {
            if (!this.closed) new Notice(uiDiagnostic(error, this.t))
        } finally {
            button.disabled = this.busy
        }
    }

    private async applyOnce(apply: ApplyPreview, status: HTMLElement, submit: HTMLButtonElement): Promise<void> {
        const { t } = this
        if (this.applied || this.busy || this.closed) return
        this.applied = this.busy = true
        submit.disabled = true
        for (const control of this.controls) control.disabled = true
        status.setText(t('Applying bidirectional sync…', 'Выполняется двусторонняя синхронизация…'))
        let message: string
        let complete = true
        try {
            message = (await apply(new Map(this.choices), () => { complete = false })) || t('Bidirectional sync finished.', 'Двусторонняя синхронизация завершена.')
        } catch (error) {
            complete = false
            const reason = uiDiagnostic(error, t)
            message = t(`${reason} Run Bidirectional Sync again to refresh the preview.`, `${reason} Повторно запустите двустороннюю синхронизацию, чтобы обновить предпросмотр.`)
            status.style.color = 'var(--text-error)'
        } finally {
            this.busy = false
            if (this.closed && previews.get(this.app) === this) previews.delete(this.app)
        }
        if (complete && !this.closed) this.close()
        if (this.closed) new Notice(message)
        else {
            status.style.color = 'var(--text-error)'
            status.setText(message)
            for (const control of this.controls) if (control.tagName === 'BUTTON') control.disabled = false
        }
    }
}

/** Предпросмотр не читает файлы и ждёт подтверждения пользователя перед применением изменений. */
export function openBidirectionalPreview(app: App, preview: BidirectionalPreview, apply?: ApplyPreview, t: UiText = englishUi): void {
    const active = previews.get(app)
    if (active?.isApplying()) {
        new Notice(t('Bidirectional Sync is still applying changes.', 'Двусторонняя синхронизация ещё применяет изменения.'))
        return
    }
    active?.close()
    const modal = new BidirectionalPreviewModal(app, preview, t, apply)
    previews.set(app, modal)
    modal.open()
}
