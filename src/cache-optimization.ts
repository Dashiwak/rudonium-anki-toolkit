/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type { Vault } from 'obsidian'
import type { MediaIndex } from './media-sync'

export interface CacheOptimizationSummary {
    markdownPaths: number
    hashes: number
    fileEntries: number
    idEntries: number
    mediaLinks: number
    bytesBefore: number
    bytesAfter: number
    skipped: number
}

export interface CacheOptimizationPlan {
    summary: CacheOptimizationSummary
    paths: readonly string[]
}

function isMarkdownPath(path: string): boolean {
    return /\.md$/i.test(path) && !/[\\\0]/.test(path) &&
        path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function parentOf(path: string): string {
    const slash = path.lastIndexOf('/')
    return slash < 0 ? '' : path.slice(0, slash)
}

function portablePath(path: string): string {
    return path.normalize('NFC').toLowerCase()
}

export async function confirmMissingCachePaths(vault: Vault, candidates: Iterable<string>):
    Promise<{ missing: string[]; skipped: number }> {
    const live = new Set(vault.getMarkdownFiles().map(file => file.path))
    const folders = new Map<string, Promise<Set<string> | undefined>>()
    let skipped = 0
    const suspects: string[] = []
    for (const path of new Set(candidates)) {
        if (live.has(path)) continue
        if (isMarkdownPath(path)) suspects.push(path)
        else skipped++
    }
    const listing = (parent: string) => {
        const known = folders.get(parent)
        if (known) return known
        const read = (async () => {
            try {
                const { files, folders } = await vault.adapter.list(parent)
                const paths = [...files, ...folders]
                if (paths.some(path => typeof path !== 'string' || parentOf(path) !== parent)) return undefined
                return new Set(paths.map(portablePath))
            } catch {
                return undefined
            }
        })()
        folders.set(parent, read)
        return read
    }
    const absent = async (path: string) => {
        try {
            if (vault.getAbstractFileByPath(path)) return false
            const entries = await listing(parentOf(path))
            return entries !== undefined && !entries.has(portablePath(path)) &&
                await vault.adapter.exists(path) === false && !vault.getAbstractFileByPath(path)
        } catch {
            return false
        }
    }
    const missing: string[] = []
    for (let offset = 0; offset < suspects.length; offset += 24) {
        const files = suspects.slice(offset, offset + 24)
        const confirmed = await Promise.all(files.map(absent))
        for (const [index, path] of files.entries()) {
            if (confirmed[index]) missing.push(path)
            else skipped++
        }
    }
    return { missing: missing.sort(), skipped }
}

export function compactMediaLinks(index: MediaIndex, removed: ReadonlySet<string>): { index: MediaIndex; links: number } {
    let links = 0
    const next: MediaIndex = new Map()
    for (const [key, record] of index) {
        const pending = new Set(record.pendingNotes)
        const notes = record.notes.filter(path => !removed.has(path) || pending.has(path))
        links += record.notes.length - notes.length
        next.set(key, notes.length === record.notes.length ? record : { ...record, notes })
    }
    return { index: next, links }
}
