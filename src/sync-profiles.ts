/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { TFolder } from 'obsidian'
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import type { InterfaceSettings } from './interface-language'
import { validateExportRules } from './export-rules'
import type { ExportRule } from './export-rules'

export interface SyncFolderProfile {
    id: string
    name: string
    folders: string[]
    excludedFolders: string[]
    exportRules?: ExportRule[]
}

interface FolderProfileSettings {
    NOTE_TYPE_RULE_NAMES?: Record<string, string>
    SYNC_FOLDER_PROFILES?: SyncFolderProfile[]
    ACTIVE_SYNC_FOLDER_PROFILE?: string
    EFFECTIVE_EXPORT_RULES?: ExportRule[]
}

export interface SyncScope {
    allFiles: TFile[]
    files: TFile[]
    paths: ReadonlySet<string>
    label: string
    profileId: string
    signature: string
    contains(path: string): boolean
    excludes(path: string): boolean
}

export function isSyncAuditReportPath(path: string): boolean {
    return path.startsWith('Anki sync audit ') &&
        /^Anki sync audit \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?: \(\d+\))?\.md$/.test(path)
}

export function readSyncProfiles(settings: FolderProfileSettings): {
    activeId: string; profiles: SyncFolderProfile[];
} {
    const stored = Array.isArray(settings.SYNC_FOLDER_PROFILES) ? settings.SYNC_FOLDER_PROFILES : []
    const profiles = new Map<string, SyncFolderProfile>()
    for (const item of stored) {
        if (!item || typeof item.id !== 'string' || !item.id || profiles.has(item.id) ||
            typeof item.name !== 'string' || !item.name.trim() || !validFolderPaths(item.folders) ||
            (item.excludedFolders !== undefined && !validFolderPaths(item.excludedFolders))) continue
        profiles.set(item.id, {
            id: item.id, name: item.name.trim(),
            folders: Array.from(new Set(item.folders)),
            excludedFolders: Array.from(new Set(item.excludedFolders ?? [])),
            ...(item.exportRules !== undefined ? { exportRules: item.exportRules } : {}),
        })
    }
    const activeId = typeof settings.ACTIVE_SYNC_FOLDER_PROFILE === 'string' ? settings.ACTIVE_SYNC_FOLDER_PROFILE : ''
    return { activeId, profiles: Array.from(profiles.values()) }
}

function validFolderPaths(paths: unknown): paths is string[] {
    return Array.isArray(paths) && paths.every(path =>
        typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.endsWith('/'))
}

/** Возвращает правила только выбранного профиля и блокирует использование повреждённой конфигурации. */
export function activeExportRules(settings: FolderProfileSettings): ExportRule[] | undefined {
    const raw = settings.ACTIVE_SYNC_FOLDER_PROFILE
        ? (Array.isArray(settings.SYNC_FOLDER_PROFILES)
            ? settings.SYNC_FOLDER_PROFILES.find(profile => profile?.id === settings.ACTIVE_SYNC_FOLDER_PROFILE)?.exportRules
            : undefined)
        : settings.EFFECTIVE_EXPORT_RULES
    if (raw === undefined) return undefined
    const rules = validateExportRules(raw)
    if (!rules) throw new Error('Export rules for the active folder profile are invalid. Review its settings before exporting.')
    return rules.length ? rules : undefined
}

/** Вместо всей коллекции профилей сохраняет только правила, влияющие на текущий экспорт. */
export function scanProfileFreeSettings<T extends FolderProfileSettings & InterfaceSettings>(
    settings: T,
): Omit<T, keyof FolderProfileSettings | keyof InterfaceSettings> & Pick<FolderProfileSettings, 'EFFECTIVE_EXPORT_RULES'> {
    const { SYNC_FOLDER_PROFILES: profiles, ACTIVE_SYNC_FOLDER_PROFILE: active,
        EFFECTIVE_EXPORT_RULES: previousRules,
        INTERFACE_LANGUAGE: language, NOTE_TYPE_RULE_NAMES: ruleLabels, ...exportSettings } = settings
    const rules = activeExportRules(settings)
    return rules ? { ...exportSettings, EFFECTIVE_EXPORT_RULES: rules } : exportSettings
}

function selection(settings: MyPlugin['settings']): SyncFolderProfile {
    const { activeId, profiles } = readSyncProfiles(settings)
    if (!activeId) return { id: '', name: 'Entire vault', folders: [], excludedFolders: [] }
    const profile = profiles.find(item => item.id === activeId)
    if (!profile) throw new Error('The active sync profile is missing. Select a profile in Export to Anki settings.')
    return profile
}

export function syncScopeSignature(settings: MyPlugin['settings']): string {
    return serializeScope(selection(settings))
}

function serializeScope(profile: SyncFolderProfile): string {
    const scope: unknown[] = [profile.id, profile.name, [...profile.folders].sort(), [...profile.excludedFolders].sort()]
    if (profile.exportRules !== undefined) {
        const rules = validateExportRules(profile.exportRules)
        if (!rules) throw new Error('Export rules for the active folder profile are invalid. Review its settings before exporting.')
        if (rules.length) scope.push(rules)
    }
    return JSON.stringify(scope)
}

function isInFolders(path: string, folders: ReadonlySet<string>): boolean {
    if (!folders.size) return false
    let separator = path.lastIndexOf('/')
    while (separator > 0) {
        if (folders.has(path.slice(0, separator))) return true
        separator = path.lastIndexOf('/', separator - 1)
    }
    return false
}

function prepareSyncScope(plugin: Pick<MyPlugin, 'app' | 'settings'>, settings: MyPlugin['settings']) {
    const profile = selection(settings)
    const { vault } = plugin.app
    const included = new Set(profile.folders)
    const excluded = new Set(profile.excludedFolders)
    const roots = new Set([...included, ...excluded])
    const absent = Array.from(roots).filter(path => !(vault.getAbstractFileByPath(path) instanceof TFolder))
    if (absent.length) {
        throw new Error(`Sync profile "${profile.name}" has missing folders: ${absent.join(', ')}. Update it in Manage Profiles.`)
    }
    const excludes = (path: string) => isInFolders(path, excluded)
    const accepts = (path: string) => (!included.size || isInFolders(path, included)) && !excludes(path)
    return { profile, included, excluded, accepts, excludes }
}

/** Проверяет один путь исходника без обхода хранилища. */
export function describeSyncPath(plugin: Pick<MyPlugin, 'app' | 'settings'>, path: string, settings = plugin.settings):
    { included: boolean; label: string } {
    const { profile, accepts } = prepareSyncScope(plugin, settings)
    return { included: !isSyncAuditReportPath(path) && accepts(path), label: profile.name }
}

export function resolveSyncScope(plugin: Pick<MyPlugin, 'app' | 'settings'>, settings = plugin.settings): SyncScope {
    const { profile, included, excluded, accepts, excludes } = prepareSyncScope(plugin, settings)
    const allFiles = plugin.app.vault.getMarkdownFiles().filter(file => !isSyncAuditReportPath(file.path))
    const files = !included.size && !excluded.size
        ? allFiles
        : allFiles.filter(file => accepts(file.path))
    const paths = new Set(files.map(file => file.path))
    return {
        allFiles, files, paths, label: profile.name, profileId: profile.id, signature: serializeScope(profile),
        contains: path => paths.has(path), excludes,
    }
}
