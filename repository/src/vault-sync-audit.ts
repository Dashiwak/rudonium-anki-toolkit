/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { mayHavePageTag } from './page-frontmatter'
import { tableIdAdvice } from './card-export-diagnostics'
import { activeCardMarkdown } from './archived-card'
import { ankiIdNumberTokens } from './anki-id-marker'
import { MarkdownView } from 'obsidian'
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import { expectedAnkiProfile, isAnkiProfileLockEnabled, readActiveAnkiProfile } from './anki-profile'
import { findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax, IdMarker } from './duplicate-markers'
import { FileManager, frontmatterTags, mergeTags } from './files-manager'
import { cachedImageAliases, settingsWithoutAuditMode, withFastScanReadLock } from './fast-scan'
import { imageFieldMediaKeys, rewriteImageFields } from './image-field-links'
import { findLinkedBullets, readLinkedBulletModels } from './linked-bullets'
import { readRecoveryMarker } from './export-recovery'
import type { LinkedBullet, LinkedBulletModel } from './linked-bullets'
import { reconcileCardTags } from './bidirectional-markdown'
import { settingToData } from './setting-to-data'
import { AuditNoteSnapshots, auditRead, checkAnkiNoteExistence, markObsidianInventoryIncomplete, runSyncAudit, syncAuditDeckKey } from './sync-audit'
import type { SyncAuditAnkiProfile, SyncAuditDeckReference, SyncAuditFileError, SyncAuditGroup, SyncAuditProgress, SyncAuditResult,
    SyncAuditSource, SyncAuditUnlinked } from './sync-audit'
import { resolveSyncScope, scanProfileFreeSettings, syncScopeSignature } from './sync-profiles'
import { attachmentDeckMembers, rememberAuditAttachmentSources } from './audit-attachment-check'
import type { AuditAttachmentSource } from './audit-attachment-check'
import { localMediaName } from './media-sync'
import { authoredCardTagOverrides, portableCardExportRuleRoute } from './portable-parser'
import { addAuditUnlinkedCard, auditCandidateByteLimit, auditCardCaption, auditUnlinkedWeight,
    classifyAuditFieldChanges } from './audit-card-status'

export type VaultSyncAuditProgress = SyncAuditProgress | { phase: 'vault'; completed: number; total: number }
export type VaultSyncAuditScope = 'default-deck' | { deck: string }

const filesPerRead = 8
const idsPerModelRequest = 500
const filesPerModelGroup = idsPerModelRequest
const modelGroupTextLimit = 8 * 1024 * 1024
const modelReadTimeoutMs = 15_000
const cacheFileLimit = 24_000
const cacheWeightLimit = 24 * 1024 * 1024

interface FileAuditData {
    sources: SyncAuditSource[]
    pendingDeletions: SyncAuditSource[]
    unparsedIds: SyncAuditSource[]
    unlinked: SyncAuditUnlinked[]
    deckAssignments: SyncAuditDeckReference[]
    errors: SyncAuditFileError[]
    markdownWarnings: NonNullable<SyncAuditResult['markdownWarnings']>
    warningDeck?: string
    attachments?: Array<{ id?: number; deck: string; links: string[] }>
}

interface FileObservation {
    file: TFile
    path: string
    stamp: readonly [mtime: number, ctime: number, size: number, revision: number]
}

interface MarkdownSnapshot extends FileObservation {
    content: string
    markers?: IdMarker[]
    bullets?: LinkedBullet[]
    linkedIds: number[]
    pendingCreation: boolean
}

interface CachedFile extends MarkdownSnapshot {
    dependsOnVault: boolean
    schema: string
    data: FileAuditData
    weight: number
}

const auditCaches = new WeakMap<MyPlugin, { context: string; markerSyntax: string; revision: number; metadata: number;
    dependencyObservations?: readonly FileObservation[]; entries: Map<string, CachedFile> }>()
const candidateSnapshots = new WeakMap<SyncAuditResult, () => boolean>()

export function auditCandidateSnapshotCurrent(result: SyncAuditResult): boolean {
    return candidateSnapshots.get(result)?.() === true
}

function sameSnapshot(snapshot: FileObservation, file: TFile, revision: (path: string) => number): boolean {
    const { mtime, ctime, size } = file.stat
    const [previousMtime, previousCtime, previousSize, previousRevision] = snapshot.stamp
    return snapshot.file === file && snapshot.path === file.path && mtime === previousMtime && ctime === previousCtime &&
        size === previousSize && revision(file.path) === previousRevision
}

function modelSchema(ids: readonly number[], schemas: ReadonlyMap<number, string>): string {
    if (ids.length === 1) return schemas.get(ids[0]) ?? 'missing'
    return ids.length ? JSON.stringify(ids.map(id => schemas.get(id) ?? null)) : ''
}

