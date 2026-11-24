// SPDX-License-Identifier: GPL-3.0-only
import type { App } from 'obsidian'

export const rudoniumPluginId = 'rudonium-anki-toolkit'
export const supportUrl = 'https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue'
export const previousRudoniumId = 'rupos-anki-toolkit'
export const upstreamPluginId = 'obsidian-to-anki-plugin'

export function hasActiveLegacyPlugin(app: App): boolean {
    const registry = (app as App & { plugins?: {
        enabledPlugins?: ReadonlySet<string>
        plugins?: Record<string, unknown>
    } }).plugins
    if (!registry) return false
    return !!(registry.enabledPlugins?.has(previousRudoniumId) || registry.enabledPlugins?.has(upstreamPluginId) ||
        registry.plugins?.[previousRudoniumId] || registry.plugins?.[upstreamPluginId])
}
