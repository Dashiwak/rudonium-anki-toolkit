/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Modal, Notice, Setting, TFolder } from 'obsidian'
import type MyPlugin from '../main'
import { readAnkiDeckKind } from './anki-study-state'
import { describeDeckRoute, resolveFolderDeck } from './deck-routes'
import { savePluginDataInOrder, withFastScanReadLock } from './fast-scan'
import { createFolderTree, vaultFolderEntries } from './folder-tree'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { auditRead, readSyncAuditDeckNames } from './sync-audit'

type Mode = 'inherit' | 'default' | 'deck'
type Rule = { mode: Mode; deck: string }
type Rules = { decks: Record<string, string>; defaults: Record<string, boolean> }

const pageSize = 80

function searchKey(value: string): string {
    return value.normalize('NFC').toLowerCase().trim()
}

function readRules(plugin: MyPlugin): Rules {
    return { decks: plugin.settings.FOLDER_DECKS ?? {}, defaults: plugin.settings.FOLDER_DEFAULT_DECKS ?? {} }
}

function ownValue<T>(values: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined
}

function readRule(path: string, rules: Rules): Rule {
    if (ownValue(rules.defaults, path) === true) return { mode: 'default', deck: '' }
    const deck = ownValue(rules.decks, path)
    return typeof deck === 'string' && deck.trim() ? { mode: 'deck', deck } : { mode: 'inherit', deck: '' }
}

function changeRule(rules: Rules, from: string | undefined, path: string, rule: Rule): Rules {
    const decks: Rules['decks'] = Object.assign(Object.create(null), rules.decks)
    const defaults: Rules['defaults'] = Object.assign(Object.create(null), rules.defaults)
    if (from !== undefined && from !== path) {
        delete decks[from]
        delete defaults[from]
    }
    delete decks[path]
    delete defaults[path]
    if (rule.mode === 'deck') decks[path] = rule.deck
    if (rule.mode === 'default') defaults[path] = true
    return { decks, defaults }
}

function assignedFolders(rules: Rules): string[] {
    return Array.from(new Set([...Object.keys(rules.decks), ...Object.keys(rules.defaults)]))
        .filter(path => readRule(path, rules).mode !== 'inherit')
        .sort((a, b) => a.localeCompare(b))
}

function destination(plugin: MyPlugin, path: string, rules: Rules, t: UiText): string {
    const resolved = resolveFolderDeck(path, plugin.settings.Defaults.Deck, rules.decks, rules.defaults)
    return `${resolved.deck || t('Set the default Deck in settings', 'Укажите колоду по умолчанию в настройках')} · ${describeDeckRoute(resolved, t)}`
}

function searchDecks(parent: HTMLElement, selected: string,
    onSelect: (value: string) => void, t: UiText) {
    const search = parent.createEl('label', { text: t('Search anki decks', 'Поиск колод Anki') })
        .createEl('input', { attr: { type: 'search', autocomplete: 'off' } })
    search.classList.add('rudonium-deck-routes-search')
    const count = parent.createEl('small', { attr: { role: 'status' } })
    const list = parent.createEl('select', { attr: { size: 7, 'aria-label': t('Anki decks', 'Колоды Anki') } })
    list.classList.add('rudonium-deck-routes-list')
    const more = parent.createEl('button', { text: t('Show More Anki decks', 'Показать ещё колоды') })
    let choices: Array<{ value: string; key: string }> = []
    let chosen = selected
    let limit = pageSize
    let rendered = 0
    let visible: Array<{ value: string; key: string }> = []
    const render = (append = false) => {
        const query = searchKey(search.value)
        visible = query ? choices.filter(item => item.key.includes(query)) : choices
        if (!append) {
            list.empty()
            rendered = 0
        }
        const end = Math.min(limit, visible.length)
        for (; rendered < end; rendered++) {
            const { value } = visible[rendered]
            list.createEl('option', { value, text: value, title: value })
        }
        list.value = chosen
        count.setText(choices.length ? t(`${end} of ${visible.length} anki decks`,
            visible.length ? `Показано ${end} из ${visible.length}` : 'Совпадений нет.') : '')
        list.hidden = !visible.length
        more.hidden = end === visible.length
    }
    const select = (value: string) => {
        chosen = value
        list.value = value
        onSelect(value)
    }
    search.oninput = () => { limit = pageSize; render(); list.scrollTop = 0 }
    search.onkeydown = event => {
        if (event.isComposing || !visible.length) return
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            select(list.value || visible[0].value)
            list.focus()
        } else if (event.key === 'Enter') {
            const exact = visible.filter(item => item.key === searchKey(search.value))
            if (exact.length === 1) { event.preventDefault(); select(exact[0].value) }
        }
    }
    list.onchange = () => select(list.value)
    more.onclick = () => { limit += pageSize; render(true) }
    return {
        setDisabled(disabled: boolean) {
            search.disabled = disabled
            list.disabled = disabled
            more.disabled = disabled
        },
        setChoices(values: readonly string[]) {
            choices = values.map(value => ({ value, key: searchKey(value) }))
            render()
        },
    }
}

