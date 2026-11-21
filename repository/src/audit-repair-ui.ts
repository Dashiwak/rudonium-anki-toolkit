/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Notice, setIcon } from 'obsidian'
import type MyPlugin from '../main'
import { searchAuditRepairMatches } from './audit-repair-match'
import type { AuditRepairCandidate, AuditRepairRow, AuditRepairSearch } from './audit-repair-match'
import { applyAuditRepairs, finishAuditRepairUnlink, readPendingAuditRepairs } from './audit-repair-apply'
import type { AuditRepairSelection } from './audit-repair-apply'
import type { SyncAuditResult } from './sync-audit'
import { openAuditAnkiNote, openAuditSource } from './sync-difference-ui'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { ReviewModal } from './obsidian-navigation'
import { installModalLayout } from './modal-layout'
import { sameFieldValue } from './anki-field-value'
import { AnkiProfileError, profileProblemText } from './anki-profile'

const pageSize = 30
const actions = ['replace-id', 'delete-anki', 'delete-obsidian'] as const
type AuditRepairAction = typeof actions[number]
type RepairResults = Awaited<ReturnType<typeof applyAuditRepairs>>
type PendingRepairs = Awaited<ReturnType<typeof readPendingAuditRepairs>>

function actionLabel(action: AuditRepairAction, t: UiText): string {
    switch (action) {
        case 'replace-id': return t('Replace ID in Obsidian', 'Заменить ID в Obsidian')
        case 'delete-anki': return t('Delete Card in Anki', 'Удалить карточку в Anki')
        case 'delete-obsidian': return t('Delete Card in Obsidian', 'Удалить карточку в Obsidian')
    }
}

function actionDescription(action: AuditRepairAction, t: UiText): string {
    switch (action) {
        case 'replace-id': return t('Writes the selected Anki note ID into the source. The Anki note and its review history are kept.',
            'Подставляет ID выбранной записи Anki в исходный блок Obsidian. Запись Anki и история повторений сохраняются.')
        case 'delete-anki': return t('Deletes the selected Anki note, its cards and their study progress, then removes the obsolete ID from Obsidian. The next normal export can create a new note.',
            'Удаляет выбранную запись Anki, все её карточки и историю повторений. Затем убирает старый ID из Obsidian. При следующем экспорте можно создать новую запись.')
        case 'delete-obsidian': return t('Removes the audited card block, including its ID marker, from the Markdown file. Records in Anki are kept.',
            'Удаляет проверенный блок карточки вместе со строкой ID из файла Markdown. Записи в Anki сохраняются.')
    }
}

