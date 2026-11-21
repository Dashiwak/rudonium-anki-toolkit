/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { pageYamlId } from './page-frontmatter'
import { pageFooterId, parseAnkiIdMarker } from './anki-id-marker'
import { MarkdownView } from 'obsidian'
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import { requireExpectedAnkiProfile } from './anki-profile'
import { editorPreviewMetadata } from './card-preview-metadata'
import { archivedIdMarkers, findIdMarkers } from './duplicate-markers'
import type { IdMarker } from './duplicate-markers'
import { settingsWithoutAuditMode, withFastScanReadLock } from './fast-scan'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { findLinkedBullets } from './linked-bullets'
import { parsePortableMarkdown } from './portable-parser'
import { settingToData } from './setting-to-data'
import { auditRead, checkAnkiNoteExistence, readSyncAuditNoteInventory, syncAuditDeckKey } from './sync-audit'
import type { SyncAuditResult, SyncAuditSource } from './sync-audit'
import { resolveSyncScope, scanProfileFreeSettings, syncScopeSignature } from './sync-profiles'
import { indexVaultIds } from './vault-id-index'

export interface AuditRepairSource extends SyncAuditSource {
    wholePage?: boolean
    line: number
    endLine: number
    markerLine: number
    startColumn: number
    endColumn: number
    blockStart: number
    blockEnd: number
    markerStart: number
    markerEnd: number
    markerLineStart: number
    markerLineEnd: number
    blockText: string
    markerText: string
    firstField: string
    fields: Readonly<Record<string, string>>
    modelName?: string
}

interface AuditRepairNote {
    id: number
    modelName: string
    firstField: string
    fieldNames: readonly string[]
    fields: Readonly<Record<string, string>>
    tags: readonly string[]
    cards: readonly number[]
    signature: string
}

export interface AuditRepairCandidate extends AuditRepairNote {
    eligible: boolean
    reason?: string
}

export interface AuditRepairRow {
    id: number
    source?: AuditRepairSource
    candidates: readonly AuditRepairCandidate[]
    issue?: string
}

export interface AuditRepairSearch {
    profile: string
    deck: string
    scopeSignature: string
    rows: readonly AuditRepairRow[]
}

interface RepairSearchOptions {
    signal?: AbortSignal
    onProgress?: (completed: number, total: number) => void
}

interface SourceLocation { file: TFile; text: string }
interface LineRange { start: number; end: number; next: number }

const readBatchSize = 200
const lineBreak = /\r\n?|\n/g
const generatedLink = /<br\s*\/?\s*>\s*<a href="obsidian:\/\/(?:open|anki-card)\?[^"<>]+" class="obsidian-link">Obsidian<\/a>/gi
const entities = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']])

function abortIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Поиск соответствий отменён.', 'AbortError')
}

/** Сохраняем регистр и значимые знаки. Убираем типовое оформление и служебную ссылку. */
export function auditRepairFieldKey(value: string): string {
    return value.replace(generatedLink, '')
        .replace(/<br\s*\/?\s*>|<\/?(?:div|p)>/gi, ' ')
        .replace(/<\/?(?:b|strong|i|em|u|s|strike|del|span)>/gi, '')
        .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
            if (name[0] !== '#') return entities.get(name.toLowerCase()) ?? entity
            const hex = name[1]?.toLowerCase() === 'x'
            const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
            return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity
        })
        .replace(/[ \t\r\n\u00a0]+/g, ' ').normalize('NFC').trim()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function auditRepairNoteSnapshot(value: unknown): AuditRepairNote | undefined {
    const note = asRecord(value)
    if (!note) return undefined
    const { noteId: id, modelName, tags, cards } = note
    const fields = asRecord(note.fields)
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof modelName !== 'string' || !modelName ||
        !fields || !Array.isArray(tags) || !tags.every(tag => typeof tag === 'string') || !Array.isArray(cards) ||
        !cards.every(card => typeof card === 'number' && Number.isSafeInteger(card) && card > 0) ||
        new Set(cards).size !== cards.length) return undefined
    const ordered: Array<{ name: string; order: number; value: string }> = []
    for (const [name, raw] of Object.entries(fields)) {
        const field = asRecord(raw)
        if (!name || !field || typeof field.value !== 'string' || typeof field.order !== 'number' ||
            !Number.isSafeInteger(field.order) || field.order < 0) return undefined
        ordered.push({ name, order: field.order, value: field.value })
    }
    ordered.sort((left, right) => left.order - right.order)
    if (!ordered.length || ordered.some(({ order }, index) => order !== index)) return undefined
    const notesTags = Object.freeze([...new Set(tags as string[])].sort())
    const noteCards = Object.freeze((cards as number[]).slice().sort((left, right) => left - right))
    const entries = ordered.map(({ name, value }) => [name, value] as const)
    return Object.freeze({ id, modelName, fields: Object.freeze(Object.fromEntries(entries)), tags: notesTags, cards: noteCards,
        firstField: ordered[0].value, fieldNames: Object.freeze(ordered.map(({ name }) => name)),
        signature: JSON.stringify([id, modelName, entries, notesTags, noteCards]) })
}

