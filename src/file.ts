import { multilineOwnership, checkWizardRowModels } from './wizard-card-ownership'
import type { MultilineOwnership } from './wizard-card-ownership'
import { readDelimitedRule } from './delimited-rule'
import { insertPageFooterId, validatePageYamlPlacement, readPageCard, writePageId, isLinkedPageSchema, needsLinkedPageLayout, pageSourceContext, pageExportFieldNames, pageContentTags } from './page-card'
import type { PageCard } from './page-card'
import { currentCardExpression, cardRegexpWithSuffix, tableCardExpression, remNoteExpression, applyRemNoteMetadata, namedCardExpressions, pageCardExpression } from './card-format-presets'
import { presetStartGuard, wizardStartGuard, tableIdConflicts } from './card-export-diagnostics'
import { checkedCustomAnkiMatches, copyMatchForRegexNote } from './anki-id-marker'
import type { AnkiIdDateWarning } from './anki-id-marker'
import { customRegexpKey, matchCustomRegexps } from './custom-regexp-worker'
import type { CustomRegexpOptions, CustomRegexpPattern } from './custom-regexp-worker'
import { makeSpanLookup, makeSpanOverlap } from './markdown-pipeline'
import { findMarkdownSyntaxSpans, removeUnprotectedMatches, suspiciousMathCardLines } from './markdown-pipeline'

function markdownSyntaxSpans(text: string) {
    return findMarkdownSyntaxSpans(text, c.OBS_DISPLAY_CODE_REGEXP, c.OBS_CODE_REGEXP, c.OBS_DISPLAY_MATH_REGEXP, c.OBS_INLINE_MATH_REGEXP)
}

import { matchesOutsideSpans } from './markdown-pipeline'
import { tableIdSpacing } from './card-format-presets'
import { joinIdInsertions } from './markdown-pipeline'
import { linkedBulletSourceFields } from './linked-bullets'
import type { LinkedBullet, LinkedBulletModel } from './linked-bullets'
import { ankiIdRegexpSource } from './anki-id-marker'
import { formatLocalIdDate } from './anki-id-marker'
/*Performing plugin operations on markdown file contents*/

import { FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FileData } from './interfaces/settings-interface'
import { Note, InlineNote, RegexNote, CLOZE_ERROR, NOTE_TYPE_ERROR, TAG_SEP, ID_REGEXP_STR, TAG_REGEXP_STR } from './note'
import { Md5 } from 'ts-md5/dist/md5';
import * as AnkiConnect from './anki'
import * as c from './constants'
import { FormatConverter } from './format'
import { CachedMetadata, HeadingCache } from 'obsidian'

const double_regexp: RegExp = /(?:\r\n|\r|\n)((?:\r\n|\r|\n)(?:<!--)?ID: \d+)/g

function id_to_str(identifier:number, inline:boolean = false, comment:boolean = false, date?: string): string {
    let result = "ID: " + identifier.toString()
    if (date) result += " | " + date
    if (comment) {
        result = "<!--" + result + "-->"
    }
    if (inline) {
        result += " "
    } else {
        result += "\n"
    }
    return result
}

function string_insert(text: string, position_inserts: Array<[number, string]>, tablePositions?: ReadonlySet<number>): string {
    return joinIdInsertions(text, position_inserts, tablePositions ? (source, position, marker) => tablePositions.has(position) ? tableIdSpacing(source, position, marker) : marker : undefined)
}

function spans(pattern: RegExp, text: string): Array<[number, number]> {
	/*Return a list of span-tuples for matches of pattern in text.*/
	let output: Array<[number, number]> = []
	let matches = text.matchAll(pattern)
	for (let match of matches) {
		output.push(
			[match.index, match.index + match[0].length]
		)
	}
	return output
}



abstract class AbstractFile {
    protected markdownProtected = (_offset: number): boolean => false
    file: string
    path: string
    url: string
    original_file: string
    data: FileData
    file_cache: CachedMetadata

