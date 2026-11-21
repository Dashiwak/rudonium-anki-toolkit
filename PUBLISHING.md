# Building and releasing Rudonium 0.10.3 / Сборка и публикация

Use Node.js 22.18 or later and npm. The project uses Obsidian to Anki 3.6.0 at commit `2dd39fefd26f3141a4e02105b1172a5a3eb2611f`. [Upstream source](https://github.com/ObsidianToAnki/Obsidian_to_Anki/tree/2dd39fefd26f3141a4e02105b1172a5a3eb2611f) · [Release notes](docs/releases/0.10.3.md)

## Windows preparation kit / Комплект Windows

| Task / Задача | Command / Команда | Result / Результат |
| --- | --- | --- |
| Build for local installation / Собрать для своего хранилища | `Build-Plugin.cmd` | `Plugin-0.10.3/main.js`, `manifest.json`, styles when present |
| Edit the source / Открыть исходники | `Open-Source.cmd` | `project/src/` |
| Prepare GitFlic publication / Подготовить публикацию | `Prepare-GitFlic.cmd` | `GitFlic-0.10.3/repository/`, `install/`, `release/` |

Run the commands from the extracted kit. Once `project/` exists, both build launchers use your edits there. For configuration changes, edit the matching files at the root of `project/`. Each build prints the output path when it completes.

Распакуйте комплект и запустите нужную команду. Если вы открыли исходники, обе сборочные команды используют вашу папку `project/`. Основной код находится в `src/`, инструменты подготовки релиза — в `Build/`.

## Build from the editable kit

Run these commands from the editable kit (`project/` in the Windows package). Downloading the pinned upstream source and npm packages requires a network connection. If the upstream download fails, supply a local copy of the official commit. The builder verifies a Git checkout and records the origin of an unpacked source directory as unverified.

| Task | Command |
| --- | --- |
| Build into `Release-0.10.3/` | `npm run build` |
| Build with a local upstream checkout | `node Build/build-main.cjs "../Obsidian_to_Anki"` |
| Prepare the complete public source and install ZIP | `node Build/prepare-gitflic.cjs` |
| Prepare with a local checkout and new output directory | `node Build/prepare-gitflic.cjs "../Obsidian_to_Anki" "../GitFlic-0.10.3"` |
| Prepare a standalone public source tree | `npm run prepare-repository -- "../Obsidian_to_Anki" "../rudonium-public"` |
| Compare an existing set of runtime files with two clean builds | `node Build/verify-rebuild.cjs . "../candidate" "../Obsidian_to_Anki"` |

For the comparison, put the original `main.js`, `manifest.json` and any generated `styles.css` in the candidate folder. The verifier checks byte equality, including whether the stylesheet was generated. Release preparation runs the clean-build comparison automatically. If a build stops, read the first error in the terminal and check `Build/build-error.txt` in the editable kit.

## Work in the public repository

The generated repository has ordinary TypeScript sources, Rollup configuration, a dependency lockfile, tests and notices. From a clean checkout, run the following commands. The output is `main.js` in the repository root.

```sh
npm ci
npm exec --offline -- tsc --noEmit
npm run build
```

The source kit downloads the pinned base during assembly. A checkout of the assembled repository already contains that base. In the prepared repository, `PROVENANCE.json` records source and binary hashes, `UPSTREAM-SNAPSHOT/` identifies the original revision, and `LICENSES/dependencies/inventory.json` indexes the dependency records. Keep these records with a published release. [Notices](NOTICE.md) · [Contributing](CONTRIBUTING.md)

## Publish on GitFlic / Публикация на GitFlic

1. Copy the **contents** of `GitFlic-0.10.3/repository/` to the repository root. Commit the reviewed sources. The numeric tag, package and manifest version must all be `0.10.3`.
2. Install the candidate from `GitFlic-0.10.3/install/rudonium-anki-toolkit/` into a test vault. Check the version, connection to a test Anki profile and that editing a linked card updates its existing ID. [Installation](README.md#install)
3. Create a pre-release for the tag on GitFlic. Attach `release/Rudonium-0.10.3.zip` and its `SHA256SUMS.txt`. Use the bilingual release description. [Release notes](docs/releases/0.10.3.md) · [GitFlic release guide](https://docs.gitflic.ru/latest/project/release/)

Для публикации перенесите **содержимое** `GitFlic-0.10.3/repository/` в корень проекта GitFlic. Проверьте установку из `install/rudonium-anki-toolkit/` в отдельном хранилище Obsidian. Создайте тег `0.10.3` на проверенном коммите. В предварительный релиз вложите ZIP и файл контрольной суммы из `release/`. [Описание выпуска](docs/releases/0.10.3.md#русский) · [Установка](README.ru.md#установка)

### SourceGit и FreeFileSync / Using a local Git clone

Один раз клонируйте проект GitFlic в SourceGit. Сохраните локальные правки перед переносом. После строки `3/3 GitFlic files ready` откройте `GitFlic-0.10.3/Compare.ffs_gui`. Слева указана подготовленная папка `repository/`, справа выберите корень клона. Сначала сравните изменения, затем синхронизируйте. Копирование идёт слева направо. `.git` исключена. Файлы только справа остаются для ручной проверки. Просмотрите результат, выполните Commit и Push в SourceGit. Установочный ZIP приложите к релизу.

Clone the GitFlic project once in SourceGit. Commit any local edits before transferring a new version. Open the generated FreeFileSync job after preparation finishes and select the clone as the right folder. Compare, review and synchronize. Changed files are copied from the generated repository to the clone. Right-only files are kept and Git metadata is excluded. Review the diff, commit and push in SourceGit.

If release verification fails after the source check, see `Sources saved` for the recovered source tree. A later packaging attempt should target a fresh output directory.

Keep the number for unchanged rebuilds. Increment the third number when distributing a changed kit (`0.10.4` next). Use `0.11.0` for the next beta series and `1.0.0` for the stable release.

Повторная сборка того же выпуска сохраняет номер. Следующая изменённая сборка этой серии получит `0.10.4`. Отметку **Public Beta** укажите в названии релиза. Манифест и тег содержат числовую версию.

For a future Obsidian directory submission, consult its current release and fork requirements. [Submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) · [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
