# Rudonium Anki Toolkit — source and license notices

This is an independently maintained, modified derivative of **Obsidian_to_Anki / Export to Anki**, originally developed by **Pseudonium and the upstream contributors**.

- Upstream repository: https://github.com/ObsidianToAnki/Obsidian_to_Anki
- Build base: release 3.6.0; expected commit `2dd39fefd26f3141a4e02105b1172a5a3eb2611f`.
- The fork builds on the earlier v16–v17 modifications to Export to Anki. The project adopted the Rudonium Anki Toolkit name in version 1.6.0. Version **0.13.3** was prepared on **2026-11-28**.
- Rudonium additions copyright © 2026 **dashiwak**. [Project support](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue)

## License chosen for this distribution

The Rudonium additions and this derivative distribution are offered under **GNU GPL version 3**, SPDX `GPL-3.0-only`. The root [LICENSE](LICENSE) contains the standard GPLv3 text. Attribution for the Rudonium changes appears above and in [AUTHORS.md](AUTHORS.md). This choice does not revoke or replace permissions that original authors have separately granted for their materials. Existing copyright notices and third-party license texts must be retained as their applicable terms require.

The upstream currently presents conflicting indicators: a GPLv3 `LICENSE` and an MIT field in `package.json`. These have not been confirmed as an intentional dual-license grant. The original assembly recorded the files from a pinned archive URL. Revision verification and the captured files are listed in `UPSTREAM-SNAPSHOT/origin.json`. Do not describe this audit as an upstream relicensing permission or as a resolution of that ambiguity. See `LICENSING-ru.md` and `UPSTREAM-SNAPSHOT/`.

The build records the exact upstream legal files, metadata, and source hashes before modifying its temporary copy. These records are stored in `UPSTREAM-SNAPSHOT`; `PROVENANCE.json` identifies the expected source, observed metadata, and modifications. A supplied Git checkout lets the builder export the tracked files from that commit and record the Git-object verification. For a plain source directory it records the acquisition and hashes without authenticating the revision. Identifying the Git commit establishes neither authorship nor licensing authority.

Match the version in `PROVENANCE.json` under `release.version` to the version in `manifest.json` when inspecting a distribution. A source checkout can still carry the previous release’s evidence until a new build has recorded the candidate’s source and artifact hashes. The verified installation ZIP contains the new record in the plugin directory.

The source update for 0.13.3 retains dependency notices from the previous build. Its runtime dependency inventory is regenerated during the locked build.

## Changes and acknowledgements

Rudonium's changes include incremental export, deck audits, folder profiles and deck routing, previews and conflict review, recovery journals, bidirectional field/tag handling, image processing, backups and ZIP transfer, Russian/English interface, compatible ID/date parsing, ID presentation and conversion, and navigation to Anki. The changelog describes the successive releases. This is not a claim that every line or underlying concept originated in Rudonium.

Version 1.6.4 assigns the production plugin ID `rudonium-anki-toolkit` and supports migration from earlier installations. Development build 1.6.3 updated the then-current project credits. Version 1.6.2 moved the build notice into the production Rollup configuration and added an independent release comparison procedure. Version 1.6.1 introduced changes concerning license metadata, preservation of origin/third-party notices, the About section and release preparation. Card syntax, numeric IDs, settings data and synchronization algorithms are preserved.

## Dependencies and availability of source

Installed dependency notices are collected at build time under `LICENSES/dependencies`. The inventory includes development tools as well as potential runtime dependencies; it is **not** proof of which packages Rollup actually included or an automated legal compatibility opinion. Missing notices and unreadable packages are reported for review.

The full repository contains the plugin sources, build configuration, dependency lockfile and required notices. For a binary release, `Prepare-Release.cmd` packages the corresponding source snapshot and verifies it against the selected build. See `PUBLISHING.md` for the contents of each archive.

The software is provided without warranty to the extent permitted by the applicable licenses. Name/origin guidance is in `TRADEMARKS.md`.
