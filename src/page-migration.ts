// SPDX-License-Identifier: GPL-3.0-only
import { MarkdownView } from 'obsidian'
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import type { UiText } from './interface-language'
import { uiFor } from './interface-language'
import { hasPendingAnkiWrite } from './anki-transport'
import { hasPendingBidirectionalWrite } from './bidirectional-sync'
import { sameEditorText } from './markdown-pipeline'
import { archivedCardRanges } from './archived-card'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { findIdMarkers } from './duplicate-markers'
import { withFastScanReadLock, settingsWithoutAuditMode } from './fast-scan'
import { scanProfileFreeSettings, isSyncAuditReportPath } from './sync-profiles'
import { auditRead } from './sync-audit'
import { requireExpectedAnkiProfile } from './anki-profile'
import { auditRepairFieldKey, auditRepairNoteSnapshot } from './audit-repair-match'
import { createFullMigrationBackup, fullMigrationBackupDirectory } from './vault-backup'
import { isRecoveryTag } from './export-recovery'
import { isDeckPageSchema, sourcePageFields } from './page-card'
import { pageCardExpression } from './card-format-presets'
import { pageIdLocation } from './page-id-location'
import { detectMigrationContext } from './page-migration-context'
import { inspectMigrationFile, foreignMigrationIds, foreignMigrationKeys, renderMigrationPage } from './page-migration-router'
import type { MigrationCandidate, MigrationContext, MigrationSource } from './page-migration-context'
import { editorPreviewMetadata } from './card-preview-metadata'
import { parsePortableMarkdown, portableFileExportRules } from './portable-parser'
import { settingToData } from './setting-to-data'

export { fullMigrationBackupDirectory as migrationBackupDirectory }

export interface PageMigrationOptions { model: string; source?: string; folder?: string; checkMissingIds?: boolean }
export interface PageMigrationRow {
    path: string
    source: string
    status: 'ready' | 'review' | 'already' | 'link' | 'unchecked'
    link?: Readonly<{ id: number; model: string; deck: string; front: string; back: string }>
    reason?: string
    id?: number
    before?: string
    after?: string
}
export interface PageMigrationPlan {
    model: string
    profile?: string
    scanned: number
    rows: PageMigrationRow[]
    warnings: string[]
}
export interface PageMigrationResult { archive: string; converted: string[]; stopped?: string }
type Progress = (done: number, total: number) => void
interface Draft {
    row: PageMigrationRow
    candidate: MigrationCandidate
    file: TFile
    before: string
    after: string
    front: string
    back: string
    deck: string
    model: string
    fields: readonly string[]
    recovery?: RecoveryTarget
    originalSignature?: string
    vaultName: string
}
interface Stored {
    plugin: MyPlugin
    settings: string
    discovery: string
    revision: number
    profile?: string
    model: string
    drafts: Map<string, Draft>
}

const plans = new WeakMap<PageMigrationPlan, Stored>()
const pluginIds = { rudonium: 'rudonium-anki-toolkit', 'anki-forge': 'anki-forge', 'anki-bridge': 'anki-bridge', 'anki-ast-sync': 'anki-ast-sync', 'anki-exporter': 'anki-exporter', yanki: 'yanki', flashcards: 'flashcards-obsidian', 'obsidian-to-anki': 'obsidian-to-anki-plugin', 'deck-to-anki': 'deck-to-anki', 'spaced-repetition': 'obsidian-spaced-repetition' }
const batchSize = 500
function cancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Migration cancelled', 'AbortError')
}
export function openSources(plugin: MyPlugin): MarkdownView[] {
    return plugin.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
        .filter((view): view is MarkdownView => view instanceof MarkdownView && !!view.file && view.getMode() === 'source')
}
function dirtyFiles(plugin: MyPlugin): Set<string> {
    const paths = new Set<string>()
    for (const view of openSources(plugin)) {
        if (!sameEditorText(view.getViewData(), view.data)) paths.add(view.file!.path)
    }
    return paths
}
const signature = (plugin: MyPlugin) => JSON.stringify([plugin.settings, plugin.fields_dict])
function activeSourceId(plugin: MyPlugin, source: MigrationSource): string | undefined {
    const registry = (plugin.app as typeof plugin.app & { plugins?: { enabledPlugins?: ReadonlySet<string>; plugins?: Record<string, unknown> } }).plugins
    if (source === 'rudonium') return
    const ids = source === 'flashcards' ? [pluginIds.flashcards, 'better-flashcards']
        : source === 'anki-bridge' ? [pluginIds[source], 'obsidian-anki-bridge'] : [pluginIds[source]]
    return ids.find(id => registry?.enabledPlugins?.has(id) || !!registry?.plugins?.[id])
}
function checkModel(plugin: MyPlugin, model: string, t: UiText): string[] {
    const names = Object.prototype.hasOwnProperty.call(plugin.fields_dict, model) ? plugin.fields_dict[model] : undefined
    if (!Array.isArray(names) || names.length < 2) throw new Error(t('Choose an Anki note type with two or more fields.', 'Выберите тип записи Anki с двумя полями или более.'))
    const rules = plugin.settings.CUSTOM_REGEXPS ?? {}
    if (Object.keys(rules).some(key => key !== model && rules[key] === pageCardExpression))
        throw new Error(t('Choose the note type already assigned to @page.',
            'Выберите тип записи, уже назначенный @page.'))
    return names
}
function markReview(draft: Draft, reason: string): void {
    draft.row.status = 'review'
    draft.row.reason = reason
}
function safeFolder(input: string | undefined, t: UiText): string {
    if (input?.trim() === '/') return '/'
    const folder = (input ?? '').trim().replace(/\/$/u, '')
    if (folder && folder.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/u.test(part))) throw new Error(t('Choose a folder inside this vault.', 'Выберите папку внутри хранилища.'))
    return folder
}
function checkRemoteSchema(candidate: MigrationCandidate, names: readonly string[], model: string, t: UiText): string | undefined {
    if (candidate.model && candidate.model !== model && candidate.id) return t('Choose its original Anki note type: ', 'Выберите исходный тип записи Anki: ') + candidate.model
    const expected = candidate.id ? candidate.fieldNames : undefined
    const native = candidate.source === 'rudonium' && candidate.recoverOnly
    const namedDeck = (native || candidate.source === 'deck-to-anki') && expected?.[0] === 'ob-deck-front' && expected[1] === 'ob-deck-back'
    const namedSource = candidate.source === 'anki-forge' || candidate.source === 'anki-bridge'
    const inferredPair = sourcePageFields(native ? 'anki-bridge' : candidate.source, names)
    const nativeNamed = native && expected && inferredPair && inferredPair[0] === expected[0] && inferredPair[1] === expected[1]
    const differentPair = !!expected && (!inferredPair || inferredPair[0] !== expected[0] || inferredPair[1] !== expected[1])
    if (namedDeck ? !isDeckPageSchema(model, names)
        : namedSource && expected ? differentPair
        : !nativeNamed && (expected && (names[0] !== expected[0] || names[1] !== expected[1]) || names[0] === 'ob-deck-id')) {
        return t('Its source fields or card template do not match the selected type.', 'Исходные поля или шаблон карточки не совпадают с выбранным типом.')
    }
    return undefined
}
type Snapshot = NonNullable<ReturnType<typeof auditRepairNoteSnapshot>>
interface Inventory {
    profile: string
    linked: Map<number, Snapshot>
    decks: Map<number, string>
    fronts: Set<string>
    byContent: Map<string, Snapshot[]>
    unlinkedSchemaProblem?: string
}

