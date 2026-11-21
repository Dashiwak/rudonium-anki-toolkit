/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { MarkdownView, TFile } from 'obsidian'
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import { AnkiProfileError, profileProblemText, requireExpectedAnkiProfile } from './anki-profile'
import { hasPendingAnkiWrite, withAnkiWriteDeadline } from './anki-transport'
import { readAnkiDeckEntries } from './anki-study-state'
import { hasPendingBidirectionalWrite } from './bidirectional-sync'
import { editorPreviewMetadata } from './card-preview-metadata'
import { pageFooterId } from './anki-id-marker'
import { pageYamlId } from './page-frontmatter'
import { archivedIdMarkers, findIdMarkers } from './duplicate-markers'
import { settingsWithoutAuditMode, withFastScanReadLock } from './fast-scan'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { auditRepairFieldKey, inspectAuditRepairSource, readAuditRepairNotes } from './audit-repair-match'
import type { AuditRepairCandidate, AuditRepairRow, AuditRepairSource } from './audit-repair-match'
import { auditRead, checkAnkiNoteExistence, readSyncAuditNoteInventory, syncAuditDeckKey } from './sync-audit'
import { describeSyncPath, isSyncAuditReportPath, scanProfileFreeSettings, syncScopeSignature } from './sync-profiles'
import { settingToData } from './setting-to-data'
import { parsePortableMarkdown } from './portable-parser'
import { indexVaultIds } from './vault-id-index'

export type AuditRepairAction = 'replace-id' | 'delete-anki' | 'delete-obsidian'

export interface AuditRepairSelection {
    readonly row: AuditRepairRow
    readonly candidateId?: number
}

export interface AuditRepairResult {
    readonly status: 'applied' | 'failed' | 'needs-local-unlink' | 'needs-verification'
    readonly path: string
    readonly oldId: number
    readonly candidateId?: number
    readonly message?: string
}

export interface PendingAuditRepair {
    readonly token: string
    readonly path: string
    readonly oldId: number
    readonly candidateId: number
}

interface AuditRepairIntent extends PendingAuditRepair {
    readonly version: 1
    readonly profile: string
    readonly afterHash: string
    readonly blockHash: string
    readonly blockLength: number
    readonly digitsInBlock: number
    readonly markerStartInBlock: number
    readonly markerEndInBlock: number
}

interface FileChange {
    readonly file: TFile
    readonly path: string
    readonly before: string
    readonly after: string
    readonly blockStart: number
    readonly blockEnd: number
}

type ReadRevision = () => number
type PathRevision = (path: string) => number

const intentPrefix = 'audit-repair-intent-'
const intentName = /^audit-repair-intent-([a-f0-9]{32})\.json$/
const lineBreak = /\r\n?|\n/g
const localRepairError = Symbol('audit repair error')

function problem(message: string): Error {
    return Object.assign(new Error(message), { [localRepairError]: true })
}

function failure(error: unknown, t: UiText): string {
    if (error instanceof AnkiProfileError) return profileProblemText(error, t)
    if (error instanceof Error && localRepairError in error) return error.message
    if (error instanceof DOMException && error.name === 'AbortError') return t('Repair cancelled.', 'Исправление отменено.')
    if (error instanceof DOMException && error.name === 'TimeoutError') return t(
        'AnkiConnect did not respond in time. Check the connection and audit again.',
        'AnkiConnect не ответил вовремя. Проверьте связь и повторите аудит.')
    console.warn('[Export to Anki] Ошибка исправления связи', error)
    return t('The correction could not be verified. Check the audit and try again.',
        'Не удалось подтвердить исправление. Проверьте результаты аудита и повторите попытку.')
}

function cancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Исправление отменено.', 'AbortError')
}

function isId(id: unknown): id is number {
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
}

