/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
"use strict";

function patchAcceptedMatches(searchCode) {
    const nativeMatches = /\bfindignore\(\s*regexp\s*,\s*this\.file\s*,\s*this\.ignore_spans\s*\)/g;
    const directMatches = /this\.file\.matchAll\(\s*regexp\s*\)/g;
    const nativeCount = Array.from(searchCode.matchAll(nativeMatches)).length;
    const directCount = Array.from(searchCode.matchAll(directMatches)).length;
    if (nativeCount + directCount !== 1) throw new Error("Unexpected Custom Regexp match loop.");
    const usesClaimedSpans = nativeCount === 1;
    const candidates = usesClaimedSpans ? "matchesOutsideSpans(matches, this.file, this.ignore_spans)" : "matches";
    const excluded = "(start, end) => this.tableOwnsRange?.(start, end) || this.multilineOwnsRange?.(start, end, note_type) || this.presetStartBlocked?.(start) || this.linkedBulletOverlap(start, end)" +
        (usesClaimedSpans ? "" : " || this.ignore_spans.some(([from, to]) => from <= start && start < to)");
    const code = searchCode.replace(usesClaimedSpans ? nativeMatches : directMatches,
        () => `checkedCustomAnkiMatches(${candidates}, this.file, search_id, this.idDateWarnings, ${excluded})`)
        .replace(/(\bnew\s+RegexNote\s*\(\s*)match(?=\s*[,)])/g, "$1copyMatchForRegexNote(match)");
    return { code, usesClaimedSpans };
}

function pageMethods() {
    return `
    tableIdWarnings?: Array<{ line: number; id: number }>
    private tableOwnsRange?: (start: number, end: number) => boolean
    private presetStartBlocked?: (start: number) => boolean
    private multilineOwnsRange?: MultilineOwnership
    pageCard?: PageCard | null
    private namedFieldProtection?: Map<string, ReadonlySet<string> | undefined>

    namedSyncFrozenFields(model: string): ReadonlySet<string> | undefined {
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
    }`;
}

