/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { recordSyncChanges, syncHistoryEnabled, syncHistoryLimit } from './sync-change-history'
import type { SyncHistoryChange } from './sync-change-history'
import { generatedRuleGuard } from './delimited-rule'
import { afterDeleteMode } from './deletion-policy'
import { registerRecordReview } from './obsidian-navigation'
import { sameEditorText } from './markdown-pipeline'
import { MarkdownView, Notice } from 'obsidian'
import type { TFile } from 'obsidian'
import { Md5 } from 'ts-md5'
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import { findIdMarkers } from './duplicate-markers'
import { mayHaveSuspendMarker, readSuspendMarkers } from './suspend-marker'
import { applySuspendCards } from './suspend-anki'
import { createDuplicateReviewLoader } from './duplicate-review'
import { openDuplicateReview } from './duplicate-review-ui'
import { uiFor } from './interface-language'
import { hasActiveLegacyPlugin } from './plugin-identity'
import { requireSettledZipImport } from './zip-import-guard'
import { FileManager } from './files-manager'
import { settingToData } from './setting-to-data'
import { openExportPreview, openExportProgress, openExportRunReport, openExportRecovery, singleAuditDeck, auditDeckForFile,
    dismissMissingCardReview, isReportedDuplicateAddError, showDuplicateFirstFieldNotice, showMissingAnkiCardNotice } from './export-review-ui'
import type { ExportRepairTarget, ExportPreviewRow, ExportProgress, ExportRunReport, ExportRecoveryRow } from './export-review-ui'
import { fieldReviewIssue, isExportCardIssue, localizeExportError } from './card-export-diagnostics'
import type { ExportCardIssue } from './card-export-diagnostics'
import { isRecord } from './anki-delta'
import type { ExportDeckMove } from './anki-delta'
import { checkCloudFolder, openCloudFolderCheck } from './cloud-folder-check'
import { activeMediaProfile, changedMediaNotes, hasMediaAlias, imageAliases, loadMediaIndex, reconcileMediaNotes } from './media-sync'
import { readImageOptimization } from './image-optimizer'
import { createFullMigrationBackup, ensureScheduledBackup, readBackupSettings } from './vault-backup'
import type { BackupCheck } from './vault-backup'
import { AnkiProfileError, expectedAnkiProfile, isAnkiProfileLockEnabled, requireExpectedAnkiProfile } from './anki-profile'
import { showAnkiProfileProblem } from './anki-profile-ui'
import { checkCursorEditors } from './cursor-editor-guard'
import { cursorConfiguration, staleCursorCard } from './cursor-card'
import type { CursorCardTarget } from './cursor-card'
import { compactMediaLinks, confirmMissingCachePaths } from './cache-optimization'
import type { CacheOptimizationPlan } from './cache-optimization'
import { ExportRecovery, pendingRecoveryProfileProblem, readRecoveryMarker, recoveryTag, recoveryMarkerTokens } from './export-recovery'
import type { RecoveryCleanup } from './export-recovery'
import { lookupRecoveryNotes } from './recovery-lookup'
import type { RecoveryLookupResult } from './recovery-lookup'
import { auditRead, checkAnkiNoteExistence, checkWarmAnkiNoteExistence, readSyncAuditNoteInventory, syncAuditDeckKey } from './sync-audit'
import { DuplicatePreflight } from './duplicate-preflight'
import type { ExportPreviewSelection } from './export-plan'
import { sendExportBatches } from './export-batch'
import { hasPendingAnkiWrite, pendingAnkiWriteMessage, withAnkiDeadline } from './anki-transport'
import type { OneWayHistory } from './oneway-history'
import { ExportOperationJournal, operationJournalPath } from './export-operation-journal'
import { checkedCount, isSkippedExportIssue, skippedExportNotes, SyncOutcome } from './sync-outcome'
import { showExportOperationJournal } from './export-operation-journal-ui'
import { oneWayFieldChoice } from './export-plan'
import { forgetConfirmedAnkiDeletions, hasPendingBidirectionalWrite, pendingBidirectionalWriteMessage, previewBidirectionalSync, runBidirectionalSync } from './bidirectional-sync'
import { isSyncAuditReportPath, resolveSyncScope, scanProfileFreeSettings, syncScopeSignature } from './sync-profiles'
import { indexVaultIds } from './vault-id-index'

import { ensureScanState, indexPath, markModified, openOneWayHistory, prepareInitialSchema, previousPluginMessage,
    sameStat, saveOpenEdits, settingsWithoutAuditMode, states, waitForFastScanIdle, withFastScanReadLock } from './scan-state'
import type { Entry, IdEntry, ScanState } from './scan-state'
export { openOneWayHistory, prepareInitialSchema, saveBidirectionalEditors, savePluginDataInOrder, settingsWithoutAuditMode,
    waitForFastScanIdle, withFastScanReadLock } from './scan-state'
export { isSyncAuditReportPath } from './sync-profiles'

const staleRoutingMessage = 'The deck assignments or sync profile changed during export. Run the export again.'

