// SPDX-License-Identifier: GPL-3.0-only
import { mayHavePageTag, hasPageYamlIdText, hasRetiredPageProperty } from './page-frontmatter'
import { activeCardMarkdown, archivedCardRanges } from './archived-card'
import { detectAnkiForge, detectAnkiBridge } from './migrate-forge-bridge'
import { detectAnkiAstSync, detectAnkiExporter } from './migrate-ast-exporter'
import { detectRudoniumPage, renderRecoveredPage } from './migrate-rudonium-page'
import type { ExistingPage } from './migrate-rudonium-page'
export type { ExistingPage } from './migrate-rudonium-page'
import { detectDeckToAnki } from './migrate-deck'
import { detectFlashcards } from './migrate-flashcards'
import { detectYanki } from './migrate-yanki'
import { splitMigrationMarkdown } from './migration-markdown'
import { deckPageLayoutMarker, insertPageFooterId, linkedPageRouteMarker, readPageCard, sourcePageLayoutMarker } from './page-card'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import type { PageIdLocation } from './page-id-location'
import type { MigrationAdapter, MigrationCandidate, MigrationContext } from './page-migration-context'
import { explicitNotePattern, pageCardExpression } from './card-format-presets'
import { validCardTags } from './bidirectional-markdown'
import { escapeRegex } from './constants'
import { insertPageYamlId } from './duplicate-markers'

const detectLocalSchedule: MigrationAdapter = (_path, text, context) => {
    if (!/<!--SR:![0-9]{4}-[0-9]{2}-[0-9]{2},/u.test(text)) return
    return { source: 'spaced-repetition', status: 'review', reason: context.t(
        'This file contains a local Spaced Repetition schedule. It has no verified Anki note link.',
        'В файле есть локальное расписание Spaced Repetition. Подтверждённой связи с записью Anki нет.') }
}
const adapters = { 'yanki': detectYanki, 'flashcards': detectFlashcards,
    'deck-to-anki': detectDeckToAnki, 'spaced-repetition': detectLocalSchedule, 'anki-forge': detectAnkiForge,
    'anki-bridge': detectAnkiBridge, 'anki-ast-sync': detectAnkiAstSync, 'anki-exporter': detectAnkiExporter }
const auto = Object.values(adapters)

function migrationSource(text: string): string {
    if (!text.includes('RUDONIUM-ARCHIVE')) return text
    const active = activeCardMarkdown(text)
    if (active === text) return text
    const parsed = splitMigrationMarkdown(active)
    return parsed && !parsed.body.trim() ? '' : active
}

