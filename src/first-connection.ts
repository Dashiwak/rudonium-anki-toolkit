/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Modal, Setting } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, checkPinnedAnkiProfile, profileProblemText, readActiveAnkiProfile } from './anki-profile'
import { readAnkiDeckKind } from './anki-study-state'
import { buildBasicCardVariants, readCardTemplateVariants } from './card-preview-render'
import { openCardPreview } from './card-preview-ui'
import { installModalLayout } from './modal-layout'
import { rememberGroup, saveSettingsLayout } from './settings-layout'
import { readNoteTypeSchema } from './note-type-refresh'
import { auditRead } from './sync-audit'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { openPageMigration } from './page-migration-ui'
import { acknowledgeFormatSetup, needsFormatSetup } from './first-run-formats'
import { supportUrl } from './plugin-identity'
import { cardFormatPresets } from './card-format-presets'
import { customRegexpKey, matchCustomRegexps } from './custom-regexp-worker'
import { addRegexpWizard } from './regexp-wizard'
import { formatControl } from './note-type-rule-ui'
import { applyRuleSettings, configuredModels, customExpressionProblem, presetId, readRule, ruleProblem, withRule } from './note-type-rules'
import type { RuleSettings } from './note-type-rules'

export interface FirstConnectionSchema {
    names: string[]
    fields: Record<string, string[]>
}

interface Connection extends FirstConnectionSchema {
    profile: string
    decks: string[]
}

export interface FirstConnectionChoice {
    deck: string
    model: string
    front: string
    back: string
    lock: boolean
    expression: string
    originalExpression: string
    wizardFields?: string[]
    forMigration?: boolean
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

export async function inspectFirstConnection(signal?: AbortSignal): Promise<Connection> {
    const profile = await readActiveAnkiProfile(signal)
    const decks = await decksFromAnki(signal)
    const { names, fields } = await readNoteTypeSchema(performance.now() + 20000, signal)
    await checkPinnedAnkiProfile(profile, signal)
    if (!names.length || !names.some(model => fields[model]?.length >= 2)) {
        throw new Error('Create or enable an Anki note type with at least two fields, then check the connection again.')
    }
    return { profile, decks, names, fields }
}

export async function verifyFirstConnection(connection: Connection, choice: FirstConnectionChoice, signal?: AbortSignal): Promise<void> {
    const names = connection.fields[choice.model]
    if (!choice.deck || !connection.decks.includes(choice.deck) || !names ||
        choice.front === choice.back || !names.includes(choice.front) || !names.includes(choice.back)) {
        throw new Error('Choose an existing deck and two different fields.')
    }
    await checkPinnedAnkiProfile(connection.profile, signal)
    const kind = await readAnkiDeckKind(choice.deck, (action, params) => auditRead(action, params ?? {}, signal, 5000))
    if (kind !== 'ordinary') throw new Error('Choose a confirmed ordinary Anki deck.')
    const matches = (left: readonly string[], right: readonly string[]) =>
        left.length === right.length && left.every((value, index) => value === right[index])
    const current = await readNoteTypeSchema(performance.now() + 20000, signal)
    if (connection.names.length !== current.names.length ||
        connection.names.some(name => !current.fields[name] || !matches(current.fields[name], connection.fields[name]))) {
        throw new Error('The Anki note types changed. Check the connection again.')
    }
    await checkPinnedAnkiProfile(connection.profile, signal)
}

export function exampleBlock(syntax: MyPlugin['settings']['Syntax'] | undefined, model: string,
    fields: readonly string[], front: string, back: string): string {
    const values = fields.flatMap(name => name === front ? [name + ': Capital of Austria?'] : name === back ? [name + ': Vienna'] : [])
    return [syntax?.['Begin Note'] ?? 'START', model, ...values, syntax?.['End Note'] ?? 'END'].join('\n')
}

function setupRule(settings: RuleSettings, fields: FirstConnectionSchema['fields'], choice: FirstConnectionChoice, t: UiText) {
    const current = readRule(settings, choice.model)
    if (current.expression !== choice.originalExpression) throw new Error(t('This rule changed. Reopen Quick Start.', 'Правило изменилось. Откройте быстрый старт заново.'))
    const rule = { ...current, expression: choice.expression }
    const problem = ruleProblem(settings, fields, rule, t)
    if (problem) throw new Error(problem)
    return withRule(settings, rule, false, choice.wizardFields)
}

const remNoteExpression = cardFormatPresets.find(preset => preset.id === 'remnote')!.expression

type Save = (connection: Connection, choice: FirstConnectionChoice, signal: AbortSignal) => Promise<void>

class FirstConnectionModal extends Modal {
    private connection?: Connection
    private choice?: FirstConnectionChoice
    private controller?: AbortController
    private custom = false
    private sample = ''
    private customFields?: string[]
    private failed = false
    private busy = false
    private closed = false
    private message = ''
    private migrating = false

