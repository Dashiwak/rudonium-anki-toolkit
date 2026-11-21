/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import type MyPlugin from '../main'

type LayoutSettings = Pick<MyPlugin, 'settings'>
const openGroups = new WeakMap<LayoutSettings, Map<string, boolean>>()

function remembered(plugin: LayoutSettings): Map<string, boolean> {
    let state = openGroups.get(plugin)
    if (!state) { state = new Map(); openGroups.set(plugin, state) }
    return state
}

/** Раскрытие хранится только в памяти интерфейса и не сбрасывает кеш карточек. */
function rememberGroup(details: HTMLDetailsElement, plugin: LayoutSettings, key: string, initial: boolean): void {
    if (details.getAttribute('data-rudonium-settings-group')) return
    details.setAttribute('data-rudonium-settings-group', key)
    details.open = remembered(plugin).get(key) ?? initial
    const previous = details.ontoggle
    details.ontoggle = event => {
        previous?.call(details, event)
        if (details.isConnected !== false) remembered(plugin).set(key, details.open)
    }
}

/** Оборачивает существующий раздел, не пересоздавая его элементы и обработчики. */
export function createSettingsGroup(container: HTMLElement, plugin: LayoutSettings, key: string,
    title: string, description?: string, open = false): HTMLElement {
    const details = container.createEl('details', { cls: ['rudonium-settings-group', 'anki-settings-disclosure'] })
    details.createEl('summary', { text: title })
    const body = details.createDiv({ cls: 'rudonium-settings-group-body' })
    if (description) body.createEl('p', { text: description })
    rememberGroup(details, plugin, key, open)
    return body
}

/** Позволяет использовать штатный установщик раздела без повторного заголовка. */
export function renderSettingsGroup(container: HTMLElement, plugin: LayoutSettings, key: string, title: string,
    render: (body: HTMLElement) => void, description?: string, open = false): HTMLElement {
    const body = createSettingsGroup(container, plugin, key, title, description, open)
    render(body)
    const heading = Array.from(body.querySelectorAll<HTMLElement>('.setting-item-heading, h3, h4'))
        .find(element => element.textContent?.trim() === title)
    heading?.remove()
    return body
}

/** Запоминаем раскрытие разделов, созданных штатными настройками. */
export function finalizeSettingsLayout(container: HTMLElement, plugin: LayoutSettings): void {
    let other = 0
    for (const details of Array.from(container.querySelectorAll<HTMLDetailsElement>('details.anki-settings-disclosure'))) {
        rememberGroup(details, plugin, `syntax-and-defaults-${other++}`, false)
    }
}

/** Перерисовка языка сохраняет раскрытые группы, поиск таблиц и положение страницы. */
export function redrawSettingsPreservingLayout(container: HTMLElement, plugin: LayoutSettings, redraw: () => void): void {
    for (const details of Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-rudonium-settings-group]'))) {
        const key = details.getAttribute('data-rudonium-settings-group')
        if (key) remembered(plugin).set(key, details.open)
    }
    const queries = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="search"]')).map(input => input.value)
    const scroll: Array<{ element: HTMLElement; top: number; left: number }> = []
    for (let element: HTMLElement | null = container; element; element = element.parentElement) {
        scroll.push({ element, top: element.scrollTop, left: element.scrollLeft })
    }
    redraw()
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="search"]'))
    queries.forEach((query, index) => {
        const input = inputs[index]
        if (!input || input.value === query) return
        input.value = query
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    for (const { element, top, left } of scroll) { element.scrollTop = top; element.scrollLeft = left }
}
