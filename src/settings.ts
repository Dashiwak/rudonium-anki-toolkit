import { uiDiagnostic, uiFor } from './interface-language'
import { bindSyntaxEdit, installCardLifecycleSettings, isLifecycleSyntax } from './card-lifecycle-settings'
import { createSettingsGroup, finalizeSettingsLayout, saveSettingsLayout, renderSettingsGroup } from './settings-layout'
import { installSettingsHelp, installInterfaceLanguage, installProjectInfo, legacySettingLabel, legacySettingDescription } from './interface-settings-ui'
import { installNoteTypeRules } from './note-type-rule-ui'
import { installFolderTagSettings, installIgnoredFilesSetting } from './settings-search'
import { installNoteTypeRefresh } from './note-type-refresh'
import { clearFastScanCache, previewVaultExport, withFastScanReadLock } from './fast-scan'
import { installIdMarkerSettings } from './id-tools-settings-ui'
import { openIdMarkerConversion } from './id-marker-conversion-ui'
import { openPageIdBulk } from './page-id-bulk-ui'
import { refreshEditorIdFolding } from './editor-id-folding'
import { installBidirectionalSettings } from './bidirectional-field-settings'
import { installFirstRunSetting } from './first-connection'
import { installPageMigrationSetting } from './page-migration-ui'
import { installZipImportSettings } from './zip-import-ui'
import { installImageOptimizationSettings } from './image-optimization-ui'
import { startSyncAudit, openSyncAuditDeckPicker } from './sync-audit-ui'
import { installDefaultDeckSetting } from './default-deck-setting'
import { installAnkiProfileSettings } from './anki-profile-ui'
import { installSyncProfileSettings } from './sync-profiles-ui'
import { installDeckRoutingSettings } from './deck-routes-ui'
import { openCacheOptimization } from './cache-optimization-ui'
import type RudoniumAnkiPlugin from '../main'
import type { App } from 'obsidian'
import { PluginSettingTab, Setting, Notice } from 'obsidian'

declare const RUDONIUM_BUILD_VERSION: string

const defaultDescs: Readonly<Record<string, string>> = {
	"Tag": "The tag that the plugin automatically adds to any generated cards.",
	"Deck": "The deck the plugin adds cards to if TARGET DECK is not specified in the file.",
	"Scheduling Interval": "The time, in minutes, between automatic scans of the vault. Set this to 0 to disable automatic scanning.",
	"Add File Link": "Append a link to the file that generated the flashcard on the field specified in the table.",
	"Add Context": "Append 'context' for the card, in the form of path > heading > heading etc, to the field specified in the table.",
	"CurlyCloze": "Convert {cloze deletions} -> {{c1::cloze deletions}} on note types that have a 'Cloze' in their name.",
	"CurlyCloze - Highlights to Clozes": "Convert ==highlights== -> {highlights} to be processed by CurlyCloze.",
	"ID Comments": "Wrap note IDs in a HTML comment.",
	"Add Date to Anki IDs": "Place the local date after each confirmed Anki ID and before your annotations. Existing dates are kept.",
	"Add Obsidian Tags": "Interpret #tags in the fields of a note as Anki tags, removing them from the note text in Anki."
}


interface SettingsSection {
    name: string
    aliases: string[]
    mount: (parent: HTMLElement, title: string) => void
}

export class SettingsTab extends PluginSettingTab {

    private readonly rudonium: RudoniumAnkiPlugin
    private scanInterval?: number
    private unloaded = false

    constructor(app: App, plugin: RudoniumAnkiPlugin) {
        super(app, plugin)
        this.rudonium = plugin
        this.setScanInterval(plugin.settings.Defaults?.['Scheduling Interval'] ?? 0)
        plugin.register(() => {
            this.unloaded = true
            this.setScanInterval(0)
        })
    }

