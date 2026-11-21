# Rudonium Anki Toolkit — source and license notices

This is an independently maintained, modified derivative of **Obsidian_to_Anki / Export to Anki**, originally developed by **Pseudonium and the upstream contributors**.

- Upstream repository: https://github.com/ObsidianToAnki/Obsidian_to_Anki
- Build base: release 3.6.0; expected commit `2dd39fefd26f3141a4e02105b1172a5a3eb2611f`.
- The fork builds on the earlier v16–v17 modifications to Export to Anki. The project adopted the Rudonium Anki Toolkit name in version 1.6.0. Version **0.10.3** is part of the first public beta series, prepared on **2026-11-21**.
- Rudonium additions copyright © 2026 **dashiwak** <dashiwak@yandex.ru>.

## License chosen for this distribution

The Rudonium additions and this derivative distribution are offered under **GNU GPL version 3**, SPDX `GPL-3.0-only`. The root [LICENSE](LICENSE) contains the standard GPLv3 text. Attribution for the Rudonium changes appears above and in [AUTHORS.md](AUTHORS.md). This choice does not revoke or replace permissions that original authors have separately granted for their materials. Existing copyright notices and third-party license texts must be retained as their applicable terms require.

The upstream currently presents conflicting indicators: a GPLv3 `LICENSE` and an MIT field in `package.json`. These have not been confirmed as an intentional dual-license grant. The exact historical files of the expected commit were not retrieved in preparing this source kit. Do not describe this audit as an upstream relicensing permission or as a resolution of that ambiguity. See `LICENSING-ru.md` and the snapshots produced by a successful build.

The build records the exact upstream legal files, metadata, and source hashes before modifying its temporary copy. These records are stored in `UPSTREAM-SNAPSHOT`; `PROVENANCE.json` identifies the expected source, observed metadata, and modifications. A supplied Git checkout lets the builder export the tracked files from that commit and record the Git-object verification. For a plain source directory it records the acquisition and hashes without authenticating the revision. Identifying the Git commit establishes neither authorship nor licensing authority.

## Changes and acknowledgements

Rudonium's changes include incremental export, deck audits, folder profiles and deck routing, previews and conflict review, recovery journals, bidirectional field/tag handling, image processing, backups and ZIP transfer, Russian/English interface, compatible ID/date parsing, ID presentation and conversion, and navigation to Anki. The changelog describes the successive releases. This is not a claim that every line or underlying concept originated in Rudonium.

Version 1.6.4 assigns the production plugin ID `rudonium-anki-toolkit` and supports migration from earlier installations. Development build 1.6.3 updated the then-current project credits. Version 1.6.2 moved the build notice into the production Rollup configuration and added an independent release comparison procedure. Version 1.6.1 introduced changes concerning license metadata, preservation of origin/third-party notices, the About section and release preparation. Card syntax, numeric IDs, settings data and synchronization algorithms are preserved.

## Dependencies and availability of source

Installed dependency notices are collected at build time under `LICENSES/dependencies`. The inventory includes development tools as well as potential runtime dependencies; it is **not** proof of which packages Rollup actually included or an automated legal compatibility opinion. Missing notices and unreadable packages are reported for review.

This source kit contains the fork modules and assembly scripts; it obtains the official base during a local build. For distribution of a binary, provide the matching complete assembled source, build configuration, dependency lockfile and required notices. Use `--prepare-repository` and the publication checks in `PUBLISHING.md`. Do not substitute this partial kit alone for the complete corresponding source of a binary.

The software is provided without warranty to the extent permitted by the applicable licenses. Name/origin guidance is in `TRADEMARKS.md`.
