// SPDX-License-Identifier: GPL-3.0-only
import { Notice, setIcon } from 'obsidian'
import type MyPlugin from '../main'
import { createFolderTree, vaultFolderEntries } from './folder-tree'
import { uiDiagnostic, uiFor } from './interface-language'
import { createSettingsGroup } from './settings-layout'

const views = new WeakMap<MyPlugin, { expanded: Set<string>; query: string }>()
type TagMap = Record<string, string>

/** Обходим хранилище только при открытии раздела. Дерево создаёт редакторы для видимых строк. */
export function installFolderTagSettings(container: HTMLElement, plugin: MyPlugin, tagKey: string): void {
    const t = uiFor(plugin.settings)
    // Some upstream layouts create the folder heading in display(), outside setup_folder_table().
    const previous = container.lastElementChild
    if ((previous?.tagName === 'H3' || previous?.classList.contains('setting-item-heading')) && /^folder (?:settings|table)$/i.test(previous.textContent?.trim() ?? '')) previous.remove()
    const body = createSettingsGroup(container, plugin, 'folders', t('Folder tags', 'Теги папок'),
        t('Separate tags with spaces. Nested folders also use their parent folders’ tags.',
            'Разделяйте теги пробелами. Вложенные папки также наследуют теги родительских папок.'))
    const details = body.parentElement as HTMLDetailsElement
    let mounted = false
    const mount = () => {
        if (mounted || !details.open) return
        mounted = true
        let view = views.get(plugin)
        if (!view) {
            view = { expanded: new Set(), query: '' }
            views.set(plugin, view)
        }
        const settings = plugin.settings as unknown as Record<string, TagMap | undefined>
        let saveTimer: ReturnType<typeof setTimeout> | undefined
        let dirty = false
        const flush = async () => {
            if (!dirty) return
            dirty = false
            clearTimeout(saveTimer)
            saveTimer = undefined
            try { await plugin.saveAllData() }
            catch (error) {
                dirty = true
                new Notice(t('Could not save folder tags. Press Enter in a tag field to retry.',
                    'Не удалось сохранить теги папок. Для повтора нажмите Enter в поле тегов.') + ' ' + uiDiagnostic(error, t))
            }
        }
        createFolderTree(body, {
            entries: vaultFolderEntries(plugin.app.vault), t, viewState: view,
            renderAction: (row, label, entry) => {
                label.classList.add('rudonium-settings-search-label')
                const icon = label.createSpan({ attr: { 'aria-hidden': 'true' } })
                setIcon(icon, 'folder')
                icon.classList.add('rudonium-text-muted')
                label.prepend(icon)
                const input = row.createEl('input', { attr: { type: 'text', autocomplete: 'off', spellcheck: 'false',
                    'aria-label': t(`Tags for ${entry.path}`, `Теги папки ${entry.path}`) } })
                row.classList.add('rudonium-settings-search-row')
                input.classList.add('rudonium-settings-search-input')
                const tags = settings[tagKey]
                input.value = tags && Object.prototype.hasOwnProperty.call(tags, entry.path) ? tags[entry.path] : ''
                input.oninput = () => {
                    const values = settings[tagKey] ??= Object.create(null)
                    if (input.value.trim()) {
                        // Ordinary vault folder names can include "__proto__" and "constructor".
                        Object.defineProperty(values, entry.path, { value: input.value, enumerable: true, configurable: true, writable: true })
                    } else delete values[entry.path]
                    dirty = true
                    clearTimeout(saveTimer)
                    saveTimer = setTimeout(flush, 300)
                }
                input.onchange = flush
                input.onkeydown = event => {
                    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void flush() }
                }
                return input
            },
        })
    }
    details.addEventListener('toggle', mount)
    mount()
}