/** Лимит учитывает строки и примерную стоимость объектов, а также отдельное число файлов. */
function cacheWeight(entry: MarkdownSnapshot, data: FileAuditData, retainedMarkerCount: number): number {
    let weight = 512 + 2 * (entry.path.length + entry.content.length) + entry.linkedIds.length * 8 + retainedMarkerCount * 48
    weight += (data.pendingDeletions.length + data.unparsedIds.length + data.deckAssignments.length + data.markdownWarnings.length) * 160
    for (const card of data.attachments ?? []) {
        weight += card.deck.length * 2 + 64
        for (const link of card.links) weight += link.length * 2 + 32
    }
    for (const group of data.unlinked) weight += 160 + (group.lines?.length ?? 0) * 8 + auditUnlinkedWeight(group)
    for (const item of data.sources) {
        weight += 360
        if (item.expected) {
            const { fields, tags } = item.expected
            for (const [name, value] of Object.entries(fields)) weight += 2 * (name.length + value.length) + 64
            for (const tag of tags) weight += 2 * tag.length + 32
        }
    }
    return weight
}

/** У одной карточки с одним маркером точная строка уже есть в результате разбора. */
function compactMarkers(markers: IdMarker[], data: FileAuditData): IdMarker[] | undefined {
    if (markers.length !== 1 || data.sources.length !== 1) return markers
    const marker = markers[0]
    const source = data.sources[0]
    return marker.id === source.id && marker.line === source.markerLine ? undefined : markers
}

/** Позиции начала строк связывают координаты маркеров с диапазонами штатного парсера. */
function fileLines(content: string) {
    let starts: number[] | undefined
    const lineStarts = () => starts ??= [0, ...Array.from(content.matchAll(/\r\n?|\n/g), match => match.index! + match[0].length)]
    return {
        lineAt(offset: number): number {
            const positions = lineStarts()
            let low = 0
            let high = positions.length
            while (low + 1 < high) {
                const middle = Math.floor((low + high) / 2)
                if (positions[middle] <= offset) low = middle
                else high = middle
            }
            return low + 1
        },
        offsetAt(line: number, column: number): number {
            return lineStarts()[line - 1] + column
        },
    }
}

function validId(id: number): boolean {
    return Number.isSafeInteger(id) && id > 0
}

/** Принимает смещения по порядку, просматривая отсортированные диапазоны только один раз. */
function orderedCoverage(ranges: ReadonlyArray<[number, number]>): (offset: number) => boolean {
    let next = 0
    let coveredUntil = -1
    return offset => {
        while (next < ranges.length && ranges[next][0] <= offset) {
            coveredUntil = Math.max(coveredUntil, ranges[next++][1])
        }
        return offset < coveredUntil
    }
}

function firstOffsetAtLeast(offsets: readonly number[], target: number): number {
    let low = 0
    let high = offsets.length
    while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (offsets[middle] < target) low = middle + 1
        else high = middle
    }
    return low
}

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Sync audit cancelled', 'AbortError')
}

async function readAuditProfile(expected: string | undefined, signal?: AbortSignal): Promise<SyncAuditAnkiProfile> {
    try {
        return { active: await readActiveAnkiProfile(signal), expected }
    } catch (error) {
        checkAbort(signal)
        return { problem: error instanceof Error ? error.message : String(error), expected }
    }
}