export async function readAuditRepairNotes(ids: readonly number[], signal?: AbortSignal): Promise<ReadonlyMap<number, AuditRepairNote>> {
    const requested = Array.from(new Set(ids))
    const result = new Map<number, AuditRepairNote>()
    for (let offset = 0; offset < requested.length; offset += readBatchSize) {
        abortIfCancelled(signal)
        const batch = requested.slice(offset, offset + readBatchSize)
        const pending = new Set(batch)
        const response = await auditRead('notesInfo', { notes: batch }, signal)
        if (!Array.isArray(response) || response.length !== batch.length) throw new Error('Anki вернула неполный список записей.')
        for (const item of response as unknown[]) {
            const note = auditRepairNoteSnapshot(item)
            if (!note || !pending.delete(note.id)) throw new Error('Anki вернула неполные или повторяющиеся данные записи.')
            result.set(note.id, note)
        }
    }
    return result
}

/** Проверяет заново разобранный диапазон одной карточки перед применением правки. */
export async function inspectAuditRepairSource(plugin: MyPlugin, file: TFile, text: string, source: SyncAuditSource,
    signal?: AbortSignal): Promise<AuditRepairSource | undefined> {
    if (file.path !== source.path) return undefined
    const inspected = await parseRepairSources(plugin, new Map([[file.path, { file, text }]]), new Map([[source.path, [source]]]), signal)
    return inspected.get(source.id)
}

function lineRanges(text: string): LineRange[] {
    const result: LineRange[] = []
    let start = 0
    for (const match of text.matchAll(lineBreak)) {
        const end = match.index
        const next = end + match[0].length
        result.push({ start, end, next })
        start = next
    }
    result.push({ start, end: text.length, next: text.length })
    return result
}

function offsetLine(lines: readonly LineRange[], offset: number): number {
    let low = 0
    let high = lines.length
    while (low < high) {
        const mid = low + Math.floor((high - low) / 2)
        if (lines[mid].start <= offset) low = mid + 1
        else high = mid
    }
    return low
}

function markerOffsets(text: string, lines: readonly LineRange[], marker: IdMarker, start: number, end: number) {
    const row = lines[marker.line - 1]
    if (!row) return undefined
    const pageLink = marker.location === 'yaml' ? pageYamlId(text) : (text.includes('@page') ? pageFooterId(text) : undefined)
    if (pageLink && pageLink.id === marker.id && pageLink.line === marker.line && pageLink.start >= start && row.next <= end) {
        return { markerStart: pageLink.digitsStart, markerEnd: pageLink.digitsEnd, markerLineStart: pageLink.start, markerLineEnd: row.next,
            markerText: text.slice(pageLink.start, row.next) }
    }
    const offset = row.start + marker.column
    const token = `ID: ${marker.id}`
    if (offset < start || offset + token.length > end || text.slice(offset, offset + token.length) !== token) return undefined
    const before = text.slice(Math.max(start, row.start), offset)
    const opening = /[ \t]*(?:<!--[ \t]*)?$/.exec(before)![0]
    let markerLineStart = offset - opening.length
    const parsed = parseAnkiIdMarker(text.slice(markerLineStart, Math.min(row.end, end)))
    if (!parsed || parsed.id !== marker.id) return undefined
    let markerLineEnd = markerLineStart + parsed.to
    if (markerLineStart === row.start && row.end <= end && /^[ \t]*$/.test(text.slice(markerLineEnd, row.end))) {
        markerLineEnd = Math.min(row.next, end)
        if (markerLineEnd === row.end) {
            const prior = lines[marker.line - 2]
            if (prior && prior.end >= start) markerLineStart = prior.end
        }
    }
    return { markerStart: offset + 'ID: '.length, markerEnd: offset + token.length, markerLineStart, markerLineEnd,
        markerText: text.slice(markerLineStart, markerLineEnd) }
}

