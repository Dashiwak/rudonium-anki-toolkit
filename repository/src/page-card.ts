/*! SPDX-License-Identifier: GPL-3.0-only */
import { pageExportFieldNames, pageFieldIsAvailable, readPageNamedFields, readPageSharedFields } from './page-named-fields'
import { pageHeading, pageControlStart, pageLifecycleSlot, pageTextSpan, hasPageYamlIdText, mayHavePageTag, pageYamlId, unclaimedPageYamlId, insertPageYamlId } from './page-frontmatter'
export { validatePageYamlPlacement, pageContentTags } from './page-frontmatter'
export { pageHeading }
import { isBidirectionalFieldName } from './bidirectional-fields'
import { readDelimitedRule } from './delimited-rule'
import { activeCardMarkdown } from './archived-card'
import { currentCardExpression, cardFormatPresets, hasLinkedAnswerSlot, linkedCardPattern, knowledgeBulletExpression, pageCardExpression } from './card-format-presets'
import type { PageSharedFields } from './page-named-fields'
import { readSuspendLine } from './suspend-label'
import { looksLikeAnkiIdMarker, pageFooterId, pageFooterMarker, parseAnkiIdMarker } from './anki-id-marker'
import { findPageAnswerBoundary } from './id-marker-literals'
export { pageExportFieldNames }
import { readRecoveryMarker } from './export-recovery'
import { maskLegacyFieldSections } from './legacy-field-sections'
import { findIdMarkers } from './duplicate-markers'
import type { BidirectionalBlock, ExplicitFieldSpan } from './bidirectional-blocks'
import type { DuplicateMarkerSyntax } from './duplicate-markers'

export const deckPageLayoutMarker = '<!--rudonium-page-layout: deck-to-anki-->'
/** Use the first heading itself for a page card, even when Obsidian's heading cache is stale. */
export function pageSourceContext(path: string, question: string): string {
    const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    return escape(path) + ' > ' + escape(question)
}
const deckPageFields = ['ob-deck-front', 'ob-deck-back'] as const

export function isDeckPageSchema(model: string, names: readonly string[] | undefined): boolean {
    return model === 'ob-deck-basic' && names?.[0] === 'ob-deck-id' && deckPageFields.every(name => names.includes(name))
}

type FieldPair = readonly [string, string]
const linkedLayouts = [
    { fields: ['Front', 'Back'], marker: '<!--rudonium-page-layout: linked-front-back-->' },
    { fields: ['Question', 'Answer'], marker: '<!--rudonium-page-layout: linked-question-answer-->' },
] as const

function namedFields(names: readonly string[] | undefined): FieldPair | undefined {
    if (!names) return
    const layouts = linkedLayouts.filter(({ fields }) => fields.every(name => names.includes(name)))
    if (layouts.length === 1 && new Set(names).size === names.length) return layouts[0].fields
}

/** These adapters can migrate records whose actual first Anki field is an integration key. */
export function sourcePageFields(source: string, names: readonly string[]): FieldPair | undefined {
    if (source === 'anki-forge' || source === 'anki-bridge') return namedFields(names)
}

export function sourcePageLayoutMarker(source: string, fields?: FieldPair): string | undefined {
    if (!fields || !sourcePageFields(source, fields)) return
    return linkedLayouts.find(layout => layout.fields[0] === fields[0] && layout.fields[1] === fields[1])?.marker
}

export function isLinkedPageSchema(model: string, names: readonly string[] | undefined, pair: FieldPair): boolean {
    if (pair[0] === deckPageFields[0]) return pair[1] === deckPageFields[1] && isDeckPageSchema(model, names)
    const fields = namedFields(names)
    return !!fields && model !== 'ob-deck-basic' && fields[0] === pair[0] && fields[1] === pair[1]
}

/** If a route's layout line disappears, do not overwrite the service field with the question. */
export function needsLinkedPageLayout(names: readonly string[]): boolean {
    return linkedLayouts.some(({ fields: [front, back] }) =>
        names.includes(front) && names.includes(back) && (names[0] !== front || names[1] !== back))
}

export interface LinkedPageRoute { model: string; deck: string }
const routePrefix = '<!--rudonium-page-route: '
function validRouteName(value: unknown): value is string {
    return typeof value === 'string' && value.trim() === value && !!value && !/[\u0000-\u001f\u007f]/u.test(value)
}
export function linkedPageRouteMarker(route: LinkedPageRoute): string {
    if (!validRouteName(route.model) || !validRouteName(route.deck)) throw new Error('Invalid Anki model or deck name.')
    return routePrefix + JSON.stringify([route.model, route.deck]).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e') + '-->'
}