class DeckRoutingModal extends Modal {
    private closed = false
    private saving = false
    private loading?: AbortController

    constructor(private readonly plugin: MyPlugin, private readonly onChange: () => void) {
        super(plugin.app)
    }

    onOpen(): void {
        this.modalEl.classList.add('rudonium-modal-48rem')
        installModalLayout(this, uiFor(this.plugin.settings))
        this.showRules()
    }

    onClose(): void {
        this.closed = true
        this.loading?.abort()
        this.contentEl.empty()
    }

    private showRules(): void {
        const t = uiFor(this.plugin.settings)
        this.loading?.abort()
        this.contentEl.empty()
        this.titleEl.setText(t('Deck Assignments', 'Назначение колод'))
        const current = readRules(this.plugin)
        const folders = assignedFolders(current)
        if (!folders.length) {
            this.contentEl.createEl('p', { text: t('Folders currently use the default Deck.', 'Для папок действует колода по умолчанию.') })
        } else {
            const entries = folders.map(path => ({ path, keywords: destination(this.plugin, path, current, t) }))
            createFolderTree(this.contentEl, {
                entries, t, initiallyVisible: folders,
                label: t('Assigned folders', 'Папки с назначенными колодами'),
                searchLabel: t('Search assigned folders or decks', 'Поиск по папкам и колодам'),
                renderAction: (row, label, { path, keywords }) => {
                    const exists = this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder
                    const details = label.createEl('small', { text: exists ? keywords :
                        t(`Folder missing · ${keywords}`, `Папка отсутствует · ${keywords}`) })
                    details.classList.add('rudonium-block')
                    details.classList.add(exists ? 'rudonium-text-muted' : 'rudonium-text-error')
                    const button = row.createEl('button', { text: t('Edit', 'Изменить'), attr: { type: 'button',
                        'aria-label': t(`Edit deck assignment for ${path}`, `Изменить назначение колоды для папки ${path}`) } })
                    button.onclick = () => this.edit(path)
                    return button
                },
            })
        }
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        footer.createEl('button', { text: t('Add Folder Rule', 'Добавить правило для папки'), cls: 'mod-cta' }).onclick = () => this.edit()
    }

