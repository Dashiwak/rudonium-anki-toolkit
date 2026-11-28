// SPDX-License-Identifier: GPL-3.0-only
import type { App } from 'obsidian'

export const rudoniumPluginId = 'rudonium-anki-toolkit'
export const supportUrl = 'https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue'
export const previousRudoniumId = 'rupos-anki-toolkit'
export const upstreamPluginId = 'obsidian-to-anki-plugin'

export type LegacyPluginId = typeof upstreamPluginId | typeof previousRudoniumId

export function legacyPluginName(id: LegacyPluginId): string {
    return id === upstreamPluginId ? 'Obsidian to Anki' : 'Rudonium (rupos-anki-toolkit)'
}

export function activeLegacyPlugins(app: App): LegacyPluginId[] {
    const registry = (app as App & { plugins?: {
        enabledPlugins?: ReadonlySet<string>
        plugins?: Record<string, unknown>
    } }).plugins
    return ([upstreamPluginId, previousRudoniumId] as const).filter(id =>
        registry?.enabledPlugins?.has(id) || registry?.plugins?.[id])
}

export function hasActiveLegacyPlugin(app: App): boolean {
    return activeLegacyPlugins(app).length > 0
}
