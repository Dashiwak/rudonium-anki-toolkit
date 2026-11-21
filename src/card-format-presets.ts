/*! SPDX-License-Identifier: GPL-3.0-only */
export const pageCardExpression = '@page'

export interface CardFormatPreset {
    id: string
    expression: string
    en: string
    ru: string
    example: string
    front: string
    back: string
}

const front = 'Capital of Austria?'
const back = 'Vienna'
const oneLine = String.raw`([^\s](?:[^\r\n]*?[^\s])?)`
const end = String.raw`[ \t]*(?=\r?$)`
const remValue = String.raw`(?!::)[^\s](?:(?:(?!::)[^\r\n])*?(?!::)[^\s])?`
const remSide = '(' + remValue + ')'
const remPrefix = String.raw`^(?:[-*+][ \t]+)?` + remSide + String.raw`[ \t]*::(?!:)[ \t]*`
const remBody = remPrefix + remSide
export const legacyRemNoteExpression = remBody + end
function metadataExpression(localeSeparator: string, linked = false): string {
    const body = linked ? remPrefix + '(' + remValue + '|)' : remBody
    return body + String.raw`(?:[ \t]*::[ \t]*(?:R|[FB]=[a-z]{2,3}${localeSeparator}[A-Z]{2}\.?))*` + end
}
// Проектный формат хранит R и языки в трёх независимых необязательных захватах.
export const knowledgeBulletExpression = String.raw`^- (?=\S)((?:(?!::)[^\r\n])+?)[ \t]+::[ \t]+(?=\S)((?:(?!::)[^\r\n])+?)(?:[ \t]+::[ \t]+(R))?(?:[ \t]+::[ \t]+F=([a-z]{2,3}_[A-Z]{2}))?(?:[ \t]+::[ \t]+B=([a-z]{2,3}_[A-Z]{2}))?[ \t]*\r?$`

// Obsidian может сохранить подчёркивание в языковом коде как Markdown-escape.
const knowledgeMarkdownExpression = knowledgeBulletExpression.replace(/\}_\[/gu, String.raw`}\\?_[`)
// Only the pass that requires a verified ID accepts an empty second slot.
const knowledgeBack = String.raw`::[ \t]+(?=\S)((?:(?!::)[^\r\n])+?)`
const linkedKnowledge = knowledgeMarkdownExpression.replace(knowledgeBack,
    () => String.raw`::(?=[ \t]|\r?$)[ \t]*((?=\S)(?:(?!::)[^\r\n])+?|)`)
const knowledgeBullet = new RegExp(linkedKnowledge)
export function isKnowledgeBullet(text: string, start: number): boolean {
    if (!text.startsWith('- ', start)) return false
    const lf = text.indexOf('\n', start)
    const end = lf < 0 ? text.length : lf
    return end - start <= 16384 && knowledgeBullet.test(text.slice(start, end))
}

const previousRemNoteExpression = metadataExpression('_')
export const remNoteExpression = metadataExpression(String.raw`\\?_`)
const linkedRemNote = metadataExpression(String.raw`\\?_`, true)
const remNoteBullet = new RegExp(linkedRemNote)

export function isRemNoteBullet(text: string, start: number): boolean {
    const lf = text.indexOf('\n', start), end = lf < 0 ? text.length : lf
    return end - start <= 16384 && remNoteBullet.test(text.slice(start, end))
}

export function linkedCardPattern(expression: string): string {
    if (expression === knowledgeBulletExpression) return linkedKnowledge
    const current = currentCardExpression(expression)
    return current === remNoteExpression ? linkedRemNote : current
}

/** Only these positional formats identify an empty answer unambiguously beside a confirmed ID. */
export function hasLinkedAnswerSlot(format?: string): boolean {
    return format === 'knowledge' || format === 'remnote'
}

export function currentCardExpression(expression: string): string {
    return expression === legacyRemNoteExpression || expression === previousRemNoteExpression ? remNoteExpression : expression
}