function busy(plugin: MyPlugin, t: UiText): void {
    if (hasPendingAnkiWrite(plugin.app) || hasPendingBidirectionalWrite(plugin.app)) {
        throw problem(t('Wait for the previous Anki operation to finish.', 'Дождитесь завершения предыдущей операции с Anki.'))
    }
}

function changed(t: UiText): Error {
    return problem(t('The source, scope or settings changed. Run the audit again.',
        'Исходник, область проверки или настройки изменились. Проведите аудит заново.'))
}

function registeredFile(plugin: MyPlugin, path: string, t: UiText): TFile {
    const file = plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md' || isSyncAuditReportPath(path) || file.path !== path) {
        throw changed(t)
    }
    if (!describeSyncPath(plugin, path).included) throw problem(t('The file is outside the active sync profile.',
        'Файл находится вне выбранного профиля синхронизации.'))
    return file
}

function checkOpenEditors(plugin: MyPlugin, path: string, ids: readonly number[], t: UiText): void {
    for (const { view } of plugin.app.workspace.getLeavesOfType('markdown')) {
        if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file) continue
        const text = view.getViewData()
        if (text.replace(/\r\n/g, '\n') === view.data.replace(/\r\n/g, '\n')) continue
        if (view.file.path === path || findIdMarkers(text, plugin.settings.Syntax).some(marker => ids.includes(marker.id)) ||
            archivedIdMarkers(text).some(marker => ids.includes(marker.id))) {
            throw problem(t(`Save the unsaved changes in ${view.file.path} before repairing.`,
                `Сохраните правки в файле ${view.file.path} перед исправлением связи.`))
        }
    }
}

function lineStart(text: string, line: number): number {
    if (line === 1) return 0
    let nextLine = 2
    for (const match of text.matchAll(lineBreak)) {
        if (nextLine++ === line) return match.index! + match[0].length
    }
    return -1
}

function digitOffset(plugin: MyPlugin, text: string, id: number, t: UiText): number {
    const markers = findIdMarkers(text, plugin.settings.Syntax).filter(marker => marker.id === id)
    if (markers.length !== 1) throw changed(t)
    const marker = markers[0]
    const pageLink = marker.location === 'yaml' ? pageYamlId(text) : (text.includes('@page') ? pageFooterId(text) : undefined)
    if (pageLink && pageLink.id === id && pageLink.line === marker.line) return pageLink.digitsStart
    const start = lineStart(text, marker.line)
    if (start < 0 || text.slice(start + marker.column, start + marker.column + 4) !== 'ID: ') throw changed(t)
    return start + marker.column + 4
}

function assertMarkerRange(source: AuditRepairSource, id: number, t: UiText): void {
    const offsets = [source.blockStart, source.blockEnd, source.markerStart, source.markerEnd, source.markerLineStart, source.markerLineEnd]
    if (!offsets.every(offset => Number.isSafeInteger(offset) && offset >= 0) ||
        source.blockStart > source.markerLineStart || source.markerLineStart > source.markerStart ||
        source.markerStart >= source.markerEnd || source.markerEnd > source.markerLineEnd || source.markerLineEnd > source.blockEnd ||
        source.blockEnd - source.blockStart !== source.blockText.length ||
        source.blockText.slice(source.markerLineStart - source.blockStart, source.markerLineEnd - source.blockStart) !== source.markerText) {
        throw changed(t)
    }
    const digits = source.blockText.slice(source.markerStart - source.blockStart, source.markerEnd - source.blockStart)
    if (!/^\d+$/.test(digits) || Number(digits) !== id) throw changed(t)
}