    constructor(private readonly plugin: MyPlugin, private readonly t: UiText, private readonly save: Save,
        private readonly firstRun: boolean, private readonly suggestRemNote: boolean) { super(plugin.app) }
    onOpen(): void {
        this.titleEl.setText(this.t('Quick Start', 'Быстрый старт'))
        installModalLayout(this, this.t)
        this.render()
    }
    onClose(): void {
        saveSettingsLayout(this.contentEl, this.plugin)
        this.closed = true
        this.controller?.abort()
        if (running.get(this.plugin) === this) running.delete(this.plugin)
        this.contentEl.empty()
    }

    private errorText(error: unknown): string {
        if (error instanceof AnkiProfileError) return this.t(error.message, profileProblemText(error, this.t))
        if (error instanceof Error) {
            if (/ordinary Anki deck/.test(error.message)) return this.t(error.message, 'Выберите обычную колоду Anki с подтверждённым типом.')
            if (/note types changed/.test(error.message)) return this.t(error.message, 'Типы записей в Anki изменились. Проверьте соединение снова.')
        }
        return uiDiagnostic(error, this.t)
    }

    private async act(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
        if (this.busy) return
        this.busy = true
        this.failed = false
        this.message = this.t('Checking…', 'Проверка…')
        const controller = this.controller = new AbortController()
        this.render()
        try { await task(controller.signal) }
        catch (error) { if (!controller.signal.aborted) { this.failed = true; this.message = this.errorText(error) } }
        finally {
            this.busy = false
            if (!this.closed) this.render()
        }
    }

    private async connect(signal: AbortSignal): Promise<void> {
        this.connection = undefined
        this.choice = undefined
        const connection = await inspectFirstConnection(signal)
        const names = connection.names.filter(model => connection.fields[model]?.length >= 2)
        const settings = this.plugin.settings ?? {}
        const existing = configuredModels(settings, connection.fields).find(model => names.includes(model))
        const model = existing ?? (names.includes('Basic') ? 'Basic' : names[0])
        const [front, back] = connection.fields[model]
        const preferred = this.plugin.settings?.Defaults?.Deck
        const deck = preferred && connection.decks.includes(preferred) ? preferred
            : connection.decks.includes('Default') ? 'Default' : connection.decks[0]
        this.connection = connection
        const originalExpression = readRule(settings, model).expression
        const expression = this.suggestRemNote ? remNoteExpression : originalExpression
        this.custom = presetId(expression) === 'custom'
        this.customFields = undefined
        this.sample = ''
        this.choice = { deck, model, front, back, expression, originalExpression, lock: this.plugin.settings?.REQUIRE_ANKI_PROFILE === true }
        this.message = ''
    }

    private exampleValues(choice: FirstConnectionChoice): string[] {
        if (this.custom) return this.customFields ?? []
        const preset = cardFormatPresets.find(item => item.expression === choice.expression)
        return preset?.expression ? [preset.front, preset.back] : ['Capital of Austria?', 'Vienna']
    }

