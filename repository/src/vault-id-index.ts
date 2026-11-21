/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import { archivedIdMarkers, findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax, IdMarker } from './duplicate-markers'

export interface VaultIdLocation extends IdMarker {
    path: string
}

interface FileVersion {
    file: TFile
    ctime: number
    mtime: number
    size: number
    revision: number
}

interface IndexedFile extends FileVersion {
    markers: VaultIdLocation[]
    archives?: VaultIdLocation[]
}

interface IndexOptions {
    includeArchivedOwners?: boolean
    force?: boolean
    needsContent?: (path: string, file: TFile) => boolean
    onFile?: (file: TFile, path: string, markers: readonly VaultIdLocation[], content?: string) => void
    shouldStop?: () => boolean
}

interface VaultIdInventory {
    first: Map<number, VaultIdLocation>
    duplicates: Map<number, VaultIdLocation[]>
    errors: Array<{ path: string; message: string }>
    reads: number
    complete: boolean
}

const indexes = new WeakMap<Pick<MyPlugin, 'app'>, { syntax: string; files: Map<string, IndexedFile> }>()
const fileBatchSize = 16

function version(file: TFile, revision: number): FileVersion {
    const { ctime, mtime, size } = file.stat
    return { file, ctime, mtime, size, revision }
}

function matchesVersion(left: FileVersion, right: FileVersion): boolean {
    return left.file === right.file && left.ctime === right.ctime && left.mtime === right.mtime &&
        left.size === right.size && left.revision === right.revision
}

/** Использует актуальный список Markdown всего хранилища, включая файлы вне настроенной области экспорта. */
export async function indexVaultIds(plugin: Pick<MyPlugin, 'app'>, files: readonly TFile[],
    syntax: DuplicateMarkerSyntax | undefined, pathRevision: (path: string) => number,
    options: IndexOptions = {},
): Promise<VaultIdInventory> {
    const syntaxKey = JSON.stringify(syntax ?? {})
    let saved = indexes.get(plugin)
    if (!saved || saved.syntax !== syntaxKey) {
        // Перестраиваем индекс после перезагрузки плагина, поскольку нельзя проверить изменения, сделанные без наблюдения за файлами.
        saved = { syntax: syntaxKey, files: new Map() }
        indexes.set(plugin, saved)
    }

    const cache = saved.files
    const first = new Map<number, VaultIdLocation>()
    const duplicates = new Map<number, VaultIdLocation[]>()
    const errors: VaultIdInventory['errors'] = []
    const paths = new Set<string>()
    let reads = 0

    const collect = (file: TFile, path: string, entry: IndexedFile, content?: string) => {
        const owners = options.includeArchivedOwners && entry.archives ? entry.markers.concat(entry.archives) : entry.markers
        for (const marker of owners) {
            const prior = first.get(marker.id)
            if (!prior) first.set(marker.id, marker)
            else {
                const group = duplicates.get(marker.id)
                if (group) group.push(marker)
                else duplicates.set(marker.id, [prior, marker])
            }
        }
        try {
            options.onFile?.(file, path, entry.markers, content)
        } catch (error) {
            errors.push({ path, message: String(error) })
        }
    }

    for (let offset = 0; offset < files.length; offset += fileBatchSize) {
        if (options.shouldStop?.()) return { first, duplicates, errors, reads, complete: false }
        const pending: Promise<void>[] = []
        for (const file of files.slice(offset, offset + fileBatchSize)) {
            const path = file.path
            paths.add(path)
            const stamp = version(file, pathRevision(path))
            const cached = cache.get(path)
            if (!options.force && cached && matchesVersion(cached, stamp) && !options.needsContent?.(path, file)) {
                collect(file, path, cached)
                continue
            }
            pending.push((async () => {
                let content: string
                let entry: IndexedFile
                try {
                    reads++
                    content = await plugin.app.vault.read(file)
                    if (file.path !== path || !matchesVersion(stamp, version(file, pathRevision(path)))) {
                        throw new Error('the file changed during the ID check')
                    }
                    const markers = findIdMarkers(content, syntax).map(marker => ({ ...marker, path }))
                    entry = { ...stamp, markers }
                    if (content.includes('RUDONIUM-ARCHIVE')) {
                        entry.archives = archivedIdMarkers(content).map(marker => ({ ...marker, path }))
                    }
                    cache.set(path, entry)
                } catch (error) {
                    cache.delete(path)
                    errors.push({ path, message: String(error) })
                    return
                }
                collect(file, path, entry, content)
            })())
        }
        if (pending.length) await Promise.all(pending)
    }
    for (const path of cache.keys()) {
        if (!paths.has(path)) cache.delete(path)
    }
    for (const [id, group] of duplicates) {
        group.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column)
        first.set(id, group[0])
    }
    return { first, duplicates, errors, reads, complete: errors.length === 0 }
}
