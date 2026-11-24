import { Md5 } from 'ts-md5'
import type { CustomRegexpOptions } from './custom-regexp-worker'
import { filteredMoveTargets, findOpenNotesForUpdate, matchesReviewedAnkiEvidence, prepareExistingNoteChanges, readReviewedNoteSnapshots, readUnfilteredMoveSources, snapshotFields, snapshotKey, verifyExistingNoteFieldWrites } from './anki-delta'
import type { ExistingNoteSource, ExportDeckMove, ExportFieldPreview, NoteSnapshot, OneWayFieldConflict, ReviewedAnkiEvidence } from './anki-delta'
import type { VerifiedCardImpact } from './anki-card-impact'
import { cursorCardOffset, retainCursorCard, staleCursorCard } from './cursor-card'
import type { CursorCardTarget } from './cursor-card'
import { exportOperationKey, oneWayFieldChoice } from './export-plan'
import type { ExportPreviewOperation, ExportPreviewSelection } from './export-plan'
import { mayHaveSuspendMarker, readSuspendMarkers } from './suspend-marker'
import { oneWaySuspendChange, ownedSuspendMarks } from './oneway-suspend'
import type { OneWaySuspendMark, SuspendChange } from './oneway-suspend'
import { readSuspendCards } from './suspend-anki'
import type { SuspendCard } from './suspend-anki'
import { oneWayTagKey } from './oneway-history'
import type { OneWayHistory, OneWayReceipt } from './oneway-history'
import type { DeckRouteOrigin } from './deck-routes'
import { findLinkedBullets, readLinkedBulletModels } from './linked-bullets'
import type { LinkedBullet, LinkedBulletModel } from './linked-bullets'
import { cardSourceFieldPatch } from './card-source-link-fields'
import { applyMedia, hasMediaAlias, mediaNames, mediaNeedsReview, mediaWillWrite, planMedia, plannedMediaAliases, retiredMediaMarker } from './media-sync'
import type { MediaIndex, MediaPlan } from './media-sync'
import type { ImageOptimizationSettings } from './image-optimizer'
import * as diagnosticPatterns from './constants'
import { duplicateFirstFieldSlots, duplicateFirstFieldSources, inspectCardSources, mayHaveCardMarkers } from './card-export-diagnostics'
import type { CardRange, ExportCardIssue } from './card-export-diagnostics'
import { collectionDuplicateOptions, DuplicatePreflight } from './duplicate-preflight'
import { ankiIdNumberTokens, dateLinkedMarkers, formatLocalIdDate } from './anki-id-marker'
import type { SeparatorRepair } from './card-format-presets'
import { readSuspendLine } from './suspend-label'
import { findIdMarkers } from './duplicate-markers'
import { activeCardMarkdown } from './archived-card'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { explicitDeletes, cleanConfirmedDeletes, deletionPresence, localDeleteEffect } from './deletion-source'
import type { LocalDeleteEffect } from './deletion-source'
import type { AfterDeleteMode } from './deletion-policy'
import type { BackupCheck } from './vault-backup'
import { AnkiProfileError } from './anki-profile'
import { pendingRecoveryProfileProblem } from './export-recovery'
import { rewriteImageFields } from './image-field-links'
import type { OptimizedImagePreview } from './export-review-ui'
import { findMarkdownSyntaxSpans } from './markdown-pipeline'
import { addRecoveryMarker, hasRecoveredLinks, isRecoveryTag, newRecoveryToken, noteRecoverySignature, readRecoveryMarker, readRecoverySlots, recoveryMarkerTokens, recoveryTag } from './export-recovery'
import type { ExportRecovery, RecoveryEntry, RecoveryPlan, RecoverySlot } from './export-recovery'
import { isUnsentExportResponse, sendExportBatches } from './export-batch'
import type { SyncHistoryChange } from './sync-change-history'
export type ExportConfirmedAction = 'add' | 'edit' | 'delete' | 'suspend' | 'tags' | 'move' | 'link' | 'cleanup' | 'normalize' | 'unsuspend'
import type { ExportOperationJournal, JournalSource } from './export-operation-journal'
import { ankiBrowseMessage } from './interface-language'
import { withAnkiDeadline } from './anki-transport'
import { ankiStudyDeckKey, readFilteredAnkiDecks } from './anki-study-state'
import { lookupRecoveryNotes } from './recovery-lookup'
import { cardAtOffset, applyAuthoredTags, authoredFieldNames, frontmatterBounds, frontmatterTags, mergeTags, parsePortableMarkdown, portableCardExportRuleRoute, portableDeckRoute, portableFileExportRules } from './portable-parser'
export { frontmatterTags, mergeTags } from './portable-parser'

type DuplicateSourceRows = { before: string; ranges: (CardRange | undefined)[]; issues: ExportCardIssue[]; slots?: ReadonlySet<number> };

function recoverySlotLines(file: AllFile): (number | null)[] {
    const positions = file.id_indexes.concat(file.inline_id_indexes, file.regex_id_indexes);
    const offsets = file.all_notes_to_add.map((_note, index) => ({
        index, offset: Number.isSafeInteger(positions[index]) && positions[index] <= file.original_file.length + 1
            ? Math.max(0, positions[index] - 1) : -1,
    })).filter(item => item.offset >= 0).sort((left, right) => left.offset - right.offset);
    const lines: (number | null)[] = file.all_notes_to_add.map(() => null);
    let line = 1;
    let from = 0;
    for (const { index, offset } of offsets) {
        while (from < offset) if (file.original_file[from++] === "\n") line++;
        lines[index] = line;
    }
    return lines;
}

function collectNoteIds(content: string): number[] {
    return ankiIdNumberTokens(content.includes('RUDONIUM-ARCHIVE') ? activeCardMarkdown(content) : content)
        .filter(id => Number.isSafeInteger(id) && id > 0)
}

function isAnkiRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fastResult(response: unknown): unknown {
    if (typeof response === "object" && response !== null &&
        "result" in response && "error" in response) {
        if (response.error === null) return response.result;
    }
    return undefined;
}

function checkFastResponses(
    requests: AnkiConnect.AnkiConnectRequest[], responses: unknown, errors: string[], location: string
): void {
    if (!Array.isArray(responses)) {
        errors.push(location + ": response was not an array");
        return;
    }
    if (responses.length !== requests.length) {
        errors.push(location + ": expected " + requests.length + " responses, got " + responses.length);
    }
    requests.forEach((request, index) => {
        const response: unknown = responses[index];
        const result = fastResult(response);
        const name = location + " / " + request.action + "[" + (index + 1) + "]";
        if (result === undefined) {
            const error = response && typeof response === "object" && "error" in response ? response.error : undefined;
            const deferred = typeof error === "string" && /^This action was not sent\. (Anki Browse: ID |Deck type unverified: )/.test(error);
            errors.push(deferred ? error.slice("This action was not sent. ".length) : name + ": " + (error ?? "missing or malformed response"));
        } else if (request.action === "multi") {
            checkFastResponses(request.params.actions, result, errors, name);
        } else if (request.action === "addNote" &&
            (typeof result !== "number" || !Number.isSafeInteger(result) || result <= 0)) {
            errors.push(name + ": missing note ID");
        }
    });
}

/*Class for managing a list of files, and their Anki requests.*/
import { ParsedSettings } from './interfaces/settings-interface'
import { App, TFile } from 'obsidian'
import { AllFile } from './file'
import * as AnkiConnect from './anki'


export class FileManager {
    checkedHashes = new Map<string, string>()
    recognizedCards = 0
    readonly suspensionHints = new Set<string>()
    readonly staleSuspensionSources = new Set<string>()
    private readonly suspensionMarks = new Map<string, OneWaySuspendMark[]>()
    suspendOnly?: ReadonlySet<string>
    applySuspension?: (expected: ReadonlyMap<number, readonly SuspendCard[]>, targets: ReadonlyMap<number, ReadonlySet<number>>,
        guard: () => Promise<void>, onVerified?: (action: 'suspend' | 'unsuspend', cards: readonly number[]) => void,
        onUnconfirmed?: (action: 'suspend' | 'unsuspend', cards: readonly number[]) => void) => Promise<void>
    private existingChanges = new Map<string, AnkiConnect.AnkiConnectRequest[]>()
    private previewDeckMoves = new Map<string, ExportDeckMove[]>()
    private linkedSnapshots = new Map<number, NoteSnapshot>()
    mediaIndex: MediaIndex = new Map()
    imageOptimization?: ImageOptimizationSettings
    beforeDeletion?: () => Promise<void>
    deletionOwnership?: (owners: ReadonlyMap<string, readonly number[]>) => Promise<void>
    forgetConfirmedDeletions?: (ids: Set<number>) => Promise<void>
    deletionGuard?: () => void
    deletedArchiveLabel?: string
    afterDeleteMode: AfterDeleteMode = 'keep'
    trashDeletedPages = false
    private absentDeletes = new Set<number>()
    private readonly deleteEffects = new WeakMap<AllFile, ReadonlyMap<number, LocalDeleteEffect>>()
    beforeMutation?: () => Promise<BackupCheck>
    ankiProfile?: string
    checkAnkiProfile?: (confirmCommitted?: boolean) => Promise<string>
    recoveryRevision?: () => number
    recoveryIdMarkers?: (text: string) => readonly { id: number }[]
    onWriteRequest?: (answered: boolean) => void
    onConfirmedNote?: (action: Exclude<ExportConfirmedAction, 'unsuspend'> | 'status', id: number) => void
    onSyncChange?: (row: Omit<SyncHistoryChange, 'profile' | 'mode'>) => void
    private readonly moveOwners = new WeakMap<AnkiConnect.AnkiConnectRequest, number>()
    private readonly deletedFields = new Map<number, [string, string][]>()
    private changeTitles?: Map<number, string>
    private changeTitle(id: number): string | undefined {
        if (!this.changeTitles) {
            this.changeTitles = new Map()
            for (const file of this.ownFiles) for (const { identifier, note } of file.notes_to_edit) {
                const first = this.data.fields_dict?.[note.modelName]?.[0]
                if (first && note.fields[first]) this.changeTitles.set(identifier, note.fields[first])
            }
        }
        return this.changeTitles.get(id)
    }
    private confirmedNote(action: ExportConfirmedAction, id: number, path: string,
        fields?: () => NonNullable<SyncHistoryChange['fields']>): void {
        this.onConfirmedNote?.(action === 'unsuspend' ? 'status' : action, id)
        this.onSyncChange?.({ action, direction: action === 'normalize' || action === 'cleanup' ? 'local' :
            action === 'link' ? 'to-obsidian' : 'to-anki', title: this.changeTitle(id),
            path, noteId: id, fields: fields?.() })
    }
    operationJournal?: ExportOperationJournal
    profileBlocked?: AnkiProfileError
    recoveredCreations = 0
    mediaConfirmed = new Set<string>()
    mediaByNote = new Map<string, ReadonlySet<string>>()
    isStillCurrent?: (path: string) => boolean
    confirmedDeletions?: ReadonlyMap<string, ReadonlySet<number>>
    confirmedDeckMoves?: ReadonlyMap<string, readonly ExportDeckMove[]>
    oneWayHistory?: OneWayHistory
    confirmedFields?: ReadonlySet<string>
    cursorCard?: CursorCardTarget
    cursorRecovery?: { path: string; token: string }
    previewSelection?: ExportPreviewSelection
    readonly previewSuppressed = new Set<string>()
    private readonly previewOperations = new Map<string, ExportPreviewOperation[]>()
    private readonly previewObserved = new Map<string, Set<string>>()
    private readonly reviewedRequests = new Map<AnkiConnect.AnkiConnectRequest, readonly ReviewedAnkiEvidence[]>()
    private readonly reviewedStudyCards = new Map<AnkiConnect.AnkiConnectRequest, readonly number[]>()
    private readonly namedLayouts = new Map<number, import('./oneway-history').OneWayNamedLayout>()
    readonly cardImpactResults: VerifiedCardImpact[] = []
    readonly oneWayReceipts: OneWayReceipt[] = []
    readonly verifiedWriteReceipts: OneWayReceipt[] = []
    readonly verifiedCreationLinks: Array<{ path: string; noteId: number; tag: string }> = []
    private readonly previewFieldConflicts = new Map<string, OneWayFieldConflict[]>()
    private readonly previewKeptAnkiFields = new Map<string, ExportFieldPreview[]>()
    getRecovery?: () => Promise<ExportRecovery>
    onMarkdownWriteVerified?: (path: string, pendingMarker: boolean) => void
    stopAfterPacket?: () => boolean
    writeUncertain?: string
    blockedUpdates = new Map<string, string>()
    retryPaths = new Set<string>()
    retryMessages = new Set<string>()
    diagnosticSyntax?: DuplicateMarkerSyntax
    readonly cardIssues = new Map<string, ExportCardIssue[]>()
    duplicatePreflight?: DuplicatePreflight
    sourceHashes = new Map<string, string>()
    private recoverySources = new Map<string, { token: string; raw: string; cleanHash: string }>()
    readCount = 0
    parseCount = 0
    idDateWarnings: Array<{ path: string; id: number; line: number; message: string; russianMessage: string }> = []
    scanErrors: string[] = []
    importErrors: string[] = []

    private retry(path: string, message: string): void {
        this.retryPaths.add(path)
        this.retryMessages.add(path + ": " + message)
    }

    private recordCardIssue(path: string, issue: ExportCardIssue): void {
        const issues = this.cardIssues.get(path) ?? []
        issues.push(issue)
        this.cardIssues.set(path, issues)
        this.retry(path, issue.message)
    }