    private async testCustom(choice: FirstConnectionChoice, signal: AbortSignal): Promise<void> {
        const pattern = { source: choice.expression, flags: 'gm', label: choice.model }
        const results = await matchCustomRegexps(this.sample, [pattern], { signal })
        if (signal.aborted) return
        const matches = results.get(customRegexpKey(pattern)) ?? []
        if (matches.length !== 1 || !matches[0][1]) throw new Error(this.t(
            'Enter one sample card that matches the pattern and captures its first field.',
            'Введите одну карточку, которая подходит под выражение и заполняет первое поле.'))
        this.customFields = matches[0].slice(1)
        this.message = ''
    }

    private async preview(connection: Connection, choice: FirstConnectionChoice, signal: AbortSignal): Promise<void> {
        const { t } = this
        const values = this.exampleValues(choice)
        const fields = connection.fields[choice.model].map((name, index) => {
            const text = this.contentEl.ownerDocument.createDocumentFragment().createSpan()
            text.textContent = values[index] ?? ''
            return { name, html: text.innerHTML }
        })
        const verify = () => checkPinnedAnkiProfile(connection.profile, signal)
        const layout = await readCardTemplateVariants(choice.model, fields, verify,
            actions => auditRead('multi', { actions }, signal, 5000), { deck: choice.deck }, t)
        await verify()
        if (signal.aborted) return
        openCardPreview(this.plugin.app, {
            source: t('Connection setup example', 'Пример из мастера подключения'), line: 1,
            fields, modelName: choice.model, deck: choice.deck, deckReason: t('Setup selection', 'Выбрано в мастере'),
            variants: layout.variants.length ? layout.variants : buildBasicCardVariants(fields, choice.model, t),
            previewNotice: t('Read-only example', 'Тестовый предпросмотр без записи'),
            cautions: layout.cautions,
        }, t)
        this.message = ''
    }

