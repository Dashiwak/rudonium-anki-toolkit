// SPDX-License-Identifier: GPL-3.0-only
import { activeCardMarkdown } from './archived-card'
import { visitRootMarkdownLines } from './id-marker-literals'
import { maskMarkdownSpans } from './markdown-pipeline'
import { pageHeading } from './page-frontmatter'

const open = '<!--anki-fields-->', close = '<!--/anki-fields-->'
type Range = [number, number]
type View = { text: string; ranges: Range[]; ends: ReadonlyMap<number, number> }
const noRanges: Range[] = []
const noEnds: ReadonlyMap<number, number> = new Map()
let last: { source: string; view: View } | undefined
let expiry: ReturnType<typeof setTimeout> | undefined

/** Version 0.9.7 wrote closed appendices. Preserve their bytes as inert Markdown. */
export function legacyFieldSections(source: string): View {
    if (!source.includes(close) || !source.includes(open)) return { text: source, ranges: noRanges, ends: noEnds }
    if (last?.source === source) return last.view
    const active = activeCardMarkdown(source)
    const ranges: Range[] = []
    let start: number | undefined
    visitRootMarkdownLines(active, {
        line() {},
        comment(at, lineStart, end) {
            if (lineStart !== at) return
            let stop = end
            while (active[stop] === ' ' || active[stop] === '\t') stop++
            if (stop !== active.length && active[stop] !== '\n' && !active.startsWith('\r\n', stop)) return
            const token = active.slice(at, end)
            if (token === open && start === undefined) start = at
            if (token === close && start !== undefined) { ranges.push([start, stop]); start = undefined }
        },
    })
    // A marked page has its own, unbounded named-field syntax.
    const masked = maskMarkdownSpans(source, ranges)
    const page = ranges.length && pageHeading(active === source ? masked : maskMarkdownSpans(active, ranges))
    const view: View = page || !ranges.length ? { text: source, ranges: noRanges, ends: noEnds }
        : { text: masked, ranges, ends: new Map(ranges) }
    last = { source, view }
    if (expiry !== undefined) clearTimeout(expiry)
    expiry = undefined
    if (source.length > 4 * 1024 * 1024) {
        expiry = setTimeout(() => { last = undefined; expiry = undefined }, 5000)
        const handle = expiry as unknown as { unref?(): void }
        handle.unref?.()
    }
    return view
}

export function maskLegacyFieldSections(source: string): string {
    return source.includes(close) ? legacyFieldSections(source).text : source
}
