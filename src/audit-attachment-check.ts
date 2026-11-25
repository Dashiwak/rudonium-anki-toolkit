/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { TFile } from 'obsidian'
import type { App } from 'obsidian'
import * as AnkiConnect from './anki'
import { checkPinnedAnkiProfile } from './anki-profile'
import { withAnkiDeadline } from './anki-transport'
import { encodeAnkiMediaFilename } from './image-field-links'
import { imageHash } from './image-optimizer'
import * as media from './media-sync'
import type { SyncAuditResult } from './sync-audit'
import type { UiText } from './interface-language'

export interface AuditAttachmentSource {
    path: string
    links: readonly string[]
    aliases?: ReadonlyMap<string, string>
}

export interface AuditAttachmentIssue {
    kind: 'missing-local' | 'missing-anki' | 'same-local-name' | 'same-anki-name' | 'different-anki-name'
    name: string
    sources: readonly string[]
    locations?: readonly string[]
}

export interface AuditAttachmentReport {
    issues: AuditAttachmentIssue[]
    namesChecked: number
    profile?: string
    remoteProblem?: string
}

const rememberedSources = new WeakMap<SyncAuditResult, readonly AuditAttachmentSource[]>()
const rememberedDeckMembers = new WeakMap<SyncAuditResult, ReadonlySet<number>>()
const maxVerifyBytes = 32 * 1024 * 1024

export function rememberAttachmentDeckMembers(result: SyncAuditResult, ids: ReadonlySet<number>): void {
    rememberedDeckMembers.set(result, ids)
}

export function attachmentDeckMembers(result: SyncAuditResult): ReadonlySet<number> | undefined {
    const ids = rememberedDeckMembers.get(result)
    rememberedDeckMembers.delete(result)
    return ids
}

export function rememberAuditAttachmentSources(result: SyncAuditResult, sources: readonly AuditAttachmentSource[]): void {
    if (sources.length) rememberedSources.set(result, sources)
}

export function hasAuditAttachmentSources(result: SyncAuditResult): boolean {
    return rememberedSources.has(result)
}

function abortIfNeeded(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Attachment audit cancelled', 'AbortError')
}

function filenameKey(name: string): string { return name.normalize('NFC').toLowerCase() }

function aliasForLink(source: AuditAttachmentSource, link: string, name: string): string {
    const direct = source.aliases?.get(link) ?? source.aliases?.get(name)
    if (direct) return direct
    const candidates = new Set<string>()
    const key = filenameKey(name)
    for (const [from, to] of source.aliases ?? []) if (filenameKey(from) === key) candidates.add(to)
    return candidates.size === 1 ? candidates.values().next().value ?? name : name
}

function comparisonProfile(result: SyncAuditResult): string | undefined {
    const active = result.ankiProfile
    return active && 'active' in active && (!active.expected || active.active === active.expected) ? active.active : undefined
}

export async function auditAttachmentPresence(app: App, result: SyncAuditResult, signal?: AbortSignal): Promise<AuditAttachmentReport> {
    const attachments = rememberedSources.get(result) ?? []
    const local = new Map<string, { name: string; files: Set<string>; notes: Set<string>; distinctNames: Map<string, Set<string>> }>()
    const remote = new Map<string, { names: Set<string>; notes: Set<string> }>()
    const issues: AuditAttachmentIssue[] = []
    for (const source of attachments) {
        const { path, links } = source
        abortIfNeeded(signal)
        for (const link of links) {
            const name = media.localMediaName(link)
            if (!name || encodeAnkiMediaFilename(name) === undefined) continue
            const remoteName = aliasForLink(source, link, name)
            const destination = app.metadataCache.getFirstLinkpathDest(link, path)
            if (!(destination instanceof TFile)) {
                issues.push({ kind: 'missing-local', name: link, sources: [path] })
            } else {
                const key = filenameKey(name)
                const entry = local.get(key) ?? { name, files: new Set<string>(), notes: new Set<string>(), distinctNames: new Map<string, Set<string>>() }
                entry.files.add(destination.path)
                entry.notes.add(path)
                const remoteKey = filenameKey(remoteName)
                const owners = entry.distinctNames.get(remoteKey) ?? new Set<string>()
                owners.add(destination.path)
                entry.distinctNames.set(remoteKey, owners)
                local.set(key, entry)
            }
            if (encodeAnkiMediaFilename(remoteName) === undefined) continue
            const remoteKey = filenameKey(remoteName)
            const wanted = remote.get(remoteKey) ?? { names: new Set<string>(), notes: new Set<string>() }
            wanted.names.add(remoteName)
            wanted.notes.add(path)
            remote.set(remoteKey, wanted)
        }
    }
    for (const { name, files, notes, distinctNames } of local.values()) if (files.size > 1 &&
        Array.from(distinctNames.values()).some(paths => paths.size > 1)) {
        issues.push({ kind: 'same-local-name', name, sources: [...notes], locations: [...files] })
    }
    if (!remote.size) return { issues, namesChecked: 0 }
    const profile = comparisonProfile(result)
    if (!profile) return { issues, namesChecked: 0, remoteProblem: 'profile' }
    try {
        await checkPinnedAnkiProfile(profile, signal)
        const response: unknown = await withAnkiDeadline(() => AnkiConnect.invoke('getMediaFilesNames', { pattern: '*' }),
            'Read Anki attachment names', 20_000, signal)
        if (!Array.isArray(response) || !response.every(name => typeof name === 'string')) {
            throw new Error('AnkiConnect did not return a list of attachment names.')
        }
        await checkPinnedAnkiProfile(profile, signal)
        abortIfNeeded(signal)
        const found = new Map<string, Set<string>>()
        for (const name of response) {
            if (encodeAnkiMediaFilename(name) === undefined) continue
            const key = filenameKey(name)
            if (!remote.has(key)) continue
            const names = found.get(key) ?? new Set<string>()
            names.add(name)
            found.set(key, names)
        }
        for (const [key, { names, notes }] of remote) {
            const copies = found.get(key)
            const locations = copies ? [...copies] : undefined
            for (const name of names) {
                const kind = !copies?.size ? 'missing-anki' : copies.size > 1 ? 'same-anki-name'
                    : !copies.has(name) ? 'different-anki-name' : undefined
                if (kind) issues.push({ kind, name, sources: [...notes], locations })
            }
        }
        return { issues, profile, namesChecked: remote.size }
    } catch (error) {
        abortIfNeeded(signal)
        return { issues, profile, namesChecked: 0, remoteProblem: error instanceof Error ? error.message : String(error) }
    }
}

