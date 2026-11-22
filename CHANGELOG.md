# Changelog

## 0.10.13 · First bidirectional sync / Первый двусторонний перенос

- Перенос правок после одностороннего экспорта, сохранение буквальных знаков равенства в конце вопроса и выравнивание настроек.
- Improved first bidirectional sync after an export, preserved trailing equals signs in linked text and aligned the settings page.

[Release notes / Примечания к выпуску](docs/releases/0.10.13.md)

## 0.10.12 · Bidirectional conflict handling / Двусторонняя синхронизация

- Выбор более поздней правки связанного поля, ручной выбор направления в предпросмотре и свёрнутые настройки синхронизации.
- Choose the later field edit when possible, review sync directions per field and reach both settings and support from the plugin.

[Release notes / Примечания к выпуску](docs/releases/0.10.12.md)

## 0.10.11 · Sync reliability / Надёжность синхронизации

- Mode switches and missed vault events now use the correct field history and Markdown contents for manual sync. An unavailable ID can be isolated on strict AnkiConnect versions.
- Исправлены сверка после смены режима, проверка внешних правок Markdown и обработка исчезнувшего ID при пакетном чтении Anki.

[Release notes / Примечания к выпуску](docs/releases/0.10.11.md)

## 0.10.10 Update 1 · Sync feedback and installation files / Синхронизация и установочные файлы

- Manual bidirectional sync reports its result even when the preview is off. A one-way export can send concurrent text edits from Markdown to the existing Anki note.
- При ручной двусторонней синхронизации виден результат. В одностороннем режиме при одновременных изменениях обычного текста учитывается предыдущая синхронизация.
- The language control appears above About. Questions and bug reports can be opened from About.
- Три файла для Obsidian находятся непосредственно в `install/`. Установочный ZIP для распространения создаётся при подготовке релиза.

[Release notes / Примечания к выпуску](docs/releases/0.10.10.md)

### 0.10.10 · Installation file checks / Проверка установочных файлов

- Исправлена остановка при переносе проверенной сборки в постоянную папку. Обновление определяет тип каждого пути перед чтением установочных файлов.
- Fixed a failure while moving a verified build into its final folder. The updater checks each path directly to distinguish directories from files.

[Release notes / Примечания к выпуску](docs/releases/0.10.10.md)

## 0.10.9 · Build cleanup / Очистка после сборки

- Зависимости npm устанавливаются во временную папку системы. Занятый файл в каталоге зависимостей больше не мешает подготовить и проверить установочный комплект.
- The builder installs npm dependencies in the system temporary directory. A locked dependency file can no longer block verification of the installation package during cleanup.

[Release notes / Примечания к выпуску](docs/releases/0.10.9.md)

## 0.10.8 · Source recovery / Восстановление исходников

- Исправлена остановка обновления при проверке `PROVENANCE.json`. Исходники для сборки восстанавливаются побайтно из проверенной базы и накопительного пакета.
- Fixed an update failure during verification of `PROVENANCE.json`. The updater now reconstructs the exact source bytes from a verified base and the cumulative package.

[Release notes / Примечания к выпуску](docs/releases/0.10.8.md)

## 0.10.7 · Source file checks / Проверка исходников

- Fixed a source update that could stop at an unchanged file in a synced Windows folder with the message `File changed while opening`.
- Исправлена ложная остановка обновления при чтении исходников в синхронизируемой папке Windows. Переход с комплекта 0.10.5.1 возможен сразу на 0.10.7.

[Release notes / Примечания к выпуску](docs/releases/0.10.7.md)

## 0.10.6 · Cumulative updates / Накопительные обновления

- Apply the private update and build the plugin in one step. The installer and source snapshot use the same three-part version as the Obsidian manifest.
- Prepare the release files from the selected verified build. The source archive includes the working files accepted for that version.
- Установочные файлы появляются в `Rudonium-Builds/0.10.6/install/rudonium-anki-toolkit/` после успешного обновления и сборки.
- Для публикации проверенного комплекта предусмотрена команда `Prepare-Release.cmd`.

[Release notes / Примечания к выпуску](docs/releases/0.10.6.md)

## 0.10.5 · Settings and sync preview / Настройки и предпросмотр

