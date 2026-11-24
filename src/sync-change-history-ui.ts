// SPDX-License-Identifier: GPL-3.0-only
import { Modal } from 'obsidian'
import type MyPlugin from '../main'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { clearSyncChanges, readSyncChanges, syncHistoryEnabled, syncHistoryLimit, syncHistoryWriteFailed } from './sync-change-history'
import type { SyncHistoryRow } from './sync-change-history'

const dialogs = new WeakMap<MyPlugin, Modal>()

function actionLabels(t: UiText): Record<SyncHistoryRow['action'], string> {
    return {
        add: t('Note added', 'Добавлена запись'), edit: t('Fields changed', 'Изменены поля'),
        delete: t('Note deleted', 'Удалена запись'), move: t('Deck changed', 'Изменена колода'),
        tags: t('Tags changed', 'Изменены теги'), suspend: t('Card suspended', 'Карточка приостановлена'),
        unsuspend: t('Card resumed', 'Карточка возобновлена'), link: t('Note linked', 'Установлена связь'),
        unlink: t('Link removed', 'Удалена связь'), skip: t('Skipped', 'Пропущено'),
        error: t('Failed', 'Ошибка'), unknown: t('Outcome unknown', 'Результат не подтверждён'),
        cleanup: t('Deletion directive processed', 'Обработана директива удаления'),
        media: t('Attachment sent to Anki', 'Вложение отправлено в Anki'),
        'id-date': t('ID marker date updated', 'Обновлена дата маркера ID'),
        normalize: t('Separator spacing fixed', 'Исправлены пробелы у разделителя'), check: t('Checked', 'Проверено'),
    }
}

class SyncChangeHistoryModal extends Modal {
    private query = ''
    private mode = ''
    private direction = ''
    private limit = 40
    private rows: SyncHistoryRow[] = []
    private closed = false
    private generation = 0
    private readonly t: UiText

