// SPDX-License-Identifier: GPL-3.0-only
import { Modal, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type { UiText } from './interface-language'
import { delimitedRule, readDelimitedRule } from './delimited-rule'

export function addRegexpWizard(container: HTMLElement, app: App, t: UiText, fields: readonly string[],
    expression: () => string, accept: (pattern: string, sample: string, values: string[]) => void): () => void {
    const label = t('Regular expression wizard', 'Мастер регулярных выражений')
    const open = container.createEl('button', { text: label })
    open.type = 'button'
    open.disabled = fields.length < 2
    let active: Modal | undefined
    open.onclick = () => {
        const dialog = active = new Modal(app)
        dialog.titleEl.setText(label)
        const body = dialog.contentEl
        dialog.onClose = () => { active = undefined; body.empty() }
        const prior = readDelimitedRule(expression())
        let count = prior && prior.count <= fields.length ? prior.count : 2
        let separator = prior?.separator ?? ':'
        let multiline = prior?.multiline === true
        let sampleEdited = false
        const example = () => {
            const values = fields.slice(0, count).map((_field, index) =>
                t('Value ' + (index + 1), 'Значение ' + (index + 1)))
            return multiline ? [':::anki', values.slice(0, -1).join(' ' + separator + ' '), values[count - 1], '',
                t('Second paragraph.', 'Второй абзац.'), ':::'].join('\n') : values.join(' ' + separator + ' ')
        }
        let sample = example()

        new Setting(body).setName(t('Answer layout', 'Формат ответа')).addDropdown(control => control
            .addOption('line', t('Single line', 'Одна строка'))
            .addOption('block', t('Multiple paragraphs', 'Несколько абзацев'))
            .setValue(multiline ? 'block' : 'line').onChange(value => { multiline = value === 'block'; updateExample() }))
        new Setting(body).setName(t('Number of fields', 'Количество полей')).addDropdown(control => {
            for (let n = 2; n <= fields.length; n++) control.addOption(String(n), String(n))
            control.setValue(String(count)).onChange(value => { count = Number(value); updateExample() })
        })
        let separatorInput: HTMLInputElement
        new Setting(body).setName(t('Field separator', 'Разделитель полей'))
            .setDesc(t('Enter literal characters, for example : or ||. Spaces around the separator are optional.',
                'Введите символы разделителя, например : или ||. Пробелы вокруг разделителя необязательны.'))
            .addText(control => { separatorInput = control.inputEl; control.setValue(separator).onChange(value => { separator = value; updateExample() }) })
        const sampleRow = new Setting(body).setName(t('Sample Markdown line', 'Пример строки Markdown'))
        let sampleInput: HTMLTextAreaElement
        sampleRow.addTextArea(control => {
            sampleInput = control.inputEl
            control.setValue(sample).onChange(value => { sampleEdited = true; sample = value; render() })
        })
        const preview = body.createDiv({ attr: { 'aria-live': 'polite' } })
        const details = body.createEl('details')
        details.createEl('summary', { text: t('Generated regular expression', 'Получившееся регулярное выражение') })
        const code = details.createEl('code')
        const actions = body.createDiv({ cls: 'modal-button-container' })
        actions.createEl('button', { text: t('Cancel', 'Отмена') }).onclick = () => dialog.close()
        const use = actions.createEl('button', { text: t('Use this format', 'Использовать формат'), cls: 'mod-cta' })
        function updateExample(): void {
            if (!sampleEdited) { sample = example(); sampleInput.value = sample }
            render()
        }
        function render(): void {
            preview.empty()
            separatorInput.disabled = multiline && count === 2
            sampleRow.setName(multiline ? t('Sample Markdown block', 'Пример блока Markdown') : t('Sample Markdown line', 'Пример строки Markdown'))
                .setDesc(multiline ? t('Put the question or header fields below :::anki. Write the last field underneath and end with ::: on its own line.',
                    'Под :::anki укажите вопрос или первые поля. Ниже напишите последнее поле с абзацами и завершите блок отдельной строкой :::.') : '')
            sampleInput.rows = multiline ? 8 : 2
            const pattern = delimitedRule(count, separator, multiline)
            code.setText(pattern ?? '')
            use.disabled = true
            use.onclick = null
            if (!pattern) {
                preview.setText(t('Enter a separator with no leading or trailing whitespace. The pattern must fit the export limit.',
                    'Введите разделитель без пробелов по краям. Выражение должно помещаться в лимит правила.'))
                return
            }
            if (sample.length > 16384) {
                preview.setText(t('Use a shorter sample line.', 'Возьмите более короткую строку для примера.'))
                return
            }
            const match = (multiline || !/[\r\n]/u.test(sample)) && new RegExp(pattern, 'm').exec(sample)
            const metadata = /^[ \t]*(?:[-*+][ \t]+)?(?:[Tt][Aa][Gg][Ss][ \t]*:|(?:<!--[ \t]*)?ID[ \t]*:)/u
            if (!match || match.index !== 0 || match[0].length !== sample.length || (!multiline && metadata.test(sample))) {
                preview.setText(multiline ? t('Check the header fields, the nonempty first answer line and both block markers.',
                    'Проверьте поля первой строки, непустую первую строку ответа и обе границы блока.') :
                    t(`Enter one card line with ${count} nonempty fields separated by “${separator}”. Tags: and ID: are reserved.`,
                    `Введите одну строку карточки с ${count} непустыми полями через «${separator}». Строки Tags: и ID: служебные.`))
                return
            }
            const values = match.slice(1)
            const list = preview.createEl('dl')
            for (let i = 0; i < count; i++) {
                list.createEl('dt', { text: fields[i] })
                const value = list.createEl('dd', { text: values[i] })
                if (multiline) value.classList.add('rudonium-pre-wrap')
            }
            use.disabled = false
            use.onclick = () => { dialog.close(); accept(pattern, sample, values) }
        }
        render()
        dialog.open()
    }
    return () => active?.close()
}
