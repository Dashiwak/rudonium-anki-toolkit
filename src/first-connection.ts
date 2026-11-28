/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Modal, Setting, setIcon } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, checkPinnedAnkiProfile, profileProblemText, readActiveAnkiProfile } from './anki-profile'
import { readAnkiDeckKind } from './anki-study-state'
import { copyBlock } from './copy-block'
import { installModalLayout } from './modal-layout'
import { rememberGroup, saveSettingsLayout } from './settings-layout'
import { readNoteTypeSchema, updatedChoices } from './note-type-refresh'
import { auditRead } from './sync-audit'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { needsFormatSetup } from './first-run-formats'
import { renderQuickStartNoteTypeRules } from './note-type-rule-ui'
import { applyRuleSettings } from './note-type-rules'
import type { RuleSettings } from './note-type-rules'

export interface FirstConnectionSchema {
    names: string[]
    fields: Record<string, string[]>
}

interface Connection extends FirstConnectionSchema {
    profile: string
    decks: string[]
}

interface SetupDraft {
    deck: string
    originalDeck: string
    originalRules: RuleSettings
    rules: RuleSettings
}

const addOnCode = '2055492159'
const obsidianOrigin = 'app://obsidian.md'
const defaultLocalConfig = JSON.stringify({
    apiKey: null,
    apiLogPath: null,
    webBindAddress: '127.0.0.1',
    webBindPort: 8765,
    webCorsOrigin: 'http://localhost',
    webCorsOriginList: ['http://localhost', obsidianOrigin],
}, null, 2)

function addAnkiConnectGuide(guide: HTMLElement, t: UiText): void {
    const steps = guide.createEl('ol')
    const start = steps.createEl('li', { text: t(
        'Open desktop Anki on this computer and select the profile where you want to study. ',
        'Откройте настольную Anki на этом компьютере и выберите профиль, в котором будете заниматься. ') })
    start.createEl('a', { text: t('Download Anki', 'Скачать Anki'), attr: { href: 'https://apps.ankiweb.net/' } })
    const install = steps.createEl('li', { text: t(
        'In Anki, open Tools → Add-ons → Get Add-ons, enter this code and restart Anki. ',
        'В Anki откройте «Инструменты → Дополнения → Загрузить дополнения», введите этот код и перезапустите Anki. ') })
    install.createEl('a', { text: t('AnkiConnect on AnkiWeb', 'AnkiConnect на AnkiWeb'),
        attr: { href: 'https://ankiweb.net/shared/info/' + addOnCode } })
    copyBlock(install, addOnCode, t('Copy add-on code', 'Скопировать код дополнения'), t)
    const cors = steps.createEl('li', { text: t(
        'Under Tools → Add-ons, select AnkiConnect and open Config. Add this quoted address to the webCorsOriginList array. Separate entries with commas and keep your existing addresses and settings.',
        'В разделе «Инструменты → Дополнения» выберите AnkiConnect и откройте «Настройки» (Config). Добавьте этот адрес вместе с кавычками в список webCorsOriginList. Разделите адреса запятыми и сохраните прежние адреса и настройки.') })
    copyBlock(cors, JSON.stringify(obsidianOrigin), t('Copy Obsidian address', 'Скопировать адрес Obsidian'), t)
    cors.createEl('p', { text: t(
        'Full example for a fresh installation. Rudonium connects to 127.0.0.1:8765 with apiKey set to null. If you already use a custom configuration, keep it and use the example to locate the origin list.',
        'Полный пример для новой установки. Rudonium подключается к 127.0.0.1:8765 при значении null у apiKey. Если у вас уже настроен AnkiConnect, сохраните свою конфигурацию и используйте пример, чтобы найти список адресов.') })
    copyBlock(cors, defaultLocalConfig, t('Copy example JSON', 'Скопировать пример JSON'), t)
    steps.createEl('li', { text: t(
        'Save the configuration, restart Anki and leave the collection open. Here in Obsidian, click Check Connection. Choose your deck, review the note types and click Save Setup.',
        'Сохраните настройки, перезапустите Anki и оставьте коллекцию открытой. В этом окне Obsidian нажмите «Проверить соединение». Выберите колоду, проверьте типы записей и нажмите «Сохранить настройки».') })
}

