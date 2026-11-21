/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal, Notice, TFile } from 'obsidian'
import type { App } from 'obsidian'
import type { ExportDeckMove, ExportFieldPreview, OneWayFieldConflict } from './anki-delta'
import { oneWayFieldChoice } from './export-plan'
import { describeDeckRoute } from './deck-routes'
import { openAuditAnkiNote, openAuditSource } from './sync-difference-ui'
import { AnkiProfileError, checkPinnedAnkiProfile, profileProblemText } from './anki-profile'
import { exportCardIssueText, exportCardSourceDigest, isDuplicateFirstFieldErrorMessage, localizeExportError } from './card-export-diagnostics'
import type { ExportCardIssue } from './card-export-diagnostics'
import { findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'
import { openObsidianFile, ReviewModal } from './obsidian-navigation'
import type { NavigationOrigin } from './obsidian-navigation'
import { installModalLayout } from './modal-layout'
import { renderReviewedCardImpact } from './anki-card-impact-ui'
import { describeExportRule } from './export-rules'
import type { ExportRuleOutcome } from './export-rules'
import type { ExportPreviewOperation, ExportPreviewSelection } from './export-plan'

export interface OptimizedImagePreview {
    filename: string
    originalBytes: number
    optimizedBytes: number
    originalWidth: number
    originalHeight: number
    width: number
    height: number
    copyPath?: string
    replacePath?: string
    references?: { total: number; sample: string[] }
}

export interface ExportPreviewRow {
    path: string
    exportRules?: readonly ExportRuleOutcome[]
    deck?: string
    added: number
    updated: number
    deleted: number
    deletionIds?: readonly number[]
    moved: number
    deckMoves?: readonly ExportDeckMove[]
    media?: number
    optimizedImages?: readonly OptimizedImagePreview[]
    errors?: readonly string[]
    cardIssues?: readonly ExportCardIssue[]
    fieldConflicts?: readonly OneWayFieldConflict[]
    keptAnkiFields?: readonly ExportFieldPreview[]
    plannedFieldUpdates?: readonly ExportFieldPreview[]
    operations?: readonly ExportPreviewOperation[]
}

export interface ExportProgress {
    total: number
    confirmed: number
    pending: number
    stage: string
}

export interface ExportReportFile {
    path: string
    deck?: string
    errors: readonly string[]
    retryable: boolean
    cardIssues?: readonly ExportCardIssue[]
}

export interface ExportRunReport {
    finishedAt: string
    scope: string
    profileSignature?: string
    ankiProfile?: string
    submittedRequests?: number
    answeredRequests?: number
    recoveredCreations?: number
    outcome: 'completed' | 'stopped' | 'failed' | 'blocked-profile'
    total: number
    confirmed: number
    pending: number
    files: readonly ExportReportFile[]
    cardImpact?: readonly string[]
    messages?: readonly string[]
    warnings?: readonly string[]
}

export interface ExportRecoveryRow {
    cursorToken?: string
    path: string
    currentPath?: string
    ankiProfile?: string
    slots: readonly (number | null | 'unknown')[]
    candidateIds?: readonly number[]
    cardPreviews?: readonly ExportRecoveryCardPreview[]
    error?: string
}

export interface ExportRecoveryCardPreview {
    line?: number
    prompt?: string
    state: string
    candidates?: readonly number[]
}

interface ExportRecoveryActions {
    cleanup?: () => Promise<number>
}

const rowsPerPage = 40
const activeReview = new WeakMap<App, Modal>()

function fileLabel(parent: HTMLElement, path: string, openFile: () => void, t: UiText): void {
    const line = parent.createDiv()
    line.style.display = 'flex'
    line.style.flexWrap = 'wrap'
    line.style.alignItems = 'center'
    line.style.gap = '0.5em'
    const label = line.createEl('strong', { text: path })
    label.style.overflowWrap = 'anywhere'
    line.createEl('button', {
        text: t('Open in Obsidian', 'Открыть в Obsidian'),
        attr: { 'aria-label': t(`Open ${path} in Obsidian`, `Открыть ${path} в Obsidian`) },
    }).onclick = openFile
}

function showErrors(parent: HTMLElement, errors: readonly string[], t: UiText): void {
    if (!errors.length) return
    const list = parent.createEl('ul')
    for (const text of new Set(errors.map(error => localizeExportError(error, t)))) {
        const row = list.createEl('li', { text })
        row.style.color = 'var(--text-error)'
        row.style.overflowWrap = 'anywhere'
    }
}

function hasMissingAnkiId(issues: readonly ExportCardIssue[] | undefined): boolean {
    return issues?.some(issue => issue.code === 'missing-id') ?? false
}

export function isReportedDuplicateAddError(error: string): boolean {
    const match = /(?:^|: )Import action \d+ \/ multi\[\d+\] \/ addNote\[\d+\]: ([^\r\n]+)$/.exec(error)
    return match !== null && isDuplicateFirstFieldErrorMessage(match[1])
}

/** После записи соседних ID строки могли сместиться. Привязываем выделение к единственному текущему маркеру. */
async function openExportCardSource(app: App, path: string, issue: ExportCardIssue, t: UiText,
    syntax?: DuplicateMarkerSyntax, origin?: NavigationOrigin): Promise<void> {
    const { source, id } = issue
    if (source?.digest && id === undefined) {
        await openObsidianFile(app, path, origin, editor => {
            const { line, endLine, startColumn, endColumn, digest } = source
            const changed = () => new Error(t('The card has moved or changed. Export again to refresh its location.',
                'Карточка переместилась или изменилась. Повторите экспорт, чтобы обновить её расположение.'))
            if (line > endLine || endLine > editor.lineCount() || startColumn > editor.getLine(line - 1).length ||
                endColumn > editor.getLine(endLine - 1).length || line === endLine && startColumn > endColumn) throw changed()
            const lines = Array.from({ length: endLine - line + 1 }, (_value, index) => {
                const row = line + index
                return editor.getLine(row - 1).slice(row === line ? startColumn : 0, row === endLine ? endColumn : undefined)
            })
            if (exportCardSourceDigest(lines.join('\n')) !== digest) throw changed()
            const from = { line: line - 1, ch: startColumn }
            const to = { line: endLine - 1, ch: endColumn }
            editor.setSelection(from, to)
            editor.scrollIntoView({ from, to }, true)
        })
        return
    }
    if (!source || id === undefined) {
        await openAuditSource(app, { path, line: issue.line, id }, origin, t)
        return
    }
    const file = app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error(t('The Markdown file was moved or removed. Recheck to update this location.',
        'Файл Markdown перемещён или отсутствует. Повторите проверку, чтобы найти его.'))
    const matches = findIdMarkers(await app.vault.read(file), syntax).filter(marker => marker.id === id)
    const marker = matches.length === 1 ? matches[0] : undefined
    const lineShift = marker ? marker.line - issue.line : 0
    const columnShift = marker && source.markerColumn !== undefined ? marker.column - source.markerColumn : 0
    await openAuditSource(app, { path, id, line: source.line + lineShift, endLine: source.endLine + lineShift,
        markerLine: issue.line + lineShift, startColumn: source.startColumn + (source.line === issue.line ? columnShift : 0),
        endColumn: source.endColumn + (source.endLine === issue.line ? columnShift : 0) }, origin, t)
}

class CardIssueNotice extends Notice {
    onDismiss?: () => void

    hide(): void {
        this.onDismiss?.()
        this.onDismiss = undefined
        super.hide()
    }
}

const activeMissing = new WeakMap<App, CardIssueNotice>()

export function dismissMissingCardReview(app: App): void {
    activeMissing.get(app)?.hide()
}

type NoticeButton = readonly [label: string, action?: () => void | Promise<void>, keepOpen?: boolean]

function showCardNotice(path: string, issue: ExportCardIssue, t: UiText, details: string | undefined,
    buttons: readonly NoticeButton[], duration = 15000): CardIssueNotice {
    const fragment = document.createDocumentFragment()
    const heading = document.createElement('strong')
    heading.textContent = exportCardIssueText(issue, t)
    fragment.append(heading)
    const location = document.createElement('div')
    location.textContent = cardIssueLocation(path, issue, t)
    location.style.overflowWrap = 'anywhere'
    fragment.append(location)
    if (details) {
        const more = document.createElement('small')
        more.textContent = details
        fragment.append(more)
    }
    const actions = document.createElement('div')
    Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '0.4em', marginBlockStart: '0.6em' })
    fragment.append(actions)
    const notice = new CardIssueNotice(fragment, duration)
    for (const [label, action, keepOpen] of buttons) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        if (label === t('Review Repair', 'Исправить запись') || label === t('Run Audit', 'Провести аудит')) button.className = 'mod-cta'
        actions.append(button)
        button.onclick = async event => {
            event.stopPropagation()
            if (button.disabled) return
            button.disabled = true
            if (!keepOpen) notice.hide()
            try { await action?.() }
            finally { if (keepOpen) button.disabled = false }
        }
    }
    return notice
}