    frozen_fields_dict: FROZEN_FIELDS_DICT
    target_deck: string
    global_tags: string

    notes_to_add: AnkiConnectNote[]
    id_indexes: number[]
    notes_to_edit: AnkiConnectNoteAndID[]
    notes_to_delete: number[]
    all_notes_to_add: AnkiConnectNote[]

    note_ids: Array<number | null>
    card_ids: number[]
    tags: string[]

    formatter: FormatConverter

    constructor(file_contents: string, path:string, url: string, data: FileData, file_cache: CachedMetadata) {
        this.data = data
        this.file = file_contents
        this.path = path
        this.url = url
        this.original_file = this.file
        this.file_cache = file_cache
        this.formatter = new FormatConverter(file_cache, this.data.vault_name)
    }

    setup_frozen_fields_dict() {
        let frozen_fields_dict: FROZEN_FIELDS_DICT = {}
        for (let note_type in this.data.fields_dict) {
            let fields: string[] = this.data.fields_dict[note_type]
            let temp_dict: Record<string, string> = {}
            for (let field of fields) {
                temp_dict[field] = ""
            }
            frozen_fields_dict[note_type] = temp_dict
        }
        for (let match of this.file.matchAll(this.data.FROZEN_REGEXP)) {
            const [note_type, fields]: [string, string] = [match[1], match[2]]
            const virtual_note = note_type + "\n" + fields
            const parsed_fields: Record<string, string> = new Note(
                virtual_note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).getFields()
            frozen_fields_dict[note_type] = parsed_fields
        }
        this.frozen_fields_dict = frozen_fields_dict
    }

    setup_target_deck() {
        const result = this.file.match(this.data.DECK_REGEXP)
        this.target_deck = result ? result[1] : this.data.template["deckName"]
    }

    setup_global_tags() {
        const result = this.file.match(this.data.TAG_REGEXP)
        this.global_tags = result ? result[1] : ""
    }

    getHash(): string {
        return Md5.hashStr(this.file) as string
    }

    abstract scanFile(): void

    scanDeletions() {
        for (let match of this.file.matchAll(this.data.EMPTY_REGEXP)) {
            if (this.markdownProtected(match.index ?? 0)) continue
            this.notes_to_delete.push(parseInt(match[1]))
        }
    }

    getContextAtIndex(position: number): string {
        let result: string = this.path
        let currentContext: HeadingCache[] = []
        if (!(this.file_cache.hasOwnProperty('headings'))) {
            return result
        }
        for (let currentHeading of this.file_cache.headings) {
            if (position < currentHeading.position.start.offset) {
                //We've gone past position now with headings, so let's return!
                break
            }
            let insert_index: number = 0
            for (let contextHeading of currentContext) {
                if (currentHeading.level > contextHeading.level) {
                    insert_index += 1
                    continue
                }
                break
            }
            currentContext = currentContext.slice(0, insert_index)
            currentContext.push(currentHeading)
        }
        let heading_strs: string[] = []
        for (let contextHeading of currentContext) {
            heading_strs.push(contextHeading.heading)
        }
        let result_arr: string[] = [result]
        result_arr.push(...heading_strs)
        return result_arr.join(" > ")
    }

    abstract writeIDs(): void

    removeEmpties() {
        const { code, math } = markdownSyntaxSpans(this.file)
        this.file = removeUnprotectedMatches(this.file, this.data.EMPTY_REGEXP, makeSpanLookup(code.concat(math)))
    }

