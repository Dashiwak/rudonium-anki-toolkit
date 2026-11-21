/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { TFile, TFolder } from 'obsidian'
import type { App } from 'obsidian'
import * as AnkiConnect from './anki'
import { AnkiProfileError, readActiveAnkiProfile } from './anki-profile'
import { hasPendingAnkiWrite, pendingAnkiWriteMessage, withAnkiDeadline, withAnkiWriteDeadline } from './anki-transport'
import { imageHash as digest, optimizeImage } from './image-optimizer'
import type { ImageOptimizationSettings, OptimizedImage } from './image-optimizer'
import { prepareImageReplacement, readImageReplacement } from './export-image-replacement'
import { encodeAnkiMediaFilename } from './image-field-links'

export const optimizedImageFolder = 'Anki Optimized Images'
const managedImageName = /^anki-opt-[a-f0-9]{64}\.(?:jpg|png)$/i
const namespacedMediaName = /^rupos-media-[a-f0-9]{64}\.[a-z0-9]{1,12}$/u

export function isOptimizedImageCopyPath(path: string): boolean {
    return path === optimizedImageFolder ||
        (path.startsWith(`${optimizedImageFolder}/`) && managedImageName.test(path.slice(optimizedImageFolder.length + 1)))
}

interface ImageReceipt {
    profile: string
    sourceDigest: string
    originalBytes: number
    optimizedBytes: number
    originalWidth: number
    originalHeight: number
    width: number
    height: number
}

export type OptimizedImagePreview = Omit<ImageReceipt, 'profile' | 'sourceDigest'> & {
    filename: string
    copyPath?: string
    replacePath?: string
    references?: { total: number; sample: string[] }
}

interface MediaRecord {
    filename: string
    path: string
    digest: string
    stamp: [number, number, number]
    notes: string[]
    ankiProfile?: string
    sourceFilename?: string
    sourceReferences?: MediaReference[]
    canonicalConfirmed?: boolean
    namespaced?: true
    image?: ImageReceipt
    pendingNotes?: string[]
}

export type MediaIndex = Map<string, MediaRecord>
export interface MediaReference { note: string; link: string }
export interface MediaPlan {
    record: MediaRecord
    sourceFilename: string
    sourceReferences: readonly MediaReference[]
    indexKey: string
    notes: string[]
    upload: boolean
    remoteBefore: string | null
    remoteNames: ReadonlyMap<string, string | null>
    optimized?: OptimizedImagePreview
    optimizedBytes?: ArrayBuffer
    imageSettings?: ImageOptimizationSettings
    sourceGuard?: string
    retiredImageKey?: string
    profileGuard?: string
    confirmAlias?: boolean
}

export function mediaWillWrite(plan: MediaPlan): boolean {
    return plan.upload || Boolean(plan.optimized?.copyPath || plan.optimized?.replacePath)
}

export function mediaNeedsReview(plan: MediaPlan): boolean {
    return mediaWillWrite(plan) || plan.confirmAlias === true
}

function mediaKey(filename: string): string {
    return filename.normalize('NFC').toLowerCase()
}

function imageKey(filename: string, profile: string): string {
    return '\0' + JSON.stringify([profile, mediaKey(filename)])
}

function namespaceKey(path: string, filename: string, profile: string): string {
    return '\0alias:' + JSON.stringify([profile, path, mediaKey(filename)])
}

export function retiredMediaMarker(indexKey: string): string {
    return '\0retired:' + indexKey
}

export async function activeMediaProfile(): Promise<string | undefined> {
    try {
        return await readActiveAnkiProfile()
    } catch {
        return undefined
    }
}

export function imageAliases(index: MediaIndex, profile: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
    const byNote = new Map<string, Map<string, string>>()
    const optimized: MediaRecord[] = []
    const namespaced: MediaRecord[] = []
    const addRecord = (record: MediaRecord) => {
        const pending = new Set(record.pendingNotes)
        addMediaAliases(byNote, record, record.notes.filter(note => !pending.has(note)), record.sourceReferences ?? [])
    }
    for (const record of index.values()) {
        if ((record.image?.profile ?? record.ankiProfile) !== profile || !hasMediaAlias(record)) continue
        if (record.namespaced) namespaced.push(record)
        else if (record.image) optimized.push(record)
        else addRecord(record)
    }
    // Если сохранены оба подтверждения, оптимизированное вложение заменяет обычную отправленную копию.
    optimized.forEach(addRecord)
    // Явно подтверждённая ссылка с отдельным именем имеет приоритет для этой заметки.
    namespaced.forEach(addRecord)
    return byNote
}

export function hasMediaAlias(record: MediaRecord): boolean {
    if (!record.sourceFilename || (!record.image && !record.canonicalConfirmed)) return false
    const encoded = encodeAnkiMediaFilename(record.filename)
    return Boolean(encoded && (encoded !== record.sourceFilename || record.sourceReferences?.length))
}

function addMediaAliases(byNote: Map<string, Map<string, string>>, record: MediaRecord,
    notes: readonly string[], references: readonly MediaReference[]): void {
    if (!record.sourceFilename) return
    const visible = new Set(notes)
    for (const note of notes) {
        const aliases = byNote.get(note) ?? new Map<string, string>()
        aliases.set(record.sourceFilename, record.filename)
        byNote.set(note, aliases)
    }
    for (const { note, link } of references) if (visible.has(note)) byNote.get(note)?.set(link, record.filename)
}

