import { uiFor } from './src/interface-language'
import { openAuditForExportIssue, startSyncAudit, openSyncAuditDeckPicker } from './src/sync-audit-ui'
import { openPageMigration, registerPageMigrationCommand } from './src/page-migration-ui'
import { registerSupportCommand } from './src/interface-settings-ui'
import { registerFrozenFieldsCommand } from './src/frozen-fields-ui'
import { registerLostIdRecoveryCommand } from './src/lost-id-recovery-ui'
import { registerCardPreview } from './src/card-preview'
import { registerZipImport } from './src/zip-import-ui'
import { registerEditorCardWarnings } from './src/editor-card-warnings'
import { registerArchivedCardDisplay } from './src/archived-card-display'
import { registerEditorIdFolding } from './src/editor-id-folding'
import { registerIdMarkerConversion } from './src/id-marker-conversion-ui'
import { registerPageIdBulk } from './src/page-id-bulk-ui'
import { registerPageFieldEditor } from './src/page-field-editor-ui'
import { registerOpenCardInAnki } from './src/card-open-anki'
import { pauseForMigration } from './src/plugin-migration'
import { refreshNoteTypes } from './src/note-type-refresh'
import { registerSetupCommand } from './src/first-connection'
import { openDuplicateIdReview, registerFastScan, savePluginDataInOrder, scanVaultFast, withFastScanReadLock } from './src/fast-scan'
import { registerCardSourceLinks } from './src/card-source-links'
import { Notice, Plugin, addIcon } from 'obsidian'
import * as AnkiConnect from './src/anki'
import { PluginSettings } from './src/interfaces/settings-interface'
import { SettingsTab } from './src/settings'
import { ANKI_ICON } from './src/constants'

export default class MyPlugin extends Plugin {

	settings: PluginSettings
	note_types: Array<string>
	fields_dict: Record<string, string[]>
	added_media: string[]
	file_hashes: Record<string, string>

	async getDefaultSettings(): Promise<PluginSettings> {
		let settings: PluginSettings = {
			CUSTOM_REGEXPS: {},
			FILE_LINK_FIELDS: {},
			CONTEXT_FIELDS: {},
			FOLDER_DECKS: {},
			FOLDER_TAGS: {},
			Syntax: {
				"Begin Note": "START",
				"End Note": "END",
				"Begin Inline Note": "STARTI",
				"End Inline Note": "ENDI",
				"Target Deck Line": "TARGET DECK",
				"File Tags Line": "FILE TAGS",
				"Delete Note Line": "DELETE",
				"Suspend Line": "SUSPEND",
				"Frozen Fields Line": "FROZEN"
			},
			EXPECTED_ANKI_PROFILE: "",
			REQUIRE_ANKI_PROFILE: false,
			BIDIRECTIONAL_SYNC: false,
			BIDIRECTIONAL_PREVIEW: false,
			SKIP_SYNC_ERRORS: false,
			INTERFACE_LANGUAGE: "en",
			PAGE_ID_LOCATION: "yaml",
			COLLAPSE_ANKI_IDS: false,
			CLEAN_DELETED_BLOCKS: false,
			MARK_DELETED_BLOCKS: false,
			TRASH_DELETED_PAGES: false,
			Defaults: {
				"Tag": "",
				"Deck": "Default",
				"Scheduling Interval": 0,
				"Add File Link": false,
				"Add Context": false,
				"CurlyCloze": false,
				"CurlyCloze - Highlights to Clozes": false,
				"ID Comments": true,
				"Add Date to Anki IDs": false,
				"Add Obsidian Tags": false,
			},
		}
		this.note_types = []
        this.fields_dict = {}
        settings.CUSTOM_REGEXPS = {}
        settings.FILE_LINK_FIELDS = {}
        return settings
	}

	async generateFieldsDict(): Promise<Record<string, string[]>> {
		let fields_dict = {}
		for (let note_type of this.note_types) {
			const field_names: string[] = await AnkiConnect.invoke(
				'modelFieldNames', {modelName: note_type}
			) as string[]
			fields_dict[note_type] = field_names
		}
		return fields_dict
	}

