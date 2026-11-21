// SPDX-License-Identifier: GPL-3.0-only
import type MyPlugin from '../main'
import type { UiText } from './interface-language'
import type { DuplicateMarkerSyntax } from './duplicate-markers'

export type MigrationSource = 'yanki' | 'flashcards' | 'obsidian-to-anki' | 'deck-to-anki' | 'spaced-repetition' | 'anki-forge' | 'anki-bridge' | 'anki-ast-sync' | 'anki-exporter' | 'rudonium'
export interface MigrationContext {
    syntax?: DuplicateMarkerSyntax
    source?: MigrationSource | 'auto'
    folder?: string
    yankiFolders?: readonly string[]
    yankiInstalled?: boolean
    vaultName?: string
    bridgeRegistryPresent?: boolean
    forgeRegistryPresent?: boolean
    t: UiText
}
export interface MigrationCandidate {
    source: MigrationSource
    status: 'candidate' | 'review'
    reason?: string
    front?: string
    back?: string
    /** Exact YAML prefix after removing only confirmed old integration keys. Keep BOM and line endings. */
    prefix?: string
    linkedRoute?: { model: string; deck: string }
    /** An existing Rudonium page may be relinked but must not be converted into a new note. */
    recoverOnly?: true
    /** Source metadata indicates an established link even if no numeric note ID is available. */
    needsLink?: boolean
    preservedTags?: string[]
    anchor?: string
    id?: number
    /** Known original Anki model/deck if specified by the source. */
    recoveryIdentity?: { tag: string } | { field: string; value: string }
    recoveryModel?: string
    model?: string
    deck?: string
    /** Source-specific keys must never be interpreted as Anki note IDs. */
    externalKey?: string
    /** Known source field names in front/back order, when documented. */
    fieldNames?: readonly [string, string]
}
export type MigrationAdapter = (path: string, text: string, context: MigrationContext) => MigrationCandidate | undefined

async function hasYankiManifest(plugin: MyPlugin): Promise<boolean> {
    const { vault } = plugin.app
    const path = vault.configDir + '/plugins/yanki/manifest.json'
    if (!await vault.adapter.exists(path)) return false
    const manifest = await vault.adapter.read(path)
    try { return JSON.parse(manifest)?.id === 'yanki' }
    catch (error) { if (error instanceof SyntaxError) return false; throw error }
}

export async function detectMigrationContext(plugin: MyPlugin) {
    const { vault } = plugin.app
    // Yanki does not document a portable watched-folder preference schema. Only
    // the user's explicit source/folder selection authorizes unmarked files.
    const [yankiInstalled, bridgeRegistryPresent, forgeRegistryPresent] = await Promise.all([
        hasYankiManifest(plugin),
        vault.adapter.exists('.obsidian-anki-bridge/data.json'),
        vault.adapter.exists(vault.configDir + '/plugins/anki-forge/data.json'),
    ])
    return { yankiInstalled, yankiFolders: [], vaultName: vault.getName(), bridgeRegistryPresent, forgeRegistryPresent }
}

/** Suggestions use Obsidian's existing metadata index. They do not expand automatic migration scope. */
export async function detectMigrationFolders(plugin: MyPlugin): Promise<string[]> {
    if (!await hasYankiManifest(plugin)) return []
    const folders = new Set<string>()
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const id = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.noteId
        if (!/^[1-9]\d*$/u.test(String(id)) || !Number.isSafeInteger(Number(id))) continue
        const end = file.path.lastIndexOf('/')
        if (end > 0) folders.add(file.path.slice(0, end))
    }
    return [...folders].sort((left, right) => left.localeCompare(right))
}