function snapshotSource(source: SyncAuditSource, text: string, ranges: readonly LineRange[], marker: IdMarker,
    start: number, end: number, firstField: string, fields: Record<string, string>, modelName?: string): AuditRepairSource | undefined {
    const offsets = markerOffsets(text, ranges, marker, start, end)
    const line = offsetLine(ranges, start)
    const endLine = offsetLine(ranges, Math.max(start, end - 1))
    if (!offsets || source.line !== line || source.endLine !== endLine || source.markerLine !== marker.line) return undefined
    return Object.freeze({ ...source, ...offsets, line, endLine, markerLine: marker.line,
        startColumn: start - ranges[line - 1].start, endColumn: Math.min(end, ranges[endLine - 1].end) - ranges[endLine - 1].start,
        blockStart: start, blockEnd: end,
        blockText: text.slice(start, end), firstField, fields: Object.freeze({ ...fields }), modelName })
}

function chosenSources(result: SyncAuditResult): Map<string, SyncAuditSource[]> {
    const paths = new Map<string, SyncAuditSource[]>()
    for (const group of result.obsidianOnly) {
        if (group.occurrences.length !== 1) continue
        const source = group.occurrences[0]
        if (source.id !== group.id || source.line === undefined || source.endLine === undefined || source.markerLine === undefined) continue
        const sources = paths.get(source.path) ?? []
        sources.push(source)
        paths.set(source.path, sources)
    }
    return paths
}

async function parseRepairSources(plugin: MyPlugin, locations: ReadonlyMap<string, SourceLocation>,
    sourcesByPath: ReadonlyMap<string, SyncAuditSource[]>, signal?: AbortSignal): Promise<Map<number, AuditRepairSource>> {
    const result = new Map<number, AuditRepairSource>()
    const settings = scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings))
    const data = await settingToData(plugin.app, settings, plugin.fields_dict, [])
    const noteTypes = new Set(Object.keys(plugin.fields_dict))
    for (const [path, { file, text }] of locations) {
        abortIfCancelled(signal)
        const sources = sourcesByPath.get(path) ?? []
        const markers = new Map(findIdMarkers(text, settings.Syntax).map(marker => [marker.id, marker]))
        const ranges = lineRanges(text)
        const bullets = findLinkedBullets(text, false, settings.Syntax)
        const parsed = await parsePortableMarkdown(plugin.app, data, file, text, [...markers.keys()], { preview: true,
            metadata: editorPreviewMetadata(text, plugin.app.metadataCache.getCache(path)), syntax: settings.Syntax, noteTypes,
            bullets, regexpOptions: { shouldStop: () => signal?.aborted === true } })
        for (const source of sources) {
            const marker = markers.get(source.id)
            if (!marker) continue
            const cards = (parsed.previewCandidates ?? []).filter(candidate => candidate.identifier === source.id)
            if (cards.length > 1) continue
            const card = cards[0]
            if (card) {
                if (syncAuditDeckKey(card.note.deckName) !== syncAuditDeckKey(source.assignedDeck ?? '')) continue
                const model = card.note.modelName
                const first = plugin.fields_dict[model]?.[0]
                const confirmed = first && typeof card.note.fields[first] === 'string' ? snapshotSource(source, text, ranges, marker,
                    card.start, card.end, card.note.fields[first], card.note.fields, model) : undefined
                if (confirmed) result.set(source.id, parsed.pageCard?.id === source.id
                    ? Object.freeze({ ...confirmed, wholePage: true }) : confirmed)
                continue
            }
            // Без записи Anki тип простого блока с соседним ID ещё не известен.
            const bullet = bullets.find(item => item.id === source.id)
            if (!bullet || syncAuditDeckKey(parsed.target_deck) !== syncAuditDeckKey(source.assignedDeck ?? '')) continue
            const fields = { Front: parsed.formatter.format(bullet.front, false, false),
                Back: parsed.formatter.format(bullet.back, false, false), ...bullet.metadata }
            const confirmed = snapshotSource(source, text, ranges, marker, bullet.start, bullet.end, fields.Front, fields)
            if (confirmed) result.set(source.id, confirmed)
        }
    }
    abortIfCancelled(signal)
    return result
}