async function readChange(plugin: MyPlugin, source: AuditRepairSource, id: number, action: AuditRepairAction,
    candidateId: number | undefined, t: UiText, signal?: AbortSignal): Promise<FileChange> {
    assertMarkerRange(source, id, t)
    const file = registeredFile(plugin, source.path, t)
    checkOpenEditors(plugin, file.path, candidateId === undefined ? [id] : [id, candidateId], t)
    const before = await plugin.app.vault.read(file)
    const digits = digitOffset(plugin, before, id, t)
    const shift = digits - source.markerStart
    const blockStart = source.blockStart + shift
    const oldEnd = source.blockEnd + shift
    if (blockStart < 0 || before.slice(blockStart, oldEnd) !== source.blockText) throw changed(t)
    // Предыдущая строка в том же пакете могла сдвинуть блок. Геометрия берётся из
    // нового текста, а содержимое и границы повторно сверяются штатным парсером.
    const lineAt = (offset: number) => {
        let line = 1
        for (const match of before.matchAll(lineBreak)) {
            if (match.index! + match[0].length > offset) break
            line++
        }
        return line
    }
    const fresh = await inspectAuditRepairSource(plugin, file, before,
        { ...source, line: lineAt(blockStart), endLine: lineAt(oldEnd - 1), markerLine: lineAt(digits) }, signal)
    if (!fresh || fresh.blockStart !== blockStart || fresh.blockEnd !== oldEnd ||
        fresh.markerStart !== digits || fresh.markerEnd !== source.markerEnd + shift ||
        fresh.markerLineStart !== source.markerLineStart + shift || fresh.markerLineEnd !== source.markerLineEnd + shift ||
        fresh.modelName !== source.modelName || fresh.firstField !== source.firstField ||
        Object.keys(fresh.fields).length !== Object.keys(source.fields).length ||
        Object.entries(source.fields).some(([name, value]) => fresh.fields[name] !== value)) throw changed(t)
    if (action === 'delete-obsidian' && fresh.wholePage) {
        throw problem(t('Open the page in Obsidian to edit or remove its contents.',
            'Откройте страницу в Obsidian, чтобы изменить или удалить её содержимое.'))
    }
    const from = action === 'delete-obsidian' ? blockStart : action === 'replace-id' ? digits : fresh.markerLineStart
    const until = action === 'delete-obsidian' ? oldEnd : action === 'replace-id' ? fresh.markerEnd : fresh.markerLineEnd
    const replacement = action === 'replace-id' ? String(candidateId) : ''
    const after = before.slice(0, from) + replacement + before.slice(until)
    const markers = findIdMarkers(after, plugin.settings.Syntax)
    if (markers.some(marker => marker.id === id) || (action === 'replace-id' && markers.filter(marker => marker.id === candidateId).length !== 1)) {
        throw changed(t)
    }
    return { file, path: source.path, before, after, blockStart, blockEnd: oldEnd + replacement.length - (until - from) }
}

async function requireUnlinkedDraft(plugin: MyPlugin, change: FileChange, candidate: AuditRepairCandidate,
    t: UiText, signal?: AbortSignal): Promise<void> {
    const settings = scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings))
    const ids = [...new Set(findIdMarkers(change.after, settings.Syntax).map(marker => marker.id))]
    const data = await settingToData(plugin.app, settings, plugin.fields_dict, ids)
    cancelled(signal)
    const metadata = editorPreviewMetadata(change.after, plugin.app.metadataCache.getCache(change.file.path))
    const parsed = await parsePortableMarkdown(plugin.app, data, change.file, change.after, ids, { preview: true, metadata,
        syntax: settings.Syntax, noteTypes: new Set(Object.keys(plugin.fields_dict)), regexpOptions: { shouldStop: () => signal?.aborted === true } })
    const drafts = (parsed.previewCandidates ?? []).filter(card => !card.identifier &&
        card.start >= change.blockStart && card.end <= change.blockEnd)
    const firstField = plugin.fields_dict[candidate.modelName]?.[0]
    const first = drafts.length === 1 && firstField ? drafts[0].note.fields[firstField] : undefined
    if (drafts.length !== 1 || drafts[0].note.modelName !== candidate.modelName || typeof first !== 'string' ||
        auditRepairFieldKey(first) !== auditRepairFieldKey(candidate.firstField)) {
        throw problem(t('The remaining Markdown is not recognised as one new card. Fix the card format and audit again. Anki was not changed.',
            'Markdown без ID не распознаётся как одна новая карточка. Исправьте формат и проведите аудит заново. В Anki ничего не изменилось.'))
    }
}