    private setScanInterval(minutes: number): void {
        if (this.scanInterval !== undefined) window.clearInterval(this.scanInterval)
        this.scanInterval = undefined
        if (!this.unloaded && Number.isFinite(minutes) && minutes > 0) {
            this.scanInterval = window.setInterval(() => {
                void this.rudonium.scanVault('scheduled').catch(error => {
                    new Notice(uiDiagnostic(error, uiFor(this.rudonium.settings)))
                })
            }, minutes * 60_000)
        }
    }

    setup_syntax(containerEl = this.containerEl): void {
        const plugin = this.rudonium
        const t = uiFor(plugin.settings)
        const body = createSettingsGroup(containerEl, plugin, 'syntax', t('Syntax Settings', 'Синтаксис карточек'))
        for (const key of Object.keys(plugin.settings.Syntax)) {
            if (isLifecycleSyntax(key)) continue
            new Setting(body).setName(legacySettingLabel(key, t))
                .addText(text => bindSyntaxEdit(text, plugin, key))
        }
    }

    setup_defaults(containerEl = this.containerEl): void {
        const plugin = this.rudonium
        const t = uiFor(plugin.settings)
        const defaults: Record<string, string | number | boolean> = plugin.settings.Defaults
        // Fill keys introduced after older vault settings were saved.
        defaults['Add Context'] ??= false
        defaults['Scheduling Interval'] ??= 0
        defaults['CurlyCloze - Highlights to Clozes'] ??= false
        defaults['Add Obsidian Tags'] ??= false
        defaults['Add Date to Anki IDs'] ??= false
        const body = createSettingsGroup(containerEl, plugin, 'defaults', t('Defaults', 'Параметры по умолчанию'))
        installDefaultDeckSetting(body, plugin)
        for (const [key, value] of Object.entries(defaults)) {
            if (key === 'Deck' || key === 'Regex') continue
            const row = new Setting(body).setName(legacySettingLabel(key, t))
                .setDesc(legacySettingDescription(key, defaultDescs[key] ?? '', t))
            const save = async (next: string | number | boolean): Promise<void> => {
                defaults[key] = next
                try {
                    await plugin.saveAllData()
                    if (key === 'Scheduling Interval' && typeof next === 'number' && defaults[key] === next) {
                        this.setScanInterval(next)
                    }
                } catch (error) {
                    new Notice(uiDiagnostic(error, t))
                }
            }
            if (typeof value === 'string') row.addText(text => text.setValue(value).onChange(save))
            else if (typeof value === 'boolean') row.addToggle(toggle => toggle.setValue(value).onChange(save))
            else if (typeof value === 'number') row.addSlider(slider => slider.setLimits(0, 360, 5)
                .setValue(value).setDynamicTooltip().onChange(save))
        }
    }

    setup_connection(containerEl = this.containerEl): void {
        const plugin = this.rudonium
        const t = uiFor(plugin.settings)
        const connectionBody = createSettingsGroup(containerEl, plugin, 'connection', t('Anki Connection', 'Подключение к Anki'))
        installFirstRunSetting(connectionBody, plugin, task => withFastScanReadLock(plugin, task), () => this.redraw())
        installPageMigrationSetting(connectionBody, plugin)
    }

    private setupProfiles(containerEl: HTMLElement): void {
        const plugin = this.rudonium
        const t = uiFor(plugin.settings)
        const profileBody = createSettingsGroup(containerEl, plugin, 'profiles-and-routing', t('Profiles and Deck Assignments', 'Профили и назначения колод'))
        installAnkiProfileSettings(profileBody, plugin)
        installSyncProfileSettings(profileBody, plugin)
        installDeckRoutingSettings(profileBody, plugin)
    }