- With preview off, bidirectional sync applies eligible changes in the background. Conflicting fields and changes requiring a decision remain available in **Preview now**.
- The help link and sync mode are at the top of settings. Interface language is at the bottom.
- С выключенным предпросмотром безопасные изменения синхронизируются в фоне. Конфликты можно разрешить вручную в разделе «Синхронизация и проверка».
- Сборщик хранит проверенные результаты отдельно от исходников. [Build / Сборка](PUBLISHING.md)

[Release notes / Примечания к выпуску](docs/releases/0.10.5.md)

## 0.10.4 · Obsidian review fixes

- Use the Obsidian settings heading API and the supplied stylesheet across settings, previews and dialogs.
- Sanitize card preview markup and render settings labels as text.
- Preserve the plugin identifier, commands, note formats and sync-state files.

[Review and build notes](docs/releases/0.10.4.md)

## 0.10.3 · GitFlic preparation on Windows

- Exclude workspace state in nested upstream test vaults while preserving Markdown fixtures.
- Keep checked sources when a subsequent release check fails. Add an interactive FreeFileSync comparison for a SourceGit clone.

[Release notes](docs/releases/0.10.3.md)

## 0.10.2 · Smaller source and release kits

- Keep the active user guides in English and Russian. Earlier release changes are recorded below.
- Open the toolkit sources in `project/` with `Open-Source.cmd`. Build and release commands use these edits.
- Publish the generated repository with editable TypeScript in `src/`, the dependency lockfile and indexed third-party notices. The installation ZIP contains the plugin and its distribution notices.

[English and Russian release notes](docs/releases/0.10.2.md)

## 0.10.1 · Windows release packaging

- Fix GitFlic preparation failing after Rollup on files from the upstream Anki test profile.
- Keep a verified unpacked plugin in `install/rudonium-anki-toolkit/` beside the completed release ZIP.

## 0.10.0 · Public beta on GitFlic

- Correct the folder tree’s pagination control so it appears when there are more visible rows to display.
- Package the matching manifest and runtime for the same version, with a source tree and bilingual release materials for GitFlic.

## 0.9.8 · Empty answers and sync settings

- Apply an empty Anki answer to a linked vocabulary line and retain its options and note ID. Retire the additional regex field section.
- Honor the automatic preview preference and expose the same preference inside the preview. Keep decisions available for manual review.
- Select a default deck from Anki, edit folder tags in a tree and switch languages at the top of settings. Correct the project link, attribution and version display.

## 0.9.7 · Regex note fields and whole-page controls

- Sync editable extra fields on linked regex notes in a delimited section below the Anki note ID. Existing capture groups retain their field positions.
- Use the same command position below the first H1 for suspending or deleting a linked whole-page note with any supported ID location.
- Set shared page fields with the configured FROZEN marker and keep their values separate from the question and answer.

## 0.9.6 · Sync added and removed named fields

- Clear an additional Anki field when its previously synced line is removed from a linked START/END block or whole-page card. A one-way export preserves fields that were only filled in Anki.
- During bidirectional sync, insert newly populated Anki fields in Markdown and resolve simultaneous edits per field. Leave missing, empty fields out of Markdown.

## 0.9.5 · Choose fields for a card page

- Add a missing field to a marked page from the command palette. The picker uses the cached fields for its Anki note type and accepts multiline values. Choose **Insert and add another** to enter several fields in one window.
- When a manually entered field name is unknown, suggest eligible fields from the page’s note type and show close spellings first.
- Keep a page’s omitted optional fields in Anki and suppress the request to add those fields to Markdown.
- Require the YAML property `anki-page-ID` for page links. Report marked pages that still contain `rudonium-id` so the author can verify the existing number and rename the property before syncing.

## 0.9.4 · Page tags and named fields

- Accept an `anki-page` YAML tag or a `#anki-page` tag in normal Markdown, including below the private-notes boundary. The first H1 supplies the question in each layout.
- Use `anki-page-ID` for new YAML links. Recognize the existing `rudonium-id` property and preserve its Anki note number.
- Support optional multiline fields after a separate `<!--anki-fields-->` marker. Page authors can keep a free-form answer and use the fields already defined in their Anki note type.
- Fill the selected file-link and context fields on whole-page notes. The context includes the vault-relative path and question heading.

