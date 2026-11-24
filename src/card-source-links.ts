/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { MarkdownView, Notice } from 'obsidian'
import type { App, Plugin, TFile } from 'obsidian'
import { findIdMarkers } from './duplicate-markers'
import type { DuplicateMarkerSyntax, IdMarker } from './duplicate-markers'
import { openAuditSource } from './sync-difference-ui'
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'

const action = 'anki-card'
const filesPerRead = 8
export { cardSourceFieldPatch, linkFieldsToCard } from './card-source-link-fields'

interface Snapshot {
    mtime: number
    ctime: number
    size: number
    markers: SourceMarker[]
}

type SourceMarker = IdMarker & { cardLine?: number; cardEndLine?: number }

function sourceMarkers(content: string, syntax: DuplicateMarkerSyntax): SourceMarker[] {
    const markers = findIdMarkers(content, syntax)
    if (!markers.length) return markers
    const lines = content.split(/\r\n?|\n/)
    const begin = syntax['Begin Note'] ?? 'START'
    const end = syntax['End Note'] ?? 'END'
    return markers.map(marker => {
        const row = marker.line - 1
        if (!/^[ \t]*(?:<!--[ \t]*)?$/.test(lines[row].slice(0, marker.column))) return marker
        if (begin && end && lines[row + 1]?.trim() === end) {
            for (let cursor = row - 1; cursor >= 0; cursor--) {
                const text = lines[cursor].trim()
                if (text === end) break
                if (text === begin) return { ...marker, cardLine: cursor + 1, cardEndLine: marker.line + 1 }
            }
        }
        const previous = lines[row - 1]
        if (previous && /^ {0,3}[-+*][ \t]+\S/.test(previous) && /[ \t]::[ \t]/.test(previous)) {
            return { ...marker, cardLine: marker.line - 1 }
        }
        return marker
    })
}

function sameStamp(file: TFile, snapshot: Pick<Snapshot, 'mtime' | 'ctime' | 'size'>): boolean {
    return file.stat.mtime === snapshot.mtime && file.stat.ctime === snapshot.ctime && file.stat.size === snapshot.size
}

function openEditorText(app: App, paths: ReadonlySet<string>, t: UiText): Map<string, string> {
    const text = new Map<string, string>()
    for (const { view } of app.workspace.getLeavesOfType('markdown')) {
        if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file || !paths.has(view.file.path)) continue
        const path = view.file.path
        const content = view.getViewData()
        if (text.has(path) && text.get(path) !== content) throw new Error(t(
            `${path} has inconsistent open editor contents. Save the note and try the link again.`,
            `Открытые редакторы показывают разные версии файла ${path}. Сохраните заметку и снова откройте ссылку.`))
        text.set(path, content)
    }
    return text
}

export function registerCardSourceLinks(plugin: Plugin, getSyntax: () => DuplicateMarkerSyntax = () => ({}),
    onDuplicate?: (id: number) => void, getText: () => UiText = () => englishUi): void {
    const app = plugin.app
    const cache = new Map<string, Snapshot>()
    let syntaxKey = ''
    let revision = 0
    let opening = false
    const invalidate = (path: string) => { revision++; cache.delete(path) }
    plugin.registerEvent(app.vault.on('modify', file => invalidate(file.path)))
    plugin.registerEvent(app.vault.on('delete', file => invalidate(file.path)))
    plugin.registerEvent(app.vault.on('rename', (file, oldPath) => { invalidate(file.path); invalidate(oldPath) }))
    plugin.registerEvent(app.vault.on('create', file => invalidate(file.path)))
    plugin.registerEvent(app.workspace.on('editor-change', (_editor, info) => { if (info.file) invalidate(info.file.path) }))

    const open = async (id: number, path: string) => {
        const t = getText()
        const changed = t('The vault changed while locating the card. Try the link again.',
            'Хранилище изменилось во время поиска карточки. Откройте ссылку ещё раз.')
        const currentRevision = revision
        const syntax = getSyntax()
        const key = JSON.stringify(syntax)
        if (key !== syntaxKey) { cache.clear(); syntaxKey = key }
        const files = app.vault.getMarkdownFiles()
        const paths = new Set(files.map(file => file.path))
        const openText = openEditorText(app, paths, t)
        const occurrences: Array<SourceMarker & { path: string }> = []
        const failures: string[] = []
        for (const savedPath of cache.keys()) if (!paths.has(savedPath)) cache.delete(savedPath)
        for (let start = 0; start < files.length; start += filesPerRead) {
            if (revision !== currentRevision) throw new Error(changed)
            const batch = files.slice(start, start + filesPerRead)
            await Promise.all(batch.map(async file => {
                const filename = file.path
                try {
                    const before = { ...file.stat }
                    const editorText = openText.get(filename)
                    const saved = cache.get(filename)
                    let markers: SourceMarker[]
                    if (editorText !== undefined) markers = sourceMarkers(editorText, syntax)
                    else if (saved && sameStamp(file, saved)) markers = saved.markers
                    else {
                        markers = sourceMarkers(await app.vault.read(file), syntax)
                        if (file.path !== filename || !sameStamp(file, before) || revision !== currentRevision) {
                            throw new Error('The source changed during reading.')
                        }
                        cache.set(filename, { ...before, markers })
                    }
                    for (const marker of markers) if (marker.id === id) occurrences.push({ ...marker, path: filename })
                } catch {
                    cache.delete(filename)
                    failures.push(filename)
                }
            }))
            if (occurrences.length > 1) break
        }
        if (revision !== currentRevision) throw new Error(changed)
        if (occurrences.length > 1) {
            if (onDuplicate) { onDuplicate(id); return }
            throw new Error(t(`Anki ID ${id} occurs more than once. Open Review Duplicate Anki IDs to choose its source.`,
                `ID Anki ${id} встречается несколько раз. Откройте проверку дубликатов, чтобы выбрать источник.`))
        }
        if (failures.length) throw new Error(t(`Could not confirm a unique source for Anki ID ${id}. The vault read failed for ${failures[0]}.`,
            `Не удалось подтвердить единственный источник ID Anki ${id}. Ошибка чтения ${failures[0]}.`))
        const source = occurrences[0]
        if (!source) throw new Error(t(`Anki ID ${id} was not found in the vault. Source recorded in the link — ${path}.`,
            `ID Anki ${id} не найден в хранилище. Путь к источнику из ссылки — ${path}.`))
        await openAuditSource(app, { path: source.path, id, line: source.cardLine ?? source.line,
            endLine: source.cardEndLine ?? source.line, markerLine: source.line }, undefined, t)
    }

    plugin.registerObsidianProtocolHandler(action, params => {
        const id = Number(params.nid)
        if (opening) return
        if (!/^\d+$/.test(params.nid ?? '') || !Number.isSafeInteger(id) || id <= 0 || !params.file ||
            (params.vault && params.vault !== app.vault.getName())) {
            new Notice(getText()('Invalid Anki source link for this vault.', 'Ссылка из Anki недействительна для этого хранилища.'))
            return
        }
        opening = true
        app.workspace.onLayoutReady(() => {
            void open(id, params.file).catch(error => {
                new Notice(error instanceof Error ? error.message : String(error))
            }).finally(() => { opening = false })
        })
    })
}
