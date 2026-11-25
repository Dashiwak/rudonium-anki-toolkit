import { uiFor } from './src/interface-language'
import { openAuditForExportIssue, startSyncAudit, openSyncAuditDeckPicker } from './src/sync-audit-ui'
import { registerPageMigrationCommand } from './src/page-migration-ui'
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
import multimatch from 'multimatch'
import { importLegacyScanScope } from './src/sync-profiles'
import { pauseForMigration } from './src/plugin-migration'
import { refreshNoteTypes } from './src/note-type-refresh'
import { registerSetupCommand } from './src/first-connection'
import type { CursorCardTarget } from './src/cursor-card'
import { openDuplicateIdReview, previewVaultExport, registerFastScan, savePluginDataInOrder, scanVaultFast, withFastScanReadLock } from './src/fast-scan'
import { registerCardSourceLinks } from './src/card-source-links'
import { Notice, Plugin, addIcon } from 'obsidian'
import * as AnkiConnect from './src/anki'
import { PluginSettings } from './src/interfaces/settings-interface'
import { SettingsTab } from './src/settings'
import { ANKI_ICON } from './src/constants'

type DataRecord = Record<string, unknown>

function isDataRecord(value: unknown): value is DataRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isStringMap(value: unknown): value is Record<string, string> {
    return isDataRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function isFieldMap(value: unknown): value is Record<string, string[]> {
    return isDataRecord(value) && Object.values(value).every(isStringList)
}

function validSection(values: DataRecord, defaults: DataRecord): boolean {
    return Object.entries(defaults).every(([key, value]) =>
        !Object.prototype.hasOwnProperty.call(values, key) || typeof values[key] === typeof value)
}

function invalidPluginData(settings?: unknown): Error {
    const language = isDataRecord(settings) && settings.INTERFACE_LANGUAGE === 'ru' ? 'ru' : 'en'
    const message = uiFor({ INTERFACE_LANGUAGE: language })(
        "Invalid plugin data.json. Restore the settings file from a backup, then enable the plugin again.",
        "Повреждены настройки плагина. Восстановите data.json из резервной копии и снова включите плагин.")
    return Object.assign(new Error(message), { name: "InvalidRudoniumPluginData" })
}

export default class RudoniumAnkiPlugin extends Plugin {

    readonly matchIgnoredPaths = multimatch

	settings: PluginSettings
	note_types: string[] = []
	fields_dict: Record<string, string[]> = {}
	added_media: string[]
	file_hashes: Record<string, string>

	async getDefaultSettings(): Promise<PluginSettings> {
		const settings: PluginSettings = {
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
			SYNC_CHANGE_HISTORY: false,
			BIDIRECTIONAL_SYNC: false,
			BIDIRECTIONAL_PREVIEW: false,
			BIDIRECTIONAL_CONFLICT_POLICY: "latest",
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
		return settings
	}

	async generateFieldsDict(): Promise<Record<string, string[]>> {
		const fields_dict: Record<string, string[]> = {}
		for (let note_type of this.note_types) {
			const field_names = await AnkiConnect.invoke('modelFieldNames', { modelName: note_type })
			if (!isStringList(field_names)) throw new Error('Anki returned invalid field names.')
			fields_dict[note_type] = field_names
		}
		return fields_dict
	}

	async saveDefault(): Promise<void> {
		const default_sets = await this.getDefaultSettings()
		await this.saveData(
			{
				settings: default_sets,
				"Added Media": [],
				"File Hashes": {},
				fields_dict: {}
			}
		)
	}

    private async readSavedData() {
        const data: unknown = await this.loadData()
        if (data == null || (isDataRecord(data) && Object.keys(data).length === 0)) return undefined
        if (!isDataRecord(data) || !isDataRecord(data.settings) ||
            !isStringList(data["Added Media"]) || !isStringMap(data["File Hashes"]) || !isFieldMap(data.fields_dict)) {
            throw invalidPluginData(isDataRecord(data) ? data.settings : undefined)
        }
        return { data, settings: data.settings, media: data["Added Media"], hashes: data["File Hashes"], fields: data.fields_dict }
    }

    async loadSettings(): Promise<PluginSettings> {
        const saved = await this.readSavedData()
        const defaults = await this.getDefaultSettings()
        if (!saved) {
            this.note_types = []
            this.fields_dict = {}
            this.added_media = []
            this.file_hashes = {}
            await this.saveData({ settings: defaults, "Added Media": this.added_media, "File Hashes": this.file_hashes, fields_dict: this.fields_dict })
            return defaults
        }

        // Read one consistent snapshot for settings and caches, including keys saved by newer versions.
        const options = { ...saved.settings }
        const syntax = options.Syntax ?? {}
        const preferences = options.Defaults ?? {}
        if (!isDataRecord(syntax) || !isDataRecord(preferences)) throw invalidPluginData(options)
        const tag = preferences.Tag ?? ""
        if (typeof tag !== "string") throw invalidPluginData(options)
        const values: DataRecord = { ...preferences, Tag: tag }
        importLegacyScanScope(options, values)
        if (!validSection(syntax, defaults.Syntax) || !validSection(values, defaults.Defaults)) throw invalidPluginData(options)
        for (const key of ["CUSTOM_REGEXPS", "FILE_LINK_FIELDS", "CONTEXT_FIELDS", "FOLDER_DECKS", "FOLDER_TAGS"]) {
            if (key in options && !isStringMap(options[key])) throw invalidPluginData(options)
        }
        for (const [key, value] of Object.entries(defaults)) {
            if (typeof value === 'boolean' && key in options && typeof options[key] !== 'boolean') throw invalidPluginData(options)
        }
        this.rudoniumDataExtras = this.extraDataKeys(saved.data)
        this.fields_dict = saved.fields
        this.added_media = saved.media
        this.file_hashes = saved.hashes
        return { ...defaults, ...options, Syntax: { ...defaults.Syntax, ...syntax },
            Defaults: { ...defaults.Defaults, ...values, Tag: tag } }
    }

    async loadAddedMedia(): Promise<string[]> {
        const saved = await this.readSavedData()
        if (saved) return saved.media
        await this.saveDefault()
        return []
    }

    async loadFileHashes(): Promise<Record<string, string>> {
        const saved = await this.readSavedData()
        if (saved) return saved.hashes
        await this.saveDefault()
        return {}
    }

    async loadFieldsDict(): Promise<Record<string, string[]>> {
        const saved = await this.readSavedData()
        if (saved) return saved.fields
        await this.saveDefault()
        return this.generateFieldsDict()
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
			this.settings["CUSTOM_REGEXPS"][note_type] = Object.prototype.hasOwnProperty.call(regexp_section, note_type) ? regexp_section[note_type] : ""
		}
		// Removing old note types
		for (let note_type of Object.keys(this.settings["CUSTOM_REGEXPS"])) {
			if (!this.note_types.includes(note_type)) {
				delete this.settings["CUSTOM_REGEXPS"][note_type]
			}
		}
	}



    previewCursorExport(source: string, target: CursorCardTarget): Promise<void> {
        return previewVaultExport(this, undefined, new Set([source]), target)
    }

	async scanVault(origin?: 'scheduled') {
        await scanVaultFast(this, origin)
    }

	onload(): void {
        void this.loadRudonium().catch((error: unknown) => {
            if (this.rudoniumStopped) return
            console.error('[Rudonium] Could not start plugin', error)
            new Notice(uiFor(this.settings)('Could not start Rudonium. See the console for details.',
                'Не удалось запустить Rudonium. Подробности в консоли.'))
        })
    }

    private async loadRudonium(): Promise<void> {
        if (await pauseForMigration(this, () => this.startRudonium())) return
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

		addIcon('anki', ANKI_ICON)

        try {
            this.settings = await this.loadSettings()
        } catch (error) {
            if (this.rudoniumStopped) return
            if (error instanceof Error && error.name === 'InvalidRudoniumPluginData') new Notice(error.message, 12000)
            else {
                console.error('[Rudonium] Could not load plugin settings', error)
                new Notice(uiFor(this.settings)('Could not load Rudonium settings.', 'Не удалось загрузить настройки Rudonium.'))
            }
            return
        }
        if (this.rudoniumStopped) return
        this.note_types = Object.keys(this.settings.CUSTOM_REGEXPS)
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

    onunload(): void {
        this.rudoniumStopped = true
        if (!this.rudoniumInitialized) return
        void this.saveAllData().catch(error => {
            console.error('[Rudonium] Could not save plugin data during unload', error)
            new Notice(uiFor(this.settings)('Could not save Rudonium settings.', 'Не удалось сохранить настройки Rudonium.'))
        })
    }
}
