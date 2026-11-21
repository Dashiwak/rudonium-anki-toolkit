/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Notice } from 'obsidian'
import type { Editor, TFile } from 'obsidian'
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import { AnkiProfileError, profileProblemText, requireExpectedAnkiProfile } from './anki-profile'
import { withAnkiDeadline } from './anki-transport'
import { buildCardPreview } from './card-preview'
import { findIdMarkers } from './duplicate-markers'
import { auditRead } from './sync-audit'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'

const opens = new WeakMap<MyPlugin, AbortController>()
const readTimeoutMs = 5_000

function problemText(error: unknown, t: UiText): string {
    if (error instanceof AnkiProfileError) {
        const detail = error.expected && error.actual ? t(
            ` Expected “${error.expected}”, active “${error.actual}”.`,
            ` Ожидался «${error.expected}», открыт «${error.actual}».`) : ''
        return profileProblemText(error, t) + detail
    }
    return error instanceof Error ? error.message : String(error)
}

/** Открывает существующую запись. Текст редактора и данные коллекции не изменяются. */
export async function openCurrentCardInAnki(plugin: MyPlugin, editor: Editor, file: TFile): Promise<void> {
    const t = uiFor(plugin.settings)
    opens.get(plugin)?.abort()
    const controller = new AbortController()
    opens.set(plugin, controller)
    const { signal } = controller
    const source = file.path
    const text = editor.getValue()
    const cursor = editor.getCursor('head')
    const offset = editor.posToOffset(cursor)
    const stamp = [file.stat.ctime, file.stat.mtime, file.stat.size].join(':')
    const settings = JSON.stringify([plugin.settings, plugin.fields_dict])
    const requireCurrent = () => {
        if (signal.aborted || opens.get(plugin) !== controller) throw new DOMException('Cancelled', 'AbortError')
        const active = plugin.app.workspace.getActiveFile()
        const current = editor.getCursor('head')
        if (file.path !== source || active !== file || editor.getValue() !== text ||
            current.line !== cursor.line || current.ch !== cursor.ch ||
            [file.stat.ctime, file.stat.mtime, file.stat.size].join(':') !== stamp ||
            JSON.stringify([plugin.settings, plugin.fields_dict]) !== settings) {
            throw new Error(t('The note, cursor or settings changed. Run Open Current Card in Anki again.',
                'Заметка, положение курсора или настройки изменились. Повторите команду «Открыть текущую карточку в Anki».'))
        }
    }
    try {
        if (file.extension.toLowerCase() !== 'md') throw new Error(t(
            'Open a Markdown note and place the cursor inside a linked card.',
            'Откройте Markdown-заметку и поставьте курсор внутрь связанной карточки.'))
        requireCurrent()
        const profile = await requireExpectedAnkiProfile(plugin, undefined, signal)
        requireCurrent()
        // Используется тот же разбор текущего буфера, что у предпросмотра. Чтение всего хранилища не требуется.
        const preview = await buildCardPreview(plugin, file, text, offset, true, true)
        requireCurrent()
        const id = preview.id
        if (id === undefined) throw new Error(t(
            'This card has no Anki ID yet. Export it first, or use Preview Current Card without writing.',
            'У этой карточки пока нет ID Anki. Сначала экспортируйте её или откройте предпросмотр текущей карточки без записи.'))
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(t('The card has an invalid Anki ID.', 'У карточки некорректный ID Anki.'))
        const occurrences = findIdMarkers(text, plugin.settings.Syntax).filter(marker => marker.id === id).length
        if (!occurrences) throw new Error(t(
            'The card ID could not be verified in the current source. Check the ID marker in the sync audit.',
            'ID карточки не удалось подтвердить в текущем исходнике. Проверьте маркер ID в аудите синхронизации.'))
        if (occurrences > 1) {
            throw new Error(t(`Anki ID ${id} occurs more than once in this note. Run the sync audit before opening it.`,
                `ID Anki ${id} повторяется в этой заметке. Выполните аудит синхронизации перед переходом.`))
        }
        await requireExpectedAnkiProfile(plugin, profile, signal)
        const response = await auditRead('notesInfo', { notes: [id] }, signal, readTimeoutMs)
        requireCurrent()
        const note: unknown = Array.isArray(response) && response.length === 1 ? response[0] : undefined
        const record = note && typeof note === 'object' && !Array.isArray(note)
            ? note as Record<string, unknown> : undefined
        if (!record || record.noteId !== id || typeof record.modelName !== 'string' || !record.modelName) {
            throw new Error(t(`Anki note ${id} was not found or could not be verified in the active profile. Run the sync audit.`,
                `Запись с ID ${id} не найдена или не подтверждена в открытом профиле Anki. Выполните аудит синхронизации.`))
        }
        const unconfirmed = t('Unconfirmed Anki note type', 'Тип записи Anki не подтверждён')
        if (preview.modelName !== unconfirmed && record.modelName !== preview.modelName) {
            throw new Error(t(`Anki note ${id} has a different note type. Check its ID and profile in the sync audit.`,
                `Тип записи Anki с ID ${id} отличается от типа в исходнике. Проверьте ID и профиль в аудите синхронизации.`))
        }
        await requireExpectedAnkiProfile(plugin, profile, signal)
        requireCurrent()
        // nid выбирает запись независимо от фильтрованной колоды, приостановки и числа её карточек.
        const cards: unknown = await withAnkiDeadline(() => AnkiConnect.invoke('guiBrowse', { query: `nid:${id}` }),
            'Open Anki Browse', readTimeoutMs, signal)
        if (!Array.isArray(cards) || cards.some(card => !Number.isSafeInteger(card) || card <= 0)) {
            throw new Error(t('Anki Browse did not return a valid card list.', 'Обозреватель Anki не вернул корректный список карточек.'))
        }
        await requireExpectedAnkiProfile(plugin, profile, signal)
        requireCurrent()
        if (!cards.length) new Notice(t(`Anki Browse opened for nid:${id}, but the note has no generated cards.`,
            `В обозревателе Anki открыт поиск nid:${id}, но у записи нет созданных карточек.`), 8_000)
    } catch (error) {
        if (!signal.aborted && opens.get(plugin) === controller) new Notice(t(
            `Open in Anki · ${problemText(error, t)}`, `Переход в Anki · ${problemText(error, t)}`), 12_000)
    } finally {
        if (opens.get(plugin) === controller) opens.delete(plugin)
    }
}

export function registerOpenCardInAnki(plugin: MyPlugin): void {
    plugin.addCommand({
        id: 'anki-open-current-card',
        name: uiFor(plugin.settings)('Open Current Card in Anki', 'Открыть текущую карточку в Anki'),
        editorCallback: (editor, view) => {
            if (view.file?.extension.toLowerCase() === 'md') void openCurrentCardInAnki(plugin, editor, view.file)
        },
    })
    plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
        const file = view.file
        if (file?.extension.toLowerCase() !== 'md') return
        menu.addItem(item => item.setTitle(uiFor(plugin.settings)('Open Card in Anki', 'Открыть карточку в Anki'))
            .setIcon('external-link').onClick(() => { void openCurrentCardInAnki(plugin, editor, file) }))
    }))
    plugin.register(() => { opens.get(plugin)?.abort(); opens.delete(plugin) })
}
