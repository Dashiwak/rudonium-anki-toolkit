/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import type { App } from 'obsidian'
import * as AnkiConnect from './anki'
import { readActiveAnkiProfile } from './anki-profile'
import { openObsidianFile, ReviewModal } from './obsidian-navigation'
import type { NavigationOrigin } from './obsidian-navigation'
import type { SyncAuditAnkiProfile, SyncAuditDifference, SyncAuditSource } from './sync-audit'
import { describeDeckRoute } from './deck-routes'
import { englishUi, uiDiagnostic } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

type NavigationSource = Pick<SyncAuditSource, 'path' | 'line' | 'endLine' | 'markerLine'> & {
    id?: number; startColumn?: number; endColumn?: number
}
type FieldDifference = SyncAuditDifference['fields'][number]

const openReviews = new WeakMap<App, SyncDifferenceModal>()
const blockTags = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'blockquote', 'pre', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const maxDiffCells = 200_000
const browseTimeoutMs = 10_000

const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new () => { segment: (value: string) => Iterable<{ segment: string }> }
}).Segmenter
const graphemes = Segmenter ? new Segmenter() : undefined

/** Декодирует сущности после удаления разметки, чтобы даже отдельный документ не ссылался на внешние ресурсы. */
function fieldText(value: string): string {
    const source = value
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/?([a-z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
            (_tag, name: string) => blockTags.has(name.toLowerCase()) ? '\n' : '')
        .replace(/</g, '&lt;')
    return (new DOMParser().parseFromString(source, 'text/html').body.textContent ?? '')
        .replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

type DiffChunk = { shared: string } | { changes: [string, string] }

function changedChunks(left: string[], right: string[]): DiffChunk[] {
    const columns = right.length + 1
    if (!left.length || !right.length || (left.length + 1) * columns > maxDiffCells) {
        return [{ changes: [left.join(''), right.join('')] }]
    }
    const scores = new Uint16Array((left.length + 1) * columns)
    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            scores[i * columns + j] = left[i] === right[j]
                ? 1 + scores[(i + 1) * columns + j + 1]
                : Math.max(scores[(i + 1) * columns + j], scores[i * columns + j + 1])
        }
    }
    const chunks: DiffChunk[] = []
    let i = 0, j = 0
    const equal = () => i < left.length && j < right.length && left[i] === right[j]
    while (i < left.length || j < right.length) {
        const startLeft = i, startRight = j
        if (equal()) {
            do { i++; j++ } while (equal())
            chunks.push({ shared: left.slice(startLeft, i).join('') })
        } else {
            do {
                if (j === right.length || (i < left.length && scores[(i + 1) * columns + j] >= scores[i * columns + j + 1])) i++
                else j++
            } while ((i < left.length || j < right.length) && !equal())
            chunks.push({ changes: [left.slice(startLeft, i).join(''), right.slice(startRight, j).join('')] })
        }
    }
    return chunks
}