export function plannedMediaAliases(plans: readonly MediaPlan[]): ReadonlyMap<string, ReadonlyMap<string, string>> {
    const byNote = new Map<string, Map<string, string>>()
    for (const plan of plans) {
        if (hasMediaAlias(plan.record)) addMediaAliases(byNote, plan.record, plan.notes, plan.sourceReferences)
    }
    return byNote
}

function stamp(file: TFile): MediaRecord['stamp'] {
    return [file.stat.mtime, file.stat.ctime, file.stat.size]
}

function sameStamp(file: TFile, saved: MediaRecord['stamp']): boolean {
    const { mtime, ctime, size } = file.stat
    return mtime === saved[0] && ctime === saved[1] && size === saved[2]
}

export function loadMediaIndex(index: MediaIndex, data: unknown): void {
    if (!Array.isArray(data)) return
    const ambiguous = new Set<string>()
    for (const entry of data) {
        if (!entry || typeof entry.filename !== 'string' || typeof entry.path !== 'string' ||
            typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest) ||
            !Array.isArray(entry.stamp) || entry.stamp.length !== 3 || !entry.stamp.every(Number.isFinite) ||
            !Array.isArray(entry.notes) || !entry.notes.every((note: unknown) => typeof note === 'string')) continue
        const image = entry.image as Partial<ImageReceipt> | undefined
        if (image && (typeof image.profile !== 'string' || !image.profile.trim() ||
            typeof image.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(image.sourceDigest) ||
            typeof entry.sourceFilename !== 'string' || localMediaName(entry.sourceFilename) !== entry.sourceFilename ||
            !managedImageName.test(entry.filename) || !mediaKey(entry.filename).startsWith(`anki-opt-${entry.digest}.`) ||
            ![image.originalBytes, image.optimizedBytes, image.originalWidth, image.originalHeight, image.width, image.height]
                .every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0))) continue
        if (entry.pendingNotes !== undefined &&
            (!Array.isArray(entry.pendingNotes) || !entry.pendingNotes.every((note: unknown) => typeof note === 'string'))) continue
        if (entry.ankiProfile !== undefined && (typeof entry.ankiProfile !== 'string' || !entry.ankiProfile.trim())) continue
        if (entry.canonicalConfirmed !== undefined && typeof entry.canonicalConfirmed !== 'boolean') continue
        if (entry.canonicalConfirmed && (encodeAnkiMediaFilename(entry.filename) === undefined ||
            typeof entry.sourceFilename !== 'string' || localMediaName(entry.sourceFilename) !== entry.sourceFilename)) continue
        if (entry.namespaced !== undefined && (entry.namespaced !== true || image || !entry.ankiProfile ||
            entry.canonicalConfirmed !== true || !namespacedMediaName.test(entry.filename))) continue
        if (entry.sourceReferences !== undefined && (!Array.isArray(entry.sourceReferences) ||
            !entry.sourceReferences.every((reference: Partial<MediaReference> | undefined) =>
                reference && typeof reference.note === 'string' && typeof reference.link === 'string'))) continue
        const key = entry.namespaced ? namespaceKey(entry.path, entry.sourceFilename, entry.ankiProfile)
            : image?.profile ? imageKey(entry.sourceFilename, image.profile) : mediaKey(entry.filename)
        if (ambiguous.has(key)) continue
        // При повреждённом индексе порядок записей не определяет принадлежность имени файла.
        if (index.has(key)) {
            index.delete(key)
            ambiguous.add(key)
        } else index.set(key, entry)
    }
}

export function changedMediaNotes(app: App, index: MediaIndex, revisions: ReadonlyMap<string, number>,
    confirmed: ReadonlyMap<string, number>, checkOptimizedChanges = false): Set<string> {
    const notes = new Set<string>()
    for (const record of index.values()) {
        if (!record.notes.length) continue
        for (const note of record.pendingNotes ?? []) notes.add(note)
        if (record.image && !checkOptimizedChanges) continue
        const file = app.vault.getAbstractFileByPath(record.path)
        if (file instanceof TFile && sameStamp(file, record.stamp) &&
            (revisions.get(record.path) ?? 0) === (confirmed.get(record.path) ?? 0)) continue
        for (const note of record.notes) notes.add(note)
    }
    return notes
}

export function reconcileMediaNotes(index: MediaIndex, processed: ReadonlyMap<string, ReadonlySet<string>>, profile?: string): boolean {
    if (!processed.size) return false
    let changed = false
    const aliasesByNote = new Map<string, Set<string>>()
    for (const [path, names] of processed) for (const name of names) if (name.startsWith('\0alias:')) {
        const record = index.get(name)
        if (!record?.namespaced || record.ankiProfile !== profile || !record.sourceFilename) continue
        const aliases = aliasesByNote.get(path) ?? new Set<string>()
        aliases.add(mediaKey(record.sourceFilename))
        aliasesByNote.set(path, aliases)
    }
    for (const [key, record] of index) {
        if (record.namespaced && record.ankiProfile !== profile) continue
        const sourceKey = record.sourceFilename ? mediaKey(record.sourceFilename) : key
        const marker = record.image ? retiredMediaMarker(key) : undefined
        const notes = record.notes.filter(path => {
            const names = processed.get(path)
            if (!names) return true
            if (record.namespaced) return names.has(key)
            return names.has(sourceKey) && !(marker && names.has(marker)) &&
                !((record.image?.profile ?? record.ankiProfile) === profile && aliasesByNote.get(path)?.has(sourceKey))
        })
        const retained = record.pendingNotes?.length || record.sourceReferences?.length ? new Set(notes) : undefined
        const pendingNotes = record.pendingNotes?.filter(path => retained?.has(path) && !processed.get(path)?.has(key))
        if (notes.length === record.notes.length && pendingNotes?.length === record.pendingNotes?.length) continue
        const sourceReferences = record.sourceReferences?.filter(({ note }) => retained?.has(note))
        index.set(key, { ...record, notes, sourceReferences, pendingNotes: pendingNotes?.length ? pendingNotes : undefined })
        changed = true
    }
    return changed
}

