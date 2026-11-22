# Build and release guide · Сборка и выпуск

## Build from public sources

Use Node.js 22.18 or later with npm. In the directory containing `manifest.json` and `package-lock.json`, run the commands below. The lockfile pins the dependencies. The first installation needs access to those packages.

```sh
npm ci
npm exec --offline -- tsc --noEmit
npm test
npm run build
```

Rollup writes `main.js` next to `manifest.json` and `styles.css`. All three belong to the same plugin version.

## Prepare a release from an owner update

1. Keep the permanent SourceGit checkout `rudonium-anki-toolkit`, `Rudonium-Incoming` and `Rudonium-Builds` in the same parent directory.
2. Keep the original update ZIP in `Rudonium-Incoming` and extract it into its own folder there. Run its `Apply-Update.cmd`. The command validates the input, reconstructs the target sources and builds them in temporary storage. Local revisions such as Update 1 use the same version directory. After success the tested assets are in `Rudonium-Builds/<version>/install/`.
3. Check the plugin in a test vault and Anki profile. Once you accept the build, run `Prepare-Release.cmd` in the current repository, or run `npm run release:prepare` there. The command checks the selected sources and previously built assets and places the publication files in `Rudonium-Builds/<version>/release/`. Keep the verified copy of the full source ZIP in `Rudonium-Incoming` for recovery.
4. Review and commit the matching source tree in SourceGit. Point the three-part tag (e.g. `0.10.13`) at that commit on both remotes. Use the release notes and verified files below when publishing.

| Files in `release/` | Use |
| --- | --- |
| `main.js`, `manifest.json`, `styles.css` | Attach each file separately to the GitHub release for Obsidian. |
| `Rudonium-<version>-Install.zip` | Manual installation with distribution notices. |
| `Rudonium-<version>-Repository.zip` | Complete corresponding source snapshot. The same archive serves both remotes. |
| `SHA256SUMS.txt`, `RELEASE-NOTES.md`, `RELEASE-INFO.json` | Verify downloads, describe the release and identify the source used for the build. |

Attach both ZIPs and their SHA-256 sums on GitFlic and GitHub. The review workflow builds the tagged commit and can attest the runtime files. Local preparation and CI are separate from publishing the release.

## Сборка из исходников

В каталоге с `manifest.json` выполните четыре команды из начала инструкции. Нужны Node.js 22.18 или новее, npm и доступ к зависимостям из lock-файла. После сборки Rollup запишет `main.js` рядом с `manifest.json` и `styles.css`.

## Подготовка выбранной версии

1. Храните постоянный клон `rudonium-anki-toolkit`, входящие архивы `Rudonium-Incoming` и результаты `Rudonium-Builds` в трёх соседних папках.
2. Сохраните ZIP обновления в `Rudonium-Incoming` и распакуйте в отдельную папку. Запустите из неё `Apply-Update.cmd`. Локальные исправления, в том числе Update 1, используют ту же папку версии. После успешной проверки исходников и сборки возьмите плагин из `Rudonium-Builds/<версия>/install/`.
3. Проверьте плагин в тестовом хранилище Obsidian и профиле Anki. Когда выберете сборку для публикации, запустите `Prepare-Release.cmd` или `npm run release:prepare` из постоянного репозитория. Команда сверит исходники и готовые файлы сборки. Материалы для публикации появятся в `Rudonium-Builds/<версия>/release/`, а копия полного исходного архива — в `Rudonium-Incoming`.
4. Проверьте изменения в SourceGit и зафиксируйте соответствующие исходники. Отправьте один коммит с тегом версии, например `0.10.13`, на обе площадки. Для GitHub прикрепите `main.js`, `manifest.json` и `styles.css` отдельными файлами. Для ручной установки на обеих площадках разместите архив `Install.zip` с номером версии, для восстановления исходников — `Repository.zip`, для сверки — `SHA256SUMS.txt`. Описание для публикации находится в `RELEASE-NOTES.md`, сведения о сборке — в `RELEASE-INFO.json`.

[Установка](README.ru.md) · [Installation](README.md) · [Licenses and notices](NOTICE.md)
