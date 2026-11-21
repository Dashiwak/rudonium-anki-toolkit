// SPDX-License-Identifier: GPL-3.0-only
import { mayHavePageTag, pageControlStart } from './page-frontmatter'
import { activeCardMarkdown, archivedCardRanges } from './archived-card'
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import type { CardPreviewCandidate } from './file'
import type { UiText } from './interface-language'
import { uiFor } from './interface-language'
import { ankiIdNumberTokens, looksLikeAnkiIdMarker } from './anki-id-marker'
import { hasPendingAnkiWrite } from './anki-transport'
import { hasPendingBidirectionalWrite } from './bidirectional-sync'
import { editorPreviewMetadata } from './card-preview-metadata'
import { findIdMarkers } from './duplicate-markers'
import { isRecoveryTag } from './export-recovery'
import { settingsWithoutAuditMode, withFastScanReadLock } from './fast-scan'
import { sameEditorText } from './markdown-pipeline'
import { pageHeading } from './page-card'
import { pageRecoverySlot } from './migrate-rudonium-page'
import { exactMatch, linkedField, openSources, readNativeRecoveryInventory, recoveryNames } from './page-migration'
import type { RecoveryTarget } from './page-migration'
import { foreignMigrationIds, foreignMigrationKeys } from './page-migration-router'
import { parsePortableMarkdown, portableFileExportRules } from './portable-parser'
import { settingToData } from './setting-to-data'
import { resolveSyncScope, scanProfileFreeSettings, syncScopeSignature } from './sync-profiles'
import { createFullMigrationBackup } from './vault-backup'

export interface LostIdOptions { deck?: string; profile?: string; scopeSignature?: string }
export interface LostIdRow {
    key: string; path: string; line: number; front: string; back: string; model: string; deck: string
    status: 'match' | 'review'; id?: number; reason?: string
}
export interface LostIdPlan { scanned: number; unlinked: number; unmatched: number; rows: LostIdRow[]; profile?: string; folderLabel?: string }
export interface LostIdResult { restored: number; archive: string; stopped?: string }

type Parsed = Awaited<ReturnType<typeof parsePortableMarkdown>>
type Data = Awaited<ReturnType<typeof settingToData>>
interface Source { file: TFile; text: string; parsed: Parsed; probe?: { at: number; marker: string } }
type DraftSource = Omit<Source, 'parsed'> & { parsed?: Parsed }
interface Draft { source: DraftSource; card: CardPreviewCandidate; target: RecoveryTarget; row: LostIdRow; visible: boolean; blocked?: string; anchor?: string }
interface Choice { draft: Draft; id: number }
interface Stored { plugin: MyPlugin; options: LostIdOptions; config: string; revision: number; choices: Map<string, Choice>; data: Data; editors: ReturnType<typeof captureEditors> }
const plans = new WeakMap<LostIdPlan, Stored>()
const configuration = (plugin: MyPlugin) => JSON.stringify([plugin.settings, plugin.fields_dict, plugin.app.vault.getName()])
const problem = (error: unknown) => error instanceof Error ? error.message : String(error)
const stale = (t: UiText) => new Error(t('The vault, settings or Anki match changed. Run the ID check again.',
    'Хранилище, настройки или совпадение в Anki изменились. Запустите проверку ID ещё раз.'))
function running(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('ID check cancelled', 'AbortError')
}

function captureEditors(plugin: MyPlugin) {
    return new Map(openSources(plugin).map(view => [view, { path: view.file!.path, text: view.getViewData() }] as const))
}

function checkEditors(plugin: MyPlugin, snapshot: ReturnType<typeof captureEditors>, t: UiText, written?: ReadonlyMap<string, string>) {
    for (const view of openSources(plugin)) {
        const path = view.file!.path, text = view.getViewData(), captured = snapshot.get(view)
        if (captured?.path === path && captured.text === text) continue
        if (written?.has(path) && sameEditorText(text, written.get(path))) continue
        // Opening an unchanged saved file introduces no new claim. Unsaved edits could
        // introduce either an ID marker or an unlinked card with identical contents.
        if (captured?.path === path || !sameEditorText(text, view.data)) throw stale(t)
    }
}

function overlappingCards(cards: readonly CardPreviewCandidate[]) {
    const overlaps = new Set<CardPreviewCandidate>()
    let furthest: CardPreviewCandidate | undefined
    for (const card of [...cards].sort((a, b) => a.start - b.start)) {
        if (furthest && card.start < furthest.end) {
            overlaps.add(furthest)
            overlaps.add(card)
        }
        if (!furthest || card.end > furthest.end) furthest = card
    }
    return overlaps
}

