/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Modal, Notice, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, expectedAnkiProfile, isAnkiProfileLockEnabled, profileProblemText, readActiveAnkiProfile,
    requireExpectedAnkiProfile, savedAnkiProfile } from './anki-profile'
import { savePluginDataInOrder, withFastScanReadLock } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

type ProblemStage = 'before-write' | 'in-progress'
const problemDialogs = new WeakMap<MyPlugin, Modal>()
const settingsDialogs = new WeakMap<MyPlugin, Modal>()
const refreshSettingsProfile = new WeakMap<MyPlugin, (profile: string) => void>()

type ProfileSettingsChange = Partial<Pick<MyPlugin['settings'], 'REQUIRE_ANKI_PROFILE' | 'EXPECTED_ANKI_PROFILE'>>

async function writeProfileSettings(plugin: MyPlugin, change: ProfileSettingsChange): Promise<void> {
    await plugin.saveData({
        settings: { ...plugin.settings, ...change },
        'Added Media': plugin.added_media,
        'File Hashes': plugin.file_hashes,
        fields_dict: plugin.fields_dict,
    })
    Object.assign(plugin.settings, change)
}

function errorText(error: unknown, t: UiText): string {
    if (error instanceof AnkiProfileError) return profileProblemText(error, t)
    return uiDiagnostic(error, t)
}

function addStatus(container: HTMLElement): HTMLElement {
    const status = container.createDiv({ attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } })
    status.classList.add('rudonium-wrap-anywhere')
    return status
}

function showStatus(status: HTMLElement, message: string, error = false): void {
    status.classList.toggle('rudonium-text-error', Boolean(error))
    status.setText(message)
}

function profileNames(t: UiText, expected?: string, active?: string): string {
    return t(`Expected · ${expected ?? 'None selected'}\nActive in Anki · ${active ?? 'Unconfirmed'}`,
        `Профиль хранилища · ${expected ?? 'Не выбран'}\nОткрыт в Anki · ${active ?? 'Не подтверждён'}`)
}

function profileModeText(plugin: MyPlugin, t: UiText): string {
    const saved = savedAnkiProfile(plugin)
    if (isAnkiProfileLockEnabled(plugin)) {
        return t(`Expected · ${saved ?? 'None selected'}`, `Профиль хранилища · ${saved ?? 'Не выбран'}`)
    }
    const automatic = t('Automatic · uses the profile open in Anki', 'Автоматически · используется открытый профиль Anki')
    return saved ? `${automatic}\n${t(`Saved selection · ${saved}`, `Сохранённый выбор · ${saved}`)}` : automatic
}

function automaticProfileText(plugin: MyPlugin, t: UiText, active: string): string {
    return `${profileModeText(plugin, t)}\n${t(`Active in Anki · ${active}`, `Открыт в Anki · ${active}`)}`
}

function addProfileField(list: HTMLDListElement, label: string): HTMLElement {
    const field = list.createDiv()
    field.classList.add('rudonium-anki-profile-field')
    field.createEl('dt', { text: label }).classList.add('rudonium-text-muted')
    const value = field.createEl('dd')
    value.classList.add('rudonium-anki-profile-value')
    return value
}

export function openAnkiProfileSettings(plugin: MyPlugin): void {
    if (settingsDialogs.has(plugin)) return
    problemDialogs.get(plugin)?.close()
    const modal = new AnkiProfileSettingsModal(plugin)
    settingsDialogs.set(plugin, modal)
    modal.open()
}

class AnkiProfileSettingsModal extends Modal {
    private readonly abort = new AbortController()