	async saveDefault(): Promise<void> {
		const default_sets = await this.getDefaultSettings()
		this.saveData(
			{
				settings: default_sets,
				"Added Media": [],
				"File Hashes": {},
				fields_dict: {}
			}
		)
	}

	async loadSettings(): Promise<PluginSettings> {
		let current_data = await this.loadData()
		if (current_data == null || (typeof current_data === 'object' && !Array.isArray(current_data) && Object.keys(current_data).length === 0)) {
			const default_sets = await this.getDefaultSettings()
			await this.saveData(
				{
					settings: default_sets,
					"Added Media": [],
					"File Hashes": {},
					fields_dict: {}
				}
			)
			return default_sets
		} else {
			if (!current_data.settings || typeof current_data.settings !== "object" || Array.isArray(current_data.settings) ||
                !Array.isArray(current_data["Added Media"]) || !current_data["File Hashes"] ||
                typeof current_data["File Hashes"] !== "object" || Array.isArray(current_data["File Hashes"]) ||
                !current_data.fields_dict || typeof current_data.fields_dict !== "object" || Array.isArray(current_data.fields_dict)) {
                const message = uiFor(current_data.settings)(
                    "Invalid plugin data.json. Restore the settings file from a backup, then enable the plugin again.",
                    "Повреждены настройки плагина. Восстановите data.json из резервной копии и снова включите плагин.")
                throw Object.assign(new Error(message), { name: "InvalidRudoniumPluginData" })
            }
            this.rudoniumDataExtras = this.extraDataKeys(current_data)
            const settings: PluginSettings & {
                IGNORED_FILE_GLOBS?: string[]
                Defaults: { "Scan Directory"?: string }
            } = current_data.settings
            delete settings.IGNORED_FILE_GLOBS
            delete settings.Defaults?.["Scan Directory"]
            if (settings.Defaults && settings.Defaults.Tag == null) settings.Defaults.Tag = ""
            return settings
		}
	}