export interface PageCard {
    linkedRoute?: LinkedPageRoute
    fieldPair?: readonly [string, string]
    model: string
    start: number
    end: number
    front: string
    frontStart: number
    frontSpan?: ExplicitFieldSpan
    backSpan?: ExplicitFieldSpan
    sharedFields?: PageSharedFields
    namedFields?: ReadonlyMap<string, ExplicitFieldSpan>
    pageFieldSyntax?: DuplicateMarkerSyntax
    markerOffsets?: readonly number[]
    back: string
    backStart: number
    backEnd: number
    answerBoundary?: number
    insertion: number
    line: number
    endLine: number
    id?: number
    idStart?: number
    unlinkedControl?: boolean
    idLocation?: 'heading' | 'yaml' | 'after-answer'
    tagAnchor?: number
    idEnd?: number
    eol: string
}

function lineAt(text: string, offset: number): number {
    let n = 1
    for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++
    return n
}

/** A marked H1 must be the first content after properties. One file owns at most one page card. */
export function readPageCard(text: string, expressions: Readonly<Record<string, string>>,
    syntax?: DuplicateMarkerSyntax, defaultPageModel?: string): PageCard | undefined {
    const archived = text.includes('RUDONIUM-ARCHIVE')
    if (archived) text = activeCardMarkdown(text)
    if (!mayHavePageTag(text) && !hasPageYamlIdText(text) && !text.includes('@page')) return
    // A page tag in a regex card's field value cannot own the enclosing file.
    if (maskLegacyFieldSections(text) !== text) return
    const footer = pageFooterId(text)
    const models = Object.keys(expressions).filter(name => expressions[name] === pageCardExpression)
    if (!models.length && defaultPageModel) models.push(defaultPageModel)
    const linkedLayout = text.includes('<!--rudonium-page-route:') || text.includes('<!--rudonium-page-layout:')
    if (!models.length && !linkedLayout && !footer && !hasPageYamlIdText(text)) return
    const location = pageHeading(text, !archived)
    if (!location) {
        if (unclaimedPageYamlId(text)) throw new Error('Restore the #anki-page tag to use the saved Anki ID. / Верните метку #anki-page на страницу с сохранённым ID Anki.')
        return
    }
    const { start, heading, tags } = location
    const answerBoundary = findPageAnswerBoundary(text, start + heading[0].length)
    const active = answerBoundary === undefined ? text : text.slice(0, answerBoundary)
    const property = pageYamlId(text, location)
    if (!models.length && !property && !footer && !active.includes('<!--rudonium-page-route:') && !active.includes('<!--rudonium-page-layout:')) return
    const pending = readRecoveryMarker(text)
    if (pending) {
        // Journals normally sit at EOF. Another placement cannot preserve all field offsets.
        if (!text.startsWith(pending.clean) || !/^\r?\n\r?\n<!-- Obsidian-to-Anki pending [a-f0-9]{32} -->(?:\r?\n)?$/u.test(text.slice(pending.clean.length))) {
            throw new Error('Finish the pending export before previewing this page.')
        }
        text = pending.clean
    }
    if (models.length !== 1) throw new Error('Choose one Anki note type for @page. / Выберите один тип записи Anki для @page.')
    const eol = heading[3] || '\n'
    const slot = pageLifecycleSlot(text, pageControlStart(text, start + heading[0].length, tags), tags, syntax)
    const insertion = slot.next
    const first = /^[^\r\n]*/u.exec(text.slice(insertion))![0]
    const marker = parseAnkiIdMarker(first)
    if (!marker && looksLikeAnkiIdMarker(first)) throw new Error('Invalid page ID under the heading. / Ошибка в строке ID под заголовком.')
    const detached = property ?? footer
    if (property && footer || detached && marker) throw new Error('Keep exactly one page ID. / Оставьте только один ID страницы.')
    if (active.includes('ID:')) {
        const otherIds = findIdMarkers(active, syntax).filter(item => item.location !== 'yaml')
        const bodyId = marker?.id ?? footer?.id
        if (otherIds.length !== (bodyId === undefined ? 0 : 1) || (bodyId !== undefined && otherIds[0]?.id !== bodyId)) {
            throw new Error('A page card can have only one Anki ID. Move other linked cards to another note. / У страницы может быть только один ID Anki. Перенесите другие связанные карточки в отдельную заметку.')
        }
    }
    let after = insertion
    const idEnd = detached?.end ?? (marker ? insertion + first.length : undefined)
    let tagAnchor = idEnd
    const control = slot.command !== undefined
    if (detached) {
        after = slot.next
        tagAnchor = control ? slot.tail : detached.headingEnd
    } else if (idEnd !== undefined) {
        after = idEnd + (/^\r?\n/u.exec(text.slice(idEnd))?.[0].length ?? 0)
    }
    if (idEnd !== undefined) {
        // A per-card tag override is managed by the two-way sync and stays outside the answer.
        const tags = /^([ \t]*<!-- anki-bidirectional-tags:[^\r\n]*-->[ \t]*)(?:\r?\n|$)/u.exec(text.slice(after))
        if (tags) after += tags[0].length
    }
    let linkedRoute: LinkedPageRoute | undefined
    if (active.includes('<!--rudonium-page-route:')) {
        const line = text.slice(after).split(/\r?\n/u, 1)[0]
        if (!(marker || detached) || !line.startsWith(routePrefix) || !line.endsWith('-->') ||
            active.indexOf('<!--rudonium-page-route:') !== after || active.indexOf('<!--rudonium-page-route:', after + line.length) >= 0) {
            throw new Error('Verify the saved model and deck below the page ID. / Проверьте тип и колоду под ID страницы.')
        }
        const route: unknown = JSON.parse(line.slice(routePrefix.length, -3))
        if (!Array.isArray(route) || route.length !== 2 || !validRouteName(route[0]) || !validRouteName(route[1])) {
            throw new Error('Invalid saved Anki model or deck. / Некорректный тип записи или колода Anki.')
        }
        linkedRoute = { model: route[0], deck: route[1] }
        after += line.length
        after += /^\r?\n/u.exec(text.slice(after))?.[0].length ?? 0
    }
    let fieldPair: PageCard['fieldPair']
    if (active.includes('<!--rudonium-page-layout:')) {
        const layout = text.slice(after).split(/\r?\n/u, 1)[0]
        const named = linkedRoute && linkedLayouts.find(entry => entry.marker === layout)
        if (!(marker || detached) || (layout !== deckPageLayoutMarker && !named) || active.indexOf('<!--rudonium-page-layout:') !== after ||
            active.indexOf('<!--rudonium-page-layout:', after + layout.length) !== -1) {
            throw new Error('Verify the linked page layout marker below the ID. / Проверьте маркер формата под ID страницы.')
        }
        fieldPair = named ? named.fields : deckPageFields
        after += layout.length
        after += /^\r?\n/u.exec(text.slice(after))?.[0].length ?? 0
    }
    const answerEnd = footer?.start ?? answerBoundary
    const sharedFields = readPageSharedFields(text, after, answerEnd ?? text.length,
        syntax?.['Frozen Fields Line'] ?? 'FROZEN', linkedRoute?.model ?? models[0], tags)
    if (sharedFields) after = sharedFields.after
    const body = text.slice(after, answerEnd)
    const backStart = after + (/^(?:[ \t]*\r?\n)*/u.exec(body)?.[0].length ?? 0)
    const end = backStart + text.slice(backStart, answerEnd).replace(/(?:\r?\n[ \t]*)+$/u, '').length
    const named = readPageNamedFields(text, backStart, end, tags)
    const frontStart = start + heading[1].length
    const frontSpan = pageTextSpan(text, frontStart, frontStart + heading[2].length, tags)
    const backSpan = pageTextSpan(text, backStart, named?.answerEnd ?? end, tags)
    if (!frontSpan.value.trim()) throw new Error('Add a question to the first heading. / Добавьте вопрос в первый заголовок.')
    if (!backSpan.value.trim()) throw new Error('Add an answer below the page heading. / Добавьте ответ под заголовком страницы.')
    return { model: linkedRoute?.model ?? models[0], linkedRoute, start, end: text.length, front: frontSpan.value, frontStart: frontSpan.start,
        back: backSpan.value, fieldPair, sharedFields, backStart: backSpan.start, backEnd: backSpan.end, frontSpan, backSpan, namedFields: named?.fields,
        markerOffsets: tags, pageFieldSyntax: syntax, insertion, id: detached?.id ?? marker?.id, idEnd, tagAnchor,
        idStart: detached?.start ?? (marker && insertion), idLocation: property ? 'yaml' : footer ? 'after-answer' : marker ? 'heading' : undefined,
        unlinkedControl: !detached && !marker && control, answerBoundary, line: lineAt(text, start), endLine: lineAt(text, end), eol }
}

