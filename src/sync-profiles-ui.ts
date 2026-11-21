/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal, Notice, Setting, TFolder } from 'obsidian'
import type MyPlugin from '../main'
import { savePluginDataInOrder, withFastScanReadLock } from './fast-scan'
import { createFolderTree, vaultFolderEntries } from './folder-tree'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { readSyncProfiles } from './sync-profiles'
import type { SyncFolderProfile } from './sync-profiles'
import { openExportRulesEditor } from './export-rules-ui'

type ProfileSettings = ReturnType<typeof readSyncProfiles>
type FolderRule = 'include' | 'exclude'

function labelKey(value: string): string {
    return value.trim().normalize('NFC').toLowerCase()
}

function missingFolders(plugin: MyPlugin, paths: readonly string[]): string[] {
    return paths.filter(path => !(plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder))
}

function profileDescription(plugin: MyPlugin, profile: SyncFolderProfile, t: UiText): string {
    const missing = new Set(missingFolders(plugin, [...profile.folders, ...profile.excludedFolders]))
    const describe = (paths: readonly string[]) => {
        const shown = paths.slice(0, 3).map(path => missing.has(path) ? t(`${path} (missing)`, `${path} (отсутствует)`) : path)
        if (paths.length > shown.length) {
            const remaining = paths.length - shown.length
            shown.push(t(`${remaining} more`, `ещё ${remaining}`))
        }
        return shown.join(', ')
    }
    const scope = `${t('Includes', 'Включено')} · ${describe(profile.folders) || t('All folders', 'Все папки')}`
    const excludes = profile.excludedFolders.length ? ` · ${t('Excludes', 'Исключено')} · ${describe(profile.excludedFolders)}` : ''
    const count = Array.isArray(profile.exportRules) ? profile.exportRules.length : 0
    return scope + excludes + (count ? t(` · Export rules: ${count}`, ` · Правил экспорта: ${count}`) : '')
}

/** Публикует изменения настроек после сохранения data.json под блокировкой сканирования. */
function saveProfiles(plugin: MyPlugin, change: (state: ProfileSettings) => ProfileSettings | undefined): Promise<void> {
    return withFastScanReadLock(plugin, () => savePluginDataInOrder(plugin, async () => {
        const next = change(readSyncProfiles(plugin.settings))
        if (!next) return
        const patch = { SYNC_FOLDER_PROFILES: next.profiles, ACTIVE_SYNC_FOLDER_PROFILE: next.activeId }
        await plugin.saveData({
            settings: { ...plugin.settings, ...patch },
            'Added Media': plugin.added_media,
            'File Hashes': plugin.file_hashes,
            fields_dict: plugin.fields_dict,
        })
        Object.assign(plugin.settings, patch)
    }))
}

function excludingParent(path: string, rules: ReadonlyMap<string, FolderRule>): string | undefined {
    for (let split = path.lastIndexOf('/'); split > 0; split = path.lastIndexOf('/', split - 1)) {
        const parent = path.slice(0, split)
        if (rules.get(parent) === 'exclude') return parent
    }
    return undefined
}

function assertUnchanged(profiles: readonly SyncFolderProfile[], expected: SyncFolderProfile, t: UiText): void {
    const actual = profiles.find(profile => profile.id === expected.id)
    const pathsEqual = (left: readonly string[], right: readonly string[]) =>
        left.length === right.length && left.every((path, index) => path === right[index])
    if (!actual || actual.name !== expected.name || !pathsEqual(actual.folders, expected.folders) ||
        !pathsEqual(actual.excludedFolders, expected.excludedFolders) ||
        JSON.stringify(actual.exportRules) !== JSON.stringify(expected.exportRules)) {
        throw new Error(t('This profile changed while you were editing it. Reopen it and try again.',
            'Профиль изменился во время редактирования. Откройте его снова и повторите попытку.'))
    }
}

class SyncProfilesModal extends Modal {
    private busy = false
    private closed = false

    constructor(private readonly plugin: MyPlugin, private readonly onChange: () => void) {
        super(plugin.app)
    }

    onOpen(): void {
        this.modalEl.classList.add('rudonium-modal-50rem')
        installModalLayout(this, uiFor(this.plugin.settings))
        this.showProfiles()
    }