## 0.9.3 · Page ID locations

- Store new whole-page links in YAML by default. A saved preference to link below the heading remains effective.
- Add a third location for page links, a hidden comment after the public answer. The `@page` suffix identifies the page owner.
- Preview ID moves across the entire vault, select the pages to convert and create a verified full-vault ZIP before writing to Markdown.

## 0.9.2 · Whole-page cards

- Select the ID location for newly linked pages. Move an existing link from the active editor and keep its Anki note ID.
- Keep reference notes below an explicit end-of-answer marker.
- Use the selected ID location in the page migration wizard and check ownership before applying a link.

## 0.9.1 · Desktop build fix

- Fix the TypeScript error in custom-regex export when validating a matched block.
- Fix the two TypeScript errors in Quick Start that accessed storage methods missing from the pinned Obsidian type definitions.

## 0.9.0 · First public beta candidate

- Preserve table IDs across a formatting gap and detect ambiguous ID annotations in cells. Preview custom rules on the active note and batch destination deck lookups.
- Use GitFlic for support in the settings, command palette, documentation and package metadata.
- Put the standard GPLv3 text in LICENSE and the fork and upstream credits in NOTICE.md. Include runnable tests in the source kit and compare release assets with two clean builds.

## 0.8.10 · Test beta

- Keep table and page IDs linked through supported formatting changes. Reconcile questions and answers for the five-capture Knowledge pattern and preserve ID annotations when dating a link.
- Name a rule and check its matches on the active note before saving it. Restore automatic first-run setup and make routine bidirectional previews optional.
- Defer edits to notes selected in Anki Browse, batch deck checks and reconcile ambiguous creation responses before writing IDs.

## 0.8.9 · Test beta

- Start offline and offer Quick Start as a manual palette command.
- Author multiline answers with the delimiter wizard and review reversible custom Markdown changes before applying them.
- Preserve temporarily inactive model rules and fix tag reconciliation, interrupted exports, markup recognition, source field transfers and card lifecycle commands. Batch independently verified outbound field edits and reuse inbound snapshots before local writes.

## 0.8.8 · Test beta

- Pin current-file sync to the original file, including when switching editors.
- When there are no configured rules or explicit cards, offer Quick Start.
- Generate and test single-line delimiter rules using the current note type's fields. Verify the field mapping before export.
- Preserve all captured fields on linked regex cards and skip metadata in generated rules. Clear and report missing file/context field assignments without switching them to the first field.
- Diagnose conflicting file-level deck destinations before writing.

## 0.8.7 · Test beta

- Recheck active Markdown on export, recognise RemNote language markers, refresh moved-card links and open repair directly from a missing-ID notice.
- Consume confirmed deletion commands, preserve past deletion choices and checkpoint small edits with a per-profile journal.
- Start new setups with RemNote and an empty default tag. Clarify the automatic scanning interval.

## 0.8.6 · Test beta

- Choose from five after-deletion actions, including portable whole-card strikethrough and a hidden HTML comment. Existing preferences and previous archive formats are supported.
- Use a confirmed Anki note ID, profile and source fingerprint from a successful bidirectional sync as evidence before applying an external deletion to Markdown.

## 0.8.5 · Test beta

- Keep a confirmed deleted Anki note in Markdown with its original content, ID and a visible archive label. Existing installations retain their previous deletion preferences.
- Edit several shared Anki fields in one FROZEN block, with a complete preview and one editor change.

## 0.8.4 · Test beta

- Pause a specific Anki card with a configurable marker and reconcile its status in bidirectional sync.
- Consume confirmed deletion commands and optionally remove linked blocks or move card pages to trash.
- Choose the note type and field when editing shared values in a Markdown note.

## 0.8.3 · Test beta

- Add **Check cards without an ID** to the deck audit and the command palette. Look for a missing link on demand, review exact matches, then restore selected IDs to Markdown after a vault backup.
- Separate source-file preview from optional ID recovery in the migration wizard. Checking an existing ID and looking for a lost one are distinct actions.

## 0.8.2 · Test beta

- Migrate supported one-card files from Anki Forge, Anki Bridge by Aaron Ade, Anki AST Sync and Anki Exporter.
- Offer to restore a missing Anki note ID in the migration wizard. Each proposed link requires an individual confirmation and is checked again before the Markdown is written. Existing Rudonium page cards can also be checked for a lost ID.
- Add **Sync this card** to the current-card preview. Review and apply changes for the card under the cursor, including when the open note contains other cards.