    app: App
    data: ParsedSettings
    files: TFile[]
    ownFiles: Array<AllFile>
    file_hashes: Record<string, string>
        added_media_set: Set<string>

    constructor(app: App, data:ParsedSettings, files: TFile[], file_hashes: Record<string, string>, added_media: string[]) {
        this.app = app
        this.data = data

        this.files = files;

        this.ownFiles = []
        this.file_hashes = file_hashes
        this.added_media_set = new Set(added_media)
    }
    getUrl(file: TFile): string {
        return "obsidian://open?vault=" + encodeURIComponent(this.data.vault_name) + String.raw`&file=` + encodeURIComponent(file.path)
    }

    

    

    

    

    

    async parseMarkdown(file: TFile, content: string, ids: number[], audit = false,
        models: ReadonlyMap<number, LinkedBulletModel> = new Map(), bullets = findLinkedBullets(content, false, this.diagnosticSyntax),
        preview = false, metadata?: import('obsidian').CachedMetadata, trackRanges = false, noteTypes?: ReadonlySet<string>,
        regexpOptions?: CustomRegexpOptions): Promise<AllFile> {
        this.parseCount++;
        return parsePortableMarkdown(this.app, this.data, file, content, ids, {
            audit, models, bullets, preview, metadata, trackRanges, noteTypes, syntax: this.diagnosticSyntax, regexpOptions,
        });
    }

    async initialiseFiles(
        resolveIds: (ids: ReadonlySet<number>) => Promise<number[]>,
        expectedEditorText: ReadonlyMap<string, string> = new Map(),
        scan: { textByPath: ReadonlyMap<string, string>; fullExport: ReadonlySet<string>;
            duplicates: ReadonlyMap<number, string>; conflictingPaths: ReadonlyMap<string, ReadonlySet<number>>;
            expectedPreviewHashes?: ReadonlyMap<string, string> } = {
                textByPath: new Map(), fullExport: new Set(), duplicates: new Map(), conflictingPaths: new Map(),
            },
    ) {
        this.linkedSnapshots.clear();
        this.recoverySources.clear();
        const changed: Array<{
            file: TFile; path: string; content: string; hash: string; mtime: number; size: number;
            tags: string[]; bullets: LinkedBullet[]; ids: number[];
        }> = [];
        const readLimit = 8;
        for (let offset = 0; offset < this.files.length; offset += readLimit) {
            const batch = await Promise.all(this.files.slice(offset, offset + readLimit).map(async file => {
                const path = file.path;
                const { mtime, size } = file.stat;
                let content: string;
                try {
                    const preloaded = scan.textByPath.get(path);
                    if (preloaded !== undefined) content = preloaded;
                    else {
                        this.readCount++;
                        content = await this.app.vault.read(file);
                    }
                    const expected = expectedEditorText.get(path);
                    if (expected !== undefined && content.replace(/\r\n/g, "\n") !== expected.replace(/\r\n/g, "\n")) {
                        this.scanErrors.push(path + ": editor changes have not reached the file yet. Run the scan again after saving.");
                        return undefined;
                    }
                } catch (error) {
                    this.scanErrors.push(path + ": " + String(error));
                    return undefined;
                }
                if (file.path !== path || file.stat.mtime !== mtime || file.stat.size !== size) {
                    this.scanErrors.push(path + ": file changed during the read");
                    return undefined;
                }
                const hash = Md5.hashStr(content);
                if (scan.expectedPreviewHashes && scan.expectedPreviewHashes.get(path) !== hash) {
                    this.scanErrors.push(path + ": Markdown changed after the preview. Open Preview Export again.");
                    return undefined;
                }
                try {
                    const marker = readRecoveryMarker(content);
                    if (this.cursorRecovery && (path !== this.cursorRecovery.path || marker?.token !== this.cursorRecovery.token)) throw staleCursorCard();
                    if (this.cursorCard && marker) throw new Error("Review Pending Anki Creations before syncing a single card. / Сначала проверьте незавершённое создание записей.");
                    if (marker) {
                        this.recoverySources.set(path, { token: marker.token, raw: content, cleanHash: Md5.hashStr(marker.clean) });
                        content = marker.clean;
                    }
                } catch (error) {
                    this.scanErrors.push(path + ": " + String(error));
                    return undefined;
                }
                const sameHash = Object.prototype.hasOwnProperty.call(this.file_hashes, path) &&
                    hash === this.file_hashes[path];
                if (!sameHash && this.suspendOnly?.has(path)) {
                    this.staleSuspensionSources.add(path);
                    this.scanErrors.push(path + ": Markdown changed without a file event. Retry export to refresh Anki ID ownership.");
                    return undefined;
                }
                if (sameHash && !this.recoverySources.has(path) && !scan.fullExport.has(path) && !scan.conflictingPaths.has(path) &&
                    !mayHaveSuspendMarker(content, this.diagnosticSyntax)) {
                    this.checkedHashes.set(path, hash);
                    return undefined;
                }
                let tags: string[];
                try {
                    tags = frontmatterTags(content);
                } catch (error) {
                    this.scanErrors.push(path + ": invalid YAML frontmatter: " + String(error));
                    return undefined;
                }
                try {
                    return { file, path, content, hash, mtime, size, tags,
                        bullets: findLinkedBullets(content, false, this.diagnosticSyntax), ids: collectNoteIds(content) };
                } catch (error) {
                    // An unresolved link in this file must not cancel the other reads in this batch.
                    this.scanErrors.push(path + ": " + String(error));
                    return undefined;
                }
            }));
            for (const entry of batch) {
                if (entry) changed.push(entry);
            }
        }

        this.ownFiles = [];
        this.files = [];
        if (!changed.length) return;
        const requested = new Set<number>();
        const linkedIds = new Set<number>();
        for (const entry of changed) {
            for (const id of entry.ids) if (!this.cursorCard || this.cursorCard.id === id) requested.add(id);
            for (const bullet of entry.bullets) if (!this.cursorCard || this.cursorCard.id === bullet.id) linkedIds.add(bullet.id);
        }
        let existingIds: Set<number> | undefined;
        let linkedModels: Map<number, LinkedBulletModel>;
        try {
            linkedModels = await readLinkedBulletModels(linkedIds, this.linkedSnapshots);
        } catch {
            this.linkedSnapshots.clear();
            const confirmed = new Set(await resolveIds(requested));
            existingIds = confirmed;
            const knownLinks = new Set(Array.from(linkedIds).filter(id => confirmed.has(id)));
            linkedModels = await readLinkedBulletModels(knownLinks, this.linkedSnapshots);
        }
        if (!existingIds) {
            const confirmed = new Set(linkedModels.keys());
            const unconfirmed = new Set(Array.from(requested).filter(id => !confirmed.has(id)));
            for (const id of await resolveIds(unconfirmed)) confirmed.add(id);
            existingIds = confirmed;
        }
        const noteTypes = new Set(Object.keys(this.data.fields_dict));
        const captureCustomRanges = Object.values(this.data.custom_regexps).some(Boolean);
        for (const { file, path, content, hash, mtime, size, tags, bullets, ids } of changed) {
            if (this.stopAfterPacket?.()) break;
            try {
                if (file.path !== path || file.stat.mtime !== mtime || file.stat.size !== size) {
                    this.scanErrors.push(path + ": file changed before import");
                    continue;
                }
                const inspectMarkers = mayHaveCardMarkers(content, this.diagnosticSyntax);
                const inspectSuspension = mayHaveSuspendMarker(content, this.diagnosticSyntax);
                const commands = explicitDeletes(content, this.diagnosticSyntax ?? {}, this.data.custom_regexps, this.data.page_model,
                    [this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]);
                if (commands && inspectSuspension) readSuspendMarkers(content, this.diagnosticSyntax);
                if (commands && this.recoverySources.has(path)) throw new Error("Finish the pending creation before applying deletion commands.");
                const parsingText = commands?.masked ?? content;
                const scanned = await this.parseMarkdown(file, parsingText, ids, false, linkedModels, bullets,
                    false, undefined, !!this.cursorCard || this.recoverySources.has(path) || inspectMarkers || inspectSuspension || captureCustomRanges, inspectMarkers ? noteTypes : undefined,
                    { shouldStop: this.stopAfterPacket });
                if (commands) {
                    scanned.original_file = content;
                    scanned.file = content;
                    scanned.notes_to_delete = commands.directives.map(d => d.id);
                    this.deleteEffects.set(scanned, new Map(commands.directives.map(d =>
                        [d.id, localDeleteEffect(d, this.afterDeleteMode, this.trashDeletedPages)] as const)));
                    if (commands.directives.some(d => !d.card && !d.detached)) {
                        scanned.removeUnsafeNewCards(new Set(scanned.all_notes_to_add));
                    }
                } else scanned.notes_to_delete = [];
                this.recognizedCards += scanned.all_notes_to_add.length + scanned.notes_to_edit.length + scanned.notes_to_delete.length;
                let targetOffset: number | undefined;
                if (this.cursorCard) {
                    targetOffset = cursorCardOffset(this.cursorCard, path, content);
                    if (this.cursorCard.id !== undefined && !existingIds.has(this.cursorCard.id)) throw new Error("Linked Anki note is missing. / Связанная запись Anki не найдена.");
                } else if (this.recoverySources.has(path)) {
                    const source = this.recoverySources.get(path)!;
                    const pending = (await this.getRecovery?.())?.byToken(source.token);
                    if (this.cursorRecovery && (pending?.cursorOffset === undefined || pending.ankiProfile !== this.ankiProfile ||
                        pending.path !== path || pending.sourceHash !== source.cleanHash || pending.formerPath)) throw staleCursorCard();
                    if (pending?.cursorOffset !== undefined && pending.path === path && pending.sourceHash === source.cleanHash) {
                        targetOffset = pending.cursorOffset;
                        this.previewSuppressed.add(path);
                    }
                }
                const selected = targetOffset === undefined ? undefined : cardAtOffset(scanned, content, targetOffset);
                if (targetOffset !== undefined) {
                    if (!selected || (!this.cursorCard && selected.identifier !== undefined)) throw staleCursorCard();
                    retainCursorCard(scanned, selected, this.cursorCard);
                }
                const lineOf = (at: number) => content.slice(0, at).split(String.fromCharCode(10)).length;
                const startLine = selected && lineOf(selected.start);
                const endLine = selected && lineOf(selected.end);
                const inRange = (line: number) => startLine === undefined || endLine === undefined || startLine <= line && line <= endLine;
                for (const warning of scanned.idDateWarnings ?? []) if (inRange(warning.line)) this.idDateWarnings.push({ path, ...warning });
                for (const line of scanned.markdownWarningLines) {
                    if (!inRange(line)) continue;
                    this.recordCardIssue(path, { code: "protected-block", line, message: "Line " + line + " looks like a card inside a math block." });
                }
                const conflicts = new Set([
                    ...(targetOffset === undefined ? scan.conflictingPaths.get(path) ?? [] : []),
                    ...scanned.notes_to_edit.map(({ identifier }) => identifier),
                ]);
                for (const id of conflicts) {
                    const conflict = scan.duplicates.get(id);
                    if (!conflict) continue;
                    this.retryPaths.add(path);
                    this.retryMessages.add(conflict);
                }
                if (inspectMarkers) {
                    const { code, math } = findMarkdownSyntaxSpans(content, diagnosticPatterns.OBS_DISPLAY_CODE_REGEXP,
                        diagnosticPatterns.OBS_CODE_REGEXP, diagnosticPatterns.OBS_DISPLAY_MATH_REGEXP, diagnosticPatterns.OBS_INLINE_MATH_REGEXP);
                    const inspection = inspectCardSources({
                        text: parsingText, ranges: scanned.previewCandidates ?? [], syntax: this.diagnosticSyntax,
                        noteTypes, existingIds, duplicateIds: scan.duplicates, deck: scanned.target_deck || undefined,
                        tableIdWarnings: scanned.tableIdWarnings,
                        linkedRanges: bullets.map(({ id, start, end }) => ({ identifier: id, start, end })),
                        protectedSpans: code.concat(math), frontmatterEnd: frontmatterBounds(content)?.end,
                    });
                    for (const issue of inspection.issues) {
                        if (inRange(issue.line) || (issue.id !== undefined && issue.id === selected?.identifier)) this.recordCardIssue(path, issue);
                    }
                    if (inspection.skippedNew.size) {
                        scanned.removeUnsafeNewCards(new Set(Array.from(inspection.skippedNew, candidate => candidate.note)));
                    }
                    scanned.notes_to_edit = scanned.notes_to_edit.filter(({ identifier }) => !inspection.skippedIds.has(identifier));
                }
                scanned.notes_to_edit = scanned.notes_to_edit.filter(({ identifier }) => !scan.duplicates.has(identifier));
                if (scanned.notes_to_delete.some(id => scan.duplicates.has(id))) scanned.notes_to_delete = [];
                applyAuthoredTags(scanned, content, bullets, tags, this.diagnosticSyntax);
                if (selected && !scanned.all_notes_to_add.length && !scanned.notes_to_edit.length) {
                    if (!this.cardIssues.get(path)?.length) this.scanErrors.push(path + ": the selected card could not be verified.");
                    continue;
                }
                if (inspectSuspension) {
                    const marks = ownedSuspendMarks(readSuspendMarkers(content, this.diagnosticSyntax), scanned.previewCandidates ?? [],
                        scanned.notes_to_edit, scanned.notes_to_delete);
                    if (marks.length) {
                        this.suspensionHints.add(path);
                        this.suspensionMarks.set(path, marks);
                    }
                }
                if (this.suspendOnly?.has(path)) {
                    scanned.removeUnsafeNewCards(new Set(scanned.all_notes_to_add));
                    scanned.notes_to_edit = [];
                    scanned.notes_to_delete = [];
                    scanned.formatter.detectedMedia.clear();
                } else this.mediaByNote.set(path, mediaNames(scanned.formatter.detectedMedia));
                const hasNoNoteActions = !scanned.all_notes_to_add.length && !scanned.notes_to_edit.length && !scanned.notes_to_delete.length;
                const unresolvedLink = this.cardIssues.get(path)?.some(issue => issue.code === "missing-id");
                if (!this.recoverySources.has(path) && !this.suspensionMarks.has(path) && hasNoNoteActions &&
                    (!scanned.formatter.detectedMedia.size || unresolvedLink)) {
                    if (!this.retryPaths.has(path)) this.checkedHashes.set(path, hash);
                    continue;
                }
                this.sourceHashes.set(path, hash);
                this.ownFiles.push(scanned);
                this.files.push(file);
            } catch (error) {
                this.scanErrors.push(path + ": " + String(error));
            }
        }
    }