export function inspectMigrationFile(path: string, text: string, context: MigrationContext,
    claimedIds?: readonly number[]): MigrationCandidate | ExistingPage | undefined {
    const active = migrationSource(text)
    if (active !== text) {
        if (!active) return
        const candidate = inspectMigrationFile(path, active, context, claimedIds)
        if (!candidate) return
        return { source: candidate.source, status: 'review', reason: context.t(
            'Whole-file migration would replace archived cards in this note. Move the active card to its own file first.',
            'При переносе целого файла будут перезаписаны архивные карточки. Сначала переместите действующую карточку в отдельную заметку.') }
    }
    if (mayHavePageTag(text) || hasPageYamlIdText(text) || text.includes('@page')) {
        const native = detectRudoniumPage(text, context)
        if (native) {
            if (native.status !== 'review' && (claimedIds ?? foreignMigrationIds(text)).some(id => id !== native.id)) {
                return { ...native, status: 'review', reason: context.t('This page already contains a foreign note ID.', 'На странице уже есть ID другого формата.') }
            }
            return native
        }
    }
    const syntax = context.syntax ?? {}
    const begin = syntax['Begin Note'] ?? 'START', end = syntax['End Note'] ?? 'END'
    const inline = syntax['Begin Inline Note'] ?? 'STARTI', inlineEnd = syntax['End Inline Note'] ?? 'ENDI'
    if ((begin && text.includes(begin) && explicitNotePattern(escapeRegex(begin), escapeRegex(end)).test(text)) ||
        (inline && inlineEnd && text.includes(inline) && new RegExp(escapeRegex(inline) + '.*?' + escapeRegex(inlineEnd)).test(text))) {
        return { source: 'obsidian-to-anki', status: 'already' }
    }
    if (context.source === 'rudonium' || context.source === 'obsidian-to-anki') return
    const selected = context.source && context.source !== 'auto' ? [adapters[context.source]] : auto
    let found: MigrationCandidate | undefined
    for (const adapter of selected) {
        const candidate = adapter(path, text, context)
        if (!candidate) continue
        // Both plugins accept a plain #card. Forge's terminal block key or anki-deck
        // property establishes its source only if Flashcards has no independent identity.
        if (found?.source === 'flashcards' && candidate.source === 'anki-forge' && candidate.status === 'candidate' &&
            !/(?:^|[ \t])\^(?:q-[a-z0-9-]+|\d{13})[ \t]*\r?$|^["']?(?:flashcards|cards-[a-z-]+|test)["']?[ \t]*:/mu.test(text)) {
            found = candidate
            continue
        }
        if (found) return { source: found.source, status: 'review', reason: context.t(
            'Several source formats are present. Check the file and choose its source explicitly.',
            'Найдены признаки нескольких форматов. Проверьте файл и укажите исходный плагин.') }
        found = candidate
    }
    if (found?.status === 'candidate') {
        if (hasRetiredPageProperty(text)) return { ...found, status: 'review', reason: context.t(
            'This source also contains rudonium-id. Check which Anki note owns the file before migration.',
            'В исходном файле есть rudonium-id. Перед переносом проверьте, с какой записью Anki связан файл.') }
        // Preserve pending source actions verbatim until their owner has resolved them.
        if (/^[ \t]*(?:SUSPEND|DELETE|FROZEN)[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*(?:ID:|<!--\s*(?:ID:|anki-note-id:|anki-id:)|\^(?:af-|q-|[1-9]\d{12}))/imu.test(text)) {
            return { ...found, status: 'review', reason: context.t('Review the source command next to the card ID before migration.',
                'Перед переносом проверьте служебную команду рядом с ID карточки.') }
        }
        if (context.source && context.source !== 'auto' && detectLocalSchedule(path, text, context)) {
            return { ...found, status: 'review', reason: context.t(
                'This file also contains a local review schedule. Check it before conversion.',
                'В файле также есть локальное расписание повторений. Проверьте его перед переносом.') }
        }
        if ((claimedIds ?? foreignMigrationIds(text)).some(id => id !== found.id)) {
            return { ...found, status: 'review', reason: context.t(
                'Another source ID is present in the same file. Verify which Anki note owns it.',
                'В этом же файле указан другой ID. Проверьте, с какой записью Anki он связан.') }
        }
    }
    return found
}

/** Collect possible ownership even when a file cannot be converted. Matching a number alone never establishes identity. */
export function foreignMigrationIds(text: string): number[] {
    text = migrationSource(text)
    const ids = new Set<number>()
    const yaml = splitMigrationMarkdown(text)?.yaml ?? ''
    const integer = (s: string) => {
        const id = Number(s)
        if (Number.isSafeInteger(id) && id > 0) ids.add(id)
    }
    for (const match of yaml.matchAll(/(?:^|[\s,{])["']?(?:noteId|deckID|nid)["']?\s*:\s*["']?([1-9]\d*)["']?(?=\s|[,}\]]|$)/gmu)) integer(match[1])
    for (const match of text.matchAll(/(?:^|[ \t])\^(\d{13})[ \t]*\r?$/gmu)) integer(match[1])
    for (const match of text.matchAll(/<!--[ \t]*anki-note-id:[ \t]*([1-9]\d*)[ \t]*-->/giu)) integer(match[1])
    return [...ids]
}

/** Also index external keys in unselected Markdown so a copied source cannot reclaim someone else's note. */
export function foreignMigrationKeys(text: string): string[] {
    text = migrationSource(text)
    const keys = new Set<string>()
    if (text.includes('^af-')) for (const match of text.matchAll(/(?:^|[ \t])\^(af-[a-zA-Z0-9-]+)(?=[ \t\r]*(?:\n|$))/gmu)) keys.add(match[1])
    if (text.includes('^q-')) for (const match of text.matchAll(/(?:^|[ \t])\^(q-[a-z0-9][a-z0-9-]{2,31})(?=[ \t\r]*(?:\n|$))/gmu)) keys.add(match[1])
    if (/anki-id:/iu.test(text)) for (const match of text.matchAll(/<!--\s*anki-id:\s*([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\s*-->/giu)) keys.add(match[1].toLowerCase())
    return [...keys]
}

function preservedTagLine(item: MigrationCandidate): string {
    if (!item.preservedTags?.length) return ''
    if (!validCardTags(item.preservedTags)) throw new Error('Invalid Anki tag.')
    const tags = JSON.stringify({ add: [...new Set(item.preservedTags)], remove: [] })
        .replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')
    return '<!-- anki-bidirectional-tags: ' + tags + ' -->'
}

export function renderMigrationPage(original: string, item: MigrationCandidate, model: string, comment = true,
    idLocation: PageIdLocation = 'yaml', syntax?: DuplicateMarkerSyntax): string {
    if (original.includes('RUDONIUM-ARCHIVE') && archivedCardRanges(original).length) {
        throw new Error('Whole-file migration cannot overwrite archived cards.')
    }
    const { front, back, anchor, id } = item
    if (item.status !== 'candidate' || !front || !back?.trim() || !model || front.trim() !== front ||
        /[\r\n]/u.test(front) || (anchor !== undefined && !/^[A-Za-z0-9-]+$/u.test(anchor)) ||
        (id !== undefined && (!Number.isSafeInteger(id) || id < 1))) throw new Error('The card cannot be represented as a page.')
    const tagLine = preservedTagLine(item)
    const routeLine = item.linkedRoute ? linkedPageRouteMarker(item.linkedRoute) : ''
    if (item.recoverOnly && item.source === 'rudonium') return renderRecoveredPage(original, item, model, comment, tagLine, routeLine, idLocation, syntax)
    const source = splitMigrationMarkdown(original)
    if (!source) throw new Error('Unclosed Markdown properties.')
    const { eol } = source
    const prefix = item.prefix ?? source.bom + source.yaml
    const header = splitMigrationMarkdown(prefix)
    if (!header || header.body.trim()) throw new Error('Unrecognized text before the page heading.')
    let text = (source.bom && !prefix.startsWith(source.bom) ? source.bom : '') + prefix
    if (text && text !== '\uFEFF' && !text.endsWith('\n')) text += eol
    text += '# ' + front + ' #anki-page' + (anchor ? ' ^' + anchor : '') + eol
    if (id !== undefined) {
        if (idLocation === 'heading') text += (comment ? '<!--ID: ' + id + '-->' : 'ID: ' + id) + eol
        if (tagLine) text += tagLine + eol
        if (routeLine) text += routeLine + eol
        if (item.source === 'deck-to-anki' && item.fieldNames?.[0] === 'ob-deck-front' && item.fieldNames[1] === 'ob-deck-back') {
            text += deckPageLayoutMarker + eol
        } else if (item.linkedRoute) {
            const marker = sourcePageLayoutMarker(item.source, item.fieldNames)
            if (marker) text += marker + eol
        }
    }
    const rawBody = back.replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/(?:\r?\n[ \t]*)+$/u, '')
    const body = rawBody.replace(/\r\n/gu, '\n')
    text += eol + rawBody + (original.endsWith('\n') ? eol : '')
    if (id !== undefined && idLocation === 'yaml') text = insertPageYamlId(text, id)
    if (id !== undefined && idLocation === 'after-answer') text = insertPageFooterId(text, id)
    const check = readPageCard(text, { [model]: pageCardExpression }, syntax)
    if (!check || check.front !== front || check.back !== body || check.id !== id || (id !== undefined && check.idLocation !== idLocation) ||
        check.model !== (item.linkedRoute?.model ?? model) ||
        check.linkedRoute?.deck !== item.linkedRoute?.deck) {
        throw new Error('The converted question, answer or note ID changed during Markdown parsing.')
    }
    return text
}
