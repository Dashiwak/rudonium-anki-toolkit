// SPDX-License-Identifier: GPL-3.0-only
import type { App, TFile } from 'obsidian'
import { activeCardMarkdown, archivedCardRanges, wrapArchivedCard } from './archived-card'
import { makeSpanOverlap } from './markdown-pipeline'
import { checkPinnedAnkiProfile } from './anki-profile'
import { checkAnkiNoteExistence } from './sync-audit'
import type { AfterDeleteMode } from './deletion-policy'
import { Md5 } from 'ts-md5'
import { wizardServiceGuard } from './card-export-diagnostics'
import { hasPageYamlIdText, mayHavePageTag } from './page-frontmatter'
import { pageLifecycleLink } from './suspend-marker'
import { deletionLabelProblem } from './suspend-label'
import { pageFooterMarker, parseAnkiIdMarker } from './anki-id-marker'
import { findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { cardFormatPresets } from './card-format-presets'
import { maskLegacyFieldSections } from './legacy-field-sections'
import { findBidirectionalBlocks } from './bidirectional-blocks'
import { findLinkedBullets } from './linked-bullets'
import { findPresetBlocks, presetReaders, readPageCard } from './page-card'
import { cardMetadataEnd } from './bidirectional-markdown'

interface Span { start: number; end: number }
interface Card extends Span { id: number; format?: string; tagEnd?: number; answerBoundary?: number }
export interface SourceRemoval extends Span { id: number; page: boolean; bounded?: boolean }

export async function pageTrash(app: App): Promise<(file: TFile) => Promise<void>> {
    const { adapter, configDir } = app.vault
    const path = configDir + '/app.json'
    if (await adapter.exists(path)) {
        const value: unknown = JSON.parse(await adapter.read(path))
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            ('trashOption' in value && value.trashOption !== 'local' && value.trashOption !== 'system')) {
            throw new Error('The card page was kept. Choose system trash or Obsidian trash in Files and links.')
        }
    }
    const manager: typeof app.fileManager & { trashFile?(file: TFile): Promise<void> } = app.fileManager
    if (typeof manager?.trashFile !== 'function') throw new Error('Obsidian cannot apply its file deletion preference.')
    return manager.trashFile.bind(manager)
}

function afterLine(text: string, end: number): number {
    return end + (text.startsWith('\r\n', end) ? 2 : text[end] === '\n' ? 1 : 0)
}

export function sourceRemoval(text: string, card: Card): SourceRemoval {
    if (card.format === 'page') {
        if (card.answerBoundary === undefined) return { id: card.id, start: 0, end: text.length, page: true }
        const newline = text.indexOf('\n', card.answerBoundary)
        return { id: card.id, start: 0, end: newline < 0 ? text.length : newline + 1, page: true, bounded: true }
    }
    const end = afterLine(text, cardMetadataEnd(text, card))
    return { id: card.id, start: card.start, end, page: false }
}

function protectExistingArchives(text: string, spans: readonly Span[]): void {
    if (!spans.length) return
    const archives = archivedCardRanges(text)
    if (!archives.length) return
    const overlaps = makeSpanOverlap(archives.map(range => [range.start, range.end]))
    if (spans.some(span => overlaps(span.start, span.end))) throw new Error(
        'This deletion overlaps an archived card. / Удаляемая карточка пересекается с уже архивированной записью.')
}

export function deletionSignature(text: string, path: string, removal: SourceRemoval): string {
    return Md5.hashStr(JSON.stringify([path, removal.id, removal.page, text.slice(removal.start, removal.end)]))
}

function replaceRanges<T extends Span>(text: string, spans: readonly T[], replacement: (span: T) => string): string {
    const parts: string[] = []
    let position = 0
    for (const span of [...spans].sort((a, b) => a.start - b.start)) {
        const { start, end } = span
        if (start < position || start < 0 || end <= start || end > text.length) throw new Error('Ambiguous deletion ranges.')
        parts.push(text.slice(position, start), replacement(span))
        position = end
    }
    return parts.join('') + text.slice(position)
}

export function withoutRanges(text: string, spans: readonly Span[], conceal = false): string {
    return replaceRanges(text, spans, ({ start, end }) => conceal ? text.slice(start, end).replace(/[^\r\n]/g, ' ') : '')
}

interface Directive extends Span { id: number; markerEnd: number; detached: boolean; card?: SourceRemoval }
export interface ExplicitDeletes { directives: Directive[]; masked: string }