const running = new WeakMap<MyPlugin, FirstConnectionModal>()
const registeredCleanup = new WeakSet<MyPlugin>()

async function decksFromAnki(signal?: AbortSignal): Promise<string[]> {
    const response = await auditRead('deckNames', {}, signal, 5000)
    if (!Array.isArray(response) || !response.length ||
        !response.every((name): name is string => typeof name === 'string' && !!name.trim()) ||
        new Set(response).size !== response.length) throw new Error('Anki returned an invalid list of decks.')
    return response
}

// A profile may change or Anki may close while decks or fields are being read.
async function checkedAnkiRead<T>(profile: string, signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
    try { return await read() }
    finally { if (!signal?.aborted) await checkPinnedAnkiProfile(profile, signal) }
}

export async function inspectFirstConnection(signal?: AbortSignal): Promise<Connection> {
    const profile = await readActiveAnkiProfile(signal)
    return checkedAnkiRead(profile, signal, async () => {
        const decks = await decksFromAnki(signal)
        const { names, fields } = await readNoteTypeSchema(performance.now() + 20000, signal)
        return { profile, decks, names, fields }
    })
}

class ConnectionChanged extends Error {
    constructor(message: string, readonly russian: string) { super(message) }
}

function sameSchema(left: FirstConnectionSchema, right: FirstConnectionSchema): boolean {
    return left.names.length === right.names.length && left.names.every(model => {
        const before = left.fields[model], after = right.fields[model]
        return Object.hasOwn(right.fields, model) && before.length === after.length &&
            before.every((field, index) => field === after[index])
    })
}

export async function verifyFirstConnection(connection: Connection, deck: string, signal?: AbortSignal): Promise<void> {
    await checkPinnedAnkiProfile(connection.profile, signal)
    await checkedAnkiRead(connection.profile, signal, async () => {
        const kind = connection.decks.includes(deck)
            ? await readAnkiDeckKind(deck, (action, params) => auditRead(action, params ?? {}, signal, 5000))
            : 'missing'
        if (kind === 'missing') throw new ConnectionChanged('The selected deck is no longer available. Check the connection again.',
            'Выбранная колода больше недоступна. Проверьте соединение снова.')
        if (kind !== 'ordinary') throw new Error('Choose a confirmed ordinary Anki deck.')
        const current = await readNoteTypeSchema(performance.now() + 20000, signal)
        if (!sameSchema(connection, current)) throw new ConnectionChanged('The Anki note types changed. Check the connection again.',
            'Типы записей в Anki изменились. Проверьте соединение снова.')
    })
}

function ruleSnapshot(settings: RuleSettings): RuleSettings {
    const { CUSTOM_REGEXPS, INACTIVE_CUSTOM_REGEXPS, FILE_LINK_FIELDS, CONTEXT_FIELDS,
        NOTE_TYPE_RULE_NAMES, NOTE_TYPE_RULE_MODELS, REGEXP_WIZARD_FIELDS } = settings
    return structuredClone({ CUSTOM_REGEXPS, INACTIVE_CUSTOM_REGEXPS, FILE_LINK_FIELDS, CONTEXT_FIELDS,
        NOTE_TYPE_RULE_NAMES, NOTE_TYPE_RULE_MODELS, REGEXP_WIZARD_FIELDS })
}

type Save = (connection: Connection, draft: SetupDraft, signal: AbortSignal) => Promise<void>
type Status = 'checking' | 'offline' | 'problem' | 'connected'

class FirstConnectionModal extends Modal {
    private connection?: Connection
    private draft?: SetupDraft
    private controller?: AbortController
    private closeRuleEditor?: () => void
    private state: Status = 'checking'
    private busy = false
    private closed = false
    private message = ''

