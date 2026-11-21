/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { currentCardExpression, hasLinkedAnswerSlot, isKnowledgeBullet, isRemNoteBullet, remNoteExpression } from './card-format-presets'
import { sameEditorText, makeSpanOverlap } from './markdown-pipeline'
import { MarkdownView, Notice } from 'obsidian'
import type { App, TFile } from 'obsidian'
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import { observeSourceFields, sourceSuffixes, sourceSuffixMap } from './bidirectional-source-fields'
import type { SourceFieldUpdates, SourceSuffixes } from './bidirectional-source-fields'
import { isRecord, parseExistingNoteSnapshot, snapshotKey } from './anki-delta'
import type { NoteSnapshot } from './anki-delta'
import { AnkiProfileError, checkPinnedAnkiProfile, requireExpectedAnkiProfile } from './anki-profile'
import { hasPendingAnkiWrite, pendingAnkiWriteMessage, withAnkiDeadline } from './anki-transport'
import { showAnkiProfileProblem } from './anki-profile-ui'
import { readRecoveryMarker } from './export-recovery'
import { FileManager, frontmatterTags, mergeTags } from './files-manager'
import { openOneWayHistory, settingsWithoutAuditMode, withFastScanReadLock } from './fast-scan'
import { oneWayFieldDigest } from './oneway-history'
import type { OneWayHistory, OneWayReceipt, OneWayRecord } from './oneway-history'
import { createFullMigrationBackup, ensureScheduledBackup } from './vault-backup'
import { findIdMarkers } from './duplicate-markers'
import { formatLocalIdDate, idDatePatch, pageIdDatePatch } from './anki-id-marker'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { findLinkedBullets } from './linked-bullets'
import type { LinkedBullet, LinkedBulletModel } from './linked-bullets'
import { findPresetBlocks, isDeckPageSchema, isLinkedPageSchema, pageBlock, pageSourceContext, presetReaders, readPageCard } from './page-card'
import { pageContentTags } from './page-frontmatter'
import { findBidirectionalBlocks, isWritableBlockExtraName } from './bidirectional-blocks'
import type { BidirectionalBlock } from './bidirectional-blocks'
import { maskLegacyFieldSections } from './legacy-field-sections'
import type { CardPreviewCandidate } from './file'
import { cardAtOffset, containsCardOffset, readDeckDirective, portableCardExportRule } from './portable-parser'
import { previewCurrentCard } from './card-preview'
import { cursorCardOffset, cursorConfiguration } from './cursor-card'
import type { CursorCardTarget } from './cursor-card'
import { checkCursorEditors } from './cursor-editor-guard'
import { settingToData } from './setting-to-data'
import { auditRead, checkAnkiNoteExistence } from './sync-audit'
import { afterDeleteMode } from './deletion-policy'
import { explicitDeletes, cleanConfirmedDeletes, deletionSignature, sourceRemoval, localDeleteEffect } from './deletion-source'
import type { ExplicitDeletes, SourceRemoval } from './deletion-source'
import { resolveSyncScope, scanProfileFreeSettings, syncScopeSignature } from './sync-profiles'
import { indexVaultIds } from './vault-id-index'
import { applyMarkdownPatches, isEditableBlockField, isEditableMarkdownField, planExplicitBlockPatches,
    planLinkedBulletPatches, readCardTagOverride, readEditableAnkiBlockField, readEditableAnkiField,
    readGeneratedAnkiBacklink, reconcileCardTags, writeEditableAnkiBlockField, writeEditableAnkiField } from './bidirectional-markdown'
import type { MarkdownPatch } from './bidirectional-markdown'
import { BidirectionalState, matchesPendingSyncValue, mergeSyncValues, normalizeSyncTags, sameSyncExtras, syncValuesEqual } from './bidirectional-state'
import type { SyncBacklinks, SyncChangeField, SyncChoices, SyncField, SyncRecord, SyncValue } from './bidirectional-state'
import { isBidirectionalFieldName, isGeneratedBidirectionalField, readBidirectionalFieldRules, readTemplateFieldReferences } from './bidirectional-fields'
import type { BidirectionalFieldDirection } from './bidirectional-fields'
import { cardFieldHazards, sameCardIds } from './anki-card-impact'
import { openBidirectionalPreview } from './bidirectional-ui'
import { addPreviewPreference } from './bidirectional-preview-preference'
import { ankiBrowseMessage, uiDiagnostic, uiFor } from './interface-language'
import { requireSettledZipImport } from './zip-import-guard'
import type { BidirectionalPreviewChange, BidirectionalPreviewRow, BidirectionalSide } from './bidirectional-ui'

import { applySuspendCards, readSuspendCards, verifySuspendCards } from './suspend-anki'
import type { SuspendCard } from './suspend-anki'
import { acceptAnkiSuspension, describeSuspendSelection, mergeSuspension, SuspensionTopologyChanged } from './suspend-merge'
import { readSuspendMarkers, rewriteSuspendMarkers } from './suspend-marker'
import type { SuspendSelection } from './suspend-marker'

interface PauseUpdate {
    id: number
    source: SourceFile
    slots: SuspendCard[]
    requiresAnkiChoice?: boolean
    merge: ReturnType<typeof mergeSuspension>
    record?: SyncRecord
}

const readBatchSize = 500
const fields = ['front', 'back', 'tags'] as const
const labels = { front: 'Front', back: 'Back', tags: 'Tags' } as const
const writeTimeoutMs = 20_000
const maxCachedSources = 25_000
const maxCachedSourceLength = 64 * 1024
const maxCachedSourceChars = 8 * 1024 * 1024
const pendingAnkiWrites = new WeakMap<App, Promise<unknown>>()
export const pendingBidirectionalWriteMessage =
    'Anki has not answered the previous sync write. Inspect the card in Anki and open a fresh preview after it settles.'

export function hasPendingBidirectionalWrite(app: App): boolean {
    return pendingAnkiWrites.has(app)
}

interface Scope { currentOnly?: boolean; currentFile?: { file: TFile; path: string }; paths?: ReadonlySet<string>; force?: boolean; card?: CursorCardTarget }
type SourceCard = LinkedBullet | BidirectionalBlock
interface DeleteFile {
    commands?: ExplicitDeletes
    removals: SourceRemoval[]
    evidence: Map<number, string | null>
}
interface SourceFile {
    file: TFile
    path: string
    content: string
    cards: SourceCard[]
    stamp: SourceStamp
    // The full source is parsed for heading context and file directives. Only cards[] can produce operations.
    markers: ReturnType<typeof readSuspendMarkers>
    parserText?: string
    parseIds?: number[]
    readAfterCustomEdit?: (content: string) => Promise<Awaited<ReturnType<FileManager['parseMarkdown']>>>
}
type SourceStamp = readonly [mtime: number, ctime: number, size: number, revision: number]
interface LocalCard {
    sourceSuffixes?: SourceSuffixes
    sourceBodies?: Record<string, string>
    pageShared?: Readonly<Record<string, string>>
    obsidian: SyncValue
    inheritedTags: string[]
    ruleFields?: ReadonlySet<string>
    verifiedExtras?: ReadonlyMap<string, string>
    frozenFields?: ReadonlySet<string>
    deletionSource?: string
}
interface Link extends LocalCard {
    fieldBases?: ReadonlyMap<string, string | null>
    releaseOneWayField?: boolean
    namedFieldModel?: string
    pageContextField?: string
    datePatch?: MarkdownPatch
    generated?: SourceFieldUpdates
    source: SourceFile
    bullet: SourceCard
    anki: SyncValue
    model: string
    ankiBacklinks: SyncBacklinks
    record?: SyncRecord
    extraDirections?: ReadonlyMap<string, BidirectionalFieldDirection>
    outboundBlocked?: ReadonlySet<string>
    cardIds?: readonly number[]
}

interface SourceModel extends LinkedBulletModel { key: string }
interface CachedSource {
    file: TFile
    content: string
    entries: SourceCard[]
    markers: ReturnType<typeof readSuspendMarkers>
    stamp: SourceStamp
    models: readonly SourceModel[]
    cards: Map<number, LocalCard>
}
interface WarmSources { key: string; files: Map<string, CachedSource> }
const warmSources = new WeakMap<MyPlugin, WarmSources>()

function sourceStamp(file: TFile, revision: number): SourceStamp {
    const { mtime, ctime, size } = file.stat
    return [mtime, ctime, size, revision]
}

interface Plan {
    newCardSource?: TFile
    profile: string
    scopeLabel: string
    statePath: string
    configuration: string
    revision: number
    links: Link[]
    deletions: Map<SourceFile, DeleteFile>
    expressions: Readonly<Record<string, string>>
    directivePatterns: ReadonlyArray<RegExp | undefined>
    readers: ReturnType<typeof presetReaders>
    modelFields: Readonly<Record<string, readonly string[]>>
    pageModel?: string
    pauses: PauseUpdate[]
    rows: BidirectionalPreviewRow[]
    issues: string[]
    scanned: number
    complete: boolean
    cursor?: CursorCardTarget
}

function configuration(plugin: MyPlugin): string {
    return JSON.stringify([scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings)), plugin.fields_dict, syncScopeSignature(plugin.settings)])
}

function protectedStatePath(plugin: MyPlugin): string {
    const { manifest, app } = plugin
    return `${manifest.dir ?? `${app.vault.configDir}/plugins/${manifest.id}`}/bidirectional-sync.json`
}

// После подтверждённого DELETE старую сверку нельзя использовать для повторного удаления Markdown.
export async function forgetConfirmedAnkiDeletions(plugin: MyPlugin, profile: string, ids: Set<number>): Promise<void> {
    if (!ids.size) return
    const state = await BidirectionalState.open(plugin.app.vault.adapter, protectedStatePath(plugin), profile)
    await state.checkpoint(Array.from(ids).filter(id => state.get(id)).map(id => [id, undefined] as const))
}

function dirtyFiles(plugin: MyPlugin): Set<string> {
    const result = new Set<string>()
    for (const { view } of plugin.app.workspace.getLeavesOfType('markdown')) {
        if (view instanceof MarkdownView && view.file && view.getMode() === 'source' && !sameEditorText(view.getViewData(), view.data)) {
            result.add(view.file.path)
        }
    }
    return result
}

function isResponseList(value: unknown): value is unknown[] {
    return Array.isArray(value)
}

async function readNoteBatch(notes: number[], requested: Set<number>, profile: string, missing?: Set<number>): Promise<unknown> {
    const read = (ids: number[]) => auditRead('notesInfo', { notes: ids }, undefined, 30_000)
    try {
        return await read(notes)
    } catch (error) {
        const message = error instanceof Error ? error.message : error
        if (typeof message !== 'string' ||
            !/\b(?:notes?(?: ids?)?(?: \d+)? (?:(?:was|were) )?(?:not found|does not exist)|unknown note id|no such note)\b/i.test(message)) throw error

        // Строгие коннекторы отклоняют весь пакет, когда запись пропала. Повторяем запрос только для проверенной части пакета.
        await checkPinnedAnkiProfile(profile)
        const matches = await auditRead('findNotes', { query: `nid:${notes.join(',')}` }, undefined, 30_000)
        if (!isResponseList(matches) || !matches.every((id): id is number => typeof id === 'number' && requested.has(id)) ||
            matches.length >= notes.length || new Set(matches).size !== matches.length) throw error
        const remaining = new Set<number>(matches)
        const rows = remaining.size ? await read(notes.filter(id => remaining.has(id))) : []
        await checkPinnedAnkiProfile(profile)
        for (const id of notes) if (!remaining.has(id)) {
            requested.delete(id)
            missing?.add(id)
        }
        return rows
    }
}

async function readNotes(ids: readonly number[], profile: string, missing?: Set<number>): Promise<Map<number, NoteSnapshot>> {
    const result = new Map<number, NoteSnapshot>()
    for (let offset = 0; offset < ids.length; offset += readBatchSize) {
        const notes = ids.slice(offset, offset + readBatchSize)
        const requested = new Set(notes)
        const raw = await readNoteBatch(notes, requested, profile, missing)
        if (!isResponseList(raw)) throw new Error('AnkiConnect returned an invalid note list.')
        let empty = 0
        for (const row of raw) {
            // Некоторые версии AnkiConnect возвращают пустой объект для отсутствующей записи.
            if (isRecord(row) && Object.keys(row).length === 0) {
                empty++
                continue
            }
            if (!isRecord(row) || typeof row.noteId !== 'number' || !requested.delete(row.noteId)) throw new Error('AnkiConnect returned an unexpected or repeated note ID.')
            if (typeof row.profile === 'string' && row.profile !== profile) {
                throw new AnkiProfileError('mismatch', profile, row.profile)
            }
            const snapshot = parseExistingNoteSnapshot(row)
            if (snapshot) result.set(row.noteId, snapshot)
        }
        // Простой пропуск строк не подтверждает удаление. Учитываем только явные пустые ответы.
        if (missing && empty === requested.size) for (const id of requested) missing.add(id)
    }
    return result
}

function rawField(snapshot: NoteSnapshot, name: string): string | undefined {
    const field = snapshot.fields[name] as { value?: unknown } | undefined
    return typeof field?.value === 'string' ? field.value : undefined
}

function explicitBlock(card: SourceCard): BidirectionalBlock | undefined {
    return 'explicitFields' in card ? card : undefined
}

function decodeField(html: string | undefined, block?: BidirectionalBlock, backlink?: string, allowEmpty = false): string | undefined {
    if (html === undefined) return
    return block ? readEditableAnkiBlockField(html, block, backlink, allowEmpty) : readEditableAnkiField(html, backlink, allowEmpty)
}

