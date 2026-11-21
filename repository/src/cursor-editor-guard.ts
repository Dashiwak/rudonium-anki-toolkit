// SPDX-License-Identifier: GPL-3.0-only
import { MarkdownView } from 'obsidian'
import type MyPlugin from '../main'
import { sameEditorText } from './markdown-pipeline'
import { findIdMarkers } from './duplicate-markers'
import type { CursorCardTarget } from './cursor-card'
import { uiFor } from './interface-language'

/** Учитываем ещё не сохранённую копию того же ID даже во вкладке вне области экспорта. */
export function checkCursorEditors(plugin: MyPlugin, target: CursorCardTarget): void {
    const t = uiFor(plugin.settings)
    for (const { view } of plugin.app.workspace.getLeavesOfType('markdown')) {
        if (!(view instanceof MarkdownView) || !view.file || view.getMode() !== 'source') continue
        const content = view.getViewData()
        if (sameEditorText(content, view.data)) continue
        if (view.file.path === target.path) throw new Error(t(
            'Save the open edits in this note and preview the card again.',
            'Сохраните правки в этой заметке и повторите предпросмотр карточки.'))
        if (target.id !== undefined && findIdMarkers(content, plugin.settings.Syntax).some(marker => marker.id === target.id)) {
            throw new Error(t('Save the open edits that reference this Anki ID and preview the card again.',
                'Сохраните открытые правки, связанные с этим ID Anki, и повторите предпросмотр карточки.'))
        }
    }
}
