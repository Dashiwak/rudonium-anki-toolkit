/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
export type CardGenerationHazard = 'cloze' | 'reverse'

export interface CardStudyDetail {
    id: number
    order?: number
    repetitions?: number
    interval?: number
    queue?: number
    deck?: string
}

export interface ReviewedCardImpact {
    hazards: readonly CardGenerationHazard[]
    cardIds: readonly number[]
    cards: readonly CardStudyDetail[]
}

export interface VerifiedCardImpact {
    noteId: number
    path: string
    kept: readonly number[]
    added: readonly number[]
    missing: readonly number[]
}

const clozeMarker = /\{\{c(\d+)::/giu
const simpleCloze = /\{\{c(\d+)::([^{}]*?)\}\}/giu

function clozeOrdinals(value: string): string[] {
    return [...value.matchAll(clozeMarker)].map(match => match[1])
}

function movedClozeText(before: string, after: string): boolean {
    // Одинаковый набор номеров тоже может скрывать перенос знакомого ответа под другой номер.
    function groups(value: string): Map<string, Set<string>> {
        const result = new Map<string, Set<string>>()
        for (const match of value.matchAll(simpleCloze)) {
            const answer = match[2].split('::', 1)[0].trim()
            if (!answer) continue
            const ordinals = result.get(answer) ?? new Set<string>()
            ordinals.add(match[1])
            result.set(answer, ordinals)
        }
        return result
    }
    const previous = groups(before)
    for (const [answer, numbers] of groups(after)) {
        const old = previous.get(answer)
        if (old && (old.size !== numbers.size || [...old].some(ordinal => !numbers.has(ordinal)))) return true
    }
    return false
}

function reverseTrigger(value: string): boolean | undefined {
    const plain = value.replace(/<!--[^]*?-->|<\/?(?:div|p)\b[^>]*>|<br\b[^>]*>|&nbsp;|&#(?:160|x0*a0);/giu, '').trim()
    // Необычная разметка может по-разному учитываться шаблоном Anki.
    return /[<>]|&(?:#\w+|[a-z]+);/iu.test(plain) ? undefined : plain.length > 0
}

/** Отмечает изменения с риском для состава карточек. Точный результат проверяется после записи. */
export function cardFieldHazards(field: string, before: string, after: string): CardGenerationHazard[] {
    if (before === after) return []
    const result: CardGenerationHazard[] = []
    if (field.trim().toLowerCase() === 'add reverse') {
        const previous = reverseTrigger(before)
        const next = reverseTrigger(after)
        if (previous === undefined || next === undefined || previous !== next) result.push('reverse')
    }
    const previous = clozeOrdinals(before)
    const next = clozeOrdinals(after)
    if (previous.length !== next.length || previous.some((number, index) => number !== next[index]) ||
        (previous.length > 0 && movedClozeText(before, after))) result.push('cloze')
    return result
}

export function readCardIds(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined
    const ids: number[] = []
    const seen = new Set<number>()
    for (const id of value) {
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return undefined
        seen.add(id)
        ids.push(id)
    }
    return ids.sort((first, second) => first - second)
}

export function sameCardIds(actual: readonly number[], expected: readonly number[]): boolean {
    if (actual.length !== expected.length) return false
    const known = new Set(expected)
    return actual.every(id => known.delete(id))
}

function integer(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function isStudyRow(row: unknown): row is Record<string, unknown> {
    return row !== null && typeof row === 'object' && !Array.isArray(row)
}

/** Проверяет владельца и ID каждой карточки независимо от порядка строк AnkiConnect. */
export function parseCardStudyRows(value: unknown, noteId: number, cardIds: readonly number[]): CardStudyDetail[] {
    if (!Array.isArray(value) || value.length !== cardIds.length) throw new Error('Anki did not confirm all requested study cards.')
    const pending = new Set(cardIds)
    const result: CardStudyDetail[] = []
    const rows: readonly unknown[] = value
    for (const row of rows) {
        if (!isStudyRow(row) || row.note !== noteId || typeof row.cardId !== 'number' || !pending.delete(row.cardId)) {
            throw new Error('Anki returned another note or card in the requested study cards.')
        }
        result.push({
            id: row.cardId, order: integer(row.ord), repetitions: integer(row.reps), interval: integer(row.interval),
            queue: integer(row.queue), deck: typeof row.deckName === 'string' ? row.deckName : undefined,
        })
    }
    return result.sort((first, second) => first.id - second.id)
}

export async function readCardStudyDetails(noteId: number, cardIds: readonly number[],
    read: (cards: number[]) => Promise<unknown>): Promise<CardStudyDetail[]> {
    const result: CardStudyDetail[] = []
    for (let start = 0; start < cardIds.length; start += 500) {
        const batch = cardIds.slice(start, start + 500)
        result.push(...parseCardStudyRows(await read(batch), noteId, batch))
    }
    return result.sort((first, second) => first.id - second.id)
}

export function compareStudyCardIds(noteId: number, path: string, before: readonly number[], after: readonly number[]): VerifiedCardImpact {
    const previous = new Set(before)
    const actual = new Set(after)
    return { noteId, path, kept: before.filter(id => actual.has(id)),
        added: after.filter(id => !previous.has(id)), missing: before.filter(id => !actual.has(id)) }
}