## 0.8.1 · Test beta

- Document the supported single-file formats for each migration source, including cases that need manual review.
- Adopt a separate number for each local test build and advance the minor version for every public GitVerse beta.

## 0.8.0 · Public beta

- Add a migration wizard for Markdown card files from other Obsidian plugins. Open it from Quick Start, settings or the command palette.
- Preview the original and converted card, select files and create a full vault ZIP before rewriting Markdown. Linked pages keep their verified Anki note IDs, note types, decks and tags. Files requiring a decision remain available for review.

## 0.7.0 · Public beta

- Missing-ID notifications now show one affected card at a time. Skip advances to the next record. Opening a source line keeps the audit or repair available beside the editor.
- Review one mismatch at a time, compare a candidate in Anki and expand the deletion controls only when needed.
- Configure a note type by adding a rule, choosing a preset or entering a custom expression. Quick Start shows a card preview and saves one type and format.
- Add opt-in whole-page cards and new question/answer formats. Use the page heading as the question and keep the Anki ID immediately beneath it.
- Keep unchanged source files in the cache when switching from the current note back to a full bidirectional scan. Reuse validated checkpoints when their bytes match.
- Start new installations in English. Support and author details now point to dashiwak and the GitVerse issue tracker.
- Begin the public beta series at 0.7.0 with parallel English and Russian guides. Earlier 1.x entries below retain the original labels of the development builds.


## Rudonium Anki Toolkit 1.6.6

- Custom Regexp ID validation now runs when the parser accepts a match. The installer no longer looks for a particular RegexNote constructor or result declaration.
- When patching, type checking or bundling fails, the builder writes a diagnostic report to `Build/build-error.txt`.

## Rudonium Anki Toolkit 1.6.5

- Fixed an overly strict installer match when adding the numeric-ID guard to Custom Regexp parsing in src/file.ts. Typed declarations and multiline constructor arguments are accepted.
- Added a regression test for those source forms, ambiguous matches and protection against malformed IDs before a note can be treated as new.
- The production ID is `rudonium-anki-toolkit`. Updating an existing 1.6.4 installation uses the same plugin folder.

## Rudonium Anki Toolkit 1.6.4

- Changed the production ID to `rudonium-anki-toolkit`. Install 1.6.4 in its own folder and review the transfer from the previous desktop installation. The migration copies the saved sync state and verifies it before the first export.
- Preserved additional top-level settings data across migration, initialization and subsequent saves. Disabling the plugin during the first migration check cancels initialization.
- Fixed the editor check for saved Windows Markdown files. A CRLF file whose editor uses LF can now be exported and previewed. Unsaved edits still require attention.
- When adding a new ID to an inline card, the writer inserts a separator if the preceding character is part of a word or another non-space token. A repeated export can verify the existing link.
- ZIP import preview now reports an invalid pending-import journal. ZIP creation rechecks open editors before finishing and discards its incomplete output if a selected note acquires an unsaved edit during verification.


## Rudonium Anki Toolkit 1.6.3

The manifest, About section and project documentation now credit the «Знание» project for Rudonium maintenance. New transfer ZIPs use Rudonium in the suggested filename. The assembled npm package is named `rudonium-anki-toolkit`.

## Rudonium Anki Toolkit 1.6.2

The normal production build emits the release license notice as part of Rollup output. The source kit includes a command to build two clean copies and compare them with the desktop release. Updated attribution, disclosures and submission instructions cover the original plugin, bundled dependencies and fork eligibility.

## Rudonium Anki Toolkit 1.6.1

- Harmonized the fork license in prepared package and lock metadata while preserving exact original upstream notices and metadata.
- Added provenance/source hashes, inclusive installed-dependency notices, license banner and a distribution directory with legal materials after a successful build.
- Added About license/origin information, attribution and name-policy documentation; kept the upstream licensing ambiguity explicit.
- Preserved card parsing, IDs, caches, synchronization algorithms and settings compatibility. No anti-fork activation or runtime license requests.

## Rudonium Anki Toolkit 1.6.0