    getCreateDecks(): AnkiConnect.AnkiConnectRequest {        
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let note of this.all_notes_to_add) {
            actions.push(AnkiConnect.createDeck(note.deckName))
        }
        return AnkiConnect.multi(actions)
    }

    getAddNotes(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let note of this.all_notes_to_add) {
            actions.push(AnkiConnect.addNote(note))
        }
        return AnkiConnect.multi(actions)
    }

    getDeleteNotes(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.deleteNotes(this.notes_to_delete)
    }

    getUpdateFields(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) {
            actions.push(
                AnkiConnect.updateNoteFields(
                    parsed.identifier, parsed.note.fields
                )
            )
        }
        return AnkiConnect.multi(actions)
    }

    getNoteInfo(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.notesInfo(IDs)
    }

    getChangeDecks(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.changeDeck(this.card_ids, this.target_deck)
    }

    getClearTags(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.removeTags(IDs, this.tags.join(" "))
    }

    getAddTags(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) {
            actions.push(
                AnkiConnect.addTags([parsed.identifier], parsed.note.tags.join(" ") + " " + this.global_tags)
            )
        }
        return AnkiConnect.multi(actions)
    }

}


export interface CardPreviewCandidate {
    start: number
    end: number
    note: AllFile['all_notes_to_add'][number]
    identifier?: number
    authoredFields?: readonly string[]
    generatedFields?: readonly string[]
    explicitNoteBlock?: boolean
    namedLayout?: import('./oneway-history').OneWayNamedLayout
}

export class AllFile extends AbstractFile {
    /** UTF-16 offsets in the same Markdown snapshot passed to the parser. */
    previewCandidates?: CardPreviewCandidate[]
    acceptExplicitType?: (source: string, inline: boolean) => boolean

    /** The upstream ID writer requires the insertion position to stay aligned with each card. */
    removeUnsafeNewCards(blocked: ReadonlySet<CardPreviewCandidate['note']>): void {
        const retain = (cards: CardPreviewCandidate['note'][], positions: number[]) => {
            let kept = 0;
            for (let index = 0; index < cards.length; index++) {
                if (blocked.has(cards[index])) continue;
                cards[kept] = cards[index];
                positions[kept] = positions[index];
                kept++;
            }
            cards.length = kept;
            positions.length = kept;
        };
        retain(this.notes_to_add, this.id_indexes);
        retain(this.inline_notes_to_add, this.inline_id_indexes);
        retain(this.regex_notes_to_add, this.regex_id_indexes);
        this.all_notes_to_add = this.notes_to_add.concat(this.inline_notes_to_add, this.regex_notes_to_add);
    }

    private tableNotes?: WeakSet<object>

    private tableIdPositions(): Set<number> | undefined {
        if (this.tableNotes) return new Set(this.regex_id_indexes.filter((_position, index) => this.tableNotes!.has(this.regex_notes_to_add[index])));
    }

    private pushPreviewNote<T extends CardPreviewCandidate['note']>(
        notes: T[], start: number | undefined, end: number, expression: string | undefined, explicitNoteBlock: boolean, note: T,
    ): number {
        if (expression === tableCardExpression) (this.tableNotes ??= new WeakSet()).add(note);
        if (expression && currentCardExpression(expression) === remNoteExpression && start !== undefined)
            applyRemNoteMetadata(expression, this.file.slice(start, end), note.fields, this.data.fields_dict[note.modelName]);
        if (this.previewCandidates && start !== undefined && start >= 0 && end > start) {
            this.previewCandidates.push({ start, end, note, explicitNoteBlock });
        }
        return notes.push(note);
    }

    private captureLinkedPreview<T extends { note: CardPreviewCandidate['note']; identifier?: number | null }>(
        parsed: T, start: number | undefined, end: number, authoredFields?: readonly string[], explicitNoteBlock = false,
    ): T {
        if (start !== undefined && start >= 0 && end > start) {
            this.previewCandidates?.push({ start, end, note: parsed.note, identifier: parsed.identifier ?? undefined, authoredFields, explicitNoteBlock });
        }
        return parsed;
    }

    private previewCapturedFields(model: string, match: RegExpMatchArray, searchId: boolean, searchTags: boolean): string[] {
        const names: string[] = this.data.fields_dict[model] ?? [];
        const count = match.length - 1 - Number(searchId) - Number(searchTags);
        return names.filter((_name, index) => index < count && match[index + 1] !== undefined);
    }

