import { FIELDS_DICT } from './field-interface'
import { AnkiConnectNote } from './note-interface'

export interface PluginSettings {
    NOTE_TYPE_RULE_MODELS?: string[]
    NOTE_TYPE_RULE_NAMES?: Record<string, string>
    INACTIVE_CUSTOM_REGEXPS?: Record<string, string>
    REGEXP_WIZARD_FIELDS?: Record<string, string[]>
    PAGE_MODEL?: string
    PAGE_ID_LOCATION?: "heading" | "yaml" | "after-answer"
    AUDIT_READ_ONLY?: boolean
    SYNC_CHANGE_HISTORY?: boolean
    BIDIRECTIONAL_SYNC?: boolean
    BIDIRECTIONAL_PREVIEW?: boolean
    BIDIRECTIONAL_CONFLICT_POLICY?: "latest" | "skip"
    SKIP_SYNC_ERRORS?: boolean
    LEGACY_IGNORED_FILE_GLOBS?: string[]
    SYNC_FOLDER_PROFILES?: import("../sync-profiles").SyncFolderProfile[]
    ACTIVE_SYNC_FOLDER_PROFILE?: string
    EFFECTIVE_EXPORT_RULES?: import("../export-rules").ExportRule[]
    BIDIRECTIONAL_FIELDS?: import("../bidirectional-fields").BidirectionalFieldRule[]
    FOLDER_DEFAULT_DECKS?: Record<string, boolean>
    IMAGE_OPTIMIZATION?: import("../image-optimizer").ImageOptimizationSettings
    VAULT_BACKUP?: import("../vault-backup").BackupSettings
    ARCHIVE_TRANSFER?: import("../archive-settings").ArchiveTransferSettings
    EXPECTED_ANKI_PROFILE?: string
    REQUIRE_ANKI_PROFILE?: boolean
    COLLAPSE_ANKI_IDS?: boolean
    CLEAN_DELETED_BLOCKS?: boolean
    MARK_DELETED_BLOCKS?: boolean
    AFTER_DELETE_MODE?: import("../deletion-policy").AfterDeleteMode
    TRASH_DELETED_PAGES?: boolean
    INTERFACE_LANGUAGE?: import("../interface-language").InterfaceLanguage
	CUSTOM_REGEXPS: Record<string, string>,
	FILE_LINK_FIELDS: Record<string, string>,
	CONTEXT_FIELDS: Record<string, string>,
	FOLDER_DECKS: Record<string, string>,
	FOLDER_TAGS: Record<string, string>,
	Syntax: {
		"Begin Note": string,
		"End Note": string,
		"Begin Inline Note": string,
		"End Inline Note": string,
		"Target Deck Line": string,
		"File Tags Line": string,
		"Delete Note Line": string,
		"Suspend Line"?: string,
		"Suspend Line Aliases"?: string,
		"Frozen Fields Line": string
	},
	Defaults: {
		"Tag": string,
		"Deck": string,
		"Scheduling Interval": number
		"Add File Link": boolean,
		"Add Context": boolean,
		"CurlyCloze": boolean,
		"CurlyCloze - Highlights to Clozes": boolean,
		"ID Comments": boolean,
		"Add Date to Anki IDs"?: boolean,
		"Add Obsidian Tags": boolean
	},
}

export interface FileData {
	//All the data that a file would need.
	fields_dict: FIELDS_DICT
	custom_regexps: Record<string, string>
	file_link_fields: Record<string, string>
	context_fields: Record<string, string>
	template: AnkiConnectNote
	EXISTING_IDS: number[]
	vault_name: string

	FROZEN_REGEXP: RegExp
	DECK_REGEXP: RegExp
	TAG_REGEXP: RegExp
	NOTE_REGEXP: RegExp
	INLINE_REGEXP: RegExp
	EMPTY_REGEXP: RegExp

	curly_cloze: boolean
	highlights_to_cloze: boolean
	comment: boolean
	id_date?: boolean
	page_model?: string
	page_id_location?: "heading" | "yaml" | "after-answer"
	folder_default_decks?: Record<string, boolean>
	export_rules?: import("../export-rules").ExportRule[]
	add_context: boolean
	add_obs_tags: boolean
}

export interface ParsedSettings extends FileData {
	add_file_link: boolean
	folder_decks: Record<string, string>
	folder_tags: Record<string, string>
}
