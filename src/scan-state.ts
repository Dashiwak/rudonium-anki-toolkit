/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */

import { MarkdownView, Notice, TFolder } from 'obsidian'
import type { TFile } from 'obsidian'
import { Md5 } from 'ts-md5'
import type MyPlugin from '../main'
import type { ExportRepairTarget } from './export-review-ui'
import type { ExportRecovery } from './export-recovery'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { sameEditorText } from './markdown-pipeline'
import { isOptimizedImageCopyPath } from './media-sync'
import type { MediaIndex } from './media-sync'
import { OneWayHistory } from './oneway-history'
import { hasActiveLegacyPlugin } from './plugin-identity'

export type Entry = [mtime: number, ctime: number, size: number, hash: string | null, hasSuspension?: true]
export type IdEntry = [mtime: number, ctime: number, size: number, ids: number[]]

export interface ScanState {
    refreshInitialSchema?: () => Promise<unknown>
    openAudit?: (deck?: string, repair?: ExportRepairTarget) => void
    context: string | null
    entries: Map<string, Entry>
    idsByPath: Map<string, IdEntry>
    idOwners: Map<number, Map<string, number>>
    duplicateIds: Set<number>
    mediaIndex: MediaIndex
    mediaRevisions: Map<string, number>
    recovery?: ExportRecovery
    modified: Map<string, number>
    pathRevisions: Map<string, number>
    cacheEpoch: number
    metadataRevision: number
    cacheRevision: number
    editorModified: Set<string>
    revision: number
    scopeRevision: number
    lastScopePath?: string
    loaded: boolean
    running: Promise<void> | null
    resetting: Promise<void> | null
    saveData: boolean
    saveIndex: boolean
}

export const states = new WeakMap<MyPlugin, ScanState>()
const dataWrites = new WeakMap<MyPlugin, Promise<void>>()

export function ensureScanState(plugin: MyPlugin): ScanState {
    const existing = states.get(plugin)
    if (existing) return existing
    const state: ScanState = {
        context: null,
        entries: new Map(),
        idsByPath: new Map(),
        idOwners: new Map(),
        duplicateIds: new Set(),
        mediaIndex: new Map(),
        mediaRevisions: new Map(),
        modified: new Map(),
        pathRevisions: new Map(),
        cacheEpoch: 0,
        metadataRevision: 0,
        cacheRevision: 0,
        editorModified: new Set(),
        revision: 0,
        scopeRevision: 0,
        loaded: false,
        running: null,
        resetting: null,
        saveData: false,
        saveIndex: false,
    }
    states.set(plugin, state)

    const vault = plugin.app.vault
    const metadata = plugin.app.metadataCache
    if (typeof metadata?.on === 'function') {
        const changed = () => { state.metadataRevision++ }
        plugin.registerEvent(metadata.on('changed', changed))
        plugin.registerEvent(metadata.on('deleted', changed))
        plugin.registerEvent(metadata.on('resolved', changed))
    }
    const mark = (path: string, folderTreeChanged = false) => {
        if (!isOptimizedImageCopyPath(path)) markModified(state, path, folderTreeChanged)
    }
    plugin.registerEvent(vault.on('modify', file => { mark(file.path) }))
    plugin.registerEvent(plugin.app.workspace.on('editor-change', (_editor, info) => {
        if (info.file) {
            state.editorModified.add(info.file.path)
            mark(info.file.path)
        }
    }))
    plugin.app.workspace.onLayoutReady(() => {
        plugin.registerEvent(vault.on('create', file => { mark(file.path) }))
    })
    plugin.registerEvent(vault.on('delete', file => { mark(file.path, file instanceof TFolder) }))
    plugin.registerEvent(vault.on('rename', (file, oldPath) => {
        mark(oldPath, file instanceof TFolder)
        mark(file.path, file instanceof TFolder)
    }))
    return state
}

export function openOneWayHistory(plugin: MyPlugin, profile: string): Promise<OneWayHistory> {
    const index = indexPath(plugin)
    return OneWayHistory.open(plugin.app.vault.adapter, `${index.slice(0, index.lastIndexOf('/') + 1)}one-way-history.json`, profile)
}

