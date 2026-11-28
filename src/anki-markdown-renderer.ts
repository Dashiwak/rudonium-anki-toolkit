// SPDX-License-Identifier: GPL-3.0-only
import { Marked, Renderer } from 'marked'
import type { TokenizerObject, Tokens } from 'marked'
import hljs from 'highlight.js'

// Showdown starts a nested list at four spaces. Marked may already have grouped a
// two- or three-space item with its parent. Reparent only actual list tokens: a
// marker inside a code fence, raw HTML or a paragraph must remain untouched.
function legacyListLevels(list: Tokens.List): Tokens.List[] {
    if (!list.items.some(item => item.tokens.some(token => token.type === 'list'))) return [list]
    const lines = list.raw.split('\n')
    const roots: Tokens.List[] = []
    const levels: Tokens.List[] = []
    let changed = false
    const lineCount = (raw: string) => raw.split('\n').length - 1

    function collect(group: Tokens.List, row: number, originalDepth: number): boolean {
        for (const item of group.items) {
            const first = item.raw.split('\n', 1)[0].trimStart()
            const source = lines[row]
            if (source === undefined || source.trimStart() !== first) return false
            const depth = Math.min(originalDepth, Math.floor((source.length - first.length) / 4), levels.length)
            const firstChild = item.tokens.findIndex(token => token.type === 'list')
            if (firstChild >= 0 && item.tokens.slice(firstChild).some(token =>
                token.type !== 'list' && token.type !== 'space')) return false
            levels.length = Math.min(levels.length, depth + 1)
            let target = levels[depth]
            if (!target || target.ordered !== group.ordered) {
                target = { ...group, start: group.ordered && depth === 0 ? list.start || 1 : group.start, items: [] }
                if (depth) {
                    const parents = levels[depth - 1].items
                    parents[parents.length - 1].tokens.push(target)
                } else roots.push(target)
                levels[depth] = target
            }
            changed ||= depth !== originalDepth
            target.items.push({ ...item, tokens: firstChild < 0 ? [...item.tokens] : item.tokens.slice(0, firstChild) })
            if (firstChild >= 0) {
                let childRow = row
                for (const token of item.tokens) {
                    if (token.type === 'list' && !collect(token as Tokens.List, childRow, originalDepth + 1)) return false
                    childRow += lineCount(token.raw)
                }
            }
            row += lineCount(item.raw)
        }
        return true
    }
    return collect(list, 0, 0) && changed ? roots : [list]
}

// The HTML spelling matters: Anki stores the resulting string and Rudonium compares
// it with the last export. Keep the forms used by Obsidian_to_Anki for existing notes.
class AnkiRenderer extends Renderer {
    private listDepth = 0
    readonly headingCounts = new Map<string, number>()

