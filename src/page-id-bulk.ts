// SPDX-License-Identifier: GPL-3.0-only
import { hashes as crypto } from './desktop-io'
import { mayHavePageTag, hasPageYamlIdText } from './page-frontmatter'
import { MarkdownView } from 'obsidian'
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import { withFastScanReadLock } from './fast-scan'
import { createFullMigrationBackup } from './vault-backup'
import { indexVaultIds } from './vault-id-index'
import { archivedIdMarkers, findIdMarkers } from './duplicate-markers'
import { markedPageAnswerBoundary } from './anki-id-marker'
import { foreignMigrationIds } from './page-migration-router'
import { movePageId } from './page-id-move'
import { verifyPageMoveSource } from './id-marker-conversion'
import { readPageCard } from './page-card'
import { sameEditorText } from './markdown-pipeline'
import { uiDiagnostic, uiFor } from './interface-language'
import { hasPendingAnkiWrite } from './anki-transport'
import { hasPendingBidirectionalWrite } from './bidirectional-sync'
import type { PageIdLocation } from './page-id-location'

export type PageIdPlace = PageIdLocation
export type PageIdBulkSource = PageIdPlace | 'all'
interface PageFile { path: string; id: number; from: PageIdPlace }
export interface PageIdBulkPlan {
    source: PageIdBulkSource
    target: PageIdPlace
    scanned: number
    files: readonly PageFile[]
    skipped: readonly { path: string; reason: string }[]
}
interface Draft extends PageFile { file: TFile; beforeHash: string }
interface Edit extends Draft { before: string; after: string }
interface Stored { plugin: MyPlugin; signature: string; target: PageIdPlace; rows: Map<string, Draft> }
const plans = new WeakMap<PageIdBulkPlan, Stored>()
const pageRules = { Rudonium: '@page' }
const places = ['heading', 'yaml', 'after-answer']
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
const signature = (p: MyPlugin) => JSON.stringify([p.settings.Syntax, p.settings.Defaults?.['ID Comments'], p.settings.VAULT_BACKUP, p.settings.PAGE_ID_LOCATION])
const stale = (p: MyPlugin) => new Error(uiFor(p.settings)('The vault or settings changed. Preview the move again.', 'Хранилище или настройки изменились. Повторите предпросмотр переноса.'))
function checkIdle(p: MyPlugin): void {
    if (hasPendingAnkiWrite(p.app) || hasPendingBidirectionalWrite(p.app)) throw new Error(uiFor(p.settings)(
        'Finish the pending synchronization before moving page IDs.', 'Завершите незаконченные операции синхронизации перед переносом ID.'))
}
function dirtyEditors(p: MyPlugin): MarkdownView[] {
    const views: MarkdownView[] = []
    for (const { view } of p.app.workspace.getLeavesOfType('markdown')) {
        if (view instanceof MarkdownView && view.file && view.getMode() === 'source' && !sameEditorText(view.getViewData(), view.data)) views.push(view)
    }
    return views
}
function foreignClaims(text: string): readonly number[] {
    if (!/noteId|deckID|\bnid\b|\^\d{13}|anki-note-id/iu.test(text)) return []
    let boundary: number | undefined
    try { boundary = markedPageAnswerBoundary(text) } catch { /* Reserve possible owners on a malformed page. */ }
    return foreignMigrationIds(text.slice(0, boundary))
}

/** Use the full disk inventory plus unsaved editor owners even when a sync profile excludes their folders. */
async function inventory(p: MyPlugin, revision: () => number, pathRevision: (path: string) => number,
    visit: (file: TFile, path: string, text: string) => void, progress?: (done: number, total: number) => void) {
    const files = p.app.vault.getMarkdownFiles(), start = revision()
    const other = new Map<number, string>(), conflicts = new Set<number>()
    const claim = (id: number, path: string) => {
        const prior = other.get(id)
        if (prior !== undefined && prior !== path) conflicts.add(id)
        else other.set(id, path)
    }
    let done = 0
    const index = await indexVaultIds(p, files, p.settings.Syntax, pathRevision, {
        force: true, includeArchivedOwners: true, onFile(file, path, _markers, text) {
            if (text === undefined) throw stale(p)
            for (const id of foreignClaims(text)) claim(id, path)
            visit(file, path, text)
            progress?.(++done, files.length)
        },
    })
    if (!index.complete) throw new Error(uiFor(p.settings)(
        'Could not verify ID ownership across the vault. ', 'Не удалось проверить владельцев ID во всём хранилище. ') +
        index.errors.slice(0, 4).map(item => item.path + ' — ' + item.message).join('\n'))
    if (start !== revision()) throw stale(p)
    const dirty = new Set<string>()
    for (const view of dirtyEditors(p)) {
        const path = view.file!.path, text = view.getViewData()
        dirty.add(path)
        for (const marker of findIdMarkers(text, p.settings.Syntax)) claim(marker.id, path)
        for (const marker of archivedIdMarkers(text)) claim(marker.id, path)
        for (const id of foreignClaims(text)) claim(id, path)
    }
    return { scanned: files.length, dirty, owns: (row: PageFile) => index.first.get(row.id)?.path === row.path &&
        !index.duplicates.has(row.id) && !conflicts.has(row.id) && (!other.has(row.id) || other.get(row.id) === row.path) }
}

