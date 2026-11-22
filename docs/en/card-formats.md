[English](card-formats.md) | [Русский](../ru/card-formats.md)

# Markdown card formats

Configure a format for an Anki note type in **Note type rules**. The first two captured values populate the first two fields in the Anki type’s field order. The examples below show the same question and answer. Use one of them in a note after selecting its format.

| Format | Use it for |
| --- | --- |
| START / END | A named note type and fields explicitly labeled with their Anki field names |
| RemNote · single line | A short question and answer separated by two colons |
| Neuracache · #flashcard | A tagged question followed by one answer line |
| Question and answer · Q: / A: | Questions and answers with visible labels |
| Spaced Repetition · ? separator | One question line and one answer line with a delimiter between them |
| Two-column table · one card | A complete, three-line Markdown table with one data row |
| Whole page · #anki-page | A dedicated page with the title as the question and the body as the answer |

## Build a rule from a separator

Select an Anki note type in **Quick Start**, or add or edit its rule in **Note type rules**. Open **Regular expression wizard**, choose the number of fields, enter a literal separator and try one Markdown line. For example, a four-field vocabulary note can use a colon:

```markdown
Wirtshaus : inn : ein altes Wirtshaus : de_DE
```

Check the four values beside the actual Anki field names. **Use this format** puts the expression in the current form. **Save Setup** or **Save rule** activates it. An existing rule opens with its saved field count and separator.

The fields must be nonempty and in the order used by the note type. Use a separator such as `||` if your field text contains colons. If one line matches two wizard rules, export reports its line number and both note types. Change one delimiter or rewrite that line. After a successful first export, keep the ID on the following line. With one-way export, editing this line updates the same Anki note. If the field order changes in Anki, refresh note types, open the wizard and confirm the new order.

### Multiline answers in the wizard

Choose **Answer layout → Multiple paragraphs**. For a two-field note, put the question on the line after `:::anki`. Start the answer on the next line. It can include blank lines, lists and colons. End the card with `:::` on a separate line. Export places the ID below it.

```markdown
:::anki
How do you recognize a Viennese inn?
The sign may say Wirtshaus.

Local dishes often appear on the menu.
:::
```

For three or more fields, put every field except the last on the first content line using your separator. A four-field header could be `Wirtshaus : inn : de_DE`, followed by the paragraphs of the fourth field. An incomplete block, a misplaced ID, a nested directive or a match for two competing note types produces an error with the affected line.

### START / END

Use the block markers from your settings and the exact names of your Anki type and fields.

```markdown
START
Basic
Front: Capital of Austria?
Back: Vienna
END
```