    private setupReview(containerEl: HTMLElement): void {
        const plugin = this.rudonium
        const t = uiFor(plugin.settings)
        const syncBody = createSettingsGroup(containerEl, plugin, 'sync-review', t('Sync and Review', 'Синхронизация и проверка'))
        new Setting(syncBody)
            .setName(t("Preview Export", "Предпросмотр экспорта"))
            .setDesc(t("Check what the export would add, update, move, or delete.",
                "Проверьте, какие записи экспорт добавит, изменит, перенесёт или удалит."))
            .addButton(button => button.setButtonText(t("Preview", "Открыть предпросмотр")).setClass('mod-cta')
                .onClick(() => previewVaultExport(plugin)))
        new Setting(syncBody)
            .setName(t("Sync Audit", "Сверка с Anki"))
            .setDesc(t("Check one exact deck and review duplicate IDs. Choose whether to run a folder profile export before the audit.",
                "Сверьте одну колоду и проверьте дубликаты ID. Можно запустить экспорт выбранных папок перед сверкой."))
            .addButton(button => button.setButtonText(t("Check Default Deck", "Проверить колоду по умолчанию")).onClick(() => startSyncAudit(plugin)))
            .addButton(button => button.setButtonText(t("Choose Deck", "Выбрать колоду")).onClick(() => openSyncAuditDeckPicker(plugin)))
    }

    private setupIdMarkers(containerEl: HTMLElement): void {
        const plugin = this.rudonium
        installIdMarkerSettings(containerEl, plugin, {
            toComment: () => openIdMarkerConversion(plugin, 'to-comment'),
            toPlain: () => openIdMarkerConversion(plugin, 'to-plain'),
            moveVaultPages: () => openPageIdBulk(plugin),
            foldingChanged: () => refreshEditorIdFolding(plugin),
        })
    }

    setup_buttons(containerEl = this.containerEl): void {
        const { rudonium } = this
        const t = uiFor(rudonium.settings)
        const body = createSettingsGroup(containerEl, rudonium, 'actions', t('Actions', 'Обслуживание'))
        installNoteTypeRefresh(this.containerEl, body, rudonium, () => this.redraw())
        // Both cache changes wait for the active scan to finish.
        const clear = async (kind: 'media' | 'files'): Promise<void> => {
            try { await clearFastScanCache(rudonium, kind) }
            catch (error) { new Notice(uiDiagnostic(error, t)) }
        }
        new Setting(body)
            .setName(t('Clear Media Cache', 'Очистить кеш вложений'))
            .setDesc(t('Clear the cached list of media previously sent to Anki.', 'Удаляет из кеша список ранее отправленных вложений.'))
            .addButton(button => button.setButtonText(t('Clear', 'Очистить')).setClass('mod-cta').onClick(() => clear('media')))
        new Setting(body)
            .setName(t('Optimize Cache', 'Оптимизировать кеш'))
            .setDesc(t('Review stale cache entries from deleted files and keep the current index.', 'Проверьте записи кеша для удалённых файлов. Индекс существующих заметок сохранится.'))
            .addButton(button => button.setButtonText(t('Optimize Cache', 'Проверить кеш')).onClick(() => openCacheOptimization(rudonium)))
        new Setting(body)
            .setName(t('Clear File Hash Cache', 'Очистить кеш проверки файлов'))
            .setDesc(t('Clear saved file hashes and the fast-scan index. The next scan rechecks files in scope.', 'Удаляет хэши файлов и индекс быстрого прохода. При следующем экспорте выбранные файлы будут проверены заново.'))
            .addButton(button => button.setButtonText(t('Clear', 'Очистить')).setClass('mod-cta').onClick(() => clear('files')))
    }