/** Разбирает сохранённый файл независимо от колоды, которую пользователь проверяет сейчас. */
async function collectFileAudit(
    manager: FileManager, data: Awaited<ReturnType<typeof settingToData>>,
    snapshot: MarkdownSnapshot, markers: readonly IdMarker[], linkedModels: ReadonlyMap<number, LinkedBulletModel>,
    usesCustomSyntax: boolean, retainedCandidates: { bytes: number; count: number }, syntax: DuplicateMarkerSyntax,
    signal?: AbortSignal,
): Promise<FileAuditData> {
    const { file, path, content } = snapshot
    const bullets = snapshot.bullets ?? findLinkedBullets(content, false, syntax)
    const result: FileAuditData = {
        sources: [], pendingDeletions: [], unparsedIds: [], unlinked: [], deckAssignments: [], errors: [], markdownWarnings: [],
    }
    const { sources, pendingDeletions, unparsedIds, unlinked, deckAssignments } = result
    const { lineAt, offsetAt } = fileLines(content)
    const idMarkers = markers
        .map(({ id, line, column }) => ({ id, offset: offsetAt(line, column) }))
    const active = content.includes('RUDONIUM-ARCHIVE') ? activeCardMarkdown(content) : content
    const hasExplicitDeck = !!data.DECK_REGEXP && active.search(data.DECK_REGEXP) >= 0
    const canParse = bullets.length > 0 || usesCustomSyntax || Boolean(data.page_model && mayHavePageTag(active)) ||
        active.search(data.NOTE_REGEXP) >= 0 ||
        active.search(data.INLINE_REGEXP) >= 0 || active.search(data.EMPTY_REGEXP) >= 0
    if (!canParse && !idMarkers.length && !hasExplicitDeck) {
        return result
    }

    const markersById = new Map<number, number[]>()
    for (const { id, offset } of idMarkers) {
        const offsets = markersById.get(id)
        if (offsets) offsets.push(offset)
        else markersById.set(id, [offset])
    }
    function sourceLines(id: number, range?: [number, number]): Pick<SyncAuditSource, 'line' | 'endLine' | 'markerLine'> {
        if (!range) return {}
        const [start, end] = range
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) return {}
        // Для перехода к ID используем координату только если в диапазоне ровно один такой маркер.
        const offsets = markersById.get(id)
        const first = offsets ? firstOffsetAtLeast(offsets, start) : 0
        const offset = offsets?.[first]
        const next = offsets?.[first + 1]
        return { line: lineAt(start), endLine: lineAt(end - 1),
            markerLine: offset !== undefined && offset < end && (next === undefined || next >= end) ? lineAt(offset) : undefined }
    }

    // Даём парсеру все числовые кандидаты этого файла, включая отсутствующие
    // в Anki. Парсер всё равно сам проверит, принадлежит ли ID карточке.
    const ids = ankiIdNumberTokens(active)
    const parsed = await manager.parseMarkdown(file, content, ids, true, linkedModels, bullets,
        false, undefined, false, undefined, { signal })
    const detectedMedia = parsed.formatter?.detectedMedia
    const attachmentLinks = detectedMedia?.size ? new Map<string, string[]>() : undefined
    if (attachmentLinks && detectedMedia) for (const link of detectedMedia) {
        const name = localMediaName(link)?.normalize('NFC').toLowerCase()
        if (!name) continue
        const group = attachmentLinks.get(name) ?? []
        group.push(link)
        attachmentLinks.set(name, group)
    }
    const rememberAttachments = (note: { fields: Record<string, string>; deckName: string }, id?: number) => {
        if (!attachmentLinks?.size) return
        const supported = [...imageFieldMediaKeys(note.fields)].flatMap(key => attachmentLinks.get(key) ?? [])
        if (supported.length) (result.attachments ??= []).push({ id, deck: note.deckName, links: supported })
    }
    const covered = parsed.auditNoteRanges ?? []
    const assignedDeck = parsed.target_deck || undefined
    const deckRoute = assignedDeck ? manager.deckRouteFor(path, content, parsed) : undefined
    if (deckRoute?.origin === 'note' && assignedDeck) deckAssignments.push({ deck: assignedDeck, path, deckRoute })
    if (assignedDeck && parsed.tableIdWarnings?.length) {
        for (const conflict of parsed.tableIdWarnings) {
            result.warningDeck = syncAuditDeckKey(assignedDeck)
            result.markdownWarnings.push({ path, line: conflict.line, message: tableIdAdvice })
        }
    }
    if (assignedDeck && parsed.idDateWarnings?.length) {
        result.warningDeck = syncAuditDeckKey(assignedDeck)
        for (const warning of parsed.idDateWarnings) result.markdownWarnings.push({ path, line: warning.line, message: warning.message })
    }
    if (assignedDeck && parsed.markdownWarningLines?.length) {
        result.warningDeck = syncAuditDeckKey(assignedDeck)
        for (const line of parsed.markdownWarningLines) {
            result.markdownWarnings.push({ path, line, message: 'Card-like text is inside a math block and was skipped.' })
        }
    }
    let yamlTags: string[] | undefined
    if (parsed.notes_to_edit.length || parsed.all_notes_to_add.length) {
        try {
            yamlTags = frontmatterTags(content)
        } catch (error) {
            result.errors.push({ path, message: `Could not parse YAML: ${String(error)}` })
        }
    }
    const fileTags = parsed.global_tags.split(/\s+/u)
    const overrides = authoredCardTagOverrides(content, bullets, syntax)
    parsed.notes_to_edit.forEach(({ identifier, note }, index) => {
        rememberAttachments(note, identifier)
        const first = data.fields_dict[note.modelName]?.[0]
        sources.push({
            id: identifier,
            path,
            auditCaption: auditCardCaption(first && note.fields[first]),
            ...sourceLines(identifier, covered[index]),
            assignedDeck: note.deckName,
            deckRoute: portableCardExportRuleRoute(note) ?? (note.deckName === assignedDeck ? deckRoute : undefined),
            expected: yamlTags ? {
                modelName: note.modelName,
                fields: note.fields,
                tags: reconcileCardTags(mergeTags(note.tags.flatMap(tag => tag.split(/\s+/u)), fileTags, yamlTags), overrides?.get(identifier)),
                deck: note.deckName,
            } : undefined,
        })
    })

    // В Anki может уже не быть заметки, но Markdown по-прежнему содержит
    // распознанную карточку со связью. Для неё известен целевой deck файла.
    const isParsed = orderedCoverage(covered.sort((left, right) => left[0] - right[0]))
    const unresolvedBullets = bullets.filter(bullet => !isParsed(bullet.end - 1))
    for (const { id, start, end } of unresolvedBullets) {
        sources.push({ id, path, ...sourceLines(id, [start, end]), assignedDeck, deckRoute })
        covered.push([start, end])
    }
    if (parsed.all_notes_to_add.length) {
        const positions = parsed.id_indexes.concat(parsed.inline_id_indexes, parsed.regex_id_indexes)
        // Эти диапазоны упорядочены и не пересекаются. Позиции штатного парсера идут по типам карточек.
        const unresolvedStarts = unresolvedBullets.map(({ start }) => start)
        const groups = new Map<string, SyncAuditUnlinked>()
        parsed.all_notes_to_add.forEach((note, index) => {
            const position = positions[index]
            const offset = position === undefined ? undefined : Math.max(0, position - 1)
            if (offset !== undefined && unresolvedStarts.length) {
                const previous = unresolvedBullets[firstOffsetAtLeast(unresolvedStarts, offset + 1) - 1]
                if (previous && offset < previous.end) return
            }
            rememberAttachments(note)
            const deck = note.deckName
            let group = groups.get(deck)
            if (!group) {
                group = { path, count: 0, lines: [], assignedDeck: deck,
                    deckRoute: portableCardExportRuleRoute(note) ?? (deck === assignedDeck ? deckRoute : undefined) }
                groups.set(deck, group)
            }
            group.count++
            const line = offset === undefined ? undefined : lineAt(offset)
            if (line !== undefined) group.lines?.push(line)
            addAuditUnlinkedCard(group, line, data.fields_dict[note.modelName]?.[0], note, retainedCandidates)
        })
        for (const group of groups.values()) {
            group.lines?.sort((left, right) => left - right)
            unlinked.push(group)
        }
    }
    for (const match of content.matchAll(data.EMPTY_REGEXP)) {
        const id = Number(match[1])
        if (!validId(id)) continue
        const start = match.index!
        const end = start + match[0].length
        const offsets = markersById.get(id)
        const offset = offsets?.[firstOffsetAtLeast(offsets, start)]
        if (offset === undefined || offset >= end) continue
        covered.push([start, end])
        pendingDeletions.push({ id, path, ...sourceLines(id, [start, end]), assignedDeck, deckRoute })
    }

    // Отдельно показываем маркеры вне распознанных диапазонов.
    const isCovered = orderedCoverage(covered.sort((left, right) => left[0] - right[0]))
    for (const { id, offset: start } of idMarkers) {
        if (!isCovered(start)) {
            const line = lineAt(start)
            unparsedIds.push({ id, path, line, endLine: line, markerLine: line, assignedDeck, deckRoute })
        }
    }
    return result
}