    deckRouteFor(path: string, markdown: string, parsed?: AllFile): DeckRouteOrigin {
        return portableDeckRoute(this.data, path, markdown, parsed);
    }

    private reviewSpacing(file: AllFile, describe: boolean): Map<number, SeparatorRepair> {
        const repairs = new Map<number, SeparatorRepair>();
        if (!file.separatorRepairs?.size) return repairs;
        for (const { identifier: id, note } of file.notes_to_edit) {
            const repair = file.separatorRepairs.get(note);
            if (repair && typeof id === 'number' && this.reviewOperation(file.path, {
                kind: "spacing", key: exportOperationKey("spacing", [id, repair.before, repair.after]), id,
                values: [{ name: "Markdown", before: repair.before, after: repair.after }],
            }, describe)) repairs.set(id, repair);
        }
        return repairs;
    }

    private saveSpacing(file: AllFile, repairs: Map<number, SeparatorRepair>): Set<number> {
        const fixed = new Set<number>();
        if (!repairs.size) return fixed;
        const rows = file.file.split("\n");
        for (const { line, id } of findIdMarkers(file.file, this.diagnosticSyntax)) {
            const repair = repairs.get(id);
            if (!repair) continue;
            let index = line - 2;
            if (index >= 0 && readSuspendLine(rows[index].trimEnd(), this.diagnosticSyntax)) index--;
            if (index >= 0 && /^Tags:[ \t]/u.test(rows[index])) index--;
            if (index < 0) continue;
            const endsCR = rows[index].endsWith("\r");
            const raw = endsCR ? rows[index].slice(0, -1) : rows[index];
            if (raw !== repair.before) continue;
            rows[index] = repair.after + (endsCR ? "\r" : "");
            fixed.add(id);
        }
        if (fixed.size) file.file = rows.join("\n");
        return fixed;
    }

    private reviewDateMarkers(file: AllFile, today: string, describe: boolean): Set<number> {
        const approved = new Set<number>();
        if (!file.notes_to_edit.length) return approved;
        const ids = new Set(file.notes_to_edit.map(edit => edit.identifier));
        dateLinkedMarkers(file.original_file, findIdMarkers(file.original_file, this.diagnosticSyntax), ids, today,
            (id, line, before, after) => {
                if (this.reviewOperation(file.path, { kind: "id-date", key: exportOperationKey("id-date", [id, before, after]),
                    id, line, values: [{ name: "Markdown", before, after }] }, describe)) approved.add(id);
                return false;
            });
        return approved;
    }

    private reviewOperation(path: string, operation: ExportPreviewOperation, describe: boolean): boolean {
        if (describe) {
            const list = this.previewOperations.get(path) ?? [];
            list.push(operation);
            this.previewOperations.set(path, list);
        } else if (this.previewSelection) {
            if (!this.previewSelection.paths.get(path)?.has(operation.key)) {
                this.previewSuppressed.add(path);
                return false;
            }
            const observed = this.previewObserved.get(path) ?? new Set<string>();
            observed.add(operation.key);
            this.previewObserved.set(path, observed);
        }
        return true;
    }

    private async reviewSuspensions(files: readonly AllFile[], describe: boolean): Promise<SuspendChange[]> {
        const marked = files.flatMap(file => (this.suspensionMarks.get(file.path) ?? []).map(mark => ({ path: file.path, mark })));
        if (!marked.length) return [];
        if (!this.ankiProfile) throw new AnkiProfileError("unconfigured");
        const missingSnapshots = marked.map(({ mark }) => mark.id).filter(id => !this.linkedSnapshots.has(id));
        const fetched = await readReviewedNoteSnapshots(missingSnapshots);
        const notes = new Map<number, readonly number[]>();
        const numbered = new Set<number>();
        for (const { path, mark } of marked) {
            const snapshot = this.linkedSnapshots.get(mark.id) ?? fetched.get(mark.id);
            if (!snapshot || snapshot.modelName !== mark.modelName || !snapshot.cards.length) {
                this.retry(path, "Cannot verify the cards of Anki note " + mark.id + " / Не удалось подтвердить карточки записи Anki.");
                continue;
            }
            notes.set(mark.id, snapshot.cards);
            if (mark.selection !== "all") numbered.add(mark.id);
        }
        if (!notes.size) return [];
        const cards = await readSuspendCards(this.ankiProfile, notes, numbered);
        const approved: SuspendChange[] = [];
        for (const { path, mark } of marked) {
            if (!notes.has(mark.id)) continue;
            try {
                const change = oneWaySuspendChange(path, mark, cards.get(mark.id) ?? []);
                if (change && this.reviewOperation(path, change.operation, describe)) approved.push(change);
            } catch (error) { this.retry(path, String(error)); }
        }
        return approved;
    }

    private creationOperations(file: AllFile): Map<AllFile["all_notes_to_add"][number], ExportPreviewOperation> {
        const positions = file.id_indexes.concat(file.inline_id_indexes, file.regex_id_indexes);
        const lines = recoverySlotLines(file);
        return new Map(file.all_notes_to_add.map((note, index) => {
            const tags = mergeTags(note.tags, file.global_tags.split(/\s+/));
            const key = exportOperationKey("create", [positions[index], noteRecoverySignature(note), tags]);
            return [note, { key, kind: "create", line: lines[index] ?? undefined,
                modelName: note.modelName, deck: note.deckName,
                values: Object.entries(note.fields).map(([name, after]) => ({ name, after }))
                    .concat({ name: "Tags", after: tags.join(" ") }),
            }] as const;
        }));
    }

    private filterReviewedCreations(files: readonly AllFile[]): void {
        if (!this.previewSelection) return;
        for (const file of files) {
            if (this.recoverySources.has(file.path)) continue;
            const excluded = new Set<AllFile["all_notes_to_add"][number]>();
            for (const [note, operation] of this.creationOperations(file)) {
                if (!this.reviewOperation(file.path, operation, false)) excluded.add(note);
            }
            if (excluded.size) file.removeUnsafeNewCards(excluded);
        }
    }

    private async reviewDeletions(files: readonly AllFile[], describe: boolean): Promise<Map<number, ReviewedAnkiEvidence>> {
        const result = new Map<number, ReviewedAnkiEvidence>();
        this.absentDeletes.clear();
        const candidates = files.flatMap(file => file.notes_to_delete);
        if (!candidates.length) return result;
        if (!this.ankiProfile) throw new AnkiProfileError("unconfigured");
        const presence = await deletionPresence(candidates, this.ankiProfile);
        const active = candidates.filter(id => presence.get(id) === true);
        const notes = await readReviewedNoteSnapshots(active);
        for (const file of files) {
            const kept: number[] = [];
            for (const id of file.notes_to_delete) {
                const note = notes.get(id);
                const local = this.deleteEffects.get(file)?.get(id);
                if (!local) {
                    this.retry(file.path, "Could not confirm the Markdown deletion command for ID " + id + ".");
                    continue;
                }
                if (presence.get(id) === false) {
                    const operation: ExportPreviewOperation = { kind: "delete", id, key: exportOperationKey("delete", [id, null, local]),
                        deletion: { local, alreadyAbsent: true }, values: [] };
                    if (this.reviewOperation(file.path, operation, describe)) {
                        this.absentDeletes.add(id);
                        kept.push(id);
                    }
                    continue;
                }
                if (!note) {
                    this.retry(file.path, "Could not confirm Anki note " + id + " for deletion. Run the export preview again.");
                    continue;
                }
                const snapshot = snapshotKey(note);
                const operation: ExportPreviewOperation = {
                    key: exportOperationKey("delete", [id, snapshot, local]), kind: "delete", id, modelName: note.modelName,
                    deletion: { local, alreadyAbsent: false },
                    values: snapshotFields(note).map(([name, before]) => ({ name, before })),
                };
                if (!this.reviewOperation(file.path, operation, describe)) continue;
                kept.push(id);
                result.set(id, { id, modelName: note.modelName, snapshot });
                if (this.onSyncChange && !describe) this.deletedFields.set(id, snapshotFields(note));
            }
            if (kept.length && this.afterDeleteMode !== "keep" && this.afterDeleteMode !== "remove") {
                const plan = explicitDeletes(file.original_file, this.diagnosticSyntax ?? {}, this.data.custom_regexps, this.data.page_model,
                    [this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]);
                if (!plan) throw new Error("The deletion source changed; open a new preview.");
                cleanConfirmedDeletes(file.original_file, plan, new Set(kept), this.afterDeleteMode, this.trashDeletedPages, [], this.deletedArchiveLabel);
            }
            file.notes_to_delete = kept;
        }
        return result;
    }

    private reviewMedia(plans: readonly MediaPlan[], describe: boolean): Set<string> {
        const unavailable = new Set<string>();
        if (!describe && !this.previewSelection) return unavailable;
        const byPath = new Map<string, MediaPlan[]>();
        for (const plan of plans) if (mediaNeedsReview(plan)) for (const path of plan.notes) {
            const entries = byPath.get(path) ?? [];
            entries.push(plan);
            byPath.set(path, entries);
        }
        for (const [path, entries] of byPath) {
            const evidence = entries.map(plan => [plan.indexKey, plan.record.path, plan.record.filename,
                plan.record.digest, plan.remoteBefore, Array.from(plan.remoteNames).sort(),
                plan.optimized?.copyPath, plan.optimized?.replacePath]).sort((left, right) =>
                String(left[0]).localeCompare(String(right[0])));
            const operation: ExportPreviewOperation = {
                key: exportOperationKey("media", evidence), kind: "media",
                values: entries.map(plan => ({ name: plan.record.namespaced ? plan.record.path : plan.sourceFilename,
                    after: plan.record.filename })),
                requiresExplicitSelection: entries.some(plan => plan.confirmAlias),
                mediaAliasSources: entries.filter(plan => plan.record.namespaced).map(plan => plan.record.path),
            };
            if (!this.reviewOperation(path, operation, describe)) unavailable.add(path);
        }
        return unavailable;
    }