interface RecoverySearch {
    models: ReadonlySet<string>
    knownLayout: boolean
    native?: boolean
    content: (schemaProblem?: string) => Promise<ReadonlySet<string>> | ReadonlySet<string>
}

export interface RecoveryTarget {
    model: string
    deck: string
    front: string
    back: string
    fields: readonly string[]
    names: readonly [string, string]
    knownLayout: boolean
}

export function contentKey(model: string, deck: string, front: string, back: string): string {
    const forIndex = (value: string) => fieldBody(value).replace(sourceLink, '').trim()
    return JSON.stringify([model, deck, forIndex(front), forIndex(back)])
}

export function recoveryNames(model: string, fields: readonly string[]): readonly [string, string] {
    return isDeckPageSchema(model, fields) ? ['ob-deck-front', 'ob-deck-back'] : [fields[0], fields[1]]
}

function knownLayout(candidate: MigrationCandidate, fields: readonly string[]): boolean {
    return !!(candidate.model || candidate.recoveryModel || sourcePageFields(candidate.source, fields))
}


/** For new notes verify the selected Basic-shaped template once per preview, independent of linked models. */
async function unlinkedSchemaIssue(plugin: MyPlugin, model: string, t: UiText, signal?: AbortSignal): Promise<string | undefined> {
    const names = plugin.fields_dict[model]
    const problem = t('Choose a single forward template that displays the first field as its question and the second as its answer.',
        'Выберите тип с одним прямым шаблоном, первым полем в вопросе и вторым в ответе.')
    try {
        const actual = await auditRead('modelFieldNames', { modelName: model }, signal)
        if (JSON.stringify(actual) !== JSON.stringify(names) || names[0] === 'ob-deck-id') return problem
        const result = await auditRead('modelTemplates', { modelName: model }, signal)
        if (!result || typeof result !== 'object' || Array.isArray(result)) return problem
        const templates = Object.values(result)
        if (templates.length !== 1) return problem
        const template: unknown = templates[0]
        if (!template || typeof template !== 'object' || !('Front' in template) || !('Back' in template) ||
            typeof template.Front !== 'string' || typeof template.Back !== 'string') return problem
        const displays = (html: string, field: string) => Array.from(html.matchAll(/\{\{([^{}]*)\}\}/gu),
            match => match[1].trim()).some(ref => ref === field || ref === 'text:' + field || ref === 'type:' + field)
        if (/\{\{\s*(?:[^{}]+:)*cloze:/iu.test(template.Front + template.Back) ||
            !displays(template.Front, names[0]) || !displays(template.Back, names[1])) return problem
    } catch {
        cancelled(signal)
        return problem
    }
    return undefined
}

/** Unlinked pages require a cross-model lookup. In a linked-only run read just the IDs selected for migration. */
async function readInventory(plugin: MyPlugin, ids: Set<number>, checkUnlinked: boolean, model: string, t: UiText,
    signal?: AbortSignal, pinned?: string, search?: RecoverySearch): Promise<Inventory> {
    const profile = await requireExpectedAnkiProfile(plugin, pinned, signal)
    const unlinkedSchemaProblem = checkUnlinked && model ? await unlinkedSchemaIssue(plugin, model, t, signal) : undefined
    const lookupAll = checkUnlinked && (!unlinkedSchemaProblem || search?.knownLayout)
    const wanted = await search?.content(unlinkedSchemaProblem)
    const rawIds: unknown = lookupAll ? await auditRead('findNotes', { query: '' }, signal) : [...ids]
    if (!Array.isArray(rawIds) || !rawIds.every((id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || new Set(rawIds).size !== rawIds.length) throw new Error(t('Invalid note inventory.', 'Некорректный список записей Anki.'))
    const linked = new Map<number, Snapshot>(), decks = new Map<number, string>(), fronts = new Set<string>()
    const possible: Array<{ note: Snapshot; pairs: Array<readonly [string, string]> }> = []
    const cardIds = new Set<number>()
    for (let at = 0; at < rawIds.length; at += batchSize) {
        const notes = rawIds.slice(at, at + batchSize)
        const raw = await auditRead('notesInfo', { notes }, signal)
        if (!Array.isArray(raw) || raw.length !== notes.length) throw new Error(t('Incomplete Anki note response.', 'Ответ Anki содержит неполный список записей.'))
        const requested = new Set<number>(notes)
        const rows: readonly unknown[] = raw
        for (const item of rows) {
            if (item === null || item && typeof item === 'object' && !Object.keys(item).length) {
                if (lookupAll) throw new Error(t('The Anki inventory changed during verification.', 'Коллекция Anki изменилась во время проверки.'))
                continue
            }
            const note = auditRepairNoteSnapshot(item)
            if (!note || !requested.delete(note.id)) throw new Error(t('Could not verify note identities or fields.', 'Не удалось проверить идентификаторы и поля записей.'))
            if (lookupAll && !search?.native) {
                fronts.add(auditRepairFieldKey(note.firstField))
                for (const field of ['ob-deck-front', 'Front', 'Question']) {
                    if (note.fields[field]) fronts.add(auditRepairFieldKey(note.fields[field]))
                }
            }
            const pairs: Array<readonly [string, string]> = []
            if (lookupAll && wanted?.size && search?.models.has(note.modelName) && (note.cards.length === 1 || search.native) && note.fieldNames.length >= 2) {
                const alternatives = [recoveryNames(note.modelName, note.fieldNames), sourcePageFields('anki-forge', note.fieldNames),
                    sourcePageFields('anki-bridge', note.fieldNames)]
                for (const pair of alternatives) if (pair && !pairs.some(([f, b]) => f === pair[0] && b === pair[1]) &&
                    wanted.has(contentKey(note.modelName, '', note.fields[pair[0]], note.fields[pair[1]]))) pairs.push(pair)
                if (pairs.length) possible.push({ note, pairs })
            }
            if (ids.has(note.id)) linked.set(note.id, note)
            else if (!pairs.length) continue
            for (const card of note.cards) {
                if (cardIds.has(card)) throw new Error(t('Anki returned a repeated card ID.', 'Anki вернула повторяющийся ID карточки.'))
                cardIds.add(card)
            }
        }
    }
    const orderedCards = [...cardIds]
    for (let at = 0; at < orderedCards.length; at += batchSize) {
        const cards = orderedCards.slice(at, at + batchSize)
        const result = await auditRead('getDecks', { cards }, signal)
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(t('Could not read Anki decks.', 'Не удалось прочитать колоды Anki.'))
        const remaining = new Set(cards)
        for (const [deck, members] of Object.entries(result)) {
            if (!deck.trim() || !Array.isArray(members)) throw new Error(t('Invalid Anki deck response.', 'Некорректный ответ Anki о колодах.'))
            for (const card of members) {
                if (typeof card !== 'number' || !remaining.delete(card)) throw new Error(t('Unexpected card in deck response.', 'Anki вернула неожиданный ID карточки при проверке колод.'))
                decks.set(card, deck)
            }
        }
        if (remaining.size) throw new Error(t('Anki did not return a deck for every requested card.', 'Anki вернула колоды не для всех запрошенных карточек.'))
    }
    const byContent = new Map<string, Snapshot[]>()
    for (const { note, pairs } of possible) {
        const keys = new Set<string>()
        for (const deck of new Set(note.cards.map(card => decks.get(card)!))) for (const pair of pairs) {
            keys.add(contentKey(note.modelName, deck, note.fields[pair[0]], note.fields[pair[1]]))
        }
        for (const key of keys) {
            const group = byContent.get(key)
            if (group) group.push(note)
            else byContent.set(key, [note])
        }
    }
    await requireExpectedAnkiProfile(plugin, profile, signal)
    return { linked, decks, fronts, byContent, profile, unlinkedSchemaProblem }
}

/** Native cards already declare their model and routing through the regular export parser. */
export function readNativeRecoveryInventory(plugin: MyPlugin, targets: readonly RecoveryTarget[], t: UiText,
    signal?: AbortSignal, pinned?: string): Promise<Inventory> {
    return readInventory(plugin, new Set(), true, '', t, signal, pinned, {
        models: new Set(targets.map(target => target.model)), knownLayout: true, native: true,
        content: () => new Set(targets.map(target => contentKey(target.model, '', target.front, target.back))),
    })
}

// Keep links, media, inline markup and significant whitespace when verifying card identity.
// Compare only the host-generated backlink to this exact source and one plain outer paragraph.
const sourceLink = /<br\s*\/?><a href="(obsidian:\/\/(?:anki-card|open)\?[^"<>]*)" class="obsidian-link">Obsidian<\/a>$/u
function fieldBody(value: string): string {
    const html = value.replace(/\r\n/g, '\n').normalize('NFC').trim()
    const wrapper = /^<(div|p)>([\s\S]*)<\/\1>$/iu.exec(html)
    return (wrapper && !/<\/?(?:div|p)(?:\s|>)/iu.test(wrapper[2]) ? wrapper[2] : html).trim()
}
export function linkedField(value: string, draft: Pick<Draft, 'file' | 'vaultName'>, id: number): string {
    const body = fieldBody(value)
    const link = sourceLink.exec(body)
    if (link) {
        const url = new URL(link[1].replace(/&amp;/gu, '&'))
        if (url.searchParams.getAll('file').length === 1 && url.searchParams.get('file') === draft.file.path &&
            url.searchParams.getAll('vault').length === 1 && url.searchParams.get('vault') === draft.vaultName &&
            (url.host === 'open' || url.searchParams.getAll('nid').length === 1 && url.searchParams.get('nid') === String(id))) {
            return body.slice(0, link.index).trim()
        }
    }
    return body.trim()
}
export function exactMatch(target: RecoveryTarget, draft: Pick<Draft, 'file' | 'vaultName'>, inventory: Inventory, t: UiText): Snapshot | undefined {
    const group = inventory.byContent.get(contentKey(target.model, target.deck, target.front, target.back))
    if (!group) return
    const schema = JSON.stringify(target.fields)
    const [front, back] = target.names
    if (!target.fields.includes(front) || !target.fields.includes(back)) return
    let only: Snapshot | undefined
    for (const note of group) {
        if (JSON.stringify(note.fieldNames) !== schema ||
            linkedField(note.fields[front], draft, note.id) !== linkedField(target.front, draft, note.id) ||
            linkedField(note.fields[back], draft, note.id) !== linkedField(target.back, draft, note.id)) continue
        if (only) throw new Error(t('Multiple Anki notes match the question, answer, note type and deck.',
            'Найдено несколько записей Anki с этими вопросом, ответом, типом и колодой.'))
        only = note
    }
    return only
}

function verifyDraft(draft: Draft, inventory: Inventory, t: UiText): void {
    const id = draft.candidate.id
    if (id === undefined) {
        if (inventory.unlinkedSchemaProblem) throw new Error(inventory.unlinkedSchemaProblem)
        if (inventory.fronts.has(auditRepairFieldKey(draft.front))) throw new Error(t('Anki already contains this question. Verify its note ID before migration.', 'В Anki уже есть такой вопрос. Перед переносом проверьте ID записи.'))
        return
    }
    const note = inventory.linked.get(id)
    if (draft.recovery && ((inventory.unlinkedSchemaProblem && !draft.recovery.knownLayout) || exactMatch(draft.recovery, draft, inventory, t)?.id !== id)) throw new Error(t(
        'The proposed Anki link is no longer a unique exact match. Preview again.',
        'Предложенная связь с Anki больше не соответствует единственному точному совпадению. Повторите проверку.'))
    if (!note || note.modelName !== draft.model || note.cards.length !== 1 || draft.deck !== inventory.decks.get(note.cards[0]) ||
        JSON.stringify(note.fieldNames) !== JSON.stringify(draft.fields)) throw new Error(t('The original Anki model, card or deck could not be verified.', 'Не удалось подтвердить исходный тип, карточку или колоду Anki.'))
    const identity = draft.candidate.recoveryIdentity
    if (identity && ('tag' in identity ? !note.tags.includes(identity.tag) : note.fields[identity.field] !== identity.value)) throw new Error(t(
        'The source identity does not match the existing Anki note.', 'Ключ исходного плагина не совпадает с ключом записи Anki.'))
    if (draft.candidate.source === 'anki-forge' && draft.candidate.externalKey) {
        const existing = /^\^?(af-[a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(note.fields.ForgeKey ?? '')
        if (existing && draft.candidate.externalKey !== existing[1]) throw new Error(t(
            'The Forge key on this Anki note belongs to another source.', 'Ключ Forge этой записи Anki указывает на другой источник.'))
    }
    if (note.signature !== draft.originalSignature) throw new Error(t('The original Anki note changed. Preview again.', 'Исходная запись Anki изменилась. Повторите предпросмотр.'))
    const names = draft.candidate.fieldNames ?? draft.fields
    if (linkedField(note.fields[names[0]], draft, id) !== linkedField(draft.front, draft, id) ||
        linkedField(note.fields[names[1]], draft, id) !== linkedField(draft.back, draft, id)) throw new Error(t(
        'The question or answer differs in Anki. Compare both versions before migration.',
        'Вопрос или ответ отличаются в Anki. Сравните обе версии перед переносом.'))
}

// Восстановив запись через Undo в Anki, пользователь должен по-прежнему владеть её сохранённым ID.
function claimedNoteIds(text: string, syntax: DuplicateMarkerSyntax, foreign = foreignMigrationIds(text)): number[] {
    const ids = findIdMarkers(text, syntax).map(marker => marker.id)
    for (const id of foreign) ids.push(id)
    if (text.includes('RUDONIUM-ARCHIVE')) {
        for (const archive of archivedCardRanges(text)) ids.push(archive.id)
    }
    return ids
}

export async function previewPageMigration(plugin: MyPlugin, options: PageMigrationOptions, signal?: AbortSignal, progress?: Progress): Promise<PageMigrationPlan> {
    return withFastScanReadLock(plugin, async revision => {
        const t = uiFor(plugin.settings), { vault } = plugin.app
        const start = revision(), settings = signature(plugin)
        const folder = safeFolder(options.folder, t)
        const model = options.model
        checkModel(plugin, model, t)
        if (options.source && options.source !== 'auto' && !Object.prototype.hasOwnProperty.call(pluginIds, options.source))
            throw new Error(t('Unknown source plugin.', 'Неизвестный исходный плагин.'))
        const discovery = await detectMigrationContext(plugin)
        const context: MigrationContext = { ...discovery, source: (options.source ?? 'auto') as MigrationContext['source'], folder, t, syntax: plugin.settings.Syntax }
        const settingsForPage = { ...scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings)),
            PAGE_MODEL: model }
        const data = await settingToData(plugin.app, settingsForPage, plugin.fields_dict, [])
        const rows: PageMigrationRow[] = [], drafts: Draft[] = [], warnings: string[] = []
        const candidates: Array<{ candidate: MigrationCandidate; before: string; file: TFile; row: PageMigrationRow }> = []
        const owners = new Map<number, string>(), collisions = new Set<number>()
        const keyOwners = new Map<string, string>(), sharedKeys = new Set<string>()
        const unsaved = dirtyFiles(plugin)
        let scanned = 0
        const files = vault.getMarkdownFiles()
        const mark = (id: number, path: string) => {
            if (!owners.has(id)) owners.set(id, path)
            else if (owners.get(id) !== path) collisions.add(id)
        }
        const markKeys = (text: string, path: string) => {
            for (const key of foreignMigrationKeys(text)) {
                if (!keyOwners.has(key)) keyOwners.set(key, path)
                else if (keyOwners.get(key) !== path) sharedKeys.add(key)
            }
        }
        const editors = openSources(plugin)
        const editorsByPath = new Map<string, MarkdownView[]>()
        for (const view of editors) {
            const path = view.file!.path
            const group = editorsByPath.get(path)
            if (group) group.push(view)
            else editorsByPath.set(path, [view])
        }
        for (const file of files) {
            cancelled(signal)
            const path = file.path
            // Even a file outside the requested folder can already own an ID.
            const text = await vault.read(file)
            markKeys(text, path)
            const claimedIds = foreignMigrationIds(text)
            for (const id of claimedNoteIds(text, plugin.settings.Syntax, claimedIds)) mark(id, path)
            for (const view of editorsByPath.get(path) ?? []) {
                const current = view.getViewData()
                if (sameEditorText(current, text)) continue
                unsaved.add(path)
                markKeys(current, path)
                for (const id of claimedNoteIds(current, plugin.settings.Syntax)) mark(id, path)
            }
            progress?.(++scanned, files.length)
            if ((folder && folder !== '/' && !path.startsWith(folder + '/')) || isSyncAuditReportPath(path)) continue
            const candidate = inspectMigrationFile(path, text, context, claimedIds)
            if (!candidate) continue
            const row: PageMigrationRow = { path, source: candidate.source, status: candidate.status === 'already' ? 'already' : 'review', id: candidate.id }
            rows.push(row)
            if (candidate.status === 'already') continue
            if (candidate.id !== undefined) mark(candidate.id, path)
            if (candidate.status === 'review') { row.reason = candidate.reason; continue }
            if (unsaved.has(path)) { row.reason = t('Save the open edits and preview again.', 'Сохраните открытые правки и повторите предпросмотр.'); continue }
            candidates.push({ candidate, before: text, file, row })
        }
        for (const row of rows) {
            if (row.status === 'already' && row.id !== undefined && collisions.has(row.id)) {
                row.status = 'review'
                row.reason = t('Another Markdown file already references this note ID.', 'Этот ID уже указан в другом Markdown-файле.')
            }
        }
        const eligible = candidates.filter(({ candidate, row }) => {
            if (candidate.externalKey && sharedKeys.has(candidate.externalKey)) {
                row.reason = t('Another Markdown file has the same source key.', 'Тот же ключ исходного плагина указан в другом Markdown-файле.')
                return false
            }
            if (candidate.id && collisions.has(candidate.id)) {
                row.reason = t('Another Markdown file already references this note ID.', 'Этот ID уже указан в другом Markdown-файле.')
                return false
            }
            // Migrating a file with a saved ID can be verified directly. Search the Anki
            // collection for unlinked files only when the user requests the separate check.
            if (!candidate.id && !options.checkMissingIds) {
                row.status = 'unchecked'
                return false
            }
            return true
        })
        const expectedModelFor = (c: MigrationCandidate) => c.recoveryModel ?? c.model ?? model
        const hasKnownLayout = (c: MigrationCandidate) => {
            const name = expectedModelFor(c)
            return knownLayout(c, Object.prototype.hasOwnProperty.call(plugin.fields_dict, name) ? plugin.fields_dict[name] : [])
        }
        let inventory: Inventory | undefined
        // An incompatible default may still be used exclusively for matching a known source model.
        // The comparison model is ephemeral. The final file must parse again with the real settings and schema.
        const comparisonModel = '__Rudonium migration comparison__'
        const comparisonFields = ['Front', 'Back']
        let comparisonData: ReturnType<typeof settingToData> | undefined
        const buildDraft = async (item: typeof eligible[number], candidate: MigrationCandidate, linked?: Snapshot, probe = false): Promise<Draft> => {
            const { file, row, before: text } = item, path = row.path
            const actualModel = probe ? comparisonModel : linked?.modelName ?? model
            const fields = probe ? comparisonFields : Object.prototype.hasOwnProperty.call(plugin.fields_dict, actualModel) && plugin.fields_dict[actualModel]
            if (probe && !comparisonData) {
                const rules = Object.fromEntries(Object.entries(settingsForPage.CUSTOM_REGEXPS).filter(([, expr]) => expr !== pageCardExpression))
                comparisonData = settingToData(plugin.app, { ...settingsForPage, PAGE_MODEL: comparisonModel, CUSTOM_REGEXPS: rules },
                    { ...plugin.fields_dict, [comparisonModel]: comparisonFields }, [])
            }
            if (!fields || fields.length < 2) throw new Error(t('Refresh this original Anki note type in Rudonium: ', 'Обновите в Rudonium этот исходный тип Anki: ') + actualModel)
            const schemaProblem = checkRemoteSchema(candidate, fields, actualModel, t)
            if (schemaProblem) throw new Error(schemaProblem)
            if (linked) {
                const deck = inventory!.decks.get(linked.cards[0])
                if (linked.cards.length !== 1 || !deck || (candidate.deck && candidate.deck !== deck))
                    throw new Error(t('The source deck or original single-card layout could not be verified.', 'Не удалось подтвердить колоду или исходный шаблон с одной карточкой.'))
                if (linked.tags.some(tag => !tag || /[\s\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(tag) || isRecoveryTag(tag))) throw new Error(t(
                    'Review the invalid or pending recovery tags in Anki first.', 'Сначала проверьте в Anki некорректные теги или теги незавершённого восстановления.'))
                candidate = { ...candidate, linkedRoute: { model: actualModel, deck }, preservedTags: [...linked.tags] }
            }
            const after = renderMigrationPage(text, candidate, model, plugin.settings.Defaults?.['ID Comments'] !== false,
                pageIdLocation(plugin.settings.PAGE_ID_LOCATION), plugin.settings.Syntax)
            const parsed = await parsePortableMarkdown(plugin.app, probe ? (await comparisonData)! : data, file, after, candidate.id ? [candidate.id] : [], {
                preview: true, syntax: plugin.settings.Syntax, metadata: editorPreviewMetadata(after, plugin.app.metadataCache?.getCache(path)) })
            const cards = parsed.previewCandidates ?? []
            if (cards.length !== 1 || cards[0].identifier !== candidate.id || cards[0].note.modelName !== actualModel ||
                portableFileExportRules(parsed).some(rule => rule.problem || rule.mappedFields.length)) {
                throw new Error(t('The converted page does not produce exactly the expected card under the active export rules.',
                    'При текущих правилах экспорта страница не даёт одну карточку с ожидаемыми полями.'))
            }
            const note = cards[0].note
            if (linked) {
                const tags = new Set(note.tags.map(tag => tag.toLowerCase()))
                if (linked.tags.some(tag => !tags.has(tag.toLowerCase()))) throw new Error(t(
                    'The active export rules would drop original Anki tags.', 'Текущие правила экспорта удалили бы исходные теги Anki.'))
            }
            if (linked && candidate.deck && note.deckName !== candidate.deck) throw new Error(t('Match the Rudonium target deck to the source deck: ', 'Настройте в Rudonium исходную колоду: ') + candidate.deck)
            const names = candidate.id ? candidate.fieldNames ?? fields : fields
            const front = note.fields[names[0]], back = note.fields[names[1]]
            if (!front || !back) throw new Error(t('Front and back must both contain text.', 'Вопрос и ответ должны содержать текст.'))
            return { file, row, candidate, before: text, after, front, back, fields, model: actualModel, deck: note.deckName,
                originalSignature: linked?.signature, vaultName: vault.getName() }
        }
        // Build each unlinked preview once. Only plausible field matches need a deck lookup.
        const prepared = new Map<string, Draft>()
        const unlinked = eligible.filter(({ candidate }) => !candidate.id)
        const prepareContent = async (problem?: string) => {
            const wanted = new Set<string>()
            for (const item of unlinked) {
                cancelled(signal)
                try {
                    if (problem && !hasKnownLayout(item.candidate)) throw new Error(problem)
                    const draft = await buildDraft(item, item.candidate, undefined, !!problem)
                    prepared.set(item.row.path, draft)
                    wanted.add(contentKey(expectedModelFor(item.candidate), '', draft.front, draft.back))
                } catch (error) { item.row.reason = String(error instanceof Error ? error.message : error) }
            }
            return wanted
        }
        if (eligible.length) {
            try {
                inventory = await readInventory(plugin, new Set(eligible.flatMap(({ candidate }) => candidate.id ? [candidate.id] : [])),
                    !!unlinked.length, model, t, signal, undefined, unlinked.length ? {
                        models: new Set(unlinked.map(({ candidate }) => expectedModelFor(candidate))),
                        knownLayout: unlinked.some(({ candidate }) => hasKnownLayout(candidate)), content: prepareContent } : undefined)
            } catch (error) {
                cancelled(signal)
                const reason = t('Anki verification is incomplete. ', 'Проверка в Anki не завершилась. ') + String(error instanceof Error ? error.message : error)
                warnings.push(reason)
                for (const { row, candidate } of eligible) {
                    row.reason = reason
                    if (!candidate.id) row.status = 'unchecked'
                }
            }
        }
        const newPagesByFront = new Map<string, Draft[]>()
        const claimants = new Map<number, PageMigrationRow[]>()
        if (inventory) for (const item of eligible) {
            const { row, candidate } = item
            cancelled(signal)
            try {
                const linked = candidate.id ? inventory.linked.get(candidate.id) : undefined
                if (candidate.id && !linked) throw new Error(t('Note ID is missing in this Anki profile.', 'ID записи отсутствует в этом профиле Anki.'))
                let draft = linked ? await buildDraft(item, candidate, linked) : prepared.get(row.path)
                if (!draft) continue
                if (!candidate.id) {
                    const expectedModel = expectedModelFor(candidate)
                    const fields = Object.prototype.hasOwnProperty.call(plugin.fields_dict, expectedModel) ? plugin.fields_dict[expectedModel] : undefined
                    const specifiedPair = fields && sourcePageFields(candidate.source, fields)
                    const needsPair = candidate.source === 'anki-forge' || candidate.source === 'anki-bridge'
                    const target: RecoveryTarget | undefined = fields && fields.length >= 2 && (!needsPair || specifiedPair)
                        ? { front: draft.front, back: draft.back, model: expectedModel, deck: candidate.deck ?? draft.deck, fields,
                            names: candidate.fieldNames ?? specifiedPair ?? recoveryNames(expectedModel, fields), knownLayout: hasKnownLayout(candidate) } : undefined
                    const match = target && exactMatch(target, draft, inventory, t)
                    if (target && match) {
                        if (owners.has(match.id)) throw new Error(t('Another Markdown file already references this note ID.',
                            'Этот ID уже указан в другом Markdown-файле.'))
                        const claims = claimants.get(match.id)
                        if (claims) claims.push(row)
                        else claimants.set(match.id, [row])
                        draft = await buildDraft(item, { ...candidate, id: match.id, model: target.model,
                            fieldNames: candidate.fieldNames ?? target.names }, match)
                        draft.recovery = target
                        inventory.linked.set(match.id, match)
                        verifyDraft(draft, inventory, t)
                        row.link = Object.freeze({ id: match.id, model: match.modelName, deck: target.deck,
                            front: match.fields[target.names[0]], back: match.fields[target.names[1]] })
                    } else {
                        if (candidate.externalKey || candidate.needsLink) throw new Error(t('No unique Anki note matches the source link, fields, type and deck.',
                            'Для исходной связи не найдено единственного совпадения полей, типа записи и колоды в Anki.'))
                        verifyDraft(draft, inventory, t)
                        if (candidate.recoverOnly) { row.status = 'already'; continue }
                        if (candidate.deck && candidate.deck !== draft.deck) throw new Error(t('Match the Rudonium target deck to the source deck: ', 'Настройте в Rudonium исходную колоду: ') + candidate.deck)
                        const key = auditRepairFieldKey(draft.front)
                        const group = newPagesByFront.get(key)
                        if (group) group.push(draft)
                        else newPagesByFront.set(key, [draft])
                    }
                } else verifyDraft(draft, inventory, t)
                row.status = draft.recovery ? 'link' : 'ready'
                row.before = draft.before
                row.after = draft.after
                drafts.push(draft)
            } catch (error) { row.status = 'review'; row.reason = String(error instanceof Error ? error.message : error) }
        }
        for (const group of newPagesByFront.values()) if (group.length > 1) for (const draft of group)
            markReview(draft, t('Multiple unlinked files have the same question.', 'У нескольких файлов без ID одинаковый вопрос.'))
        for (const group of claimants.values()) if (group.length > 1) for (const row of group) {
            row.status = 'review'
            delete row.link
            delete row.after
            row.reason = t('Multiple files could claim this Anki note. Choose the original file before migration.',
                'На эту запись Anki претендуют несколько файлов. До переноса определите исходный файл.')
        }
        const profile = inventory?.profile
        const ready = drafts.filter(draft => draft.row.status === 'ready' || draft.row.status === 'link')
        for (const source of new Set(ready.map(draft => draft.candidate.source))) {
            const active = activeSourceId(plugin, source)
            if (active) warnings.push(t('Disable this source plugin before applying: ', 'Перед применением отключите исходный плагин: ') + active)
        }
        cancelled(signal)
        if (start !== revision() || settings !== signature(plugin)) throw new Error(t('The vault or settings changed. Open a fresh preview.', 'Хранилище или настройки изменились. Выполните новый предпросмотр.'))
        const plan = { model, profile, scanned, rows, warnings }
        for (const row of rows) Object.freeze(row)
        plans.set(plan, { plugin, settings, discovery: JSON.stringify(discovery), revision: start, profile, model, drafts: new Map(ready.map(d => [d.row.path, d])) })
        return plan
    }, true)
}

export function applyPageMigration(plugin: MyPlugin, plan: PageMigrationPlan, selected: ReadonlySet<string>,
    backupDirectory?: string, signal?: AbortSignal, progress?: Progress, allowUnlinked = false,
    confirmedLinks: ReadonlyMap<string, number> = new Map()): Promise<PageMigrationResult> {
    return withFastScanReadLock(plugin, async revision => {
        const stored = plans.get(plan), t = uiFor(plugin.settings), { vault } = plugin.app
        const stale = () => new Error(t('The migration preview is stale. Scan again.', 'Предпросмотр переноса устарел. Повторите сканирование.'))
        if (!stored || stored.plugin !== plugin || stored.revision !== revision() || stored.settings !== signature(plugin) || !stored.profile) throw stale()
        const matched = [...selected].map(path => stored.drafts.get(path))
        if (!matched.length || matched.some(draft => !draft)) throw stale()
        const drafts = matched as Draft[]
        if (drafts.some(draft => draft.recovery && confirmedLinks.get(draft.file.path) !== draft.candidate.id)) throw new Error(t(
            'Confirm each proposed note ID with “Link to this note”.', 'Подтвердите каждый предложенный ID кнопкой «Связать с этой записью».'))
        if (!allowUnlinked && drafts.some(draft => !draft.candidate.id)) throw new Error(t(
            'Confirm the unlinked notes selected for migration.', 'Подтвердите перенос выбранных записей без ID.'))
        const sources = new Set(drafts.map(draft => draft.candidate.source))
        const checkPlugins = () => {
            if (hasPendingAnkiWrite(plugin.app) || hasPendingBidirectionalWrite(plugin.app)) throw new Error(t(
                'Wait for the previous Anki write to finish.', 'Дождитесь завершения предыдущей записи в Anki.'))
            for (const source of sources) {
                const active = activeSourceId(plugin, source)
                if (active) throw new Error(t('Disable this source plugin and retry: ', 'Отключите исходный плагин и повторите: ') + active)
            }
        }
        const recheck = async () => {
            checkPlugins()
            cancelled(signal)
            if (stored.discovery !== JSON.stringify(await detectMigrationContext(plugin))) throw stale()
            const unsaved = dirtyFiles(plugin)
            const selectedIds = new Map(drafts.filter(draft => draft.candidate.id).map(draft => [draft.candidate.id!, draft.row.path]))
            for (const view of openSources(plugin)) {
                const path = view.file!.path
                const text = view.getViewData()
                if (sameEditorText(text, await vault.read(view.file!))) continue
                unsaved.add(path)
                const ids = claimedNoteIds(text, plugin.settings.Syntax)
                if (ids.some(id => selectedIds.has(id) && selectedIds.get(id) !== path)) throw stale()
            }
            for (const draft of drafts) {
                cancelled(signal)
                if (unsaved.has(draft.row.path) || vault.getAbstractFileByPath(draft.row.path) !== draft.file ||
                    await vault.read(draft.file) !== draft.before) throw stale()
            }
            if (stored.settings !== signature(plugin) || stored.revision !== revision()) throw stale()
        }
        await recheck()
        const archive = await createFullMigrationBackup(plugin, backupDirectory)
        const result: PageMigrationResult = { archive, converted: [] }
        try {
            await recheck()
            // A recovered ID did not belong to this source during preview. Re-read all Markdown
            // owners after the backup, including files outside the chosen folder and open edits.
            const recovering = drafts.filter(draft => draft.recovery)
            if (recovering.length) {
                const ids = new Set(recovering.map(draft => draft.candidate.id!))
                const keys = new Map(recovering.flatMap(draft => draft.candidate.externalKey
                    ? [[draft.candidate.externalKey, draft.row.path] as const] : []))
                const checkOwner = (path: string, text: string) => {
                    if (claimedNoteIds(text, plugin.settings.Syntax).some(id => ids.has(id)) ||
                        foreignMigrationKeys(text).some(key => keys.has(key) && keys.get(key) !== path)) throw stale()
                }
                for (const file of vault.getMarkdownFiles()) {
                    cancelled(signal)
                    checkOwner(file.path, await vault.read(file))
                }
                for (const view of openSources(plugin)) checkOwner(view.file!.path, view.getViewData())
            }
            if (stored.settings !== signature(plugin) || stored.revision !== revision()) throw stale()
            const remote = await readInventory(plugin, new Set(drafts.flatMap(draft => draft.candidate.id ? [draft.candidate.id] : [])),
                drafts.some(draft => !draft.candidate.id || !!draft.recovery), stored.model, t, signal, stored.profile,
                recovering.length ? {
                    models: new Set(recovering.map(draft => draft.recovery!.model)),
                    knownLayout: recovering.some(draft => draft.recovery!.knownLayout),
                    content: () => new Set(recovering.map(draft => { const r = draft.recovery!; return contentKey(r.model, '', r.front, r.back) })),
                } : undefined)
            for (const draft of drafts) {
                try { verifyDraft(draft, remote, t) }
                catch (error) { throw new Error(draft.row.path + ' — ' + String(error instanceof Error ? error.message : error)) }
            }
            if (stored.settings !== signature(plugin) || stored.revision !== revision()) throw stale()
            const editorClaims = new WeakMap<MarkdownView, { text: string; ids: Set<number>; keys: Set<string> }>()
            const claimedInEditor = (draft: Draft) => {
                if (!draft.candidate.id) return false
                for (const view of openSources(plugin)) {
                    if (view.file!.path === draft.row.path) continue
                    const text = view.getViewData()
                    let claims = editorClaims.get(view)
                    if (!claims || claims.text !== text) {
                        claims = { text, ids: new Set(claimedNoteIds(text, plugin.settings.Syntax)),
                            keys: new Set(foreignMigrationKeys(text)) }
                        editorClaims.set(view, claims)
                    }
                    if (claims.ids.has(draft.candidate.id!) || draft.candidate.externalKey && claims.keys.has(draft.candidate.externalKey)) return true
                }
                return false
            }
            // One allowance per deliberate Vault.process write. Any other vault edit stops the rest of the batch.
            const expected = new Set<string>()
            let interrupted = false
            const changes = [
                vault.on('modify', file => { if (!expected.delete(file.path)) interrupted = true }),
                vault.on('create', () => { interrupted = true }), vault.on('delete', () => { interrupted = true }),
                vault.on('rename', () => { interrupted = true }),
            ]
            let undoSettings: (() => void) | undefined
            let uncertainWrite = false
            try {
                cancelled(signal)
                checkPlugins()
                if (plugin.settings.CUSTOM_REGEXPS[stored.model] !== pageCardExpression && plugin.settings.PAGE_MODEL !== stored.model) {
                    const old = plugin.settings.PAGE_MODEL
                    plugin.settings.PAGE_MODEL = stored.model
                    undoSettings = () => {
                        if (plugin.settings.PAGE_MODEL !== stored.model) return
                        if (old === undefined) delete plugin.settings.PAGE_MODEL
                        else plugin.settings.PAGE_MODEL = old
                    }
                    await plugin.saveAllData()
                }
                const activeSettings = signature(plugin)
                for (const draft of drafts) {
                    cancelled(signal)
                    checkPlugins()
                    const path = draft.row.path
                    if (interrupted || activeSettings !== signature(plugin) || dirtyFiles(plugin).has(path) ||
                        vault.getAbstractFileByPath(path) !== draft.file) throw stale()
                    expected.add(path)
                    try {
                        await vault.process(draft.file, current => {
                            if (interrupted || current !== draft.before || dirtyFiles(plugin).has(path) || draft.file.path !== path || claimedInEditor(draft)) throw stale()
                            return draft.after
                        })
                    } catch (error) {
                        // A filesystem provider can report failure after the write actually completed.
                        uncertainWrite = true
                        const actual = await vault.read(draft.file)
                        if (actual === draft.after) result.converted.push(path)
                        uncertainWrite = actual !== draft.before && actual !== draft.after
                        throw error
                    }
                    result.converted.push(path)
                    progress?.(result.converted.length, drafts.length)
                }
            } catch (error) {
                // After the first conversion the @page setting must stay available for the converted files.
                if (!result.converted.length && !uncertainWrite && undoSettings) { undoSettings(); await plugin.saveAllData() }
                throw error
            } finally { for (const ref of changes) vault.offref(ref) }
        } catch (error) {
            result.stopped = String(error instanceof Error ? error.message : error)
        } finally { plans.delete(plan) }
        return result
    })
}
