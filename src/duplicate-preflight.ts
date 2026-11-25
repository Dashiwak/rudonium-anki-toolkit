/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { isDuplicateFirstFieldErrorMessage, withAnkiDeadline } from './anki-transport'
import { sameFieldValue } from './anki-field-value'

interface NewNote {
    deckName: string
    modelName: string
    fields: Readonly<Record<string, string>>
    options?: { allowDuplicate?: boolean; duplicateScope?: string }
}

export interface DuplicateSource {
    path: string
    line: number
    modelName: string
    deckName: string
}

export interface DuplicateAnkiCandidate {
    id: number
    modelName: string
    decks: string[]
    fieldChanges: Array<{ name: string; source?: string; anki?: string }>
}

type Target = { note: NewNote; firstField?: string; source: DuplicateSource }
type DuplicateFinding = { origin: 'anki' | 'batch'; otherSource?: DuplicateSource; ankiCandidates?: DuplicateAnkiCandidate[] }
type Action = 'canAddNotesWithErrorDetail' | 'canAddNotes' | 'findNotes' | 'notesInfo' | 'getDecks' | 'multi'
type Read = (action: Action, params: Record<string, unknown>) => Promise<unknown>

const batchSize = 128
const maxCandidateQueries = 12
const maxCandidateNotes = 48
const maxFieldDetails = 12
const unavailableAction = /\b(?:unsupported(?: action)?|(?:action|method) (?:is )?(?:not supported|not found|unknown)|unknown (?:action|method))\b/i

const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const numericId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function collectionDuplicateOptions(note: NewNote) {
    return { ...note.options, allowDuplicate: false, duplicateScope: 'collection', duplicateScopeOptions: { checkAllModels: true } }
}