function numberLines(text: string) {
    const positions = [0]
    for (const match of text.matchAll(/\r\n?|\n/gu)) positions.push(match.index + match[0].length)
    return (offset: number) => {
        let low = 0, high = positions.length
        while (low + 1 < high) {
            const mid = (low + high) >>> 1
            if (positions[mid] <= offset) low = mid
            else high = mid
        }
        return low + 1
    }
}

// Orphaned page routing and field-layout lines are readable only with an ID in their
// original slot. The temporary ID exists solely in this parser input, never in the vault or in Anki.
const probeId = Number.MAX_SAFE_INTEGER
async function readSource(plugin: MyPlugin, data: Data, file: TFile, text: string, signal?: AbortSignal): Promise<Source> {
    let input = text
    let probe: Source['probe']
    const ids = ankiIdNumberTokens(text.includes('RUDONIUM-ARCHIVE') ? activeCardMarkdown(text) : text)
    if (mayHavePageTag(text) && /<!--(?:rudonium-page-(?:route|layout):| anki-bidirectional-tags:)/u.test(text)) {
        const head = pageHeading(text.includes('RUDONIUM-ARCHIVE') ? activeCardMarkdown(text) : text)
        if (head) {
            const start = pageControlStart(text, head.start + head.heading[0].length, head.tags)
            const at = pageRecoverySlot(text, start, plugin.settings.Syntax)
            if (!ids.length && !looksLikeAnkiIdMarker(text.slice(at).split(/\r?\n/u, 1)[0])) {
                const marker = '<!--ID: ' + probeId + '-->' + (head.heading[3] || '\n')
                probe = { at, marker }
                input = text.slice(0, at) + marker + text.slice(at)
                ids.push(probeId)
            }
        }
    }
    const parsed = await parsePortableMarkdown(plugin.app, data, file, input, ids, {
        preview: true, syntax: plugin.settings.Syntax, regexpOptions: { signal },
        metadata: editorPreviewMetadata(input, plugin.app.metadataCache?.getCache(file.path)),
    })
    if (probe && (parsed.pageCard?.id !== probeId || parsed.previewCandidates?.length !== 1))
        throw new Error(uiFor(plugin.settings)('Could not read the saved page layout.', 'Не удалось прочитать сохранённую разметку страницы.'))
    return { file, text, parsed, probe }
}

