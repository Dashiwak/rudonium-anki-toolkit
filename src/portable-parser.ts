/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { pageContentTags } from './page-frontmatter'
import { knowledgeBulletExpression, isKnowledgeBullet, isKnowledgeRule, currentCardExpression, remNoteExpression } from './card-format-presets'
import { makeSpanOverlap } from './markdown-pipeline'
import { activeCardMarkdown, archivedCardRanges } from './archived-card'
import { readSuspendMarkers, suspendParserView } from './suspend-marker'
import { editorPreviewMetadata, pagePrefixMetadata } from './card-preview-metadata'
import { maskIdMarkerHtmlLiterals } from './id-marker-literals'
import { compatibleAnkiIdRegexp, markedPageAnswerBoundary, parseAnkiIdMarker, looksLikeAnkiIdMarker } from './anki-id-marker'
import { collectAnkiIdDateWarnings, findIdMarkers } from './duplicate-markers'
import { parseYaml } from 'obsidian'
import type { App, CachedMetadata, TAbstractFile, TFile, TFolder } from 'obsidian'
import { readCardTagOverride, reconcileCardTags } from './bidirectional-markdown'
import { legacyFieldSections } from './legacy-field-sections'
import { pageBlock, pageHeading, findPresetBlocks, presetReaders, readPageCard } from './page-card'
import type { BidirectionalBlock } from './bidirectional-blocks'
import { explicitBlockNamedFields, findBidirectionalBlocks, isWritableBlockExtraName } from './bidirectional-blocks'
import { isBidirectionalFieldName } from './bidirectional-fields'
import { pageFieldIsAvailable } from './page-named-fields'
import type { OneWayNamedLayout } from './oneway-history'
import { commentSpans, typeInExplicitMatch } from './card-export-diagnostics'
import { linkFieldsToCard } from './card-source-link-fields'
import * as markdownPatterns from './constants'
import type { CustomRegexpOptions } from './custom-regexp-worker'
import { parentFolderPath, resolveFolderDeck } from './deck-routes'
import type { DeckRouteOrigin } from './deck-routes'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { isRecoveryTag } from './export-recovery'
import { applyExportRule, describeExportRule, exportRuleMatcher } from './export-rules'
import type { ExportRuleOutcome } from './export-rules'
import { AllFile } from './file'
import type { CardPreviewCandidate } from './file'
import type { FileData, ParsedSettings } from './interfaces/settings-interface'
import { findLinkedBullets } from './linked-bullets'
import type { LinkedBullet, LinkedBulletModel } from './linked-bullets'
import { findMarkdownSyntaxSpans, frontmatterBounds, makeSpanLookup } from './markdown-pipeline'
import { englishUi } from './interface-language'

export function authoredFieldNames(file: AllFile, candidate: CardPreviewCandidate | undefined,
    fields: Record<string, string>): readonly string[] {
    if (file.pageCard?.fieldPair || file.pageCard?.linkedRoute) {
        // For an imported page only verified content fields and selected generator destinations
        // belong to this writer. Model fields managed by the former plugin remain in Anki.
        return [...new Set([...(candidate?.authoredFields ?? file.pageCard.fieldPair ?? []),
            ...(candidate?.generatedFields ?? [])])]
    }
    const authored = new Set(Object.keys(fields).filter(name => fields[name] !== ""));
    if (candidate?.authoredFields) {
        // Captures can intentionally be empty. Nonempty generated fields also belong to the
        // source (file link, heading context or FROZEN); empty model placeholders do not.
        for (const name of candidate.authoredFields) authored.add(name);
        return [...authored];
    }
    if (!candidate) return [...authored];
    const configured = new Map(Object.keys(fields).map(name => [name.toLowerCase(), name]));
    const source = file.original_file.slice(candidate.start, candidate.end);
    for (const line of source.split(/\r\n?|\n/)) {
        const delimiter = line.indexOf(":");
        if (delimiter < 0) continue;
        const name = configured.get(line.slice(0, delimiter).trim().toLowerCase());
        if (name) authored.add(name);
    }
    return [...authored];
}

