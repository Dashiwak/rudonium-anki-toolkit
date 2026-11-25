/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import * as Obsidian from 'obsidian'
import { Prec, StateEffect, type EditorState, type StateEffectType } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree, syntaxTreeAvailable, type EditorSyntaxNode } from '@codemirror/language'
import type MyPlugin from '../main'
import { collectIdMarkerSpans } from './id-marker-format'
import type { IdMarkerSpan } from './id-marker-format'
import { parseAnkiIdMarker } from './anki-id-marker'
import { uiFor } from './interface-language'

const badgeClass = 'rudonium-anki-id-badge'
const maximumLines = 300
const maximumCharacters = 262_144
const maximumLineLength = 16_384
const literalNode = /(?:code|frontmatter|math)/i
const htmlContextNode = /(?:html|comment)/i
const htmlAttributeNode = /(?:attribute|tagname)/i
const views = new WeakMap<MyPlugin, Set<EditorView>>()
const effects = new WeakMap<MyPlugin, StateEffectType<void>>()
const registered = new WeakSet<MyPlugin>()

export function refreshEditorIdFolding(plugin: MyPlugin): void {
    const effect = effects.get(plugin)
    if (!effect) return
    for (const editor of views.get(plugin) ?? []) {
        try { editor.dispatch({ effects: effect.of(undefined) }) } catch { /* Закрывающийся редактор уже не требует обновления. */ }
    }
}

function selectedLine(state: EditorState, from: number, to: number): boolean {
    return state.selection.ranges.some(range => range.from <= to && range.to >= from)
}