    private render(): void {
        const { t, contentEl, connection, choice, busy } = this
        saveSettingsLayout(contentEl, this.plugin)
        contentEl.empty()
        if (this.message) contentEl.createEl('p', { text: this.message, attr: { role: 'status', 'aria-live': 'polite' } })
        if (this.failed) contentEl.createEl('a', { text: t('Help on GitFlic', 'Помощь на GitFlic'), attr: { href: supportUrl } })
        if (!connection || !choice) {
            contentEl.createEl('p', { text: t('Open your profile in desktop Anki with AnkiConnect enabled.',
                'Откройте нужный профиль в настольной Anki с включённым AnkiConnect.') })
            const guide = contentEl.createEl('details')
            rememberGroup(guide, this.plugin, 'quick-start-connection-help', this.firstRun || this.failed)
            guide.createEl('summary', { text: t('Set up AnkiConnect', 'Как настроить AnkiConnect') })
            const steps = guide.createEl('ol')
            steps.createEl('li', { text: t(
                'In desktop Anki, open Tools → Add-ons → Get Add-ons. Enter 2055492159 and restart Anki.',
                'В настольной Anki откройте «Инструменты → Дополнения → Загрузить дополнения». Введите 2055492159 и перезапустите Anki.') })
            const cors = steps.createEl('li', { text: t(
                'Under Tools → Add-ons, select AnkiConnect and open Config. Add "app://obsidian.md" to webCorsOriginList, keeping the existing entries. Example list after editing',
                'В разделе «Инструменты → Дополнения» выберите AnkiConnect и откройте «Настройки» (Config). Добавьте "app://obsidian.md" в список webCorsOriginList, сохранив прежние адреса. Пример списка после правки') })
            cors.createEl('pre', { text: '["http://localhost", "app://obsidian.md"]' })
            steps.createEl('li', { text: t(
                'Save the configuration, restart Anki and leave your collection open. In this window, choose Check Connection.',
                'Сохраните настройки, перезапустите Anki и оставьте коллекцию открытой. В этом окне нажмите «Проверить соединение».') })
            guide.createEl('p', { text: t(
                'Rudonium connects on this computer at 127.0.0.1:8765. It supports the default AnkiConnect setup with apiKey set to null.',
                'Rudonium подключается к Anki на этом компьютере по адресу 127.0.0.1:8765. Поддерживается стандартная конфигурация AnkiConnect со значением null у apiKey.') })
            guide.createEl('a', { text: t('AnkiConnect on AnkiWeb', 'AnkiConnect на AnkiWeb'),
                attr: { href: 'https://ankiweb.net/shared/info/2055492159' } })
            const actions = contentEl.createDiv({ cls: 'modal-button-container' })
            const check = actions.createEl('button', {
                text: t('Check Connection', 'Проверить соединение'), cls: 'mod-cta' })
            check.disabled = busy
            check.onclick = () => { this.migrating = false; void this.act(signal => this.connect(signal)) }
            if (this.firstRun) {
                const migrate = actions.createEl('button', { text: t('Migrate existing card files', 'Перенести существующие карточки') })
                migrate.disabled = busy
                migrate.onclick = () => { this.migrating = true; void this.act(signal => this.connect(signal)) }
            }
            return
        }
        const form = contentEl.createEl('fieldset')
        form.disabled = busy
        form.classList.add('rudonium-first-connection-form')
        form.createEl('legend', { text: t(`Anki profile · ${connection.profile}`, `Профиль Anki · ${connection.profile}`) })
        const dropdown = (label: string, items: readonly string[], value: string, change: (value: string) => void) =>
            new Setting(form).setName(label).addDropdown(control => {
                for (const item of items) control.addOption(item, item)
                control.setValue(value).onChange(value => { change(value); this.render() })
            })
        dropdown(t('Deck', 'Колода'), connection.decks, choice.deck, deck => { choice.deck = deck })
        dropdown(this.migrating ? t('Default note type for unlinked pages', 'Тип записи для страниц без связи') : t('Note type', 'Тип записи'),
            connection.names.filter(name => connection.fields[name].length >= 2),
            choice.model, model => {
                choice.wizardFields = undefined
                choice.model = model
                choice.front = connection.fields[model][0]
                choice.back = connection.fields[model][1]
                choice.originalExpression = readRule(this.plugin.settings ?? {}, model).expression
                choice.expression = this.suggestRemNote ? remNoteExpression : choice.originalExpression
                this.custom = presetId(choice.expression) === 'custom'
                this.customFields = undefined
                this.sample = ''
            })
        if (this.migrating) {
            form.createEl('p', { text: t('Save this connection, then preview existing card files. You can select files and review the backup location before conversion.',
                'Сохраните подключение, чтобы проверить существующие карточки. Перед преобразованием можно выбрать файлы и папку для резервной копии.') })
            const actions = form.createDiv({ cls: 'modal-button-container' })
            actions.createEl('button', { text: t('Back to setup', 'К настройке') }).onclick =
                () => { this.migrating = false; this.render() }
            actions.createEl('button', { text: t('Continue to migration', 'Перейти к переносу'), cls: 'mod-cta' }).onclick =
                () => void this.act(async signal => {
                    const selected = { ...choice, forMigration: true }
                    await verifyFirstConnection(connection, selected, signal)
                    if (signal.aborted) return
                    await this.save(connection, selected, signal)
                    if (signal.aborted || this.closed) return
                    this.close()
                    openPageMigration(this.plugin, selected.model)
                })
            return
        }
        formatControl(form, t, choice.expression, this.custom, (expression, custom) => {
            choice.wizardFields = undefined
            choice.expression = expression
            this.custom = custom
            this.customFields = undefined
            this.render()
        }, expression => { choice.wizardFields = undefined; choice.expression = expression; this.customFields = undefined; refreshCard() })
        const names = connection.fields[choice.model]
        addRegexpWizard(form, this.plugin.app, t, names, () => choice.expression, (pattern, sample, values) => {
            choice.expression = pattern
            choice.wizardFields = names.slice(0, values.length)
            this.custom = true
            this.sample = sample
            this.customFields = values
            this.render()
        })
        const preset = cardFormatPresets.find(item => item.expression === choice.expression)
        if (this.custom) {
            new Setting(form).setName(t('Sample Markdown', 'Пример Markdown')).addTextArea(area =>
                area.setValue(this.sample).onChange(value => { this.sample = value; this.customFields = undefined; refreshCard() }))
            form.createEl('button', { text: t('Test sample', 'Проверить пример') }).onclick =
                () => void this.act(signal => this.testCustom(choice, signal))
        } else {
            form.createEl('pre', { text: preset?.expression ? preset.example :
                exampleBlock(this.plugin.settings?.Syntax, choice.model, connection.fields[choice.model], choice.front, choice.back) })
        }
        const card = form.createEl('section')
        card.classList.add('rudonium-first-connection-card')
        const refreshCard = () => {
            card.empty()
            const values = this.exampleValues(choice)
            card.hidden = !values.length
            if (card.hidden) return
            card.createEl('small', { text: t('Front', 'Лицевая сторона') })
            card.createEl('div', { text: values[0] ?? '' })
            card.createEl('hr')
            card.createEl('small', { text: t('Back', 'Обратная сторона') })
            card.createEl('div', { text: values[1] ?? '' })
        }
        refreshCard()
        const options = form.createEl('details')
        rememberGroup(options, this.plugin, 'quick-start-more-options')
        options.createEl('summary', { text: t('More options', 'Дополнительные настройки') })
        new Setting(options).setName(t('Require this profile before writing', 'Проверять этот профиль перед записью'))
            .addToggle(control => control.setValue(choice.lock).onChange(lock => { choice.lock = lock }))
        const preview = options.createEl('button', { text: t('Preview Anki template', 'Посмотреть шаблон Anki') })
        preview.onclick = () => void this.act(async signal => {
            if (this.custom) await this.testCustom(choice, signal)
            if (!signal.aborted) await this.preview(connection, { ...choice }, signal)
        })
        options.createEl('button', { text: t('Check connection again', 'Проверить соединение снова') }).onclick = () => void this.act(signal => this.connect(signal))
        if (this.firstRun) form.createEl('p', { text: t(
            'For your first card, save this setup and write a card using the example format in a Markdown note. Put the cursor in the card and run Preview Current Card. Confirm the export and keep the ID that appears next to the card.',
            'Сохраните настройки и запишите первую карточку по образцу в заметку Markdown. Поставьте курсор в карточку и выполните команду «Предпросмотр текущей карточки». Подтвердите экспорт и сохраните ID, который появится рядом с карточкой.') })
        const actions = form.createDiv({ cls: 'modal-button-container' })
        if (this.firstRun) actions.createEl('button', { text: t('Migrate existing card files', 'Перенести существующие карточки') }).onclick =
            () => { this.migrating = true; this.render() }
        const button = actions.createEl('button', { text: t('Save Setup', 'Сохранить настройку'), cls: 'mod-cta' })
        button.onclick = () => void this.act(async signal => {
            const selected = { ...choice }
            const customProblem = this.custom && customExpressionProblem(selected.expression, t)
            if (customProblem) throw new Error(customProblem)
            setupRule(this.plugin.settings ?? {}, connection.fields, selected, t)
            if (this.custom && selected.expression !== selected.originalExpression) await this.testCustom(selected, signal)
            if (signal.aborted) return
            await verifyFirstConnection(connection, selected, signal)
            if (signal.aborted) return
            await this.save(connection, selected, signal)
            if (!this.closed) this.close()
        })
    }
}

function open(plugin: MyPlugin, t: UiText, save: Save, firstRun = false, suggestRemNote = firstRun): void {
    if (running.has(plugin)) return
    if (!registeredCleanup.has(plugin)) {
        plugin.register(() => {
            running.get(plugin)?.close()
            registeredCleanup.delete(plugin)
        })
        registeredCleanup.add(plugin)
    }
    const modal = new FirstConnectionModal(plugin, t, save, firstRun, suggestRemNote)
    running.set(plugin, modal)
    modal.open()
}

type SetupLock = (task: () => Promise<void>) => Promise<void>

export function registerSetupCommand(plugin: MyPlugin, withLock: SetupLock, stopped: () => boolean): void {
    plugin.addCommand({ id: 'ankiconnect-first-run', name: uiFor(plugin.settings)('Quick Start', 'Быстрый старт'),
        callback: () => openSetup(plugin, withLock) })
    plugin.app.workspace.onLayoutReady(() => {
        const settings = plugin.settings
        const cancelled = () => stopped() || settings !== plugin.settings || registeredCleanup.has(plugin)
        if (cancelled()) return
        void needsFormatSetup(plugin.app, settings, cancelled).then(needed => {
            if (needed && !cancelled()) openSetup(plugin, withLock)
        }).catch(error => console.warn('[Rudonium] Could not check first-run formats', error))
    })
}

export function installFirstRunSetting(container: HTMLElement, plugin: MyPlugin, withLock: SetupLock, redraw: () => void): void {
    const t = uiFor(plugin.settings)
    new Setting(container).setName(t('First Run', 'Первый запуск'))
        .setDesc(t('Choose a deck and card format.', 'Выберите колоду и формат карточки.'))
        .addButton(button => button.setButtonText(t('Open Setup', 'Открыть мастер')).onClick(() => openSetup(plugin, withLock, redraw)))
}

function openSetup(plugin: MyPlugin, withLock: SetupLock, redraw?: () => void): void {
    acknowledgeFormatSetup(plugin.app, plugin.settings)
    const t = uiFor(plugin.settings)
    const first = !Object.keys(plugin.fields_dict).length
    open(plugin, t, (connection, choice, signal) => withLock(async () => {
        await checkPinnedAnkiProfile(connection.profile, signal)
        if (signal.aborted) return
        const { settings } = plugin
        const previousFields = plugin.fields_dict
        const previousTypes = plugin.note_types
        const empty = !Object.keys(previousFields).length
        if (!empty && (!Object.prototype.hasOwnProperty.call(previousFields, choice.model) ||
            JSON.stringify(previousFields[choice.model]) !== JSON.stringify(connection.fields[choice.model]))) {
            throw new Error(t('Refresh note types in settings and reopen Quick Start.', 'Обновите типы записей в настройках и заново откройте быстрый старт.'))
        }
        const expressions = settings.CUSTOM_REGEXPS
        const previousDeck = settings.Defaults.Deck
        const previousProfile = settings.EXPECTED_ANKI_PROFILE
        const previousLock = settings.REQUIRE_ANKI_PROFILE
        const initial = empty ? { ...settings, CUSTOM_REGEXPS: { ...Object.fromEntries(connection.names.map(name => [name, ''])), ...expressions } } : settings
        const rule = choice.forMigration ? undefined : setupRule(initial, connection.fields, choice, t)
        const restoreRule = rule ? applyRuleSettings(settings, rule) : undefined
        if (empty) {
            if (!rule) settings.CUSTOM_REGEXPS = initial.CUSTOM_REGEXPS
            plugin.fields_dict = connection.fields
            plugin.note_types = connection.names
        }
        settings.Defaults.Deck = choice.deck
        settings.EXPECTED_ANKI_PROFILE = choice.lock ? connection.profile : previousProfile
        settings.REQUIRE_ANKI_PROFILE = choice.lock
        try { await plugin.saveAllData() } catch (error) {
            restoreRule?.()
            if (empty) settings.CUSTOM_REGEXPS = expressions
            plugin.fields_dict = previousFields
            plugin.note_types = previousTypes
            settings.Defaults.Deck = previousDeck
            settings.EXPECTED_ANKI_PROFILE = previousProfile
            settings.REQUIRE_ANKI_PROFILE = previousLock
            throw error
        }
        redraw?.()
    }), first, first || (!plugin.settings.NOTE_TYPE_RULE_MODELS?.length && !Object.values(plugin.settings.CUSTOM_REGEXPS ?? {}).some(value => value?.trim())))
}