    private edit(from?: string): void {
        const t = uiFor(this.plugin.settings)
        this.contentEl.empty()
        this.titleEl.setText(from === undefined ? t('Add Folder Deck Rule', 'Новое правило колоды для папки')
            : t('Edit Folder Deck Rule', 'Правило колоды для папки'))
        const original: Rule = from === undefined ? { mode: 'inherit', deck: '' } : readRule(from, readRules(this.plugin))
        let mode = original.mode
        let path = from ?? ''
        let deck = original.deck
        let deckNames: readonly string[] = []
        let loading = false
        let loaded = false
        const folderHeading = this.contentEl.createEl('h3', { text: t('Obsidian folder', 'Папка Obsidian') })
        folderHeading.classList.add('rudonium-deck-routes-folder-heading')
        const chosenText = (selected: boolean) => selected ? t('Selected', 'Выбрано') : t('Select', 'Выбрать')
        const renderButton = (button: HTMLButtonElement | undefined, selected: boolean) => {
            if (!button) return
            button.setText(chosenText(selected))
            button.setAttribute('aria-pressed', String(selected))
        }
        const selectFolder = (chosen: string) => {
            if (this.saving || path === chosen) return
            renderButton(folderPicker.action(path), false)
            path = chosen
            renderButton(folderPicker.action(path), true)
            render()
        }
        const folderPicker = createFolderTree(this.contentEl, {
            entries: vaultFolderEntries(this.plugin.app.vault), t, initiallyVisible: path ? [path] : [], onExactMatch: selectFolder,
            renderAction: (row, _label, entry) => {
                const button = row.createEl('button', { attr: { type: 'button',
                    'aria-label': t(`Select ${entry.path}`, `Выбрать папку ${entry.path}`) } })
                renderButton(button, path === entry.path)
                button.onclick = () => selectFolder(entry.path)
                return button
            },
        })
        const folderChoice = this.contentEl.createEl('p')
        folderChoice.classList.add('rudonium-wrap-anywhere')

        const modeLabel = this.contentEl.createEl('label', { text: t('Destination', 'Целевая колода') })
        const modeSelect = modeLabel.createEl('select')
        modeSelect.classList.add('rudonium-deck-routes-mode-select')
        modeSelect.createEl('option', { value: 'inherit', text: t('Inherit from parent', 'Унаследовать от родительской папки') })
        modeSelect.createEl('option', { value: 'default', text: t('Use default Deck', 'Использовать колоду по умолчанию') })
        modeSelect.createEl('option', { value: 'deck', text: t('Choose Anki deck', 'Выбрать колоду Anki') })
        modeSelect.value = mode
        const deckPanel = this.contentEl.createDiv()
        const deckPicker = searchDecks(deckPanel, deck, chosen => { deck = chosen; render() }, t)
        const deckStatus = deckPanel.createEl('p', { attr: { role: 'status' } })
        const retry = deckPanel.createEl('button', { text: t('Reload Anki Decks', 'Обновить список колод') })
        const effective = this.contentEl.createEl('p')
        effective.classList.add('rudonium-wrap-anywhere')
        const status = this.contentEl.createEl('p', { attr: { role: 'status' } })
        status.classList.add('rudonium-text-error')
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        const save = footer.createEl('button', { text: t('Save Rule', 'Сохранить правило'), cls: 'mod-cta' })
        const remove = from === undefined ? undefined : footer.createEl('button', { text: t('Remove Rule', 'Удалить правило') })
        const back = footer.createEl('button', { text: t('Back', 'Назад') })

        const loadDecks = () => {
            if (loading) return
            this.loading?.abort()
            const request = new AbortController()
            this.loading = request
            loading = true
            retry.disabled = true
            deckStatus.setText(t('Loading Anki decks…', 'Загружаем колоды Anki…'))
            readSyncAuditDeckNames(request.signal).then(names => {
                if (request.signal.aborted) return
                loaded = true
                deckNames = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
                deckPicker.setChoices(deckNames)
            }).catch(() => {
                if (request.signal.aborted) return
                loaded = false
                deckNames = []
                deckPicker.setChoices([])
                deckStatus.setText(t('Anki decks are unavailable. Open Anki and reload to choose a new deck.',
                    'Колоды недоступны. Откройте Anki и обновите список колод.'))
            }).finally(() => {
                if (request.signal.aborted) return
                loading = false
                render()
            })
        }
        const render = () => {
            const exists = this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder
            folderChoice.setText(path ? `${path}${exists ? '' : t(' (missing)', ' (отсутствует)')}` : t('Choose a folder.', 'Выберите папку.'))
            deckPanel.hidden = mode !== 'deck'
            if (mode === 'deck' && loaded) {
                deckStatus.setText(deck ? deckNames.includes(deck) ? deck : t(`${deck} (missing in Anki)`, `${deck} (в Anki отсутствует)`)
                    : deckNames.length ? t('Choose an Anki deck.', 'Выберите колоду Anki.') : t('No Anki decks found.', 'Колоды Anki не найдены.'))
            }
            const rule = { mode, deck }
            const changed = (from !== undefined || mode !== 'inherit') &&
                (path !== from || original.mode !== mode || (mode === 'deck' && deck !== original.deck))
            const canChooseDeck = mode !== 'deck' || (deck !== '' &&
                (deckNames.includes(deck) || (from === path && deck === original.deck)))
            save.disabled = this.saving || !path || !changed || (!exists && (mode !== 'inherit' || path !== from)) || !canChooseDeck
            modeSelect.disabled = this.saving
            back.disabled = this.saving
            retry.disabled = loading || this.saving
            folderPicker.setDisabled(this.saving)
            deckPicker.setDisabled(this.saving)
            if (remove) remove.disabled = this.saving
            effective.setText(path ? destination(this.plugin, path, changeRule(readRules(this.plugin), from, path, rule), t) : '')
        }
        modeSelect.onchange = () => {
            if (this.saving) return
            const choice = modeSelect.value
            if (choice === 'default' || choice === 'deck' || choice === 'inherit') mode = choice
            if (mode === 'deck' && !loaded) loadDecks()
            render()
        }
        retry.onclick = loadDecks
        back.onclick = () => { if (!this.saving) this.showRules() }
        const submit = async (next: Rule, target: string) => {
            if (this.saving) return
            this.saving = true
            status.setText('')
            render()
            try {
                await withFastScanReadLock(this.plugin, () => savePluginDataInOrder(this.plugin, async () => {
                    if (next.mode === 'deck') {
                        const kind = await readAnkiDeckKind(next.deck, (action, params) =>
                            auditRead(action, params, undefined, 5_000)).catch(() => 'unknown' as const)
                        if (kind === 'filtered') {
                            throw new Error(t(`“${next.deck}” is a filtered deck. Choose an ordinary home deck for this folder.`,
                                `«${next.deck}» — фильтрованная колода. Выберите для папки обычную колоду.`))
                        }
                        if (kind === 'missing') {
                            throw new Error(t(`“${next.deck}” no longer exists in Anki. Reload Anki decks and choose a destination.`,
                                `Колода «${next.deck}» отсутствует в Anki. Обновите список и выберите колоду.`))
                        }
                    }
                    const settings = this.plugin.settings
                    const current = readRules(this.plugin)
                    if (from !== undefined) {
                        const previous = readRule(from, current)
                        if (previous.mode !== original.mode || previous.deck !== original.deck) {
                            throw new Error(t('This rule changed while you were editing it. Reopen it and try again.',
                                'Правило изменилось во время редактирования. Откройте его снова и повторите попытку.'))
                        }
                    }
                    if (target !== from && readRule(target, current).mode !== 'inherit') {
                        throw new Error(t('This folder already has a rule. Open its rule to edit it.',
                            'У папки уже есть правило. Откройте это правило для редактирования.'))
                    }
                    if (next.mode !== 'inherit' && !(this.plugin.app.vault.getAbstractFileByPath(target) instanceof TFolder)) {
                        throw new Error(t('This folder is missing. Choose its new path.', 'Папка отсутствует. Укажите новый путь.'))
                    }
                    const rules = changeRule(current, from, target, next)
                    const patch = { FOLDER_DECKS: rules.decks, FOLDER_DEFAULT_DECKS: rules.defaults }
                    await this.plugin.saveData({
                        settings: { ...settings, ...patch },
                        'Added Media': this.plugin.added_media,
                        'File Hashes': this.plugin.file_hashes,
                        fields_dict: this.plugin.fields_dict,
                    })
                    Object.assign(settings, patch)
                }))
            } catch (error) {
                const message = uiDiagnostic(error, t)
                if (this.closed) new Notice(t(`Could not save the folder rule. ${message}`, `Не удалось сохранить правило для папки. ${message}`))
                else status.setText(message)
                return
            } finally {
                this.saving = false
                if (!this.closed) render()
            }
            this.onChange()
            if (!this.closed) this.showRules()
        }
        save.onclick = () => { if (!save.disabled) return submit({ mode, deck }, path) }
        if (remove && from !== undefined) remove.onclick = () => submit({ mode: 'inherit', deck: '' }, from)
        if (mode === 'deck') loadDecks()
        render()
        folderPicker.focus()
    }
}

export function installDeckRoutingSettings(container: HTMLElement, plugin: MyPlugin): void {
    const t = uiFor(plugin.settings)
    const row = new Setting(container).setName(t('Deck Assignments', 'Назначение колод'))
    const update = () => {
        const count = assignedFolders(readRules(plugin)).length
        row.setDesc(count ? t(`${count} folder ${count === 1 ? 'rule' : 'rules'} · Inherits through subfolders`,
            `Правил для папок · ${count}. Правила наследуются вложенными папками.`)
            : t('Assign a different Anki deck to a folder and its subfolders.', 'Назначьте колоду Anki для папки и её вложенных папок.'))
    }
    update()
    row.addButton(button => button.setButtonText(t('Manage Deck Assignments', 'Настроить назначение колод'))
        .onClick(() => new DeckRoutingModal(plugin, update).open()))
}
