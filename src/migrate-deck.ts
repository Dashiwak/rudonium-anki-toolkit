// SPDX-License-Identifier: GPL-3.0-only
import { parseYaml } from 'obsidian'
import { frontmatterBounds } from './markdown-pipeline'
import type { MigrationAdapter, MigrationCandidate } from './page-migration-context'

const source = 'deck-to-anki' as const
const fields = ['ob-deck-front', 'ob-deck-back'] as const
const sourceKey = /^(?:deckType|deckID|"deckType"|"deckID"|'deckType'|'deckID')[ \t]*:/mu

/** Only remove scalar ownership properties whose exact source lines can be located.
 * Leave every other property, comment, blank line and line ending in place. */
function removeOwnership(yaml: string, mode: string, id: number | undefined): string | undefined {
    const scalars = /^(?:"(deckType|deckID)"|'(deckType|deckID)'|(deckType|deckID))[ \t]*:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\s]+))([ \t]*(?:#[^\r\n]*)?)(\r?\n|$)/gmu
    const seen = new Set<string>()
    let valid = true
    const other = yaml.replace(scalars, (_line, q1: string, q2: string, bare: string, doubleValue: string,
        singleValue: string, bareValue: string, trailing: string, eol: string) => {
        const key = q1 || q2 || bare
        const value = doubleValue ?? singleValue ?? bareValue
        if (seen.has(key) || value !== (key === 'deckType' ? mode : String(id))) valid = false
        seen.add(key)
        return trailing.trim() ? trailing.trimStart() + eol : ''
    })
    return valid && seen.has('deckType') && seen.has('deckID') === (id !== undefined) && !sourceKey.test(other) ? other : undefined
}

const owns = (object: object, name: string) => Object.prototype.hasOwnProperty.call(object, name)

export const detectDeckToAnki: MigrationAdapter = (path, text, context) => {
    if (context.source && context.source !== 'auto' && context.source !== source) return
    const bounds = frontmatterBounds(text)
    if (!bounds) return
    const yaml = text.slice(bounds.start, bounds.close)
    if (!sourceKey.test(yaml)) return
    const { t } = context
    let id: number | undefined
    const review = (en: string, ru: string): MigrationCandidate => ({ source, status: 'review', id, reason: t(en, ru) })
    if (bounds.close === text.length) return review('Close the YAML properties before importing.', 'Закройте блок свойств YAML перед переносом.')
    let properties: Record<string, unknown>
    try {
        const parsed: unknown = parseYaml(yaml)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        properties = parsed as Record<string, unknown>
    } catch {
        return review('Fix the invalid or duplicate YAML properties.', 'Исправьте ошибки или повторяющиеся свойства YAML.')
    }
    if (!owns(properties, 'deckType') && !owns(properties, 'deckID')) return
    if (owns(properties, 'deckID')) {
        const value = properties.deckID
        const n = typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/u.test(value))
            ? Number(value) : NaN
        if (!Number.isSafeInteger(n) || n <= 0) return review('Check the original Anki note ID in deckID.', 'Проверьте исходный ID записи Anki в deckID.')
        id = n
    }
    const mode = properties.deckType
    if (mode !== 'title' && mode !== 'card') {
        return review('Only an explicit card or title mode identifies a single-file card. Check the original parse mode.',
            'Только явно заданный режим card или title обозначает карточку на весь файл. Проверьте исходный режим.')
    }
    if (owns(properties, 'deckStatus') && properties.deckStatus !== false) {
        return review('Check the archived or unknown deck status before migrating.', 'Проверьте статус архива или неизвестный статус колоды перед переносом.')
    }
    if (properties.deckFile || (owns(properties, 'deckNumbering') && properties.deckNumbering !== false)) {
        return review('Check the source parent deck and numbering before migrating.', 'Проверьте родительскую колоду и нумерацию перед переносом.')
    }
    if (owns(properties, 'deckTemplate') && properties.deckTemplate !== 'ob-deck-basic') {
        return review('Check the source template and its card directions. Automatic import supports the basic template.',
            'Проверьте исходный шаблон и направления карточки. Для автоматического переноса поддерживается базовый шаблон.')
    }
    if (properties.deckName) {
        return review('Check the target deck for this custom deckName before migrating.',
            'Уточните целевую колоду для пользовательского deckName перед переносом.')
    }
    const cleaned = removeOwnership(yaml, mode, id)
    if (cleaned === undefined) return review('The ownership properties use a complex or ambiguous YAML spelling.',
        'Не удалось однозначно выделить служебные свойства в YAML.')
    const afterYaml = bounds.end + (/^\r?\n/u.exec(text.slice(bounds.end))?.[0].length ?? 0)
    const body = text.slice(afterYaml)
    let front: string
    let back: string
    if (mode === 'title') {
        front = (path.split('/').pop() ?? '').replace(/\.md$/iu, '')
        back = body
    } else {
        // A second separator, even in an example, needs a human choice of boundary.
        const separator = /^---[ \t]*(?:\r?\n|$)/gmu
        const split = separator.exec(body)
        if (!split || separator.test(body)) return review('Card mode needs exactly one --- line between its front and back.',
            'В режиме card нужна ровно одна строка --- между вопросом и ответом.')
        front = body.slice(0, split.index).trim()
        back = body.slice(split.index + split[0].length)
    }
    if (!front.trim() || front !== front.trim() || /[\r\n\x00-\x1f]|#anki-page/u.test(front) ||
        /^(?:#{1,6}[ \t]|[-*+>][ \t]|\d+[.)][ \t]|```|~~~|<!--|%%|---$)/u.test(front)) {
        return review('The front must fit on one heading line. Check its Markdown formatting.',
            'Вопрос должен помещаться в одну строку заголовка. Проверьте его разметку.')
    }
    if (!back.trim()) return review('Add or check the answer before importing.', 'Добавьте или проверьте ответ перед переносом.')
    if (/^[ \t]*(?:(?:<!--[ \t]*)?ID[ \t]*:|START(?:I)?[ \t]*$)|<!--\s*(?:anki-bidirectional-tags:|Obsidian-to-Anki pending )/imu.test(body)) {
        return review('Other card markers were found inside this page.', 'Внутри страницы найдены маркеры других карточек.')
    }
    return { source, status: 'candidate', front, back, id, prefix: text.slice(0, bounds.start) + cleaned +
        text.slice(bounds.close, afterYaml), recoveryModel: 'ob-deck-basic', model: id !== undefined && properties.deckTemplate === 'ob-deck-basic' ? 'ob-deck-basic' : undefined,
        fieldNames: id === undefined ? undefined : fields }
}