export function localMediaName(link: string): string | undefined {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) return undefined
    const filename = link.split(/[/\\]/).pop()
    return filename || undefined
}

export function mediaNames(links: ReadonlySet<string>): Set<string> {
    return new Set(Array.from(links).flatMap(link => {
        const name = localMediaName(link)
        return name ? [mediaKey(name)] : []
    }))
}

function mergeSourceReferences(previous: MediaRecord | undefined, notes: ReadonlySet<string>,
    references: MediaReference[]): MediaReference[] | undefined {
    const merged = (previous?.sourceReferences ?? []).filter(({ note }) => !notes.has(note))
    for (const reference of references) {
        // Созданные форматтером ссылки обычно уже используют имя файла. Сохраняем только дополнительные соответствия.
        if (localMediaName(reference.link) !== reference.link) merged.push(reference)
    }
    return merged.length ? merged : undefined
}

function encode(bytes: ArrayBuffer): string {
    const array = new Uint8Array(bytes)
    const parts: string[] = []
    // Размер всех частей, кроме последней, кратен трём байтам.
    const step = 12 * 1024
    for (let offset = 0; offset < array.length; offset += step) {
        parts.push(btoa(String.fromCharCode(...array.subarray(offset, offset + step))))
    }
    return parts.join('')
}

function decodeRemoteBytes(value: unknown, maxBytes?: number): ArrayBuffer | null {
    if (value === false) return null
    if (typeof value !== 'string') throw new Error('Anki did not return the attachment bytes.')
    if (maxBytes !== undefined && value.length > 4 * Math.ceil(maxBytes / 3)) {
        throw new Error('The Anki attachment exceeds the comparison limit.')
    }
    const raw = atob(value)
    if (maxBytes !== undefined && raw.length > maxBytes) throw new Error('The Anki attachment exceeds the comparison limit.')
    const bytes = new Uint8Array(raw.length)
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
    return bytes.buffer
}

export async function readAnkiMediaBytes(filename: string, signal?: AbortSignal, maxBytes?: number): Promise<ArrayBuffer | null> {
    if (encodeAnkiMediaFilename(filename) === undefined) throw new Error('An invalid Anki attachment filename was requested.')
    const value: unknown = await withAnkiDeadline(() => AnkiConnect.invoke('retrieveMediaFile', { filename }),
        'Read Anki attachment', 30_000, signal)
    return decodeRemoteBytes(value, maxBytes)
}

async function remoteDigest(filename: string): Promise<string | null> {
    const bytes = await readAnkiMediaBytes(filename)
    return bytes === null ? null : digest(bytes)
}

function unsupportedAction(error: unknown): boolean {
    const message = error instanceof Error ? error.message : error
    return typeof message === 'string' && /unsupported action|unknown action|not implemented|unknown (?:api )?method/i.test(message)
}

function isMediaReadResponse(value: unknown): value is { result: unknown; error: unknown } {
    return typeof value === 'object' && value !== null && 'result' in value && 'error' in value
}

/** Проверяет содержимое в закреплённом профиле непосредственно перед перезаписью файла. */
async function confirmMediaOverwrite(filename: string, expectedDigest: string, profile: string,
    checkProfile: () => Promise<string | undefined>): Promise<void> {
    const requests = [
        { action: 'getActiveProfile', version: 6 },
        { action: 'retrieveMediaFile', version: 6, params: { filename } },
        { action: 'getActiveProfile', version: 6 },
    ]
    let response: unknown
    try {
        // Один пакет запросов чтения сокращает промежуток между проверкой коллекции и файла.
        response = await withAnkiDeadline(() => AnkiConnect.invoke('multi', { actions: requests }), 'Verify Anki attachment before replacing it')
    } catch (error) {
        if (!unsupportedAction(error)) throw error
        const actual = await remoteDigest(filename)
        if (actual !== expectedDigest) throw new Error('The Anki copy changed before export.')
        await checkProfile()
        return
    }
    if (!Array.isArray(response) || response.length !== requests.length || !response.every(isMediaReadResponse) ||
        response.some(row => row.error !== null)) {
        throw new Error('Anki did not confirm the attachment and profile before replacement.')
    }
    const [before, media, after] = response
    if (before.result !== profile || after.result !== profile) {
        // Перед остановкой пакета даём вызывающему коду зарегистрировать подтверждённое несоответствие профиля.
        await checkProfile()
        const reported = before.result !== profile ? before.result : after.result
        if (typeof reported !== 'string' || !reported.trim()) throw new AnkiProfileError('unavailable', profile)
        throw new AnkiProfileError('mismatch', profile, reported)
    }
    const bytes = decodeRemoteBytes(media.result)
    if (bytes === null || await digest(bytes) !== expectedDigest) throw new Error('The Anki copy changed before export.')
}

