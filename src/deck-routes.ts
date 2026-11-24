/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'

export interface DeckRouteOrigin {
    origin: 'note' | 'folder' | 'forced-default' | 'default' | 'profile-rule'
    folder?: string
    rule?: string
}

export function parentFolderPath(path: string): string {
    const separator = path.lastIndexOf('/')
    return separator < 0 ? '' : path.slice(0, separator)
}

export function resolveFolderDeck(folderPath: string, fallback: string, decks?: Readonly<Record<string, string>>,
    defaults?: Readonly<Record<string, boolean>>): DeckRouteOrigin & { deck: string } {
    for (let folder = folderPath; folder; folder = parentFolderPath(folder)) {
        if (defaults && Object.prototype.hasOwnProperty.call(defaults, folder) && defaults[folder] === true) {
            return { deck: fallback, origin: 'forced-default', folder }
        }
        if (decks && Object.prototype.hasOwnProperty.call(decks, folder)) {
            const deck = decks[folder]
            if (typeof deck === 'string' && deck.trim()) return { deck, origin: 'folder', folder }
        }
    }
    return { deck: fallback, origin: 'default' }
}

export function describeDeckRoute(route: DeckRouteOrigin, t: UiText = englishUi): string {
    switch (route.origin) {
    case 'note': return t('Destination set in this note', 'Колода задана в заметке')
    case 'folder': return route.folder ? t(`Folder rule · ${route.folder}`, `Правило папки · ${route.folder}`)
        : t('Folder rule', 'Правило папки')
    case 'forced-default': return route.folder ? t(`Default deck selected for ${route.folder}`, `Колода по умолчанию для папки ${route.folder}`)
        : t('Default deck selected for this folder', 'Для папки выбрана колода по умолчанию')
    case 'default': return t('Default deck setting', 'Колода по умолчанию')
        case 'profile-rule': return route.rule ? t(`Export rule · ${route.rule}`, `Правило экспорта · ${route.rule}`)
            : t('Profile export rule', 'Правило экспорта профиля')
    }
}