    async prepareExistingUpdates(includeDeckDetails = false): Promise<void> {
        const collectDeckMoves = includeDeckDetails || this.confirmedDeckMoves !== undefined;
        const notes = this.ownFiles.flatMap(file => {
            const fileTags = file.global_tags.split(/\s+/);
            const deckRule = file.notes_to_edit.length ? this.deckRouteFor(file.path, file.original_file, file) : undefined;
            const candidates = new Map<number, NonNullable<AllFile["previewCandidates"]>[number]>();
            for (const candidate of file.previewCandidates ?? []) {
                if (candidate.identifier !== undefined && !candidates.has(candidate.identifier)) {
                    candidates.set(candidate.identifier, candidate);
                }
            }
            return file.notes_to_edit.map(({ identifier, note }) => ({
                id: identifier,
                path: file.path,
                fields: note.fields,
                tags: mergeTags(note.tags, fileTags),
                deck: note.deckName,
                deckRule: portableCardExportRuleRoute(note) ?? deckRule,
                modelName: note.modelName,
                authoredFields: authoredFieldNames(file, candidates.get(identifier), note.fields),
                namedLayout: candidates.get(identifier)?.namedLayout,
                sharedPageFields: file.pageCard?.sharedFields ? [...file.pageCard.sharedFields.values.keys()] : undefined,
            }));
        });
        this.previewDeckMoves.clear();
        this.previewFieldConflicts.clear();
        this.previewKeptAnkiFields.clear();
        this.oneWayReceipts.length = 0;
        this.namedLayouts.clear();
        for (const note of notes) if (note.namedLayout) this.namedLayouts.set(note.id, note.namedLayout);
        this.reviewedStudyCards.clear();
        this.reviewedRequests.clear();
        if (this.previewSelection) {
            for (const observed of this.previewObserved.values()) for (const key of observed) {
                if (key.startsWith("field:") || key.startsWith("tags:") || key.startsWith("deck:")) observed.delete(key);
            }
        }
        const onDeckMove = collectDeckMoves ? (path: string, detail: ExportDeckMove) => {
            const list = this.previewDeckMoves.get(path) ?? [];
            list.push(detail);
            this.previewDeckMoves.set(path, list);
        } : undefined;
        const pathsById = new Map(notes.map(note => [note.id, note.path] as const));
        this.existingChanges = await prepareExistingNoteChanges(notes, (path, message) => this.retry(path, message),
            this.linkedSnapshots, onDeckMove, {
                history: this.oneWayHistory,
                allowDeckMoves: collectDeckMoves,
                capture: includeDeckDetails ? undefined : receipt => this.oneWayReceipts.push(receipt),
                onFieldConflict: conflict => {
                    const path = pathsById.get(conflict.id);
                    if (!path) return;
                    const list = this.previewFieldConflicts.get(path) ?? [];
                    list.push(conflict);
                    this.previewFieldConflicts.set(path, list);
                },
                onKeptAnkiFields: includeDeckDetails ? (path, note) => {
                    const list = this.previewKeptAnkiFields.get(path) ?? [];
                    list.push(note);
                    this.previewKeptAnkiFields.set(path, list);
                } : undefined,
                authorizeField: conflict => this.confirmedFields?.has(oneWayFieldChoice(conflict)) === true,
                reviewOperation: includeDeckDetails || this.previewSelection ?
                    (path, operation) => this.reviewOperation(path, operation, includeDeckDetails) : undefined,
                reviewEvidence: this.previewSelection || this.operationJournal || this.onSyncChange ?
                    (request, evidence) => this.reviewedRequests.set(request, [evidence]) : undefined,
                includeCardStudyDetails: includeDeckDetails,
                rememberReviewedCards: (request, cardIds) => this.reviewedStudyCards.set(request, cardIds),
                rememberMoveOwner: (request, id) => this.moveOwners.set(request, id),
            });
        if (this.confirmedDeckMoves) {
            for (const [path, moves] of this.previewDeckMoves) {
                const reviewed = new Map<number, ExportDeckMove>();
                for (const move of this.confirmedDeckMoves.get(path) ?? []) {
                    for (const card of move.cardIds) reviewed.set(card, move);
                }
                const changed = moves.some(move => move.cardIds.some(card => {
                    const before = reviewed.get(card);
                    return !before || before.from !== move.from || before.to !== move.to;
                }));
                if (!changed) continue;
                const message = "the proposed deck moves changed. Run the export preview again";
                this.retry(path, message);
                this.blockedUpdates.set(path, path + ": " + message);
                this.existingChanges.delete(path);
            }
        }
        if (!includeDeckDetails) return;
        const openNotes = await findOpenNotesForUpdate(this.existingChanges);
        if (!openNotes.size) return;
        const titles = new Map<number, string>();
        for (const note of notes) if (openNotes.has(note.id)) {
            const front = this.data.fields_dict[note.modelName]?.[0];
            if (front) titles.set(note.id, note.fields[front]);
        }
        for (const [path, changes] of this.existingChanges) {
            this.existingChanges.set(path, changes.filter(request => {
                if (request.action !== "updateNoteFields" || !openNotes.has(request.params.note.id)) return true;
                this.retry(path, ankiBrowseMessage(request.params.note.id, titles.get(request.params.note.id)));
                return false;
            }));
            const previews = this.previewOperations.get(path);
            if (previews) this.previewOperations.set(path, previews.filter(op =>
                op.kind !== "field" || op.id === undefined || !openNotes.has(op.id)));
        }
    }

    private mediaReferences(files: readonly AllFile[]) {
        return files.flatMap(file => Array.from(file.formatter.detectedMedia, link => ({ note: file.path, link })));
    }

    private applyMediaAliases(plans: readonly MediaPlan[], files: readonly AllFile[]): void {
        if (!plans.length) return;
        const byPath = plannedMediaAliases(plans);
        for (const file of files) {
            const aliases = byPath.get(file.path);
            if (!aliases) continue;
            for (const note of file.all_notes_to_add) rewriteImageFields(note.fields, aliases);
            for (const { note } of file.notes_to_edit) rewriteImageFields(note.fields, aliases);
        }
    }

    private pendingMessage(entry: RecoveryEntry): string {
        const ids = entry.slots.filter(slot => typeof slot === "number");
        return "pending Anki note creation from " + entry.path + (entry.formerPath ? " (formerly " + entry.formerPath + ")" : "") +
            (ids.length ? " (known IDs: " + ids.join(", ") + ")" : "") +
            ". Verify the original source and Anki before retrying new cards";
    }

    /** A moved pending source must be unique across the vault, including ignored Markdown. */
    private async locateRecoveryTokens(tokens: ReadonlySet<string>, existingIds?: Set<number>): Promise<Map<string, string | null>> {
        const files = this.app.vault.getMarkdownFiles().map(file => ({ file, path: file.path, ...file.stat }));
        const owners = new Map<string, string | null>();
        for (let offset = 0; offset < files.length; offset += 8) {
            if (this.stopAfterPacket?.()) throw new Error("export stopped while checking moved pending notes");
            await Promise.all(files.slice(offset, offset + 8).map(async ({ file, path }) => {
                this.readCount++;
                const text = await this.app.vault.read(file);
                for (const token of recoveryMarkerTokens(text)) {
                    if (tokens.has(token)) owners.set(token, owners.has(token) ? null : path);
                }
                if (existingIds) {
                    const ids = this.recoveryIdMarkers ? this.recoveryIdMarkers(text).map(marker => marker.id) : collectNoteIds(text);
                    for (const id of ids) existingIds.add(id);
                }
            }));
        }
        if (this.app.vault.getMarkdownFiles().length !== files.length || files.some(({ file, path, ctime, mtime, size }) =>
            file.path !== path || file.stat.ctime !== ctime || file.stat.mtime !== mtime || file.stat.size !== size)) {
            throw new Error("Markdown files changed during the pending-source check. Recheck before binding any Anki IDs");
        }
        return owners;
    }

    private matchesRecoverySource(file: AllFile, entry: RecoveryEntry): boolean {
        const notes = file.all_notes_to_add;
        const sourceHash = this.recoverySources.get(file.path)?.cleanHash ?? this.sourceHashes.get(file.path);
        if (entry.path !== file.path || entry.formerPath || entry.sourceHash !== sourceHash) return false;
        if (notes.length === entry.signatures.length) return notes.every((note, index) =>
            noteRecoverySignature(note) === entry.signatures[index]);
        if (notes.length < entry.signatures.length || !entry.slotLines?.every(line => line !== null)) return false;
        const lines = recoverySlotLines(file);
        const expected = new Map(entry.slotLines.map((line, i) => [line + ":" + entry.signatures[i], i] as const));
        if (expected.size !== entry.signatures.length) return false;
        const omitted = new Set<typeof notes[number]>();
        let next = 0;
        for (const [index, note] of notes.entries()) {
            const position = expected.get(lines[index] + ":" + noteRecoverySignature(note));
            if (position === undefined) omitted.add(note);
            else if (position !== next++) return false;
        }
        if (next !== entry.signatures.length) return false;
        file.removeUnsafeNewCards(omitted);
        return true;
    }

    private async recoverIds(file: AllFile, entry: RecoveryEntry): Promise<boolean> {
        if (!this.matchesRecoverySource(file, entry) || entry.slots.includes("unknown")) return false;
        const notes = file.all_notes_to_add;
        const known = new Map<number, typeof notes[number]>();
        entry.slots.forEach((id, index) => { if (typeof id === "number") known.set(id, notes[index]); });
        if (!known.size) return entry.tagVersion === 1 && entry.slots.every(slot => slot === null);
        const ids = Array.from(known.keys());
        for (let offset = 0; offset < ids.length; offset += 500) {
            const batch = ids.slice(offset, offset + 500);
            const pending = new Set(batch);
            const response: unknown = await withAnkiDeadline(() => AnkiConnect.invoke("notesInfo", { notes: batch }),
                "Anki note recovery details");
            if (!Array.isArray(response)) return false;
            const rows: readonly unknown[] = response;
            for (const row of rows) {
                if (!isAnkiRecord(row) || typeof row.noteId !== "number" || !pending.delete(row.noteId)) return false;
                const expected = known.get(row.noteId)!;
                const fields = row.fields;
                if (row.modelName !== expected.modelName || !isAnkiRecord(fields) ||
                    Object.entries(expected.fields).some(([name, value]) => {
                        const field = fields[name];
                        return !isAnkiRecord(field) || typeof field.value !== "string" ||
                            field.value.normalize("NFC") !== value.normalize("NFC");
                    })) return false;
            }
            if (pending.size) return false;
        }
        return true;
    }

