[English](README.md) | [Русский](README.ru.md)

# Rudonium Anki Toolkit

Write flashcards in Obsidian and review them in desktop Anki. Rudonium links each Markdown card to its Anki note by ID, so you can edit a question after studying it and keep the link to its review history.

**Repository and support:** [GitFlic](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit) is the primary development repository. The [GitHub repository](https://github.com/Dashiwak/rudonium-anki-toolkit) is a mirror for source-code distribution and Obsidian releases. Please send bug reports, questions, and feature requests to [GitFlic Issues](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue), or [contact the maintainer by email](mailto:dashiwak@yandex.ru).

[Documentation](docs/README.md) · [Quick start](docs/en/quick-start.md) · [Migrate existing card files](docs/en/migrate-card-files.md) · [Suspension, deletion and shared fields](docs/en/card-controls.md) · [0.10.3 beta release notes](docs/releases/0.10.3.md) · [Support on GitFlic](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue)

## What you can do

- Write a question and answer inline, in an explicit block, or on a dedicated page. Choose a named format for an Anki note type or enter a custom regular expression.
- Mark a page with `#anki-page` or add `anki-page` to its YAML tags. Use the first H1 for the question, write the answer below it and use **Add Anki page field…** to pick an extra field from the note type. Page IDs can live in YAML, under the question or after the public content. [Card page examples](docs/en/card-formats.md#whole-page)
- Migrate single-card Markdown files from Anki Forge, Anki Bridge by Aaron Ade, Anki AST Sync, Anki Exporter, Yanki, Flashcards v1/v2 by reuseman, Obsidian_to_Anki (Export to Anki), and Deck To Anki. The wizard previews changes and saves a full vault ZIP. [Supported formats and limitations](docs/en/migrate-card-files.md)
- Preview an export, check the destination deck and select the files to send. Use folder profiles when different collections of Markdown notes belong in different decks.
- Open **Preview Current Card** with the cursor in the card and choose **Sync this card** to review and apply changes to that card.
- Review edits on either side with bidirectional sync. A linked vocabulary card can receive an empty answer from Anki and retain its language, question and ID. [Example](docs/en/card-formats.md#clearing-a-linked-answer)
- Open a deck audit and choose **Check cards without an ID** if a Markdown card lost its link to Anki. Run this once, review the proposed links and choose **Restore selected IDs**. [How to recover IDs](docs/en/quick-start.md#recover-an-id-missing-from-markdown)
- Back up a vault or selected folders and exchange Markdown and attachments in ZIP packages. Optional Anki collection backup requires a desktop runtime with SQLite online backup support.
- After confirmed deletion in Anki, keep the text and ID, remove the block, add a status label, strike through the whole card or hide it in an HTML comment. Add shared values such as the book title and chapter to several Anki fields in one edit.

## Install

You need desktop Obsidian **1.15.1 or later**, desktop Anki, and the **AnkiConnect** add-on. Install the add-on in Anki, restart Anki and open the profile you want to use. [AnkiConnect](https://ankiweb.net/shared/info/2055492159)

1. In the GitFlic project’s Releases section, open tag `0.10.3` and download `Rudonium-0.10.3.zip`. [GitFlic project](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit)
2. Extract the ZIP into your vault’s `.obsidian/plugins/` folder. It contains the `rudonium-anki-toolkit/` directory with `main.js`, `manifest.json` and the stylesheet if the build produced one. If your vault uses a custom configuration directory, use it in place of `.obsidian`.
3. Open **Settings → Community plugins** and enable **Rudonium Anki Toolkit**. When updating, close Obsidian, replace the release files in the existing plugin folder and reopen the vault. The version in the plugin’s settings should be **0.10.3**.

To build from source, use Node.js 22.18 or later. After a successful GitFlic preparation, the unpacked plugin is in `GitFlic-0.10.3/install/rudonium-anki-toolkit/` and the installer is in `GitFlic-0.10.3/release/Rudonium-0.10.3.zip`. [Build instructions](PUBLISHING.md)

**Upgrading from a development build.** Back up the vault and Anki collection, wait for active sync operations to finish and disable the old plugin. Development builds 1.6.4–1.6.6 already use the current folder. Replace only the runtime files there and keep the settings, caches and journals. Install the 0.10.3 beta manually when upgrading from 1.6.6 because 0.10.3 has a lower version number. If you used `rupos-anki-toolkit` or the original Export to Anki plugin, keep its folder for the migration preview. Re-enable Rudonium and check the default deck before exporting.

## Set up your first card

Quick Start opens automatically when the vault has neither a configured format nor a complete pair of block markers. Reopen it from **Anki Connection → First Run** or the **Quick Start** command. English is the initial interface language. Check the connection, choose an ordinary Anki deck, select a note type and a Markdown format, and inspect both sides of the example. Save the setup, then use the quick start to export one note. To change the language later, use **Interface Language** at the top of the plugin settings. Reload the plugin to update command-palette labels. [Step-by-step guide](docs/en/quick-start.md)

## Data and access

The plugin sends the selected cards’ fields, tags, deck names and relevant media to AnkiConnect on the computer running Anki. The default connection uses local port 8765. Backups and ZIP transfers read and write the locations you select. Optional Anki backups read the local collection and its media. The plugin has no Rudonium account requirement or telemetry.

## Support and contributions

Open an issue on GitFlic in English or Russian. Include your plugin, Obsidian and Anki versions and a small Markdown example. The author of Rudonium is **dashiwak**. [GitFlic issues](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue) · [Contact dashiwak](mailto:dashiwak@yandex.ru) · [Contributing](CONTRIBUTING.md)

## License and credits

GPL-3.0-only. Rudonium is based on **Obsidian_to_Anki 3.6.0**, by Pseudonium and the upstream contributors. [License](LICENSE) · [Notices](NOTICE.md) · [Upstream](https://github.com/ObsidianToAnki/Obsidian_to_Anki)