export async function verifyLocalAttachmentContents(app: App, paths: readonly string[], signal?: AbortSignal): Promise<boolean> {
    let total = 0
    const files = paths.map(path => {
        const file = app.vault.getAbstractFileByPath(path)
        if (!(file instanceof TFile) || file.path !== path) throw new Error(`Missing attachment ${path}.`)
        const { mtime, ctime, size } = file.stat
        if (!Number.isSafeInteger(size) || size < 0 || (total += size) > maxVerifyBytes) {
            throw new Error('Attachment group exceeds the 32 MiB verification limit.')
        }
        return { file, path, mtime, ctime, size }
    })
    const unchanged = ({ file, path, mtime, ctime, size }: typeof files[number]) =>
        file.path === path && file.stat.mtime === mtime && file.stat.ctime === ctime && file.stat.size === size &&
        app.vault.getAbstractFileByPath(path) === file
    const fingerprints = new Set<string>()
    for (const item of files) {
        abortIfNeeded(signal)
        if (!unchanged(item)) throw new Error('An attachment changed during verification.')
        const bytes = await app.vault.readBinary(item.file)
        if (bytes.byteLength !== item.size || !unchanged(item)) throw new Error('An attachment changed during verification.')
        fingerprints.add(await imageHash(bytes))
    }
    abortIfNeeded(signal)
    if (!files.every(unchanged)) throw new Error('An attachment changed during verification.')
    return fingerprints.size < 2
}

export interface AttachmentComparisonTarget {
    note: string
    link: string
    localPath: string
    remoteName: string
}

export type AttachmentComparison = { matches: boolean; localBytes: number; remoteBytes: number } | { missing: true }

export function auditAttachmentComparisonTargets(app: App, result: SyncAuditResult, query = ''): {
    items: AttachmentComparisonTarget[]; hasMore: boolean
} {
    const items: AttachmentComparisonTarget[] = []
    const seen = new Set<string>()
    const search = filenameKey(query.trim())
    for (const source of rememberedSources.get(result) ?? []) for (const link of source.links) {
        const name = media.localMediaName(link)
        if (!name || encodeAnkiMediaFilename(name) === undefined) continue
        const remoteName = aliasForLink(source, link, name)
        if (encodeAnkiMediaFilename(remoteName) === undefined ||
            !filenameKey(`${source.path}\n${link}\n${remoteName}`).includes(search)) continue
        const file = app.metadataCache.getFirstLinkpathDest(link, source.path)
        if (!(file instanceof TFile)) continue
        const key = JSON.stringify([file.path, remoteName])
        if (seen.has(key)) continue
        if (items.length === 100) return { items, hasMore: true }
        seen.add(key)
        items.push({ note: source.path, link, localPath: file.path, remoteName })
    }
    return { items, hasMore: false }
}

