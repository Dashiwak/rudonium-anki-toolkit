// SPDX-License-Identifier: GPL-3.0-only
import { MarkdownView, Modal, Notice } from 'obsidian'
import type { Editor } from 'obsidian'
import type MyPlugin from '../main'
import { uiDiagnostic, uiFor } from './interface-language'
import { insertPageField, pageFieldChoices } from './page-field-insertion'
import { sameEditorText } from './markdown-pipeline'

function openPageFieldEditor(plugin: MyPlugin, editor: Editor, view: MarkdownView): void {
    const t = uiFor(plugin.settings)
    const file = view.file
    if (!file || view.getMode() !== 'source') return
    const path = file.path
    let source = editor.getValue()
    const choices = pageFieldChoices(source, plugin.settings, plugin.fields_dict)
    if (!choices) {
        new Notice(t('Open an Anki page marked with #anki-page.', 'Откройте страницу Anki с меткой #anki-page.'))
        return
    }
    const { model } = choices
    if (!choices.fields.length) {
        new Notice(t('No additional fields to add for ', 'Нет доступных дополнительных полей для типа ') + model + '.')
        return
    }
    const schema = [...plugin.fields_dict[model]]
    const modal = new Modal(plugin.app)
    modal.titleEl.setText(t('Add Anki page field', 'Добавить поле страницы Anki'))
    modal.contentEl.createEl('p', { text: path + ' · ' + model, cls: 'setting-item-description' })
    const form = modal.contentEl.createEl('form')
    const select = form.createEl('label', { text: t('Field', 'Поле') }).createEl('select')
    const valueLabel = form.createDiv().createEl('label', { text: t('Value', 'Значение') })
    const input = valueLabel.createEl('textarea')
    input.rows = 4
    input.required = true
    input.classList.add('rudonium-full-width-field')
    const status = form.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
    const buttons = form.createDiv({ cls: 'modal-button-container' })
    buttons.createEl('button', { text: t('Cancel', 'Отмена'), attr: { type: 'button' } }).onclick = () => modal.close()
    const another = buttons.createEl('button', { text: t('Insert and add another', 'Вставить и добавить ещё'), attr: { type: 'button' } })
    const submit = buttons.createEl('button', { text: t('Insert field', 'Вставить поле'), cls: 'mod-cta', attr: { type: 'submit' } })
    let finished = false
    const update = () => {
        submit.disabled = finished || !input.value.trim()
        another.disabled = submit.disabled || another.hidden
        if (!finished) status.setText('')
    }
    const showFields = (fields: readonly string[]) => {
        select.empty()
        for (const name of fields) select.createEl('option', { text: name, value: name })
        select.value = fields[0]
        input.value = ''
        another.hidden = fields.length < 2
        update()
        if (fields.length === 1) input.focus()
        else select.focus()
    }
    input.oninput = update
    select.onchange = update
    const staleMessage = t('The note or note type changed. Reopen the command to use the current version.',
        'Заметка или тип записи изменились. Откройте команду ещё раз для текущей версии.')
    const insert = (keepOpen: boolean) => {
        if (finished || !input.value.trim() || keepOpen && another.hidden) return
        try {
            const workspace = plugin.app.workspace
            const liveSchema = plugin.fields_dict?.[model]
            const otherEdits = workspace.getLeavesOfType('markdown').some(({ view: other }) => other !== view &&
                other instanceof MarkdownView && other.file === file && other.getMode() === 'source' &&
                !sameEditorText(other.getViewData(), other.data) && !sameEditorText(other.editor.getValue(), source))
            const stale = view.file !== file || file.path !== path || plugin.app.vault.getAbstractFileByPath(path) !== file ||
                workspace.getActiveViewOfType(MarkdownView) !== view || view.getMode() !== 'source' || view.editor !== editor ||
                editor.getValue() !== source || otherEdits || !liveSchema || schema.length !== liveSchema.length ||
                schema.some((name, i) => name !== liveSchema[i])
            if (stale || pageFieldChoices(source, plugin.settings, plugin.fields_dict)?.model !== model) {
                finished = true
                update()
                status.setText(staleMessage)
                return
            }
            const edit = insertPageField(source, plugin.settings, plugin.fields_dict, select.value, input.value)
            editor.replaceRange(edit.insert, editor.offsetToPos(edit.offset))
            finished = true
            if (!keepOpen) { modal.close(); return }
            const expected = source.slice(0, edit.offset) + edit.insert + source.slice(edit.offset)
            source = editor.getValue()
            if (source !== expected) {
                update()
                status.setText(staleMessage)
                return
            }
            const next = pageFieldChoices(source, plugin.settings, plugin.fields_dict)
            if (!next || next.model !== model || !next.fields.length) { modal.close(); return }
            finished = false
            showFields(next.fields)
        } catch (error) { status.setText(uiDiagnostic(error, t)) }
    }
    form.onsubmit = event => { event.preventDefault(); insert(false) }
    another.onclick = () => insert(true)
    input.onkeydown = event => {
        if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            if (!submit.disabled) submit.click()
        }
    }
    modal.open()
    showFields(choices.fields)
}

export function registerPageFieldEditor(plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    plugin.addCommand({ id: 'add-anki-page-field', name: t('Add Anki page field…', 'Добавить поле страницы Anki…'),
        editorCallback: (editor, context) => {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
            if (!view || view.file !== context.file || view.editor !== editor) return
            try { openPageFieldEditor(plugin, editor, view) }
            catch (error) { new Notice(uiDiagnostic(error, t)) }
        } })
}
