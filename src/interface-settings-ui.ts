/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Notice, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { interfaceLanguage, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { redrawSettingsPreservingLayout } from './settings-layout'
import { supportUrl } from './plugin-identity'

export function registerSupportCommand(plugin: MyPlugin): void {
    plugin.addCommand({
        // Existing vault hotkeys and command links use this ID.
        id: 'open-gitverse-support',
        name: uiFor(plugin.settings)('Get help on GitFlic', 'Обратиться за помощью на GitFlic'),
        callback: () => { window.open(supportUrl, '_blank', 'noopener,noreferrer') },
    })
}

export function installSettingsHelp(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    container.createEl('a', { text: t('Rudonium help on GitFlic', 'Помощь по Rudonium на GitFlic'),
        attr: { href: supportUrl } })
}

export function installInterfaceLanguage(container: HTMLElement, plugin: MyPlugin, redraw: () => void): void {
    const t = uiFor(plugin.settings)
    const label = t('Interface Language', 'Язык интерфейса')
    new Setting(container).setName(label)
        .setDesc(t('Reload the plugin to update command names.', 'Для смены языка названий команд перезапустите плагин.'))
        .addDropdown(control => {
            control.selectEl.setAttribute('aria-label', label)
            control.addOption('en', 'English').addOption('ru', 'Русский')
                .setValue(interfaceLanguage(plugin.settings)).onChange(async value => {
                    if ((value !== 'en' && value !== 'ru') || value === interfaceLanguage(plugin.settings)) return
                    const previous = plugin.settings.INTERFACE_LANGUAGE
                    control.setDisabled(true)
                    plugin.settings.INTERFACE_LANGUAGE = value
                    try {
                        await plugin.saveAllData()
                    } catch (error) {
                        if (previous === undefined) delete plugin.settings.INTERFACE_LANGUAGE
                        else plugin.settings.INTERFACE_LANGUAGE = previous
                        control.setValue(interfaceLanguage(plugin.settings)).setDisabled(false)
                        console.error('[Rudonium] Could not save interface language', error)
                        new Notice(t('Could not save the interface language. Try again.',
                            'Не удалось сохранить язык интерфейса. Попробуйте ещё раз.'))
                        return
                    }
                    redrawSettingsPreservingLayout(container, plugin, redraw)
                    const refreshed = container.querySelector<HTMLSelectElement>('select.anki-interface-language')
                    refreshed?.focus({ preventScroll: true })
                })
            control.selectEl.classList.add('anki-interface-language')
        })

}

export function installProjectInfo(container: HTMLElement, plugin: MyPlugin, buildVersion: string): void {
    const t = uiFor(plugin.settings)
    const section = container.createEl('section', { cls: 'rudonium-settings-about' })
    new Setting(section).setName(t('About the plugin', 'О плагине')).setHeading()
    section.createEl('p', { text: `Rudonium Anki Toolkit ${buildVersion}` })
    if (plugin.manifest.version !== buildVersion) {
        section.createEl('p', { text: t(
            `Obsidian loaded manifest.json ${plugin.manifest.version}. Disable Rudonium, install main.js and manifest.json together from the ${buildVersion} release, then restart Obsidian.`,
            `Obsidian загрузил manifest.json версии ${plugin.manifest.version}. Отключите Rudonium, замените main.js и manifest.json файлами из выпуска ${buildVersion} и перезапустите Obsidian.`) })
    }
    const contact = section.createEl('p')
    contact.createSpan({ text: t('Author: dashiwak · ', 'Автор: dashiwak · ') })
    contact.createEl('a', { text: t('Questions and bug reports on GitFlic', 'Вопросы и сообщения об ошибках на GitFlic'),
        attr: { href: supportUrl } })
    const links = section.createEl('p')
    links.createEl('a', { text: 'GNU GPLv3', attr: { href: 'https://www.gnu.org/licenses/gpl-3.0.html' } })
    section.createEl('a', {
        text: t('Based on Obsidian to Anki by Pseudonium and contributors',
            'На основе Obsidian to Anki от Pseudonium и участников проекта'),
        attr: { href: 'https://github.com/ObsidianToAnki/Obsidian_to_Anki' },
    })
}

const fieldLabels: Readonly<Record<string, string>> = {
    Deck: 'Колода по умолчанию',
    Tag: 'Тег по умолчанию',
    'Add File Link': 'Добавлять ссылку на заметку',
    'Add Context': 'Добавлять контекст',
    CurlyCloze: 'Пропуски в фигурных скобках',
    'CurlyCloze - Highlights to Clozes': 'Преобразовывать выделение в пропуски',
    'ID Comments': 'Хранить ID в HTML-комментариях',
    'Add Date to Anki IDs': 'Дата рядом с ID Anki',
    'Add Obsidian Tags': 'Переносить теги Obsidian',
    'Begin Note': 'Начало блока карточки',
    'End Note': 'Конец блока карточки',
    'Begin Inline Note': 'Начало встроенной карточки',
    'End Inline Note': 'Конец встроенной карточки',
    'Target Deck Line': 'Директива целевой колоды',
    'File Tags Line': 'Директива тегов файла',
    'Delete Note Line': 'Директива удаления записи',
    'Frozen Fields Line': 'Директива фиксированных полей',
}

const fieldDescriptions: Readonly<Record<string, string>> = {
    Deck: 'Колода Anki для записей без явно заданного назначения.',
    Tag: 'Тег для экспортируемых записей Anki.',
    'Add File Link': 'Добавляет ссылку на исходную заметку в выбранное поле Anki.',
    'Add Context': 'Добавляет контекст заметки в выбранное поле Anki.',
    CurlyCloze: 'Преобразует текст в фигурных скобках в пропуски для типов записей Cloze.',
    'CurlyCloze - Highlights to Clozes': 'Преобразует выделение ==текст== в пропуск Cloze при включённой обработке скобок.',
    'ID Comments': 'Записывает числовой ID Anki внутри HTML-комментария.',
    'Add Date to Anki IDs': 'Ставит локальную дату после подтверждённого ID, перед пометками. Ранее записанные даты сохраняются.',
    'Add Obsidian Tags': 'Переносит #теги из полей заметки в теги Anki и убирает их из текста поля в Anki.',
}

export function legacySettingLabel(key: string, t: UiText): string {
    if (key === 'Scheduling Interval') return t('Auto-scan interval (minutes)', 'Интервал автосканирования (минуты)')
    const translation = fieldLabels[key]
    return typeof translation === 'string' ? t(key, translation) : key
}

export function legacySettingDescription(key: string, english: string, t: UiText): string {
    if (key === 'Scheduling Interval') return t('How often to scan notes for export to Anki. Set to 0 to scan manually.',
        'Как часто проверять заметки для экспорта в Anki. Установите 0 для ручного запуска.')
    const translation = fieldDescriptions[key]
    return typeof translation === 'string' ? t(english, translation) : english
}