function splitField(left: string, right: string): DiffChunk[] {
    const split = (value: string) => graphemes ? Array.from(graphemes.segment(value), item => item.segment) : [value]
    const a = split(left)
    const b = split(right)
    const shorter = Math.min(a.length, b.length)
    let start = 0
    while (start < shorter && a[start] === b[start]) start++
    let end = 0
    while (end < shorter - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
    return [
        { shared: a.slice(0, start).join('') },
        ...changedChunks(a.slice(start, a.length - end), b.slice(start, b.length - end)),
        { shared: a.slice(a.length - end).join('') },
    ]
}

function location(source: NavigationSource, t: UiText): string {
    if (source.line === undefined) return source.path
    const end = source.endLine ?? source.markerLine ?? source.line
    return end > source.line
        ? t(`${source.path} · lines ${source.line}–${end}`, `${source.path} · строки ${source.line}–${end}`)
        : t(`${source.path} · line ${source.line}`, `${source.path} · строка ${source.line}`)
}

/** Открывает существующий исходник и выделяет проверенный диапазон ID. Сообщает об ошибке, если позиция устарела. */
export function openAuditSource(app: App, source: NavigationSource, origin?: NavigationOrigin, t: UiText = englishUi): Promise<void> {
    return openObsidianFile(app, source.path, origin, editor => {
        const first = source.line ?? source.markerLine
        if (first === undefined) return
        const last = Math.max(source.endLine ?? first, source.markerLine ?? first)
        const inFile = (line: number) => Number.isInteger(line) && line >= 1 && line <= editor.lineCount()
        if (!inFile(first) || !inFile(last) || last < first) {
            throw new Error(t('The audited lines have moved. Recheck for the current source location.',
                'Строки переместились. Проверьте заметку повторно, чтобы найти их.'))
        }
        if (source.id !== undefined) {
            const markerStart = source.markerLine ?? first
            const markerEnd = source.markerLine ?? last
            let found = false
            for (let line = markerStart; line <= markerEnd && inFile(line) && !found; line++) {
                found = Array.from(editor.getLine(line - 1).matchAll(/\bID:[ \t]*(\d+)(?!\d|[.,]\d|[eE][+-]?\d)/g))
                    .some(marker => Number(marker[1]) === source.id)
            }
            if (!found || markerStart < first || markerEnd > last) {
                throw new Error(t(`Anki ID ${source.id} has moved. Recheck for the current source location.`,
                    `ID Anki ${source.id} переместился. Проверьте заметку повторно, чтобы найти его.`))
            }
        }
        const firstColumn = source.startColumn ?? 0
        const lastColumn = source.endColumn ?? editor.getLine(last - 1).length
        const inLine = (line: number, column: number) => Number.isInteger(column) && column >= 0 && column <= editor.getLine(line - 1).length
        if (!inLine(first, firstColumn) || !inLine(last, lastColumn) || first === last && firstColumn > lastColumn) {
            throw new Error(t('The audited block has moved. Recheck for the current source location.',
                'Блок карточки переместился. Повторите проверку, чтобы найти его.'))
        }
        const from = { line: first - 1, ch: firstColumn }
        const to = { line: last - 1, ch: lastColumn }
        editor.setSelection(from, to)
        editor.scrollIntoView({ from, to }, true)
    })
}

/** Вызывается только при явном действии «Открыть в Anki». */
export async function openAuditAnkiNote(id: number, auditProfile?: SyncAuditAnkiProfile, t: UiText = englishUi): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(t('This Anki note ID is invalid.', 'Некорректный ID записи Anki.'))
    if (auditProfile) {
        // В другом профиле тот же числовой ID может относиться к другой записи.
        if (!('active' in auditProfile)) throw new Error(t('The audit could not confirm the Anki profile. Recheck before opening the note.',
            'При проверке не удалось подтвердить профиль Anki. Повторите проверку перед открытием записи.'))
        if (await readActiveAnkiProfile() !== auditProfile.active) {
            throw new Error(t('The Anki profile changed since the audit. Recheck before opening the note.',
                'После проверки профиль Anki изменился. Повторите проверку перед открытием записи.'))
        }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const response = await Promise.race([
            AnkiConnect.invoke('guiBrowse', { query: `nid:${id}` }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(t('AnkiConnect did not reply in time.', 'AnkiConnect не ответил вовремя.'))), browseTimeoutMs)
            }),
        ])
        if (!Array.isArray(response)) throw new Error(t('Anki Browse did not return a card list.', 'Обозреватель Anki не вернул список карточек.'))
    } catch (error) {
        const reason = uiDiagnostic(error, t)
        throw new Error(t(`Could not open Anki Browse. Search for nid:${id} in Anki. ${reason}`,
            `Не удалось открыть обозреватель Anki. Найдите запись вручную по запросу nid:${id}. ${reason}`))
    } finally {
        clearTimeout(timer)
    }
}