function cardIssueLocation(path: string, issue: ExportCardIssue, t: UiText): string {
    const line = t(`${path} · line ${issue.line}`, `${path} · строка ${issue.line}`)
    const column = issue.source?.startColumn
    return issue.code === 'duplicate-first-field' && column !== undefined && column > 0
        ? line + t(`, column ${column + 1}`, `, столбец ${column + 1}`) : line
}

function showNoticeSource(app: App, path: string, issue: ExportCardIssue, t: UiText, syntax?: DuplicateMarkerSyntax): () => Promise<void> {
    return () => openExportCardSource(app, path, issue, t, syntax)
        .catch(error => { new Notice(localizeExportError(String(error), t)) })
}

interface ReportedCard { path: string; issue: ExportCardIssue; deck?: string }

export interface ExportRepairTarget {
    id: number
    path: string
    profile?: string
    scopeSignature?: string
}

export function showMissingAnkiCardNotice(app: App, cards: readonly ReportedCard[], t: UiText,
    repair?: (deck: string | undefined, target: ExportRepairTarget) => void, syntax?: DuplicateMarkerSyntax): void {
    dismissMissingCardReview(app)
    let index = 0
    const next = () => {
        const card = cards[index++]
        if (!card) return
        const { path, issue } = card
        const buttons: NoticeButton[] = [[t('Show Note', 'Показать запись'), showNoticeSource(app, path, issue, t, syntax), true]]
        const id = issue.id
        if (repair && id !== undefined) buttons.push([t('Review Repair', 'Исправить запись'), () => repair(issue.deck ?? card.deck, { id, path })])
        buttons.push([t('Skip', 'Пропустить'), next])
        const notice = showCardNotice(path, issue, t, undefined, buttons, 0)
        activeMissing.set(app, notice)
        notice.onDismiss = () => { if (activeMissing.get(app) === notice) activeMissing.delete(app) }
    }
    next()
}

export function showDuplicateFirstFieldNotice(app: App, cards: readonly ReportedCard[], t: UiText,
    openAudit?: (deck?: string) => void): void {
    const first = cards[0]
    if (!first) return
    const { path, issue } = first
    const count = cards.length
    const details = count > 1 ? t(`Skipped because of a matching first field: ${count}.`,
        `Пропущено карточек с таким же первым полем: ${count}.`) : undefined
    const buttons: Array<readonly [string, () => void | Promise<void>]> = [
        [t('Show Note', 'Показать запись'), showNoticeSource(app, path, issue, t)],
    ]
    if (openAudit) buttons.push([t('Run Audit', 'Провести аудит'), () => openAudit(singleAuditDeck(cards.map(card => card.issue.deck ?? card.deck)))])
    if (count > 1) buttons.push([t('Show All Skipped Cards', 'Все пропущенные карточки'), () => openReview(app, { skipped: cards }, t, openAudit)])
    showCardNotice(path, issue, t, details, buttons)
}

/** При неизвестном маршруте или нескольких колодах пользователь выбирает колоду в аудите. */
export function singleAuditDeck(decks: readonly (string | undefined)[]): string | undefined {
    const first = decks[0]?.trim()
    return first && decks.every(deck => deck?.trim() === first) ? first : undefined
}

export function auditDeckForFile(file: { deck?: string; cardIssues?: readonly ExportCardIssue[] }): string | undefined {
    const issues = file.cardIssues ?? []
    return issues.length ? singleAuditDeck(issues.map(issue => issue.deck ?? file.deck)) : file.deck
}

