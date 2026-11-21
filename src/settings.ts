import { uiFor } from './interface-language'
import { bindSyntaxEdit, installCardLifecycleSettings } from './card-lifecycle-settings'
import { finalizeSettingsLayout } from './settings-layout'
import { installSettingsHeader, installProjectInfo, legacySettingLabel, legacySettingDescription } from './interface-settings-ui'
declare const RUDONIUM_BUILD_VERSION: string
import { installNoteTypeRules } from './note-type-rule-ui'
import { installFolderTagSettings } from './settings-search'
import { installNoteTypeRefresh } from './note-type-refresh'
import { previewVaultExport, withFastScanReadLock } from './fast-scan'
import { createSettingsGroup, renderSettingsGroup } from './settings-layout'
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
import { clearFastScanCache } from './fast-scan'
import { openCacheOptimization } from './cache-optimization-ui'
import { PluginSettingTab, Setting, Notice, TFolder } from 'obsidian'

const defaultDescs = {
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


export class SettingsTab extends PluginSettingTab {

	setup_custom_regexp(note_type: string, row_cells: HTMLCollection) {
		const plugin = (this as any).plugin
		let regexp_section = plugin.settings["CUSTOM_REGEXPS"]
		let custom_regexp = new Setting(row_cells[1] as HTMLElement)
			.addText(
					text => text.setValue(
					Object.prototype.hasOwnProperty.call(regexp_section, note_type) ? regexp_section[note_type] : ""
					)
					.onChange((value) => {
						plugin.settings["CUSTOM_REGEXPS"][note_type] = value
						plugin.saveAllData()
					})
			)
		custom_regexp.settingEl = row_cells[1] as HTMLElement
		custom_regexp.infoEl.remove()
		custom_regexp.controlEl.className += " anki-center"
	}

	setup_link_field(note_type: string, row_cells: HTMLCollection) {
		const plugin = (this as any).plugin
		let link_fields_section = plugin.settings.FILE_LINK_FIELDS
		let link_field = new Setting(row_cells[2] as HTMLElement)
			.addDropdown(
				async dropdown => {
					const field_names: string[] = plugin.fields_dict?.[note_type] ?? []
            if (!field_names.length) { dropdown.setDisabled(true); return }
					for (let field of field_names) {
						dropdown.addOption(field, field)
					}
					dropdown.setValue(
						Object.prototype.hasOwnProperty.call(link_fields_section, note_type) ? link_fields_section[note_type] : field_names[0]
					)
					dropdown.onChange((value) => {
						plugin.settings.FILE_LINK_FIELDS[note_type] = value
						plugin.saveAllData()
					})
				}
			)
		link_field.settingEl = row_cells[2] as HTMLElement
		link_field.infoEl.remove()
		link_field.controlEl.className += " anki-center"
	}

	setup_context_field(note_type: string, row_cells: HTMLCollection) {
		const plugin = (this as any).plugin
		let context_fields_section: Record<string, string> = plugin.settings.CONTEXT_FIELDS
		let context_field = new Setting(row_cells[3] as HTMLElement)
			.addDropdown(
				async dropdown => {
					const field_names: string[] = plugin.fields_dict?.[note_type] ?? []
            if (!field_names.length) { dropdown.setDisabled(true); return }
					for (let field of field_names) {
						dropdown.addOption(field, field)
					}
					dropdown.setValue(
						Object.prototype.hasOwnProperty.call(context_fields_section, note_type) ? context_fields_section[note_type] : field_names[0]
					)
					dropdown.onChange((value) => {
						plugin.settings.CONTEXT_FIELDS[note_type] = value
						plugin.saveAllData()
					})
				}
			)
		context_field.settingEl = row_cells[3] as HTMLElement
		context_field.infoEl.remove()
		context_field.controlEl.className += " anki-center"
	}

	create_collapsible(name: string) {
		let {containerEl} = this;
		let div = containerEl.createEl('div', {cls: "collapsible-item"})
		const row = div.createDiv({ cls: "collapsible-item-self" })
		const arrow = row.createDiv({ cls: ["collapsible-item-collapse", "collapse-icon", "anki-rotated"] })
		const svg = arrow.createSvg("svg", { cls: "right-triangle", attr: {
			viewBox: "0 0 100 100", width: "8", height: "8", "aria-hidden": "true"
		} })
		svg.createSvg("path", { attr: { fill: "currentColor", stroke: "currentColor",
			d: "M94.9,20.8c-1.4-2.5-4.1-4.1-7.1-4.1H12.2c-3,0-5.7,1.6-7.1,4.1c-1.3,2.4-1.2,5.2,0.2,7.6L43.1,88c1.5,2.3,4,3.7,6.9,3.7 s5.4-1.4,6.9-3.7l37.8-59.6C96.1,26,96.2,23.2,94.9,20.8L94.9,20.8z"
		} })
		row.createDiv({ cls: "collapsible-item-inner" })
		row.createEl("header", { text: name })
		div.addEventListener('click', function () {
			this.classList.toggle("active")
			let icon = this.firstElementChild.firstElementChild as HTMLElement
			icon.classList.toggle("anki-rotated")
			let content = this.nextElementSibling as HTMLElement
			content.classList.toggle('rudonium-settings-expanded')
		})
	}

	setup_note_table() {
		let {containerEl} = this;
		const plugin = (this as any).plugin
		new Setting(containerEl).setName('Note type settings').setHeading()
		this.create_collapsible("Note Type Table")
		let note_type_table = containerEl.createEl('table', {cls: "anki-settings-table"})
		let head = note_type_table.createTHead()
		let header_row = head.insertRow()
		for (let header of ["Note Type", "Custom Regexp", "File Link Field", "Context Field"]) {
			header_row.createEl("th", { text: header })
		}
		let main_body = note_type_table.createTBody()
		if (!(plugin.settings.hasOwnProperty("CONTEXT_FIELDS"))) {
			plugin.settings.CONTEXT_FIELDS = {}
		}
		for (let note_type of plugin.note_types) {
			let row = main_body.insertRow()

			row.insertCell()
			row.insertCell()
			row.insertCell()
			row.insertCell()

			let row_cells = row.children

			row_cells[0].textContent = note_type
			this.setup_custom_regexp(note_type, row_cells)
			this.setup_link_field(note_type, row_cells)
			this.setup_context_field(note_type, row_cells)
		}
	}

	setup_syntax() {
		let {containerEl} = this;
		const plugin = (this as any).plugin
		const syntax = containerEl.createEl('details', { cls: 'anki-settings-disclosure' })
        syntax.createEl('summary', { text: uiFor(plugin.settings)('Syntax Settings', 'Синтаксис карточек') })
        const syntax_settings = syntax.createDiv()
		for (let key of Object.keys(plugin.settings["Syntax"])) {
            if (key === 'Suspend Line' || key === 'Suspend Line Aliases') continue
			new Setting(syntax_settings)
				.setName(legacySettingLabel(key, uiFor(plugin.settings)))
				.addText(
						text => bindSyntaxEdit(text, plugin, key)
				)
		}
	}

	setup_defaults() {
		let {containerEl} = this;
		const plugin = (this as any).plugin

		// To account for new add context
		if (!(plugin.settings["Defaults"].hasOwnProperty("Add Context"))) {
			plugin.settings["Defaults"]["Add Context"] = false
		}
		// To account for new scheduling interval
		if (!(plugin.settings["Defaults"].hasOwnProperty("Scheduling Interval"))) {
			plugin.settings["Defaults"]["Scheduling Interval"] = 0
		}
		// To account for new highlights to clozes
		if (!(plugin.settings["Defaults"].hasOwnProperty("CurlyCloze - Highlights to Clozes"))) {
			plugin.settings["Defaults"]["CurlyCloze - Highlights to Clozes"] = false
		}
		// To account for new add obsidian tags
		if (!(plugin.settings["Defaults"].hasOwnProperty("Add Obsidian Tags"))) {
			plugin.settings["Defaults"]["Add Obsidian Tags"] = false
		}
		plugin.settings["Defaults"]["Add Date to Anki IDs"] ??= false
        const t = uiFor(plugin.settings)
        new Setting(this.containerEl).setName(t('Defaults', 'Параметры по умолчанию')).setHeading()
        const defaults_settings = this.containerEl.createDiv()
        installDefaultDeckSetting(defaults_settings, plugin)
        for (let key of Object.keys(plugin.settings["Defaults"])) {
            if (key === "Deck") continue
			// To account for removal of regex setting
			if (key === "Regex") {
				continue
			}
			if (typeof plugin.settings["Defaults"][key] === "string") {
				new Setting(defaults_settings)
					.setName(legacySettingLabel(key, uiFor(plugin.settings)))
					.setDesc(legacySettingDescription(key, defaultDescs[key], uiFor(plugin.settings)))
					.addText(
						text => text.setValue(plugin.settings["Defaults"][key])
						.onChange((value) => {
							plugin.settings["Defaults"][key] = value
							plugin.saveAllData()
						})
				)
			} else if (typeof plugin.settings["Defaults"][key] === "boolean") {
				new Setting(defaults_settings)
					.setName(legacySettingLabel(key, uiFor(plugin.settings)))
					.setDesc(legacySettingDescription(key, defaultDescs[key], uiFor(plugin.settings)))
					.addToggle(
						toggle => toggle.setValue(plugin.settings["Defaults"][key])
						.onChange((value) => {
							plugin.settings["Defaults"][key] = value
							plugin.saveAllData()
						})
					)
			} else {
				new Setting(defaults_settings)
					.setName(legacySettingLabel(key, uiFor(plugin.settings)))
					.setDesc(legacySettingDescription(key, defaultDescs[key], uiFor(plugin.settings)))
					.addSlider(
						slider => {
							slider.setValue(plugin.settings["Defaults"][key])
							.setLimits(0, 360, 5)
							.setDynamicTooltip()
							.onChange(async (value) => {
								plugin.settings["Defaults"][key] = value
								await plugin.saveAllData()
								if (plugin.hasOwnProperty("schedule_id")) {
									window.clearInterval(plugin.schedule_id)
								}
								if (value != 0) {
									plugin.schedule_id = window.setInterval(async () => await plugin.scanVault(), value * 1000 * 60)
									plugin.registerInterval(plugin.schedule_id)
								}

							})
					}
					)
			}
		}
	}

	get_folders(): TFolder[] {
		const app = (this as any).plugin.app
		let folder_list: TFolder[] = [app.vault.getRoot()]
		for (let folder of folder_list) {
			let filtered_list: TFolder[] = folder.children.filter((element) => element.hasOwnProperty("children")) as TFolder[]
			folder_list.push(...filtered_list)
		}
		return folder_list.slice(1) //Removes initial vault folder
	}

	

	setup_folder_tag(folder: TFolder, row_cells: HTMLCollection) {
		const plugin = (this as any).plugin
		let folder_tags = plugin.settings.FOLDER_TAGS
		if (!(folder_tags.hasOwnProperty(folder.path))) {
			folder_tags[folder.path] = ""
		}
		let folder_tag = new Setting(row_cells[1] as HTMLElement)
			.addText(
				text => text.setValue(folder_tags[folder.path])
				.onChange((value) => {
					plugin.settings.FOLDER_TAGS[folder.path] = value
					plugin.saveAllData()
				})
			)
		folder_tag.settingEl = row_cells[1] as HTMLElement
		folder_tag.infoEl.remove()
		folder_tag.controlEl.className += " anki-center"
	}

	setup_folder_table() {
		let {containerEl} = this;
		const plugin = (this as any).plugin
		const folder_list = this.get_folders()
		new Setting(containerEl).setName('Folder settings').setHeading()
		this.create_collapsible("Folder Table")
		let folder_table = containerEl.createEl('table', {cls: "anki-settings-table"})
		let head = folder_table.createTHead()
		let header_row = head.insertRow()
		for (let header of ["Folder", "Folder Tags"]) {
			header_row.createEl("th", { text: header })
		}
		let main_body = folder_table.createTBody()
		if (!(plugin.settings.hasOwnProperty("FOLDER_DECKS"))) {
			plugin.settings.FOLDER_DECKS = {}
		}
		if (!(plugin.settings.hasOwnProperty("FOLDER_TAGS"))) {
			plugin.settings.FOLDER_TAGS = {}
		}
		for (let folder of folder_list) {
			let row = main_body.insertRow()

			row.insertCell()
			row.insertCell()

			let row_cells = row.children

			row_cells[0].textContent = folder.path
			this.setup_folder_tag(folder, row_cells)
		}

	}

	setup_workflows() {
        const {containerEl} = this
        const plugin = (this as any).plugin
        const t = uiFor(plugin.settings)
        new Setting(containerEl).setName(t('Additional tools', 'Дополнительные инструменты')).setHeading()
        const connectionBody = createSettingsGroup(containerEl, plugin, 'connection', t('Anki Connection', 'Подключение к Anki'))
        installFirstRunSetting(connectionBody, plugin, task => withFastScanReadLock(plugin, task), () => this.setup_display())
        installPageMigrationSetting(connectionBody, plugin)
        const profileBody = createSettingsGroup(containerEl, plugin, 'profiles-and-routing', t('Profiles and Deck Assignments', 'Профили и назначения колод'))
        installAnkiProfileSettings(profileBody, plugin)
        installSyncProfileSettings(profileBody, plugin)
        installDeckRoutingSettings(profileBody, plugin)
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
        installBidirectionalSettings(syncBody, plugin)
        renderSettingsGroup(containerEl, plugin, 'archives-transfer', t('Archives, Backup and Transfer', 'Архивы, резервные копии и перенос'), body => installZipImportSettings(body, plugin))
        renderSettingsGroup(containerEl, plugin, 'image-optimization', t('Image Optimization', 'Оптимизация изображений'), body => installImageOptimizationSettings(body, plugin))
        installIdMarkerSettings(containerEl, plugin, {
            toComment: () => openIdMarkerConversion(plugin, 'to-comment'),
            toPlain: () => openIdMarkerConversion(plugin, 'to-plain'),
            moveVaultPages: () => openPageIdBulk(plugin),
            foldingChanged: () => refreshEditorIdFolding(plugin),
        })
    }

    setup_buttons() {
		let {containerEl} = this
		const plugin = (this as any).plugin
		
        const t = uiFor(plugin.settings)
        new Setting(containerEl).setName(t('Actions', 'Обслуживание')).setHeading()
        let action_buttons = containerEl.createDiv()
		installNoteTypeRefresh(containerEl, action_buttons, plugin, () => this.setup_display())
        new Setting(action_buttons)
			.setName(t("Clear Media Cache", "Очистить кеш вложений"))
			.setDesc(t("Clear the cached list of media previously sent to Anki.", "Удаляет из кеша список ранее отправленных вложений."))
			.addButton(
				button => {
					button.setButtonText(t("Clear", "Очистить")).setClass("mod-cta")
					.onClick(async () => {
						// Сброс кеша медиа ждёт завершения текущего сканирования.
                    await clearFastScanCache(plugin, 'media')})
				}
			)
		new Setting(action_buttons)
            .setName(t("Optimize Cache", "Оптимизировать кеш"))
            .setDesc(t("Review stale cache entries from deleted files and keep the current index.", "Проверьте записи кеша для удалённых файлов. Индекс существующих заметок сохранится."))
            .addButton(button => button.setButtonText(t("Optimize Cache", "Проверить кеш")).onClick(() => openCacheOptimization(plugin)))
        new Setting(action_buttons)
			.setName(t("Clear File Hash Cache", "Очистить кеш проверки файлов"))
			.setDesc(t("Clear saved file hashes and the fast-scan index. The next scan rechecks files in scope.", "Удаляет хэши файлов и индекс быстрого прохода. При следующем экспорте выбранные файлы будут проверены заново."))
			.addButton(
				button => {
					button.setButtonText(t("Clear", "Очистить")).setClass("mod-cta")
					.onClick(async () => {
						// Сбрасываем оба уровня кеша файлов, чтобы следующая проверка прочитала заметки заново.
                    await clearFastScanCache(plugin, 'files')})
				}
			)
	}
	

	setup_display() {
		let {containerEl} = this

		containerEl.empty()
		new Setting(containerEl).setName(uiFor((this as any).plugin.settings)('Rudonium Anki Toolkit settings', 'Настройки Rudonium Anki Toolkit')).setHeading()
		containerEl.createEl('a', {text: 'For more information check the wiki', href: "https://github.com/Pseudonium/Obsidian_to_Anki/wiki"})
		installNoteTypeRules(containerEl, (this as any).plugin)
		installFolderTagSettings(containerEl, (this as any).plugin, "FOLDER_TAGS")
		this.setup_syntax()
		this.setup_defaults()
		this.setup_buttons()
        this.setup_workflows()
        installSettingsHeader(this.containerEl, (this as any).plugin, () => this.setup_display())
        installCardLifecycleSettings(this.containerEl, (this as any).plugin)
        installProjectInfo(this.containerEl, (this as any).plugin, RUDONIUM_BUILD_VERSION)
        finalizeSettingsLayout(this.containerEl, (this as any).plugin)
	}

	async display() {
		this.setup_display()
	}
}
