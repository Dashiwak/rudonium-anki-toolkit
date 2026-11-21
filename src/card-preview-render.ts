/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { auditRead } from './sync-audit'
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'

export interface CardPreviewField {
    name: string
    html: string
}

export interface CardPreviewVariant {
    name: string
    front: string
    back: string
    css?: string
}

export interface CardTemplateReadContext {
    deck?: string
    tags?: readonly string[]
}

type TemplateAction = {
    action: 'modelTemplates' | 'modelStyling'
    version: 6
    params: { modelName: string }
}

export type CardTemplateRead = (actions: readonly TemplateAction[]) => Promise<unknown>

const renderLimit = 1024 * 1024
const variantLimit = 32
const clozeCss = '.cloze { font-weight: bold; color: #3b82f6; }'

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function visibleValue(html: string): boolean {
    return /<(?:img|svg|audio|video|object)\b|\[sound:/i.test(html) || Boolean(html
        .replace(/<!--[\s\S]*?-->|<[^>]*>/g, '')
        .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' ')
        .trim())
}

function escapeText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function clozeNumbers(fields: Iterable<string>): number[] {
    const numbers = new Set<number>()
    for (const value of fields) {
        for (const match of value.matchAll(/\{\{c([1-9]\d*)::/g)) {
            const number = Number(match[1])
            if (Number.isSafeInteger(number)) numbers.add(number)
        }
    }
    return [...numbers].sort((left, right) => left - right)
}

/** Подставляет пропуски Cloze в HTML без выполнения скриптов шаблона и без изменения записи. */
function displayCloze(html: string, selected: number, question: boolean): string {
    const chunks: string[] = []
    const frames: { number: number; answer: string[]; hint?: string[] }[] = []
    let start = 0
    const append = (value: string) => {
        const frame = frames[frames.length - 1]
        const target = frame?.hint ?? frame?.answer ?? chunks
        target.push(value)
    }
    for (const match of html.matchAll(/\{\{c([1-9]\d*)::|::|\}\}/g)) {
        append(html.slice(start, match.index))
        start = match.index + match[0].length
        const frame = frames[frames.length - 1]
        if (match[1]) {
            frames.push({ number: Number(match[1]), answer: [] })
        } else if (match[0] === '::' && frame && !frame.hint) {
            frame.hint = []
        } else if (match[0] === '}}' && frame) {
            frames.pop()
            const answer = frame.answer.join('')
            if (frame.number !== selected) append(answer)
            else append('<span class="cloze">' + (question ? '[' + (frame.hint?.join('') || '…') + ']' : answer) + '</span>')
        } else {
            append(match[0])
        }
    }
    if (frames.length) return html
    append(html.slice(start))
    return chunks.join('')
}

function frontBack(fields: readonly CardPreviewField[]): { front: string; back: string } {
    const content = fields.filter(field => !/^(?:add reverse|frontlang|backlang)$/i.test(field.name.trim()))
    const explicitBack = content.find(field => field.name.trim().toLowerCase() === 'back')
    const front = content.find(field => field.name.trim().toLowerCase() === 'front') ??
        content.find(field => field !== explicitBack)
    return {
        front: front?.html ?? '',
        back: explicitBack?.html ?? content.find(field => field !== front)?.html ?? '',
    }
}

export function buildBasicCardVariants(fields: readonly CardPreviewField[], modelName?: string,
    t: UiText = englishUi): readonly CardPreviewVariant[] {
    const { front, back } = frontBack(fields)
    const numbers = clozeNumbers([front])
    if (numbers.length) {
        return numbers.slice(0, variantLimit).map(number => ({
            name: t(`Cloze ${number}`, `Пропуск ${number}`),
            front: displayCloze(front, number, true),
            back: displayCloze(front, number, false) + (visibleValue(back) ? '<hr>' + back : ''),
            css: clozeCss,
        }))
    }
    const cards: CardPreviewVariant[] = [{ name: t('Forward', 'Прямая'), front, back }]
    const reverse = fields.find(field => field.name.trim().toLowerCase() === 'add reverse')
    if (reverse ? visibleValue(reverse.html) : /^(?:basic\s*\(and reversed card\)|basic and reversed)$/i.test(modelName ?? '')) {
        cards.push({ name: t('Reverse', 'Обратная'), front: back, back: front })
    }
    return cards
}

/** Разбирает подстановки в двойных фигурных скобках по правилам Anki, включая вложенные необязательные разделы. */
function renderTemplate(source: string, field: (expression: string) => string): string | undefined {
    if (source.length > renderLimit) return undefined
    const sections: { name: string; hidden: boolean }[] = []
    const chunks: string[] = []
    let hidden = 0
    let length = 0
    let start = 0
    const append = (value: string) => {
        if (!value || hidden || length > renderLimit) return
        length += value.length
        chunks.push(value)
    }
    for (const match of source.matchAll(/\{\{\{([^{}]+)\}\}\}|\{\{([^{}]+)\}\}/g)) {
        append(source.slice(start, match.index))
        start = match.index + match[0].length
        const expression = (match[1] ?? match[2]).trim()
        const operator = expression[0]
        const name = expression.slice(1).trim()
        if (operator === '#' || operator === '^') {
            const visible = !hidden && visibleValue(field(name))
            const blocked = Boolean(hidden) || (operator === '#' ? !visible : visible)
            sections.push({ name, hidden: blocked })
            if (blocked) hidden++
        } else if (operator === '/') {
            const section = sections.pop()
            if (!section || section.name !== name) return undefined
            if (section.hidden) hidden--
        } else if (operator === '=') {
            // Старые шаблоны Anki могут использовать другие разделители. Показываем основной предпросмотр полей.
            return undefined
        } else if (operator !== '!' && !hidden) {
            append(field(expression))
        }
    }
    if (sections.length) return undefined
    append(source.slice(start))
    return length <= renderLimit ? chunks.join('') : undefined
}

function resolvedField(expression: string, fields: ReadonlyMap<string, string>, front: string | undefined,
    cloze: number | undefined, cautions: Set<string>, t: UiText): string {
    if (expression === 'FrontSide' && front !== undefined) return front
    const direct = fields.get(expression)
    if (direct !== undefined) return direct
    const segments = expression.split(':').map(segment => segment.trim())
    const name = segments.pop()!
    let html = fields.get(name) ?? ''
    for (const filter of segments.reverse()) {
        if (filter === 'text') html = html.replace(/<br\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '')
        else if (filter === 'cloze' && cloze !== undefined) html = displayCloze(html, cloze, front === undefined)
        else if (filter === 'hint' && visibleValue(html)) {
            html = '<details><summary>' + escapeText(t('Show hint', 'Показать подсказку')) + '</summary>' + html + '</details>'
        }
        else if (/^(?:tts(?:\s|$)|tts-voices$|type$)/i.test(filter)) {
            cautions.add(t('Typing and audio controls are only available in Anki.',
                'Ввод ответа и воспроизведение звука доступны в Anki.'))
            return ''
        } else if (filter !== 'hint' && filter !== 'cloze') {
            cautions.add(t('Some Anki template filters are shown as plain field values.',
                'Для некоторых фильтров шаблона показаны исходные значения полей.'))
        }
    }
    return html
}

function clozeFields(source: string, fields: ReadonlyMap<string, string>): string[] {
    const values: string[] = []
    for (const match of source.matchAll(/\{\{([^{}]+)\}\}/g)) {
        const parts = match[1].split(':').map(part => part.trim())
        const last = parts.pop()!
        if (parts.includes('cloze') && fields.has(last)) values.push(fields.get(last)!)
    }
    return values
}

const defaultRead: CardTemplateRead = actions => auditRead('multi', { actions }, undefined, 3500)

export async function readCardTemplateVariants(modelName: string, fields: readonly CardPreviewField[],
    verifyProfile: () => Promise<unknown>, read: CardTemplateRead = defaultRead,
    context: CardTemplateReadContext = {}, t: UiText = englishUi): Promise<{ variants: readonly CardPreviewVariant[]; cautions: readonly string[] }> {
    const unavailable = t('Anki template unavailable. Showing a basic preview.', 'Шаблон Anki недоступен. Показан упрощённый вид.')
    if (!modelName.trim()) return { variants: [], cautions: [unavailable] }
    const initialProfile = await verifyProfile()
    const params = { modelName }
    const response = await read([{ action: 'modelTemplates', version: 6, params }, { action: 'modelStyling', version: 6, params }])
    if (await verifyProfile() !== initialProfile) {
        return { variants: [], cautions: [t('The active Anki profile changed. Showing a basic preview.',
            'Активный профиль Anki изменился. Показан упрощённый вид.')] }
    }
    if (!Array.isArray(response) || response.length !== 2) return { variants: [], cautions: [unavailable] }
    const [templateReply, styleReply]: unknown[] = response
    if (!isRecord(templateReply) || templateReply.error !== null || !isRecord(templateReply.result)) {
        return { variants: [], cautions: [unavailable] }
    }
    const css = isRecord(styleReply) && styleReply.error === null && isRecord(styleReply.result) &&
        typeof styleReply.result.css === 'string' && styleReply.result.css.length <= renderLimit ? styleReply.result.css : undefined
    const values = new Map(fields.map(field => [field.name, field.html]))
    values.set('Type', escapeText(modelName))
    if (context.deck !== undefined) {
        const separator = context.deck.lastIndexOf('::')
        values.set('Deck', escapeText(context.deck))
        values.set('Subdeck', escapeText(separator < 0 ? context.deck : context.deck.slice(separator + 2)))
    }
    if (context.tags !== undefined) values.set('Tags', escapeText(context.tags.join(' ')))
    const cautions = new Set<string>()
    const variants: CardPreviewVariant[] = []
    if (css === undefined) cautions.add(t('Anki template styles could not be loaded.', 'Не удалось загрузить стили шаблона Anki.'))
    const unsupportedTemplate = t('An Anki card template could not be previewed.', 'Не удалось показать шаблон карточки Anki.')
    const templates = Object.entries(templateReply.result)
    for (const [name, model] of templates.slice(0, variantLimit)) {
        if (!isRecord(model) || typeof model.Front !== 'string' || typeof model.Back !== 'string') {
            cautions.add(unsupportedTemplate)
            continue
        }
        values.set('Card', escapeText(name))
        const numbers = clozeNumbers(clozeFields(model.Front, values))
        for (const number of (numbers.length ? numbers : [undefined]).slice(0, variantLimit - variants.length)) {
            const front = renderTemplate(model.Front, expression => resolvedField(expression, values, undefined, number, cautions, t))
            const back = front === undefined ? undefined :
                renderTemplate(model.Back, expression => resolvedField(expression, values, front, number, cautions, t))
            if (front === undefined || back === undefined) {
                cautions.add(unsupportedTemplate)
                continue
            }
            if (/<script\b|\[sound:|\b(?:onclick|onload)\s*=/i.test(front + back)) {
                cautions.add(t('Audio and template scripts are not run in preview.',
                    'В предпросмотре звук и скрипты шаблона отключены.'))
            }
            if (visibleValue(front)) variants.push({
                name: number === undefined ? name : t(`Cloze ${number}`, `Пропуск ${number}`),
                front, back, css: css ?? (number === undefined ? undefined : clozeCss),
            })
        }
        if (variants.length >= variantLimit) break
    }
    if (variants.length >= variantLimit && templates.length) cautions.add(t('This preview shows up to 32 card variants.',
        'В предпросмотре доступно до 32 вариантов карточки.'))
    if (variants.length === 0) cautions.add(unavailable)
    return { variants, cautions: [...cautions] }
}