export function explicitDeletes(text: string, syntax: DuplicateMarkerSyntax, expressions: Readonly<Record<string, string>>,
    pageModel?: string, directivePatterns?: ReadonlyArray<RegExp | undefined>): ExplicitDeletes | undefined {
    const label = syntax['Delete Note Line'] ?? 'DELETE'
    if (!label || (!text.includes('ID:') && !hasPageYamlIdText(text))) return
    if (!text.includes(label) && !(mayHavePageTag(text) && text.toLowerCase().includes(label.toLowerCase()))) return
    const problem = deletionLabelProblem(syntax)
    if (problem) throw new Error(problem)
    const active = activeCardMarkdown(text)
    const markers = findIdMarkers(text, syntax)
    const starts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
    const line = (row: number) => text.slice(starts[row], starts[row + 1]).replace(/\r?\n$/, '')
    let directives: Directive[] = []
    const pageLink = pageLifecycleLink(active, syntax)
    for (const marker of markers) {
        if (pageLink && marker.id === pageLink.id) {
            const { start, end, command } = pageLink.slot
            if (command === 'delete') {
                if (markers.length !== 1) throw new Error('Conflicting page IDs. / У страницы несколько ID.')
                directives.push({ id: pageLink.id, detached: false, start, end, markerEnd: end })
            }
            continue
        }
        const row = marker.line - 1
        const current = line(row)
        if (/^(?: {4}| {0,3}\t)/u.test(current)) continue
        if (pageFooterMarker(current)) continue
        const plain = parseAnkiIdMarker(current)
        const left = current.trimStart()
        if (plain?.id === marker.id && row > 0 && !/^(?: {4}| {0,3}\t)/u.test(line(row - 1)) && line(row - 1).trim() === label) {
            directives.push({ id: marker.id, detached: row < 2 || !line(row - 2).trim(), start: starts[row - 1], end: starts[row], markerEnd: starts[row + 1] ?? text.length })
        } else if (left.startsWith(label) && parseAnkiIdMarker(left.slice(label.length))?.id === marker.id) {
            const start = starts[row] + current.length - left.length
            const remainder = left.slice(label.length)
            const end = start + label.length + remainder.length - remainder.trimStart().length
            directives.push({ id: marker.id, detached: row === 0 || !line(row - 1).trim(), start, end, markerEnd: starts[row + 1] ?? text.length })
        }
    }
    if (!directives.length) return
    if (directivePatterns?.some(Boolean)) {
        const metadata = wizardServiceGuard(text, directivePatterns)
        directives = directives.filter(d => !metadata(d.start))
        if (!directives.length) return
    }
    for (const d of directives) {
        const previous = text.lastIndexOf('\n', d.start - 1)
        if (previous < 0 || text.slice(previous + 1, d.start).trim()) continue
        const above = text.slice(text.lastIndexOf('\n', previous - 1) + 1, previous)
        if (!/^(?: {4}| {0,3}\t)/u.test(above) && above.trim() === label) throw new Error(
            'Repeated deletion marker for ID ' + d.id + '. / Повторная метка удаления у ID ' + d.id + '.')
    }
    const counts = new Map<number, number>()
    for (const marker of markers) counts.set(marker.id, (counts.get(marker.id) ?? 0) + 1)
    if (directives.some(d => counts.get(d.id) !== 1)) throw new Error('Duplicate Anki ID in a deletion command.')
    const projection = withoutRanges(text, directives)
    const view = maskLegacyFieldSections(projection)
    const page = readPageCard(view, expressions, syntax, pageModel)
    if (pageLink && directives.some(d => d.id === pageLink.id) && page?.id !== pageLink.id) {
        throw new Error('Verify the @page rule before deleting. / Проверьте правило @page перед удалением.')
    }
    const found: Card[] = page?.id ? [{ ...page, id: page.id, format: 'page' }] : [
        ...findBidirectionalBlocks(view, syntax), ...findLinkedBullets(view, false, syntax),
        ...findPresetBlocks(view, presetReaders(expressions), findIdMarkers(view, syntax), undefined, syntax),
    ]
    let skipped = 0
    const gaps = directives.map(d => {
        const offset = d.start - skipped
        skipped += d.end - d.start
        return { offset, skipped }
    })
    const original = (at: number, right: boolean): number => {
        let low = 0, high = gaps.length
        while (low < high) {
            const mid = (low + high) >>> 1
            if (right ? gaps[mid].offset <= at : gaps[mid].offset < at) low = mid + 1
            else high = mid
        }
        return at + (low ? gaps[low - 1].skipped : 0)
    }
    const byId = new Map<number, Card[]>()
    const metadata = directivePatterns?.some(Boolean) && found.length ? wizardServiceGuard(projection, directivePatterns) : undefined
    for (const c of found) {
        if (c.format !== 'page' && metadata?.(c.start)) continue
        const matched = byId.get(c.id)
        if (matched) matched.push(c)
        else byId.set(c.id, [c])
    }
    for (const d of directives) {
        const candidates = byId.get(d.id)
        if (!candidates) {
            if (d.start > 0 && Object.values(expressions).some(expression => expression &&
                !cardFormatPresets.some(preset => preset.expression === expression))) d.detached = false
            continue
        }
        const ranges = candidates.map(c => sourceRemoval(projection, c))
        if (ranges.some(r => r.start !== ranges[0].start || r.end !== ranges[0].end)) throw new Error('Ambiguous card deletion boundaries.')
        const r = ranges[0]
        d.card = { ...r, start: original(r.start, false), end: original(r.end, false) }
        if (d.start < d.card.start || d.markerEnd > d.card.end) throw new Error('Deletion marker outside card boundaries.')
    }
    const spans = directives.map(d => d.card ?? { start: d.start, end: d.markerEnd })
    protectExistingArchives(text, spans)
    // While a page deletion is pending its private appendix stays outside every other export rule.
    const mask = directives.some(d => d.card?.bounded) ? [{ start: 0, end: text.length }] : spans
    return { directives, masked: withoutRanges(maskLegacyFieldSections(text), mask, true) }
}