function lookupQuery(fields: readonly string[], value: string): string | undefined {
    if (!value.length || value.length > 160 || /[<>&\r\n\t]/.test(value)) return undefined
    const names = [...new Set(fields)].filter(name => /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(name)).slice(0, 30)
    const escape = (text: string) => text.replace(/[\\*_:"()]/g, '\\$&')
    return names.map(name => `"${escape(name)}:${escape(value)}"`).join(' OR ') || undefined
}

function firstValue(target: Target): string | undefined {
    const value = target.firstField && Object.prototype.hasOwnProperty.call(target.note.fields, target.firstField)
        ? target.note.fields[target.firstField] : undefined
    return typeof value === 'string' && value.trim() ? value.normalize('NFC') : undefined
}

export class DuplicatePreflight {
    private mode: 'detailed' | 'legacy' | 'guard-only' = 'detailed'
    private readonly previous = new Map<string, DuplicateSource>()

    async check<T extends Target>(targets: readonly T[], knownFirstFields: readonly string[], read: Read,
        shouldStop?: () => boolean): Promise<ReadonlyMap<T, DuplicateFinding>> {
        const findings = new Map<T, DuplicateFinding>()
        const rpc: Read = (action, params) => withAnkiDeadline(() => read(action, params), 'Check new Anki notes', 12_000)
        for (let offset = 0; offset < targets.length && !shouldStop?.(); offset += batchSize) {
            const batch = targets.slice(offset, offset + batchSize)
            const eligible = batch.filter(target => {
                const value = firstValue(target)
                const earlier = value && this.previous.get(value)
                if (!earlier) return true
                findings.set(target, { origin: 'batch', otherSource: earlier })
                return false
            })
            const rejected = await this.remoteRejections(eligible, rpc)
            const candidates = rejected.size && !shouldStop?.()
                ? await this.readCandidates([...rejected.keys()], knownFirstFields, rpc) : new Map<T, DuplicateAnkiCandidate[]>()
            for (const target of eligible) {
                if (shouldStop?.()) return findings
                const remote = candidates.get(target)
                if (rejected.get(target) === 'duplicate' || remote?.length) {
                    findings.set(target, { origin: 'anki', ankiCandidates: remote })
                    continue
                }
                const value = firstValue(target)
                if (!value) continue
                const earlier = this.previous.get(value)
                if (earlier) findings.set(target, { origin: 'batch', otherSource: earlier })
                else this.previous.set(value, target.source)
            }
        }
        return findings
    }

    private async remoteRejections<T extends Target>(targets: readonly T[], read: Read): Promise<Map<T, 'duplicate' | 'unknown'>> {
        const result = new Map<T, 'duplicate' | 'unknown'>()
        if (!targets.length || this.mode === 'guard-only') return result
        const notes = targets.map(({ note }) => ({ deckName: note.deckName, modelName: note.modelName,
            fields: note.fields, options: collectionDuplicateOptions(note) }))
        if (this.mode === 'detailed') {
            try {
                const answer = await read('canAddNotesWithErrorDetail', { notes })
                if (!Array.isArray(answer) || answer.length !== targets.length) {
                    this.mode = 'guard-only'
                    return result
                }
                const rows = answer.map(record)
                if (rows.some(row => !row || typeof row.canAdd !== 'boolean' ||
                    !(row.error === undefined || row.error === null || typeof row.error === 'string'))) {
                    this.mode = 'guard-only'
                    return result
                }
                rows.forEach((row, index) => {
                    if (row?.canAdd === false && typeof row.error === 'string' && isDuplicateFirstFieldErrorMessage(row.error)) {
                        result.set(targets[index], 'duplicate')
                    } else if (row?.canAdd === false && typeof row.error === 'string' && /^deck was not found\s*:/i.test(row.error)) {
                        result.set(targets[index], 'unknown')
                    }
                })
                return result
            } catch (error) {
                if (!unavailableAction.test(String(error))) {
                    this.mode = 'guard-only'
                    return result
                }
                this.mode = 'legacy'
            }
        }
        try {
            const answer = await read('canAddNotes', { notes })
            if (Array.isArray(answer) && answer.length === targets.length && answer.every(value => typeof value === 'boolean')) {
                answer.forEach((canAdd, index) => { if (!canAdd) result.set(targets[index], 'unknown') })
            } else this.mode = 'guard-only'
        } catch {
            this.mode = 'guard-only'
        }
        return result
    }

    private async readCandidates<T extends Target>(targets: readonly T[], fields: readonly string[], read: Read): Promise<Map<T, DuplicateAnkiCandidate[]>> {
        const matches = new Map<T, DuplicateAnkiCandidate[]>()
        const byQuery = new Map<string, T[]>()
        for (const target of targets) {
            const value = firstValue(target)
            const query = value && lookupQuery(fields, value)
            if (!query) continue
            const earlier = byQuery.get(query)
            if (earlier) earlier.push(target)
            else if (byQuery.size < maxCandidateQueries) byQuery.set(query, [target])
        }
        if (!byQuery.size) return matches
        const groups = [...byQuery.entries()]
        let answers: unknown[]
        try {
            const actions = groups.map(([query]) => ({ action: 'findNotes', version: 6, params: { query } }))
            const result = actions.length === 1 ? [{ error: null, result: await read('findNotes', actions[0].params) }]
                : await read('multi', { actions })
            if (!Array.isArray(result) || result.length !== actions.length) return matches
            answers = result.map(value => {
                const row = record(value)
                return row?.error === null ? row.result : undefined
            })
        } catch {
            return matches
        }
        const idsByTarget = new Map<T, number[]>()
        const selectedIds = new Set<number>()
        answers.forEach((ids, index) => {
            if (!Array.isArray(ids) || ids.length > maxCandidateNotes || !ids.every(numericId) || new Set(ids).size !== ids.length) return
            const selected: number[] = []
            for (const id of ids) {
                if (!selectedIds.has(id) && selectedIds.size >= maxCandidateNotes) continue
                selectedIds.add(id)
                selected.push(id)
            }
            for (const target of groups[index][1]) idsByTarget.set(target, selected)
        })
        if (!selectedIds.size) return matches
        try {
            const info = await read('notesInfo', { notes: [...selectedIds] })
            if (!Array.isArray(info)) return matches
            const rows = new Map<number, { modelName: string; fields: Array<{ name: string; value: string }>; cards: number[] }>()
            const cardIds = new Set<number>()
            const seen = new Set<number>()
            for (const value of info) {
                const row = record(value)
                const id = row?.noteId
                if (!numericId(id) || !selectedIds.has(id)) return matches
                if (seen.has(id)) return matches
                seen.add(id)
                const fields = record(row?.fields)
                if (!fields || typeof row?.modelName !== 'string' || !Array.isArray(row.cards) || !row.cards.every(numericId)) continue
                const ordered = Object.entries(fields).map(([name, raw]) => ({ name, field: record(raw) }))
                    .sort((a, b) => Number(a.field?.order) - Number(b.field?.order))
                if (!ordered.length || ordered.some(({ field }, index) => field?.order !== index || typeof field.value !== 'string')) continue
                rows.set(id, { modelName: row.modelName, fields: ordered.map(({ name, field }) => ({ name, value: field!.value as string })), cards: row.cards })
                for (const card of row.cards) if (cardIds.size < 500) cardIds.add(card)
            }
            let decks: Record<string, unknown> | undefined
            if (cardIds.size) {
                try { decks = record(await read('getDecks', { cards: [...cardIds] })) } catch { /* ID и поля уже подтверждены. */ }
            }
            const cardDecks = new Map<number, string>()
            const ambiguousCards = new Set<number>()
            for (const [deck, ids] of Object.entries(decks ?? {})) if (Array.isArray(ids) && ids.every(numericId)) {
                for (const id of ids) {
                    if (!cardIds.has(id) || ambiguousCards.has(id)) continue
                    const earlier = cardDecks.get(id)
                    if (earlier && earlier !== deck) {
                        ambiguousCards.add(id)
                        cardDecks.delete(id)
                    } else cardDecks.set(id, deck)
                }
            }
            for (const [target, ids] of idsByTarget) {
                const sourceValue = firstValue(target)
                if (!sourceValue) continue
                const candidates: DuplicateAnkiCandidate[] = []
                for (const id of ids) {
                    const row = rows.get(id)
                    if (!row || !sameFieldValue(row.fields[0].value, sourceValue)) continue
                    const current = new Map(row.fields.map(field => [field.name, field.value]))
                    const names = new Set([...Object.keys(target.note.fields), ...current.keys()])
                    const fieldChanges: DuplicateAnkiCandidate['fieldChanges'] = []
                    for (const name of names) {
                        const source = Object.prototype.hasOwnProperty.call(target.note.fields, name) ? target.note.fields[name] : undefined
                        const anki = current.get(name)
                        if (source === anki || source !== undefined && sameFieldValue(anki, source)) continue
                        fieldChanges.push({ name, source: source?.slice(0, 500), anki: anki?.slice(0, 500) })
                        if (fieldChanges.length === maxFieldDetails) break
                    }
                    candidates.push({ id, modelName: row.modelName, decks: [...new Set(row.cards.flatMap(card => {
                        const deck = cardDecks.get(card)
                        return deck ? [deck] : []
                    }))], fieldChanges })
                    if (candidates.length === 8) break
                }
                if (candidates.length) matches.set(target, candidates)
            }
        } catch {
            // Keep the matches confirmed before the lookup failed.
        }
        return matches
    }
}