/** Для читаемого предпросмотра и исходного форматированного текста используем текстовые узлы DOM. */
function renderPair(container: HTMLElement, expected: string, actual: string | undefined, t: UiText): void {
    const pair = container.createDiv()
    pair.classList.add('rudonium-sync-difference-pair')
    const difference = actual !== undefined && expected !== actual ? splitField(expected, actual) : undefined
    const panes = [t('Obsidian export value', 'Значение из Obsidian'), t('Anki stored value', 'Значение в Anki')]
    for (const [index, value] of [expected, actual].entries()) {
        const pane = pair.createDiv()
        pane.classList.add('rudonium-sync-difference-pane')
        pane.createEl('strong', { text: panes[index] })
        const text = pane.createEl('div')
        text.classList.add('rudonium-sync-difference-text')
        if (difference) {
            for (const chunk of difference) {
                if ('shared' in chunk) {
                    if (chunk.shared) text.createSpan({ text: chunk.shared })
                } else {
                    const changed = chunk.changes[index]
                    const noText = t('No text at this position', 'Здесь нет текста')
                    text.createEl('mark', changed ? { text: changed } : {
                        text: '∅', title: noText, attr: { 'aria-label': noText },
                    })
                }
            }
        } else {
            text.setText(value === undefined ? t('Field missing', 'Поле отсутствует') : value || t('Empty field', 'Пустое поле'))
        }
    }
}

function renderField(container: HTMLElement, field: FieldDifference, t: UiText): void {
    const section = container.createEl('section')
    section.createEl('h3', { text: field.name })
    const expected = fieldText(field.expected)
    const actual = field.actual === undefined ? undefined : fieldText(field.actual)
    const previewMatches = expected === actual && field.expected !== field.actual
    if (previewMatches) section.createEl('p', { text: t('Text previews match. The formatted source differs.',
        'Текст совпадает, форматирование отличается.') })
    renderPair(section, expected, actual, t)
    if (expected !== field.expected || actual !== field.actual || previewMatches) {
        const raw = section.createEl('details')
        raw.createEl('summary', { text: t('Compare formatted source (HTML)', 'Сравнить исходное форматирование (HTML)') })
        raw.open = previewMatches
        if (previewMatches) {
            renderPair(raw, field.expected, field.actual, t)
        } else {
            raw.ontoggle = () => {
                if (!raw.open) return
                raw.ontoggle = null
                renderPair(raw, field.expected, field.actual, t)
            }
        }
    }
}

class SyncDifferenceModal extends ReviewModal {
    private readonly differences: readonly SyncAuditDifference[]
    private readonly recheck: () => void
    private readonly initialId: number | undefined
    private readonly backToReport: (() => void) | undefined
    private readonly auditProfile: SyncAuditAnkiProfile | undefined
    private selector?: HTMLSelectElement
    private closed = false
    private busy = false

    constructor(app: App, differences: readonly SyncAuditDifference[], recheck: () => void, initialId?: number,
        backToReport?: () => void, auditProfile?: SyncAuditAnkiProfile, private readonly t: UiText = englishUi) {
        super(app)
        this.differences = differences
        this.recheck = recheck
        this.initialId = initialId
        this.backToReport = backToReport
        this.auditProfile = auditProfile
    }

    onOpen(): void {
        const t = this.t
        this.titleEl.setText(t('Compare Obsidian and Anki', 'Сравнение Obsidian и Anki'))
        this.modalEl.classList.add('rudonium-modal-56rem')
        installModalLayout(this, t)
        if (this.differences.length) {
            const label = this.contentEl.createEl('label', { text: t('Anki note', 'Запись Anki') })
            const select = label.createEl('select', { cls: 'dropdown' })
            this.selector = select
            select.classList.add('rudonium-sync-difference-select')
            for (const note of this.differences) {
                select.createEl('option', { text: `${note.id} · ${note.path}`, value: String(note.id) })
            }
            const selected = this.differences.find(note => note.id === this.initialId) ?? this.differences[0]
            const comparison = this.contentEl.createDiv()
            select.value = String(selected.id)
            select.onchange = () => {
                const note = this.differences.find(item => String(item.id) === select.value)
                if (note) this.show(comparison, note)
            }
            this.show(comparison, selected)
        } else {
            this.contentEl.createEl('p', { text: t('No differences appear in these audit results.', 'При проверке не найдено различий.') })
        }
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        footer.createEl('button', { text: t('Recheck', 'Проверить повторно'), cls: 'mod-cta' }).onclick = () => {
            if (this.busy) return
            this.close()
            this.recheck()
        }
        const back = this.backToReport
        if (back) footer.createEl('button', { text: t('Back to Report', 'К отчёту') }).onclick = () => {
            if (this.busy) return
            this.close()
            back()
        }
    }