    constructor(private readonly plugin: MyPlugin) {
        super(plugin.app)
    }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Anki Profile Settings', 'Настройки профиля Anki'))
        this.modalEl.classList.add('rudonium-modal-38rem')
        installModalLayout(this, t)
        this.contentEl.createEl('p', { text: t('Open the profile for this vault in Anki. Its name appears here once AnkiConnect verifies it.',
            'Откройте в Anki профиль для этого хранилища. Его имя появится здесь после проверки через AnkiConnect.') })
        const profileList = this.contentEl.createEl('dl')
        profileList.classList.add('rudonium-anki-profile-profile-list')
        const savedName = addProfileField(profileList, t('Saved for This Vault', 'Привязан к хранилищу'))
        const activeName = addProfileField(profileList, t('Active in Anki', 'Открыт в Anki'))
        const status = addStatus(this.contentEl)
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        const recheck = footer.createEl('button', { text: t('Check Again', 'Проверить ещё раз') })
        const confirm = footer.createEl('button', { cls: 'mod-cta' })

        const signal = this.abort.signal
        let locked = isAnkiProfileLockEnabled(this.plugin)
        let expected = savedAnkiProfile(this.plugin)
        let active: string | undefined
        let busy = false
        const selectionStillCurrent = () => locked === isAnkiProfileLockEnabled(this.plugin) &&
            expected === savedAnkiProfile(this.plugin)
        const render = () => {
            const saved = savedAnkiProfile(this.plugin)
            savedName.setText(saved ?? t('None selected', 'Не выбран'))
            activeName.setText(active ?? t('Unconfirmed', 'Не подтверждён'))
            confirm.setText(saved ? t('Confirm Profile Change', 'Подтвердить смену профиля')
                : t('Confirm Profile', 'Подтвердить профиль'))
            recheck.disabled = busy
            confirm.disabled = busy || !locked || !active || active === saved || !selectionStillCurrent()
        }
        const check = async () => {
            if (busy || signal.aborted) return
            busy = true
            active = undefined
            locked = isAnkiProfileLockEnabled(this.plugin)
            expected = savedAnkiProfile(this.plugin)
            render()
            showStatus(status, t('Checking the active profile in Anki…', 'Проверяем открытый профиль Anki…'))
            try {
                const live = await readActiveAnkiProfile(signal)
                if (signal.aborted) return
                if (!selectionStillCurrent()) throw new AnkiProfileError('changed', expected)
                active = live
                if (!locked) showStatus(status, t('Automatic mode uses the profile open in Anki. Turn on Expected Anki Profile in the plugin settings to choose a fixed profile.',
                    'В автоматическом режиме используется открытый профиль Anki. Чтобы закрепить профиль, включите переключатель в настройках плагина.'))
                else if (live === expected) showStatus(status, t('Profile verified. This vault is linked to the open profile.',
                    'Профиль проверен. Хранилище связано с открытым профилем.'))
                else if (expected) showStatus(status,
                    t('A different profile is open. To keep the saved profile, switch to it in Anki and check again. Confirm a change only if this vault should export to the open profile.',
                        'В Anki открыт другой профиль. Чтобы сохранить привязку, переключите профиль в Anki и повторите проверку. Подтвердите смену, если хотите экспортировать в открытый профиль.'))
                else showStatus(status, t('Confirm the active profile to enable export from this vault.',
                    'Подтвердите открытый профиль, чтобы включить экспорт из этого хранилища.'))
            } catch (error) {
                if (!signal.aborted) showStatus(status, errorText(error, t), true)
            } finally {
                busy = false
                if (!signal.aborted) render()
            }
        }
        confirm.onclick = async () => {
            const selected = active
            if (confirm.disabled || !selected || signal.aborted) return
            busy = true
            render()
            showStatus(status, t('Confirming and saving the profile…', 'Проверяем и сохраняем профиль…'))
            try {
                let saved = false
                await withFastScanReadLock(this.plugin, () => savePluginDataInOrder(this.plugin, async () => {
                    if (signal.aborted) return
                    if (!selectionStillCurrent()) throw new AnkiProfileError('changed', expected)
                    const live = await readActiveAnkiProfile(signal)
                    if (signal.aborted) return
                    if (!selectionStillCurrent()) throw new AnkiProfileError('changed', expected)
                    if (live !== selected) {
                        throw new Error(t(`Anki opened “${live}” after your check. Check again and confirm the intended profile.`,
                            `После проверки в Anki открыт профиль «${live}». Повторите проверку и подтвердите нужный профиль.`))
                    }
                    await writeProfileSettings(this.plugin, { EXPECTED_ANKI_PROFILE: selected })
                    saved = true
                }))
                if (saved) {
                    refreshSettingsProfile.get(this.plugin)?.(selected)
                    new Notice(t(`Anki profile “${selected}” saved. Run the operation again when ready.`,
                        `Профиль Anki «${selected}» сохранён. Запустите операцию ещё раз.`))
                    if (!signal.aborted) this.close()
                }
            } catch (error) {
                active = undefined
                if (!signal.aborted) showStatus(status, errorText(error, t), true)
            } finally {
                busy = false
                if (!signal.aborted) render()
            }
        }
        recheck.onclick = () => { void check() }
        void check()
    }

    onClose(): void {
        this.abort.abort()
        settingsDialogs.delete(this.plugin)
        this.contentEl.empty()
    }
}