export function settingsWithoutAuditMode(settings: MyPlugin['settings']): Omit<MyPlugin['settings'], 'AUDIT_READ_ONLY' | 'SKIP_SYNC_ERRORS' | 'ARCHIVE_TRANSFER' | 'COLLAPSE_ANKI_IDS' | 'INTERFACE_LANGUAGE' | 'BIDIRECTIONAL_PREVIEW' | 'BIDIRECTIONAL_CONFLICT_POLICY' | 'SYNC_CHANGE_HISTORY'> {
    const { AUDIT_READ_ONLY, SKIP_SYNC_ERRORS, ARCHIVE_TRANSFER, COLLAPSE_ANKI_IDS, INTERFACE_LANGUAGE, BIDIRECTIONAL_PREVIEW, BIDIRECTIONAL_CONFLICT_POLICY, SYNC_CHANGE_HISTORY, ...scanSettings } = settings
    return scanSettings
}

export function savePluginDataInOrder(plugin: MyPlugin, save: () => Promise<void>): Promise<void> {
    const previous = dataWrites.get(plugin)
    const current = (previous?.catch(() => {}) ?? Promise.resolve()).then(save)
    dataWrites.set(plugin, current)
    return current.finally(() => {
        if (dataWrites.get(plugin) === current) dataWrites.delete(plugin)
    })
}

export function markModified(state: ScanState, path: string, folderTreeChanged = false): void {
    const revision = ++state.revision
    state.modified.set(path, revision)
    state.pathRevisions.set(path, revision)
    if (folderTreeChanged || /\.md$/i.test(path)) {
        state.scopeRevision++
        state.lastScopePath = path
    }
}

export async function saveOpenEdits(plugin: MyPlugin, state: ScanState, inScope: (path: string) => boolean,
    errors: string[], checkCleanActive: boolean, applyingPreview = false, activePathToVerify?: string): Promise<{ pending: Set<string>; expected: Map<string, string> }> {
    const pending = new Set<string>()
    const expected = new Map<string, string>()
    const views = new Map<string, MarkdownView[]>()
    for (const { view } of plugin.app.workspace.getLeavesOfType('markdown')) {
        if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file || !inScope(view.file.path)) continue
        const path = view.file.path
        const open = views.get(path) ?? []
        open.push(view)
        views.set(path, open)
    }
    const included = Array.from(views.keys())
    for (const path of included) {
        const open = views.get(path)!
        const dirty = open.filter(view => view.file?.path === path && !sameEditorText(view.getViewData(), view.data))
        if (dirty.length === 0) continue
        if (applyingPreview) {
            errors.push(`${path}: the editor has unsaved changes. Save them and open Preview Export again.`)
            pending.add(path)
            continue
        }
        const view = dirty[0]
        const content = view.getViewData()
        state.editorModified.add(path)
        markModified(state, path)
        if (dirty.some(other => !sameEditorText(other.getViewData(), content))) {
            errors.push(`${path}: conflicting unsaved edits in split views`)
            pending.add(path)
            continue
        }
        try {
            await view.save()
            if (view.file?.path !== path || !sameEditorText(view.getViewData(), content) || !sameEditorText(content, view.data)) {
                throw new Error('the editor changed during save')
            }
            expected.set(path, content)
        } catch (error) {
            errors.push(`${path}: could not save editor changes: ${String(error)}`)
            pending.add(path)
        }
    }
    for (const path of included) {
        if (pending.has(path)) continue
        const open = views.get(path)!.filter(view => view.file?.path === path)
        if (open.some(view => {
            const text = view.getViewData()
            return !sameEditorText(text, view.data) && !sameEditorText(text, expected.get(path))
        })) {
            errors.push(`${path}: the editor has unsaved changes`)
            pending.add(path)
        } else if ((state.editorModified.has(path) || path === activePathToVerify) && !expected.has(path) && open.length === 1) {
            expected.set(path, open[0].getViewData())
        }
    }
    const active = checkCleanActive ? plugin.app.workspace.getActiveViewOfType(MarkdownView) : null
    const activePath = active?.file?.path
    if (active && activePath && included.includes(activePath) && !pending.has(activePath) &&
        state.entries.has(activePath) && !state.modified.has(activePath)) {
        const entry = state.entries.get(activePath)!
        const hash = entry[3]
        const content = active.getViewData()
        const normalized = content.replace(/\r\n/g, '\n')
        if (hash && sameEditorText(content, active.data) && Md5.hashStr(content) !== hash &&
            Md5.hashStr(content === normalized ? normalized.replace(/\n/g, '\r\n') : normalized) !== hash) {
            markModified(state, activePath)
            if (active.file && sameStat(active.file, entry)) expected.set(activePath, content)
        }
    }
    return { pending, expected }
}