export function registerEditorIdFolding(plugin: MyPlugin): void {
    if (registered.has(plugin) || typeof plugin.registerEditorExtension !== 'function') return
    try {
        const livePreview = Obsidian.editorLivePreviewField
        if (!livePreview) return
        const refresh = StateEffect.define<void>()
        const editors = new Set<EditorView>()

        class IdWidget extends WidgetType {
            constructor(private readonly marker: IdMarkerSpan, private readonly position: number,
                private readonly title: string, private readonly warning: boolean) { super() }

            eq(other: IdWidget): boolean {
                return this.position === other.position && this.marker.text === other.marker.text && this.title === other.title
            }

            toDOM(editor: EditorView): HTMLElement {
                const button = editor.dom.ownerDocument.adoptNode(createEl('button'))
                button.type = 'button'
                button.className = badgeClass + (this.warning ? ` ${badgeClass}-warning` : '')
                button.textContent = this.warning ? 'Anki ⚠' : 'Anki'
                button.title = this.title
                button.setAttribute('aria-label', this.title)
                button.onmousedown = event => { if (event.button === 0) event.preventDefault() }
                button.onclick = event => {
                    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
                    event.preventDefault()
                    try {
                        editor.dispatch({ selection: { anchor: this.position }, scrollIntoView: true })
                        editor.focus()
                    } catch { /* Если редактор закрыт, сохранённый текст остаётся неизменным. */ }
                }
                return button
            }

            ignoreEvent(): boolean { return true }
        }

        class IdFoldingView {
            decorations: DecorationSet = Decoration.none
            private cache = new Map<string, readonly IdMarkerSpan[]>()
            private syntaxKey = ''
            private closed = false
            private reportedFailure = false
            private timerWindow?: Window
            private timer?: number

            constructor(private readonly editor: EditorView) {
                editors.add(editor)
                this.rebuild(editor)
            }

            update(update: ViewUpdate): void {
                if (update.docChanged || update.viewportChanged || update.selectionSet ||
                    update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refresh))) ||
                    syntaxTree(update.startState) !== syntaxTree(update.state)) this.rebuild(update.view)
            }

            refreshSoon(editor: EditorView): void {
                if (this.timer !== undefined) this.timerWindow?.clearTimeout(this.timer)
                this.timerWindow = editor.dom.ownerDocument.defaultView ?? window
                this.timer = this.timerWindow.setTimeout(() => {
                    if (!this.closed) {
                        try { editor.dispatch({ effects: refresh.of(undefined) }) } catch { /* Окно уже закрывается. */ }
                    }
                }, 0)
            }

            private rebuild(editor: EditorView): void {
                this.decorations = Decoration.none
                try { this.draw(editor) } catch (error) {
                    this.decorations = Decoration.none
                    this.cache.clear()
                    if (!this.reportedFailure) {
                        this.reportedFailure = true
                        console.warn('[Rudonium Anki Toolkit] Исходные ID показаны без сворачивания', error)
                    }
                }
            }

            private draw(editor: EditorView): void {
                if (plugin.settings.COLLAPSE_ANKI_IDS !== true || editor.composing ||
                    editor.state.field(livePreview, false) !== true) return
                const info = editor.state.field(Obsidian.editorInfoField, false)
                if (!info?.file) return
                const syntax = plugin.settings.Syntax
                const signature = JSON.stringify(syntax)
                if (signature !== this.syntaxKey) { this.cache.clear(); this.syntaxKey = signature }
                const tree = syntaxTree(editor.state)
                const ranges: Array<ReturnType<ReturnType<typeof Decoration.replace>['range']>> = []
                const visited = new Set<number>()
                let characters = 0
                let contextCharacters = 0
                const t = uiFor(plugin.settings)
                for (const visible of editor.visibleRanges) {
                    if (!syntaxTreeAvailable(editor.state, visible.to)) continue
                    const first = editor.state.doc.lineAt(visible.from).number
                    const last = editor.state.doc.lineAt(visible.to).number
                    for (let number = first; number <= last; number++) {
                        if (visited.has(number)) continue
                        if (visited.size >= maximumLines || characters >= maximumCharacters) break
                        visited.add(number)
                        const line = editor.state.doc.line(number)
                        characters += line.length
                        if (line.length > maximumLineLength || !line.text.includes('ID:') ||
                            selectedLine(editor.state, line.from, line.to)) continue
                        const key = line.text
                        let markers = this.cache.get(key)
                        if (!markers) {
                            markers = collectIdMarkerSpans(line.text, syntax)
                            if (this.cache.size >= maximumLines) this.cache.clear()
                            this.cache.set(key, markers)
                        }
                        for (const marker of markers) {
                            if (ranges.length >= maximumLines) break
                            const from = line.from + marker.from
                            const to = line.from + marker.to
                            if (to > line.to || from < line.from) continue
                            let node: EditorSyntaxNode | null = tree.resolveInner(from, 1)
                            let literal = false
                            while (node) {
                                if (literalNode.test(node.name) || htmlAttributeNode.test(node.name)) { literal = true; break }
                                if (htmlContextNode.test(node.name) && (node.from < from || node.to > to)) {
                                    const length = node.to - node.from
                                    if (!marker.comment || length > marker.text.length + 256 || length < marker.text.length ||
                                        contextCharacters + length > maximumCharacters) { literal = true; break }
                                    contextCharacters += length
                                    if (editor.state.doc.sliceString(node.from, node.to).trim() !== marker.text) { literal = true; break }
                                }
                                node = node.parent
                            }
                            if (literal) continue
                            const warning = parseAnkiIdMarker(marker.text)?.warning
                            const dateNotice = warning === 'missing-date' ? t(' The date is missing after the separator.',
                                ' После разделителя отсутствует дата.') : warning ? t(' The date is invalid.', ' Дата записана некорректно.') : ''
                            const title = t(`Stored Anki ID: ${marker.id}.${dateNotice} Click to show the source.`,
                                `Сохранён ID Anki: ${marker.id}.${dateNotice} Нажмите, чтобы показать исходную строку.`)
                            ranges.push(Decoration.replace({ widget: new IdWidget(marker, from, title, !!warning), inclusive: false }).range(from, to))
                        }
                    }
                    if (visited.size >= maximumLines || characters >= maximumCharacters) break
                }
                this.decorations = Decoration.set(ranges, true)
            }

            destroy(): void {
                this.closed = true
                if (this.timer !== undefined) this.timerWindow?.clearTimeout(this.timer)
                this.cache.clear()
                editors.delete(this.editor)
            }
        }

        const extension = ViewPlugin.fromClass(IdFoldingView, {
            decorations: value => value.decorations,
            eventHandlers: {
                compositionstart(_event, editor) { this.refreshSoon(editor); return false },
                compositionend(_event, editor) { this.refreshSoon(editor); return false },
            },
        })
        const theme = EditorView.baseTheme({ [`.${badgeClass}`]: {
            display: 'inline-block', padding: '0 0.4em', margin: '0 0.1em', border: '1px solid var(--background-modifier-border)',
            borderRadius: '0.4em', color: 'var(--text-muted)', backgroundColor: 'var(--background-secondary)',
            font: 'inherit', fontSize: '0.8em', lineHeight: '1.3', height: 'auto', boxShadow: 'none', cursor: 'pointer',
            verticalAlign: 'baseline',
        }, [`.${badgeClass}.${badgeClass}-warning`]: {
            color: 'var(--text-warning)', borderColor: 'var(--text-warning)',
        } })
        plugin.registerEditorExtension([Prec.highest(extension), theme])
        views.set(plugin, editors)
        effects.set(plugin, refresh)
        registered.add(plugin)
        plugin.register(() => { views.delete(plugin); effects.delete(plugin); registered.delete(plugin) })
    } catch (error) {
        console.warn('[Rudonium Anki Toolkit] Сворачивание ID недоступно', error)
    }
}
