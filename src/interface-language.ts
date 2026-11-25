/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
export type InterfaceLanguage = 'en' | 'ru'
export type UiText = (english: string, russian: string) => string

export interface InterfaceSettings {
    INTERFACE_LANGUAGE?: string
}

export const englishUi: UiText = english => english
export const russianUi: UiText = (_english, russian) => russian

export function interfaceLanguage(settings?: InterfaceSettings): InterfaceLanguage {
    return settings?.INTERFACE_LANGUAGE === 'ru' ? 'ru' : 'en'
}

export function uiFor(settings?: InterfaceSettings): UiText {
    return interfaceLanguage(settings) === 'ru' ? russianUi : englishUi
}

export function ankiBrowseMessage(id: number, front = ''): string {
    const title = front.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 90)
    return `Anki Browse: ID ${id}${title ? ' · ' + title : ''}. Select another note or close Browse, then retry sync.`
}

const diagnosticRules: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Anki Browse: ID (\d+)(.*?)\. Select another note or close Browse, then retry sync\.$/u,
        'В окне «Обзор» Anki выбрана запись ID $1$2. Выберите другую запись или закройте «Обзор», затем повторите синхронизацию.'],
    [/^Anki ID (\d+): fields differ after saving \((.*?)\)\. Review this note and retry sync\.$/u,
        'ID Anki $1: после сохранения поля отличаются ($2). Проверьте запись и повторите синхронизацию.'],
    [/^Deck type unverified: (.+)\. Retry sync\.$/u, 'Не удалось проверить тип колоды «$1». Повторите синхронизацию.'],
    [/^Anki ID (\d+) is preserved\. Its date is (?:missing|invalid); use YYYY-MM-DD\.$/u,
        'Связь по ID Anki $1 сохранена. Проверьте дату после разделителя; используйте ГГГГ-ММ-ДД.'],
    [/^Invalid Anki ID marker on line (\d+)\. Keep a positive whole number and repair the marker before exporting\.[\s\S]*$/u,
        'Некорректный маркер ID Anki в строке $1. Исправьте целое положительное число перед экспортом.'],
    [/^.+? did not respond within ([\d.]+) seconds?\.?$/i, 'Истекло время ожидания ответа ($1 с).'],
    [/^(?:failed to fetch|network (?:error|request failed)|ECONNREFUSED|net::ERR_[A-Z_]+|could not connect to anki)\b.*$/i,
        'Нет связи с AnkiConnect. Проверьте, что Anki открыта и дополнение AnkiConnect работает.'],
    [/^AnkiConnect returned an invalid note list\.?$/i, 'AnkiConnect вернул некорректный список записей.'],
    [/^AnkiConnect returned an unexpected or repeated note ID\.?$/i, 'AnkiConnect вернул неожиданный или повторяющийся ID записи.'],
    [/^ENOENT: no such file or directory,?\s*(.*)$/i, 'Не удалось найти файл или папку. $1'],
    [/^(?:EACCES|EPERM): (?:permission denied|operation not permitted),?\s*(.*)$/i, 'Операция с файлом запрещена. $1'],
    [/^AnkiConnect is still processing a previous write\..*$/i, 'AnkiConnect ещё обрабатывает предыдущую запись. Дождитесь завершения операции и повторите проверку.'],
    [/^Anki has not answered the previous sync write\..*$/i, 'Anki ещё не ответила на предыдущую запись. Проверьте карточку в Anki и откройте новый предпросмотр после завершения операции.'],
    [/^Open a Markdown note before starting the sync\.?$/i, 'Откройте заметку Markdown перед синхронизацией.'],
    [/^Sync profile "(.+)" has missing folders: (.+)\. Update it in Manage Profiles\.$/u,
        'В профиле «$1» не найдены папки: $2. Уточните пути в настройках профиля.'],
    [/^Anki returned the same ID for different creations: (\d+)$/u,
        'Anki вернула один ID $1 для разных новых записей. Проверьте незавершённые создания.'],
    [/^The current note is excluded by (.+)\.$/i, 'Текущая заметка исключена профилем $1.'],
    [/^The current note is outside the selected scan area \((.+)\)\.$/i, 'Текущая заметка находится вне выбранной области: $1.'],
    [/^The selected files are outside (.+) or no longer exist\.$/i, 'Выбранные файлы находятся вне области $1 или уже удалены.'],
    [/^Save the open note before syncing it\.?$/i, 'Сохраните открытую заметку перед синхронизацией.'],
    [/^Use Review Pending Anki Creations before syncing this note\.?$/i, 'Перед синхронизацией заметки откройте проверку незавершённого создания записей Anki.'],
    [/^(\d+) ID markers are outside supported cards \(linked bullets or labeled START\/END blocks\)\.?$/i, 'Маркеры ID вне поддерживаемых однострочных карточек и блоков START/END с именами полей: $1.'],
    [/^Duplicate Anki ID (\d+)\. Keep this ID in one source\.?$/i, 'Повторяется ID Anki $1. Оставьте этот ID в одном исходном файле.'],
    [/^A previous write is still pending\. Restore the original generated Obsidian link in Anki, then preview again\.?$/i,
        'Предыдущая запись ещё не подтверждена. Восстановите в Anki прежнюю ссылку на Obsidian и повторите предпросмотр.'],
    [/^A previous write is still pending\. Review the new generated Obsidian link in Anki and restore its previous state before retrying\.?$/i,
        'Предыдущая запись ещё не подтверждена. Проверьте новую ссылку на Obsidian в Anki, восстановите прежнее значение и повторите проверку.'],
    [/^The card page was kept\. Choose system trash or Obsidian trash in Files and links\.$/u,
        'Страница сохранена. В настройках «Файлы и ссылки» выберите системную корзину или корзину Obsidian.'],
    [/^Obsidian cannot apply its file deletion preference\.$/u, 'Не удалось применить настройку удаления файлов Obsidian.'],
    [/^This ID was not found or could not be read in the active Anki profile\.?$/i, 'Этот ID отсутствует в открытом профиле Anki или недоступен для чтения.'],
    [/^This card needs plain-text Front and Back fields that can be mapped back to Markdown\.?$/i,
        'Для этой карточки нужны текстовые поля Front и Back, которые можно сопоставить с Markdown.'],
    [/^A previous sync of this card is pending verification\.?$/i, 'Результат предыдущей синхронизации этой карточки ещё не подтверждён.'],
    [/^The vault check was incomplete\. Resolve the file errors before applying a plan\.?$/i,
        'Проверка хранилища завершилась не полностью. Устраните ошибки файлов перед применением изменений.'],
    [/^Files or settings changed during the preview\. Run it again\.?$/i, 'Во время предпросмотра изменились файлы или настройки. Откройте предпросмотр заново.'],
    [/^A card to be updated is selected in Anki Browse\. Close Browse and preview again\.?$/i,
        'Обновляемая карточка открыта в браузере Anki. Закройте браузер и повторите предпросмотр.'],
    [/^Could not verify saved values for Anki ID (\d+)\.?$/i, 'Не удалось подтвердить сохранённые значения для ID Anki $1.'],
    [/^Could not verify the generated Obsidian link for Anki ID (\d+)\.?$/i, 'Не удалось подтвердить ссылку на Obsidian для ID Anki $1.'],
    [/^Wait for the current scan or cache reset to finish, then try again\.?$/i, 'Дождитесь завершения текущей проверки или сброса кеша и попробуйте снова.'],
    [/^Invalid per-card tag comment under Anki ID (\d+)\.?$/i, 'Некорректный комментарий с тегами под ID Anki $1.'],
    [/^The Anki ID moved before writing this Markdown card\.?$/i, 'ID Anki переместился до сохранения карточки Markdown.'],
    [/^This value requires manual Markdown editing\.?$/i, 'Это значение нужно изменить в Markdown вручную.'],
    [/^Could not read note type [“"](.+?)[”"]\..*$/i, 'Не удалось прочитать тип записи «$1».'],
    [/^Could not save note-type settings\..*$/i, 'Не удалось сохранить настройки типов записей.'],
    [/^Anki returned an invalid or empty list of note types\.?$/i, 'Anki вернула пустой или некорректный список типов записей.'],
    [/^AnkiConnect did not finish reading the note types within (\d+) seconds?\.?$/i, 'AnkiConnect не успел прочитать типы записей за $1 с.'],
    [/^Vault Backup requires desktop Obsidian and a local vault\.?$/i, 'Для резервного копирования нужен настольный Obsidian с локальным хранилищем.'],
    [/^ZIP backups require desktop Obsidian\.?$/i, 'Для резервных ZIP-копий нужен настольный Obsidian.'],
    [/^Set the backup folder to an absolute path outside the vault\.?$/i, 'Укажите абсолютный путь для резервных копий за пределами хранилища.'],
    [/^(?:Choose a backup folder outside the vault|The backup folder resolves inside the vault)\.?$/i, 'Выберите папку для копий за пределами хранилища.'],
    [/^Enter the absolute path of an Obsidian ZIP backup\.?$/i, 'Введите абсолютный путь к резервной копии Obsidian в формате ZIP.'],
    [/^The selected backup is not a file\.?$/i, 'Выбранный путь не указывает на файл резервной копии.'],
    [/^Choose a vault with a parent folder before restoring\.?$/i, 'Перед восстановлением выберите хранилище, у которого есть родительская папка.'],
    [/^Anki backup requires desktop Obsidian with the Node SQLite online backup API.*$/i, 'Для резервного копирования Anki нужен настольный Obsidian с модулем SQLite из Node.js 22.16 или новее.'],
    [/^AnkiConnect did not return a local collection\.media folder\..*$/i, 'AnkiConnect не вернул локальную папку collection.media. Откройте Anki на этом компьютере.'],
    [/^Anki backup needs a real collection\.media folder on this computer\.?$/i, 'Для копии Anki нужна существующая папка collection.media на этом компьютере.'],
    [/^Could not find a regular collection\.anki2 beside the Anki media folder\.?$/i, 'Не удалось найти файл collection.anki2 рядом с папкой медиафайлов Anki.'],
    [/^Choose an absolute path for the Anki backup\.?$/i, 'Укажите абсолютный путь для резервной копии Anki.'],
    [/^Choose a backup location outside the active Anki profile\.?$/i, 'Выберите место для копии за пределами папки активного профиля Anki.'],
    [/^The active Anki profile changed during the backup\.?$/i, 'Активный профиль Anki изменился при создании резервной копии.'],
]

export function uiDiagnostic(error: unknown, t: UiText): string {
    const text = error instanceof Error ? error.message : String(error)
    const bilingual = /^(.*?) \/ ([А-ЯЁа-яё][\s\S]*)$/su.exec(text)
    if (bilingual && !text.includes('Anki Browse: ID ')) {
        const location = /^(.+?\.md):\s+/iu.exec(bilingual[1])
        return t(bilingual[1], (location?.[0] ?? '') + bilingual[2])
    }
    if (t('en', 'ru') === 'en') return text
    const path = /^(.+?\.md):\s+([\s\S]*)$/i.exec(text)
    const message = (path?.[2] ?? text).replace(/^(?:Error|TypeError|TimeoutError):\s*/, '')
    const prefix = path ? `${path[1]}: ` : ''
    for (const [rule, translation] of diagnosticRules) {
        if (rule.test(message)) return prefix + message.replace(rule, translation)
    }
    if (/[А-ЯЁа-яё]/.test(message)) return prefix + message
    console.warn('[Export to Anki] Подробности операции', text)
    return prefix + 'Не удалось завершить операцию. Подробности доступны в консоли разработчика.'
}
