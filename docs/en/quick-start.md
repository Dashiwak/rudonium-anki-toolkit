[English](quick-start.md) | [Русский](../ru/quick-start.md)

# Quick start

Your first export will send one card from a saved Markdown note to Anki.

Already have card files from another plugin? From Quick Start choose **Migrate existing card files**. The [migration guide](migrate-card-files.md) explains the preview, source formats and full vault backup.

Quick Start opens automatically when the vault has no configured format or complete block markers. You can reopen it from **Anki Connection → First Run** or the **Quick Start** command. Anki can be offline when the wizard opens.

## Install or update

Download the install archive (`Rudonium-<version>.zip`) from the latest published release. Close Obsidian and extract the archive into your vault’s `.obsidian/plugins/`. Reopen the vault and enable the plugin in **Settings → Community plugins**. [GitFlic project](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit)

If Rudonium’s settings show a different version from the release you installed, close Obsidian and replace `main.js`, `manifest.json` and any stylesheet together from the same release in `.obsidian/plugins/rudonium-anki-toolkit/`. Keep your settings, caches and journals. Reopen the vault. Select **Interface Language** just above **About the plugin** in settings to change the language.

## Connect

1. Install the [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159), restart Anki and open the profile where you want to create the card.
2. In **Quick Start**, click **Check Connection** and check the displayed Anki profile. Choose an ordinary deck, a note type such as **Basic**, and keep the preset **RemNote** style. For this example, the type should have a question field followed by an answer field.
3. Look at the sample Markdown and the front and back in the wizard. For the appearance of your Anki template, open **More options → Preview Anki template**. Select **Save Setup**. You can reopen Quick Start from the command palette.

On a new installation, bidirectional sync is off and the default tag field is empty. Enter a tag if you want it added to exported notes. **Auto-scan interval (minutes)** controls how often your notes are checked for export. Leave it at 0 to run scans manually.

In plugin settings, choose the default deck from the active Anki profile. A subdeck keeps its full name, such as `Knowledge::Deutsch`. If decks are unavailable, open Anki and refresh the list. To assign tags to a folder, use the arrow next to its parent or search by path. A button to show more folders appears only when expanded branches or search results contain more rows.

## Export one card

In a Markdown note inside your selected folder, enter this line and save the note.

```markdown
What is the capital of Austria? :: Vienna
```

1. Put the cursor inside the example and run **Preview Current Card** from the command palette. Check its question, answer and deck.
2. Select **Sync this card**. Review the proposed creation and confirm the export. Rudonium writes the Anki note ID next to the card. Keep this ID with the card when editing it.
3. With the cursor still in the card, run **Open Current Card in Anki**. You can use the same preview to check a later edit in a note containing several cards. If you edited the Markdown after opening the preview, save it and reopen the preview.

The bidirectional preview checks notes that already have IDs. To add a new card, place the editor cursor inside it and choose **Preview new card at cursor** in the bidirectional preview. Review the card, choose **Sync this card** and confirm creation. Other drafts in the note stay available for later.

Enable **Bidirectional sync** and select **Sync now** beside it. The ribbon button runs the same check. With preview off, verified changes are applied immediately. When the same linked field changes on both sides, sync uses the later version by default if the timestamps establish an order. To choose these values manually, expand **Sync settings** below the **Bidirectional sync** row and turn off **Apply the newer edit**. Open the preview from the same section, choose a direction with the arrows beside the field and apply the selection.

## Sync one file

From the command palette, choose **Sync Current File with Anki**. One-way export processes the recognised cards in the open Markdown file, including new cards. For a linked note with a confirmed previous sync, concurrent text edits take the Markdown value during one-way export. A change made only in Anki stays in Anki. Review ambiguous or potentially destructive changes in the export preview. Bidirectional mode applies verified changes to linked records and reports the result of a manual run. Turn on **Preview every sync** to review each run. Conflicting edits with equal or unavailable timestamps stay pending in the preview. Deletions also await confirmation there. Choose **Preview now** in the sync settings when you want to review them. The same preference is available inside the preview. Use the cursor action for a new card. The preview shows the selected path, and switching tabs keeps the original target.

