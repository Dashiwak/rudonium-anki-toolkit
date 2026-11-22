/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal, Notice } from 'obsidian'
import type { App } from 'obsidian'
import { openAuditAnkiNote, openAuditSource, renderFieldComparison } from './sync-difference-ui'
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
    recommendedSide?: BidirectionalSide
    canChooseDirection?: boolean
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
        row.classList.add('rudonium-bidirectional-row')
    }
}

class BidirectionalPreviewModal extends Modal {
    private readonly preview: BidirectionalPreview
    private readonly apply?: ApplyPreview
    private readonly choices = new Map<string, BidirectionalSide>()
    private readonly controls: HTMLButtonElement[] = []
    private readonly directionButtons = new Set<HTMLButtonElement>()
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
        this.modalEl.classList.add('rudonium-modal-56rem')
        installModalLayout(this, t)
        this.removePreference = preview.mountPreference?.(this.contentEl)
        const counts = { obsidian: 0, anki: 0, merge: 0, conflict: 0 }
        const conflictGroups: string[][] = []
        const editable = new Map<string, BidirectionalPreviewChange>()
        let blocked = 0
        for (const row of preview.rows) {
            if (!row.changes.length && (row.issues?.length || row.duplicates?.length)) blocked++
            const fieldConflicts: string[] = []
            for (const change of row.changes) {
                counts[change.decision]++
                if (change.decision === 'conflict' || change.canChooseDirection) editable.set(change.key, change)
                if (change.decision !== 'conflict') continue
                if (change.recommendedSide && (!change.allowedSide || change.allowedSide === change.recommendedSide)) {
                    this.choices.set(change.key, change.recommendedSide)
                }
                // Pauses are independently applicable. All conflicting text fields of a note are committed together.
                if (change.key === row.id + ':suspension') conflictGroups.push([change.key])
                else fieldConflicts.push(change.key)
            }
            if (fieldConflicts.length) conflictGroups.push(fieldConflicts)
        }
        this.contentEl.createEl('p', { text: t(`Sync profile: ${preview.scopeLabel}`, `Профиль синхронизации: ${preview.scopeLabel}`) })
        this.contentEl.createEl('p', { text: t(`Anki profile: ${preview.profile} · ${preview.scanned} linked notes checked`, `Профиль Anki: ${preview.profile} · Связанных записей проверено: ${preview.scanned}`) })
        const merged = counts.merge ? t(` · To merge: ${counts.merge}`, ` · Объединение: ${counts.merge}`) : ''
        const summary = this.contentEl.createEl('p')
        if (blocked) {
            this.contentEl.createEl('p', { text: t(`Notes requiring attention: ${blocked}. Open a note below to see the reason.`,
                `Записей для проверки: ${blocked}. Раскройте запись, чтобы увидеть причину.`) })
        }
        if (apply && preview.canApply && !counts.obsidian && !counts.anki && !counts.merge && !counts.conflict) {
            this.contentEl.createEl('p', { text: t('Apply Sync remembers the checked values for the next sync.', 'Кнопка «Применить синхронизацию» сохранит проверенные значения для следующей сверки.') })
        }
        showIssues(this.contentEl, preview.issues ?? [], t)
        const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
        let submit: HTMLButtonElement | undefined
        const update = () => {
            const totals = { ...counts }
            for (const [key, side] of this.choices) {
                const change = editable.get(key)
                if (!change) continue
                totals[change.decision]--
                totals[side]++
            }
            summary.setText(t(`To Anki: ${totals.obsidian} · To Obsidian: ${totals.anki}${merged} · Unresolved conflicts: ${totals.conflict}`,
                `В Anki: ${totals.obsidian} · В Obsidian: ${totals.anki}${merged} · Нерешённых конфликтов: ${totals.conflict}`))
            const ready = preview.canApply || conflictGroups.some(group => group.every(key => this.choices.has(key)))
            if (submit) submit.disabled = this.applied || this.busy || !ready
            if (!apply) {
                status.setText(t('Read-only preview. Resolve the issue above and open the preview again.',
                    'Предпросмотр в режиме чтения. Устраните указанную причину и откройте предпросмотр снова.'))
            } else if (counts.conflict) {
                const selected = counts.conflict - totals.conflict
                status.setText(t(`Selected conflicts: ${selected} of ${counts.conflict}.`, `Выбрано конфликтов: ${selected} из ${counts.conflict}.`) + (ready ? '' : t(
                    ' Choose a direction for each conflicting field in at least one note to enable Apply Sync.',
                    ' Чтобы применить изменения, укажите направление для каждого конфликтующего поля хотя бы одной записи.')))
            } else if (!ready) {
                status.setText(blocked || preview.issues?.length ? t('No safe changes to apply. Resolve the reported issue and open the preview again.',
                    'Нет изменений, которые можно перенести. Устраните указанную причину и откройте предпросмотр снова.') :
                    t('No changes to apply.', 'Нет изменений для переноса.'))
            }
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
            more.classList.toggle('rudonium-hidden', displayed >= rows.length)
        }
        more.onclick = append
        append()
    }

    private showRow(parent: HTMLElement, row: BidirectionalPreviewRow, update: () => void): void {
        const { t } = this
        const item = parent.createEl('li')
        item.classList.add('rudonium-bidirectional-item')
        const details = item.createEl('details')
        const title = details.createEl('summary', { text: `${row.path} · ID ${row.id}` })
        title.classList.add('rudonium-bidirectional-title')
        details.open = this.preview.rows.length <= 3
        const expand = () => {
            details.ontoggle = null
            const actions = details.createDiv({ cls: 'modal-button-container' })
            actions.classList.add('rudonium-wrap-controls')
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
                    location.classList.add('rudonium-bidirectional-location')
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
        const heading = section.createEl('strong', { text: `${change.field} · ${decisions[change.decision]}` })
        renderFieldComparison(section, change.obsidian, change.anki, t)
        if (change.markdown) {
            const detail = section.createEl('details')
            detail.createEl('summary', { text: t('Preview this field in Markdown', 'Как изменится это поле в Markdown') })
            detail.ontoggle = () => {
                if (!detail.open) return
                detail.ontoggle = null
                const { before, after } = change.markdown!()
                for (const [label, value] of [[t('Before', 'До изменения'), before], [t('With Anki value', 'Со значением из Anki'), after]]) {
                    detail.createEl('strong', { text: label })
                    detail.createEl('pre', { text: value }).classList.add('rudonium-pre-wrap')
                }
            }
        }
        if (change.decision === 'merge' && change.merged !== undefined) {
            section.createEl('p', { text: t(`Merged result — ${change.merged || 'Empty field'}`, `Результат объединения — ${change.merged || 'Пустое поле'}`) }).classList.add('rudonium-wrap-anywhere')
        }
        if (!this.apply || (change.decision !== 'conflict' && !change.canChooseDirection)) return

        const recommended = change.recommendedSide
        if (recommended) {
            section.createEl('p', { text: t(`Later edit: ${recommended === 'anki' ? 'Anki' : 'Obsidian'}.`,
                `Более поздняя правка: ${recommended === 'anki' ? 'Anki' : 'Obsidian'}.`) })
        }
        const group = section.createDiv({ cls: 'rudonium-bidirectional-directions', attr: {
            role: 'group', 'aria-label': t(`Sync direction for ${change.field}`, `Направление синхронизации поля «${change.field}»`),
        } })
        const defaultSide = change.decision === 'obsidian' || change.decision === 'anki' ? change.decision : undefined
        const buttons = new Map<BidirectionalSide | 'skip', HTMLButtonElement>()
        const refresh = () => {
            const selected = this.choices.get(change.key) ?? defaultSide ?? 'skip'
            for (const [side, button] of buttons) {
                button.setAttribute('aria-pressed', String(selected === side))
            }
            heading.setText(`${change.field} · ${selected === 'skip' ? decisions.conflict : decisions[selected]}`)
        }
        const add = (side: BidirectionalSide | 'skip', label: string) => {
            const action = side === 'obsidian' ? t('Use the Obsidian value in Anki', 'Перенести значение из Obsidian в Anki') :
                side === 'anki' ? t('Use the Anki value in Obsidian', 'Перенести значение из Anki в Obsidian') : label
            const button = group.createEl('button', { text: label, title: action, attr: { type: 'button', 'aria-label': `${change.field} · ${action}` } })
            buttons.set(side, button)
            this.directionButtons.add(button)
            this.controls.push(button)
            button.disabled = this.applied || this.busy
            button.onclick = () => {
                if (this.applied || this.busy) return
                if (side === 'skip' || side === defaultSide) this.choices.delete(change.key)
                else this.choices.set(change.key, side)
                refresh()
                update()
            }
        }
        if (change.allowedSide !== 'anki') add('obsidian', 'Obsidian → Anki')
        if (change.allowedSide !== 'obsidian') add('anki', 'Obsidian ← Anki')
        if (change.decision === 'conflict') add('skip', t('Skip', 'Пропустить'))
        refresh()
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
            status.classList.add('rudonium-text-error')
        } finally {
            this.busy = false
            if (this.closed && previews.get(this.app) === this) previews.delete(this.app)
        }
        if (complete && !this.closed) this.close()
        if (this.closed) new Notice(message)
        else {
            status.classList.add('rudonium-text-error')
            status.setText(message)
            for (const control of this.controls) if (!this.directionButtons.has(control)) control.disabled = false
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
