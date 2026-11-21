// SPDX-License-Identifier: GPL-3.0-only
import { readDelimitedRule } from './delimited-rule'
import { presetStartGuard } from './card-export-diagnostics'
import { findMarkdownSyntaxSpans } from './markdown-pipeline'
import { OBS_DISPLAY_CODE_REGEXP, OBS_CODE_REGEXP, OBS_DISPLAY_MATH_REGEXP, OBS_INLINE_MATH_REGEXP } from './constants'

type Block = { from: number; to: number; model: string }
export type MultilineOwnership = (start: number, end: number, model?: string) => boolean

/** Reserve each explicit multiline block for exactly one model before any other parser can claim its answer. */
export function multilineOwnership(text: string, expressions: Record<string, string>,
    directives: ReadonlyArray<RegExp | undefined>): MultilineOwnership | undefined {
    if (!text.includes(':::anki')) return
    const rules = Object.entries(expressions).filter(([, rule]) => readDelimitedRule(rule)?.multiline)
        .map(([model, rule]) => ({ model, re: new RegExp(rule, 'm') }))
    if (!rules.length) return
    const { code, math } = findMarkdownSyntaxSpans(text, OBS_DISPLAY_CODE_REGEXP, OBS_CODE_REGEXP, OBS_DISPLAY_MATH_REGEXP, OBS_INLINE_MATH_REGEXP)
    const protectedAt = presetStartGuard(text, code.concat(math))
    const fail = (at: number, en: string, ru: string): never => {
        const line = 1 + (text.slice(0, at).match(/\n/g)?.length ?? 0)
        throw new Error(`Multiline card, line ${line}: ${en} / Многострочная карточка, строка ${line}: ${ru}`)
    }
    const blocks: Block[] = []
    let opened: number | undefined
    for (const marker of text.matchAll(/^:::(anki)?[ \t]*(?=\r?$)/gm)) {
        const pos = marker.index!
        if (protectedAt(pos)) {
            if (opened !== undefined) fail(pos, 'Move the boundary marker out of markup.', 'Переместите строку маркера за пределы разметки.')
            continue
        }
        if (marker[1]) {
            if (opened !== undefined) fail(opened, 'Close the block with ::: before the next card.', 'Завершите блок строкой ::: перед следующей карточкой.')
            opened = pos
        } else if (opened !== undefined) {
            const to = pos + marker[0].length
            const source = text.slice(opened, to)
            let owner: string | undefined
            for (const { model, re } of rules) {
                const match = re.exec(source)
                if (!match || match.index !== 0 || match[0].length !== source.length) continue
                if (owner !== undefined) fail(opened, 'Two note types match this header.', 'Этой строке полей соответствуют два типа записи.')
                owner = model
            }
            if (owner === undefined) fail(opened, 'Check the header fields, the answer and the ID placement after :::.',
                'Проверьте поля первой строки, непустой ответ и положение ID после :::.')
            blocks.push({ from: opened, to, model: owner! })
            opened = undefined
        }
    }
    if (opened !== undefined) fail(opened, 'Missing closing :::.', 'Отсутствует завершающая строка :::.')
    if (!blocks.length) return
    const overlaps: MultilineOwnership = (start, end, model) => {
        let lo = 0, hi = blocks.length
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (blocks[mid].to <= start) lo = mid + 1; else hi = mid }
        const b = blocks[lo]
        if (!b || b.from >= end) return false
        return !(b.from === start && b.model === model && end >= b.to && (lo + 1 === blocks.length || end <= blocks[lo + 1].from))
    }
    for (const pattern of directives) if (pattern) {
        for (const match of text.matchAll(new RegExp(pattern.source, pattern.global ? pattern.flags : pattern.flags + 'g'))) {
            const first = match[0].search(/\S/)
            if (first < 0) continue
            const pos = match.index! + first
            if (!protectedAt(pos) && overlaps(pos, match.index! + match[0].length)) {
                fail(pos, 'A card or file directive overlaps the block.', 'В блок попала служебная команда или другая карточка.')
            }
        }
    }
    return overlaps
}

/** The worker already found all candidate rows. Distinct Anki models claiming the same line require user input. */
export function checkWizardRowModels(text: string, rules: Record<string, string>,
    matches: (model: string, expression: string) => readonly RegExpMatchArray[],
    excluded: () => (from: number, to: number) => boolean): void {
    const generated = Object.entries(rules).filter(([, expr]) => {
        const format = readDelimitedRule(expr)
        return format && !format.multiline
    })
    if (generated.length < 2) return
    const blocked = excluded()
    const owners = new Map<number, string>()
    for (const [model, expression] of generated) {
        for (const match of matches(model, expression)) {
            const start = match.index
            if (start === undefined || blocked(start, start + match[0].length)) continue
            const other = owners.get(start)
            if (other !== undefined && other !== model) {
                const line = 1 + (text.slice(0, start).match(/\n/g)?.length ?? 0)
                throw new Error(`Two Anki models match line ${line}: ${other}, ${model}. Change one delimiter. / Строка ${line} соответствует двум типам Anki: ${other}, ${model}. Измените один из разделителей.`)
            }
            owners.set(start, model)
        }
    }
}