    protected releaseReview(): void {
        this.closed = true
        if (openReviews.get(this.app) === this) openReviews.delete(this.app)
        this.contentEl.empty()
    }

    private show(container: HTMLElement, note: SyncAuditDifference): void {
        container.empty()
        const t = this.t
        container.createEl('p', { text: location(note, t) }).classList.add('rudonium-wrap-anywhere')
        const actions = container.createDiv()
        actions.classList.add('rudonium-sync-difference-actions')
        const openSource = actions.createEl('button', { text: t('Open in Obsidian', 'Открыть в Obsidian') })
        const openAnki = actions.createEl('button', { text: t('Open in Anki', 'Открыть в Anki') })
        const status = container.createEl('p', { attr: { role: 'status' } })
        const run = async (operation: () => Promise<void>, source: boolean) => {
            if (this.busy) return
            this.busy = true
            if (this.selector) this.selector.disabled = true
            openSource.disabled = openAnki.disabled = true
            status.setText(source ? t('Opening Markdown source…', 'Открываю исходную заметку…')
                : t('Opening Anki Browse…', 'Открываю обозреватель Anki…'))
            try {
                await operation()
                if (this.closed) return
                if (!source) status.setText(t(`Anki Browse opened for nid:${note.id}.`, `В Anki открыт результат поиска nid:${note.id}.`))
            } catch (error) {
                if (!this.closed) status.setText(error instanceof Error ? error.message : String(error))
            } finally {
                this.busy = false
                if (this.selector) this.selector.disabled = false
                openSource.disabled = openAnki.disabled = false
            }
        }
        openSource.onclick = () => run(() => openAuditSource(this.app, note, { modal: this, isClosed: () => this.closed }, t), true)
        openAnki.onclick = () => run(() => openAuditAnkiNote(note.id, this.auditProfile, t), false)

        if (!note.complete) container.createEl('p', { text: t('Some comparison data is unavailable.', 'Часть данных для сравнения недоступна.') })
        if (note.fields.length) for (const field of note.fields) renderField(container, field, t)
        else container.createEl('p', { text: t('No field differences were found for this note.', 'В полях записи не найдено различий.') })
        if (note.model || note.missingTags.length || note.extraTags.length || note.decks.length) {
            container.createEl('h3', { text: t('Other differences', 'Другие различия') })
            const details = container.createEl('ul')
            if (note.model) details.createEl('li', { text: t(`Note type · Obsidian — ${note.model.expected} · Anki — ${note.model.actual}`,
                `Тип записи · Obsidian — ${note.model.expected} · Anki — ${note.model.actual}`) })
            if (note.missingTags.length) details.createEl('li', { text: t(`Obsidian tags only — ${note.missingTags.join(', ')}`,
                `Теги только в Obsidian — ${note.missingTags.join(', ')}`) })
            if (note.extraTags.length) details.createEl('li', { text: t(`Anki tags only — ${note.extraTags.join(', ')}`,
                `Теги только в Anki — ${note.extraTags.join(', ')}`) })
            if (note.decks.length && note.deckRoute) {
                details.createEl('li', { text: describeDeckRoute(note.deckRoute, t) })
            }
            for (const deck of note.decks) {
                details.createEl('li', { text: t(`Card ${deck.cardId} · Obsidian deck — ${deck.expected} · Anki deck — ${deck.actual}`,
                    `Карточка ${deck.cardId} · колода в Obsidian — ${deck.expected} · колода в Anki — ${deck.actual}`) })
            }
        }
    }
}

export function openSyncDifferenceReview(app: App, differences: readonly SyncAuditDifference[], recheck: () => void,
    initialId?: number, backToReport?: () => void, auditProfile?: SyncAuditAnkiProfile, t: UiText = englishUi): void {
    openReviews.get(app)?.close()
    const modal = new SyncDifferenceModal(app, differences, recheck, initialId, backToReport, auditProfile, t)
    openReviews.set(app, modal)
    modal.open()
}
