/*! SPDX-License-Identifier: GPL-3.0-only */
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import { checkPinnedAnkiProfile, requireExpectedAnkiProfile } from './anki-profile'
import { withAnkiDeadline, withAnkiWriteDeadline } from './anki-transport'

export interface SuspendCard { cardId: number; number: number | null; suspended: boolean }
type CardMap = ReadonlyMap<number, readonly SuspendCard[]>
const batchSize = 500
const flagBatchSize = 5_000

function invalid(): Error {
    return new Error('Anki could not confirm the cards, template numbers, or suspension state. Open a fresh preview. / Не удалось подтвердить карточки Anki, номера шаблонов или их статус. Откройте новый предпросмотр.')
}
function id(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function read(action: string, params: Record<string, unknown>): Promise<unknown> {
    return withAnkiDeadline(() => AnkiConnect.invoke(action, params), 'AnkiConnect ' + action)
}

export async function readSuspendCards(profile: string, notes: ReadonlyMap<number, readonly number[]>,
    numbered: ReadonlySet<number> = new Set()): Promise<Map<number, SuspendCard[]>> {
    const result = new Map<number, SuspendCard[]>()
    const owners = new Map<number, number>()
    for (const [noteId, cards] of notes) {
        if (!id(noteId) || !Array.isArray(cards) || !cards.length) throw invalid()
        for (const cardId of cards) {
            if (!id(cardId) || owners.has(cardId)) throw invalid()
            owners.set(cardId, noteId)
        }
        result.set(noteId, [])
    }
    if (!owners.size) return result
    await checkPinnedAnkiProfile(profile)
    const ids = [...owners.keys()]
    const cardsById = new Map<number, SuspendCard>()
    for (let offset = 0; offset < ids.length; offset += flagBatchSize) {
        const cards = ids.slice(offset, offset + flagBatchSize)
        const flags: unknown = await read('areSuspended', { cards })
        if (!Array.isArray(flags) || flags.length !== cards.length) throw invalid()
        cards.forEach((cardId, i) => {
            const suspended: unknown = flags[i]
            if (typeof suspended !== 'boolean') throw invalid()
            const slot: SuspendCard = { cardId, number: null, suspended }
            cardsById.set(cardId, slot)
            result.get(owners.get(cardId)!)!.push(slot)
        })
    }
    const details: number[] = []
    for (const [noteId, slots] of result) {
        if (numbered.has(noteId) || slots.some(slot => slot.suspended) && slots.some(slot => !slot.suspended)) {
            for (const slot of slots) details.push(slot.cardId)
        }
    }
    for (let offset = 0; offset < details.length; offset += batchSize) {
        const cards = details.slice(offset, offset + batchSize)
        const rows: unknown = await read('cardsInfo', { cards })
        const pending = new Set(cards)
        if (!Array.isArray(rows) || rows.length !== cards.length) throw invalid()
        for (const row of rows) {
            if (!record(row) || !id(row.cardId) || !pending.delete(row.cardId) || row.note !== owners.get(row.cardId) ||
                typeof row.ord !== 'number' || !Number.isSafeInteger(row.ord) || row.ord < 0 || !Number.isSafeInteger(row.ord + 1)) throw invalid()
            cardsById.get(row.cardId)!.number = row.ord + 1
        }
    }
    for (const slots of result.values()) {
        if (slots[0].number !== null && new Set(slots.map(slot => slot.number)).size !== slots.length) throw invalid()
    }
    await checkPinnedAnkiProfile(profile)
    return result
}

/** Снимок карт из notesInfo подтверждает и владельца, и полный набор карточек, включая добавленные шаблоны. */
export async function verifySuspendCards(profile: string, expected: CardMap, targets?: ReadonlyMap<number, ReadonlySet<number>>): Promise<void> {
    if (!expected.size) return
    const notes = [...expected.keys()]
    const owners = new Map<number, number[]>()
    const numbered = new Set<number>()
    await checkPinnedAnkiProfile(profile)
    for (let offset = 0; offset < notes.length; offset += batchSize) {
        const batch = notes.slice(offset, offset + batchSize)
        const rows: unknown = await read('notesInfo', { notes: batch })
        const pending = new Set(batch)
        if (!Array.isArray(rows) || rows.length !== batch.length) throw invalid()
        for (const row of rows) {
            if (!record(row) || !id(row.noteId) || !pending.delete(row.noteId) || !Array.isArray(row.cards) ||
                row.profile !== undefined && row.profile !== profile) throw invalid()
            const slots = expected.get(row.noteId)!
            const ids = new Set(slots.map(slot => slot.cardId))
            const keys: readonly unknown[] = row.cards
            const cards: number[] = []
            if (keys.length !== slots.length) throw invalid()
            for (const key of keys) {
                if (!id(key) || !ids.delete(key)) throw invalid()
                cards.push(key)
            }
            owners.set(row.noteId, cards)
            if (slots.some(slot => slot.number !== null)) numbered.add(row.noteId)
        }
    }
    const actual = await readSuspendCards(profile, owners, numbered)
    for (const [noteId, slots] of expected) {
        const old = new Map(slots.map(slot => [slot.cardId, slot]))
        for (const current of actual.get(noteId)!) {
            const prior = old.get(current.cardId)!
            if (prior.number !== null && prior.number !== current.number ||
                (targets?.get(noteId)?.has(current.cardId) ?? prior.suspended) !== current.suspended) throw invalid()
        }
    }
}

export async function applySuspendCards(plugin: MyPlugin, profile: string, expected: CardMap,
    targets: ReadonlyMap<number, ReadonlySet<number>>, guard?: (noteIds: readonly number[]) => void | Promise<void>,
    onWriteRequest?: (answered: boolean) => void): Promise<void> {
    if (!expected.size) return
    const add: number[] = [], remove: number[] = []
    const owners = new Map<number, number>()
    for (const [noteId, slots] of expected) {
        const target = targets.get(noteId)
        if (!target) throw invalid()
        const valid = new Set(slots.map(slot => slot.cardId))
        for (const cardId of target) if (!valid.has(cardId)) throw invalid()
        for (const slot of slots) {
            owners.set(slot.cardId, noteId)
            const wanted = target.has(slot.cardId)
            if (slot.suspended !== wanted) (wanted ? add : remove).push(slot.cardId)
        }
    }
    // Проверяем изменяемые пакеты перед каждой записью. При переносе только в Markdown сверяем весь снимок.
    if (!add.length && !remove.length) {
        await verifySuspendCards(profile, expected)
        return
    }
    const observed = new Map([...expected].map(([noteId, slots]) =>
        [noteId, new Set(slots.filter(slot => slot.suspended).map(slot => slot.cardId))] as const))
    let lastVerified: ReadonlyMap<number, readonly SuspendCard[]> | undefined
    for (const [action, ids] of [['suspend', add], ['unsuspend', remove]] as const) {
        for (let offset = 0; offset < ids.length; offset += batchSize) {
            const cards = ids.slice(offset, offset + batchSize)
            const touched = new Map(cards.map(cardId => {
                const noteId = owners.get(cardId)!
                return [noteId, expected.get(noteId)!] as const
            }))
            await verifySuspendCards(profile, touched, observed)
            await guard?.([...touched.keys()])
            await requireExpectedAnkiProfile(plugin, profile)
            await withAnkiWriteDeadline(plugin.app, async () => {
                onWriteRequest?.(false)
                const answer = await AnkiConnect.invoke(action, { cards })
                onWriteRequest?.(true)
                return answer
            }, 'AnkiConnect ' + action)
            for (const cardId of cards) {
                const set = observed.get(owners.get(cardId)!)!
                if (action === 'suspend') set.add(cardId)
                else set.delete(cardId)
            }
            await verifySuspendCards(profile, touched, observed)
            lastVerified = touched
        }
    }
    if (lastVerified?.size !== expected.size) await verifySuspendCards(profile, expected, targets)
}