function classifyCandidate(source: AuditRepairSource, note: AuditRepairNote, owned: ReadonlySet<number>,
    localFields: Readonly<Record<string, readonly string[]>>, t: UiText): AuditRepairCandidate {
    const names = note.fieldNames
    const schema = Object.prototype.hasOwnProperty.call(localFields, note.modelName) ? localFields[note.modelName] : undefined
    const unsupported = !schema || schema.length !== names.length || !schema.every((name, index) => name === names[index]) ||
        (source.modelName ? source.modelName !== note.modelName : names[0] !== 'Front' || !('Back' in note.fields) ||
            Object.keys(source.fields).some(field => !(field in note.fields)))
    const reason = owned.has(note.id) ? t('This Anki ID is already linked in Obsidian.', 'Этот ID Anki уже связан с записью Obsidian.') :
        unsupported ? t('The note type or fields do not match the Markdown block.', 'Тип записи или поля не совпадают с Markdown-блоком.') : undefined
    return Object.freeze({ ...note, eligible: reason === undefined, reason })
}

function dirtyMarkdown(plugin: MyPlugin): Map<string, string> {
    const result = new Map<string, string>()
    for (const { view } of plugin.app.workspace.getLeavesOfType('markdown')) {
        if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file) continue
        const source = view.getViewData()
        if (source.replace(/\r\n/g, '\n') !== view.data.replace(/\r\n/g, '\n')) result.set(view.file.path, source)
    }
    return result
}