    idDateWarnings: AnkiIdDateWarning[] = []
    linkedBullets?: Array<LinkedBullet & { model: LinkedBulletModel }>
    private linkedBulletOverlap = (_start: number, _end: number): boolean => false
    markdownWarningLines: number[] = []

    private scanLinkedBulletCards(): void {
        const claimed = makeSpanLookup(this.ignore_spans)
        const linkedRanges: Array<[number, number]> = []
        let acceptedEnd = -Infinity
        for (const bullet of this.linkedBullets ?? []) {
            // Штатные START, STARTI и исключённые участки уже зарезервированы.
            if (claimed(bullet.start) || bullet.start < acceptedEnd) continue
            const { model, id, start, end } = bullet
            const sourceFields = linkedBulletSourceFields(bullet, model)

            const frozen = this.frozen_fields_dict?.[model.name]
            const linkField = this.data.file_link_fields?.[model.name]
            const contextField = this.data.context_fields?.[model.name]
            const generatedNames = [this.url && linkField, this.data.add_context && contextField];
            for (const name of generatedNames) {
                if (name && model.fieldNames.has(name) && !(name in sourceFields)) sourceFields[name] = "";
            }
            const match: RegExpMatchArray = [this.file.slice(start, end), ...Object.values(sourceFields), String(id)]
            const frozenFields = Object.fromEntries(Object.keys(sourceFields).map(field =>
                [field, field === "Front" || field === "Back" ? frozen?.[field] ?? "" : ""]))
            const parsed = new RegexNote(match, model.name, { [model.name]: Object.keys(sourceFields) }, false, true,
                this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter).parse(
                    this.target_deck, linkField && linkField in sourceFields ? this.url : "",
                    { [model.name]: frozenFields }, this.data,
                    this.data.add_context && contextField && contextField in sourceFields
                        ? this.getContextAtIndex(start) : "",
                )
            if (parsed.identifier !== id) continue
            this.notes_to_edit.push(this.previewCandidates ? this.captureLinkedPreview(parsed, start, end, Object.keys(sourceFields), false) : parsed)
            this.auditNoteRanges?.push([start, end])
            this.ignore_spans.push([start, end])
            linkedRanges.push([start, end])
            acceptedEnd = end
        }
        this.linkedBulletOverlap = makeSpanOverlap(linkedRanges)
    }

    // При обычном экспорте массив позиций не создаётся.
    auditNoteRanges?: Array<[number, number]>

    ignore_spans: [number, number][]
    custom_regexps: Record<string, string>
    inline_notes_to_add: AnkiConnectNote[]
    inline_id_indexes: number[]
    regex_notes_to_add: AnkiConnectNote[]
    regex_id_indexes: number[]

    constructor(file_contents: string, path:string, url: string, data: FileData, file_cache: CachedMetadata) {
        super(file_contents, path, url, data, file_cache)
        this.custom_regexps = data.custom_regexps
    }

    add_spans_to_ignore() {
        this.ignore_spans = []
        this.ignore_spans.push(...spans(this.data.FROZEN_REGEXP, this.file))
        const deck_result = this.file.match(this.data.DECK_REGEXP)
        if (deck_result) {
            this.ignore_spans.push([deck_result.index, deck_result.index + deck_result[0].length])
        }
        const tag_result = this.file.match(this.data.TAG_REGEXP)
        if (tag_result) {
            this.ignore_spans.push([tag_result.index, tag_result.index + tag_result[0].length])
        }
        this.ignore_spans.push(...spans(this.data.NOTE_REGEXP, this.file))
        this.ignore_spans.push(...spans(this.data.INLINE_REGEXP, this.file))
        const { code, math } = markdownSyntaxSpans(this.file)
        this.markdownWarningLines = suspiciousMathCardLines(this.file, math, code)
        this.markdownProtected = makeSpanLookup(code.concat(math))
        this.ignore_spans.push(...code, ...math)



    }

