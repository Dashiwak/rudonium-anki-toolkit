// SPDX-License-Identifier: GPL-3.0-only
import { pageFooterMarker, parseAnkiIdMarker } from './anki-id-marker'
import { insertPageFooterId, readPageCard } from './page-card'
import { insertPageYamlId, pageControlStart, pageHeading, pageLifecycleSlot, pageYamlId } from './page-frontmatter'
import type { PageIdLocation } from './page-id-location'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import type { UiText } from './interface-language'

function annotation(t: UiText): Error {
    return new Error(t('The ID line has an annotation. Move it to a separate property or line first.',
        'В строке ID есть примечание. Сначала перенесите его в отдельное свойство или строку.'))
}

/** Read the date only when every character of the old marker can be accounted for. */
function movableDate(text: string, from: PageIdLocation, start: number, end: number, id: number, t: UiText): string | undefined {
    const row = text.slice(start, end)
    if (from === 'yaml') {
        const field = pageYamlId(text)
        if (!field || field.id !== id) throw annotation(t)
        const tail = text.slice(field.digitsEnd, field.end)
        const match = /^['"]?[ \t]*(?:#[ \t]*\|[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*)?$/u.exec(tail)
        if (!match || (match[1] && parseAnkiIdMarker('ID: ' + id + ' | ' + match[1])?.date !== match[1])) throw annotation(t)
        return match[1]
    }
    const marker = from === 'after-answer' ? pageFooterMarker(row) : parseAnkiIdMarker(row)
    if (!marker || marker.id !== id || marker.digits !== String(id) || row.slice(marker.to).trim()) throw annotation(t)
    const contents = from === 'after-answer' ? marker.inner.replace(/[ \t]+@page[ \t]*$/u, '') : marker.inner
    const standard = /^[ \t]*ID:[ \t]*\d+(?:[ \t]*(?:\|[ \t]*)?(\d{4}-\d{2}-\d{2}))?[ \t]*$/u.exec(contents)
    if (!standard || standard[1] !== marker.date) throw annotation(t)
    return marker.date
}

/** Move only the link in a recognized page; the conversion can run without Anki. */
export function movePageId(text: string, location: PageIdLocation, comment: boolean,
    syntax: DuplicateMarkerSyntax | undefined, t: UiText): string {
    if (text.includes('<!-- Obsidian-to-Anki pending ')) throw new Error(t(
        'Finish the pending export before moving the ID.', 'Завершите незаконченный экспорт перед переносом ID.'))
    const rules = { Rudonium: '@page' }
    const page = readPageCard(text, rules, syntax)
    if (!page || page.id === undefined || page.idStart === undefined || page.idEnd === undefined || !page.idLocation) throw new Error(t(
        'Open a linked page marked #anki-page.', 'Откройте связанную страницу с меткой #anki-page.'))
    if (page.idLocation === location) return text
    const date = movableDate(text, page.idLocation, page.idStart, page.idEnd, page.id, t)
    const eol = /^\r?\n/u.exec(text.slice(page.idEnd))?.[0] ?? ''
    let start = page.idStart
    if (page.idLocation === 'after-answer' && start > 0) {
        // Remove the footer's separating line break, preserving all original trailing whitespace.
        start -= /\r?\n$/u.exec(text.slice(0, start))?.[0].length ?? 0
    }
    const clean = text.slice(0, start) + text.slice(page.idEnd + (page.idLocation === 'after-answer' ? 0 : eol.length))
    const head = pageHeading(clean)
    if (!head) throw new Error(t('The page heading changed.', 'Заголовок страницы изменился.'))
    const below = pageControlStart(clean, head.start + head.heading[0].length, head.tags)
    const slot = pageLifecycleSlot(clean, below, head.tags, syntax)
    if (slot.command === 'delete') throw new Error(t(
        'Resolve the page deletion before moving its ID.', 'Завершите обработку удаления страницы перед переносом ID.'))
    let changed: string
    if (location === 'yaml') changed = insertPageYamlId(clean, page.id, date)
    else if (location === 'after-answer') changed = insertPageFooterId(clean, page.id, date)
    else {
        const insertion = slot.next
        const marker = 'ID: ' + page.id + (date ? ' | ' + date : '')
        changed = clean.slice(0, insertion) + (comment ? '<!--' + marker + '-->' : marker) + page.eol + clean.slice(insertion)
    }
    const verified = readPageCard(changed, rules, syntax)
    if (!verified || verified.id !== page.id || verified.idLocation !== location || verified.front !== page.front ||
        verified.back !== page.back || verified.namedFields?.size !== page.namedFields?.size ||
        (page.namedFields && [...page.namedFields].some(([name, span]) => verified.namedFields?.get(name)?.value !== span.value)) ||
        JSON.stringify(verified.linkedRoute) !== JSON.stringify(page.linkedRoute) ||
        JSON.stringify(verified.fieldPair) !== JSON.stringify(page.fieldPair) ||
        (page.answerBoundary !== undefined && (verified.answerBoundary === undefined ||
            text.slice(page.answerBoundary) !== changed.slice(verified.answerBoundary)))) throw new Error(t(
        'Could not preserve this page link and its fields.', 'Не удалось сохранить связь и поля этой страницы.'))
    return changed
}