    constructor(private readonly plugin: MyPlugin, private readonly t: UiText, private readonly save: Save,
        private readonly firstRun: boolean, private readonly savePreference: (dismiss: boolean) => Promise<void>) { super(plugin.app) }

    onOpen(): void {
        this.titleEl.setText(this.t('Quick Start', 'Быстрый старт'))
        installModalLayout(this, this.t)
        this.contentEl.classList.add('rudonium-quick-start')
        this.checkConnection()
    }

    onClose(): void {
        this.closed = true
        this.controller?.abort()
        this.closeRuleEditor?.()
        saveSettingsLayout(this.contentEl, this.plugin)
        if (running.get(this.plugin) === this) running.delete(this.plugin)
        this.contentEl.empty()
    }

    private async act(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
        if (this.busy || this.closed) return
        this.busy = true
        this.message = ''
        const controller = this.controller = new AbortController()
        this.render()
        try { await task(controller.signal) }
        catch (error) {
            if (!controller.signal.aborted) {
                const { t } = this
                if (error instanceof AnkiProfileError) {
                    this.state = error.reason === 'unreachable' ? 'offline' : 'problem'
                    this.message = this.state === 'offline' ? t(
                        'Start desktop Anki, then check the connection again. If Anki is already open, check that AnkiConnect is enabled.',
                        'Запустите настольную Anki и повторите проверку. Если Anki уже открыта, проверьте, включено ли дополнение AnkiConnect.')
                        : profileProblemText(error, t)
                } else if (error instanceof ConnectionChanged) {
                    this.state = 'problem'
                    this.message = t(error.message, error.russian)
                } else {
                    if (this.state === 'checking') this.state = 'problem'
                    this.message = error instanceof Error && error.message === 'Choose a confirmed ordinary Anki deck.'
                        ? t(error.message, 'Выберите обычную колоду Anki с подтверждённым типом.')
                        : uiDiagnostic(error, t)
                }
            }
        } finally {
            this.busy = false
            if (!this.closed) this.render()
        }
    }

    private checkConnection(): void {
        if (this.busy || this.closed) return
        this.state = 'checking'
        void this.act(async signal => {
            const connection = await inspectFirstConnection(signal)
            if (signal.aborted) return
            const settings = this.plugin.settings
            if (settings.REQUIRE_ANKI_PROFILE && settings.EXPECTED_ANKI_PROFILE &&
                settings.EXPECTED_ANKI_PROFILE !== connection.profile) {
                throw new AnkiProfileError('mismatch', settings.EXPECTED_ANKI_PROFILE, connection.profile)
            }
            const previous = this.connection
            const existing = this.draft
            const rules = ruleSnapshot(settings)
            const reuse = existing && previous?.profile === connection.profile && sameSchema(previous, connection) &&
                JSON.stringify(existing.originalRules) === JSON.stringify(rules) && existing.originalDeck === settings.Defaults.Deck
            const preferred = reuse ? existing.deck : settings.Defaults.Deck
            const deck = connection.decks.includes(preferred) ? preferred :
                connection.decks.includes('Default') ? 'Default' : connection.decks[0]
            this.draft = reuse ? { ...existing, deck } : { deck, originalDeck: settings.Defaults.Deck, rules, originalRules: rules }
            if (!reuse && existing && (existing.rules !== existing.originalRules || existing.deck !== existing.originalDeck)) {
                this.message = this.t('The profile or its settings changed. Review the current deck and rules.',
                    'Профиль или настройки изменились. Проверьте текущую колоду и правила.')
            }
            this.connection = connection
            this.state = 'connected'
        })
    }

    private showStartupPreference(parent: HTMLElement): void {
        if (!this.firstRun && this.plugin.settings.QUICK_START_STATUS !== 'dismissed') return
        const label = parent.createEl('label', { cls: 'rudonium-first-run-preference' })
        const checkbox = label.createEl('input', { attr: { type: 'checkbox' } })
        checkbox.checked = this.plugin.settings.QUICK_START_STATUS === 'dismissed'
        checkbox.disabled = this.busy
        label.createSpan({ text: this.t('Don’t show Quick Start automatically', 'Не показывать быстрый старт автоматически') })
        checkbox.onchange = () => {
            const dismiss = checkbox.checked
            void this.act(() => this.savePreference(dismiss))
        }
    }

