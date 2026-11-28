/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit. See NOTICE.md for component attribution and licenses.
 */
import { invoke } from './anki'
import { withAnkiDeadline } from './anki-transport'
import type { UiText } from './interface-language'

export async function browseAnkiNote(id: number, t: UiText, verify: () => Promise<void>,
    signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(t('This Anki note ID is invalid.', 'Некорректный ID записи Anki.'))
    const host = window as Window & { activeDocument?: Document }
    const origin = host.activeDocument ?? host.document
    const initialElement = origin?.activeElement
    const stillHere = () => origin?.hasFocus() && origin.activeElement === initialElement
    const browse = async () => {
        const cards = await withAnkiDeadline(() => invoke('guiBrowse', { query: `nid:${id}` }), 'Open Anki Browse', 10_000, signal)
        if (!Array.isArray(cards) || cards.some(card => !Number.isSafeInteger(card) || card <= 0)) {
            throw new Error(t('Anki Browse did not return a valid card list.', 'Обозреватель Anki не вернул корректный список карточек.'))
        }
        return cards.length
    }
    await verify()
    let count = await browse()
    // Reopening an existing Anki Browser asks Anki's dialog manager to restore,
    // activate and raise that window. Leave focus alone once the user has moved.
    if (count && stillHere()) {
        await verify()
        if (stillHere()) count = await browse()
    }
    if (!count) return t(`Anki Browse found no cards for nid:${id}.`, `По запросу nid:${id} в обозревателе Anki нет карточек.`)
    return stillHere()
        ? t(`Note ${id} is open in Anki Browse. Switch to Anki to see it.`, `Запись ${id} открыта в обозревателе Anki. Переключитесь в Anki, чтобы увидеть её.`)
        : t(`Opened note ${id} in Anki Browse.`, `Запись ${id} открыта в обозревателе Anki.`)
}
