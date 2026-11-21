// SPDX-License-Identifier: GPL-3.0-only
import { parseYaml } from 'obsidian'
import { splitMigrationMarkdown, withoutMigrationKeys } from './migration-markdown'
import type { MigrationAdapter, MigrationCandidate, MigrationContext } from './page-migration-context'

type Origin = 'anki-forge' | 'anki-bridge'
type Sides = { front: string; back: string }
const yamlDeckKey = /^(?:anki-deck|"anki-deck"|'anki-deck')[ \t]*:/mu
const forgeKey = /^\^(af-[a-z0-9]+(?:-[a-z0-9]+)*)[ \t]*$/u
const basic = '⇢%%oab:basic:v1%%'
const dump = '⇢{%%oab:dump:v1%%'
const endDump = '}⇠%%oab:end:v1%%'

function review(source: Origin, context: MigrationContext, en: string, ru: string): MigrationCandidate {
    return { source, status: 'review', reason: context.t(en, ru) }
}

function contentRows(body: string): string[] {
    const lines = body.split(/\r?\n/u)
    let first = 0, last = lines.length
    while (first < last && !lines[first].trim()) first++
    while (last > first && !lines[last - 1].trim()) last--
    return lines.slice(first, last)
}

// Whole-page H1 has only one plain question. An inner ID, example, or list item must not
// turn into the outer question or cause other text to be discarded.
function question(row: string): string | undefined {
    const text = row.trimEnd()
    if (!text || text !== text.trimStart() || /^(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|\||~~~|---|<!--|%%)/u.test(text) ||
        /\^[-\w]+$|#anki-page|[\x00-\x1f`]/u.test(text)) return
    return text
}

function forgeSides(rows: readonly string[], anchored: boolean, eol: string): Sides | undefined {
    if (!rows.length || rows.some(line => /\^af-|\^q-|%%oab:|:::|==|\{[^}]+\}|(?:^|\s)#[\p{L}\p{N}_/-]+/u.test(line.replace(/[ \t]+#card[ \t]*$/u, '')) ||
        /(?:^|\s)\^[\w-]+[ \t]*$|^(?:ID:|<!--\s*ID:|START|END)\b/iu.test(line))) return
    const tagged = /^(.+?)[ \t]+#card[ \t]*$/u.exec(rows[0])
    if (tagged) {
        const front = question(tagged[1])
        const answer = rows.slice(1)
        if (!front || front.includes('::') || !answer.length || answer.some(line => /::|(?:^|\s)#card(?:\s|$)/u.test(line)) ||
            (!anchored && answer.some(line => !line.trim()))) return
        const back = answer.join(eol)
        if (back.trim()) return { front, back }
        return
    }
    if (rows.length !== 1 || /[`$\\]|\[\[|\]\(/u.test(rows[0])) return
    const parts = rows[0].split('::')
    if (parts.length !== 2 || parts[0].includes('#card')) return
    const front = question(parts[0]), back = parts[1].trim()
    if (front && back) return { front, back }
}

/** Forge keeps its af-... block anchor and Anki note ID in separate namespaces. */
export const detectAnkiForge: MigrationAdapter = (_path, text, context) => {
    const source = 'anki-forge'
    const selected = context.source === source
    if (!selected && context.source && context.source !== 'auto') return
    const hasAnchor = text.includes('^af-')
    const mayHaveDeck = text.includes('anki-deck')
    if (!hasAnchor && !mayHaveDeck && !(selected && /::|#card\b|==[^=]+==/u.test(text))) return
    const parts = splitMigrationMarkdown(text)
    if (!parts) return selected || hasAnchor ? review(source, context, 'Check the unclosed YAML properties.', 'Проверьте незакрытые свойства YAML.') : undefined
    const rows = contentRows(parts.body)
    const deckKey = yamlDeckKey.test(parts.yaml)
    const hasKeyLine = rows.some(line => /^\^af-/u.test(line))
    if (!selected && !hasKeyLine && !(context.forgeRegistryPresent && deckKey)) return
    if (rows.length && /^(?: {4}|\t| {0,3}(?:`{3}|~{3}|<!--|%%|>))/u.test(rows[0])) return
    const marker = forgeKey.exec(rows[rows.length - 1] ?? '')
    if (marker) rows.pop()
    const sides = forgeSides(rows, !!marker, parts.eol)
    if (!sides) return review(source, context,
        'Check the Forge card boundaries or template. A page needs one basic question and its complete answer.',
        'Проверьте границы и шаблон Forge. Для страницы нужны один простой вопрос и его полный ответ.')
    let prefix = parts.bom + parts.yaml
    let deck: string | undefined
    if (deckKey) {
        const yaml = parts.yaml.replace(/^---[^\n]*\n/u, '').replace(/^---[ \t]*(?:\r?\n)?$/mu, '')
        const retained = withoutMigrationKeys(parts.yaml, new Set(['anki-deck']))
        let parsed: unknown
        try { parsed = parseYaml(yaml) } catch { /* handled as a review row */ }
        const value = parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'anki-deck')
            ? (parsed as Record<string, unknown>)['anki-deck'] : undefined
        if (retained === undefined || typeof value !== 'string' || !value.trim() || value !== value.trim() ||
            /[\x00-\x1f\x7f]/u.test(value) || !/^["']?anki-deck["']?[ \t]*:[ \t]*(?![&*|>!])[\S][^\r\n]*$/mu.test(yaml) ||
            /(?:^|\n)[ \t]*<<[ \t]*:/u.test(yaml)) {
            return review(source, context, 'Check the original anki-deck property.', 'Проверьте исходное свойство anki-deck.')
        }
        prefix = parts.bom + retained
        deck = value
    }
    const anchor = marker?.[1]
    return { source, status: 'candidate', ...sides, deck, prefix, anchor, externalKey: anchor,
        needsLink: !!anchor || !!context.forgeRegistryPresent }
}