function decodeAnkiNote(snapshot: NoteSnapshot, card: SourceCard, extraDirections?: ReadonlyMap<string, BidirectionalFieldDirection>):
    { value?: SyncValue; backlinks: SyncBacklinks } | undefined {
    const block = explicitBlock(card)
    if (block?.layout) {
        const keys = Object.keys(snapshot.fields)
        if (!block.layout.names.every((name, i) => {
            const field = snapshot.fields[name] as { order?: unknown } | undefined
            return field && (field.order === undefined ? keys[i] === name : field.order === i)
        })) return
    }
    if (!block?.layout && block?.fieldPair && !isLinkedPageSchema(snapshot.modelName, Object.keys(snapshot.fields), block.fieldPair)) return
    const frontHtml = rawField(snapshot, block?.fieldPair?.[0] ?? 'Front')
    const backHtml = rawField(snapshot, block?.fieldPair?.[1] ?? 'Back')
    if (frontHtml === undefined || backHtml === undefined) return undefined
    const frontLink = readGeneratedAnkiBacklink(frontHtml, card.id)
    const backLink = readGeneratedAnkiBacklink(backHtml, card.id)
    const front = decodeField(frontHtml, block, frontLink)
    const back = decodeField(backHtml, block, backLink, hasLinkedAnswerSlot(block?.format) || ('metadata' in card && card.remNoteAnswerSlot))
    const backlinks: SyncBacklinks = [frontLink ?? null, backLink ?? null]
    if (front === undefined || back === undefined) return { backlinks }
    const value: SyncValue = { front, back, tags: normalizeSyncTags(snapshot.tags) }
    if (extraDirections?.size) {
        const extra = Object.create(null) as Record<string, string>
        for (const name of extraDirections.keys()) {
            const raw = rawField(snapshot, name)
            const field = decodeField(raw, block, undefined, true)
            if (field === undefined) return { backlinks }
            extra[name] = field
        }
        value.extra = extra
    }
    return { value, backlinks }
}

function sameBacklinks(left: SyncBacklinks, right: SyncBacklinks): boolean {
    return left[0] === right[0] && left[1] === right[1]
}

function sourceFieldsSnapshot(snapshot: NoteSnapshot, bullet: SourceCard, generated?: SourceFieldUpdates, written = false): NoteSnapshot | undefined {
    if (!generated) return snapshot
    const fields = { ...snapshot.fields }
    const pair = explicitBlock(bullet)?.fieldPair ?? ['Front', 'Back']
    for (const [name, update] of Object.entries(generated)) {
        const raw = rawField(snapshot, name)
        const suffix = written ? update.after : update.before
        if (raw === undefined || !raw.endsWith(suffix)) return
        const body = raw.slice(0, raw.length - suffix.length)
        if (!pair.includes(name) && body !== update.body) return
        fields[name] = { value: body }
    }
    return { ...snapshot, fields }
}

function matchesPreview(snapshot: NoteSnapshot | undefined, link: Link, expected = link.anki, written = false): boolean {
    if (!snapshot || snapshot.modelName !== link.model || link.cardIds && !sameCardIds(snapshot.cards, link.cardIds)) return false
    const clean = sourceFieldsSnapshot(snapshot, link.bullet, link.generated, written)
    const remote = clean && decodeAnkiNote(clean, link.bullet, link.extraDirections)
    return !!remote?.value && syncValuesEqual(remote.value, expected) && sameBacklinks(remote.backlinks, link.ankiBacklinks)
}

function tagSetsEqual(left: string[], right: string[]): boolean {
    const keys = new Set(left.map(tag => tag.toLowerCase()))
    return keys.size === right.length && right.every(tag => keys.has(tag.toLowerCase()))
}

function valueFor(value: SyncValue, field: SyncField): string {
    return field === 'tags' ? value.tags.join(' · ') : value[field]
}

function readLocalCard(content: string, bullet: SourceCard, note: CardPreviewCandidate['note'],
    fileTags: readonly string[], yamlTags: readonly string[]): LocalCard | undefined {
    const { id, front, back } = bullet
    const block = explicitBlock(bullet)
    if (block && (note.modelName !== block.model || !block.explicitFields.has('Front') || !block.explicitFields.has('Back'))) return
    const matches = (name: string, value: string, allowEmpty = false) => {
        const html = note.fields[name]
        const backlink = (!allowEmpty || name === (block?.fieldPair?.[1] ?? 'Back')) && typeof html === 'string' ? readGeneratedAnkiBacklink(html, id) : undefined
        return (block ? isEditableBlockField(value, block, allowEmpty) : isEditableMarkdownField(value)) &&
            decodeField(html, block, backlink, allowEmpty)?.normalize('NFC') === value.normalize('NFC')
    }
    if (!matches(block?.fieldPair?.[0] ?? 'Front', front) || !matches(block?.fieldPair?.[1] ?? 'Back', back, hasLinkedAnswerSlot(block?.format))) return
    const allTags = mergeTags(note.tags.flatMap(tag => tag.split(/\s+/u)), fileTags, yamlTags)
    const inheritedTags = block?.format === 'page' ? pageContentTags(allTags) : allTags
    const tags = normalizeSyncTags(reconcileCardTags(inheritedTags, readCardTagOverride(content, bullet)))
    const mapped = bullet.extra && portableCardExportRule(note)?.mappedFields
    const verifiedExtras = block ? new Map(Object.entries(block.extra).filter(([name, value]) => matches(name, value, true))
        .map(([name]) => [name, note.fields[name]] as const)) : undefined
    return { obsidian: { front, back, tags }, inheritedTags, verifiedExtras, ruleFields: mapped?.length ? new Set(mapped) : undefined }
}

function fieldEqual(left: SyncValue, right: SyncValue, field: SyncField): boolean {
    return field === 'tags' ? tagSetsEqual(left.tags, right.tags)
        : left[field].normalize('NFC') === right[field].normalize('NFC')
}

function sameStoredValue(left: SyncValue, right: SyncValue): boolean {
    return left.front === right.front && left.back === right.back &&
        left.tags.length === right.tags.length && left.tags.every((tag, index) => tag === right.tags[index]) &&
        sameSyncExtras(left.extra, right.extra)
}

function activeBaseline(base: SyncValue, active: SyncValue): SyncValue {
    if (!base.extra) return base
    if (!active.extra) return { ...base, extra: undefined }
    const extra = Object.fromEntries(Object.entries(base.extra).filter(([name]) =>
        Object.prototype.hasOwnProperty.call(active.extra, name)))
    return { ...base, extra }
}

function targetFor(link: Link, choices: SyncChoices = {}): { value: SyncValue; conflicts: SyncChangeField[] } {
    const { record, obsidian, anki } = link
    const pending = record?.pending
    const directions = link.outboundBlocked?.size ? new Map(Array.from(link.extraDirections ?? [], ([field, direction]) =>
        [field, link.outboundBlocked!.has(field) ? 'to-obsidian' : direction] as const)) : link.extraDirections
    if (pending) {
        // Resume only slots still owned by the current source. A 0.9.7 regex
        // journal can contain an extra field whose Markdown writer has been retired.
        const target = activeBaseline(pending.target, obsidian)
        if (matchesPendingSyncValue(obsidian, activeBaseline(pending.obsidian, obsidian), target) &&
            matchesPendingSyncValue(anki, activeBaseline(pending.anki, anki), target)) {
            return { value: target, conflicts: [] }
        }
        return mergeSyncValues(undefined, obsidian, anki, choices, directions)
    }
    return mergeSyncValues(record?.base, obsidian, anki, choices, directions, link.fieldBases)
}

function previewChanges(link: Link): BidirectionalPreviewChange[] {
    const target = targetFor(link)
    link = resolvedPageContext(link, target.value.front)
    const rows = fields.flatMap((field): BidirectionalPreviewChange[] => {
        const sameAsLocal = fieldEqual(target.value, link.obsidian, field)
        const sameAsRemote = fieldEqual(target.value, link.anki, field)
        if (sameAsLocal && sameAsRemote) return []
        return [{
            key: `${link.bullet.id}:${field}`, field: field === 'tags' ? labels[field] :
                explicitBlock(link.bullet)?.fieldPair?.[field === 'front' ? 0 : 1] ?? labels[field],
            obsidian: valueFor(link.obsidian, field), anki: valueFor(link.anki, field),
            decision: target.conflicts.includes(field) ? 'conflict' : sameAsLocal ? 'obsidian' : sameAsRemote ? 'anki' : 'merge',
            merged: valueFor(target.value, field),
        }]
    })
    for (const [name, update] of Object.entries(link.generated ?? {})) {
        if (update.before !== update.after) rows.push({ key: link.bullet.id + ':source:' + name, field: name,
            obsidian: update.after, anki: update.before, merged: update.after, decision: 'obsidian' })
    }
    if (!link.extraDirections?.size) return rows
    for (const [field, direction] of link.extraDirections) {
        const key = `extra:${field}` as const
        const local = link.obsidian.extra![field]
        const remote = link.anki.extra![field]
        if (local.normalize('NFC') === remote.normalize('NFC')) continue
        const merged = target.value.extra![field]
        rows.push({ key: `${link.bullet.id}:${key}`, field, obsidian: local, anki: remote, merged,
            decision: target.conflicts.includes(key) ? 'conflict'
                : merged.normalize('NFC') === local.normalize('NFC') ? 'obsidian' : 'anki',
            allowedSide: direction === 'to-anki' ? 'obsidian'
                : direction === 'to-obsidian' || link.outboundBlocked?.has(field) ? 'anki' : undefined })
    }
    return rows
}

/** Generate Context from the same title that the conflict choice or incoming edit will put in Markdown. */
function resolvedPageContext(link: Link, title: string): Link {
    const field = link.pageContextField
    if (!field || !link.generated || title === link.obsidian.front) return link
    const update = link.generated[field]
    if (!update) return link
    const original = pageSourceContext(link.source.path, link.obsidian.front)
    const next = pageSourceContext(link.source.path, title)
    // File and Context may be assigned to one service field. Respect either suffix order.
    const after = update.after.startsWith(original) ? next + update.after.slice(original.length) :
        update.after.endsWith(original) ? update.after.slice(0, -original.length) + next : undefined
    if (!after) return link
    return { ...link, generated: { ...link.generated, [field]: { ...update, after } },
        sourceSuffixes: { ...link.sourceSuffixes, [field]: after } }
}

async function readModelTemplateFields(modelName: string): Promise<ReadonlySet<string> | undefined> {
    try {
        const response = await auditRead('multi', { actions: [{ action: 'modelTemplates', version: 6, params: { modelName } }] },
            undefined, 5_000)
        const row = isResponseList(response) && response.length === 1 ? response[0] : undefined
        return isRecord(row) && row.error === null ? readTemplateFieldReferences(row.result) : undefined
    } catch {
        return undefined
    }
}

let cachedEmptyFieldHash: string | undefined
function emptyNamedFieldHash(): string { return cachedEmptyFieldHash ??= oneWayFieldDigest('') }

async function additionalObservation(plugin: MyPlugin, snapshot: NoteSnapshot, bullet: SourceCard,
    configured: ReadonlyMap<string, BidirectionalFieldDirection> | undefined, record: SyncRecord | undefined,
    templateFields: () => Promise<ReadonlySet<string> | undefined>, localCard: LocalCard,
    priorOneWay: () => Promise<OneWayHistory>): Promise<{
    directions?: Map<string, BidirectionalFieldDirection>
    fieldBases?: Map<string, string | null>
    releaseOneWayField?: boolean
    outboundBlocked?: Set<string>
    local?: Record<string, string>
    remote?: Record<string, string>
    issues?: string[]
    blocked?: boolean
}> {
    const pending = record?.pending
    const wanted = pending?.extraDirections
    // Незавершённую операцию старого формата проверяем с исходным набором полей.
    if (pending && !wanted && !Object.keys(pending.target.extra ?? {}).length) return {}
    if (!bullet.extra && !pending) return {}
    const t = uiFor(plugin.settings)
    const issues: string[] = []
    const local = Object.create(null) as Record<string, string>
    const remote = Object.create(null) as Record<string, string>
    const directions = new Map<string, BidirectionalFieldDirection>()
    const outboundBlocked = new Set<string>()
    const block = explicitBlock(bullet)
    const named = block?.format === 'page' || block?.namedFieldInsertAt !== undefined
    const schema = plugin.fields_dict?.[snapshot.modelName]
    const candidates = new Set(Object.keys(bullet.extra ?? {}))
    if (named && block) for (const name of block.pageOptionalFieldNames ?? schema ?? []) {
        if (isWritableBlockExtraName(name) && !block.fieldPair?.includes(name) &&
            Object.prototype.hasOwnProperty.call(snapshot.fields, name)) candidates.add(name)
    }
    const fieldBases = new Map<string, string | null>()
    let history: OneWayRecord | undefined
    let checkedHistory = false
    const namedHistory = async () => {
        if (!checkedHistory) {
            history = (await priorOneWay()).get(bullet.id, snapshot.modelName)
            checkedHistory = true
        }
        return history
    }
    let releaseOneWayField = false
    for (const name of candidates) {
        if (wanted && !Object.prototype.hasOwnProperty.call(wanted, name)) continue
        if (localCard.frozenFields?.has(name) || localCard.sourceSuffixes?.[name] ||
            isGeneratedBidirectionalField(plugin.settings, snapshot.modelName, name)) continue
        const present = Object.prototype.hasOwnProperty.call(bullet.extra ?? {}, name)
        const value = present ? bullet.extra![name] : ''
        const direction = configured?.get(name) ?? ((block?.layout || named) && isBidirectionalFieldName(name) ? 'both' : undefined)
        if (block && !direction && !wanted) continue
        let previous: string | null | undefined = record?.namedFieldModel === snapshot.modelName ? record.base?.extra?.[name] : undefined
        const raw = rawField(snapshot, name)
        // Source у перенесённой страницы хранит связь с прежним плагином. Начинаем
        // обмен им только после явной строки или настройки направления для этого поля.
        if (block?.linkedRoute && name === 'Source' && !present && !wanted && !configured?.has(name) && previous === undefined) {
            if (!(await namedHistory())?.namedFields?.includes(name)) continue
        }
        if (localCard.ruleFields?.has(name)) {
            issues.push(t(`Additional field “${name}” is managed by an export rule.`,
                `Дополнительное поле «${name}» управляется правилом экспорта.`))
            continue
        }
        if (!direction) {
            issues.push(t(`Additional field “${name}” has no editable rule for this note type.`,
                `У дополнительного поля «${name}» нет редактируемого правила для этого типа записи.`))
            continue
        }
        const field = decodeField(raw, block, undefined, true)
        if (present && (block ? !localCard.verifiedExtras?.has(name) : value !== '' && !isEditableMarkdownField(value)) || field === undefined) {
            issues.push(block ? t(`Additional field “${name}” must be editable plain text in both apps.`,
                `Дополнительное поле «${name}» должно содержать редактируемый простой текст в обеих программах.`)
                : t(`Additional field “${name}” must be a reversible single line of text in both apps.`,
                    `Дополнительное поле «${name}» должно быть простой редактируемой строкой в обеих программах.`))
            continue
        }
        if (named && !pending && (!present || value.normalize('NFC') !== field.normalize('NFC'))) {
            // The profile-specific receipt stores the verified HTML. Compare bytes from
            // the same exporter and Anki read used by one-way sync, including line breaks.
            const prior = await namedHistory()
            const hash = prior?.fields[name]
            if (prior?.namedFields && hash) {
                const owned = prior.namedFields.includes(name)
                if (owned && !present && !field) releaseOneWayField = true
                if (hash === emptyNamedFieldHash()) previous = ''
                else if (owned) {
                    const localHtml = localCard.verifiedExtras?.get(name)
                    previous = hash === oneWayFieldDigest(raw!) ? field :
                        localHtml !== undefined && hash === oneWayFieldDigest(localHtml) ? value : null
                }
                if (previous !== undefined) fieldBases.set(name, previous)
            }
        }
        if (!present) {
            if (!wanted && direction === 'to-anki' && previous === undefined) continue
            if (!wanted && previous === undefined && field === '') continue
            // Old checkpoints could contain obsolete values for an omitted field. In
            // the absence of a named receipt, a remote-only value is a new local line.
            fieldBases.set(name, direction === 'to-obsidian' || previous === undefined ? '' : previous)
        }
        const base = fieldBases.has(name) ? fieldBases.get(name) : record?.base?.extra?.[name]
        const remoteOnly = direction !== 'to-anki' && typeof base === 'string' && value.normalize('NFC') === base.normalize('NFC')
        if (!remoteOnly && direction !== 'to-obsidian' && (value === '') !== (field === '')) {
            const references = await templateFields()
            if (!references || references.has(name.toLowerCase())) {
                issues.push(t(`Sending an empty or newly filled “${name}” to Anki may change generated cards; this write is blocked.`,
                    `Запись пустого или впервые заполненного поля «${name}» в Anki может изменить состав карточек. Эта запись заблокирована.`))
                if (direction === 'to-anki') continue
                outboundBlocked.add(name)
            }
        }
        local[name] = value
        remote[name] = field
        directions.set(name, direction)
    }
    const expected = wanted && Object.keys(wanted).filter(name => named || candidates.has(name) ||
        // The first import of an Anki-only field could have been interrupted before a 0.9.7 receipt existed.
        (record?.namedFieldModel !== snapshot.modelName && pending?.obsidian.extra?.[name] !== ''))
    if (pending && (!wanted || directions.size !== expected?.length || outboundBlocked.size ||
        Array.from(directions).some(([name, direction]) => wanted[name] !== direction))) {
        return { issues: [...issues, t('Restore the additional field markers and directions before resuming the unconfirmed write.',
            'Восстановите маркеры и направления дополнительных полей перед продолжением неподтверждённой записи.')], blocked: true }
    }
    return directions.size ? { directions, releaseOneWayField, fieldBases: fieldBases.size ? fieldBases : undefined, outboundBlocked: outboundBlocked.size ? outboundBlocked : undefined, local, remote, issues } : { issues }
}