export async function searchAuditRepairMatches(plugin: MyPlugin, result: SyncAuditResult,
    { signal, onProgress }: RepairSearchOptions = {}): Promise<AuditRepairSearch> {
    const t = uiFor(plugin.settings)
    const profile = result.ankiProfile && 'active' in result.ankiProfile ? result.ankiProfile.active : undefined
    const stale = () => new Error(t('The audit data changed. Run the audit again.', 'Данные изменились. Повторите аудит.'))
    if (!profile || !result.ankiInventoryComplete || !result.vaultInventoryComplete || result.ankiDeckExists === false) {
        throw new Error(t('Run a complete audit for this deck before searching.', 'Перед поиском проведите полную проверку этой колоды.'))
    }
    return withFastScanReadLock(plugin, async (currentRevision, pathRevision) => {
        abortIfCancelled(signal)
        const revision = currentRevision()
        const scope = resolveSyncScope(plugin)
        const settingsKey = () => JSON.stringify([scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings)), plugin.fields_dict])
        const settings = settingsKey()
        const checkSnapshot = () => {
            abortIfCancelled(signal)
            if (revision !== currentRevision() || scope.signature !== syncScopeSignature(plugin.settings) || settings !== settingsKey()) throw stale()
        }
        if (result.vaultName !== plugin.app.vault.getName() || result.folderProfile &&
            (result.folderProfile.label !== scope.label || result.folderProfile.files !== scope.paths.size)) throw stale()
        await requireExpectedAnkiProfile(plugin, profile, signal)
        const groups = chosenSources(result)
        const sources = new Map<string, SourceLocation>()
        const dirty = dirtyMarkdown(plugin)
        const inventory = await indexVaultIds(plugin, scope.allFiles, plugin.settings.Syntax, pathRevision, {
            includeArchivedOwners: true, shouldStop: () => signal?.aborted === true, needsContent: path => groups.has(path),
            onFile: (file, path, _markers, text) => {
                if (groups.has(path) && scope.contains(path) && !dirty.has(path) && typeof text === 'string') sources.set(path, { file, text })
            },
        })
        checkSnapshot()
        if (!inventory.complete) throw new Error(t('Unable to check ID ownership across the vault.', 'Не удалось проверить ID во всём хранилище.'))
        const laterDirty = dirtyMarkdown(plugin)
        for (const path of laterDirty.keys()) sources.delete(path)
        const owned = new Set(inventory.first.keys())
        for (const dirtyText of [...dirty.values(), ...laterDirty.values()]) {
            for (const marker of findIdMarkers(dirtyText, plugin.settings.Syntax)) owned.add(marker.id)
            for (const marker of archivedIdMarkers(dirtyText)) owned.add(marker.id)
        }
        const confirmedSources = await parseRepairSources(plugin, sources, groups, signal)
        const existenceErrors: string[] = []
        const existence = await checkAnkiNoteExistence(result.obsidianOnly.map(({ id }) => id), existenceErrors, signal)
        checkSnapshot()
        if (existenceErrors.length) throw new Error(t('Anki did not confirm the missing IDs. Repeat the audit.', 'Anki не подтвердила отсутствующие ID. Повторите аудит.'))
        const rows: AuditRepairRow[] = result.obsidianOnly.map(({ id }) => {
            if (existence.get(id) !== false) return { id, candidates: [], issue: t('This ID is present in Anki. Run the audit again.', 'Этот ID есть в Anki. Повторите аудит.') }
            if (inventory.duplicates.has(id)) return { id, candidates: [], issue: t('This ID appears in more than one block.', 'Этот ID встречается в нескольких блоках.') }
            const source = confirmedSources.get(id)
            return source ? { id, source, candidates: [] } : { id, candidates: [], issue: t(
                'The Markdown block could not be verified. Save it and run the audit again.', 'Не удалось подтвердить Markdown-блок. Сохраните его и повторите аудит.') }
        })
        const targets = new Map<string, AuditRepairRow[]>()
        for (const row of rows) {
            if (!row.source) continue
            const key = auditRepairFieldKey(row.source.firstField)
            if (!key) continue
            const matching = targets.get(key) ?? []
            matching.push(row)
            targets.set(key, matching)
        }
        if (targets.size) {
            await requireExpectedAnkiProfile(plugin, profile, signal)
            const notes = await readSyncAuditNoteInventory(result.deck, signal)
            if (!notes) throw new Error(t('Unable to verify the exact deck in Anki.', 'Не удалось подтвердить состав указанной колоды Anki.'))
            const ids = Array.from(notes)
            const candidates = new Map<number, AuditRepairCandidate[]>()
            onProgress?.(0, ids.length)
            for (let offset = 0; offset < ids.length; offset += readBatchSize) {
                checkSnapshot()
                const batch = ids.slice(offset, offset + readBatchSize)
                for (const note of (await readAuditRepairNotes(batch, signal)).values()) {
                    for (const row of targets.get(auditRepairFieldKey(note.firstField)) ?? []) {
                        if (row.id === note.id) continue
                        const choices = candidates.get(row.id) ?? []
                        choices.push(classifyCandidate(row.source!, note, owned, plugin.fields_dict, t))
                        candidates.set(row.id, choices)
                    }
                }
                onProgress?.(offset + batch.length, ids.length)
            }
            for (const row of rows) row.candidates = Object.freeze((candidates.get(row.id) ?? []).sort((a, b) => a.id - b.id))
        }
        await requireExpectedAnkiProfile(plugin, profile, signal)
        checkSnapshot()
        return Object.freeze({ profile, deck: result.deck, scopeSignature: scope.signature, rows: Object.freeze(rows.map(row => Object.freeze(row))) })
    })
}
