/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
export type BidirectionalFieldDirection = 'both' | 'to-anki' | 'to-obsidian'

export interface BidirectionalFieldRule {
    model: string
    field: string
    direction: BidirectionalFieldDirection
}

export const explicitFieldLabel = /^([^\s:\x00-\x1f\x7f<>[\]][^:\x00-\x1f\x7f<>[\]]{0,79}):([ \t]*)(.*)$/u

const protectedNames = new Set(['front', 'back', 'file', 'context', 'add reverse', 'frontlang', 'backlang',
    'tags', 'text', 'image', 'occlusion', 'id', 'anki id', '__proto__', 'constructor', 'prototype'])
const directions: ReadonlySet<string> = new Set(['both', 'to-anki', 'to-obsidian'])

export function isBidirectionalFieldName(name: string): boolean {
    return name.length > 0 && name.length <= 80 && name.trim() === name &&
        !/[\p{Cc}\u2028\u2029\p{Cs}[\]<>]/u.test(name) &&
        !protectedNames.has(name.toLowerCase())
}

export function readBidirectionalFieldRules(value: unknown): BidirectionalFieldRule[] {
    if (!Array.isArray(value)) return []
    const rules = new Map<string, BidirectionalFieldRule>()
    const ambiguous = new Set<string>()
    for (const entry of value.slice(0, 256)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const { model, field, direction } = entry as Partial<BidirectionalFieldRule>
        if (typeof model !== 'string' || !model.trim() || typeof field !== 'string' ||
            !isBidirectionalFieldName(field) || !direction || !directions.has(direction)) continue
        const key = JSON.stringify([model, field])
        if (rules.has(key)) ambiguous.add(key)
        rules.set(key, { model, field, direction })
    }
    for (const key of ambiguous) rules.delete(key)
    return Array.from(rules.values())
}

/** Служебное поле может иметь произвольное имя в настройках конкретной модели. */
export function isGeneratedBidirectionalField(settings: {
    FILE_LINK_FIELDS?: Record<string, string>
    CONTEXT_FIELDS?: Record<string, string>
}, model: string, field: string): boolean {
    return settings.FILE_LINK_FIELDS?.[model] === field || settings.CONTEXT_FIELDS?.[model] === field
}

export function parseExplicitLinkedField(part: string): { field: string; value: string; offset: number } | undefined {
    const marker = /^X\[([^[\]\r\n]{1,80})\]=/u.exec(part)
    if (!marker || !isBidirectionalFieldName(marker[1])) return
    return { field: marker[1], value: part.slice(marker[0].length), offset: marker[0].length }
}

/** Anki определяет создание карточки по лицевой стороне каждого шаблона. */
export function readTemplateFieldReferences(value: unknown): ReadonlySet<string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const templates: unknown[] = Object.values(value)
    if (!templates.length || templates.length > 100) return
    const result = new Set<string>()
    for (const row of templates) {
        if (!row || typeof row !== 'object' || Array.isArray(row) ||
            !('Front' in row) || typeof row.Front !== 'string' || !('Back' in row) || typeof row.Back !== 'string') return
        const question = row.Front
        if (question.length > 500_000) return
        let unmatched = false
        const remaining = question.replace(/\{\{\{([^{}]+)\}\}\}|\{\{([^{}]+)\}\}/gu, (_match: string, triple: string | undefined, normal: string | undefined) => {
            const expression = (triple ?? normal ?? '').trim().replace(/^[#^/&]/u, '').trim()
            const field = expression.slice(expression.lastIndexOf(':') + 1).trim()
            if (!field || /^[=%>!<]/u.test(field)) unmatched = true
            result.add(field.toLowerCase())
            return ''
        })
        if (unmatched || remaining.includes('{{')) return
    }
    return result
}
