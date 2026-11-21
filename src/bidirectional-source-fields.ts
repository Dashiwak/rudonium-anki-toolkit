// SPDX-License-Identifier: GPL-3.0-only
import { readGeneratedAnkiBacklink } from './bidirectional-markdown'

export type SourceSuffixes = Record<string, string>
export interface SourceFieldUpdate {
    before: string
    after: string
    body: string
}
export type SourceFieldUpdates = Record<string, SourceFieldUpdate>

// The upstream formatter appends the Markdown path and heading trail verbatim.
// Locate only the expected path, keeping any authored field prefix (including HTML).
function contextPart(html: string, path: string): string {
    for (const exact of [path, path.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;')]) {
        const start = html.lastIndexOf(exact)
        if (start >= 0 && /^(?:(?: > | &gt; )[^\r\n]+)?$/u.test(html.slice(start + exact.length))) return html.slice(start)
    }
    return ''
}

function backlinkPath(link: string, vault: string): string | undefined {
    const href = /href="([^"]+)"/u.exec(link)?.[1]
    if (!href) return
    const url = new URL(href.replace(/&amp;/gu, '&'))
    if (url.searchParams.get('vault') === vault) return url.searchParams.get('file') ?? undefined
}

export function sourceSuffixes(fields: Readonly<Record<string, string>>, id: number, path: string, vault: string,
    fileField?: string, contextField?: string): SourceSuffixes | undefined {
    if (!fileField && !contextField) return
    const suffixes = Object.create(null) as SourceSuffixes
    for (const name of new Set([fileField, contextField])) {
        if (!name || typeof fields[name] !== 'string') continue
        const value = fields[name]
        let body = value, end = ''
        // Both orders occur in exported collections.
        for (let i = 0; i < 2; i++) {
            const anchor = name === fileField ? readGeneratedAnkiBacklink(body, id) : undefined
            const tail = anchor && backlinkPath(anchor, vault) === path && body.endsWith(anchor) ? anchor :
                name === contextField ? contextPart(body, path) : ''
            if (!tail) break
            end = tail + end
            body = body.slice(0, -tail.length)
        }
        if (end) suffixes[name] = end
    }
    return Object.keys(suffixes).length ? suffixes : undefined
}

function oldSourceAnchor(raw: string, id: number, vault: string, confirmedPath: (path: string) => boolean) {
    const match = /<br ?\/?><a href="(obsidian:\/\/(?:anki-card|open)\?[^"<>\r\n]*)" class="obsidian-link">Obsidian<\/a>/iu.exec(raw)
    if (!match) return
    if (readGeneratedAnkiBacklink(match[0], id)) {
        const path = backlinkPath(match[0], vault)
        if (path) return { match, path }
    }
    try {
        const url = new URL(match[1].replace(/&amp;/gu, '&'))
        const path = url.searchParams.get('file')
        if (url.hostname === 'open' && url.searchParams.get('vault') === vault && path && confirmedPath(path)) return { match, path }
    } catch { return }
}

export function observeSourceFields(fields: Record<string, unknown>, desired: SourceSuffixes, saved: SourceSuffixes | undefined,
    id: number, vault: string, authored: Record<string, string> | undefined, confirmedPath: (path: string) => boolean,
    pendingTarget?: SourceSuffixes): SourceFieldUpdates | undefined {
    const updates = Object.create(null) as SourceFieldUpdates
    let linkedPath: string | undefined
    for (const [name, suffix] of Object.entries(desired)) {
        if (suffix.includes('class="obsidian-link"')) {
            const field = (fields[name] as { value?: unknown } | undefined)?.value
            if (typeof field === 'string') linkedPath = oldSourceAnchor(field, id, vault, confirmedPath)?.path
        }
    }
    for (const [name, after] of Object.entries(desired)) {
        const raw = (fields[name] as { value?: unknown } | undefined)?.value
        if (typeof raw !== 'string') return
        const before = [saved?.[name], pendingTarget?.[name], after].filter((suffix): suffix is string => !!suffix && raw.endsWith(suffix))
            .sort((a, b) => b.length - a.length)[0]
        if (before && (saved?.[name] !== undefined || raw === (authored?.[name] ?? '') + before)) {
            updates[name] = { before, after, body: raw.slice(0, -before.length) }
            continue
        }
        // Legacy snapshots have no generated-field receipt. Only accept a legacy suffix
        // separated from a known authored value, or a typed same-vault backlink for this ID.
        const legacy = oldSourceAnchor(raw, id, vault, confirmedPath)
        if (!saved?.[name] && legacy && after.includes('class="obsidian-link"')) {
            const { match: anchorMatch, path: oldPath } = legacy
            const anchor = anchorMatch[0]
            const head = raw.slice(0, anchorMatch.index)
            const tail = raw.slice(anchorMatch.index + anchor.length)
            if (tail && contextPart(tail, oldPath) !== tail) return
            const priorContext = tail ? '' : contextPart(head, oldPath)
            const old = priorContext + anchor + tail
            updates[name] = { before: old, after, body: raw.slice(0, -old.length) }
            continue
        }
        if (saved?.[name] || raw.includes('class="obsidian-link"')) return
        const body = authored?.[name]
        if (body === undefined || !raw.startsWith(body)) return
        const rest = raw.slice(body.length)
        if (rest) {
            const previous = /^([^<>\r\n]+?\.md)(?:(?: > | &gt; )[^\r\n]+)?$/iu.exec(rest)?.[1]
            if (!previous || (previous !== linkedPath && !confirmedPath(previous))) return
        }
        updates[name] = { before: rest, after, body }
    }
    return updates
}

export function sourceSuffixMap(updates: SourceFieldUpdates, side: 'before' | 'after'): SourceSuffixes {
    return Object.fromEntries(Object.entries(updates).map(([name, value]) => [name, value[side]]))
}