    setupScan() {
        this.setup_frozen_fields_dict()
        this.setup_target_deck()
        this.setup_global_tags()
        this.add_spans_to_ignore()
        this.notes_to_add = []
        this.inline_notes_to_add = []
        this.regex_notes_to_add = []
        this.id_indexes = []
        this.inline_id_indexes = []
        this.regex_id_indexes = []
        this.notes_to_edit = []
        this.notes_to_delete = []
    }

    scanNotes() {
        for (let note_match of this.file.matchAll(this.data.NOTE_REGEXP)) {
            if (this.acceptExplicitType?.(note_match[0], false) === false) continue
            if (this.markdownProtected(note_match.index ?? 0)) continue
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new Note(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.pushPreviewNote(this.notes_to_add, note_match.index, (note_match.index ?? -1) + note_match[0].length, undefined, true, parsed.note)
                this.id_indexes.push(position)
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                // Need to show an error otherwise
                else if (parsed.identifier == NOTE_TYPE_ERROR) {
                    console.warn("Did not recognise note type ", parsed.note.modelName, " in file ", this.path)
                } else {
                    console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                }
            } else {
                this.notes_to_edit.push(this.previewCandidates ? this.captureLinkedPreview(parsed, note_match.index, (note_match.index ?? -1) + note_match[0].length, undefined, true) : parsed)
                this.auditNoteRanges?.push([note_match.index, note_match.index + note_match[0].length])
            }
        }
    }

    scanInlineNotes() {
        for (let note_match of this.file.matchAll(this.data.INLINE_REGEXP)) {
            if (this.acceptExplicitType?.(note_match[0], true) === false) continue
            if (this.markdownProtected(note_match.index ?? 0)) continue
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new InlineNote(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.pushPreviewNote(this.inline_notes_to_add, note_match.index, (note_match.index ?? -1) + note_match[0].length, undefined, false, parsed.note)
                this.inline_id_indexes.push(position)
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                // Need to show an error
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
            } else {
                this.notes_to_edit.push(this.previewCandidates ? this.captureLinkedPreview(parsed, note_match.index, (note_match.index ?? -1) + note_match[0].length, undefined, false) : parsed)
                this.auditNoteRanges?.push([note_match.index, note_match.index + note_match[0].length])
            }
        }
    }

    search(note_type: string, regexp_str: string, matchesByPattern: ReadonlyMap<string, readonly RegExpMatchArray[]>) {
        //Search the file for regex matches
        //ignoring matches inside ignore_spans,
        //and adding any matches to ignore_spans.
        for (let search_id of [true, false]) {
            for (let search_tags of [true, false]) {
                const pattern = this.customRegexpPattern(regexp_str, search_id, search_tags);
                const matches = matchesByPattern.get(customRegexpKey(pattern));
                if (!matches) throw new Error("Missing Custom Regexp worker result.");for (let match of checkedCustomAnkiMatches(matchesOutsideSpans(matches, this.file, this.ignore_spans), this.file, search_id, this.idDateWarnings, (start, end) => this.tableOwnsRange?.(start, end) || this.multilineOwnsRange?.(start, end, note_type) || this.presetStartBlocked?.(start) || this.linkedBulletOverlap(start, end))) {
                    this.ignore_spans.push([match.index, match.index + match[0].length])
                    const parsed: AnkiConnectNoteAndID = new RegexNote(
                        copyMatchForRegexNote(match), note_type, this.data.fields_dict,
                        search_tags, search_id, this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter
                    ).parse(
                        this.target_deck,
                        this.url,
                        this.frozen_fields_dict,
                        this.data,
                        this.data.add_context ? this.getContextAtIndex(match.index) : ""
                    )
                    if (search_id) {
                        if (!(this.data.EXISTING_IDS.includes(parsed.identifier))) {
                            if (parsed.identifier == CLOZE_ERROR) {
                                // This means it wasn't actually a note! So we should remove it from ignore_spans
                                this.ignore_spans.pop()
                                continue
                            }
                            console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                        } else {
                            { const remNoteFields = applyRemNoteMetadata(regexp_str, match[0], parsed.note.fields, this.data.fields_dict[note_type]); this.notes_to_edit.push(this.previewCandidates ? this.captureLinkedPreview(parsed, match.index, (match.index ?? -1) + match[0].length, [...this.previewCapturedFields(parsed.note.modelName, match, search_id, search_tags), ...remNoteFields], false) : parsed) }
                this.auditNoteRanges?.push([match.index, match.index + match[0].length])
                        }
                    } else {
                        if (parsed.identifier == CLOZE_ERROR) {
                            // This means it wasn't actually a note! So we should remove it from ignore_spans
                            this.ignore_spans.pop()
                            continue
                        }
                        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                        this.pushPreviewNote(this.regex_notes_to_add, match.index, (match.index ?? -1) + match[0].length, regexp_str, false, parsed.note)
                        this.regex_id_indexes.push(match.index + match[0].length)
                    }
                }
            }
        }
    }

