// SPDX-License-Identifier: GPL-3.0-only
import type { BidirectionalBlock } from './bidirectional-blocks'
import type { PageCard } from './page-card'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import { readRecoveryMarker } from './export-recovery'
import { isLinkedPageSchema, needsLinkedPageLayout, readPageCard } from './page-card'
import { pageExportFieldNames, pageFieldIsAvailable, pageFieldsMarker } from './page-named-fields'

type Models = Readonly<Record<string, readonly string[]>>
type ModelSettings = Readonly<Record<string, string>>
export interface PageFieldEditorSettings {
    CUSTOM_REGEXPS?: ModelSettings
    PAGE_MODEL?: string
    Syntax?: DuplicateMarkerSyntax
    FILE_LINK_FIELDS?: ModelSettings
    CONTEXT_FIELDS?: ModelSettings
}

function inspectPage(text: string, settings: PageFieldEditorSettings, models: Models) {
    const page = readPageCard(text, settings.CUSTOM_REGEXPS ?? {}, settings.Syntax, settings.PAGE_MODEL)
    if (!page) return
    if (readRecoveryMarker(text)) throw new Error('Finish the pending export before adding a field. / Завершите незаконченный экспорт перед добавлением поля.')
    const names = Object.prototype.hasOwnProperty.call(models, page.model) ? models[page.model] : undefined
    if (!names || names.length < 2 || new Set(names).size !== names.length)
        throw new Error('Refresh the fields for this Anki note type. / Обновите список полей этого типа записи Anki.')
    const layout = page.fieldPair
    if (layout ? page.id === undefined || !isLinkedPageSchema(page.model, names, layout) :
        page.model === 'ob-deck-basic' || names[0] === 'ob-deck-id' || page.linkedRoute && needsLinkedPageLayout(names)) {
        throw new Error('Verify the linked page layout and note fields. / Проверьте формат и поля связанной страницы.')
    }
    const mapped = { file: settings.FILE_LINK_FIELDS?.[page.model], context: settings.CONTEXT_FIELDS?.[page.model],
        addFile: false, addContext: false }
    pageExportFieldNames(page, names, mapped)
    const fields = names.filter(name => !page.sharedFields?.values.has(name) && !page.namedFields?.has(name) && pageFieldIsAvailable(name, page, names, mapped))
    return { page, fields }
}

/** Only called from the editor command; it uses the model dictionary already cached in the plugin. */
export function pageFieldChoices(text: string, settings: PageFieldEditorSettings, models: Models):
    { model: string; fields: string[] } | undefined {
    const current = inspectPage(text, settings, models)
    return current && { model: current.page.model, fields: current.fields }
}

/** Return one undoable edit. Existing Markdown, line endings and the private appendix stay byte-exact. */
export function insertPageField(text: string, settings: PageFieldEditorSettings, models: Models, name: string, value: string):
    { offset: number; insert: string } {
    const current = inspectPage(text, settings, models)
    if (!current || !current.fields.includes(name))
        throw new Error('The selected page field is unavailable. / Выбранное поле недоступно для этой страницы.')
    return appendPageFields(text, settings, current.page, [[name, value]])
}

/** A return edit must round-trip before it can appear in the sync preview. */
export function planPageFieldInsertion(text: string, block: BidirectionalBlock, fields: Readonly<Record<string, string>>):
    { start: number; end: number; text: string } {
    const entries = Object.entries(fields)
    const settings = { PAGE_MODEL: block.model, Syntax: block.pageFieldSyntax }
    const page = readPageCard(text, {}, settings.Syntax, block.model)
    if (!page || page.id !== block.id || page.model !== block.model || readRecoveryMarker(text) || !entries.length ||
        entries.some(([name]) => page.sharedFields?.values.has(name) || page.namedFields?.has(name) || !block.pageOptionalFieldNames?.includes(name))) {
        throw new Error('The page or its fields changed. Preview synchronization again. / Страница или её поля изменились. Повторите предпросмотр.')
    }
    const edit = appendPageFields(text, settings, page, entries)
    return { start: edit.offset, end: edit.offset, text: edit.insert }
}

function appendPageFields(text: string, settings: PageFieldEditorSettings, page: PageCard,
    fields: readonly (readonly [string, string])[]): { offset: number; insert: string } {
    const normalized = fields.map(([name, raw]) => {
        const value = raw.replace(/\r\n?/gu, '\n')
        if (!value.trim()) throw new Error('Enter a field value. / Введите значение поля.')
        return { name, value }
    })
    const limit = page.idLocation === 'after-answer' ? page.idStart : page.answerBoundary
    const offset = text.slice(0, limit).replace(/(?:\r?\n[ \t]*)+$/u, '').length
    const rows = normalized.map(({ name, value }) => {
        // A fenced value needs a real Markdown line start, including when it begins on the first line.
        const separator = /^ {0,3}(?:`{3}|~{3})/u.test(value) ? ':' + page.eol : ': '
        return name + separator + value.replace(/\n/gu, page.eol)
    })
    const insert = page.eol + (page.namedFields ? '' : page.eol + pageFieldsMarker + page.eol) + rows.join(page.eol)
    const next = text.slice(0, offset) + insert + text.slice(offset)
    const verified = readPageCard(next, settings.CUSTOM_REGEXPS ?? {}, settings.Syntax, settings.PAGE_MODEL)
    if (!verified || verified.id !== page.id || verified.idLocation !== page.idLocation || verified.model !== page.model ||
        verified.front !== page.front || verified.back !== page.back || verified.linkedRoute?.deck !== page.linkedRoute?.deck ||
        verified.namedFields?.size !== (page.namedFields?.size ?? 0) + normalized.length ||
        normalized.some(({ name, value }) => verified.namedFields?.get(name)?.value !== value.trim()) ||
        (page.namedFields && [...page.namedFields].some(([key, prior]) => verified.namedFields?.get(key)?.value !== prior.value)) ||
        (verified.markerOffsets?.length ?? 0) !== (page.markerOffsets?.length ?? 0) ||
        (verified.answerBoundary === undefined) !== (page.answerBoundary === undefined) ||
        (page.answerBoundary !== undefined && next.slice(verified.answerBoundary) !== text.slice(page.answerBoundary)) ||
        readRecoveryMarker(next)) {
        throw new Error('The value changes the page structure. Indent literal field labels or use a fenced code block. / Значение меняет структуру страницы. Добавьте отступ перед буквальными названиями полей или оформите их как блок кода.')
    }
    return { offset, insert }
}