async function ownedIds(plugin: MyPlugin, pathRevision: PathRevision, force: boolean, t: UiText, signal?: AbortSignal) {
    const files = plugin.app.vault.getMarkdownFiles().filter(file => !isSyncAuditReportPath(file.path))
    const inventory = await indexVaultIds(plugin, files, plugin.settings.Syntax, pathRevision, { includeArchivedOwners: true, force, shouldStop: () => signal?.aborted === true })
    cancelled(signal)
    if (!inventory.complete) throw problem(t('Unable to verify all Markdown files for duplicate IDs.',
        'Не удалось проверить все файлы Markdown на повторяющиеся ID.'))
    return inventory
}

async function remotePresence(ids: readonly number[], t: UiText, signal?: AbortSignal): Promise<Map<number, boolean>> {
    const errors: string[] = []
    const presence = await checkAnkiNoteExistence(ids, errors, signal)
    if (errors.length || ids.some(id => !presence.has(id))) throw problem(t('Anki did not confirm these IDs. Run the audit again.',
        'Anki не подтвердила состояние этих ID. Проведите аудит заново.'))
    return presence
}

type DeckEntries = Awaited<ReturnType<typeof readAnkiDeckEntries>>

async function confirmCandidateDeck(deck: string, candidate: AuditRepairCandidate, numericDecks: DeckEntries | undefined,
    t: UiText, signal?: AbortSignal): Promise<void> {
    const key = syncAuditDeckKey(deck)
    const numeric = numericDecks?.get(key)?.id
    if (numeric !== undefined) {
        try {
            const cards = await auditRead('findCards', { query: `nid:${candidate.id} did:${numeric}` }, signal)
            if (Array.isArray(cards) && cards.length && cards.every(id => candidate.cards.includes(id))) {
                const details = await auditRead('cardsInfo', { cards }, signal)
                if (Array.isArray(details) && details.some(row => row && cards.includes(row.cardId) &&
                    row.note === candidate.id && typeof row.deckName === 'string' && syncAuditDeckKey(row.deckName) === key)) return
            }
        } catch (error) {
            cancelled(signal)
            if (error instanceof DOMException && error.name === 'TimeoutError') throw error
        }
    }
    // Старые AnkiConnect и временные колоды требуют той же проверки точного
    // состава колоды, которая используется при поиске соответствий.
    if (!(await readSyncAuditNoteInventory(deck, signal))?.has(candidate.id)) throw problem(t(
        'The Anki note is no longer confirmed in the audited deck. Run the audit again.',
        'Запись больше не подтверждается в проверяемой колоде Anki. Проведите аудит заново.'))
}

function configuration(plugin: MyPlugin): string {
    return JSON.stringify([syncScopeSignature(plugin.settings), settingsWithoutAuditMode(plugin.settings), plugin.fields_dict])
}

function ensureUnchanged(plugin: MyPlugin, original: string, revision: number, currentRevision: ReadRevision, t: UiText,
    signal?: AbortSignal): void {
    cancelled(signal)
    if (configuration(plugin) !== original || currentRevision() !== revision) throw changed(t)
}

async function writeLocal(plugin: MyPlugin, change: FileChange, ids: readonly number[], validate: () => void, t: UiText): Promise<void> {
    const { vault } = plugin.app
    await vault.process(change.file, text => {
        validate()
        if (registeredFile(plugin, change.path, t) !== change.file || text !== change.before) throw changed(t)
        checkOpenEditors(plugin, change.path, ids, t)
        return change.after
    })
    if (await vault.read(change.file) !== change.after) throw changed(t)
}

function journalDirectory(plugin: MyPlugin): string {
    return plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
}