/** Убираем разметку до декодирования сущностей, чтобы предпросмотр не загружал ресурсы из Anki. */
function fieldText(value: string): string {
    const source = value.replace(/<!--[^]*?-->/g, '')
        .replace(/<(script|style|template)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
        .replace(/<\/?([a-z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
            (_tag, name: string) => /^(br|p|div|li|tr|h[1-6])$/i.test(name) ? '\n' : '')
        .replace(/</g, '&lt;')
    return (new DOMParser().parseFromString(source, 'text/html').body.textContent ?? '').trim()
}

function fieldExcerpt(value: string): string {
    const plain = (fieldText(value) || value).replace(/\s+/g, ' ')
    return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain
}

function differentFields(local: Readonly<Record<string, string>>, remote: Readonly<Record<string, string>>): string[] {
    const names = new Set([...Object.keys(local), ...Object.keys(remote)])
    return [...names].filter(name => !(name in local) || !sameFieldValue(remote[name], local[name]))
}

function displayDiagnostic(error: unknown, t: UiText): string {
    return error instanceof AnkiProfileError ? profileProblemText(error, t) : uiDiagnostic(error, t)
}

function location(row: AuditRepairRow, t: UiText): string {
    if (!row.source) return ''
    const { path, line } = row.source
    return t(`${path} · line ${line}`, `${path} · строка ${line}`)
}

class AuditRepairModal extends ReviewModal {
    private readonly t: UiText
    private readonly abort = new AbortController()
    private readonly selected = new Set<number>()
    private readonly candidates = new Map<number, number | null>()
    private readonly focusTargets = new Map<string, HTMLElement>()
    private data?: AuditRepairSearch
    private pending: PendingRepairs = []
    private selectedRow?: number
    private tableViewport?: HTMLElement
    private batch = false
    private page = 0
    private busy = false

    constructor(private readonly plugin: MyPlugin, private readonly result: SyncAuditResult,
        private readonly recheck: () => void, private readonly initialId?: number) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.modalEl.style.width = 'min(62rem, calc(100vw - 2rem))'
        installModalLayout(this, this.t)
        this.titleEl.setText(this.t('Repair Sync Audit Findings', 'Исправить расхождения Obsidian и Anki'))
        void this.load()
    }

    protected releaseReview(): void {
        this.abort.abort()
        this.contentEl.empty()
    }

    private titleLine(): void {
        const t = this.t
        const profile = this.result.ankiProfile
        const desc = profile && 'active' in profile ? t(`Deck ${this.result.deck} · Profile ${profile.active}`,
            `Колода «${this.result.deck}» · Профиль «${profile.active}»`) : this.result.deck
        this.contentEl.createEl('p', { text: desc }).style.overflowWrap = 'anywhere'
    }

    private buttons(parent: HTMLElement = this.contentEl): HTMLElement {
        const group = parent.createDiv({ cls: 'modal-button-container' })
        Object.assign(group.style, { flexWrap: 'wrap', gap: '0.4em' })
        return group
    }

    private notice(error: unknown): void {
        if (!this.abort.signal.aborted) new Notice(displayDiagnostic(error, this.t))
    }

    private goToAudit(): void {
        this.close()
        this.recheck()
    }

    private addRecheck(parent: HTMLElement): void {
        parent.createEl('button', { text: this.t('Recheck Deck', 'Провести аудит повторно') }).onclick = () => this.goToAudit()
    }

    private async load(): Promise<void> {
        const t = this.t
        if (this.busy || this.abort.signal.aborted) return
        this.busy = true
        this.contentEl.empty()
        this.titleLine()
        const status = this.contentEl.createEl('p', { text: t('Finding records by the first field…', 'Ищу записи Anki по первому полю…'),
            attr: { role: 'status' } })
        try {
            const profile = this.result.ankiProfile
            const [search, pending] = await Promise.allSettled([
                searchAuditRepairMatches(this.plugin, this.result, { signal: this.abort.signal, onProgress: (done, total) => {
                    status.setText(t(`Finding records by the first field… ${done} of ${total}`, `Ищу записи Anki по первому полю… ${done} из ${total}`))
                } }),
                profile && 'active' in profile ? readPendingAuditRepairs(this.plugin, profile.active) : Promise.resolve([]),
            ])
            if (this.abort.signal.aborted) return
            this.pending = pending.status === 'fulfilled' ? pending.value : []
            if (search.status === 'rejected') {
                this.data = undefined
                this.render(displayDiagnostic(search.reason, t))
                return
            }
            this.data = search.value
            const liveRows = new Map(this.data.rows.map(row => [row.id, row]))
            for (const id of this.selected) if (!liveRows.get(id)?.source) this.selected.delete(id)
            this.candidates.clear()
            if (this.selectedRow === undefined || !liveRows.has(this.selectedRow)) {
                this.selectedRow = this.data.rows.find(row => row.id === this.initialId)?.id ?? this.data.rows[0]?.id
                this.page = Math.max(0, Math.floor(this.data.rows.findIndex(row => row.id === this.selectedRow) / pageSize))
            }
            this.render(pending.status === 'rejected' ? displayDiagnostic(pending.reason, t) : undefined,
                this.selectedRow === undefined ? undefined : `row-${this.selectedRow}`)
        } catch (error) {
            if (!this.abort.signal.aborted) status.setText(displayDiagnostic(error, t))
        } finally {
            this.busy = false
        }
    }

    private chooseCandidate(row: AuditRepairRow): AuditRepairCandidate | undefined {
        const explicit = this.candidates.get(row.id)
        if (explicit !== undefined) return row.candidates.find(candidate => candidate.id === explicit)
        const only = row.candidates.length === 1 ? row.candidates[0] : undefined
        const source = row.source
        if (!only?.eligible || !source) return undefined
        const sourceNames = Object.keys(source.fields)
        // Подставляем единственный вариант автоматически только при совпадении всех полей.
        return sourceNames.length && source.modelName === only.modelName && sourceNames.length === Object.keys(only.fields).length &&
            sourceNames.every(name => sameFieldValue(only.fields[name], source.fields[name])) ? only : undefined
    }

    private render(error?: string, focus?: string): void {
        const t = this.t
        this.focusTargets.clear()
        this.contentEl.empty()
        this.titleLine()
        if (error) this.contentEl.createEl('p', { text: error, attr: { role: 'alert' } }).style.color = 'var(--text-error)'
        const rows = this.data?.rows ?? []
        if (rows.length) {
            const index = Math.max(0, rows.findIndex(row => row.id === this.selectedRow))
            const row = rows[index]
            this.selectedRow = row.id
            if (rows.length > 1) this.recordNavigation(rows, index)
            if (this.batch) this.table(rows)
            this.detail(row)
            this.actionFooter(this.batch ? rows : [row])
        } else if (!error) this.contentEl.createEl('p', { text: t('There are no missing-ID records to repair in this audit.',
            'В этой проверке нет записей с отсутствующими ID для исправления.') })
        this.showPending()
        const tools = this.contentEl.createEl('details')
        tools.createEl('summary', { text: t('Recheck records', 'Повторная проверка') })
        tools.open = !!error
        const footer = this.buttons(tools)
        footer.createEl('button', { text: t('Refresh First-field Search', 'Обновить поиск по первому полю') }).onclick = () => { void this.load() }
        this.addRecheck(footer)
        if (focus) this.focusTargets.get(focus)?.focus()
    }

    private recordNavigation(rows: readonly AuditRepairRow[], index: number): void {
        const t = this.t
        const bar = this.contentEl.createDiv()
        Object.assign(bar.style, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5em' })
        if (!this.batch) {
            const step = (label: string, position: number) => {
                const button = bar.createEl('button', { text: label })
                button.disabled = position < 0 || position >= rows.length
                button.onclick = () => {
                    this.selectedRow = rows[position].id
                    this.page = Math.floor(position / pageSize)
                    this.render(undefined, 'record')
                }
            }
            step(t('Previous', 'Назад'), index - 1)
            bar.createSpan({ text: t(`Record ${index + 1} of ${rows.length}`, `Запись ${index + 1} из ${rows.length}`) })
            step(t('Next', 'Дальше'), index + 1)
        }
        const toggle = bar.createEl('button', { text: this.batch ? t('Review one record', 'По одной записи')
            : t('Select multiple', 'Выбрать несколько'), attr: { 'aria-pressed': String(this.batch) } })
        this.focusTargets.set('mode', toggle)
        toggle.onclick = () => {
            this.batch = !this.batch
            this.selected.clear()
            if (this.batch && rows[index].source) this.selected.add(rows[index].id)
            this.page = Math.floor(index / pageSize)
            this.render(undefined, 'mode')
        }
    }

    private table(rows: readonly AuditRepairRow[]): void {
        const t = this.t
        const bar = this.contentEl.createDiv()
        Object.assign(bar.style, { display: 'flex', flexWrap: 'wrap', gap: '0.7em', alignItems: 'center' })
        const allLabel = bar.createEl('label', { text: t('Select All Records', 'Выбрать все записи') })
        const all = allLabel.createEl('input', { attr: { type: 'checkbox', 'aria-label': t('Select All Records', 'Выбрать все записи') } })
        this.focusTargets.set('all', all)
        const available = rows.filter(row => row.source)
        all.disabled = !available.length
        all.checked = available.length > 0 && available.every(row => this.selected.has(row.id))
        all.indeterminate = !all.checked && available.some(row => this.selected.has(row.id))
        all.onchange = () => {
            this.selected.clear()
            if (all.checked) for (const row of available) this.selected.add(row.id)
            this.render(undefined, 'all')
        }
        bar.createSpan({ text: t(`${this.selected.size} selected · ${rows.length} total`, `Выбрано ${this.selected.size} из ${rows.length}`),
            attr: { role: 'status' } })
        const pages = Math.ceil(rows.length / pageSize)
        this.page = Math.min(this.page, pages - 1)
        if (pages > 1) {
            const previous = bar.createEl('button', { text: t('Previous Page', 'Предыдущая страница') })
            previous.disabled = this.page === 0
            if (!previous.disabled) this.focusTargets.set('previous', previous)
            previous.onclick = () => { this.changePage(rows, this.page - 1, this.page === 1 ? 'next' : 'previous') }
            bar.createSpan({ text: t(`Page ${this.page + 1} of ${pages}`, `Страница ${this.page + 1} из ${pages}`) })
            const next = bar.createEl('button', { text: t('Next Page', 'Следующая страница') })
            next.disabled = this.page + 1 === pages
            if (!next.disabled) this.focusTargets.set('next', next)
            next.onclick = () => { this.changePage(rows, this.page + 1, this.page + 2 === pages ? 'previous' : 'next') }
        }
        const scroll = this.tableViewport?.scrollTop ?? 0
        const viewport = this.contentEl.createDiv()
        this.tableViewport = viewport
        Object.assign(viewport.style, { maxHeight: 'min(32vh, 18rem)', overflow: 'auto', marginBlock: '0.5em' })
        const table = viewport.createEl('table', { attr: { 'aria-label': t('Missing ID records', 'Записи с отсутствующими ID') } })
        table.style.width = '100%'
        const caption = table.createEl('thead').createEl('tr')
        for (const label of [t('Select', 'Выбор'), 'Obsidian', 'Anki']) caption.createEl('th', { text: label, attr: { scope: 'col' } })
        const body = table.createEl('tbody')
        for (const row of rows.slice(this.page * pageSize, (this.page + 1) * pageSize)) {
            const active = row.id === this.selectedRow
            const line = body.createEl('tr')
            if (active) line.style.backgroundColor = 'var(--background-modifier-hover)'
            const label = t(`Select note ID ${row.id}`, `Выбрать запись ID ${row.id}`)
            const selection = line.createEl('td').createEl('input', { attr: { type: 'checkbox', 'aria-label': label } })
            this.focusTargets.set(`select-${row.id}`, selection)
            selection.checked = this.selected.has(row.id)
            selection.disabled = !row.source
            selection.onchange = () => {
                if (selection.checked) this.selected.add(row.id)
                else this.selected.delete(row.id)
                this.selectedRow = row.id
                this.render(undefined, `select-${row.id}`)
            }
            const name = line.createEl('td')
            const details = name.createEl('button', { text: `ID ${row.id}`, title: t('Compare Fields', 'Сравнить поля'),
                attr: { 'aria-pressed': String(active) } })
            this.focusTargets.set(`row-${row.id}`, details)
            details.onclick = () => { this.selectedRow = row.id; this.render(undefined, `row-${row.id}`) }
            if (row.source) {
                if (row.source.firstField) name.createDiv({ text: fieldExcerpt(row.source.firstField) }).style.overflowWrap = 'anywhere'
            } else if (row.issue) name.createDiv({ text: row.issue }).style.overflowWrap = 'anywhere'
            const candidate = this.chooseCandidate(row)
            const cell = line.createEl('td')
            if (candidate) cell.setText(`ID ${candidate.id}`)
            else cell.setText(row.candidates.length
                ? t(`${row.candidates.length} candidates`, `Кандидатов · ${row.candidates.length}`) : t('No match', 'Совпадений нет'))
        }
        viewport.scrollTop = scroll
    }

    private changePage(rows: readonly AuditRepairRow[], page: number, focus: string): void {
        this.page = page
        this.selectedRow = rows[page * pageSize]?.id
        if (this.tableViewport) this.tableViewport.scrollTop = 0
        this.render(undefined, focus)
    }

    private detail(row: AuditRepairRow): void {
        const t = this.t
        const details = this.contentEl.createEl('section')
        const heading = details.createEl('h3', { text: `ID ${row.id}`, attr: { tabindex: '-1' } })
        this.focusTargets.set('record', heading)
        this.focusTargets.set(`row-${row.id}`, this.focusTargets.get(`row-${row.id}`) ?? heading)
        if (row.source) details.createEl('small', { text: location(row, t) }).style.overflowWrap = 'anywhere'
        if (row.source?.wholePage) details.createEl('p', { text: t('This card uses the whole page. Edit its text in Obsidian.',
            'Карточка занимает всю страницу. Изменить её текст можно в Obsidian.') })
        if (row.issue) details.createEl('p', { text: row.issue, attr: { role: 'status' } }).style.overflowWrap = 'anywhere'
        const controls = this.buttons(details)
        const sourceButton = controls.createEl('button', { text: t('Show Record in Obsidian', 'Показать запись в Obsidian') })
        const source = row.source
        const original = this.result.obsidianOnly.find(group => group.id === row.id)?.occurrences[0]
        sourceButton.disabled = !source && !original
        sourceButton.onclick = async () => {
            const location = source ?? original
            if (!location) return
            sourceButton.disabled = true
            try {
                await openAuditSource(this.app, location, { modal: this, isClosed: () => this.abort.signal.aborted }, t)
            } catch (error) { this.notice(error) }
            finally { sourceButton.disabled = false }
        }
        const chosen = this.chooseCandidate(row)
        if (chosen) {
            const ankiButton = controls.createEl('button', { text: t('Show Record in Anki', 'Показать запись в Anki') })
            ankiButton.onclick = async () => {
                ankiButton.disabled = true
                try { await openAuditAnkiNote(chosen.id, this.result.ankiProfile, t) }
                catch (error) { this.notice(error) }
                finally { ankiButton.disabled = false }
            }
        }
        if (source && !row.issue) {
            const status = details.createEl('p', { attr: { role: 'status' } })
            Object.assign(status.style, { display: 'flex', gap: '0.5em', alignItems: 'center' })
            const icon = status.createSpan({ attr: { 'aria-hidden': 'true' } })
            setIcon(icon, chosen?.eligible ? 'link' : row.candidates.length ? 'list' : 'unlink')
            status.createSpan({ text: chosen?.eligible ? t(`Anki match · ID ${chosen.id}`, `Совпадение в Anki · ID ${chosen.id}`)
                : row.candidates.length ? t('Check the candidates and choose an Anki record.', 'Сравните варианты и выберите запись Anki.')
                : t('No match in Anki. You can keep the source and continue.', 'Совпадений в Anki нет. Можно оставить запись и продолжить.') })
        }
        if (row.candidates.length > 1 || row.candidates.length === 1 && (!chosen?.eligible || this.candidates.has(row.id))) {
            const name = t(`Anki note for ID ${row.id}`, `Запись Anki для ID ${row.id}`)
            const label = details.createEl('label', { text: name })
            const choice = label.createEl('select', { attr: { 'aria-label': name } })
            this.focusTargets.set('candidate', choice)
            choice.style.maxWidth = '100%'
            choice.createEl('option', { value: '', text: t('Choose an Anki record', 'Выберите запись Anki') })
            for (const candidate of row.candidates) {
                choice.createEl('option', { value: String(candidate.id), text: `ID ${candidate.id} · ${candidate.modelName}` })
            }
            choice.value = chosen ? String(chosen.id) : ''
            choice.onchange = () => {
                this.candidates.set(row.id, choice.value ? Number(choice.value) : null)
                this.render(undefined, 'candidate')
            }
        }
        if (chosen?.reason) details.createEl('p', { text: chosen.reason }).style.overflowWrap = 'anywhere'
        if (source && chosen) {
            const fields = differentFields(source.fields, chosen.fields)
            details.createEl('p', { text: fields.length ? t(`Different fields · ${fields.join(', ')}`, `Различаются поля · ${fields.join(', ')}`)
                : t('All compared fields match.', 'Все сравниваемые поля совпадают.') }).style.overflowWrap = 'anywhere'
        }
        const first = source?.firstField
        if (first || chosen) {
            const pairs = details.createDiv()
            Object.assign(pairs.style, { display: 'grid', gap: '0.6em', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 14rem),1fr))' })
            if (source && first) this.fieldPanel(pairs, 'Obsidian', first, source.fields)
            if (chosen) this.fieldPanel(pairs, `Anki · ID ${chosen.id}`, chosen.firstField, chosen.fields)
        }
    }

    private fieldPanel(parent: HTMLElement, system: string, first: string, fields: Readonly<Record<string, string>>): void {
        const t = this.t
        const pane = parent.createDiv()
        Object.assign(pane.style, { padding: '0.5em', minWidth: '0', border: '1px solid var(--background-modifier-border)' })
        pane.createEl('strong', { text: system })
        pane.createEl('p', { text: fieldExcerpt(first) }).style.overflowWrap = 'anywhere'
        const detail = pane.createEl('details')
        detail.createEl('summary', { text: t('All Fields', 'Все поля') })
        const list = detail.createEl('dl')
        Object.assign(list.style, { maxHeight: '12rem', overflow: 'auto', overflowWrap: 'anywhere' })
        for (const [name, value] of Object.entries(fields)) {
            list.createEl('dt', { text: name })
            const text = fieldText(value) || value
            list.createEl('dd', { text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text })
        }
    }

    private actionFooter(rows: readonly AuditRepairRow[]): void {
        const t = this.t
        const matched = this.plan(rows, true)
        const local = this.plan(rows, false)
        const count = this.batch ? this.selected.size : 1
        if (matched.length) {
            const footer = this.buttons()
            const button = footer.createEl('button', { text: actionLabel('replace-id', t), cls: 'mod-cta',
                title: actionDescription('replace-id', t) })
            button.onclick = () => this.confirm('replace-id', matched)
        }
        if (!local.length && !matched.length) return
        const advanced = this.contentEl.createEl('details')
        advanced.createEl('summary', { text: t('Delete records…', 'Удаление записей…') })
        const footer = this.buttons(advanced)
        for (const action of actions) {
            if (action === 'replace-id') continue
            const plan = action === 'delete-obsidian' ? local : matched
            if (!plan.length) continue
            const label = actionLabel(action, t)
            const button = footer.createEl('button', { text: this.batch ? label + ` (${plan.length}/${count})` : label,
                title: actionDescription(action, t) })
            button.onclick = () => this.confirm(action, plan)
        }
    }

    private plan(rows: readonly AuditRepairRow[], requiresAnki: boolean): AuditRepairSelection[] {
        const planned: AuditRepairSelection[] = []
        const owners = new Map<number, number>()
        for (const row of rows) {
            if (!row.source || (this.batch ? !this.selected.has(row.id) : row.id !== this.selectedRow)) continue
            const candidate = requiresAnki ? this.chooseCandidate(row) : undefined
            if (!requiresAnki) {
                if (!row.source.wholePage) planned.push({ row })
            }
            else if (candidate?.eligible) {
                planned.push({ row, candidateId: candidate.id })
                owners.set(candidate.id, (owners.get(candidate.id) ?? 0) + 1)
            }
        }
        return planned.filter(item => item.candidateId === undefined || owners.get(item.candidateId) === 1)
    }

    private confirm(action: AuditRepairAction, rows: readonly AuditRepairSelection[]): void {
        const t = this.t
        if (this.busy || !this.data || !rows.length) return
        this.contentEl.empty()
        this.titleLine()
        this.contentEl.createEl('h3', { text: actionLabel(action, t) })
        this.contentEl.createEl('p', { text: actionDescription(action, t) })
        const skipped = (this.batch ? this.selected.size : 1) - rows.length
        this.contentEl.createEl('p', { text: t(`To apply · ${rows.length}. Skipped · ${skipped}.`, `Будет обработано · ${rows.length}. Пропущено · ${skipped}.`) })
        if (skipped) this.contentEl.createEl('p', { text: t('Skipped rows lack a verified source or a unique selected Anki record for this action.',
            'У пропущенных строк отсутствует проверенный источник или однозначно выбранная запись Anki для этого действия.') })
        this.pagedList(rows, (list, { row, candidateId }) => {
            const candidate = candidateId === undefined ? '' : ` → Anki ID ${candidateId}`
            const item = list.createEl('li', { text: `ID ${row.id}${candidate} · ${location(row, t)}` })
            item.style.overflowWrap = 'anywhere'
            if (row.source?.firstField) item.createDiv({ text: fieldExcerpt(row.source.firstField) })
            const target = row.candidates.find(note => note.id === candidateId)
            if (row.source && target) {
                const fields = differentFields(row.source.fields, target.fields)
                if (fields.length) item.createDiv({ text: t(`Different fields · ${fields.join(', ')}`, `Различаются поля · ${fields.join(', ')}`) })
            }
        })
        const footer = this.buttons()
        footer.createEl('button', { text: t('Back to Records', 'Назад к записям') }).onclick = () => this.render()
        const button = footer.createEl('button', { text: t('Confirm Action', 'Подтвердить действие'), cls: action === 'replace-id' ? 'mod-cta' : 'mod-warning' })
        button.onclick = () => { button.disabled = true; void this.apply(action, rows) }
    }

    private pagedList<T>(items: readonly T[], append: (list: HTMLElement, item: T) => void): void {
        const t = this.t
        const list = this.contentEl.createEl('ul')
        Object.assign(list.style, { maxHeight: 'min(43vh, 25rem)', overflow: 'auto' })
        let visible = 0
        const add = () => {
            const end = Math.min(items.length, visible + pageSize)
            for (; visible < end; visible++) append(list, items[visible])
        }
        add()
        if (visible === items.length) return
        const button = this.contentEl.createEl('button', { text: t('Show More Records', 'Показать ещё записи') })
        button.onclick = () => { add(); button.hidden = visible === items.length }
    }

    private async apply(action: AuditRepairAction, rows: readonly AuditRepairSelection[]): Promise<void> {
        if (this.busy || !this.data || this.abort.signal.aborted) return
        this.busy = true
        const t = this.t
        const { profile, deck, scopeSignature } = this.data
        this.working(t('Verifying selected records and applying the approved action…', 'Проверяю выбранные записи и применяю подтверждённое действие…'))
        try {
            const results = await applyAuditRepairs(this.plugin, { profile, deck, scopeSignature, action, rows, signal: this.abort.signal })
            if (!this.abort.signal.aborted) await this.showResults(results, profile)
        } catch (error) {
            this.showError(error)
        } finally {
            this.busy = false
        }
    }

    private working(text: string): void {
        this.contentEl.empty()
        this.titleLine()
        this.contentEl.createEl('p', { text, attr: { role: 'status' } })
    }

    private showError(error: unknown): void {
        if (this.abort.signal.aborted) return
        this.working(this.t('The action was interrupted.', 'Действие прервано.'))
        this.contentEl.createEl('p', { text: displayDiagnostic(error, this.t), attr: { role: 'alert' } }).style.color = 'var(--text-error)'
        this.addRecheck(this.buttons())
    }

    private async showResults(results: RepairResults, profile: string): Promise<void> {
        const t = this.t
        this.working(t('Action Results', 'Результаты исправления'))
        const applied = results.filter(item => item.status === 'applied').length
        this.contentEl.createEl('p', { text: t(`Applied · ${applied}. Check required · ${results.length - applied}.`,
            `Исправлено · ${applied}. Требуют проверки · ${results.length - applied}.`) })
        this.pagedList(results, (list, item) => {
            const status = item.status === 'applied' ? t('Applied', 'Исправлено') :
                item.status === 'needs-local-unlink' ? t('Complete the Markdown change', 'Нужно завершить изменение Markdown') :
                item.status === 'needs-verification' ? t('Check the Anki result', 'Нужно проверить результат Anki') : t('Failed', 'Ошибка')
            const line = list.createEl('li', { text: `ID ${item.oldId} · ${item.path} · ${status}` })
            line.style.overflowWrap = 'anywhere'
            if (item.status !== 'applied') line.style.color = 'var(--text-error)'
            if (item.message) line.createDiv({ text: item.message })
        })
        try { this.pending = await readPendingAuditRepairs(this.plugin, profile) }
        catch (error) {
            if (!this.abort.signal.aborted) this.contentEl.createEl('p', { text: displayDiagnostic(error, t), attr: { role: 'alert' } })
        }
        if (this.abort.signal.aborted) return
        this.showPending()
        this.addRecheck(this.buttons())
    }

    private showPending(): void {
        if (!this.pending.length) return
        const t = this.t
        const heading = this.contentEl.createEl('section')
        heading.createEl('h3', { text: t('Unfinished Anki Repairs', 'Незавершённые исправления Anki') })
        heading.createEl('p', { text: t('Verification reads the prior deletion result. If the note is confirmed missing, it removes only the old ID marker from the matching Markdown source.',
            'Проверка выясняет результат предыдущего удаления. Когда отсутствие записи подтверждено, из проверенного блока Markdown удаляется только строка старого ID.') })
        const list = heading.createEl('ul')
        for (const item of this.pending) {
            const row = list.createEl('li', { text: `ID ${item.oldId} → Anki ID ${item.candidateId} · ${item.path}` })
            row.style.overflowWrap = 'anywhere'
            row.createEl('button', { text: t('Verify and Finish Unlinking', 'Проверить и завершить отвязку') })
                .onclick = () => this.confirmPending(item)
        }
    }

    private confirmPending(item: PendingRepairs[number]): void {
        if (this.busy) return
        const t = this.t
        this.working(t('Confirm Unlinking', 'Подтвердите завершение отвязки'))
        this.contentEl.createEl('p', { text: t(`Check Anki ID ${item.candidateId} and remove obsolete ID ${item.oldId} from ${item.path} only if the earlier deletion is confirmed.`,
            `Проверить Anki ID ${item.candidateId} и удалить старый ID ${item.oldId} из ${item.path}, если прежнее удаление подтверждено.`) }).style.overflowWrap = 'anywhere'
        const footer = this.buttons()
        footer.createEl('button', { text: t('Back to Records', 'Назад к записям') }).onclick = () => this.render()
        footer.createEl('button', { text: t('Confirm Action', 'Подтвердить действие'), cls: 'mod-cta' })
            .onclick = () => { void this.finishPending(item) }
    }

    private async finishPending(item: PendingRepairs[number]): Promise<void> {
        const profile = this.result.ankiProfile
        if (this.busy || !profile || !('active' in profile) || this.abort.signal.aborted) return
        this.busy = true
        this.working(this.t('Verifying the previous deletion…', 'Проверяю предыдущее удаление…'))
        try {
            const result = await finishAuditRepairUnlink(this.plugin, profile.active, item.token, this.abort.signal)
            if (!this.abort.signal.aborted) await this.showResults([result], profile.active)
        } catch (error) { this.showError(error) }
        finally { this.busy = false }
    }
}

export function openAuditRepair(plugin: MyPlugin, result: SyncAuditResult, recheck: () => void, initialId?: number): void {
    new AuditRepairModal(plugin, result, recheck, initialId).open()
}