export function oneWayNamedLayout(file: AllFile, candidate: CardPreviewCandidate, data: ParsedSettings,
    syntax?: DuplicateMarkerSyntax): OneWayNamedLayout | undefined {
    const { modelName } = candidate.note
    const names = data.fields_dict[modelName]
    if (!names || names.length <= 2) return
    const page = file.pageCard
    let labels: readonly string[] | undefined
    if (page) labels = [...(page.namedFields?.keys() ?? [])]
    else {
        if (!candidate.explicitNoteBlock) return
        const source = file.original_file.slice(candidate.start, candidate.end)
        labels = explicitBlockNamedFields(source, modelName, names, syntax)
        if (!labels) return
    }
    const settings = { file: data.file_link_fields?.[modelName], context: data.context_fields?.[modelName] }
    const mapped = portableCardExportRule(candidate.note)?.mappedFields
    const frozen = file.namedSyncFrozenFields?.(modelName)
    const fixed = page?.fieldPair ?? names.slice(0, 2)
    const eligible = names.filter(name => !fixed.includes(name) && isBidirectionalFieldName(name) &&
        name !== settings.file && name !== settings.context && !mapped?.includes(name) &&
        !frozen?.has(name) && (page ? pageFieldIsAvailable(name, page, names, settings) : isWritableBlockExtraName(name)))
    const shared = page?.sharedFields ? [...page.sharedFields.values.keys()] : undefined
    if (eligible.length || shared?.length) return { eligible, present: labels.filter(name => eligible.includes(name)), ...(shared && { shared }) }
}

const cardExpressions = new WeakMap<AllFile, Readonly<Record<string, string>>>()

export function authoredCardTagOverrides(content: string, bullets: readonly LinkedBullet[], syntax?: DuplicateMarkerSyntax,
    additional: readonly BidirectionalBlock[] = []):
    ReadonlyMap<number, NonNullable<ReturnType<typeof readCardTagOverride>>> | undefined {
    if (!content.includes('anki-bidirectional-tags:')) return
    content = content.slice(0, markedPageAnswerBoundary(content))
    const overrides = new Map<number, NonNullable<ReturnType<typeof readCardTagOverride>>>()
    for (const card of [...bullets, ...findBidirectionalBlocks(content, syntax), ...additional]) {
        const override = readCardTagOverride(content, card)
        if (override) overrides.set(card.id, override)
    }
    return overrides.size ? overrides : undefined
}

export function applyAuthoredTags(scanned: AllFile, content: string, bullets: readonly LinkedBullet[], tags: readonly string[],
    syntax?: DuplicateMarkerSyntax): void {
    if (scanned.pageCard) {
        tags = pageContentTags(tags)
        scanned.global_tags = pageContentTags(scanned.global_tags.split(/\s+/u)).join(' ')
    }
    for (const note of scanned.all_notes_to_add) {
        if (tags.length || note.tags.length > 1 || note.tags.some(tag => !tag || /\s/u.test(tag))) note.tags = mergeTags(note.tags, tags);
    }
    if (tags.length) {
        const fileTags = scanned.global_tags.split(/\s+/);
        for (const { note } of scanned.notes_to_edit) note.tags = mergeTags(note.tags, fileTags, tags);
        scanned.global_tags = "";
    }
    let additional: BidirectionalBlock[] = []
    if (content.includes('anki-bidirectional-tags:')) {
        const page = scanned.pageCard && pageBlock(scanned.pageCard)
        if (page) additional = [page]
        else {
            const readers = presetReaders(cardExpressions.get(scanned) ?? {})
            if (readers.length) additional = findPresetBlocks(content, readers, findIdMarkers(content, syntax), undefined, syntax)
        }
    }
    const overrides = authoredCardTagOverrides(content, bullets, syntax, additional)
    if (overrides) {
        const shared = scanned.global_tags.split(/\s+/u)
        for (const { identifier, note } of scanned.notes_to_edit) {
            note.tags = reconcileCardTags(mergeTags(note.tags.flatMap(tag => tag.split(/\s+/u)), shared), overrides.get(identifier))
        }
        scanned.global_tags = ""
    }
}

