// SPDX-License-Identifier: GPL-3.0-only
import { parseYaml } from 'obsidian'
import { splitMigrationMarkdown, withoutMigrationKeys } from './migration-markdown'
import type { MigrationAdapter, MigrationCandidate, MigrationContext } from './page-migration-context'

const externalMarker = /<!--[ \t]*anki-id[ \t]*:/iu
const exporterMarker = /<!--[ \t]*anki-note-id[ \t]*:/iu
const uuidAtEnd = /<!--[ \t]*anki-id:[ \t]*([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})[ \t]*-->\s*$/iu
const unsafeQuestion = /[\x00-\x1f\x7f]|#anki-page|(?:^|\s)\^[\w-]+$|^(?:\s|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||`{3}|~{3}|<|\$\$)/u
const otherMarkers = /<!--[ \t]*(?:ID\s*:|anki-note-id\s*:|anki-bidirectional-tags\s*:|rudonium-page-|Obsidian-to-Anki pending)|^(?:STARTI?|ENDI?|FROZEN|SUSPEND|DELETE)(?:[ \t]|\r?$)|^ID:\s|(?:^|\s)\^(?:\d{13}|q-[\w-]+)\s*$/imu

function sourceSelected(context: MigrationContext, name: 'anki-ast-sync' | 'anki-exporter'): boolean {
    return !context.source || context.source === 'auto' || context.source === name
}

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function supportedQuestion(value: string): boolean {
    return !!value && value === value.trim() && !unsafeQuestion.test(value)
}

function trimBlankRows(rows: string[]): string[] {
    let start = 0, end = rows.length
    while (start < end && !rows[start].trim()) start++
    while (end > start && !rows[end - 1].trim()) end--
    return rows.slice(start, end)
}