export function insertPageFooterId(text: string, id: number, date?: string): string {
    const pending = readRecoveryMarker(text)
    if (pending) {
        if (!text.startsWith(pending.clean) || !/^\r?\n\r?\n<!-- Obsidian-to-Anki pending [a-f0-9]{32} -->(?:\r?\n)?$/u.test(text.slice(pending.clean.length))) {
            throw new Error('Finish the pending export before placing the page ID. / Завершите незаконченный экспорт перед размещением ID.')
        }
        return insertPageFooterId(pending.clean, id, date) + text.slice(pending.clean.length)
    }
    const head = pageHeading(text)
    if (!head || !Number.isSafeInteger(id) || id <= 0 || findIdMarkers(text).length || pageYamlId(text) || pageFooterId(text)) {
        throw new Error('Cannot insert another page ID. / Невозможно добавить ID страницы.')
    }
    const marker = '<!--ID: ' + id + (date ? ' | ' + date : '') + ' @page-->'
    if (!pageFooterMarker(marker)) throw new Error('Invalid page ID or date. / Некорректный ID или дата страницы.')
    const from = head.start + head.heading[0].length
    const boundary = findPageAnswerBoundary(text, from)
    const publicPart = text.slice(from, boundary).replace(/(?:\r?\n[ \t]*)+$/u, '')
    const at = from + publicPart.length
    const next = text.slice(0, at) + (head.heading[3] || '\n') + marker + text.slice(at)
    if (!publicPart.trim() || pageFooterId(next)?.id !== id) throw new Error(
        'Close the Markdown block at the end of the answer before placing its ID. / Завершите блок Markdown в конце ответа перед размещением ID.')
    return next
}

