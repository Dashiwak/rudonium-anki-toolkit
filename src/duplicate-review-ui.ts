/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal } from 'obsidian'
import type { App, Editor } from 'obsidian'
import { openObsidianFile } from './obsidian-navigation'
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

export interface DuplicateOccurrence {
    path: string
    id: number
    line: number
    column: number
    preview: string
    front?: string
    back?: string
    options?: string
}

export interface DuplicateConflict {
    id: number
    occurrences: readonly DuplicateOccurrence[]
}

export interface DuplicateReviewResult {
    conflicts: readonly DuplicateConflict[]
    errors: readonly string[]
    checkedFiles: number
}

interface ReviewOptions {
    load: () => Promise<DuplicateReviewResult>
    initialId?: number
    scopeLabel: string
    t?: UiText
}

const fields = [
    { key: 'front', label: ['Question', 'Вопрос'] },
    { key: 'back', label: ['Answer', 'Ответ'] },
    { key: 'options', label: ['Options', 'Параметры'] },
] as const

const reviews = new WeakMap<App, DuplicateReviewModal>()
const selectedIds = new WeakMap<App, Map<string, number>>()

// Один видимый символ может состоять из комбинируемых знаков и связанных эмодзи. В старой среде показываем всё изменившееся поле.
const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new () => { segment: (value: string) => Iterable<{ segment: string }> }
}).Segmenter
const graphemes = Segmenter ? new Segmenter() : undefined

