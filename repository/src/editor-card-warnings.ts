/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { editorInfoField, parseLinktext } from 'obsidian'
import type { EditorState } from '@codemirror/state'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import type MyPlugin from '../main'
import { previewCurrentCard } from './card-preview'
import { inspectEditorCardLines } from './editor-warning-rules'
import type { EditorCardWarning, EditorWarningLine } from './editor-warning-rules'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'

interface SyntaxNode {
    name: string
    parent: SyntaxNode | null
}

interface MarkdownLanguage {
    syntaxTree: (state: EditorState) => { resolveInner(position: number, side?: number): SyntaxNode }
    syntaxTreeAvailable: (state: EditorState, until?: number) => boolean
}

const warningClass = 'rupos-anki-card-warning'
const delay = 160
const visibleLineLimit = 300
const literalNode = /(?:fencedcode|code[-_]?block|frontmatter|math[-_]?block|^inlinecode$)/i

function warningText(warning: EditorCardWarning, t: UiText): string {
    switch (warning.code) {
        case 'id': return t('The card ID must be a positive integer.', 'ID карточки должен быть положительным целым числом.')
        case 'duplicate': return t(`Anki ID ${warning.value} occurs more than once in the visible blocks.`,
            `ID Anki ${warning.value} встречается в нескольких видимых блоках.`)
        case 'model': return t(`Unknown Anki note type: ${warning.value}.`, `Неизвестный тип записи Anki «${warning.value}».`)
        case 'attachment': return t(`Unresolved attachment: ${warning.value}.`, `Вложение «${warning.value}» не найдено.`)
    }
}

function visibleLines(view: EditorView, language: MarkdownLanguage): EditorWarningLine[] {
    const { state, visibleRanges } = view
    const document = state.doc
    const tree = language.syntaxTree(state)
    const lines: EditorWarningLine[] = []
    let last = 0
    for (const range of visibleRanges) {
        if (!language.syntaxTreeAvailable(state, range.to)) continue
        const first = Math.max(last + 1, document.lineAt(range.from).number - 1)
        const end = Math.min(document.lines, document.lineAt(range.to).number + 1)
        for (let number = first; number <= end && lines.length < visibleLineLimit; number++) {
            const line = document.line(number)
            const column = line.text.search(/\S/u)
            let literal = column < 0 || /^ {0,3}(?:`{3,}|~{3,})/.test(line.text) || /^\s*\$\$/.test(line.text)
            if (!literal) {
                let node: SyntaxNode | null = tree.resolveInner(line.from + column, 1)
                while (node && !(literal = literalNode.test(node.name))) node = node.parent
            }
            lines.push({ number, from: line.from, text: line.text, literal })
            last = number
        }
        if (lines.length >= visibleLineLimit) break
    }
    return lines
}

/** Обновляет только видимые строки. Anki запрашивается исключительно после явного открытия предпросмотра. */
export function registerEditorCardWarnings(plugin: MyPlugin): void {
    if (typeof plugin.registerEditorExtension !== 'function') return
    try {
        // Используем экземпляры модулей того же редактора, в который добавляется расширение.
        const state = require('@codemirror/state') as typeof import('@codemirror/state')
        const view = require('@codemirror/view') as typeof import('@codemirror/view')
        // Модуль языка предоставляет Obsidian вместе с редактором. В сборку вторая копия не включается.
        const language: MarkdownLanguage = require('@codemirror/language')
        if (typeof language.syntaxTree !== 'function' || typeof language.syntaxTreeAvailable !== 'function') return
        const { Decoration, EditorView, ViewPlugin } = view
        const refresh = state.StateEffect.define<void>()
        const extension = ViewPlugin.fromClass(class {
            decorations: DecorationSet = Decoration.none
            private timer?: number

            constructor(editor: EditorView) { this.schedule(editor) }

            update(update: ViewUpdate): void {
                if (update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refresh)))) {
                    const { state } = update.view
                    const info = state.field(editorInfoField, false)
                    const file = info?.file
                    if (!file) return
                    const syntax = plugin.settings.Syntax
                    const t = uiFor(plugin.settings)
                    const warnings = inspectEditorCardLines(visibleLines(update.view, language), {
                        begin: syntax?.['Begin Note'] ?? 'START', end: syntax?.['End Note'] ?? 'END',
                        inlineBegin: syntax?.['Begin Inline Note'] ?? 'STARTI', inlineEnd: syntax?.['End Inline Note'] ?? 'ENDI',
                        models: new Set(Object.keys(plugin.fields_dict ?? {})),
                        resolves: link => {
                            let decoded: string
                            try { decoded = decodeURI(link) } catch { decoded = link }
                            const path = parseLinktext(decoded).path
                            return !path || Boolean(plugin.app.metadataCache.getFirstLinkpathDest(path, file.path))
                        },
                    })
                    this.decorations = Decoration.set(warnings.map(warning => Decoration.mark({
                        class: warningClass,
                        attributes: { title: warningText(warning, t), 'data-rupos-anki-warning': 'true' },
                    }).range(warning.from, warning.to)), true)
                } else if (update.docChanged || update.viewportChanged || language.syntaxTree(update.startState) !== language.syntaxTree(update.state)) {
                    if (update.docChanged) this.decorations = Decoration.none
                    this.schedule(update.view)
                }
            }

            private schedule(editor: EditorView): void {
                window.clearTimeout(this.timer)
                this.timer = window.setTimeout(() => editor.dispatch({ effects: refresh.of(undefined) }), delay)
            }

            destroy(): void { window.clearTimeout(this.timer) }
        }, {
            decorations: plugin => plugin.decorations,
            eventHandlers: {
                click(event, editor) {
                    const target = event.target instanceof Element ? event.target.closest(`.${warningClass}`) : null
                    if (!target || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                    const info = editor.state.field(editorInfoField, false)
                    if (!info?.editor || !info.file) return
                    const position = editor.posAtDOM(target)
                    void previewCurrentCard(plugin, info.editor, info.file, undefined, position)
                    return true
                },
            },
        })
        const theme = EditorView.baseTheme({ [`.${warningClass}`]: {
            textDecoration: 'underline wavy var(--text-error)', cursor: 'pointer',
        } })
        plugin.registerEditorExtension([extension, theme])
    } catch (error) {
        console.warn('[Rudonium Anki Toolkit] Диагностика редактора недоступна', error)
    }
}
