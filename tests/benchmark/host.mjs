// SPDX-License-Identifier: GPL-3.0-only
// Test boundaries for desktop Obsidian, upstream Markdown renderer and AnkiConnect.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
let host
export function useHost(value) { host = value }
export class MarkdownView {}
export class TFolder {}
export class Notice { constructor(message) { host.notices.push(message) } hide() {} }
export function parseYaml(text) {
    if (host.parseYaml) return host.parseYaml(text)
    throw new Error('Fixture does not use YAML')
}
export const Md5 = { hashStr: value => createHash('md5').update(value).digest('hex') }
export function isOptimizedImageCopyPath() { return false }
export function ensureScheduledBackup() { return undefined } // Backups disabled in the measured profile.
export function showAnkiProfileProblem(_plugin, error) { throw error }
export function openCardPreview(_app, result, _language, sync) { host.cardDialog = { result, sync } }
export function openBidirectionalPreview(_app, preview, apply) { host.dialog = { preview, apply } }
export async function invoke(action, params = {}) { return host.request(action, params) }
export const auditRead = invoke
export async function checkAnkiNoteExistence(ids, errors) {
    // Simulate the audit module boundary using the same addressed lookup as AnkiConnect.
    try {
        const found = new Set(await invoke('findNotes', { query: 'nid:' + ids.join(',') }))
        return new Map(ids.map(id => [id, found.has(id)]))
    } catch (error) {
        errors.push(String(error))
        return new Map()
    }
}
export async function createFullMigrationBackup() {
    if (!host.backup) throw new Error('Unexpected backup')
    return host.backup()
}
export const addTags = (notes, tags) => ({ action: 'addTags', params: { notes, tags } })
export const removeTags = (notes, tags) => ({ action: 'removeTags', params: { notes, tags } })
export const updateNoteFields = (id, fields) => ({ action: 'updateNoteFields', params: { note: { id, fields } } })
export function settingToData(_app, _settings, fields) {
    const noMatch = /(?!)/
    return { template: { deckName: 'Knowledge', tags: [] }, folder_tags: {}, fields_dict: fields, custom_regexps: host.expressions, NOTE_REGEXP: noMatch,
        INLINE_REGEXP: noMatch, EMPTY_REGEXP: noMatch, add_context: false, add_file_link: false, ...host.sourceSettings }
}
// Record the one-way export dispatch at the upstream file-manager boundary when requested.
export class DuplicatePreflight {}
export function readImageOptimization() { return { enabled: false } }
export function openExportPreview(_app, rows, apply) { host.exportPlan = { rows, apply } }
export class FileManager {
    constructor(app, data, files) { this.app = app; this.data = data; this.files = files }
    initialiseFiles() {
        if (!host.onOneWayPreview) throw Error('Unexpected one-way export in the two-way fixture')
        host.onOneWayPreview(this)
    }
    describeExportPlan() { return [] }
    parseMarkdown(file, content, ids, audit, models, bullets, preview, metadata, trackRanges, noteTypes, regexpOptions) {
        host.metrics.parses++
        return host.runtime.parsePortableMarkdown(this.app, this.data, file, content, ids,
            { audit, models, bullets, preview, metadata, trackRanges, noteTypes, syntax: this.diagnosticSyntax, regexpOptions })
    }
}
// Simulates upstream AllFile only for the plain linked bullets used by this fixture.
// Range detection, file-data preparation and linked field extraction are production functions.
export class AllFile {
    constructor(content, path) { this.original_file = content; this.path = path }
    async scanFile(options) {
        if (!host.plain && !host.mixed) assert.match(this.original_file, /^(?:## Cards\n- [^\n]+ :: [^\n]+\n<!--ID: \d+ -->\n)+$/)
        this.notes_to_edit = this.linkedBullets.map(bullet => {
            const note = { modelName: bullet.model.name, deckName: 'Knowledge',
                fields: host.runtime.linkedBulletSourceFields(bullet, bullet.model), tags: [] }
            host.decorateFields?.(note, bullet, this.path, this.original_file)
            this.previewCandidates?.push({ identifier: bullet.id, note, start: bullet.start, end: bullet.end,
                authoredFields: Object.keys(note.fields) })
            this.auditNoteRanges?.push([bullet.start, bullet.end])
            return { identifier: bullet.id, note }
        })
        if (host.explicit) {
            for (const match of this.original_file.matchAll(/^START\r?\nCloze\r?\nText: ([^\r\n]+)\r?\nBack Extra: ([^\r\n]+)\r?\n<!--ID: (\d+) -->\r?\nEND$/gm)) {
                const note = { modelName: 'Cloze', deckName: 'Knowledge', tags: [],
                    fields: { Text: match[1], 'Back Extra': match[2] } }
                const identifier = Number(match[3])
                const start = match.index, end = start + match[0].length
                this.notes_to_edit.push({ identifier, note })
                this.previewCandidates?.push({ identifier, note, start, end })
                this.auditNoteRanges?.push([start, end])
            }
        }
        if (host.expressions.Basic) {
            // Mirror stock search with/without a Tags row and ID, using the plugin's real isolated worker.
            // These fixtures contain only Basic, no YAML, no tags and no HTML field formatting.
            const { ankiIdRegexpSource, matchCustomRegexps, customRegexpKey } = host.runtime
            const patterns = []
            for (const id of [true, false]) for (const tags of [true, false]) {
                const tagPart = tags ? String.raw`\r?\nTags: ([^\r\n]+)` : ''
                const idPart = id ? String.raw`\r?\n` + ankiIdRegexpSource : ''
                patterns.push({ source: host.runtime.cardRegexpWithSuffix(host.expressions.Basic, tagPart, idPart), flags: 'gm', label: 'Basic' })
            }
            host.metrics.regexpFiles++
            const matches = await matchCustomRegexps(this.original_file, patterns, options)
            const withId = matches.get(customRegexpKey(patterns[1]))
            assert.equal(withId.length, this.original_file.split('<!--ID:').length - 1)
            if (host.plain || host.includeUnclaimedRegex) {
                if (!host.includeUnclaimedRegex) assert.equal(this.linkedBullets.length, 0)
                for (const match of withId) {
                    if (host.includeUnclaimedRegex && this.linkedBullets.some(card => card.start === match.index)) continue
                    const fields = host.capturedFields ?? ['Front', 'Back']
                    const identifier = Number(match.at(-1))
                    const note = { modelName: 'Basic', deckName: 'Knowledge', tags: [],
                        fields: Object.fromEntries(fields.map((name, i) =>
                            [name, (i < match.length - 2 ? match[i + 1] ?? '' : '').replace(/\r\n|\n/g, '<br>')])) }
                    host.decorateRegexNote?.(note)
                    const end = match.index + match[0].length
                    this.notes_to_edit.push({ identifier, note })
                    this.previewCandidates?.push({ identifier, note, start: match.index, end,
                        authoredFields: fields.filter((name, i) =>
                            i < match.length - 2 && match[i + 1] !== undefined) })
                    this.auditNoteRanges?.push([match.index, end])
                }
            }
        }
        this.global_tags = ''
        this.all_notes_to_add = []
        if (host.previewDraft) {
            const draft = host.previewDraft
            const start = this.original_file.indexOf(draft)
            if (start >= 0) {
                const note = { modelName: 'Basic', deckName: 'Knowledge', fields: { Front: 'This draft', Back: 'must stay local' }, tags: [] }
                this.previewCandidates?.push({ note, start, end: start + draft.length })
                this.all_notes_to_add.push(note)
            }
        }
    }
}