function readSourceCards(text: string, syntax: DuplicateMarkerSyntax, expressions: Readonly<Record<string, string>>,
    pageModel: string | undefined, readers: ReturnType<typeof presetReaders>,
    markers: readonly { id: number; line: number }[], modelFields: Plan['modelFields'], cursorId?: number): SourceCard[] {
    const page = readPageCard(text, expressions, syntax, pageModel)
    if (page) {
        const card = pageBlock(page, modelFields[page.model])
        return card ? [card] : []
    }
    text = maskLegacyFieldSections(text)
    const blocks = findBidirectionalBlocks(text, syntax, modelFields)
    let bullets = findLinkedBullets(text, readers.length > 0, syntax)
    if (bullets.length && readers.some(reader => reader.format === 'knowledge')) {
        bullets = bullets.filter(bullet => !isKnowledgeBullet(text, bullet.start))
    }
    if (blocks.length && bullets.length) {
        const overlaps = makeSpanOverlap(blocks.map(block => [block.start, block.end]))
        bullets = bullets.filter(card => !overlaps(card.start, card.end))
    }
    const cards: SourceCard[] = blocks.length ? [...blocks, ...bullets] : bullets
    if (!readers.length || bullets.length === markers.length &&
        bullets.every((bullet, i) => bullet.id === markers[i].id && bullet.markerLine === markers[i].line)) return cards
    const claimed = makeSpanOverlap(cards.map(card => [card.start, card.end]))
    const wanted = cursorId === undefined ? markers : markers.filter(marker => marker.id === cursorId)
    return [...cards, ...findPresetBlocks(text, readers, wanted, claimed, syntax)]
}

/** Контрольная точка должна описывать уже записанный Markdown, включая только что изменённые поля и метки. */
function savedSignatures(source: SourceFile, text: string, wanted: ReadonlySet<number>, plan: Plan, syntax: DuplicateMarkerSyntax) {
    const hashes = new Map<number, string>()
    let cards = source.cards
    if (text !== source.content) {
        const commands = source.parserText === undefined ? undefined : explicitDeletes(text, syntax, plan.expressions, plan.pageModel, plan.directivePatterns)
        const view = commands?.masked ?? text
        const markers = findIdMarkers(view, syntax)
        const seen = new Set<number>(), ambiguous = new Set<number>()
        for (const marker of markers) {
            if (seen.has(marker.id)) ambiguous.add(marker.id)
            seen.add(marker.id)
        }
        cards = readSourceCards(view, syntax, plan.expressions, plan.pageModel, plan.readers, markers, plan.modelFields, plan.cursor?.id)
            .filter(card => seen.has(card.id) && !ambiguous.has(card.id))
    }
    for (const card of cards) if (wanted.has(card.id)) {
        hashes.set(card.id, deletionSignature(text, source.path, sourceRemoval(text, card)))
    }
    return hashes
}