function journalPath(plugin: MyPlugin, token: string): string {
    return `${journalDirectory(plugin)}/${intentPrefix}${token}.json`
}

function isHash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isIntent(value: unknown, token: string): value is AuditRepairIntent {
    if (!value || typeof value !== 'object') return false
    const row = value as Partial<AuditRepairIntent>
    return row.version === 1 && row.token === token && typeof row.profile === 'string' && !!row.profile &&
        typeof row.path === 'string' && !!row.path && isId(row.oldId) && isId(row.candidateId) && row.oldId !== row.candidateId &&
        isHash(row.afterHash) && isHash(row.blockHash) && typeof row.blockLength === 'number' &&
        typeof row.digitsInBlock === 'number' && typeof row.markerStartInBlock === 'number' && typeof row.markerEndInBlock === 'number' &&
        [row.blockLength, row.digitsInBlock, row.markerStartInBlock, row.markerEndInBlock].every(n => Number.isSafeInteger(n) && n >= 0) &&
        row.markerStartInBlock <= row.digitsInBlock && row.digitsInBlock < row.markerEndInBlock && row.markerEndInBlock <= row.blockLength
}

async function readIntent(plugin: MyPlugin, token: string, t: UiText): Promise<AuditRepairIntent> {
    if (!/^[a-f0-9]{32}$/.test(token)) throw changed(t)
    const raw: unknown = JSON.parse(await plugin.app.vault.adapter.read(journalPath(plugin, token)))
    if (!isIntent(raw, token)) throw problem(t('A pending audit repair could not be read. Check the previous operation before making changes.',
        'Не удалось прочитать журнал исправления. Проверьте предыдущую операцию перед изменением записей.'))
    return raw
}

async function intents(plugin: MyPlugin, profile: string, t: UiText): Promise<AuditRepairIntent[]> {
    const directory = journalDirectory(plugin)
    const adapter = plugin.app.vault.adapter
    if (!await adapter.exists(directory)) return []
    const { files } = await adapter.list(directory)
    const result: AuditRepairIntent[] = []
    for (const file of files) {
        const match = intentName.exec(file.slice(file.lastIndexOf('/') + 1))
        if (!match) continue
        const intent = await readIntent(plugin, match[1], t)
        if (intent.profile === profile) result.push(intent)
    }
    return result
}

export async function readPendingAuditRepairs(plugin: MyPlugin, profile: string): Promise<PendingAuditRepair[]> {
    const t = uiFor(plugin.settings)
    try {
        return (await intents(plugin, profile, t)).map(({ token, oldId, candidateId, path }) => ({ token, oldId, candidateId, path }))
    } catch (error) {
        throw problem(failure(error, t))
    }
}