    private sections(): SettingsSection[] {
        const plugin = this.rudonium
        const t = uiFor(plugin.settings)
        const section = (en: string, ru: string, aliases: string[], mount: SettingsSection['mount']): SettingsSection =>
            ({ name: t(en, ru), aliases, mount })
        return [
            section('Rudonium help', 'Помощь по Rudonium', ['GitFlic'],
                el => installSettingsHelp(el, plugin, this.containerEl)),
            section('Anki Connection', 'Подключение к Anki',
                ['AnkiConnect', t('Quick Start', 'Быстрый старт'), t('Card file migration', 'Перенос карточек из файлов')],
                el => this.setup_connection(el)),
            section('Sync settings', 'Настройки синхронизации',
                [t('Bidirectional sync', 'Двусторонняя синхронизация'), t('Change history', 'Журнал изменений'), t('Preview', 'Предпросмотр')],
                el => installBidirectionalSettings(el, plugin)),
            section('Note type rules', 'Правила типов записей', [t('Regular expressions', 'Регулярные выражения')],
                el => installNoteTypeRules(el, plugin)),
            section('Folder tags', 'Теги папок', [], el => installFolderTagSettings(el, plugin, 'FOLDER_TAGS')),
            section('Syntax Settings', 'Синтаксис карточек',
                Object.keys(plugin.settings.Syntax ?? {}).filter(key => !isLifecycleSyntax(key)).map(key => legacySettingLabel(key, t)),
                el => this.setup_syntax(el)),
            section('Defaults', 'Параметры по умолчанию', Object.keys(defaultDescs).map(key => legacySettingLabel(key, t)),
                el => this.setup_defaults(el)),
            section('Actions', 'Обслуживание', [t('File hash cache', 'Кеш проверки файлов'), t('Media', 'Вложения')],
                el => this.setup_buttons(el)),
            section('Ignored files', 'Исключённые файлы', [], el => installIgnoredFilesSetting(el, plugin)),
            section('Profiles and Deck Assignments', 'Профили и назначения колод', [], el => this.setupProfiles(el)),
            section('Sync and Review', 'Синхронизация и проверка',
                [t('Sync audit', 'Сверка с Anki'), t('Preview export', 'Предпросмотр экспорта')], el => this.setupReview(el)),
            section('Archives, Backup and Transfer', 'Архивы, резервные копии и перенос', ['ZIP'],
                (el, title) => renderSettingsGroup(el, plugin, 'archives-transfer', title, body => installZipImportSettings(body, plugin))),
            section('Image Optimization', 'Оптимизация изображений', [],
                (el, title) => renderSettingsGroup(el, plugin, 'image-optimization', title, body => installImageOptimizationSettings(body, plugin))),
            section('Anki ID Markers', 'Маркеры ID Anki', [], el => this.setupIdMarkers(el)),
            section('Card suspension, deletion and shared fields', 'Приостановка, удаление и общие поля',
                ['SUSPEND', 'DELETE', 'FROZEN'], el => installCardLifecycleSettings(el, plugin)),
            section('Interface and plugin information', 'Интерфейс и сведения о плагине', [t('Language', 'Язык')], (el, title) => {
                const info = createSettingsGroup(el, plugin, 'plugin-info', title)
                installInterfaceLanguage(info, plugin, () => this.redraw(), this.containerEl)
                installProjectInfo(info, plugin, RUDONIUM_BUILD_VERSION)
            }),
        ]
    }

    getSettingDefinitions() {
        return this.sections().map(({ name, aliases, mount }) => ({
            name, aliases,
            render: (row: Setting) => {
                finalizeSettingsLayout(this.containerEl, this.rudonium)
                row.settingEl.empty()
                row.settingEl.classList.add('rudonium-settings-section')
                mount(row.settingEl, name)
            },
        }))
    }

    private redraw(): void {
        saveSettingsLayout(this.containerEl, this.rudonium)
        const tab: SettingsTab & { update?(): void } = this
        if (tab.update) tab.update()
        else this.display()
    }

    setup_display(): void {
        saveSettingsLayout(this.containerEl, this.rudonium)
        this.containerEl.empty()
        for (const section of this.sections()) section.mount(this.containerEl, section.name)
        finalizeSettingsLayout(this.containerEl, this.rudonium)
    }

    hide(): void {
        saveSettingsLayout(this.containerEl, this.rudonium)
        this.containerEl.classList.remove('rudonium-settings-pane')
        super.hide()
    }

    display(): void {
        this.setup_display()
    }
}