async function buildPlan(plugin: MyPlugin, scope: Scope, currentRevision: () => number,
    pathRevision: (path: string) => number,
): Promise<Plan> {
    const startRevision = currentRevision()
    const config = configuration(plugin)
    const { app } = plugin
    const { vault } = app
    const target = scope.card
    const t = uiFor(plugin.settings)
    const changedCard = () => new Error(t('The selected card, its sync settings or its location changed. Open the card preview again.',
        'Изменились выбранная карточка, её положение или настройки. Откройте предпросмотр карточки снова.'))
    if (target) {
        if (!target.id || target.configuration !== cursorConfiguration(plugin)) throw changedCard()
        checkCursorEditors(plugin, target)
    }
    const folderScope = resolveSyncScope(plugin)
    const current = scope.currentFile?.file
    if (scope.currentFile && (current?.path !== scope.currentFile.path || !folderScope.allFiles.includes(scope.currentFile.file))) {
        throw new Error(t('The selected Markdown file was moved or removed. Run the command again.',
            'Выбранный Markdown-файл перемещён или удалён. Повторите команду.'))
    }
    const selected = current || scope.paths || target
        ? new Set(folderScope.files.filter(file =>
            (!current || file === current) && (!scope.paths || scope.paths.has(file.path)) &&
            (!target || file.path === target.path),
        ).map(file => file.path))
        : folderScope.paths
    if (current && !selected.has(current.path)) {
        if (folderScope.excludes(current.path)) throw new Error(`The current note is excluded by "${folderScope.label}".`)
        throw new Error(`The current note is outside the selected scan area (${folderScope.label}).`)
    }
    if ((target || scope.paths?.size) && !selected.size) {
        throw new Error(`The selected files are outside "${folderScope.label}" or no longer exist.`)
    }
    const editorFile = target ? null : current ?? app.workspace.getActiveFile?.()
    const newCardSource = editorFile && selected.has(editorFile.path) ? editorFile : undefined
    const profile = await requireExpectedAnkiProfile(plugin, target?.profile)
    const statePath = protectedStatePath(plugin)
    const state = await BidirectionalState.open(vault.adapter, statePath, profile)
    let history: Promise<OneWayHistory> | undefined
    const priorOneWay = () => history ??= openOneWayHistory(plugin, profile)
    const extraRules = new Map<string, Map<string, BidirectionalFieldDirection>>()
    for (const { model, field, direction } of readBidirectionalFieldRules(plugin.settings.BIDIRECTIONAL_FIELDS)) {
        const fields = extraRules.get(model) ?? new Map<string, BidirectionalFieldDirection>()
        fields.set(field, direction)
        extraRules.set(model, fields)
    }
    const modelTemplates = new Map<string, Promise<ReadonlySet<string> | undefined>>()
    const templateFieldsFor = (model: string): Promise<ReadonlySet<string> | undefined> => {
        let read = modelTemplates.get(model)
        if (!read) {
            read = readModelTemplateFields(model)
            modelTemplates.set(model, read)
        }
        return read
    }
    const data = await settingToData(app, plugin.settings, plugin.fields_dict, [])
    const directivePatterns = [data.DECK_REGEXP, data.TAG_REGEXP, data.FROZEN_REGEXP]
    const readers = presetReaders(data.custom_regexps, data.fields_dict)
    // Контекст карточки может зависеть от отдельного обновления метаданных Obsidian.
    const cacheKey = !data.add_context && !scope.force ? JSON.stringify([config, profile, vault.getName()]) : undefined
    const previousSources = warmSources.get(plugin)
    const cachedFiles = cacheKey !== undefined && previousSources?.key === cacheKey ? previousSources.files : undefined
    const cachedSource = (file: TFile, path: string, stamp: SourceStamp): CachedSource | undefined => {
        const cached = cachedFiles?.get(path)
        return cached?.file === file && stamp.every((part, index) => part === cached.stamp[index]) ? cached : undefined
    }
    const sources: SourceFile[] = []
    const issues: string[] = []
    const rows: BidirectionalPreviewRow[] = []
    const deletions = new Map<SourceFile, DeleteFile>()
    const dirty = dirtyFiles(plugin)
    const index = await indexVaultIds(plugin, folderScope.allFiles, plugin.settings.Syntax, pathRevision, {
        force: scope.force,
        needsContent: (path, file) => selected.has(path) && !dirty.has(path) &&
            !cachedSource(file, path, sourceStamp(file, pathRevision(path))),
        onFile: (file, path, markers, content) => {
            if (!selected.has(path)) return
            if (dirty.has(path)) {
                issues.push(`${path}: save the open note before syncing it.`)
                return
            }
            const stamp = sourceStamp(file, pathRevision(path))
            const cached = content === undefined ? cachedSource(file, path, stamp) : undefined
            const text = content ?? cached?.content
            if (text === undefined) throw new Error('the file changed during the preview')
            if (!cached && readRecoveryMarker(text)) {
                issues.push(`${path}: use Review Pending Anki Creations before syncing this note.`)
                return
            }
            const offset = target ? cursorCardOffset(target, path, text) : undefined
            let suspendMarkers: ReturnType<typeof readSuspendMarkers>
            try {
                suspendMarkers = cached?.markers ?? readSuspendMarkers(text, plugin.settings.Syntax)
            } catch (error) {
                issues.push(path + ': ' + (error instanceof Error ? error.message : String(error)))
                return
            }
            let commands: ExplicitDeletes | undefined
            try {
                commands = explicitDeletes(text, plugin.settings.Syntax, data.custom_regexps, data.page_model, directivePatterns)
                // A DELETE-only source may bypass the regular parser. Apply the same deck check before queuing it.
                if (commands && data.DECK_REGEXP) readDeckDirective(text, data.DECK_REGEXP)
            }
            catch (error) { issues.push(path + ': ' + String(error)); return }
            const parserText = commands?.masked ?? text
            const source: SourceFile = { path, file, content: text, cards: [], stamp, markers: suspendMarkers,
                parserText: commands ? parserText : undefined }
            if (commands && !target) deletions.set(source, { commands, removals: [], evidence: new Map() })
            let cards = cached?.entries
            if (!cards) {
                try {
                    cards = readSourceCards(parserText, plugin.settings.Syntax, data.custom_regexps, data.page_model,
                        readers, markers, data.fields_dict, target?.id)
                } catch (error) {
                    issues.push(path + ': ' + (error instanceof Error ? error.message : String(error)))
                    return
                }
            }
            if (target && offset !== undefined) {
                const matches = cards.filter(card => containsCardOffset(card, text, offset))
                if (matches.length !== 1 || matches[0].id !== target.id) {
                    throw new Error(t('The card at this position has no verified two-way field mapping.',
                        'Для карточки в этой позиции не подтверждено сопоставление полей двусторонней синхронизации.'))
                }
                sources.push({ ...source, cards: matches, parseIds: markers.map(marker => marker.id) })
                return
            }
            const supportedIds = new Set([...cards.map(card => card.id), ...(commands?.directives.map(d => d.id) ?? [])])
            const unsupported = markers.filter(marker => !supportedIds.has(marker.id)).length
            if (unsupported) issues.push(t(`${path}: ${unsupported} ID markers have no verified field boundaries. Check their format in the rule wizard.`,
                `${path}: маркеров ID без подтверждённых границ полей: ${unsupported}. Проверьте их формат в мастере правил.`))
            if (cards.length) { source.cards = cards; sources.push(source) }
        },
    })
    for (const { path, message } of index.errors) issues.push(`${path}: ${message}`)
    const noteIds = Array.from(new Set([...sources.flatMap(source => source.cards.map(card => card.id)),
        ...Array.from(deletions.values()).flatMap(group => group.commands!.directives.map(d => d.id))]))
    if (noteIds.length) await requireExpectedAnkiProfile(plugin, profile)
    const deletionMode = afterDeleteMode(plugin.settings)
    const trashPages = plugin.settings.TRASH_DELETED_PAGES === true
    // Пропущенная строка в неполном ответе сама по себе не считается отсутствующей записью.
    const missing = new Set<number>()
    const snapshots = await readNotes(noteIds, profile, missing)
    const descriptions = {
        'trash-page': t('Move page to vault trash', 'Переместить страницу в корзину'),
        'remove-block': t('Remove source block', 'Удалить исходный блок'),
        'strike-block': t('Strike through the entire card', 'Зачеркнуть всю карточку'),
        'hide-block': t('Hide the card in an HTML comment', 'Скрыть карточку в HTML-комментарии'),
        'mark-block': t('Keep source and mark it as deleted', 'Сохранить текст и отметить удаление'),
        'keep-private-page': t('Keep the page and ID to protect private notes after the answer', 'Сохранить страницу и ID для защиты личных заметок после ответа'),
        'clear-command': t('Clear the command and keep the source and ID', 'Убрать команду, сохранить текст и ID'),
        'clear-command-and-id': t('Clear standalone command and ID', 'Убрать отдельную команду и её ID'),
    }
    for (const [source, group] of deletions) {
        for (const directive of group.commands!.directives) {
            const { id } = directive
            const owner = index.first.get(id)
            const snap = snapshots.get(id)
            const row = { path: source.path, id, markerLine: owner?.line, changes: [] }
            if (!index.complete || owner?.path !== source.path || index.duplicates.has(id) || state.get(id)?.pending ||
                !snap && !missing.has(id)) {
                rows.push({ ...row, issues: [t('Could not verify this deletion command.', 'Не удалось проверить команду удаления.')] })
                continue
            }
            group.evidence.set(id, snap ? snapshotKey(snap) : null)
            const effect = localDeleteEffect(directive, deletionMode, trashPages)
            const local = descriptions[effect]
            rows.push({ ...row, changes: [{ key: String(id) + ':delete', field: t('Delete Anki note', 'Удалить запись Anki'),
                obsidian: local, anki: snap ? snap.modelName : t('Already absent', 'Уже отсутствует'), decision: 'obsidian' }] })
        }
        if (!group.evidence.size) deletions.delete(source)
    }
    const suspendInputs = new Map<number, readonly number[]>()
    const numbered = new Set<number>()
    for (const source of sources) for (const { id } of source.cards) {
        const snapshot = snapshots.get(id)
        if (!snapshot?.cards.length || index.duplicates.has(id)) continue
        suspendInputs.set(id, snapshot.cards)
        const base = state.get(id)?.suspension
        if (Array.isArray(source.markers.get(id)?.selection) || base?.cards.some(([, number]) => number !== null)) numbered.add(id)
    }
    const statuses = await readSuspendCards(profile, suspendInputs, numbered)
    const pauses: PauseUpdate[] = []
    const models = new Map<number, SourceModel>()
    const schemas = new Map<string, SourceModel>()
    for (const [id, snapshot] of snapshots) {
        const names = Object.keys(snapshot.fields)
        if ((!names.includes('Front') || !names.includes('Back')) && (!names.includes('Question') || !names.includes('Answer')) &&
            !isDeckPageSchema(snapshot.modelName, names)) continue
        const key = JSON.stringify([snapshot.modelName, names])
        let model = schemas.get(key)
        if (!model) {
            model = { key, name: snapshot.modelName, fieldNames: new Set(names) }
            schemas.set(key, model)
        }
        models.set(id, model)
    }
    const manager = new FileManager(app, data, [], {}, [])
    manager.diagnosticSyntax = plugin.settings.Syntax
    const nextFiles = new Map<string, CachedSource>()
    let cachedChars = 0
    const links: Link[] = []
    const idDate = plugin.settings.Defaults['Add Date to Anki IDs'] ? formatLocalIdDate(new Date()) : undefined
    for (const source of sources) {
        const { file, path, content, cards, stamp } = source
        const firstRow = rows.length
        const firstLink = links.length
        const firstPause = pauses.length
        try {
            const ids = cards.map(card => card.id)
            const sourceModels = cacheKey !== undefined && content.length <= maxCachedSourceLength
                ? ids.map(id => models.get(id)) : undefined
            const cached = cachedFiles?.get(path)
            const reused = !target && cached?.file === file && cached.content === content && sourceModels &&
                sourceModels.length === cached.models.length &&
                sourceModels.every((model, index) => model?.key === cached.models[index]?.key) ? cached : undefined
            const parsed = reused ? undefined : await manager.parseMarkdown(file, source.parserText ?? content, source.parseIds ?? ids, true, models,
                cards.filter((card): card is LinkedBullet => !('explicitFields' in card)),
                false, undefined, !!target, undefined, { shouldStop: () => currentRevision() !== startRevision })
            if (target && parsed) {
                const atCursor = cardAtOffset(parsed, content, cursorCardOffset(target, path, content))
                const edits = parsed.notes_to_edit.filter(edit => edit.identifier === target.id)
                if (!atCursor || atCursor.identifier !== target.id || atCursor.note.modelName !== target.model ||
                    atCursor.note.deckName !== target.deck || edits.length !== 1 || edits[0].note !== atCursor.note) throw changedCard()
            }
            if (cards.some(needsReparse)) {
                source.readAfterCustomEdit = async text => {
                    const readRevision = currentRevision()
                    const view = source.parserText === undefined ? text :
                        explicitDeletes(text, plugin.settings.Syntax, data.custom_regexps, data.page_model, directivePatterns)?.masked ?? text
                    const markers = findIdMarkers(view, plugin.settings.Syntax)
                    const entries = readSourceCards(view, plugin.settings.Syntax, data.custom_regexps, data.page_model, readers, markers, data.fields_dict)
                    return manager.parseMarkdown(file, view, markers.map(marker => marker.id), true, models,
                        entries.filter((entry): entry is LinkedBullet => !('explicitFields' in entry)),
                        false, undefined, false, undefined, { shouldStop: () => currentRevision() !== readRevision })
                }
            }
            const parsedById = parsed && new Map(parsed.notes_to_edit.map(({ identifier, note }, index) =>
                [identifier, { note, range: parsed.auditNoteRanges?.[index] }] as const))
            const fileTags = parsed?.global_tags.split(/\s+/u) ?? []
            const yamlTags = parsed ? frontmatterTags(content) : []
            const localCards = reused?.cards ?? new Map<number, LocalCard>()
            for (const bullet of cards) {
                const { id } = bullet
                const block = explicitBlock(bullet)
                if ('metadata' in bullet) {
                    const model = models.get(id)?.name
                    bullet.remNoteAnswerSlot = !!model && currentCardExpression(data.custom_regexps[model] ?? '') === remNoteExpression &&
                        isRemNoteBullet(content, bullet.start)
                }
                const conflict = index.duplicates.get(id)
                const markerLine = (conflict?.find(location => location.path === path) ?? index.first.get(id))?.line
                const row: BidirectionalPreviewRow = { id, path, markerLine, changes: [], endLine: block?.endLine,
                    line: block?.line ?? (markerLine === undefined ? undefined : markerLine - 1) }
                if (conflict) {
                    rows.push({ ...row, issues: [`Duplicate Anki ID ${id}. Keep this ID in one source.`], duplicates: conflict })
                    continue
                }
                const snapshot = snapshots.get(id)
                const candidate = parsedById?.get(id)
                if (target && snapshot && snapshot.modelName !== target.model) throw changedCard()
                const record = state.get(id)
                const suffixes = candidate ? sourceSuffixes(candidate.note.fields, id, path, vault.getName(),
                    data.add_file_link ? data.file_link_fields?.[candidate.note.modelName] : undefined,
                    data.add_context ? data.context_fields?.[candidate.note.modelName] : undefined) : localCards.get(id)?.sourceSuffixes
                const sourceBodies = candidate && suffixes ? Object.fromEntries(Object.entries(suffixes).map(([name, suffix]) =>
                    [name, candidate.note.fields[name].slice(0, -suffix.length)])) : localCards.get(id)?.sourceBodies
                let generated = snapshot && suffixes ? observeSourceFields(snapshot.fields, suffixes,
                    record?.pending?.sourceSuffixes ?? record?.sourceSuffixes, id, vault.getName(), sourceBodies,
                    previousPath => !!record?.deletionSource && record.deletionSource ===
                        deletionSignature(content, previousPath, sourceRemoval(content, bullet)),
                    record?.pending?.targetSourceSuffixes) : undefined
                if (snapshot && suffixes && !generated) {
                    rows.push({ ...row, issues: [t('The generated source field in Anki changed. Review its link or heading context.',
                        'Служебное поле в Anki изменилось. Проверьте ссылку на файл или контекст заголовка.')] })
                    continue
                }
                // У страницы общее поле определено только в заголовке FROZEN. Сравниваем именно
                // результат штатного Markdown-рендера; запись из Anki не меняет этот источник.
                const sharedNames = parsed?.pageCard?.sharedFields?.values
                const pageShared = candidate ? sharedNames && Object.fromEntries(Array.from(sharedNames.keys(),
                    name => [name, candidate.note.fields[name]])) : localCards.get(id)?.pageShared
                if (snapshot && pageShared) {
                    generated ??= Object.create(null) as SourceFieldUpdates
                    for (const [name, after] of Object.entries(pageShared)) {
                        const before = rawField(snapshot, name)
                        if (before === undefined || typeof after !== 'string') throw new Error(
                            'Refresh the note type to verify its shared field. / Обновите тип записи для проверки общего поля: ' + name)
                        if ((before === '') !== (after === '')) {
                            const refs = await templateFieldsFor(snapshot.modelName)
                            if (!refs || refs.has(name.toLowerCase())) throw new Error(t(
                                `Changing shared field “${name}” can affect the generated Anki cards. Review its question template first.`,
                                `Значение общего поля «${name}» может повлиять на состав карточек Anki. Проверьте лицевую сторону шаблона.`))
                        }
                        generated[name] = { before, after, body: '' }
                    }
                }
                if (generated && Object.entries(generated).some(([name, update]) => update.before !== update.after &&
                    cardFieldHazards(name, update.body + update.before, update.body + update.after).length)) {
                    rows.push({ ...row, issues: [t('Updating this source field could change the generated Anki cards.',
                        'Обновление служебного поля может изменить состав учебных карточек Anki.')] })
                    continue
                }
                const clean = snapshot && sourceFieldsSnapshot(snapshot, bullet, generated)
                const remote = clean && decodeAnkiNote(clean, bullet)
                const expectedLinks = record?.pending?.ankiBacklinks
                // Older pending records kept the formatter's backlink in a separate guard.
                // Validate it against the original Anki bytes before upgrading its representation.
                const checkedLinks = expectedLinks && generated && !record?.pending?.sourceSuffixes && snapshot
                    ? decodeAnkiNote(snapshot, bullet)?.backlinks : remote?.backlinks
                if (expectedLinks && checkedLinks && !sameBacklinks(checkedLinks, expectedLinks)) {
                    // Совпадение простого текста не подтверждает завершение записи, в которой потерялась сформированная ссылка.
                    const fix = expectedLinks.some(link => link !== null)
                        ? 'Restore the original generated Obsidian link in Anki, then preview again.'
                        : 'Review the new generated Obsidian link in Anki and restore its previous state before retrying.'
                    rows.push({ ...row, issues: [`A previous write is still pending. ${fix}`] })
                    continue
                }
                let local = localCards.get(id)
                const range = candidate?.range
                const blockIsParsed = !block || range && range[0] >= block.start - block.eol.length &&
                    range[0] < content.indexOf('\n', block.start) && range[1] > block.idStart &&
                    range[1] <= block.end + block.eol.length
                const capturedNames = block && (block.format || block.namedFieldInsertAt !== undefined) ? data.fields_dict[block.model] : undefined
                const mapping = block?.format === 'custom' && block.layout && plugin.settings.REGEXP_WIZARD_FIELDS?.[block.model]
                const mappedFrontAndBack = block?.layout ? block.layout.names.every((name, i) =>
                    capturedNames?.[i] === name && (!mapping || mapping[i] === name)) : block?.fieldPair ? isLinkedPageSchema(block.model, capturedNames, block.fieldPair) :
                    !block?.format || capturedNames?.[0] === 'Front' && capturedNames[1] === 'Back'
                if (remote?.value && markerLine !== undefined && candidate && blockIsParsed && mappedFrontAndBack &&
                    (!block || block.model === snapshot?.modelName)) {
                    const fields = suffixes ? { ...candidate.note.fields } : candidate.note.fields
                    for (const [name, suffix] of Object.entries(suffixes ?? {})) fields[name] = fields[name].slice(0, -suffix.length)
                    local = readLocalCard(content, bullet, suffixes ? { ...candidate.note, fields } : candidate.note, fileTags, yamlTags)
                    if (local) {
                        local.frozenFields = parsed?.namedSyncFrozenFields?.(candidate.note.modelName)
                        local.pageShared = pageShared
                    }
                    if (local && suffixes) { local.sourceSuffixes = suffixes; local.sourceBodies = sourceBodies }
                    if (local) localCards.set(id, local)
                }
                const slots = statuses.get(id)
                const pauseIssues: string[] = []
                let pauseChange: BidirectionalPreviewChange | undefined
                const marker = source.markers.get(id)?.selection ?? null
                if (slots && (marker || record?.suspension || slots.some(slot => slot.suspended)) && markerLine !== undefined && (local || candidate && blockIsParsed && candidate.note.modelName === snapshot?.modelName)) {
                    const label = (selection: SuspendSelection | null) => selection === null ? t('All active', 'Все активны') :
                        selection === 'all' ? t('All paused', 'Все на паузе') :
                            t('Paused: ', 'На паузе: ') + selection.map(n => '#' + n).join(', ')
                    try {
                        const merge = mergeSuspension(slots, marker, record?.suspension)
                        if (merge.changed) {
                            pauses.push({ id, source, slots, merge, record })
                            if (merge.localChange || merge.remoteChange) {
                                pauseChange = { key: id + ':suspension', field: t('Review status', 'Статус повторений'),
                                    decision: merge.localChange && merge.remoteChange ? 'merge' : merge.remoteChange ? 'obsidian' : 'anki',
                                    obsidian: label(marker), anki: label(describeSuspendSelection(slots, merge.remote)), merged: label(merge.nextMarker) }
                            }
                        }
                    } catch (error) {
                        if (error instanceof SuspensionTopologyChanged && record?.suspension) {
                            const merge = acceptAnkiSuspension(slots, marker)
                            pauses.push({ id, source, slots, merge, record, requiresAnkiChoice: true })
                            const pairs = (cards: readonly (readonly [number, number | null])[]) =>
                                cards.map(([cardId, number]) => (number === null ? '' : '#' + number + ' · ') + 'ID ' + cardId).join(', ')
                            pauseChange = { key: id + ':suspension', field: t('Changed card identities', 'Изменились учебные карточки'),
                                decision: 'conflict', allowedSide: 'anki',
                                obsidian: label(marker) + '\n' + pairs(record.suspension.cards.map(([cid, n]) => [cid, n])),
                                anki: label(merge.nextMarker) + '\n' + pairs(slots.map(slot => [slot.cardId, slot.number])) }
                            pauseIssues.push(t('Check the card IDs. Choose Anki to use its current suspension status and remember the new cards.',
                                'Проверьте ID учебных карточек. Выберите Anki, чтобы перенести её текущие паузы и запомнить новые карточки.'))
                        } else pauseIssues.push(uiDiagnostic(error, t))
                    }
                } else if (snapshot && (marker || record?.suspension)) {
                    pauseIssues.push(t('Could not verify the cards belonging to this suspension marker.',
                        'Не удалось подтвердить учебные карточки для этой метки паузы.'))
                }
                if (pauseChange) row.changes = [pauseChange]
                // Запоминаем только подтверждённые пары, независимо от выбранного способа обработки удаления.
                const linkedHere = markerLine !== undefined && index.complete && index.first.get(id)?.path === path
                const removal = linkedHere && (local && snapshot || !snapshot && record?.deletionSource && missing.has(id)) ?
                    sourceRemoval(content, bullet) : undefined
                const effect = !target && removal && localDeleteEffect({ card: removal, detached: false }, deletionMode, trashPages)
                const signature = removal && (local?.deletionSource ?? deletionSignature(content, path, removal))
                if (local && signature) local.deletionSource = signature
                if (!snapshot && missing.has(id) && index.complete && index.first.get(id)?.path === path &&
                    removal && effect &&
                    record?.base && !record.pending && record.deletionSource === signature) {
                    const group: DeleteFile = deletions.get(source) ?? { evidence: new Map(), removals: [] }
                    deletions.set(source, group)
                    group.removals.push(removal)
                    group.evidence.set(id, null)
                    rows.push({ ...row, changes: [{ key: String(id) + ':deletion', field: t('Deleted in Anki', 'Удалено в Anki'),
                        obsidian: removal.page ? t('Page', 'Страница') : t('Card block', 'Блок карточки'),
                        anki: effect === 'clear-command' ? t('Keep text and ID', 'Оставить текст и ID') : descriptions[effect], decision: 'anki' }] })
                    continue
                }
                if (!snapshot || !remote?.value || !local || markerLine === undefined) {
                    let problem = !snapshot ? t('This ID was not found or could not be read in the active Anki profile.',
                        'Не удалось найти или прочитать этот ID в активном профиле Anki.') :
                        block?.layout ? t('The Anki and Markdown fields must have the same verified order and editable text. Check the rule and model fields.',
                            'Проверьте порядок полей в правиле и типе Anki. Для обратного переноса нужен однозначно сопоставимый текст.') :
                        t('This card needs plain-text Front and Back fields that can be mapped back to Markdown.',
                            'У этой карточки должны быть текстовые поля вопроса и ответа, соответствующие разметке Markdown.')
                    if (!snapshot && missing.has(id)) {
                        if (!record?.base) problem = t(
                            'Anki reports this note missing. No previous confirmed sync of this ID in the active profile is recorded. Its Markdown source is kept.',
                            'Anki сообщает, что запись отсутствует. Предыдущая успешная сверка этого ID в активном профиле не зафиксирована. Исходный текст сохранён.')
                        else if (signature && record.deletionSource === signature && !record.pending) problem = t(
                            'Anki previously confirmed this note in this profile. The current response reports it missing. Its Markdown text and ID are kept.',
                            'Ранее Anki подтвердила эту запись в данном профиле. Сейчас Anki сообщает, что она отсутствует. Текст Markdown и ID сохранены.')
                        else problem = t(
                            'Anki reports this note missing. Its current Markdown source could not be verified against the previous sync. The source is kept.',
                            'Anki сообщает, что запись отсутствует. Подтвердить текущий блок Markdown по предыдущей сверке не удалось. Исходный текст сохранён.')
                    }
                    const issues = [problem]
                    if (record?.pending) issues.push('A previous sync of this card is pending verification.')
                    rows.push({ ...row, issues: [...issues, ...pauseIssues],
                        recoverable: !pauseChange && !pauseIssues.length && !record?.pending && markerLine !== undefined && (snapshot !== undefined || missing.has(id)) })
                    continue
                }
                const extra = block || bullet.extra || record?.pending?.extraDirections || record?.pending?.target.extra
                    ? await additionalObservation(plugin, snapshot, bullet, extraRules.get(snapshot.modelName),
                        record, () => templateFieldsFor(snapshot.modelName), local, priorOneWay)
                    : undefined
                if (extra?.blocked) {
                    rows.push({ ...row, issues: [...(extra.issues ?? []), ...pauseIssues] })
                    continue
                }
                const obsidian = extra?.local ? { ...local.obsidian, extra: extra.local } : local.obsidian
                const anki = extra?.remote ? { ...remote.value, extra: extra.remote } : remote.value
                const extraIssues = extra?.issues?.length || pauseIssues.length ? [...(extra?.issues ?? []), ...pauseIssues] : undefined
                // Записи с подтверждённой общей версией и совпавшими сторонами не создают операций.
                const namedFieldModel = (block?.format === 'page' || block?.namedFieldInsertAt !== undefined) &&
                    (extra?.directions?.size || record?.namedFieldModel === snapshot.modelName) ? snapshot.modelName : undefined
                const baseline = record?.base && activeBaseline(record.base, obsidian)
                const metadataChanged = generated && (Object.values(generated).some(field => field.before !== field.after) ||
                    Object.entries(suffixes ?? {}).some(([name, suffix]) => record?.sourceSuffixes?.[name] !== suffix))
                let datePatch: MarkdownPatch | undefined
                if (idDate) {
                    const start = block ? block.idStart : content.lastIndexOf('\n', bullet.end - 1) + 1
                    const next = content.indexOf('\n', start)
                    const line = content.slice(start, next < 0 ? undefined : next).replace(/\r$/u, '')
                    datePatch = block?.idLocation === 'yaml' ? pageIdDatePatch(content, id, idDate) :
                        idDatePatch(line, id, idDate, start)
                }
                if (!datePatch && !metadataChanged && !extra?.releaseOneWayField && namedFieldModel === record?.namedFieldModel && (!signature || signature === record?.deletionSource) && baseline && !record?.pending && sameStoredValue(baseline, obsidian) && sameStoredValue(baseline, anki)) {
                    if (extraIssues || pauseChange) rows.push({ ...row, issues: extraIssues })
                    continue
                }
                const link: Link = { source, bullet, ...local, datePatch, generated, obsidian, anki, deletionSource: signature,
                    pageContextField: block?.format === 'page' && data.add_context ? data.context_fields?.[snapshot.modelName] : undefined,
                    record, namedFieldModel, fieldBases: extra?.fieldBases, releaseOneWayField: extra?.releaseOneWayField, model: snapshot.modelName, ankiBacklinks: remote.backlinks, extraDirections: extra?.directions,
                    outboundBlocked: extra?.outboundBlocked, cardIds: block || generated || extra?.directions?.size ? snapshot.cards : undefined }
                const fieldChanges = previewChanges(link)
                if (datePatch) fieldChanges.push({ key: id + ':id-date', field: t('ID date in Markdown', 'Дата ID в Markdown'),
                    decision: 'merge', obsidian: content.slice(datePatch.start, datePatch.end), anki: '', merged: datePatch.text })
                if (block && needsReparse(block)) {
                    let problem: string | undefined
                    for (const change of fieldChanges) {
                        if (change.decision !== 'anki' && change.decision !== 'conflict') continue
                        const slot = change.key.slice(String(id).length + 1)
                        const name = slot === 'front' ? 'Front' : slot === 'back' ? 'Back' :
                            slot.startsWith('extra:') ? slot.slice(6) : undefined
                        if (!name) continue
                        try {
                            const [patch] = planExplicitBlockPatches(content, block, { [name]: change.anki })
                            const end = block.answerBoundary ?? block.end
                            change.markdown = () => ({
                                before: content.slice(block.start, end),
                                after: content.slice(block.start, patch.start) + patch.text + content.slice(patch.end, end),
                            })
                        } catch (error) {
                            problem = error instanceof Error ? error.message : String(error)
                            break
                        }
                    }
                    if (problem) { rows.push({ ...row, issues: [...(extraIssues ?? []), problem] }); continue }
                }
                links.push(link)
                const changes = [...row.changes, ...fieldChanges]
                if (changes.length || extraIssues) rows.push({ ...row, changes, issues: link.record?.pending
                    ? ['A previous sync of this card is pending verification.', ...(extraIssues ?? [])] : extraIssues })
            }
            // В пределах заданного объёма памяти оставляем только полностью проверенные файлы из последнего предпросмотра.
            if (!target && !source.parserText && sourceModels?.every((model): model is SourceModel => model !== undefined) && localCards.size === cards.length &&
                nextFiles.size < maxCachedSources && cachedChars + content.length <= maxCachedSourceChars) {
                nextFiles.set(path, { file, content, entries: cards, markers: source.markers, stamp, models: sourceModels, cards: localCards })
                cachedChars += content.length
            }
        } catch (error) {
            issues.push(`${path}: ${String(error)}`)
            deletions.delete(source)
            rows.length = firstRow
            links.length = firstLink
            pauses.length = firstPause
        }
    }
    if (deletions.size) {
        const label = t('Deleted from Anki', 'Удалено из Anki')
        for (const [source, group] of deletions) {
            if ((deletionMode === 'keep' || deletionMode === 'remove') && !source.content.includes('RUDONIUM-ARCHIVE')) continue
            try {
                cleanConfirmedDeletes(source.content, group.commands, new Set(group.evidence.keys()),
                    deletionMode, trashPages, group.removals, label)
            } catch (error) {
                deletions.delete(source)
                const message = uiDiagnostic(error, t)
                issues.push(source.path + ': ' + message)
                for (const row of rows) {
                    if (row.path === source.path && group.evidence.has(row.id)) {
                        row.changes = []
                        row.issues = [...(row.issues ?? []), message]
                    }
                }
            }
        }
    }
    await requireExpectedAnkiProfile(plugin, profile)
    if (currentRevision() !== startRevision || configuration(plugin) !== config) {
        throw new Error('Files or settings changed during the preview. Run it again.')
    }
    if (!target && cacheKey !== undefined && index.complete) {
        // Scanning the current note must not evict unrelated notes. Their stamps and Anki models
        // are rechecked on use. Freshly verified entries have priority within both size limits.
        if (cachedFiles && selected !== folderScope.paths) {
            for (const [path, entry] of cachedFiles) {
                if (nextFiles.size >= maxCachedSources || cachedChars >= maxCachedSourceChars) break
                if (selected.has(path) || !folderScope.paths.has(path) || entry.file.path !== path ||
                    cachedChars + entry.content.length > maxCachedSourceChars) continue
                nextFiles.set(path, entry)
                cachedChars += entry.content.length
            }
        }
        warmSources.set(plugin, { key: cacheKey, files: nextFiles })
    } else if (!target) warmSources.delete(plugin)
    if (!index.complete) issues.push('The vault check was incomplete. Resolve the file errors before applying a plan.')
    const scopeLabel = target ? t(`Card at cursor · ID ${target.id}`, `Карточка под курсором · ID ${target.id}`) :
        current ? current.path : folderScope.profileId ? folderScope.label : t('Entire vault', 'Всё хранилище')
    return { profile, scopeLabel, statePath, newCardSource, configuration: config, revision: startRevision,
        links, pauses, deletions, readers, directivePatterns, expressions: data.custom_regexps, modelFields: data.fields_dict, pageModel: data.page_model, rows, issues, scanned: noteIds.length, complete: index.complete, cursor: target }
}