type Progress = (done: number, total: number) => void
async function collect(plugin: MyPlugin, options: LostIdOptions, revision: () => number, signal?: AbortSignal, progress?: Progress, retainFiles?: ReadonlySet<string>) {
    const t = uiFor(plugin.settings), { vault } = plugin.app
    const config = configuration(plugin), start = revision(), scope = resolveSyncScope(plugin)
    if (options.scopeSignature !== undefined && options.scopeSignature !== scope.signature) throw stale(t)
    const data = await settingToData(plugin.app, scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings)), plugin.fields_dict, [])
    const plan: LostIdPlan = { rows: [], scanned: 0, unlinked: 0, unmatched: 0, folderLabel: scope.profileId ? scope.label : undefined }
    const choices = new Map<string, Choice>(), drafts: Draft[] = [], owners = new Set<number>()
    const editors = captureEditors(plugin)
    const editorTexts = new Map<string, Set<string>>()
    for (const { path, text } of editors.values()) {
        const variants = editorTexts.get(path) ?? new Set<string>()
        variants.add(text); editorTexts.set(path, variants)
    }
    const anchors = new Map<string, string>(), sharedAnchors = new Set<string>()
    const indexIds = (text: string, path: string) => {
        if (text.includes('RUDONIUM-ARCHIVE')) for (const archive of archivedCardRanges(text)) owners.add(archive.id)
        for (const mark of findIdMarkers(text, plugin.settings.Syntax)) owners.add(mark.id)
        const external = foreignMigrationIds(text)
        for (const id of external) owners.add(id)
        const keys = foreignMigrationKeys(text)
        for (const key of keys) {
            const previous = anchors.get(key)
            if (previous === undefined) anchors.set(key, path)
            else if (previous !== path) sharedAnchors.add(key)
        }
        return { numeric: external.length, keys }
    }
    const pending = t('Finish the pending export before recovering IDs in this note.',
        'Перед восстановлением ID в этой заметке завершите незаконченный экспорт.')
    const dirty = t('Save the open edits and check again.', 'Сохраните открытые изменения и повторите проверку.')
    const files = scope.allFiles
    let visited = 0
    for (const file of files) {
        running(signal)
        const text = await vault.read(file)
        const variants = [...(editorTexts.get(file.path) ?? [])].filter(value => !sameEditorText(value, text))
        const inScope = scope.paths.has(file.path)
        if (inScope) plan.scanned++
        for (const [index, value] of [text, ...variants].entries()) {
            const foreign = indexIds(value, file.path)
            const visible = inScope && index === 0
            try {
                const source = await readSource(plugin, data, file, value, signal)
                const parsed = source.parsed
                // Keep the full parser only for files about to be written. A single
                // suggested link must not retain thousands of unrelated parsed neighbours.
                const origin: DraftSource = retainFiles?.has(file.path) && index === 0 ? source : { file, text: value }
                const unlinked: CardPreviewCandidate[] = []
                for (const card of parsed.previewCandidates ?? []) {
                    if (card.identifier === undefined || source.probe && card.identifier === probeId) unlinked.push(card)
                    else owners.add(card.identifier)
                }
                if (!unlinked.length) continue
                const overlaps = overlappingCards(parsed.previewCandidates ?? [])
                const lineAt = numberLines(value)
                const heading = parsed.pageCard?.linkedRoute && foreign.keys.length === 1 ? pageHeading(value) : undefined
                const anchor = heading && /[ \t]\^(af-[A-Za-z0-9-]+|q-[a-z0-9-]+)[ \t]*(?:\r?\n|$)/u.exec(heading.heading[0])?.[1]
                const preserved = anchor && anchor === foreign.keys[0] ? anchor : undefined
                const otherSource = foreign.numeric || foreign.keys.length && !preserved
                const issue = variants.length ? dirty : value.includes('<!-- Obsidian-to-Anki pending ') ? pending
                    : otherSource ? t('This note contains a link from another plugin. Check it in the migration wizard.',
                        'В заметке есть связь другого плагина. Проверьте её в мастере переноса.')
                    : portableFileExportRules(parsed).some(rule => rule.problem)
                        ? t('Verify the deck and export rules for this note.', 'Проверьте колоду и правила экспорта этой заметки.') : undefined
                for (const card of unlinked) {
                    const { note } = card
                    const model = note.modelName, deck = note.deckName, fields = plugin.fields_dict[model]
                    const show = visible && (!options.deck || deck === options.deck)
                    if (show) plan.unlinked++
                    if (!Array.isArray(fields) || fields.length < 2) {
                        if (show) plan.rows.push({ key: JSON.stringify([file.path, card.start]), path: file.path, line: lineAt(card.start),
                            front: '', back: '', model, deck, status: 'review', reason: t('Check the note type fields.', 'Проверьте поля типа записи.') })
                        continue
                    }
                    const names = parsed.pageCard?.fieldPair ?? recoveryNames(model, fields)
                    const front = note.fields[names[0]], back = note.fields[names[1]]
                    if (!front?.trim() || !back?.trim()) { if (show) plan.unmatched++; continue }
                    const sourceIdentity = { file, vaultName: vault.getName() }
                    const target: RecoveryTarget = { front: source.probe ? linkedField(front, sourceIdentity, probeId) : front,
                        back: source.probe ? linkedField(back, sourceIdentity, probeId) : back, model, deck, names, fields, knownLayout: true }
                    const row: LostIdRow = { key: JSON.stringify([file.path, card.start]), path: file.path, line: lineAt(card.start), front: target.front,
                        back: target.back, model, deck, status: 'review' }
                    const blocked = issue ?? (overlaps.has(card)
                        ? t('More than one card uses this part of the note.', 'Этот фрагмент заметки распознан как часть нескольких карточек.') : undefined)
                    drafts.push({ source: origin, card, target, row, visible: show, blocked, anchor: preserved })
                }
            } catch (error) {
                running(signal)
                if (visible) plan.rows.push({ key: JSON.stringify([file.path, 'parse']), path: file.path, line: 1,
                    front: '', back: '', model: '', deck: '', status: 'review', reason: t('Could not check this note: ', 'Не удалось проверить заметку: ') + problem(error) })
            }
        }
        progress?.(++visited, files.length)
    }
    if (drafts.some(draft => draft.visible)) {
        const inventory = await readNativeRecoveryInventory(plugin, drafts.filter(d => d.visible).map(d => d.target), t, signal, options.profile)
        plan.profile = inventory.profile
        const claims = new Map<number, Draft[]>()
        const vaultName = vault.getName()
        for (const draft of drafts) {
            const { row, target, source, visible } = draft
            running(signal)
            try {
                const match = exactMatch(target, { file: source.file, vaultName }, inventory, t)
                if (!match) { if (visible) plan.unmatched++; continue }
                const group = claims.get(match.id)
                if (group) group.push(draft)
                else claims.set(match.id, [draft])
                if (!visible) continue
                if (draft.blocked) row.reason = draft.blocked
                else if (draft.anchor && (sharedAnchors.has(draft.anchor) || draft.anchor.startsWith('af-') && match.fields.ForgeKey &&
                    match.fields.ForgeKey.replace(/^\^/u, '') !== draft.anchor)) row.reason = t('The source anchor is shared or belongs to a different Anki note.',
                    'Якорь исходной карточки повторяется или указывает на другую запись Anki.')
                else if (owners.has(match.id)) row.reason = t('This ID is already used in the vault.', 'Этот ID уже занят в хранилище.')
                else if (match.cards.some(card => inventory.decks.get(card) !== target.deck) || match.tags.some(isRecoveryTag))
                    row.reason = t('Review the decks or pending export of this Anki note.', 'Проверьте колоды или незавершённый экспорт этой записи Anki.')
                else { row.status = 'match'; row.id = match.id; choices.set(row.key, { draft, id: match.id }) }
            } catch (error) { row.reason = problem(error) }
            if (visible) plan.rows.push(row)
        }
        for (const group of claims.values()) if (group.length > 1) {
            for (const { row, visible } of group) if (visible) {
                row.status = 'review'; delete row.id; choices.delete(row.key)
                row.reason = t('Several local cards match the same Anki note.', 'Несколько карточек в хранилище совпадают с одной записью Anki.')
            }
        }
    }
    checkEditors(plugin, editors, t)
    if (config !== configuration(plugin) || revision() !== start || syncScopeSignature(plugin.settings) !== scope.signature) throw stale(t)
    running(signal)
    const stored: Stored = { plugin, options: { ...options, scopeSignature: scope.signature, profile: plan.profile }, config, revision: start, choices, data, editors }
    return { plan, stored }
}

