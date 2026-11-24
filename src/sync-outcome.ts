/*! SPDX-License-Identifier: GPL-3.0-only */
import type { UiText } from './interface-language'

type CountForms = readonly [string, string, string]
const plural = new Intl.PluralRules('ru')
const note: CountForms = ['запись', 'записи', 'записей']
const file: CountForms = ['файл', 'файла', 'файлов']

function form(count: number, forms: CountForms): string {
    const category = plural.select(count)
    return forms[category === 'one' ? 0 : category === 'few' ? 1 : 2]
}

function counted(count: number, noun: CountForms): string {
    return count + ' ' + form(count, noun)
}

function en(count: number, noun: string): string {
    return count + ' ' + noun + (count === 1 ? '' : 's')
}

export function checkedCount(count: number, unit: 'note' | 'file', t: UiText): string {
    return t('Checked ' + en(count, unit) + '.', 'Проверено: ' + counted(count, unit === 'note' ? note : file) + '.')
}

export function deferredNotes(count: number, t: UiText): string {
    return t('Deferred ' + en(count, 'note') + ' for review.',
        form(count, ['Отложена', 'Отложены', 'Отложено']) + ' ' + counted(count, note) + ' для проверки.')
}

export function unconfirmedNotes(count: number, t: UiText): string {
    return t('Could not confirm changes to ' + en(count, 'note') + '.',
        'Не удалось подтвердить изменения для ' + count + ' ' + form(count, ['записи', 'записей', 'записей']) + '.')
}

export function skippedFiles(count: number, t: UiText): string {
    return t('Some notes were skipped. Check ' + en(count, 'file') + '.',
        'Часть записей пропущена. Проверьте ' + counted(count, file) + '.')
}

export type NoteChange = 'add' | 'edit' | 'delete' | 'cleanup' | 'link' | 'tags' | 'move' | 'suspend' | 'resume' | 'status' | 'normalize'
const actions: readonly NoteChange[] = ['add', 'edit', 'tags', 'move', 'suspend', 'resume', 'status', 'delete', 'cleanup', 'link', 'normalize']

function describe(kind: NoteChange, count: number, t: UiText): string {
    const notes = counted(count, note)
    const notesEn = en(count, 'note')
    const genitive = count + ' ' + form(count, ['записи', 'записей', 'записей'])
    switch (kind) {
        case 'add': return t('Added ' + notesEn + '.', form(count, ['Добавлена', 'Добавлены', 'Добавлено']) + ' ' + notes + '.')
        case 'edit': return t('Updated ' + notesEn + '.', form(count, ['Изменена', 'Изменены', 'Изменено']) + ' ' + notes + '.')
        case 'delete': return t('Deleted ' + notesEn + ' from Anki.', form(count, ['Удалена', 'Удалены', 'Удалено']) + ' ' + notes + ' из Anki.')
        case 'tags': return t('Updated tags for ' + notesEn + '.', 'Обновлены теги у ' + genitive + '.')
        case 'move': return t('Changed the deck for ' + notesEn + '.', 'Изменена колода у ' + genitive + '.')
        case 'suspend': return t('Paused reviews for ' + notesEn + '.', 'Приостановлены повторения для ' + genitive + '.')
        case 'resume': return t('Resumed reviews for ' + notesEn + '.', 'Возобновлены повторения для ' + genitive + '.')
        case 'status': return t('Updated review status for ' + notesEn + '.', 'Обновлён статус повторений для ' + genitive + '.')
        case 'normalize': return t('Fixed separator spacing in ' + notesEn + '.',
            'Исправлены пробелы в ' + count + ' ' + form(count, ['записи', 'записях', 'записях']) + '.')
        case 'cleanup': return t('Updated Obsidian after deletion of ' + notesEn + ' from Anki.',
            'В Obsidian учтено удаление ' + genitive + ' из Anki.')
        case 'link': return t('Restored links to ' + notesEn + '.', 'Для ' + genitive + ' восстановлена связь с Anki.')
    }
}

export class SyncOutcome {
    private readonly notes = new Map<NoteChange, Set<number>>()

    record(kind: NoteChange, id: number): void {
        let ids = this.notes.get(kind)
        if (!ids) this.notes.set(kind, ids = new Set<number>())
        ids.add(id)
    }

    message(t: UiText): string {
        return actions.flatMap(kind => {
            const size = this.notes.get(kind)?.size ?? 0
            return size ? [describe(kind, size, t)] : []
        }).join('\n')
    }
}
