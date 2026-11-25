// SPDX-License-Identifier: GPL-3.0-only
import { editorLivePreviewField, type MarkdownPostProcessorContext } from 'obsidian'
import { StateEffect, type Text } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import type MyPlugin from '../main'
import { archivedCardRanges } from './archived-card'

const legacyOpener = /<!--RUDONIUM-ARCHIVE:[1-9]\d{0,15}-->/u
const openerLookaround = '<!--RUDONIUM-ARCHIVE:'.length + String(Number.MAX_SAFE_INTEGER).length + '-->'.length
const bodyClass = 'rudonium-archived-card-body'
const statusClass = 'rudonium-archived-card-status'

interface Span { from: number; to: number }
interface ReadingSpan { first: number; last: number; bodyFirst: number; bodyLast: number; status: number; label: string }

function rangesForDisplay(text: string): ReturnType<typeof archivedCardRanges> {
    if (!legacyOpener.test(text)) return []
    try { return archivedCardRanges(text).filter(range => range.style === 'legacy') }
    catch { return [] }
}

function lowerBound(length: number, before: (index: number) => boolean): number {
    let low = 0, high = length
    while (low < high) {
        const mid = low + Math.floor((high - low) / 2)
        if (before(mid)) low = mid + 1
        else high = mid
    }
    return low
}

function readingSpans(text: string): ReadingSpan[] {
    const ranges = rangesForDisplay(text)
    if (!ranges.length) return []
    const starts = [0]
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
    const line = (at: number) => lowerBound(starts.length, i => starts[i] <= at) - 1
    return ranges.map(r => {
        const status = line(r.statusStart)
        const statusLine = text.slice(starts[status], starts[status + 1]).trim()
        const label = /^\*\*(.+)\*\*$/u.exec(statusLine)?.[1] ?? ''
        return { first: line(r.start), last: line(r.end - 1), bodyFirst: line(r.bodyStart),
            bodyLast: line(Math.max(r.bodyStart, r.bodyEnd - 1)), status, label }
    })
}

function strikeReadingText(element: HTMLElement, status?: HTMLElement): void {
    const owner = element.ownerDocument
    const walker = owner.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const textNodes: Node[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeValue?.trim() && !status?.contains(node) &&
            !node.parentElement?.closest('s, del, svg, math, script, style, textarea')) textNodes.push(node)
    }
    for (const node of textNodes) {
        const parent = node.parentElement
        if (!parent) continue
        const strike = parent.createEl('s', { cls: bodyClass })
        parent.insertBefore(strike, node)
        strike.appendChild(node)
    }
}

function registerReadingView(plugin: MyPlugin): void {
    if (typeof plugin.registerMarkdownPostProcessor !== 'function') return
    const cache = new Map<string, { text: string; spans: ReadingSpan[] }>()
    plugin.registerMarkdownPostProcessor((element: HTMLElement, context: MarkdownPostProcessorContext) => {
        if (element.classList.contains(bodyClass)) {
            for (const strike of Array.from(element.querySelectorAll('s.' + bodyClass))) {
                strike.replaceWith(...Array.from(strike.childNodes))
            }
            element.classList.remove(bodyClass)
            element.querySelector('.' + statusClass)?.classList.remove(statusClass)
        }
        const section = context.getSectionInfo(element)
        if (!section) return
        let doc = cache.get(context.sourcePath)
        if (!doc || doc.text !== section.text) {
            if (cache.size >= 4 && !doc) cache.delete(cache.keys().next().value as string)
            doc = { text: section.text, spans: readingSpans(section.text) }
            cache.set(context.sourcePath, doc)
        }
        const { lineStart: first, lineEnd: last } = section
        const ranges = doc.spans
        const r = ranges[lowerBound(ranges.length, i => ranges[i].last < first)]
        if (!r || !Number.isInteger(first) || !Number.isInteger(last) || first > last ||
            first < r.first || last > r.last || first > r.bodyLast || last < r.bodyFirst ||
            element.closest('.callout, .internal-embed') || element.querySelector('.internal-embed')) return
        let status: HTMLElement | undefined
        if (r.label && first <= r.status && last >= r.status) {
            const bold = Array.from(element.querySelectorAll('strong'))
            status = bold[bold.length - 1]
            if (!status || status.textContent?.trim() !== r.label) return
            status.classList.add(statusClass)
        }
        strikeReadingText(element, status)
        element.classList.add(bodyClass)
    })
    plugin.register(() => {
        cache.clear()
    })
}