function formatImageSize(bytes: number, t: UiText): string {
    if (bytes < 1000) return `${bytes} ${t('B', 'Б')}`
    const unit = bytes >= 1000000 ? 1000000 : 1000
    const count = (bytes / unit).toLocaleString(t('', 'ru') || undefined, { maximumFractionDigits: 1 })
    return `${count} ${unit === 1000 ? t('KB', 'КБ') : t('MB', 'МБ')}`
}

function showRows(container: HTMLElement, length: number, renderRow: (row: HTMLElement, index: number) => void, t: UiText): void {
    if (!length) return
    const list = container.createEl('ul')
    let displayed = 0
    const more = length > rowsPerPage ? container.createEl('button') : undefined
    const next = () => {
        const end = Math.min(length, displayed + rowsPerPage)
        for (; displayed < end; displayed++) {
            const row = list.createEl('li')
            row.style.marginBlock = '0.65em'
            renderRow(row, displayed)
        }
        if (more) {
            const remaining = Math.min(rowsPerPage, length - displayed)
            if (remaining) more.setText(t(`Show ${remaining} More`, `Показать ещё ${remaining}`))
            else more.remove()
        }
    }
    if (more) more.onclick = next
    next()
}

function showFieldStatus(parent: HTMLElement, notes: readonly ExportFieldPreview[] | undefined, title: string, color: string, t: UiText): void {
    if (!notes?.length) return
    const section = parent.createDiv({ attr: { role: 'group', 'aria-label': title } })
    section.createEl('strong', { text: title }).style.color = color
    showRows(section, notes.length, (item, index) => {
        const { id, fields } = notes[index]
        item.textContent = `Anki ID ${id} · ${fields.join(', ')}`
        item.style.overflowWrap = 'anywhere'
    }, t)
}

type Review =
    { rows: readonly ExportPreviewRow[]; apply: (selected: ExportPreviewSelection) => void; scopeLabel?: string; ankiProfile?: string } |
    { skipped: readonly ReportedCard[] } |
    { report: ExportRunReport; retry: (paths: ReadonlySet<string>) => void } |
    { recovery: readonly ExportRecoveryRow[]; recheck: (paths: ReadonlySet<string>, profile: string) => void;
        actions?: ExportRecoveryActions }

class ExportReviewModal extends ReviewModal {
    private readonly review: Review
    private closed = false
    private navigating = false

    constructor(app: App, review: Review, private readonly t: UiText, private readonly openAudit?: (deck?: string) => void,
        private readonly sourceSyntax?: DuplicateMarkerSyntax) {
        super(app)
        this.review = review
    }

    onOpen(): void {
        this.modalEl.style.width = 'min(52rem, calc(100vw - 2rem))'
        installModalLayout(this, this.t)
        const review = this.review
        if ('rows' in review) this.showPreview(review.rows, review.apply, review.scopeLabel)
        else if ('skipped' in review) this.showSkipped(review.skipped)
        else if ('report' in review) this.showReport(review.report, review.retry)
        else this.showRecovery(review.recovery, review.recheck, review.actions)
    }

    protected releaseReview(): void {
        this.closed = true
        if (activeReview.get(this.app) === this) activeReview.delete(this.app)
        this.contentEl.empty()
    }

    private async openFile(path: string, line?: number, issue?: ExportCardIssue): Promise<void> {
        if (this.navigating) return
        this.navigating = true
        try {
            const origin = { modal: this, isClosed: () => this.closed }
            if (issue) await openExportCardSource(this.app, path, issue, this.t, this.sourceSyntax, origin)
            else await openAuditSource(this.app, { path, line }, origin, this.t)
        } catch (error) {
            if (!this.closed) new Notice(localizeExportError(String(error), this.t))
        } finally {
            this.navigating = false
        }
    }

    private footer(): HTMLElement {
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.style.flexWrap = 'wrap'
        return footer
    }

    private addAuditButton(parent: HTMLElement, deck?: string): void {
        const openAudit = this.openAudit
        if (!openAudit) return
        parent.createEl('button', { text: this.t('Run Audit', 'Провести аудит') }).onclick = () => {
            this.close()
            openAudit(deck)
        }
    }

    private showFileIssues(parent: HTMLElement, path: string, errors: readonly string[], issues: readonly ExportCardIssue[] = []): void {
        if (issues.length) {
            if (hasMissingAnkiId(issues)) {
                parent.createEl('p', { cls: 'setting-item-description', text: this.t(
                    'Check the open Anki profile. If the note was deleted, use Undo in Anki if available, or restore it from a backup made before the deletion. Then retry this file.',
                    'Проверьте открытый профиль Anki. Если запись удалена, отмените удаление в Anki, если это ещё возможно, или восстановите её из копии, сделанной до удаления. Затем повторите экспорт файла.') })
                if (this.openAudit) parent.createEl('p', { cls: 'setting-item-description', text: this.t(
                    'Retrying checks the same ID again. If you find the same note under a different ID, compare the fields before replacing the stale ID in the existing Obsidian block.',
                    'Повтор снова проверит тот же ID. Если в Anki найдётся та же запись с другим ID, сравните поля перед заменой старого ID в существующем блоке Obsidian.') })
            }
            const list = parent.createEl('ul', { attr: { 'aria-label': this.t('Card issues', 'Проблемы карточек') } })
            for (const issue of issues) {
                const item = list.createEl('li')
                const message = item.createEl('p', { text: exportCardIssueText(issue, this.t) })
                message.style.color = 'var(--text-error)'
                message.style.overflowWrap = 'anywhere'
                const duplicate = issue.code === 'duplicate-first-field'
                const label = duplicate ? this.t('Show Note', 'Показать запись') : this.t(`Open line ${issue.line}`, `Открыть строку ${issue.line}`)
                item.createEl('button', { text: label }).onclick = () => {
                    void this.openFile(path, issue.line, issue)
                }
                this.showDuplicateEvidence(item, issue)
            }
        }
        const shown = new Set(issues.map(issue => issue.message))
        const duplicate = issues.some(issue => issue.code === 'duplicate-first-field')
        const prefix = `${path}: `
        showErrors(parent, errors.filter(error => !shown.has(error) && !shown.has(error.slice(prefix.length)) &&
            !(duplicate && isReportedDuplicateAddError(error))), this.t)
    }