async function readRemoteCopies(names: ReadonlySet<string>): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>()
    for (const name of names) result.set(name, await remoteDigest(name))
    return result
}

function filenamePattern(filename: string): string {
    const literal = (value: string) => value.replace(/[?*\[\]]/g, character => `[${character}]`)
    return Array.from(filename, character => {
        const upper = character.toUpperCase()
        const lower = character.toLowerCase()
        return upper !== lower && Array.from(upper).length === 1 && Array.from(lower).length === 1
            ? `[${upper}${lower}]` : literal(character)
    }).join('')
}

/** Точный запрос может совпасть без учёта регистра. По возможности уточняем фактическое написание имени на диске. */
async function existingMediaFilename(filename: string, expected: string): Promise<string | undefined> {
    const key = mediaKey(filename)
    const candidates = new Set<string>()
    const patterns = new Set([filenamePattern(filename), filenamePattern(filename.normalize('NFD'))])
    for (const pattern of patterns) {
        let names: unknown
        try {
            names = await withAnkiDeadline(() => AnkiConnect.invoke('getMediaFilesNames', { pattern }), 'Verify Anki attachment filename')
        } catch (error) {
            // При работе со старым AnkiConnect сохраняем существующие ссылки.
            if (error instanceof Error && /unsupported action|unknown action/i.test(error.message)) return undefined
            throw error
        }
        if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) return undefined
        for (const name of names) {
            if (mediaKey(name) === key && encodeAnkiMediaFilename(name) !== undefined) candidates.add(name)
        }
    }
    if (candidates.size > 1) throw new Error('Anki has multiple copies under equivalent filenames.')
    const name = candidates.values().next().value
    if (name !== undefined && await remoteDigest(name) !== expected) {
        throw new Error('The Anki copy changed while verifying its filename.')
    }
    return name
}

function imagePreview(record: MediaRecord, copyPath?: string): OptimizedImagePreview {
    const { originalBytes, optimizedBytes, originalWidth, originalHeight, width, height } = record.image!
    return { filename: record.filename, originalBytes, optimizedBytes, originalWidth, originalHeight, width, height, copyPath }
}

async function needsCopy(app: App, record: MediaRecord, settings?: ImageOptimizationSettings): Promise<string | undefined> {
    if (!settings?.enabled || !settings.saveCopy) return undefined
    const path = `${optimizedImageFolder}/${mediaKey(record.filename)}`
    const file = app.vault.getAbstractFileByPath(path)
    if (!file) return path
    if (!(file instanceof TFile) || await digest(await app.vault.readBinary(file)) !== record.digest) {
        throw new Error(`The Obsidian optimized copy differs at ${path}. Move it before exporting.`)
    }
    return undefined
}

async function storeImageCopy(app: App, path: string, bytes: ArrayBuffer, expected: string): Promise<void> {
    if (await digest(bytes) !== expected) throw new Error('The optimized image bytes changed before saving the Obsidian copy.')
    const vault = app.vault
    const ensure = async () => {
        const folder = vault.getAbstractFileByPath(optimizedImageFolder)
        if (folder instanceof TFolder) return
        if (folder) throw new Error(`Cannot create the optimized image folder at ${optimizedImageFolder}.`)
        try { await vault.createFolder(optimizedImageFolder) } catch (error) {
            if (!(vault.getAbstractFileByPath(optimizedImageFolder) instanceof TFolder)) throw error
        }
    }
    await ensure()
    let file = vault.getAbstractFileByPath(path)
    if (!file) {
        try { file = await vault.createBinary(path, bytes) } catch (error) {
            file = vault.getAbstractFileByPath(path)
            if (!file) throw error
        }
    }
    if (!(file instanceof TFile) || await digest(await vault.readBinary(file)) !== expected) {
        throw new Error(`Could not confirm the Obsidian optimized copy at ${path}.`)
    }
}

interface AttachmentGroup {
    filename: string
    locations: Map<string, { file: TFile; references: MediaReference[] }>
}

