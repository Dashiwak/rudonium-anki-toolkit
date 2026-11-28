/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { MarkdownView } from 'obsidian'
import type { CachedMetadata, TFile } from 'obsidian'
import type MyPlugin from '../main'
import { parseAnkiIdMarker } from './anki-id-marker'
import { visitRootMarkdownLines } from './id-marker-literals'
import { requireExpectedAnkiProfile } from './anki-profile'
import { formatAnkiSourceRestore, sameRestoredAnkiField } from './anki-source-restore-format'
import { isProtectedAnkiTag } from './anki-study-state'
import { hasPendingAnkiWrite, pendingAnkiWriteMessage } from './anki-transport'
import { hasPendingBidirectionalWrite } from './bidirectional-sync'
import { editorPreviewMetadata } from './card-preview-metadata'
import { archivedIdMarkers, findIdMarkers } from './duplicate-markers'
import { settingsWithoutAuditMode, withFastScanReadLock } from './fast-scan'
import type { CardPreviewCandidate } from './file'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { findLinkedBullets } from './linked-bullets'
import { parsePortableMarkdown } from './portable-parser'
import { settingToData } from './setting-to-data'
import { auditRead } from './sync-audit'
import { describeSyncPath, isSyncAuditReportPath, scanProfileFreeSettings } from './sync-profiles'
import { indexVaultIds } from './vault-id-index'

export interface AnkiSourceRestorePlan {
    readonly id: number
    readonly profile: string
    readonly modelName: string
    readonly fields: Readonly<Record<string, string>>
    readonly tags: readonly string[]
    readonly suggestedPaths: readonly string[]
    readonly path?: string
    readonly maxLine?: number
    readonly line?: number
    readonly block?: string
    readonly manualReason?: string
    readonly manualFields?: readonly string[]
    readonly targetReason?: 'file-link' | 'context' | 'selection'
    readonly targetDeck?: string
    readonly warnings?: readonly string[]
}

type RestoreErrorCode = 'id' | 'profile' | 'source-record' | 'model' | 'target' | 'duplicate' | 'unsaved' |
    'source-check' | 'stale' | 'unsupported' | 'busy' | 'draft' | 'position'

export class AnkiSourceRestoreError extends Error {
    constructor(readonly code: RestoreErrorCode, message: string) {
        super(message)
        this.name = 'AnkiSourceRestoreError'
    }
}

interface SourceRecord {
    modelName: string
    fieldNames: string[]
    fields: Record<string, string>
    tags: string[]
}

interface StoredRestore {
    plugin: MyPlugin
    file: TFile
    source: string
    positions: number[]
    formatted: ReturnType<typeof formatAnkiSourceRestore>
    configuration: string
    remoteSignature: string
}

const storedRestores = new WeakMap<AnkiSourceRestorePlan, StoredRestore>()
const obsidianAnchor = /<a\b[^>]*?\s+href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>]+))[^>]*>[\s\S]*?<\/a>/gi
const generatedAnchor = /(?:<br\s*\/?\s*>\s*)?<a href="([^"]+)" class="obsidian-link">Obsidian<\/a>/gi
const newline = /\r\n?|\n/g

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function safeMarkdownPath(path: string): boolean {
    return /\.md$/i.test(path) && !/^[a-z]:|[\\\x7f]/i.test(path) && !Array.from(path).some(character => character.charCodeAt(0) < 32) &&
        path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function consistentProfile(profile: string): boolean {
    return typeof profile === 'string' && profile.trim().length > 0
}

function ensureNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Anki source restoration cancelled', 'AbortError')
}

function ensureAvailable(plugin: MyPlugin, text: UiText): void {
    if (hasPendingAnkiWrite(plugin.app) || hasPendingBidirectionalWrite(plugin.app)) {
        throw new AnkiSourceRestoreError('busy', text(pendingAnkiWriteMessage,
            'Предыдущая запись в Anki ещё выполняется. Дождитесь её завершения и повторите восстановление.'))
    }
}

function stale(t: UiText): AnkiSourceRestoreError {
    return new AnkiSourceRestoreError('stale', t('The note, settings or vault changed during restore. Open a new preview.',
        'Заметка, настройки или хранилище изменились во время восстановления. Откройте новый предпросмотр.'))
}

function configurationKey(plugin: MyPlugin): string {
    return JSON.stringify([plugin.app.vault.getName(), settingsWithoutAuditMode(plugin.settings), plugin.fields_dict])
}

