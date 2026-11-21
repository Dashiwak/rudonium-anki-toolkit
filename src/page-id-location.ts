// SPDX-License-Identifier: GPL-3.0-only
import type { UiText } from './interface-language'

export type PageIdLocation = 'yaml' | 'heading' | 'after-answer'
export const pageIdLocations: readonly PageIdLocation[] = ['yaml', 'heading', 'after-answer']

/** Only an explicitly stored choice overrides the default for new page links. */
export function pageIdLocation(value: unknown): PageIdLocation {
    return value === 'heading' || value === 'after-answer' ? value : 'yaml'
}

export function pageIdLocationLabel(value: PageIdLocation, t: UiText): string {
    if (value === 'heading') return t('Under the heading', 'Под заголовком')
    if (value === 'after-answer') return t('After the answer', 'После ответа')
    return t('In properties (YAML)', 'В свойствах (YAML)')
}