    onClose(): void {
        this.closed = true
        this.contentEl.empty()
    }

    private showProfiles(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Manage Sync Profiles', 'Профили папок'))
        this.contentEl.empty()
        const { activeId, profiles } = readSyncProfiles(this.plugin.settings)
        if (!profiles.length) this.contentEl.createEl('p', { text: t('Create a profile to save a set of folders.',
            'Создайте профиль, чтобы сохранить набор папок для синхронизации.') })
        for (const profile of profiles) {
            const setting = new Setting(this.contentEl)
                .setName(profile.id === activeId ? t(`${profile.name} (active)`, `${profile.name} (активен)`) : profile.name)
                .setDesc(profileDescription(this.plugin, profile, t))
                .addButton(button => button.setButtonText(t('Edit', 'Изменить')).onClick(() => this.editProfile(profile)))
                .addButton(button => button.setButtonText(t('Export Rules', 'Правила экспорта')).onClick(() => {
                    openExportRulesEditor(this.plugin, profile, rules => saveProfiles(this.plugin, state => {
                        assertUnchanged(state.profiles, profile, t)
                        return { activeId: state.activeId, profiles: state.profiles.map(item =>
                            item.id === profile.id ? { ...item, exportRules: rules.length ? rules : undefined } : item) }
                    }), () => {
                        if (!this.closed) this.showProfiles()
                        this.onChange()
                    })
                }))
            setting.descEl.classList.add('rudonium-wrap-anywhere')
        }
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        footer.createEl('button', { text: t('New Profile', 'Создать профиль'), cls: 'mod-cta' }).onclick = () => this.editProfile()
    }

    private editProfile(profile?: SyncFolderProfile): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(profile ? t('Edit Sync Profile', 'Редактирование профиля папок')
            : t('New Sync Profile', 'Новый профиль папок'))
        this.contentEl.empty()
        const name = this.contentEl.createEl('label', { text: t('Profile name', 'Название профиля') }).createEl('input', { attr: { type: 'text' } })
        name.value = profile?.name ?? ''
        name.classList.add('rudonium-sync-profiles-name')
        const rules = new Map<string, FolderRule>()
        for (const path of profile?.folders ?? []) rules.set(path, 'include')
        for (const path of profile?.excludedFolders ?? []) rules.set(path, 'exclude')
        this.contentEl.createEl('p', {
            text: t('Choose Include or Exclude next to each folder. Rules apply to subfolders and exclusions take priority.',
                'Выберите «Включить» или «Исключить» рядом с папкой. Правила действуют и для вложенных папок. Исключения имеют приоритет.'),
        })
        const summary = this.contentEl.createDiv()
        summary.classList.add('rudonium-sync-profiles-summary')
        const included = summary.createDiv()
        const excluded = summary.createDiv()
        const treeHost = this.contentEl.createDiv()
        const status = this.contentEl.createEl('p', { attr: { role: 'status' } })
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        const save = footer.createEl('button', { text: t('Save Profile', 'Сохранить профиль'), cls: 'mod-cta' })
        const cancel = footer.createEl('button', { text: t('Cancel', 'Отмена') })
        const remove = profile ? footer.createEl('button', { text: t('Delete Profile', 'Удалить профиль'), cls: 'mod-warning' }) : undefined