function bridgeSides(rows: readonly string[], eol: string): Sides | undefined {
    const first = rows[0] ?? ''
    const pieces = first.split(basic)
    if (pieces.length === 2 && rows.length === 1 && !pieces.some(side => side.includes('%%oab:'))) {
        const front = question(pieces[0]), back = pieces[1].trim()
        if (front && back) return { front, back }
    }
    const heading = first.trimEnd()
    if (!heading.endsWith(dump) || rows.length < 3 || rows[rows.length - 1].trimEnd() !== endDump) return
    const front = question(heading.slice(0, -dump.length))
    const answer = rows.slice(1, -1)
    if (!front || front.includes('%%oab:') || answer.some(line => line.includes('%%oab:'))) return
    const back = answer.join(eol)
    if (back.trim()) return { front, back }
}

/** Anki Bridge by Aaron Ade. Its versioned comments are syntax, never numeric Anki IDs. */
export const detectAnkiBridge: MigrationAdapter = (path, text, context) => {
    const source = 'anki-bridge'
    if (context.source && context.source !== 'auto' && context.source !== source || !text.includes('%%oab:')) return
    const parts = splitMigrationMarkdown(text)
    if (!parts) return review(source, context, 'Check the unclosed YAML properties.', 'Проверьте незакрытые свойства YAML.')
    if (!parts.body.includes('%%oab:')) return
    const rows = contentRows(parts.body)
    if (!rows.length || /^(?: {4}|\t| {0,3}(?:`{3}|~{3}|<!--|%%|>))/u.test(rows[0])) return
    const sides = bridgeSides(rows, parts.eol)
    if (!sides || /(?:^|\s)#[\p{L}\p{N}_/-]+|(?:^|\s)\^[\w-]+[ \t]*$|<!--\s*ID:|^ID:[ \t]*/mu.test(sides.front + '\n' + sides.back)) {
        return review(source, context, 'Check this Bridge file. Only a whole-file Basic or Dump card with a single question and answer can become a page.',
            'Проверьте формат Bridge. В страницу можно перенести целый файл с одной карточкой Basic или Dump.')
    }
    const deck = context.bridgeRegistryPresent && context.vaultName
        ? ['Obsidian Flashcards', context.vaultName, ...path.replace(/\.md$/iu, '').split('/')].join('::') : undefined
    return { source, status: 'candidate', ...sides, prefix: parts.bom + parts.yaml, deck, needsLink: !!context.bridgeRegistryPresent }
}
