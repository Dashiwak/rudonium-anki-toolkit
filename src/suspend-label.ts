// SPDX-License-Identifier: GPL-3.0-only
import type { DuplicateMarkerSyntax } from './duplicate-markers'

export type SuspendSelection = 'all' | readonly number[]

export function suspendLabel(syntax?: DuplicateMarkerSyntax): string {
    return syntax?.['Suspend Line'] || 'SUSPEND'
}

const defaults = { 'Begin Note': 'START', 'End Note': 'END', 'Begin Inline Note': 'STARTI',
    'End Inline Note': 'ENDI', 'Delete Note Line': 'DELETE', 'Frozen Fields Line': 'FROZEN',
    'Target Deck Line': 'TARGET DECK', 'File Tags Line': 'FILE TAGS' }

const labelsBySettings = new WeakMap<object, { current: string; raw: string; labels: string[] }>()
const standardLabels = ['SUSPEND']

export function suspendLabels(syntax?: DuplicateMarkerSyntax): readonly string[] {
    if (!syntax) return standardLabels
    const current = suspendLabel(syntax), raw = syntax['Suspend Line Aliases'] || ''
    const cached = labelsBySettings.get(syntax)
    if (cached && cached.current === current && cached.raw === raw) return cached.labels
    const aliases: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(aliases) || !aliases.every((value): value is string => typeof value === 'string')) {
        throw new Error('Invalid suspension marker aliases. / Некорректные прежние метки приостановки.')
    }
    const labels = [...new Map([current, ...aliases].map(value => [value.toLowerCase(), value])).values()]
        .sort((a, b) => b.length - a.length)
    labelsBySettings.set(syntax, { current, raw, labels })
    return labels
}

function overlaps(a: string, b: string): boolean {
    return a === b || a.startsWith(b + '_') || b.startsWith(a + '_') ||
        a.startsWith(b + ' ') || b.startsWith(a + ' ')
}

/** A configured end-of-card line can sit directly above the ID just like DELETE. */
export function deletionLabelProblem(syntax: DuplicateMarkerSyntax): string | undefined {
    const label = syntax['Delete Note Line'] ?? defaults['Delete Note Line']
    if (!label) return
    const normalized = label.toLowerCase()
    if (label !== label.trim() || /[\p{Cc}\u2028\u2029]/u.test(label) ||
        /^(?:ID\s*:|Tags:|---|\$\$|%%)$/iu.test(label) ||
        Object.entries(defaults).some(([key, fallback]) => key !== 'Delete Note Line' &&
            (syntax[key as keyof DuplicateMarkerSyntax] ?? fallback).trim().toLowerCase() === normalized) ||
        suspendLabels(syntax).some(value => overlaps(normalized, value.toLowerCase()))) {
        return 'Choose a distinct deletion marker; it overlaps a card delimiter or another control. / Выберите отдельную метку удаления: она совпадает с границей карточки или другой служебной командой.'
    }
}

export function suspendLabelProblem(label: string, syntax?: DuplicateMarkerSyntax): string | undefined {
    let labels: readonly string[]
    try { labels = suspendLabels({ ...syntax, 'Suspend Line': label }) } catch {
        return 'Invalid suspension marker history. / Проверьте сохранённые прежние метки приостановки.'
    }
    if (!label || labels.some(value => !value || value !== value.trim() || /[\p{Cc}\u2028\u2029]/u.test(value) ||
        /(?:_|[ \t])\d+(?:,[ \t]*\d+)*$/u.test(value) ||
        /^(?:ID\s*:|#{1,6}(?:\s|$)|[-+*>]\s|---$|\$\$|~~~|%%|<!--|\x60)/iu.test(value))) {
        return 'Choose a single visible marker without a card-number suffix. / Введите отдельную метку без номера карточки на конце.'
    }
    const other = Object.entries(defaults).map(([key, fallback]) =>
        (syntax?.[key as keyof DuplicateMarkerSyntax] || fallback).trim().toLowerCase())
    for (const value of labels) {
        const normalized = value.toLowerCase()
        if (other.some(existing => overlaps(existing, normalized))) {
            return 'This marker overlaps another syntax setting or previous name. / Метка совпадает с другой директивой или прежней меткой.'
        }
        other.push(normalized)
    }
}

export function readSuspendLine(raw: string, syntax?: DuplicateMarkerSyntax): SuspendSelection | undefined {
    // Four-space examples, quoted text and lists belong to Markdown, even immediately above an ID.
    if (!raw || /^(?: {4}| {0,3}\t)/u.test(raw)) return
    const value = raw.trim()
    const label = suspendLabels(syntax).find(prefix => value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase())
    if (!label) return
    if (value.length === label.length) return 'all'
    const suffix = value.slice(label.length)
    if (suffix[0] !== '_' && !/^[ \t]+[+\-\d,]/u.test(suffix)) return
    const list = suffix[0] === '_' ? suffix.slice(1) : suffix.trimStart()
    if (/^[1-9]\d*(?:,[ \t]*[1-9]\d*)*$/u.test(list)) {
        const ordinals = list.split(',').map(Number)
        if (ordinals.every(Number.isSafeInteger) && new Set(ordinals).size === ordinals.length) {
            return ordinals.sort((a, b) => a - b)
        }
    }
    throw new Error('Invalid card numbers in the suspension marker. / Проверьте номера карточек в метке приостановки.')
}
