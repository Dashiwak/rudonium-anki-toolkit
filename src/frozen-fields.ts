// SPDX-License-Identifier: GPL-3.0-only
import { splitMigrationMarkdown } from './migration-markdown'
import { pageHeading, readPageCard } from './page-card'
import { activeCardMarkdown, archivedCardRanges, archivedCardSource } from './archived-card'
import type { PageCard } from './page-card'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { isBidirectionalFieldName } from './bidirectional-fields'
import { pageFieldIsAvailable } from './page-named-fields'
import type { UiText } from './interface-language'

interface Edit { start: number; end: number; replacement: string; preview: string }
export interface FrozenFields {
    values: ReadonlyMap<string, string>
    preview: string
    replaceAll(entries: ReadonlyArray<readonly [string, string]>): Edit | undefined
    verify(edit: Edit): void
}

function inLiteral(prefix: string): boolean {
    let fence = ''
    let comment = false
    for (const row of prefix.split(/\r?\n/u)) {
        const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(row)
        if (fence) {
            if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = ''
        } else if (mark && !comment) fence = mark[1]
        else {
            for (const token of row.matchAll(/<!--|-->/gu)) comment = token[0] === '<!--'
        }
    }
    return !!fence || comment
}

export function prepareFrozenFields(text: string, marker: string, model: string, fields: readonly string[],
    pattern: RegExp, t: UiText, pageOptions?: { page: PageCard; syntax?: DuplicateMarkerSyntax;
        file?: string; context?: string }): FrozenFields {
    const manual = () => new Error(t('This shared-fields block needs to be edited in Markdown.',
        'Этот блок общих полей нужно отредактировать в Markdown.'))
    const source = splitMigrationMarkdown(text)
    if (!source) throw new Error(t('Close the YAML properties before adding shared fields.',
        'Закройте раздел свойств YAML перед добавлением общих полей.'))
    const active = activeCardMarkdown(text)
    const bodyOffset = source.bom.length + source.yaml.length
    if (active !== text) {
        const [first] = archivedCardRanges(text)
        if (first && !text.slice(bodyOffset, first.start).trim() && pageHeading(archivedCardSource(text, first))) {
            throw new Error(t('This page card is archived. Its shared fields cannot be edited here.',
                'Эта страница-карточка в архиве. Редактирование её общих полей недоступно.'))
        }
    }
    if (pageOptions || pageHeading(active)) {
        const syntax = { ...pageOptions?.syntax, ['Frozen Fields Line']: marker }
        const page = pageOptions?.page ?? readPageCard(text, {}, syntax, model)
        if (!page || page.model !== model || !marker.trim() || /[\r\n]/u.test(marker + model)) throw manual()
        const section = page.sharedFields
        const values = section?.values ?? new Map<string, string>()
        const start = section?.start ?? page.backStart
        const end = section?.after ?? start
        const available = (name: string) => isBidirectionalFieldName(name) && !page.namedFields?.has(name) &&
            pageFieldIsAvailable(name, page, fields, pageOptions ?? {})
        for (const name of values.keys()) if (!available(name)) throw manual()
        const prior = section ? text.slice(start, section.end) : ''
        return {
            values, preview: prior,
            replaceAll(entries) {
                if (new Set(entries.map(([name]) => name)).size !== entries.length) throw manual()
                const lines = entries.map(([name, value]) => {
                    if (!available(name) || !value.trim() || /[\r\n]/u.test(value)) throw manual()
                    if (values.get(name) === value) {
                        const original = prior.split(page.eol).slice(1).find(row => row.startsWith(name + ':'))
                        if (original !== undefined) return original
                    }
                    return name + ': ' + value
                })
                const preview = lines.length ? [marker + ' - ' + model + ':', ...lines].join(page.eol) : ''
                if (preview === prior) return
                return { start, end, preview, replacement: preview ? preview + page.eol + page.eol : '' }
            },
            verify(edit) {
                const next = readPageCard(text.slice(0, start) + edit.replacement + text.slice(end), {}, syntax, model)
                if (!next || next.id !== page.id || next.front !== page.front || next.back !== page.back ||
                    next.model !== page.model || next.idLocation !== page.idLocation ||
                    (next.sharedFields ? next.sharedFields.values.size : 0) !== Math.max(0, edit.preview.split(page.eol).length - 1))
                    throw manual()
            },
        }
    }
    if (!marker.trim() || !model || /[\r\n]/u.test(marker + model)) throw manual()
    const header = marker + ' - ' + model + ':'
    const fieldText = (str: string) => str.replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
    const matches = (str: string) => Array.from(str.matchAll(
        new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))).filter(m => m[1] === model)
    const seen = matches(active)
    const locations = Array.from(active.matchAll(/[^\r\n]+/gu)).filter(match => match[0].trim() === header.trim())
    if (seen.length > 1 || locations.length > 1) throw new Error(t(
        'This note contains multiple shared-fields blocks for this type. Combine them in Markdown first.',
        'В заметке несколько блоков общих полей этого типа. Сначала объедините их в Markdown.'))
    if (seen.length !== locations.length) throw manual()
    const exists = seen.length === 1
    const { eol } = source
    const preamble = !!(source.bom || source.yaml)
    const insertion = bodyOffset + (preamble && source.body.startsWith(eol) ? eol.length : 0)
    const start = exists ? locations[0].index : insertion
    const body = exists ? fieldText(seen[0][2]) : ''
    const rows = body ? body.split('\n') : []
    const original = [header, ...rows].join(eol)
    if (exists && (start < bodyOffset || !text.startsWith(original, start) ||
        inLiteral(active.slice(bodyOffset, start)))) throw manual()
    const values = new Map<string, string>()
    const indexes = new Map<string, number>()
    for (const [i, row] of rows.entries()) {
        const names = fields.filter(name => row.startsWith(name + ':'))
        if (names.length !== 1 || values.has(names[0])) throw manual()
        const name = names[0]
        indexes.set(name, i)
        values.set(name, row.slice(name.length + 1).replace(/^ /u, ''))
    }
    return {
        values,
        preview: exists ? original : '',
        replaceAll(entries) {
            const chosen = new Set<string>()
            const updated = entries.map(([field, value]) => {
                if (!fields.includes(field) || !field || chosen.has(field) || /[\r\n]/u.test(field + value)) throw manual()
                chosen.add(field)
                const index = indexes.get(field)
                if (index !== undefined && values.get(field) === value) return rows[index]
                if (!value.trim()) throw new Error(t('Enter a value or remove the field.', 'Введите значение или уберите поле.'))
                return field + ': ' + value
            })
            const preview = updated.length ? [header, ...updated].join(eol) : ''
            if (exists ? preview === original : !preview) return
            // The configured export parser must recognise exactly the proposed fields. Otherwise leave the note intact.
            if (preview) {
                const parsed = matches(preview + eol + eol)
                if (parsed.length !== 1 || fieldText(parsed[0][2]) !== updated.join('\n')) throw manual()
            }
            // Insert before ordinary note content so an unfinished code fence at EOF cannot hide the directive.
            let prefix = ''
            if (!exists && preamble && start === bodyOffset) prefix = source.yaml && !source.yaml.endsWith('\n') ? eol + eol : eol
            let end = exists ? start + original.length : start
            if (exists && !preview && text.startsWith(eol + eol, end)) end += 2 * eol.length
            return { start, end, preview, replacement: exists ? preview : prefix + preview + eol + eol }
        },
        verify(edit) {
            const after = matches(activeCardMarkdown(text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)))
            const expected = edit.preview.split(eol).slice(1).join('\n')
            if (after.length !== (edit.preview ? 1 : 0) ||
                (expected && fieldText(after[0][2]) !== expected)) throw manual()
        },
    }
}
