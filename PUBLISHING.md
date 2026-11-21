# Building and distributing Rudonium Anki Toolkit

## Build from a checkout

Use Node.js 22.18 or later with npm. Run these commands in the repository containing `manifest.json` and `package-lock.json`.

```sh
npm ci
npm exec --offline -- tsc --noEmit
npm test
npm run build
```

Rollup writes `main.js` to the repository root. The plugin also needs the matching `manifest.json` and `styles.css`.

On Windows, `Prepare-GitFlic.cmd` prepares a verified distribution from the same checkout. Its cross-platform equivalent is `npm run release:prepare`. It builds in a temporary directory and compares the runtime files with two independent clean builds. The output is placed beside the checkout under `Rudonium-Builds/<version>.<build>/`. The manifest supplies the public version. The positive integer `rudoniumBuild` in `package.json` identifies this working build. Changed builds of the same release use successive build numbers. The command prints the full output paths and preserves earlier builds.

| Destination | Files from the verified build |
| --- | --- |
| Test vault | Copy the contents of `install/rudonium-anki-toolkit/` into the matching plugin directory with Obsidian closed. Preserve local `data.json` and sync journals. |
| GitFlic release | Attach the ZIP and `SHA256SUMS.txt` from `release/`. |
| GitHub release for Obsidian | Attach `main.js`, `manifest.json` and `styles.css` separately from `install/rudonium-anki-toolkit/`. |

Keep the public tag and the manifest version identical, for example `0.10.5`, and publish that same commit to both remotes. GitHub Actions can verify the branch build. On a matching release tag it can also attest the verified runtime files. The published files must match the attested bytes. [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

## Сборка и публикация

Для Windows запустите `Prepare-GitFlic.cmd` из корня репозитория. Нужны Node.js 22.18 или новее, npm и доступ к зафиксированным зависимостям. Сборщик сверяет три установочных файла с результатами двух чистых сборок. Готовые файлы лежат рядом с репозиторием в `Rudonium-Builds/<версия>.<сборка>/`. Например, для первого комплекта версии 0.10.5 это `Rudonium-Builds/0.10.5.1/`. Ранее созданную папку сборщик сохраняет. При ошибке откройте `Build/build-error.txt` в репозитории.

Проверьте синхронизацию в отдельном хранилище и профиле Anki. Для GitFlic возьмите ZIP и контрольную сумму из `release/`. Для GitHub приложите три отдельных файла из `install/rudonium-anki-toolkit/`. В каталоге Obsidian используется номер из манифеста, например `0.10.5`. Тег на обеих площадках должен указывать на один проверенный коммит.

В комплект входят лицензия, уведомления и сведения о происхождении исходников и установочных файлов. [Уведомления](NOTICE.md) · [Установка](README.ru.md) · [Проверка плагина в каталоге](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
