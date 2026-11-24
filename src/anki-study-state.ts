/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { isRecoveryTag } from './export-recovery'

export function isProtectedAnkiTag(tag: string): boolean {
    const key = tag.toLowerCase()
    return key === 'leech' || key === 'marked' || isRecoveryTag(key)
}

export type AnkiStudyRead = (action: 'deckNamesAndIds' | 'findCards', params?: Record<string, unknown>) => Promise<unknown>
type AnkiDeckConfigRead = (action: 'getDeckConfig', params: { deck: string }) => Promise<unknown>

export async function readAnkiDeckKind(deck: string, read: AnkiDeckConfigRead):
    Promise<'filtered' | 'ordinary' | 'missing' | 'unknown'> {
    return deckKind(await read('getDeckConfig', { deck }))
}

type DeckKind = 'filtered' | 'ordinary' | 'missing' | 'unknown'
function deckKind(response: unknown): DeckKind {
    if (response === false) return 'missing'
    if (!response || typeof response !== 'object' || Array.isArray(response) || !('dyn' in response)) return 'unknown'
    const { dyn } = response
    if (dyn === true || dyn === 1) return 'filtered'
    if (dyn === false || dyn === 0) return 'ordinary'
    return 'unknown'
}

export function ankiStudyDeckKey(deck: string): string {
    return deck.normalize('NFC').toLowerCase()
}

function isId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export async function readAnkiDeckEntries(read: AnkiStudyRead): Promise<Map<string, { name: string; id: number }>> {
    const response = await read('deckNamesAndIds')
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error('deckNamesAndIds: expected deck names and IDs')
    }
    const result = new Map<string, { name: string; id: number }>()
    const ids = new Set<number>()
    for (const [deck, id] of Object.entries(response)) {
        const key = ankiStudyDeckKey(deck)
        if (!key || !isId(id) || result.has(key) || ids.has(id)) throw new Error('deckNamesAndIds: ambiguous or invalid deck')
        result.set(key, { name: deck, id })
        ids.add(id)
    }
    return result
}

export async function readFilteredAnkiDecks(decks: Iterable<string>,
    read: (action: 'getDeckConfig' | 'deckNamesAndIds' | 'multi', params?: Record<string, unknown>) => Promise<unknown>,
    shouldStop?: () => boolean, unverified = new Set<string>()): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const names = new Map<string, string>()
    for (const deck of decks) names.set(ankiStudyDeckKey(deck), deck)
    const inspect = async (list: string[]): Promise<[string, DeckKind][]> => {
        const checked: [string, DeckKind][] = []
        for (let offset = 0; offset < list.length; offset += 64) {
            if (shouldStop?.()) break
            const batch = list.slice(offset, offset + 64)
            if (batch.length === 1) {
                checked.push([batch[0], await readAnkiDeckKind(batch[0], read).catch(() => 'unknown' as const)])
                continue
            }
            const reply = await read('multi', { actions: batch.map(deck => ({
                action: 'getDeckConfig', version: 6, params: { deck },
            })) }).catch(() => undefined)
            const rows: readonly unknown[] = Array.isArray(reply) && reply.length === batch.length ? reply : []
            batch.forEach((deck, i) => {
                const item = rows[i]
                checked.push([deck, item && typeof item === 'object' && 'error' in item && item.error === null && 'result' in item ? deckKind(item.result) : 'unknown'])
            })
        }
        return checked
    }
    const checked = new Map(await inspect([...names.values()]))
    const missing = [...checked].filter(([, kind]) => kind === 'missing')
    if (missing.length && !shouldStop?.()) {
        const entries = await readAnkiDeckEntries(() => read('deckNamesAndIds')).catch(() => undefined)
        const aliases: string[] = []
        for (const [deck] of missing) {
            const key = ankiStudyDeckKey(deck)
            const entry = entries?.get(key)
            if (!entries || entry?.name === deck) checked.set(deck, 'unknown')
            else if (entry) {
                checked.delete(deck)
                names.set(key, entry.name)
                aliases.push(entry.name)
            }
        }
        for (const [deck, kind] of await inspect(aliases)) checked.set(deck, kind === 'missing' ? 'unknown' : kind)
    }
    for (const [key, deck] of names) {
        const kind = checked.get(deck)
        if (kind === 'filtered') result.set(key, deck)
        else if (!kind || kind === 'unknown') unverified.add(key)
    }
    return result
}

export async function readAnkiDeckIds(read: AnkiStudyRead): Promise<Map<string, number>> {
    const entries = await readAnkiDeckEntries(read)
    return new Map(Array.from(entries, ([key, entry]) => [key, entry.id]))
}

async function findCardIds(filter: string, cards: readonly number[], read: AnkiStudyRead): Promise<Set<number>> {
    const result = new Set<number>()
    const unique = Array.from(new Set(cards))
    for (let offset = 0; offset < unique.length; offset += 500) {
        const batch = unique.slice(offset, offset + 500)
        const requested = new Set(batch)
        const response = await read('findCards', { query: `${filter} cid:${batch.join(',')}` })
        if (response == null) throw new Error('findCards: no search result')
        if (!Array.isArray(response)) throw new Error('findCards: expected card IDs')
        for (const id of response) {
            if (!isId(id) || !requested.delete(id)) throw new Error('findCards: unexpected or repeated card ID')
            result.add(id)
        }
    }
    return result
}

export function findFilteredAnkiCards(cards: readonly number[], read: AnkiStudyRead): Promise<Set<number>> {
    return findCardIds('deck:filtered', cards, read)
}

export async function findAnkiDeckCardIds(deckId: number, cards: readonly number[], read: AnkiStudyRead): Promise<Set<number>> {
    if (!isId(deckId)) throw new Error('Invalid Anki deck ID')
    return findCardIds(`did:${deckId}`, cards, read)
}