    private render(): void {
        const { t, contentEl, connection, draft, state } = this
        this.closeRuleEditor?.()
        this.closeRuleEditor = undefined
        saveSettingsLayout(contentEl, this.plugin)
        contentEl.empty()
        const titles = {
            checking: t('Checking Anki connection…', 'Проверяем соединение с Anki…'),
            offline: t('No connection to Anki', 'Нет соединения с Anki'),
            problem: t('Could not complete the connection check', 'Не удалось завершить проверку соединения'),
            connected: t('Connected to Anki', 'Соединение с Anki установлено'),
        }
        const status = contentEl.createDiv({ cls: ['rudonium-connection-status', 'is-' + state],
            attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } })
        setIcon(status.createSpan({ attr: { 'aria-hidden': 'true' } }),
            { checking: 'loader', offline: 'circle-x', problem: 'circle-alert', connected: 'circle-check' }[state])
        const body = status.createDiv()
        body.createEl('strong', { text: titles[state] })
        if (state === 'checking') return
        if (state === 'connected' && connection && draft) {
            const form = contentEl.createEl('fieldset', { cls: 'rudonium-first-connection-form' })
            form.disabled = this.busy
            form.createEl('legend', { text: t(`Anki profile · ${connection.profile}`, `Профиль Anki · ${connection.profile}`) })
            new Setting(form).setName(t('Deck', 'Колода')).addDropdown(list => {
                for (const deck of connection.decks) list.addOption(deck, deck)
                list.setValue(draft.deck).onChange(deck => { draft.deck = deck })
            })
            this.closeRuleEditor = renderQuickStartNoteTypeRules(form, this.plugin, connection.fields,
                () => draft.rules, rules => { draft.rules = rules })
            if (this.message) {
                form.createEl('p', { text: this.message, attr: { role: 'status' } })
            }
            const actions = form.createDiv({ cls: 'modal-button-container' })
            actions.createEl('button', { text: t('Save Setup', 'Сохранить настройки'), cls: 'mod-cta' }).onclick =
                () => void this.act(async signal => {
                    await verifyFirstConnection(connection, draft.deck, signal)
                    if (signal.aborted) return
                    await this.save(connection, draft, signal)
                    if (!this.closed) this.close()
                })
        } else {
            if (this.message) body.createEl('p', { text: this.message })
            const actions = contentEl.createDiv({ cls: ['modal-button-container', 'rudonium-connection-actions'] })
            const retry = actions.createEl('button', { text: t('Check Connection', 'Проверить соединение'), cls: 'mod-cta' })
            retry.disabled = this.busy
            retry.onclick = () => this.checkConnection()
            const guide = contentEl.createEl('details')
            rememberGroup(guide, this.plugin, 'quick-start-connection-help')
            guide.createEl('summary', { text: t('Set up AnkiConnect', 'Как настроить AnkiConnect') })
            addAnkiConnectGuide(guide, t)
        }
        this.showStartupPreference(contentEl)
        const links = contentEl.createDiv({ cls: 'rudonium-quick-start-links' })
        links.createEl('a', { text: t('Quick Start guide', 'Руководство по быстрому старту'),
            attr: { href: 'https://github.com/Dashiwak/rudonium-anki-toolkit/blob/HEAD/docs/' + t('en', 'ru') + '/quick-start.md' } })
    }
}

function open(plugin: MyPlugin, t: UiText, save: Save, firstRun: boolean, savePreference: (dismiss: boolean) => Promise<void>): void {
    if (running.has(plugin)) return
    if (!registeredCleanup.has(plugin)) {
        plugin.register(() => {
            running.get(plugin)?.close()
            registeredCleanup.delete(plugin)
        })
        registeredCleanup.add(plugin)
    }
    const modal = new FirstConnectionModal(plugin, t, save, firstRun, savePreference)
    running.set(plugin, modal)
    modal.open()
}