    private showDuplicateEvidence(parent: HTMLElement, issue: ExportCardIssue): void {
        const { t, review } = this
        const candidate = issue.otherSource
        if (candidate) parent.createEl('button', { text: t('Show Other Obsidian Note', 'Показать вторую запись в Obsidian') }).onclick =
            () => this.openFile(candidate.path, candidate.line)
        const profile = 'rows' in review ? review.ankiProfile : 'report' in review ? review.report.ankiProfile : undefined
        for (const note of issue.ankiCandidates ?? []) {
            const details = parent.createEl('details')
            details.createEl('summary', { text: [`Anki ID ${note.id}`, note.modelName, ...note.decks].filter(Boolean).join(' · ') })
            for (const field of note.fieldChanges) {
                details.createEl('strong', { text: field.name })
                details.createEl('p', { text: t('In Anki', 'В Anki') })
                details.createEl('pre', { text: field.anki ?? t('(Unavailable)', '(Нет данных)') }).style.whiteSpace = 'pre-wrap'
                details.createEl('p', { text: t('In Obsidian', 'В Obsidian') })
                details.createEl('pre', { text: field.source ?? t('(Unavailable)', '(Нет данных)') }).style.whiteSpace = 'pre-wrap'
            }
            if (profile) details.createEl('button', { text: t('Open in Anki', 'Открыть в Anki') }).onclick = async () => {
                try { await openAuditAnkiNote(note.id, { active: profile }, t) }
                catch (error) { if (!this.closed) new Notice(localizeExportError(String(error), t)) }
            }
        }
    }

    private showSkipped(cards: readonly ReportedCard[]): void {
        const { t } = this
        this.titleEl.setText(t('Skipped Cards', 'Пропущенные карточки'))
        this.contentEl.createEl('p', { text: t(
            'These cards have a matching first field in Anki or in this export.',
            'У этих карточек первое поле совпало с записью в Anki или с другой карточкой в этом экспорте.') })
        showRows(this.contentEl, cards.length, (item, index) => {
            const { path, issue, deck } = cards[index]
            item.createEl('strong', { text: cardIssueLocation(path, issue, t) }).style.overflowWrap = 'anywhere'
            item.createEl('button', { text: t('Show Note', 'Показать запись') }).onclick = () => this.openFile(path, issue.line, issue)
            this.showDuplicateEvidence(item, issue)
            this.addAuditButton(item, issue.deck ?? deck)
        }, t)
    }

