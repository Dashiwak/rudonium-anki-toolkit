// SPDX-License-Identifier: GPL-3.0-only
import { Setting, setIcon } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, expectedAnkiProfile, profileProblemText, requireExpectedAnkiProfile } from './anki-profile'
import { uiFor } from './interface-language'
import { readSyncAuditDeckNames } from './sync-audit'

/** В списке сохраняем точные имена Anki, в том числе двойные двоеточия у подколод. */
export function installDefaultDeckSetting(parent: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const title = t('Default deck', 'Колода по умолчанию')
    const row = new Setting(parent).setName(title).setDesc(t('For notes without a deck assignment.',
        'Для записей без назначенной колоды.'))
    const status = row.descEl.createDiv({ attr: { role: 'status' } })
    const list = row.controlEl.createEl('select', { cls: 'dropdown', attr: { 'aria-label': title } })
    list.style.maxWidth = 'min(22rem, 45vw)'
    const refreshText = t('Refresh Anki decks', 'Обновить список колод Anki')
    const refresh = row.controlEl.createEl('button', { cls: 'clickable-icon', attr: {
        type: 'button', title: refreshText, 'aria-label': refreshText,
    } })
    setIcon(refresh, 'refresh-cw')

    let decks: string[] = []
    let profile: string | undefined
    const populate = () => {
        const current = plugin.settings.Defaults.Deck
        list.empty()
        if (!decks.includes(current)) {
            const retained = list.createEl('option', { value: current, text: current || t('Choose a deck', 'Выберите колоду') })
            retained.disabled = true
        }
        for (const deck of decks) list.createEl('option', { value: deck, text: deck })
        list.value = current
        list.title = current
    }
    const unavailable = (error: unknown) => {
        profile = undefined
        decks = []
        populate()
        list.disabled = true
        if (error instanceof AnkiProfileError && error.reason !== 'unreachable') {
            status.setText(error.reason === 'mismatch' && !expectedAnkiProfile(plugin)
                ? t('Anki profile changed. Refresh the deck list.', 'Профиль Anki сменился. Обновите список колод.')
                : profileProblemText(error, t))
        } else {
            status.setText(t('Decks unavailable. Open Anki, check AnkiConnect, then refresh.',
                'Колоды недоступны. Откройте Anki, проверьте AnkiConnect и обновите список.'))
        }
    }
    const load = async () => {
        refresh.disabled = true
        list.disabled = true
        status.setText(t('Loading decks from Anki…', 'Загрузка колод из Anki…'))
        try {
            const active = await requireExpectedAnkiProfile(plugin)
            if (!row.settingEl.isConnected) return
            const names = await readSyncAuditDeckNames(undefined, 5000)
            await requireExpectedAnkiProfile(plugin, active)
            if (!row.settingEl.isConnected) return
            profile = active
            decks = [...new Set(names)].sort((a, b) => a.localeCompare(b))
            populate()
            list.disabled = !decks.length
            const current = plugin.settings.Defaults.Deck
            status.setText(!decks.length ? t('This Anki profile has no decks.', 'В этом профиле Anki нет колод.')
                : current && !decks.includes(current) ? t('Saved deck missing from this profile. Choose a deck.',
                    'Сохранённой колоды нет в этом профиле. Выберите колоду.') : '')
        } catch (error) {
            if (row.settingEl.isConnected) unavailable(error)
        } finally {
            refresh.disabled = false
        }
    }
    list.onchange = async () => {
        const chosen = list.value
        const previous = plugin.settings.Defaults.Deck
        if (list.disabled || !profile || !decks.includes(chosen) || previous === chosen) return
        list.disabled = true
        refresh.disabled = true
        try {
            await requireExpectedAnkiProfile(plugin, profile)
            if (!row.settingEl.isConnected || plugin.settings.Defaults.Deck !== previous) return
            plugin.settings.Defaults.Deck = chosen
            try {
                await plugin.saveAllData()
                status.setText('')
            } catch {
                if (plugin.settings.Defaults.Deck === chosen) plugin.settings.Defaults.Deck = previous
                status.setText(t('Could not save the default deck. Select it again.',
                    'Не удалось сохранить колоду. Выберите её ещё раз.'))
            }
        } catch (error) {
            unavailable(error)
        } finally {
            list.value = plugin.settings.Defaults.Deck
            list.title = list.value
            list.disabled = !decks.length
            refresh.disabled = false
        }
    }
    populate()
    refresh.onclick = load
    void load()
}
