/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type MyPlugin from '../main'
import type { SyncAuditDifference, SyncAuditResult, SyncAuditSource, SyncAuditUnlinked } from './sync-audit'
import { collectionDuplicateOptions } from './duplicate-preflight'
import { isDuplicateFirstFieldErrorMessage } from './anki-transport'
import { OneWayHistory, oneWayFieldDigest } from './oneway-history'
import { BidirectionalState } from './bidirectional-state'
import type { SyncRecord } from './bidirectional-state'

export type AuditCardStatus = 'same' | 'obsidian-edit' | 'anki-edit' | 'conflict' | 'different' | 'unverified' |
    'new' | 'ready' | 'duplicate' | 'blocked' | 'missing-anki' | 'missing-source' | 'other-deck' | 'outside-scope' |
    'pending-deletion' | 'unrecognized'

interface AuditNewNote {
    modelName: string
    deckName: string
    fields: Readonly<Record<string, string>>
}

interface AuditUnlinkedCard {
    line?: number
    caption?: string
    firstFieldKey?: string
    candidate?: AuditNewNote
}

export interface AuditCardRow {
    status: AuditCardStatus
    id?: number
    path?: string
    line?: number
    endLine?: number
    markerLine?: number
    caption?: string
    model?: string
    checkedNew?: boolean
    message?: string
    candidate?: AuditNewNote
}

export const auditCandidateByteLimit = 8 * 1024 * 1024
const auditSingleCandidateByteLimit = 128 * 1024
const auditCandidateCountLimit = 2_000
const auditBatchLimit = 25

const unlinkedCards = new WeakMap<SyncAuditUnlinked, AuditUnlinkedCard[]>()
const linkedRows = new WeakMap<SyncAuditResult, AuditCardRow[]>()

export function auditCardCaption(value: string | undefined): string | undefined {
    return value?.slice(0, 480).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240) || undefined
}

function candidateBytes(candidate: AuditNewNote): number {
    let bytes = 128 + 2 * (candidate.modelName.length + candidate.deckName.length)
    for (const [field, value] of Object.entries(candidate.fields)) bytes += 64 + 2 * (field.length + value.length)
    return bytes
}

export function addAuditUnlinkedCard(group: SyncAuditUnlinked, line: number | undefined, first: string | undefined,
    note: AuditNewNote, retains: { bytes: number; count: number }): void {
    let rows = unlinkedCards.get(group)
    if (!rows) unlinkedCards.set(group, rows = [])
    const firstValue = first && note.fields[first]
    const candidate = { modelName: note.modelName, deckName: note.deckName, fields: note.fields }
    const bytes = firstValue?.trim() ? candidateBytes(candidate) : Infinity
    const retained = retains.count < auditCandidateCountLimit && bytes <= auditSingleCandidateByteLimit && bytes <= retains.bytes
    if (retained) {
        retains.bytes -= bytes
        retains.count++
    }
    rows.push({ line, caption: auditCardCaption(firstValue),
        firstFieldKey: firstValue?.trim() ? oneWayFieldDigest(firstValue) : undefined,
        candidate: retained ? candidate : undefined })
}

export function auditUnlinkedWeight(group: SyncAuditUnlinked): number {
    return (unlinkedCards.get(group) ?? []).reduce((weight, row) =>
        weight + 112 + 2 * (row.caption?.length ?? 0) + (row.candidate ? candidateBytes(row.candidate) : 0), 0)
}

export function auditLinkedRow(source: SyncAuditSource, status: AuditCardStatus): AuditCardRow {
    return { status, id: source.id, path: source.path, line: source.line, endLine: source.endLine,
        markerLine: source.markerLine, caption: source.auditCaption, model: source.expected?.modelName }
}

export function rememberAuditLinkedRows(result: SyncAuditResult, rows: AuditCardRow[]): void {
    linkedRows.set(result, rows)
}