/** Маркеры языка остаются в Markdown, даже если модель содержит только два поля. */
export function applyRemNoteMetadata(expression: string, matched: string, fields: Record<string, string>, names: readonly string[]): string[] {
    if (currentCardExpression(expression) !== remNoteExpression) return []
    const lineEnd = matched.search(/[\r\n]/)
    const parts = (lineEnd < 0 ? matched : matched.slice(0, lineEnd)).split('::')
    const authored: string[] = []
    const seen = new Set<string>()
    for (const raw of parts.slice(2)) {
        const token = raw.trim()
        const field = token === 'R' ? 'Add Reverse' : token.startsWith('B=') ? 'BackLang' : 'FrontLang'
        if (seen.has(field)) throw new Error('Repeated RemNote marker / Повторная метка RemNote: ' + field)
        seen.add(field)
        if (names.includes(field)) {
            fields[field] = token === 'R' ? 'R' : token.slice(2).replace('\\_', '_').replace(/\.$/, '')
            authored.push(field)
        } else if (field === 'Add Reverse') throw new Error('RemNote R requires an Add Reverse field / Для R требуется поле Add Reverse.')
    }
    return authored
}
const answer = String.raw`(?!(?:<!--[ \t]*)?ID[ \t]*:)` + oneLine
const cell = String.raw`[ \t]*([^|\s](?:[^|\r\n]*?[^|\s])?)[ \t]*`
const tableHead = String.raw`^\|[^|\r\n]+\|[^|\r\n]+\|[ \t]*\r?\n\|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*\r?\n`

export const cardFormatPresets: readonly CardFormatPreset[] = [
    { id: 'explicit', en: 'START / END', ru: 'START / END', expression: '',
        example: 'START\nBasic\nFront: ' + front + '\nBack: ' + back + '\nEND', front, back },
    { id: 'remnote', en: 'RemNote · single line', ru: 'RemNote · одна строка',
        expression: remNoteExpression,
        example: front + ' :: ' + back, front, back },
    { id: 'neuracache', en: 'Neuracache · #flashcard', ru: 'Neuracache · #flashcard',
        expression: '^' + oneLine + String.raw`[ \t]+#flashcard[ \t]*\r?\n` + answer + end,
        example: front + ' #flashcard\n' + back, front, back },
    { id: 'qa', en: 'Question and answer · Q: / A:', ru: 'Вопрос и ответ · Q: / A:',
        expression: String.raw`^Q:[ \t]+` + oneLine + String.raw`\r?\nA:[ \t]+` + answer + end,
        example: 'Q: ' + front + '\nA: ' + back, front, back },
    { id: 'spaced', en: 'Spaced Repetition · ? separator', ru: 'Spaced Repetition · разделитель ?',
        expression: '^' + oneLine + String.raw`\r?\n\?[ \t]*\r?\n` + answer + end,
        example: front + '\n?\n' + back, front, back },
    { id: 'table', en: 'Two-column table · one card', ru: 'Два столбца таблицы · одна карточка',
        expression: tableHead + String.raw`\|` + cell + String.raw`\|` + cell + String.raw`\|` + end + String.raw`(?![ \t]*\r?\n[ \t]*\|)`,
        example: '| Front | Back |\n| --- | --- |\n| ' + front + ' | ' + back + ' |', front, back },
    { id: 'page', en: 'Whole page · #anki-page', ru: 'Целая страница · #anki-page', expression: pageCardExpression,
        example: '# ' + front + ' #anki-page\n\n' + back, front, back },
]

export const namedCardExpressions: ReadonlySet<string> = new Set(cardFormatPresets
    .filter(preset => preset.expression && preset.id !== 'page').map(preset => preset.expression))

export const tableCardExpression = cardFormatPresets.find(preset => preset.id === 'table')!.expression

/** Одна пустая строка после таблицы отделяет маркер Anki от ячеек Markdown. */
export function cardRegexpWithSuffix(expression: string, tags: string, id: string): string {
    const gap = expression === tableCardExpression && (tags || id) ? String.raw`(?:\r?\n[ \t]*(?=\r?$))?` : ''
    const pattern = id ? linkedCardPattern(expression) : expression === knowledgeBulletExpression ? knowledgeMarkdownExpression : currentCardExpression(expression)
    return pattern + gap + tags + id
}

const tableBody = new RegExp(tableCardExpression)
export function tableIdSpacing(text: string, position: number, marker: string): string {
    let end = position
    if (end > 0 && text[end - 1] === '\n') end--
    if (end > 0 && text[end - 1] === '\r') end--
    let last = end
    while (last && (text[last - 1] === ' ' || text[last - 1] === '\t')) last--
    if (!last || text[last - 1] !== '|' || !/^(?:[ \t]*\r?\n)*[ \t]*(?:<!--[ \t]*)?ID:/u.test(marker)) return marker
    const data = text.lastIndexOf('\n', last - 1)
    const separator = data > 0 ? text.lastIndexOf('\n', data - 1) : -1
    if (separator < 0) return marker
    const start = separator > 0 ? text.lastIndexOf('\n', separator - 1) + 1 : 0
    if (!tableBody.test(text.slice(start, end))) return marker
    const eol = text[data - 1] === '\r' ? '\r\n' : '\n'
    return eol.repeat(position > end ? 1 : 2) + marker.replace(/^(?:[ \t]*\r?\n)*/u, '')
}