    private async scanBlockFormats(options?: CustomRegexpOptions, pageOnly = false) {
        this.setupScan()
        this.scanNotes()
        this.scanInlineNotes()
        this.scanLinkedBulletCards()
        const patterns: CustomRegexpPattern[] = [];
        for (const noteType in this.custom_regexps) {
            const expression = this.custom_regexps[noteType];
            if (pageOnly || !expression || expression === pageCardExpression) continue;
            for (const hasId of [true, false]) for (const hasTags of [true, false]) {
                patterns.push(this.customRegexpPattern(expression, hasId, hasTags, noteType));
            }
        }
        const matchesByPattern = patterns.length ? await matchCustomRegexps(this.file, patterns, options) : new Map();
        let guard: ((start: number) => boolean) | undefined;
        if (!pageOnly && Object.values(this.custom_regexps ?? {}).includes(tableCardExpression)) {
            const conflicts = tableIdConflicts(this.file, start => (guard ??= presetStartGuard(this.file, this.ignore_spans))(start));
            if (conflicts.length) { this.tableIdWarnings = conflicts; this.tableOwnsRange = makeSpanOverlap(conflicts.map(({ start, end }) => [start, end])); }
        }
        let wizardGuard: ((start: number) => boolean) | undefined;
        if (!pageOnly && patterns.length > 4) checkWizardRowModels(this.file, this.custom_regexps,
            (model, expression) => matchesByPattern.get(customRegexpKey(this.customRegexpPattern(expression, false, false, model))) ?? [],
            () => {
                const blocked = wizardGuard = wizardStartGuard(this.file, this.ignore_spans, [this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]);
                return (from, to) => blocked(from) || this.linkedBulletOverlap(from, to) || !!this.multilineOwnsRange?.(from, to);
            });
        for (let note_type in this.custom_regexps) {
            if (pageOnly || this.custom_regexps[note_type] === pageCardExpression) continue;
            this.presetStartBlocked = readDelimitedRule(this.custom_regexps[note_type])
                ? (wizardGuard ??= wizardStartGuard(this.file, this.ignore_spans, [this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]))
                : namedCardExpressions.has(currentCardExpression(this.custom_regexps[note_type]))
                ? (guard ??= presetStartGuard(this.file, this.ignore_spans)) : undefined;
            const regexp_str: string = this.custom_regexps[note_type]
            if (regexp_str) {
                this.search(note_type, regexp_str, matchesByPattern)
            }
        }
        this.all_notes_to_add = this.notes_to_add.concat(this.inline_notes_to_add).concat(this.regex_notes_to_add)
        this.scanDeletions()
    }