    constructor(private readonly plugin: MyPlugin) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.titleEl.setText(this.t('Sync change history', 'Журнал изменений синхронизации'))
        installModalLayout(this, this.t)
        void this.reload()
    }

    onClose(): void {
        this.closed = true
        this.rows = []
        dialogs.delete(this.plugin)
        this.contentEl.empty()
    }

    private async reload(): Promise<void> {
        const generation = ++this.generation
        let error = false
        let rows: SyncHistoryRow[] = []
        try { rows = await readSyncChanges(this.plugin) } catch { error = true }
        if (this.closed || generation !== this.generation) return
        this.rows = rows
        this.render(error)
    }

    private render(readError: boolean): void {
        const { contentEl: root, t } = this
        root.empty()
        if (!syncHistoryEnabled(this.plugin)) {
            root.createEl('p', { text: t('Recording is off.', 'Запись журнала выключена.') })
        }
        if (readError || syncHistoryWriteFailed(this.plugin)) root.createEl('p', { attr: { role: 'alert' }, text: readError
            ? t('Could not read the history file.', 'Не удалось прочитать журнал.')
            : t('Some operations could not be saved to the history during this session.',
                'Некоторые операции в этом сеансе не удалось сохранить в журнале.') })

        const tools = root.createDiv({ cls: 'modal-button-container' })
        tools.createEl('button', { text: t('Refresh', 'Обновить') }).onclick = () => { void this.reload() }
        if (this.rows.length || readError || syncHistoryWriteFailed(this.plugin)) {
            tools.createEl('button', { text: t('Clear history', 'Очистить журнал') }).onclick = () => this.showClearPrompt()
        }
        if (!this.rows.length) {
            if (!readError) root.createEl('p', { text: t('No recorded operations yet.', 'Записанных операций пока нет.') })
            return
        }
        root.createEl('p', { text: t(`Up to ${syncHistoryLimit} recent operations. Larger entries use more space and shorten the history.`,
            `Хранится до ${syncHistoryLimit} последних операций. Если значения полей большие, в журнал поместится меньше записей.`) })
        const filters = root.createDiv({ cls: 'rudonium-history-filters' })
        const search = filters.createEl('label', { text: t('Search ', 'Поиск ') }).createEl('input', {
            attr: { type: 'search', placeholder: t('Note ID, file, field…', 'ID записи, файл, поле…') },
        })
        search.value = this.query
        const modeLabels = { 'one-way': t('One-way', 'Односторонняя'), 'two-way': t('Bidirectional', 'Двусторонняя') }
        const directionLabels = { 'to-anki': 'Obsidian → Anki', 'to-obsidian': 'Anki → Obsidian',
            local: t('Within Obsidian', 'Внутри Obsidian'), none: t('No direction', 'Без направления') }
        const filter = (name: string, options: Record<string, string>, current: string) => {
            const select = filters.createEl('label', { text: name + ' ' }).createEl('select')
            select.createEl('option', { value: '', text: t('All', 'Все') })
            for (const [value, text] of Object.entries(options)) select.createEl('option', { value, text })
            select.value = current
            return select
        }
        const mode = filter(t('Mode', 'Режим'), modeLabels, this.mode)
        const direction = filter(t('Direction', 'Направление'), directionLabels, this.direction)
        const list = root.createDiv()
        const actions = actionLabels(t)
        const draw = () => {
            list.empty()
            const query = this.query.trim().toLocaleLowerCase()
            const matches = this.rows.filter(row => (!this.mode || row.mode === this.mode) &&
                (!this.direction || row.direction === this.direction) && (!query || [row.path, row.noteId, row.title, row.profile,
                    actions[row.action], row.detail, ...(row.fields ?? []).map(field => field.name)]
                    .some(value => value !== undefined && String(value).toLocaleLowerCase().includes(query))))
            if (!matches.length) list.createEl('p', { text: t('No matching operations.', 'Подходящих операций нет.') })
            const locale = this.plugin.settings.INTERFACE_LANGUAGE === 'ru' ? 'ru' : 'en'
            const date = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' })
            for (const row of matches.slice(0, this.limit)) {
                const item = list.createEl('details')
                const identity = row.title || row.path || row.profile
                item.createEl('summary', { text: [date.format(new Date(row.at)), actions[row.action], identity,
                    row.noteId && `ID ${row.noteId}`].filter(Boolean).join(' · ') })
                item.createEl('p', { text: [modeLabels[row.mode], directionLabels[row.direction], row.profile, row.path,
                    row.noteId && `ID ${row.noteId}`].filter(Boolean).join(' · ') })
                if (row.detail) item.createEl('p', { text: row.detail })
                for (const field of row.fields ?? []) {
                    item.createEl('strong', { text: field.name })
                    for (const [label, value] of [[t('Before', 'Было'), field.before], [t('After', 'Стало'), field.after]] as const) {
                        item.createDiv({ text: label })
                        item.createEl('pre', { cls: 'rudonium-pre-wrap', text: value === undefined
                            ? t('(Not recorded)', '(Нет данных)') : value || t('(Empty)', '(Пусто)') })
                    }
                }
                if (row.omittedFields) item.createEl('p', { text: t(`Additional fields omitted: ${row.omittedFields}.`,
                    `Ещё полей сверх лимита: ${row.omittedFields}.`) })
            }
            if (this.limit < matches.length) list.createEl('button', { text: t('Show more', 'Показать ещё') })
                .onclick = () => { this.limit += 40; draw() }
        }
        const update = () => {
            this.query = search.value
            this.mode = mode.value
            this.direction = direction.value
            this.limit = 40
            draw()
        }
        search.oninput = mode.onchange = direction.onchange = update
        draw()
    }

    private showClearPrompt(): void {
        ++this.generation
        const { contentEl: root, t } = this
        root.empty()
        root.createEl('p', { text: t('Delete all recorded sync changes from this vault?', 'Удалить весь журнал изменений из этого хранилища?') })
        const tools = root.createDiv({ cls: 'modal-button-container' })
        const cancel = tools.createEl('button', { text: t('Cancel', 'Отмена') })
        cancel.onclick = () => { void this.reload() }
        const confirm = tools.createEl('button', { text: t('Delete history', 'Удалить журнал'), cls: 'mod-warning' })
        confirm.onclick = async () => {
            confirm.disabled = cancel.disabled = true
            try { await clearSyncChanges(this.plugin); if (!this.closed) await this.reload() } catch {
                if (this.closed) return
                root.createEl('p', { attr: { role: 'alert' }, text: t('Could not clear the history.', 'Не удалось очистить журнал.') })
                confirm.disabled = cancel.disabled = false
            }
        }
        cancel.focus()
    }
}

export function openSyncChangeHistory(plugin: MyPlugin): void {
    if (dialogs.has(plugin)) return
    const dialog = new SyncChangeHistoryModal(plugin)
    dialogs.set(plugin, dialog)
    dialog.open()
}