export function writePageId(text: string, page: PageCard, id: number, comment: boolean, date?: string, placement?: string): string {
    if (page.id !== undefined || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid new page ID.')
    const footer = pageFooterId(text)
    if (footer) {
        const claims = findIdMarkers(text)
        if (footer.id === id && claims.length === 1 && claims[0].id === id && !pageYamlId(text)) return text
        throw new Error('The page ID changed before it could be saved.')
    }
    const already = pageYamlId(text)
    if (already) {
        if (already.id === id && !findIdMarkers(text).some(marker => marker.location !== 'yaml')) return text
        throw new Error('The page ID changed before it could be saved.')
    }
    const first = /^[^\r\n]*/u.exec(text.slice(page.insertion))![0]
    if (looksLikeAnkiIdMarker(first)) {
        if (parseAnkiIdMarker(first)?.id === id) return text
        throw new Error('The page ID changed before it could be saved.')
    }
    if (placement === 'after-answer') return insertPageFooterId(text, id, date)
    if (placement !== 'heading') return insertPageYamlId(text, id, date)
    const marker = 'ID: ' + id + (date ? ' | ' + date : '')
    return text.slice(0, page.insertion) + (comment ? '<!--' + marker + '-->' : marker) + page.eol + text.slice(page.insertion)
}

export function pageBlock(page: PageCard, modelFields?: readonly string[]): BidirectionalBlock | undefined {
    if (page.id === undefined || page.idEnd === undefined) return
    const names = modelFields?.slice(0, 2) ?? []
    const positional = !page.fieldPair && !page.linkedRoute && names.length === 2 && names[0] !== names[1] &&
        names.every((name, index) => name === (index ? 'Back' : 'Front') || isBidirectionalFieldName(name)) &&
        (names[0] !== 'Front' || names[1] !== 'Back')
    const fieldPair: FieldPair | undefined = positional ? [names[0], names[1]] : page.fieldPair
    const pageOptionalFieldNames = modelFields?.filter(name => !page.sharedFields?.values.has(name) && pageFieldIsAvailable(name, page, modelFields, {}))
    return { ...page, fieldPair, pageOptionalFieldNames, layout: positional ? { names, separators: [], multiline: true, answer: 'Back' } : undefined,
        id: page.id, start: page.idLocation === 'yaml' ? 0 : page.start, idStart: page.idStart ?? page.insertion, format: 'page', tagEnd: page.tagAnchor ?? page.idEnd,
        extra: Object.fromEntries(Array.from(page.namedFields ?? [], ([name, span]) => [name, span.value])),
        begin: '', closing: '', explicitFields: new Map<string, ExplicitFieldSpan>([
            ['Front', page.frontSpan ?? { start: page.frontStart, end: page.frontStart + page.front.length, value: page.front, spaceWhenFilled: false }],
            ['Back', page.backSpan ?? { start: page.backStart, end: page.backEnd, value: page.back, spaceWhenFilled: false }],
            ...(page.namedFields ?? []),
        ]) }
}

interface PresetReader {
    model: string
    format: string
    pattern?: RegExp
    lines: number
    literals?: readonly string[]
    layout?: NonNullable<BidirectionalBlock['layout']>
}

// A manual reverse mapping needs a literal boundary between each capture. We never
// evaluate user-supplied regexps on the UI thread or guess which repeated value owns a field.
function literalLayout(expression: string): string[] | undefined {
    if (!expression.startsWith('^') || !expression.endsWith('$') || expression.length > 2048) return
    const tokens = expression.slice(1, -1).split(/\(\.\+\??\)/u)
    if (tokens.length < 3 || tokens.length > 33) return
    const literals = []
    for (const token of tokens) {
        let literal = ''
        for (let i = 0; i < token.length; i++) {
            const c = token[i]
            if (c === '\\' && i + 1 < token.length && /[\\.^$*+?()[\]{}|/]/u.test(token[i + 1])) literal += token[++i]
            else if (/[\\.^$*+?()[\]{}|\r\n]/u.test(c)) return
            else literal += c
        }
        literals.push(literal)
    }
    return literals.slice(1, -1).every(s => s.trim()) ? literals : undefined
}

export function presetReaders(expressions: Readonly<Record<string, string>>, models?: Readonly<Record<string, readonly string[]>>): PresetReader[] {
    const readers: PresetReader[] = []
    for (const [model, expression] of Object.entries(expressions)) {
        if (!expression) continue
        const preset = cardFormatPresets.find(item => item.expression === currentCardExpression(expression) && item.id !== 'page')
        if (preset) {
            readers.push({ model, format: preset.id, pattern: new RegExp(linkedCardPattern(preset.expression), 'd'), lines: preset.example.split('\n').length })
            continue
        }
        const knowledge = expression === knowledgeBulletExpression
        const wizard = readDelimitedRule(expression)
        const literals = wizard ? undefined : literalLayout(expression)
        // Языки и R остаются в Markdown. Двусторонний режим изменяет вопрос и ответ,
        // для которых даже при пропуске любой необязательной группы известны точные границы.
        const count = knowledge ? 2 : wizard?.count ?? (literals?.length ?? 1) - 1
        if (count < 2) continue
        const names = models ? models[model]?.slice(0, count) :
            Array.from({ length: count }, (_, i) => i === 0 ? 'Front' : i === 1 ? 'Back' : 'Field ' + (i + 1))
        if (!names || names.length !== count || new Set(names).size !== count ||
            names.some((name, index) => !name || /^(?:__proto__|constructor|prototype)$/iu.test(name) ||
                index > 1 && (name === 'Front' || name === 'Back') ||
                index < 2 && name !== (index ? 'Back' : 'Front') && !isBidirectionalFieldName(name))) continue
        const multiline = wizard?.multiline === true
        readers.push({ model, format: knowledge ? 'knowledge' : 'custom', lines: 1, literals,
            pattern: wizard || knowledge ? new RegExp(linkedCardPattern(expression), 'dm') : undefined,
            layout: { names, separators: knowledge ? ['::'] : wizard ? [wizard.separator] : literals!.slice(1, -1), multiline,
                answer: count === 2 ? 'Back' : names[count - 1] } })
    }
    return readers
}

function literalSpans(text: string, tokens: readonly string[]): [number, number][] | undefined {
    const last = tokens[tokens.length - 1]
    if (!text.startsWith(tokens[0]) || !text.endsWith(last)) return
    const limit = text.length - last.length
    const spans: [number, number][] = []
    const joins = tokens.slice(1, -1)
    const required = new Map<string, number>()
    for (const join of joins) required.set(join, (required.get(join) ?? 0) + 1)
    const middle = text.slice(tokens[0].length, limit)
    for (const [join, count] of required) {
        let found = 0, next = middle.indexOf(join)
        while (next >= 0 && found <= count) { found++; next = middle.indexOf(join, next + join.length) }
        if (found !== count) return
    }
    let at = tokens[0].length
    for (const separator of joins) {
        const end = text.indexOf(separator, at)
        if (end <= at || end + separator.length > limit) return
        spans.push([at, end])
        at = end + separator.length
    }
    if (at >= limit) return
    spans.push([at, limit])
    return spans
}

export function findPresetBlocks(text: string, readers: readonly PresetReader[], markers: readonly { id: number; line: number }[],
    claimed?: (from: number, to: number) => boolean, syntax?: DuplicateMarkerSyntax): BidirectionalBlock[] {
    if (text.includes('RUDONIUM-ARCHIVE')) text = activeCardMarkdown(text)
    if (!readers.length || !markers.length) return []
    const starts = [0]
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
    const endOf = (line: number) => {
        if (line + 1 === starts.length) return text.length
        const lf = starts[line + 1] - 1
        return text.charCodeAt(lf - 1) === 13 ? lf - 1 : lf
    }
    const rowText = (row: number) => text.slice(starts[row], endOf(row))
    const result: BidirectionalBlock[] = []
    for (const { line, id } of markers) {
        const row = line - 1
        if (row <= 0 || row >= starts.length) continue
        const markerStart = starts[row], end = endOf(row)
        if (claimed?.(markerStart, end) || parseAnkiIdMarker(rowText(row))?.id !== id) continue
        let bodyLimit = readSuspendLine(rowText(row - 1), syntax) ? row - 1 : row
        if (bodyLimit && /^Tags:[ \t]/u.test(rowText(bodyLimit - 1))) bodyLimit--
        let found: BidirectionalBlock | undefined
        for (const reader of readers) {
            const limit = reader.format === 'table' && bodyLimit > 0 && /^[ \t]*$/u.test(rowText(bodyLimit - 1))
                ? bodyLimit - 1 : bodyLimit
            let first = limit - reader.lines
            if (first < 0) continue
            if (reader.layout?.multiline) {
                if (!/^:::[ \t]*$/u.test(rowText(first))) continue
                while (--first >= 0 && end - starts[first] <= 65536) {
                    if (/^:::anki[ \t]*$/u.test(rowText(first))) break
                    if (/^:::[ \t]*$/u.test(rowText(first))) { first = -1; break }
                }
                if (first < 0) continue
            }
            const start = starts[first]
            if (claimed?.(start, end)) continue
            const contentEnd = endOf(limit - 1)
            if (contentEnd - start > (reader.layout?.multiline ? 65536 : 16384)) continue
            const body = text.slice(start, contentEnd)
            let spans: [number, number][] | undefined
            if (reader.literals) spans = literalSpans(body, reader.literals)
            else {
                const match = reader.pattern!.exec(body) as (RegExpExecArray & { indices: Array<[number, number]> }) | null
                if (match?.index === 0 && match[0].length === body.length) spans = match.indices.slice(1)
            }
            const names = reader.layout?.names ?? ['Front', 'Back']
            if (!spans || spans.length < names.length || !spans.slice(0, names.length).every((span, index) => span && (span[0] < span[1] || index === 1 && hasLinkedAnswerSlot(reader.format)))) continue
            const fields = new Map(names.map((name, i) => {
                let [from, to] = spans![i]
                if (from === to && reader.format === 'remnote' && body.startsWith('::', from) &&
                    /[ \t]/u.test(body[from - 1])) {
                    // Keep the conventional space in front of the next separator when refilling the answer.
                    from--
                    to--
                }
                return [i === 0 ? 'Front' : i === 1 ? 'Back' : name, { start: start + from, end: start + to,
                    value: body.slice(from, to).replace(/\r\n/gu, '\n'), spaceWhenFilled: from === to && body[from - 1] === ':' && (reader.format === 'knowledge' || /[ \t]::$/u.test(body.slice(0, from))) }] as const
            }))
            if (found) { found = undefined; break }
            found = { id, model: reader.model, format: reader.format, layout: reader.layout,
                fieldPair: reader.layout ? [names[0], names[1]] : undefined, idStart: markerStart,
                start, end, line: first + 1, endLine: line, front: fields.get('Front')!.value, back: fields.get('Back')!.value,
                extra: Object.fromEntries([...fields].slice(2).map(([name, field]) => [name, field.value])), explicitFields: fields,
                eol: text.slice(contentEnd, starts[limit]), begin: reader.layout?.multiline ? ':::anki' : '', closing: reader.layout?.multiline ? ':::' : '' }
        }
        if (found) result.push(found)
    }
    return result
}
