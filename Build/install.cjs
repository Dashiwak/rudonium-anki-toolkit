/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
"use strict";

// Этот установщик меняет исходники плагина 3.6.0. Готовый main.js затем создаёт штатная сборка плагина.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const overlay = require("./overlay-source.cjs");
const { patchManager } = require("./patch-manager.cjs");
const { patchCardPreviewRanges, patchIdWrites, patchLinkedCoverage, patchMarkdownConstants, patchFormatter } = require("./format-patches.cjs");
const { patchCustomRegexpIsolation } = require("./custom-regexp-patch.cjs");

// Каждая текстовая правка рассчитана на один известный участок исходника.
// Если совпадений нет или их несколько, останавливаемся, чтобы не менять похожий участок наугад.
function replaceOnce(source, pattern, replacement) {
    if ([...source.matchAll(new RegExp(pattern.source, "g"))].length !== 1) {
        throw new Error("Unexpected upstream code near " + pattern.source);
    }
    return source.replace(pattern, replacement);
}

function removeStartupSchemaFetch(body) {
    return replaceOnce(body,
        /\bif\s*\(\s*Object\.keys\(this\.fields_dict\)\.length\s*={2,3}\s*0\s*\)\s*\{[\s\S]*?\}\s*(?=this\.added_media\s*=\s*await this\.loadAddedMedia\(\))/,
        "");
}