function differingText(left: string, right: string) {
    const split = (value: string) => graphemes ? Array.from(graphemes.segment(value), item => item.segment) : [value]
    const a = split(left)
    const b = split(right)
    const shorter = Math.min(a.length, b.length)
    let start = 0
    while (start < shorter && a[start] === b[start]) start++
    let end = 0
    while (end < shorter - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
    return {
        prefix: a.slice(0, start).join(''),
        changes: [a.slice(start, a.length - end).join(''), b.slice(start, b.length - end).join('')],
        suffix: a.slice(a.length - end).join(''),
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function statusLine(container: HTMLElement, text = ''): HTMLElement {
    return container.createEl('p', { text, attr: { role: 'status', 'aria-live': 'polite' } })
}

/** Проверяем маркер на указанной позиции перед переходом к нему. */
function selectMarker(editor: Editor, occurrence: DuplicateOccurrence, t: UiText): void {
    const line = occurrence.line - 1
    const marker = line >= 0 && line < editor.lineCount()
        ? /^ID:[ \t]*(\d+)/.exec(editor.getLine(line).slice(occurrence.column))
        : null
    if (!marker || Number(marker[1]) !== occurrence.id) {
        throw new Error(t('The ID has moved. Select Recheck for the current line number.',
            'ID переместился. Нажмите «Проверить повторно», чтобы обновить номер строки.'))
    }

    const from = { line, ch: occurrence.column }
    const to = { line, ch: occurrence.column + marker[0].length }
    editor.setSelection(from, to)
    editor.scrollIntoView({ from, to }, true)
}

class DuplicateReviewModal extends Modal {
    private readonly options: ReviewOptions
    private readonly t: UiText
    private closed = false
    private opening = false
    private selected: number | undefined

    constructor(app: App, options: ReviewOptions) {
        super(app)
        this.options = options
        this.t = options.t ?? englishUi
        this.selected = options.initialId ?? selectedIds.get(app)?.get(options.scopeLabel)
    }

    onOpen(): void {
        this.titleEl.setText(this.t('Duplicate Anki IDs', 'Повторяющиеся ID Anki'))
        this.modalEl.classList.add('rudonium-modal-54rem')
        installModalLayout(this, this.t)
        void this.recheck()
    }

    onClose(): void {
        this.closed = true
        if (reviews.get(this.app) === this) reviews.delete(this.app)
        this.contentEl.empty()
    }

    private footer(container: HTMLElement, checking: boolean): void {
        const actions = container.createDiv({ cls: 'modal-button-container' })
        actions.classList.add('rudonium-wrap-controls')
        const recheck = actions.createEl('button', { text: this.t('Recheck', 'Проверить повторно'), cls: 'mod-cta', attr: { type: 'button' } })
        recheck.disabled = checking
        recheck.onclick = () => { if (!this.opening) void this.recheck() }
    }

    private renderScope(): void {
        this.contentEl.empty()
        this.contentEl.createEl('p', { text: this.t(`Scope — ${this.options.scopeLabel}`, `Область проверки — ${this.options.scopeLabel}`) })
    }

    private async recheck(): Promise<void> {
        const previous = this.selected
        this.renderScope()
        statusLine(this.contentEl, this.t('Checking saved Markdown for duplicate IDs…', 'Ищу повторяющиеся ID в сохранённых файлах Markdown…'))
        this.footer(this.contentEl, true)
        try {
            const result = await this.options.load()
            if (!this.closed) this.renderResult(result, previous)
        } catch (error) {
            if (this.closed) return
            this.renderScope()
            const reason = errorMessage(error)
            statusLine(this.contentEl, this.t(`The check could not finish. ${reason}`, `Проверку не удалось завершить. ${reason}`))
            this.footer(this.contentEl, false)
        }
    }

    private renderResult(result: DuplicateReviewResult, previous?: number): void {
        this.renderScope()
        const t = this.t
        const { conflicts, errors, checkedFiles } = result
        const count = conflicts.length
        const files = t(`${checkedFiles} Markdown ${checkedFiles === 1 ? 'file' : 'files'} checked.`, `Проверено файлов Markdown — ${checkedFiles}.`)
        const duplicates = t(`${count} duplicate ${count === 1 ? 'ID' : 'IDs'} found.`, `Найдено повторяющихся ID — ${count}.`)
        statusLine(this.contentEl, `${errors.length ? t('Check incomplete. ', 'Проверка завершилась с ошибками. ') : ''}${files} ${duplicates}`)

        if (previous !== undefined && !conflicts.some(conflict => conflict.id === previous)) {
            this.contentEl.createEl('p', { text: errors.length
                ? t(`ID ${previous} did not appear among the duplicates in the files checked.`,
                    `В проверенных файлах не найдено повторений ID ${previous}.`)
                : t(`ID ${previous} has no duplicate in this scope.`, `В этой области ID ${previous} не повторяется.`) })
        }
        if (errors.length) {
            const details = this.contentEl.createEl('details')
            details.createEl('summary', { text: t(`Check errors (${errors.length})`, `Ошибки проверки (${errors.length})`) })
            const list = details.createEl('ul')
            for (const error of errors) list.createEl('li', { text: error })
        }
        if (count > 0) {
            this.contentEl.createEl('p', {
                text: t('Keep the full card block and its ID in one source note. Replace each duplicate block with a link to that note. To keep a distinct card, remove its copied ID so that the next export can assign a new one. Recheck reads saved Markdown only.',
                    'Сохраните полный блок карточки и её ID в одной заметке. Замените копии блока ссылками на эту заметку. Чтобы оставить отдельную карточку, удалите у неё скопированный ID. При следующем экспорте ей будет назначен новый ID. Повторная проверка читает сохранённые файлы Markdown.'),
            })

            const label = this.contentEl.createEl('label', { text: t('Anki note ID', 'ID записи Anki') })
            const select = label.createEl('select', { cls: 'dropdown' })
            select.classList.add('rudonium-duplicate-review-select')
            for (const conflict of conflicts) {
                select.createEl('option', {
                    text: t(`${conflict.id} · ${conflict.occurrences.length} locations`,
                        `${conflict.id} · найдено мест — ${conflict.occurrences.length}`),
                    value: String(conflict.id),
                })
            }
            const comparison = this.contentEl.createDiv()
            const chosen = conflicts.find(conflict => conflict.id === previous) ?? conflicts[0]
            select.value = String(chosen.id)
            const show = (conflict: DuplicateConflict) => {
                this.selected = conflict.id
                const remembered = selectedIds.get(this.app) ?? new Map<string, number>()
                remembered.set(this.options.scopeLabel, conflict.id)
                selectedIds.set(this.app, remembered)
                this.renderConflict(comparison, conflict)
            }
            select.onchange = () => {
                const conflict = conflicts.find(item => String(item.id) === select.value)
                if (conflict) show(conflict)
            }
            show(chosen)
        }
        this.footer(this.contentEl, false)
    }

    private renderConflict(container: HTMLElement, { occurrences }: DuplicateConflict): void {
        container.empty()
        const t = this.t
        const parsed = occurrences.filter(entry => entry.front !== undefined && entry.back !== undefined)
        const differences = new Set(fields.filter(({ key }) =>
            new Set(parsed.map(entry => entry[key] ?? '')).size > 1,
        ).map(({ key }) => key))
        const exactDiffs = new Map(parsed.length === 2 ? fields.filter(({ key }) => differences.has(key)).map(({ key }) =>
            [key, differingText(parsed[0][key] ?? '', parsed[1][key] ?? '')] as const) : [])
        const showOptions = parsed.some(entry => Boolean(entry.options))
        if (parsed.length > 1 && parsed.length === occurrences.length && differences.size === 0) {
            container.createEl('p', { text: t('The displayed fields match.', 'Показанные поля совпадают.') })
        }
        const grid = container.createDiv()
        grid.classList.add('rudonium-duplicate-review-grid')

        const navigationStatus = statusLine(container)

        for (const occurrence of occurrences) {
            const card = grid.createEl('section')
            card.classList.add('rudonium-duplicate-review-card')
            const heading = card.createEl('h3', { text: occurrence.path })
            heading.classList.add('rudonium-duplicate-review-heading')
            card.createEl('div', { text: t(`Line ${occurrence.line}`, `Строка ${occurrence.line}`), cls: 'setting-item-description' })

            if (occurrence.front === undefined || occurrence.back === undefined) {
                this.renderPreview(card, occurrence.preview)
            } else {
                const list = card.createEl('dl')
                for (const { key, label: [en, ru] } of fields) {
                    if (key === 'options' && !showOptions) continue
                    const changed = differences.has(key)
                    const label = t(en, ru)
                    const term = list.createEl('dt')
                    term.createEl('strong', { text: changed ? t(`${label} · Differs`, `${label} · отличается`) : label })
                    const description = list.createEl('dd')
                    description.classList.add('rudonium-duplicate-review-description')
                    const diff = exactDiffs.get(key)
                    if (diff) {
                        const changedText = diff.changes[parsed.indexOf(occurrence)]
                        description.createSpan({ text: diff.prefix })
                        const noText = t('No text at this position', 'Здесь нет текста')
                        description.createEl('mark', changedText ? { text: changedText } : {
                            text: '∅', title: noText, attr: { 'aria-label': noText },
                        })
                        description.createSpan({ text: diff.suffix })
                    } else {
                        description.setText(occurrence[key] ?? t('None', 'Нет значения'))
                    }
                    if (changed) {
                        description.classList.add('rudonium-duplicate-highlight')
                    }
                }
                const details = card.createEl('details')
                details.createEl('summary', { text: t('Show Markdown', 'Показать Markdown') })
                this.renderPreview(details, occurrence.preview, false)
            }

            const open = card.createEl('button', { text: t('Open at line', 'Перейти к строке'), attr: {
                type: 'button', 'aria-label': t(`Open ${occurrence.path} at line ${occurrence.line}`,
                    `Открыть ${occurrence.path} на строке ${occurrence.line}`),
            } })
            open.classList.add('rudonium-duplicate-review-open')
            open.onclick = async () => {
                if (this.opening) return
                this.opening = true
                open.disabled = true
                navigationStatus.setText(t('Opening the Markdown source…', 'Открываю исходную заметку…'))
                try {
                    await openObsidianFile(this.app, occurrence.path, { modal: this, isClosed: () => this.closed },
                        editor => selectMarker(editor, occurrence, t))
                } catch (error) {
                    if (!this.closed) navigationStatus.setText(errorMessage(error))
                } finally {
                    this.opening = false
                    open.disabled = false
                }
            }
        }
    }

    private renderPreview(container: HTMLElement, value: string, label = true): void {
        if (label) container.createEl('strong', { text: 'Markdown' })
        const preview = container.createEl('pre', { text: value || this.t(
            'The Markdown preview is unavailable. Recheck the note.', 'Предпросмотр Markdown недоступен. Проверьте заметку повторно.') })
        preview.classList.add('rudonium-wrapped-text')
    }
}

export function openDuplicateReview(app: App, options: ReviewOptions): void {
    reviews.get(app)?.close()
    const review = new DuplicateReviewModal(app, options)
    reviews.set(app, review)
    review.open()
}