## Add another format

To export a line with four fields separated by a colon, choose the note type, open **Regular expression wizard**, and enter a sample. The preview shows each value next to its Anki field. Choose **Use this format**, then save the setup. [Wizard example and supported direction](card-formats.md#build-a-rule-from-a-separator)

In the plugin settings, open **Note type rules** and choose **Add rule**. Select a note type from the active Anki profile and pick a format or enter a custom expression. The optional file link and context fields belong here. Choose destination fields and enable the corresponding **Add File Link** or **Add Context** setting to include that information. Save the rule. To change a format already assigned to a type, edit that type’s rule. [Markdown format examples](card-formats.md)

For a **whole-page card**, select the page format for its Anki note type. Mark the note with `#anki-page` in normal Markdown, or add `anki-page` to the YAML `tags` property. Write the question in the first H1 and the answer below it. On first link the default ID location is the YAML property `anki-page-ID`. In the editor, **Add Anki page field…** lets you choose an extra field and enter a value. When upgrading a marked page that still has `rudonium-id`, rename that key to `anki-page-ID` and keep the original digits. [Page examples, optional fields and ID locations](card-formats.md#whole-page)

```markdown
# What is the capital of Austria? #anki-page

Vienna.
```

## Recover an ID missing from Markdown

If a card you have already studied lost its ID in Obsidian, open the deck audit and choose **Check cards without an ID**. The audit checks the chosen deck within the active folder profile. To include cards assigned to different decks in that profile, run **Check cards without an ID** from the command palette. The search runs once per request, independently of ordinary synchronization and the initial audit.

Under **Ready to restore**, each suggestion matches the question, answer, note type and deck of exactly one Anki note with an ID available in the vault. **Needs manual review** lists conflicts. **No exact match** can include new drafts and previously exported cards whose fields, note type or deck have changed. Tick the links you recognize and choose **Restore selected IDs**. Rudonium creates a full vault ZIP and checks the links again before writing IDs into Markdown. Your Anki notes and review history stay in place.

## If Markdown has an ID but the Anki note is missing

Confirm that the expected profile is open in Anki. Run **Check Default Deck with Anki → Check Deck Without Writing** and open the affected record. Choose **Review Repair** on a missing-ID notification to check the deck without writing and open repair for that specific ID. **Skip** moves to the next missing record. The audit report keeps the complete list. When you open the source line from the audit or repair view, the report stays alongside the editor. Use Previous and Next in repair to review one record at a time. Compare a candidate’s fields before choosing a replacement ID. [Support on GitFlic](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue)

[Suspension, deletion and shared fields](card-controls.md)

## When an export sends nothing

With the RemNote preset, `- What is the restaurant called? :: Wirtshaus zum Raxkönig :: B=de_DE` is one card. If the note type has a `BackLang` field, it receives `de_DE`.

Place the cursor in the new line, open **Preview Current Card**, and choose **Sync this card**. After confirming creation, look for the Anki note ID in Markdown. A change in file size triggers a check. Adding a space around the separator can leave the exported fields identical, so there is nothing to write to Anki.

## Duplicate ID or interrupted export

If two Markdown cards carry the same ID, open **Review Duplicate Anki IDs**. Compare the listed source lines, keep the ID on its original card and save your changes. Use a link to refer to that card elsewhere. Choose **Recheck**, then sync the edited file.

If an export stopped after creating a note in Anki, open **Review Pending Anki Creations**. Check the profile, file and candidate in Anki before choosing **Recheck and Recover**. This links the original Markdown card to the recovered note.

## Back up and restore a vault

Under **Vault Backup**, choose **Create Backup Now**, or enable **Automatic backup before export** and set an interval in days. The default destination is the `Obsidian Anki Backups` folder beside the vault. **Include Anki collection** also backs up the active profile when the local desktop runtime supports SQLite online backup. Select your vault ZIP and choose **Restore to New Folder**. Open that folder in Obsidian to check the restored notes before copying anything back.