function offlineDefaults(body) {
    // В исходной версии тег задан прямо в литерале настроек. Непустой выбор из data.json не меняем.
    const defaults = replaceOnce(body, /(["']Tag["']\s*:\s*)["']Obsidian_to_Anki["']/i, '$1""');
    return replaceOnce(defaults, /\/\*\s*Making settings from scratch[\s\S]*?(?=\breturn settings\b)/,
        `this.note_types = []
        this.fields_dict = {}
        settings.CUSTOM_REGEXPS = {}
        settings.FILE_LINK_FIELDS = {}
        `);
}

// Подключает ускоренное сканирование к существующим командам и настройкам плагина.
function patchMain(source, ts) {
    // TypeScript разбирает файл в синтаксическое дерево. По дереву находим границы тела
    // нужного метода класса MyPlugin и заменяем только текст внутри фигурных скобок.
    function editBody(name, edit) {
        const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
        const plugin = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MyPlugin");
        const method = plugin?.members.find(node =>
            ts.isMethodDeclaration(node) && node.name.getText(file) === name);
        if (!method?.body) throw new Error("Unexpected MyPlugin." + name);
        const start = method.body.getStart(file) + 1;
        const end = method.body.end - 1;
        source = source.slice(0, start) + edit(source.slice(start, end)) + source.slice(end);
    }

    editBody("scanVault", body => {
        // Проверяем признаки штатного сканирования перед заменой. Это помогает обнаружить
        // другую редакцию метода, даже если её класс и имя команды совпали.
        for (const marker of ["settingToData", "FileManager", "requests_1", "initialiseFiles"]) {
            if (!body.includes(marker)) throw new Error("Unexpected scanVault implementation.");
        }
        return "\n        // Существующая команда передаёт управление ускоренному сканированию.\n" +
            "        await scanVaultFast(this)\n    ";
    });
    editBody("getDefaultSettings", body => body.replace(/^([ \t]*)(["']Frozen Fields Line["']\s*:)/m,
        '$1"Suspend Line": "SUSPEND",\n$1$2'));
    editBody("getDefaultSettings", body => replaceOnce(body, /([ \t]*)Defaults:\s*\{/,
        '$1EXPECTED_ANKI_PROFILE: "",\n$1REQUIRE_ANKI_PROFILE: false,\n$1BIDIRECTIONAL_SYNC: false,\n$1BIDIRECTIONAL_PREVIEW: false,\n$1BIDIRECTIONAL_CONFLICT_POLICY: "latest",\n$1SKIP_SYNC_ERRORS: false,\n$1INTERFACE_LANGUAGE: "en",\n$1PAGE_ID_LOCATION: "yaml",\n$1COLLAPSE_ANKI_IDS: false,\n$1CLEAN_DELETED_BLOCKS: false,\n$1MARK_DELETED_BLOCKS: false,\n$1TRASH_DELETED_PAGES: false,\n$&'));
    editBody("getDefaultSettings", offlineDefaults);
    editBody("loadSettings", body => {
        const load = replaceOnce(body.replace(/new Notice\(["'](?:Need to connect to Anki generate default settings\.\.\.|Default settings successfully generated!)["']\)\s*;?/g, ""), /current_data\s*==\s*null\s*\|\|\s*Object\.keys\(current_data\)\.length\s*!=\s*4/,
            "current_data == null || (typeof current_data === 'object' && !Array.isArray(current_data) && Object.keys(current_data).length === 0)");
        return replaceOnce(replaceOnce(load, /this\.saveData\(/, "await this.saveData("), /return current_data\.settings\b/,
            `if (!current_data.settings || typeof current_data.settings !== "object" || Array.isArray(current_data.settings) ||
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
            return settings`);
    });
    // При запуске плагина сохраняем загрузку старых хешей и подключаем новые обработчики сразу после неё.
    editBody("onload", body => replaceOnce(body,
        /this\.file_hashes\s*=\s*await this\.loadFileHashes\(\)/,
        "$&\n        if (this.rudoniumStopped) return\n        // После загрузки хешей включаем отслеживание файлов и команду полной проверки.\n" +
            "        registerFastScan(this, (deck, repair) => { void openAuditForExportIssue(this, deck, repair) }, () => refreshNoteTypes(this))\n" +
            "        registerSetupCommand(this, task => withFastScanReadLock(this, task), () => this.rudoniumStopped)\n" +
            "        registerCardPreview(this)\n" +
            "        registerSupportCommand(this)\n" +
            "        registerPageMigrationCommand(this)\n" +
            "        registerLostIdRecoveryCommand(this)\n" +
            "        registerFrozenFieldsCommand(this)\n" +
            "        registerZipImport(this)\n" +
            "        registerEditorCardWarnings(this)\n" +
            "        registerEditorIdFolding(this)\n" +
            "        registerArchivedCardDisplay(this)\n" +
            "        registerIdMarkerConversion(this)\n" +
            "        registerPageIdBulk(this)\n" +
            "        registerPageFieldEditor(this)\n" +
            "        registerOpenCardInAnki(this)\n" +
            "        registerCardSourceLinks(this, () => this.settings.Syntax, id => openDuplicateIdReview(this, id), () => uiFor(this.settings))\n" +
            "        this.addCommand({ id: 'anki-sync-audit-default-deck', name: uiFor(this.settings)('Check Default Deck with Anki', 'Сверить колоду по умолчанию с Anki'),\n" +
            "            callback: () => startSyncAudit(this) })\n" +
            "        this.addCommand({ id: 'anki-sync-audit-choose-deck', name: uiFor(this.settings)('Choose Deck to Check with Anki', 'Выбрать колоду для сверки с Anki'),\n" +
            "            callback: () => openSyncAuditDeckPicker(this) })"));
    editBody("onload", removeStartupSchemaFetch);
    editBody("onload", body => body
        .replace(/(this\.(?:settings|fields_dict|added_media)\s*=\s*await this\.(?:loadSettings|loadFieldsDict|generateFieldsDict|loadAddedMedia)\(\)\s*;?)/g,
            "$1\n        if (this.rudoniumStopped) return\n")
        .replace(/catch\s*\(\s*(\w+)\s*\)\s*\{/g,
            "$&\n        if (this.rudoniumStopped) return\n        if ($1 instanceof Error && $1.name === 'InvalidRudoniumPluginData') { new Notice($1.message, 12000); return }\n")
        .replace(/name:\s*['"]Scan Vault['"]/, "name: uiFor(this.settings)('Scan Vault', 'Экспортировать хранилище в Anki')")
        .replace(/(['"])Obsidian_to_Anki - Scan Vault\1/, "uiFor(this.settings)('Obsidian_to_Anki - Scan Vault', 'Экспортировать хранилище в Anki')")
        .replace(/(['"])Couldn't connect to Anki! Check console for error message\.\1/g,
            `uiFor(this.settings)("Couldn't connect to Anki! Check console for error message.", "Нет связи с Anki. Откройте Anki и проверьте AnkiConnect.")`)
        .replace(/(['"])Need to connect to Anki to generate fields dictionary\.\.\.\1/g,
            "uiFor(this.settings)('Need to connect to Anki to generate fields dictionary...', 'Читаем типы записей и поля из Anki…')")
        .replace(/(['"])Fields dictionary successfully generated!\1/g,
            "uiFor(this.settings)('Fields dictionary successfully generated!', 'Поля записей получены из Anki.')"));
    editBody("onload", body => `\n        if (await pauseForMigration(this, () => this.startRudonium(), () => { if (this.rudoniumInitialized && !this.rudoniumStopped) openPageMigration(this) })) return\n` +
        `        await this.startRudonium()\n    }\n\n    private rudoniumInitialized = false\n    private rudoniumStopped = false\n\n` +
        `    private async startRudonium(): Promise<void> {
        if (this.rudoniumStopped) return
        await this.initializeRudonium()
    }\n\n` +
        `    private async initializeRudonium(): Promise<void> {\n        if (this.rudoniumStopped) return\n${body.trimEnd()}\n        this.rudoniumInitialized = true\n    `);
    // Выключение до завершения проверки миграции не должно создавать пустой data.json.
    editBody("onunload", body => `\n        this.rudoniumStopped = true\n        if (!this.rudoniumInitialized) return\n${body}`);
    // Некоторые настройки сохраняются напрямую через saveData. Поддерживаем те же
    // дополнительные поля для всех путей записи, не перечитывая большой data.json.
    source = replaceOnce(source, /(?=\basync saveAllData\(\))/,
        `private rudoniumDataExtras: Record<string, unknown> = {}

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

    `);
    editBody("saveAllData", body => {
        // Ставим сохранение data.json в общую очередь и ждём завершения записи.
        const save = replaceOnce(body, /this\.saveData\(/, "await this.saveData(");
        return "\n        // Сохранения от сканирования и настроек выполняются по очереди.\n" +
            "        await savePluginDataInOrder(this, async () => {" +
            save.trimEnd().replace(/\n/g, "\n    ") + "\n        })\n    ";
    });
    // Удаляем импорты, которые были нужны только прежней реализации метода.
    source = replaceOnce(source, /, ParsedSettings(?=\s*\})/, "");
    source = replaceOnce(source, /import \{ settingToData \} from ['"]\.\/src\/setting-to-data['"]\r?\n/, "");
    source = replaceOnce(source, /import \{ FileManager \} from ['"]\.\/src\/files-manager['"]\r?\n/, "");
    source = replaceOnce(source, /DEFAULT_IGNORED_FILE_GLOBS,\s*(?=SettingsTab)/, "");
    source = replaceOnce(source, /[ \t]*IGNORED_FILE_GLOBS\s*:\s*DEFAULT_IGNORED_FILE_GLOBS,?\s*\r?\n/, "");
    source = replaceOnce(source, /[ \t]*"Scan Directory"\s*:\s*"",\s*\r?\n/, "");
    const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
    const plugin = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MyPlugin");
    const folderWalker = plugin?.members.find(node =>
        ts.isMethodDeclaration(node) && node.name.getText(file) === "getAllTFilesInFolder");
    if (folderWalker) {
        const before = source.slice(0, folderWalker.getStart(file))
            .replace(/^[ \t]*\/\*\*\s*\* Recursively traverse a TFolder[^]*?\*\/\s*$/m, "");
        source = before + source.slice(folderWalker.end);
        if (!/(?:^|[^.])\bTFile\b/.test(source.replace(/import[^\r\n]+from ['"]obsidian['"]\r?\n/, ""))) {
            source = source.replace(/, TFile(?=\s*[,}])/, "");
        }
        if (!/(?:^|[^.])\bTFolder\b/.test(source.replace(/import[^\r\n]+from ['"]obsidian['"]\r?\n/, ""))) {
            source = source.replace(/, TFolder(?=\s*[,}])/, "");
        }
    }
    // У новой установки переключатель выключен. Для прежних настроек это же значение
    // применяется при открытии Defaults и при подготовке очередного экспорта.
    source = replaceOnce(source,
        /("ID Comments"\s*:\s*true,)(\r?\n)([ \t]*)/,
        '$1$2$3"Add Date to Anki IDs": false,$2$3');
    return "import { uiFor } from './src/interface-language'\n" +
        "import { openAuditForExportIssue, startSyncAudit, openSyncAuditDeckPicker } from './src/sync-audit-ui'\n" +
        "import { openPageMigration, registerPageMigrationCommand } from './src/page-migration-ui'\n" +
        "import { registerSupportCommand } from './src/interface-settings-ui'\n" +
        "import { registerFrozenFieldsCommand } from './src/frozen-fields-ui'\n" +
        "import { registerLostIdRecoveryCommand } from './src/lost-id-recovery-ui'\n" +
        "import { registerCardPreview } from './src/card-preview'\n" +
        "import { registerZipImport } from './src/zip-import-ui'\n" +
        "import { registerEditorCardWarnings } from './src/editor-card-warnings'\n" +
        "import { registerArchivedCardDisplay } from './src/archived-card-display'\n" +
        "import { registerEditorIdFolding } from './src/editor-id-folding'\n" +
        "import { registerIdMarkerConversion } from './src/id-marker-conversion-ui'\n" +
        "import { registerPageIdBulk } from './src/page-id-bulk-ui'\n" +
        "import { registerPageFieldEditor } from './src/page-field-editor-ui'\n" +
        "import { registerOpenCardInAnki } from './src/card-open-anki'\n" +
        "import { pauseForMigration } from './src/plugin-migration'\n" +
        "import { refreshNoteTypes } from './src/note-type-refresh'\n" +
        "import { registerSetupCommand } from './src/first-connection'\n" +
        "import { openDuplicateIdReview, registerFastScan, savePluginDataInOrder, scanVaultFast, withFastScanReadLock } from './src/fast-scan'\n" +
        "import { registerCardSourceLinks } from './src/card-source-links'\n" + source;
}

// Позволяет передать заранее выбранные Anki ID в штатный преобразователь настроек.
// Быстрый проход передаёт пустой список и позже ищет только ID из отобранных файлов.
function patchSettings(source) {
    source = replaceOnce(source,
        /(fields_dict:\s*Record<string,\s*string\[\]>)(\s*\):\s*Promise<ParsedSettings>)/,
        "$1, existingIds?: number[]$2");
    source = replaceOnce(source,
        /result\.EXISTING_IDS\s*=\s*(await AnkiConnect\.invoke\(['"]findNotes['"],\s*\{\s*query:\s*["']["']\s*\}\)\s*as number\[\])/,
        "// При отсутствии переданного списка используется прежний запрос. Пустой список уже считается переданным.\n" +
            "    result.EXISTING_IDS = existingIds ?? ($1)");
    source = replaceOnce(source, /(result\.comment\s*=\s*settings\.Defaults\["ID Comments"\])([ \t]*\r?\n)/,
        '$1$2    result.id_date = settings.Defaults["Add Date to Anki IDs"] ?? false$2' +
        '    result.folder_default_decks = settings.FOLDER_DEFAULT_DECKS$2    result.page_model = settings.PAGE_MODEL$2' +
        '    result.page_id_location = pageIdLocation(settings.PAGE_ID_LOCATION)$2' +
        '    result.export_rules = activeExportRules(settings)$2');
    if (/\bignored_file_globs\b|\bIGNORED_FILE_GLOBS\b/.test(source)) {
        source = replaceOnce(source, /[ \t]*result\.ignored_file_globs\s*=[^\r\n]*\r?\n/, "");
        if (/\bignored_file_globs\b|\bIGNORED_FILE_GLOBS\b/.test(source)) {
            throw new Error("Unexpected legacy folder filters in src/setting-to-data.ts.");
        }
    }
    let blockImport = "";
    if (/\bresult\.NOTE_REGEXP\s*=/u.test(source)) {
        source = replaceOnce(source, /result\.NOTE_REGEXP\s*=\s*new RegExp[^\r\n]+/,
            'result.NOTE_REGEXP = explicitNotePattern(escapeRegex(settings.Syntax["Begin Note"]), escapeRegex(settings.Syntax["End Note"]))');
        blockImport = "import { explicitNotePattern } from './card-format-presets'\n";
    }
    return blockImport + "import { pageIdLocation } from './page-id-location'\n" +
        "import { activeExportRules } from './sync-profiles'\n" + source;
}

/** Описывает настройку и добавляет её к данным, которые получают обработчики файлов. */
function patchIdDateInterfaces(source) {
    source = source.replace(/^([ \t]*)(["']Frozen Fields Line["']\s*:\s*string)/m,
        '$1"Suspend Line"?: string,\n$1"Suspend Line Aliases"?: string,\n$1$2');
    source = source.replace(/^[ \t]*(?:"Scan Directory"|IGNORED_FILE_GLOBS|ignored_file_globs)\??\s*:[^\r\n]*\r?\n/gm, "");
    source = replaceOnce(source, /("ID Comments"\s*:\s*boolean,)(\r?\n)([ \t]*)/,
        '$1$2$3"Add Date to Anki IDs"?: boolean,$2$3');
    source = replaceOnce(source, /(export interface PluginSettings\s*\{)(\r?\n)/,
        '$1$2    NOTE_TYPE_RULE_MODELS?: string[]$2    NOTE_TYPE_RULE_NAMES?: Record<string, string>$2    INACTIVE_CUSTOM_REGEXPS?: Record<string, string>$2    REGEXP_WIZARD_FIELDS?: Record<string, string[]>$2    PAGE_MODEL?: string$2    PAGE_ID_LOCATION?: "heading" | "yaml" | "after-answer"$2    AUDIT_READ_ONLY?: boolean$2    BIDIRECTIONAL_SYNC?: boolean$2    BIDIRECTIONAL_PREVIEW?: boolean$2    BIDIRECTIONAL_CONFLICT_POLICY?: "latest" | "skip"$2    SKIP_SYNC_ERRORS?: boolean$2' +
        '    SYNC_FOLDER_PROFILES?: import("../sync-profiles").SyncFolderProfile[]$2    ACTIVE_SYNC_FOLDER_PROFILE?: string$2' +
        '    EFFECTIVE_EXPORT_RULES?: import("../export-rules").ExportRule[]$2' +
        '    BIDIRECTIONAL_FIELDS?: import("../bidirectional-fields").BidirectionalFieldRule[]$2' +
        '    FOLDER_DEFAULT_DECKS?: Record<string, boolean>$2' +
        '    IMAGE_OPTIMIZATION?: import("../image-optimizer").ImageOptimizationSettings$2' +
        '    VAULT_BACKUP?: import("../vault-backup").BackupSettings$2' +
        '    ARCHIVE_TRANSFER?: import("../archive-settings").ArchiveTransferSettings$2' +
        '    EXPECTED_ANKI_PROFILE?: string$2    REQUIRE_ANKI_PROFILE?: boolean$2' +
        '    COLLAPSE_ANKI_IDS?: boolean$2    CLEAN_DELETED_BLOCKS?: boolean$2    MARK_DELETED_BLOCKS?: boolean$2    AFTER_DELETE_MODE?: import("../deletion-policy").AfterDeleteMode$2    TRASH_DELETED_PAGES?: boolean$2' +
        '    INTERFACE_LANGUAGE?: import("../interface-language").InterfaceLanguage$2');
    return replaceOnce(source, /(\bcomment:[ \t]*boolean)(\r?\n)([ \t]*)/,
        '$1$2$3id_date?: boolean$2$3page_model?: string$2$3page_id_location?: "heading" | "yaml" | "after-answer"$2$3folder_default_decks?: Record<string, boolean>$2$3' +
        'export_rules?: import("../export-rules").ExportRule[]$2$3');
}

/** Сохраняет основные параметры на прежнем месте; профили расположены в дополнительных инструментах. */
function patchFolderProfileSettings(source, ts) {
    const file = ts.createSourceFile("settings.ts", source, ts.ScriptTarget.Latest, true);
    const settings = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SettingsTab");
    const legacy = settings?.members.find(node =>
        ts.isMethodDeclaration(node) && node.name.getText(file) === "setup_ignore_files");
    if (legacy) {
        source = source.slice(0, legacy.getStart(file)) + source.slice(legacy.end);
        source = replaceOnce(source, /[ \t]*this\.setup_ignore_files\(\);?[ \t]*\r?\n/, "");
    }
    if (/\bDEFAULT_IGNORED_FILE_GLOBS\b/.test(source)) {
        source = replaceOnce(source, /export const DEFAULT_IGNORED_FILE_GLOBS\s*=\s*\[[^\]]*\];?[ \t]*\r?\n/, "");
    }
    source = source.replace(/^[ \t]*"Scan Directory"\s*:\s*"[^"\r\n]*",?[ \t]*\r?\n/m, "");
    if (source.includes('"Scan Directory"')) {
        source = replaceOnce(source,
            /(?:[ \t]*\/\/ To account for new scan directory[^\r\n]*\r?\n)?[ \t]*if\s*\(\s*!\(plugin\.settings\["Defaults"\]\.hasOwnProperty\("Scan Directory"\)\)\s*\)\s*\{\s*plugin\.settings\["Defaults"\]\["Scan Directory"\]\s*=\s*"";?\s*\}[ \t]*\r?\n/,
            "");
    }
    // В исходных настройках элементы формы были вложены в заголовок.
    source = source.replace(/^[ \t]*(?:let|const) defaults_settings = containerEl\.createEl\('h3',\s*\{\s*text:\s*'Defaults'\s*\}\);?[ \t]*\r?\n/m, "");
    source = source.replace(/new Setting\(this\.containerEl\)(?=\s*\.setName\(key\))/g, "new Setting(defaults_settings)");
    source = replaceOnce(source, /for \(let key of Object\.keys\(plugin\.settings\["Defaults"\]\)\) \{/,
        `const t = uiFor(plugin.settings)
        this.containerEl.createEl('h3', { text: t('Defaults', 'Параметры по умолчанию') })
        const defaults_settings = this.containerEl.createDiv()
        installDefaultDeckSetting(defaults_settings, plugin)
        $&
            if (key === "Deck") continue`);
    if (/\bIGNORED_FILE_GLOBS\b|\bsetup_ignore_files\b|"Scan Directory"/.test(source)) {
        throw new Error("Unexpected legacy folder settings in src/settings.ts.");
    }
    return "import { installDefaultDeckSetting } from './default-deck-setting'\n" +
        "import { installAnkiProfileSettings } from './anki-profile-ui'\n" +
        "import { installSyncProfileSettings } from './sync-profiles-ui'\n" +
        "import { installDeckRoutingSettings } from './deck-routes-ui'\n" + source;
}

/** Назначения колод редактируются в дополнительном разделе профилей. Исходный редактор тегов папок сохраняется. */
function patchLegacyFolderDeckTable(source, ts) {
    const file = ts.createSourceFile("settings.ts", source, ts.ScriptTarget.Latest, true);
    const tab = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SettingsTab");
    const legacy = tab?.members.find(node =>
        ts.isMethodDeclaration(node) && node.name.getText(file) === "setup_folder_deck");
    if (!legacy) return source.replace(/\['Folder', 'Deck', 'Tags'\]/, "['Folder', 'Tags']");
    source = source.slice(0, legacy.getStart(file)) + source.slice(legacy.end);
    source = replaceOnce(source, /\["Folder", "Folder Deck", "Folder Tags"\]/, '["Folder", "Folder Tags"]');
    source = replaceOnce(source, /[ \t]*this\.setup_folder_deck\(folder, row_cells\)[ \t]*\r?\n/, "");
    source = replaceOnce(source, /(row\.insertCell\(\)[ \t]*\r?\n\s*row\.insertCell\(\)[ \t]*\r?\n)[ \t]*row\.insertCell\(\)[ \t]*\r?\n(?=\s*let row_cells = row\.children\s*\r?\n\s*row_cells\[0\]\.innerHTML = folder\.path)/, "$1");
    const updated = ts.createSourceFile("settings.ts", source, ts.ScriptTarget.Latest, true);
    const updatedTab = updated.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SettingsTab");
    const tags = updatedTab?.members.find(node =>
        ts.isMethodDeclaration(node) && node.name.getText(updated) === "setup_folder_tag");
    if (!tags?.body) throw new Error("Unexpected folder tag editor.");
    const from = tags.body.getStart(updated);
    return source.slice(0, from) + source.slice(from, tags.end).replace(/row_cells\[2\]/g, "row_cells[1]") + source.slice(tags.end);
}

/** Штатный список Defaults сам создаёт переключатель для логического значения. */
function patchIdDateSettings(source) {
    source = replaceOnce(source, /("ID Comments"\s*:\s*"[^"\r\n]*",)(\r?\n)([ \t]*)/,
        '$1$2$3"Add Date to Anki IDs": "Place the local date after each confirmed Anki ID and before your annotations. Existing dates are kept.",$2$3');
    return replaceOnce(source, /for \(let key of Object\.keys\(plugin\.settings\["Defaults"\]\)\) \{/,
        'plugin.settings["Defaults"]["Add Date to Anki IDs"] ??= false\n        $&');
}

/** Добавляет дату при штатной записи подтверждённых ID для всех форматов карточек. */
function patchIdDateFile(source) {
    source = replaceOnce(source, /function id_to_str(\([^\r\n)]*)(\):\s*string\s*\{)/,
        `function id_to_str$1, date?: string$2`);
    source = replaceOnce(source, /(let result = "ID: " \+ identifier\.toString\(\))([ \t]*\r?\n)/,
        '$1$2    if (date) result += " | " + date$2');
    source = replaceOnce(source, /(writeIDs\(\)\s*\{\s*)(let normal_inserts)/,
        "$1// Вычисляем дату один раз для всех новых ID в этом файле.\n" +
        "        const date = this.data.id_date && this.note_ids.some(Boolean) ? formatLocalIdDate(new Date()) : undefined\n" +
        "        $2");
    const calls = /(\bid_to_str\(identifier,\s*(?:true|false),\s*this\.data\.comment)\)/g;
    if ([...source.matchAll(calls)].length !== 3) {
        throw new Error("Unexpected Anki ID writers in src/file.ts.");
    }
    source = source.replace(calls, "$1, date)");
    source = "import { formatLocalIdDate } from './anki-id-marker'\n" + source;
    // Разделяем однострочный маркер и предшествующее слово, даже когда между ними не было пробела.
    return replaceOnce(source, /id_to_str\(identifier,\s*true,\s*this\.data\.comment, date\)/,
        '((id_position > 0 && /\\S/.test(this.file[id_position - 1])) ? " " : "") + $&');
}

/** Во время аудита штатный парсер сохраняет границы карточек с ID в исходном Markdown. */
function patchAuditFile(source) {
    source = replaceOnce(source, /export class AllFile extends AbstractFile\s*\{/, "$&\n" +
        "    // При обычном экспорте массив позиций не создаётся.\n" +
        "    auditNoteRanges?: Array<[number, number]>\n");
    const matches = /this\.notes_to_edit\.push\(parsed\)/g;
    if ([...source.matchAll(matches)].length !== 3) throw new Error("Unexpected Anki note readers in src/file.ts.");
    let reader = 0;
    return source.replace(matches, statement => {
        const match = reader++ < 2 ? "note_match" : "match";
        return statement + `\n                this.auditNoteRanges?.push([${match}.index, ${match}.index + ${match}[0].length])`;
    });
}

/** Сохраняет привязку к ID в пользовательских шаблонах при CRLF и отступе строки. */
function patchRegexNoteId(source) {
    return "import { ankiIdRegexpSource } from './anki-id-marker'\n" + replaceOnce(source,
        /(\bid_str\s*=\s*search_id\s*\?\s*)ID_REGEXP_STR(\s*:\s*"")/,
        (_match, before, after) => before + 'String.raw`(?:\\r?\\n)?` + ankiIdRegexpSource' + after);
}

/** Распознаёт связанные карточки проекта перед общим циклом пользовательских выражений. */
function patchLinkedBulletFile(source) {
    source = replaceOnce(source, /export class AllFile extends AbstractFile\s*\{/, `$&
    idDateWarnings: AnkiIdDateWarning[] = []
    linkedBullets?: Array<LinkedBullet & { model: LinkedBulletModel }>
    private linkedBulletRanges: Array<[number, number]> = []

    private scanLinkedBulletCards(): void {
        this.linkedBulletRanges = []
        for (const bullet of this.linkedBullets ?? []) {
            // Штатные START, STARTI и исключённые участки уже зарезервированы.
            if (this.ignore_spans.some(([start, end]) => start <= bullet.start && bullet.start < end)) continue
            const { model, id, start, end } = bullet
            const sourceFields = linkedBulletSourceFields(bullet, model)

            const frozen = this.frozen_fields_dict?.[model.name]
            const linkField = this.data.file_link_fields?.[model.name]
            const contextField = this.data.context_fields?.[model.name]
            const generatedNames = [this.url && linkField, this.data.add_context && contextField];
            for (const name of generatedNames) {
                if (name && model.fieldNames.has(name) && !(name in sourceFields)) sourceFields[name] = "";
            }
            const match: RegExpMatchArray = [this.file.slice(start, end), ...Object.values(sourceFields), String(id)]
            const frozenFields = Object.fromEntries(Object.keys(sourceFields).map(field =>
                [field, field === "Front" || field === "Back" ? frozen?.[field] ?? "" : ""]))
            const parsed = new RegexNote(match, model.name, { [model.name]: Object.keys(sourceFields) }, false, true,
                this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter).parse(
                    this.target_deck, linkField && linkField in sourceFields ? this.url : "",
                    { [model.name]: frozenFields }, this.data,
                    this.data.add_context && contextField && contextField in sourceFields
                        ? this.getContextAtIndex(start) : "",
                )
            if (parsed.identifier !== id) continue
            this.notes_to_edit.push(parsed)
            this.auditNoteRanges?.push([start, end])
            this.ignore_spans.push([start, end])
            this.linkedBulletRanges.push([start, end])
        }
    }
`);
    source = replaceOnce(source, /\bthis\.scanInlineNotes\(\)/, '$&\n        this.scanLinkedBulletCards()');
    return "import { linkedBulletSourceFields } from './linked-bullets'\n" +
        "import type { LinkedBullet, LinkedBulletModel } from './linked-bullets'\n" + source;
}

/** Кнопки настроек используют те же действия, что и соответствующие команды из палитры. */
function patchAuditSettings(source) {
    source = replaceOnce(source, /this\.setup_buttons\(\)/, "$&\n        this.setup_workflows()");
    source = replaceOnce(source, /setup_buttons\(\)\s*\{/, `setup_workflows() {
        const {containerEl} = this
        const plugin = (this as any).plugin
        const t = uiFor(plugin.settings)
        containerEl.createEl('h3', { text: t('Additional tools', 'Дополнительные инструменты') })
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
        installBidirectionalSettings(containerEl.querySelector<HTMLElement>('.rudonium-mode-slot') ?? syncBody, plugin)
        renderSettingsGroup(containerEl, plugin, 'archives-transfer', t('Archives, Backup and Transfer', 'Архивы, резервные копии и перенос'), body => installZipImportSettings(body, plugin))
        renderSettingsGroup(containerEl, plugin, 'image-optimization', t('Image Optimization', 'Оптимизация изображений'), body => installImageOptimizationSettings(body, plugin))
        installIdMarkerSettings(containerEl, plugin, {
            toComment: () => openIdMarkerConversion(plugin, 'to-comment'),
            toPlain: () => openIdMarkerConversion(plugin, 'to-plain'),
            moveVaultPages: () => openPageIdBulk(plugin),
            foldingChanged: () => refreshEditorIdFolding(plugin),
        })
    }

    $&`);
    source = replaceOnce(source, /let action_buttons = containerEl\.createEl\('h3', \{text: 'Actions'\}\)/, `
        const t = uiFor(plugin.settings)
        containerEl.createEl('h3', { text: t('Actions', 'Обслуживание') })
        let action_buttons = containerEl.createDiv()`);
    return "import { previewVaultExport, withFastScanReadLock } from './fast-scan'\n" +
        "import { createSettingsGroup, renderSettingsGroup } from './settings-layout'\n" +
        "import { installIdMarkerSettings } from './id-tools-settings-ui'\n" +
        "import { openIdMarkerConversion } from './id-marker-conversion-ui'\n" +
        "import { openPageIdBulk } from './page-id-bulk-ui'\n" +
        "import { refreshEditorIdFolding } from './editor-id-folding'\n" +
        "import { installBidirectionalSettings } from './bidirectional-field-settings'\n" +
        "import { installFirstRunSetting } from './first-connection'\n" +
        "import { installPageMigrationSetting } from './page-migration-ui'\n" +
        "import { installZipImportSettings } from './zip-import-ui'\n" +
        "import { installImageOptimizationSettings } from './image-optimization-ui'\n" +
        "import { startSyncAudit, openSyncAuditDeckPicker } from './sync-audit-ui'\n" + source;
}

function patchFieldRefresh(source) {
    source = replaceOnce(source,
        /new Setting\(action_buttons\)\s*\.setName\("Regenerate Note Type Table"\)[\s\S]*?(?=new Setting\(action_buttons\)\s*\.setName\("Clear Media Cache"\))/,
        "installNoteTypeRefresh(containerEl, action_buttons, plugin, () => this.setup_display())\n        ");
    if (/\bsetup_link_field\(note_type:/.test(source)) {
        // Вывод двух списков не должен запускать ещё одно чтение Anki или менять схему во время обновления.
        source = replaceOnce(source,
            /if\s*\(!\(plugin\.fields_dict\[note_type\]\)\)\s*\{[\s\S]*?(?=const field_names = plugin\.fields_dict\[note_type\])/,
            "");
        source = source.replace(/const field_names = plugin\.fields_dict\[note_type\]/g,
            "const field_names: string[] = plugin.fields_dict?.[note_type] ?? []\n" +
            "            if (!field_names.length) { dropdown.setDisabled(true); return }")
            .replace(/\b(regexp_section|link_fields_section|context_fields_section)\.hasOwnProperty\(note_type\)/g,
                "Object.prototype.hasOwnProperty.call($1, note_type)");
    }
    if (!/\bAnkiConnect\./.test(source)) {
        source = source.replace(/import \* as AnkiConnect from ['"]\.\/anki['"];?\r?\n/, "");
    }
    return "import { installNoteTypeRefresh } from './note-type-refresh'\n" + source;
}

// Use the same serialized setting as the pinned upstream exporter, including bracket notation.
function folderTagStorageKey(converter, editor) {
    const key = /\bresult\s*(?:\.\s*folder_tags|\[\s*["']folder_tags["']\s*\])\s*=\s*settings\s*(?:\.\s*(\w+)|\[\s*["']([^"'\r\n]+)["']\s*\])/.exec(converter);
    if (key) return key[1] ?? key[2];
    const names = new Set();
    for (const read of editor.matchAll(/\bsettings\s*(?:\.\s*(\w+)|\[\s*["']([^"'\r\n]+)["']\s*\])/g)) {
        const name = read[1] ?? read[2];
        if (/tag/i.test(name)) names.add(name);
    }
    if (names.size !== 1) throw new Error("Cannot identify the upstream setting used for folder tags.");
    return [...names][0];
}

function patchSettingsSearch(source, ts, converter) {
    if (!/this\.setup_folder_table\(\)/.test(source)) return source;
    const tree = ts.createSourceFile("settings.ts", source, ts.ScriptTarget.Latest, true);
    const tab = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SettingsTab");
    const methods = new Map((tab?.members ?? []).filter(node => ts.isMethodDeclaration(node) && node.body)
        .map(node => [node.name.getText(tree), node.body]));
    const display = Array.from(methods.values()).find(body => body.getText(tree).includes("this.setup_folder_table()"));
    const displaySource = display?.getText(tree) ?? "";
    const calls = [...displaySource.matchAll(/this\.(\w+)\(\)/g)].map(match => match[1]);
    // Identify the stock note table from its controls, independently of the method name.
    const buildsRules = (name, seen = new Set()) => {
        const body = methods.get(name);
        if (!body || body === display || seen.has(name)) return false;
        seen.add(name);
        const text = body.getText(tree);
        if (/this\.setup_(?:link_field|context_field)\(note_type|["']Custom Regexp["']|["']Note Type Table["']/.test(text)) return true;
        return [...text.matchAll(/this\.(setup_\w+)\(/g)].some(match => buildsRules(match[1], seen));
    };
    const noteTable = calls.filter(name => name !== "setup_folder_table" && buildsRules(name));
    const tagKey = folderTagStorageKey(converter, methods.get("setup_folder_tag")?.getText(tree) ?? "");
    let folderSettings = "installFolderTagSettings(containerEl, (this as any).plugin, " + JSON.stringify(tagKey) + ")";
    if (display && noteTable.length === 1) {
        const updated = displaySource.replace("this." + noteTable[0] + "()", "installNoteTypeRules(containerEl, (this as any).plugin)");
        source = source.slice(0, display.getStart(tree)) + updated + source.slice(display.end);
    } else {
        // Some compatible upstream layouts inline the note table. Replace that table by
        // its rendered header before the folder-search pass touches either section.
        folderSettings = "replaceRenderedNoteTypeTable(containerEl, (this as any).plugin)\n        " + folderSettings;
    }
    const ruleImport = display && noteTable.length === 1 ? "installNoteTypeRules" : "replaceRenderedNoteTypeTable";
    return "import { " + ruleImport + " } from './note-type-rule-ui'\n" +
        "import { installFolderTagSettings } from './settings-search'\n" + replaceOnce(source,
        /this\.setup_folder_table\(\)/, folderSettings)
        .replace(/(row_cells\[0\])\.innerHTML(\s*=\s*(?:note_type|folder\.path)\b)/g, "$1.textContent$2");
}

function patchInterfaceSettings(source) {
    source = replaceOnce(source, /this\.setup_workflows\(\)/,
        "$&\n" +
        "        installCardLifecycleSettings(this.containerEl, (this as any).plugin)\n" +
        "        installInterfaceLanguage(this.containerEl, (this as any).plugin, () => this.setup_display())\n" +
        "        installProjectInfo(this.containerEl, (this as any).plugin, RUDONIUM_BUILD_VERSION)\n" +
        "        finalizeSettingsLayout(this.containerEl, (this as any).plugin)");

    source = source
        .replace(/containerEl\.createEl\(['"]h2['"],\s*\{\s*text:\s*['"]Obsidian_to_Anki settings['"]\s*\}\)/,
            "installSettingsHelp(containerEl, (this as any).plugin)\n        containerEl.createDiv({ cls: 'rudonium-mode-slot' })")
        .replace(/containerEl\.createEl\(['"]a['"],\s*\{[^}]*For more information check the wiki[^}]*\}\)[^\n]*/g, "")
        .replace(/(['"])Formatting information\1/g, "uiFor((this as any).plugin.settings)('Card formatting', 'Формат карточек')")
        .replace(/(?:let|const) syntax_settings = containerEl\.createEl\('h3',\s*\{\s*text:\s*'Syntax Settings'\s*\}\)/,
            `const syntax = containerEl.createEl('details', { cls: 'anki-settings-disclosure' })
        syntax.createEl('summary', { text: uiFor(plugin.settings)('Syntax Settings', 'Синтаксис карточек') })
        const syntax_settings = syntax.createDiv()`)
        .replace(/(for\s*\(let key of Object\.keys\(plugin\.settings\[["']Syntax["']\]\)\)\s*\{)/,
            "$1\n            if (key === 'Suspend Line' || key === 'Suspend Line Aliases') continue")
        .replace(/text\s*=>\s*text\.setValue\(plugin\.settings\[["']Syntax["']\]\[key\]\)\s*\.onChange\(\(value\)\s*=>\s*\{\s*plugin\.settings\[["']Syntax["']\]\[key\]\s*=\s*value\s*;?\s*plugin\.saveAllData\(\)\s*;?\s*\}\)/,
            "text => bindSyntaxEdit(text, plugin, key)")
        .replace(/\.setName\(key\)/g, ".setName(legacySettingLabel(key, uiFor(plugin.settings)))")
        .replace(/\.setDesc\(defaultDescs\[key\]\)/g, ".setDesc(legacySettingDescription(key, defaultDescs[key], uiFor(plugin.settings)))")
        .replace(/\.setName\("Clear Media Cache"\)/g, '.setName(t("Clear Media Cache", "Очистить кеш вложений"))')
        .replace(/\.setDesc\(`Clear the cached list of media filenames[^\x60]*\x60\)/,
            '.setDesc(t("Clear the cached list of media previously sent to Anki.", "Удаляет из кеша список ранее отправленных вложений."))')
        .replace(/\.setName\("Clear File Hash Cache"\)/g, '.setName(t("Clear File Hash Cache", "Очистить кеш проверки файлов"))')
        .replace(/\.setDesc\("Clear saved file hashes and the fast-scan index\. The next scan rechecks files in scope\."\)/,
            '.setDesc(t("Clear saved file hashes and the fast-scan index. The next scan rechecks files in scope.", "Удаляет хэши файлов и индекс быстрого прохода. При следующем экспорте выбранные файлы будут проверены заново."))')
        .replace(/\.setName\("Optimize Cache"\)/g, '.setName(t("Optimize Cache", "Оптимизировать кеш"))')
        .replace(/\.setDesc\("Review stale cache entries from deleted files and keep the current index\."\)/,
            '.setDesc(t("Review stale cache entries from deleted files and keep the current index.", "Проверьте записи кеша для удалённых файлов. Индекс существующих заметок сохранится."))')
        .replace(/\.setButtonText\("Optimize Cache"\)/g, '.setButtonText(t("Optimize Cache", "Проверить кеш"))')
        .replace(/\.setButtonText\("Clear"\)/g, '.setButtonText(t("Clear", "Очистить"))');
    return "import { uiFor } from './interface-language'\n" +
        "import { bindSyntaxEdit, installCardLifecycleSettings } from './card-lifecycle-settings'\n" +
        "import { finalizeSettingsLayout } from './settings-layout'\n" +
        "import { installSettingsHelp, installInterfaceLanguage, installProjectInfo, legacySettingLabel, legacySettingDescription } from './interface-settings-ui'\n" +
        "declare const RUDONIUM_BUILD_VERSION: string\n" + source;
}

// Подключает обе существующие кнопки очистки к общей очереди сканирования и сброса.
function patchSettingsActions(source) {
    // Кнопка медиа по-прежнему отвечает только за список уже отправленных вложений.
    source = replaceOnce(source,
        /plugin\.added_media\s*=\s*\[\s*\]\s*;?\s*await plugin\.saveAllData\(\)\s*;?\s*new Notice\("Media Cache cleared successfully!"\)\s*;?/,
        "// Сброс кеша медиа ждёт завершения текущего сканирования.\n" +
            "                    await clearFastScanCache(plugin, 'media')");
    // Кнопка хешей сбрасывает прежние хеши и отдельный индекс быстрого прохода.
    source = replaceOnce(source,
        /plugin\.file_hashes\s*=\s*\{\s*\}\s*;?\s*await plugin\.saveAllData\(\)\s*;?\s*new Notice\("File Hash Cache cleared successfully!"\)\s*;?/,
        "// Сбрасываем оба уровня кеша файлов, чтобы следующая проверка прочитала заметки заново.\n" +
            "                    await clearFastScanCache(plugin, 'files')");
    // Подсказка у кнопки хешей объясняет, что она очищает оба уровня кеша файлов.
    source = replaceOnce(source,
        /(\.setName\("Clear File Hash Cache"\)\s*)\.setDesc\(`[^\x60]*`\)/,
        '$1.setDesc("Clear saved file hashes and the fast-scan index. The next scan rechecks files in scope.")');
    source = replaceOnce(source, /new Setting\(action_buttons\)\s*\.setName\("Clear File Hash Cache"\)/,
        `new Setting(action_buttons)
            .setName("Optimize Cache")
            .setDesc("Review stale cache entries from deleted files and keep the current index.")
            .addButton(button => button.setButtonText("Optimize Cache").onClick(() => openCacheOptimization(plugin)))
        $&`);
    return "import { clearFastScanCache } from './fast-scan'\n" +
        "import { openCacheOptimization } from './cache-optimization-ui'\n" + source;
}

// Штатное \w распознаёт только латинские буквы. Для тегов из полей карточки
// поддерживаем Unicode и вложенные пути. Символ # внутри ссылки или HTML не захватываем.
function patchInlineTags(source) {
    source = replaceOnce(source,
        /const OBS_TAG_REGEXP:\s*RegExp\s*=\s*\/#\(\\w\+\)\/g/,
        String.raw`// Теги из полей распознаются после форматирования текста в HTML.
const OBS_TAG_REGEXP: RegExp = /(?<![^\s>(\[])#((?=[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D_/-]*[\p{L}\p{M}\p{Extended_Pictographic}_-])[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D_-]+(?:\/[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D_-]+)*)(?![\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D_/-])(?![^<>]*>)/gu`);
    const capture = /(\.matchAll\(OBS_TAG_REGEXP\)\)\s*\{\s*)this\.tags\.push\(match\[1\]\)/g;
    if ([...source.matchAll(capture)].length !== 2) {
        throw new Error("Unexpected inline tag readers in src/note.ts.");
    }
    return source.replace(capture, "$1this.tags.push(match[1].split('/').join('::'))");
}

function patchSourceFieldWriters(source) {
    source = source.replace(String.raw`ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/`, String.raw`ID_REGEXP: RegExp = /^[ \t]*(?:<!--[ \t]*)?ID:[ \t]*(\d+)(?!\d|[.,]\d|[eE][+-]?\d)/u`);
    source = source.replace(String.raw`static ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/`, String.raw`static ID_REGEXP: RegExp = /(?:<!--[ \t]*(?=ID:[^\r\n]*?-->)|(?<!\S))ID:[ \t]*(\d+)(?!\d|[.,]\d|[eE][+-]?\d)/gu`);
    source = source.replace("        const result = this.text.match(InlineNote.ID_REGEXP)", String.raw`        const candidates = Array.from(this.text.matchAll(InlineNote.ID_REGEXP))
        const explicit = candidates.filter(marker => marker[0].startsWith('<!--'))
        const dated = candidates.filter(marker => /^[ \t]*\|[ \t]*\d{4}-\d{2}-\d{2}(?!\d)/u.test(this.text.slice(marker.index + marker[0].length)))
        const markers = explicit.length ? explicit : dated.length ? dated : candidates
        if (markers.length > 1) throw new Error('Ambiguous inline Anki ID. Keep one explicit <!--ID: 123--> marker. / Неоднозначный ID строчной карточки. Оставьте один явный маркер <!--ID: 123-->.')
        const result = markers[0]`);
    source = source.replace('this.text.split("\\n")', 'this.text.split(/\\r?\\n/u)');
    // Оба парсера (обычный/строчный и RegExp) получают URL и контекст для всего файла.
    // «Без поля» действует отдельно для каждого назначения и каждого типа записи.
    for (const [argument, map] of [["url", "file_link_fields"], ["context", "context_fields"]]) {
        const condition = new RegExp("if\\s*\\(\\s*" + argument + "\\s*\\)\\s*\\{", "g");
        if ([...source.matchAll(condition)].length !== 2) {
            throw new Error("Unexpected " + argument + " writers in src/note.ts.");
        }
        source = source.replace(condition, "if (" + argument + " && hasSourceField(template.fields, data." + map + "?.[this.note_type])) {");
    }
    return source + `
function hasSourceField(fields: Record<string, string>, name: string | undefined): boolean {
    return !!name && Object.prototype.hasOwnProperty.call(fields, name)
}
`;
}

// Принимает путь к распакованным исходникам. Запускается после npm ci и перед npm run build.
function install(directory) {
    // Проверяем идентификатор и версию в manifest.json, прежде чем готовить замены.
    const root = path.resolve(directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    if (manifest.id !== "obsidian-to-anki-plugin" || manifest.version !== "3.6.0") {
        throw new Error("Expected the official Obsidian_to_Anki 3.6.0 source tree.");
    }

    // Берём TypeScript из зависимостей самих исходников, установленных по их lock-файлу.
    const localRequire = createRequire(path.join(root, "package.json"));
    let ts;
    try {
        ts = localRequire("typescript");
    } catch {
        throw new Error("Run npm ci in the Obsidian_to_Anki source directory first.");
    }

    // Наличие нового модуля означает, что этот установщик уже применялся к папке.
    const modules = overlay.names();
    for (const name of modules) {
        if (fs.existsSync(path.join(root, "src", name))) {
            throw new Error("src/" + name + " already exists. Use an unmodified source checkout.");
        }
    }

    const edits = new Map([
        ["main.ts", patchMain],
        ["src/files-manager.ts", patchManager],
        ["src/setting-to-data.ts", patchSettings],
        ["src/settings.ts", source => patchInterfaceSettings(patchSettingsSearch(patchFieldRefresh(patchAuditSettings(patchFolderProfileSettings(
            patchLegacyFolderDeckTable(patchIdDateSettings(patchSettingsActions(source)), ts), ts))), ts,
            fs.readFileSync(path.join(root, "src/setting-to-data.ts"), "utf8")))],
        ["src/note.ts", source => patchSourceFieldWriters(patchInlineTags(source))],
        ["src/interfaces/settings-interface.ts", patchIdDateInterfaces],
        ["src/file.ts", (source, compiler) => {
            const patched = patchLinkedCoverage(patchIdWrites(patchLinkedBulletFile(patchRegexNoteId(patchAuditFile(patchIdDateFile(source))))));
            return patchCustomRegexpIsolation(patchCardPreviewRanges(patched, compiler), compiler);
        }],
        ["src/constants.ts", patchMarkdownConstants],
        ["src/format.ts", patchFormatter],
    ]);
    // Готовим изменённые исходники в памяти. Затем добавляем модули сканирования и сверки.
    const sources = [];
    for (const [file, patch] of edits) {
        const fullPath = path.join(root, file);
        const original = fs.readFileSync(fullPath, "utf8");
        try { sources.push([fullPath, patch(original, ts)]); }
        catch (error) {
            error.sourceFile = file;
            if (file === "src/file.ts") {
                // Оставляем в отчёте только исходную реализацию поиска из собираемого плагина.
                try {
                    const tree = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
                    const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AllFile");
                    const method = cls?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === "search");
                    if (method?.body) error.details = "AllFile.search:\n" + original.slice(method.getStart(tree), method.end);
                } catch { /* Сбой формирования отчёта не меняет исходную ошибку патча. */ }
            }
            throw error;
        }
    }
    for (const name of modules) {
        sources.push([path.join(root, "src", name), fs.readFileSync(overlay.file(name), "utf8")]);
    }
    // Проверяем синтаксис всех подготовленных файлов до первой записи. Проверка типов
    // и сборка готового main.js остаются за штатной командой npm run build.
    for (const [file, content] of sources) {
        const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
        if (parsed.parseDiagnostics.length) {
            throw new Error(path.basename(file) + ": " +
                ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, "\n"));
        }
    }
    for (const [file, content] of sources) fs.writeFileSync(file, content);
    console.log("Fast scan patch applied. Run npm run build in " + root);
}

// При прямом запуске читаем путь из командной строки. При импорте только предоставляем функции.
if (require.main === module) {
    try {
        if (process.argv.length !== 3) throw new Error("Usage: node install.cjs <Obsidian_to_Anki source directory>");
        install(process.argv[2]);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    folderTagStorageKey, install, offlineDefaults, removeStartupSchemaFetch, patchMain, patchSettings, patchInterfaceSettings, patchSettingsActions, patchInlineTags, patchSourceFieldWriters,
    patchIdDateFile, patchIdDateInterfaces, patchIdDateSettings, patchFolderProfileSettings,
    patchAuditFile, patchAuditSettings, patchRegexNoteId, patchLinkedBulletFile,
};