interface Operation { link: Link; target: SyncValue; patches: MarkdownPatch[]; requests: AnkiConnect.AnkiConnectRequest[] }

function needsReparse(card: SourceCard): boolean {
    const block = explicitBlock(card)
    return !!block && (!!block.layout || block.format === 'page' || block.namedFieldInsertAt !== undefined)
}

/** Re-run the production parser over the proposed edit. Other rules in the file may also match the new text. */
async function verifyCustomEdit(source: SourceFile, operations: readonly Operation[]): Promise<void> {
    if (!source.readAfterCustomEdit || !operations.some(op => op.patches.length && needsReparse(op.link.bullet))) return
    const changed = operations.filter(op => op.patches.length)
    const after = applyMarkdownPatches(source.content, changed.flatMap(op => op.patches))
    const beforeScan = await source.readAfterCustomEdit(source.content)
    const afterScan = await source.readAfterCustomEdit(after)
    const fail = (): never => { throw new Error(source.path +
        ': The proposed Markdown changes the card structure or destination. Review it manually. / После правки меняются поля, границы или колода карточки. Проверьте текст вручную.') }
    const original = beforeScan.notes_to_edit
    if (JSON.stringify(beforeScan.all_notes_to_add) !== JSON.stringify(afterScan.all_notes_to_add) ||
        beforeScan.global_tags !== afterScan.global_tags || original.length !== afterScan.notes_to_edit.length) fail()
    const wanted = new Map(changed.map(op => [op.link.bullet.id, op]))
    const seen = new Set<number>()
    for (let i = 0; i < original.length; i++) {
        const { identifier, note } = original[i]
        const next = afterScan.notes_to_edit[i]
        if (next.identifier !== identifier || note.modelName !== next.note.modelName || note.deckName !== next.note.deckName) fail()
        const op = wanted.get(identifier)
        if (!op) {
            if (JSON.stringify(note.fields) !== JSON.stringify(next.note.fields) || JSON.stringify(note.tags) !== JSON.stringify(next.note.tags)) fail()
            continue
        }
        if (seen.has(identifier)) fail()
        seen.add(identifier)
        const block = explicitBlock(op.link.bullet)
        const names = block?.fieldPair ?? ['Front', 'Back']
        const changes = new Map<string, string>()
        if (!fieldEqual(op.link.obsidian, op.target, 'front')) changes.set(names[0], op.target.front)
        if (!fieldEqual(op.link.obsidian, op.target, 'back')) changes.set(names[1], op.target.back)
        for (const [name, value] of Object.entries(op.target.extra ?? {})) {
            if (op.link.obsidian.extra?.[name] !== value) changes.set(name, value)
        }
        for (const name of changes.keys()) if (!Object.prototype.hasOwnProperty.call(next.note.fields, name)) fail()
        for (const name of new Set([...Object.keys(note.fields), ...Object.keys(next.note.fields)])) {
            const beforeValue = note.fields[name]
            if (beforeValue === undefined && !changes.has(name)) fail()
            const newValue = next.note.fields[name]
            if (typeof newValue !== 'string') fail()
            const value = changes.get(name)
            const suffix = op.link.sourceSuffixes?.[name]
            if (suffix && !newValue.endsWith(suffix)) fail()
            const body = suffix ? newValue.slice(0, -suffix.length) : newValue
            if (value === undefined) {
                if (body !== (op.link.sourceBodies?.[name] ?? beforeValue)) fail()
            } else {
                if (decodeField(body, block, readGeneratedAnkiBacklink(body, identifier), !names.includes(name) || name === names[1] && hasLinkedAnswerSlot(block?.format))?.normalize('NFC') !== value.normalize('NFC')) fail()
            }
        }
        if (fieldEqual(op.link.obsidian, op.target, 'tags') && JSON.stringify(note.tags) !== JSON.stringify(next.note.tags)) fail()
    }
    if (seen.size !== wanted.size) fail()
}