export function previewPageIdBulk(plugin: MyPlugin, source: PageIdBulkSource, target: PageIdPlace,
    onProgress?: (done: number, total: number) => void): Promise<PageIdBulkPlan> {
    return withFastScanReadLock(plugin, async (revision, pathRevision) => {
        const t = uiFor(plugin.settings), initial = signature(plugin)
        if (!places.includes(target) || source !== 'all' && !places.includes(source)) throw new Error(t('Unknown page ID location.', 'Неизвестное расположение ID страницы.'))
        const candidates: Draft[] = [], skipped: Array<{ path: string; reason: string }> = []
        const index = await inventory(plugin, revision, pathRevision, (file, path, text) => {
            if (!mayHavePageTag(text) && !hasPageYamlIdText(text)) return
            try {
                const page = readPageCard(text, pageRules, plugin.settings.Syntax)
                if (!page?.id || !page.idLocation || page.idLocation === target || source !== 'all' && page.idLocation !== source) return
                if (foreignClaims(text).some(id => id !== page.id)) throw new Error(t(
                    'Another plugin references a different Anki note in this page.', 'Другой плагин указывает на другую запись Anki в этой странице.'))
                movePageId(text, target, plugin.settings.Defaults?.['ID Comments'] !== false, plugin.settings.Syntax, t)
                candidates.push({ file, path, id: page.id, from: page.idLocation, beforeHash: hash(text) })
            } catch (error) { skipped.push({ path, reason: uiDiagnostic(error, t) }) }
        }, onProgress)
        const rows = new Map<string, Draft>()
        candidates.sort((a, b) => a.path.localeCompare(b.path))
        for (const row of candidates) {
            if (index.dirty.has(row.path)) skipped.push({ path: row.path, reason: t('Save open edits first.', 'Сначала сохраните правки в редакторе.') })
            else if (!index.owns(row)) skipped.push({ path: row.path, reason: t('Another file or open editor claims this ID.', 'Этот ID встречается в другом файле или открытом редакторе.') })
            else rows.set(row.path, row)
        }
        if (signature(plugin) !== initial) throw stale(plugin)
        const plan: PageIdBulkPlan = { source, target, scanned: index.scanned,
            files: [...rows.values()].map(({ path, id, from }) => ({ path, id, from })), skipped: skipped.sort((a,b) => a.path.localeCompare(b.path)) }
        plans.set(plan, { plugin, signature: initial, target, rows })
        return plan
    })
}

export function applyPageIdBulk(plugin: MyPlugin, plan: PageIdBulkPlan,
    selected?: ReadonlySet<string>): Promise<{ changed: number; backupPath?: string }> {
    return withFastScanReadLock(plugin, async (revision, pathRevision) => {
        const stored = plans.get(plan), t = uiFor(plugin.settings), vault = plugin.app.vault
        if (!stored || stored.plugin !== plugin || stored.signature !== signature(plugin)) throw stale(plugin)
        const { signature: initial, target } = stored
        const wanted = new Map(stored.rows)
        if (selected) {
            for (const key of selected) if (!wanted.has(key)) throw stale(plugin)
            for (const key of wanted.keys()) if (!selected.has(key)) wanted.delete(key)
        }
        if (!wanted.size) return { changed: 0 }
        plans.delete(plan)
        checkIdle(plugin)
        const edits = new Map<string, Edit>()
        async function validate(stage: 'original' | 'prepare' | 'written'): Promise<void> {
            if (signature(plugin) !== initial) throw stale(plugin)
            let found = 0
            const index = await inventory(plugin, revision, pathRevision, (file, path, text) => {
                const row = wanted.get(path)
                if (!row) return
                if (row.file !== file || (stage === 'written' ? text !== edits.get(path)?.after : hash(text) !== row.beforeHash)) throw stale(plugin)
                if (stage === 'prepare') edits.set(path, { ...row, before: text,
                    after: movePageId(text, target, plugin.settings.Defaults?.['ID Comments'] !== false, plugin.settings.Syntax, t) })
                found++
            })
            if (found !== wanted.size || signature(plugin) !== initial) throw stale(plugin)
            for (const row of wanted.values()) if (index.dirty.has(row.path) || !index.owns(row)) throw stale(plugin)
        }
        await validate('original')
        const backupPath = await createFullMigrationBackup(plugin)
        const attempted: Edit[] = []
        try {
            await validate('prepare')
            for (const row of wanted.values()) {
                const edit = edits.get(row.path)!
                checkIdle(plugin)
                if (vault.getAbstractFileByPath(edit.path) !== edit.file) throw stale(plugin)
                await verifyPageMoveSource(plugin, edit.path, edit.before)
                attempted.push(edit)
                await vault.process(edit.file, current => {
                    if (current !== edit.before || edit.file.path !== edit.path || signature(plugin) !== initial ||
                        dirtyEditors(plugin).some(view => view.file!.path === edit.path)) throw stale(plugin)
                    return edit.after
                })
            }
            await validate('written')
            return { changed: edits.size, backupPath }
        } catch (error) {
            const unresolved: string[] = []
            for (const edit of attempted.reverse()) {
                try {
                    if (vault.getAbstractFileByPath(edit.path) !== edit.file) throw stale(plugin)
                    if (await vault.read(edit.file) === edit.before) continue
                    await verifyPageMoveSource(plugin, edit.path, edit.after)
                    await vault.process(edit.file, current => {
                        if (current !== edit.after || dirtyEditors(plugin).some(view => view.file!.path === edit.path)) throw stale(plugin)
                        return edit.before
                    })
                    if (await vault.read(edit.file) !== edit.before) throw stale(plugin)
                } catch { unresolved.push(edit.path) }
            }
            throw new Error(uiDiagnostic(error, t) + '\n' + t('Verified full vault ZIP: ', 'Проверенная ZIP-копия хранилища: ') + backupPath +
                (unresolved.length ? '\n' + t('Check these files: ', 'Проверьте файлы: ') + unresolved.join(', ') : ''))
        }
    })
}