- Renamed the display name; kept the existing plugin ID, state files and numeric Anki links.
- New dated IDs use `ID: <number> | YYYY-MM-DD`; the common reader accepts previous plain and HTML forms. Invalid numeric markers stop that file before writing; invalid dates retain the link and produce warnings.
- Added optional Live Preview ID badges, explicit previewed HTML-wrapper conversion with verified ZIP backup, and Open Current Card in Anki.
- Restored the original relative order of core settings, grouped advanced tools in collapsible sections, and moved Interface Language into About.
- Kept visual settings out of the card cache key. Added model benchmarks for 20,000 linked notes and standalone ID-format tests.
- Excluded Future-Mobile from the desktop source package.

## 1.5.1

- Fixes the six TypeScript diagnostics reported during the Windows 1.5.0 build: undo evidence now narrows outgoing field values to strings, and optional export-rule properties retain explicit string types after validation.
- Preserves rule validation, existing Anki IDs and the strict build gate. ID folding is not part of this patch.

## 1.5.0

- Combines archive selection, transfer packages and backups in one settings group. Existing Obsidian.zip backups can be opened directly for selective transfer or restored into a new folder.
- Adds bounded, read-only backup metadata inspection and labels for full and selected snapshots. A standalone ZIP remains usable without its sidecar manifest.
- Recognizes the files wrapper only with a valid, unambiguous transfer package marker; ordinary vault folders named files keep their paths.
- Rejects Anki collection ZIPs in the Obsidian importer. Backup snapshots remain complete for their selected scope, independently of delta transfer settings.

## 1.4.0

- Focuses the active build on desktop. The unchanged 1.3.0 mobile source kit is retained in `Future-Mobile/`.
- Adds an Archiving and Transfer settings group with a searchable folder tree, multiple included roots, priority exclusions, attachment selection and a default output directory.
- Shows file counts and source sizes before creation and supports SHA-256 based changed-only packages for each saved scope.
- Applies folder selection to Obsidian backups only when explicitly enabled, labels selected-area copies and separates their backup schedule from full copies.
- Keeps archive preferences outside card-export cache fingerprints.

## 1.3.0

- Adds a portable mobile ZIP receiver and sender with current-vault replacement, per-file comparison, explicit phone/computer choices and deferred conflicts.
- Returns changed Markdown and attachments with the original desktop package marker, then accepts verified ID-only writeback from the desktop.
- Preserves originals and recoverable import journals through Obsidian Vault and DataAdapter APIs.
- Adds a desktop ZIP exchange launcher and verifies phone packages against the mobile reader limits.
- Adds separate mobile and combined build commands with TypeScript, portable dependency and bundle checks before replacing files.

## 1.2.0

- Adds reviewed import of Markdown and attachments from an ordinary ZIP with root-folder mapping, paged selection, and content comparison.
- Adds phone packages with a desktop baseline to classify phone, desktop, and simultaneous file edits.
- Keeps receipts for repeated ZIP versions, validates numeric Anki IDs, and backs up selected originals before applying changes.
- Recovers interrupted imports and guards subsequent export until recovery is complete.
- Opens the existing scoped Anki export preview after import. Both export directions retain their existing scope rules.

## 1.1.0

- Reviews changes to Cloze numbering and optional reverse cards before writing. The export report shows verified Anki card IDs after the change. Verified missing sources can be reviewed for suspending or resuming individual cards.
- Adds export rules to named folder profiles. Rules can match a folder, heading, and YAML property and configure note type, fields, tags, and deck.
- Adds searchable per-card audit statuses and an explicit read-only check of new card candidates.
- Resolves reviewed attachment name collisions across notes and compares selected local and Anki attachment copies on demand.
- Supports opt-in additional plain-text fields in bidirectional sync for linked `START … END` blocks and one-line cards. The note type must contain `Front` and `Back`.
- Supports guarded reversal of eligible field and tag operations from the one-way journal.
- Adds a connection and example preview wizard for a fresh installation, also available in settings.

## 1.0.0

- Introduces a distinct plugin ID and a first-run migration review from Export to Anki.
- Keeps desktop AnkiConnect integration, Markdown formats, exact-deck audit, and verified note bindings from the v17.10 line.
- Prepares reproducible source and separate release assets for catalog submission.
