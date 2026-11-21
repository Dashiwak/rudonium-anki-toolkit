// SPDX-License-Identifier: GPL-3.0-only
// Exercise the production page scan and ID writer at the upstream renderer boundary.
const { pageMethods, patchPageIdWriter } = require('../../Build/custom-regexp-patch.cjs');
module.exports = function pageFile() {
    return patchPageIdWriter(`
        import { insertPageFooterId, validatePageYamlPlacement, readPageCard, writePageId, isLinkedPageSchema, needsLinkedPageLayout, pageSourceContext, pageExportFieldNames, pageContentTags } from './page-card.mjs'
        const formatLocalIdDate = () => '2026-11-19'
        class RegexNote {
            constructor(match, model, fields, tags, hasId) { Object.assign(this, { match, model, fields, hasId }) }
            parse(deckName, url, frozen, data, context) {
                const names = this.fields[this.model];
                const values = this.match.slice(1);
                const identifier = this.hasId ? Number(values.pop()) : null;
                const fields = Object.fromEntries(names.map((name, i) => [name, values[i] ?? '']));
                const fileField = data.file_link_fields?.[this.model], contextField = data.context_fields?.[this.model];
                if (url && Object.hasOwn(fields, fileField)) fields[fileField] += '<br><a href="' + url + '" class="obsidian-link">Obsidian</a>';
                if (context && Object.hasOwn(fields, contextField)) fields[contextField] += context;
                return { identifier, note: { modelName: this.model, deckName, fields, tags: [], url, context } }
            }
        }
        export class AllFile {
            data = { fields_dict: { Basic: ['Front', 'Back'] }, comment: true, id_date: true, add_context: true }
            custom_regexps = { Basic: '@page' }
            linkedBullets = [{ start: 1, end: 4 }]
            target_deck = 'Knowledge'
            path = 'Card.md'
            url = 'obsidian://example'
            regex_notes_to_add = []; regex_id_indexes = []; all_notes_to_add = []; notes_to_edit = []; notes_to_delete = []
            previewCandidates = []; auditNoteRanges = []; note_ids = []
            global_tags = ''
            constructor(markdown, path, url, data) {
                this.original_file = this.file = markdown
                if (data) {
                    this.path = path
                    this.url = url
                    this.data = data
                    this.custom_regexps = data.custom_regexps
                    this.target_deck = data.template.deckName
                }
            }
            getContextAtIndex(i) { return String(i) }
            scanBlockFormats(options, pageOnly = false) {
                if (pageOnly && (this.file !== '' || this.linkedBullets.length)) throw Error('nested scan')
                this.regularScanned = true
            }
            ${pageMethods()}
            writeIDs() { this.regularWrote = true }
        }`);
};
