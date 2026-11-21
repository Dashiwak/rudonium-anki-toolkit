// SPDX-License-Identifier: GPL-3.0-only
import { explicitFieldLabel, isBidirectionalFieldName } from './bidirectional-fields'
import type { ExplicitFieldSpan } from './bidirectional-blocks'
import type { PageCard } from './page-card'
import { pageDirective, pageTagOffsets } from './id-marker-literals'
import { pageTextSpan } from './page-frontmatter'

export const pageFieldsMarker = '<!--anki-fields-->'
const reservedPageNames = new Set(['id', 'anki id', 'tags', 'file', 'context', 'front', 'back', '__proto__', 'constructor', 'prototype'])

function pageFieldLabel(line: string): RegExpExecArray | null {
    // Markdown quotations, headings, lists and bare URLs can continue a multiline value.
    if (/^(?:>|#{1,6}[ \t]|(?:[*+-]|\d+[.)])[ \t]|[\w+.-]+:\/\/)/u.test(line)) return null
    return explicitFieldLabel.exec(line)
}

/** Opt-in only. A colon in an existing page answer remains ordinary Markdown. */
export function readPageNamedFields(text: string, from: number, until: number, markerOffsets?: readonly number[]):
    { answerEnd: number; fields: ReadonlyMap<string, ExplicitFieldSpan> } | undefined {
    const firstMarker = text.indexOf(pageFieldsMarker, from)
    if (firstMarker < 0 || firstMarker >= until) return
    const fields = new Map<string, ExplicitFieldSpan>()
    let open: { name: string; start: number; space: boolean } | undefined
    let firstLabel: number | undefined
    const finish = (end: number) => {
        if (!open) return
        const raw = text.slice(open.start, end)
        const clean = raw.trim()
        const start = clean ? open.start + raw.length - raw.trimStart().length : open.start
        const last = clean ? open.start + raw.trimEnd().length : start
        const span = pageTextSpan(text, start, last, markerOffsets)
        fields.set(open.name, { ...span, spaceWhenFilled: !span.value && !open.space })
    }
    const marker = pageDirective(text, pageFieldsMarker, from, until, (start, line) => {
        const label = pageFieldLabel(line)
        if (!label) return
        finish(start)
        const name = label[1]
        if (name.trim() !== name || reservedPageNames.has(name.toLowerCase()))
            throw new Error('Reserved page field / Зарезервированное поле страницы: ' + name)
        if (fields.has(name)) throw new Error('Repeated page field / Поле страницы повторяется: ' + name)
        firstLabel ??= start
        open = { name, start: start + name.length + 1 + label[2].length, space: Boolean(label[2]) }
    })
    if (marker === undefined) return
    finish(until)
    if (pageTextSpan(text, marker + pageFieldsMarker.length, firstLabel ?? until, markerOffsets).value.trim()) {
        throw new Error('Start the additional fields section with a field name and a colon. / Начните раздел дополнительных полей с названия поля и двоеточия.')
    }
    const answer = text.slice(from, marker).replace(/(?:\r?\n[ \t]*)+$/u, '')
    if (!answer.trim()) throw new Error('Write an answer above the additional fields. / Напишите ответ перед дополнительными полями.')
    return { answerEnd: from + answer.length, fields }
}

interface PageFieldSettings {
    file?: string
    context?: string
    addFile: boolean
    addContext: boolean
}

type PageFieldLayout = Pick<PageCard, 'fieldPair' | 'linkedRoute'>

function linkedServiceField(name: string, page: PageFieldLayout, names: readonly string[]): boolean {
    return Boolean(page.fieldPair || page.linkedRoute) && !page.fieldPair?.includes(name) &&
        (Boolean(page.fieldPair) && name === names[0] || name.startsWith('ob-deck-') || name === 'ForgeKey' || name === 'CardKey')
}

/** Shared by the exporter, the field picker and diagnostics. A label must round-trip as Markdown. */
export function pageFieldIsAvailable(name: string, page: PageFieldLayout, names: readonly string[],
    settings: Pick<PageFieldSettings, 'file' | 'context'>): boolean {
    const pair = page.fieldPair ?? names.slice(0, 2)
    return names.includes(name) && !pair.includes(name) && name !== settings.file && name !== settings.context &&
        name.trim() === name && !reservedPageNames.has(name.toLowerCase()) && !linkedServiceField(name, page, names) &&
        pageFieldLabel(name + ': ')?.[1] === name && (!name.includes('#') || pageTagOffsets(name + ': ').length === 0)
}

/** Only invoked on a typo. Keep canonical Anki spelling in diagnostics. */
function spellingDistance(left: readonly string[], right: readonly string[]): number {
    let previous = Array.from({ length: right.length + 1 }, (_, column) => column)
    let next = new Array<number>(right.length + 1)
    for (let row = 1; row <= left.length; row++) {
        next[0] = row
        for (let column = 1; column <= right.length; column++) {
            const substitution = previous[column - 1] + Number(left[row - 1] !== right[column - 1])
            next[column] = Math.min(substitution, previous[column] + 1, next[column - 1] + 1)
        }
        const swap = previous
        previous = next
        next = swap
    }
    return previous[right.length]
}

function unknownPageField(name: string, page: PageCard, names: readonly string[], settings: PageFieldSettings): Error {
    const letters = (label: string) => Array.from(label.normalize('NFC').toLowerCase())
    const input = letters(name)
    const choices = names.filter(field => !page.namedFields?.has(field) && pageFieldIsAvailable(field, page, names, settings))
    const ranked = choices.map(field => ({ field, distance: spellingDistance(input, letters(field)) }))
        .sort((a, b) => a.distance - b.distance)
    const options = ranked.slice(0, 5).map(item => item.field).join(', ') + (ranked.length > 5 ? '…' : '')
    const english = `Unknown field “${name}” in “${page.model}”. ` +
        (options ? 'Available fields: ' + options : 'No unused additional fields are available.')
    const russian = `В типе записи «${page.model}» нет поля «${name}». ` +
        (options ? 'Доступные поля: ' + options : 'Свободных дополнительных полей нет.')
    return new Error(english + ' / ' + russian)
}

/** Choose only user-authored, generated or configured frozen values for an existing note. */
export function pageExportFieldNames(page: PageCard, names: readonly string[], settings: PageFieldSettings,
    frozen?: Readonly<Record<string, string>>) {
    const pair = page.fieldPair ?? names.slice(0, 2)
    if (pair.length !== 2 || pair[0] === pair[1] || pair.some(name => !names.includes(name)))
        throw new Error('Verify the two page fields in Anki. / Проверьте два основных поля страницы в Anki.')
    const authored = [...pair]
    for (const name of page.namedFields?.keys() ?? []) {
        if (!names.includes(name)) throw unknownPageField(name, page, names, settings)
        if (!pageFieldIsAvailable(name, page, names, settings)) throw new Error('This page field is filled automatically or is reserved / Это поле страницы заполняется автоматически или зарезервировано: ' + name)
        authored.push(name)
    }
    for (const name of page.sharedFields?.values.keys() ?? []) {
        if (!names.includes(name)) throw unknownPageField(name, page, names, settings)
        if (!isBidirectionalFieldName(name) || !pageFieldIsAvailable(name, page, names, settings) || page.namedFields?.has(name))
            throw new Error('Choose one editable additional field per shared value. Remove a duplicate label or change the field: / Выберите отдельное дополнительное поле для общего значения. Уберите повторное объявление или смените поле: ' + name)
        authored.push(name)
    }
    const available = (name: string | undefined) => !!name && names.includes(name) && (pair.includes(name) || !linkedServiceField(name, page, names))
    const file = settings.addFile && available(settings.file) ? settings.file : undefined
    const context = settings.addContext && available(settings.context) ? settings.context : undefined
    const selected = new Set(authored)
    if (file) selected.add(file)
    if (context) selected.add(context)
    for (const name of names) {
        if (!page.linkedRoute && !page.fieldPair && (page.id === undefined || frozen?.[name])) selected.add(name)
    }
    return { authored, selected: [...selected], file, context }
}

export interface PageSharedFields {
    start: number
    end: number
    after: number
    values: ReadonlyMap<string, string>
}

/** Only the public preamble immediately before the answer can define page-wide values. */
export function readPageSharedFields(text: string, at: number, limit: number, marker: string, model: string, tagOffsets?: readonly number[]): PageSharedFields | undefined {
    if (!marker) return
    const blanks = /(?:[ \t]*\r?\n)*/uy
    blanks.lastIndex = at
    const start = at + blanks.exec(text)![0].length
    if (start >= limit || !text.startsWith(marker + ' - ', start)) return
    const header = marker + ' - ' + model + ':'
    const line = /([^\r\n]*)(\r?\n|$)/uy
    line.lastIndex = start
    const head = line.exec(text)!
    if (head[1] !== header || !head[2]) throw new Error(
        'Use the page note type in the shared-fields header. / Укажите в заголовке общих полей тип записи этой страницы.')
    let end = start + head[1].length
    const values = new Map<string, string>()
    while (line.lastIndex < limit) {
        const pos = line.lastIndex
        const row = line.exec(text)
        if (!row || line.lastIndex > limit) break
        if (!row[1].trim() && row[2] && values.size) return { start, end, after: line.lastIndex, values }
        const labeled = explicitFieldLabel.exec(row[1])
        if (!labeled || !labeled[3].trim() || labeled[1] !== labeled[1].trim() ||
            values.has(labeled[1]) || !row[2]) break
        end = pos + row[1].length
        const value = pageTextSpan(text, end - labeled[3].length, end, tagOffsets).value.trim()
        if (!value) break
        values.set(labeled[1], value)
    }
    throw new Error('Write one named shared field per line and leave a blank line before the answer. / Запишите каждое общее поле отдельной строкой и оставьте пустую строку перед ответом.')
}
