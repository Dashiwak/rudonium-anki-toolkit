// SPDX-License-Identifier: GPL-3.0-only
import { MarkdownView } from 'obsidian'
import type MyPlugin from '../main'
import type { CardPreviewCandidate } from './file'
import { ankiIdNumberTokens } from './anki-id-marker'
import { editorPreviewMetadata } from './card-preview-metadata'
import { previewFieldText } from './card-preview-ui'
import { pageCardExpression } from './card-format-presets'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { withRule } from './note-type-rules'
import type { NoteTypeRule, RuleSettings } from './note-type-rules'
import { parsePortableMarkdown } from './portable-parser'
import { settingToData } from './setting-to-data'
import { scanProfileFreeSettings } from './sync-profiles'

type Candidate = Pick<CardPreviewCandidate, 'start' | 'end' | 'identifier' | 'note'>
type Range = Pick<Candidate, 'start' | 'end'>
type Change = { kind: 'added' | 'lost' | 'changed' | 'overlap' | 'moved' | 'duplicate'; card: Candidate; other?: string }
type Report = { path: string; text: string; cards: Candidate[]; changes: Change[]; warnings: string[] }

function sameFields(a: Candidate, b: Candidate): boolean {
    const left = a.note.fields, right = b.note.fields
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key])
}

export function compareRuleMatches(before: Candidate[], after: Candidate[], others: Iterable<[string, Range[]]>): Change[] {
    const changes: Change[] = []
    const indexed = (cards: Candidate[]) => {
        const byStart = new Map<number, Candidate>(), byId = new Map<number, Candidate | null>()
        for (const card of cards) {
            byStart.set(card.start, card)
            if (card.identifier !== undefined) byId.set(card.identifier, byId.has(card.identifier) ? null : card)
        }
        return { byStart, byId }
    }
    const old = indexed(before), current = indexed(after)
    for (const card of before) {
        const id = card.identifier
        if (id !== undefined && !current.byId.has(id)) changes.push({ kind: 'lost', card })
    }
    for (const card of after) {
        const id = card.identifier
        if (id !== undefined && (current.byId.get(id) === null || old.byId.get(id) === null)) {
            changes.push({ kind: 'duplicate', card })
            continue
        }
        const previous = id === undefined ? old.byStart.get(card.start) : old.byId.get(id)
        if (!previous || previous.identifier !== id) changes.push({ kind: 'added', card })
        else {
            if (previous.start !== card.start) changes.push({ kind: 'moved', card })
            if (!sameFields(previous, card)) changes.push({ kind: 'changed', card })
        }
    }
    // Matches from each individual parse have exclusive ranges. Walk both sorted lists once per model.
    const focused = [...after].sort((a, b) => a.start - b.start)
    for (const [other, cards] of others) {
        const sorted = cards.sort((a, b) => a.start - b.start)
        let index = 0
        for (const card of focused) {
            while (index < sorted.length && sorted[index].end <= card.start) index++
            if (index < sorted.length && sorted[index].start < card.end) changes.push({ kind: 'overlap', card, other })
        }
    }
    return changes.sort((a, b) => a.card.start - b.card.start)
}

/** Each rule sees the same current editor snapshot, formatter and ID reader as export.
 * Independent parses reveal overlapping models that ordinary ordered export can mask. */