/** Перед сравнением с Anki разбирает сохранённый Markdown по правилам экспорта. */
export function auditPluginSync(
    plugin: MyPlugin, onProgress?: (progress: VaultSyncAuditProgress) => void, signal?: AbortSignal,
    scope: VaultSyncAuditScope = 'default-deck', expectedFolderScopeSignature?: string,
    exportTarget?: { profile: string },
): Promise<SyncAuditResult> {
    return withFastScanReadLock(plugin, async (currentRevision, pathRevision, metadataRevision) => {
        checkAbort(signal)
        const started = performance.now()
        const startedAt = new Date().toISOString()
        const { app } = plugin
        const { vault } = app
        const revision = currentRevision()
        const metadata = metadataRevision()
        const folderScope = resolveSyncScope(plugin)
        if (expectedFolderScopeSignature !== undefined && expectedFolderScopeSignature !== folderScope.signature) {
            throw new Error('The sync profile changed. Run the audit again for the selected profile.')
        }
        const auditContext = () => {
            const settings = scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings))
            // Настройки изображений действуют на будущие экспорты. Аудит использует последние подтверждённые соответствия имён.
            delete settings.IMAGE_OPTIMIZATION
            return JSON.stringify([vault.getName(), settings, plugin.fields_dict])
        }
        const context = auditContext()
        const checkConfiguration = () => {
            if (syncScopeSignature(plugin.settings) !== folderScope.signature) {
                throw new Error('The sync profile changed during the audit. Run it again.')
            }
            if (auditContext() !== context) {
                throw new Error('The export settings changed during the audit. Run it again.')
            }
        }
        const [vaultName, settings, fields] = JSON.parse(context)
        const deck: string = scope === 'default-deck' ? settings.Defaults.Deck : scope.deck
        if (typeof deck !== 'string' || !deck.trim()) {
            throw new Error(scope === 'default-deck' ? 'Set Defaults → Deck before checking the default deck.'
                : 'Select an Anki deck before running the deck audit.')
        }
        const expectedProfile = expectedAnkiProfile(plugin)
        if (exportTarget && isAnkiProfileLockEnabled(plugin) && exportTarget.profile !== expectedProfile) {
            throw new Error('Confirm the expected Anki profile in Defaults → Expected Anki Profile, then run the audit again.')
        }
        const initialProfile = await readAuditProfile(expectedProfile, signal)
        const activeProfile = 'active' in initialProfile ? initialProfile.active : undefined
        if (exportTarget && 'problem' in initialProfile) throw new Error(initialProfile.problem)
        if (exportTarget && activeProfile !== exportTarget.profile) {
            throw new Error(`Expected Anki profile “${exportTarget.profile}” but Anki now has “${activeProfile}” open. Switch profiles and recheck.`)
        }
        const imageAliasesByPath = await cachedImageAliases(plugin, activeProfile ?? null)
        checkAbort(signal)

        // За пределами профиля тоже ищем источники уже существующих ID и их дубликаты.
        const { allFiles: files, paths: exportPaths } = folderScope
        const data = await settingToData(app, settings, fields, [])
        const manager = new FileManager(app, data, [], {}, [])
        manager.diagnosticSyntax = settings.Syntax
        const usesCustomSyntax = Object.values(data.custom_regexps).some(Boolean)
        const prior = auditCaches.get(plugin)
        const cacheContext = JSON.stringify([context, activeProfile])
        const reuseSettings = prior?.context === cacheContext
        const markerSyntax = JSON.stringify(settings.Syntax)
        const reuseMarkers = prior?.markerSyntax === markerSyntax
        // Прерванная или неполная проверка не оставляет снимок для следующего запуска.
        auditCaches.delete(plugin)
        const cache = new Map<string, CachedFile>()
        let weight = 0
        const metrics = { filesRead: 0, readCacheHits: 0, filesParsed: 0, parseCacheHits: 0, linkedModelRequests: 0,
            markdownMs: 0, modelMs: 0, parseMs: 0 }
        const sources: SyncAuditSource[] = []
        const attachmentSources: Array<{ path: string; aliases?: ReadonlyMap<string, string>; cards: NonNullable<FileAuditData['attachments']> }> = []
        const firstIdLocations = new Map<number, SyncAuditSource>()
        const duplicateIds = new Map<number, SyncAuditGroup>()
        type SourceScope = Pick<SyncAuditSource, 'inExportScope' | 'excludedByProfile'>
        const recordMarker = (id: number, line: number, path: string, sourceScope: SourceScope) => {
            const source: SyncAuditSource = { id, path, line, markerLine: line, ...sourceScope }
            const first = firstIdLocations.get(id)
            if (!first) {
                firstIdLocations.set(id, source)
                return
            }
            const duplicate = duplicateIds.get(id)
            if (duplicate) duplicate.occurrences.push(source)
            else duplicateIds.set(id, { id, occurrences: [first, source] })
        }
        const auditedDeckKey = syncAuditDeckKey(deck)
        const pendingDeletions: SyncAuditSource[] = []
        const unparsedIds: SyncAuditSource[] = []
        const unlinked: SyncAuditUnlinked[] = []
        const retainedCandidates = { bytes: auditCandidateByteLimit, count: 0 }
        const deckAssignments: SyncAuditDeckReference[] = []
        const fileErrors: SyncAuditFileError[] = []
        const markdownWarnings: NonNullable<SyncAuditResult['markdownWarnings']> = []
        const linkedModels = new Map<number, LinkedBulletModel>()
        const linkedSchemas = new Map<number, string>()
        const modelErrors = new Map<number, string>()
        const queriedIds = new Set<number>()
        const observations: FileObservation[] = []
        let hasVaultDependencies = false
        const linkedDetails = activeProfile ? new AuditNoteSnapshots() : undefined
        const readModelNotes = async (notes: number[]) => {
            const response = await auditRead('notesInfo', { notes }, signal, modelReadTimeoutMs)
            linkedDetails?.remember(notes, response)
            return response
        }
        let filesScanned = 0

        onProgress?.({ phase: 'vault', completed: 0, total: files.length })

        const openPaths = new Set<string>()
        const dirtyPaths = new Set<string>()
        for (const { view } of app.workspace.getLeavesOfType('markdown')) {
            if (!(view instanceof MarkdownView)) continue
            const path = view.file?.path
            if (!path) continue
            openPaths.add(path)
            if (!dirtyPaths.has(path) && view.getMode() === 'source' &&
                view.getViewData().replace(/\r\n/g, '\n') !== view.data.replace(/\r\n/g, '\n')) {
                dirtyPaths.add(path)
            }
        }
        const activePath = app.workspace.getActiveFile()?.path
        if (activePath) openPaths.add(activePath)

        function previousSnapshot(file: TFile): MarkdownSnapshot | undefined {
            const cached = prior?.entries.get(file.path)
            if (!reuseMarkers || !cached || !sameSnapshot(cached, file, pathRevision)) return undefined
            return cached
        }

        async function readMarkdown(file: TFile, cached?: MarkdownSnapshot): Promise<MarkdownSnapshot | undefined> {
            const path = file.path
            const { mtime, ctime, size } = file.stat
            const stamp = [mtime, ctime, size, pathRevision(path)] as const
            try {
                metrics.filesRead++
                const content = await vault.read(file)
                let snapshot: MarkdownSnapshot
                if (cached?.content === content) snapshot = cached
                else {
                    const pendingCreation = !!readRecoveryMarker(content)
                    const bullets = pendingCreation ? [] : findLinkedBullets(content, false, settings.Syntax)
                    const linkedIds = bullets.length ? [...new Set(bullets.map(bullet => bullet.id))] : []
                    const markers = findIdMarkers(content, settings.Syntax)
                    snapshot = { file, path, stamp, content, markers, bullets, linkedIds, pendingCreation }
                }
                if (!sameSnapshot(snapshot, file, pathRevision)) throw new Error('The file changed while it was being read.')
                return snapshot
            } catch (error) {
                fileErrors.push({ path, message: String(error) })
                return undefined
            }
        }

        // Перечитываем открытые заметки, даже если время файла и события хранилища не показывают изменений.
        const openFiles = openPaths.size ? files.filter(file => openPaths.has(file.path)) : []
        const visible = new Map<string, MarkdownSnapshot | undefined>()
        // Ссылка может зависеть от любого файла, в том числе отсутствующего в ограниченном кеше разбора.
        // Пропускаем проверку всего хранилища, если все сохранённые результаты разбора самодостаточны.
        const dependencies = prior?.dependencyObservations
        let reuseDependencies = !!prior && !!dependencies && reuseSettings && prior.revision === revision &&
            prior.metadata === metadata && dependencies.length === files.length &&
            files.every((file, index) => sameSnapshot(dependencies[index], file, pathRevision))
        for (let offset = 0; offset < openFiles.length; offset += filesPerRead) {
            checkAbort(signal)
            const readStarted = performance.now()
            await Promise.all(openFiles.slice(offset, offset + filesPerRead).map(async file => {
                const path = file.path
                if (dirtyPaths.has(path)) fileErrors.push({ path, message: 'The editor has unsaved changes. Save the note and recheck.' })
                const entry = await readMarkdown(file, previousSnapshot(file))
                visible.set(path, entry)
                const previous = prior?.entries.get(path)
                if (!entry || (prior && previous?.content !== entry.content)) reuseDependencies = false
            }))
            metrics.markdownMs += performance.now() - readStarted
        }

        let offset = 0
        while (offset < files.length) {
            checkAbort(signal)
            const readStarted = performance.now()
            const batch: Array<MarkdownSnapshot | undefined> = []
            let textSize = 0
            while (offset < files.length && batch.length < filesPerModelGroup && textSize < modelGroupTextLimit) {
                const end = Math.min(files.length, offset + filesPerRead, offset + filesPerModelGroup - batch.length)
                let pending: Array<Promise<void>> | undefined
                for (; offset < end; offset++) {
                    const file = files[offset]
                    const path = file.path
                    if (visible.has(path)) {
                        batch.push(visible.get(path))
                        continue
                    }
                    const cached = previousSnapshot(file)
                    if (cached) {
                        metrics.readCacheHits++
                        batch.push(cached)
                        continue
                    }
                    const slot = batch.length
                    batch.push(undefined)
                    pending ??= []
                    pending.push(readMarkdown(file).then(entry => {
                        batch[slot] = entry
                        textSize += 2 * (entry?.content.length ?? 0)
                    }))
                }
                if (pending) {
                    await Promise.all(pending)
                    checkAbort(signal)
                }
            }
            metrics.markdownMs += performance.now() - readStarted
            checkAbort(signal)
            // Размер запроса к Anki не зависит от числа одновременно читаемых файлов.
            const modelStarted = performance.now()
            const linkedIds: number[] = []
            for (const entry of batch) {
                if (!entry?.linkedIds.length) continue
                for (const id of entry.linkedIds) {
                    if (queriedIds.has(id)) continue
                    queriedIds.add(id)
                    linkedIds.push(id)
                }
            }
            for (let index = 0; index < linkedIds.length; index += idsPerModelRequest) {
                checkAbort(signal)
                const ids = new Set(linkedIds.slice(index, index + idsPerModelRequest))
                const readModels = (requested: ReadonlySet<number>) => {
                    metrics.linkedModelRequests++
                    return readLinkedBulletModels(requested, undefined, readModelNotes)
                }
                try {
                    let models: Awaited<ReturnType<typeof readModels>>
                    try {
                        models = await readModels(ids)
                    } catch (error) {
                        checkAbort(signal)
                        if (error instanceof DOMException && error.name === 'TimeoutError') throw error
                        // Некоторые версии AnkiConnect отклоняют весь запрос, если удалена одна запись.
                        // Перечитываем схему только для подтверждённых ID; удалённые остаются в отчёте.
                        const problems: string[] = []
                        const existence = await checkAnkiNoteExistence([...ids], problems, signal)
                        if (problems.length || existence.size !== ids.size) throw error
                        const found = new Set([...ids].filter(id => existence.get(id) === true))
                        if (found.size === ids.size) throw error
                        models = found.size ? await readModels(found) : new Map()
                    }
                    for (const [id, model] of models) {
                        linkedModels.set(id, model)
                        linkedSchemas.set(id, JSON.stringify([model.name, [...model.fieldNames].sort()]))
                    }
                } catch (error) {
                    checkAbort(signal)
                    // После тайм-аута не держим замок ещё на десятках недоступных пакетов.
                    if (error instanceof DOMException && error.name === 'TimeoutError') throw error
                    const message = `Could not read linked note types: ${String(error)}`
                    for (const id of ids) modelErrors.set(id, message)
                }
            }
            metrics.modelMs += performance.now() - modelStarted
            checkAbort(signal)
            const parseStarted = performance.now()
            for (const entry of batch) {
                if (!entry) continue
                const { file, path, linkedIds } = entry
                const inExportScope = exportPaths.has(path)
                const sourceScope: SourceScope = { inExportScope }
                if (!inExportScope && folderScope.excludes(path)) sourceScope.excludedByProfile = true
                try {
                    if (!sameSnapshot(entry, file, pathRevision)) throw new Error('The file changed during the audit.')
                    observations.push({ file, path, stamp: entry.stamp })
                    const modelError = modelErrors.size ? linkedIds.map(id => modelErrors.get(id)).find(Boolean) : undefined
                    if (modelError) fileErrors.push({ path, message: modelError })
                    const schema = modelSchema(linkedIds, linkedSchemas)
                    const previous = prior?.entries.get(path)
                    const cached = reuseSettings && previous && previous === entry && previous.schema === schema &&
                        (reuseDependencies || !previous.dependsOnVault)
                        ? previous : undefined
                    // Повторы определяем по сохранённым маркерам, даже когда тип записи не удалось разобрать.
                    const compact = cached && !cached.markers ? cached.data.sources[0] : undefined
                    const markers = entry.markers ?? (compact ? [] : findIdMarkers(entry.content, settings.Syntax))
                    for (const { id, line } of markers) recordMarker(id, line, path, sourceScope)
                    if (compact?.markerLine !== undefined) recordMarker(compact.id, compact.markerLine, path, sourceScope)
                    if (entry.pendingCreation) {
                        fileErrors.push({ path, message: 'This source has an unresolved Anki creation. Use Review Pending Anki Creations before auditing it.' })
                        continue
                    }
                    const local = cached?.data ?? await collectFileAudit(manager, data, entry, markers, linkedModels,
                        usesCustomSyntax, retainedCandidates, settings.Syntax, signal)
                    if (cached) metrics.parseCacheHits++
                    else metrics.filesParsed++

                    const imageAliases = imageAliasesByPath.get(path)
                    for (const source of local.sources) {
                        const expected = source.expected
                        if (!imageAliases?.size || !expected) {
                            sources.push({ ...source, ...sourceScope })
                            continue
                        }
                        // Храним в кеше поля, извлечённые непосредственно из Markdown. Применяем последние
                        // подтверждённые соответствия имён только к ожидаемым полям этого аудита.
                        const fields = { ...expected.fields }
                        rewriteImageFields(fields, imageAliases)
                        sources.push({ ...source, ...sourceScope, expected: { ...expected, fields } })
                    }
                    for (const source of local.pendingDeletions) pendingDeletions.push({ ...source, ...sourceScope })
                    for (const source of local.unparsedIds) unparsedIds.push({ ...source, ...sourceScope })
                    if (inExportScope) {
                        for (const group of local.unlinked) unlinked.push(group)
                        for (const assignment of local.deckAssignments) deckAssignments.push(assignment)
                        if (local.attachments?.length) attachmentSources.push({ path, aliases: imageAliases, cards: local.attachments })
                    }
                    for (const error of local.errors) fileErrors.push(error)
                    if (inExportScope && local.warningDeck === auditedDeckKey) {
                        for (const warning of local.markdownWarnings) markdownWarnings.push(warning)
                    }

                    if (!local.errors.length && cache.size < cacheFileLimit) {
                        const retainedMarkers = cached ? cached.markers : compactMarkers(markers, local)
                        const estimated = cached?.weight ?? cacheWeight(entry, local, retainedMarkers?.length ?? 0)
                        // Текущий список читается независимо от лимита. Не вытесняем ранние записи этого прохода.
                        if (weight + estimated <= cacheWeightLimit) {
                            // Кеш хранит результат и исходный текст. Промежуточные блоки нужны только при новом разборе.
                            const retained = cached ?? {
                                file, path, stamp: entry.stamp, content: entry.content, linkedIds, markers: retainedMarkers,
                                pendingCreation: entry.pendingCreation,
                                schema, data: local, weight: estimated,
                                // Простой текст без ссылок или контекста можно повторно использовать после изменений в других файлах.
                                dependsOnVault: !!data.add_context || !!data.add_file_link || /[!\[\]()<>`]/u.test(entry.content),
                            }
                            cache.set(path, retained)
                            if (retained.dependsOnVault) hasVaultDependencies = true
                            weight += estimated
                        }
                    }
                    filesScanned++
                } catch (error) {
                    fileErrors.push({ path, message: `Could not parse Markdown: ${String(error)}` })
                }
            }
            metrics.parseMs += performance.now() - parseStarted
            onProgress?.({ phase: 'vault', completed: offset, total: files.length })
        }

        const compareStarted = performance.now()
        checkConfiguration()
        const result = await runSyncAudit({
            vaultName,
            deck,
            folderProfile: { label: folderScope.label, files: exportPaths.size, named: !!folderScope.profileId },
            exportTag: settings.Defaults.Tag,
            filesScanned,
            sources,
            duplicateIds: Array.from(duplicateIds.values()),
            deckAssignments,
            unlinked,
            unparsedIds,
            pendingDeletions,
            fileErrors,
            linkedDetails,
        }, onProgress, signal)
        if (activeProfile && (!expectedProfile || expectedProfile === activeProfile)) {
            await classifyAuditFieldChanges(plugin, result, activeProfile)
        }
        const finalProfile = await readAuditProfile(expectedProfile, signal)
        const finalName = 'active' in finalProfile ? finalProfile.active : undefined
        if (activeProfile !== finalName) {
            if (!finalName && 'problem' in finalProfile) {
                throw new Error('The Anki profile could no longer be confirmed at the end of the audit. ' + finalProfile.problem)
            }
            throw new Error('The Anki profile changed during the audit. Recheck to read one collection.')
        }
        checkConfiguration()
        result.ankiProfile = initialProfile
        result.startedAt = startedAt
        const filteredMembers = attachmentDeckMembers(result)
        const matchingAttachments: AuditAttachmentSource[] = []
        for (const { path, aliases, cards } of attachmentSources) {
            const links = new Set<string>()
            for (const { id, deck, links: cardLinks } of cards) {
                if (result.ankiDeckKind === 'filtered' ? id !== undefined && filteredMembers?.has(id) :
                    syncAuditDeckKey(deck) === auditedDeckKey) {
                    for (const link of cardLinks) links.add(link)
                }
            }
            if (links.size) matchingAttachments.push({ path, aliases, links: [...links] })
        }
        rememberAuditAttachmentSources(result, matchingAttachments)
        if (markdownWarnings.length) result.markdownWarnings = markdownWarnings
        // Внешняя правка может обновить TFile.stat до того, как Obsidian отправит событие хранилища.
        // Повторно проверяем метаданные без хранения или повторного чтения текста Markdown.
        if (currentRevision() !== revision || metadataRevision() !== metadata ||
            observations.some(entry => !sameSnapshot(entry, entry.file, pathRevision))) {
            result.fileErrors.push({ path: vaultName, message: 'The vault changed during the audit. Run the audit again for an up-to-date report.' })
            markObsidianInventoryIncomplete(result)
        }
        if (result.unlinked.length && result.vaultInventoryComplete && result.ankiInventoryComplete && !result.ankiErrors.length) {
            const unlinkedPaths = new Set(result.unlinked.map(({ path }) => path))
            const unlinkedObs = observations.filter(entry => unlinkedPaths.has(entry.path))
            const scopeSignature = folderScope.signature
            candidateSnapshots.set(result, () =>
                currentRevision() === revision && metadataRevision() === metadata && auditContext() === context &&
                syncScopeSignature(plugin.settings) === scopeSignature &&
                unlinkedObs.every(entry => sameSnapshot(entry, entry.file, pathRevision)))
        }
        if (activeProfile && result.vaultInventoryComplete && result.ankiInventoryComplete && !result.ankiErrors.length) {
            auditCaches.set(plugin, {
                context: cacheContext, markerSyntax, revision, metadata, entries: cache,
                dependencyObservations: hasVaultDependencies && observations.length <= cacheFileLimit ? observations : undefined,
            })
        }
        console.info('[Rudonium Anki Toolkit] Sync Audit', {
            ...metrics, markdownMs: Math.round(metrics.markdownMs), modelMs: Math.round(metrics.modelMs),
            parseMs: Math.round(metrics.parseMs), compareMs: Math.round(performance.now() - compareStarted),
            totalMs: Math.round(performance.now() - started), cachedFiles: auditCaches.get(plugin)?.entries.size ?? 0,
        })
        return result
    })
}