        const pathsFor = (rule: FolderRule) =>
            [...rules].flatMap(([path, value]) => value === rule ? [path] : []).sort((a, b) => a.localeCompare(b))
        const renderSummary = (panel: HTMLElement, rule: FolderRule, title: string, emptyText: string) => {
            const paths = pathsFor(rule)
            panel.empty()
            panel.createEl('h3', { text: paths.length ? `${title} (${paths.length})` : title })
            if (!paths.length) {
                panel.createEl('p', { text: emptyText })
                return
            }
            const selected = panel.createEl('ul')
            selected.classList.add('rudonium-sync-profiles-selected')
            for (const path of paths) {
                const missing = missingFolders(this.plugin, [path]).length > 0
                const row = selected.createEl('li')
                row.classList.add('rudonium-wrap-anywhere')
                row.createSpan({ text: `${path}${missing ? t(' (missing)', ' (отсутствует)') : ''} ` })
                const parent = rule === 'include' ? excludingParent(path, rules) : undefined
                if (parent) {
                    const detail = row.createEl('small', { text: t(`Excluded by ${parent} `, `Исключено правилом папки ${parent} `) })
                    detail.classList.add('rudonium-text-muted')
                }
                const removal = rule === 'include' ? 'inclusion' : 'exclusion'
                row.createEl('button', { text: t('Remove', 'Убрать'),
                    attr: { 'aria-label': t(`Remove ${removal} for ${path}`, `Убрать правило для папки ${path}`) } }).onclick = () => {
                    if (this.busy) return
                    rules.delete(path)
                    const control = tree.action(path)
                    if (control) control.value = ''
                    renderRuleSummaries()
                    const focusTarget = control ?? tree.search
                    focusTarget.focus()
                }
            }
        }
        const renderRuleSummaries = () => {
            renderSummary(included, 'include', t('Included folders', 'Включённые папки'),
                t('All folders unless excluded.', 'Все папки, кроме исключённых.'))
            renderSummary(excluded, 'exclude', t('Excluded folders', 'Исключённые папки'), t('No excluded folders.', 'Исключённых папок нет.'))
        }
        const tree = createFolderTree(treeHost, {
            t, entries: vaultFolderEntries(this.plugin.app.vault), initiallyVisible: [...rules.keys()],
            renderAction: (row, _label, { path }) => {
                const control = row.createEl('select', { attr: { 'aria-label': t(`Sync rule for ${path}`, `Правило для папки ${path}`) } })
                control.createEl('option', { text: t('Default', 'Без правила'), value: '' })
                control.createEl('option', { text: t('Include', 'Включить'), value: 'include' })
                control.createEl('option', { text: t('Exclude', 'Исключить'), value: 'exclude' })
                control.value = rules.get(path) ?? ''
                control.onchange = () => {
                    if (this.busy) { control.value = rules.get(path) ?? ''; return }
                    const value = control.value
                    if (value === 'include' || value === 'exclude') rules.set(path, value)
                    else rules.delete(path)
                    renderRuleSummaries()
                }
                return control
            },
        })
        cancel.onclick = () => this.showProfiles()
        if (remove && profile) remove.onclick = () => this.confirmDelete(profile)
        save.onclick = async () => {
            if (this.busy) return
            const label = name.value.trim()
            const includedFolders = pathsFor('include')
            const excludedFolders = pathsFor('exclude')
            tree.setDisabled(true)
            try {
                await this.runSave(status, [name, save, cancel, ...(remove ? [remove] : [])], state => {
                    if (!label) throw new Error(t('Enter a profile name.', 'Введите название профиля.'))
                    const missing = missingFolders(this.plugin, [...includedFolders, ...excludedFolders])
                    if (missing.length) throw new Error(t(`Remove or replace missing folders. ${missing.join(' · ')}`,
                        `Удалите из профиля или замените отсутствующие папки. ${missing.join(' · ')}`))
                    if (profile) assertUnchanged(state.profiles, profile, t)
                    if (state.profiles.some(item => item.id !== profile?.id && labelKey(item.name) === labelKey(label))) {
                        throw new Error(t('A profile with that name already exists.', 'Профиль с таким названием уже существует.'))
                    }
                    const entry = { id: profile?.id ?? crypto.randomUUID(), name: label, folders: includedFolders,
                        excludedFolders, ...(profile?.exportRules !== undefined ? { exportRules: profile.exportRules } : {}) }
                    return { activeId: state.activeId,
                        profiles: profile ? state.profiles.map(item => item.id === profile.id ? entry : item) : [...state.profiles, entry] }
                })
            } finally {
                tree.setDisabled(false)
            }
        }
        renderRuleSummaries()
        name.focus()
    }

    private confirmDelete(profile: SyncFolderProfile): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Delete Sync Profile', 'Удаление профиля папок'))
        this.contentEl.empty()
        this.contentEl.createEl('p', { text: t(`Delete “${profile.name}”?`, `Удалить профиль «${profile.name}»?`) })
        if (readSyncProfiles(this.plugin.settings).activeId === profile.id) {
            this.contentEl.createEl('p', { text: t('The folder filter will turn off. Future runs will use all folders.',
                'Фильтр по папкам отключится. При следующем запуске будут использованы все папки.') })
        }
        const status = this.contentEl.createEl('p', { attr: { role: 'status' } })
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        const remove = footer.createEl('button', { text: t('Delete Profile', 'Удалить профиль'), cls: 'mod-warning' })
        const cancel = footer.createEl('button', { text: t('Cancel', 'Отмена') })
        cancel.onclick = () => this.editProfile(profile)
        remove.onclick = () => this.runSave(status, [remove, cancel], state => {
            assertUnchanged(state.profiles, profile, t)
            return { activeId: state.activeId === profile.id ? '' : state.activeId,
                profiles: state.profiles.filter(item => item.id !== profile.id) }
        })
        cancel.focus()
    }

    private async runSave(status: HTMLElement, controls: (HTMLInputElement | HTMLButtonElement)[],
        change: (state: ProfileSettings) => ProfileSettings): Promise<void> {
        if (this.busy) return
        const t = uiFor(this.plugin.settings)
        this.busy = true
        for (const control of controls) control.disabled = true
        status.setText(t('Saving…', 'Сохраняем изменения…'))
        try {
            await saveProfiles(this.plugin, change)
        } catch (error) {
            const message = uiDiagnostic(error, t)
            if (this.closed) new Notice(t(`Could not save the sync profile. ${message}`, `Не удалось сохранить профиль папок. ${message}`))
            else status.setText(message)
            return
        } finally {
            this.busy = false
            for (const control of controls) control.disabled = false
        }
        this.onChange()
        if (!this.closed) this.showProfiles()
    }
}