On a linked block the extra fields use these names to sync with Anki. [How changes to named fields sync](#how-changes-to-named-fields-sync)

### RemNote

```markdown
Capital of Austria? :: Vienna
```

Add language markers after the answer, for example `- Question?+++ :: Answer :: F=ru_RU :: B=de_DE`. The plugin fills `FrontLang` and `BackLang` when those fields exist in Anki. A two-field model receives the question and answer, and the language markers stay in Markdown. The `:: R` marker requires an `Add Reverse` field. Existing custom expressions keep their own capture rules.

### Neuracache

```markdown
Capital of Austria? #flashcard
Vienna
```

### Q: / A:

```markdown
Q: Capital of Austria?
A: Vienna
```

### Spaced Repetition

```markdown
Capital of Austria?
?
Vienna
```

### Two-column table

Use a separate table per card. The table contains its own headings, delimiter line and one data row. The ID follows the table.

```markdown
| Question | Answer |
| --- | --- |
| Capital of Austria? | Vienna |
```

### Whole page

Select **Whole page** (`@page`) for one Anki note type with at least two fields. Write the question in the first level-one heading (`#`) and a nonempty answer below it. Mark the page with the tag `#anki-page` anywhere in normal Markdown, or add `anki-page` to the YAML `tags` property. The tag identifies the page before it has an Anki ID. YAML properties, blank lines, comments and a line of tags can precede the H1. Place ordinary prose below the question. You can also put the tag below the private-notes boundary. It marks the page while the notes below the boundary stay in Obsidian. A tag inside a code example, a comment or a link does not mark the page. Once the page has an ID you can rename the file or edit the question and keep the same Anki note.

New page links use **In properties (YAML)** by default. If you already saved a location, Rudonium uses that choice. Changing it in **Anki ID Markers → ID location for card pages** applies to future links. A page already linked keeps the ID in its original location.

| Location | Where the saved ID appears |
| --- | --- |
| In properties (YAML) | The text property `anki-page-ID: '1700000000001'` above the heading. |
| Under the heading | An ID line below the question, plain or wrapped according to the ID comment setting. |
| After the answer | A separate hidden line such as `<!--ID: 1700000000001 @page-->` after the answer and before any private notes. |

Rudonium writes the ID when a page is linked to Anki. It recognizes `anki-page-ID` as the YAML link. Sync skips a marked page with the former `rudonium-id` key and reports it for correction. If that is the page’s only link, rename the YAML key and keep the digits and any date or comment. If both keys appear, check the Anki note number first and keep the verified number under `anki-page-ID` only. A personal YAML property named `ID` is independent of the link.

#### Additional Anki fields

To add a field in the editor, open the command palette and run **Add Anki page field…**. Choose a field from the saved definition of this page’s Anki note type, enter its value and confirm. For example, select `Example` and enter `Wir essen im Wirtshaus.` The command inserts the field and creates the section if needed. To enter several values, choose **Insert and add another** after each one and **Insert field** for the last. You can fill it while Anki is closed. Run your usual sync to send the change.

To write extra fields by hand, put `<!--anki-fields-->` on its own line after the main answer. Start each field on a new line with its exact Anki name and a colon. If a name is unknown, Rudonium shows the eligible names from this note type with the closest spellings first. Edit the name and sync again. Its value can continue on the following lines. The example uses the extra fields `Example` and `Translation`.

```markdown
---
tags: [anki-page, vocabulary]
anki-page-ID: '1700000000001'
---
# What does Wirtshaus mean?

An inn or tavern.

<!--anki-fields-->
Example: Wir essen im Wirtshaus.
Das Wirtshaus liegt am Marktplatz.
Translation: We are eating at the inn.
The inn is on the market square.

<!--rudonium-answer-end-->
My source: [[Field notebook]]
```

Anki receives the question, answer, example and translation as four separate values. Use the names that exist in your Anki note type. Each extra field can appear once. The two main fields already come from the heading and answer. A configured file-link or context field is filled by Rudonium. Write ordinary sentences containing colons freely above the field marker. In the **After the answer** layout the generated ID follows the last extra field. [How changes to named fields sync](#how-changes-to-named-fields-sync)

For example, a vocabulary note type with fields named `FrontLang` and `BackLang` can receive `FrontLang: ru_RU` and `BackLang: de_DE` on a one-way export. These language fields are protected from automatic edits back into Markdown.

For a simple question and answer you can omit the field section entirely. To keep personal notes on the same page, add `<!--rudonium-answer-end-->` on its own line before those notes. The optional boundary and everything below it stay in Obsidian.

With a local-notes boundary, the **Remove block** deletion policy keeps the Markdown page and its previous ID when the Anki note is deleted. This protects the private notes on later exports. The deletion preview shows this exception.

In the **After the answer** layout, the hidden ID follows the last field. A standalone `#anki-page` line may also follow that ID before any private notes. If dates are enabled, it can look like `<!--ID: 1700000000001 | 2026-11-20 @page-->`. The `@page` suffix distinguishes this link from an ordinary card ID in the answer. Suspend and delete commands for a footer-linked page belong immediately under its first H1.

#### Move existing page IDs

For a single open page, choose the destination in settings and run **Move this page ID**. You can undo this edit in Obsidian.

For a whole vault, open **Anki ID Markers → Move page IDs…**, select the current and destination locations, then choose **Preview**. Choose **Under the heading → In properties (YAML)** to convert older pages to the default layout. The preview covers the entire vault regardless of the active sync profile. Review the eligible pages and the reasons for any skips. Select the pages to move and choose **Back up and move (N)**.

Before its first change, Rudonium creates and verifies a ZIP of the entire Obsidian vault, including settings and attachments. If the backup fails, the files are left as they were. Each move keeps the same Anki note number and supported date. The conversion edits Markdown locally. If an ID has a personal annotation, move the annotation to a separate line or property and preview again. Keep the backup path shown in the result. The backup can be opened with **Saved Backups → Restore to New Folder**. [Migrate files from other plugins](migrate-card-files.md)

Yanki stores a page's Anki number in its properties. Deck To Anki also uses YAML for its Card and Title modes. Obsidian_to_Anki documents a hidden ID directly after the card fields. Rudonium adopts this placement for its third option and identifies whole-page footers with its own `@page` suffix. [Yanki](https://github.com/kitschpatrol/yanki-obsidian/blob/main/README.md#can-i-delete-the-noteid) · [Deck To Anki](https://github.com/PandaNocturne/obsidian-deck-to-anki/blob/master/README.md) · [Obsidian_to_Anki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki/Updating-existing-notes)

### Editing linked cards from Anki

A linked card made with the format wizard can receive plain-text edits from Anki, including paragraph breaks in the last field of a multiline card. Run bidirectional sync for its file. Expand the field, then **Preview this field in Markdown** to see the original block and the result of accepting that Anki field. When the same field changed on both sides, sync uses the later version if the timestamps establish an order. The preview shows the available directions. The comparison uses the Markdown file modification time and the Anki note modification time, at one-second resolution. On the first bidirectional sync, Rudonium first checks values confirmed by one-way export. Where those values do not establish a direction, it compares the Markdown file modification time with each linked Anki note’s modification time, including multiple note IDs in one file. If several mapped text fields on a note differ, the same first-sync comparison applies to those conflicts. After this first sync, Rudonium also checks for edits to neighbouring cards or other text in the file. Edits in the same second, missing timestamps or ambiguous later edits stay available for manual review. If the Anki value contains a field delimiter that would break Markdown, the preview can still offer a verified Obsidian → Anki edit or a skip.

Basic bold text is supported. For example, Markdown `**Marian Column**` corresponds to `<b>Marian Column</b>` or `<strong>Marian Column</strong>` in Anki. Tags with attributes, overlapping markup and ambiguous field mapping require manual review.

Simple hand-written single-line expressions are also reversible when they start with `^`, end with `$`, and separate `(.+?)` or `(.+)` captures with unambiguous literal text. For example, `^Q=(.+?) -> A=(.+)$` preserves the labels and separator. Anki text containing a field boundary, complex HTML and other arbitrary expressions require manual review. Capture order must still match the Anki note type. Extra captured fields follow their per-field direction settings. Generated and protected fields stay outside the plain-text mapping.

The plugin checks the proposed text with its export parser before applying it. Further edits after opening the preview, a different card owner or a changed destination require a fresh review. The ID, unaffected values and original line endings are preserved. Existing built-in formats retain their named field mappings, including `ob-deck-front` and `ob-deck-back` on migrated Deck To Anki pages.


### Custom regular expression

Use capture groups in the order of the Anki fields. For example, this expression maps two lines beginning with `Prompt:` and `Reply:` to the first and second fields. Enter the expression without surrounding slashes.

```regex
^Prompt: ([^\r\n]+)\r?\nReply: ([^\r\n]+)
```

```markdown
Prompt: Capital of Austria?
Reply: Vienna
```

In Quick Start, enter the example in **Sample Markdown** and click **Test sample** to inspect the captured values. Preview a real saved note before exporting. Changing its format can change which text matches. Keep any existing Anki IDs alongside the matching records.

#### Clearing a linked answer

Clear the answer of an already linked note in Anki, then run bidirectional sync. After you clear `Bahnhof`, Markdown looks like this. The empty answer keeps its place between the separators. The question, language option and note ID stay in place.

```markdown
- Как по-немецки «вокзал»? ::  :: B=de_DE
```

If you also edited the Markdown answer, open the preview and choose which edit to keep. One-way export uses Markdown as its source. Additional Anki fields outside the captures are not appended below the ID.

In one-way mode, editing a previously confirmed plain-text field in Markdown updates the same Anki note, even when someone also edited the text in Anki. An edit made only in Anki is kept. For a first-time difference, a concurrent edit and clear, competing edits to formatted content, formulas or cloze text, or a change that affects study cards, choose **Preview file export** in the notice and compare the values.

## How changes to named fields sync

These rules apply to editable additional fields on linked cards in `START` / `END` blocks and on whole-page cards. Here `Example` is a field in the Anki note type.

| What changed | One-way export | Bidirectional sync (both directions enabled) |
| --- | --- | --- |
| You deleted the entire line `Example: Vienna` after Rudonium synced it. | Clears `Example` in the same Anki note. If the Anki value also changed, export requests a review. | Clears it in Anki if its value there is unchanged. If someone also edited it in Anki, choose which change to keep. |
| You filled in `Example` in Anki. This card has never included that field in Markdown. | Keeps the value in Anki. | Adds `Example: …` inside the block or in the page’s fields section. |
| You cleared the value in Anki. Markdown still has the synced label and its previous value. | One-way export reads values from Markdown. | Clears the value in Markdown and keeps the label. |
| The field is absent in Markdown and empty in Anki. | Leaves it empty. | Leaves it empty on both sides. |

Rudonium needs a record of the field on this note from a successful sync to recognize a deleted line. Tracking starts in 0.9.6 for blocks and pages. If you remove the last field from a page, you can also remove the empty `<!--anki-fields-->` section. On a first export, it preserves Anki values for fields that are already absent from the source. To deliberately clear one that Rudonium has never seen here, write `Example:`, review the proposed change and confirm it. Clearing a field that affects which study cards Anki generates can also require confirmation. You can change an individual field’s direction under **Bidirectional sync → Additional fields**.

## File links and heading context

For a whole-page card you can enable either or both of these options. Under **Note type rules**, choose **File link field** and **Context field**. Assign them to separate fields in the Anki note type.

| Option | What the Anki field receives |
| --- | --- |
| **Add File Link** | An **Obsidian** link that opens the source. For a linked page the link includes its Anki note ID. |
| **Add Context** | The vault-relative file path and question heading, for example `Vocabulary/Food.md > What does Wirtshaus mean?`. The page tag is omitted. |

Run sync after moving the note or editing the question to refresh these values on the same Anki note. Leave the corresponding option off when you only need one of them.

After renaming or removing Anki fields, open **Note type rules** and click **Refresh**. Rudonium lists each missing file-link or context destination and switches that assignment to **None**. To resume adding that information, edit the rule for the named note type and select the replacement field.

## Further reading

The linked projects show the Markdown conventions that inspired these presets. The examples above describe the exact syntax Rudonium accepts. [RemNote single-line style](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki/RemNote-single-line-style) · [Neuracache style](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki/Neuracache-flashcard-style) · [Question and answer style](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki/Question-answer-style) · [Spaced Repetition](https://forum.obsidian.md/t/plugin-for-flashcards-note-level-spaced-repetition-all-inside-obsidian/16498)

## Test a rule on your own note

Open a representative Markdown note. In **Note type rules**, edit the rule, optionally enter a display name, change the expression and select **Check current note**. Expand a row to inspect the fields and ID. A Dataview property such as `Status:: In Progress` can match an unrestricted RemNote expression. Check the line numbers before saving.

For a two-column table, keep the ID on a separate line below the table. One blank line is allowed. For a whole-page card, keep the marker immediately below the first level-one heading when you select **Under the heading**. YAML properties and standalone comments before the heading remain in Markdown. A named rule changes the label in Rudonium and keeps the Anki note type.