export async function previewRuleOnNote(plugin: MyPlugin, rule: NoteTypeRule, signal: AbortSignal,
    shouldStop?: () => boolean, ruleSettings: RuleSettings = plugin.settings, fields = plugin.fields_dict): Promise<Report> {
    const { app } = plugin
    const settings = { ...plugin.settings, ...ruleSettings }
    const t = uiFor(settings)
    const file = app.workspace.getActiveFile()
    if (!file || file.extension.toLowerCase() !== 'md') throw new Error(t('Open a Markdown note first.', 'Сначала откройте заметку Markdown.'))
    const active = app.workspace.getActiveViewOfType(MarkdownView)
    const view = active?.file?.path === file.path ? active : undefined
    const text = view?.editor?.getValue() ?? await app.vault.cachedRead(file)
    const ids = ankiIdNumberTokens(text)
    const metadata = editorPreviewMetadata(text, app.metadataCache.getCache(file.path))
    const next = { ...settings, ...withRule(settings, rule) }
    const previousData = await settingToData(app, scanProfileFreeSettings(settings), fields, [])
    const read = async (data: typeof previousData, model: string) => {
        if (signal.aborted || shouldStop?.()) throw new Error(t('Check cancelled.', 'Проверка отменена.'))
        // A marked whole page owns all its text, including examples matching an inline rule.
        const custom_regexps = Object.fromEntries(Object.entries(data.custom_regexps).filter(([key, value]) => key === model || value === pageCardExpression))
        const parsed = await parsePortableMarkdown(app, { ...data, custom_regexps }, file, text, ids, {
            preview: true, syntax: settings.Syntax, metadata, regexpOptions: { signal, shouldStop },
        })
        return (parsed.previewCandidates ?? []).filter(card => card.note.modelName === model)
    }
    const prior = settings.CUSTOM_REGEXPS?.[rule.model] ?? ''
    const same = prior === rule.expression && (settings.FILE_LINK_FIELDS?.[rule.model] ?? '') === rule.file &&
        (settings.CONTEXT_FIELDS?.[rule.model] ?? '') === rule.context
    const nextData = same ? previousData : await settingToData(app, scanProfileFreeSettings(next), fields, [])
    const after = await read(nextData, rule.model)
    const warnings: string[] = []
    const comparison = async (data: typeof previousData, model: string, warning: string) => {
        try { return await read(data, model) }
        catch (error) {
            if (signal.aborted || shouldStop?.()) throw error
            warnings.push(warning)
            return undefined
        }
    }
    const before = same ? after : await comparison(previousData, rule.model,
        t('Could not check the saved rule. Changes to existing IDs could not be compared.',
            'Не удалось проверить сохранённое правило. Изменения привязок ID не сопоставлены.'))
    const others = new Map<string, Range[]>()
    if (after.length) {
        for (const [model, expression] of Object.entries(next.CUSTOM_REGEXPS)) {
            if (model !== rule.model && expression && Object.prototype.hasOwnProperty.call(fields, model)) {
                const peers = await comparison(nextData, model, t(`Could not check overlaps with “${model}”.`,
                    `Не удалось проверить пересечения с типом «${model}».`))
                if (peers) others.set(model, peers.map(({ start, end }) => ({ start, end })))
            }
        }
    }
    // When the baseline cannot be parsed, only duplicates in the draft and verified overlaps are known.
    return { path: file.path, text, cards: after, changes: compareRuleMatches(before ?? after, after, others), warnings }
}

export function showRuleReport(container: HTMLElement, report: Report, t: UiText): void {
    container.empty()
    const { path, text, changes, cards } = report
    const total = cards.length
    container.createEl('p', { text: t(`${path} · Matches: ${total}`, `${path} · Совпадений: ${total}`) })
    for (const warning of report.warnings) container.createEl('p', { text: warning })
    if (!changes.length && !report.warnings.length) container.createEl('p', { text: t('No changes or overlaps.', 'Изменений и пересечений нет.') })
    const starts = [0]
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
    const lineAt = (offset: number) => {
        let lo = 0, hi = starts.length
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid + 1; else hi = mid }
        return lo
    }
    const labels: Record<Change['kind'], string> = {
        added: t('New match', 'Новое совпадение'), lost: t('ID loses its block', 'ID теряет связь с блоком'),
        changed: t('Fields change', 'Изменятся поля'), moved: t('Same ID, different block start', 'Прежний ID, другое начало блока'),
        duplicate: t('Repeated ID', 'Повторяющийся ID'), overlap: t('Matches multiple types', 'Подходит нескольким типам'),
    }
    if (changes.length) {
        const counts = new Map<Change['kind'], number>()
        for (const { kind } of changes) counts.set(kind, (counts.get(kind) ?? 0) + 1)
        container.createEl('p', { text: Array.from(counts, ([kind, n]) => labels[kind] + ': ' + n).join(' · ') })
    }
    const length = changes.length || cards.length
    if (!length) return
    const body = changes.length || length === 1 ? container : container.createEl('details')
    if (body !== container) body.createEl('summary', { text: t('Matching blocks', 'Совпавшие блоки') })
    let count = 0
    const list = body.createDiv()
    const more = body.createEl('button', { text: t('Show more', 'Показать ещё') })
    const nextPage = () => {
        const limit = Math.min(count + 20, length)
        for (; count < limit; count++) {
            const change = changes[count], card = change?.card ?? cards[count]
            const label = !change ? t('Match', 'Совпадение') : change.other ?
                t(`Also matches ${change.other}`, `Подходит и типу «${change.other}»`) : labels[change.kind]
            const item = list.createEl('details')
            item.createEl('summary', { text: t(`Line ${lineAt(card.start)}`, `Строка ${lineAt(card.start)}`) +
                ' · ' + label + (card.identifier === undefined ? '' : ' · ID ' + card.identifier) })
            let rendered = false
            item.addEventListener('toggle', () => {
                if (!item.open || rendered) return
                rendered = true
                for (const [field, html] of Object.entries(card.note.fields)) if (html) {
                    item.createEl('p', { text: field + ' · ' + previewFieldText(container.ownerDocument, html, t('[Image]', '[Изображение]')) })
                }
            })
        }
        more.hidden = count >= length
    }
    more.onclick = nextPage
    nextPage()
}
