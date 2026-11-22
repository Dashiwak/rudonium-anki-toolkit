import { explicitNotePattern } from './card-format-presets'
import { pageIdLocation } from './page-id-location'
import { activeExportRules } from './sync-profiles'
import { PluginSettings, ParsedSettings } from './interfaces/settings-interface'
import { App } from 'obsidian'
import * as AnkiConnect from './anki'
import { ID_REGEXP_STR } from './note'
import { escapeRegex } from './constants'

export async function settingToData(app: App, settings: PluginSettings, fields_dict: Record<string, string[]>, existingIds?: number[]): Promise<ParsedSettings> {
    let result: ParsedSettings = <ParsedSettings>{}

    //Some processing required
    result.vault_name = app.vault.getName()
    result.fields_dict = fields_dict
    result.custom_regexps = settings.CUSTOM_REGEXPS
    result.file_link_fields = settings.FILE_LINK_FIELDS
    result.context_fields = settings.CONTEXT_FIELDS
    result.folder_decks = settings.FOLDER_DECKS
    result.folder_tags = settings.FOLDER_TAGS
    result.template = {
        deckName: settings.Defaults.Deck,
        modelName: "",
        fields: {},
        options: {
            allowDuplicate: false,
            duplicateScope: "deck"
        },
        tags: [settings.Defaults.Tag]
    }
    // При отсутствии переданного списка используется прежний запрос. Пустой список уже считается переданным.
    result.EXISTING_IDS = existingIds ?? (await AnkiConnect.invoke('findNotes', {query: ""}) as number[])

    //RegExp section
    result.FROZEN_REGEXP = new RegExp(escapeRegex(settings.Syntax["Frozen Fields Line"]) + String.raw` - (.*?):\n((?:[^\n][\n]?)+)`, "g")
    result.DECK_REGEXP = new RegExp(String.raw`^` + escapeRegex(settings.Syntax["Target Deck Line"]) + String.raw`(?:\n|: )(.*)`, "m")
    result.TAG_REGEXP = new RegExp(String.raw`^` + escapeRegex(settings.Syntax["File Tags Line"]) + String.raw`(?:\n|: )(.*)`, "m")
    result.NOTE_REGEXP = explicitNotePattern(escapeRegex(settings.Syntax["Begin Note"]), escapeRegex(settings.Syntax["End Note"]))
    result.INLINE_REGEXP = new RegExp(escapeRegex(settings.Syntax["Begin Inline Note"]) + String.raw`(.*?)` + escapeRegex(settings.Syntax["End Inline Note"]), "g")
    result.EMPTY_REGEXP = new RegExp(escapeRegex(settings.Syntax["Delete Note Line"]) + ID_REGEXP_STR, "g")

    //Just a simple transfer
    result.curly_cloze = settings.Defaults.CurlyCloze
    result.highlights_to_cloze = settings.Defaults["CurlyCloze - Highlights to Clozes"]
    result.add_file_link = settings.Defaults["Add File Link"]
    result.comment = settings.Defaults["ID Comments"]
    result.id_date = settings.Defaults["Add Date to Anki IDs"] ?? false
    result.folder_default_decks = settings.FOLDER_DEFAULT_DECKS
    result.page_model = settings.PAGE_MODEL
    result.page_id_location = pageIdLocation(settings.PAGE_ID_LOCATION)
    result.export_rules = activeExportRules(settings)
    result.add_context = settings.Defaults["Add Context"]
    result.add_obs_tags = settings.Defaults["Add Obsidian Tags"]

    return result
}
