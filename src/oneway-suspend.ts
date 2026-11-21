// SPDX-License-Identifier: GPL-3.0-only
import { exportOperationKey } from './export-plan'
import type { ExportPreviewOperation } from './export-plan'
import type { SuspendSelection, SuspendMark } from './suspend-marker'
import type { SuspendCard } from './suspend-anki'

export interface OneWaySuspendMark {
    id: number
    selection: SuspendSelection
    modelName: string
}

export function ownedSuspendMarks(
    marks: ReadonlyMap<number, SuspendMark>,
    candidates: readonly { identifier?: number; start: number; end: number; note: { modelName: string } }[],
    edits: readonly { identifier: number; note: { modelName: string } }[],
    deleted: readonly number[],
): OneWaySuspendMark[] {
    const owners = new Map(edits.map(edit => [edit.identifier, edit.note]))
    const blocked = new Set(deleted)
    const found = new Map<number, OneWaySuspendMark>()
    for (const range of candidates) {
        const id = range.identifier
        if (id === undefined || blocked.has(id)) continue
        const mark = marks.get(id)
        if (!mark || range.start > mark.idStart || mark.idStart >= range.end) continue
        if (found.has(id)) {
            blocked.add(id)
            found.delete(id)
        } else if (owners.get(id) === range.note) {
            found.set(id, { id, modelName: range.note.modelName, selection: mark.selection })
        }
    }
    return [...found.values()]
}

export interface SuspendChange {
    path: string
    id: number
    cards: readonly SuspendCard[]
    target: Set<number>
    operation: ExportPreviewOperation
}

/** Номера шаблонов Anki могут иметь пропуски. Позиция в массиве cards ничего не говорит о номере. */
export function oneWaySuspendChange(path: string, mark: OneWaySuspendMark, cards: readonly SuspendCard[]): SuspendChange | undefined {
    if (!cards.length) throw new Error('No Anki cards for note ' + mark.id + ' / У записи Anki нет карточек.')
    const slots = mark.selection === 'all' ? null : new Set(mark.selection)
    const available = slots && new Set(cards.map(card => card.number))
    if (slots && available && [...slots].some(n => !available.has(n))) {
        throw new Error('Unknown card number for Anki note ' + mark.id + ' / У записи Anki нет указанного номера карточки.')
    }
    const target = new Set<number>()
    const changed: number[] = []
    for (const card of cards) {
        const marked = !slots || (card.number !== null && slots.has(card.number))
        if (card.suspended || marked) target.add(card.cardId)
        if (marked && !card.suspended) changed.push(card.cardId)
    }
    if (!changed.length) return
    const evidence = [...cards].sort((a, b) => a.cardId - b.cardId).map(card => [card.cardId, card.number, card.suspended])
    const key = exportOperationKey('suspend', [mark.id, mark.modelName, mark.selection, evidence])
    return { path, id: mark.id, cards, target, operation: { key, kind: 'suspend', id: mark.id,
        modelName: mark.modelName, suspendSelection: mark.selection, values: [{ name: 'Card IDs', after: changed.join(', ') }] } }
}
