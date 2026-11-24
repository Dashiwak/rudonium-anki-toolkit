/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type MyPlugin from '../main'

type LayoutSettings = Pick<MyPlugin, 'settings'> & Partial<Pick<MyPlugin, 'app'>>
export type LayoutStorage = MyPlugin['app'] & {
    loadLocalStorage?(key: string): unknown
    saveLocalStorage?(key: string, value: unknown): void
}
const layoutKey = 'rudonium-anki-toolkit:settings-sections-v1'
const openGroups = new WeakMap<LayoutSettings, Map<string, boolean>>()

function remembered(plugin: LayoutSettings): Map<string, boolean> {
    let state = openGroups.get(plugin)
    if (state) return state
    state = new Map()
    try {
        const stored = (plugin.app as LayoutStorage | undefined)?.loadLocalStorage?.(layoutKey)
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            for (const [key, open] of Object.entries(stored)) if (typeof open === 'boolean') state.set(key, open)
        }
    } catch { /* Keep the layout in memory if local storage is unavailable. */ }
    openGroups.set(plugin, state)
    return state
}

function persist(plugin: LayoutSettings, groups: Map<string, boolean>): void {
    try { (plugin.app as LayoutStorage | undefined)?.saveLocalStorage?.(layoutKey, Object.fromEntries(groups)) }
    catch { /* The current session still retains these preferences. */ }
}

export function rememberGroup(details: HTMLDetailsElement, plugin: LayoutSettings, key: string, initial = false): void {
    if (details.getAttribute('data-rudonium-settings-group')) return
    details.setAttribute('data-rudonium-settings-group', key)
    const groups = remembered(plugin)
    if (!groups.has(key)) groups.set(key, initial)
    details.open = groups.get(key) ?? initial
    const previous = details.ontoggle
    details.ontoggle = event => {
        previous?.call(details, event)
        if (details.isConnected === false || (groups.get(key) ?? initial) === details.open) return
        groups.set(key, details.open)
        persist(plugin, groups)
    }
}

export function createSettingsGroup(container: HTMLElement, plugin: LayoutSettings, key: string,
    title: string, description?: string, open = false): HTMLElement {
    const details = container.createEl('details', { cls: ['rudonium-settings-group', 'anki-settings-disclosure'] })
    details.createEl('summary', { text: title })
    const body = details.createDiv({ cls: 'rudonium-settings-group-body' })
    if (description) body.createEl('p', { text: description })
    rememberGroup(details, plugin, key, open)
    return body
}

export function renderSettingsGroup(container: HTMLElement, plugin: LayoutSettings, key: string, title: string,
    render: (body: HTMLElement) => void, description?: string, open = false): HTMLElement {
    const body = createSettingsGroup(container, plugin, key, title, description, open)
    render(body)
    const heading = Array.from(body.querySelectorAll<HTMLElement>('.setting-item-heading, h3, h4'))
        .find(element => element.textContent?.trim() === title)
    heading?.remove()
    return body
}

export function finalizeSettingsLayout(container: HTMLElement, _plugin: LayoutSettings): void {
    container.classList.add('rudonium-settings-pane')
}

export function saveSettingsLayout(container: HTMLElement, plugin: LayoutSettings): void {
    const groups = remembered(plugin)
    let changed = false
    for (const details of Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-rudonium-settings-group]'))) {
        const key = details.getAttribute('data-rudonium-settings-group')
        if (key && (groups.get(key) ?? false) !== details.open) {
            groups.set(key, details.open)
            changed = true
        }
    }
    if (changed) persist(plugin, groups)
}

export function setAllSettingsGroupsOpen(container: HTMLElement, plugin: LayoutSettings, open: boolean): void {
    for (const details of Array.from(container.querySelectorAll<HTMLDetailsElement>('details'))) details.open = open
    saveSettingsLayout(container, plugin)
}

export function redrawSettingsPreservingLayout(container: HTMLElement, plugin: LayoutSettings, redraw: () => void): void {
    saveSettingsLayout(container, plugin)
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