    private async recoverTaggedNotes(files: readonly AllFile[], recovery: ExportRecovery, profile: string,
        verifyProfile: () => Promise<string>, existingIds: ReadonlySet<number>, ownershipRevision: number | undefined): Promise<void> {
        const entries = new Map<string, { entry: RecoveryEntry; slots: RecoverySlot[] }>();
        const requested = files.flatMap(file => {
            const source = this.recoverySources.get(file.path);
            const entry = source && recovery.byToken(source.token);
            if (!entry || entry.tagVersion !== 1 || !entry.slots.includes("unknown")) return [];
            if (!this.matchesRecoverySource(file, entry)) {
                this.retry(file.path, "pending Anki note creation source has changed. Review the Markdown and the Anki candidates");
                return [];
            }
            entries.set(file.path, { entry, slots: [...entry.slots] });
            return entry.slots.flatMap((slot, index) => {
                const tag = slot === "unknown" ? recoveryTag(entry, index) : undefined;
                if (!tag) return [];
                const { modelName, fields } = file.all_notes_to_add[index];
                return [{ tag, modelName, fields, path: file.path, index }];
            });
        });
        if (!requested.length) return;
        const results = await lookupRecoveryNotes(requested, verifyProfile);
        if (this.recoveryRevision?.() !== ownershipRevision || this.stopAfterPacket?.()) {
            for (const path of entries.keys()) this.retry(path, "pending Anki note creation source changed during recovery");
            return;
        }
        const claimed = new Set(existingIds);
        for (const entry of recovery.records()) {
            if (entry.ankiProfile !== profile) continue;
            for (const id of entry.slots) if (typeof id === "number") claimed.add(id);
        }
        const counts = new Map<number, number>();
        for (const result of results.values()) {
            for (const id of result.candidates) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        for (const { tag, path, index } of requested) {
            const result = results.get(tag);
            const id = result?.noteId;
            if (result?.state === "found" && id !== undefined && counts.get(id) === 1 && !claimed.has(id)) {
                entries.get(path)!.slots[index] = id;
                claimed.add(id);
                continue;
            }
            const candidates = result?.candidates.length ? " (Anki IDs: " + result.candidates.join(", ") + ")" : "";
            const problem = result?.state === "found" ? "the Anki ID is already linked or belongs to multiple pending records" :
                result?.state === "missing" ? "no Anki note has this recovery tag yet; creation remains pending" :
                    result?.detail ?? "the Anki result could not be confirmed";
            this.retry(path, "pending Anki note creation " + (index + 1) + ": " + problem + candidates);
        }
        await recovery.record(Array.from(entries.values()).flatMap(({ entry, slots }) =>
            slots.some((slot, index) => slot !== entry.slots[index]) ? [{ path: entry.path, slots }] : []), profile);
    }

    private async blockedCreationFiles(files: readonly AllFile[], pending?: ReadonlySet<string>): Promise<Set<string>> {
        const candidates = files.filter(file => !pending?.has(file.path) && !this.recoverySources.has(file.path) &&
            file.all_notes_to_add.length > 0);
        const decks = new Set<string>();
        for (const file of candidates) for (const note of file.all_notes_to_add) decks.add(note.deckName);
        const blocked = new Set<string>();
        if (!decks.size) return blocked;
        const unverified = new Set<string>();
        const filtered = await readFilteredAnkiDecks(decks, (action, params) =>
            withAnkiDeadline(() => AnkiConnect.invoke(action, params), "Read Anki deck type"), this.stopAfterPacket, unverified);
        if (!filtered.size && !unverified.size) return blocked;
        for (const file of candidates) {
            const held = file.all_notes_to_add.filter(note => {
                const key = ankiStudyDeckKey(note.deckName);
                const canonical = filtered.get(key);
                if (!canonical && !unverified.has(key)) return false;
                this.retry(file.path, canonical ? canonical + " is a filtered deck. Choose an ordinary home deck for new cards." :
                    "Deck type unverified: " + note.deckName + ". Retry sync.");
                return true;
            });
            if (held.length === file.all_notes_to_add.length) blocked.add(file.path);
            else if (held.length) file.removeUnsafeNewCards(new Set(held));
        }
        return blocked;
    }

    private async checkNewFirstFields(files: readonly AllFile[], media: readonly MediaPlan[] = []): Promise<Map<string, DuplicateSourceRows>> {
        const detected = new Map<string, DuplicateSourceRows>();
        const aliasesByPath = plannedMediaAliases(media);
        const targets = files.flatMap(file => {
            if (!file.all_notes_to_add.length) return [];
            const ranges = new Map((file.previewCandidates ?? []).map(range => [range.note, range] as const));
            const lines = recoverySlotLines(file);
            const aliases = aliasesByPath.get(file.path);
            return file.all_notes_to_add.map((original, index) => {
                const note = aliases ? { ...original, fields: { ...original.fields } } : original;
                if (aliases) rewriteImageFields(note.fields, aliases);
                return { file, note, original, range: ranges.get(original),
                    firstField: this.data.fields_dict[note.modelName]?.[0],
                    source: { path: file.path, line: lines[index] ?? 1, modelName: note.modelName, deckName: note.deckName },
                };
            });
        });
        if (!targets.length) return detected;
        const firstFields = Object.values(this.data.fields_dict).flatMap(fields => fields[0] ? [fields[0]] : []);
        const preflight = this.duplicatePreflight ?? new DuplicatePreflight();
        const results = await preflight.check(targets, firstFields, (action, params) =>
            AnkiConnect.invoke(action, params), this.stopAfterPacket);
        const byFile = new Map<AllFile, typeof targets>();
        for (const target of results.keys()) {
            const group = byFile.get(target.file) ?? [];
            group.push(target);
            byFile.set(target.file, group);
        }
        for (const [file, group] of byFile) {
            const before = file.original_file;
            const ranges = group.map(target => target.range);
            const locations = duplicateFirstFieldSources(before, before, ranges);
            const issues = group.map((target, index): ExportCardIssue => {
                const match = results.get(target)!;
                const source = locations[index];
                return { code: "duplicate-first-field", line: source?.line ?? target.source.line,
                    source, deck: target.note.deckName, duplicateOrigin: match.origin, otherSource: match.otherSource,
                    ankiCandidates: match.ankiCandidates,
                    message: match.origin === "batch"
                        ? "The same first field also appears in this export at " + match.otherSource!.path + ":" + match.otherSource!.line + "."
                        : "Anki found a note in this collection with the same first field. The new note was skipped before creation.",
                };
            });
            for (const issue of issues) this.recordCardIssue(file.path, issue);
            file.removeUnsafeNewCards(new Set(group.map(target => target.original)));
            detected.set(file.path, { before, ranges, issues });
        }
        return detected;
    }

    async describeExportPlan() {
        this.previewOperations.clear();
        const blockedCreations = await this.blockedCreationFiles(this.ownFiles);
        const mediaProblems = new Set<string>();
        const mediaSources = this.ownFiles.filter(file => !blockedCreations.has(file.path) || file.notes_to_edit.length);
        const media = await planMedia(this.app, this.mediaReferences(mediaSources), this.mediaIndex, (path, error) => {
            mediaProblems.add(path);
            this.retry(path, error);
        }, this.imageOptimization, true, this.ankiProfile, true);
        const creations = new Map(this.ownFiles.filter(file => file.all_notes_to_add.length && !mediaProblems.has(file.path) &&
            !blockedCreations.has(file.path)).map(file => [file.path, this.creationOperations(file)] as const));
        this.applyMediaAliases(media, this.ownFiles);
        let recovery: ExportRecovery | undefined;
        if (this.ownFiles.some(file => (file.all_notes_to_add.length && !blockedCreations.has(file.path)) || this.recoverySources.has(file.path))) {
            try { recovery = await this.getRecovery?.(); }
            catch (error) {
                for (const file of this.ownFiles) if (file.all_notes_to_add.length) this.retry(file.path, String(error));
            }
        }
        const duplicateSources = await this.checkNewFirstFields(this.ownFiles.filter(file => !blockedCreations.has(file.path) && !mediaProblems.has(file.path) &&
            !this.recoverySources.has(file.path) && !recovery?.get(file.path, this.sourceHashes.get(file.path))));
        const duplicateMediaOnly = new Set<string>();
        for (const file of this.ownFiles) if (duplicateSources.has(file.path) && !file.all_notes_to_add.length && !file.notes_to_edit.length) {
            duplicateMediaOnly.add(file.path);
        }
        this.reviewMedia(media, true);
        await this.reviewDeletions(this.ownFiles.filter(file => !mediaProblems.has(file.path)), true);
        await this.prepareExistingUpdates(true);
        const allowed = this.ownFiles.filter(file => !this.blockedUpdates.has(file.path));
        await this.reviewSuspensions(allowed.filter(file => !mediaProblems.has(file.path)), true);
        for (const file of allowed) this.reviewSpacing(file, true);
        if (this.data.id_date) {
            const today = formatLocalIdDate(new Date());
            for (const file of allowed) this.reviewDateMarkers(file, today, true);
        }
        const mediaCounts = new Map<string, number>();
        const imageDetails = new Map<string, OptimizedImagePreview[]>();
        for (const plan of media) {
            for (const path of plan.notes) {
                if (duplicateMediaOnly.has(path)) continue;
                if (plan.upload) mediaCounts.set(path, (mediaCounts.get(path) ?? 0) + 1);
                if (plan.optimized && mediaWillWrite(plan)) {
                    const details = imageDetails.get(path) ?? [];
                    details.push({ ...plan.optimized, filename: plan.sourceFilename });
                    imageDetails.set(path, details);
                }
            }
        }
        return allowed.filter(file => !mediaProblems.has(file.path)).flatMap(file => {
            const changes = this.existingChanges.get(file.path) ?? [];
            const edited = new Set<number>();
            const plannedFieldUpdates: ExportFieldPreview[] = [];
            let moved = 0;
            for (const change of changes) {
                if (change.action === "updateNoteFields") {
                    const { id, fields } = change.params.note;
                    edited.add(id);
                    plannedFieldUpdates.push({ id, fields: Object.keys(fields) });
                }
                if (change.action === "addTags" || change.action === "removeTags") {
                    for (const id of change.params.notes) edited.add(id);
                }
                if (change.action === "changeDeck") moved += change.params.cards.length;
            }
            const source = this.recoverySources.get(file.path);
            const pending = source ? recovery?.byToken(source.token) : recovery?.get(file.path, this.sourceHashes.get(file.path));
            const profileProblem = pending && pendingRecoveryProfileProblem(pending, this.ankiProfile);
            if (profileProblem) {
                this.retry(file.path, profileProblem);
                return [];
            }
            if (pending || source) {
                this.retry(file.path, pending ? this.pendingMessage(pending) :
                    "no journal matches the pending Markdown marker. Inspect the operation before adding cards");
                return [];
            }
            const unresolved = recovery?.records().find(entry => (!entry.ankiProfile || entry.ankiProfile === this.ankiProfile) &&
                !this.app.vault.getAbstractFileByPath(entry.path));
            if (unresolved && !pending && file.all_notes_to_add.length) this.retry(file.path, this.pendingMessage(unresolved));
            const added = recovery && !source && !pending && !unresolved && !blockedCreations.has(file.path) ? file.all_notes_to_add.length : 0;
            if (added) for (const note of file.all_notes_to_add) {
                const operation = creations.get(file.path)?.get(note);
                if (!operation) continue;
                const tags = operation.values[operation.values.length - 1];
                const values = Object.entries(note.fields).map(([name, after]) => ({ name, after }));
                if (tags?.after !== undefined) values.push({ name: tags.name, after: tags.after });
                this.reviewOperation(file.path, { ...operation, values }, true);
            }
            const deleted = file.notes_to_delete.filter(id => !this.absentDeletes.has(id)).length;
            const attachments = mediaCounts.get(file.path) ?? 0;
            const optimizedImages = imageDetails.get(file.path);
            const fieldConflicts = this.previewFieldConflicts.get(file.path);
            const keptAnkiFields = this.previewKeptAnkiFields.get(file.path);
            const operations = this.previewOperations.get(file.path)?.filter(operation =>
                operation.kind !== "media" || !duplicateMediaOnly.has(file.path));
            const exportRules = portableFileExportRules(file);
            return added || edited.size || deleted || moved || attachments || optimizedImages?.length ||
                fieldConflicts?.length || keptAnkiFields?.length || exportRules?.length || operations?.some(op => op.kind === "suspend" || op.kind === "delete" || op.kind === "id-date" || op.kind === "spacing")
                ? [{ path: file.path, added, updated: edited.size, moved, deleted, deletionIds: Array.from(file.notes_to_delete),
                    media: attachments, optimizedImages, deckMoves: this.previewDeckMoves.get(file.path),
                    fieldConflicts, keptAnkiFields, plannedFieldUpdates, operations, exportRules }] : [];
        });
    }

    async requests_1() {
        const profile = this.ankiProfile;
        const check = this.checkAnkiProfile;
        if (!profile || !check) throw new AnkiProfileError("unconfigured");
        const profileProblem = () => this.profileBlocked;
        const retryPaths = (paths: Iterable<string>, fallback: string) => {
            const message = profileProblem()?.message ?? fallback;
            for (const path of paths) this.retry(path, message);
        };
        const verifyProfile = async (confirmCommitted = false) => {
            if (this.profileBlocked) throw this.profileBlocked;
            try {
                return await check(confirmCommitted);
            } catch (error) {
                if (error instanceof AnkiProfileError) this.profileBlocked = error;
                throw error;
            }
        };
        const checkAtBoundary = async (confirmCommitted = false): Promise<string | undefined> => {
            try {
                await verifyProfile(confirmCommitted);
            } catch (error) {
                if (error instanceof AnkiProfileError || this.stopAfterPacket?.()) {
                    return error instanceof Error ? error.message : String(error);
                }
                throw error;
            }
        };
        const beforeSend = () => checkAtBoundary();
        const send = (actions: AnkiConnect.AnkiConnectRequest[]) => {
            if (actions.some(request => request.action === "deleteNotes")) this.deletionGuard?.();
            this.onWriteRequest?.(false);
            return AnkiConnect.invoke("multi", { actions });
        };
        const movePaths = new Map<AnkiConnect.AnkiConnectRequest, string>();
        let titles: Map<number, string> | undefined;
        const preparePacket = async (packet: readonly AnkiConnect.AnkiConnectRequest[]) => {
            const moves = packet.flatMap(request => request.action === "changeDeck" ? [request] : []);
            const reject = new Map<AnkiConnect.AnkiConnectRequest, string>();
            const selected = packet.some(request => request.action === "updateNoteFields")
                ? await findOpenNotesForUpdate(new Map([["", packet]])) : new Set<number>();
            if (selected.size) {
                if (!titles) {
                    titles = new Map();
                    for (const file of this.ownFiles) for (const { identifier, note } of file.notes_to_edit) {
                        const front = this.data.fields_dict[note.modelName]?.[0];
                        if (front) titles.set(identifier, note.fields[front]);
                    }
                }
                for (const request of packet) if (request.action === "updateNoteFields" && selected.has(request.params.note.id)) {
                    const id = request.params.note.id;
                    reject.set(request, ankiBrowseMessage(id, titles.get(id)));
                }
            }
            const reviewed = packet.filter(request => this.reviewedRequests.has(request));
            if (reviewed.length) {
                let snapshots: ReadonlyMap<number, NoteSnapshot> = new Map();
                try {
                    snapshots = await readReviewedNoteSnapshots(
                        reviewed.flatMap(request => this.reviewedRequests.get(request)!.map(evidence => evidence.id)));
                } catch {
                }
                for (const request of reviewed) {
                    const expected = this.reviewedRequests.get(request)!;
                    if (!reject.has(request) && expected.some(evidence => !matchesReviewedAnkiEvidence(snapshots.get(evidence.id), evidence))) {
                        reject.set(request, "Anki changed after the preview. Run the preview again to review this operation.");
                    }
                }
                const problem = await checkAtBoundary();
                if (problem) return { problem };
            }
            if (!moves.length) return { reject };
            const unverified = new Set<string>();
            const filteredTargets = await filteredMoveTargets(moves.map(request => request.params.deck), unverified);
            let current: Map<number, string>;
            try {
                current = await readUnfilteredMoveSources(moves.flatMap(request => request.params.cards), profile);
            } catch (error) {
                if (error instanceof AnkiProfileError) {
                    this.profileBlocked = error;
                    return { problem: error.message };
                }
                const problem = await checkAtBoundary();
                if (problem) return { problem };
                for (const move of moves) reject.set(move, "Could not verify the current deck before moving cards. Open Preview Export again.");
                return { reject };
            }
            for (const move of moves) {
                const deck = move.params.deck;
                if (unverified.has(ankiStudyDeckKey(deck))) {
                    reject.set(move, "Deck type unverified: " + deck + ". Retry sync.");
                    continue;
                }
                if (filteredTargets.has(ankiStudyDeckKey(deck))) {
                    reject.set(move, "The destination " + deck + " is a filtered deck. Choose a regular deck.");
                    continue;
                }
                const path = movePaths.get(move);
                const reviewed = new Map<number, string>();
                for (const row of (path ? this.previewDeckMoves.get(path) : undefined) ?? []) {
                    if (row.to === deck) for (const card of row.cardIds) reviewed.set(card, row.from);
                }
                const safe = move.params.cards.filter(card => {
                    const source = current.get(card);
                    return source !== undefined && source === reviewed.get(card);
                });
                if (safe.length === move.params.cards.length) continue;
                const message = "Some reviewed cards changed decks or entered a filtered deck. Open Preview Export again to review any remaining moves.";
                if (!safe.length) reject.set(move, message);
                else {
                    move.params.cards = safe;
                    if (path) this.retry(path, message);
                }
            }
            return { reject };
        };
        const journal = this.operationJournal;
        const journalSources = new Map<AnkiConnect.AnkiConnectRequest, readonly JournalSource[]>();
        const decksByPath = new Map(this.ownFiles.map(file => [file.path, file.target_deck]));
        const track = (request: AnkiConnect.AnkiConnectRequest, paths: ReadonlySet<string>) => {
            if (!journal && !this.onSyncChange) return;
            if (request.action === "multi") {
                for (const action of request.params.actions) track(action, paths);
            } else {
                journalSources.set(request, Array.from(paths, path => ({ path, deck: decksByPath.get(path) })));
            }
        };
        const transport = { scope: this.app, onResponse: () => this.onWriteRequest?.(true), preparePacket,
            reviewEveryPacket: this.previewSelection !== undefined || journal !== undefined || this.ownFiles.some(file => file.notes_to_delete.length),
            prepareJournalPacket: journal ? (packet: readonly AnkiConnect.AnkiConnectRequest[]) =>
                journal.prepare(packet, journalSources, this.reviewedRequests) : undefined,
            observeJournalResponse: journal || this.onSyncChange ? (request: AnkiConnect.AnkiConnectRequest, response: unknown, unsent: boolean) => {
                journal?.observe(request, response, unsent);
                if (!this.onSyncChange || request.action === 'createDeck') return;
                const result = fastResult(response);
                if (!unsent && result !== undefined && (request.action !== 'addNote' ||
                    typeof result === 'number' && Number.isSafeInteger(result) && result > 0)) return;
                const problem = typeof response === 'object' && response && 'error' in response && typeof response.error === 'string'
                    ? response.error : 'Anki did not confirm the result.';
                const ids = request.action === 'updateNoteFields' ? [request.params.note.id] :
                    request.action === 'addTags' || request.action === 'removeTags' || request.action === 'deleteNotes'
                        ? request.params.notes : [this.moveOwners.get(request)];
                for (const source of journalSources.get(request) ?? []) for (const id of ids) {
                    this.onSyncChange({ path: source.path, noteId: id, direction: 'to-anki', action: unsent ? 'skip' : 'unknown',
                        title: request.action === 'addNote' ? Object.values(request.params.note.fields)[0] : undefined,
                        detail: request.action + ': ' + problem });
                }
            } : undefined,
        };
        const actions: AnkiConnect.AnkiConnectRequest[] = [];
        const actionPaths: Set<string>[] = [];
        const enqueue = (request: AnkiConnect.AnkiConnectRequest, paths: Set<string>) => {
            track(request, paths);
            actions.push(request);
            actionPaths.push(paths);
            return actions.length - 1;
        };
        const additions = new Map<string, number>();
        const deletions = new Map<string, number>();
        const submittedChanges = new Map<string, AnkiConnect.AnkiConnectRequest[]>();
        const confirmedActions = new Set<AnkiConnect.AnkiConnectRequest>();
        const createdNotes: ExistingNoteSource[] = [];
        let recovery: ExportRecovery | undefined;
        let journalError = "the pending export journal is unavailable";
        if (this.ownFiles.length) {
            try { recovery = await this.getRecovery?.(); }
            catch (error) { journalError = String(error); }
        }
        const pendingTagged = new Set<string>();
        const pendingCreations = new Set<string>();
        const allowed = this.ownFiles.filter(file => {
            const source = this.recoverySources.get(file.path);
            const pending = source ? recovery?.byToken(source.token) : recovery?.get(file.path, this.sourceHashes.get(file.path));
            const problem = pending && pendingRecoveryProfileProblem(pending, profile);
            if (this.cursorRecovery && (source?.token !== this.cursorRecovery.token || pending?.cursorOffset === undefined ||
                pending.ankiProfile !== profile || pending.path !== this.cursorRecovery.path || pending.sourceHash !== source?.cleanHash)) {
                this.retry(file.path, "The pending card no longer matches the recovery entry. Review it again.");
            }
            else if (problem) this.retry(file.path, problem);
            else if (this.previewSelection && (pending || source)) this.retry(file.path,
                "A previous creation needs verification. Review Pending Anki Creations before applying a new plan.");
            else if (source && !pending) this.retry(file.path, recovery
                ? "no journal matches the pending Markdown marker. Inspect the operation before adding cards" : journalError);
            else {
                if (pending || source) pendingCreations.add(file.path);
                if (pending?.tagVersion === 1) pendingTagged.add(file.path);
                return true;
            }
            return false;
        });
        this.filterReviewedCreations(allowed);
        const reviewedDeletions = await this.reviewDeletions(allowed, false);
        const blockedCreations = await this.blockedCreationFiles(allowed, pendingCreations);
        const mediaProblems = new Set<string>();
        const mediaError = (path: string, error: string) => { mediaProblems.add(path); this.retry(path, error); };
        const mediaSources = allowed.filter(file => !blockedCreations.has(file.path) || file.notes_to_edit.length);
        const media = await planMedia(this.app, this.mediaReferences(mediaSources), this.mediaIndex, mediaError,
            this.imageOptimization, false, profile, this.previewSelection?.mediaAliasSources ?? false);
        const unapprovedMedia = this.reviewMedia(media, false);
        const current = (file: AllFile) => {
            if (this.isStillCurrent?.(file.path) !== false) return true;
            this.retry(file.path, "file changed before sending the export plan");
            return false;
        };
        const ready = new Set(allowed.filter(file => {
            if (!current(file)) return false;
            if (unapprovedMedia.has(file.path)) {
                this.retry(file.path, "The attachment changes were not approved or changed since preview. Review the attachments before applying this file.");
                return false;
            }
            if (this.confirmedDeletions && file.notes_to_delete.some(id => !this.confirmedDeletions?.get(file.path)?.has(id))) {
                this.retry(file.path, "the proposed deletions changed. Run the export preview again");
                return false;
            }
            return true;
        }).map(file => file.path));
        const duplicateSources = await this.checkNewFirstFields(allowed.filter(file => ready.has(file.path) &&
            !mediaProblems.has(file.path) && !blockedCreations.has(file.path) && !pendingCreations.has(file.path)), media);
        const duplicateMediaOnly = new Set(allowed.filter(file => duplicateSources.has(file.path) &&
            !file.all_notes_to_add.length && !file.notes_to_edit.length).map(file => file.path));
        const writableMedia = (plan: MediaPlan) => plan.notes.some(path =>
            ready.has(path) && !mediaProblems.has(path) && !pendingTagged.has(path) && !duplicateMediaOnly.has(path));
        let backedUpProfile: string | undefined;
        if (this.beforeMutation && !this.stopAfterPacket?.() && media.some(plan => mediaWillWrite(plan) &&
            writableMedia(plan))) {
            await verifyProfile();
            backedUpProfile = (await this.beforeMutation()).profile;
            for (const file of allowed) if (ready.has(file.path) && !current(file)) ready.delete(file.path);
        }
        const verifiedMedia = media.filter(plan => !mediaWillWrite(plan) && hasMediaAlias(plan.record) &&
            plan.notes.some(path => pendingTagged.has(path)));
        const sentPaths = await applyMedia(this.app, media.filter(writableMedia), this.mediaIndex, mediaError, this.mediaConfirmed,
            this.stopAfterPacket, plan => {
                if (hasMediaAlias(plan.record)) verifiedMedia.push(plan);
                for (const path of plan.notes) {
                    const keys = new Set(this.mediaByNote.get(path));
                    keys.add(plan.indexKey);
                    if (plan.retiredImageKey) keys.add(retiredMediaMarker(plan.retiredImageKey));
                    this.mediaByNote.set(path, keys);
                }
            }, backedUpProfile ?? profile, verifyProfile, this.onWriteRequest, this.onSyncChange && ((plan, filename) => {
                for (const path of plan.notes) this.onSyncChange?.({ action: 'media', direction: 'to-anki', path,
                    title: filename, fields: [{ name: 'Checksum', before: plan.remoteBefore ?? undefined, after: plan.record.digest }] });
            }));
        if (profileProblem()) {
            retryPaths(ready, "export stopped during attachment checks");
            return sentPaths;
        }
        if (this.stopAfterPacket?.()) {
            for (const path of ready) this.retry(path, "export stopped before submitting this file's card changes");
            return sentPaths;
        }
        this.applyMediaAliases(verifiedMedia, allowed);
        if (media.length) this.linkedSnapshots.clear();
        await this.prepareExistingUpdates();
        const eligible = () => allowed.filter(file => ready.has(file.path) && !mediaProblems.has(file.path) &&
            !this.blockedUpdates.has(file.path) && current(file));
        let exportFiles = eligible();
        const suspensions = await this.reviewSuspensions(exportFiles, false);
        const localDate = this.data.id_date ? formatLocalIdDate(new Date()) : undefined;
        const spacing = new Map<string, Map<number, SeparatorRepair>>();
        for (const file of exportFiles) {
            const approved = this.reviewSpacing(file, false);
            if (approved.size) spacing.set(file.path, approved);
        }
        const spacedIds = new Map<string, Set<number>>();
        const datedIds = new Map<string, Set<number>>();
        if (localDate) for (const file of exportFiles) {
            const ids = this.reviewDateMarkers(file, localDate, false);
            if (ids.size) datedIds.set(file.path, ids);
        }

        if (this.beforeMutation && !this.stopAfterPacket?.() && (suspensions.length || datedIds.size || spacing.size || exportFiles.some(file =>
            file.all_notes_to_add.length || file.notes_to_delete.length || this.recoverySources.has(file.path) ||
            this.existingChanges.get(file.path)?.length))) {
            await verifyProfile();
            const check = await this.beforeMutation();
            backedUpProfile = check.profile;
            if (check.created) {
                this.linkedSnapshots.clear();
                await this.prepareExistingUpdates();
                exportFiles = eligible();
            }
        }

        if (this.previewSelection) for (const file of allowed) {
            const accepted = this.previewObserved.get(file.path);
            const selected = this.previewSelection.paths.get(file.path);
            if (selected && [...selected].some(key => !accepted?.has(key))) {
                this.retry(file.path, "One or more selected operations changed. Run the preview again.");
            }
        }
        const plans: RecoveryPlan[] = [];
        const resumes = new Map<string, readonly RecoverySlot[]>();
        const manualLinks = new Map<string, number[]>();
        const blockedRecovery = new Set<string>();
        const existingIds = new Set<number>();
        let checkedRecoveryRevision: number | undefined;
        if (recovery) {
            const moved = new Map<string, { entry: RecoveryEntry; token: string }>();
            for (const file of exportFiles) {
                const source = this.recoverySources.get(file.path);
                const pending = source && recovery.byToken(source.token);
                if (source && pending && (pending.formerPath || pending.path !== file.path || pending.tagVersion === 1)) {
                    moved.set(file.path, { entry: pending, token: source.token });
                }
            }
            if (moved.size) {
                const tagged = Array.from(moved.values()).some(({ entry }) => entry.tagVersion === 1 && entry.slots.includes("unknown"));
                const readIds = Array.from(moved.values()).some(({ entry }) => entry.tagVersion === 1);
                const ownershipRevision = this.recoveryRevision?.();
                checkedRecoveryRevision = ownershipRevision;
                let owners: Map<string, string | null> | undefined;
                let problem = "pending creation marker has no single Markdown owner; inspect any copied files before linking this Anki note";
                try { owners = await this.locateRecoveryTokens(new Set(Array.from(moved.values(), row => row.token)), readIds ? existingIds : undefined); }
                catch (error) { problem = "could not verify pending creation marker ownership: " + String(error); }
                for (const [path, { entry, token }] of moved) {
                    if (owners?.get(token) !== path || (entry.path !== path &&
                        (recovery.get(path) || this.app.vault.getAbstractFileByPath(entry.path)))) {
                        this.retry(path, problem);
                        blockedRecovery.add(path);
                    } else if (entry.path !== path) {
                        await verifyProfile();
                        await recovery.relocate(token, entry.path, path, profile);
                    }
                }
                if (tagged) await this.recoverTaggedNotes(exportFiles.filter(file => !blockedRecovery.has(file.path)),
                    recovery, profile, verifyProfile, existingIds, ownershipRevision);
            }
        }
        const unresolved = recovery?.records().find(entry => (!entry.ankiProfile || entry.ankiProfile === profile) &&
            !this.app.vault.getAbstractFileByPath(entry.path));
        for (const file of exportFiles) {
            if (blockedRecovery.has(file.path)) continue;
            const source = this.recoverySources.get(file.path);
            if (!file.all_notes_to_add.length && !source) continue;
            const sourceHash = source?.cleanHash ?? this.sourceHashes.get(file.path);
            if (!recovery || !sourceHash) {
                this.retry(file.path, journalError);
                continue;
            }
            let pending = source ? recovery.byToken(source.token) : recovery.get(file.path, sourceHash);
            if (source && pending?.path !== file.path) {
                this.retry(file.path, pending ? this.pendingMessage(pending) : "no journal matches the pending Markdown marker. Inspect the operation before adding cards");
                blockedRecovery.add(file.path);
                continue;
            }
            if (pending?.path === file.path && !source) {
                await verifyProfile();
                await recovery.settle(file.path, sourceHash, profile);
                await recovery.settleLinked(file.path, file.notes_to_edit.map(note => note.identifier), profile);
                pending = recovery.get(file.path, sourceHash);
            }
            if (pending) {
                const linkedIds = file.notes_to_edit.map(note => note.identifier);
                if (source && hasRecoveredLinks(pending, linkedIds)) {
                    manualLinks.set(file.path, linkedIds);
                    if (file.all_notes_to_add.length) this.retry(file.path, "previous creation resolved; retry any remaining new cards");
                    continue;
                }
                try {
                    await verifyProfile();
                    const alreadyLinked = pending.tagVersion === 1 &&
                        pending.slots.some(id => typeof id === "number" && existingIds.has(id));
                    if (!alreadyLinked && await this.recoverIds(file, pending)) resumes.set(file.path, pending.slots);
                    else {
                        if (pending.tagVersion === 1) blockedRecovery.add(file.path);
                        this.retry(file.path, alreadyLinked ? "pending Anki note creation already has an ID linked to Markdown. Review the source." :
                            this.pendingMessage(pending));
                    }
                } catch (error) {
                    if (error instanceof AnkiProfileError) throw error;
                    if (pending.tagVersion === 1) blockedRecovery.add(file.path);
                    this.retry(file.path, this.pendingMessage(pending));
                }
                continue;
            }
            if (unresolved) {
                this.retry(file.path, this.pendingMessage(unresolved));
                continue;
            }
            if (blockedCreations.has(file.path)) continue;
            plans.push({ path: file.path, sourceHash, signatures: file.all_notes_to_add.map(noteRecoverySignature),
                token: newRecoveryToken(), tagVersion: 1, slotLines: recoverySlotLines(file),
                ...(this.cursorCard ? { cursorOffset: cursorCardOffset(this.cursorCard, file.path, file.original_file) } : {}) });
        }
        const recheckResumeOwners = async () => {
            const revision = this.recoveryRevision?.();
            if (!resumes.size || revision === checkedRecoveryRevision) return;
            const byPath = Array.from(resumes.keys()).flatMap(path => {
                const source = this.recoverySources.get(path);
                const entry = source && recovery?.byToken(source.token);
                return entry?.tagVersion === 1 && entry.token ? [{ path, entry, token: entry.token }] : [];
            });
            if (!byPath.length) return;
            const ids = new Set<number>();
            let owners: Map<string, string | null> | undefined;
            try {
                owners = await this.locateRecoveryTokens(new Set(byPath.map(row => row.token)), ids);
            } catch {
            }
            for (const { path, entry, token } of byPath) {
                if (this.recoveryRevision?.() !== revision || owners?.get(token) !== path ||
                    entry.slots.some(id => typeof id === "number" && ids.has(id))) {
                    resumes.delete(path);
                    blockedRecovery.add(path);
                    this.retry(path, "pending Anki note creation source or ID ownership changed during recovery");
                }
            }
            checkedRecoveryRevision = revision;
        };
        await recheckResumeOwners();
        const beforeJournal = exportFiles.filter(file => !blockedRecovery.has(file.path) && current(file));
        const beforeJournalPaths = new Set(beforeJournal.map(file => file.path));
        const activePlans = this.stopAfterPacket?.() ? [] : plans.filter(plan => beforeJournalPaths.has(plan.path));
        if (plans.length && !activePlans.length && this.stopAfterPacket?.()) {
            for (const plan of plans) this.retry(plan.path, "export stopped before creating new cards");
        }
        if (activePlans.length) {
            await verifyProfile();
            await recovery!.begin(activePlans, profile);
            if (await beforeSend()) {
                await recovery!.record(activePlans.map(plan => ({
                    path: plan.path, slots: Array<RecoverySlot>(plan.signatures.length).fill(null),
                })), profile);
                await recovery!.settleMany(activePlans.map(plan => ({ path: plan.path, currentHash: plan.sourceHash })), profile);
                retryPaths(beforeJournalPaths, "export stopped before creating new cards");
                return sentPaths;
            }
        }
        const fileMappings = new Map(activePlans.length ?
            this.ownFiles.map((file, index) => [file.path, { scanned: file, file: this.files[index] }] as const) : []);
        const plannedAdds = new Set<string>();
        for (const plan of activePlans) {
            const { scanned, file } = fileMappings.get(plan.path)!;
            try {
                if (this.stopAfterPacket?.()) throw new Error("export stopped before creating new cards");
                if (!current(scanned)) continue;
                const token = plan.token!;
                const marked = addRecoveryMarker(scanned.original_file, token);
                await this.app.vault.process(file, source => {
                    if (file.path !== plan.path || source !== scanned.original_file) throw new Error("file changed before saving the pending creation marker");
                    return marked;
                });
                this.readCount++;
                if (file.path !== plan.path || await this.app.vault.read(file) !== marked) {
                    throw new Error("could not verify the pending Markdown creation marker");
                }
                this.recoverySources.set(plan.path, { token, raw: marked, cleanHash: plan.sourceHash });
                this.onMarkdownWriteVerified?.(plan.path, true);
                plannedAdds.add(plan.path);
            } catch (error) {
                this.retry(plan.path, String(error));
            }
        }
        const writingFiles = activePlans.length ? beforeJournal.filter(current) : beforeJournal;
        const writingPaths = new Set(writingFiles.map(file => file.path));
        const trash = new Set<string>();
        const confirmedCommands = new Map<string, Set<number>>();
        if (writingFiles.some(file => file.notes_to_delete.length)) {
            this.deletionGuard?.();
            if (!this.deletionOwnership) throw new Error("Cannot verify deletion sources.");
            await this.deletionOwnership(new Map(writingFiles.filter(f => f.notes_to_delete.length).map(f => [f.path, f.notes_to_delete])));
            if (this.afterDeleteMode !== "keep") {
                if (!this.beforeDeletion) throw new Error("Cannot back up Markdown before deletion.");
                await this.beforeDeletion();
                this.deletionGuard?.();
            }
            await verifyProfile();
        }

        const changesToSuspend = suspensions.filter(change => writingPaths.has(change.path) && !this.retryPaths.has(change.path));
        if (changesToSuspend.length) {
            if (!this.applySuspension) throw new Error("Missing Anki suspension transport");
            const paths = new Set(changesToSuspend.map(change => change.path));
            const guard = async () => {
                await verifyProfile();
                if (this.stopAfterPacket?.() || [...paths].some(path => this.isStillCurrent?.(path) === false)) {
                    throw new Error("The source changed or export stopped. / Источник изменился или экспорт остановлен.");
                }
            };
            await guard();
            const reportSuspension = (action: 'suspend' | 'unsuspend', cards: readonly number[], confirmed = true) => {
                const changed = new Set(cards);
                for (const change of changesToSuspend) {
                    const ids = change.cards.filter(card => changed.has(card.cardId)).map(card => card.cardId);
                    if (!ids.length) continue;
                    if (confirmed) this.confirmedNote(action, change.id, change.path, () => [{ name: 'Card IDs', after: ids.join(', ') }]);
                    else this.onSyncChange?.({ action: 'unknown', direction: 'to-anki', path: change.path, noteId: change.id,
                        title: this.changeTitle(change.id), detail: action + ' · ' + ids.join(', ') });
                }
            };
            await this.applySuspension(new Map(changesToSuspend.map(change => [change.id, change.cards] as const)),
                new Map(changesToSuspend.map(change => [change.id, change.target] as const)), guard, reportSuspension,
                this.onSyncChange && ((action, cards) => reportSuspension(action, cards, false)));
            for (const path of paths) sentPaths.add(path);
        }

        const decks = new Map<string, Set<string>>();
        for (const file of writingFiles) {
            if (!plannedAdds.has(file.path)) continue;
            for (const note of file.all_notes_to_add) {
                const paths = decks.get(note.deckName) ?? new Set<string>();
                paths.add(file.path);
                decks.set(note.deckName, paths);
            }
        }
        for (const [deck, paths] of decks) enqueue(AnkiConnect.createDeck(deck), paths);

        const planByPath = new Map(activePlans.map(plan => [plan.path, plan]));
        for (const file of writingFiles) {
            if (!plannedAdds.has(file.path)) continue;
            const plan = planByPath.get(file.path)!;
            const requests = file.all_notes_to_add.map((note, index) => {
                const tag = recoveryTag(plan, index);
                if (!tag) throw new Error("Could not verify the pending Anki note creation tag.");
                const tags = [...note.tags.filter(value => !isRecoveryTag(value)), tag];
                const options = collectionDuplicateOptions(note);
                return { action: "addNote" as const, version: 6 as const, params: { note: { ...note, tags, options } } };
            });
            additions.set(file.path, enqueue(AnkiConnect.multi(requests), new Set([file.path])));
            sentPaths.add(file.path);
        }
        for (const file of writingFiles) {
            const changes = this.existingChanges.get(file.path);
            if (changes?.length) {
                for (const change of changes) {
                    if (change.action === "changeDeck") movePaths.set(change, file.path);
                    enqueue(change, new Set([file.path]));
                }
                submittedChanges.set(file.path, changes);
                sentPaths.add(file.path);
            }
            if (file.notes_to_delete.length) {
                const active = file.notes_to_delete.filter(id => !this.absentDeletes.has(id));
                if (active.length) {
                    const request = { action: "deleteNotes" as const, version: 6 as const, params: { notes: active } };
                    this.reviewedRequests.set(request, active.map(id => reviewedDeletions.get(id)!));
                    deletions.set(file.path, enqueue(request, new Set([file.path])));
                }
                sentPaths.add(file.path);
            }
        }

        const { responses: response, uncertain, problem } = await sendExportBatches(actions, send, this.stopAfterPacket, beforeSend, transport);
        if (uncertain) this.writeUncertain = problem;
        if (!Array.isArray(response) || response.length !== actions.length) {
            checkFastResponses(actions, response, this.importErrors, "Import");
            return sentPaths;
        }
        actions.forEach((action, index) => {
            const errors: string[] = [];
            checkFastResponses([action], [response[index]], errors, "Import action " + (index + 1));
            if (!errors.length) confirmedActions.add(action);
            for (const path of actionPaths[index]) {
                for (const error of errors) this.retry(path, error);
            }
        });
        for (const [path, actionIndex] of additions) {
            const plan = planByPath.get(path)!;
            const rejected = duplicateFirstFieldSlots(response[actionIndex], plan.signatures.length);
            if (!rejected.length) continue;
            const scanned = fileMappings.get(path)!.scanned;
            const byNote = new Map((scanned.previewCandidates ?? []).map(range => [range.note, range] as const));
            const ranges = rejected.map(slot => byNote.get(scanned.all_notes_to_add[slot]));
            const before = scanned.original_file;
            const locations = duplicateFirstFieldSources(before, before, ranges);
            const issues = rejected.map((slot, index): ExportCardIssue => ({
                code: "duplicate-first-field", line: locations[index]?.line ?? plan.slotLines?.[slot] ?? 1,
                source: locations[index], deck: scanned.all_notes_to_add[slot].deckName,
                message: "Anki refused to create this note because its first field matches an existing note in this collection. Find the original in Anki and restore its ID in Markdown.",
            }));
            for (const issue of issues) this.recordCardIssue(path, issue);
            const previous = duplicateSources.get(path);
            duplicateSources.set(path, { before, ranges: [...(previous?.ranges ?? []), ...ranges],
                issues: [...(previous?.issues ?? []), ...issues], slots: new Set(rejected) });
        }
        const unsent = new Set(actions.filter((_action, index) => isUnsentExportResponse(response[index])));
        if (unsent.size) {
            for (const [path, changes] of submittedChanges) submittedChanges.set(path, changes.filter(change => !unsent.has(change)));
        }

        if (activePlans.length) {
            const records = activePlans.map(plan => {
                const actionIndex = additions.get(plan.path);
                const slots = actionIndex === undefined ? Array<RecoverySlot>(plan.signatures.length).fill(null) :
                    readRecoverySlots(response[actionIndex], plan.signatures.length, isUnsentExportResponse);
                slots.forEach((value, slot) => {
                    const line = plan.slotLines?.[slot];
                    if (value === "unknown" && line) this.recordCardIssue(plan.path, { code: "unconfirmed-response", line,
                        message: "Anki could not confirm this creation. Open Review Pending Anki Creations before retrying." });
                });
                return { path: plan.path, slots };
            });
            await recovery!.record(records, profile);
        }
        if (profileProblem() || (writingPaths.size && await checkAtBoundary(true))) {
            retryPaths(writingPaths, "export stopped before confirming the Anki writes");
            return sentPaths;
        }

        const intents: Array<{ path: string; writtenHash: string; sourceHash: string }> = [];
        const settled: Array<{ path: string; currentHash: string }> = [];
        const cleanMarkers = new Set<string>();
        const appliedDates = new Map<number, { name: string; before: string; after: string }>();
        await recheckResumeOwners();
        for (let index = 0; index < this.ownFiles.length; index++) {
            const own = this.ownFiles[index];
            own.note_ids = [];
            if (!writingPaths.has(own.path) || blockedRecovery.has(own.path)) continue;
            const source = this.recoverySources.get(own.path);
            const sourceHash = source?.cleanHash ?? this.sourceHashes.get(own.path)!;
            const entry = recovery?.get(own.path);
            const slots = resumes.get(own.path) ?? (plannedAdds.has(own.path) ? entry?.slots : undefined);
            if (slots && entry) {
                const namedLayouts = new Map((own.previewCandidates ?? []).map(row => [row.note, row.namedLayout] as const));
                slots.forEach((id, slot) => {
                    const note = own.all_notes_to_add[slot];
                    if (typeof id === "number" && note) createdNotes.push({ id, path: own.path, modelName: note.modelName,
                        fields: note.fields, tags: mergeTags(note.tags), deck: note.deckName, namedLayout: namedLayouts.get(note) });
                });
                if (slots.includes("unknown")) {
                    this.retry(own.path, this.pendingMessage(entry));
                } else {
                    own.note_ids = slots.map(id => typeof id === "number" ? id : null);
                    const duplicateSlots = duplicateSources.get(own.path)?.slots;
                    if (own.note_ids.some((id, slot) => id === null && !duplicateSlots?.has(slot))) {
                        this.retry(own.path, "one or more notes were not added; the saved IDs will be reused on retry");
                    }
                    if (source) cleanMarkers.add(own.path);
                    else if (!own.note_ids.some(id => id !== null)) settled.push({ path: own.path, currentHash: sourceHash });
                }
            }

            let wroteNewIds = false;
            if (own.note_ids.some(id => id !== null)) {
                own.writeIDs();
                const seen = new Set(collectNoteIds(own.file));
                wroteNewIds = own.file !== own.original_file && own.note_ids.every(id => id === null || seen.has(id));
                if (!wroteNewIds) {
                    own.file = own.original_file;
                    own.note_ids = [];
                    cleanMarkers.delete(own.path);
                    this.retry(own.path, "Anki created an ID but no matching Markdown position could be written");
                }
            }
            if (manualLinks.has(own.path)) cleanMarkers.add(own.path);
            const deletionIndex = deletions.get(own.path);
            if (writingPaths.has(own.path) && own.notes_to_delete.length) {
                try {
                    if (!current(own)) throw new Error("Markdown changed before clearing the deletion command.");
                    this.deletionGuard?.();
                    const accepted = deletionIndex !== undefined && fastResult(response[deletionIndex]) === null;
                    const eligible = own.notes_to_delete.filter(id => accepted || this.absentDeletes.has(id));
                    if (eligible.length) {
                        const presence = await deletionPresence(eligible, profile);
                        const confirmed = new Set(eligible.filter(id => presence.get(id) === false));
                        for (const id of confirmed) if (!this.absentDeletes.has(id)) {
                            this.confirmedNote('delete', id, own.path, () =>
                                (this.deletedFields.get(id) ?? []).map(([name, before]) => ({ name, before })));
                        }
                        if (confirmed.size !== eligible.length) this.retry(own.path, "Anki still contains a requested deletion ID.");
                        const plan = explicitDeletes(own.file, this.diagnosticSyntax ?? {}, this.data.custom_regexps, this.data.page_model,
                            [this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]);
                        if (!plan || !current(own)) throw new Error("Deletion command changed; open a fresh preview.");
                        const result = cleanConfirmedDeletes(own.file, plan, confirmed, this.afterDeleteMode, this.trashDeletedPages, [], this.deletedArchiveLabel);
                        if (result.trash) trash.add(own.path);
                        else own.file = result.text;
                        confirmedCommands.set(own.path, confirmed);
                    }
                } catch (error) { this.retry(own.path, String(error)); }
            }
            if (own.separatorRepairs?.size && !this.retryPaths.has(own.path) && !trash.has(own.path) && !this.importErrors.length) {
                const repairs = spacing.get(own.path) ?? new Map<number, SeparatorRepair>();
                own.note_ids.forEach((id, slot) => {
                    const repair = own.separatorRepairs?.get(own.all_notes_to_add[slot]);
                    if (typeof id === 'number' && repair) repairs.set(id, repair);
                });
                if (repairs.size) {
                    spacing.set(own.path, repairs);
                    spacedIds.set(own.path, this.saveSpacing(own, repairs));
                }
            }
            const ids = datedIds.get(own.path);
            if (localDate && ids && !this.retryPaths.has(own.path) && !trash.has(own.path) && !this.importErrors.length) {
                own.file = dateLinkedMarkers(own.file, findIdMarkers(own.file, this.diagnosticSyntax), ids, localDate,
                    this.onSyncChange ? (id, _line, before, after) => {
                        appliedDates.set(id, { name: 'Anki ID', before, after });
                        return true;
                    } : undefined);
            }
            if (wroteNewIds) intents.push({ path: own.path, writtenHash: own.getHash(), sourceHash });
        }
        if (intents.length) {
            await recovery!.intendMany(intents, profile);
            if (await checkAtBoundary(true)) {
                retryPaths(writingPaths, "export stopped before saving the Anki IDs");
                return sentPaths;
            }
        }
        await recheckResumeOwners();
        if (confirmedCommands.size && this.forgetConfirmedDeletions) {
            await this.forgetConfirmedDeletions(new Set(Array.from(confirmedCommands.values()).flatMap(ids => Array.from(ids))));
        }
        const intentHashes = new Map(intents.map(intent => [intent.path, intent.writtenHash]));
        for (let index = 0; index < this.ownFiles.length; index++) {
            const own = this.ownFiles[index];
            if (blockedRecovery.has(own.path)) continue;
            const file = this.files[index];
            const source = this.recoverySources.get(own.path);
            const clean = cleanMarkers.has(own.path);
            if (own.file === own.original_file && !clean && !trash.has(own.path)) continue;
            try {
                if (file.path !== own.path) throw new Error("file moved or renamed");
                if (source) {
                    own.original_file = source.raw;
                    if (!clean) own.file = addRecoveryMarker(own.file, source.token);
                }
                const verified = confirmedCommands.get(own.path);
                const recordCleanup = () => {
                    for (const id of verified ?? []) if (this.absentDeletes.has(id)) this.confirmedNote('cleanup', id, own.path);
                };
                if (verified?.size) {
                    this.deletionGuard?.();
                    await verifyProfile(true);
                    const presence = await deletionPresence(Array.from(verified), profile);
                    if (Array.from(verified).some(id => presence.get(id) !== false) || !current(own)) throw new Error("Deletion is no longer verified.");
                    this.deletionGuard?.();
                    if (trash.has(own.path)) {
                        if (this.afterDeleteMode !== "remove" || !this.trashDeletedPages || await this.app.vault.read(file) !== own.original_file ||
                            file.path !== own.path || !current(own)) throw new Error("Page changed before moving to trash.");
                        await verifyProfile(true);
                        this.deletionGuard?.();
                        if (!current(own)) throw new Error("Page changed before moving to trash.");
                        await this.app.vault.trash(file, false);
                        if (this.app.vault.getAbstractFileByPath(own.path)) throw new Error("Page was not moved to vault trash.");
                        recordCleanup();
                        this.onMarkdownWriteVerified?.(own.path, false);
                        continue;
                    }
                }
                await this.app.vault.process(file, current => {
                    if (verified?.size) this.deletionGuard?.();
                    if (file.path !== own.path || current !== own.original_file) {
                        throw new Error("file changed during import");
                    }
                    return own.file;
                });
                const writtenHash = intentHashes.get(own.path);
                if (!writtenHash && !clean) this.readCount++;
                if (await this.app.vault.read(file) !== own.file) {
                    throw new Error(writtenHash || clean ? "could not verify the saved Anki IDs in Markdown" :
                        "could not verify the saved Markdown after removing confirmed Anki deletion markers");
                }
                if (this.onSyncChange) for (const id of datedIds.get(own.path) ?? []) {
                    const field = appliedDates.get(id);
                    if (field) this.onSyncChange({ action: 'id-date', direction: 'local', path: own.path,
                        noteId: id, title: this.changeTitle(id), fields: [field] });
                }
                for (const id of spacedIds.get(own.path) ?? []) {
                    const repair = spacing.get(own.path)!.get(id)!;
                    this.confirmedNote('normalize', id, own.path, () => [{ name: 'Markdown', before: repair.before, after: repair.after }]);
                }
                const duplicates = duplicateSources.get(own.path);
                if (duplicates && own.file !== duplicates.before) {
                    const positions = own.id_indexes.concat(own.inline_id_indexes, own.regex_id_indexes);
                    const insertions = writtenHash ? positions.filter((_position, slot) => Boolean(own.note_ids[slot])) : [];
                    const locations = duplicateFirstFieldSources(duplicates.before, own.file, duplicates.ranges, insertions);
                    duplicates.issues.forEach((issue, position) => {
                        issue.source = locations[position];
                        if (issue.source) issue.line = issue.source.line;
                    });
                }
                recordCleanup();
                this.onMarkdownWriteVerified?.(own.path, false);
                if (writtenHash || clean) {
                    if (resumes.has(own.path)) {
                        const recovered = own.note_ids.filter((id): id is number => id !== null);
                        this.recoveredCreations += recovered.length;
                        for (const id of recovered) this.confirmedNote('link', id, own.path);
                    }
                    const entry = recovery?.get(own.path);
                    if (journal && entry) own.note_ids.forEach((noteId, slot) => {
                        const tag = recoveryTag(entry, slot);
                        if (noteId !== null && tag) this.verifiedCreationLinks.push({ path: own.path, noteId, tag });
                    });
                    const linked = manualLinks.get(own.path);
                    if (linked) await recovery!.settleLinked(own.path, linked, profile);
                    else settled.push({ path: own.path, currentHash: writtenHash ?? source!.cleanHash });
                    sentPaths.add(own.path);
                }
                if (this.data.add_file_link) {
                    const url = this.getUrl(file);
                    const links = own.note_ids.flatMap((id, slot) => {
                        if (id === null) return [];
                        const note = own.all_notes_to_add[slot];
                        const fields = cardSourceFieldPatch(note.fields, url, this.app.vault.getName(), own.path, id,
                            this.data.file_link_fields?.[note.modelName]);
                        return Object.keys(fields).length ? [AnkiConnect.updateNoteFields(id, fields)] : [];
                    });
                    if (links.length) {
                        for (const link of links) track(link, new Set([own.path]));
                        if (this.writeUncertain) {
                            this.retry(own.path, "pending card source link after an unconfirmed Anki response");
                            continue;
                        }
                        const { responses: feedback, uncertain, problem } = await sendExportBatches(links, send, this.stopAfterPacket, beforeSend, transport);
                        if (uncertain) this.writeUncertain = problem;
                        const errors: string[] = [];
                        checkFastResponses(links, feedback, errors, "Card source links");
                        for (const error of errors) this.retry(own.path, error);
                        links.forEach((link, position) => {
                            if (fastResult(feedback[position]) !== undefined) confirmedActions.add(link);
                        });
                        if (profileProblem()) break;
                        const existing = submittedChanges.get(own.path) ?? [];
                        submittedChanges.set(own.path, existing.concat(links.filter((_link, offset) =>
                            !isUnsentExportResponse(feedback[offset]))));
                    }
                }
            } catch (error) {
                const ids = own.note_ids.filter(id => id !== null).join(", ");
                this.retry(own.path, String(error) + (ids ? " (new Anki IDs: " + ids + ")" : ""));
            }
        }
        if (settled.length) await recovery!.settleMany(settled, profile);
        if (profileProblem()) {
            retryPaths(writingPaths, "export stopped before verifying card source links");
            return sentPaths;
        }
        const models = new Map(this.ownFiles.flatMap(file =>
            file.notes_to_edit.map(({ identifier, note }) => [identifier, note.modelName] as const)));
        const verifiedMoves = new Set<number>();
        await verifyExistingNoteFieldWrites(submittedChanges, (path, message) => this.retry(path, message), {
            models, created: createdNotes, namedLayouts: this.namedLayouts, confirmedActions, capture: receipt => {
                this.oneWayReceipts.push(receipt);
                this.verifiedWriteReceipts.push(receipt);
            },
            onDeckVerified: card => verifiedMoves.add(card), reviewedCards: this.reviewedStudyCards, onCardImpact: impact => this.cardImpactResults.push(impact),
        });
        if ((submittedChanges.size || createdNotes.length) && await checkAtBoundary(true)) {
            retryPaths(submittedChanges.keys(), "export stopped before confirming the Anki writes");
        } else if (this.onConfirmedNote || this.onSyncChange) {
            const receipts = new Map(this.verifiedWriteReceipts.map(receipt => [receipt.id, receipt] as const));
            const added = new Set<number>();
            for (const note of createdNotes) {
                const receipt = receipts.get(note.id);
                if (!plannedAdds.has(note.path) || !receipt) continue;
                added.add(note.id);
                if (this.onSyncChange) {
                    this.changeTitle(note.id);
                    const first = this.data.fields_dict?.[note.modelName]?.[0];
                    if (first && note.fields[first]) this.changeTitles?.set(note.id, note.fields[first]);
                }
                this.confirmedNote('add', note.id, note.path, () =>
                    Object.entries(receipt.fields ?? {}).map(([name, after]) => ({ name, after })));
            }
            for (const [path, changes] of submittedChanges) for (const request of changes) {
                if (!confirmedActions.has(request)) continue;
                if (request.action === 'updateNoteFields') {
                    const { id, fields } = request.params.note;
                    const receipt = receipts.get(id);
                    if (!receipt || added.has(id)) continue;
                    const confirmed = Object.entries(fields).filter(([name, value]) => receipt.fields?.[name] === value);
                    if (!confirmed.length) continue;
                    this.confirmedNote('edit', id, path, () => {
                        const before = new Map(this.reviewedRequests.get(request)?.find(item => item.id === id)?.fields);
                        return confirmed.map(([name, after]) => ({ name, before: before.get(name), after }));
                    });
                } else if (request.action === 'addTags' || request.action === 'removeTags') {
                    const adding = request.action === 'addTags';
                    for (const id of request.params.notes) {
                        const receipt = receipts.get(id);
                        const observed = adding ? receipt?.matchedTags : receipt?.removedTags;
                        if (!observed?.length) continue;
                        const tags = request.params.tags.split(' ').filter(tag => observed.includes(oneWayTagKey(tag)));
                        if (tags.length) this.confirmedNote('tags', id, path, () => [
                            adding ? { name: 'Tags (+)', after: tags.join(' ') } : { name: 'Tags (−)', before: tags.join(' ') }]);
                    }
                } else if (request.action === 'changeDeck') {
                    const id = this.moveOwners.get(request);
                    const moved = request.params.cards.filter(card => verifiedMoves.has(card));
                    if (id !== undefined && moved.length) this.confirmedNote('move', id, path, () => {
                        const wanted = new Set(moved);
                        return (this.previewDeckMoves.get(path) ?? []).flatMap(move =>
                            move.cardIds.filter(card => wanted.has(card) && move.to === request.params.deck)
                                .map(card => ({ name: String(card), before: move.from, after: move.to })));
                    });
                }
            }
        }
        return sentPaths;
    }

    

    getHashes(): Record<string, string> {
        let result: Record<string, string> = {}
        for (let file of this.ownFiles) {
            result[file.path] = file.file === file.original_file
                ? this.sourceHashes.get(file.path) ?? file.getHash() : file.getHash()
        }
        return result
    }

    



}