	async loadAddedMedia(): Promise<string[]> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			return []
		} else {
			return current_data["Added Media"]
		}
	}

	async loadFileHashes(): Promise<Record<string, string>> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			return {}
		} else {
			return current_data["File Hashes"]
		}
	}

	async loadFieldsDict(): Promise<Record<string, string[]>> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			const fields_dict = await this.generateFieldsDict()
			return fields_dict
		}
		return current_data.fields_dict
	}

	private rudoniumDataExtras: Record<string, unknown> = {}

    private extraDataKeys(data: object): Record<string, unknown> {
        return Object.fromEntries(Object.entries(data).filter(([key]) =>
            key !== "settings" && key !== "Added Media" && key !== "File Hashes" && key !== "fields_dict"))
    }

    async saveData(data: unknown): Promise<void> {
        if (!data || typeof data !== "object" || Array.isArray(data)) return super.saveData(data)
        const merged = { ...this.rudoniumDataExtras, ...data }
        await super.saveData(merged)
        this.rudoniumDataExtras = this.extraDataKeys(merged)
    }

    async saveAllData(): Promise<void> {
        // Сохранения от сканирования и настроек выполняются по очереди.
        await savePluginDataInOrder(this, async () => {
    		await this.saveData(
    				{
    					settings: this.settings,
    					"Added Media": this.added_media,
    					"File Hashes": this.file_hashes,
    					fields_dict: this.fields_dict
    				}
    		)
        })
    }

	regenerateSettingsRegexps() {
		let regexp_section = this.settings["CUSTOM_REGEXPS"]
		// For new note types
		for (let note_type of this.note_types) {
			this.settings["CUSTOM_REGEXPS"][note_type] = regexp_section.hasOwnProperty(note_type) ? regexp_section[note_type] : ""
		}
		// Removing old note types
		for (let note_type of Object.keys(this.settings["CUSTOM_REGEXPS"])) {
			if (!this.note_types.includes(note_type)) {
				delete this.settings["CUSTOM_REGEXPS"][note_type]
			}
		}
	}



	async scanVault() {
        // Существующая команда передаёт управление ускоренному сканированию.
        await scanVaultFast(this)
    }

	async onload() {
        if (await pauseForMigration(this, () => this.startRudonium(), () => { if (this.rudoniumInitialized && !this.rudoniumStopped) openPageMigration(this) })) return
        await this.startRudonium()
    }

    private rudoniumInitialized = false
    private rudoniumStopped = false

    private async startRudonium(): Promise<void> {
        if (this.rudoniumStopped) return
        await this.initializeRudonium()
    }

    private async initializeRudonium(): Promise<void> {
        if (this.rudoniumStopped) return

		console.log('loading Obsidian_to_Anki...');
		addIcon('anki', ANKI_ICON)

		try {
			this.settings = await this.loadSettings()
		
        if (this.rudoniumStopped) return
}
		catch(e) {
        if (this.rudoniumStopped) return
        if (e instanceof Error && e.name === 'InvalidRudoniumPluginData') { new Notice(e.message, 12000); return }

			new Notice(uiFor(this.settings)("Couldn't connect to Anki! Check console for error message.", "Нет связи с Anki. Откройте Anki и проверьте AnkiConnect."))
			return
		}

		this.note_types = Object.keys(this.settings["CUSTOM_REGEXPS"])
		this.fields_dict = await this.loadFieldsDict()
		
        if (this.rudoniumStopped) return
this.added_media = await this.loadAddedMedia()
		
        if (this.rudoniumStopped) return
this.file_hashes = await this.loadFileHashes()
        if (this.rudoniumStopped) return
        // После загрузки хешей включаем отслеживание файлов и команду полной проверки.
        registerFastScan(this, (deck, repair) => { void openAuditForExportIssue(this, deck, repair) }, () => refreshNoteTypes(this))
        registerSetupCommand(this, task => withFastScanReadLock(this, task), () => this.rudoniumStopped)
        registerCardPreview(this)
        registerSupportCommand(this)
        registerPageMigrationCommand(this)
        registerLostIdRecoveryCommand(this)
        registerFrozenFieldsCommand(this)
        registerZipImport(this)
        registerEditorCardWarnings(this)
        registerEditorIdFolding(this)
        registerArchivedCardDisplay(this)
        registerIdMarkerConversion(this)
        registerPageIdBulk(this)
        registerPageFieldEditor(this)
        registerOpenCardInAnki(this)
        registerCardSourceLinks(this, () => this.settings.Syntax, id => openDuplicateIdReview(this, id), () => uiFor(this.settings))
        this.addCommand({ id: 'anki-sync-audit-default-deck', name: uiFor(this.settings)('Check Default Deck with Anki', 'Сверить колоду по умолчанию с Anki'),
            callback: () => startSyncAudit(this) })
        this.addCommand({ id: 'anki-sync-audit-choose-deck', name: uiFor(this.settings)('Choose Deck to Check with Anki', 'Выбрать колоду для сверки с Anki'),
            callback: () => openSyncAuditDeckPicker(this) })

		this.addSettingTab(new SettingsTab(this.app, this));

		this.addRibbonIcon('anki', uiFor(this.settings)('Obsidian_to_Anki - Scan Vault', 'Экспортировать хранилище в Anki'), async () => {
			await this.scanVault()
		})

		this.addCommand({
			id: 'anki-scan-vault',
			name: uiFor(this.settings)('Scan Vault', 'Экспортировать хранилище в Anki'),
			callback: async () => {
			 	await this.scanVault()
			 }
		})
        this.rudoniumInitialized = true
    }

	async onunload() {
        this.rudoniumStopped = true
        if (!this.rudoniumInitialized) return

		console.log("Saving settings for Obsidian_to_Anki...")
		this.saveAllData()
		console.log('unloading Obsidian_to_Anki...');
	}
}
