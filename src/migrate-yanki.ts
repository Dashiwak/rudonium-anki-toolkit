// SPDX-License-Identifier: GPL-3.0-only
import { parseYaml } from 'obsidian'
import type { MigrationAdapter, MigrationCandidate } from './page-migration-context'

// The documented noteId is an Anki *note* ID. Never interpret a card ID or
// an arbitrary YAML value as one. Preserve unrelated properties verbatim.
function readMetadata(text: string): { prefix: string; body: string; id?: number } | undefined {
    const opening = /^\uFEFF?---[ \t]*\r?\n/u.exec(text)
    if (!opening) {
        const prefix = text.startsWith('\uFEFF') ? '\uFEFF' : ''
        return { prefix, body: text.slice(prefix.length) }
    }
    const tail = text.slice(opening[0].length)
    const closing = /^---[ \t]*(?:\r?\n|$)/mu.exec(tail)
    if (!closing) return
    const yaml = tail.slice(0, closing.index)
    const body = tail.slice(closing.index + closing[0].length)
    const properties: unknown = parseYaml(yaml)
    if (properties != null && (typeof properties !== 'object' || Array.isArray(properties))) return
    if (!properties || !Object.prototype.hasOwnProperty.call(properties, 'noteId')) {
        return { prefix: opening[0] + yaml + closing[0], body }
    }
    const rows = [...yaml.matchAll(/^(?:noteId|'noteId'|"noteId")[ \t]*:[ \t]*(?:(\d+)|'(\d+)'|"(\d+)")[ \t]*(#[^\r\n]*)?(\r?\n|$)/gmu)]
    if (rows.length !== 1) return
    const row = rows[0]
    const digits = row[1] ?? row[2] ?? row[3]
    const id = Number(digits)
    const stored = (properties as Record<string, unknown>).noteId
    if (!Number.isSafeInteger(id) || id < 1 || String(stored) !== String(id) || String(id) !== digits) return
    const keepComment = row[4] ? row[4] + row[5] : ''
    const remaining = yaml.slice(0, row.index) + keepComment + yaml.slice(row.index + row[0].length)
    return { prefix: opening[0] + remaining + closing[0], body, id }
}

function inside(path: string, root: string): boolean {
    if (root === '/') return true
    const folder = root.replace(/^\/+|\/+$/gu, '')
    return folder.length > 0 && path.startsWith(folder + '/')
}

function endsWithTypedAnswer(body: string): boolean {
    const clean = body.trimEnd()
    if (!clean.endsWith('_') && !clean.endsWith('*')) return false
    const last = /(?:^|\n)[ \t]*([_*])[^\n]+\1$/u
    if (last.test(clean)) return true
    const paragraph = clean.split(/\r?\n[ \t]*\r?\n/u).pop()!.trim()
    return /^([_*])[\s\S]+\1$/u.test(paragraph)
}

/** Conservative recognizer for Yanki Basic, as documented in kitschpatrol/yanki-obsidian. */
export const detectYanki: MigrationAdapter = (path, text, context) => {
    if (context.source && context.source !== 'auto' && context.source !== 'yanki') return
    if (context.folder && !inside(path, context.folder)) return
    const scoped = (context.source === 'yanki' && !!context.folder) ||
        context.yankiFolders?.some(folder => inside(path, folder))
    // noteId alone is shared with other tools. Require evidence of a Yanki installation
    // for automatic discovery and let the planner verify its actual Anki model and deck.
    const propertyHint = /^(?:noteId|'noteId'|"noteId")[ \t]*:/mu.test(text)
    if (!scoped && !(context.yankiInstalled && propertyHint)) return
    const review = (en: string, ru: string, id?: number): MigrationCandidate =>
        ({ source: 'yanki', status: 'review', reason: context.t(en, ru), id })
    let source: ReturnType<typeof readMetadata>
    try { source = readMetadata(text) } catch { /* Malformed or ambiguous YAML must remain intact. */ }
    if (!source) return review('Check the YAML properties and the original Yanki noteId.',
        'Проверьте свойства YAML и исходный noteId Yanki.')
    if (!scoped && !source.id) return
    const { body, id, prefix } = source
    if (/^(?:[ \t]*\r?\n)* {0,3}#[ \t]+[^\r\n]+[ \t]+#anki-page[ \t]*(?:\r?\n|$)/u.test(body)) return
    const filename = path.split('/').pop()?.replace(/\.md$/iu, '')
    if (!id && filename === path.split('/').slice(-2, -1)[0]) {
        return review('Yanki can exclude folder notes. Check this folder index first.',
            'Yanki может исключать заметки с именем папки. Проверьте эту заметку-оглавление.')
    }
    if (body.includes('~~') || endsWithTypedAnswer(body)) {
        return review('Yanki cloze and typed-answer cards require their own templates.',
            'Для пропусков Yanki и карточек с вводом ответа нужны их исходные шаблоны.', id)
    }
    // A thematic break must be its own block. "Title\n---" is a Setext heading.
    // Multiple rules, including other Markdown spellings, can indicate a reversed note.
    const lines = body.split(/\r?\n/u)
    const breaks: number[] = []
    for (let i = 0; i < lines.length; i++) {
        if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(lines[i])) breaks.push(i)
    }
    if (breaks.length !== 1 || breaks[0] === 0 || lines[breaks[0] - 1].trim() || lines[breaks[0]].trim() !== '---') {
        return review('Expected a Basic card with one separate --- line. Check reversed, front-only and multi-part notes.',
            'Для Basic нужна одна отдельная строка ---. Проверьте оборотные карточки, записи без ответа и составные заметки.', id)
    }
    const separator = breaks[0]
    const front = lines.slice(0, separator).join('\n').trim()
    const sourceFront = lines.slice(0, separator).find(line => line.trim()) ?? ''
    if (!front || front.includes('\n') || /^(?:[ \t]{4}|\t| {0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|`{3}|~{3}|<|\$\$|\|))/u.test(sourceFront)) {
        return review('The front needs a single question line that can become a page heading.',
            'Вопрос должен занимать одну строку, которую можно перенести в заголовок страницы.', id)
    }
    if (/^\^\S+[ \t]*$/u.test(front) || /\s\^[\w-]+$/u.test(front) || front.includes('#anki-page')) {
        return review('Check the source heading or block reference before converting this note.',
            'Проверьте заголовок или ссылку на блок перед преобразованием этой заметки.', id)
    }
    const boundary = /^ {0,3}---[ \t]*(?:\r?\n|$)/mu.exec(body)!
    const back = body.slice(boundary.index + boundary[0].length).replace(/^(?:[ \t]*\r?\n)+/u, '')
    if (!back.trim()) return review('This Yanki note has no answer.', 'У этой записи Yanki нет ответа.', id)
    return { source: 'yanki', status: 'candidate', prefix, front, back, id,
        recoveryModel: 'Yanki - Basic', model: id === undefined ? undefined : 'Yanki - Basic', fieldNames: ['Front', 'Back'] }
}