export function classifyAuditDifference(difference: SyncAuditDifference,
    base: Readonly<Record<string, string>> | undefined): AuditCardStatus {
    if (!difference.complete) return 'unverified'
    if (difference.model || !difference.fields.length) return 'different'
    let localChanged = false
    let remoteChanged = false
    let conflict = false
    let unknown = !base || !!difference.missingTags.length || !!difference.extraTags.length || !!difference.decks.length
    for (const field of difference.fields) {
        const common = base && Object.prototype.hasOwnProperty.call(base, field.name) ? base[field.name] : undefined
        if (common === undefined || field.kind === 'missing' || field.actual === undefined || field.expected === '') {
            unknown = true
            continue
        }
        const local = oneWayFieldDigest(field.expected) !== common
        const remote = oneWayFieldDigest(field.actual) !== common
        localChanged ||= local
        remoteChanged ||= remote
        conflict ||= local && remote
    }
    if (conflict) return 'conflict'
    if (unknown || localChanged === remoteChanged) return 'different'
    return localChanged ? 'obsidian-edit' : 'anki-edit'
}

function agreedBaseline(difference: SyncAuditDifference, oneWay: Readonly<Record<string, string>> | undefined,
    twoWay: SyncRecord | undefined): Readonly<Record<string, string>> | undefined {
    if (!oneWay || twoWay?.pending) return undefined
    if (!twoWay?.base) return oneWay
    for (const field of difference.fields) {
        const { name } = field
        const common = name === 'Front' ? twoWay.base.front : name === 'Back' ? twoWay.base.back : twoWay.base.extra?.[name]
        if (common !== undefined && oneWay[name] !== oneWayFieldDigest(common)) return undefined
    }
    return oneWay
}

export async function classifyAuditFieldChanges(plugin: MyPlugin, result: SyncAuditResult, profile: string): Promise<void> {
    const rows = linkedRows.get(result)
    if (!rows?.length) return
    const fieldDifferences = new Map(result.differences.filter(item => item.fields.length && !item.model)
        .map(item => [item.id, item]))
    if (!fieldDifferences.size) return
    const parent = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
    try {
        const { adapter } = plugin.app.vault
        const [history, twoWay] = await Promise.all([
            OneWayHistory.open(adapter, `${parent}/one-way-history.json`, profile),
            BidirectionalState.open(adapter, `${parent}/bidirectional-sync.json`, profile),
        ])
        for (const row of rows) {
            if (row.status !== 'different' || row.id === undefined || row.model === undefined) continue
            const change = fieldDifferences.get(row.id)
            if (change) row.status = classifyAuditDifference(change, agreedBaseline(change, history.get(row.id, row.model)?.fields,
                twoWay.get(row.id)))
        }
    } catch (error) {
        console.warn('[Rudonium Anki Toolkit] Не удалось прочитать историю полей для аудита', error)
    }
}

