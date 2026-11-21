// SPDX-License-Identifier: GPL-3.0-only
export interface MigrationMarkdown { bom: string; yaml: string; body: string; eol: string }

/** Return the exact YAML bytes, apart from the BOM. An unclosed header is ambiguous. */
export function splitMigrationMarkdown(text: string): MigrationMarkdown | undefined {
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
    const raw = text.slice(bom.length)
    const eol = raw.match(/\r?\n/u)?.[0] ?? '\n'
    const open = /^---[ \t]*(?:\r?\n|$)/u.exec(raw)
    if (!open) return { bom, yaml: '', body: raw, eol }
    const close = /^---[ \t]*(?:\r?\n|$)/mu.exec(raw.slice(open[0].length))
    if (!close) return undefined
    const end = open[0].length + close.index + close[0].length
    return { bom, yaml: raw.slice(0, end), body: raw.slice(end), eol }
}

// YAML treats a separated # as a comment only outside quoted scalars.
function removedLineComment(line: string): string | undefined {
    let quote = ''
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quote) {
            if (quote === '"' && ch === '\\') i++
            else if (ch === quote) {
                if (quote === "'" && line[i + 1] === "'") i++
                else quote = ''
            }
        } else if ((ch === '"' || ch === "'") && (i === 0 || /[\s:[{,]/u.test(line[i - 1]))) {
            quote = ch
        } else if (ch === '#' && (i === 0 || /\s/u.test(line[i - 1]))) return line.slice(i)
    }
    // A continued quoted scalar needs a multiline YAML parser to locate comments safely.
    return quote ? undefined : ''
}

/** Keep the spelling, comments and line endings of unrelated user properties. */
export function withoutMigrationKeys(yaml: string, keys: ReadonlySet<string>): string | undefined {
    if (!yaml || !keys.size) return yaml
    const lines = yaml.match(/[^\n]*\n|[^\n]+$/gu) ?? []
    if (lines.length < 2) return undefined
    const keep: string[] = []
    const seen = new Set<string>()
    let drop = false
    for (const line of lines.slice(1, -1)) {
        const text = line.replace(/\r?\n$/u, '')
        if (/^\s*$|^[ \t]*#/u.test(text)) { keep.push(line); continue }
        if (/^[ \t]|^-(?:\s|$)/u.test(text)) {
            if (drop && /(?:^|\s)&[\w-]+/u.test(text)) return undefined
        } else {
            const key = /^(?:"([^"\\]+)"|'([^']+)'|([^\s"'!&#*{},\[\]:][^:#]*?))\s*:(?:[ \t]|$)/u.exec(text)
            if (!key) return undefined
            const name = key[1] ?? key[2] ?? key[3]
            drop = keys.has(name)
            if (drop && seen.has(name)) return undefined
            seen.add(name)
        }
        if (drop) {
            if (/(?:^|[\s:[{,])&[\w-]+|(?:^|:\s*|-\s+)[|>][+\-\d]*(?:\s|$)/u.test(text)) return undefined
            const comment = removedLineComment(text)
            if (comment === undefined) return undefined
            if (comment) keep.push(comment + line.slice(text.length))
        } else keep.push(line)
    }
    return keep.some(line => line.trim()) ? lines[0] + keep.join('') + lines[lines.length - 1] : ''
}
