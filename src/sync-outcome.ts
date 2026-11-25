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

const checkedUnits = {
    note: [note, 'Проверена'],
    file: [file, 'Проверен'],
    card: [['карточка', 'карточки', 'карточек'], 'Проверена'],
    image: [['изображение', 'изображения', 'изображений'], 'Проверено'],
    name: [['имя', 'имени', 'имён'], 'Проверено'],
    'note type': [['тип записи', 'типа записей', 'типов записей'], 'Проверен'],
} as const

export function checkedCount(count: number, unit: keyof typeof checkedUnits, t: UiText): string {
    const [noun, singular] = checkedUnits[unit]
    const verb = form(count, [singular, 'Проверены', 'Проверено'])
    return t('Checked ' + en(count, unit) + '.', verb + ' ' + counted(count, noun) + '.')
}

export function deferredNotes(count: number, t: UiText): string {
    return t('Deferred ' + en(count, 'note') + ' for review.',
        form(count, ['Отложена', 'Отложены', 'Отложено']) + ' ' + counted(count, note) + ' для проверки.')
}

export function skippedFields(count: number, t: UiText): string {
    return t('Skipped ' + en(count, 'field') + '.', 'Пропущено ' + counted(count, ['поле', 'поля', 'полей']) + '.')
}

export function skippedNotes(count: number, t: UiText): string {
    return t('Skipped ' + en(count, 'note') + ' because of card errors.',
        form(count, ['Пропущена', 'Пропущены', 'Пропущено']) + ' ' + counted(count, note) + ' из-за ошибок в карточках.')
}

export function unconfirmedNotes(count: number, t: UiText): string {
    return t('Could not confirm changes to ' + en(count, 'note') + '.',
        'Не удалось подтвердить изменения для ' + count + ' ' + form(count, ['записи', 'записей', 'записей']) + '.')
}

export function skippedFiles(count: number, t: UiText): string {
    return t('Some notes were skipped. Check ' + en(count, 'file') + '.',
        'Часть записей пропущена. Проверьте ' + counted(count, file) + '.')
}

export type NoteChange = 'add' | 'edit' | 'delete' | 'cleanup' | 'link' | 'tags' | 'move' | 'suspend' | 'resume' | 'status'
type Destination = 'Anki' | 'Obsidian'
const actions: readonly NoteChange[] = ['add', 'edit', 'tags', 'move', 'suspend', 'resume', 'status', 'delete', 'cleanup', 'link']

function describe(kind: NoteChange, count: number, destination: Destination, t: UiText): string {
    const notes = counted(count, note)
    const notesEn = en(count, 'note')
    const genitive = count + ' ' + form(count, ['записи', 'записей', 'записей'])
    const where = ' в ' + destination + '.'
    const whereEn = ' in ' + destination + '.'
    switch (kind) {
        case 'add': return t('Added ' + notesEn + ' to ' + destination + '.', form(count, ['Добавлена', 'Добавлены', 'Добавлено']) + ' ' + notes + where)
        case 'edit': return t('Updated ' + notesEn + whereEn, form(count, ['Изменена', 'Изменены', 'Изменено']) + ' ' + notes + where)
        case 'delete': return t('Deleted ' + notesEn + ' from ' + destination + '.', form(count, ['Удалена', 'Удалены', 'Удалено']) + ' ' + notes + ' из ' + destination + '.')
        case 'tags': return t('Updated tags for ' + notesEn + whereEn, 'Обновлены теги у ' + genitive + where)
        case 'move': return t('Changed the deck for ' + notesEn + whereEn, 'Изменена колода у ' + genitive + where)
        case 'suspend': return t('Paused reviews for ' + notesEn + whereEn, 'Приостановлены повторения для ' + genitive + where)
        case 'resume': return t('Resumed reviews for ' + notesEn + whereEn, 'Возобновлены повторения для ' + genitive + where)
        case 'status': return t('Updated review status for ' + notesEn + whereEn, 'Обновлён статус повторений для ' + genitive + where)
        case 'cleanup': return t('Updated Obsidian after deletion of ' + notesEn + ' from Anki.',
            'В Obsidian учтено удаление ' + genitive + ' из Anki.')
        case 'link': return t('Restored Anki links for ' + notesEn + ' in Obsidian.', 'В Obsidian восстановлена связь с Anki для ' + genitive + '.')
    }
}

export class SyncOutcome {
    private readonly counts = { Anki: new Map<NoteChange, Set<number>>(), Obsidian: new Map<NoteChange, Set<number>>() }

    record(kind: NoteChange, id: number, destination: Destination): void {
        const notes = this.counts[destination]
        let ids = notes.get(kind)
        if (!ids) notes.set(kind, ids = new Set<number>())
        ids.add(id)
    }

    message(t: UiText): string {
        const lines: string[] = []
        for (const kind of actions) for (const destination of ['Anki', 'Obsidian'] as const) {
            const count = this.counts[destination].get(kind)?.size
            if (count) lines.push(describe(kind, count, destination, t))
        }
        return lines.join('\n')
    }
}