function isList(value: unknown): value is unknown[] {
    return Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
    return isList(value) && value.every(item => typeof item === 'string')
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isExportReport(value: unknown): value is ExportRunReport {
    return isRecord(value) && typeof value.scope === 'string' && typeof value.finishedAt === 'string' &&
        typeof value.outcome === 'string' && ['completed', 'stopped', 'failed', 'blocked-profile'].includes(value.outcome) &&
        [value.total, value.confirmed, value.pending].every(isCount) &&
        [value.recoveredCreations, value.submittedRequests, value.answeredRequests].every(n => n === undefined || isCount(n)) &&
        [value.ankiProfile, value.profileSignature].every(s => s === undefined || typeof s === 'string') &&
        [value.cardImpact, value.messages, value.warnings].every(rows => rows === undefined || isStringList(rows)) &&
        isList(value.files) && value.files.every(file => isRecord(file) && typeof file.path === 'string' &&
            typeof file.retryable === 'boolean' && isStringList(file.errors) &&
            (file.deck === undefined || typeof file.deck === 'string') &&
            (file.cardIssues === undefined || isList(file.cardIssues) && file.cardIssues.every(isExportCardIssue)))
}

function routingSettingsKey(settings: MyPlugin['settings']): string {
    return JSON.stringify([settings.Defaults.Deck, settings.Syntax?.['Target Deck Line'],
        settings.FOLDER_DECKS, settings.FOLDER_DEFAULT_DECKS])
}

interface Candidate {
    file: TFile
    path: string
    stamp: Entry
    revision: number | undefined
}

const commandsRegistered = new WeakSet<MyPlugin>()
const indexVersion = 13
const idIndexVersion = 5
const filesPerBatch = 512
const idsPerQuery = 500
const checkpointInterval = 8
const sourceBufferBytes = 64 * 1024 * 1024
const cachePreviews = new WeakMap<CacheOptimizationPlan, {
    plugin: MyPlugin; vaultRevision: number; cacheRevision: number; paths: readonly string[]; skipped: number;
}>()

export function registerFastScan(plugin: MyPlugin, openAudit?: (deck?: string, repair?: ExportRepairTarget) => void,
    refreshInitialSchema?: () => Promise<unknown>): void {
    const state = ensureScanState(plugin)
    if (openAudit) state.openAudit = openAudit
    if (refreshInitialSchema) state.refreshInitialSchema = refreshInitialSchema
    if (commandsRegistered.has(plugin)) return
    commandsRegistered.add(plugin)
    registerRecordReview(plugin)
    plugin.register(() => dismissMissingCardReview(plugin.app))
    const t = uiFor(plugin.settings)
    plugin.addCommand({
        id: 'anki-scan-vault-full',
        name: t('Scan Vault (full)', 'Полностью перепроверить и экспортировать хранилище'),
        callback: () => { void scanVaultFast(plugin, true) },
    })
    plugin.addCommand({
        id: 'anki-scan-current-note',
        name: t('Sync Current File with Anki', 'Синхронизировать текущий файл с Anki'),
        callback: async () => { await scanVaultFast(plugin, false, true) },
    })
    plugin.addCommand({
        id: 'anki-review-duplicate-ids',
        name: t('Review Duplicate Anki IDs', 'Проверить дубликаты ID Anki'),
        callback: () => openDuplicateIdReview(plugin),
    })
    plugin.addCommand({
        id: 'anki-preview-export',
        name: t('Preview Export to Anki', 'Предпросмотр экспорта в Anki'),
        callback: () => { void previewVaultExport(plugin) },
    })
    plugin.addCommand({
        id: 'anki-check-cloud-folder',
        name: t('Check Folder after Cloud Sync', 'Проверить папку после облачной синхронизации'),
        callback: () => {
            const text = uiFor(plugin.settings)
            openCloudFolderCheck(plugin.app, (folder, signal, progress) =>
                withFastScanReadLock(plugin, async (_revision, pathRevision) => {
                    if (!state.loaded) await loadIndex(plugin, state)
                    return checkCloudFolder(plugin.app, folder, {
                        expectedHash: path => {
                            const hash = state.entries.get(path)?.[3]
                            return typeof hash === 'string' && plugin.file_hashes[path] === hash ? hash : undefined
                        },
                        include: path => !isSyncAuditReportPath(path), pathRevision, t: text,
                    }, signal, progress)
                }), undefined, text)
        },
    })
    plugin.addCommand({
        id: 'anki-last-export-report',
        name: t('Show Last Anki Export', 'Показать последний отчёт об экспорте'),
        callback: () => showLastExport(plugin),
    })
    plugin.addCommand({
        id: 'anki-export-operation-journal',
        name: t('Open Anki Export Journal', 'Открыть журнал экспорта Anki'),
        callback: () => openExportJournal(plugin),
    })
    plugin.addCommand({
        id: 'anki-recover-creations',
        name: t('Review Pending Anki Creations', 'Проверить незавершённое создание записей Anki'),
        callback: () => showPendingCreations(plugin),
    })
}

export function openDuplicateIdReview(plugin: MyPlugin, initialId?: number): void {
    registerFastScan(plugin)
    const state = states.get(plugin)!
    const { app } = plugin
    openDuplicateReview(app, {
        scopeLabel: uiFor(plugin.settings)('Entire vault', 'Всё хранилище'),
        t: uiFor(plugin.settings),
        initialId,
        load: createDuplicateReviewLoader(app, {
            listFiles: () => app.vault.getMarkdownFiles().filter(file => !isSyncAuditReportPath(file.path)),
            getSyntax: () => plugin.settings.Syntax,
            revision: path => state.pathRevisions.get(path),
        }),
    })
}

function lastReportPath(plugin: MyPlugin): string {
    const index = indexPath(plugin)
    return `${index.slice(0, index.lastIndexOf('/') + 1)}last-export-report.json`
}

function reportRetry(plugin: MyPlugin, paths: ReadonlySet<string>, profileSignature?: string, ankiProfile?: string): void {
    if (profileSignature) {
        try {
            if (syncScopeSignature(plugin.settings) !== profileSignature) {
                new Notice(uiFor(plugin.settings)('Select the sync profile used for this export before retrying its files.',
                    'Для повтора выберите профиль папок, использованный при экспорте.'))
                return
            }
        } catch (error) {
            new Notice(localizeExportError(String(error), uiFor(plugin.settings)))
            return
        }
    }
    void scanVaultFast(plugin, false, false, paths, new Map(), undefined, undefined, ankiProfile)
}

export async function showLastExport(plugin: MyPlugin): Promise<void> {
    const t = uiFor(plugin.settings)
    const path = lastReportPath(plugin)
    const { adapter } = plugin.app.vault
    try {
        if (!await adapter.exists(path)) {
            new Notice(t('Export to Anki: no export report has been saved yet.', 'Отчётов об экспорте в Anki пока нет.'))
            return
        }
        const report: unknown = JSON.parse(await adapter.read(path))
        if (!isExportReport(report)) throw new Error('invalid report format')
        openExportRunReport(plugin.app, report, paths => {
            if (report.ankiProfile) reportRetry(plugin, paths, report.profileSignature, report.ankiProfile)
        }, t, states.get(plugin)?.openAudit, plugin.settings.Syntax)
    } catch (error) {
        new Notice(t(`Export to Anki: could not read the last export report. ${String(error)}`,
            `Не удалось открыть последний отчёт об экспорте в Anki. ${localizeExportError(String(error), t)}`))
    }
}

export async function openExportJournal(plugin: MyPlugin, deck?: string): Promise<void> {
    await waitForFastScanIdle(plugin)
    showExportOperationJournal(plugin, {
        deck,
        preview: () => { void previewVaultExport(plugin) },
        recover: () => { void showPendingCreations(plugin) },
    })
}

async function showPendingCreations(plugin: MyPlugin): Promise<void> {
    const { app } = plugin
    const t = uiFor(plugin.settings)
    try {
        const rows = await withFastScanReadLock(plugin, async () => {
            const records = (await exportRecovery(plugin, states.get(plugin)!)).records()
            const tokens = new Set(records.flatMap(entry => entry.token ? [entry.token] : []))
            const locations = new Map<string, { path: string; clean?: string }[]>()
            const files = tokens.size ? app.vault.getMarkdownFiles() : []
            for (let offset = 0; offset < files.length; offset += 8) {
                await Promise.all(files.slice(offset, offset + 8).map(async file => {
                    try {
                        const text = await app.vault.read(file)
                        for (const token of recoveryMarkerTokens(text)) {
                            if (!tokens.has(token)) continue
                            const paths = locations.get(token) ?? []
                            const location: { path: string; clean?: string } = { path: file.path }
                            paths.push(location)
                            locations.set(token, paths)
                            try { location.clean = readRecoveryMarker(text)?.clean } catch { /* неоднозначный маркер */ }
                        }
                    } catch {
                        return
                    }
                }))
            }
            let activeProfile: string | undefined
            let lookupError: string | undefined
            if (records.length) {
                try {
                    activeProfile = await requireExpectedAnkiProfile(plugin)
                } catch (error) {
                    lookupError = error instanceof Error ? error.message : String(error)
                }
            }
            const requested = activeProfile ? records.filter(entry => entry.ankiProfile === activeProfile).flatMap(entry =>
                entry.slots.flatMap((slot, index) => {
                    const tag = slot === 'unknown' ? recoveryTag(entry, index) : undefined
                    return tag ? [{ tag }] : []
                })) : []
            let matches: ReadonlyMap<string, RecoveryLookupResult> | undefined
            if (requested.length && activeProfile) {
                const pinned = activeProfile
                try {
                    matches = await lookupRecoveryNotes(requested, () => requireExpectedAnkiProfile(plugin, pinned))
                } catch (error) {
                    lookupError = error instanceof Error ? error.message : String(error)
                }
            }
            return records.map((entry): ExportRecoveryRow => {
                const sources = entry.token ? locations.get(entry.token) ?? [] : []
                const source = sources.length === 1 ? sources[0] : undefined
                const currentPath = source?.path ?? (sources.length === 0 && !entry.token &&
                    app.vault.getAbstractFileByPath(entry.path) ? entry.path : undefined
                )
                const exactSource = source?.clean !== undefined && Md5.hashStr(source.clean) === entry.sourceHash
                const lines = exactSource ? source?.clean?.split(/\r?\n/) : undefined
                const error = sources.length > 1 ? `The same recovery marker appears in ${sources.map(item => item.path).join(', ')}.` :
                    !currentPath ? 'The current Markdown source could not be identified. Check the previous path and known Anki IDs.' :
                    source && !exactSource ? 'The Markdown source changed. Compare it with the Anki candidate before linking.' : undefined
                const profileError = pendingRecoveryProfileProblem(entry, activeProfile)
                const cardPreviews = entry.tagVersion === 1 ? entry.slots.map((slot, index) => {
                    const tag = recoveryTag(entry, index)
                    const match = tag ? matches?.get(tag) : undefined
                    const line = exactSource ? entry.slotLines?.[index] ?? undefined : undefined
                    const text = line !== undefined ? lines?.[line - 1]?.trim() : undefined
                    const preceding = line !== undefined && line > 1 ? lines?.[line - 2] : undefined
                    const prompt = text && (/^[-*+]\s+(.*?)\s+::\s+/.exec(text)?.[1] ??
                        (/^(?:A|Back):\s+/i.test(text) ? /^\s*(?:Q|Front):\s+(.+)/i.exec(preceding ?? '')?.[1] : undefined) ?? text)
                    return { line, prompt: prompt?.slice(0, 240), candidates: slot === 'unknown' ? match?.candidates : undefined,
                        state: typeof slot === 'number' ? t(`Confirmed Anki ID ${slot}`, `Подтверждён ID Anki ${slot}`) :
                            slot === null ? t('The creation did not complete.', 'Создание записи не завершилось.') :
                                match?.state === 'found' ? t('One candidate found. Recheck and Recover verifies the link.',
                                    'Найдена одна запись. Повторная проверка подтвердит связь.') :
                                    match?.state === 'missing' ? t('No Anki record has this recovery tag yet. The creation stays pending.',
                                        'В Anki пока нет записи с этой меткой восстановления.') :
                                        localizeExportError(match?.detail ?? (profileError || lookupError || t('Anki has not confirmed this creation.',
                                            'Anki не подтвердила создание записи.')), t) }
                }) : undefined
                return { path: entry.formerPath ?? entry.path, currentPath, slots: entry.slots,
                    cursorToken: entry.cursorOffset !== undefined && exactSource && currentPath === entry.path && !entry.formerPath ? entry.token : undefined,
                    ankiProfile: entry.ankiProfile, cardPreviews,
                    error: [error, profileError, !activeProfile || entry.ankiProfile === activeProfile ? lookupError : undefined]
                        .filter(Boolean).join(' ') || undefined }
            })
        })
        openExportRecovery(app, rows, (paths, profile) => {
            const row = rows.find(row => paths.size === 1 && row.currentPath && paths.has(row.currentPath) &&
                row.ankiProfile === profile && row.cursorToken && !row.error)
            if (row?.currentPath && row.cursorToken) {
                void scanVaultFast(plugin, false, false, paths, new Map(), {
                    cursorRecovery: { path: row.currentPath, token: row.cursorToken }, omittedPreviewPaths: paths,
                }, undefined, profile)
                return
            }
            if (plugin.settings.BIDIRECTIONAL_SYNC === true) {
                new Notice(t('Turn off Bidirectional Sync to recheck an unfinished one-way export.',
                    'Отключите двустороннюю синхронизацию, чтобы перепроверить незавершённый односторонний экспорт.'))
                return
            }
            reportRetry(plugin, paths, undefined, profile)
        }, { cleanup: () => cleanRecoveryTags(plugin) }, t)
    } catch (error) {
        new Notice(t(`Export to Anki: could not open pending creations. ${String(error)}`,
            `Не удалось открыть список незавершённых записей Anki. ${localizeExportError(String(error), t)}`))
    }
}

async function confirmedCleanupTags(rows: readonly RecoveryCleanup[], checkProfile: () => Promise<string>):
    Promise<Map<number, ReadonlySet<string>>> {
    await checkProfile()
    const notes = [...new Set(rows.map(row => row.noteId))]
    const response = await auditRead('notesInfo', { notes })
    await checkProfile()
    if (!isList(response)) throw new Error('Anki did not return valid notes for recovery tag cleanup.')
    const allowed = new Set(notes)
    const tags = new Map<number, ReadonlySet<string>>()
    for (const row of response) {
        if (!isRecord(row) || typeof row.noteId !== 'number' || !allowed.has(row.noteId) || tags.has(row.noteId) ||
            !isStringList(row.tags)) {
            throw new Error('Anki did not confirm the exact recovery tag owners.')
        }
        tags.set(row.noteId, new Set(row.tags.map(tag => tag.toLowerCase())))
    }
    return tags
}

function cleanRecoveryTags(plugin: MyPlugin): Promise<number> {
    return withFastScanReadLock(plugin, async () => {
        if (hasPendingBidirectionalWrite(plugin.app)) throw new Error(pendingBidirectionalWriteMessage)
        if (hasPendingAnkiWrite(plugin.app)) throw new Error(pendingAnkiWriteMessage)
        const recovery = await exportRecovery(plugin, states.get(plugin)!)
        const expected = await requireExpectedAnkiProfile(plugin)
        const pending = recovery.cleanupRecords(expected)
        const checkProfile = () => requireExpectedAnkiProfile(plugin, expected)
        let cleaned = 0
        for (let offset = 0; offset < pending.length; offset += 100) {
            const batch = pending.slice(offset, offset + 100)
            let tags = await confirmedCleanupTags(batch, checkProfile)
            const remove = batch.filter(item => tags.get(item.noteId)?.has(item.tag))
            if (remove.length) {
                await sendExportBatches(remove.map(item => AnkiConnect.removeTags([item.noteId], item.tag)),
                    actions => AnkiConnect.invoke('multi', { actions }), undefined, async () => {
                        await checkProfile()
                        return undefined
                    }, { scope: plugin.app })
                tags = await confirmedCleanupTags(batch, checkProfile)
            }
            const confirmed = batch.filter(item => tags.has(item.noteId) && !tags.get(item.noteId)!.has(item.tag))
            await recovery.confirmCleanup(confirmed, expected)
            cleaned += confirmed.length
        }
        if (cleaned < pending.length) throw new Error(`${cleaned} recovery tags confirmed removed. ${pending.length - cleaned} could not be verified and remain queued.`)
        return cleaned
    })
}

async function exportRecovery(plugin: MyPlugin, state: ScanState): Promise<ExportRecovery> {
    if (!state.recovery) {
        const index = indexPath(plugin)
        state.recovery = await ExportRecovery.open(plugin.app.vault.adapter,
            `${index.slice(0, index.lastIndexOf('/') + 1)}pending-new-notes.json`)
    }
    return state.recovery
}

async function loadIndex(plugin: MyPlugin, state: ScanState): Promise<void> {
    const { adapter } = plugin.app.vault
    const path = indexPath(plugin)
    try {
        if (await adapter.exists(path)) {
            const saved: unknown = JSON.parse(await adapter.read(path))
            if (!isRecord(saved)) throw new Error('Invalid scan index.')
            if (typeof saved.version === 'number' && Number.isInteger(saved.version) && saved.version >= 6 && saved.version <= indexVersion) loadMediaIndex(state.mediaIndex, saved.media)
            if (typeof saved.context === 'string' && isList(saved.entries)) {
                if (saved.version === indexVersion) {
                    for (const pair of saved.entries) {
                        if (!isList(pair)) continue
                        const [file, entry] = pair
                        if (
                            typeof file === 'string' &&
                            isList(entry) &&
                            (entry.length === 4 || entry.length === 5 && entry[4] === true) &&
                            entry.slice(0, 3).every(Number.isFinite) &&
                            typeof entry[3] === 'string'
                        ) {
                            state.entries.set(file, entry as Entry)
                        }
                    }
                    const savedIds = saved.idIndexVersion === idIndexVersion && isList(saved.idsByPath)
                        ? saved.idsByPath : []
                    for (const pair of savedIds) {
                        if (!isList(pair)) continue
                        const [file, entry] = pair
                        if (typeof file === 'string' && isList(entry) && entry.length === 4 &&
                            entry.slice(0, 3).every(Number.isFinite) && isList(entry[3]) &&
                            entry[3].every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
                            updateIdOwners(state, file, entry as IdEntry)
                        }
                    }
                    state.context = saved.context
                }
            }
        }
    } catch (error) {
        state.entries.clear()
        clearIdOwners(state)
        console.warn('[Export to Anki] Rebuilding unreadable scan index', error)
    }
    state.loaded = true
}

export async function cachedImageAliases(plugin: MyPlugin, pinnedProfile?: string | null): Promise<ReadonlyMap<string, ReadonlyMap<string, string>>> {
    const state = states.get(plugin)!
    if (!state.loaded) await loadIndex(plugin, state)
    if (!Array.from(state.mediaIndex.values()).some(hasMediaAlias)) return new Map()
    const profile = pinnedProfile === undefined ? await activeMediaProfile() : pinnedProfile
    return profile ? imageAliases(state.mediaIndex, profile) : new Map()
}

function serializeIndex(state: Pick<ScanState, 'context' | 'entries' | 'idsByPath' | 'mediaIndex'>): string {
    return JSON.stringify({
        version: indexVersion,
        idIndexVersion,
        context: state.context,
        entries: Array.from(state.entries),
        idsByPath: Array.from(state.idsByPath),
        media: Array.from(state.mediaIndex.values()),
    })
}

async function flush(plugin: MyPlugin, state: ScanState): Promise<void> {
    if (state.saveData) {
        state.cacheRevision++
        await plugin.saveAllData()
        state.saveData = false
    }
    if (state.saveIndex) {
        state.cacheRevision++
        await plugin.app.vault.adapter.write(indexPath(plugin), serializeIndex(state))
        state.saveIndex = false
    }
}

function* cachedMarkdownPaths(plugin: MyPlugin, state: ScanState): Iterable<string> {
    yield* Object.keys(plugin.file_hashes)
    yield* state.entries.keys()
    yield* state.idsByPath.keys()
    for (const record of state.mediaIndex.values()) {
        const pending = new Set(record.pendingNotes)
        for (const path of record.notes) if (!pending.has(path)) yield path
    }
}

function makeCacheOptimization(plugin: MyPlugin, state: ScanState, paths: readonly string[], skipped: number) {
    const removed = new Set(paths)
    const cachedHashes = plugin.file_hashes
    const hashes = { ...cachedHashes }
    Object.setPrototypeOf(hashes, null)
    const entries = new Map(state.entries)
    const idsByPath = new Map(state.idsByPath)
    const media = compactMediaLinks(state.mediaIndex, removed)
    let hashCount = 0
    for (const path of removed) {
        if (Object.prototype.hasOwnProperty.call(hashes, path)) {
            delete hashes[path]
            hashCount++
        }
        entries.delete(path)
        idsByPath.delete(path)
    }
    const serializedBefore = serializeIndex(state)
    const serializedAfter = serializeIndex({ context: state.context, entries, idsByPath, mediaIndex: media.index })
    const bytes = (index: string, fileHashes: Record<string, string>) => {
        const encoder = new TextEncoder()
        return encoder.encode(index).length + encoder.encode(JSON.stringify(fileHashes)).length
    }
    const plan: CacheOptimizationPlan = {
        paths,
        summary: {
            markdownPaths: removed.size, hashes: hashCount, fileEntries: state.entries.size - entries.size,
            idEntries: state.idsByPath.size - idsByPath.size, mediaLinks: media.links, skipped,
            bytesBefore: bytes(serializedBefore, cachedHashes), bytesAfter: bytes(serializedAfter, hashes),
        },
    }
    return { plan, hashes, entries, mediaIndex: media.index, serializedAfter }
}

function staleCachePreview(): Error {
    return new Error('The vault or the cache changed. Recheck before optimizing.')
}

export function previewCacheOptimization(plugin: MyPlugin): Promise<CacheOptimizationPlan> {
    return withFastScanReadLock(plugin, async currentRevision => {
        const state = states.get(plugin)!
        if (!state.loaded) await loadIndex(plugin, state)
        const vaultRevision = currentRevision()
        const { missing, skipped } = await confirmMissingCachePaths(plugin.app.vault, cachedMarkdownPaths(plugin, state))
        if (currentRevision() !== vaultRevision) throw staleCachePreview()
        const plan = makeCacheOptimization(plugin, state, missing, skipped).plan
        cachePreviews.set(plan, { plugin, vaultRevision, cacheRevision: state.cacheRevision, paths: [...missing], skipped })
        return plan
    })
}

export function applyCacheOptimization(plugin: MyPlugin, preview: CacheOptimizationPlan): Promise<CacheOptimizationPlan> {
    return withFastScanReadLock(plugin, async currentRevision => {
        const saved = cachePreviews.get(preview)
        const state = states.get(plugin)!
        if (!saved || saved.plugin !== plugin || saved.vaultRevision !== currentRevision() ||
            saved.cacheRevision !== state.cacheRevision) throw staleCachePreview()
        const { missing } = await confirmMissingCachePaths(plugin.app.vault, saved.paths)
        if (missing.length !== saved.paths.length || saved.vaultRevision !== currentRevision()) throw staleCachePreview()
        const next = makeCacheOptimization(plugin, state, missing, saved.skipped)
        if (!missing.length) return next.plan

        const { adapter } = plugin.app.vault
        const path = indexPath(plugin)
        const changesIndex = next.plan.summary.fileEntries + next.plan.summary.idEntries + next.plan.summary.mediaLinks > 0
        const previousIndex = changesIndex && await adapter.exists(path) ? await adapter.read(path) : undefined
        const previousHashes = plugin.file_hashes
        if (saved.vaultRevision !== currentRevision()) throw staleCachePreview()
        let attemptedIndex = false
        let attemptedHashes = false
        try {
            if (changesIndex) {
                attemptedIndex = true
                await adapter.write(path, next.serializedAfter)
            }
            if (saved.vaultRevision !== currentRevision()) throw staleCachePreview()
            if (next.plan.summary.hashes) {
                attemptedHashes = true
                plugin.file_hashes = next.hashes
                await plugin.saveAllData()
            }
            if (saved.vaultRevision !== currentRevision()) throw staleCachePreview()
        } catch (error) {
            plugin.file_hashes = previousHashes
            let restored = true
            if (attemptedHashes) {
                try { await plugin.saveAllData() } catch { state.saveData = true; restored = false }
            }
            if (attemptedIndex) {
                try {
                    if (previousIndex !== undefined) await adapter.write(path, previousIndex)
                    else if (await adapter.exists(path)) await adapter.remove(path)
                } catch { state.saveIndex = true; restored = false }
            }
            state.cacheRevision++
            if (!restored) throw new Error('Could not save or restore the cache files. Check write access before retrying.')
            throw error
        }
        state.entries = next.entries
        state.mediaIndex = next.mediaIndex
        for (const removed of missing) {
            updateIdOwners(state, removed)
            state.modified.delete(removed)
            state.pathRevisions.delete(removed)
            state.editorModified.delete(removed)
        }
        state.cacheRevision++
        cachePreviews.delete(preview)
        return next.plan
    })
}

export function clearFastScanCache(plugin: MyPlugin, kind: 'files' | 'media'): Promise<void> {
    const t = uiFor(plugin.settings)
    registerFastScan(plugin)
    const state = states.get(plugin)!
    const label = kind === 'files' ? 'File Hash Cache' : 'Media Cache'
    const previous = state.resetting ?? state.running
    if (state.running && !state.resetting) {
        new Notice(t('Export to Anki: the cache will be cleared after the current scan.',
            'Кеш будет очищен после завершения текущей проверки.'))
    }

    const reset = (async () => {
        await previous
        try {
            if (!state.loaded) await loadIndex(plugin, state)
            if (kind === 'files') {
                plugin.file_hashes = {}
                state.entries.clear()
                clearIdOwners(state)
                state.pathRevisions.clear()
                state.cacheEpoch = ++state.revision
                state.modified.clear()
                state.editorModified.clear()
                state.context = null
                state.saveIndex = true
            } else {
                plugin.added_media = []
                for (const { path } of state.mediaIndex.values()) markModified(state, path)
            }
            state.saveData = true
            await flush(plugin, state)
            new Notice(t(`${label} cleared successfully!`,
                kind === 'files' ? 'Кеш проверки файлов очищен.' : 'Кеш вложений очищен.'))
        } catch (error) {
            console.error('[Export to Anki] Could not clear ' + label, error)
            new Notice(t(`Export to Anki: could not save the ${label} reset. See the developer console.`,
                'Не удалось сохранить сброс кеша. Подробности — в консоли разработчика.'))
        }
    })()
    state.resetting = reset
    return reset.finally(() => {
        if (state.resetting === reset) state.resetting = null
    })
}

function clearIdOwners(state: ScanState): void {
    state.idsByPath.clear()
    state.idOwners.clear()
    state.duplicateIds.clear()
}

function updateIdOwners(state: ScanState, path: string, next?: IdEntry): void {
    const previous = state.idsByPath.get(path)
    const before = previous?.[3] ?? []
    const after = next?.[3] ?? []
    if (before.length === after.length && before.every((id, index) => id === after[index])) {
        if (next) state.idsByPath.set(path, next)
        else state.idsByPath.delete(path)
        return
    }
    const counts = new Map<number, number>()
    for (const id of after) counts.set(id, (counts.get(id) ?? 0) + 1)
    const touched = new Set(before)
    for (const id of counts.keys()) touched.add(id)
    for (const id of touched) {
        const owners = state.idOwners.get(id) ?? new Map<string, number>()
        const count = counts.get(id)
        if (count) owners.set(path, count)
        else owners.delete(path)
        if (owners.size) state.idOwners.set(id, owners)
        else state.idOwners.delete(id)
        if (owners.size > 1 || (owners.values().next().value ?? 0) > 1) state.duplicateIds.add(id)
        else state.duplicateIds.delete(id)
    }
    if (next) state.idsByPath.set(path, next)
    else state.idsByPath.delete(path)
}

async function indexNoteIds(plugin: MyPlugin, state: ScanState, files: readonly TFile[],
    candidates: ReadonlySet<string>, rescan: ReadonlySet<string>, pending: Set<string>, expected: ReadonlyMap<string, string>,
    errors: string[], shouldStop?: () => boolean): Promise<{ preloaded: Map<string, string>; duplicates: Map<number, string>;
        conflictingPaths: Map<string, Set<number>>; reads: number }> {
    const refresh: TFile[] = []
    let knownPaths = 0
    for (const file of files) {
        const path = file.path
        const entry = state.idsByPath.get(path)
        if (entry) knownPaths++
        if (!pending.has(path) && (!entry || state.modified.has(path) || rescan.has(path) || !sameStat(file, entry))) {
            refresh.push(file)
        }
    }
    if (knownPaths < state.idsByPath.size) {
        const scope = new Set<string>()
        for (const { path } of files) if (state.idsByPath.has(path)) scope.add(path)
        for (const path of state.idsByPath.keys()) {
            if (!scope.has(path)) {
                updateIdOwners(state, path)
                state.saveIndex = true
            }
        }
    }
    const preloaded = new Map<string, string>()
    let buffered = 0
    let reads = 0
    const bufferLimit = shouldStop ? sourceBufferBytes : sourceBufferBytes / 4
    for (let offset = 0; offset < refresh.length; offset += 8) {
        if (shouldStop?.()) break
        const group = refresh.slice(offset, offset + 8)
        reads += group.length
        await Promise.all(group.map(async file => {
            const candidate = snapshot(file, state)
            const { path, stamp } = candidate
            try {
                const text = await plugin.app.vault.read(file)
                if (!stillCurrent(candidate, state)) throw new Error('file changed during ID check')
                const editorText = expected.get(path)
                if (editorText !== undefined && !sameEditorText(text, editorText)) {
                    throw new Error('editor changes have not reached the file yet. Run the scan again after saving.')
                }
                updateIdOwners(state, path, [stamp[0], stamp[1], stamp[2], findIdMarkers(text, plugin.settings.Syntax).map(marker => marker.id)])
                state.saveIndex = true
                const cost = 2 * text.length + 128
                if (candidates.has(path) && buffered + cost <= bufferLimit) {
                    preloaded.set(path, text)
                    buffered += cost
                }
            } catch (error) {
                pending.add(path)
                errors.push(`${path}: ${String(error)}`)
            }
        }))
    }
    const duplicates = new Map<number, string>()
    const conflictingPaths = new Map<string, Set<number>>()
    for (const id of state.duplicateIds) {
        const owners = state.idOwners.get(id)!
        const distinct = Array.from(owners.keys()).sort()
        const locations = distinct.length === 1 ? `${distinct[0]} (${owners.get(distinct[0])} occurrences)` : distinct.join(' and ')
        duplicates.set(id, `Duplicate Anki note ID ${id} in ${locations}. Keep the ID in one source.`)
        for (const path of distinct) {
            const ids = conflictingPaths.get(path) ?? new Set<number>()
            ids.add(id)
            conflictingPaths.set(path, ids)
        }
    }
    return { preloaded, duplicates, conflictingPaths, reads }
}

async function indexProfileNoteIds(plugin: MyPlugin, state: ScanState, files: readonly TFile[],
    selected: ReadonlySet<string>, contentPaths: ReadonlySet<string>, force: boolean, shouldStop?: () => boolean,
    recordSelectedIds = false, card?: CursorCardTarget) {
    const preloaded = new Map<string, string>()
    let buffered = 0
    const revision = state.scopeRevision
    const result = await indexVaultIds(plugin, files, plugin.settings.Syntax,
        path => Math.max(state.cacheEpoch, state.pathRevisions.get(path) ?? 0), {
            force, shouldStop, needsContent: path => contentPaths.has(path),
            onFile: (file, path, markers, content) => {
                if (recordSelectedIds && selected.has(path)) {
                    const indexed = state.idsByPath.get(path)
                    if (!indexed || !sameStat(file, indexed) || state.modified.has(path)) {
                        const { mtime, ctime, size } = file.stat
                        updateIdOwners(state, path, [mtime, ctime, size, markers.map(marker => marker.id)])
                        state.saveIndex = true
                    }
                }
                if (content === undefined || !contentPaths.has(path)) return
                const bytes = 2 * content.length + 128
                if (buffered + bytes > sourceBufferBytes) return
                preloaded.set(path, content)
                buffered += bytes
            },
        })
    const duplicates = new Map<number, string>()
    const conflictingPaths = new Map<string, Set<number>>()
    for (const [id, locations] of result.duplicates) {
        if (card && id !== card.id) continue
        const affected = new Set(locations.filter(location => selected.has(location.path)).map(location => location.path))
        if (!affected.size) continue
        const description = locations.map(item => `${item.path} · line ${item.line}`).join(' and ')
        duplicates.set(id, `Duplicate Anki note ID ${id} in ${description}. Keep the ID in one source.`)
        for (const path of affected) {
            const ids = conflictingPaths.get(path) ?? new Set<number>()
            ids.add(id)
            conflictingPaths.set(path, ids)
        }
    }
    const errors = result.errors.map(item => `${item.path}: ${item.message}`)
    if (state.scopeRevision !== revision) errors.push('The vault changed while checking Anki IDs. Run the scan again.')
    return {
        preloaded, duplicates, conflictingPaths, reads: result.reads, revision, errors,
        complete: result.complete && state.scopeRevision === revision,
    }
}

function snapshot(file: TFile, state: ScanState): Candidate {
    const { mtime, ctime, size } = file.stat
    return {
        file,
        path: file.path,
        stamp: [mtime, ctime, size, null],
        revision: state.modified.get(file.path),
    }
}

function stillCurrent(candidate: Candidate, state: ScanState): boolean {
    const { file, path, stamp, revision } = candidate
    return file.path === path && revision === state.modified.get(path) && sameStat(file, stamp)
}

function remember(candidate: Candidate, hash: string, state: ScanState): void {
    if (!stillCurrent(candidate, state)) return
    candidate.stamp[3] = hash
    state.entries.set(candidate.path, candidate.stamp)
    state.modified.delete(candidate.path)
    state.editorModified.delete(candidate.path)
    state.saveIndex = true
}

function setHash(plugin: MyPlugin, state: ScanState, path: string, hash: string | undefined): void {
    const old = Object.prototype.hasOwnProperty.call(plugin.file_hashes, path)
        ? plugin.file_hashes[path]
        : undefined
    if (hash === old) return
    if (hash === undefined) {
        delete plugin.file_hashes[path]
    } else {
        Object.defineProperty(plugin.file_hashes, path, {
            value: hash, writable: true, enumerable: true, configurable: true,
        })
    }
    state.saveData = true
}

async function findExistingIds(ids: ReadonlySet<number>, onQuery?: () => void): Promise<number[]> {
    const requested = Array.from(ids)
    const found: number[] = []
    for (let offset = 0; offset < requested.length; offset += idsPerQuery) {
        const batch = requested.slice(offset, offset + idsPerQuery)
        const expected = new Set(batch)
        onQuery?.()
        const response: unknown = await withAnkiDeadline(
            () => AnkiConnect.invoke('findNotes', { query: `nid:${batch.join(',')}` }), 'Anki ID search')
        if (!isList(response) || !response.every((id): id is number => typeof id === 'number' && expected.has(id)) || new Set(response).size !== response.length) {
            throw new Error('findNotes: AnkiConnect did not return the requested numeric note IDs')
        }
        found.push(...response)
    }
    return found
}

export interface AuditedExportPreview {
    deck: string
    ankiProfile: string
    paths: ReadonlySet<string>
    ids: ReadonlySet<number>
    scopeSignature: string
}

async function checkAuditPreviewScope(plugin: MyPlugin, scope: AuditedExportPreview, signal?: AbortSignal): Promise<void> {
    if (scope.scopeSignature !== syncScopeSignature(plugin.settings)) {
        throw new Error('The sync profile changed. Start the audit again.')
    }
    await requireExpectedAnkiProfile(plugin, scope.ankiProfile, signal)
    const current = await readSyncAuditNoteInventory(scope.deck, signal)
    await requireExpectedAnkiProfile(plugin, scope.ankiProfile, signal)
    if (!current || Array.from(scope.ids).some(id => !current.has(id))) {
        throw new Error('The audited deck changed. Start the audit again.')
    }
}

export async function previewVaultExport(plugin: MyPlugin, auditScope?: AuditedExportPreview,
    requestedPaths?: ReadonlySet<string>, card?: CursorCardTarget): Promise<void> {
    const t = uiFor(plugin.settings)
    if (card) {
        if (cursorConfiguration(plugin) !== card.configuration) throw staleCursorCard()
        requestedPaths = new Set([card.path])
    }
    if (plugin.settings.BIDIRECTIONAL_SYNC === true && !(card && card.id === undefined)) {
        if (auditScope) new Notice(t('Use the bidirectional preview to resolve these differences.',
            'Откройте двусторонний предпросмотр для разрешения этих расхождений.'))
        else if (card) await runBidirectionalSync(plugin, { paths: requestedPaths, card })
        else return previewBidirectionalSync(plugin, requestedPaths ? { paths: requestedPaths } : undefined)
        return
    }
    if (hasPendingBidirectionalWrite(plugin.app)) {
        new Notice(t(pendingBidirectionalWriteMessage, 'Дождитесь завершения предыдущей операции двусторонней синхронизации.'))
        return
    }
    const previewInputs = () => [scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings)),
        plugin.fields_dict, syncScopeSignature(plugin.settings)] as const
    const getConfiguration = () => JSON.stringify(previewInputs())
    try {
        if (!await prepareInitialSchema(plugin)) return
        const result = await withFastScanReadLock(plugin, async currentRevision => {
            const state = states.get(plugin)!
            if (!state.loaded) await loadIndex(plugin, state)
            const revision = currentRevision()
            if (card) {
                if (cursorConfiguration(plugin) !== card.configuration) throw staleCursorCard()
                checkCursorEditors(plugin, card)
            }
            const { app } = plugin
            const { files: allSelectedFiles, allFiles, paths: allSelectedPaths, label: scopeLabel, profileId } = resolveSyncScope(plugin)
            if (auditScope) await checkAuditPreviewScope(plugin, auditScope)
            const scope = allSelectedFiles.filter(file => (!auditScope || auditScope.paths.has(file.path)) &&
                (!requestedPaths || requestedPaths.has(file.path)))
            const paths = auditScope || requestedPaths ? new Set(scope.map(file => file.path)) : allSelectedPaths
            if (requestedPaths && !scope.length) throw new Error(`The selected files are outside ${scopeLabel} or no longer exist.`)
            const ankiProfile = await requireExpectedAnkiProfile(plugin, card?.profile ?? auditScope?.ankiProfile)
            const history = await openOneWayHistory(plugin, ankiProfile)
            const expected = new Map<string, string>()
            const errors: string[] = []
            const pending = new Set<string>()
            for (const { view } of app.workspace.getLeavesOfType('markdown')) {
                if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file || !paths.has(view.file.path)) continue
                const path = view.file.path
                const text = view.getViewData()
                if (!sameEditorText(text, view.data) && !pending.has(path)) {
                    pending.add(path)
                    errors.push(`${path}: save the current edits before previewing this file.`)
                }
                expected.set(path, text)
            }
            const local: ScanState = { ...state, idsByPath: new Map(), idOwners: new Map(), duplicateIds: new Set() }
            const inputs = structuredClone(previewInputs())
            const configuration = JSON.stringify(inputs)
            const [settings, fields] = inputs
            const profileOwnership = profileId || card
                ? await indexProfileNoteIds(plugin, state, allFiles, paths, paths, false, undefined, false, card)
                : undefined
            if (profileOwnership && !profileOwnership.complete) {
                throw new Error(profileOwnership.errors[0] ?? 'Could not verify duplicate Anki IDs.')
            }
            const ownership = profileOwnership ?? await indexNoteIds(plugin, local, allSelectedFiles, paths, paths, new Set(), new Map(), errors)
            const data = await settingToData(app, settings, fields, [])
            const rows = new Map<string, ExportPreviewRow>()
            const sourceHashes = new Map<string, string>()
            const decksByPath = new Map<string, string>()
            const emptyRow = (path: string): ExportPreviewRow => ({ path, added: 0, updated: 0, moved: 0, deleted: 0 })
            const checkFields = generatedRuleGuard(settings, fields, modelName => auditRead('modelFieldNames', { modelName }), t)
            const duplicatePreflight = new DuplicatePreflight()
            for (let offset = 0; offset < scope.length; offset += filesPerBatch) {
                const batch = scope.slice(offset, offset + filesPerBatch).filter(file => !pending.has(file.path))
                const manager = new FileManager(app, data, batch, {}, [...plugin.added_media])
                manager.cursorCard = card
                manager.deletedArchiveLabel = t('Deleted from Anki', 'Удалено из Anki')
                manager.afterDeleteMode = afterDeleteMode(settings)
                manager.trashDeletedPages = settings.TRASH_DELETED_PAGES === true
                manager.duplicatePreflight = duplicatePreflight
                manager.ankiProfile = ankiProfile
                manager.diagnosticSyntax = settings.Syntax
                manager.oneWayHistory = history
                manager.mediaIndex = state.mediaIndex
                manager.imageOptimization = readImageOptimization(settings.IMAGE_OPTIMIZATION)
                manager.getRecovery = () => exportRecovery(plugin, state)
                manager.stopAfterPacket = () => currentRevision() !== revision
                await manager.initialiseFiles(findExistingIds, expected, {
                    textByPath: ownership.preloaded, fullExport: paths, duplicates: ownership.duplicates,
                    conflictingPaths: ownership.conflictingPaths,
                })
                const badFields = await checkFields(manager.ownFiles)
                if (badFields.size) {
                    for (const [path, error] of badFields) errors.push(path + ': ' + error)
                    manager.ownFiles = manager.ownFiles.filter(file => !badFields.has(file.path))
                    manager.files = manager.files.filter(file => !badFields.has(file.path))
                }
                for (const note of manager.ownFiles) decksByPath.set(note.path, note.target_deck)
                for (const full of await manager.describeExportPlan()) {
                    const auditOperations = auditScope && full.operations?.filter(operation =>
                        (operation.kind === 'field' || operation.kind === 'tags') && operation.id !== undefined &&
                        auditScope.ids.has(operation.id) && operation.deck !== undefined &&
                        syncAuditDeckKey(operation.deck) === syncAuditDeckKey(auditScope.deck))
                    const auditConflict = auditScope && syncAuditDeckKey(decksByPath.get(full.path) ?? '') === syncAuditDeckKey(auditScope.deck)
                        ? full.fieldConflicts?.filter(field => auditScope.ids.has(field.id)) : undefined
                    const requiresMedia = auditScope && full.operations?.some(operation => operation.kind === 'media')
                    if (auditScope && !auditOperations?.length && !auditConflict?.length) continue
                    const row: ExportPreviewRow = auditScope ? { ...emptyRow(full.path), deck: auditScope.deck,
                        updated: requiresMedia ? 0 : new Set(auditOperations?.map(operation => operation.id)).size,
                        operations: requiresMedia ? [] : auditOperations || [],
                        fieldConflicts: requiresMedia ? [] : auditConflict,
                        errors: requiresMedia ? [t('Review this file and its attachments in the general export preview.',
                            'Проверьте этот файл и его вложения в общем предпросмотре экспорта.')] : undefined,
                    } : full
                    rows.set(row.path, row)
                    const hash = manager.sourceHashes.get(row.path)
                    if (hash !== undefined) sourceHashes.set(row.path, hash)
                }
                for (const [path, cardIssues] of manager.cardIssues) {
                    rows.set(path, { ...(rows.get(path) ?? emptyRow(path)), cardIssues })
                }
                errors.push(...manager.scanErrors, ...manager.retryMessages, ...manager.blockedUpdates.values())
            }
            if (currentRevision() !== revision || configuration !== getConfiguration()) {
                throw new Error('The vault or settings changed during the preview. Run the preview again.')
            }
            await requireExpectedAnkiProfile(plugin, ankiProfile)
            if (currentRevision() !== revision || configuration !== getConfiguration()) {
                throw new Error('The vault or settings changed during the preview. Run the preview again.')
            }
            for (const error of new Set(errors)) {
                const boundary = error.indexOf(': ')
                const prefix = boundary < 0 ? '' : error.slice(0, boundary)
                const path = paths.has(prefix) ? prefix : 'Export'
                const row = rows.get(path) ?? emptyRow(path)
                rows.set(path, { ...row, errors: [...(row.errors ?? []), error] })
            }
            const previewRows = Array.from(rows.values())
            for (const row of previewRows) if (row.errors?.length || row.cardIssues?.length) row.deck = decksByPath.get(row.path)
            return { rows: previewRows, paths, sourceHashes,
                revision, currentRevision, configuration, scopeLabel,
                namedScope: !!profileId, ankiProfile }
        })
        const confirmedDeckMoves = new Map(result.rows.filter(row => row.deckMoves?.length)
            .map(row => [row.path, row.deckMoves!] as const))
        const scopeDescription = card ? t(`${card.path} · One card`, `${card.path} · Одна карточка`) :
            auditScope?.deck ?? (requestedPaths ? t(`${result.paths.size} selected files`, `Выбранных файлов: ${result.paths.size}`) :
                result.namedScope ? result.scopeLabel : t(result.scopeLabel, 'Всё хранилище'))
        openExportPreview(plugin.app, result.rows, selected => {
            try {
                if (result.currentRevision() === result.revision && result.configuration === getConfiguration()) {
                    const confirmedFields = selected.conflicts
                    const selectedPaths = new Set<string>()
                    const omittedPaths = new Set<string>(card ? [card.path] : [])
                    const confirmedDeletions = new Map<string, ReadonlySet<number>>()
                    for (const row of result.rows) {
                        if (!result.paths.has(row.path)) continue
                        const keys = selected.paths.get(row.path)
                        if (!keys?.size && !row.fieldConflicts?.some(field => confirmedFields.has(oneWayFieldChoice(field)))) continue
                        selectedPaths.add(row.path)
                        if (row.operations?.some(operation => !keys?.has(operation.key))) omittedPaths.add(row.path)
                        const ids = row.operations?.flatMap(operation => operation.kind === 'delete' &&
                            operation.id !== undefined && keys?.has(operation.key) ? [operation.id] : []) ?? []
                        if (ids.length) confirmedDeletions.set(row.path, new Set(ids))
                    }
                    if (!selectedPaths.size) return
                    void scanVaultFast(plugin, false, false, selectedPaths, confirmedDeletions,
                        { expectedPreviewHashes: result.sourceHashes, previewSelection: selected, omittedPreviewPaths: omittedPaths,
                            auditedPreview: auditScope, cursorCard: card },
                        confirmedDeckMoves, result.ankiProfile, confirmedFields)
                    return
                }
            } catch {
                // Failed revalidation also requires a fresh preview.
            }
            new Notice(t('Files or settings changed. Run the export preview again.',
                'Файлы или настройки изменились. Запустите предпросмотр экспорта заново.'))
        }, t(`${scopeDescription} · Anki profile: ${result.ankiProfile}`,
            `${scopeDescription} · профиль Anki: ${result.ankiProfile}`), t,
            states.get(plugin)?.openAudit, plugin.settings.Syntax, result.ankiProfile)
    } catch (error) {
        if (error instanceof AnkiProfileError) showAnkiProfileProblem(plugin, error)
        else new Notice(t(`Export preview stopped. ${String(error)}`,
            `Предпросмотр экспорта остановлен. ${localizeExportError(String(error), t)}`))
    }
}

