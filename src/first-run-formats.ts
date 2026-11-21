// SPDX-License-Identifier: GPL-3.0-only
import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import type MyPlugin from '../main'
import { activeCardMarkdown } from './archived-card'
import { presetStartGuard } from './card-export-diagnostics'
import { findMarkdownSyntaxSpans } from './markdown-pipeline'
import { OBS_DISPLAY_CODE_REGEXP, OBS_CODE_REGEXP, OBS_DISPLAY_MATH_REGEXP, OBS_INLINE_MATH_REGEXP } from './constants'

type FormatSettings = Pick<MyPlugin['settings'], 'Syntax' | 'CUSTOM_REGEXPS'>
type FormatEvidence = { syntax: string; path?: string; shown?: true }
// Эти публичные методы Obsidian 1.8.7 отсутствуют в более ранних типах исходной основы.
type FormatStorageApp = App & {
    loadLocalStorage?(key: string): unknown
    saveLocalStorage?(key: string, data: unknown): void
}
const storageKey = 'rudonium-anki-toolkit:format-check-v1'
function markers(settings: FormatSettings): string[] {
    const syntax = settings.Syntax
    return [syntax?.['Begin Note'] ?? 'START', syntax?.['End Note'] ?? 'END',
        syntax?.['Begin Inline Note'] ?? 'STARTI', syntax?.['End Inline Note'] ?? 'ENDI']
}
function hasRule(settings: FormatSettings): boolean {
    return Object.values(settings.CUSTOM_REGEXPS ?? {}).some(value => typeof value === 'string' && !!value.trim())
}
function readEvidence(app: FormatStorageApp): FormatEvidence | undefined {
    try {
        const stored: unknown = app.loadLocalStorage?.(storageKey)
        if (!stored || typeof stored !== 'object') return
        const { syntax, shown, path } = stored as Partial<FormatEvidence>
        if (typeof syntax !== 'string') return
        if (shown === true) return { syntax, shown }
        if (typeof path === 'string') return { syntax, path }
    } catch { /* A vault with unavailable local storage can still be scanned. */ }
    return undefined
}
function remember(app: FormatStorageApp, value: FormatEvidence | null): void {
    try { app.saveLocalStorage?.(storageKey, value) } catch { /* Local storage is optional. */ }
}
export function acknowledgeFormatSetup(app: App, settings: FormatSettings): void {
    if (!hasRule(settings)) remember(app, { syntax: JSON.stringify(markers(settings)), shown: true })
}

function escapeToken(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function markerProbe(settings: FormatSettings): (source: string) => boolean {
    const [start, end, inline, inlineEnd] = markers(settings)
    const block = !!start && !!end && start !== end
    const inlinePattern = inline && inlineEnd && inline !== inlineEnd ?
        new RegExp([inline, inlineEnd].sort((a, b) => b.length - a.length).map(escapeToken).join('|'), 'g') : undefined
    return source => {
        if (!(block && source.includes(start) && source.includes(end)) &&
            !(inlinePattern && source.includes(inline) && source.includes(inlineEnd))) return false
        const text = activeCardMarkdown(source)
        const { code, math } = findMarkdownSyntaxSpans(text, OBS_DISPLAY_CODE_REGEXP, OBS_CODE_REGEXP, OBS_DISPLAY_MATH_REGEXP, OBS_INLINE_MATH_REGEXP)
        const blocked = presetStartGuard(text, code.concat(math))
        let opened = false, pos = 0
        for (const row of text.split('\n')) {
            const token = row.trim()
            if (block && (token === start || token === end) && !blocked(pos + row.indexOf(token))) {
                if (token === end && opened) return true
                opened = token === start
            }
            if (inlinePattern && row.includes(inline) && row.includes(inlineEnd)) {
                let inlineOpen = false
                for (const match of row.matchAll(inlinePattern)) {
                    const at = match.index ?? 0
                    if (blocked(pos + at)) continue
                    const word = match[0]
                    const next = row[at + word.length] ?? ''
                    if (word === inline && (!at || /[ \t]/.test(row[at - 1])) && /[ \t[|]/.test(next)) inlineOpen = true
                    if (word === inlineEnd && inlineOpen && (!next || !/\w/.test(next))) return true
                }
            }
            pos += row.length + 1
        }
        return false
    }
}

/** Сохраняем только путь первого найденного блока или факт показа мастера, без кэша заметок. */
export async function needsFormatSetup(app: App, settings: FormatSettings, stopped: () => boolean): Promise<boolean> {
    if (stopped()) return false
    const prior = readEvidence(app)
    if (hasRule(settings)) {
        if (prior) remember(app, null)
        return false
    }
    const syntax = JSON.stringify(markers(settings))
    if (stopped() || (prior?.syntax === syntax && prior.shown === true)) return false
    const probe = markerProbe(settings)
    const witness = prior?.syntax === syntax && typeof prior.path === 'string' ? app.vault.getAbstractFileByPath(prior.path) : null
    const priorFile = witness instanceof TFile ? witness : null
    // Проверяем сам текст даже для ранее найденной заметки: синхронизатор диска может сохранить mtime.
    let incomplete = false
    const check = async (file: TFile) => {
        try { return probe(await app.vault.read(file)) }
        catch { incomplete = true; return false }
    }
    if (priorFile && await check(priorFile)) return false
    const current = () => !stopped() && !hasRule(settings) && JSON.stringify(markers(settings)) === syntax
    const files = app.vault.getMarkdownFiles()
    for (let offset = 0; offset < files.length && current(); offset += 4) {
        const batch = files.slice(offset, offset + 4).filter(f => f !== priorFile)
        const matches = await Promise.all(batch.map(check))
        const hit = batch[matches.indexOf(true)]
        if (hit) {
            if (current()) remember(app, { syntax, path: hit.path })
            return false
        }
        if (offset % 128 === 124) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    return current() && !incomplete
}