async function readSourceRecord(plugin: MyPlugin, id: number, profile: string, t: UiText,
    signal?: AbortSignal): Promise<SourceRecord> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new AnkiSourceRestoreError('id', t('Invalid Anki note ID.', 'Некорректный ID записи Anki.'))
    if (!consistentProfile(profile)) throw new AnkiSourceRestoreError('profile', t(
        'The audit did not verify an Anki profile. Run the audit again before restoring.',
        'Аудит не подтвердил профиль Anki. Перед восстановлением запустите аудит заново.'))
    await requireExpectedAnkiProfile(plugin, profile, signal)
    const response = await auditRead('notesInfo', { notes: [id] }, signal)
    await requireExpectedAnkiProfile(plugin, profile, signal)
    const broken = () => new AnkiSourceRestoreError('source-record', t(
        `Anki did not confirm exactly one complete note with ID ${id}. Recheck the active profile and run the audit again.`,
        `Anki не подтвердила единственную полную запись с ID ${id}. Проверьте открытый профиль и запустите аудит снова.`))
    if (!Array.isArray(response) || response.length !== 1 || !record(response[0])) throw broken()
    const { noteId, modelName, fields, tags } = response[0]
    if (noteId !== id || typeof modelName !== 'string' || !modelName.trim() || !record(fields) ||
        !Array.isArray(tags) || !tags.every((tag: unknown): tag is string => typeof tag === 'string')) throw broken()
    const entries = Object.entries(fields)
    const byOrder: Array<{ name: string; value: string; order: number }> = []
    for (const [name, field] of entries) {
        if (!name.trim() || !record(field) || typeof field.value !== 'string' || typeof field.order !== 'number' ||
            !Number.isSafeInteger(field.order) || field.order < 0) throw broken()
        byOrder.push({ name, value: field.value, order: field.order })
    }
    byOrder.sort((left, right) => left.order - right.order)
    if (!byOrder.length || byOrder.some(({ order }, index) => order !== index)) throw broken()
    const fieldNames = byOrder.map(({ name }) => name)
    const registered = Object.prototype.hasOwnProperty.call(plugin.fields_dict, modelName) ? plugin.fields_dict[modelName] : undefined
    if (!Array.isArray(registered) || registered.length !== fieldNames.length || registered.some((name, index) => name !== fieldNames[index])) {
        throw new AnkiSourceRestoreError('model', t(
            `The local table of fields for “${modelName}” differs from Anki. Click Refresh in Note type rules, then run the audit again.`,
            `Локальная схема полей «${modelName}» отличается от Anki. Нажмите «Обновить» в разделе «Правила типов записей» и запустите аудит снова.`))
    }
    return { modelName, fieldNames, fields: Object.fromEntries(byOrder.map(({ name, value }) => [name, value])),
        tags: [...new Set(tags)].sort() }
}