export function installSyncProfileSettings(container: HTMLElement, plugin: MyPlugin): void {
    const root = container.createDiv({ attr: { 'data-anki-sync-profile': '' } })
    const render = () => {
        const t = uiFor(plugin.settings)
        root.empty()
        const { activeId, profiles } = readSyncProfiles(plugin.settings)
        const active = profiles.find(profile => profile.id === activeId)
        const missing = active ? missingFolders(plugin, [...active.folders, ...active.excludedFolders]) : []
        const summary = !activeId ? t('Synchronizes all folders.', 'Синхронизируются все папки.')
            : !active ? t('The selected profile is unavailable.', 'Выбранный профиль недоступен.')
            : missing.length ? t(`Missing folders · ${missing.slice(0, 3).join(' · ')}`,
                `Отсутствуют папки · ${missing.slice(0, 3).join(' · ')}`) : profileDescription(plugin, active, t)
        const setting = new Setting(root).setName(t('Sync Profile', 'Профиль папок')).setDesc(summary)
        setting.descEl.classList.add('rudonium-wrap-anywhere')
        if (missing.length || (activeId && !active)) setting.descEl.classList.add('rudonium-text-error')
        setting.addDropdown(dropdown => {
            dropdown.addOption('', t('Off (all folders)', 'Без профиля (все папки)'))
            for (const { id, name } of profiles) dropdown.addOption(id, name)
            if (activeId && !active) dropdown.addOption(activeId, t('Unavailable profile', 'Недоступный профиль'))
            dropdown.setValue(activeId).onChange(async id => {
                dropdown.setDisabled(true)
                try {
                    await saveProfiles(plugin, state => {
                        if (id && !state.profiles.some(profile => profile.id === id)) {
                            throw new Error(t('That sync profile is unavailable.', 'Профиль папок недоступен.'))
                        }
                        return state.activeId === id ? undefined : { ...state, activeId: id }
                    })
                } catch (error) {
                    const message = uiDiagnostic(error, t)
                    new Notice(t(`Could not select the sync profile. ${message}`, `Не удалось выбрать профиль папок. ${message}`))
                } finally {
                    const focused = root.contains(document.activeElement)
                    render()
                    if (focused) root.querySelector('select')?.focus()
                }
            })
        })
        setting.addButton(button => button.setButtonText(t('Manage Profiles', 'Настроить профили')).onClick(() => new SyncProfilesModal(plugin, render).open()))
        root.querySelector('select')?.setAttribute('aria-label', t('Sync profile', 'Профиль папок'))
    }
    render()
}