async function selectedBrowseIds(ids: ReadonlySet<number>): Promise<Set<number>> {
    if (!ids.size) return new Set()
    try {
        const selected = await auditRead('guiSelectedNotes', {}, undefined, 10_000)
        if (!isResponseList(selected) || !selected.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
            throw new Error('Anki returned an invalid browser selection. Retry syncing. / Anki вернула некорректное выделение в обзоре. Повторите синхронизацию.')
        }
        return new Set(selected.filter(id => ids.has(id)))
    } catch (error) {
        if (!/unsupported action|unknown action|unexpected action|not supported/i.test(String(error))) throw error
    }
    return new Set()
}

async function checkBrowse(ids: ReadonlySet<number>, front?: string): Promise<void> {
    const selected = await selectedBrowseIds(ids)
    const first = selected.values().next()
    if (!first.done) throw new Error(ankiBrowseMessage(first.value, front))
}

/** Истечение времени ожидания освобождает интерфейс. Незавершённый запрос продолжает блокировать новые записи. */
async function writeToAnki(app: App, request: AnkiConnect.AnkiConnectRequest): Promise<void> {
    if (hasPendingBidirectionalWrite(app)) throw new Error(pendingBidirectionalWriteMessage)
    if (hasPendingAnkiWrite(app)) throw new Error(pendingAnkiWriteMessage)
    const transport = Promise.resolve().then(() => AnkiConnect.invoke(request.action, request.params))
    pendingAnkiWrites.set(app, transport)
    const release = () => {
        if (pendingAnkiWrites.get(app) === transport) pendingAnkiWrites.delete(app)
    }
    void transport.then(release, release)
    const result = await withAnkiDeadline(() => transport, 'AnkiConnect', writeTimeoutMs)
    if (request.action === 'multi') {
        const actions = request.params.actions
        if (!isResponseList(result) || result.length !== actions.length) throw new Error('Anki did not confirm every update in the batch.')
        for (let i = 0; i < result.length; i++) {
            const reply = result[i]
            if (!isRecord(reply) || reply.error !== null || reply.result !== null) {
                const action = actions[i]
                const target = action.action === 'updateNoteFields' ? `Anki ID ${action.params.note.id}` : action.action
                const reason = isRecord(reply) && typeof reply.error === 'string' ? reply.error : 'unconfirmed field update'
                throw new Error(`${target}: ${reason}`)
            }
        }
    }
}

// Пакет содержит независимые обновления полей. Теги, интервалы, удаление и изменения шаблонов идут своим обычным путём.
function canBatchFields(group: readonly Operation[]): boolean {
    return group.length >= 8 && group.every(item => !item.patches.length && !item.link.pageShared && !item.link.extraDirections?.size &&
        item.requests.length === 1 && item.requests[0].action === 'updateNoteFields')
}

async function writeFieldPackets(plugin: MyPlugin, plan: Plan, group: readonly Operation[], beforeWrite: () => void,
    afterVerify: (packet: readonly Operation[]) => void, defer: (item: Operation) => void): Promise<void> {
    let offset = 0
    while (offset < group.length) {
        const packet: Operation[] = []
        let bytes = 0
        while (offset < group.length && packet.length < 64) {
            const item = group[offset]
            const bound = JSON.stringify(item.requests[0]).length * 3
            if (packet.length && bytes + bound > 1024 * 1024) break
            packet.push(item)
            bytes += bound
            offset++
        }
        const ids = packet.map(item => item.link.bullet.id)
        const live = await readNotes(ids, plan.profile)
        for (const {link} of packet) if (!matchesPreview(live.get(link.bullet.id), link)) throw stalePlan()
        const selected = await selectedBrowseIds(new Set(ids))
        const ready = selected.size ? packet.filter(item => {
            if (!selected.has(item.link.bullet.id)) return true
            defer(item)
            return false
        }) : packet
        if (!ready.length) continue
        const sources = new Set(ready.map(item => item.link.source))
        for (const source of sources) if (await plugin.app.vault.read(source.file) !== source.content) throw stalePlan()
        await requireExpectedAnkiProfile(plugin, plan.profile)
        const dirty = dirtyFiles(plugin)
        for (const source of sources) if (source.file.path !== source.path || dirty.has(source.path)) throw stalePlan()
        if (configuration(plugin) !== plan.configuration) throw stalePlan()
        beforeWrite()
        await writeToAnki(plugin.app, {action: 'multi', version: 6,
            params: {actions: ready.map(item => item.requests[0])}})
        await verifyAnkiTargets(plugin, ready, plan.profile)
        afterVerify(ready)
    }
}

function expectedAfterRequest(value: SyncValue, target: SyncValue, action: string): SyncValue {
    if (action === 'updateNoteFields') return { ...value, front: target.front, back: target.back, extra: target.extra }
    if (action === 'addTags') return { ...value, tags: normalizeSyncTags([...value.tags, ...target.tags]) }
    return { ...value, tags: target.tags }
}

async function verifyAnkiTargets(plugin: MyPlugin, group: readonly Operation[], profile: string,
    observed?: ReadonlyMap<number, NoteSnapshot>): Promise<ReadonlyMap<number, NoteSnapshot>> {
    const saved = observed ?? await readNotes(group.map(item => item.link.bullet.id), profile)
    await requireExpectedAnkiProfile(plugin, profile)
    for (const { link, target, requests } of group) {
        const id = link.bullet.id
        const note = saved.get(id)
        const clean = note && sourceFieldsSnapshot(note, link.bullet, link.generated, true)
        const remote = clean && decodeAnkiNote(clean, link.bullet, link.extraDirections)
        if (!note || !remote?.value || note.modelName !== link.model || !syncValuesEqual(remote.value, target) ||
            link.cardIds && !sameCardIds(note.cards, link.cardIds)) {
            if (requests.some(request => request.action === 'updateNoteFields')) await checkBrowse(new Set([id]), link.obsidian.front)
            throw new Error(`Could not verify saved values for Anki ID ${id}.`)
        }
        // Сравнение полей не учитывает сформированные обратные ссылки. Проверяем их до снятия признака незавершённой записи.
        if (!sameBacklinks(remote.backlinks, link.ankiBacklinks)) {
            throw new Error(`Could not verify the generated Obsidian link for Anki ID ${id}.`)
        }
    }
    return saved
}

/** При смене режима принадлежность поля остаётся у того же ID и профиля. */
function confirmedNamedReceipt(item: Operation, note: NoteSnapshot | undefined): OneWayReceipt | undefined {
    const { link, target } = item
    if (!note || !link.pageShared && (!link.namedFieldModel || !link.extraDirections?.size)) return
    const eligible = link.namedFieldModel ? Array.from(link.extraDirections?.keys() ?? []) : []
    const shared = link.pageShared && Object.keys(link.pageShared)
    if (!eligible.length && !shared?.length) return
    const present: string[] = []
    const values = Object.create(null) as Record<string, string>
    for (const name of eligible) {
        const value = rawField(note, name)
        if (value === undefined) continue
        const labeled = Object.prototype.hasOwnProperty.call(link.bullet.extra ?? {}, name) || !!target.extra?.[name]
        if (labeled) present.push(name)
        values[name] = labeled ? value : ''
    }
    for (const name of shared ?? []) {
        const value = rawField(note, name)
        if (value !== undefined) values[name] = value
    }
    return { id: link.bullet.id, modelName: note.modelName, fields: values, namedLayout: { eligible, present, shared } }
}

function needsUpdate(link: Link, target: SyncValue): boolean {
    return !!link.releaseOneWayField || link.namedFieldModel !== link.record?.namedFieldModel || !!link.datePatch || !!link.generated && Object.entries(link.generated).some(([name, field]) =>
        field.before !== field.after || !Object.prototype.hasOwnProperty.call(link.pageShared ?? {}, name) && link.record?.sourceSuffixes?.[name] !== field.after) || !!link.deletionSource && link.deletionSource !== link.record?.deletionSource || !!link.record?.pending || !link.record?.base || !syncValuesEqual(activeBaseline(link.record.base, target), target) ||
        !syncValuesEqual(link.obsidian, target) || !syncValuesEqual(link.anki, target)
}

function operationsFor(plan: Plan, choices: ReadonlyMap<string, BidirectionalSide>): Operation[] {
    return plan.links.flatMap((link): Operation[] => {
        const id = link.bullet.id
        const block = explicitBlock(link.bullet)
        const selected: SyncChoices = {}
        for (const field of fields) {
            const choice = choices.get(`${id}:${field}`)
            if (choice) selected[field] = choice
        }
        for (const field of link.extraDirections?.keys() ?? []) {
            const key = `extra:${field}` as const
            const choice = choices.get(`${id}:${key}`)
            if (choice) selected[key] = choice
        }
        const { value: target, conflicts } = targetFor(link, selected)
        if (conflicts.length || !needsUpdate(link, target)) return []
        link = resolvedPageContext(link, target.front)
        const localFields: Partial<Record<'Front' | 'Back', string>> = {}
        const remoteFields: Record<string, string> = {}
        for (const field of ['front', 'back'] as const) {
            if (!fieldEqual(link.obsidian, target, field)) localFields[labels[field]] = target[field]
            const remoteName = block?.fieldPair?.[field === 'front' ? 0 : 1] ?? labels[field]
            if (!fieldEqual(link.anki, target, field)) remoteFields[remoteName] =
                (block ? writeEditableAnkiBlockField(target[field], block, field === 'back' && hasLinkedAnswerSlot(block.format)) : writeEditableAnkiField(target[field])) +
                (link.ankiBacklinks[field === 'front' ? 0 : 1] ?? '')
        }
        for (const [name, update] of Object.entries(link.generated ?? {})) {
            if (update.before !== update.after && cardFieldHazards(name, update.body + update.before, update.body + update.after).length) throw stalePlan()
            if (Object.prototype.hasOwnProperty.call(remoteFields, name)) remoteFields[name] += update.after
            else if (update.before !== update.after) remoteFields[name] = update.body + update.after
        }
        const localExtras = Object.create(null) as Record<string, string>
        for (const field of link.extraDirections?.keys() ?? []) {
            const value = target.extra![field]
            if (link.obsidian.extra![field].normalize('NFC') !== value.normalize('NFC')) localExtras[field] = value
            const before = link.anki.extra![field]
            if (before.normalize('NFC') !== value.normalize('NFC')) {
                if (link.outboundBlocked?.has(field) || cardFieldHazards(field, before, value).length) throw stalePlan()
                remoteFields[field] = block ? writeEditableAnkiBlockField(value, block, true) : writeEditableAnkiField(value, true)
            }
        }
        const tags = fieldEqual(link.obsidian, target, 'tags') ? undefined
            : { inherited: link.inheritedTags, effective: target.tags }
        const patches = 'explicitFields' in link.bullet
            ? planExplicitBlockPatches(link.source.content, link.bullet, { ...localFields, ...localExtras }, tags)
            : planLinkedBulletPatches(link.source.content, link.bullet, localFields, tags, localExtras)
        if (link.datePatch) patches.push(link.datePatch)
        const requests: AnkiConnect.AnkiConnectRequest[] = []
        if (Object.keys(remoteFields).length) requests.push(AnkiConnect.updateNoteFields(id, remoteFields))
        const prior = new Set(link.anki.tags.map(tag => tag.toLowerCase()))
        const next = new Set(target.tags.map(tag => tag.toLowerCase()))
        const added = target.tags.filter(tag => !prior.has(tag.toLowerCase()))
        const removed = link.anki.tags.filter(tag => !next.has(tag.toLowerCase()))
        if (added.length) requests.push(AnkiConnect.addTags([id], added.join(' ')))
        if (removed.length) requests.push(AnkiConnect.removeTags([id], removed.join(' ')))
        return [{ link, target, patches, requests }]
    })
}

function stalePlan(): Error { return new Error('A file, Anki record, or the sync state changed. Preview the sync again.') }

interface PauseApplyContext {
    outputs: Map<SourceFile, string>
    backupChecked: boolean
    guard: () => void
    onWrite(path?: string): void
}

