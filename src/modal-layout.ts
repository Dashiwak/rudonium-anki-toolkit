/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { setIcon } from 'obsidian'
import type { Modal } from 'obsidian'
import type { UiText } from './interface-language'

export function installModalLayout(modal: Modal, t: UiText): void {
    const { modalEl, titleEl, contentEl } = modal
    if (modalEl.querySelector('.anki-modal-size')) return

    const control = modalEl.createEl('button', {
        cls: ['clickable-icon', 'anki-modal-size'],
        attr: { type: 'button' },
    })
    // Крестик и обработчики закрытия принадлежат Obsidian.
    const close = modalEl.querySelector('.modal-close-button')
    if (close?.parentElement === modalEl) modalEl.insertBefore(control, close)
    control.classList.add('rudonium-modal-layout-control')
    titleEl.classList.add('rudonium-modal-title')

    let expanded = false
    const update = () => {
        const label = expanded ? t('Restore Window Size', 'Восстановить размер окна')
            : t('Expand Window', 'Развернуть окно')
        control.title = label
        control.setAttribute('aria-label', label)
        control.setAttribute('aria-pressed', String(expanded))
        setIcon(control, expanded ? 'minimize-2' : 'maximize-2')
    }
    control.onclick = () => {
        const { scrollTop, scrollLeft } = contentEl
        expanded = !expanded
        modalEl.classList.toggle('rudonium-modal-expanded', expanded)
        // Смена размера сохраняет содержимое, фокус и прокрутку в пределах окна.
        contentEl.scrollTop = scrollTop
        contentEl.scrollLeft = scrollLeft
        update()
    }
    update()
}