function containsLegacyOpener(doc: Text, from = 0, to = doc.length): boolean {
    const iterator = doc.iterRange(from, to)
    while (!iterator.next().done) if (legacyOpener.test(iterator.value)) return true
    return false
}

function visibleArchiveSpans(ranges: readonly Span[], visible: readonly Span[]): Span[] {
    const output: Span[] = []
    for (const part of visible) {
        let index = lowerBound(ranges.length, i => ranges[i].to <= part.from)
        while (index < ranges.length && ranges[index].from < part.to) {
            const item = ranges[index++]
            const from = Math.max(item.from, part.from), to = Math.min(item.to, part.to)
            if (from < to) output.push({ from, to })
        }
    }
    return output
}

export function registerArchivedCardDisplay(plugin: MyPlugin): void {
    registerReadingView(plugin)
    if (typeof plugin.registerEditorExtension !== 'function') return
    try {
        if (!editorLivePreviewField) return
        const refresh = StateEffect.define<void>()
        const mark = Decoration.mark({ tagName: 's', class: bodyClass })
        class ArchiveView {
            decorations: DecorationSet = Decoration.none
            private spans: Span[] = []
            private marked = false
            private timerWindow?: Window
            private timer?: number
            constructor(view: EditorView) { if (view.state.field(editorLivePreviewField, false)) this.read(view) }
            private read(view: EditorView): void {
                this.marked = containsLegacyOpener(view.state.doc)
                this.spans = this.marked ? rangesForDisplay(view.state.doc.toString()).map(r => ({ from: r.bodyStart, to: r.bodyEnd })) : []
                this.paint(view)
            }
            private paint(view: EditorView): void {
                this.decorations = Decoration.set(visibleArchiveSpans(this.spans, view.visibleRanges).map(s => mark.range(s.from, s.to)))
            }
            update(update: ViewUpdate): void {
                if (!update.state.field(editorLivePreviewField, false)) {
                    this.destroy()
                    this.spans = []
                    this.marked = false
                    this.decorations = Decoration.none
                    return
                }
                if (!update.startState.field(editorLivePreviewField, false) || update.transactions.some(tr => tr.effects.some(effect => effect.is(refresh)))) {
                    this.read(update.view)
                    return
                }
                if (update.docChanged) {
                    let affected = this.marked
                    if (!affected) update.changes.iterChangedRanges((_a, _b, from, to) => {
                        if (!affected) affected = containsLegacyOpener(update.state.doc, Math.max(0, from - openerLookaround),
                            Math.min(update.state.doc.length, to + openerLookaround))
                    })
                    if (!affected) return
                    this.spans = []
                    this.marked = true
                    this.decorations = Decoration.none
                    this.destroy()
                    this.timerWindow = update.view.dom.ownerDocument.defaultView ?? window
                    this.timer = this.timerWindow.setTimeout(() => update.view.dispatch({ effects: refresh.of(undefined) }), 180)
                } else if (update.viewportChanged) this.paint(update.view)
            }
            destroy(): void { if (this.timer !== undefined) this.timerWindow?.clearTimeout(this.timer); this.timer = undefined }
        }
        plugin.registerEditorExtension(ViewPlugin.fromClass(ArchiveView, { decorations: view => view.decorations }))
    } catch (error) {
        console.warn('[Rudonium Anki Toolkit] Archive formatting is unavailable in the editor.', error)
    }
}