export type LocalDeleteEffect = 'keep-private-page' | 'mark-block' | 'strike-block' | 'hide-block' | 'trash-page' | 'remove-block' | 'clear-command' | 'clear-command-and-id'

export function localDeleteEffect(d: Pick<Directive, 'card' | 'detached'>, mode: AfterDeleteMode,
    trashPages: boolean): LocalDeleteEffect {
    if (d.card) {
        if (mode === 'mark') return 'mark-block'
        if (mode === 'strike') return 'strike-block'
        if (mode === 'hidden') return 'hide-block'
        if (mode === 'remove' && d.card.bounded) return 'keep-private-page'
        if (mode === 'remove' && !d.card.page) return 'remove-block'
        if (mode === 'remove' && trashPages) return 'trash-page'
    }
    return !d.card && d.detached ? 'clear-command-and-id' : 'clear-command'
}

export function cleanConfirmedDeletes(text: string, plan: ExplicitDeletes | undefined, confirmed: ReadonlySet<number>,
    mode: AfterDeleteMode, trashPages: boolean, additional: readonly SourceRemoval[] = [],
    label = 'Deleted from Anki', excerpts?: Map<number, { before: string; after?: string }>): { text: string; trash: boolean } {
    protectExistingArchives(text, additional)
    const changes: (Span & { id: number; removed?: boolean; replacement: string })[] = []
    const archivedIds = new Set<number>()
    const eol = /\r\n|\n|\r/u.exec(text)?.[0] ?? '\n'
    const planCard = (card: SourceRemoval, body: string) => {
        let replacement = ''
        if (mode === 'mark' || mode === 'strike' || mode === 'hidden') {
            replacement = wrapArchivedCard(body, card.id, label, card.page, eol, mode, card.bounded ? text.slice(card.end) : '')
            archivedIds.add(card.id)
        }
        changes.push({ ...card, replacement, removed: !replacement })
    }
    for (const card of additional) {
        if (!confirmed.has(card.id)) continue
        const effect = localDeleteEffect({ card, detached: false }, mode, trashPages)
        if (effect === 'trash-page') {
            excerpts?.set(card.id, { before: text })
            return { text, trash: true }
        }
        if (effect !== 'clear-command' && effect !== 'keep-private-page') planCard(card, text.slice(card.start, card.end))
    }
    for (const d of plan?.directives ?? []) {
        if (!confirmed.has(d.id)) continue
        const effect = localDeleteEffect(d, mode, trashPages)
        if (effect === 'trash-page') {
            excerpts?.set(d.id, { before: text })
            return { text, trash: true }
        }
        if (d.card && effect !== 'clear-command' && effect !== 'keep-private-page') {
            const body = text.slice(d.card.start, d.start) + text.slice(d.end, d.card.end)
            planCard(d.card, body)
        } else {
            const start = effect === 'clear-command-and-id' ? text.lastIndexOf('\n', Math.max(0, d.start - 1)) + 1 : d.start
            changes.push({ id: d.id, start, end: effect === 'clear-command-and-id' ? d.markerEnd : d.end,
                replacement: start === 0 && text.charCodeAt(0) === 0xfeff ? '\ufeff' : '' })
        }
    }
    if (!changes.length) return { text, trash: false }
    const output = replaceRanges(text, changes, change => change.replacement)
    if (excerpts) for (const change of changes) {
        excerpts.set(change.id, { before: text.slice(change.start, change.end), after: change.removed ? undefined : change.replacement })
    }
    if (archivedIds.size) {
        for (const range of archivedCardRanges(output)) archivedIds.delete(range.id)
        if (archivedIds.size) throw new Error('Cannot mark this source block as deleted. / Не удалось отметить этот исходный блок как удалённый.')
    }
    return { text: output, trash: false }
}

export async function deletionPresence(ids: readonly number[], profile: string): Promise<Map<number, boolean>> {
    await checkPinnedAnkiProfile(profile)
    const problems: string[] = []
    const presence = await checkAnkiNoteExistence(ids, problems)
    await checkPinnedAnkiProfile(profile)
    if (problems.length || ids.some(id => !presence.has(id))) throw new Error('Anki did not verify the requested deletion IDs.')
    return presence
}