    private showPreview(rows: readonly ExportPreviewRow[], apply: (selected: ExportPreviewSelection) => void, scopeLabel?: string): void {
        const { t } = this
        this.titleEl.setText(t('Preview Anki Export', 'Предпросмотр экспорта в Anki'))
        if (scopeLabel) this.contentEl.createEl('p', { text: t(`Sync scope · ${scopeLabel}`, `Область синхронизации · ${scopeLabel}`) })
        const changed = rows.filter(row => row.operations?.length).length
        const errors = rows.some(row => row.errors?.length || row.cardIssues?.length)
        const fieldConflicts = rows.some(row => row.fieldConflicts?.length)
        const selected = new Set<string>()
        const planned = new Map(rows.filter(row => row.operations?.length)
            .map(row => [row.path, new Set(row.operations?.filter(operation => !operation.cardImpact && !operation.requiresExplicitSelection)
                .map(operation => operation.key))] as const))
        let operationCount = Array.from(planned.values()).reduce((total, keys) => total + keys.size, 0)
        let exportButton: HTMLButtonElement | undefined
        const updateButton = () => {
            if (exportButton) exportButton.disabled = operationCount === 0 && selected.size === 0
        }
        const kinds = {
            field: t('Update field', 'Обновить поле'),
            tags: t('Update tags', 'Обновить теги'),
            deck: t('Move cards', 'Переместить карточки'),
            create: t('Create note', 'Создать запись'),
            delete: t('Delete Anki note', 'Удалить запись Anki'),
            'id-date': t('Date the Markdown ID', 'Поставить дату рядом с ID'),
            suspend: t('Suspend all cards', 'Приостановить все карточки'),
            media: t('Update attachments', 'Обновить вложения'),
        }
        const localEffects = {
            'strike-block': t('Strike through the entire card in Markdown', 'Зачеркнуть всю карточку в Markdown'),
            'hide-block': t('Hide the card in an HTML comment', 'Скрыть карточку в HTML-комментарии'),
            'mark-block': t('Keep the source and mark it as deleted from Anki', 'Сохранить текст и отметить удаление из Anki'),
            'remove-block': t('Remove the Markdown card block', 'Удалить блок карточки из Markdown'),
            'trash-page': t('Move the entire Markdown file to trash', 'Переместить весь файл Markdown в корзину'),
            'keep-private-page': t('Keep the page and ID to protect private notes after the answer', 'Сохранить страницу и ID для защиты личных заметок после ответа'),
            'clear-command': t('Clear the deletion marker and keep the source and ID', 'Убрать метку удаления, сохранить текст и ID'),
            'clear-command-and-id': t('Clear the standalone command and ID', 'Убрать отдельную команду и её ID'),
        }
        const summary = this.contentEl.createEl('p', {
            text: changed ? t(`Planned changes in ${changed} ${changed === 1 ? 'file' : 'files'}. Anki will be checked again before export.`,
                `Файлы с запланированными изменениями · ${changed}. Перед экспортом плагин повторно проверит Anki.`) :
                fieldConflicts ? t('Review differing fields and select only the values to take from Obsidian.',
                    'Сравните поля и отметьте значения, которые нужно перенести из Obsidian.') :
                    errors ? t('Resolve the issues below and review the export again.',
                        'Исправьте указанные проблемы и повторите предпросмотр.') : t('No changes to export.', 'Изменений для экспорта нет.'),
            attr: { role: 'status' },
        })
        if (errors && !changed) summary.style.color = 'var(--text-error)'
        if (errors && changed) {
            this.contentEl.createEl('p', { text: t('Some files need attention. Review their messages below.',
                'В некоторых файлах есть проблемы. Проверьте сообщения под этими файлами.') }).style.color = 'var(--text-error)'
        }
        if (rows.some(row => row.added)) {
            this.contentEl.createEl('p', { text: t(
                'When adding notes, Anki checks the first field against the entire open collection. Restore the original ID in Markdown if this card already exists.',
                'При добавлении Anki проверяет первое поле по всей открытой коллекции. Если карточка уже существует, восстановите в Markdown ID оригинала.') })
        }
        showRows(this.contentEl, rows.length, (item, index) => {
            const row = rows[index]
            if (row.path) fileLabel(item, row.path, () => { void this.openFile(row.path) }, t)
            for (const rule of row.exportRules ?? []) item.createEl('p', { text: describeExportRule(rule, t) })
            const changes = [
                [row.added, t(`Add ${row.added}`, `Добавить ${row.added}`)],
                [row.updated, t(`Update ${row.updated}`, `Обновить ${row.updated}`)],
                [row.moved, t(`Move ${row.moved}`, `Переместить ${row.moved}`)],
                [row.deleted, t(`Delete ${row.deleted}`, `Удалить ${row.deleted}`)],
                [row.media ?? 0, t(`Upload ${row.media ?? 0} media`, `Загрузить вложения (${row.media ?? 0})`)],
            ] as const
            const detail = changes.filter(([count]) => count > 0).map(([, label]) => label)
            if (detail.length) item.createEl('p', { text: detail.join(' · ') })
            const operations = row.operations ?? []
            const choices = planned.get(row.path)
            if (choices) showRows(item, operations.length, (operationEl, operationIndex) => {
                const operation = operations[operationIndex]
                const numbers = operation.suspendSelection !== 'all' && operation.suspendSelection?.join(', ')
                const action = numbers ? t(`Suspend card numbers ${numbers}`, `Приостановить карточки № ${numbers}`) : kinds[operation.kind]
                const deletion = operation.deletion
                const remote = deletion?.alreadyAbsent ? t('Already absent from Anki', 'Запись уже отсутствует в Anki') : action
                const title = [remote, deletion && localEffects[deletion.local], operation.id ? `Anki ID ${operation.id}` : '',
                    operation.modelName, operation.deck, operation.kind === 'field' ? operation.values[0]?.name : ''].filter(Boolean).join(' · ')
                const label = operationEl.createEl('label')
                const checkbox = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': title } })
                label.createEl('span', { text: ` ${title}` })
                checkbox.checked = choices.has(operation.key)
                checkbox.onchange = () => {
                    if (checkbox.checked && !choices.has(operation.key)) {
                        choices.add(operation.key)
                        operationCount++
                    } else if (!checkbox.checked && choices.delete(operation.key)) operationCount--
                    updateButton()
                }
                if (!operation.values.length && !operation.cardImpact && !operation.requiresExplicitSelection && !operation.line) return
                const breakdown = operationEl.createEl('details')
                breakdown.createEl('summary', { text: t('Review details', 'Посмотреть изменения') })
                if (operation.cardImpact) {
                    renderReviewedCardImpact(operationEl, operation.cardImpact, t)
                }
                if (operation.requiresExplicitSelection) {
                    operationEl.createEl('p', { text: t('Approve a new attachment name for these cards.',
                        'Подтвердите новое имя вложения для этих карточек.') })
                }
                for (const value of operation.values) {
                    const name = value.name === 'Tags' && operation.kind !== 'field' ? t('Tags', 'Теги') :
                        operation.kind === 'suspend' ? t('Card IDs', 'ID карточек') : value.name
                    breakdown.createEl('strong', { text: name })
                    if (value.before !== undefined) {
                        breakdown.createEl('p', { text: t('Before', 'До') })
                        breakdown.createEl('pre', { text: value.before || t('(Empty)', '(Пусто)') }).style.whiteSpace = 'pre-wrap'
                    }
                    if (value.after !== undefined) {
                        breakdown.createEl('p', { text: t('After', 'После') })
                        breakdown.createEl('pre', { text: value.after || t('(Empty)', '(Пусто)') }).style.whiteSpace = 'pre-wrap'
                    }
                }
                const line = operation.line
                if (line !== undefined) {
                    breakdown.createEl('button', { text: t(`Open line ${line}`, `Открыть строку ${line}`) }).onclick =
                        () => this.openFile(row.path, line)
                }
            }, t)
            showFieldStatus(item, row.keptAnkiFields, t('Changes in Anki kept', 'Сохранить правки из Anki'), 'var(--text-muted)', t)
            if (row.optimizedImages?.length) {
                const images = item.createEl('ul', { attr: { 'aria-label': t('Planned image optimization', 'Оптимизация изображений при экспорте') } })
                for (const image of row.optimizedImages) {
                    const sizes = `${formatImageSize(image.originalBytes, t)} → ${formatImageSize(image.optimizedBytes, t)}`
                    const dimensions = `${image.originalWidth} × ${image.originalHeight} → ${image.width} × ${image.height} ${t('px', 'пкс')}`
                    const entry = images.createEl('li', { text: `${image.filename} · ${dimensions} · ${sizes}` })
                    if (image.copyPath) entry.createEl('p', { text: t(`Save copy in Obsidian · ${image.copyPath}`, `Сохранить копию в Obsidian · ${image.copyPath}`) })
                    if (image.replacePath) entry.createEl('p', { text: t(`Replace original in Obsidian · ${image.replacePath}`, `Заменить оригинал в Obsidian · ${image.replacePath}`) })
                    if (image.references) {
                        const { total, sample } = image.references
                        const extra = total > sample.length ? t(` · ${total - sample.length} more`, ` · и ещё ${total - sample.length}`) : ''
                        entry.createEl('p', { text: t(`Referenced by ${total} notes`, `Заметок со ссылкой · ${total}`) + ` · ${sample.join(' · ')}${extra}` })
                    }
                }
            }
            if (row.deckMoves?.length) {
                const moves = item.createEl('ul', { attr: { 'aria-label': t('Planned deck moves', 'Перемещения между колодами') } })
                for (const move of row.deckMoves) {
                    const reason = move.reason ? describeDeckRoute(move.reason, t) : ''
                    const count = t(`${move.count} ${move.count === 1 ? 'card' : 'cards'}`, `Карточек · ${move.count}`)
                    moves.createEl('li', { text: `${move.from} → ${move.to} · ${count}${reason ? ` · ${reason}` : ''}` })
                }
            }
            if (row.deletionIds?.length) {
                const sample = row.deletionIds.slice(0, 8).join(', ')
                const remaining = row.deletionIds.length - 8
                item.createEl('p', { text: t(`Delete Anki IDs ${sample}${remaining > 0 ? ` and ${remaining} more` : ''}`,
                    `Удалить записи Anki с ID ${sample}${remaining > 0 ? ` и ещё ${remaining}` : ''}`) })
            }
            for (const field of row.fieldConflicts ?? []) {
                const choice = oneWayFieldChoice(field)
                const details = item.createEl('details')
                details.createEl('summary', { text: `Anki ID ${field.id} · ${field.name} · ${t('Review differing values', 'Сравнить значения')}` })
                    .style.color = 'var(--text-error)'
                details.createEl('p', { text: field.kind === 'untracked' ? t('No confirmed previous value is available.',
                    'Подтверждённое предыдущее значение недоступно.') :
                    t('Obsidian and Anki both changed this field.', 'Это поле изменилось и в Obsidian, и в Anki.') })
                details.createEl('strong', { text: t('In Anki', 'В Anki') })
                details.createEl('pre', { text: field.actual || t('(Empty)', '(Пусто)') }).style.whiteSpace = 'pre-wrap'
                details.createEl('strong', { text: t('In Obsidian', 'В Obsidian') })
                details.createEl('pre', { text: field.source || t('(Empty)', '(Пусто)') }).style.whiteSpace = 'pre-wrap'
                if (field.cardImpact) renderReviewedCardImpact(details, field.cardImpact, t)
                const label = details.createEl('label')
                const checkbox = label.createEl('input', { attr: { type: 'checkbox',
                    'aria-label': t(`Use Obsidian for ${field.name} in Anki ID ${field.id}`, `Взять поле ${field.name} из Obsidian для Anki ID ${field.id}`) } })
                label.createEl('span', { text: t(' Use Obsidian for this field', ' Взять значение из Obsidian') })
                checkbox.checked = selected.has(choice)
                checkbox.onchange = () => {
                    if (checkbox.checked) selected.add(choice)
                    else selected.delete(choice)
                    updateButton()
                }
            }
            this.showFileIssues(item, row.path, row.errors ?? [], row.cardIssues)
        }, t)
        const footer = this.footer()
        if (errors) this.addAuditButton(footer, singleAuditDeck(rows.filter(row => row.errors?.length || row.cardIssues?.length).map(auditDeckForFile)))
        if (changed > 0 || fieldConflicts) {
            exportButton = footer.createEl('button', { text: t('Export Changes', 'Экспортировать изменения'), cls: 'mod-cta' })
            updateButton()
            exportButton.onclick = () => {
                const mediaAliasSources = new Set(rows.flatMap(row => (row.operations ?? [])
                    .filter(operation => planned.get(row.path)?.has(operation.key))
                    .flatMap(operation => operation.mediaAliasSources ?? [])))
                this.close()
                apply({ paths: planned, conflicts: selected, mediaAliasSources })
            }
        }
    }

