/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
"use strict";

function replaceOnce(source, pattern, replacement, name) {
    const matches = Array.from(source.matchAll(new RegExp(pattern.source, pattern.flags + "g")));
    if (matches.length !== 1) throw new Error("Unexpected " + name + " in Export to Anki 3.6.0.");
    return source.replace(pattern, replacement);
}

function patchIdWrites(source) {
    const declaration = /^(function string_insert\(\s*(\w+)\s*:\s*string\s*,\s*(\w+)\s*:[^\r\n]+\)\s*:\s*string\s*\{)[\s\S]*?^\}/m;
    const result = replaceOnce(source, declaration, (_match, header, text, inserts) =>
        header.replace(/\)(?=\s*:\s*string\s*\{)/, ", tablePositions?: ReadonlySet<number>)") +
        "\n    return joinIdInsertions(" + text + ", " + inserts +
        ", tablePositions ? (source, position, marker) => tablePositions.has(position) ? tableIdSpacing(source, position, marker) : marker : undefined)\n}", "Anki ID insertion routine");
    return "import { tableIdSpacing } from './card-format-presets'\nimport { joinIdInsertions } from './markdown-pipeline'\n" + result;
}

function patchLinkedCoverage(source) {
    source = replaceOnce(source, /private linkedBulletRanges: Array<\[number, number\]> = \[\]/,
        "private linkedBulletOverlap = (_start: number, _end: number): boolean => false\n    markdownWarningLines: number[] = []", "linked bullet range property");
    source = replaceOnce(source, /this\.linkedBulletRanges = \[\]\s+for \(const bullet of this\.linkedBullets \?\? \[\]\) \{/,
        `const claimed = makeSpanLookup(this.ignore_spans)
        const linkedRanges: Array<[number, number]> = []
        let acceptedEnd = -Infinity
        for (const bullet of this.linkedBullets ?? []) {`, "linked bullet loop");
    source = replaceOnce(source, /this\.ignore_spans\.some\(\(\[start, end\]\) => start <= bullet\.start && bullet\.start < end\)/,
        "claimed(bullet.start) || bullet.start < acceptedEnd", "linked bullet ownership check");
    source = replaceOnce(source, /this\.linkedBulletRanges\.push\(\[start, end\]\)\s+\}\s+\}/,
        `linkedRanges.push([start, end])
            acceptedEnd = end
        }
        this.linkedBulletOverlap = makeSpanOverlap(linkedRanges)
    }`, "linked bullet range insertion");
    const generator = /^(function\*\s*findignore\([^\r\n]+\)\s*:[^\r\n]+\{)[\s\S]*?^\}/m;
    if (generator.test(source)) {
        source = replaceOnce(source, generator,
            "$1\n    yield* matchesOutsideSpans(pattern, text, ignore_spans)\n}", "custom-regexp range check");
        if ((source.match(/\bcontained_in\b/g) ?? []).length === 1) {
            source = source.replace(/^function\s+contained_in\([^\r\n]+\)\s*:[^\r\n]+\{[\s\S]*?^\}[ \t]*\r?\n/m, "");
        }
        source = "import { matchesOutsideSpans } from './markdown-pipeline'\n" + source;
    }

    const originalSpans = /^([ \t]*)this\.ignore_spans\.push\(\.\.\.spans\((c\.(?:OBS_INLINE_MATH_REGEXP|OBS_DISPLAY_MATH_REGEXP|OBS_CODE_REGEXP|OBS_DISPLAY_CODE_REGEXP)),\s*this\.file\)\);?[ \t]*$/gm;
    const spanCalls = Array.from(source.matchAll(originalSpans));
    if (spanCalls.length === 4 && new Set(spanCalls.map(match => match[2])).size === 4) {
        let inserted = false;
        source = source.replace(originalSpans, (_match, indent) => {
            if (inserted) return "";
            inserted = true;
            return `const { code, math } = markdownSyntaxSpans(this.file)
        this.markdownWarningLines = suspiciousMathCardLines(this.file, math, code)
        this.markdownProtected = makeSpanLookup(code.concat(math))
        this.ignore_spans.push(...code, ...math)`.split("\n").map(line => indent + line.trimStart()).join("\n");
        });
        source = replaceOnce(source, /abstract class AbstractFile\s*\{/,
            "$&\n    protected markdownProtected = (_offset: number): boolean => false", "Markdown protection state");
        for (const name of ["NOTE_REGEXP", "INLINE_REGEXP"]) {
            const loop = new RegExp("(for \\((?:let|const) note_match of this\\.file\\.matchAll\\(this\\.data\\." + name + "\\)\\) \\{)(\\r?\\n[ \\t]*)");
            source = replaceOnce(source, loop, "$1$2if (this.markdownProtected(note_match.index ?? 0)) continue$2", name + " protected-range check");
        }
        const deleteLoop = /(for \((?:let|const) match of this\.file\.matchAll\(this\.data\.EMPTY_REGEXP\)\) \{)(\r?\n[ \t]*)/;
        source = replaceOnce(source, deleteLoop, "$1$2if (this.markdownProtected(match.index ?? 0)) continue$2", "protected deletion marker");
        source = replaceOnce(source, /^([ \t]*)this\.file = this\.file\.replace\(this\.data\.EMPTY_REGEXP,\s*["']{2}\);?/m,
            (_match, indent) => indent + "const { code, math } = markdownSyntaxSpans(this.file)\n" +
                indent + "this.file = removeUnprotectedMatches(this.file, this.data.EMPTY_REGEXP, makeSpanLookup(code.concat(math)))",
            "protected deletion cleanup");
        source = `import { findMarkdownSyntaxSpans, removeUnprotectedMatches, suspiciousMathCardLines } from './markdown-pipeline'

function markdownSyntaxSpans(text: string) {
    return findMarkdownSyntaxSpans(text, c.OBS_DISPLAY_CODE_REGEXP, c.OBS_CODE_REGEXP, c.OBS_DISPLAY_MATH_REGEXP, c.OBS_INLINE_MATH_REGEXP)
}

` + source;
    } else if (spanCalls.length || /\badd_spans_to_ignore\s*\(/.test(source)) {
        throw new Error("Unexpected math and code span definitions in Export to Anki 3.6.0.");
    }

    return "import { makeSpanLookup, makeSpanOverlap } from './markdown-pipeline'\n" + source;
}

function patchCardPreviewRanges(source, ts) {
    const file = ts.createSourceFile("file.ts", source, ts.ScriptTarget.Latest, true);
    const parser = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AllFile");
    if (!parser) throw new Error("Missing Anki card parser in src/file.ts.");
    const methods = [
        { name: "scanNotes", match: "note_match", added: "notes_to_add", indexes: "id_indexes" },
        { name: "scanInlineNotes", match: "note_match", added: "inline_notes_to_add", indexes: "inline_id_indexes" },
        { name: "search", match: "match", added: "regex_notes_to_add", indexes: "regex_id_indexes" },
        { name: "scanLinkedBulletCards" },
    ];
    const edits = methods.map(({ name, match, added, indexes }) => {
        const method = parser.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
        if (!method?.body) throw new Error("Unexpected card preview parser method " + name + ".");
        const from = method.body.getStart(file) + 1;
        const to = method.body.end - 1;
        const start = match ? `${match}.index` : "start";
        const end = match ? `(${match}.index ?? -1) + ${match}[0].length` : "end";
        const authored = name === "scanLinkedBulletCards" ? "Object.keys(sourceFields)" :
            name === "search" ? "[...this.previewCapturedFields(parsed.note.modelName, match, search_id, search_tags), ...remNoteFields]" : "undefined";
        let body = replaceOnce(source.slice(from, to), /this\.notes_to_edit\.push\(parsed\)/,
            (name === "search" ? "{ const remNoteFields = applyRemNoteMetadata(regexp_str, match[0], parsed.note.fields, this.data.fields_dict[note_type]); " : "") +
            `this.notes_to_edit.push(this.previewCandidates ? this.captureLinkedPreview(parsed, ${start}, ${end}, ${authored}, ${name === "scanNotes"}) : parsed)` + (name === "search" ? " }" : ""),
            name + " editable-card capture");
        if (name === "scanNotes" || name === "scanInlineNotes") {
            const loop = /(for \((?:let|const) note_match of this\.file\.matchAll\(this\.data\.(?:NOTE_REGEXP|INLINE_REGEXP)\)\) \{)(\r?\n[ \t]*)/;
            body = replaceOnce(body, loop, "$1$2if (this.acceptExplicitType?.(note_match[0], " +
                String(name === "scanInlineNotes") + ") === false) continue$2", name + " invalid note type guard");
        }
        const capture = added ? new RegExp(`\\bthis\\.${added}\\.push\\(\\s*`, "g") : undefined;
        const next = capture ? body.replace(capture,
            `this.pushPreviewNote(this.${added}, ${start}, ${end}, ${name === "search" ? "regexp_str" : "undefined"}, ${name === "scanNotes"}, `) : body;
        if (indexes && body.includes(`this.${indexes}.push(`) && next === body) {
            throw new Error("Missing new-card capture in " + name + ".");
        }
        return { from, to, next };
    });
    for (const { from, to, next } of edits.sort((left, right) => right.from - left.from)) {
        source = source.slice(0, from) + next + source.slice(to);
    }
    return replaceOnce(source, /export class AllFile extends AbstractFile\s*\{/, `
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

$&
    /** UTF-16 offsets in the same Markdown snapshot passed to the parser. */
    previewCandidates?: CardPreviewCandidate[]
    separatorRepairs?: Map<AnkiConnectNote, NonNullable<ReturnType<typeof separatorRepair>>>
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
`, "card preview range storage");
}

function patchMarkdownConstants(source) {
    const constants = {
        OBS_INLINE_MATH_REGEXP: /(?<![\\$\p{L}\p{N}])\$(?![\s$])((?:\\[^\r\n]|[^\\$\r\n])+?)(?<!\s)\$(?![$\p{L}\p{N}])/gu,
        OBS_DISPLAY_MATH_REGEXP: /(?<![\\$])\$\$(?!\$)((?:\\[\s\S]|[^\\$]|\$(?!\$))*?)\$\$(?!\$)/g,
        OBS_CODE_REGEXP: /(?<![\\`])(`+)(?!`)[^\r\n]*?(?<!`)\1(?!`)/g,
        OBS_DISPLAY_CODE_REGEXP: /^[ \t]*(`|~)(\1{2,})[^\r\n]*\r?\n[\s\S]*?(?:^[ \t]*\1\2\1*[ \t]*(?=\r?$)|(?![\s\S]))/gm,
    };
    for (const [name, regexp] of Object.entries(constants)) {
        const declaration = new RegExp("^([ \\t]*(?:export\\s+)?const\\s+" + name + "\\s*(?::\\s*RegExp\\s*)?=\\s*).+?$", "m");
        source = replaceOnce(source, declaration, (_match, header) => header + regexp, name);
    }
    return source;
}

function patchEmbeddedMedia(source) {
    if (!/\b(?:IMAGE_EXTS|AUDIO_EXTS|getAndFormatMedias)\b/.test(source)) return source;
    source = replaceOnce(source, /^([ \t]*const IMAGE_EXTS: string\[\] = \[[^\r\n]*?"\.tiff")(?=\])/m,
        '$1, ".webp"', "embedded image extensions");
    source = replaceOnce(source, /^([ \t]*)if \(AUDIO_EXTS\.includes\(extname\(embed\.link\)\)\) \{/m,
        "$1const extension = extname(embed.link).toLowerCase()\n$1if (AUDIO_EXTS.includes(extension)) {", "embedded audio classification");
    return replaceOnce(source, /IMAGE_EXTS\.includes\(extname\(embed\.link\)\)/,
        "IMAGE_EXTS.includes(extension)", "embedded image classification");
}

function patchFormatter(source) {
    source = patchEmbeddedMedia(source);
    source = replaceOnce(source, /^([ \t]*)format\(note_text:\s*string,\s*cloze:\s*boolean,\s*highlights_to_cloze:\s*boolean\):\s*string\s*\{/m,
        (_match, indent) => [
            indent + "format(note_text: string, cloze: boolean, highlights_to_cloze: boolean): string {",
            indent + "    return memoizeMarkdownField(this, note_text, cloze, highlights_to_cloze,",
            indent + "        () => this.formatUncached(note_text, cloze, highlights_to_cloze))",
            indent + "}",
            "",
            indent + "private formatUncached(note_text: string, cloze: boolean, highlights_to_cloze: boolean): string {",
        ].join("\n"), "Markdown formatter");
    source = replaceOnce(source, /^[ \t]*note_text = this\.obsidian_to_anki_math\(note_text\);?[ \t]*\r?\n/m,
        "", "Markdown math conversion");
    const highlight = /^[ \t]*const add_highlight_css(?:\s*:\s*boolean)?\s*=\s*(?:note_text\.match\(c\.OBS_DISPLAY_CODE_REGEXP\)\s*\?\s*true\s*:\s*false|c\.OBS_DISPLAY_CODE_REGEXP\.test\(note_text\));?[ \t]*\r?\n(?:[ \t]*c\.OBS_DISPLAY_CODE_REGEXP\.lastIndex\s*=\s*0;?[ \t]*\r?\n)?/m;
    source = replaceOnce(source, highlight, "", "fenced-code stylesheet check");
    for (const name of ["math_matches", "display_code_matches", "inline_code_matches"]) {
        const declaration = new RegExp("(let " + name + ":\\s*string\\[\\])(?=\\s*\\r?\\n)");
        source = replaceOnce(source, declaration, "$1 = []", name + " declaration");
    }
    const masks = /^([ \t]*)(\[note_text, math_matches\] = this\.censor\(note_text, ANKI_MATH_REGEXP, MATH_REPLACE\);?)[ \t]*\r?\n[ \t]*(\[note_text, display_code_matches\] = this\.censor\(note_text, c\.OBS_DISPLAY_CODE_REGEXP, DISPLAY_CODE_REPLACE\);?)[ \t]*\r?\n[ \t]*(\[note_text, inline_code_matches\] = this\.censor\(note_text, c\.OBS_CODE_REGEXP, INLINE_CODE_REPLACE\);?)/m;
    source = replaceOnce(source, masks, (_match, indent, math, fenced, inline) =>
        [
            "if (note_text.includes('```') || note_text.includes('~~~')) {",
            "    " + fenced,
            "}",
            "const add_highlight_css = display_code_matches.length > 0;",
            "if (note_text.includes('`')) {",
            "    " + inline,
            "}",
            "if (note_text.includes('$')) note_text = this.obsidian_to_anki_math(note_text);",
            String.raw`if (note_text.includes('\\(') || note_text.includes('\\[')) {`,
            "    " + math,
            "}",
        ]
            .map(line => indent + line).join("\n"), "Markdown code and math formatter masks");
    source = replaceOnce(source, /for\s*\(let match of note_text\.matchAll\(regexp\)\)\s*\{\s*matches\.push\(match\[0\]\)\s*\}\s*return \[note_text\.replace\(regexp, mask\), matches\]/,
        "const masked = note_text.replace(regexp, match => {\n            matches.push(match)\n            return mask\n        })\n        return [masked, matches]", "Markdown mask collection");
    source = replaceOnce(source, /mask,\s*escape\s*\?\s*escapeHtml\(replacement\)\s*:\s*replacement/,
        "mask, () => escape ? escapeHtml(replacement) : replacement", "Markdown mask restoration");
    source = source.replace(/^(\s*const HIGHLIGHT_REGEXP)[^\r\n]*/m, "$1 = markdownHighlightPattern()");
    return "import { markdownHighlightPattern, memoizeMarkdownField } from './markdown-pipeline'\n" + source;
}

module.exports = { patchIdWrites, patchLinkedCoverage, patchMarkdownConstants, patchFormatter, patchCardPreviewRanges };