async function applyPauseUpdates(plugin: MyPlugin, plan: Plan, state: BidirectionalState,
    pauses: readonly PauseUpdate[], context: PauseApplyContext): Promise<void> {
    const { vault } = plugin.app
    const { guard } = context
    const sources = new Map<SourceFile, PauseUpdate[]>()
    const expected = new Map<number, SuspendCard[]>()
    const targets = new Map<number, ReadonlySet<number>>()
    for (const update of pauses) {
        const { id, source, slots, merge } = update
        if (plan.cursor && (source.path !== plan.cursor.path || id !== plan.cursor.id)) throw stalePlan()
        if (JSON.stringify(state.get(id)?.suspension) !== JSON.stringify(update.record?.suspension)) throw stalePlan()
        const group = sources.get(source)
        if (group) group.push(update)
        else sources.set(source, [update])
        expected.set(id, slots)
        targets.set(id, merge.target)
    }
    const clean = (source: SourceFile, dirty: Set<string>) => {
        if (source.file.path !== source.path || dirty.has(source.path)) throw stalePlan()
    }
    const assertSources = async (checked: Iterable<SourceFile> = sources.keys()) => {
        guard()
        const dirty = dirtyFiles(plugin)
        for (const source of checked) {
            clean(source, dirty)
            if (await vault.read(source.file) !== (context.outputs.get(source) ?? source.content)) throw stalePlan()
        }
        guard()
    }
    await assertSources()
    if (!context.backupChecked && pauses.some(p => p.merge.localChange || p.merge.remoteChange)) {
        await ensureScheduledBackup(plugin, plan.profile)
    }
    const owners = new Map(pauses.map(update => [update.id, update.source]))
    await applySuspendCards(plugin, plan.profile, expected, targets,
        noteIds => assertSources(new Set(noteIds.map(id => owners.get(id)!))),
        answered => { if (!answered) context.onWrite() })
    const changedHashes = new Map<number, string | undefined>()
    let nextProfileCheck = 0
    let filesSinceCheck = 0
    for (const [source, group] of sources) {
        const localChanges = new Map(group.filter(p => p.merge.localChange).map(p => [p.id, p.merge.nextMarker] as const))
        if (!localChanges.size) continue
        guard()
        clean(source, dirtyFiles(plugin))
        const before = context.outputs.get(source) ?? source.content
        const output = rewriteSuspendMarkers(before, localChanges, plugin.settings.Syntax)
        // Все локальные правки относятся к одному проверенному снимку. Проверяем профиль между пакетами.
        if (Date.now() >= nextProfileCheck || filesSinceCheck >= readBatchSize) {
            await requireExpectedAnkiProfile(plugin, plan.profile)
            nextProfileCheck = Date.now() + 1_000
            filesSinceCheck = 0
        }
        filesSinceCheck++
        context.onWrite(source.path)
        await vault.process(source.file, text => {
            guard()
            clean(source, dirtyFiles(plugin))
            if (text !== before) throw stalePlan()
            return output
        })
        guard()
        if (await vault.read(source.file) !== output) throw stalePlan()
        context.outputs.set(source, output)
        const ids = new Set(localChanges.keys())
        const oldHashes = savedSignatures(source, before, ids, plan, plugin.settings.Syntax)
        const nextHashes = savedSignatures(source, output, ids, plan, plugin.settings.Syntax)
        for (const id of ids) {
            const record = state.get(id)
            // Обновление только расписания не подтверждает попутную несверенную правку текста.
            changedHashes.set(id, record?.base && !record.pending && record.deletionSource &&
                record.deletionSource === oldHashes.get(id) ? nextHashes.get(id) : undefined)
        }
    }
    if (pauses.some(p => p.merge.localChange)) await verifySuspendCards(plan.profile, expected, targets)
    await assertSources()
    await requireExpectedAnkiProfile(plugin, plan.profile)
    const updates = pauses.map(p => {
        const record = { ...state.get(p.id), suspension: p.merge.next }
        if (changedHashes.has(p.id)) record.deletionSource = changedHashes.get(p.id)
        return [p.id, Object.values(record).some(value => value !== undefined) ? record : undefined] as const
    })
    await state.checkpoint(updates)
}

async function applyPlan(plugin: MyPlugin, plan: Plan, choices: ReadonlyMap<string, BidirectionalSide>,
    onPartial?: () => void, mode: 'preview' | 'background' = 'preview'): Promise<string> {
    const t = uiFor(plugin.settings)
    return withFastScanReadLock(plugin, async (currentRevision, pathRevision) => {
        await requireSettledZipImport(plugin)
        if (hasPendingBidirectionalWrite(plugin.app)) throw new Error(pendingBidirectionalWriteMessage)
        if (hasPendingAnkiWrite(plugin.app)) throw new Error(pendingAnkiWriteMessage)
        if (!plan.complete || plugin.settings.BIDIRECTIONAL_SYNC !== true) throw stalePlan()
        if (plan.cursor) {
            if (cursorConfiguration(plugin) !== plan.cursor.configuration || plan.links.some(link =>
                link.source.path !== plan.cursor!.path || link.bullet.id !== plan.cursor!.id)) throw stalePlan()
            checkCursorEditors(plugin, plan.cursor)
        }
        await requireExpectedAnkiProfile(plugin, plan.profile)
        if (configuration(plugin) !== plan.configuration || currentRevision() !== plan.revision) throw stalePlan()
        const { vault } = plugin.app
        const planned = operationsFor(plan, choices)
        const errors: string[] = []
        const defer = (item: Operation) => {
            errors.push(uiDiagnostic(ankiBrowseMessage(item.link.bullet.id, item.link.obsidian.front), t))
        }
        const selected = await selectedBrowseIds(new Set(planned.filter(item =>
            item.patches.length || item.requests.some(request => request.action === 'updateNoteFields')).map(item => item.link.bullet.id)))
        const operations = selected.size ? planned.filter(item => {
            if (!selected.has(item.link.bullet.id)) return true
            defer(item)
            return false
        }) : planned
        const chosenPauses = plan.pauses.filter(p => !p.requiresAnkiChoice || choices.get(p.id + ':suspension') === 'anki')
        if (!operations.length && !chosenPauses.length && !plan.deletions.size) {
            if (errors.length) onPartial?.()
            return errors[0] ?? t('There are no changes with a confirmed choice.', 'Нет изменений с подтверждённым вариантом.')
        }
        const state = await BidirectionalState.open(vault.adapter, plan.statePath, plan.profile)
        const snapshot = await readNotes(operations.map(item => item.link.bullet.id), plan.profile)
        await requireExpectedAnkiProfile(plugin, plan.profile)
        const bySource = new Map<SourceFile, Operation[]>()
        const dirty = dirtyFiles(plugin)
        const pending: [number, SyncRecord][] = []
        for (const item of operations) {
            const { link, target } = item
            const id = link.bullet.id
            if (!matchesPreview(snapshot.get(id), link) ||
                JSON.stringify(state.get(id)) !== JSON.stringify(link.record) || dirty.has(link.source.file.path)) throw stalePlan()
            const group = bySource.get(link.source) ?? []
            if (group.length === 0) bySource.set(link.source, group)
            group.push(item)
            if (item.patches.length || item.requests.length) pending.push([id, {
                ...link.record, pending: { obsidian: link.obsidian, anki: link.anki, target, ankiBacklinks: link.ankiBacklinks,
                    sourceSuffixes: link.generated && sourceSuffixMap(link.generated, 'before'),
                    targetSourceSuffixes: link.pageContextField && !fieldEqual(link.obsidian, target, 'front') ? link.sourceSuffixes : undefined,
                    extraDirections: link.extraDirections && Object.fromEntries(link.extraDirections) },
            }])
        }
        if (currentRevision() !== plan.revision || configuration(plugin) !== plan.configuration) throw stalePlan()

        const ankiWrites = new Set(operations.filter(item => item.requests.length).map(item => item.link.bullet.id))
        for (const [source, items] of bySource) {
            if (source.readAfterCustomEdit) await verifyCustomEdit(source, items)
        }
        if (pending.length) {
            if (ankiWrites.size) await requireExpectedAnkiProfile(plugin, plan.profile)
            await ensureScheduledBackup(plugin, plan.profile)
            await requireExpectedAnkiProfile(plugin, plan.profile)
            if (currentRevision() !== plan.revision || configuration(plugin) !== plan.configuration) throw stalePlan()
            await state.checkpoint(pending)
        }
        const fieldOutputs = new Map<SourceFile, string>()
        const failedSources = new Set<SourceFile>()
        const confirmed: [number, SyncRecord][] = []
        const namedReceipts: OneWayReceipt[] = []
        let profileProblem: AnkiProfileError | undefined
        let dispatchedWrite = false
        let revision = plan.revision
        let ownWritePath: string | undefined
        const checkRevision = () => {
            if (plan.cursor) checkCursorEditors(plugin, plan.cursor)
            const current = currentRevision()
            if (current === revision) return
            // Хранилище может сообщить о нашей правке до или после завершения запроса записи.
            if (!ownWritePath || current !== revision + 1 || pathRevision(ownWritePath) !== current) throw stalePlan()
            revision = current
            ownWritePath = undefined
        }
        const confirm = (item: Operation, sourceHash: string | undefined, note?: NoteSnapshot) => {
            const receipt = confirmedNamedReceipt(item, note)
            if (receipt) namedReceipts.push(receipt)
            const prior = item.link.namedFieldModel === item.link.record?.namedFieldModel ? item.link.record?.base?.extra : undefined
            const base = prior ? { ...item.target, extra: { ...prior, ...item.target.extra } } : item.target
            // После перевода редактируемого поля в FROZEN его прежняя строка больше не владеет значением.
            if (prior && item.link.pageShared) for (const name of Object.keys(item.link.pageShared)) delete base.extra![name]
            confirmed.push([item.link.bullet.id, { ...item.link.record, pending: undefined, base, namedFieldModel: item.link.namedFieldModel,
                sourceSuffixes: item.link.sourceSuffixes, deletionSource: sourceHash }])
        }
        if (!chosenPauses.length && !plan.deletions.size && canBatchFields(operations)) {
            try {
                await writeFieldPackets(plugin, plan, operations, () => { checkRevision(); dispatchedWrite = true }, packet => {
                    checkRevision()
                    for (const item of packet) confirm(item, item.link.deletionSource)
                }, defer)
            } catch (error) {
                errors.push(uiDiagnostic(error, t))
                if (error instanceof AnkiProfileError) profileProblem = error
            }
            // Сбой оставляет неподтверждённые ID в журнале до следующего предпросмотра.
            bySource.clear()
        }
        for (const [source, group] of bySource) {
            try {
                checkRevision()
                if (source.file.path !== source.path || dirtyFiles(plugin).has(source.path) ||
                    await vault.read(source.file) !== source.content) throw stalePlan()
                const requests = group.flatMap(item => item.requests)
                const patches = group.flatMap(item => item.patches)
                let verified: ReadonlyMap<number, NoteSnapshot> = snapshot
                if (requests.length || patches.length) {
                    await requireExpectedAnkiProfile(plugin, plan.profile)
                    if (configuration(plugin) !== plan.configuration) throw stalePlan()
                    const wanted = group.map(item => item.link.bullet.id)
                    const current = await readNotes(wanted, plan.profile)
                    for (const { link } of group) {
                        if (!matchesPreview(current.get(link.bullet.id), link)) throw stalePlan()
                    }
                    for (const item of group) {
                        if (!item.requests.length) continue
                        const { link, target } = item
                        const id = link.bullet.id
                        let expected = link.anki
                        let fieldsWritten = false
                        for (const request of item.requests) {
                            // Пока шла запись, могли измениться другая карточка этого файла или теги этой карточки.
                            const live = await readNotes([id], plan.profile)
                            if (!matchesPreview(live.get(id), link, expected, fieldsWritten)) throw stalePlan()
                            if (request.action === 'updateNoteFields') await checkBrowse(new Set([id]), link.obsidian.front)
                            if (await vault.read(source.file) !== source.content) throw stalePlan()
                            if (request.action === 'updateNoteFields' && (link.extraDirections?.size || link.pageShared)) {
                                const changedPresence = Array.from(link.extraDirections?.keys() ?? []).filter(field =>
                                    Object.prototype.hasOwnProperty.call(request.params.note.fields, field) &&
                                    (expected.extra![field] === '') !== (target.extra![field] === ''))
                                for (const field of Object.keys(link.pageShared ?? {})) {
                                    const update = link.generated?.[field]
                                    if (update && Object.prototype.hasOwnProperty.call(request.params.note.fields, field) &&
                                        (update.before === '') !== (update.after === '')) changedPresence.push(field)
                                }
                                if (changedPresence.length) {
                                    const references = await readModelTemplateFields(link.model)
                                    if (!references || changedPresence.some(field => references.has(field.toLowerCase()))) throw stalePlan()
                                }
                            }
                            await requireExpectedAnkiProfile(plugin, plan.profile)
                            checkRevision()
                            if (source.file.path !== source.path || dirtyFiles(plugin).has(source.path) ||
                                configuration(plugin) !== plan.configuration) throw stalePlan()
                            dispatchedWrite = true
                            await writeToAnki(plugin.app, request)
                            expected = expectedAfterRequest(expected, target, request.action)
                            if (request.action === 'updateNoteFields') fieldsWritten = true
                        }
                    }
                    const output = patches.length ? applyMarkdownPatches(source.content, patches) : undefined
                    // A pure Markdown import has done only synchronous checks since the
                    // per-file notesInfo above. Reuse it here, then read Anki again after Vault.process.
                    verified = await verifyAnkiTargets(plugin, group, plan.profile, requests.length ? undefined : current)
                    checkRevision()
                    if (output !== undefined) {
                        ownWritePath = source.path
                        dispatchedWrite = true
                        await vault.process(source.file, text => {
                            checkRevision()
                            if (configuration(plugin) !== plan.configuration || text !== source.content ||
                                source.file.path !== source.path || dirtyFiles(plugin).has(source.path)) throw stalePlan()
                            return output
                        })
                        checkRevision()
                        if (await vault.read(source.file) !== output) throw stalePlan()
                        fieldOutputs.set(source, output)
                        verified = await verifyAnkiTargets(plugin, group, plan.profile)
                    }
                } else {
                    const resuming = group.filter(({ link }) => link.record?.pending?.ankiBacklinks !== undefined)
                    if (resuming.length) {
                        // Пользователь может снова изменить восстановленную ссылку во время проверки сохранённого Markdown.
                        verified = await verifyAnkiTargets(plugin, resuming, plan.profile)
                        checkRevision()
                    }
                }
                const savedText = fieldOutputs.get(source)
                const hashes = savedText === undefined ? undefined : savedSignatures(source, savedText,
                    new Set(group.filter(item => item.link.deletionSource).map(item => item.link.bullet.id)), plan, plugin.settings.Syntax)
                for (const item of group) {
                    const id = item.link.bullet.id
                    confirm(item, hashes ? hashes.get(id) : item.link.deletionSource, verified.get(id) ?? snapshot.get(id))
                }
            } catch (error) {
                failedSources.add(source)
                errors.push(`${source.path}: ${uiDiagnostic(error, t)}`)
                if (error instanceof AnkiProfileError) {
                    profileProblem = error
                    break
                }
                if (error instanceof DOMException && error.name === 'TimeoutError') break
            }
        }
        // Храним подтверждение уже проверенных пакетов в контрольной точке исходного профиля даже после переключения.
        if (namedReceipts.length) {
            const history = await openOneWayHistory(plugin, plan.profile)
            history.apply(namedReceipts)
            await history.flush()
        }
        if (confirmed.length) await state.checkpoint(confirmed)
        let pausedCount = 0
        if (!profileProblem && !hasPendingAnkiWrite(plugin.app) && !hasPendingBidirectionalWrite(plugin.app)) {
            const pauses = chosenPauses.filter(p => !failedSources.has(p.source))
            if (pauses.length) {
                try {
                    const guard = () => {
                        checkRevision()
                        if (configuration(plugin) !== plan.configuration) throw stalePlan()
                    }
                    await applyPauseUpdates(plugin, plan, state, pauses, {
                        outputs: fieldOutputs,
                        backupChecked: pending.length > 0,
                        guard,
                        onWrite(path) {
                            if (path !== undefined) ownWritePath = path
                            dispatchedWrite = true
                        },
                    })
                    pausedCount = pauses.length
                } catch (error) {
                    errors.push(uiDiagnostic(error, t))
                    if (error instanceof AnkiProfileError) profileProblem = error
                }
            }
        }
        const pauseSummary = pausedCount ? t(`Review status confirmed for ${pausedCount} notes.`, `Статус повторений подтверждён для записей: ${pausedCount}.`) : ''
        let removed = 0
        if (plan.deletions.size && !profileProblem) {
            try {
                const deletionIds = new Set([...plan.deletions.values()].flatMap(group => [...group.evidence.keys()]))
                const deletionPaths = new Set([...plan.deletions.keys()].map(source => source.path))
                const dirtyCopies = new Map<string, { text: string; base: string; touches: boolean }>()
                const unsafeEditor = () => plugin.app.workspace.getLeavesOfType('markdown').some(({ view }) => {
                    if (!(view instanceof MarkdownView) || !view.file || view.getMode() !== 'source') return false
                    const text = view.getViewData(), base = view.data
                    if (sameEditorText(text, base)) return false
                    if (deletionPaths.has(view.file.path)) return true
                    const prior = dirtyCopies.get(view.file.path)
                    if (prior && prior.text === text && prior.base === base) return prior.touches
                    const touches = [text, base].some(value => findIdMarkers(value, plugin.settings.Syntax)
                        .some(marker => deletionIds.has(marker.id)))
                    dirtyCopies.set(view.file.path, { text, base, touches })
                    return touches
                })
                const guard = () => {
                    checkRevision()
                    if (unsafeEditor() || configuration(plugin) !== plan.configuration) throw stalePlan()
                }
                guard()
                await requireExpectedAnkiProfile(plugin, plan.profile)
                if ([...plan.deletions.values()].some(group => !!group.commands || group.removals.some(card =>
                    !['clear-command','keep-private-page'].includes(localDeleteEffect({ card, detached: false }, afterDeleteMode(plugin.settings), plugin.settings.TRASH_DELETED_PAGES === true))))) {
                    await createFullMigrationBackup(plugin)
                }
                for (const [source, group] of plan.deletions) {
                    const ids = Array.from(group.evidence.keys())
                    const expectedText = fieldOutputs.get(source) ?? source.content
                    const commands = group.commands && explicitDeletes(expectedText, plugin.settings.Syntax, plan.expressions, plan.pageModel, plan.directivePatterns)
                    if (group.commands && !commands) throw stalePlan()
                    if (commands && group.commands && expectedText !== source.content) {
                        for (const previous of group.commands.directives) {
                            const current = commands.directives.find(d => d.id === previous.id)
                            if (!current || Boolean(current.card) !== Boolean(previous.card) ||
                                source.content.slice(previous.card?.start ?? previous.start, previous.card?.end ?? previous.markerEnd) !==
                                expectedText.slice(current.card?.start ?? current.start, current.card?.end ?? current.markerEnd)) throw stalePlan()
                        }
                    }
                    const ranges = group.removals.map(range => {
                        if (expectedText === source.content) return range
                        const original = source.content.slice(range.start, range.end)
                        const start = expectedText.indexOf(original)
                        if (start < 0 || expectedText.indexOf(original, start + 1) >= 0) throw stalePlan()
                        return { ...range, start, end: start + original.length }
                    })
                    const result = cleanConfirmedDeletes(expectedText, commands, new Set(ids),
                        afterDeleteMode(plugin.settings), plugin.settings.TRASH_DELETED_PAGES === true, ranges,
                        t('Deleted from Anki', 'Удалено из Anki'))
                    const verifyLocal = async () => {
                        guard()
                        if (source.path !== source.file.path || vault.getAbstractFileByPath(source.path) !== source.file ||
                            await vault.read(source.file) !== expectedText || group.removals.some(r =>
                                state.get(r.id)?.pending || state.get(r.id)?.deletionSource !== deletionSignature(source.content, source.path, r))) throw stalePlan()
                        guard()
                    }
                    await verifyLocal()
                    await requireExpectedAnkiProfile(plugin, plan.profile)
                    const active = ids.filter(id => group.evidence.get(id) !== null)
                    if (active.length) {
                        const notes = await readNotes(active, plan.profile)
                        if (active.some(id => !notes.has(id) || snapshotKey(notes.get(id)!) !== group.evidence.get(id))) throw stalePlan()
                        await checkBrowse(new Set(active))
                        await requireExpectedAnkiProfile(plugin, plan.profile)
                        await verifyLocal()
                        await requireExpectedAnkiProfile(plugin, plan.profile)
                        guard()
                        dispatchedWrite = true
                        await writeToAnki(plugin.app, { action: 'deleteNotes', version: 6, params: { notes: active } })
                    }
                    const problems: string[] = []
                    const presence = await checkAnkiNoteExistence(ids, problems)
                    await requireExpectedAnkiProfile(plugin, plan.profile)
                    if (problems.length || ids.some(id => presence.get(id) !== false)) throw stalePlan()
                    await verifyLocal()
                    await requireExpectedAnkiProfile(plugin, plan.profile)
                    guard()
                    const explicitIds = new Set(commands?.directives.map(d => d.id).filter(id => group.evidence.has(id)))
                    if (explicitIds.size) {
                        await state.checkpoint([...explicitIds].filter(id => state.get(id)).map(id => [id, undefined] as const))
                        await verifyLocal()
                        await requireExpectedAnkiProfile(plugin, plan.profile)
                        guard()
                    }
                    ownWritePath = source.path
                    if (result.trash) {
                        if (ids.length !== 1 || plugin.settings.TRASH_DELETED_PAGES !== true) throw stalePlan()
                        await vault.trash(source.file, false)
                        if (vault.getAbstractFileByPath(source.path)) throw stalePlan()
                    } else if (result.text !== expectedText) {
                        await vault.process(source.file, text => {
                            guard()
                            if (text !== expectedText || source.file.path !== source.path) throw stalePlan()
                            return result.text
                        })
                        if (await vault.read(source.file) !== result.text) throw stalePlan()
                    }
                    checkRevision()
                    await state.checkpoint(ids.filter(id => !explicitIds.has(id)).map(id => [id, undefined] as const))
                    removed += ids.length
                }
            } catch (error) {
                errors.push(uiDiagnostic(error, t))
                if (error instanceof AnkiProfileError) profileProblem = error
            }
        }
        const summary = [
            plan.deletions.size ? t(`Confirmed ${removed} deletions.`, `Подтверждено удалений: ${removed}.`) : '',
            planned.length ? t(`Confirmed ${confirmed.length} of ${planned.length} linked records.`,
                `Подтверждено связанных записей: ${confirmed.length} из ${planned.length}.`) : '',
            pauseSummary,
        ].filter(Boolean).join(' ')
        if (profileProblem) {
            showAnkiProfileProblem(plugin, profileProblem, dispatchedWrite ? 'in-progress' : 'before-write', summary)
        }
        if (!errors.length) return summary
        onPartial?.()
        const retry = mode === 'preview' ? t('Open a fresh preview to review the pending files.',
            'Откройте новый предпросмотр, чтобы проверить оставшиеся файлы.') : ''
        return [summary, retry, errors[0]].filter(Boolean).join(' ')
    })
}