    private showReport(report: ExportRunReport, retry: (paths: ReadonlySet<string>) => void): void {
        const { t } = this
        this.titleEl.setText(t('Last Anki Export', 'Отчёт о последнем экспорте'))
        const date = new Date(report.finishedAt).toLocaleString(t('', 'ru') || undefined)
        if (report.cardImpact?.length) {
            const details = this.contentEl.createEl('details')
            details.createEl('summary', { text: t('Verified study card changes', 'Проверенные изменения учебных карточек') })
            showRows(details, report.cardImpact.length,
                (item, index) => { item.setText(report.cardImpact![index]) }, t)
        }
        const outcomes = {
            completed: t('Completed', 'Завершён'),
            stopped: t('Stopped before the next batch', 'Остановлен перед следующим пакетом'),
            failed: t('Finished with errors', 'Завершён с ошибками'),
            'blocked-profile': t('Stopped by the Anki profile check', 'Остановлен проверкой профиля Anki'),
        }
        this.contentEl.createEl('p', { text: `${outcomes[report.outcome]} · ${date} · ${report.scope}` })
        if (report.ankiProfile) this.contentEl.createEl('p', { text: t(`Target Anki profile: ${report.ankiProfile}`,
            `Целевой профиль Anki · ${report.ankiProfile}`) })
        if (report.recoveredCreations) this.contentEl.createEl('p', { text: t(`Recovered existing Anki IDs · ${report.recoveredCreations}`,
            `Восстановлено существующих Anki ID · ${report.recoveredCreations}`) })
        this.contentEl.createEl('p', { text: exportCounts(report, t), attr: { role: 'status' } })
        if (report.outcome === 'blocked-profile' && report.submittedRequests) {
            this.contentEl.createEl('p', { text: t(
                `${report.submittedRequests} Anki write requests sent · ${report.answeredRequests ?? 0} received a response`,
                `Запросов на запись в Anki · ${report.submittedRequests}. Ответов · ${report.answeredRequests ?? 0}.`) })
        }
        if (report.warnings?.length) {
            const warnings = this.contentEl.createEl('details')
            warnings.createEl('summary', { text: t(`Warnings · ${report.warnings.length}`, `Предупреждения · ${report.warnings.length}`) })
            const list = warnings.createEl('ul')
            for (const warning of report.warnings) list.createEl('li', { text: warning }).style.color = 'var(--text-warning)'
        }
        showErrors(this.contentEl, report.messages ?? [], t)
        if (!report.files.length) {
            if (report.messages?.length) this.addAuditButton(this.footer())
            return
        }
        const canRetry = (file: ExportReportFile) => Boolean(report.ankiProfile) && file.retryable
        if (!report.ankiProfile) {
            this.contentEl.createEl('p', { text: t('Start a new scan after setting the expected Anki profile to retry this operation.',
                'Настройте ожидаемый профиль Anki и запустите новую проверку.') })
        }

        const findLabel = t('Find a file or error', 'Найти файл или ошибку')
        const label = this.contentEl.createEl('label', { text: findLabel + ' ' })
        const search = label.createEl('input', { attr: { type: 'search', 'aria-label': findLabel } })
        const status = this.contentEl.createEl('p', { attr: { role: 'status' } })
        const tools = this.contentEl.createDiv({ cls: 'modal-button-container' })
        tools.style.flexWrap = 'wrap'
        const select = tools.createEl('button', { text: t('Select Matching Files', 'Выбрать найденные файлы') })
        const clear = tools.createEl('button', { text: t('Clear Selection', 'Снять выделение') })
        const list = this.contentEl.createDiv()
        const footer = this.footer()
        const submit = footer.createEl('button', { text: t('Retry Selected Files', 'Повторить для выбранных файлов'), cls: 'mod-cta' })
        const selected = new Set<string>()
        const searchable = report.files.map(file => ({
            file,
            text: [file.path, ...file.errors, ...(file.cardIssues?.map(issue => issue.message) ?? [])].join('\n').toLowerCase(),
        }))
        let matches = report.files

        const update = () => {
            status.setText(t(`${matches.length} of ${report.files.length} files shown · ${selected.size} selected`,
                `Показано файлов · ${matches.length} из ${report.files.length}. Выбрано · ${selected.size}.`))
            submit.disabled = clear.disabled = selected.size === 0
            select.disabled = !matches.some(file => canRetry(file) && !selected.has(file.path))
        }
        const render = () => {
            list.empty()
            const query = search.value?.trim().toLowerCase()
            matches = query ? searchable.filter(entry => entry.text.includes(query)).map(entry => entry.file) : report.files
            if (!matches.length) list.createEl('p', { text: t('No files match this search.', 'По этому запросу файлы не найдены.') })
            showRows(list, matches.length, (row, index) => {
                const file = matches[index]
                if (canRetry(file)) {
                    const label = row.createEl('label', { text: t('Retry this file ', 'Проверить этот файл повторно ') })
                    const input = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': t(`Retry ${file.path}`, `Повторить для ${file.path}`) } })
                    input.checked = selected.has(file.path)
                    input.onchange = () => {
                        if (input.checked) selected.add(file.path)
                        else selected.delete(file.path)
                        update()
                    }
                }
                fileLabel(row, file.path, () => { void this.openFile(file.path) }, t)
                this.showFileIssues(row, file.path, file.errors, file.cardIssues)
                if (file.errors.length || file.cardIssues?.length) this.addAuditButton(row, auditDeckForFile(file))
            }, t)
            update()
        }
        search.oninput = render
        select.onclick = () => {
            for (const file of matches) if (canRetry(file)) selected.add(file.path)
            render()
        }
        clear.onclick = () => { selected.clear(); render() }
        submit.onclick = () => {
            if (!selected.size) return
            this.close()
            retry(new Set(selected))
        }
        render()
    }

