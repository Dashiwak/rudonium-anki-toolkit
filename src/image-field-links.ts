/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
const htmlTag = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi
const attribute = /(\s+)([^\s<>=/"']+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s<>="'`]+)))?/g
const rawText = new Set(['script', 'style', 'textarea', 'xmp', 'title'])
const mediaTags = new Set(['img', 'audio', 'video', 'source'])
const sounds = /\[sound:([^\]\r\n]+)\]/gi
const namedEntities = new Map([
    ['amp', '&'], ['quot', '"'], ['apos', "'"], ['lt', '<'], ['gt', '>'],
])

function decodeHtml(value: string): string {
    return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (token, entity: string) => {
        if (!entity.startsWith('#')) return namedEntities.get(entity.toLowerCase()) ?? token
        const hex = entity[1]?.toLowerCase() === 'x'
        const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
            ? String.fromCodePoint(point)
            : token
    })
}

export function encodeAnkiMediaFilename(filename: string): string | undefined {
    if (!filename || filename === '.' || filename === '..' || /[/\\:\u0000-\u001f\u007f]/u.test(filename)) return undefined
    try {
        return encodeURIComponent(filename).replace(/[!'()*]/g, character =>
            '%' + character.charCodeAt(0).toString(16).toUpperCase())
    } catch {
        // Имя файла с некорректным Unicode пропускаем, чтобы не вставлять его в поле.
        return undefined
    }
}

function sourceKey(filename: string): string | undefined {
    if (!filename || /^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(filename)) return undefined
    return filename.normalize('NFC').toLowerCase()
}

/** Возвращает нормализованные локальные имена медиа из уже отформатированных полей. */
export function imageFieldMediaKeys(fields: Readonly<Record<string, string>>): ReadonlySet<string> {
    const keys = new Set<string>()
    const add = (value: string) => {
        const decoded = decodeHtml(value)
        const values = [decoded]
        if (decoded.includes('%')) {
            try { values.push(decodeURIComponent(decoded)) } catch { /* некорректный URL */ }
        }
        for (const candidate of values) {
            if (!sourceKey(candidate)) continue
            const filename = candidate.split(/[/\\]/).pop()
            if (filename && encodeAnkiMediaFilename(filename) !== undefined) keys.add(filename.normalize('NFC').toLowerCase())
        }
    }
    const addSounds = (text: string) => { for (const match of text.matchAll(sounds)) add(match[1]) }
    for (const value of Object.values(fields)) {
        if (!/<(?:img|audio|video|source)[\s/>]|\[sound:/i.test(value)) continue
        let last = 0
        let raw: string | undefined
        for (const match of value.matchAll(htmlTag)) {
            const [tag, tagName] = match
            if (!raw) addSounds(value.slice(last, match.index!))
            last = match.index! + tag.length
            const name = tagName?.toLowerCase()
            const closing = tag.startsWith('</')
            if (raw) {
                if (closing && name === raw) raw = undefined
                continue
            }
            if (!name || closing) continue
            if (rawText.has(name)) raw = name
            if (!mediaTags.has(name)) continue
            for (const [, , key, assignment, double, single, bare] of tag.matchAll(attribute)) {
                const lower = key.toLowerCase()
                if (assignment && (lower === 'src' || name === 'video' && lower === 'poster')) add(double ?? single ?? bare ?? '')
            }
        }
        if (!raw) addSounds(value.slice(last))
    }
    return keys
}

/** Меняет ссылки на медиа только по подтверждённым соответствиям. Сохраняет остальные байты поля. */
export function rewriteImageFields(fields: Record<string, string>, aliases: ReadonlyMap<string, string>): void {
    if (!aliases.size) return
    const normalized = new Map<string, string | null>()
    for (const [source, target] of aliases) {
        const key = sourceKey(source)
        if (key !== undefined && encodeAnkiMediaFilename(target) !== undefined) {
            const existing = normalized.get(key)
            normalized.set(key, existing === undefined || existing === target ? target : null)
        }
    }
    const find = (value: string) => {
        const decoded = decodeHtml(value)
        if (!sourceKey(decoded)) return undefined
        const keys = new Set([sourceKey(value), sourceKey(decoded)])
        if (decoded.includes('%')) {
            try { keys.add(sourceKey(decodeURIComponent(decoded))) } catch { /* некорректный URL */ }
        }
        const targets = new Set<string>()
        for (const key of keys) {
            if (key === undefined) continue
            const candidate = normalized.get(key)
            if (candidate === null) return undefined
            if (candidate !== undefined) targets.add(candidate)
        }
        return targets.size === 1 ? targets.values().next().value : undefined
    }
    const rewriteSounds = (text: string) => text.replace(sounds, (match, reference: string) => {
        const filename = find(reference)
        return filename === undefined || /[\[\]<>]/u.test(filename) ? match : '[sound:' + filename + ']'
    })
    for (const [field, value] of Object.entries(fields)) {
        if (!/<(?:img|audio|video|source)[\s/>]|\[sound:/i.test(value)) continue
        const parts: string[] = []
        let previous = 0
        let raw: string | undefined
        for (const match of value.matchAll(htmlTag)) {
            const [tag, tagName] = match
            const index = match.index
            if (index === undefined) continue
            const segment = value.slice(previous, index)
            parts.push(raw ? segment : rewriteSounds(segment))
            previous = index + tag.length
            const name = tagName?.toLowerCase()
            const closing = tag.startsWith('</')
            if (raw) {
                if (closing && name === raw) raw = undefined
                parts.push(tag)
                continue
            }
            if (name && !closing && rawText.has(name)) raw = name
            if (!name || closing || !mediaTags.has(name)) { parts.push(tag); continue }
            parts.push(tag.replace(attribute, (matched, separator: string, key: string, assignment: string | undefined,
                double: string | undefined, single: string | undefined, bare: string | undefined) => {
                if (assignment === undefined || !(key.toLowerCase() === 'src' ||
                    (name === 'video' && key.toLowerCase() === 'poster'))) return matched
                const filename = find(double ?? single ?? bare ?? '')
                if (filename === undefined) return matched
                const encoded = encodeAnkiMediaFilename(filename)
                if (encoded === undefined) return matched
                const quote = double !== undefined ? '"' : single !== undefined ? "'" : ''
                return separator + key + assignment + quote + encoded + quote
            }))
        }
        const last = value.slice(previous)
        parts.push(raw ? last : rewriteSounds(last))
        fields[field] = parts.join('')
    }
}
