# Contributing

We accept questions, bug reports, suggestions and contributions in **English and Russian**. Open an issue on GitFlic so discussion and decisions stay together. [GitFlic Issues](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue)

## Report a problem

Describe what you expected, what happened and the shortest steps to repeat it. Include your operating system, the Rudonium, Obsidian, Anki and AnkiConnect versions, and the sync mode. For a parsing issue, paste the smallest Markdown example that shows it and list the corresponding Anki field names in order. For a source-kit build failure, include the relevant lines from `Build/build-error.txt`. Replace private card content, account names and local paths with examples.

## Submit a change

1. Describe the change and the user workflow it affects in a GitFlic issue. Refer to that issue in your merge request.
2. Test the affected workflow with a disposable vault and Anki profile. Use the corresponding tests in `tests/` with Node.js 22.18 or later. In a clean checkout of the assembled source repository, first run `npm ci`. The installable plugin has only the runtime files and notices. For a production build, follow the build guide. [Build and release guide](PUBLISHING.md)
3. Add or update a regression test when behavior changes. For a user-visible change, update both quick starts or READMEs as appropriate and add an English changelog entry.
4. Open a merge request on GitFlic and include the test result, versions and any checks that still require desktop validation.

## По-русски

Сообщения и предложения можно писать по-русски. В задаче укажите версии программ, режим синхронизации, ожидаемый результат и шаги для воспроизведения. Для ошибки разбора приложите небольшой пример Markdown и названия полей Anki. Запустите проверки изменённых сценариев из `tests/`. Нужен Node.js 22.18 или новее. В чистой копии развёрнутого репозитория сначала выполните `npm ci`. В запросе на слияние дайте ссылку на задачу и опишите, как проверяли изменение. [GitFlic Issues](https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue)

Rudonium author and maintainer · dashiwak.
