/*! SPDX-License-Identifier: GPL-3.0-only */
import type { SuspendCard } from './suspend-anki'
import type { SuspendSelection } from './suspend-marker'

/** Запоминаем идентичность учебных карточек лишь для записей, где есть паузы. */
export interface SuspendBase {
    marker: SuspendSelection
    cards: [cardId: number, number: number | null, suspended: boolean][]
}
export function validSuspendBase(value: unknown): value is SuspendBase {
    if (!value || typeof value !== 'object') return false
    const { marker, cards } = value as SuspendBase
    const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    if (!Array.isArray(cards) || !cards.length || !cards.every(row => Array.isArray(row) && row.length === 3 &&
        positive(row[0]) && (row[1] === null || positive(row[1])) && typeof row[2] === 'boolean') ||
        new Set(cards.map(row => row[0])).size !== cards.length) return false
    const numbers = cards.map(([, number]) => number).filter(number => number !== null)
    if (new Set(numbers).size !== numbers.length || numbers.length && numbers.length !== cards.length) return false
    if (marker === 'all') return cards.every(([, , paused]) => paused)
    if (!Array.isArray(marker) || !marker.length || !marker.every((n, i) => positive(n) && (!i || n > marker[i - 1]))) return false
    const selected = new Set(marker)
    return numbers.length === cards.length && cards.filter(([, , paused]) => paused).length === selected.size &&
        cards.every(([, number, paused]) => paused === selected.has(number!))
}
function equalSelection(a: SuspendSelection | null, b: SuspendSelection | null): boolean {
    return a === b || Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((n, i) => n === b[i])
}
export function describeSuspendSelection(slots: readonly SuspendCard[], selected: ReadonlySet<number>): SuspendSelection | null {
    if (!selected.size) return null
    if (selected.size === slots.length) return 'all'
    return slots.filter(slot => selected.has(slot.cardId)).map(slot => {
        if (slot.number === null) throw new Error('Anki did not confirm a suspended card’s template number. / Anki не подтвердила номер шаблона приостановленной карточки.')
        return slot.number
    }).sort((a, b) => a - b)
}
export class SuspensionTopologyChanged extends Error {}

export function mergeSuspension(slots: readonly SuspendCard[], marker: SuspendSelection | null, base?: SuspendBase) {
    const old = new Map(base?.cards.map(([cardId, number, suspended]) => [cardId, { number, suspended }]))
    const edited = !equalSelection(marker, base?.marker ?? null)
    const numbers = new Set(Array.isArray(marker) ? marker : [])
    const local = new Set(slots.filter(slot => marker === 'all' || slot.number !== null && numbers.has(slot.number)).map(slot => slot.cardId))
    const topologyChanged = !!base && (slots.length !== old.size || slots.some(slot => {
        const before = old.get(slot.cardId)
        return !before || before.number !== null && before.number !== slot.number
    }))
    const currentIds = new Set(slots.map(slot => slot.cardId))
    if (base && (edited && topologyChanged || base.cards.some(([id, , paused]) => paused && !currentIds.has(id)))) {
        throw new SuspensionTopologyChanged('Anki card templates changed since the last sync. Check the template numbers before changing this marker. / Изменился состав карточек Anki. Проверьте соответствие номеров шаблонов и ID.')
    }
    if ((!base || edited) && Array.isArray(marker) && local.size !== numbers.size) {
        throw new Error('A template number in the suspension marker does not exist in Anki. / Номера из метки паузы нет среди шаблонов этой записи Anki.')
    }
    const target = new Set<number>()
    for (const slot of slots) {
        const before = old.get(slot.cardId)
        const selected = local.has(slot.cardId)
        // При первом связывании сохраняем обе паузы. На следующих сверках используем стабильный cardId.
        const wanted = !base ? selected || slot.suspended :
            edited && before && selected !== before.suspended ? selected : slot.suspended
        if (wanted) target.add(slot.cardId)
    }
    const remote = new Set(slots.filter(slot => slot.suspended).map(slot => slot.cardId))
    const remoteChange = slots.some(slot => target.has(slot.cardId) !== slot.suspended)
    const matchesLocal = slots.every(slot => local.has(slot.cardId) === target.has(slot.cardId)) &&
        (!Array.isArray(marker) || numbers.size === local.size)
    const nextMarker = matchesLocal ? marker : describeSuspendSelection(slots, target)
    const next: SuspendBase | undefined = nextMarker === null ? undefined : {
        marker: nextMarker, cards: slots.map(slot => [slot.cardId, slot.number, target.has(slot.cardId)] as [number, number | null, boolean])
            .sort((a, b) => a[0] - b[0]),
    }
    const localChange = !equalSelection(marker, nextMarker)
    return { target, remote, nextMarker, next, remoteChange, localChange, changed: remoteChange || localChange || JSON.stringify(next) !== JSON.stringify(base) }
}

/** При смене идентичности только явный выбор актуальной стороны Anki устанавливает новое соответствие. */
export function acceptAnkiSuspension(slots: readonly SuspendCard[], marker: SuspendSelection | null) {
    const observed = mergeSuspension(slots, null)
    return { ...observed, changed: true, localChange: !equalSelection(marker, observed.nextMarker) }
}