async function planNamespaceAlias(app: App, attachment: TFile, sourceFilename: string, references: MediaReference[],
    profile: string, indexKey: string, previous?: MediaRecord): Promise<MediaPlan> {
    const path = attachment.path
    const initialStamp = stamp(attachment)
    const bytes = await app.vault.readBinary(attachment)
    if (attachment.path !== path || !sameStamp(attachment, initialStamp) || bytes.byteLength !== initialStamp[2]) {
        throw new Error('The local attachment changed during the check.')
    }
    const local = await digest(bytes)
    const extension = /\.[a-z0-9]{1,12}$/iu.exec(sourceFilename)?.[0].toLowerCase()
    if (!extension) throw new Error('An unambiguous attachment filename could not be prepared.')
    // Хеш зависит от исходного пути и байтов. Устаревшая копия остаётся в Anki для других карточек.
    const filename = `rupos-media-${await digest(new TextEncoder().encode(JSON.stringify([path, local])).buffer)}${extension}`
    const remote = await remoteDigest(filename)
    if (remote !== null && remote !== local) throw new Error('Anki has a different file at the proposed attachment name.')
    const remoteNames = new Map([[filename, remote]])
    if (previous && previous.filename !== filename) {
        const old = await remoteDigest(previous.filename)
        if (old !== null && old !== previous.digest) throw new Error('The previous Anki attachment changed. Review it first.')
        remoteNames.set(previous.filename, old)
    }
    const notes = new Set(references.map(reference => reference.note))
    const confirmedNotes = new Set(previous?.filename === filename ? previous.notes : [])
    const pendingNotes = new Set([...(previous?.pendingNotes ?? []), ...[...notes].filter(note => !confirmedNotes.has(note))])
    if (previous && previous.filename !== filename) for (const note of previous.notes) pendingNotes.add(note)
    const record: MediaRecord = { filename, path, digest: local, stamp: initialStamp, sourceFilename,
        ankiProfile: profile, canonicalConfirmed: true, namespaced: true,
        sourceReferences: mergeSourceReferences(previous, notes, references),
        notes: [...new Set([...(previous?.notes ?? []), ...notes])], pendingNotes: [...pendingNotes] }
    return { record, sourceFilename, sourceReferences: references, indexKey, notes: [...notes], upload: remote === null,
        remoteBefore: remote, remoteNames, sourceGuard: local, profileGuard: profile, confirmAlias: !previous }
}

