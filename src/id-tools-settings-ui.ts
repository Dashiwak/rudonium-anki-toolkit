/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Notice, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { savePluginDataInOrder, withFastScanReadLock } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import { pageIdLocation, pageIdLocationLabel, pageIdLocations } from './page-id-location'
import { createSettingsGroup, rememberGroup } from './settings-layout'

export interface IdMarkerSettingsActions {
    toComment(): void
    toPlain(): void
    moveVaultPages(): void
    foldingChanged?(): void
}

export function installIdMarkerSettings(container: HTMLElement, plugin: MyPlugin, actions: IdMarkerSettingsActions): void {
    const t = uiFor(plugin.settings)
    const body = createSettingsGroup(container, plugin, 'id-markers', t('Anki ID Markers', 'Маркеры ID Anki'),
        t('Choose how saved IDs appear in the editor. Conversion opens a preview and saves a backup before changes.',
            'Выберите вид сохранённых ID в редакторе. Преобразование открывает предпросмотр и сохраняет резервную копию перед изменениями.'))
    const settings = plugin.settings
    const save = (patch: Partial<Pick<MyPlugin['settings'], 'PAGE_ID_LOCATION' | 'COLLAPSE_ANKI_IDS'>>) =>
        withFastScanReadLock(plugin, () => savePluginDataInOrder(plugin, async () => {
            const current = plugin.settings
            const saved: unknown = await plugin.loadData()
            const previous = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {}
            await plugin.saveData({ ...previous, settings: { ...current, ...patch },
                'Added Media': plugin.added_media, 'File Hashes': plugin.file_hashes, fields_dict: plugin.fields_dict })
            Object.assign(current, patch)
        }))
    const pageLocation = () => pageIdLocation(plugin.settings.PAGE_ID_LOCATION)
    const location = new Setting(body).setName(t('ID location for card pages', 'Расположение ID страницы-карточки'))
        .setDesc(t('Used when a page is first linked or imported. To move an existing ID, run “Move this page ID”.',
            'Для первой привязки и импорта страницы. Чтобы переместить уже записанный ID, выполните команду «Перенести ID этой страницы».'))
    const example = body.createEl('details')
    example.createEl('summary', { text: t('Page ID example', 'Пример расположения ID') })
    const sample = example.createEl('pre')
    const refreshExample = () => {
        const question = t('Question', 'Вопрос'), answer = t('Answer', 'Ответ')
        const heading = '# ' + question + ' #anki-page'
        const id = 'ID: 123'
        const placement = pageLocation()
        if (placement === 'yaml') sample.setText("---\nanki-page-ID: '123'\n---\n" + heading + '\n\n' + answer)
        else if (placement === 'after-answer') sample.setText(heading + '\n\n' + answer + '\n<!--ID: 123 @page-->')
        else sample.setText(heading + '\n' + (plugin.settings.Defaults?.['ID Comments'] !== false ? '<!--' + id + '-->' : id) + '\n\n' + answer)
    }
    example.ontoggle = () => { if (example.open) refreshExample() }
    refreshExample()
    rememberGroup(example, plugin, 'id-markers-example')
    let moving = false
    location.addDropdown(control => {
        for (const choice of pageIdLocations) control.addOption(choice, pageIdLocationLabel(choice, t))
        control.setValue(pageLocation()).onChange(async value => {
            if (moving || value === pageLocation()) return
            if (value !== 'heading' && value !== 'yaml' && value !== 'after-answer') { control.setValue(pageLocation()); return }
            moving = true
            control.setDisabled(true)
            try { await save({ PAGE_ID_LOCATION: value }) }
            catch (error) { new Notice(uiDiagnostic(error, t)) }
            finally {
                moving = false
                control.setValue(pageLocation()).setDisabled(false)
                refreshExample()
            }
        })
    })
    new Setting(body).setName(t('Existing card pages', 'Уже связанные страницы'))
        .setDesc(t('Preview ID moves across the vault. A complete vault ZIP is verified before changes.',
            'Проверьте перенос ID во всём хранилище. Перед изменениями создаётся и проверяется полный ZIP хранилища.'))
        .addButton(button => button.setButtonText(t('Move page IDs…', 'Перенести ID страниц…')).onClick(() => actions.moveVaultPages()))
    let busy = false
    new Setting(body).setName(t('Collapse Anki IDs in Live Preview', 'Сворачивать ID Anki в Live Preview'))
        .setDesc(t('Display a compact Anki badge. A cursor or selection reveals the saved ID. Source mode always shows the original text.',
            'Показывать компактную метку Anki. Курсор или выделение раскрывают сохранённый ID. Режим исходного текста всегда показывает оригинал.'))
        .addToggle(toggle => toggle.setValue(settings.COLLAPSE_ANKI_IDS === true).onChange(async value => {
            if (busy) return
            busy = true
            toggle.setDisabled(true)
            try {
                await save({ COLLAPSE_ANKI_IDS: value })
                actions.foldingChanged?.()
            } catch (error) { new Notice(uiDiagnostic(error, t)) }
            finally {
                busy = false
                toggle.setValue(plugin.settings.COLLAPSE_ANKI_IDS === true).setDisabled(false)
            }
        }))
    new Setting(body).setName(t('Convert ID Markers', 'Преобразовать маркеры ID'))
        .setDesc(t('Wrap IDs in HTML comments or remove only their comment wrappers. Ordinary HTML comments are preserved.',
            'Обернуть ID в HTML-комментарии или убрать только их оболочку. Обычные HTML-комментарии сохраняются.'))
        .addButton(button => button.setButtonText(t('Convert IDs to Comments', 'Перевести ID в комментарии')).onClick(() => actions.toComment()))
        .addButton(button => button.setButtonText(t('Remove ID Comment Wrappers', 'Убрать HTML-оболочку ID')).onClick(() => actions.toPlain()))
}
