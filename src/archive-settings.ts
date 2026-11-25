/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type { TFile } from 'obsidian'
import type MyPlugin from '../main'
import { savePluginDataInOrder, withFastScanReadLock } from './scan-state'
import { uiFor } from './interface-language'
import { isSupportedZipImportPath } from './zip-import-archive'

export interface ArchiveTransferSettings {
    includeFolders: string[]
    excludeFolders: string[]
    includeAttachments: boolean
    changedOnly: boolean
    outputDirectory: string
    useForBackups: boolean
}

export interface ArchivePreviewOptions { folder?: string; useSavedScope?: boolean; settings?: ArchiveTransferSettings }
export interface ArchiveFilePreview {
    files: TFile[]
    totalFiles: number
    markdownFiles: number
    attachments: number
    totalBytes: number
    excludedFiles: number
    excludedBytes: number
    missingFolders: string[]
    scope: string
}

type SettingsWithArchive = MyPlugin['settings'] & { ARCHIVE_TRANSFER?: ArchiveTransferSettings }
const maxFolders = 2048

function visiblePath(path: string): boolean {
    return path === '' || path.split('/').every(part => Boolean(part) && !part.startsWith('.') && part !== '__MACOSX' &&
        !/[\\:<>|"*?\p{Cc}]/u.test(part) && !/[ .]$/u.test(part) &&
        !/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(part))
}

function folderList(raw: unknown): string[] {
    if (raw === undefined) return []
    if (!Array.isArray(raw) || raw.length > maxFolders || raw.some(value => typeof value !== 'string')) {
        throw new Error('The saved archive folder list is invalid. / Сохранённый список папок архива повреждён.')
    }
    const paths = (raw as string[]).map(value => value.trim().replace(/\/+$/u, '').normalize('NFC'))
    if (paths.some(path => !visiblePath(path))) {
        throw new Error('An archive folder path is invalid. / В списке архива есть недопустимый путь папки.')
    }
    return [...new Set(paths)].sort()
}

export function readArchiveSettings(raw: unknown): ArchiveTransferSettings {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<ArchiveTransferSettings> : {}
    const includeFolders = folderList(value.includeFolders)
    return {
        includeFolders: includeFolders.includes('') ? [] : includeFolders,
        excludeFolders: folderList(value.excludeFolders),
        includeAttachments: value.includeAttachments !== false,
        changedOnly: value.changedOnly === true,
        outputDirectory: typeof value.outputDirectory === 'string' ? value.outputDirectory.trim() : '',
        useForBackups: value.useForBackups === true,
    }
}

function under(path: string, folder: string): boolean {
    return !folder || path === folder || path.startsWith(`${folder}/`)
}

export function archiveFolderIncluded(path: string, settings: Pick<ArchiveTransferSettings, 'includeFolders' | 'excludeFolders'>): boolean {
    const normalized = path.normalize('NFC')
    return visiblePath(normalized) && !settings.excludeFolders.some(folder => under(normalized, folder)) &&
        (!settings.includeFolders.length || settings.includeFolders.some(folder => under(normalized, folder)))
}

export function archivePathIncluded(path: string, settings: ArchiveTransferSettings): boolean {
    return archiveFolderIncluded(path, settings) && isSupportedZipImportPath(path) &&
        (settings.includeAttachments || /\.md$/iu.test(path))
}

export function archiveScopeSignature(settings: ArchiveTransferSettings): string {
    const normalized = readArchiveSettings(settings)
    return JSON.stringify([normalized.includeFolders, normalized.excludeFolders, normalized.includeAttachments])
}

export async function previewArchiveFiles(plugin: MyPlugin, options: ArchivePreviewOptions = {}): Promise<ArchiveFilePreview> {
    const settings = readArchiveSettings(options.settings ?? (options.useSavedScope ? (plugin.settings as SettingsWithArchive).ARCHIVE_TRANSFER : undefined))
    const folder = options.folder?.trim().replace(/\/+$/u, '') ?? ''
    if (!visiblePath(folder)) throw new Error(uiFor(plugin.settings)('Choose a visible vault-relative folder.', 'Выберите обычную папку относительно хранилища.'))
    const allFiles = plugin.app.vault.getFiles()
    const candidates = allFiles.filter(file => !folder || file.path.startsWith(`${folder}/`))
    const files: TFile[] = []
    let totalBytes = 0, excludedFiles = 0, excludedBytes = 0, markdownFiles = 0
    for (const file of candidates) {
        if (archivePathIncluded(file.path, settings)) {
            files.push(file)
            totalBytes += file.stat.size
            if (/\.md$/iu.test(file.path)) markdownFiles++
        } else {
            excludedFiles++
            excludedBytes += file.stat.size
        }
    }
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
    const named = [...settings.includeFolders, ...settings.excludeFolders, ...(folder ? [folder] : [])]
    const knownFolders = new Set<string>()
    for (const file of allFiles) {
        for (let slash = file.path.indexOf('/'); slash >= 0; slash = file.path.indexOf('/', slash + 1)) {
            knownFolders.add(file.path.slice(0, slash).normalize('NFC'))
        }
    }
    const missingFolders = [...new Set(named)].filter(path => {
        if (!path) return false
        const candidate = plugin.app.vault.getAbstractFileByPath(path)
        return (!candidate || !('children' in candidate)) && !knownFolders.has(path.normalize('NFC'))
    })
    return { files, totalFiles: files.length, markdownFiles, attachments: files.length - markdownFiles, totalBytes,
        excludedFiles, excludedBytes, missingFolders, scope: JSON.stringify([folder, archiveScopeSignature(settings)]) }
}

export function saveArchiveSettings(plugin: MyPlugin, raw: ArchiveTransferSettings, expected?: ArchiveTransferSettings): Promise<void> {
    const next = readArchiveSettings(raw)
    return withFastScanReadLock(plugin, () => savePluginDataInOrder(plugin, async () => {
        const settings = plugin.settings as SettingsWithArchive
        if (expected && JSON.stringify(readArchiveSettings(settings.ARCHIVE_TRANSFER)) !== JSON.stringify(readArchiveSettings(expected))) {
            throw new Error(uiFor(plugin.settings)('Archive settings changed. Reopen this window.', 'Параметры архива изменились. Откройте окно заново.'))
        }
        const saved = await plugin.loadData() as unknown
        const previous = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {}
        await plugin.saveData({ ...previous, settings: { ...settings, ARCHIVE_TRANSFER: next },
            'Added Media': plugin.added_media, 'File Hashes': plugin.file_hashes, fields_dict: plugin.fields_dict })
        settings.ARCHIVE_TRANSFER = next
    }))
}
