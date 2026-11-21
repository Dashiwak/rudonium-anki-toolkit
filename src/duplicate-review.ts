/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { MarkdownView } from 'obsidian'
import type { App, TFile } from 'obsidian'
import { findIdMarkers, readDuplicateSources } from './duplicate-markers'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import type { DuplicateOccurrence, DuplicateReviewResult } from './duplicate-review-ui'

type FileStamp = readonly [mtime: number, ctime: number, size: number]
export type IndexedIds = readonly [...FileStamp, ids: readonly number[]]

interface ReviewOptions {
    listFiles: () => readonly TFile[]
    getSyntax: () => DuplicateMarkerSyntax | undefined
    revision: (path: string) => number | undefined
}

const filesPerRead = 8

function stamp(file: TFile): FileStamp {
    const { mtime, ctime, size } = file.stat
    return [mtime, ctime, size]
}

function matchesStamp(file: TFile, saved: FileStamp | IndexedIds): boolean {
    const { mtime, ctime, size } = file.stat
    return mtime === saved[0] && ctime === saved[1] && size === saved[2]
}

/** Проверка дублей читает только Markdown. Она не сохраняет открытые редакторы и не обращается к Anki. */
export function createDuplicateReviewLoader(app: App, options: ReviewOptions): () => Promise<DuplicateReviewResult> {
    const cache = new Map<string, { entry: IndexedIds; revision: number | undefined }>()
    let previousConflictPaths = new Set<string>()
    let syntaxKey: string | undefined

    return async () => {
        const syntax = options.getSyntax()
        const key = JSON.stringify(syntax ?? {})
        const syntaxChanged = syntaxKey !== undefined && key !== syntaxKey
        if (syntaxChanged) cache.clear()
        syntaxKey = key

        const files = new Map(options.listFiles().map(file => [file.path, file]))
        const errors = new Set<string>()
        const dirty = new Set<string>()
        for (const { view } of app.workspace.getLeavesOfType('markdown')) {
            if (view instanceof MarkdownView && view.file && view.getMode() === 'source' &&
                files.has(view.file.path) &&
                view.getViewData().replace(/\r\n/g, '\n') !== view.data.replace(/\r\n/g, '\n')) dirty.add(view.file.path)
        }
        for (const path of dirty) errors.add(`${path} has unsaved edits. Save the note and recheck.`)

        for (const path of cache.keys()) if (!files.has(path)) cache.delete(path)
        const inventory = new Map<string, { entry: IndexedIds; revision: number | undefined }>()
        const toRead: Array<[string, TFile]> = []
        for (const [path, file] of files) {
            // В последующих проходах перечитываем прежние места конфликта даже при том же размере файла.
            if (!previousConflictPaths.has(path) && !dirty.has(path)) {
                const revision = options.revision(path)
                const local = cache.get(path)
                if (local && local.revision === revision && matchesStamp(file, local.entry)) {
                    inventory.set(path, local)
                    continue
                }
            }
            toRead.push([path, file])
        }

        for (let offset = 0; offset < toRead.length; offset += filesPerRead) {
            await Promise.all(toRead.slice(offset, offset + filesPerRead).map(async ([path, file]) => {
                const before = stamp(file)
                const revision = options.revision(path)
                try {
                    const text = await app.vault.read(file)
                    if (file.path !== path || !matchesStamp(file, before) || options.revision(path) !== revision) {
                        throw new Error('The file changed during the check.')
                    }
                    const entry: IndexedIds = [...before, findIdMarkers(text, syntax).map(marker => marker.id)]
                    const item = { entry, revision }
                    if (!dirty.has(path)) cache.set(path, item)
                    inventory.set(path, item)
                } catch (error) {
                    cache.delete(path)
                    errors.add(`${path} — ${error instanceof Error ? error.message : String(error)}`)
                }
            }))
        }

        for (const [path, item] of inventory) {
            const file = files.get(path)!
            if (file.path === path && matchesStamp(file, item.entry) && options.revision(path) === item.revision) continue
            inventory.delete(path)
            errors.add(`${path} changed during the check. Recheck to refresh the result.`)
        }

        const owners = new Map<number, string[]>()
        for (const [path, { entry }] of inventory) {
            for (const id of entry[3]) {
                const paths = owners.get(id) ?? []
                paths.push(path)
                owners.set(id, paths)
            }
        }
        const conflicts = new Map<number, { id: number; occurrences: DuplicateOccurrence[] }>()
        const pathsToReview = new Set<string>()
        for (const [id, paths] of owners) {
            if (paths.length < 2) continue
            conflicts.set(id, { id, occurrences: [] })
            paths.forEach(path => pathsToReview.add(path))
        }
        previousConflictPaths = pathsToReview

        const details = Array.from(pathsToReview)
        for (let offset = 0; offset < details.length; offset += filesPerRead) {
            await Promise.all(details.slice(offset, offset + filesPerRead).map(async path => {
                const file = files.get(path)!
                const item = inventory.get(path)!
                try {
                    const content = await app.vault.read(file)
                    const markers = findIdMarkers(content, syntax)
                    if (file.path !== path || !matchesStamp(file, item.entry) || options.revision(path) !== item.revision ||
                        markers.length !== item.entry[3].length || markers.some((marker, i) => marker.id !== item.entry[3][i])) {
                        throw new Error('The ID locations changed during the check. Recheck to refresh the result.')
                    }
                    const sources = readDuplicateSources(content, markers.filter(marker => conflicts.has(marker.id)), syntax)
                    for (const source of sources) {
                        conflicts.get(source.id)!.occurrences.push({ path, ...source })
                    }
                } catch (error) {
                    cache.delete(path)
                    errors.add(`${path} — ${error instanceof Error ? error.message : String(error)}`)
                }
            }))
        }
        const currentFiles = options.listFiles()
        if (currentFiles.length !== files.size || currentFiles.some(file => !files.has(file.path))) {
            errors.add('Files were added, moved or removed during the check. Recheck to refresh the result.')
        }
        for (const [path, item] of inventory) {
            const file = files.get(path)!
            if (file.path !== path || !matchesStamp(file, item.entry) || options.revision(path) !== item.revision) {
                errors.add(`${path} changed during the check. Recheck to refresh the result.`)
            }
        }
        for (const conflict of conflicts.values()) {
            conflict.occurrences.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
        }
        return {
            conflicts: Array.from(conflicts.values()).sort((a, b) => a.id - b.id),
            errors: Array.from(errors),
            checkedFiles: inventory.size,
        }
    }
}