interface ExportControl {
    signal?: AbortSignal
    onProgress?: (progress: ExportProgress) => void
    scopeSignature?: string
    onProfileBlocked?: (error: AnkiProfileError) => void
    expectedPreviewHashes?: ReadonlyMap<string, string>
    previewSelection?: ExportPreviewSelection
    omittedPreviewPaths?: ReadonlySet<string>
    auditedPreview?: AuditedExportPreview
    cursorCard?: CursorCardTarget
    cursorRecovery?: { path: string; token: string }
}

export type ExportScanOutcome = ExportRunReport['outcome'] | 'busy'

export async function scanVaultFast(plugin: MyPlugin, scan: boolean | 'scheduled' = false, currentOnly = false,
    onlyPaths?: ReadonlySet<string>, confirmedDeletions?: ReadonlyMap<string, ReadonlySet<number>>,
    control?: ExportControl, confirmedDeckMoves?: ReadonlyMap<string, readonly ExportDeckMove[]>,
    previewProfile?: string, confirmedFields?: ReadonlySet<string>): Promise<ExportScanOutcome> {
    const t = uiFor(plugin.settings)
    const force = scan === true
    // Capture the command target before waiting for locks, profile checks or the state index.
    const current = currentOnly ? plugin.app.workspace.getActiveFile() : null
    const currentPath = current?.path
    if (currentOnly && (!current || !/\.md$/i.test(current.path))) {
        new Notice(t('Open a Markdown file to sync it with Anki.', 'Откройте Markdown-файл для синхронизации с Anki.'))
        return 'failed'
    }
    if (hasActiveLegacyPlugin(plugin.app)) {
        new Notice(previousPluginMessage(plugin.app, t))
        return 'stopped'
    }
    try { await requireSettledZipImport(plugin) }
    catch (error) { new Notice(String(error)); return 'stopped' }
    const blockedBeforeWrite = (error: AnkiProfileError) => {
        if (control?.onProfileBlocked) control.onProfileBlocked(error)
        else showAnkiProfileProblem(plugin, error, 'before-write')
        return 'blocked-profile' as const
    }
    if (previewProfile !== undefined && isAnkiProfileLockEnabled(plugin) && previewProfile !== expectedAnkiProfile(plugin)) {
        return blockedBeforeWrite(new AnkiProfileError('changed', previewProfile, expectedAnkiProfile(plugin)))
    }
    const cursor = control?.cursorCard
    const cursorRecovery = control?.cursorRecovery
    if (cursorRecovery && (!previewProfile || onlyPaths?.size !== 1 || !onlyPaths.has(cursorRecovery.path))) return 'stopped'
    if (cursor && (cursorConfiguration(plugin) !== cursor.configuration || !control?.previewSelection ||
        onlyPaths?.size !== 1 || !onlyPaths.has(cursor.path) || previewProfile !== cursor.profile)) {
        new Notice(staleCursorCard().message)
        return 'stopped'
    }
    if (plugin.settings.BIDIRECTIONAL_SYNC === true && !(cursor && cursor.id === undefined) && !cursorRecovery) {
        // A retry belongs to its one-way export and profile. Switching modes must not turn it into an import.
        if (control || previewProfile !== undefined) {
            new Notice(t('This action belongs to a one-way export. Switch to one-way mode and retry, or start a new bidirectional sync.',
                'Это действие относится к одностороннему экспорту. Переключитесь на односторонний режим и повторите или запустите новую двустороннюю синхронизацию.'))
            return 'stopped'
        }
        return runBidirectionalSync(plugin, { currentFile: current && currentPath ? { file: current, path: currentPath } : undefined,
            paths: onlyPaths, force, scheduled: scan === 'scheduled' })
    }
    try {
        if (!await prepareInitialSchema(plugin)) return 'failed'
    } catch (error) {
        if (error instanceof AnkiProfileError) return blockedBeforeWrite(error)
        throw error
    }
    if (hasPendingBidirectionalWrite(plugin.app)) {
        new Notice(t(pendingBidirectionalWriteMessage, 'Дождитесь завершения предыдущей операции двусторонней синхронизации.'))
        return 'busy'
    }
    if (hasPendingAnkiWrite(plugin.app)) {
        new Notice(t(pendingAnkiWriteMessage, 'AnkiConnect ещё обрабатывает предыдущую запись. Проверьте Anki и повторите после завершения операции.'))
        return 'busy'
    }
    registerFastScan(plugin)
    const state = states.get(plugin)!
    if (state.running || state.resetting) {
        new Notice(t('Export to Anki: a scan or cache reset is already running.', 'Уже идёт экспорт в Anki или сброс кеша.'))
        return 'busy'
    }
    dismissMissingCardReview(plugin.app)
    let finishScan!: () => void
    state.running = new Promise<void>(resolve => { finishScan = resolve })

    const expectedPreviewHashes = control?.expectedPreviewHashes
    const applyingPreview = expectedPreviewHashes !== undefined
    const counts = { files: 0, reads: 0, exportFiles: 0, idLookups: 0,
        cachedIds: 0, cachedIdRequests: 0, deferred: 0 }
    const errors: string[] = []
    const cardIssuesByPath = new Map<string, readonly ExportCardIssue[]>()
    const decksByPath = new Map<string, string>()
    const detectedDuplicates = new Set<number>()
    const confirmedMediaLinks = new Map<string, ReadonlySet<string>>()
    const cardImpactResults: string[] = []
    const idDateWarnings = new Set<string>()
    const attemptedPaths = new Set<string>()
    const confirmedPaths = new Set<string>()
    let scope: string = 'Entire vault'
    let profileSignature: string | undefined
    let reportRun = false
    let failed = false
    let blockedProfile: AnkiProfileError | undefined
    const profileLockEnabled = isAnkiProfileLockEnabled(plugin)
    const intendedProfile = previewProfile ?? expectedAnkiProfile(plugin)
    let ankiProfile: string | undefined
    let history: OneWayHistory | undefined
    const logMode = plugin.settings.BIDIRECTIONAL_SYNC === true ? 'two-way' : 'one-way'
    const changeLog: SyncHistoryChange[] = []
    let loggedChanges = false
    const appendChange = (row: Omit<SyncHistoryChange, 'mode' | 'profile'>) => {
        changeLog.push({ ...row, mode: logMode, profile: ankiProfile ?? intendedProfile })
        if (changeLog.length > syncHistoryLimit * 2) changeLog.splice(0, changeLog.length - syncHistoryLimit)
    }
    const flushChanges = async () => {
        if (changeLog.length) await recordSyncChanges(plugin, changeLog.splice(0))
    }
    let operationJournal: ExportOperationJournal | undefined
    let submittedRequests = 0
    let answeredRequests = 0
    const changes = new SyncOutcome()
    let markdownChanged = false
    let recoveredCreations = 0
    let outcome: ExportRunReport['outcome'] = 'completed'
    let stopRequested = false
    let timer: number | undefined
    let progressView: ReturnType<typeof openExportProgress> | undefined
    let progress: ExportProgress = { total: 0, confirmed: 0, pending: 0, stage: t('Checking changed files', 'Проверяем изменённые файлы') }
    let deletionBackup: Promise<string> | undefined
    let backup: Promise<BackupCheck> | undefined
    const beforeMutation = readBackupSettings(plugin.settings.VAULT_BACKUP).enabled
        ? () => backup ? backup.then(result => ({ ...result, created: false })) : (backup = ensureScheduledBackup(plugin, ankiProfile))
        : undefined
    const shouldStop = () => stopRequested || control?.signal?.aborted === true
    const notifyIssues = (allowSkip: boolean) => showExportIssues(plugin, errors, counts.deferred, changes.message(t),
        detectedDuplicates, attemptedPaths, cardIssuesByPath, decksByPath, allowSkip, ankiProfile, profileSignature)
    const showProgress = (stage: string) => {
        const confirmed = confirmedPaths.size
        progress = { stage, total: attemptedPaths.size, confirmed, pending: attemptedPaths.size - confirmed }
        control?.onProgress?.(progress)
        progressView?.update(progress)
    }
    const accept = (candidate: Candidate, hash: string, hasSuspension: boolean) => {
        if (hasSuspension) candidate.stamp[4] = true
        remember(candidate, hash, state)
        if (state.entries.get(candidate.path) === candidate.stamp) confirmedPaths.add(candidate.path)
    }
    const checkpoint = async () => {
        if (history) await history.flush()
        await operationJournal?.confirmFiles(confirmedPaths)
        if (reconcileMediaNotes(state.mediaIndex, confirmedMediaLinks, ankiProfile)) state.saveIndex = true
        confirmedMediaLinks.clear()
        if (state.saveData || state.saveIndex) await flush(plugin, state)
    }
    try {
        if (!state.loaded) await loadIndex(plugin, state)
        if (control?.auditedPreview) await checkAuditPreviewScope(plugin, control.auditedPreview, control.signal)

        const vault = plugin.app.vault
        const selection = resolveSyncScope(plugin)
        const { allFiles, files: scopeFiles, label, profileId, signature } = selection
        if (control?.scopeSignature !== undefined && control.scopeSignature !== signature) {
            throw new Error('The sync profile changed. Start the audit again.')
        }
        profileSignature = signature
        if (current && (current.path !== currentPath || !allFiles.includes(current))) {
            new Notice(t('The selected Markdown file was moved or removed. Run the command again.',
                'Выбранный Markdown-файл перемещён или удалён. Повторите команду.'))
            return 'stopped'
        }
        if (current && !selection.contains(current.path)) {
            const reason = selection.excludes(current.path) ? 'is excluded by' : 'is outside'
            new Notice(t(`Export to Anki: the current note ${reason} "${label}".`,
                `Текущая заметка не входит в область экспорта «${label}».`))
            return 'failed'
        }
        const files = current ? [current] : onlyPaths ? scopeFiles.filter(file => onlyPaths.has(file.path)) : scopeFiles
        scope = cursor ? t(`One card · ${cursor.path}`, `Одна карточка · ${cursor.path}`) :
            current ? profileId ? `${label} · ${current.path}` : current.path :
            onlyPaths ? `${files.length} selected files · ${label}` : label
        if (onlyPaths?.size && !files.length) {
            new Notice(t(`Export to Anki: the selected files are outside "${label}" or no longer exist.`,
                `Выбранные файлы вне области «${label}» или были удалены.`))
            return 'failed'
        }
        if (!profileLockEnabled && files.length) {
            if (shouldStop()) return 'stopped'
            ankiProfile = await requireExpectedAnkiProfile(plugin, previewProfile, control?.signal)
        }
        counts.files = files.length
        const { pending, expected } = await saveOpenEdits(plugin, state,
            path => current ? path === current.path : selection.contains(path) && (!onlyPaths || onlyPaths.has(path)),
            errors, !currentOnly && !force && !applyingPreview && !cursorRecovery, applyingPreview || !!cursorRecovery)
        counts.deferred += pending.size
        for (const path of pending) attemptedPaths.add(path)

        const activeFile = plugin.app.workspace.getActiveFile?.()
        if (activeFile && !force && !currentOnly && !onlyPaths && selection.contains(activeFile.path) &&
            !isSyncAuditReportPath(activeFile.path) && !pending.has(activeFile.path) && !state.modified.has(activeFile.path)) {
            const path = activeFile.path
            const entry = state.entries.get(path)
            if (entry && sameStat(activeFile, entry)) {
                counts.reads++
                const saved = await vault.read(activeFile)
                if (activeFile.path !== path || !sameStat(activeFile, entry) || Md5.hashStr(saved) !== entry[3]) {
                    markModified(state, path)
                    if (activeFile.path !== path) markModified(state, activeFile.path)
                }
            }
        }

        const { ['Add Date to Anki IDs']: addDateToIds, ...exportDefaults } = plugin.settings.Defaults
        const { VAULT_BACKUP: backupSettings, REQUIRE_ANKI_PROFILE: lockSetting, EXPECTED_ANKI_PROFILE: savedProfile,
            BIDIRECTIONAL_FIELDS: additionalBidirectionalFields,
            ...scanSettings } = scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings))
        const exportSettings = { ...scanSettings, Defaults: addDateToIds ? { ...exportDefaults, ['Add Date to Anki IDs']: true } : exportDefaults }
        const settings: MyPlugin['settings'] = structuredClone(exportSettings)
        const fields = structuredClone(plugin.fields_dict)
        const context = !profileLockEnabled && !files.length && state.context !== null ? state.context
            : JSON.stringify([vault.getName(), settings, fields, ankiProfile ?? intendedProfile])
        const routingKey = routingSettingsKey(plugin.settings)
        const initialFolderDecks = plugin.settings.FOLDER_DECKS
        const initialForcedDefaults = plugin.settings.FOLDER_DEFAULT_DECKS
        const initialDeckDirective = plugin.settings.Syntax?.['Target Deck Line']
        const initialSuspendDirective = plugin.settings.Syntax?.['Suspend Line']
        const initialSuspendAliases = plugin.settings.Syntax?.['Suspend Line Aliases']
        const initialActiveFolderProfile = plugin.settings.ACTIVE_SYNC_FOLDER_PROFILE
        let staleRouting = false
        const routingChanged = () => staleRouting ||= (cursor !== undefined && cursorConfiguration(plugin) !== cursor.configuration) || plugin.settings.Defaults.Deck !== exportDefaults.Deck ||
            plugin.settings.FOLDER_DECKS !== initialFolderDecks || plugin.settings.FOLDER_DEFAULT_DECKS !== initialForcedDefaults ||
            plugin.settings.Syntax?.['Target Deck Line'] !== initialDeckDirective ||
            plugin.settings.Syntax?.['Suspend Line'] !== initialSuspendDirective ||
            plugin.settings.Syntax?.['Suspend Line Aliases'] !== initialSuspendAliases ||
            plugin.settings.ACTIVE_SYNC_FOLDER_PROFILE !== initialActiveFolderProfile
        const requireCurrentRouting = () => {
            if (routingChanged() || routingSettingsKey(plugin.settings) !== routingKey || syncScopeSignature(plugin.settings) !== signature) {
                staleRouting = true
                throw new Error(staleRoutingMessage)
            }
        }
        const reprocess = state.context !== context
        const candidates: Candidate[] = []
        const fullExport = new Set<string>()
        const verifyOnly = new Set<string>()
        const suspendOnly = new Set<string>()
        const warmSources: Array<{ path: string; file: TFile; ids: IdEntry }> = []
        const warmIds = new Set<number>()
        const queueVerification = (file: TFile) => {
            const candidate = snapshot(file, state)
            verifyOnly.add(candidate.path)
            fullExport.add(candidate.path)
            attemptedPaths.add(candidate.path)
            candidates.push(candidate)
        }
        const mediaChanges = currentOnly || onlyPaths ? undefined :
            changedMediaNotes(plugin.app, state.mediaIndex, state.pathRevisions, state.mediaRevisions,
                plugin.settings.IMAGE_OPTIMIZATION?.enabled === true && plugin.settings.IMAGE_OPTIMIZATION.checkChanges === true)
        for (const file of files) {
            const path = file.path
            if (isSyncAuditReportPath(path)) {
                counts.files--
                continue
            }
            if (pending.has(path)) continue
            const entry = reprocess ? undefined : state.entries.get(path)
            if (
                !force && !currentOnly && !onlyPaths && !applyingPreview && !mediaChanges?.has(path) && entry && !state.modified.has(path) && sameStat(file, entry) &&
                plugin.file_hashes[path] === entry[3]
            ) {
                if (entry[4] === true) {
                    suspendOnly.add(path)
                    fullExport.add(path)
                    candidates.push(snapshot(file, state))
                    attemptedPaths.add(path)
                    continue
                }
                const ids = state.idsByPath.get(path)
                if (!ids || !sameStat(file, ids)) queueVerification(file)
                else if (ids[3].length) {
                    warmSources.push({ path, file, ids })
                    for (const id of ids[3]) warmIds.add(id)
                }
                continue
            }

            if (force || currentOnly || onlyPaths || mediaChanges?.has(path) || !entry || !sameStat(file, entry)) fullExport.add(path)
            candidates.push(snapshot(file, state))
            attemptedPaths.add(path)
        }
        const selectedRevision = state.scopeRevision
        if (warmIds.size && !shouldStop()) {
            ankiProfile ??= await requireExpectedAnkiProfile(plugin, previewProfile, control?.signal)
            const verificationErrors: string[] = []
            counts.cachedIds = warmIds.size
            const checkExistence = profileId ? checkAnkiNoteExistence : checkWarmAnkiNoteExistence
            const verification = await checkExistence(Array.from(warmIds), verificationErrors,
                control?.signal, () => { counts.cachedIdRequests++ })
            if (shouldStop()) return 'stopped'
            await requireExpectedAnkiProfile(plugin, ankiProfile, control?.signal)
            requireCurrentRouting()
            if (verificationErrors.length) {
                errors.push(t('Could not verify some Anki IDs for unchanged notes. Run export again to check the links.',
                    'Не удалось проверить часть ID Anki в неизменённых заметках. Повторите экспорт, чтобы проверить связи.'))
                console.warn('[Export to Anki] Cached note ID verification failed', verificationErrors)
            }
            if (verification.size > 0 && Array.from(verification.values()).includes(false)) {
                for (const { path, file, ids } of warmSources) {
                    if (file.path === path && !state.modified.has(path) && state.idsByPath.get(path) === ids &&
                        sameStat(file, ids) && ids[3].some(id => verification.get(id) === false)) queueVerification(file)
                }
            }
        }
        if (selectedRevision !== state.scopeRevision) {
            for (const file of files) {
                if (attemptedPaths.has(file.path) || !state.modified.has(file.path) || isSyncAuditReportPath(file.path)) continue
                candidates.push(snapshot(file, state))
                fullExport.add(file.path)
                attemptedPaths.add(file.path)
            }
        }
        if (shouldStop()) return 'stopped'
        if (candidates.length) {
            ankiProfile ??= await requireExpectedAnkiProfile(plugin, previewProfile, control?.signal)
            history = await openOneWayHistory(plugin, ankiProfile)
            operationJournal = new ExportOperationJournal(vault.adapter, operationJournalPath(plugin), ankiProfile)
            requireCurrentRouting()
        }
        if (reprocess) {
            state.entries.clear()
            clearIdOwners(state)
            plugin.file_hashes = {}
            Object.setPrototypeOf(plugin.file_hashes, null)
            state.saveData = true
            state.context = context
            state.saveIndex = true
        } else for (const { path } of candidates) {
            if (verifyOnly.has(path) || suspendOnly.has(path)) continue
            const entry = state.entries.get(path)
            if (state.entries.delete(path)) state.saveIndex = true
            if (currentOnly || !entry || entry[3] !== plugin.file_hashes[path]) setHash(plugin, state, path, undefined)
        }

        if (!currentOnly && !onlyPaths && (state.entries.size > counts.files - candidates.length || state.modified.size > candidates.length)) {
            const live = new Set(allFiles.map(file => file.path))
            for (const path of state.entries.keys()) {
                if (live.has(path)) continue
                state.entries.delete(path)
                state.saveIndex = true
                setHash(plugin, state, path, undefined)
            }
            for (const path of state.modified.keys()) {
                if (!live.has(path)) {
                    state.modified.delete(path)
                    state.editorModified.delete(path)
                }
            }
        }

        const paths = new Set(candidates.map(candidate => candidate.path))
        const selectedPaths = current || onlyPaths ? new Set(files.map(file => file.path)) : selection.paths
        const reportedConflicts = new Map<string, Set<number>>()
        const inspectOwnership = async (sources: readonly TFile[], contentPaths: ReadonlySet<string>, fresh: boolean) => {
            const checked = await indexProfileNoteIds(plugin, state, sources, selectedPaths, contentPaths, fresh, shouldStop, true, cursor)
            counts.reads += checked.reads
            errors.push(...checked.errors)
            for (const id of checked.duplicates.keys()) detectedDuplicates.add(id)
            for (const [path, ids] of checked.conflictingPaths) {
                attemptedPaths.add(path)
                const previous = reportedConflicts.get(path) ?? new Set<number>()
                for (const id of ids) if (!previous.has(id)) {
                    errors.push(`${path}: ${checked.duplicates.get(id)}`)
                    previous.add(id)
                }
                reportedConflicts.set(path, previous)
            }
            return checked
        }
        const verifyWholeVault = !!profileId || !!cursor
        const profileOwnership = verifyWholeVault ? await inspectOwnership(allFiles, paths, force) : undefined
        if (profileOwnership && !profileOwnership.complete && !shouldStop()) {
            throw new Error('Could not verify Anki ID ownership across the vault. Resolve the listed file errors and run the scan again.')
        }

        if (candidates.length === 0) {
            reportRun = attemptedPaths.size > 0 || errors.length > 0
            if (state.saveData || state.saveIndex) await flush(plugin, state)
            if (errors.length) notifyIssues(!shouldStop())
            else if (!shouldStop()) {
                const outside = activeFile && !selection.contains(activeFile.path)
                new Notice(outside ? t(`The active note is outside the export scope “${label}”.`,
                    `Активная заметка вне области экспорта «${label}».`)
                    : [checkedCount(counts.files, 'file', t), t('No changes.', 'Изменений нет.')].join('\n'))
            }
            if (syncHistoryEnabled(plugin) && !reportRun && !shouldStop()) appendChange({
                action: 'check', direction: 'none', path: currentPath ?? scope,
                detail: [checkedCount(counts.files, 'file', t), t('No changes.', 'Изменений нет.')].join(' '),
            })
            return shouldStop() ? 'stopped' : errors.length || reportRun ? 'failed' : 'completed'
        }
        reportRun = true
        if (typeof document !== 'undefined' && (!control || applyingPreview)) {
            timer = window.setTimeout(() => {
                progressView = openExportProgress(plugin.app, progress, () => { stopRequested = true }, t)
            }, 400)
        }
        showProgress(t('Checking duplicate Anki IDs', 'Проверяем дубликаты ID Anki'))

        const inspectWholeVaultOwnership = async (sources: readonly TFile[], contentPaths: ReadonlySet<string>,
            rescan: ReadonlySet<string>) => {
            const revision = state.scopeRevision
            const checked = await indexNoteIds(plugin, state, sources, contentPaths, rescan, pending, expected, errors, shouldStop)
            counts.reads += checked.reads
            return { ...checked, revision, complete: state.scopeRevision === revision }
        }
        let ownership = profileOwnership ?? await inspectWholeVaultOwnership(scopeFiles, paths,
            current ? new Set([current.path]) : force || onlyPaths ? paths : new Set())
        let ownershipRevision = ownership.revision
        const ownershipChanged = () => state.scopeRevision !== ownershipRevision
        if (shouldStop()) {
            await checkpoint()
            new Notice(t('Export to Anki: stopped before sending any changes.', 'Экспорт остановлен до отправки изменений в Anki.'))
            return 'stopped'
        }
        for (const { path } of candidates) {
            for (const id of ownership.conflictingPaths.get(path) ?? []) detectedDuplicates.add(id)
        }

        settings.Defaults['Add Date to Anki IDs'] = addDateToIds ?? false
        const data = await settingToData(plugin.app, settings, fields, [])
        const checkFields = generatedRuleGuard(settings, fields, modelName =>
            auditRead('modelFieldNames', { modelName }, control?.signal), t)
        const duplicatePreflight = new DuplicatePreflight()
        for (let offset = 0; offset < candidates.length; offset += filesPerBatch) {
            if (shouldStop()) break
            if (routingChanged()) {
                errors.push(staleRoutingMessage)
                break
            }
            if (offset && offset % (filesPerBatch * checkpointInterval) === 0) await checkpoint()
            if (shouldStop()) break
            const range = `${offset + 1}–${Math.min(offset + filesPerBatch, candidates.length)}`
            showProgress(t(`Exporting files ${range} of ${candidates.length}`, `Экспортируем файлы ${range} из ${candidates.length}`))
            if (shouldStop()) break
            const group = candidates.slice(offset, offset + filesPerBatch)
            const batch = group.filter(candidate => !pending.has(candidate.path))
            if (!batch.length) {
                for (const { path } of group) ownership.preloaded.delete(path)
                continue
            }
            if (ownershipChanged()) {
                const live = resolveSyncScope(plugin)
                if (live.signature !== signature) throw new Error('The sync profile changed. Run the export again.')
                const batchPaths = new Set(batch.map(candidate => candidate.path))
                const checked = verifyWholeVault ? await inspectOwnership(live.allFiles, batchPaths, false)
                    : await inspectWholeVaultOwnership(live.files, batchPaths, new Set())
                if (shouldStop()) break
                if (!checked.complete) throw new Error('Anki IDs could not be verified after files changed. Run the export again.')
                ownership = checked
                ownershipRevision = checked.revision
                for (const path of batchPaths) {
                    for (const id of checked.conflictingPaths.get(path) ?? []) detectedDuplicates.add(id)
                }
            }
            const byPath = new Map(batch.map(candidate => [candidate.path, candidate]))
            const manager = new FileManager(
                plugin.app, data, batch.map(candidate => candidate.file),
                plugin.file_hashes, plugin.added_media,
            )
            manager.mediaIndex = state.mediaIndex
            manager.onConfirmedNote = (action, id) => changes.record(action, id, action === 'cleanup' || action === 'link' ? 'Obsidian' : 'Anki')
            manager.duplicatePreflight = duplicatePreflight
            manager.imageOptimization = readImageOptimization(settings.IMAGE_OPTIMIZATION)
            manager.getRecovery = () => exportRecovery(plugin, state)
            manager.confirmedDeletions = confirmedDeletions
            manager.confirmedDeckMoves = confirmedDeckMoves
            manager.confirmedFields = confirmedFields
            manager.cursorCard = cursor
            manager.cursorRecovery = cursorRecovery
            manager.suspendOnly = suspendOnly
            manager.applySuspension = (expectedCards, targets, guard, verified, unconfirmed) => applySuspendCards(plugin, ankiProfile!, expectedCards, targets, async () => {
                if (!ownership.complete || pending.size) throw new Error('Cannot verify the current Markdown owners of the Anki IDs. Save the pending files and retry.')
                await guard()
            }, manager.onWriteRequest, verified, unconfirmed)
            manager.previewSelection = control?.previewSelection
            manager.oneWayHistory = history
            if (syncHistoryEnabled(plugin)) manager.onSyncChange = row => {
                loggedChanges = true
                appendChange(row)
            }
            manager.operationJournal = operationJournal
            manager.deletedArchiveLabel = t('Deleted from Anki', 'Удалено из Anki')
            manager.afterDeleteMode = afterDeleteMode(settings)
            manager.trashDeletedPages = settings.TRASH_DELETED_PAGES === true
            manager.forgetConfirmedDeletions = ids => forgetConfirmedAnkiDeletions(plugin, ankiProfile!, ids)
            manager.beforeDeletion = async () => { await (deletionBackup ??= createFullMigrationBackup(plugin)) }
            manager.deletionOwnership = async owners => {
                const files = plugin.app.vault.getMarkdownFiles().filter(file => !isSyncAuditReportPath(file.path))
                const index = await indexVaultIds(plugin, files, settings.Syntax,
                    path => Math.max(state.cacheEpoch, state.pathRevisions.get(path) ?? 0))
                if (!index.complete || Array.from(owners).some(([path, ids]) =>
                    ids.some(id => index.duplicates.has(id) || index.first.get(id)?.path !== path))) {
                    throw new Error('Could not confirm unique ownership of the deletion IDs across the vault.')
                }
                manager.deletionGuard?.()
            }
            manager.deletionGuard = () => {
                if (!ownership.complete || ownershipChanged() || routingChanged() || shouldStop() ||
                    manager.afterDeleteMode !== afterDeleteMode(plugin.settings) ||
                    manager.trashDeletedPages !== (plugin.settings.TRASH_DELETED_PAGES === true) ||
                    plugin.app.workspace.getLeavesOfType('markdown').some(({ view }) => view instanceof MarkdownView &&
                        view.getMode() === 'source' && !sameEditorText(view.getViewData(), view.data))) {
                    throw new Error('Save open notes and preview the deletion again.')
                }
            }
            manager.beforeMutation = beforeMutation
            manager.ankiProfile = ankiProfile
            manager.diagnosticSyntax = settings.Syntax
            manager.checkAnkiProfile = async confirmCommitted => {
                const profile = await requireExpectedAnkiProfile(plugin, ankiProfile, confirmCommitted ? undefined : control?.signal)
                if (!confirmCommitted) {
                    requireCurrentRouting()
                    if (cursor) checkCursorEditors(plugin, cursor)
                }
                return profile
            }
            manager.recoveryRevision = () => state.scopeRevision
            manager.recoveryIdMarkers = text => findIdMarkers(text, settings.Syntax)
            manager.onWriteRequest = answered => {
                if (answered) answeredRequests++
                else submittedRequests++
            }
            let initialisationFailed = false
            const lookupsBefore = counts.idLookups
            manager.stopAfterPacket = shouldStop
            try {
                await manager.initialiseFiles(contents => findExistingIds(contents, () => { counts.idLookups++ }),
                    expected, { textByPath: ownership.preloaded, fullExport, duplicates: ownership.duplicates,
                    conflictingPaths: ownership.conflictingPaths, expectedPreviewHashes })
            } catch (error) {
                errors.push(String(error))
                initialisationFailed = true
            } finally {
                counts.reads += manager.readCount
                for (const { path } of group) ownership.preloaded.delete(path)
            }
            errors.push(...manager.scanErrors)
            if (manager.staleSuspensionSources.size) {
                for (const path of manager.staleSuspensionSources) {
                    markModified(state, path)
                    state.entries.delete(path)
                    updateIdOwners(state, path)
                    setHash(plugin, state, path, undefined)
                }
                state.saveIndex = true
                failed = true
                break
            }
            for (const warning of manager.idDateWarnings) {
                if (idDateWarnings.size < 200) idDateWarnings.add(`${warning.path}:${warning.line} · ${t(warning.message, warning.russianMessage)}`)
            }
            if (!initialisationFailed && (batch.some(({ path }) => verifyOnly.has(path)) ||
                manager.checkedHashes.size && counts.idLookups !== lookupsBefore)) {
                await requireExpectedAnkiProfile(plugin, ankiProfile, control?.signal)
            }
            for (const [path, issues] of manager.cardIssues) cardIssuesByPath.set(path, issues)

            for (const [path, hash] of manager.checkedHashes) {
                const candidate = byPath.get(path)
                if (!candidate || !stillCurrent(candidate, state) || control?.omittedPreviewPaths?.has(path)) continue
                if (verifyOnly.has(path)) {
                    confirmedPaths.add(path)
                    continue
                }
                setHash(plugin, state, path, hash)
                accept(candidate, hash, manager.suspensionHints.has(path))
                const media = manager.mediaByNote.get(path)
                if (media) confirmedMediaLinks.set(path, media)
            }
            if (initialisationFailed) { failed = true; break }

            errors.push(...manager.retryMessages)
            const badFields = await checkFields(manager.ownFiles)
            const ready = manager.ownFiles.flatMap((note, index) => {
                const schemaError = badFields.get(note.path)
                if (schemaError) {
                    errors.push(note.path + ': ' + schemaError)
                    setHash(plugin, state, note.path, undefined)
                    return []
                }
                const candidate = byPath.get(note.path)
                if (!candidate || !stillCurrent(candidate, state)) {
                    counts.deferred++
                    return []
                }
                decksByPath.set(note.path, note.target_deck)
                if (verifyOnly.has(candidate.path)) {
                    if (!manager.retryPaths.has(candidate.path)) confirmedPaths.add(candidate.path)
                    return []
                }
                return [{ note, file: manager.files[index], candidate }]
            })
            if (ready.length === 0) continue
            if (typeof vault.process !== 'function') {
                errors.push('Update desktop Obsidian to use the Vault.process API.')
                failed = true
                break
            }
            manager.ownFiles = ready.map(item => item.note)
            manager.files = ready.map(item => item.file)
            const editorChanged = new Set<string>()
            manager.onMarkdownWriteVerified = (path, pendingMarker) => {
                if (!pendingMarker) markdownChanged = true
                const candidate = byPath.get(path)
                if (!candidate) return
                for (const { view } of plugin.app.workspace.getLeavesOfType('markdown')) {
                    if (view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source' &&
                        !sameEditorText(view.getViewData(), view.data)) {
                        editorChanged.add(path)
                        return
                    }
                }
                if (pendingMarker) Object.assign(candidate, snapshot(candidate.file, state))
                if (state.scopeRevision === ownershipRevision + 1 && state.lastScopePath === path) {
                    ownershipRevision = state.scopeRevision
                }
            }
            manager.isStillCurrent = path => {
                const candidate = byPath.get(path)
                return !ownershipChanged() && !routingChanged() && !!candidate && !editorChanged.has(path) && stillCurrent(candidate, state)
            }
            manager.stopAfterPacket = () => shouldStop() || ownershipChanged() || routingChanged()

            for (const { candidate } of ready) if (!suspendOnly.has(candidate.path)) setHash(plugin, state, candidate.path, undefined)
            const priorReads = manager.readCount
            try {
                const revision = state.revision
                const submitted = await manager.requests_1()
                if (history && !manager.profileBlocked && manager.oneWayReceipts.length) {
                    await requireExpectedAnkiProfile(plugin, ankiProfile)
                    history.apply(manager.oneWayReceipts)
                    operationJournal?.confirmReceipts(manager.verifiedWriteReceipts)
                    if (operationJournal && manager.verifiedCreationLinks.length) {
                        const present = new Set(manager.verifiedWriteReceipts.map(receipt => receipt.id))
                        await operationJournal.confirmCreationLinks(manager.verifiedCreationLinks.filter(link => present.has(link.noteId)))
                    }
                }
                counts.exportFiles += submitted.size
                if (!manager.profileBlocked) for (const impact of manager.cardImpactResults) {
                    const ids = (values: readonly number[]) => values.join(', ') || t('none', 'нет')
                    cardImpactResults.push(t(
                        `Anki ID ${impact.noteId} · kept: ${ids(impact.kept)} · new: ${ids(impact.added)} · no longer present: ${ids(impact.missing)}`,
                        `ID записи ${impact.noteId} · сохранены: ${ids(impact.kept)} · новые: ${ids(impact.added)} · больше нет: ${ids(impact.missing)}`))
                }
                for (const path of manager.mediaConfirmed) {
                    state.mediaRevisions.set(path, Math.min(revision, state.pathRevisions.get(path) ?? 0))
                    state.saveIndex = true
                }
            } catch (error) {
                errors.push(String(error))
                if (error instanceof AnkiProfileError) blockedProfile = error
                failed = true
                break
            } finally {
                await flushChanges()
                counts.reads += manager.readCount - priorReads
                recoveredCreations += manager.recoveredCreations
                for (const [path, issues] of manager.cardIssues) cardIssuesByPath.set(path, issues)
            }
            errors.push(...manager.retryMessages)
            if (ownershipChanged()) errors.push('The vault changed while checking Anki ID ownership. Retry the pending files against the current sources.')
            if (routingChanged() && !errors.includes(staleRoutingMessage)) errors.push(staleRoutingMessage)
            if (manager.profileBlocked) {
                blockedProfile = manager.profileBlocked
                errors.push(blockedProfile.message)
            }

            const media = Array.from(manager.added_media_set)
            if (media.length !== plugin.added_media.length) {
                plugin.added_media = media
                state.saveData = true
            }
            if (manager.importErrors.length > 0) {
                errors.push(...manager.importErrors)
                if (blockedProfile) break
                continue
            }

            const hashes: Record<string, string> = cursor || cursorRecovery ? {} : manager.getHashes()
            for (const { note, file, candidate } of ready) {
                const blocked = manager.blockedUpdates.get(candidate.path)
                if (blocked) {
                    errors.push(blocked)
                    continue
                }
                if (manager.retryPaths.has(candidate.path)) continue
                let verified = candidate
                if (note.file !== note.original_file) {
                    if (file.path !== candidate.path) {
                        counts.deferred++
                        continue
                    }
                    verified = snapshot(file, state)
                    counts.reads++
                    try {
                        if (await vault.read(file) !== note.file) {
                            counts.deferred++
                            continue
                        }
                    } catch (error) {
                        errors.push(`${candidate.path}: ${String(error)}`)
                        continue
                    }
                }
                if (!stillCurrent(verified, state)) {
                    counts.deferred++
                    continue
                }
                if (note.file !== note.original_file) {
                    const { stamp } = verified
                    updateIdOwners(state, candidate.path, [stamp[0], stamp[1], stamp[2], findIdMarkers(note.file, settings.Syntax).map(marker => marker.id)])
                }
                if ((cursor || cursorRecovery) && candidate.path === (cursor?.path ?? cursorRecovery?.path) && !manager.retryPaths.has(candidate.path)) {
                    confirmedPaths.add(candidate.path)
                    continue
                }
                if (control?.omittedPreviewPaths?.has(candidate.path) || manager.previewSuppressed.has(candidate.path)) {
                    if (control?.previewSelection) confirmedPaths.add(candidate.path)
                    continue
                }
                const hash = hashes[candidate.path]
                if (typeof hash !== 'string') continue
                setHash(plugin, state, candidate.path, hash)
                const marked = note.file === note.original_file ? manager.suspensionHints.has(candidate.path) :
                    mayHaveSuspendMarker(note.file, settings.Syntax) && readSuspendMarkers(note.file, settings.Syntax).size > 0
                accept(verified, hash, marked)
                const media = manager.mediaByNote.get(candidate.path)
                if (media) confirmedMediaLinks.set(candidate.path, media)
            }
            if (manager.writeUncertain) {
                errors.push(manager.writeUncertain)
                failed = true
                break
            }
            if (blockedProfile) break
        }
        await checkpoint()
        if (!blockedProfile) {
            if (errors.length > 0 || counts.deferred > 0 || detectedDuplicates.size) notifyIssues(!failed && !shouldStop())
            else if (!shouldStop()) {
                const summary = changes.message(t)
                if (summary) new Notice(summary)
                else if (counts.exportFiles || markdownChanged) new Notice(t('Export finished.', 'Экспорт завершён.'))
                else new Notice([checkedCount(counts.files, 'file', t), t('No changes.', 'Изменений нет.')].join('\n'))
            }
        }
    } catch (error) {
        failed = true
        reportRun = true
        errors.push(String(error))
        if (error instanceof AnkiProfileError) blockedProfile = error
        else if (!shouldStop()) {
            console.error('[Export to Anki] Scan failed', error)
            notifyIssues(false)
        }
    } finally {
        if (timer !== undefined) window.clearTimeout(timer)
        progressView?.close()
        const stopped = shouldStop()
        const pending = attemptedPaths.size - confirmedPaths.size
        outcome = blockedProfile ? 'blocked-profile' : stopped ? 'stopped' :
            failed || errors.length > 0 || pending > 0 ? 'failed' : 'completed'
        try {
            if (reportRun) {
                await operationJournal?.confirmFiles(confirmedPaths).catch(error => {
                    console.warn('[Rudonium Anki Toolkit] Could not save operation results', error)
                })
                const issues = exportIssues(errors, attemptedPaths)
                const files = Array.from(attemptedPaths).filter(path => !confirmedPaths.has(path)).map(path => {
                    const messages = issues.get(path) ?? [stopped ? 'Not confirmed before the export stopped.' : 'This file was not confirmed.']
                    const cardIssues = cardIssuesByPath.get(path)
                    const needsRecovery = cardIssues?.some(issue => issue.code === 'unconfirmed-response') ||
                        messages.some(message => /pending Anki note creation|pending (?:Markdown marker|export journal)/i.test(message))
                    const nextStep = needsRecovery || cursorRecovery ? 'Open Review Pending Anki Creations to check this source.' :
                        cursor ? t('Open this card’s preview and select Sync this card to retry.', 'Для повтора откройте предпросмотр этой карточки и нажмите «Синхронизировать эту карточку».') :
                        applyingPreview && !messages.some(message => /open Preview Export again/i.test(message))
                            ? 'Open Preview Export again before exporting this file.' : undefined
                    return {
                        path, deck: decksByPath.get(path), retryable: !needsRecovery && !applyingPreview && !cursorRecovery,
                        errors: nextStep ? [...messages, nextStep] : messages,
                        cardIssues,
                    }
                })
                const report: ExportRunReport = {
                    finishedAt: new Date().toISOString(), scope, profileSignature,
                    ankiProfile: ankiProfile ?? intendedProfile, submittedRequests, answeredRequests, recoveredCreations,
                    outcome,
                    total: attemptedPaths.size, confirmed: confirmedPaths.size, pending: files.length, files,
                    cardImpact: cardImpactResults.length ? cardImpactResults : undefined,
                    warnings: idDateWarnings.size ? [...idDateWarnings] : undefined,
                    messages: Array.from(new Set(errors.filter(message => !attemptedPaths.has(message.split(': ', 1)[0])))),
                }
                if (syncHistoryEnabled(plugin)) {
                    for (const file of files) {
                        if (file.cardIssues?.length) {
                            for (const issue of file.cardIssues) appendChange({
                                action: issue.code === 'unconfirmed-response' ? 'unknown' : 'skip',
                                direction: 'to-anki', path: file.path, noteId: issue.id, detail: issue.message,
                            })
                        }
                        const other = file.errors.filter(message => !file.cardIssues?.some(issue => issue.message === message))
                        if (other.length) appendChange({ action: 'error', direction: 'to-anki',
                            path: file.path, detail: other.join('\n') })
                    }
                    const message = report.messages?.join('\n')
                    if (message || (!files.length && (outcome !== 'completed' || !loggedChanges))) {
                        appendChange({ action: outcome === 'completed' ? 'check' : 'error', direction: 'none',
                            path: currentPath ?? scope, detail: message || (outcome === 'completed'
                                ? t('No changes.', 'Изменений нет.') : t('Export interrupted.', 'Экспорт прерван.')) })
                    }
                }
                await plugin.app.vault.adapter.write(lastReportPath(plugin), JSON.stringify(report))
                showProgress(stopped || blockedProfile ? t('Stopped', 'Остановлено')
                    : report.outcome === 'failed' ? t('Finished with errors', 'Завершено с ошибками') : t('Completed', 'Завершено'))
            }
        } catch (error) {
            console.warn('[Export to Anki] Could not save the export report', error)
        }
        await flushChanges()
        state.running = null
        finishScan()
        if (idDateWarnings.size) new Notice(t(
            `Anki IDs were preserved. Review date warnings in Show Last Anki Export (${idDateWarnings.size}).`,
            `Связи по ID Anki сохранены. Предупреждения о датах доступны в последнем отчёте экспорта (${idDateWarnings.size}).`), 10000)
        if (blockedProfile) {
            if (control?.onProfileBlocked) control.onProfileBlocked(blockedProfile)
            else showAnkiProfileProblem(plugin, blockedProfile, submittedRequests ? 'in-progress' : 'before-write',
                submittedRequests ? t(`${submittedRequests} Anki write requests sent, ${answeredRequests} received a response. See Show Last Anki Export for file results.`,
                    `Запросов на запись в Anki: ${submittedRequests}. Ответов: ${answeredRequests}. Откройте отчёт о последнем экспорте, чтобы проверить результат каждого файла.`) : undefined)
        } else if (stopped) {
            new Notice(t('Export to Anki: stopped after the confirmed batch. Open Show Last Anki Export to resume.',
                'Экспорт остановлен после подтверждённой партии. Для повтора откройте последний отчёт об экспорте.'))
        }
    }
    return outcome
}