    private customRegexpPattern(regexp_str: string, search_id: boolean, search_tags: boolean, label?: string): CustomRegexpPattern {
        const id = search_id ? String.raw`(?:\r?\n)?` + ankiIdRegexpSource : "";
        const tags = search_tags ? TAG_REGEXP_STR : "";
        return { source: cardRegexpWithSuffix(regexp_str, tags, id), flags: "gm", label };
    }
    tableIdWarnings?: Array<{ line: number; id: number }>
    private tableOwnsRange?: (start: number, end: number) => boolean
    private presetStartBlocked?: (start: number) => boolean
    private multilineOwnsRange?: MultilineOwnership
    pageCard?: PageCard | null
    private namedFieldProtection?: Map<string, ReadonlySet<string> | undefined>

    namedSyncFrozenFields(model: string): ReadonlySet<string> | undefined {
        // Общие значения уже разобраны штатным экспортёром. На одну заметку и модель
        // проверяем их один раз, в том числе если в заметке тысячи блоков START/END.
        if (this.pageCard?.sharedFields && this.pageCard.model === model) {
            this.namedFieldProtection ??= new Map<string, ReadonlySet<string> | undefined>();
            if (!this.namedFieldProtection.has(model)) this.namedFieldProtection.set(model, new Set(this.pageCard.sharedFields.values.keys()));
            return this.namedFieldProtection.get(model);
        }
        const dictionary = this.frozen_fields_dict;
        if (!dictionary || !Object.prototype.hasOwnProperty.call(dictionary, model)) return;
        const cache = this.namedFieldProtection ??= new Map<string, ReadonlySet<string> | undefined>();
        if (!cache.has(model)) {
            const names = Object.entries(dictionary[model]).filter(([, value]) =>
                typeof value === "string" && value !== "").map(([name]) => name);
            cache.set(model, names.length ? new Set(names) : undefined);
        }
        return cache.get(model);
    }