export function installAnkiProfileSettings(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const setting = new Setting(container).setName(t('Expected Anki Profile', 'Профиль Anki для экспорта'))
        .setDesc(t('By default, export uses the profile open in Anki. Turn on this switch to use only a specific profile for this vault.',
            'По умолчанию экспорт использует открытый профиль Anki. Включите переключатель, чтобы закрепить профиль за этим хранилищем.'))
    const status = addStatus(setting.descEl)
    status.classList.add('rudonium-pre-line')
    let changing = false
    let updateBindingButton = () => {}
    const showMode = () => showStatus(status, profileModeText(plugin, t))
    setting.addToggle(toggle => {
        toggle.toggleEl?.setAttribute('aria-label', t('Require a specific Anki profile', 'Закрепить конкретный профиль Anki'))
        toggle.setValue(isAnkiProfileLockEnabled(plugin)).onChange(async enabled => {
            if (changing || enabled === isAnkiProfileLockEnabled(plugin)) return
            changing = true
            toggle.setDisabled?.(true)
            updateBindingButton()
            try {
                await withFastScanReadLock(plugin, () => savePluginDataInOrder(plugin,
                    () => writeProfileSettings(plugin, { REQUIRE_ANKI_PROFILE: enabled })))
                if (enabled && !savedAnkiProfile(plugin)) {
                    showStatus(status, `${profileModeText(plugin, t)}\n${t('Use Current Profile to choose a profile.',
                        'Нажмите «Привязать открытый профиль», чтобы выбрать профиль.')}`)
                } else showMode()
            } catch (error) {
                showStatus(status, `${profileModeText(plugin, t)}\n${errorText(error, t)}`, true)
            } finally {
                changing = false
                toggle.setValue(isAnkiProfileLockEnabled(plugin))
                toggle.setDisabled?.(false)
                updateBindingButton()
            }
        })
    })
    setting.addButton(button => {
        updateBindingButton = () => {
            button.setButtonText(savedAnkiProfile(plugin)
                ? t('Change Anki Profile', 'Сменить профиль Anki') : t('Use Current Profile', 'Привязать открытый профиль'))
            button.setDisabled(changing || !isAnkiProfileLockEnabled(plugin))
        }
        updateBindingButton()
        refreshSettingsProfile.set(plugin, profile => {
            updateBindingButton()
            showStatus(status, `${profileNames(t, profile, profile)}\n${t('Profile saved.', 'Профиль сохранён.')}`)
        })
        button.onClick(() => openAnkiProfileSettings(plugin))
    })
    showMode()
    setting.addButton(button => button.setButtonText(t('Check Profile', 'Проверить профиль')).onClick(async () => {
        const locked = isAnkiProfileLockEnabled(plugin)
        const expected = expectedAnkiProfile(plugin)
        button.setDisabled(true)
        showStatus(status, t('Checking the active profile in Anki…', 'Проверяем открытый профиль Anki…'))
        try {
            const active = expected ? await requireExpectedAnkiProfile(plugin, expected) : await readActiveAnkiProfile()
            const updated = expectedAnkiProfile(plugin)
            if (locked !== isAnkiProfileLockEnabled(plugin) || updated !== expected) {
                showMode()
                return
            }
            if (!locked) {
                showStatus(status, automaticProfileText(plugin, t, active))
                return
            }
            const hint = !updated ? t('Use Current Profile to confirm this profile.', 'Нажмите «Привязать открытый профиль», чтобы подтвердить выбор.')
                : updated === active ? t('Profile verified.', 'Профиль проверен.')
                : t('Open the expected profile in Anki and check again.', 'Откройте в Anki привязанный профиль и повторите проверку.')
            showStatus(status, `${profileNames(t, updated, active)}\n${hint}`, Boolean(updated && updated !== active))
        } catch (error) {
            if (locked !== isAnkiProfileLockEnabled(plugin) || expected !== expectedAnkiProfile(plugin)) {
                showMode()
                return
            }
            const active = error instanceof AnkiProfileError ? error.actual : undefined
            const names = locked ? profileNames(t, expected, active) : profileModeText(plugin, t)
            showStatus(status, `${names}\n${errorText(error, t)}`, true)
        } finally {
            button.setDisabled(false)
        }
    }))
}

