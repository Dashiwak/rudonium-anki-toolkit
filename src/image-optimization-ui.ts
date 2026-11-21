/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Setting } from 'obsidian'
import type { ToggleComponent } from 'obsidian'
import type MyPlugin from '../main'
import { savePluginDataInOrder, withFastScanReadLock } from './fast-scan'
import { imageOptimizationLimits, readImageOptimization } from './image-optimizer'
import type { ImageOptimizationSettings } from './image-optimizer'
import { openLocalImageOptimization } from './local-image-optimization'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'

type ToggleKey = 'enabled' | 'checkChanges' | 'saveCopy' | 'replaceOriginal' | 'keepOriginal'
type LimitKey = 'maxWidth' | 'maxHeight' | 'targetKb'

const limitFields = (t: UiText): ReadonlyArray<{ key: LimitKey; name: string; description: string; min: number; max: number }> => [
    { key: 'maxWidth', name: t('Maximum width (px)', 'Максимальная ширина (пиксели)'), description: t('Images keep their proportions.', 'Пропорции изображений сохраняются.'),
        min: imageOptimizationLimits.minDimension, max: imageOptimizationLimits.maxDimension },
    { key: 'maxHeight', name: t('Maximum height (px)', 'Максимальная высота (пиксели)'), description: '',
        min: imageOptimizationLimits.minDimension, max: imageOptimizationLimits.maxDimension },
    { key: 'targetKb', name: t('JPEG target (KB)', 'Целевой размер JPEG (КБ)'), description: t('Enter 0 to use the pixel limits alone. Image quality takes priority over this target.', 'Введите 0, чтобы ограничить только ширину и высоту. Качество изображения важнее целевого размера файла.'),
        min: imageOptimizationLimits.minTargetKb, max: imageOptimizationLimits.maxTargetKb },
]

/** Принимает полные пути для разных настольных систем. Экспорт проверяет фактический каталог. */
function isAbsoluteFolder(value: string): boolean {
    if (!value || /[\u0000-\u001f]/.test(value)) return false
    return value.startsWith('/') || /^[A-Za-z]:[/\\]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
}