    private showRecovery(rows: readonly ExportRecoveryRow[], recheck: (paths: ReadonlySet<string>, profile: string) => void,
        actions?: ExportRecoveryActions): void {
        const { t } = this
        this.titleEl.setText(t('Recover Pending Anki Exports', 'Восстановление незавершённых экспортов'))
        this.contentEl.createEl('p', { text: rows.length ?
            t('Recheck a source to recover verified Anki IDs. Compare any candidates with the Markdown before resolving a conflict.',
                'Повторно проверьте исходный файл, чтобы восстановить подтверждённые Anki ID. При конфликте сравните найденные записи с Markdown.') :
            t('No unfinished card creation was found.', 'Незавершённых созданий карточек нет.') })
        let cleaning = false
        showRows(this.contentEl, rows.length, (item, index) => {
            const row = rows[index]
            const profile = row.ankiProfile
            const path = row.currentPath
            if (path) {
                fileLabel(item, path, () => { void this.openFile(path) }, t)
                if (path !== row.path) item.createEl('p', { text: t(`Previous location · ${row.path}`, `Предыдущий путь · ${row.path}`) })
                if (profile) item.createEl('button', { text: t('Recheck and Recover', 'Проверить и восстановить') }).onclick = () => {
                    if (cleaning) return
                    this.close()
                    recheck(new Set([path]), profile)
                }
            } else {
                item.createEl('strong', { text: row.path }).style.overflowWrap = 'anywhere'
                item.createEl('p', { text: t('The current source could not be confirmed.', 'Не удалось подтвердить исходный файл.') })
            }
            item.createEl('p', { text: row.ankiProfile ? t(`Anki profile: ${row.ankiProfile}`, `Профиль Anki · ${row.ankiProfile}`) :
                t('Anki profile could not be confirmed for this older operation.', 'Профиль Anki для этой операции не подтверждён.') })
            const ids = row.slots.filter((slot): slot is number => typeof slot === 'number' && Number.isSafeInteger(slot) && slot > 0)
            if (ids.length) this.showRecoveryIds(item, ids, profile, t('Confirmed Anki IDs', 'Подтверждённые Anki ID'))
            const cards = row.cardPreviews ?? []
            const candidateLabel = t('Candidate Anki IDs', 'Возможные Anki ID')
            if (cards.length) {
                showRows(item, cards.length, (entry, position) => {
                    const card = cards[position]
                    const line = card.line && Number.isSafeInteger(card.line) && card.line > 0 ? card.line : undefined
                    if (card.prompt || line) {
                        const label = entry.createEl('strong', {
                            text: [line ? t(`Line ${line}`, `Строка ${line}`) : '', card.prompt].filter(Boolean).join(' · '),
                        })
                        label.style.overflowWrap = 'anywhere'
                    }
                    entry.createEl('p', { text: card.state })
                    if (path && line) entry.createEl('button', { text: t(`Open line ${line} in Obsidian`, `Открыть строку ${line} в Obsidian`) }).onclick = () => {
                        void this.openFile(path, line)
                    }
                    if (card.candidates?.length) this.showRecoveryIds(entry, card.candidates, profile, candidateLabel)
                }, t)
            }
            const shownCandidates = new Set(cards.flatMap(card => card.candidates ?? []))
            const otherCandidates = row.candidateIds?.filter(id => !shownCandidates.has(id))
            if (otherCandidates?.length) this.showRecoveryIds(item, otherCandidates, profile, candidateLabel)
            const unknown = row.slots.filter(slot => slot === 'unknown').length
            if (unknown && !cards.length) item.createEl('p', { text: t(
                `${unknown} creation responses could not be verified. Review Anki before adding another record.`,
                `Неподтверждённых ответов о создании · ${unknown}. Проверьте Anki, прежде чем добавлять ещё одну запись.`) })
            showErrors(item, row.error ? [row.error] : [], t)
        }, t)
        const cleanup = actions?.cleanup
        if (!cleanup) { this.footer(); return }
        const status = this.contentEl.createEl('p', {
            text: t('Clean tags after the Anki IDs are saved in Obsidian.', 'Удалите служебные теги после сохранения Anki ID в Obsidian.'),
            attr: { role: 'status' },
        })
        const button = this.footer().createEl('button', { text: t('Clean Recovery Tags', 'Очистить теги восстановления') })
        button.onclick = async () => {
            if (cleaning) return
            cleaning = button.disabled = true
            status.setText(t('Checking saved Anki IDs and cleaning tags…', 'Проверка сохранённых Anki ID и очистка тегов…'))
            status.style.color = ''
            try {
                const count = await cleanup()
                const message = count === 0 ? t('No recovery tags are ready to clean.', 'Тегов, готовых к очистке, нет.') :
                    t(`Finished cleanup for ${count} recovery ${count === 1 ? 'tag' : 'tags'}.`, `Очищено тегов восстановления · ${count}.`)
                if (this.closed) new Notice(message)
                else status.setText(message)
            } catch (error) {
                const message = localizeExportError(error instanceof Error ? error.message : String(error), t)
                if (this.closed) new Notice(message)
                else {
                    status.setText(message)
                    status.style.color = 'var(--text-error)'
                }
            } finally {
                cleaning = button.disabled = false
            }
        }
    }

