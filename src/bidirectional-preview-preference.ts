// SPDX-License-Identifier: GPL-3.0-only
import { Notice, Setting } from 'obsidian'
import type { ToggleComponent } from 'obsidian'
import type MyPlugin from '../main'
import { withFastScanReadLock } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'

type Surface = 'settings' | 'preview'
interface PreferenceControls {
    busy: boolean
    settings?: ToggleComponent
    preview?: ToggleComponent
}
const controls = new WeakMap<MyPlugin, PreferenceControls>()

export function addPreviewPreference(container: HTMLElement, plugin: MyPlugin, surface: Surface): () => void {
    const t = uiFor(plugin.settings)
    const state: PreferenceControls = controls.get(plugin) ?? { busy: false }
    controls.set(plugin, state)
    const render = () => {
        for (const toggle of [state.settings, state.preview]) {
            toggle?.setValue(plugin.settings.BIDIRECTIONAL_PREVIEW === true).setDisabled(state.busy)
        }
    }
    let mounted: ToggleComponent | undefined
    new Setting(container).setName(t('Preview every sync', 'Предпросмотр при каждом запуске'))
        .setDesc(t('When off, changes sync in the background. Open the preview manually to review skipped fields or confirm deletions.',
            'Если выключено, изменения применяются в фоне. Чтобы посмотреть пропущенные поля или подтвердить удаления, откройте предпросмотр вручную.'))
        .addToggle(toggle => {
            mounted = state[surface] = toggle
            render()
            toggle.onChange(async value => {
                if (state.busy || value === (plugin.settings.BIDIRECTIONAL_PREVIEW === true)) return
                state.busy = true
                for (const item of [state.settings, state.preview]) item?.setDisabled(true)
                try {
                    await withFastScanReadLock(plugin, async () => {
                        const previous = plugin.settings.BIDIRECTIONAL_PREVIEW
                        plugin.settings.BIDIRECTIONAL_PREVIEW = value
                        try { await plugin.saveAllData() } catch (error) {
                            if (previous === undefined) delete plugin.settings.BIDIRECTIONAL_PREVIEW
                            else plugin.settings.BIDIRECTIONAL_PREVIEW = previous
                            throw error
                        }
                    })
                } catch (error) {
                    new Notice(uiDiagnostic(error, t))
                } finally {
                    state.busy = false
                    render()
                }
            })
        })
    return () => { if (state[surface] === mounted) delete state[surface] }
}
