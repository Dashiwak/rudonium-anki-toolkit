# Проверка изменений

Выполняйте команды из корня репозитория. Используйте версию Node.js, указанную в инструкции сборки. Стенды подставляют временные заметки и ответы AnkiConnect. Личное хранилище Obsidian и профиль Anki для этих проверок не нужны.

| Что изменилось | Какую проверку запустить |
| --- | --- |
| Первый запуск, настройка форматов, запуск без Anki | `tests/first-run-formats.test.cjs` |
| Перемещение блока, обновление полей File и Context | `tests/source-field-refresh.test.cjs` |
| Ответ страницы, служебный ID после ответа, сохранение местных заметок | `tests/page-answer-boundary.test.cjs` |
| Приостановка, удаление, двусторонняя синхронизация под курсором | `tests/linked-sync.integration.test.mjs` |
| Сбой при пакетном экспорте и повтор операции | `tests/packet-faults.test.cjs` |
| Подготовка файлов релиза для GitFlic | `tests/gitflic-release.test.cjs` |

Команда для одного файла

```sh
node --experimental-vm-modules --test tests/first-run-formats.test.cjs
```

Конкретный сценарий можно выбрать по части названия

```sh
node --experimental-vm-modules --test --test-name-pattern="signed footer" tests/page-answer-boundary.test.cjs
```

Другие сценарии лежат рядом в файлах `*.test.cjs` и `*.test.mjs`. В `benchmark/` хранятся общие компоненты стенда для загрузки модулей плагина, имитации Obsidian и AnkiConnect, а также сценарии для отдельных замеров.
