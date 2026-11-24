/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type MyPlugin from '../main'
import { uiFor } from './interface-language'
import { rudoniumPluginId } from './plugin-identity'

export async function requireSettledZipImport(plugin: MyPlugin): Promise<void> {
    const t = uiFor(plugin.settings)
    const directory = plugin.manifest?.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest?.id ?? rudoniumPluginId}`
    if (directory.startsWith('/') || directory.split('/').some(part => !part || part === '..' || part === '.')) {
        throw new Error(t('Could not verify the ZIP import journal folder.', 'Не удалось проверить папку журнала импорта ZIP.'))
    }
    if (await plugin.app.vault.adapter.exists(`${directory}/zip-imports/pending.json`)) {
        throw new Error(t('Recover the unfinished ZIP import before exporting. Open Import ZIP in the plugin settings.',
            'Перед экспортом восстановите незавершённый импорт ZIP. Откройте «Импорт ZIP» в настройках плагина.'))
    }
}