export async function previewBidirectionalSync(plugin: MyPlugin, scope: Scope = {}): Promise<void> {
    await runBidirectionalSync(plugin, scope, true)
}

export async function runBidirectionalSync(plugin: MyPlugin, scope: Scope = {}, previewRequested = false):
    Promise<'completed' | 'stopped' | 'failed' | 'blocked-profile'> {
    const t = uiFor(plugin.settings)
    if (plugin.settings.BIDIRECTIONAL_SYNC !== true) {
        new Notice(t('Enable bidirectional sync in the Rudonium settings.',
            'Включите двустороннюю синхронизацию в настройках Rudonium.'))
        return 'stopped'
    }
    try {
        if (scope.currentOnly && !scope.currentFile) {
            const file = plugin.app.workspace.getActiveFile()
            if (!file || !/\.md$/i.test(file.path)) throw new Error(t('Open a Markdown file to sync it with Anki.',
                'Откройте Markdown-файл для синхронизации с Anki.'))
            scope = { ...scope, currentFile: { file, path: file.path } }
        }
        const plan = await withFastScanReadLock(plugin, (revision, pathRevision) => buildPlan(plugin, scope, revision, pathRevision))
        const pending = hasPendingBidirectionalWrite(plugin.app) ? pendingBidirectionalWriteMessage :
            hasPendingAnkiWrite(plugin.app) ? pendingAnkiWriteMessage : undefined
        const automatic = !previewRequested && plugin.settings.BIDIRECTIONAL_PREVIEW !== true
        let applicable = plan
        let deferred = false
        if (automatic) {
            const held = new Set(plan.rows.filter(row => row.issues?.length || row.duplicates?.length ||
                row.changes.some(change => change.decision === 'conflict')).map(row => row.id))
            for (const group of plan.deletions.values()) for (const id of group.evidence.keys()) held.add(id)
            deferred = held.size > 0 || plan.issues.length > 0
            if (held.size) applicable = { ...plan, deletions: new Map(),
                links: plan.links.filter(link => !held.has(link.bullet.id)),
                pauses: plan.pauses.filter(pause => !held.has(pause.id)) }
        }
        const canApply = applicable.complete && !pending && (applicable.deletions.size > 0 ||
            applicable.pauses.some(p => !p.requiresAnkiChoice) || applicable.links.some(link => {
                const target = targetFor(link)
                return !target.conflicts.length && needsUpdate(link, target.value)
            }))
        if (automatic) {
            if (pending) {
                new Notice(t('Anki is still processing the previous write. Wait for it to finish before syncing again.',
                    'Anki ещё обрабатывает предыдущую запись. Дождитесь завершения и повторите синхронизацию.'))
                return 'stopped'
            }
            if (!plan.complete) {
                const detail = plan.issues[0] ? uiDiagnostic(plan.issues[0], t) : ''
                new Notice(t('Could not check all vault IDs. ', 'Не удалось проверить все ID хранилища. ') + detail)
                return 'failed'
            }
            if (canApply) {
                let partial = false
                const result = await applyPlan(plugin, applicable, new Map(), () => { partial = true }, 'background')
                if (result) new Notice(result, partial ? 10000 : 4000)
                if (partial) return 'failed'
            } else if (!deferred) {
                new Notice(t('Bidirectional sync: no changes.', 'Двусторонняя синхронизация: изменений нет.'), 4000)
            }
            return deferred ? 'stopped' : 'completed'
        }
        const source = plan.newCardSource
        const view = source && plan.complete && !pending ? plugin.app.workspace.getActiveViewOfType?.(MarkdownView) : null
        const previewNewCard = source && view?.file === source && view.getMode() === 'source' ? async () => {
            if (view.file !== source || view.getMode() !== 'source' ||
                plugin.app.vault.getAbstractFileByPath(source.path) !== source) throw stalePlan()
            await previewCurrentCard(plugin, view.editor, source, view.data, undefined, plan.profile)
        } : undefined
        openBidirectionalPreview(plugin.app, { mountPreference: container => addPreviewPreference(container, plugin, 'preview'),
            previewNewCard, profile: plan.profile, scopeLabel: plan.scopeLabel, scanned: plan.scanned, rows: plan.rows,
            issues: pending ? [pending, ...plan.issues] : plan.issues, canApply, foldRecoverable: plugin.settings.SKIP_SYNC_ERRORS === true },
            plan.complete && !pending ? async (choices, onPartial) => {
                try {
                    return await applyPlan(plugin, plan, choices, onPartial)
                } catch (error) {
                    if (error instanceof AnkiProfileError) showAnkiProfileProblem(plugin, error, 'before-write')
                    throw error
                }
            } : undefined, t)
        return 'stopped'
    } catch (error) {
        if (error instanceof AnkiProfileError) {
            showAnkiProfileProblem(plugin, error)
            return 'blocked-profile'
        }
        const reason = uiDiagnostic(error, t)
        new Notice(t(`Bidirectional sync stopped. ${reason}`, `Двусторонняя синхронизация остановлена. ${reason}`))
        return 'failed'
    }
}