type SetupLock = (task: () => Promise<void>) => Promise<void>

export function registerSetupCommand(plugin: MyPlugin, withLock: SetupLock, stopped: () => boolean): void {
    plugin.addCommand({ id: 'ankiconnect-first-run', name: uiFor(plugin.settings)('Quick Start', 'Быстрый старт'),
        callback: () => openSetup(plugin, withLock) })
    plugin.app.workspace.onLayoutReady(() => {
        if (!stopped() && !registeredCleanup.has(plugin) && needsFormatSetup(plugin.settings, plugin.fields_dict)) {
            openSetup(plugin, withLock)
        }
    })
}

export function installFirstRunSetting(container: HTMLElement, plugin: MyPlugin, withLock: SetupLock, redraw: () => void): void {
    const t = uiFor(plugin.settings)
    new Setting(container).setName(t('Quick Start', 'Быстрый старт'))
        .setDesc(t('Choose a deck and configure note types for this vault.',
            'Выберите колоду и настройте типы записей для этого хранилища.'))
        .addButton(button => button.setButtonText(t('Set up sync', 'Настроить синхронизацию')).onClick(() => openSetup(plugin, withLock, redraw)))
}

export function openSetup(plugin: MyPlugin, withLock: SetupLock, redraw?: () => void): void {
    const t = uiFor(plugin.settings)
    const first = needsFormatSetup(plugin.settings, plugin.fields_dict) || plugin.settings.QUICK_START_STATUS === 'dismissed'
    open(plugin, t, (connection, draft, signal) => withLock(async () => {
        await checkPinnedAnkiProfile(connection.profile, signal)
        if (signal.aborted) return
        const { settings } = plugin
        if (settings.REQUIRE_ANKI_PROFILE && settings.EXPECTED_ANKI_PROFILE && settings.EXPECTED_ANKI_PROFILE !== connection.profile) {
            throw new AnkiProfileError('mismatch', settings.EXPECTED_ANKI_PROFILE, connection.profile)
        }
        const edited = draft.rules !== draft.originalRules
        if ((edited && JSON.stringify(ruleSnapshot(settings)) !== JSON.stringify(draft.originalRules)) ||
            settings.Defaults.Deck !== draft.originalDeck) {
            throw new Error(t('The setup changed while Quick Start was open. Close and reopen it to load the latest settings.',
                'Настройки изменились, пока был открыт быстрый старт. Закройте окно и откройте его снова.'))
        }
        const previousFields = plugin.fields_dict
        const previousTypes = plugin.note_types
        const previousDeck = settings.Defaults.Deck
        const previousStatus = settings.QUICK_START_STATUS
        const schemaChanged = !sameSchema({ names: Object.keys(previousFields), fields: previousFields }, connection)
        const updates: RuleSettings = edited ? { ...draft.rules } : {}
        if (schemaChanged) {
            Object.assign(updates, updatedChoices({ ...settings, ...updates }, connection.names, connection.fields))
        }
        const restore = applyRuleSettings(settings, updates)
        plugin.fields_dict = connection.fields
        plugin.note_types = connection.names
        settings.Defaults.Deck = draft.deck
        settings.QUICK_START_STATUS = 'complete'
        try { await plugin.saveAllData() } catch (error) {
            if (previousStatus === undefined) delete settings.QUICK_START_STATUS
            else settings.QUICK_START_STATUS = previousStatus
            restore()
            plugin.fields_dict = previousFields
            plugin.note_types = previousTypes
            settings.Defaults.Deck = previousDeck
            throw error
        }
        redraw?.()
    }), first, dismiss => withLock(async () => {
        const settings = plugin.settings
        const before = settings.QUICK_START_STATUS
        settings.QUICK_START_STATUS = dismiss ? 'dismissed' : 'pending'
        try { await plugin.saveAllData() }
        catch (error) {
            if (before === undefined) delete settings.QUICK_START_STATUS
            else settings.QUICK_START_STATUS = before
            throw error
        }
    }))
}