function exportIssues(errors: readonly string[], paths: ReadonlySet<string>): Map<string, string[]> {
    const issues = new Map<string, string[]>()
    for (const message of errors) {
        const boundary = message.indexOf(': ')
        if (boundary < 0) continue
        const path = message.slice(0, boundary)
        if (!paths.has(path)) continue
        const list = issues.get(path) ?? []
        list.push(message.slice(boundary + 2))
        issues.set(path, list)
    }
    return issues
}

function showExportIssues(plugin: MyPlugin, errors: readonly string[], deferred: number, summary: string,
    duplicates: ReadonlySet<number>, attemptedPaths: ReadonlySet<string>, cardIssues: ReadonlyMap<string, readonly ExportCardIssue[]>,
    decksByPath: ReadonlyMap<string, string>, allowSkip: boolean, profile?: string, scopeSignature?: string): void {
    const messages = Array.from(new Set(errors))
    console.warn('[Export to Anki] Unconfirmed export results', { errors: messages, deferred })
    const t = uiFor(plugin.settings)
    const state = states.get(plugin)
    const openAudit = state?.openAudit
    const audit = openAudit ? (deck?: string) => { void waitForFastScanIdle(plugin).then(() => openAudit(deck)) } : undefined
    const hasDom = typeof document !== 'undefined'
    const skip = allowSkip && plugin.settings.SKIP_SYNC_ERRORS === true

    const missing: Array<{ path: string; issue: ExportCardIssue; deck?: string }> = []
    const rejected: typeof missing = []
    const recoverable = new Set<string>()
    const unconfirmedCreations = new Set<string>()
    for (const [path, issues] of cardIssues) for (const issue of issues) {
        const card = { path, issue, deck: decksByPath.get(path) }
        if (issue.code === 'missing-id' && issue.id !== undefined) missing.push(card)
        if (issue.code === 'duplicate-first-field') rejected.push(card)
        const message = `${path}: ${issue.message}`
        if (issue.code === 'unconfirmed-response') unconfirmedCreations.add(message)
        else if (isSkippedExportIssue(issue)) recoverable.add(message)
    }

    const pathOf = (message: string): string | undefined => {
        const boundary = message.indexOf(': ')
        const path = boundary < 0 ? undefined : message.slice(0, boundary)
        return path !== undefined && attemptedPaths.has(path) ? path : undefined
    }
    const duplicateOf = (message: string): number | undefined => {
        const path = pathOf(message)
        const detail = path ? message.slice(path.length + 2) : message
        const match = /^Duplicate Anki note ID (\d+) in .+\. Keep the ID in one source\.$/.exec(detail)
        const id = match ? Number(match[1]) : undefined
        return id !== undefined && duplicates.has(id) ? id : undefined
    }
    const rejectedPaths = new Set(rejected.map(card => card.path))
    const isRepeatedRejection = (message: string) => {
        const path = pathOf(message)
        return path !== undefined && rejectedPaths.has(path) && isReportedDuplicateAddError(message)
    }
    const deckFor = (path: string) => auditDeckForFile({ cardIssues: cardIssues.get(path), deck: decksByPath.get(path) })
    const deckForMessages = (items: readonly string[]) => singleAuditDeck(items.map(message => {
        const path = pathOf(message)
        if (path !== undefined) return deckFor(path)
        const id = duplicateOf(message)
        if (id === undefined) return undefined
        return singleAuditDeck(Array.from(state?.idOwners.get(id)?.keys() ?? [], deckFor))
    }))

    const show = (detail: string, deck?: string, duplicate?: number, reviewPath?: string) => {
        showExportIssueNotice(
            [t('Export to Anki', 'Экспорт в Anki'), summary, detail].filter(Boolean).join('\n'), t,
            !reviewPath && audit ? () => audit(deck) : undefined,
            duplicate === undefined ? undefined : () => openDuplicateIdReview(plugin, duplicate),
            reviewPath ? () => { void waitForFastScanIdle(plugin).then(() => previewVaultExport(plugin, undefined, new Set([reviewPath]))) } : undefined,
        )
    }
    let remaining = messages
    if (skip) {
        const grouped = messages.filter(message => recoverable.has(message) || duplicateOf(message) !== undefined ||
            isRepeatedRejection(message))
        const groupedSet = new Set(grouped)
        remaining = messages.filter(message => !groupedSet.has(message))
        const skippedPaths = new Set<string>()
        for (const message of grouped) {
            const path = pathOf(message)
            if (path !== undefined) skippedPaths.add(path)
            const id = duplicateOf(message)
            if (id !== undefined) for (const owner of state?.idOwners.get(id)?.keys() ?? []) {
                if (attemptedPaths.has(owner)) skippedPaths.add(owner)
            }
        }
        if (grouped.length || duplicates.size) {
            const detail = skippedExportNotes(duplicates, cardIssues, skippedPaths.size, t)
            show(`${detail}\n${t('Obsidian and Anki may be out of sync.', 'Данные в Obsidian и Anki могут различаться.')}`,
                deckForMessages(grouped))
        }
    } else if (hasDom) {
        const handled = new Set<string>()
        const addHandled = ({ path, issue }: (typeof missing)[number]) => {
            handled.add(`${path}: ${issue.message}`)
            handled.add(issue.message)
        }
        if (missing.length) {
            showMissingAnkiCardNotice(plugin.app, missing, t, openAudit ? (deck, target) =>
                openAudit(deck, { ...target, profile, scopeSignature }) : undefined, plugin.settings.Syntax)
            missing.forEach(addHandled)
        }
        if (rejected.length) {
            showDuplicateFirstFieldNotice(plugin.app, rejected, t, audit)
            rejected.forEach(addHandled)
        }
        if (handled.size) remaining = messages.filter(message => !handled.has(message) && !isRepeatedRejection(message))
    }
    const duplicate = skip ? undefined : duplicates.values().next().value
    if (!remaining.length && !deferred && duplicate === undefined) return
    if (duplicate === undefined && remaining.length && remaining.every(message => /(?:^|\.md: )Anki Browse: ID \d+/iu.test(message))) {
        const message = remaining[0].replace(/^.+?\.md: /iu, '')
        new Notice(localizeExportError(message, t) + (remaining.length > 1
            ? t(` Other entries in the export report: ${remaining.length - 1}.`, ` Других записей в отчёте: ${remaining.length - 1}.`) : ''), 15000)
        return
    }
    const firstError = remaining.find(message => unconfirmedCreations.has(message)) ??
        remaining.find(message => !recoverable.has(message) && duplicateOf(message) === undefined) ??
        remaining.find(message => duplicateOf(message) === undefined)
    const first = firstError ?? remaining[0]
    let detail = first === undefined
        ? t('Files changed during the scan. Run it again after editing.', 'Файлы изменились во время проверки. Повторите её после редактирования.')
        : localizeExportError(first, t).slice(0, 340)
    if (duplicate !== undefined) {
        const duplicateText = duplicates.size === 1
            ? t(`Duplicate Anki ID ${duplicate} skipped.`, `Пропущен дубликат ID Anki ${duplicate}.`)
            : t(`${duplicates.size} duplicate Anki IDs skipped.`, `Пропущено дубликатов ID Anki: ${duplicates.size}.`)
        detail = firstError === undefined ? duplicateText : `${detail}\n${duplicateText}`
    }
    if (remaining.some(message => message !== first) || first !== undefined && deferred) {
        detail += `\n${t('Details are in the last export report.', 'Подробности — в отчёте о последнем экспорте.')}`
    }
    const firstPath = first && pathOf(first)
    const reviewPath = firstPath && first && fieldReviewIssue(first.slice(firstPath.length + 2)) ? firstPath : undefined
    show(detail, deferred ? undefined : deckForMessages(remaining), duplicate, reviewPath)
}

function showExportIssueNotice(message: string, t: ReturnType<typeof uiFor>, audit?: () => void, reviewDuplicate?: () => void,
    previewFile?: () => void): void {
    if (typeof document === 'undefined' || !audit && !reviewDuplicate && !previewFile) {
        new Notice(message, 9000)
        return
    }
    const fragment = createFragment()
    fragment.createDiv({ text: message, cls: 'rudonium-pre-line' })
    const actions = fragment.createDiv({ cls: 'rudonium-notice-actions' })
    const notice = new Notice(fragment, 15000)
    const action = (label: string, run: () => void, primary = false) => {
        const button = actions.createEl('button', { text: label, attr: { type: 'button' } })
        if (primary) button.classList.add('mod-cta')
        button.onclick = event => { event.stopPropagation(); notice.hide(); run() }
    }
    if (previewFile) action(t('Preview file export', 'Предпросмотр экспорта файла'), previewFile, true)
    if (audit) action(t('Run Audit', 'Провести аудит'), audit, true)
    if (reviewDuplicate) action(t('Review Duplicates', 'Проверить дубликаты'), reviewDuplicate)
}
