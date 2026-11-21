/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Modal } from 'obsidian'
import type { App } from 'obsidian'
import { readSyncAuditDeckNames, syncAuditDeckKey } from './sync-audit'
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

/** Позволяет выбрать точную колоду для аудита из списка или подтвердить введённое имя. */
export class SyncAuditDeckPicker extends Modal {
    private readonly onChoose: (deck: string) => void
    private readonly obsidianDecks: readonly string[]
    private readonly onDismiss: (() => void) | undefined
    private readonly abort = new AbortController()

    constructor(app: App, onChoose: (deck: string) => void, obsidianDecks: readonly string[] = [],
        onDismiss?: () => void, private readonly t: UiText = englishUi) {
        super(app)
        this.onChoose = onChoose
        this.obsidianDecks = obsidianDecks
        this.onDismiss = onDismiss
    }

    onOpen(): void {
        const t = this.t
        this.titleEl.setText(t('Choose Anki Deck to Check', 'Выбор колоды Anki для проверки'))
        this.modalEl.classList.add('rudonium-modal-42rem')
        installModalLayout(this, t)

        const label = this.contentEl.createEl('label', { text: t('Search Decks', 'Поиск колод') })
        const search = label.createEl('input', { attr: {
            type: 'search', autocomplete: 'off', placeholder: t('Deck name', 'Название колоды'),
        } })
        search.value = ''
        search.classList.add('rudonium-sync-deck-picker-search')

        const count = this.contentEl.createEl('p', { attr: { role: 'status' } })
        const list = this.contentEl.createEl('select', { attr: { size: 12, 'aria-label': t('Decks', 'Колоды') } })
        list.classList.add('rudonium-sync-deck-picker-list')
        const selected = this.contentEl.createEl('p')
        selected.classList.add('rudonium-wrap-anywhere')
        const status = this.contentEl.createEl('p', { text: t('Loading deck names from Anki…', 'Загружаю список колод из Anki…'), attr: { role: 'status' } })
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        const typed = footer.createEl('button', { text: t('Check Typed Name', 'Проверить введённую колоду') })
        const check = footer.createEl('button', { text: t('Check Deck', 'Проверить колоду'), cls: 'mod-cta' })
        footer.createEl('button', { text: t('Cancel', 'Отмена') }).onclick = () => this.close()

        const byKey = new Map<string, string>()
        let choices: Array<[string, string]> = []
        let visible: string[] = []
        let chosen: string | undefined

        const selectDeck = (deck: string | undefined) => {
            chosen = deck
            if (deck !== undefined) list.value = deck
            else list.selectedIndex = -1
            check.disabled = deck === undefined
            typed.hidden = deck !== undefined || !search.value.trim()
            selected.setText(deck === undefined ? '' : t(`Selected — ${deck}`, `Выбрана колода «${deck}»`))
        }
        const filter = () => {
            const query = syncAuditDeckKey(search.value.trim())
            visible = choices.filter(([key]) => key.includes(query)).map(([, name]) => name)
            list.empty()
            for (const name of visible) list.createEl('option', { text: name, value: name, title: name })
            const current = chosen && byKey.get(syncAuditDeckKey(chosen))
            const exact = byKey.get(syncAuditDeckKey(search.value))
            selectDeck(current && visible.includes(current) ? current : exact)
            count.setText(t(`${visible.length} of ${choices.length} ${choices.length === 1 ? 'deck' : 'decks'}`,
                `Найдено колод — ${visible.length} из ${choices.length}`))
        }
        const addDecks = (decks: readonly string[]) => {
            for (const name of decks) if (name.trim()) byKey.set(syncAuditDeckKey(name), name)
            choices = Array.from(byKey).sort((a, b) => a[1].localeCompare(b[1]))
            filter()
        }
        const start = (deck: string | undefined) => {
            if (!deck?.trim() || this.abort.signal.aborted) return
            this.close()
            this.onChoose(deck)
        }

        search.oninput = () => {
            chosen = undefined
            filter()
        }
        search.onkeydown = event => {
            if (event.isComposing) return
            if (event.key === 'ArrowDown' && visible.length) {
                event.preventDefault()
                selectDeck(chosen ?? visible[0])
                list.focus()
            } else if (event.key === 'Enter' && chosen !== undefined) {
                event.preventDefault()
                start(chosen)
            }
        }
        list.onchange = () => selectDeck(visible.includes(list.value) ? list.value : undefined)
        list.onkeydown = event => {
            if (event.key === 'Enter' && !event.isComposing && visible.includes(list.value)) {
                event.preventDefault()
                start(list.value)
            }
        }
        check.onclick = () => start(chosen)
        typed.onclick = () => start(search.value)

        addDecks(this.obsidianDecks)
        search.focus()
        void readSyncAuditDeckNames(this.abort.signal).then(decks => {
            if (this.abort.signal.aborted) return
            addDecks(decks)
            status.setText('')
        }).catch(() => {
            if (this.abort.signal.aborted) return
            status.setText(t('Anki deck names are unavailable. Enter the full name and choose Check Typed Name.',
                'Список колод Anki недоступен. Введите полное название и нажмите «Проверить введённую колоду».'))
        })
    }

    onClose(): void {
        if (this.abort.signal.aborted) return
        this.abort.abort()
        this.contentEl.empty()
        this.onDismiss?.()
    }
}
