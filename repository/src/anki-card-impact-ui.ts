/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import type { CardStudyDetail, ReviewedCardImpact } from './anki-card-impact'
import type { UiText } from './interface-language'

export function studyCardDescription(card: CardStudyDetail, t: UiText): string {
    const parts = [t(`Card ID ${card.id}`, `ID карточки ${card.id}`)]
    if (card.order !== undefined && card.order >= 0) parts.push(t(
        `card position ${card.order + 1}`, `номер карточки по шаблону ${card.order + 1}`))
    if (card.repetitions !== undefined && card.repetitions >= 0) parts.push(t(
        `repetitions ${card.repetitions}`, `повторений ${card.repetitions}`))
    if (card.interval !== undefined && card.interval > 0) parts.push(t(
        `interval ${card.interval} days`, `интервал ${card.interval} дн.`))
    if (card.queue === -1) parts.push(t('suspended', 'приостановлена'))
    return parts.join(' · ')
}

export function renderReviewedCardImpact(container: HTMLElement, impact: ReviewedCardImpact, t: UiText): void {
    const section = container.createDiv({ cls: 'rupos-card-impact' })
    section.createEl('strong', { text: t('May change Anki study cards', 'Может изменить состав учебных карточек Anki') })
    const reasons = impact.hazards.map(hazard => hazard === 'cloze'
        ? t('Changed Cloze ordinals or their associated text', 'Изменились номера Cloze или их связь с текстом')
        : t('Changed the optional reverse-card flag', 'Изменилось условие создания обратной карточки'))
    section.createEl('p', { text: reasons.join(' · ') })
    if (impact.cardIds.length) {
        section.createEl('p', { text: t('Current study cards', 'Текущие учебные карточки') })
        const list = section.createEl('ul')
        const info = new Map(impact.cards.map(card => [card.id, card]))
        for (const id of impact.cardIds) list.createEl('li', { text: studyCardDescription(info.get(id) ?? { id }, t) })
        if (impact.cardIds.some(id => info.get(id)?.repetitions === undefined)) {
            section.createEl('p', { text: t('Anki did not provide the number of repetitions for every card.',
                'Anki не предоставила число повторений для всех карточек.') })
        }
    } else {
        section.createEl('p', { text: t('Anki returned an empty card list for this note.', 'Anki вернула пустой список карточек этой записи.') })
    }
    section.createEl('p', { text: t(
        'Confirm this individual change to apply it. The resulting card IDs are checked after writing.',
        'Подтвердите это изменение отдельно. Фактические ID карточек проверяются после записи.') })
}