function patchPageIdWriter(source) {
    const write = /\bwriteIDs\(\)\s*\{/;
    if (!write.test(source)) throw new Error("Missing ID writer for page cards.");
    return source.replace(write, `$&
        if (this.pageCard) {
            const id = this.note_ids[0];
            if (id != null) this.file = writePageId(this.file, this.pageCard, id, this.data.comment,
                this.data.id_date ? formatLocalIdDate(new Date()) : undefined, this.data.page_id_location);
            return;
        }`);
}

function patchCustomRegexpIsolation(source, ts) {
    const tree = ts.createSourceFile("file.ts", source, ts.ScriptTarget.Latest, true);
    const core = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AllFile");
    const method = name => core?.members.find(node =>
        ts.isMethodDeclaration(node) && node.name.getText(tree) === name);
    const search = method("search");
    const scan = method("scanFile");
    if (!search?.body || !scan?.body) throw new Error("Missing Custom Regexp parser entry points.");

    const searchStart = search.getStart(tree);
    const searchEnd = search.body.end;
    let searchCode = source.slice(searchStart, searchEnd);
    const expression = /^[ \t]*(?:let|const) id_str(?:\s*:\s*string)?\s*=\s*([^\r\n]+?);?[ \t]*\r?\n[ \t]*(?:let|const) tag_str(?:\s*:\s*string)?\s*=\s*([^\r\n]+?);?[ \t]*\r?\n([ \t]*)(?:let|const) regexp(?:\s*:\s*RegExp)?\s*=\s*new RegExp\(\s*regexp_str\s*\+\s*tag_str\s*\+\s*id_str\s*,\s*(['"])([a-z]+)\4\s*\)\s*;?/m;
    const native = expression.exec(searchCode);
    if (!native || !native[5].includes("g")) throw new Error("Unexpected Custom Regexp expression assembly.");
    const retainedSuffix = native[1].trim();
    const tagSuffix = native[2].trim();
    const indent = native[3];
    const flags = native[5];
    searchCode = searchCode.replace(expression,
        indent + 'const pattern = this.customRegexpPattern(regexp_str, search_id, search_tags);' +
        '\n' + indent + 'const matches = matchesByPattern.get(customRegexpKey(pattern));' +
        '\n' + indent + 'if (!matches) throw new Error("Missing Custom Regexp worker result.");');
    const loop = patchAcceptedMatches(searchCode);
    searchCode = loop.code.replace('this.ignore_spans.push([match.index, match.index + match[0].length])', match =>
        String.raw`const spacingRule = isKnowledgeRule(regexp_str) || currentCardExpression(regexp_str) === remNoteExpression
                    const line = spacingRule ? match[0].split(/[\r\n]/u, 1)[0] : ''
                    if (isKnowledgeRule(regexp_str) && !knowledgeMatchAllowed(line, search_id)) continue
                    ` + match).replace('if (search_id) {', match =>
        `const repair = spacingRule && separatorRepair(line, search_id)
                    if (repair) (this.separatorRepairs ??= new Map()).set(parsed.note, repair)
                    ` + match);
    const searchSignature = /^search\(\s*(note_type:\s*string,\s*regexp_str:\s*string)\s*\)/;
    if (!searchSignature.test(searchCode)) throw new Error("Unexpected Custom Regexp search signature.");
    searchCode = searchCode.replace(searchSignature,
        'search($1, matchesByPattern: ReadonlyMap<string, readonly RegExpMatchArray[]>)');

    const scanStart = scan.getStart(tree);
    const scanEnd = scan.body.end;
    let scanCode = source.slice(scanStart, scanEnd);
    const scanSignature = /^scanFile\(\s*\)(?:\s*:\s*void)?/;
    const stockLoop = /^[ \t]*for\s*\((?:let|const) note_type in this\.custom_regexps\)\s*\{/m;
    const stockCall = /this\.search\(\s*note_type\s*,\s*regexp_str\s*\)/;
    if (!scanSignature.test(scanCode) || !stockLoop.test(scanCode) || !stockCall.test(scanCode)) {
        throw new Error("Unexpected Custom Regexp scan loop.");
    }
    scanCode = scanCode.replace(scanSignature, "private async scanBlockFormats(options?: CustomRegexpOptions, pageOnly = false)")
        .replace(stockLoop, line => [
            "        const patterns: CustomRegexpPattern[] = [];",
            "        for (const noteType in this.custom_regexps) {",
            "            const expression = this.custom_regexps[noteType];",
            "            if (pageOnly || !expression || expression === pageCardExpression) continue;",
            "            for (const hasId of [true, false]) for (const hasTags of [true, false]) {",
            "                patterns.push(this.customRegexpPattern(expression, hasId, hasTags, noteType));",
            "            }",
            "        }",
            "        const matchesByPattern = patterns.length ? await matchCustomRegexps(this.file, patterns, options) : new Map();",
            "        let guard: ((start: number) => boolean) | undefined;",
            "        if (!pageOnly && Object.values(this.custom_regexps ?? {}).includes(tableCardExpression)) {",
            "            const conflicts = tableIdConflicts(this.file, start => (guard ??= presetStartGuard(this.file, this.ignore_spans))(start));",
            "            if (conflicts.length) { this.tableIdWarnings = conflicts; this.tableOwnsRange = makeSpanOverlap(conflicts.map(({ start, end }) => [start, end])); }",
            "        }",
            "        let wizardGuard: ((start: number) => boolean) | undefined;",
            "        if (!pageOnly && patterns.length > 4) checkWizardRowModels(this.file, this.custom_regexps,",
            "            (model, expression) => matchesByPattern.get(customRegexpKey(this.customRegexpPattern(expression, false, false, model))) ?? [],",
            "            () => {",
            "                const blocked = wizardGuard = wizardStartGuard(this.file, this.ignore_spans, [this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]);",
            "                return (from, to) => blocked(from) || this.linkedBulletOverlap(from, to) || !!this.multilineOwnsRange?.(from, to);",
            "            });",
            line,
            "            if (pageOnly || this.custom_regexps[note_type] === pageCardExpression) continue;",
            "            this.presetStartBlocked = readDelimitedRule(this.custom_regexps[note_type])",
            "                ? (wizardGuard ??= wizardStartGuard(this.file, this.ignore_spans, [this.data.DECK_REGEXP, this.data.TAG_REGEXP, this.data.FROZEN_REGEXP]))",
            "                : (isKnowledgeRule(this.custom_regexps[note_type]) || namedCardExpressions.has(currentCardExpression(this.custom_regexps[note_type])))",
            "                ? (guard ??= presetStartGuard(this.file, this.ignore_spans)) : undefined;",
        ].join("\n"))
        .replace(stockCall, "this.search(note_type, regexp_str, matchesByPattern)");
    scanCode += [
        "",
        "",
        "    private customRegexpPattern(regexp_str: string, search_id: boolean, search_tags: boolean, label?: string): CustomRegexpPattern {",
        "        const id = " + retainedSuffix + ";",
        "        const tags = " + tagSuffix + ";",
        "        return { source: cardRegexpWithSuffix(regexp_str, tags, id), flags: " + JSON.stringify(flags) + ", label };",
        "    }",
    ].join("\n");

    scanCode += pageMethods();
    for (const [start, end, replacement] of [[searchStart, searchEnd, searchCode], [scanStart, scanEnd, scanCode]]
        .sort((left, right) => right[0] - left[0])) {
        source = source.slice(0, start) + replacement + source.slice(end);
    }
    if (loop.usesClaimedSpans) {
        const legacyGenerator = /^function\*\s*findignore\([^\r\n]+\)\s*:[^\r\n]+\{\s*yield\* matchesOutsideSpans\(pattern, text, ignore_spans\)\s*\}\r?\n/m;
        if (!legacyGenerator.test(source)) throw new Error("Unexpected claimed-range helper for Custom Regexp.");
        source = source.replace(legacyGenerator, "");
    }
    // Restrict new spacing to actual table-preset IDs; arbitrary custom rules keep their exact separators.
    const updated = ts.createSourceFile("file.ts", source, ts.ScriptTarget.Latest, true);
    const updatedClass = updated.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AllFile");
    const writer = updatedClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(updated) === "writeIDs");
    const inserts = [];
    function collect(node) {
        if (ts.isCallExpression(node) && node.expression.getText(updated) === "string_insert") inserts.push(node.arguments.end);
        ts.forEachChild(node, collect);
    }
    if (writer) collect(writer);
    if (source.includes("function string_insert(") && !inserts.length) throw new Error("Missing ID insertion in writeIDs.");
    for (const at of inserts.reverse()) source = source.slice(0, at) + ", this.tableIdPositions()" + source.slice(at);
    source = patchPageIdWriter(source);
    return "import { multilineOwnership, checkWizardRowModels } from './wizard-card-ownership'\n" +
        "import type { MultilineOwnership } from './wizard-card-ownership'\n" +
        "import { readDelimitedRule } from './delimited-rule'\n" +
        "import { insertPageFooterId, validatePageYamlPlacement, readPageCard, writePageId, isLinkedPageSchema, needsLinkedPageLayout, pageSourceContext, pageExportFieldNames, pageContentTags } from './page-card'\n" +
        "import type { PageCard } from './page-card'\n" +
        "import { currentCardExpression, isKnowledgeRule, knowledgeMatchAllowed, separatorRepair, cardRegexpWithSuffix, tableCardExpression, remNoteExpression, applyRemNoteMetadata, namedCardExpressions, pageCardExpression } from './card-format-presets'\n" +
        "import { presetStartGuard, wizardStartGuard, tableIdConflicts } from './card-export-diagnostics'\n" +
        "import { checkedCustomAnkiMatches, copyMatchForRegexNote } from './anki-id-marker'\n" +
        "import type { AnkiIdDateWarning } from './anki-id-marker'\n" +
        "import { customRegexpKey, matchCustomRegexps } from './custom-regexp-worker'\n" +
        "import type { CustomRegexpOptions, CustomRegexpPattern } from './custom-regexp-worker'\n" + source;
}

module.exports = { patchCustomRegexpIsolation, patchAcceptedMatches, pageMethods, patchPageIdWriter };
