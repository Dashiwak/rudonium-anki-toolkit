// SPDX-License-Identifier: GPL-3.0-only
import type MyPlugin from '../main'
import type { AllFile, CardPreviewCandidate } from './file'
import { imageFieldMediaKeys } from './image-field-links'

export interface CursorCardTarget {
    path: string
    text: string
    offset: number
    model: string
    deck: string
    profile: string
    configuration: string
    id?: number
}

export function cursorConfiguration(plugin: MyPlugin): string {
    const { BIDIRECTIONAL_PREVIEW, ...settings } = plugin.settings
    return JSON.stringify([settings, plugin.fields_dict])
}

/** Смещения редактора отсчитываются в UTF-16. На диске те же строки могут иметь окончания CRLF. */
export function cursorCardOffset(target: CursorCardTarget, path: string, source: string): number {
    const { text, offset } = target
    if (path !== target.path || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw staleCursorCard()
    if (source === text) return offset
    const normalized = text.replace(/\r\n/g, '\n')
    if (normalized !== source.replace(/\r\n/g, '\n')) throw staleCursorCard()
    const position = text.slice(0, offset).replace(/\r\n/g, '\n').length
    let raw = 0
    for (let i = 0; i < position; i++, raw++) if (source.startsWith('\r\n', raw)) raw++
    return raw
}

export function staleCursorCard(): Error {
    return new Error('The card or its settings changed. Open its preview again. / Карточка или её настройки изменились. Откройте предпросмотр заново.')
}

/** Ограничиваем все коллекции записи одним объектом, сохраняя смещения штатного писателя ID. */
export function retainCursorCard(file: AllFile, card: CardPreviewCandidate | undefined, target?: CursorCardTarget): void {
    if (!card || target && (card.identifier !== target.id || card.note.modelName !== target.model || card.note.deckName !== target.deck)) throw staleCursorCard()
    const edited = file.notes_to_edit.filter(item => item.note === card.note && item.identifier === card.identifier)
    const created = file.all_notes_to_add.filter(note => note === card.note)
    if (card.identifier === undefined ? created.length !== 1 || edited.length > 0 : edited.length !== 1 || created.length > 0) throw staleCursorCard()
    file.removeUnsafeNewCards(new Set(file.all_notes_to_add.filter(note => note !== card.note)))
    file.notes_to_edit = edited
    file.notes_to_delete = []
    file.previewCandidates = [card]

    const needed = imageFieldMediaKeys(card.note.fields)
    const sources = new Map<string, string>()
    for (const link of file.formatter.detectedMedia) {
        const key = link.split(/[/\\]/u).pop()?.normalize('NFC').toLowerCase()
        if (!key || !needed.has(key) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(link)) {
            file.formatter.detectedMedia.delete(link)
        } else {
            // Один basename может принадлежать двум файлам хранилища. Не угадываем исходное вложение.
            if (sources.has(key) && sources.get(key) !== link) throw new Error('Ambiguous attachment name: ' + key + ' / Неоднозначное имя вложения.')
            sources.set(key, link)
        }
    }
}