/** Вычисляет хеш байтов, которые отправит экспорт. Отличающаяся копия отмечается как конфликт для проверки. */
export async function planMedia(app: App, references: readonly MediaReference[], index: MediaIndex,
    report: (path: string, error: string) => void, settings?: ImageOptimizationSettings,
    showReplacementReferences = false, pinnedProfile?: string,
    allowNewAliases: boolean | ReadonlySet<string> = false): Promise<MediaPlan[]> {
    const groups = new Map<string, AttachmentGroup>()
    for (const { note, link } of references) {
        const filename = localMediaName(link)
        if (!filename) continue
        const attachment = app.metadataCache.getFirstLinkpathDest(link, note)
        if (!(attachment instanceof TFile)) {
            report(note, `Missing attachment ${link}.`)
            continue
        }
        const key = mediaKey(filename)
        const group = groups.get(key) ?? { filename, locations: new Map() }
        const source = group.locations.get(attachment.path) ?? { file: attachment, references: [] }
        source.references.push({ note, link })
        group.locations.set(attachment.path, source)
        groups.set(key, group)
    }
    const plans: MediaPlan[] = []
    const canOptimize = settings?.enabled && Array.from(groups.values()).some(group => /\.(?:jpe?g|png)$/i.test(group.filename))
    const knownManaged = new Set<string>()
    if (groups.size) for (const record of index.values()) {
        if (record.image && record.sourceFilename) {
            const key = mediaKey(record.sourceFilename)
            if (groups.has(key)) knownManaged.add(key)
        }
    }
    const profile = canOptimize || knownManaged.size ? pinnedProfile ?? await activeMediaProfile() : undefined
    let cachedImageBytes = 0
    for (const [key, group] of groups) {
        const { locations } = group
        const sourceFilename = group.filename
        const managedKey = profile ? imageKey(sourceFilename, profile) : undefined
        const managed = managedKey ? index.get(managedKey) : undefined
        const saved = index.get(key)
        // Разрешаем замену только по подтверждению, которое относится к этой коллекции.
        const previous = saved?.ankiProfile === pinnedProfile ? saved : undefined
        const destinationProfile = pinnedProfile ?? profile
        const occupiedPaths = new Set([previous?.path, managed?.path].filter((path): path is string =>
            !!path && app.vault.getAbstractFileByPath(path) instanceof TFile))
        const sourceCounts = new Map<string, number>()
        if (locations.size > 1) for (const source of locations.values()) {
            for (const note of new Set(source.references.map(reference => reference.note))) {
                sourceCounts.set(note, (sourceCounts.get(note) ?? 0) + 1)
            }
        }
        const ambiguous = new Set([...sourceCounts].filter(([, count]) => count > 1).map(([note]) => note))
        for (const note of ambiguous) report(note, `Attachment ${sourceFilename}: multiple attachments in this note use the same Anki filename.`)
        for (const [path, source] of locations) {
            const attachment = source.file
            const sourceReferences = source.references.filter(({ note }) => !ambiguous.has(note))
            const notes = new Set(sourceReferences.map(({ note }) => note))
            if (!notes.size) continue
            const aliasKey = destinationProfile && namespaceKey(path, sourceFilename, destinationProfile)
            const priorAlias = aliasKey ? index.get(aliasKey) : undefined
            // После выбора части карточек второй источник из предпросмотра может не попасть в этот пакет.
            const reviewedSource = typeof allowNewAliases !== 'boolean' && allowNewAliases.has(path)
            let filename = previous?.filename ?? group.filename
            try {
                const collision = occupiedPaths.size ? [...occupiedPaths].some(owner => owner !== path) : locations.size > 1
                if (collision || priorAlias || reviewedSource) {
                    if (!aliasKey || !destinationProfile || !priorAlias && allowNewAliases !== true && !reviewedSource) {
                        throw new Error('Multiple Obsidian files would use this Anki filename. Review the separate attachment names in Preview Export.')
                    }
                    plans.push(await planNamespaceAlias(app, attachment, sourceFilename, sourceReferences, destinationProfile,
                        aliasKey, priorAlias))
                    continue
                }
                if (!profile && knownManaged.has(key)) {
                    throw new Error('Could not confirm the Anki profile for this optimized image.')
                }
                for (const owner of [previous, managed]) {
                    if (owner && owner.path !== path && app.vault.getAbstractFileByPath(owner.path) instanceof TFile) {
                        throw new Error(`Anki already uses this filename for ${owner.path}.`)
                    }
                }
                const initialStamp = stamp(attachment)
                const bytes = await app.vault.readBinary(attachment)
                if (attachment.path !== path || !sameStamp(attachment, initialStamp)) throw new Error('The local attachment changed during the check.')
                const local = await digest(bytes)
                const current = managed?.path === path ? managed : undefined
                const replace = Boolean(settings?.enabled && settings.replaceOriginal && /\.(?:jpe?g|png)$/i.test(sourceFilename) &&
                    !isOptimizedImageCopyPath(path))
                const replaced = replace ? await readImageReplacement(app, path, local) : undefined
                const prepareReplacement = replace && !replaced && (!current?.image || current.image.sourceDigest === local ||
                    settings?.checkChanges === true)
                if (replace && !profile) throw new Error('Could not verify the active Anki profile before replacing this image.')
                const imageChecks = new Map<string, string | null>()
                if (current?.image) {
                    const remote = await remoteDigest(current.filename)
                    imageChecks.set(current.filename, remote)
                    if (remote !== null && remote !== current.digest) {
                        throw new Error('Anki has a different copy of the optimized image. Review it before replacing it.')
                    }
                    const followChanges = settings?.enabled && settings.checkChanges
                    if (remote !== null && !prepareReplacement && (!replaced || current.digest === local) &&
                        (current.image.sourceDigest === local || !followChanges)) {
                        const alreadyBound = new Set(current.notes)
                        const pendingNotes = new Set(current.pendingNotes)
                        for (const path of notes) if (!alreadyBound.has(path)) pendingNotes.add(path)
                        const record = { ...current, stamp: initialStamp, notes: Array.from(new Set([...current.notes, ...notes])),
                            sourceReferences: mergeSourceReferences(current, notes, sourceReferences), pendingNotes: [...pendingNotes] }
                        plans.push({ record, sourceFilename, sourceReferences, indexKey: managedKey!, notes: [...notes], upload: false,
                            remoteBefore: remote, remoteNames: imageChecks, sourceGuard: local,
                            optimized: imagePreview(record, await needsCopy(app, record, settings)) })
                        continue
                    }
                }
                // Anki может нормализовать имена при сохранении медиа. Под запрошенным
                // именем и известным ему соответствием уже могут лежать разные файлы.
                const remoteCopies = await readRemoteCopies(new Set([filename, group.filename, mediaKey(group.filename)]))
                let remote: string | null = null
                for (const [name, hash] of remoteCopies) {
                    if (hash === null) continue
                    if (remote !== null && hash !== remote) throw new Error('Anki has different copies under equivalent filenames.')
                    if (remote === null) { filename = name; remote = hash }
                }
                if (replace && !current && remote !== null && remote !== local && remote !== replaced?.sourceHash &&
                    (!previous || previous.path !== path || remote !== previous.digest)) {
                    throw new Error('Anki has a different copy. Review the attachment before replacing the Obsidian image.')
                }
                if (!isOptimizedImageCopyPath(path) && profile && managedKey && settings?.enabled && (remote === null || current || replace)) {
                    const result: OptimizedImage | undefined = replaced
                        ? { bytes, originalWidth: replaced.originalWidth ?? replaced.width ?? 0,
                            originalHeight: replaced.originalHeight ?? replaced.height ?? 0,
                            width: replaced.width ?? 0, height: replaced.height ?? 0 }
                        : await optimizeImage(bytes, sourceFilename, settings)
                    if (result) {
                        const outgoing = await digest(result.bytes)
                        const extension = /\.png$/i.test(sourceFilename) ? 'png' : 'jpg'
                        const generatedName = `anki-opt-${outgoing}.${extension}`
                        const target = current && mediaKey(current.filename) === generatedName ? current.filename : generatedName
                        const before = imageChecks.has(target) ? imageChecks.get(target)! : await remoteDigest(target)
                        if (before !== null && before !== outgoing) throw new Error('Anki has a different file at this optimized image name.')
                        imageChecks.set(target, before)
                        const confirmedNotes = new Set(current && current.filename === target ? current.notes : [])
                        const pendingNotes = Array.from(new Set([...(current?.pendingNotes ?? []),
                            ...(current && current.filename !== target ? current.notes : []),
                            ...Array.from(notes).filter(note => !confirmedNotes.has(note))]))
                        const record: MediaRecord = {
                            filename: target, path, digest: outgoing, stamp: initialStamp, sourceFilename,
                            sourceReferences: mergeSourceReferences(current, notes, sourceReferences),
                            notes: Array.from(new Set([...(current?.notes ?? []), ...notes])), pendingNotes,
                            image: { profile, sourceDigest: replace ? outgoing : local,
                                originalBytes: replaced?.beforeBytes ?? bytes.byteLength, optimizedBytes: result.bytes.byteLength,
                                originalWidth: result.originalWidth, originalHeight: result.originalHeight, width: result.width, height: result.height },
                        }
                        const replacePath = replace && !replaced ? path : undefined
                        const copyPath = replace ? undefined : await needsCopy(app, record, settings)
                        const keepBytes = (before === null || copyPath || replacePath) &&
                            cachedImageBytes + result.bytes.byteLength <= 32 * 1024 * 1024
                        if (keepBytes) cachedImageBytes += result.bytes.byteLength
                        plans.push({ record, sourceFilename, sourceReferences, indexKey: managedKey, notes: [...notes], upload: before === null,
                            remoteBefore: before, remoteNames: imageChecks, sourceGuard: local, imageSettings: settings,
                            optimized: { ...imagePreview(record, copyPath), replacePath },
                            optimizedBytes: keepBytes ? result.bytes : undefined })
                        continue
                    }
                }
                if (remote !== local && remote !== null &&
                    (!previous || previous.path !== path || remote !== previous.digest)) {
                    throw new Error('Anki has a different copy. Review the attachment before replacing it.')
                }
                const previousOwner = previous?.path === path ? previous : undefined
                const previousNotes = previousOwner?.notes ?? []
                let canonicalConfirmed = previousOwner?.canonicalConfirmed && previousOwner.filename === filename
                if (!canonicalConfirmed && remote !== null && (mediaKey(sourceFilename) !== sourceFilename ||
                    encodeAnkiMediaFilename(sourceFilename) !== sourceFilename || filename !== sourceFilename)) {
                    const matches = Array.from(remoteCopies).filter(([, hash]) => hash !== null)
                    // Если поиск по другому написанию завершился ошибкой, Anki различает эти имена.
                    const confirmedName = matches.length === 1 && remoteCopies.size > 1 ? matches[0][0]
                        : await existingMediaFilename(filename, remote)
                    if (confirmedName) {
                        filename = confirmedName
                        remoteCopies.set(confirmedName, remote)
                        canonicalConfirmed = true
                    }
                }
                const record: MediaRecord = { filename, path, digest: local, stamp: initialStamp, ankiProfile: pinnedProfile,
                    sourceFilename, sourceReferences: mergeSourceReferences(previousOwner, notes, sourceReferences),
                    canonicalConfirmed,
                    notes: Array.from(new Set([...previousNotes, ...notes])), pendingNotes: previousOwner?.pendingNotes }
                if (hasMediaAlias(record) &&
                    (!previousOwner?.canonicalConfirmed || previousOwner.filename !== record.filename)) {
                    record.pendingNotes = Array.from(new Set([...record.notes, ...(record.pendingNotes ?? [])]))
                }
                plans.push({ record, sourceFilename, sourceReferences, indexKey: key, notes: [...notes], remoteBefore: remote,
                    remoteNames: new Map([...remoteCopies, ...imageChecks]), upload: remote !== local,
                    retiredImageKey: current ? managedKey : undefined, profileGuard: current ? profile : undefined })
            } catch (error) {
                for (const note of notes) report(note, `Attachment ${filename}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }
    if (showReplacementReferences) {
        const replacements = new Map(plans.flatMap(plan => plan.optimized?.replacePath
            ? [[plan.optimized.replacePath, plan.optimized] as const] : []))
        if (replacements.size) {
            for (const [note, links] of Object.entries(app.metadataCache.resolvedLinks ?? {})) {
                for (const link of Object.keys(links)) {
                    const preview = replacements.get(link)
                    if (!preview) continue
                    preview.references ??= { total: 0, sample: [] }
                    preview.references.total++
                    if (preview.references.sample.length < 5) preview.references.sample.push(note)
                }
            }
        }
    }
    return plans
}

export async function applyMedia(app: App, plans: readonly MediaPlan[], index: MediaIndex,
    report: (path: string, error: string) => void, confirmed = new Set<string>(), shouldStop?: () => boolean,
    onReady?: (plan: MediaPlan) => void, backedUpProfile?: string,
    checkAnkiProfile?: (confirmCommitted?: boolean) => Promise<string>,
    onWriteRequest?: (answered: boolean) => void): Promise<Set<string>> {
    const sent = new Set<string>()
    for (const plan of plans) {
        const { record, notes, upload, remoteBefore, remoteNames } = plan
        if (shouldStop?.()) break
        try {
            const file = app.vault.getAbstractFileByPath(record.path)
            if (!(file instanceof TFile) || !sameStamp(file, record.stamp)) throw new Error('The local attachment changed before export.')
            let confirmedFilename = record.filename
            let canonicalConfirmed = record.canonicalConfirmed
            const copyPath = plan.optimized?.copyPath
            const replacePath = plan.optimized?.replacePath
            const plannedProfile = record.image?.profile ?? plan.profileGuard
            if (backedUpProfile && plannedProfile && backedUpProfile !== plannedProfile) {
                throw new Error('The Anki profile for this image does not match the backup. Start the export again.')
            }
            const profile = plannedProfile ?? backedUpProfile ?? record.ankiProfile
            const checkProfile = async (confirmCommitted = false): Promise<string | undefined> => {
                if (checkAnkiProfile) return checkAnkiProfile(confirmCommitted)
                if (profile && await activeMediaProfile() !== profile) {
                    throw new Error('The active Anki profile changed during image export.')
                }
                return profile
            }
            let needsUpload = upload
            let outgoing = plan.optimizedBytes
            let currentBytes: ArrayBuffer | undefined
            if (upload || copyPath || replacePath || plannedProfile) {
                currentBytes = await app.vault.readBinary(file)
                if (await digest(currentBytes) !== (plan.sourceGuard ?? record.digest)) {
                    throw new Error('The local attachment changed before export.')
                }
                if ((upload || replacePath) && !outgoing) {
                    outgoing = record.digest === plan.sourceGuard ? currentBytes : record.image && plan.imageSettings
                        ? (await optimizeImage(currentBytes, plan.sourceFilename, plan.imageSettings))?.bytes
                        : currentBytes
                }
                if ((upload || replacePath) && (!outgoing || (record.image && await digest(outgoing) !== record.digest))) {
                    throw new Error('The prepared attachment bytes changed before export. Reopen the preview.')
                }
                for (const [filename, expectedRemote] of remoteNames) {
                    const actualRemote = await remoteDigest(filename)
                    if ((record.image || record.namespaced) && filename === record.filename && expectedRemote === null && actualRemote === record.digest) {
                        // Другой исходник в этом пакете дал такие же оптимизированные байты.
                        needsUpload = false
                    } else if (actualRemote !== expectedRemote) {
                        throw new Error('The Anki copy changed before export.')
                    }
                }
                if (record.image && (needsUpload || copyPath || replacePath) && await digest(await app.vault.readBinary(file)) !== plan.sourceGuard) {
                    throw new Error('The local image changed while checking the Anki copy. Preview the export again.')
                }
                if (profile && !checkAnkiProfile) await checkProfile()
                if (file.path !== record.path || !sameStamp(file, record.stamp)) throw new Error('The local attachment changed before export.')
                if (shouldStop?.()) break
            }
            if (replacePath && currentBytes && outgoing && plan.imageSettings && plan.sourceGuard && plan.optimized) {
                await checkProfile()
                await prepareImageReplacement(app, file, currentBytes, outgoing, plan.imageSettings,
                    plan.sourceGuard, record.digest, plan.optimized, async () => {
                        await checkProfile()
                        return !shouldStop?.()
                    }, shouldStop)
                if (file.path !== replacePath || await digest(await app.vault.readBinary(file)) !== record.digest) {
                    throw new Error('The replaced image changed before it could be sent to Anki.')
                }
                if (shouldStop?.()) break
                record.stamp = stamp(file)
            }
            if (needsUpload && outgoing) {
                // При отправке нового файла сохраняем файл, созданный после предварительной проверки.
                const data = encode(outgoing)
                const confirmedProfile = await checkProfile()
                if (remoteBefore !== null) {
                    if (!confirmedProfile) throw new AnkiProfileError('unavailable')
                    await confirmMediaOverwrite(record.filename, remoteBefore, confirmedProfile, checkProfile)
                }
                if (file.path !== record.path || !sameStamp(file, record.stamp)) throw new Error('The local attachment changed before export.')
                if (shouldStop?.()) break
                if (hasPendingAnkiWrite(app)) throw new Error(pendingAnkiWriteMessage)
                const filename = await withAnkiWriteDeadline(app, () => {
                    onWriteRequest?.(false)
                    return AnkiConnect.invoke('storeMediaFile', {
                        filename: record.filename, data, deleteExisting: remoteBefore !== null,
                    })
                }, 'Store Anki attachment')
                onWriteRequest?.(true)
                if (typeof filename === 'string' && mediaKey(filename) !== mediaKey(record.filename) && remoteBefore === null) {
                    throw new Error('The filename became occupied before upload. Anki retained its copy.')
                }
                if (typeof filename !== 'string' || encodeAnkiMediaFilename(filename) === undefined ||
                    mediaKey(filename) !== mediaKey(record.filename) ||
                    await remoteDigest(filename) !== record.digest) throw new Error('Could not verify the exported bytes in Anki.')
                await checkProfile(true)
                confirmedFilename = filename
                canonicalConfirmed = true
                for (const path of notes) sent.add(path)
            }
            if (copyPath) {
                const copy = outgoing ?? await readAnkiMediaBytes(confirmedFilename)
                if (copy === null) throw new Error('Anki did not return the optimized image for saving in Obsidian.')
                await checkProfile()
                if (shouldStop?.()) break
                await storeImageCopy(app, copyPath, copy, record.digest)
            }
            if (!needsUpload && !copyPath && checkAnkiProfile) await checkProfile()
            const fixed = { ...record, filename: confirmedFilename, canonicalConfirmed }
            if (!record.image && hasMediaAlias(fixed) &&
                (!record.canonicalConfirmed || confirmedFilename !== record.filename)) {
                fixed.pendingNotes = Array.from(new Set([...fixed.notes, ...(fixed.pendingNotes ?? [])]))
            }
            index.set(plan.indexKey, fixed)
            confirmed.add(record.path)
            onReady?.({ ...plan, record: fixed })
        } catch (error) {
            for (const path of notes) report(path, `Attachment ${record.filename}: ${error instanceof Error ? error.message : String(error)}`)
            if (error instanceof AnkiProfileError || hasPendingAnkiWrite(app)) break
        }
    }
    return sent
}
