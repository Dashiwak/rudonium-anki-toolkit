// SPDX-License-Identifier: GPL-3.0-only
import { looksLikeAnkiIdMarker, pageFooterId } from './anki-id-marker'
import { insertPageFooterId, pageBlock, pageHeading, readPageCard } from './page-card'
import { pageControlStart, insertPageYamlId, pageYamlId, unclaimedPageYamlId } from './page-frontmatter'
import { readCardTagOverride } from './bidirectional-markdown'
import { readSuspendLine } from './suspend-label'
import type { DuplicateMarkerSyntax } from './duplicate-markers'
import type { PageIdLocation } from './page-id-location'
import type { MigrationCandidate, MigrationContext } from './page-migration-context'

const probeRules = { Rudonium: '@page' }
export interface ExistingPage { source: 'rudonium'; status: 'already'; id?: number }

// Use the control slot only when a following Rudonium directive proves that the page was previously linked.
export function pageRecoverySlot(text: string, bodyStart: number, syntax?: DuplicateMarkerSyntax): number {
    const row = /^([^\r\n]*)(\r?\n)(?=<!--[ \t]*(?:rudonium-page-(?:route|layout):|anki-bidirectional-tags:))/u.exec(text.slice(bodyStart))
    return row && readSuspendLine(row[1], syntax) ? bodyStart + row[0].length : bodyStart
}

/** An ephemeral valid ID lets the regular page reader validate orphaned metadata without changing the source. */
function readUnlinkedPage(text: string, insertion: number, eol: string, syntax?: DuplicateMarkerSyntax) {
    const first = text.slice(insertion).split(/\r?\n/u, 1)[0]
    if (looksLikeAnkiIdMarker(first)) throw new Error('Invalid ID / Некорректный ID')
    const prefix = '<!--ID: 1-->' + eol
    const probe = text.slice(0, insertion) + prefix + text.slice(insertion)
    const parsed = readPageCard(probe, probeRules, syntax)
    if (!parsed || parsed.id !== 1) throw new Error('Invalid page / Некорректная страница')
    const block = pageBlock(parsed)!
    const tags = readCardTagOverride(probe, block)
    const boundary = parsed.answerBoundary
    const noteText = text.slice(insertion, boundary === undefined ? undefined : boundary - prefix.length)
    const metadata = /^(?:[ \t]*<!-- anki-bidirectional-tags:[^\r\n]*-->[ \t]*(?:\r?\n|$))?(?:<!--rudonium-page-route:[^\r\n]*-->(?:\r?\n|$))?(?:<!--rudonium-page-layout:[^\r\n]*-->(?:\r?\n|$))?/u.exec(noteText)![0]
    if (['<!-- anki-bidirectional-tags:', '<!--rudonium-page-route:', '<!--rudonium-page-layout:'].some(key => noteText.slice(metadata.length).includes(key))) {
        throw new Error('Unrecognized page metadata / Некорректные служебные строки страницы')
    }
    return { parsed, metadata, tags }
}

export function detectRudoniumPage(text: string, context: MigrationContext): MigrationCandidate | ExistingPage | undefined {
    try {
        const head = pageHeading(text, true)
        if (!head) {
            pageFooterId(text) // A signed footer without its marked heading needs review before any foreign import.
            const orphan = unclaimedPageYamlId(text)
            if (orphan) return { source: 'rudonium', status: 'review', id: orphan.id, reason: context.t(
                'Check the saved page ID. Add #anki-page to the note and use the first H1 as its question.',
                'Проверьте сохранённый ID страницы. Добавьте в заметку #anki-page и запишите вопрос в её первом заголовке первого уровня.') }
            return
        }
        const from = pageControlStart(text, head.start + head.heading[0].length, head.tags)
        if (text.includes('<!-- Obsidian-to-Anki pending ')) throw new Error(context.t('Finish the pending export first.', 'Завершите незаконченный экспорт.'))
        if (pageYamlId(text) || pageFooterId(text) || text.slice(from).split(/\r?\n/u, 2).some(looksLikeAnkiIdMarker)) {
            const page = readPageCard(text, probeRules, context.syntax)
            if (page?.id !== undefined) return { source: 'rudonium', status: 'already', id: page.id }
        }
        if (context.source && context.source !== 'rudonium' && context.source !== 'auto') {
            return { source: 'rudonium', status: 'already' }
        }
        const insertion = pageRecoverySlot(text, from, context.syntax)
        const { parsed, metadata } = readUnlinkedPage(text, insertion, head.heading[3] || '\n', context.syntax)
        return { source: 'rudonium', status: 'candidate', recoverOnly: true, needsLink: !!metadata,
            model: parsed.linkedRoute?.model, deck: parsed.linkedRoute?.deck, fieldNames: parsed.fieldPair,
            linkedRoute: parsed.linkedRoute, front: parsed.front, back: parsed.back }
    } catch (error) {
        return { source: 'rudonium', status: 'review', reason: context.t('Check this page. ', 'Проверьте эту страницу. ') + String(error) }
    }
}

/** Keep the original YAML, exact heading, whitespace, body, anchors and any existing route or tag directive. */
export function renderRecoveredPage(original: string, item: MigrationCandidate, model: string, comment: boolean,
    newTagLine: string, newRouteLine: string, idLocation: PageIdLocation, syntax?: DuplicateMarkerSyntax): string {
    const head = pageHeading(original)
    if (!head) throw new Error('The original page heading changed.')
    const bodyStart = pageControlStart(original, head.start + head.heading[0].length, head.tags)
    const insertion = pageRecoverySlot(original, bodyStart, syntax)
    const eol = head.heading[3] || '\n'
    const { parsed, metadata, tags } = readUnlinkedPage(original, insertion, eol, syntax)
    const prefix = original.slice(0, insertion)
    const suffix = original.slice(insertion + metadata.length)
    // The engine can render unlinked fields against the normal Anki formatter in memory.
    if (item.id === undefined) return original.slice(0, bodyStart) + suffix
    if (parsed.linkedRoute && (item.linkedRoute?.model !== parsed.linkedRoute.model || item.linkedRoute?.deck !== parsed.linkedRoute.deck)) {
        throw new Error('The saved note type or deck conflicts with the proposed link.')
    }
    let next = metadata
    if (!parsed.linkedRoute && newRouteLine) {
        const layout = next.indexOf('<!--rudonium-page-layout:')
        if (layout >= 0) next = next.slice(0, layout) + newRouteLine + eol + next.slice(layout)
        else next += newRouteLine + eol
    }
    if (!tags && newTagLine) next = newTagLine + eol + next
    const marker = 'ID: ' + item.id
    let result = prefix + next + suffix
    if (idLocation === 'yaml') result = insertPageYamlId(result, item.id)
    else if (idLocation === 'after-answer') result = insertPageFooterId(result, item.id)
    else result = prefix + (comment ? '<!--' + marker + '-->' : marker) + eol + next + suffix
    const check = readPageCard(result, { [model]: '@page' }, syntax)
    if (!check || check.id !== item.id || check.idLocation !== idLocation || check.front !== item.front || check.back !== item.back ||
        check.namedFields?.size !== parsed.namedFields?.size ||
        (parsed.namedFields && [...parsed.namedFields].some(([name, field]) => check.namedFields?.get(name)?.value !== field.value)) ||
        check.model !== (item.linkedRoute?.model ?? model) || check.linkedRoute?.deck !== item.linkedRoute?.deck) {
        throw new Error('Could not verify the restored page link.')
    }
    return result
}
