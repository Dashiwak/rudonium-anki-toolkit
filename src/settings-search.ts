// SPDX-License-Identifier: GPL-3.0-only
import { Notice, Setting, setIcon } from 'obsidian'
import { withFastScanReadLock } from './fast-scan'
import type MyPlugin from '../main'
import { createFolderTree, vaultFolderEntries } from './folder-tree'
import { uiDiagnostic, uiFor } from './interface-language'
import type { LayoutStorage } from './settings-layout'
import { createSettingsGroup } from './settings-layout'

const folderBranchesKey = 'rudonium-anki-toolkit:folder-tag-branches-v1'
const views = new WeakMap<MyPlugin, { expanded: Set<string>; query: string }>()
type TagMap = Record<string, string>

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
        const storage: LayoutStorage = plugin.app
        let view = views.get(plugin)
        if (!view) {
            let branches: unknown
            try { branches = storage.loadLocalStorage?.(folderBranchesKey) } catch { /* Use the default tree. */ }
            const paths = Array.isArray(branches) ? branches.filter((path): path is string => typeof path === 'string') : []
            view = { expanded: new Set(paths), query: '' }
            views.set(plugin, view)
        }
        const settings = plugin.settings as unknown as Record<string, TagMap | undefined>
        let saveTimer: number | undefined
        let dirty = false
        const flush = async () => {
            if (!dirty) return
            dirty = false
            window.clearTimeout(saveTimer)
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
            onBranchToggle: expanded => {
                try { storage.saveLocalStorage?.(folderBranchesKey, [...expanded]) } catch { /* Retain the session view. */ }
            },
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
                    const values = settings[tagKey] ??= {}
                    if (input.value.trim()) {
                        // Ordinary vault folder names can include "__proto__" and "constructor".
                        Object.defineProperty(values, entry.path, { value: input.value, enumerable: true, configurable: true, writable: true })
                    } else delete values[entry.path]
                    dirty = true
                    window.clearTimeout(saveTimer)
                    saveTimer = window.setTimeout(() => { void flush() }, 300)
                }
                input.onchange = () => { void flush() }
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

export function installIgnoredFilesSetting(container: HTMLElement, plugin: MyPlugin): void {
    const initial = plugin.settings.LEGACY_IGNORED_FILE_GLOBS
    if (!Array.isArray(initial)) return
    const t = uiFor(plugin.settings)
    const body = createSettingsGroup(container, plugin, 'ignored-files', t('Ignored files', 'Исключённые файлы'))
    new Setting(body).setName(t('File patterns to exclude', 'Шаблоны исключаемых файлов'))
        .setDesc(t('Patterns imported from Obsidian To Anki. Enter one glob pattern per line.',
            'Шаблоны из Obsidian To Anki. Введите по одному glob-шаблону пути в каждой строке.'))
        .addTextArea(area => {
            area.setValue(initial.join('\n'))
            area.inputEl.rows = 4
            area.inputEl.addEventListener('blur', () => {
                const value = area.getValue().split(/\r?\n/).filter(line => line.trim().length)
                if (value.join('\n') === plugin.settings.LEGACY_IGNORED_FILE_GLOBS?.join('\n')) return
                area.setDisabled(true)
                void withFastScanReadLock(plugin, async () => {
                    const previous = plugin.settings.LEGACY_IGNORED_FILE_GLOBS
                    plugin.settings.LEGACY_IGNORED_FILE_GLOBS = value
                    try { await plugin.saveAllData() } catch (error) {
                        plugin.settings.LEGACY_IGNORED_FILE_GLOBS = previous
                        throw error
                    }
                }).catch(error => new Notice(uiDiagnostic(error, t))).finally(() => {
                    area.setValue((plugin.settings.LEGACY_IGNORED_FILE_GLOBS ?? []).join('\n')).setDisabled(false)
                })
            })
        })
}