    text(token: Tokens.Text | Tokens.Escape): string {
        if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens)
        if ('escaped' in token && token.escaped) return token.text
        // Showdown applied typographic ellipses to prose after protecting code and escapes.
        const text = token.type === 'text' ? token.text.replace(/\.\.\./g, '…') : token.text
        return text.replace(/&(?!#\d+;|#x[\da-f]+;|[a-z][\da-z]*;)/gi, '&amp;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    heading(token: Tokens.Heading): string {
        const stem = token.text.toLowerCase().replace(/[^\w]/g, '')
        const n = this.headingCounts.get(stem) ?? 0
        this.headingCounts.set(stem, n + 1)
        const id = n ? stem + '-' + n : stem
        return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`
    }

    br(token: Tokens.Br): string {
        return token.raw.replace(/\n[\s\S]*$/, '<br />\n')
    }

    hr(): string { return '<hr />\n' }

    image(token: Tokens.Image): string { return super.image(token).replace(/>$/, ' />') }

    codespan(token: Tokens.Codespan): string {
        return super.codespan(token).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    }

    del(token: Tokens.Del): string {
        const markers = token.raw.startsWith('~~') ? '~~' : '~'
        return markers + this.parser.parseInline(token.tokens) + markers
    }

    code(token: Tokens.Code): string {
        const language = (token.lang ?? '').split(/\s/, 1)[0]
        const code = token.text.replace(/\n$/, '') + '\n'
        const html = language && hljs.getLanguage(language)
            ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value
        const label = language.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<pre><code class="hljs${label ? ' ' + label + ' language-' + label : ''}">${html}</code></pre>\n`
    }

    blockquote(token: Tokens.Blockquote): string {
        const inner = this.parser.parse(token.tokens).trimEnd().replace(/^/gm, '  ')
        return '<blockquote>\n' + inner + '\n</blockquote>\n'
    }

    checkbox({ checked }: Tokens.Checkbox): string {
        return '<input type="checkbox" disabled style="margin: 0px 0.35em 0.25em -1.6em; vertical-align: middle;"' +
            (checked ? ' checked' : '') + '> '
    }

    list(token: Tokens.List): string {
        const nested = this.listDepth > 0
        this.listDepth++
        try {
            const html = (nested ? [token] : legacyListLevels(token)).map(group => super.list(group)).join('')
            return nested ? html.replace(/\n(<\/(?:ul|ol)>)\n$/, '$1') : html
        } finally {
            this.listDepth--
        }
    }

    listitem(token: Tokens.ListItem): string {
        const item = super.listitem(token)
        return token.task ? item.replace(/^<li>/, '<li class="task-list-item" style="list-style-type: none;">') : item
    }

    table(token: Tokens.Table): string {
        const row = (cells: Tokens.TableCell[]) => '<tr>\n' + cells.map(cell => this.tablecell(cell)).join('') + '</tr>\n'
        return '<table>\n<thead>\n' + row(token.header) + '</thead>\n<tbody>\n' + token.rows.map(row).join('') +
            '</tbody>\n</table>\n'
    }

    tablecell(cell: Tokens.TableCell): string {
        const tag = cell.header ? 'th' : 'td'
        const style = cell.align ? ` style="text-align:${cell.align};"` : ''
        return `<${tag}${style}>${this.parser.parseInline(cell.tokens)}</${tag}>\n`
    }
}

// Showdown requires two dashes in each of the first two divider cells. Marked
// also accepts a single dash. Only inspect lines that could be table dividers.
const dividerLine = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
function shortDivider(line: string): boolean {
    if (!line.includes('|') || !dividerLine.test(line)) return false
    const cells = line.trim().replace(/^\||\|$/g, '').split('|', 2)
    return cells.some(cell => !cell.includes('--'))
}

function nextLine(text: string, start: number): string {
    const end = text.indexOf('\n', start)
    return text.slice(start, end < 0 ? text.length : end)
}

// A closing parenthesis numbers examples in many vocabulary notes. Treat it as
// plain text, while retaining ordered lists written with a period.
const legacyBlockMarkers: TokenizerObject = {
    list(source) {
        return /^ {0,3}\d{1,9}\)(?:[ \t]|\r?\n|$)/.test(source) ? undefined : false
    },
    table(source) {
        const lineEnd = source.indexOf('\n')
        if (lineEnd >= 0 && shortDivider(nextLine(source, lineEnd + 1))) return undefined
        return false
    },
    paragraph(source) {
        const rule = this.rules.block.paragraph
        const first = rule.exec(source)
        if (!first || !source.startsWith('\n', first[0].length)) return false
        const after = first[0].length + 1
        const header = nextLine(source, after)
        const divider = after + header.length + 1
        if (!/^ {0,3}1\)[ \t]/.test(header) &&
            !(divider < source.length && shortDivider(nextLine(source, divider)))) return false
        // Mask only the ambiguous markers in a copy used for measuring. The real
        // paragraph tokens and all inline markup come from the original text.
        const end = source.search(/\n[ \t]*\n/)
        const paragraph = end < 0 ? source : source.slice(0, end)
        const masked = paragraph.replace(/^( {0,3})1(?=\)[ \t])/gm, '$1x')
            .replace(/^[ \t:|-]+$/gm, line => shortDivider(line) ? line.replace('-', 'x') : line)
        const measured = rule.exec(masked)
        if (!measured) return false
        const raw = source.slice(0, measured[0].length)
        return { type: 'paragraph', raw, text: raw, tokens: this.lexer.inline(raw) }
    },
}

let parser: Marked | undefined
let renderer: AnkiRenderer | undefined

export function renderAnkiMarkdown(markdown: string): string {
    renderer ??= new AnkiRenderer()
    parser ??= new Marked().setOptions({ renderer, breaks: true, gfm: true }).use({ tokenizer: legacyBlockMarkers })
    renderer.headingCounts.clear()
    markdown = markdown.replace(/\u00a0/g, '&nbsp;')
    // Legacy exports insert four spaces at the first tab on each line; subsequent
    // tabs align relative to the previous tab. Leading tabs affect Markdown blocks.
    if (markdown.includes('\t')) {
        markdown = markdown.split(/(?<=\n)|(?<=\r)(?!\n)/).map(line => {
            let previous = -1
            return line.replace(/\t/g, (_tab, offset: number) => {
                const width = previous < 0 ? 4 : 4 - (offset - previous - 1) % 4
                previous = offset
                return ' '.repeat(width)
            })
        }).join('')
    }
    // Discard blank lines at EOF while keeping authored spaces on the final text line.
    const trimmed = markdown.trimEnd()
    const trailing = markdown.slice(trimmed.length)
    const lineEnd = trailing.search(/[\r\n]/)
    const content = lineEnd < 0 ? markdown : trimmed + trailing.slice(0, lineEnd)
    return parser.parse(content, { async: false }).trim()
}
