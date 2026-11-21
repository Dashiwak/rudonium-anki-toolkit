// SPDX-License-Identifier: GPL-3.0-only
import { MarkdownView, Modal, Notice } from 'obsidian'
import type MyPlugin from '../main'
import { uiFor } from './interface-language'
import { prepareFrozenFields } from './frozen-fields'
import type { FrozenFields } from './frozen-fields'
import { pageHeading, readPageCard } from './page-card'
import { pageFieldIsAvailable } from './page-named-fields'
import { isBidirectionalFieldName } from './bidirectional-fields'
import type { PageCard } from './page-card'
import { settingToData } from './setting-to-data'

function sourceView(plugin: MyPlugin): MarkdownView | undefined {
    const workspace = plugin.app.workspace
    const active = workspace.getActiveViewOfType(MarkdownView)
    if (active?.file && active.getMode() === 'source') return active
    const file = workspace.getActiveFile()
    if (!file || active) return
    const views = workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
        .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file && view.getMode() === 'source')
    return views.length === 1 ? views[0] : undefined
}

export function openFrozenFields(plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const view = sourceView(plugin)
    if (!view?.file) {
        new Notice(t('Open a Markdown note in editing mode first.', 'Сначала откройте заметку Markdown в режиме редактирования.'))
        return
    }
    const original = view.editor.getValue()
    let page: PageCard | undefined
    if (pageHeading(original)) {
        try {
            page = readPageCard(original, plugin.settings.CUSTOM_REGEXPS ?? {}, plugin.settings.Syntax, plugin.settings.PAGE_MODEL)
            if (!page) throw new Error(t('Choose the page note type in settings first.', 'Сначала выберите тип записи для страниц в настройках.'))
        } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error))
            return
        }
    }
    const modelNames = Object.keys(plugin.fields_dict ?? {}).filter(name => (!page || name === page.model) && plugin.fields_dict[name]?.length)
        .sort((a, b) => a.localeCompare(b))
    if (!modelNames.length) {
        new Notice(t('Use Refresh note types in settings to load the field names from Anki.',
            'Обновите типы записей в настройках, чтобы загрузить из Anki названия полей.'))
        return
    }
    const file = view.file
    const openView = view
    const dictionary = plugin.fields_dict
    const marker = plugin.settings.Syntax['Frozen Fields Line']
    const modal = new Modal(plugin.app)
    modal.titleEl.setText(t('Shared fields in this note', 'Общие поля этой заметки'))
    modal.contentEl.createEl('p', { text: page ? t(
        'Shared fields on this page are sent from Markdown in both sync modes.',
        'В обоих режимах значения общих полей этой страницы берутся из Markdown.') : t(
        'During export these values are appended to the corresponding fields of every note of this type in this file.',
        'При экспорте общие значения добавляются к соответствующим полям каждой записи этого типа в файле.') })
    if (!page && plugin.settings.BIDIRECTIONAL_SYNC === true) modal.contentEl.createEl('p', { text: t(
        'Use regular export for shared text. If Front or Back includes a shared value, two-way sync skips editing the card’s text.',
        'Общий текст передаётся обычным экспортом. Если он добавлен к Front или Back, двусторонняя синхронизация пропускает изменение текста этой карточки.') })
    const fileLabel = modal.contentEl.createEl('p', { text: file.path })
    fileLabel.addClass('setting-item-description')
    const model = modal.contentEl.createEl('label', { text: t('Note type ', 'Тип записи ') }).createEl('select')
    for (const name of modelNames) model.createEl('option', { text: name, value: name })
    const list = modal.contentEl.createDiv()
    const add = modal.contentEl.createEl('button', { text: t('+ Add field', '+ Добавить поле') })
    const preview = modal.contentEl.createEl('pre', { attr: { 'aria-label': t('Markdown preview', 'Предпросмотр Markdown') } })
    const status = modal.contentEl.createEl('p', { attr: { role: 'status' } })
    const actions = modal.contentEl.createDiv({ cls: 'modal-button-container' })
    actions.createEl('button', { text: t('Cancel', 'Отмена') }).onclick = () => modal.close()
    const apply = actions.createEl('button', { cls: 'mod-cta', text: t('Save in note', 'Сохранить в заметке') })
    const message = (error: unknown) => error instanceof Error ? error.message : String(error)
    let pattern: RegExp
    let shared: FrozenFields | undefined
    let edit: ReturnType<FrozenFields['replaceAll']>
    const pageSettings = () => ({ file: plugin.settings.FILE_LINK_FIELDS?.[page!.model],
        context: plugin.settings.CONTEXT_FIELDS?.[page!.model] })
    const fieldChoices = (all: string[] = dictionary[model.value] ?? []) => {
        return page ? all.filter(name => isBidirectionalFieldName(name) && !page!.namedFields?.has(name) &&
            pageFieldIsAvailable(name, page!, all, pageSettings())) : all.slice()
    }
    let names: string[] = []
    let rows: Array<{ field: string; value: string }> = []
    const unused = () => names.filter(name => !rows.some(row => row.field === name))
    const redraw = () => {
        edit = undefined
        apply.disabled = true
        apply.setText(t('Save in note', 'Сохранить в заметке'))
        status.setText('')
        preview.setText('')
        add.disabled = !shared || !unused().length
        if (!shared) return
        // Один незаполненный ряд при открытии нового блока позволяет сразу начать ввод.
        const empty = !shared.preview && rows.every(row => !row.value)
        model.disabled = !empty && (rows.length !== shared.values.size ||
            rows.some(row => shared!.values.get(row.field) !== row.value))
        model.title = model.disabled ? t('Save or cancel these changes before choosing another note type.',
            'Сохраните или отмените изменения перед выбором другого типа записи.') : ''
        if (empty) return
        try {
            edit = shared.replaceAll(rows.map(row => [row.field, row.value] as const))
            preview.setText(edit?.preview ?? shared.preview)
            if (edit && !rows.length) {
                apply.setText(t('Remove block', 'Удалить блок'))
                status.setText(t('Saving will remove this note type’s shared-fields block.', 'При сохранении блок общих полей этого типа будет удалён.'))
            }
            apply.disabled = !edit
        } catch (error) { status.setText(message(error)) }
    }
    const drawRows = (focus?: number) => {
        list.empty()
        const available = unused()
        rows.forEach((row, index) => {
            const holder = list.createDiv({ cls: 'setting-item' })
            holder.classList.add('rudonium-frozen-fields-holder')
            const field = holder.createEl('label', { text: t('Anki field ', 'Поле Anki ') }).createEl('select')
            for (const name of names) {
                if (row.field === name || available.includes(name)) field.createEl('option', { text: name, value: name })
            }
            field.value = row.field
            const value = holder.createEl('label', { text: t('Shared value ', 'Общее значение ') }).createEl('input', { type: 'text' })
            value.value = row.value
            value.oninput = () => { row.value = value.value; redraw() }
            field.onchange = () => { row.field = field.value; drawRows(index) }
            const remove = holder.createEl('button', { text: t('Remove field', 'Убрать поле'),
                attr: { 'aria-label': t('Remove field ', 'Убрать поле ') + row.field } })
            remove.onclick = () => {
                rows.splice(index, 1)
                drawRows(Math.min(index, rows.length - 1))
                if (!rows.length) add.focus()
            }
            if (focus === index) field.focus()
        })
        redraw()
    }
    add.onclick = () => {
        const name = unused()[0]
        if (!shared || !name) return
        rows.push({ field: name, value: '' })
        drawRows(rows.length - 1)
    }
    const selectModel = () => {
        shared = undefined
        rows = []
        names = fieldChoices()
        try {
            shared = prepareFrozenFields(original, marker, model.value, dictionary[model.value], pattern, t,
                page ? { page, syntax: plugin.settings.Syntax, ...pageSettings() } : undefined)
            rows = [...shared.values].map(([field, value]) => ({ field, value }))
            if (!rows.length && names.length) rows.push({ field: names[0], value: '' })
            drawRows()
            if (page && !names.length) status.setText(t('This page has no unused additional fields.',
                'У этой страницы нет свободных дополнительных полей.'))
        } catch (error) {
            drawRows()
            model.disabled = false
            status.setText(message(error))
        }
    }
    model.onchange = selectModel
    apply.onclick = () => {
        if (!edit || !shared) return
        const liveFields = plugin.fields_dict?.[model.value]
        const choices = fieldChoices(liveFields ?? [])
        if (openView.file !== file || sourceView(plugin) !== openView || openView.editor.getValue() !== original ||
            plugin.settings.Syntax['Frozen Fields Line'] !== marker || !liveFields || liveFields.length !== dictionary[model.value].length ||
            names.length !== choices.length || names.some((name, index) => name !== choices[index])) {
            status.setText(t('The note or settings changed. Reopen this dialog to preview the current version.',
                'Заметка или настройки изменились. Откройте окно ещё раз для актуального предпросмотра.'))
            edit = undefined
            apply.disabled = true
            return
        }
        try {
            if (page && readPageCard(original, plugin.settings.CUSTOM_REGEXPS ?? {}, plugin.settings.Syntax,
                plugin.settings.PAGE_MODEL)?.model !== model.value) throw new Error(t(
                    'The page type changed. Reopen this dialog.', 'Тип записи страницы изменился. Откройте окно заново.'))
            shared.verify(edit)
        } catch (error) {
            status.setText(message(error))
            apply.disabled = true
            return
        }
        const editor = openView.editor
        editor.replaceRange(edit.replacement, editor.offsetToPos(edit.start), editor.offsetToPos(edit.end))
        modal.close()
    }
    add.disabled = model.disabled = apply.disabled = true
    modal.open()
    void settingToData(plugin.app, plugin.settings, dictionary, []).then(data => {
        pattern = data.FROZEN_REGEXP
        model.disabled = false
        selectModel()
    }).catch(error => status.setText(t('Could not load the shared-fields syntax. ', 'Не удалось загрузить синтаксис общих полей. ') + message(error)))
}

export function registerFrozenFieldsCommand(plugin: MyPlugin): void {
    plugin.addCommand({ id: 'edit-shared-fields', name: uiFor(plugin.settings)('Edit shared fields in this note', 'Общие поля этой заметки'),
        callback: () => openFrozenFields(plugin) })
}