    async scanFile(options?: CustomRegexpOptions): Promise<void> {
        const page = this.pageCard === undefined ? readPageCard(this.original_file, this.custom_regexps ?? {}, undefined, this.data.page_model) : this.pageCard;
        if (!page) {
            this.multilineOwnsRange = this.file.includes(':::anki') ? multilineOwnership(this.file, this.custom_regexps ?? {}, [this.data.NOTE_REGEXP,
                this.data.INLINE_REGEXP, this.data.EMPTY_REGEXP, this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]) : undefined;
            return this.scanBlockFormats(options);
        }
        this.pageCard = page;
        // Validate the target before allowing Anki to create a note with nowhere to save its ID.
        if (page.id === undefined) {
            if (page.unlinkedControl) {
                throw new Error("Link this page first: remove the command below the heading, export to get an ID, then put the command back. / Сначала свяжите страницу: уберите команду под заголовком, экспортируйте для получения ID, затем верните команду.");
            }
            if (this.data.page_id_location === 'after-answer') insertPageFooterId(this.original_file, 1);
            else if (this.data.page_id_location !== 'heading') validatePageYamlPlacement(this.original_file);
        }
        const rangeStart = page.idLocation === 'yaml' ? 0 : page.start;
        // Initialize the normal deck, frozen fields and formatter. The page owns its entire body.
        const saved = this.original_file;
        const linked = this.linkedBullets;
        this.linkedBullets = [];
        this.file = "";
        try { await this.scanBlockFormats(options, true); }
        finally { this.file = saved; this.linkedBullets = linked; }
        if (this.all_notes_to_add.length || this.notes_to_edit.length || this.notes_to_delete.length) {
            throw new Error("Unexpected nested card in whole-page mode.");
        }
        const names = this.data.fields_dict[page.model];
        if (!names || names.length < 2) throw new Error("Page cards need an Anki note type with at least two fields.");
        const layout = page.fieldPair;
        if (layout ? page.id === undefined || !isLinkedPageSchema(page.model, names, layout) :
            page.model === "ob-deck-basic" || names[0] === "ob-deck-id" || page.linkedRoute && needsLinkedPageLayout(names)) {
            throw new Error("Verify the linked page layout and note fields. / Проверьте формат и поля связанной страницы.");
        }
        if (page.linkedRoute) this.target_deck = page.linkedRoute.deck;
        const sourceFields = pageExportFieldNames(page, names, {
            file: this.data.file_link_fields?.[page.model], context: this.data.context_fields?.[page.model],
            addFile: !!this.url, addContext: !!this.data.add_context,
        }, this.frozen_fields_dict?.[page.model]);
        const authoredFields = sourceFields.authored;
        const selected = sourceFields.selected;
        const frozen = { [page.model]: Object.fromEntries(selected.map(name =>
            [name, page.sharedFields?.values.has(name) ? "" : this.frozen_fields_dict?.[page.model]?.[name] ?? ""])) };
        const match: RegExpMatchArray = [saved.slice(page.start, page.answerBoundary ?? page.end), page.front, page.back,
            ...selected.slice(2).map(name => page.sharedFields?.values.get(name) ?? page.namedFields?.get(name)?.value ?? "")];
        if (page.id !== undefined) match.push(String(page.id));
        match.index = page.start;
        const parsed = new RegexNote(match, page.model, { [page.model]: selected }, false, page.id !== undefined,
            this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter).parse(
                this.target_deck, sourceFields.file ? this.url : "", frozen, this.data,
                sourceFields.context ? pageSourceContext(this.path, page.front) : "");
        parsed.note.tags = pageContentTags(parsed.note.tags);
        if (selected.some(name => typeof parsed.note.fields[name] !== "string")) {
            throw new Error("Incomplete page fields. / Не удалось подготовить поля страницы.");
        }
        parsed.note.fields = Object.fromEntries(selected.map(name => [name, parsed.note.fields[name]]));
        if (page.id !== undefined) {
            if (parsed.identifier !== page.id) throw new Error("The page ID could not be verified.");
            this.notes_to_edit.push(parsed);
            this.auditNoteRanges?.push([rangeStart, page.end]);
        } else {
            this.regex_notes_to_add.push(parsed.note);
            this.regex_id_indexes.push(page.insertion);
            this.all_notes_to_add = this.regex_notes_to_add.slice();
        }
        this.previewCandidates?.push({ start: rangeStart, end: page.end, note: parsed.note,
            identifier: page.id, authoredFields,
            generatedFields: [sourceFields.file, sourceFields.context].filter((name): name is string => !!name) });
    }

    fix_newline_ids() {
        this.file = this.file.replace(double_regexp, "$1")
    }

    writeIDs() {
        if (this.pageCard) {
            const id = this.note_ids[0];
            if (id != null) this.file = writePageId(this.file, this.pageCard, id, this.data.comment,
                this.data.id_date ? formatLocalIdDate(new Date()) : undefined, this.data.page_id_location);
            return;
        }
        // Вычисляем дату один раз для всех новых ID в этом файле.
        const date = this.data.id_date && this.note_ids.some(Boolean) ? formatLocalIdDate(new Date()) : undefined
        let normal_inserts: [number, string][] = []
        this.id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index]
                if (identifier) {
                    normal_inserts.push([id_position, id_to_str(identifier, false, this.data.comment, date)])
                }
            }
        )
        let inline_inserts: [number, string][] = []
        this.inline_id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index + this.notes_to_add.length] //Since regular then inline
                if (identifier) {
                    inline_inserts.push([id_position, ((id_position > 0 && /\S/.test(this.file[id_position - 1])) ? " " : "") + id_to_str(identifier, true, this.data.comment, date)])
                }
            }
        )
        let regex_inserts: [number, string][] = []
        this.regex_id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index + this.notes_to_add.length + this.inline_notes_to_add.length] // Since regular then inline then regex
                if (identifier) {
                    regex_inserts.push([id_position, "\n" + id_to_str(identifier, false, this.data.comment, date)])
                }
            }
        )
        this.file = string_insert(this.file, normal_inserts.concat(inline_inserts).concat(regex_inserts), this.tableIdPositions())
        this.fix_newline_ids()
    }
}
