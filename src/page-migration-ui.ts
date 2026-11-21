// SPDX-License-Identifier: GPL-3.0-only
import { Modal, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { vaultFolderEntries } from './folder-tree'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { applyPageMigration, migrationBackupDirectory, previewPageMigration } from './page-migration'
import type { PageMigrationPlan, PageMigrationResult, PageMigrationRow } from './page-migration'
import { detectMigrationFolders } from './page-migration-context'
import type { MigrationSource } from './page-migration-context'
import { pageIdLocation } from './page-id-location'
import { pageCardExpression } from './card-format-presets'
import { previewFieldText } from './card-preview-ui'

const active = new WeakMap<MyPlugin, PageMigrationWizard>()
const registered = new WeakSet<MyPlugin>()
const sources: Record<MigrationSource, string> = {
    yanki: 'Yanki', flashcards: 'Flashcards', 'obsidian-to-anki': 'Obsidian_to_Anki', 'deck-to-anki': 'Deck To Anki',
    'anki-forge': 'Anki Forge', 'anki-bridge': 'Anki Bridge', 'anki-ast-sync': 'Anki AST Sync', 'anki-exporter': 'Anki Exporter',
    'spaced-repetition': 'Spaced Repetition', rudonium: 'Rudonium (@page)',
}
type Filter = 'all' | PageMigrationRow['status']
const pageSize = 25

function sourceLabel(source: string): string {
    return Object.prototype.hasOwnProperty.call(sources, source) ? sources[source as MigrationSource] : source
}

function button(parent: HTMLElement, label: string, action: () => void, primary = false): HTMLButtonElement {
    const el = parent.createEl('button', { text: label, attr: { type: 'button' } })
    if (primary) el.classList.add('mod-cta')
    el.onclick = action
    return el
}

function field(parent: HTMLElement, label: string): HTMLLabelElement {
    const row = parent.createEl('label')
    row.classList.add('rudonium-page-migration-row')
    row.createDiv({ text: label })
    return row
}

function errorText(error: unknown, t: UiText): string {
    const text = error instanceof Error ? error.message : String(error)
    const parts = text.split(/ \/ (?=[А-ЯЁ])/u)
    return parts.length === 2 ? t(parts[0], parts[1]) : text
}

class PageMigrationWizard extends Modal {
    private readonly t: UiText
    private readonly models: string[]
    private model: string
    private source: MigrationSource | 'auto' = 'auto'
    private folder = ''
    private watched: string[] = []
    private folders: string[] = []
    private backup = ''
    private defaultDirectory = ''
    private plan?: PageMigrationPlan
    private result?: PageMigrationResult
    private selected = new Set<string>()
    private confirmedLinks = new Map<string, number>()
    private filter: Filter = 'all'
    private page = 0
    private allowUnlinked = false
    private message = ''
    private closed = false
    private phase?: 'preview' | 'apply'
    private controller?: AbortController
    private status?: HTMLElement

    constructor(private readonly plugin: MyPlugin, preferredModel?: string) {
        super(plugin.app)
        const expressions = plugin.settings.CUSTOM_REGEXPS ?? {}
        const explicit = Object.keys(expressions).find(model => expressions[model] === pageCardExpression)
        this.models = Object.keys(plugin.fields_dict).filter(model => plugin.fields_dict[model]?.length >= 2 &&
            (!explicit || explicit === model))
        const ordinary = this.models.filter(model => plugin.fields_dict[model][0] !== 'ob-deck-id')
        const prefs = [explicit, plugin.settings.PAGE_MODEL, preferredModel, 'Basic', ordinary[0], this.models[0]]
        this.model = prefs.find((name): name is string => !!name && this.models.includes(name)) ?? ''
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.titleEl.setText(this.t('Migrate card files', 'Перенести карточки из файлов'))
        installModalLayout(this, this.t)
        this.folders = vaultFolderEntries(this.plugin.app.vault).map(item => item.path)
        this.render()
    }

    close(): void {
        if (this.phase === 'apply' && !this.closed) {
            this.controller?.abort()
            this.status?.setText(this.t('Stopping after the current operation…', 'Остановка после текущей операции…'))
            return
        }
        super.close()
    }
    dispose(): void { this.closed = true; this.controller?.abort(); super.close() }
    onClose(): void {
        this.closed = true
        this.controller?.abort()
        this.contentEl.empty()
        active.delete(this.plugin)
    }

    private render(): void {
        if (this.closed) return
        const body = this.contentEl
        body.empty()
        this.status = body.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } })
        this.status.setText(this.message)
        if (this.phase) {
            button(body, this.t('Stop', 'Остановить'), () => {
                this.controller?.abort()
                this.status?.setText(this.t('Stopping…', 'Остановка…'))
            })
        } else if (this.result) this.renderResult(body, this.result)
        else if (this.plan) this.renderReview(body, this.plan)
        else this.renderScope(body)
    }

    private renderScope(body: HTMLElement): void {
        const t = this.t
        body.createEl('p', { text: t('Find Markdown files that each contain one card. First, review the proposed changes.',
            'Найдите заметки Markdown, каждая из которых содержит одну карточку. Сначала мастер покажет предполагаемые изменения.') })
        const placement = pageIdLocation(this.plugin.settings.PAGE_ID_LOCATION)
        if (placement === 'yaml') body.createEl('p', { text: t(
            'Verified IDs go in the anki-page-ID property. An ID with a personal annotation stays below the heading.',
            'Подтверждённый ID записывается в свойство anki-page-ID. ID с авторской пометкой остаётся под заголовком.') })
        if (placement === 'after-answer') body.createEl('p', { text: t(
            'Verified IDs go after the answer. An ID with a personal annotation stays below the heading.',
            'Подтверждённый ID записывается после ответа. ID с авторской пометкой остаётся под заголовком.') })
        const source = field(body, t('Source plugin', 'Исходный плагин')).createEl('select')
        source.createEl('option', { text: t('Detect automatically', 'Определить автоматически'), value: 'auto' })
        for (const [id, name] of Object.entries(sources)) source.createEl('option', { value: id, text: name })
        source.value = this.source
        const hint = body.createEl('small')
        const showSourceHint = () => {
            const hints: Partial<Record<MigrationSource | 'auto', string>> = {
                'spaced-repetition': t('Scheduling markers from Spaced Repetition are listed for manual review.',
                    'Метки расписания Spaced Repetition отображаются для ручной проверки.'),
                yanki: t('To include unmarked Yanki files, select their original card folder. Enter / if the entire vault was that folder. Leave the field empty to use file markers only.',
                    'Чтобы включить заметки Yanki без меток, укажите прежнюю папку карточек. Если ей было всё хранилище, введите /. При пустом поле мастер ищет только по меткам внутри файлов.'),
                rudonium: t('For a #anki-page file without its ID, choose “Check cards without an ID” in the preview.',
                    'Для страницы #anki-page без ID в результатах нажмите «Проверить карточки без ID».'),
                'anki-exporter': t('Select Anki Exporter explicitly to check a single Question :: Answer line without its Anki ID marker.',
                    'Выберите Anki Exporter, чтобы проверить одиночную строку «Вопрос :: Ответ» без метки ID Anki.'),
                'anki-forge': t('Anki Forge block anchors identify Obsidian blocks. The wizard verifies the corresponding Anki note separately.',
                    'Якорь Anki Forge указывает на блок Obsidian. Мастер отдельно проверяет связь с записью Anki.'),
                'anki-bridge': t('Choose this source for Anki Bridge by Aaron Ade (%%oab:…:v1%% markers).',
                    'Этот вариант предназначен для Anki Bridge от Aaron Ade с метками %%oab:…:v1%%.'),
                'anki-ast-sync': t('An Anki AST Sync UUID identifies the source card. The wizard checks the Anki note separately.',
                    'UUID Anki AST Sync обозначает исходную карточку. Мастер отдельно проверяет запись Anki.'),
            }
            const text = hints[this.source] ?? ''
            hint.hidden = !text
            hint.setText(text)
        }
        showSourceHint()
        const folderLabel = field(body, t('Folder to search', 'Папка для поиска'))
        const input = folderLabel.createEl('input', { attr: { type: 'text', spellcheck: 'false',
            placeholder: t('Entire vault', 'Всё хранилище'), list: 'rudonium-page-import-folders' } })
        input.classList.add('rudonium-full-width')
        input.value = this.folder
        const list = folderLabel.createEl('datalist', { attr: { id: 'rudonium-page-import-folders' } })
        const updateFolders = () => {
            list.empty()
            const key = input.value.trim().toLowerCase()
            if (this.source === 'yanki' && (!key || key === '/')) list.createEl('option', { value: '/' })
            let count = 0
            for (const path of this.folders) {
                if (key && !path.toLowerCase().includes(key)) continue
                list.createEl('option', { value: path })
                if (++count === 50) break
            }
        }
        source.onchange = () => { this.source = source.value as typeof this.source; showSourceHint(); updateFolders() }
        input.oninput = () => { this.folder = input.value; updateFolders() }
        updateFolders()
        const suggestions = body.createDiv()
        const showFolders = (folders: string[]) => {
            if (!suggestions.isConnected || !folders.length) return
            suggestions.empty()
            const label = suggestions.createEl('label', { text: t('Folders with Yanki IDs', 'Папки с ID Yanki') + ' ' })
            const choose = label.createEl('select')
            choose.createEl('option', { value: '', text: t('Choose a detected folder', 'Выбрать найденную папку') })
            for (const value of folders) choose.createEl('option', { text: value, value })
            choose.onchange = () => { if (choose.value) { this.source = 'yanki'; source.value = this.source; showSourceHint(); this.folder = input.value = choose.value; updateFolders() } }
        }
        if (this.watched.length) showFolders(this.watched)
        else void detectMigrationFolders(this.plugin).then(folders => { this.watched = folders; showFolders(folders) }, () => {})
        const model = field(body, t('Default Anki note type for unlinked pages', 'Тип записи Anki для страниц без связи')).createEl('select')
        for (const name of this.models) {
            const serviceFirst = this.plugin.fields_dict[name][0] === 'ob-deck-id'
            model.createEl('option', { value: name, text: serviceFirst
                ? name + t(' (linked cards only)', ' (только связанные карточки)') : name })
        }
        model.value = this.model
        if (this.models.length < 2) model.disabled = true
        model.onchange = () => { this.model = model.value }
        body.createEl('small', { text: this.models.length
            ? t('Verified linked cards keep their original Anki note type and deck. Migration writes to Obsidian only.',
                'У проверенных связанных карточек сохраняются исходные тип записи и колода Anki. Перенос изменяет только данные в Obsidian.')
            : t('Refresh the Anki note types in settings and check the configured page model. Page cards need at least two fields.',
                'Обновите типы записей Anki в настройках и проверьте тип, назначенный формату страницы. Нужны как минимум два поля.') })
        const actions = body.createDiv({ cls: 'modal-button-container' })
        button(actions, t('Preview files', 'Проверить файлы'), () => void this.preview(), true).disabled = !this.model
    }

    private start(phase: 'preview' | 'apply', message: string): AbortSignal {
        this.phase = phase
        this.controller = new AbortController()
        this.message = message
        this.render()
        return this.controller.signal
    }

    private progress(label: string): (done: number, total: number) => void {
        let last = -Infinity
        return (done, total) => {
            const now = Date.now()
            if (this.closed || this.controller?.signal.aborted || (done < total && now - last < 120)) return
            last = now
            this.status?.setText(label + ' · ' + done.toLocaleString() + ' / ' + total.toLocaleString())
        }
    }

    private async preview(checkMissingIds = false): Promise<void> {
        if (this.phase) return
        const previouslyReady = new Set(this.plan?.rows.filter(row => row.status === 'ready').map(row => row.path))
        this.plan = undefined
        this.confirmedLinks.clear()
        this.allowUnlinked = false
        const t = this.t
        const label = checkMissingIds ? t('Checking cards without an ID in Anki…', 'Проверяю карточки без ID в Anki…')
            : t('Checking files…', 'Проверяю файлы…')
        const signal = this.start('preview', label)
        try {
            const plan = await previewPageMigration(this.plugin, { model: this.model, source: this.source,
                folder: this.folder.trim(), ...(checkMissingIds ? { checkMissingIds: true } : {}) },
                signal, this.progress(label))
            if (signal.aborted || this.closed) return
            this.defaultDirectory = await migrationBackupDirectory(this.plugin).catch(() => '')
            if (signal.aborted || this.closed) return
            this.plan = plan
            this.selected = new Set(plan.rows.filter(row => row.status === 'ready' &&
                (!checkMissingIds || !previouslyReady.has(row.path) || this.selected.has(row.path))).map(row => row.path))
            this.page = 0
            this.filter = 'all'
            this.message = ''
        } catch (error) { this.message = errorText(error, t) }
        finally {
            if (signal.aborted) this.message = t('Preview cancelled.', 'Проверка отменена.')
            this.phase = undefined
            this.render()
        }
    }

    private renderReview(body: HTMLElement, plan: PageMigrationPlan): void {
        const t = this.t
        const ready = plan.rows.filter(row => row.status === 'ready')
        const review = plan.rows.filter(row => row.status === 'review').length
        const linkCount = plan.rows.filter(row => row.status === 'link').length
        const unchecked = plan.rows.filter(row => row.status === 'unchecked').length
        const hasChanges = !!(ready.length || linkCount)
        const labels: Record<Filter, string> = { all: t('All results', 'Все результаты'), ready: t('Ready', 'Готово к переносу'),
            link: t('Exact Anki match', 'Точное совпадение в Anki'), review: t('Needs review', 'Проверить вручную'),
            already: t('Already converted', 'Уже преобразовано'), unchecked: t('Not checked', 'Ожидает проверки') }
        body.createEl('p', { text: t(`Checked ${plan.scanned} files · ${plan.model}`, `Проверено файлов: ${plan.scanned} · ${plan.model}`) +
            (plan.profile ? ' · ' + plan.profile : '') })
        for (const warning of plan.warnings) body.createEl('p', { text: warning })
        if (unchecked) {
            body.createEl('p', { text: t(`Card files without an ID: ${unchecked}. You can search Anki once to find existing notes.`,
                `Файлов с карточкой без ID: ${unchecked}. Можно один раз проверить, есть ли для них записи в Anki.`) })
            button(body, t('Check cards without an ID', 'Проверить карточки без ID'), () => void this.preview(true), !hasChanges)
        }
        if (!plan.rows.length) body.createEl('p', { text: t('No matching card files. Check the folder or choose the source plugin explicitly.',
            'Подходящие карточки не найдены. Проверьте папку или укажите исходный плагин вручную.') })
        else {
            const select = field(body, t('Show', 'Показать')).createEl('select')
            const counts = { all: plan.rows.length, ready: ready.length, link: linkCount, review, unchecked, already: plan.rows.length - ready.length - review - linkCount - unchecked }
            for (const key of Object.keys(labels) as Filter[]) {
                if ((key !== 'link' && key !== 'unchecked') || counts[key]) select.createEl('option', { value: key, text: labels[key] + ' (' + counts[key] + ')' })
            }
            select.value = this.filter
            select.onchange = () => { this.filter = select.value as Filter; this.page = 0; this.render() }
        }
        const rows = this.filter === 'all' ? plan.rows : plan.rows.filter(row => row.status === this.filter)
        const group = body.createDiv()
        const selection = group.createEl('label')
        const all = selection.createEl('input', { attr: { type: 'checkbox' } })
        selection.createSpan({ text: ' ' + t('Select all ready files', 'Выбрать все готовые файлы') })
        selection.hidden = !ready.length
        let update = () => {}
        const boxes: Array<[string, HTMLInputElement]> = []
        let unknown = ready.reduce((n, row) => n + Number(row.id === undefined && this.selected.has(row.path)), 0)
        const linked = ready.filter(row => row.id !== undefined).map(row => row.path)
        const selectPaths = (paths: string[], unknownCount: number) => {
            this.allowUnlinked = false
            this.selected = new Set(paths)
            unknown = unknownCount
            for (const [path, box] of boxes) box.checked = this.selected.has(path)
            update()
        }
        all.onchange = () => selectPaths(all.checked ? ready.map(row => row.path) : [], all.checked ? ready.length - linked.length : 0)
        if (linked.length && linked.length < ready.length) {
            button(group, t('Select only files with verified IDs', 'Выбрать только файлы с подтверждёнными ID'), () => selectPaths(linked, 0))
        }
        const from = this.page * pageSize
        for (const row of rows.slice(from, from + pageSize)) {
            const line = group.createDiv()
            line.classList.add('rudonium-page-migration-line')
            const label = line.createEl('label')
            if (row.status === 'ready') {
                const check = label.createEl('input', { attr: { type: 'checkbox' } })
                check.checked = this.selected.has(row.path)
                check.onchange = () => {
                    if (check.checked === this.selected.has(row.path)) return
                    if (check.checked) this.selected.add(row.path)
                    else this.selected.delete(row.path)
                    if (row.id === undefined) { unknown += check.checked ? 1 : -1; this.allowUnlinked = false }
                    update()
                }
                boxes.push([row.path, check])
            }
            label.createSpan({ text: ' ' + row.path }).classList.add('rudonium-wrap-anywhere')
            line.createDiv({ text: [labels[row.status], sourceLabel(row.source), row.id ? 'ID ' + row.id : '', row.reason].filter(Boolean).join(' · ') })
            if (row.status === 'link' && row.link) this.showLink(line, row.path, row.link, () => update())
            if (row.before !== undefined && row.after !== undefined && (row.status === 'ready' || row.status === 'link')) {
                const detail = line.createEl('details')
                detail.createEl('summary', { text: t('Compare Markdown', 'Сравнить Markdown') })
                detail.ontoggle = () => {
                    if (!detail.open || detail.children.length > 1) return
                    for (const [title, value] of [[t('Before', 'До'), row.before!], [t('After', 'После'), row.after!]]) {
                        detail.createEl('small', { text: title })
                        const pre = detail.createEl('pre', { text: value.length > 5000 ? value.slice(0, 5000) + '…' : value })
                        pre.classList.add('rudonium-page-migration-pre')
                    }
                }
            }
        }
        if (rows.length > pageSize) {
            const pages = group.createDiv()
            button(pages, t('Previous', 'Назад'), () => { this.page--; this.render() }).disabled = this.page === 0
            pages.createSpan({ text: ' ' + (from + 1) + '–' + Math.min(from + pageSize, rows.length) + ' / ' + rows.length + ' ' })
            button(pages, t('Next', 'Дальше'), () => { this.page++; this.render() }).disabled = from + pageSize >= rows.length
        }
        const backupLabel = field(body, t('Full vault ZIP · backup folder outside the vault', 'ZIP всего хранилища · папка для копии вне хранилища'))
        const directory = backupLabel.createEl('input', { attr: { type: 'text', spellcheck: 'false' } })
        directory.classList.add('rudonium-full-width')
        directory.placeholder = this.defaultDirectory || t('Default backup folder', 'Папка резервных копий по умолчанию')
        directory.value = this.backup
        directory.oninput = () => { this.backup = directory.value }
        if (!hasChanges) {
            backupLabel.hidden = true
            backupLabel.classList.add('rudonium-hidden')
        }
        const unlinked = body.createEl('label')
        unlinked.classList.add('rudonium-block')
        const ack = unlinked.createEl('input', { attr: { type: 'checkbox' } })
        const ackText = unlinked.createSpan()
        ack.onchange = () => { this.allowUnlinked = ack.checked; update() }
        const count = body.createEl('p', { attr: { 'aria-live': 'polite' } })
        const actions = body.createDiv({ cls: 'modal-button-container' })
        button(actions, t('Change selection criteria', 'Изменить условия поиска'), () => {
            this.plan = undefined; this.message = ''; this.render()
        })
        if (this.message) button(actions, t('Refresh preview', 'Обновить предпросмотр'), () => void this.preview())
        const commit = button(actions, t('Back up and convert', 'Создать копию и преобразовать'), () => void this.apply(), true)
        commit.hidden = !hasChanges
        update = () => {
            const n = this.selected.size + this.confirmedLinks.size
            all.checked = ready.length > 0 && this.selected.size === ready.length
            all.indeterminate = this.selected.size > 0 && this.selected.size !== ready.length
            unlinked.hidden = !unknown
            unlinked.classList.toggle('rudonium-hidden', !unknown)
            if (!unknown) this.allowUnlinked = false
            ack.checked = this.allowUnlinked
            ackText.setText(' ' + t(`Include ${unknown} files without a verified Anki ID. A later export can create new notes in Anki.`,
                `Включить файлы без подтверждённого ID Anki (${unknown}). При следующем экспорте в Anki могут появиться новые записи.`))
            count.setText(hasChanges ? t(`Selected: ${n}. The ZIP contains the entire Obsidian vault. The Anki collection stays in Anki.`,
                `Выбрано: ${n}. Мастер сохранит и проверит ZIP всего хранилища Obsidian. Коллекция Anki хранится отдельно.`) : '')
            commit.disabled = !n || !!unknown && !this.allowUnlinked
        }
        update()
    }

    private showLink(line: HTMLElement, path: string, match: NonNullable<PageMigrationRow['link']>, update: () => void): void {
        const t = this.t
        const fields = line.createEl('details')
        const question = previewFieldText(line.ownerDocument, match.front.slice(0, 800), t('[Image]', '[Изображение]'))
            .replace(/\s+/gu, ' ').trim()
        const excerpt = question.length > 140 ? question.slice(0, 140) + '…' : question
        const title = fields.createEl('summary', { text: 'Anki ID ' + match.id + (excerpt ? ' · ' + excerpt : '') })
        title.classList.add('rudonium-wrap-anywhere')
        line.createEl('small', { text: t('Note type', 'Тип записи') + ' · ' + match.model + '   /   ' +
            t('Deck', 'Колода') + ' · ' + match.deck }).classList.add('rudonium-wrap-anywhere')
        fields.ontoggle = () => {
            if (!fields.open || fields.children.length > 1) return
            for (const [name, html] of [[t('Question', 'Вопрос'), match.front], [t('Answer', 'Ответ'), match.back]]) {
                fields.createEl('strong', { text: name })
                const text = previewFieldText(line.ownerDocument, html, t('[Image]', '[Изображение]'))
                const value = fields.createDiv({ text: text || html })
                value.classList.add('rudonium-page-migration-value')
            }
        }
        const choice = line.createEl('label')
        choice.classList.add('rudonium-block')
        const check = choice.createEl('input', { attr: { type: 'checkbox',
            'aria-label': t(`Link ${path} to Anki note ${match.id}`, `Связать ${path} с записью Anki ${match.id}`) } })
        check.checked = this.confirmedLinks.get(path) === match.id
        choice.createSpan({ text: ' ' + t('Link to this note', 'Связать с этой записью') })
        check.onchange = () => {
            if (check.checked) this.confirmedLinks.set(path, match.id)
            else this.confirmedLinks.delete(path)
            update()
        }
    }

    private async apply(): Promise<void> {
        const plan = this.plan
        if (this.phase || !plan || !(this.selected.size || this.confirmedLinks.size)) return
        const links = new Map(this.confirmedLinks)
        const selected = new Set([...this.selected, ...links.keys()])
        if (!this.allowUnlinked && plan.rows.some(row => row.status === 'ready' && row.id === undefined && selected.has(row.path))) return
        const label = this.t('Saving the full ZIP and converting files…', 'Сохраняю ZIP всего хранилища и преобразую файлы…')
        const signal = this.start('apply', label)
        try {
            this.result = await applyPageMigration(this.plugin, plan, selected, this.backup.trim() || undefined,
                signal, this.progress(this.t('Converting files', 'Преобразую файлы')), this.allowUnlinked, links)
            this.message = ''
        } catch (error) { this.message = errorText(error, this.t) }
        finally { this.phase = undefined; this.render() }
    }

    private renderResult(body: HTMLElement, result: PageMigrationResult): void {
        const t = this.t
        body.createEl('h3', { text: result.stopped ? t('Migration stopped', 'Перенос остановлен') : t('Migration complete', 'Перенос завершён') })
        body.createEl('p', { text: t(`Converted files: ${result.converted.length}.`, `Преобразовано файлов: ${result.converted.length}.`) })
        if (result.stopped) body.createEl('p', { text: result.stopped })
        if (result.converted.length) {
            const files = body.createEl('details')
            files.createEl('summary', { text: t('Converted files', 'Преобразованные файлы') })
            const list = files.createEl('ul')
            let end = 0
            const more = button(files, t('Show more', 'Показать ещё'), () => append())
            const append = () => {
                for (const path of result.converted.slice(end, end + pageSize)) list.createEl('li', { text: path }).classList.add('rudonium-wrap-anywhere')
                end += pageSize
                more.hidden = end >= result.converted.length
            }
            append()
        }
        if (result.archive) {
            body.createEl('strong', { text: t('Original vault ZIP', 'ZIP исходного хранилища') })
            body.createEl('p', { text: result.archive }).classList.add('rudonium-wrap-anywhere')
        }
        body.createEl('p', { text: t('Review a converted file and preview your next Anki export.',
            'Откройте преобразованную заметку и проверьте предпросмотр следующего экспорта в Anki.') })
        const actions = body.createDiv({ cls: 'modal-button-container' })
        button(actions, t('Check again', 'Проверить снова'), () => { this.result = undefined; this.plan = undefined; void this.preview() })
        button(actions, t('Done', 'Готово'), () => this.close(), true)
    }
}

export function openPageMigration(plugin: MyPlugin, preferredModel?: string): void {
    if (active.has(plugin)) return
    if (!registered.has(plugin)) {
        plugin.register(() => { active.get(plugin)?.dispose(); registered.delete(plugin) })
        registered.add(plugin)
    }
    const modal = new PageMigrationWizard(plugin, preferredModel)
    active.set(plugin, modal)
    modal.open()
}

export function installPageMigrationSetting(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    new Setting(container).setName(t('Card file migration', 'Перенос карточек из файлов'))
        .setDesc(t('Convert files from another flashcard plugin to page cards and keep a ZIP of the original vault.',
            'Преобразуйте файлы другого плагина в карточки-страницы и сохраните исходное хранилище в ZIP.'))
        .addButton(control => control.setButtonText(t('Open wizard', 'Открыть мастер')).onClick(() => openPageMigration(plugin)))
}

export function registerPageMigrationCommand(plugin: MyPlugin): void {
    plugin.addCommand({ id: 'migrate-page-cards', name: uiFor(plugin.settings)('Migrate card files', 'Перенести карточки из файлов'),
        callback: () => openPageMigration(plugin) })
}