export function mergeTags(...groups: ReadonlyArray<readonly string[]>): string[] {
    const tags = new Map<string, string>()
    const add = (tag: string) => {
        if (!tag) return
        const key = tag.normalize('NFC').toLowerCase()
        if (!tags.has(key)) tags.set(key, tag)
    }
    for (const group of groups) {
        for (const tag of group) {
            if (/\s/u.test(tag)) for (const token of tag.split(/\s+/u)) add(token)
            else add(tag)
        }
    }
    return Array.from(tags.values())
}

export { frontmatterBounds } from './markdown-pipeline'

export function frontmatterTags(content: string, bounds = frontmatterBounds(content)): string[] {
    if (!bounds || bounds.close === content.length) return []

    const properties = parseYaml(content.slice(bounds.start, bounds.close)) as { tags?: unknown } | null
    if (!properties || !Object.prototype.hasOwnProperty.call(properties, 'tags')) return []
    const values: unknown[] = Array.isArray(properties.tags) ? properties.tags : [properties.tags]
    const tags: string[] = []
    for (const value of values) {
        if (typeof value !== 'string') continue
        const tag = value.trim().replace(/^#/, '')
        if (!tag || /[\s#]/.test(tag) || /^\p{N}+$/u.test(tag)) continue
        const parts = tag.split(/\/|::/)
        if (parts.some(part => !part)) continue
        tags.push(parts.join('::'))
    }
    return mergeTags(tags)
}

export interface PortableMarkdownOptions {
    audit?: boolean
    preview?: boolean
    trackRanges?: boolean
    metadata?: CachedMetadata
    models?: ReadonlyMap<number, LinkedBulletModel>
    bullets?: readonly LinkedBullet[]
    noteTypes?: ReadonlySet<string>
    syntax?: DuplicateMarkerSyntax
    regexpOptions?: CustomRegexpOptions
}

export function portableFileData(data: ParsedSettings, file: TFile, ids: number[], syntax?: DuplicateMarkerSyntax): FileData {
    const parents: Array<TFolder | null> = []
    let source: TAbstractFile | null = file
    while (source && Object.prototype.hasOwnProperty.call(source, 'parent')) {
        const parent: TFolder | null = source.parent
        parents.push(parent)
        source = parent
    }
    parents.pop()
    const tags: string[] = []
    for (const parent of parents) {
        if (parent && Object.prototype.hasOwnProperty.call(data.folder_tags, parent.path)) {
            const fromFolder = data.folder_tags[parent.path]
            if (typeof fromFolder === 'string' && fromFolder) tags.push(...fromFolder.split(/\s+/u).filter(Boolean))
        }
    }
    tags.push(...data.template.tags)
    const result: FileData = JSON.parse(JSON.stringify({ ...data, EXISTING_IDS: [] }))
    result.EXISTING_IDS = ids
    result.FROZEN_REGEXP = data.FROZEN_REGEXP
    result.DECK_REGEXP = data.DECK_REGEXP
    result.TAG_REGEXP = data.TAG_REGEXP
    result.NOTE_REGEXP = compatibleAnkiIdRegexp(data.NOTE_REGEXP)
    result.INLINE_REGEXP = compatibleAnkiIdRegexp(data.INLINE_REGEXP, syntax?.['Begin Inline Note'] ?? 'STARTI')
    result.EMPTY_REGEXP = compatibleAnkiIdRegexp(data.EMPTY_REGEXP)
    result.template.deckName = resolveFolderDeck(parentFolderPath(file.path), data.template.deckName,
        data.folder_decks, data.folder_default_decks).deck
    result.template.tags = tags
    return result
}

interface DeckDirective { deck: string; offset: number }

const deckDirectivesByFile = new WeakMap<AllFile, DeckDirective>()
const rulesByNote = new WeakMap<CardPreviewCandidate['note'], ExportRuleOutcome>()
const rulesByFile = new WeakMap<AllFile, readonly ExportRuleOutcome[]>()

export function portableCardExportRule(note: CardPreviewCandidate['note']): ExportRuleOutcome | undefined {
    return rulesByNote.get(note)
}

export function portableCardExportRuleRoute(note: CardPreviewCandidate['note']): DeckRouteOrigin | undefined {
    const rule = rulesByNote.get(note)
    return rule?.deckApplied ? { origin: 'profile-rule', rule: rule.rule } : undefined
}

export function portableFileExportRules(file: AllFile): readonly ExportRuleOutcome[] {
    return rulesByFile.get(file) ?? []
}

export function readDeckDirective(markdown: string, pattern: RegExp): DeckDirective | undefined {
    if (markdown.includes('RUDONIUM-ARCHIVE')) markdown = activeCardMarkdown(markdown)
    if (markdown.search(pattern) < 0) return undefined
    markdown = markdown.slice(0, markedPageAnswerBoundary(markdown))
    const { code, math } = findMarkdownSyntaxSpans(markdown, markdownPatterns.OBS_DISPLAY_CODE_REGEXP,
        markdownPatterns.OBS_CODE_REGEXP, markdownPatterns.OBS_DISPLAY_MATH_REGEXP, markdownPatterns.OBS_INLINE_MATH_REGEXP)
    const frontmatter = frontmatterBounds(markdown)
    const protectedSpans = code.concat(math)
    if (frontmatter) protectedSpans.push([0, frontmatter.end])
    const comments = commentSpans(markdown, makeSpanLookup(protectedSpans))
    const isProtected = makeSpanLookup(protectedSpans.concat(comments))
    const flags = pattern.global ? pattern.flags : pattern.flags + 'g'
    let first: DeckDirective | undefined
    for (const match of markdown.matchAll(new RegExp(pattern.source, flags))) {
        const offset = match.index + Math.max(0, match[0].search(/\S/u))
        const deck = match[1]?.trim()
        if (!deck || isProtected(offset)) continue
        if (!first) first = { deck, offset }
        else if (first.deck.normalize('NFC').toLowerCase() !== deck.normalize('NFC').toLowerCase()) {
            const lineAt = (at: number) => (markdown.slice(0, at).match(/\r\n?|\n/g)?.length ?? 0) + 1
            const a = lineAt(first.offset), b = lineAt(offset)
            throw new Error(`Different target decks on lines ${a} (“${first.deck}”) and ${b} (“${deck}”). Keep one destination per file. / Разные колоды в строках ${a} («${first.deck}») и ${b} («${deck}»). Оставьте одну целевую колоду на файл.`)
        }
    }
    return first
}

export function portableDeckRoute(data: ParsedSettings, path: string, markdown: string, parsed?: AllFile): DeckRouteOrigin {
    const directive = parsed ? deckDirectivesByFile.get(parsed) : data.DECK_REGEXP && readDeckDirective(markdown, data.DECK_REGEXP)
    if (parsed?.pageCard?.linkedRoute || directive) return { origin: 'note' }
    const { origin, folder } = resolveFolderDeck(parentFolderPath(path), data.template.deckName,
        data.folder_decks, data.folder_default_decks)
    return { origin, folder }
}

function applyProfileExportRules(scanned: AllFile, data: ParsedSettings, content: string, explicitDeck: boolean,
    options: PortableMarkdownOptions): void {
    const rules = data.export_rules
    const candidates = scanned.previewCandidates
    if (!rules?.length || !candidates?.length) return
    const frontmatter = frontmatterBounds(content)
    const match = exportRuleMatcher(rules, scanned.path, content, frontmatter, () => {
        const { code, math } = findMarkdownSyntaxSpans(content, markdownPatterns.OBS_DISPLAY_CODE_REGEXP,
            markdownPatterns.OBS_CODE_REGEXP, markdownPatterns.OBS_DISPLAY_MATH_REGEXP, markdownPatterns.OBS_INLINE_MATH_REGEXP)
        const protectedSpans = code.concat(math)
        if (frontmatter) protectedSpans.push([0, frontmatter.end])
        return makeSpanLookup(protectedSpans.concat(commentSpans(content, makeSpanLookup(protectedSpans))))
    })
    const linked = new Map(scanned.notes_to_edit.map(({ note, identifier }) => [note, identifier] as const))
    const created = new Set(scanned.all_notes_to_add)
    const outcomes = new Map<string, ExportRuleOutcome>()
    for (const candidate of candidates) {
        // A linked YAML page owns the properties for ID checks, but heading-scoped export rules start at its title.
        const ruleStart = scanned.pageCard?.start ?? candidate.start
        if (frontmatter && ruleStart < frontmatter.end) continue
        const { note } = candidate
        const id = candidate.identifier ?? linked.get(note)
        const hasLink = id !== undefined
        if (!hasLink && !created.has(note)) continue
        const selected = match(ruleStart)
        if (!selected) continue
        const pair = scanned.pageCard?.fieldPair ?? (scanned.pageCard?.linkedRoute ? candidate.authoredFields : undefined)
        if (pair && ((selected.rule.model && selected.rule.model !== note.modelName) ||
            selected.rule.fields.some(mapping => !pair.some(name => name === mapping.target)))) {
            throw new Error('An export rule changes a protected field or note type on this linked page. / Правило экспорта меняет защищённое поле или тип связанной страницы.')
        }
        if (scanned.pageCard?.sharedFields && selected.rule.fields.some(mapping => scanned.pageCard?.sharedFields?.values.has(mapping.target))) {
            throw new Error('An export rule and a shared page field both supply the same field. / Правило экспорта и блок общих полей страницы заполняют одно и то же поле. Оставьте один источник.')
        }
        const originalFields = note.fields
        const linkedModel = id === undefined ? undefined : options.models?.get(id)?.name
        const outcome = applyExportRule(note, selected.rule, selected.properties, data.fields_dict, hasLink, linkedModel, explicitDeck)
        if (!outcome.problem && selected.rule.tags.length) note.tags = mergeTags(note.tags)
        if (outcome.mappedFields.length && hasLink) {
            candidate.authoredFields = [...new Set([...authoredFieldNames(scanned, candidate, originalFields), ...outcome.mappedFields])]
        }
        if (outcome.problem && outcome.problem !== 'linked-model' && !options.preview) {
            const line = content.slice(0, ruleStart).split(/\r\n?|\n/).length
            throw new Error(`Line ${line}: ${describeExportRule(outcome, englishUi)}`)
        }
        rulesByNote.set(note, outcome)
        outcomes.set(JSON.stringify(outcome), outcome)
    }
    if (outcomes.size) rulesByFile.set(scanned, [...outcomes.values()])
}

function checkIdMarkerSafety(content: string, syntax: DuplicateMarkerSyntax = {}): void {
    if (!content.includes('ID')) return
    const bounds = frontmatterBounds(content)
    const { code, math } = findMarkdownSyntaxSpans(content, markdownPatterns.OBS_DISPLAY_CODE_REGEXP,
        markdownPatterns.OBS_CODE_REGEXP, markdownPatterns.OBS_DISPLAY_MATH_REGEXP, markdownPatterns.OBS_INLINE_MATH_REGEXP)
    const protectedSpans = code.concat(math)
    if (bounds) protectedSpans.push([0, bounds.end])
    const protectedAt = makeSpanLookup(protectedSpans)
    const comments = commentSpans(content, protectedAt)
    const commentAt = makeSpanLookup(comments)
    const inlineStart = syntax['Begin Inline Note'] ?? 'STARTI'
    const inlineEnd = syntax['End Inline Note'] ?? 'ENDI'
    let offset = 0, line = 0
    for (const row of maskIdMarkerHtmlLiterals(content).split(/\r\n?|\n/u)) {
        line++
        const leading = row.length - row.trimStart().length
        const candidates = [{ raw: row, at: offset + leading }]
        if (inlineStart && inlineEnd && row.includes(inlineStart)) {
            for (let start = row.indexOf(inlineStart); start >= 0;) {
                const close = row.indexOf(inlineEnd, start + inlineStart.length)
                if (close < 0) break
                const from = close + inlineEnd.length
                const next = row.indexOf(inlineStart, from)
                const tail = row.slice(from, next < 0 ? undefined : next)
                candidates.push({ raw: tail, at: offset + from + tail.length - tail.trimStart().length })
                start = next
            }
        }
        for (const candidate of candidates) {
            if (!looksLikeAnkiIdMarker(candidate.raw) || protectedAt(candidate.at)) continue
            const ownComment = candidate.raw.trim().startsWith('<!--') && comments.some(([from, to]) =>
                from === candidate.at && to <= offset + row.length && /^<!--[ \t]*ID[ \t]*:/u.test(content.slice(from, to)))
            if (commentAt(candidate.at) && !ownComment) continue
            if (!parseAnkiIdMarker(candidate.raw)) throw new Error(
                `Invalid Anki ID marker on line ${line}. Keep a positive whole number and repair the marker before exporting. / Некорректный маркер ID Anki в строке ${line}. Исправьте целое положительное число перед экспортом.`)
        }
        offset += row.length
        if (content[offset] === '\r') offset++
        if (content[offset] === '\n') offset++
    }
}

export async function parsePortableMarkdown(app: App, data: ParsedSettings, file: TFile, content: string,
    ids: number[], options: PortableMarkdownOptions = {}): Promise<AllFile> {
    if (content.includes('RUDONIUM-ARCHIVE')) {
        const archives = archivedCardRanges(content)
        if (archives.length) {
            const active = activeCardMarkdown(content)
            const overlaps = makeSpanOverlap(archives.map(range => [range.start, range.end]))
            const scanned = await parsePortableMarkdown(app, data, file, active, ids, {
                ...options, trackRanges: true,
                metadata: editorPreviewMetadata(active, options.metadata ?? app.metadataCache.getCache(file.path)),
                bullets: options.bullets?.filter(bullet => !overlaps(bullet.start, bullet.end)),
            })
            const candidates = scanned.previewCandidates ?? []
            const bounded = new Set(candidates.map(card => card.note))
            if (candidates.some(card => overlaps(card.start, card.end)) ||
                scanned.all_notes_to_add.some(note => !bounded.has(note)) || scanned.notes_to_edit.some(edit => !bounded.has(edit.note))) {
                throw new Error('A card pattern crosses an archived block. Check the source boundaries. / Карточка пересекает архивный блок. Проверьте границы разметки.')
            }
            scanned.original_file = content
            scanned.file = content
            return scanned
        }
    }
    const legacy = legacyFieldSections(content)
    if (legacy.ranges.length) {
        const overlaps = makeSpanOverlap(legacy.ranges)
        const scanned = await parsePortableMarkdown(app, data, file, legacy.text, ids, {
            ...options, trackRanges: true,
            metadata: editorPreviewMetadata(legacy.text, options.metadata ?? app.metadataCache.getCache(file.path)),
            bullets: options.bullets?.filter(bullet => !overlaps(bullet.start, bullet.end)),
        })
        // A multiline rule must not claim an ID or a span across the preserved appendix.
        const candidates = scanned.previewCandidates ?? []
        const tracked = new Set(candidates.map(card => card.note))
        if (candidates.some(card => overlaps(card.start, card.end)) ||
            scanned.all_notes_to_add.some(note => !tracked.has(note)) || scanned.notes_to_edit.some(edit => !tracked.has(edit.note))) {
            throw new Error('A card rule crosses notes retained from 0.9.7. / Правило карточки пересекает текст, сохранённый из 0.9.7.')
        }
        scanned.original_file = content
        scanned.file = content
        return scanned
    }
    const boundary = markedPageAnswerBoundary(content)
    if (boundary !== undefined) {
        // Give the upstream parser and renderer only the public prefix, including for tags, frozen fields and media.
        // The complete original stays on the writer for crash recovery and precise edits.
        const page = readPageCard(content, data.custom_regexps, options.syntax, data.page_model)
        if (!page) throw new Error('Choose an Anki note type for this @page before exporting. / Выберите тип записи Anki для этой страницы @page.')
        const visible = content.slice(0, boundary)
        // A page may be selected by a tag in its private appendix. Supply just the routing
        // tag to the public parser; its original offsets, ID writer and user's Markdown stay intact.
        const publicInput = pageHeading(visible) ? visible : visible + '#anki-page' + page.eol
        const scanned = await parsePortableMarkdown(app, data, file, publicInput, ids, {
            ...options, bullets: [], metadata: pagePrefixMetadata(visible, options.metadata ?? app.metadataCache.getCache(file.path)),
        })
        const publicCard = scanned.pageCard
        if (!publicCard || publicCard.id !== page.id || publicCard.front !== page.front || publicCard.back !== page.back ||
            publicCard.namedFields?.size !== page.namedFields?.size ||
            (page.namedFields && [...page.namedFields].some(([name, field]) => publicCard.namedFields?.get(name)?.value !== field.value)))
            throw new Error('The page changed during export. / Страница изменилась во время экспорта.')
        for (const candidate of scanned.previewCandidates ?? []) candidate.end = page.end
        for (const range of scanned.auditNoteRanges ?? []) range[1] = page.end
        scanned.original_file = content
        scanned.file = content
        scanned.pageCard = page
        return scanned
    }
    const directive = data.DECK_REGEXP && readDeckDirective(content, data.DECK_REGEXP)
    checkIdMarkerSafety(content, options.syntax)
    const url = data.add_file_link
        ? 'obsidian://open?vault=' + encodeURIComponent(data.vault_name) + '&file=' + encodeURIComponent(file.path)
        : ''
    const fileData = portableFileData(data, file, ids, options.syntax)
    const marks = readSuspendMarkers(content, options.syntax)
    const view = marks.size ? suspendParserView(content, marks) : undefined
    const parserText = view?.text ?? content
    const metadata = options.metadata ?? app.metadataCache.getCache(file.path) ?? {}
    const scanned = new AllFile(parserText, file.path, url, fileData,
        data.add_context ? editorPreviewMetadata(parserText, metadata) : metadata)
    scanned.idDateWarnings = collectAnkiIdDateWarnings(content, options.syntax)
    const sourceDateWarningCount = scanned.idDateWarnings.length
    if (options.audit) scanned.auditNoteRanges = []
    if (options.preview || options.trackRanges || data.export_rules?.length) scanned.previewCandidates = []
    const { noteTypes, syntax } = options
    if (noteTypes) scanned.acceptExplicitType = (source, inline) => {
        const declared = typeInExplicitMatch(source, inline, syntax)
        return declared === undefined || noteTypes.has(declared)
    }
    const bullets = options.bullets ?? findLinkedBullets(content, false, syntax)
    scanned.linkedBullets = bullets.flatMap(bullet => {
        const model = options.models?.get(bullet.id)
        const rule = model && data.custom_regexps[model.name]
        if (bullet.separatorRepair && rule && !isKnowledgeRule(rule) && currentCardExpression(rule) !== remNoteExpression) return []
        if (model && data.custom_regexps[model.name] === knowledgeBulletExpression && isKnowledgeBullet(content, bullet.start)) return []
        return model ? [{ ...bullet, model, ...(view && { start: view.toParsed(bullet.start), end: view.toParsed(bullet.end) }) }] : []
    })
    scanned.pageCard = readPageCard(parserText, data.custom_regexps, syntax, data.page_model) ?? null
    await scanned.scanFile(options.regexpOptions)
    if (view) {
        for (const candidate of scanned.previewCandidates ?? []) {
            candidate.start = view.toRaw(candidate.start)
            candidate.end = view.toRawEnd(candidate.end)
        }
        for (const warning of scanned.tableIdWarnings ?? []) warning.line = view.toRawLine(warning.line)
        for (const range of scanned.auditNoteRanges ?? []) {
            range[0] = view.toRaw(range[0])
            range[1] = view.toRawEnd(range[1])
        }
        for (const positions of [scanned.id_indexes, scanned.inline_id_indexes, scanned.regex_id_indexes]) {
            if (positions) for (let i = 0; i < positions.length; i++) positions[i] = view.toRawEnd(positions[i])
        }
        for (const bullet of scanned.linkedBullets ?? []) {
            bullet.start = view.toRaw(bullet.start)
            bullet.end = view.toRaw(bullet.end)
        }
        if (scanned.markdownWarningLines?.length) scanned.markdownWarningLines = scanned.markdownWarningLines.map(view.toRawLine)
        for (const warning of scanned.idDateWarnings.slice(sourceDateWarningCount)) warning.line = view.toRawLine(warning.line)
        if (scanned.pageCard) scanned.pageCard = readPageCard(content, data.custom_regexps, syntax, data.page_model) ?? null
        scanned.original_file = content
        scanned.file = content
    }
    if (content.includes('anki-bidirectional-tags:')) cardExpressions.set(scanned, data.custom_regexps)
    const savedRoute = scanned.pageCard?.linkedRoute
    if (data.DECK_REGEXP || savedRoute) {
        if (directive) deckDirectivesByFile.set(scanned, directive)
        if (savedRoute && directive && savedRoute.deck !== directive.deck) {
            throw new Error('The deck directive conflicts with the preserved Anki deck on this page.')
        }
        const target = savedRoute?.deck ?? directive?.deck ?? fileData.template.deckName
        if (scanned.target_deck !== target) {
            scanned.target_deck = target
            for (const note of scanned.all_notes_to_add) note.deckName = target
            for (const { note } of scanned.notes_to_edit) note.deckName = target
            for (const candidate of scanned.previewCandidates ?? []) candidate.note.deckName = target
        }
    }
    applyProfileExportRules(scanned, data, content, !!(savedRoute || directive), options)
    for (const candidate of scanned.previewCandidates ?? []) {
        const layout = oneWayNamedLayout(scanned, candidate, data, syntax)
        if (layout) candidate.namedLayout = layout
    }
    if (url) {
        for (const { identifier, note } of scanned.notes_to_edit) {
            note.fields = linkFieldsToCard(note.fields, url, app.vault.getName(), file.path, identifier,
                data.file_link_fields?.[note.modelName])
        }
    }
    if (options.preview) {
        const bounds = frontmatterBounds(content)
        if (bounds && !scanned.pageCard) scanned.previewCandidates = scanned.previewCandidates?.filter(candidate => candidate.start >= bounds.end)
        applyAuthoredTags(scanned, content, bullets, frontmatterTags(content, bounds), syntax)
        const fileTags = scanned.global_tags.split(/\s+/)
        for (const candidate of scanned.previewCandidates ?? []) {
            const tags = candidate.identifier === undefined ? candidate.note.tags : mergeTags(candidate.note.tags, fileTags)
            candidate.note.tags = tags.filter((tag: string) => !isRecoveryTag(tag))
        }
    }
    return scanned
}

export function containsCardOffset(range: { start: number; end: number }, text: string, offset: number): boolean {
    return range.start <= offset && (offset < range.end || (offset === range.end &&
        (offset === text.length || text[offset] === '\r' || text[offset] === '\n')))
}

export function cardAtOffset(scanned: AllFile, text: string, offset: number): CardPreviewCandidate | undefined {
    if (scanned.original_file !== text || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
        throw new Error('The cursor or source no longer matches the scanned note.')
    }
    const matches = (scanned.previewCandidates ?? []).filter(candidate => containsCardOffset(candidate, text, offset))
    if (matches.length > 1) throw new Error('More than one Anki card matches the cursor. Check the card boundaries and Custom Regexp.')
    return matches[0]
}


