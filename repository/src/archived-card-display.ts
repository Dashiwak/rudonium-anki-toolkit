// SPDX-License-Identifier: GPL-3.0-only
import type { MarkdownPostProcessorContext } from 'obsidian'
import type { StateField, Text } from '@codemirror/state'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import type MyPlugin from '../main'
import { archivedCardRanges } from './archived-card'

// Начиная с 0.8.6 каждый вариант записан в переносимом Markdown/HTML.
// Старые блоки без указания стиля по-прежнему оформляет расширение.
const legacyOpener = /<!--RUDONIUM-ARCHIVE:[1-9]\d{0,15}-->/u
const openerLookaround = '<!--RUDONIUM-ARCHIVE:'.length + String(Number.MAX_SAFE_INTEGER).length + '-->'.length
const bodyClass = 'rudonium-archived-card-body'
const statusClass = 'rudonium-archived-card-status'

interface Span { from: number; to: number }
interface ReadingSpan { first: number; last: number; bodyFirst: number; bodyLast: number; status: number; label: string }

function rangesForDisplay(text: string): ReturnType<typeof archivedCardRanges> {
    if (!legacyOpener.test(text)) return []
    try { return archivedCardRanges(text).filter(range => range.style === 'legacy') }
    catch { return [] } // Пока пользователь правит границы, показываем исходное оформление.
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

function registerReadingView(plugin: MyPlugin): void {
    if (typeof plugin.registerMarkdownPostProcessor !== 'function') return
    const cache = new Map<string, { text: string; spans: ReadingSpan[] }>()
    const styles = new Map<Document, () => void>()
    const styleFor = (doc: Document) => {
        if (styles.has(doc)) return
        const style = doc.createElement('style')
        style.textContent = `.${bodyClass} { text-decoration-line: line-through; text-decoration-color: var(--text-muted); }
            .${bodyClass} .${statusClass} { display: inline-block; text-decoration-line: none; }`
        doc.head.appendChild(style)
        const remove = () => {
            doc.defaultView?.removeEventListener('pagehide', remove)
            style.remove()
            styles.delete(doc)
        }
        styles.set(doc, remove)
        doc.defaultView?.addEventListener('pagehide', remove, { once: true })
    }
    plugin.registerMarkdownPostProcessor((element: HTMLElement, context: MarkdownPostProcessorContext) => {
        if (element.classList.contains(bodyClass)) {
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
        // Obsidian может отдавать границы всего списка даже при запросе отдельного пункта.
        // У смешанного фрагмента оставляем обычный Markdown и видимый текстовый статус.
        if (!r || !Number.isInteger(first) || !Number.isInteger(last) || first > last ||
            first < r.first || last > r.last || first > r.bodyLast || last < r.bodyFirst ||
            element.closest('.callout, .internal-embed') || element.querySelector('.internal-embed')) return
        if (r.label && first <= r.status && last >= r.status) {
            const bold = Array.from(element.querySelectorAll('strong'))
            const status = bold[bold.length - 1]
            if (!status || status.textContent?.trim() !== r.label) return
            status.classList.add(statusClass)
        }
        styleFor(element.ownerDocument)
        element.classList.add(bodyClass)
    })
    plugin.register(() => {
        for (const remove of styles.values()) remove()
        cache.clear()
    })
}

function containsLegacyOpener(doc: Text, from = 0, to = doc.length): boolean {
    // Итератор не создаёт копию всей заметки для обычного файла без архива.
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
        const live = (require('obsidian') as { editorLivePreviewField?: StateField<boolean> }).editorLivePreviewField
        if (!live) return
        const cm = require('@codemirror/state') as typeof import('@codemirror/state')
        const { Decoration, ViewPlugin, EditorView: View } = require('@codemirror/view') as typeof import('@codemirror/view')
        const refresh = cm.StateEffect.define<void>()
        const mark = Decoration.mark({ class: bodyClass })
        class ArchiveView {
            decorations: DecorationSet = Decoration.none
            private spans: Span[] = []
            private marked = false
            private timer?: ReturnType<typeof setTimeout>
            constructor(view: EditorView) { if (view.state.field(live!, false)) this.read(view) }
            private read(view: EditorView): void {
                this.marked = containsLegacyOpener(view.state.doc)
                this.spans = this.marked ? rangesForDisplay(view.state.doc.toString()).map(r => ({ from: r.bodyStart, to: r.bodyEnd })) : []
                this.paint(view)
            }
            private paint(view: EditorView): void {
                this.decorations = Decoration.set(visibleArchiveSpans(this.spans, view.visibleRanges).map(s => mark.range(s.from, s.to)))
            }
            update(update: ViewUpdate): void {
                if (!update.state.field(live!, false)) {
                    this.destroy()
                    this.spans = []
                    this.marked = false
                    this.decorations = Decoration.none
                    return
                }
                if (!update.startState.field(live!, false) || update.transactions.some(tr => tr.effects.some(effect => effect.is(refresh)))) {
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
                    this.timer = setTimeout(() => update.view.dispatch({ effects: refresh.of(undefined) }), 180)
                } else if (update.viewportChanged) this.paint(update.view)
            }
            destroy(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
        }
        plugin.registerEditorExtension([ViewPlugin.fromClass(ArchiveView, { decorations: view => view.decorations }),
            View.baseTheme({ ['.' + bodyClass]: { textDecorationLine: 'line-through', textDecorationColor: 'var(--text-muted)' } })])
    } catch (error) {
        console.warn('[Rudonium Anki Toolkit] Archive formatting is unavailable in the editor.', error)
    }
}
