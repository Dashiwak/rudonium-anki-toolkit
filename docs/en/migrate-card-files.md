[English](migrate-card-files.md) | [Русский](../ru/migrate-card-files.md)

# Migrate card files from another plugin

Use this wizard when one Markdown file represents one Anki note with a question and an answer. It rewrites the selected files in place, so their paths and links from other notes stay usable. You can inspect the proposed changes before making a backup and converting anything.

Cards written for Obsidian To Anki use Rudonium’s normal export, including block and inline cards and the original Anki IDs. Import your original plugin settings to keep custom delimiters, regular expressions and field mappings. For existing Rudonium pages, select their Anki note type for the whole-page format and use normal export. For a lost page ID, use **Check cards without an ID** from the deck audit.

## Start the wizard

1. Save open Markdown edits. Disable the plugin that previously synchronized these files. Keep its settings and data in the vault for the backup. Keep Yanki disabled for migrated folders. If its own ID disappears, a later Yanki sync can delete and recreate an Anki note, losing its review history. [Yanki’s explanation of note IDs](https://github.com/kitschpatrol/yanki-obsidian#can-i-delete-the-noteid)
2. Open the original Anki profile with AnkiConnect running. On a fresh Rudonium installation, open **Quick Start** from the command palette, choose **Migrate existing card files**, check the connection and choose **Continue to migration**. On an existing installation run **Migrate card files** from the command palette, or open **Card file migration → Open wizard** in Rudonium settings.
3. **Folder to search** starts at **Entire vault**. Click it and type part of a folder name or path, or expand the folder tree. Press Enter to select an exact path or a unique match. Use the arrow keys or click **Choose** for other matches. The wizard still checks for duplicate IDs across the vault. To detect Yanki IDs automatically, keep the disabled Yanki installation in the vault. To include unmarked Yanki files, select **Yanki** and its original folder. If that folder was the vault root, explicitly choose **Entire vault including unmarked Yanki files**. Folders suggested from existing `noteId` properties are search hints. A horizontal rule alone does not establish that a file was a flashcard.
4. Choose the default Anki note type for new pages. If **Note type rules** already assigns `@page`, use that type. Otherwise the wizard can add page recognition alongside an existing regular expression. Select **Preview files**. Rudonium verifies the IDs already present and lists eligible files without an ID under **Not checked**.
5. To include cards without an ID, choose **Check cards without an ID**. This searches once in the selected migration scope. Review any proposed links individually. In **Ready**, select the files to convert. If you select a file that was never exported, confirm that its first normal export can create an Anki note. **Needs review** explains why a file was set aside. **Already supported** lists native cards, including any foreign-looking file that already exports through an active note type rule.
6. Choose an external backup folder and select **Back up and convert**. Keep the displayed ZIP path. Open a converted file and preview its next export to check the Anki note and destination.

## Recover a missing note ID

After choosing **Check cards without an ID**, select **Exact Anki match**. Expand the proposed Anki note to read the question and answer, then check its type, deck and numeric ID. Tick **Link to this note** on that file if it is your original record. Each checkbox confirms one file and one ID. Choosing **Select all ready files** leaves these decisions to you. A fresh preview clears earlier link confirmations.

The wizard offers a link when both fields, note type and deck match exactly and one available Anki note qualifies. Where the file carries no original type or deck, check your selected type and the destination deck for that file before searching. It checks for existing ID references across the vault, including outside the selected folder. After verifying the ZIP the wizard checks the proposed link again before writing it into Markdown. Subsequent exports can update the original Anki note and retain its review history. Different answers, multiple matches or another file already using the ID require manual review.

For cards already in Rudonium format, you can run **Check cards without an ID** directly from a deck audit or the command palette. A whole-page card keeps its first H1 and page tag and the recovered ID uses the location selected in **Anki ID Markers**. If you are moving cards from another plugin, run the check in the migration wizard so it reads their original format. [Recover an ID in Rudonium](quick-start.md#recover-an-id-missing-from-markdown)

## Which files can be converted?

| Source | Recognizable one-card file | What can require review |
| --- | --- | --- |
| Yanki (Basic) | A one-line question, a blank line, a line containing only `---`, and a nonempty answer. Yanki saves its Anki note ID in the YAML property `noteId`. | Reversed, typed-answer and cloze cards have different Anki behavior. |
| Flashcards v1/v2 by reuseman | One basic card takes up the entire file. Supported forms include a tagged question or heading (`#card`), a `[!CARD]` callout, or a fenced `flashcard` block with `front` and `back`. Explicit source selection also allows an unmarked single-line `question :: answer` or a supported YAML `test` cue. | Several cards, reminders, reversed cards, cloze, custom syntax and ambiguous source IDs. A v1 numeric block anchor can carry the note ID. A v2 `^q-…` anchor needs a corresponding numeric `nid` in the `flashcards` property. |
| Deck To Anki | YAML `deckType: card` with a front/back separator, or `deckType: title` with the filename as the front. These modes store an existing Anki note ID in `deckID`. | Heading, list and file-index decks may represent many cards. Archived cards, custom decks and incompatible templates require review. |
| Anki Forge by keptan | One Basic `Q::A` or `Q #card` with its answer. A final `^af-…` block anchor is preserved. A YAML `anki-deck` value identifies the source deck. Select this source explicitly for shared syntax without a Forge marker. | With a Forge anchor or recognized previous plugin data, confirm the original Anki link. Custom separators, multiple cards, cloze and reversed cards require review. |
| Anki Bridge by Aaron Ade | A single Basic or multiline Dump card with its `%%oab:…:v1%%` markers. With the original registry, the expected deck begins with `Obsidian Flashcards`, followed by the vault name, folder path and file stem. | A recognized previous registry requires a verified link. Multiple cards, outside text, reverse, list, cloze and image occlusion need review. |
| Anki AST Sync | One Basic card in a file with YAML `AnkiSync: on` or `true`. The default layout is a fourth-level heading, a separate `:::` line and an answer. A single question line between the heading and separator is also supported. Its heading is retained in YAML under `rudonium-source-heading`. | A stored AST UUID is a source key and needs a verified Anki link. Multiple sections, custom models, transclusions, reverse, typed answers and cloze require review. |
| Anki Exporter by Erik Mielke | One line in the form `Question :: Answer`, with one space on either side of `::`. A numeric `<!-- anki-note-id:123456789 -->` immediately above identifies an exported note. Select the source explicitly when the marker is absent. | Several cards, surrounding prose or an invalid ID need review. |
| Spaced Repetition | Auto-detect recognizes a local schedule comment starting with `<!--SR:!`. | The file is listed for review. A local schedule does not identify an existing Anki note or transfer review history into Anki. |

If a file stops converting after the ZIP is created, keep the archive and run the preview again. Rudonium recognizes pages already marked `#anki-page`.

The table covers the one-file layouts recognized by Rudonium. Source format details are maintained by the respective projects. [Yanki](https://github.com/kitschpatrol/yanki-obsidian) · [Flashcards](https://github.com/reuseman/flashcards-obsidian) · [Obsidian_to_Anki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki/Note-formatting) · [Deck To Anki](https://github.com/PandaNocturne/obsidian-deck-to-anki#parse-modes) · [Anki Forge](https://github.com/keptan/obsidian-anki#your-first-cards) · [Anki Bridge](https://github.com/aaronade0/obsidian-anki-bridge#card-formats) · [Anki AST Sync](https://community.obsidian.md/plugins/anki-ast-sync) · [Anki Exporter](https://github.com/erikmielke/Obsidian2Anki#smart-sync) · [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition)

**Better Flashcards.** This is a fork of Flashcards. For a file using their shared syntax, choose **Flashcards** and inspect the preview. The wizard checks that Better Flashcards is disabled before writing. Formats specific to the fork have not been tested separately. [Better Flashcards project](https://github.com/mihirpatel1112/better-flashcards#attribution)

**Earlier settings and other writing styles.** Earlier Rudonium (`rupos-anki-toolkit`) and the original Export to Anki have a separate settings migration. RemNote and Neuracache are available as writing presets for new notes. [Card formats](card-formats.md)

## What a converted file looks like

A compatible linked file becomes an `@page` card with the question in its first H1. **ID location for card pages** controls where the verified Anki ID is written. By default the wizard stores it in the YAML property `anki-page-ID`. If a marked Rudonium page still uses `rudonium-id`, verify its Anki note number and rename the property to `anki-page-ID` before resuming the migration. You can instead choose **Under the heading** or **After the answer**. The latter puts a hidden HTML comment with the `@page` suffix at the end of the public answer. For example, **Under the heading** produces this layout for a verified link.

```markdown
# What is the capital of Austria? #anki-page
<!--ID: 1700000000001-->
<!--rudonium-page-route: ["Yanki - Basic","Geography"]-->

Vienna.
```

The hidden line below the marked heading records the verified model and deck. Rudonium can also preserve the linked note’s Anki tags in a hidden comment. Leave these comments with the page. The wizard keeps unrelated YAML properties and recognized Flashcards block anchors. A Deck To Anki basic note can use the named `ob-deck-front` and `ob-deck-back` fields. An unlinked page has no saved ID. The normal export writes an ID after Anki creates the note. Migrating a page and exporting it to Anki are separate actions. [Whole-page card format](card-formats.md)

## Recover the original files

Keep the full pre-migration ZIP until you have checked your cards. It contains the vault files, including Obsidian settings, installed plugin data and attachments. The Anki collection is stored separately by Anki. To inspect the original vault, open **Saved Backups**, enter the ZIP path and choose **Restore to New Folder**. Open the restored folder as a separate vault and check its Markdown files before enabling any synchronization there.