    private showRecoveryIds(parent: HTMLElement, candidates: readonly number[], profile: string | undefined, label: string): void {
        const { t } = this
        const ids = Array.from(new Set(candidates.filter(id => Number.isSafeInteger(id) && id > 0)))
        if (!ids.length) return
        const heading = parent.createEl('details')
        heading.createEl('summary', { text: `${label} · ${ids.length}` })
        let shown = false
        const showIds = () => {
            if (!heading.open || shown) return
            shown = true
            showRows(heading, ids.length, (line, position) => {
                const id = ids[position]
                if (!profile) {
                    line.createEl('span', { text: String(id) })
                    return
                }
                const button = line.createEl('button', { text: t(`Open ${id} in Anki`, `Открыть ${id} в Anki`) })
                button.onclick = async () => {
                    button.disabled = true
                    try {
                        await checkPinnedAnkiProfile(profile)
                        await openAuditAnkiNote(id, undefined, t)
                    } catch (error) {
                        const message = error instanceof AnkiProfileError
                            ? t(error.message, profileProblemText(error, t))
                            : localizeExportError(error instanceof Error ? error.message : String(error), t)
                        new Notice(message)
                    } finally {
                        button.disabled = false
                    }
                }
            }, t)
        }
        heading.ontoggle = showIds
        heading.open = ids.length === 1
        showIds()
    }
}

function openReview(app: App, review: Review, t: UiText, openAudit?: (deck?: string) => void, sourceSyntax?: DuplicateMarkerSyntax): void {
    activeReview.get(app)?.close()
    const modal = new ExportReviewModal(app, review, t, openAudit, sourceSyntax)
    activeReview.set(app, modal)
    modal.open()
}

export function openExportPreview(app: App, rows: readonly ExportPreviewRow[],
    apply: (selected: ExportPreviewSelection) => void, scopeLabel?: string, t: UiText = englishUi,
    openAudit?: (deck?: string) => void, sourceSyntax?: DuplicateMarkerSyntax, ankiProfile?: string): void {
    openReview(app, { rows, apply, scopeLabel, ankiProfile }, t, openAudit, sourceSyntax)
}

export function openExportRunReport(app: App, report: ExportRunReport, retry: (paths: ReadonlySet<string>) => void,
    t: UiText = englishUi, openAudit?: (deck?: string) => void, sourceSyntax?: DuplicateMarkerSyntax): void {
    openReview(app, { report, retry }, t, openAudit, sourceSyntax)
}

export function openExportRecovery(app: App, rows: readonly ExportRecoveryRow[],
    recheck: (paths: ReadonlySet<string>, profile: string) => void, actions?: ExportRecoveryActions, t: UiText = englishUi): void {
    openReview(app, { recovery: rows, recheck, actions }, t)
}

function exportCounts({ total, confirmed, pending }: Pick<ExportProgress, 'total' | 'confirmed' | 'pending'>, t: UiText): string {
    return t(`${total} files selected · ${confirmed} confirmed · ${pending} pending`,
        `Выбрано файлов · ${total}. Подтверждено · ${confirmed}. Осталось · ${pending}.`)
}

class ExportProgressModal extends Modal {
    private progress: ExportProgress
    private readonly requestStop: () => void
    private stage?: HTMLElement
    private counts?: HTMLElement
    private bar?: HTMLProgressElement
    private stop?: HTMLButtonElement
    private stopping = false

    constructor(app: App, progress: ExportProgress, requestStop: () => void, private readonly t: UiText) {
        super(app)
        this.progress = progress
        this.requestStop = requestStop
    }

    onOpen(): void {
        const { t } = this
        installModalLayout(this, t)
        this.titleEl.setText(t('Anki Export Progress', 'Ход экспорта в Anki'))
        this.stage = this.contentEl.createEl('p', { attr: { role: 'status' } })
        this.bar = this.contentEl.createEl('progress', { attr: { 'aria-label': t('Confirmed files', 'Подтверждённые файлы') } })
        this.bar.style.width = '100%'
        this.counts = this.contentEl.createEl('p')
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.style.flexWrap = 'wrap'
        this.stop = footer.createEl('button', { text: t('Stop After Current Batch', 'Остановить после текущего пакета') })
        this.stop.onclick = () => {
            if (this.stopping) return
            this.stopping = true
            this.update(this.progress)
            this.requestStop()
        }
        this.update(this.progress)
    }

    onClose(): void {
        this.stage = this.counts = this.bar = this.stop = undefined
        this.contentEl.empty()
    }

    update(progress: ExportProgress): void {
        this.progress = progress
        this.stage?.setText(this.stopping ? this.t('Stopping after the current batch is verified.',
            'Экспорт остановится после проверки текущего пакета.') : progress.stage)
        this.counts?.setText(exportCounts(progress, this.t))
        if (this.bar) {
            this.bar.max = Math.max(1, progress.total)
            this.bar.value = progress.confirmed
        }
        if (this.stop) this.stop.disabled = this.stopping
    }
}

export function openExportProgress(app: App, initial: ExportProgress, requestStop: () => void, t: UiText = englishUi): {
    update: (progress: ExportProgress) => void; close: () => void
} {
    const modal = new ExportProgressModal(app, initial, requestStop, t)
    modal.open()
    return { update: progress => modal.update(progress), close: () => modal.close() }
}