export function scanLostIds(plugin: MyPlugin, options: LostIdOptions = {}, signal?: AbortSignal, progress?: Progress): Promise<LostIdPlan> {
    return withFastScanReadLock(plugin, async revision => {
        const { plan, stored } = await collect(plugin, options, revision, signal, progress)
        plans.set(plan, stored)
        return plan
    }, true)
}

/** Reuse the normal writer's positions for block, inline, regexp and page formats.
 * Reparse the entire saved result once to check both the recovered cards and their neighbours. */
async function linkedText(plugin: MyPlugin, data: Data, source: DraftSource, choices: readonly Choice[], t: UiText, signal?: AbortSignal) {
    const { parsed, file, text, probe } = source
    if (!parsed) throw stale(t)
    const chosen = new Map(choices.map(({ draft, id }) => [draft.card.note, id]))
    if (probe) {
        if (choices.length !== 1 || !parsed.pageCard) throw stale(t)
        parsed.pageCard = { ...parsed.pageCard, id: undefined }
        parsed.note_ids = [choices[0].id]
    } else {
        parsed.removeUnsafeNewCards(new Set(parsed.all_notes_to_add.filter(note => !chosen.has(note))))
        if (parsed.all_notes_to_add.length !== choices.length) throw stale(t)
        parsed.note_ids = parsed.all_notes_to_add.map(note => chosen.get(note)!)
    }
    parsed.file = text
    parsed.writeIDs()
    let after = parsed.file
    if (text.includes('\r\n') && !/(?:^|[^\r])\n/u.test(text)) after = after.replace(/\r?\n/gu, '\r\n')
    if (after === text) throw stale(t)
    const verified = await readSource(plugin, data, file, after, signal)
    const byPosition = (cards: readonly CardPreviewCandidate[]) => [...cards].sort((a, b) => a.start - b.start)
    const previous = byPosition(parsed.previewCandidates ?? []), next = byPosition(verified.parsed.previewCandidates ?? [])
    if (verified.probe || previous.length !== next.length) throw stale(t)
    const identity = { file, vaultName: plugin.app.vault.getName() }
    for (let at = 0; at < previous.length; at++) {
        const card = previous[at], found = next[at]
        const id = chosen.get(card.note) ?? card.identifier
        if (id !== found.identifier || card.note.modelName !== found.note.modelName || card.note.deckName !== found.note.deckName) throw stale(t)
        if (chosen.has(card.note)) {
            const fields = plugin.fields_dict[card.note.modelName]
            const pair = parsed.pageCard?.fieldPair ?? recoveryNames(card.note.modelName, fields)
            for (const name of pair) if (typeof found.note.fields[name] !== 'string' ||
                linkedField(card.note.fields[name], identity, probe ? probeId : id!) !== linkedField(found.note.fields[name], identity, id!)) throw stale(t)
        }
    }
    return after
}