export async function saveBidirectionalEditors(plugin: MyPlugin, includes: (path: string) => boolean): Promise<Map<string, string>> {
    const errors: string[] = []
    const state = states.get(plugin)
    if (!state) throw new Error('The sync state is unavailable.')
    const { expected } = await saveOpenEdits(plugin, state, includes, errors, false, false, plugin.app.workspace.getActiveFile?.()?.path)
    if (errors.length) throw new Error(errors[0])
    return expected
}


export function previousPluginMessage(t: UiText): string {
    return t('Disable the previous Anki export plugin in Community plugins and retry.',
        'Отключите предыдущий плагин экспорта в Anki в разделе «Сторонние плагины» и повторите операцию.')
}

export async function withFastScanReadLock<T>(
    plugin: MyPlugin, read: (currentRevision: () => number, pathRevision: (path: string) => number,
        metadataRevision: () => number) => Promise<T>,
    allowLegacyPreview = false,
): Promise<T> {
    if (!allowLegacyPreview && hasActiveLegacyPlugin(plugin.app)) throw new Error(previousPluginMessage(uiFor(plugin.settings)))
    const state = ensureScanState(plugin)
    if (state.running || state.resetting) {
        throw new Error(uiFor(plugin.settings)('Wait for the current scan or cache reset to finish, then try again.',
            'Дождитесь завершения текущей проверки или сброса кеша и попробуйте снова.'))
    }
    let finish!: () => void
    state.running = new Promise<void>(resolve => { finish = resolve })
    try {
        return await read(() => state.revision, path => Math.max(state.cacheEpoch, state.pathRevisions.get(path) ?? 0),
            () => state.metadataRevision)
    } finally {
        state.running = null
        finish()
    }
}

export async function waitForFastScanIdle(plugin: MyPlugin): Promise<void> {
    const state = states.get(plugin)
    let pending = state?.resetting ?? state?.running
    while (pending) {
        await pending
        pending = state?.resetting ?? state?.running
    }
}

export function indexPath(plugin: MyPlugin): string {
    const { app, manifest } = plugin
    const directory = manifest.dir ?? `${app.vault.configDir}/plugins/${manifest.id}`
    return `${directory}/fast-scan-index.json`
}

export function sameStat(file: TFile, stamp: Entry | IdEntry): boolean {
    const stat = file.stat
    return stat.mtime === stamp[0] && stat.ctime === stamp[1] && stat.size === stamp[2]
}

export async function prepareInitialSchema(plugin: MyPlugin, onFailure?: (reason: string) => Promise<void>): Promise<boolean> {
    if (plugin.note_types?.length && Object.prototype.hasOwnProperty.call(plugin.fields_dict, plugin.note_types[0])) return true
    const refresh = states.get(plugin)?.refreshInitialSchema
    if (!refresh || Object.keys(plugin.fields_dict ?? {}).length) return true
    try { await refresh(); return true }
    catch (error) {
        const t = uiFor(plugin.settings)
        const reason = t('Could not load note types from Anki. ', 'Не удалось загрузить типы записей из Anki. ') + String(error)
        new Notice(reason)
        await onFailure?.(reason)
        return false
    }
}