export function showAnkiProfileProblem(plugin: MyPlugin, error: AnkiProfileError, stage?: ProblemStage, details?: string): void {
    if (problemDialogs.has(plugin) || settingsDialogs.has(plugin)) return
    const t = uiFor(plugin.settings)
    class ProfileProblemModal extends Modal {
        private closed = false

        onOpen(): void {
            const title = error.reason === 'unconfigured' ? t('Set Up Anki Profile', 'Настройте профиль Anki')
                : stage === 'before-write' ? t('Export Stopped Before Writing', 'Экспорт остановлен до записи')
                : t('Anki Profile Check Stopped the Operation', 'Операция остановлена при проверке профиля Anki')
            this.titleEl.setText(title)
            installModalLayout(this, t)
            const names = this.contentEl.createEl('p')
            names.classList.add('rudonium-anki-profile-names')
            const status = addStatus(this.contentEl)
            const show = (problem: AnkiProfileError) => {
                names.setText(profileNames(t, problem.expected ?? expectedAnkiProfile(plugin), problem.actual))
                showStatus(status, profileProblemText(problem, t), problem.reason !== 'unconfigured')
            }
            show(error)
            if (details) this.contentEl.createEl('p', { text: details })
            const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
            footer.classList.add('rudonium-wrap-controls')
            const canCheck = !isAnkiProfileLockEnabled(plugin) || !!expectedAnkiProfile(plugin)
            const check = canCheck ? footer.createEl('button', { text: t('Check Again', 'Проверить ещё раз'), cls: 'mod-cta' }) : undefined
            const settings = footer.createEl('button', { text: t('Open Profile Settings', 'Открыть настройки профиля'),
                cls: canCheck ? undefined : 'mod-cta' })
            settings.onclick = () => openAnkiProfileSettings(plugin)
            if (check) check.onclick = async () => {
                if (check.disabled || this.closed) return
                check.disabled = true
                showStatus(status, t('Checking the active profile in Anki…', 'Проверяем открытый профиль Anki…'))
                try {
                    const profile = await requireExpectedAnkiProfile(plugin)
                    if (!this.closed) {
                        names.setText(isAnkiProfileLockEnabled(plugin) ? profileNames(t, profile, profile)
                            : automaticProfileText(plugin, t, profile))
                        showStatus(status, t('Profile verified. Close this window and run the operation again.',
                            'Профиль проверен. Закройте окно и запустите операцию ещё раз.'))
                    }
                } catch (cause) {
                    if (this.closed) return
                    if (cause instanceof AnkiProfileError) show(cause)
                    else showStatus(status, errorText(cause, t), true)
                } finally {
                    if (!this.closed) check.disabled = false
                }
            }
        }

        onClose(): void {
            this.closed = true
            problemDialogs.delete(plugin)
            this.contentEl.empty()
        }
    }
    const modal = new ProfileProblemModal(plugin.app)
    problemDialogs.set(plugin, modal)
    modal.open()
}