/** Anki Exporter places its numeric Anki note ID on the line before the card. */
export const detectAnkiExporter: MigrationAdapter = (_path, text, context) => {
    const source = 'anki-exporter'
    if (!sourceSelected(context, source)) return
    const marker = exporterMarker.test(text)
    if (!marker && !(context.source === source && text.includes(' :: '))) return
    const parts = splitMigrationMarkdown(text)
    const review = (id?: number): MigrationCandidate => ({ source, status: 'review', id, reason: context.t(
        'Check the Anki Exporter ID and file boundaries. A page needs one complete Question :: Answer line.',
        'Проверьте ID Anki Exporter и границы файла. Для страницы нужна одна полная строка «Вопрос :: Ответ».') })
    if (!parts) return review()
    const rows = trimBlankRows(parts.body.split(/\r?\n/u))
    if (!rows.length || /^(?: {4}|\t| {0,3}(?:`{3}|~{3}|>))/u.test(rows[0])) return
    let id: number | undefined
    if (marker) {
        const match = /^<!--[ \t]*anki-note-id:[ \t]*([1-9]\d*)[ \t]*-->[ \t]*$/u.exec(rows[0])
        if (!match) return review()
        id = Number(match[1])
        if (!Number.isSafeInteger(id)) return review()
        rows.shift()
    }
    if (rows.length !== 1) return review(id)
    const row = rows[0].trimEnd()
    const pos = row.indexOf(' :: ')
    if (pos < 1 || pos !== row.lastIndexOf(' :: ') || row.includes('<!--') || row.includes('%%') ||
        /(?:^|\s)\^[\w-]+$/u.test(row)) return review(id)
    const front = row.slice(0, pos), back = row.slice(pos + 4)
    if (!supportedQuestion(front) || !back || back !== back.trim() || /:::/u.test(row)) return review(id)
    return { source, status: 'candidate', front, back, id, prefix: parts.bom + parts.yaml, fieldNames: ['Front', 'Back'] }
}

// Track Markdown fences before interpreting delimiters and headings inside a Basic card.
function astDelimiter(rows: string[], depth: number, delimiter: string): number | undefined {
    let index: number | undefined
    let fence: string | undefined
    let math = false
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i]
        if (fence) {
            const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(row)
            if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined
            continue
        }
        if (/^[ \t]*\$\$[ \t]*$/u.test(row)) { math = !math; continue }
        if (math) continue
        const opened = /^ {0,3}(`{3,}|~{3,})/u.exec(row)
        if (opened) { fence = opened[1]; continue }
        const heading = /^ {0,3}(#{1,6})(?:[ \t]|$)/u.exec(row)
        if (heading && heading[1].length <= depth) return
        if (row.trimEnd() === delimiter) {
            if (index !== undefined) return
            index = i
        } else if (row.trimStart().startsWith(delimiter) || /<!--|%%|!\[\[|\{\{/u.test(row)) return
    }
    if (!fence && !math) return index
}

const astSettings = new Set(['AnkiSync', 'target_anki_deck', 'file_anki_tags', 'cardDeclarationHeadingLevel',
    'delimiter', 'includeParentHeadersAsTags', 'anki_cardDefault'])

function yamlPrefix(yaml: string, props: Record<string, unknown>, extraTags: string[], topic: string | undefined, eol: string): string | undefined {
    const remove = new Set([...astSettings].filter(key => Object.prototype.hasOwnProperty.call(props, key)))
    const extra: string[] = []
    if (extraTags.length) {
        const existing: unknown = props.tags
        const values = Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : existing == null ? [] : undefined
        if (!values || values.some(value => typeof value !== 'string' || !value.trim() || /[\s,]/u.test(value))) return
        const missing = extraTags.filter(tag => !values.includes(tag))
        if (missing.length) {
            if (Object.prototype.hasOwnProperty.call(props, 'tags')) remove.add('tags')
            extra.push('tags: ' + JSON.stringify([...new Set([...values, ...missing])]))
        }
    }
    if (topic && props['rudonium-source-heading'] !== topic) {
        if (Object.prototype.hasOwnProperty.call(props, 'rudonium-source-heading')) return
        extra.push('rudonium-source-heading: ' + JSON.stringify(topic))
    }
    const cleaned = withoutMigrationKeys(yaml, remove)
    if (cleaned === undefined || !extra.length) return cleaned
    if (!cleaned) return ['---', ...extra, '---', ''].join(eol)
    const close = cleaned.lastIndexOf('\n---') + 1
    return cleaned.slice(0, close) + extra.join(eol) + eol + cleaned.slice(close)
}

/** Parse one explicitly opted-in AST Sync Basic card. Its marker is a source UUID, never an Anki note ID. */
export const detectAnkiAstSync: MigrationAdapter = (_path, text, context) => {
    const source = 'anki-ast-sync'
    if (!sourceSelected(context, source)) return
    const uuidHint = externalMarker.test(text)
    if (!uuidHint && !/^(?:AnkiSync|"AnkiSync"|'AnkiSync')\s*:/mu.test(text)) return
    const parts = splitMigrationMarkdown(text)
    const review = (en: string, ru: string): MigrationCandidate => ({ source, status: 'review', reason: context.t(en, ru) })
    const settingsIssue = () => review('Check the original Anki AST Sync properties, tags and card type.',
        'Проверьте исходные свойства, теги и тип карточки Anki AST Sync.')
    if (!parts || !parts.yaml) {
        // Numeric <!--anki-id: ...--> markers are used by other plugins.
        if (!uuidAtEnd.test(text)) return
        return settingsIssue()
    }
    const rawYaml = parts.yaml.slice(parts.yaml.indexOf('\n') + 1, parts.yaml.lastIndexOf('\n---') + 1)
    if (!/^(?:AnkiSync|"AnkiSync"|'AnkiSync')[ \t]*:/mu.test(rawYaml)) {
        if (!uuidAtEnd.test(parts.body)) return
        return settingsIssue()
    }
    let props: unknown
    try { props = parseYaml(rawYaml) } catch { return settingsIssue() }
    if (!record(props)) return settingsIssue()
    const enabled = props.AnkiSync === true || props.AnkiSync === 'on' || props.AnkiSync === 'true'
    if (!enabled) return context.source === source || uuidHint ? settingsIssue() : undefined
    const depth = props.cardDeclarationHeadingLevel ?? 4, delimiter = props.delimiter ?? ':::'
    const deck = props.target_anki_deck
    if (!Number.isInteger(depth) || typeof depth !== 'number' || depth < 1 || depth > 6 ||
        typeof delimiter !== 'string' || !/^[^\w\s`~$<#]{1,12}$/u.test(delimiter) || delimiter.startsWith('>') ||
        (deck !== undefined && (typeof deck !== 'string' || !deck.trim() || deck.trim() !== deck || /[\x00-\x1f]/u.test(deck))) ||
        (props.anki_cardDefault !== undefined && props.anki_cardDefault !== 'basic') ||
        props.anki_customCardDefault != null || props.anki_customLayoutMap != null ||
        /^(?:[ \t]*<<:|[^#\r\n]+:[ \t]*[&*][\w-]+)/mu.test(rawYaml)) return settingsIssue()
    let body = parts.body
    let externalKey: string | undefined
    if (uuidHint) {
        const match = uuidAtEnd.exec(body)
        if (!match || externalMarker.test(body.slice(0, match.index))) return settingsIssue()
        externalKey = match[1].toLowerCase()
        body = body.slice(0, match.index)
    }
    const rawRows = trimBlankRows(body.match(/[^\n]*\n|[^\n]+$/gu) ?? [])
    const rows = rawRows.map(row => row.replace(/\r?\n$/u, ''))
    const first = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/u.exec(rows[0] ?? '')
    const boundaryIssue = () => review('Expected one Anki AST Sync Basic heading, one separator and a complete answer. Check other cards or source directives.',
        'Ожидались один заголовок Basic Anki AST Sync, один разделитель и полный ответ. Проверьте другие карточки или директивы источника.')
    if (!first || first[1].length !== depth || otherMarkers.test(body)) return boundaryIssue()
    let title = first[2].replace(/[ \t]+#+$/u, '')
    const tags: string[] = []
    const tag = /[ \t]+#([^\s#]+)[ \t]*$/u
    for (let found = tag.exec(title); found; found = tag.exec(title)) {
        if (found[1] !== 'anki/cardType/basic') {
            if (/^anki(?:\/|_card_)/u.test(found[1])) return settingsIssue()
            tags.push(found[1])
        }
        title = title.slice(0, found.index)
    }
    if (!title || /(?:^|\s)#\S/u.test(title) || /\^\S+$/u.test(title)) return boundaryIssue()
    if (props.file_anki_tags !== undefined) {
        if (typeof props.file_anki_tags !== 'string') return settingsIssue()
        tags.push(...props.file_anki_tags.split(',').map(value => value.trim()).filter(Boolean))
    }
    if (tags.some(tag => !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(tag) || /^\d+$/u.test(tag))) return settingsIssue()
    const boundary = astDelimiter(rows, depth, delimiter)
    if (boundary === undefined) return boundaryIssue()
    const bodyFront = trimBlankRows(rows.slice(1, boundary))
    const front = bodyFront[0] ?? title
    const back = trimBlankRows(rawRows.slice(boundary + 1)).join('').replace(/\r?\n$/u, '')
    if (bodyFront.length > 1 || !supportedQuestion(front) || !back.trim()) return boundaryIssue()
    const prefix = yamlPrefix(parts.yaml, props, tags, bodyFront.length && front !== title ? title : undefined, parts.eol)
    if (prefix === undefined) return settingsIssue()
    return { source, status: 'candidate', front, back, model: 'Basic', deck: typeof deck === 'string' ? deck : undefined,
        fieldNames: ['Front', 'Back'], externalKey, prefix: parts.bom + prefix }
}