function sourceLinkPath(link: string, vaultName: string, id: number): string | undefined {
    if (!/^obsidian:\/\/(?:open|anki-card)\?/i.test(link)) return undefined
    try {
        const url = new URL(link.replace(/&(?:amp|#0*38|#x0*26);/gi, '&'))
        const params = url.searchParams
        const vault = params.getAll('vault')
        const file = params.getAll('file')
        const note = params.getAll('nid')
        if (url.username || url.password || url.port || url.hash || vault.length !== 1 || file.length !== 1 ||
            vault[0].normalize('NFC') !== vaultName.normalize('NFC') || !safeMarkdownPath(file[0])) return undefined
        if (url.hostname === 'anki-card' && (note.length !== 1 || note[0] !== String(id))) return undefined
        if (url.hostname === 'open' && note.length && (note.length !== 1 || note[0] !== String(id))) return undefined
        return file[0]
    } catch {
        return undefined
    }
}

function decodePathEntities(value: string): string {
    return value.replace(/&(amp|lt|gt|quot|apos|nbsp|#0*39);/gi, (_, entity: string) => {
        const aliases: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
        return aliases[entity.toLowerCase()] ?? "'"
    })
}

function contextPaths(raw: string): string[] {
    const lineBreaks = raw.replace(/<br\s*\/?\s*>|<\/?(?:div|p)\b[^>]*>/gi, '\n')
    return lineBreaks.split(newline).flatMap(line => {
        const [path, ...headings] = decodePathEntities(line.trim()).split(/[ \t]+>[ \t]+/)
        return safeMarkdownPath(path) && !/[<>]/.test(path) && headings.every(heading => heading.trim() && !/[<>]/.test(heading))
            ? [path] : []
    })
}

function sourcePaths(plugin: MyPlugin, id: number, source: SourceRecord,
    markdown: ReadonlyMap<string, TFile>): { links: Set<string>; contexts: Set<string>; linkedPaths: Set<string> } {
    const links = new Set<string>()
    const contexts = new Set<string>()
    const linkedPaths = new Set<string>()
    const vaultName = plugin.app.vault.getName()
    const linkField = plugin.settings.FILE_LINK_FIELDS?.[source.modelName]
    const contextField = plugin.settings.CONTEXT_FIELDS?.[source.modelName]
    const add = (target: Set<string>, path: string | undefined) => { if (path && markdown.has(path)) target.add(path) }
    const addLink = (path: string | undefined) => {
        if (!path) return
        linkedPaths.add(path)
        add(links, path)
    }
    for (const [name, value] of Object.entries(source.fields)) {
        const isFile = name.toLowerCase() === 'file' || name === linkField && plugin.settings.Defaults['Add File Link']
        const isContext = name === contextField || name.toLowerCase() === 'context'
        if (isFile) {
            addLink(sourceLinkPath(value.trim(), vaultName, id))
            for (const path of contextPaths(value)) addLink(path)
        }
        for (const anchor of value.matchAll(obsidianAnchor)) {
            if (isFile || /\bclass\s*=\s*["'][^"']*\bobsidian-link\b[^"']*["']/i.test(anchor[0])) {
                addLink(sourceLinkPath(anchor[1] ?? anchor[2] ?? anchor[3], vaultName, id))
            }
        }
        if (isContext) {
            for (const path of contextPaths(value)) add(contexts, path)
            if (name === contextField && /\.md\b/i.test(value) && (plugin.settings.Defaults['Add Context'] || /\s>\s/.test(value))) {
                const matches = [...markdown.keys()].filter(path => contextSuffix(value, path) !== undefined)
                for (const path of matches) {
                    if (!matches.some(other => other !== path && other.endsWith('/' + path))) contexts.add(path)
                }
            }
        }
    }
    return { links, contexts, linkedPaths }
}

function contextSuffix(raw: string, path: string): number | undefined {
    for (const candidate of [path, path.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;')]) {
        const offset = raw.lastIndexOf(candidate)
        if (offset < 0 || raw[offset - 1] === '/') continue
        const suffix = decodePathEntities(raw.slice(offset + candidate.length)).trimEnd()
        if (!suffix || /^(?:\s>\s[^<>\r\n]+)+$/.test(suffix)) return offset
    }
    return undefined
}

function authoredFields(fields: Readonly<Record<string, string>>, plugin: MyPlugin,
    modelName: string, id: number, contextPath?: string): Record<string, string> {
    const vaultName = plugin.app.vault.getName()
    const sourceField = plugin.settings.FILE_LINK_FIELDS?.[modelName]
    const contextField = plugin.settings.CONTEXT_FIELDS?.[modelName]
    return Object.fromEntries(Object.entries(fields).map(([name, value]) => {
        const ownedContext = contextPath && name === contextField && plugin.settings.Defaults['Add Context']
            ? contextSuffix(value, contextPath) : undefined
        const withoutContext = ownedContext === undefined ? value : value.slice(0, ownedContext)
        const isFile = name === sourceField || name.toLowerCase() === 'file'
        if (isFile && sourceLinkPath(withoutContext.trim(), vaultName, id)) return [name, '']
        const clean = withoutContext.replace(generatedAnchor, (original, url: string) =>
            (isFile || /^<br\b/i.test(original)) && sourceLinkPath(url, vaultName, id) ? '' : original)
        return [name, clean]
    }))
}

function matchingSourceFields(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>,
    names: readonly string[]): boolean {
    return names.every(name => left[name] === right[name] || sameRestoredAnkiField(left[name] ?? '', right[name] ?? ''))
}

function conflictAt(path: string, line: number, id: number, t: UiText): AnkiSourceRestoreError {
    return new AnkiSourceRestoreError('duplicate', t(`Anki ID ${id} is already present in ${path}, line ${line}. Recheck the audit.`,
        `ID Anki ${id} уже есть в файле ${path}, строка ${line}. Повторите аудит.`))
}

function checkEditors(plugin: MyPlugin, path: string, id: number, t: UiText): void {
    for (const { view } of plugin.app.workspace.getLeavesOfType('markdown')) {
        if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file) continue
        const source = view.getViewData()
        if (source.replace(/\r\n/g, '\n') === view.data.replace(/\r\n/g, '\n')) continue
        const marker = findIdMarkers(source, plugin.settings.Syntax).find(item => item.id === id) ??
            archivedIdMarkers(source).find(item => item.id === id)
        if (marker) throw conflictAt(view.file.path, marker.line, id, t)
        if (view.file.path === path) throw new AnkiSourceRestoreError('unsaved', t(
            'The destination has unsaved edits. Save them and reopen the restore preview.',
            'В файле назначения есть несохранённые правки. Сохраните их и заново откройте предпросмотр.'))
    }
}

async function checkOwnership(plugin: MyPlugin, id: number, path: string, files: readonly TFile[],
    pathRevision: (path: string) => number, t: UiText, force: boolean, signal?: AbortSignal): Promise<void> {
    checkEditors(plugin, path, id, t)
    const ownership = await indexVaultIds(plugin, files, plugin.settings.Syntax, pathRevision,
        { includeArchivedOwners: true, force, shouldStop: () => signal?.aborted === true })
    ensureNotAborted(signal)
    const match = ownership.first.get(id)
    if (match) throw conflictAt(match.path, match.line, id, t)
    if (!ownership.complete) throw new AnkiSourceRestoreError('source-check', t(
        `The vault could not be fully checked for this ID. ${ownership.errors[0]?.path ?? ''}`,
        `Проверку этого ID по хранилищу не удалось завершить. ${ownership.errors[0]?.path ?? ''}`))
    checkEditors(plugin, path, id, t)
}

function availableMarkdown(plugin: MyPlugin): Map<string, TFile> {
    return new Map(plugin.app.vault.getMarkdownFiles().filter(file => safeMarkdownPath(file.path) && !isSyncAuditReportPath(file.path))
        .map(file => [file.path, file]))
}

function snapshotSignature(source: SourceRecord): string {
    return JSON.stringify([source.modelName, source.fieldNames.map(name => source.fields[name]), source.tags])
}

function formatRestoreBlock(plugin: MyPlugin, remote: SourceRecord, id: number, fields: Record<string, string>,
    tags: readonly string[], t: UiText, preferMarkdown = true): ReturnType<typeof formatAnkiSourceRestore> {
    try {
        return formatAnkiSourceRestore({ id, modelName: remote.modelName, fields, fieldNames: remote.fieldNames,
            tags, preferMarkdown, vaultName: plugin.app.vault.getName(), syntax: plugin.settings.Syntax,
            idAsComment: plugin.settings.Defaults['ID Comments'] })
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const field = remote.fieldNames.find(name => detail.startsWith(name + ':'))
        throw new AnkiSourceRestoreError('unsupported', t(detail,
            `Автоматическое восстановление не поддерживает формат этой записи${field ? ` в поле «${field}»` : ''}. Скопируйте её поля и ID в исходную заметку вручную.`))
    }
}

interface ParsedRestoreBlock {
    block: string
    next: string
    parsed: Awaited<ReturnType<typeof parsePortableMarkdown>>
    restored: CardPreviewCandidate
}

// The destination's metadata cache only describes its saved contents. Supply the
// exact links generated from Anki for the appended range during the dry run.
function appendLinkMetadata(metadata: CachedMetadata, block: string, prefix: string,
    links: ReturnType<typeof formatAnkiSourceRestore>['wikiLinks']): void {
    if (!links.length) return
    const known = new Map(links.map(link => [link.original, link]))
    const generated: NonNullable<CachedMetadata['links']> = []
    let line = prefix.match(newline)?.length ?? 0
    let offset = prefix.length
    for (const source of block.split(/(?<=\n)|(?<=\r)(?!\n)/u)) {
        for (const match of source.matchAll(/\[\[[^[\]\r\n]+\]\]/gu)) {
            const link = known.get(match[0])
            if (!link) continue
            const position = (col: number) => ({ line, col, offset: offset + col })
            generated.push({ ...link, position: { start: position(match.index), end: position(match.index + match[0].length) } })
        }
        line++
        offset += source.length
    }
    metadata.links = [...(metadata.links ?? []), ...generated]
}

// A line means "before this existing line". EOF is also selectable, including in
// a file with an unterminated last line. Original source bytes stay untouched.
function insertionPositions(source: string): number[] {
    const positions = [source.startsWith('\uFEFF') ? 1 : 0]
    for (const match of source.matchAll(newline)) positions.push(match.index + match[0].length)
    if (positions[positions.length - 1] !== source.length) positions.push(source.length)
    return positions
}

function insertionParts(source: string, offset: number) {
    const before = source.slice(0, offset)
    const after = source.slice(offset)
    const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'))
    const ending = lastBreak < 0 ? after.match(/\r\n|\r|\n/u)?.[0] ?? '\n'
        : before[lastBreak] === '\n' && before[lastBreak - 1] === '\r' ? '\r\n' : before[lastBreak]
    const tail = before.slice(-4).replace(newline, '\n')
    const trailing = tail.endsWith('\n\n') ? 2 : tail.endsWith('\n') ? 1 : 0
    const prefix = before + (before ? ending.repeat(Math.max(0, 2 - trailing)) : '')
    const suffix = ending + (after && !/^[\r\n]/u.test(after) ? ending : '') + after
    return { prefix, suffix, ending }
}

export function restoreInsertionContext(plan: AnkiSourceRestorePlan, line: number) {
    const stored = storedRestores.get(plan)
    if (!stored || !Number.isInteger(line) || line < 1 || line > stored.positions.length) return
    const { source, positions } = stored
    const offset = positions[line - 1]
    const { prefix } = insertionParts(source, offset)
    const row = (start: number, end: number) => source.slice(start, end).replace(/(?:\r\n|\r|\n)$/u, '')
    return {
        before: positions.slice(Math.max(0, line - 3), line - 1).map((start, i, rows) => row(start, rows[i + 1] ?? offset)),
        after: positions.slice(line - 1, line + 1).filter(start => start < source.length)
            .map((start, i) => row(start, positions[line + i] ?? source.length)),
        blockLine: (prefix.match(newline)?.length ?? 0) + 1,
    }
}

function validDraft(plugin: MyPlugin, block: string, modelName: string, id: number): boolean {
    const rows = block.split(newline)
    const syntax = plugin.settings.Syntax
    const begin = syntax['Begin Note'] ?? 'START'
    const end = syntax['End Note'] ?? 'END'
    const idRow = rows[rows.length - 2] ?? ''
    const marker = parseAnkiIdMarker(idRow)
    if (rows.length < 5 || rows[0] !== begin || rows[1] !== modelName || rows[rows.length - 1] !== end ||
        marker?.id !== id || marker.text !== idRow.trim()) return false
    const commands = [begin, end, syntax['Frozen Fields Line'], syntax['Target Deck Line'], syntax['File Tags Line'], syntax['Delete Note Line']]
        .filter(Boolean)
    const body = rows.slice(2, -2)
    const markers = findIdMarkers(block, syntax)
    if (markers.length !== 1 || markers[0].id !== id || !exposedInsertion(block, block.length, block + '\n\n')) return false
    return body.some(row => row.trim()) && !body.some(row => {
        const text = row.trim()
        return /^(?:<!--[ \t]*)?ID[ \t]*:/iu.test(text) || commands.some(command =>
            text === command || text.startsWith(command + ' ') || text.startsWith(command + ':'))
    })
}

function exposedInsertion(source: string, offset: number, prefix: string): boolean {
    // Inserting above frontmatter would silently turn vault properties into body text.
    if (offset <= (source.startsWith('\uFEFF') ? 1 : 0) && /^\uFEFF?---[ \t]*(?:\r\n|\r|\n|$)/u.test(source)) return false
    const start = prefix.replace(newline, '\n')
    // Probe on a Markdown root line. Also distinguishes an unclosed fence/comment at EOF.
    let exposed = false
    visitRootMarkdownLines(start + 'Rudonium <!-- -->\n' + source.slice(offset).replace(newline, '\n'), {
        line(at) { if (at === start.length) exposed = true },
        comment() { /* Only the probe's surrounding Markdown matters. */ },
    })
    return exposed
}

async function verifyInsertion(plugin: MyPlugin, file: TFile, source: string, offset: number,
    remote: SourceRecord, id: number, formatted: ReturnType<typeof formatAnkiSourceRestore>,
    signal?: AbortSignal, reviewed?: string): Promise<ParsedRestoreBlock | undefined> {
    const { prefix, suffix, ending } = insertionParts(source, offset)
    if (!exposedInsertion(source, offset, prefix)) return
    const config = scanProfileFreeSettings(settingsWithoutAuditMode(plugin.settings))
    const ids = [...new Set([id, ...findIdMarkers(source, config.Syntax).map(item => item.id)])]
    const data = await settingToData(plugin.app, config, plugin.fields_dict, ids)
    const savedMetadata = plugin.app.metadataCache.getCache(file.path)
    const parse = (text: string, metadata: CachedMetadata) => parsePortableMarkdown(plugin.app, data, file, text, ids, {
        preview: true, metadata, syntax: config.Syntax, noteTypes: new Set(Object.keys(plugin.fields_dict)),
        regexpOptions: { shouldStop: () => signal?.aborted === true },
    })
    const draft = reviewed ?? formatted.markdown
    if (!validDraft(plugin, draft, remote.modelName, id) || data.EMPTY_REGEXP.test(draft) || data.FROZEN_REGEXP.test(draft)) return
    // The upstream explicit-note parser requires LF or CRLF within the block.
    // Bare CR vault files retain their existing bytes on either side.
    const block = draft.replace(newline, ending === '\r' ? '\n' : ending)
    const next = prefix + block + suffix
    const metadata = editorPreviewMetadata(next, savedMetadata)
    appendLinkMetadata(metadata, block, prefix, formatted.wikiLinks)
    try {
        const parsed = await parse(next, metadata)
        const candidates = parsed.previewCandidates ?? []
        const restored = candidates.find(card => card.start === prefix.length && card.end === prefix.length + block.length &&
            card.explicitNoteBlock && card.identifier === id && card.note.modelName === remote.modelName)
        if (!restored) return
        if (reviewed === undefined && !matchingSourceFields(authoredFields(restored.note.fields, plugin, remote.modelName, id, file.path),
            formatted.fields, remote.fieldNames)) return
        if (source) {
            const baseline = await parse(source, editorPreviewMetadata(source, savedMetadata))
            const peers = candidates.filter(card => card !== restored)
            const original = baseline.previewCandidates ?? []
            if (peers.length !== original.length || JSON.stringify(baseline.notes_to_delete) !== JSON.stringify(parsed.notes_to_delete)) return
            const shift = next.length - source.length
            const peersByRange = new Map(peers.map(peer => [peer.start + ',' + peer.end, peer]))
            for (const card of original) {
                if (card.start < offset && offset < card.end) return
                const delta = card.start >= offset ? shift : 0
                const peer = peersByRange.get((card.start + delta) + ',' + (card.end + delta))
                if (!peer || card.identifier !== peer.identifier || JSON.stringify(card.note) !== JSON.stringify(peer.note)) return
            }
        } else if (candidates.length !== 1 || parsed.notes_to_delete.length) return
        return { block, next, parsed, restored }
    } catch {
        ensureNotAborted(signal)
        return
    }
}

function checkEquivalentCard(plugin: MyPlugin, file: TFile, source: string, result: ParsedRestoreBlock,
    formatted: ReturnType<typeof formatAnkiSourceRestore>, remote: SourceRecord, id: number, t: UiText): void {
    const { restored, parsed } = result
    const editedFields = authoredFields(restored.note.fields, plugin, remote.modelName, id, file.path)
    const equivalent = (fields: Record<string, string>) => [formatted.fields, editedFields].some(expected =>
        matchingSourceFields(fields, expected, remote.fieldNames))
    const existing = parsed.previewCandidates?.find(card => card !== restored && card.note.modelName === remote.modelName &&
        equivalent(authoredFields(card.note.fields, plugin, remote.modelName, card.identifier ?? id, file.path)))
    const { Front: front, Back: back } = formatted.fields
    const linked = !existing && front && back ? findLinkedBullets(source).find(bullet =>
        sameRestoredAnkiField(parsed.formatter.format(bullet.front, false, false), front) &&
        sameRestoredAnkiField(parsed.formatter.format(bullet.back, false, false), back)) : undefined
    const offset = existing ? existing.start - (existing.start > restored.start ? result.next.length - source.length : 0) : linked?.start
    if (offset === undefined) return
    const line = source.slice(0, offset).split(newline).length
    throw new AnkiSourceRestoreError('duplicate', t(
        `The same card fields are already in ${file.path}, line ${line}. Review its link before adding a second block.`,
        `Такие же поля уже есть в файле ${file.path}, строка ${line}. Проверьте связь этого блока перед добавлением копии.`))
}

export async function prepareAnkiSourceRestore(plugin: MyPlugin, id: number, profile: string,
    options: { path?: string; signal?: AbortSignal } = {}): Promise<AnkiSourceRestorePlan> {
    const t = uiFor(plugin.settings)
    const { signal } = options
    return withFastScanReadLock(plugin, async (currentRevision, pathRevision) => {
        ensureNotAborted(signal)
        ensureAvailable(plugin, t)
        const revision = currentRevision()
        const configuration = configurationKey(plugin)
        const remote = await readSourceRecord(plugin, id, profile, t, signal)
        const files = availableMarkdown(plugin)
        const { links, contexts, linkedPaths } = sourcePaths(plugin, id, remote, files)
        const suggestedPaths = [...new Set([...links, ...contexts])].sort((left, right) => left.localeCompare(right))
        const path = options.path ?? (suggestedPaths.length === 1 ? suggestedPaths[0] : undefined)
        const tags = remote.tags.filter(tag => !isProtectedAnkiTag(tag))
        const plan = { id, profile, modelName: remote.modelName, fields: Object.freeze({ ...remote.fields }),
            tags: Object.freeze(tags), suggestedPaths: Object.freeze(suggestedPaths) }
        if (revision !== currentRevision() || configurationKey(plugin) !== configuration) throw stale(t)
        const file = path === undefined ? undefined : files.get(path)
        if (path !== undefined) {
            if (!file || plugin.app.vault.getAbstractFileByPath(path) !== file) throw new AnkiSourceRestoreError('target', t(
                'Choose an existing Markdown file in this vault.', 'Выберите существующий файл Markdown в этом хранилище.'))
            await checkOwnership(plugin, id, path, plugin.app.vault.getMarkdownFiles(), pathRevision, t, false, signal)
        }
        const [context] = contexts
        const [linkedPath] = linkedPaths
        const oldContext = contexts.size === 1 ? context : linkedPaths.size === 1 ? linkedPath : undefined
        const fields = authoredFields(remote.fields, plugin, remote.modelName, id, oldContext)
        const formatted = formatRestoreBlock(plugin, remote, id, fields, tags, t)
        const manualReason = formatted.manualFields.length ? t(
            `Review these fields before adding the draft: ${formatted.manualFields.join(', ')}. Their original markup is shown as literal text.`,
            `Перед добавлением черновика проверьте поля ${formatted.manualFields.join(', ')}. Их исходная разметка показана как текст.`) : undefined
        const targetReason: AnkiSourceRestorePlan['targetReason'] = options.path ? 'selection'
            : path && links.has(path) ? 'file-link' : path ? 'context' : undefined
        const preview = { ...plan, path, block: formatted.markdown, manualReason, manualFields: Object.freeze(formatted.manualFields), targetReason }
        if (!file || !path) return Object.freeze(preview)
        const source = await plugin.app.vault.read(file)
        checkEditors(plugin, path, id, t)
        if (findIdMarkers(source, plugin.settings.Syntax).some(marker => marker.id === id) ||
            archivedIdMarkers(source).some(marker => marker.id === id)) throw stale(t)
        const positions = insertionPositions(source)
        const maxLine = positions.length
        let candidate = formatted
        const verify = () => verifyInsertion(plugin, file, source, source.length, remote, id, candidate, signal)
        let verified = manualReason ? undefined : await verify()
        if (!verified && !manualReason) {
            const literal = formatRestoreBlock(plugin, remote, id, fields, tags, t, false)
            if (literal.markdown !== formatted.markdown) {
                candidate = literal
                verified = await verify()
                if (!verified) candidate = formatted
            }
        }
        let review = manualReason
        if (!verified && !review) review = t('Review the draft before adding it to the file.',
            'Проверьте черновик перед добавлением в файл.')
        if (verified) {
            checkEquivalentCard(plugin, file, source, verified, candidate, remote, id, t)
            const parsedTags = new Set(verified.restored.note.tags.map(tag => tag.toLowerCase()))
            if (candidate.tags.some(tag => !parsedTags.has(tag.toLowerCase()))) review = t(
                'Review the tags in the draft.', 'Проверьте теги в черновике.')
        }
        await requireExpectedAnkiProfile(plugin, profile, signal)
        if (revision !== currentRevision() || configurationKey(plugin) !== configuration || file.path !== path ||
            plugin.app.vault.getAbstractFileByPath(path) !== file) throw stale(t)
        const scope = describeSyncPath(plugin, path)
        const warnings = scope.included ? [] : [t(`The file is outside the current folder profile “${scope.label}”.`,
            `Файл находится вне текущего профиля папок «${scope.label}».`)]
        const restored = verified?.restored
        if (restored && remote.fieldNames.some(name => fields[name] !== remote.fields[name] && restored.note.fields[name] !== remote.fields[name])) {
            warnings.push(t('The generated file link or Context will differ at the new location. This restore saves only the Markdown block.',
                'Служебная ссылка на файл или Context будут другими в новом месте. Восстановление сохранит только блок Markdown.'))
        }
        const ready = Object.freeze({ ...preview, line: maxLine, maxLine, manualReason: review,
            block: verified?.block ?? candidate.markdown, targetDeck: restored?.note.deckName, warnings: Object.freeze(warnings) })
        storedRestores.set(ready, { plugin, file, source, positions, formatted: candidate, configuration, remoteSignature: snapshotSignature(remote) })
        return ready
    })
}

export async function commitAnkiSourceRestore(plugin: MyPlugin, plan: AnkiSourceRestorePlan,
    signal?: AbortSignal, edit?: { line: number; block: string }): Promise<{ path: string; line: number }> {
    const t = uiFor(plugin.settings)
    return withFastScanReadLock(plugin, async (currentRevision, pathRevision) => {
        ensureNotAborted(signal)
        ensureAvailable(plugin, t)
        const saved = storedRestores.get(plan)
        const { path, line, id, profile } = plan
        const { vault } = plugin.app
        if (!saved || saved.plugin !== plugin || !path || line === undefined || saved.file.path !== path ||
            saved.configuration !== configurationKey(plugin) || vault.getAbstractFileByPath(path) !== saved.file) throw stale(t)
        if (typeof vault.process !== 'function') throw new AnkiSourceRestoreError('unsupported', t(
            'Update Obsidian to a version with the Vault.process API before restoring cards.',
            'Перед восстановлением обновите Obsidian до версии с поддержкой Vault.process.'))
        if (!edit && plan.manualReason) throw stale(t)
        const anchor = edit?.line ?? line
        const context = restoreInsertionContext(plan, anchor)
        const positionError = () => new AnkiSourceRestoreError('position', t(
            'Choose a line outside existing cards, properties, code and comments.',
            'Выберите строку вне других карточек, свойств, блоков кода и комментариев.'))
        if (!context) throw positionError()
        const offset = saved.positions[anchor - 1]
        const draft = (edit?.block ?? plan.block ?? '').replace(/[\r\n]+$/u, '')
        if (!validDraft(plugin, draft, plan.modelName, id)) throw new AnkiSourceRestoreError('draft', t(
            'Keep one card block with its original note type, ID and opening and closing markers.',
            'Сохраните один блок карточки с исходным типом записи, ID и начальным и конечным маркерами.'))
        const revision = currentRevision()
        if (await vault.read(saved.file) !== saved.source) throw stale(t)
        const read = await readSourceRecord(plugin, id, profile, t, signal)
        if (snapshotSignature(read) !== saved.remoteSignature) throw stale(t)
        await checkOwnership(plugin, id, path, vault.getMarkdownFiles(), pathRevision, t, true, signal)
        const verified = await verifyInsertion(plugin, saved.file, saved.source, offset, read, id, saved.formatted, signal, draft)
        if (!verified) throw positionError()
        checkEquivalentCard(plugin, saved.file, saved.source, verified, saved.formatted, read, id, t)
        await requireExpectedAnkiProfile(plugin, profile, signal)
        ensureNotAborted(signal)
        const validate = () => {
            if (revision !== currentRevision() || saved.configuration !== configurationKey(plugin) || saved.file.path !== path ||
                vault.getAbstractFileByPath(path) !== saved.file) throw stale(t)
            checkEditors(plugin, path, id, t)
        }
        validate()
        await vault.process(saved.file, source => {
            ensureNotAborted(signal)
            validate()
            if (source !== saved.source) throw stale(t)
            return verified.next
        })
        storedRestores.delete(plan)
        return { path, line: context.blockLine }
    })
}