export function auditCardRows(result: SyncAuditResult): AuditCardRow[] {
    const rows = (linkedRows.get(result) ?? []).map(row =>
        row.status === 'same' && (!result.ankiInventoryComplete || !result.vaultInventoryComplete)
            ? { ...row, status: 'unverified' as const } : { ...row })
    const complete = result.ankiInventoryComplete && result.vaultInventoryComplete &&
        result.ankiDeckKind === 'ordinary' && !!result.ankiDeckExists && !result.ankiErrors.length &&
        result.ankiProfile !== undefined && 'active' in result.ankiProfile &&
        (!result.ankiProfile.expected || result.ankiProfile.active === result.ankiProfile.expected)
    const groupFirstFields = new Map<string, number>()
    if (complete) for (const group of result.unlinked) for (const card of unlinkedCards.get(group) ?? []) {
        if (card.firstFieldKey) groupFirstFields.set(card.firstFieldKey, (groupFirstFields.get(card.firstFieldKey) ?? 0) + 1)
    }
    let remaining = auditCandidateByteLimit
    let checkedCandidates = 0
    for (const group of result.unlinked) {
        const cards = unlinkedCards.get(group)
        for (let i = 0; i < group.count; i++) {
            const card = cards?.[i]
            const repeated = !!card?.firstFieldKey && (groupFirstFields.get(card.firstFieldKey) ?? 0) > 1
            let candidate: AuditNewNote | undefined
            if (complete && !repeated && card?.candidate && checkedCandidates < auditCandidateCountLimit) {
                const bytes = candidateBytes(card.candidate)
                if (bytes <= remaining) {
                    candidate = card.candidate
                    remaining -= bytes
                    checkedCandidates++
                }
            }
            rows.push({ status: repeated ? 'duplicate' : 'new', path: group.path,
                line: card?.line ?? (!cards && group.lines?.length === group.count ? group.lines[i] : undefined),
                caption: card?.caption, model: card?.candidate?.modelName, candidate,
                message: repeated ? 'More than one new card in this deck has the same first field.' :
                    complete && !candidate ? 'Check this card in Export Preview.' : undefined })
        }
    }
    const addGroup = (entries: readonly { occurrences: readonly SyncAuditSource[] }[], status: AuditCardStatus) => {
        for (const { occurrences } of entries) for (const source of occurrences) rows.push(auditLinkedRow(source, status))
    }
    addGroup(result.obsidianOnly, 'missing-anki')
    for (const group of result.outsideAnkiDeck) addGroup([group],
        group.deckDetailsComplete && group.actualDecks.length ? 'other-deck' : 'unverified')
    addGroup(result.outsideObsidianScope, 'outside-scope')
    for (const source of result.pendingDeletions) rows.push(auditLinkedRow(source, 'pending-deletion'))
    for (const source of result.unparsedIds) rows.push(auditLinkedRow(source, 'unrecognized'))
    for (const item of result.ankiOnly) rows.push({ status: 'missing-source', id: item.id, model: item.modelName })
    for (const id of result.unverifiedSourceIds) rows.push({ status: 'unverified', id })
    return rows
}

export function filterAuditCards(rows: readonly AuditCardRow[], status: AuditCardStatus | '',
    query: string): readonly AuditCardRow[] {
    const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean)
    const matching = status ? rows.filter(row => row.status === status) : rows
    if (!terms.length) return matching
    return matching.filter(row => {
        const text = [row.id, row.path, row.line, row.caption, row.model].join(' ').toLowerCase()
        return terms.every(term => text.includes(term))
    })
}

function readCheck(value: unknown): { canAdd: boolean; error?: string | null } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    if (typeof row.canAdd !== 'boolean' || row.error != null && typeof row.error !== 'string') return undefined
    if (row.canAdd && row.error) return undefined
    return { canAdd: row.canAdd, error: row.error as string | null | undefined }
}

export async function checkAuditNewCards(rows: readonly AuditCardRow[], read: (notes: readonly unknown[]) => Promise<unknown>,
    verify: () => Promise<boolean>): Promise<number> {
    const candidates = rows.filter((row): row is AuditCardRow & { candidate: AuditNewNote } =>
        row.status === 'new' && row.candidate !== undefined).slice(0, auditBatchLimit)
    if (!candidates.length || !await verify()) return 0
    const answer = await read(candidates.map(row => ({
        ...row.candidate, options: collectionDuplicateOptions(row.candidate),
    })))
    if (!await verify() || !Array.isArray(answer) || answer.length !== candidates.length) return 0
    const results = answer.map(readCheck)
    if (results.some(value => !value)) return 0
    for (const [index, row] of candidates.entries()) {
        const result = results[index]!
        row.checkedNew = true
        row.status = result.canAdd ? 'ready' :
            result.error && isDuplicateFirstFieldErrorMessage(result.error) ? 'duplicate' : 'blocked'
        row.message = result.error?.slice(0, 240) ?? undefined
    }
    return results.length
}