export function applyLostIds(plugin: MyPlugin, plan: LostIdPlan, confirmed: ReadonlyMap<string, number>,
    signal?: AbortSignal): Promise<LostIdResult> {
    return withFastScanReadLock(plugin, async revision => {
        const t = uiFor(plugin.settings), { vault } = plugin.app
        const stored = plans.get(plan)
        const pairs = [...confirmed]
        if (!stored || !pairs.length || stored.plugin !== plugin || !stored.options.profile || stored.revision !== revision() ||
            stored.config !== configuration(plugin)) throw stale(t)
        const selected = pairs.map(([key, id]) => {
            const choice = stored.choices.get(key)
            if (!choice || choice.id !== id) throw stale(t)
            return choice
        })
        const busy = () => {
            running(signal)
            if (hasPendingAnkiWrite(plugin.app) || hasPendingBidirectionalWrite(plugin.app)) throw new Error(t(
                'Wait for the current Anki write to finish.', 'Дождитесь завершения записи в Anki.'))
        }
        busy()
        const archive = await createFullMigrationBackup(plugin)
        const result: LostIdResult = { archive, restored: 0 }
        try {
            if (stored.revision !== revision() || stored.config !== configuration(plugin)) throw stale(t)
            // Recheck local content, editors, every global ID owner, uniqueness, deck and the pinned Anki profile after backup.
            const selectedPaths = new Set(selected.map(({ draft }) => draft.source.file.path))
            const { stored: fresh } = await collect(plugin, stored.options, revision, signal, undefined, selectedPaths)
            const grouped = new Map<DraftSource, Choice[]>()
            for (const [i, [key, id]] of pairs.entries()) {
                const verified = fresh.choices.get(key), prior = selected[i].draft, current = verified?.draft
                if (!verified || !current || verified.id !== id || current.source.file !== prior.source.file ||
                    current.source.text !== prior.source.text || current.target.model !== prior.target.model ||
                    current.target.deck !== prior.target.deck || current.target.front !== prior.target.front || current.target.back !== prior.target.back) throw stale(t)
                const list = grouped.get(current.source)
                if (list) list.push(verified)
                else grouped.set(current.source, [verified])
            }
            const changes: Array<{ source: DraftSource; after: string; count: number }> = []
            for (const [source, choices] of grouped) {
                running(signal)
                changes.push({ source, after: await linkedText(plugin, fresh.data, source, choices, t, signal),
                    count: choices.length })
            }
            if (revision() !== stored.revision || configuration(plugin) !== stored.config) throw stale(t)
            const written = new Map<string, string>()
            const allowed = new Set<string>()
            let interrupted = false
            const refs = [
                vault.on('modify', file => { if (!allowed.delete(file.path)) interrupted = true }),
                vault.on('delete', () => { interrupted = true }), vault.on('create', () => { interrupted = true }),
                vault.on('rename', () => { interrupted = true }),
            ]
            try {
                for (const change of changes) {
                    const { source, after, count } = change, path = source.file.path
                    busy()
                    if (interrupted || configuration(plugin) !== stored.config || vault.getAbstractFileByPath(path) !== source.file) throw stale(t)
                    checkEditors(plugin, fresh.editors, t, written)
                    allowed.add(path)
                    try {
                        await vault.process(source.file, current => {
                            busy()
                            if (interrupted || current !== source.text || source.file.path !== path) throw stale(t)
                            checkEditors(plugin, fresh.editors, t, written)
                            return after
                        })
                    } catch (error) {
                        if (await vault.read(source.file) === after) result.restored += count
                        throw error
                    }
                    result.restored += count
                    written.set(path, after)
                }
            } finally { for (const ref of refs) vault.offref(ref) }
        } catch (error) { result.stopped = problem(error) }
        finally { plans.delete(plan) }
        return result
    })
}
