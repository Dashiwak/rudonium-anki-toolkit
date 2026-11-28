# Switch from Obsidian_to_Anki to Rudonium

If you already study cards written with Obsidian_to_Anki, you can keep their Markdown, Anki note IDs and review history. On first setup, Rudonium can copy the old plugin’s saved settings in the same vault. Existing blocks, inline cards and cards matched by a custom regular expression can stay in their original files.

## Switch plugins in your vault

1. Save your open notes and enable **Rudonium Anki Toolkit** in the vault you used with Obsidian_to_Anki. Leave the old plugin installed so its saved settings are available.
2. If the old plugin is still enabled, choose **Open Obsidian to Anki** in the transfer window. Turn off the old plugin under **Settings → Community plugins**. Rudonium detects the change. If you closed the window, use **Switch to Rudonium** in the left ribbon or **Review migration** in the command palette.
3. In **Move settings to Rudonium Anki Toolkit**, check that the source folder is `obsidian-to-anki-plugin`. Choose **Use existing settings**. If a previous transfer stopped partway through, choose **Resume migration**. The transfer copies plugin settings and available sync data. Your Markdown files and Anki collection stay in place.
4. Open the Anki profile you used before and leave AnkiConnect running. One-way export keeps your previous settings. Bidirectional sync, automatic backups and the change log start off. If you had scheduled exports, the old **Auto-scan interval (minutes)** still applies. Set it to `0` if you want to check a card manually before the next scheduled export.

After the transfer, the ![Anki ribbon icon](../../Images/anki-ribbon-sync.png) button in the left ribbon runs **Rudonium — Sync vault with Anki** for the imported folder scope. Use the single-card preview below to check your first linked block.

If Rudonium already has saved settings, it keeps that configuration. You can compare the values below with your old setup and adjust individual rules.

## Check one note type

In Rudonium’s settings, open **Note type rules**. With Anki running, click **Refresh** if you need to reload the note types and their fields. Find a type you used and click **Edit**.

| What you used in Obsidian_to_Anki | What to check in Rudonium |
| --- | --- |
| A custom regular expression | **Card format** shows the matching preset or **Custom regular expression**. Check the expression and the order of the Anki fields. |
| A block with no regular expression | Under **Syntax Settings**, check **Begin Note** and **End Note**. The block format shows your saved markers, including custom markers such as `!--` and `!---`. |
| A link to the source note | **File link field** should show the Anki field you selected, for example `File`. **Defaults → Add File Link** controls whether Rudonium writes that link. |
| A source path and heading | **Context field** should show the field you selected, for example `Context`. **Defaults → Add Context** controls whether Rudonium appends the path and heading. |

Obsidian_to_Anki offered the first Anki field as a default destination. Rudonium lists an imported type when it has a regular expression or a file link **or** context mapping to a field other than the first. For example, if only `EnDic26` used dedicated `File` and `Context` fields and all other types kept their defaults, you should see one imported rule. Explicit blocks still work for other note types named in your Markdown. You can add a rule later if you want to customize one.

## Check a linked block before exporting

Suppose your old start and end markers are `!--` and `!---`. A vocabulary block might look like this in Obsidian’s source mode:

```markdown
!--
EnDic26
-FW: look young
-NW: выглядеть молодо
-FE: She still **looks young** for her age.
!---
```

Here `EnDic26` is the **Anki note type**. The deck can have the same name. The first and last lines are the saved markers, and `-FW`, `-NW` and `-FE` are the actual field names. On a previously exported block, leave its existing ID line in place.

1. Open a note containing one of **your existing linked cards**, put the cursor inside the block and run **Preview Current Card**. The preview is read-only.
2. Check **Note Type**, **Deck** and **Anki ID**. The number should match the ID already in your Markdown. Under **Fields**, check the question, answer and any enabled file link or context. If a previously studied card says **New note**, close the preview and check its ID and markers before syncing.
3. Run **Open Current Card in Anki** to inspect the linked note in the original profile. When you are ready to send an edit, return to its preview and choose **Sync this card**.

## Restore a block that survives only in Anki

In the deck audit, choose **Restore Note in Obsidian** beside the missing record. Rudonium looks for the Markdown file using the file link or path in the Anki context field. Check the destination or choose another file by typing part of its name or folder path.

The draft uses the configured block markers, field names and the original Anki note ID. Tags such as `2col` appear under the note type and as editable hashtags at the end of the first field, for example `-FW: LOOK YOUNG #2col`. Keep the generated ID line intact, including the optional `@field-tags` marker. It tells Rudonium to export those hashtags as Anki tags even if importing tags from the rest of your vault is disabled. Compare the draft with the original using **Open in Anki**. You can edit or copy the Markdown before adding it.

By default the block goes at the end of the chosen file. To place it earlier, select the line before which to insert it and check the surrounding text in the preview. Choose **Add** to write the draft at that position. Rudonium preserves the ID linking the restored block to your existing Anki note.

[Quick start](quick-start.md) · [Card formats and examples](card-formats.md) · [How Obsidian_to_Anki writes file links and context](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki/Obsidian-Integration)