export async function verifyAuditAttachmentInAnki(app: App, result: SyncAuditResult, target: AttachmentComparisonTarget,
    signal?: AbortSignal): Promise<AttachmentComparison> {
    const sources = rememberedSources.get(result)
    const source = sources?.find(item => item.path === target.note && item.links.includes(target.link))
    const name = media.localMediaName(target.link)
    const profile = comparisonProfile(result)
    if (!source || !name || !profile || aliasForLink(source, target.link, name) !== target.remoteName) {
        throw new Error('The attachment or profile is not confirmed by this audit.')
    }
    const file = app.metadataCache.getFirstLinkpathDest(target.link, target.note)
    if (!(file instanceof TFile) || file.path !== target.localPath) throw new Error('The attachment source changed.')
    const { mtime, ctime, size } = file.stat
    if (!Number.isSafeInteger(size) || size < 0 || size > maxVerifyBytes) {
        throw new Error('The local attachment exceeds the 32 MiB verification limit.')
    }
    const unchanged = () => app.metadataCache.getFirstLinkpathDest(target.link, target.note) === file &&
        app.vault.getAbstractFileByPath(target.localPath) === file && file.path === target.localPath &&
        file.stat.mtime === mtime && file.stat.ctime === ctime && file.stat.size === size
    abortIfNeeded(signal)
    await checkPinnedAnkiProfile(profile, signal)
    const local = await app.vault.readBinary(file)
    if (local.byteLength !== size || !unchanged()) throw new Error('The attachment source changed.')
    abortIfNeeded(signal)
    const remote = await media.readAnkiMediaBytes(target.remoteName, signal, maxVerifyBytes)
    await checkPinnedAnkiProfile(profile, signal)
    if (!unchanged()) throw new Error('The attachment source changed.')
    abortIfNeeded(signal)
    if (remote === null) return { missing: true }
    const matches = local.byteLength === remote.byteLength && await imageHash(local) === await imageHash(remote)
    abortIfNeeded(signal)
    if (!unchanged()) throw new Error('The attachment source changed.')
    return { matches, localBytes: local.byteLength, remoteBytes: remote.byteLength }
}

export function renderAttachmentContentChecks(panel: HTMLElement, app: App, result: SyncAuditResult,
    t: UiText, signal?: AbortSignal): void {
    if (!comparisonProfile(result)) return
    const link = panel.createEl('button', { text: t('Choose a file to compare with Anki', 'Выбрать файл для сравнения с Anki') })
    link.onclick = () => {
        link.remove()
        const area = panel.createDiv()
        const queryLabel = area.createEl('label', { text: t('Filename or source note', 'Имя файла или исходной заметки') })
        const query = queryLabel.createEl('input', { attr: { type: 'search' } })
        const fileLabel = area.createEl('label', { text: t('Local path and Anki filename', 'Локальный путь и имя файла в Anki') })
        const file = fileLabel.createEl('select')
        const hint = area.createEl('p')
        area.createEl('p', { text: t('Optimized copies can differ from the original. Files up to 32 MiB each are compared.',
            'Оптимизированная копия может отличаться от оригинала. Сравниваются файлы до 32 МиБ каждый.') })
        const check = area.createEl('button', { text: t('Compare with Anki', 'Сравнить с Anki') })
        const feedback = area.createEl('p', { attr: { role: 'status' } })
        let choices: AttachmentComparisonTarget[] = []
        const refresh = () => {
            const { items, hasMore } = auditAttachmentComparisonTargets(app, result, query.value)
            choices = items
            file.empty()
            for (const [index, item] of items.entries()) file.createEl('option', {
                value: String(index), text: `${item.localPath} → ${item.remoteName}`,
            })
            check.disabled = !items.length
            hint.setText(hasMore ? t('First 100 files shown. Narrow the search.', 'Показаны первые 100 файлов. Уточните поиск.') : '')
            feedback.setText('')
        }
        query.onchange = refresh
        check.onclick = async () => {
            const target = choices[file.selectedIndex]
            if (!target) return
            query.disabled = file.disabled = check.disabled = true
            feedback.setText(t('Comparing the selected files…', 'Сравниваю выбранные файлы…'))
            try {
                const comparison = await verifyAuditAttachmentInAnki(app, result, target, signal)
                if (signal?.aborted) return
                feedback.setText('missing' in comparison ? t('The selected file is missing in Anki.', 'Выбранного файла нет в Anki.')
                    : comparison.matches ? t('The file contents match.', 'Содержимое файлов совпадает.')
                        : t(`The files differ. Obsidian: ${comparison.localBytes} bytes. Anki: ${comparison.remoteBytes} bytes.`,
                            `Файлы различаются. Obsidian — ${comparison.localBytes} байт. Anki — ${comparison.remoteBytes} байт.`))
            } catch (error) {
                if (signal?.aborted) return
                console.warn('[Rudonium Anki Toolkit] Не удалось сравнить вложения', error)
                feedback.setText(t('Comparison unavailable. Check the profile and file size, then refresh the audit.',
                    'Сравнение недоступно. Проверьте профиль и размер файла, затем обновите аудит.'))
            } finally { query.disabled = file.disabled = check.disabled = false }
        }
        refresh()
        query.focus()
    }
}