export function installImageOptimizationSettings(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const fields = limitFields(t)
    const section = container.createDiv({ cls: 'anki-image-optimization' })
    section.createEl('h3', { text: t('Image Optimization', 'Оптимизация изображений') })
    const toggles = new Map<ToggleKey, ToggleComponent>()
    const entries = new Map<LimitKey, HTMLInputElement>()
    let busy = false
    let openingPreview = false
    let choosingOriginalsFolder = false
    let feedback: { text: string; error: boolean } | undefined

    const addToggle = (key: ToggleKey, name: string, description: string): void => {
        const row = new Setting(section).setName(name).setDesc(description)
        row.settingEl.setAttribute('role', 'group')
        row.settingEl.setAttribute('aria-label', name)
        row.addToggle(toggle => {
            toggles.set(key, toggle)
            toggle.onChange(value => {
                if (key === 'keepOriginal') {
                    const stored = readImageOptimization(plugin.settings.IMAGE_OPTIMIZATION)
                    choosingOriginalsFolder = value && !isAbsoluteFolder(stored.originalsFolder)
                    if (choosingOriginalsFolder) {
                        feedback = undefined
                        render()
                        folderInput.focus()
                        return
                    }
                } else if ((key === 'enabled' || key === 'replaceOriginal') && !value) {
                    choosingOriginalsFolder = false
                }
                return save({ [key]: value })
            })
        })
    }
    addToggle('enabled', t('Optimize images for Anki', 'Оптимизировать изображения для Anki'), t('Resize and compress new JPEG and PNG attachments during export.', 'Уменьшать и сжимать новые вложения JPEG и PNG при экспорте.'))
    addToggle('checkChanges', t('Check for image changes', 'Проверять изменения изображений'), t('Update optimized attachments when their Obsidian image is edited.', 'Обновлять оптимизированные вложения после изменения исходного изображения в Obsidian.'))
    addToggle('saveCopy', t('Save optimized copy in Obsidian', 'Сохранять оптимизированную копию в Obsidian'), t('Keep copies in Anki Optimized Images. Original files stay in place.', 'Сохранять копии в папке Anki Optimized Images. Исходные файлы остаются на своих местах.'))
    addToggle('replaceOriginal', t('Replace original in Obsidian before export', 'Заменять оригинал в Obsidian перед экспортом'),
        t('Write the optimized image at the original path and send the same image to Anki. Links in your notes stay valid.', 'Сохранять уменьшенное изображение по исходному пути и отправлять его в Anki. Ссылки в заметках сохраняются.'))
    addToggle('keepOriginal', t('Keep originals in a folder', 'Хранить оригиналы в отдельной папке'),
        t('Save the original before replacing it. With this option off, the original is replaced without keeping a permanent copy.', 'Сохранять оригиналы перед заменой. При выключенной настройке постоянная копия оригинала не создаётся.'))

    let folderInput!: HTMLInputElement
    let saveFolderButton!: HTMLButtonElement
    const folderSetting = new Setting(section).setName(t('Originals folder', 'Папка для оригиналов'))
        .setDesc(t('Enter a full path to the folder where you want to keep originals.', 'Введите полный путь к папке для оригинальных изображений.'))
        .addText(control => {
            folderInput = control.inputEl
            folderInput.setAttribute('aria-label', t('Originals folder', 'Папка для оригиналов'))
            folderInput.setAttribute('placeholder', 'C:\\Image Originals or /home/me/Image Originals')
            folderInput.oninput = () => { feedback = undefined; render() }
            folderInput.onkeydown = event => {
                if (event.key !== 'Enter' || event.isComposing || saveFolderButton.disabled) return
                event.preventDefault()
                saveFolderButton.click()
            }
        })
        .addButton(button => {
            saveFolderButton = button.setButtonText(t('Save Folder', 'Сохранить папку')).buttonEl
            button.onClick(async () => {
                const directory = folderInput.value.trim()
                if (!isAbsoluteFolder(directory)) return
                await save({ keepOriginal: true, originalsFolder: directory })
            })
        })

    for (const field of fields) {
        const row = new Setting(section).setName(field.name)
        if (field.description) row.setDesc(field.description)
        row.addText(control => {
            const input = control.inputEl
            input.setAttribute('type', 'number')
            input.setAttribute('min', String(field.min))
            input.setAttribute('max', String(field.max))
            input.setAttribute('step', '1')
            input.setAttribute('inputmode', 'numeric')
            input.setAttribute('aria-label', field.name)
            input.oninput = () => { feedback = undefined; render() }
            input.onkeydown = event => {
                if (event.key !== 'Enter' || event.isComposing || saveButton.disabled) return
                event.preventDefault()
                saveButton.click()
            }
            entries.set(field.key, input)
        })
    }

    let saveButton!: HTMLButtonElement
    let previewButton!: HTMLButtonElement
    new Setting(section).setName(t('Image limits', 'Ограничения размеров')).setDesc(t('Use these limits for Anki and for the Obsidian preview.', 'Применять эти ограничения при экспорте в Anki и в предпросмотре Obsidian.'))
        .addButton(button => {
            saveButton = button.setButtonText(t('Save Limits', 'Сохранить ограничения')).buttonEl
            button.onClick(() => {
                const { limits, valid } = readLimits()
                if (valid) return save(limits)
            })
        })
    const status = section.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } })
    new Setting(section).setName(t('Originals in Obsidian', 'Исходные изображения в Obsidian'))
        .setDesc(t('Preview the savings and select which originals to replace. Available with automatic optimization off.', 'Оцените экономию места и выберите оригиналы для замены. Этим можно воспользоваться и при выключенной автоматической оптимизации.'))
        .addButton(button => {
            previewButton = button.setButtonText(t('Optimize Images in Obsidian', 'Оптимизировать изображения в Obsidian')).buttonEl
            button.onClick(async () => {
                if (openingPreview) return
                openingPreview = true
                feedback = undefined
                render()
                try {
                    await openLocalImageOptimization(plugin)
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    feedback = { text: message, error: true }
                } finally {
                    openingPreview = false
                    render()
                }
            })
        })

    function readLimits(): { limits: Pick<ImageOptimizationSettings, LimitKey>; valid: boolean } {
        const stored = readImageOptimization(plugin.settings.IMAGE_OPTIMIZATION)
        const limits = { maxWidth: stored.maxWidth, maxHeight: stored.maxHeight, targetKb: stored.targetKb }
        let valid = true
        for (const field of fields) {
            const input = entries.get(field.key)!
            const value = Number(input.value)
            const allowed = input.value.trim() !== '' && Number.isInteger(value) && value >= field.min && value <= field.max
            if (allowed) {
                limits[field.key] = value
                input.removeAttribute('aria-invalid')
            } else {
                valid = false
                input.setAttribute('aria-invalid', 'true')
            }
        }
        return { limits, valid }
    }

    function render(resetInputs = false): void {
        const stored = readImageOptimization(plugin.settings.IMAGE_OPTIMIZATION)
        for (const [key, toggle] of toggles) {
            toggle.setValue(key === 'keepOriginal' ? stored.keepOriginal || choosingOriginalsFolder : stored[key])
            toggle.setDisabled?.(busy || (key !== 'enabled' && !stored.enabled) ||
                (key === 'keepOriginal' && !stored.replaceOriginal) || (key === 'saveCopy' && stored.replaceOriginal))
        }
        const showFolder = stored.enabled && stored.replaceOriginal && (stored.keepOriginal || choosingOriginalsFolder)
        folderSetting.settingEl.hidden = !showFolder
        if (resetInputs) folderInput.value = stored.originalsFolder
        folderInput.disabled = busy
        const directory = folderInput.value.trim()
        const invalidFolder = showFolder && !isAbsoluteFolder(directory)
        if (invalidFolder) folderInput.setAttribute('aria-invalid', 'true')
        else folderInput.removeAttribute('aria-invalid')
        const pendingFolder = showFolder && (directory !== stored.originalsFolder || choosingOriginalsFolder)
        saveFolderButton.disabled = busy || invalidFolder || !pendingFolder
        for (const [key, input] of entries) {
            if (resetInputs) input.value = String(stored[key])
            input.disabled = busy
        }
        const { limits, valid } = readLimits()
        const edited = fields.some(field => limits[field.key] !== stored[field.key])
        saveButton.disabled = busy || !valid || !edited
        previewButton.disabled = busy || openingPreview || !valid || edited
        const invalid = !valid && !busy
        status.style.color = invalid || invalidFolder || feedback?.error ? 'var(--text-error)' : ''
        status.setText(busy ? t('Saving…', 'Сохранение…') : invalid ? t('Enter whole numbers within the limits for each field.', 'Введите целые числа в пределах, указанных для каждого поля.')
            : feedback?.text ?? (invalidFolder ? t('Enter a full folder path to keep originals.', 'Введите полный путь к папке для оригиналов.')
                : pendingFolder ? t('Save the folder to apply this choice.', 'Сохраните папку, чтобы применить настройку.')
                    : edited ? t('Save the limits before opening the Obsidian preview.', 'Сохраните ограничения перед открытием предпросмотра.') : ''))
        status.hidden = !status.textContent
    }

    async function save(patch: Partial<ImageOptimizationSettings>): Promise<void> {
        if (busy) return
        busy = true
        feedback = undefined
        render()
        try {
            await withFastScanReadLock(plugin, () => savePluginDataInOrder(plugin, async () => {
                const settings = plugin.settings
                const latest = readImageOptimization(settings.IMAGE_OPTIMIZATION)
                const next = readImageOptimization({ ...latest, ...patch })
                if (JSON.stringify(next) === JSON.stringify(latest)) return
                await plugin.saveData({
                    settings: { ...settings, IMAGE_OPTIMIZATION: next },
                    'Added Media': plugin.added_media,
                    'File Hashes': plugin.file_hashes,
                    fields_dict: plugin.fields_dict,
                })
                settings.IMAGE_OPTIMIZATION = next
            }))
            if (patch.keepOriginal === true) choosingOriginalsFolder = false
            feedback = { text: t('Saved.', 'Сохранено.'), error: false }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            feedback = { text: t(`Could not save image settings. ${message}`, `Не удалось сохранить настройки изображений. ${message}`), error: true }
        } finally {
            busy = false
            render()
        }
    }

    render(true)
}