async function hash(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function saveIntent(plugin: MyPlugin, profile: string, source: AuditRepairSource, oldId: number, candidateId: number,
    change: FileChange, t: UiText): Promise<AuditRepairIntent> {
    const random = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const token = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')
    const [afterHash, blockHash] = await Promise.all([hash(change.after), hash(source.blockText)])
    const intent: AuditRepairIntent = { version: 1, token, profile, path: source.path, oldId, candidateId, afterHash, blockHash,
        blockLength: source.blockText.length, digitsInBlock: source.markerStart - source.blockStart,
        markerStartInBlock: source.markerLineStart - source.blockStart, markerEndInBlock: source.markerLineEnd - source.blockStart }
    const data = JSON.stringify(intent)
    const path = journalPath(plugin, token)
    const temp = `${path}.part`
    const adapter = plugin.app.vault.adapter
    if (await adapter.exists(path) || await adapter.exists(temp)) throw changed(t)
    // Запрос в Anki отправляется только после проверки сохранённого намерения.
    // При обрыве записи временный файл не попадёт в список незавершённых действий.
    await adapter.write(temp, data)
    if (await adapter.read(temp) !== data) throw changed(t)
    await adapter.rename(temp, path)
    if (await adapter.read(path) !== data) throw changed(t)
    return intent
}

async function removeIntent(plugin: MyPlugin, token: string): Promise<void> {
    const adapter = plugin.app.vault.adapter
    const path = journalPath(plugin, token)
    if (await adapter.exists(path)) await adapter.remove(path)
}

function repeats(ids: readonly number[]): Set<number> {
    const seen = new Set<number>()
    const duplicate = new Set<number>()
    for (const id of ids) {
        if (seen.has(id)) duplicate.add(id)
        seen.add(id)
    }
    return duplicate
}

export async function applyAuditRepairs(plugin: MyPlugin, input: {
    readonly profile: string
    readonly deck?: string
    readonly scopeSignature?: string
    readonly action: AuditRepairAction
    readonly rows: readonly AuditRepairSelection[]
    readonly signal?: AbortSignal
}): Promise<AuditRepairResult[]> {
    const t = uiFor(plugin.settings)
    const { action, profile, signal } = input
    try {
        return await withFastScanReadLock(plugin, async (currentRevision, pathRevision) => {
            cancelled(signal)
            busy(plugin, t)
            if (!profile || input.scopeSignature !== undefined && syncScopeSignature(plugin.settings) !== input.scopeSignature ||
                !['replace-id', 'delete-anki', 'delete-obsidian'].includes(action)) throw changed(t)
            if (typeof plugin.app.vault.process !== 'function') throw problem(t('Update Obsidian to a version that supports Vault.process.',
                'Обновите Obsidian до версии с поддержкой Vault.process.'))
            const original = configuration(plugin)
            await requireExpectedAnkiProfile(plugin, profile, signal)
            const numericDecks = action === 'delete-obsidian' ? undefined : await readAnkiDeckEntries(
                (request, params = {}) => auditRead(request, params, signal)).catch(error => {
                cancelled(signal)
                if (error instanceof DOMException && error.name === 'TimeoutError') throw error
                return undefined
            })
            const pending = await intents(plugin, profile, t)
            const duplicatedOld = repeats(input.rows.map(item => item.row.id))
            const duplicatedCandidates = repeats(action === 'delete-obsidian' ? [] : input.rows.flatMap(item => item.candidateId === undefined ? [] : [item.candidateId]))
            const results: AuditRepairResult[] = []
            for (const { row, candidateId } of input.rows) {
                if (signal?.aborted) break
                const source = row.source
                const item = { path: source?.path ?? '', oldId: row.id, candidateId }
                let intent: AuditRepairIntent | undefined
                let dispatched = false
                let deleted = false
                try {
                    busy(plugin, t)
                    if (!source || !isId(row.id) || duplicatedOld.has(row.id) ||
                        (candidateId !== undefined && duplicatedCandidates.has(candidateId))) throw problem(t(
                        'The selection contains repeated IDs or a source without verified boundaries.',
                        'В выборе повторяется ID или не подтверждены границы карточки.'))
                    if (pending.some(saved => saved.oldId === row.id || (action !== 'delete-obsidian' && saved.candidateId === candidateId))) {
                        throw problem(t('Review the pending repair for this ID first.', 'Сначала проверьте незавершённое исправление с этим ID.'))
                    }
                    const revision = currentRevision()
                    const validate = () => ensureUnchanged(plugin, original, revision, currentRevision, t, signal)
                    const index = await ownedIds(plugin, pathRevision, results.length === 0, t, signal)
                    if (index.first.get(row.id)?.path !== source.path || index.duplicates.has(row.id)) throw changed(t)
                    const candidate = action === 'delete-obsidian' ? undefined : row.candidates.find(value => value.id === candidateId)
                    if (action !== 'delete-obsidian' && (!candidate?.eligible || !isId(candidate.id) || candidate.id === row.id || index.first.has(candidate.id))) {
                        throw problem(t('Choose a verified matching Anki note whose ID is not used in Obsidian.',
                            'Выберите подтверждённое совпадение в Anki, ID которого свободен в Obsidian.'))
                    }
                    const change = await readChange(plugin, source, row.id, action, candidate?.id, t, signal)
                    const ids = candidate ? [row.id, candidate.id] : [row.id]
                    if (action === 'delete-anki' && candidate) await requireUnlinkedDraft(plugin, change, candidate, t, signal)
                    if (action === 'delete-anki' && candidate) {
                        intent = await saveIntent(plugin, profile, source, row.id, candidate.id, change, t)
                        pending.push(intent)
                    }
                    await requireExpectedAnkiProfile(plugin, profile, signal)
                    const presence = await remotePresence(ids, t, signal)
                    if (presence.get(row.id) !== false) throw problem(t('The original ID exists in Anki again. Run the audit again.',
                        'Исходный ID снова есть в Anki. Проведите аудит заново.'))
                    if (candidate) {
                        const fresh = presence.get(candidate.id) === true ? (await readAuditRepairNotes([candidate.id], signal)).get(candidate.id) : undefined
                        if (!fresh || fresh.signature !== candidate.signature ||
                            auditRepairFieldKey(fresh.firstField) !== auditRepairFieldKey(source.firstField)) throw problem(t('The matching Anki note changed. Run a fresh search.',
                            'Найденная запись Anki изменилась. Выполните новый поиск.'))
                        const deck = input.deck ?? source.assignedDeck
                        if (!deck?.trim()) throw changed(t)
                        await confirmCandidateDeck(deck, candidate, numericDecks, t, signal)
                    }
                    await requireExpectedAnkiProfile(plugin, profile, signal)
                    validate()
                    checkOpenEditors(plugin, source.path, ids, t)
                    if (registeredFile(plugin, source.path, t) !== change.file || await plugin.app.vault.read(change.file) !== change.before) throw changed(t)
                    validate()
                    if (intent) {
                        dispatched = true
                        try {
                            await withAnkiWriteDeadline(plugin.app, () => AnkiConnect.invoke('deleteNotes', { notes: [intent!.candidateId] }),
                                'Удаление записи Anki')
                        } catch (error) {
                            console.warn('[Export to Anki] AnkiConnect не подтвердил удаление', error)
                        }
                        // Даже после потери ответа удаление повторно не отправляется.
                        // Отсутствие записи проверяется новым запросом к тому же профилю.
                        busy(plugin, t)
                        await requireExpectedAnkiProfile(plugin, profile, signal)
                        const after = await remotePresence(ids, t, signal)
                        deleted = after.get(intent.candidateId) === false
                        if (!deleted || after.get(row.id) !== false) throw problem(t('The deletion could not be confirmed.',
                            'Не удалось подтвердить удаление.'))
                        await requireExpectedAnkiProfile(plugin, profile, signal)
                    }
                    await writeLocal(plugin, change, ids, validate, t)
                    if (intent) await removeIntent(plugin, intent.token)
                    results.push({ ...item, status: 'applied' })
                } catch (error) {
                    if (intent && !dispatched) {
                        try { await removeIntent(plugin, intent.token) } catch (cleanupError) {
                            console.warn('[Export to Anki] Не удалось очистить журнал исправления', cleanupError)
                        }
                    }
                    const status = !dispatched ? 'failed' : deleted ? 'needs-local-unlink' : 'needs-verification'
                    const followup = status === 'needs-local-unlink' ? t('Anki confirmed deletion. Finish unlinking in Pending Repairs.',
                        'Anki подтвердила удаление. Завершите снятие связи в незавершённых исправлениях.') : status === 'needs-verification' ?
                        t('Check Pending Repairs for the result of the Anki request.', 'Проверьте результат запроса к Anki в незавершённых исправлениях.') : ''
                    results.push({ ...item, status, message: [failure(error, t), followup].filter(Boolean).join(' ') })
                }
            }
            return results
        })
    } catch (error) {
        throw problem(failure(error, t))
    }
}

export async function finishAuditRepairUnlink(plugin: MyPlugin, profile: string, token: string,
    signal?: AbortSignal): Promise<AuditRepairResult> {
    const t = uiFor(plugin.settings)
    try {
        return await withFastScanReadLock<AuditRepairResult>(plugin, async (currentRevision, pathRevision) => {
            cancelled(signal)
            busy(plugin, t)
            const intent = await readIntent(plugin, token, t)
            const { oldId, candidateId, path } = intent
            const base = { oldId, candidateId, path }
            if (intent.profile !== profile) throw changed(t)
            if (typeof plugin.app.vault.process !== 'function') throw problem(t('Update Obsidian to a version that supports Vault.process.',
                'Обновите Obsidian до версии с поддержкой Vault.process.'))
            await requireExpectedAnkiProfile(plugin, profile, signal)
            const presence = await remotePresence([oldId, candidateId], t, signal)
            await requireExpectedAnkiProfile(plugin, profile, signal)
            if (presence.get(candidateId) === true) {
                await removeIntent(plugin, token)
                return { ...base, status: 'failed', message: t('The record still exists in Anki. Nothing was removed from Markdown. Run a new audit.',
                    'Запись по-прежнему есть в Anki. Markdown сохранён. Проведите новый аудит.') }
            }
            if (presence.get(oldId) !== false) return { ...base, status: 'needs-local-unlink', message: t(
                'The original ID exists in Anki again. Inspect this link in the audit.', 'Исходный ID снова есть в Anki. Проверьте связь в аудите.') }
            const revision = currentRevision()
            const original = configuration(plugin)
            const validate = () => ensureUnchanged(plugin, original, revision, currentRevision, t, signal)
            checkOpenEditors(plugin, path, [oldId, candidateId], t)
            const savedFile = plugin.app.vault.getAbstractFileByPath(path)
            const savedText = savedFile instanceof TFile ? await plugin.app.vault.read(savedFile) : undefined
            if (savedText !== undefined && await hash(savedText) === intent.afterHash) {
                validate()
                await removeIntent(plugin, token)
                return { ...base, status: 'applied' }
            }
            const index = await ownedIds(plugin, pathRevision, true, t, signal)
            if (!index.first.has(oldId)) {
                validate()
                checkOpenEditors(plugin, path, [oldId, candidateId], t)
                await removeIntent(plugin, token)
                return { ...base, status: 'applied', message: t('The old ID is no longer present in Obsidian.',
                    'Старого ID уже нет в Obsidian.') }
            }
            if (index.first.get(oldId)?.path !== path || index.duplicates.has(oldId) || index.first.has(candidateId)) throw changed(t)
            const file = registeredFile(plugin, path, t)
            const before = await plugin.app.vault.read(file)
            const blockStart = digitOffset(plugin, before, oldId, t) - intent.digitsInBlock
            const blockEnd = blockStart + intent.blockLength
            // Правки за границей карточки можно сохранить, если сама карточка побайтно совпадает с подтверждённой.
            if (blockStart < 0 || await hash(before.slice(blockStart, blockEnd)) !== intent.blockHash) throw changed(t)
            const after = before.slice(0, blockStart + intent.markerStartInBlock) + before.slice(blockStart + intent.markerEndInBlock)
            if (findIdMarkers(after, plugin.settings.Syntax).some(marker => marker.id === oldId)) throw changed(t)
            await requireExpectedAnkiProfile(plugin, profile, signal)
            const verified = await remotePresence([oldId, candidateId], t, signal)
            if (verified.get(oldId) !== false || verified.get(candidateId) !== false) throw changed(t)
            await requireExpectedAnkiProfile(plugin, profile, signal)
            validate()
            await writeLocal(plugin, { file, path, before, after, blockStart, blockEnd }, [oldId, candidateId], validate, t)
            await removeIntent(plugin, token)
            return { ...base, status: 'applied' }
        })
    } catch (error) {
        throw problem(failure(error, t))
    }
}
