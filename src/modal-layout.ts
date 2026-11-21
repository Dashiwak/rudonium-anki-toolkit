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
    Object.assign(control.style, {
        position: 'absolute',
        insetBlockStart: 'var(--size-4-2, 8px)',
        insetInlineEnd: 'var(--size-4-9, 36px)',
        inlineSize: 'var(--size-4-6, 24px)',
        blockSize: 'var(--size-4-6, 24px)',
        padding: '0',
    })
    titleEl.style.paddingInlineEnd = 'var(--size-4-12, 48px)'

    const style = modalEl.style
    let previousSize: { width: string; maxWidth: string; height: string; maxHeight: string } | undefined
    const update = () => {
        const label = previousSize ? t('Restore Window Size', 'Восстановить размер окна')
            : t('Expand Window', 'Развернуть окно')
        control.title = label
        control.setAttribute('aria-label', label)
        setIcon(control, previousSize ? 'minimize-2' : 'maximize-2')
    }
    control.onclick = () => {
        const { scrollTop, scrollLeft } = contentEl
        if (previousSize) {
            Object.assign(style, previousSize)
            previousSize = undefined
        } else {
            previousSize = {
                width: style.width ?? '',
                maxWidth: style.maxWidth ?? '',
                height: style.height ?? '',
                maxHeight: style.maxHeight ?? '',
            }
            Object.assign(style, {
                width: 'calc(100vw - 1rem)', maxWidth: 'calc(100vw - 1rem)',
                height: 'calc(100vh - 1rem)', maxHeight: 'calc(100vh - 1rem)',
            })
        }
        // Смена размера сохраняет содержимое, фокус и прокрутку в пределах окна.
        contentEl.scrollTop = scrollTop
        contentEl.scrollLeft = scrollLeft
        update()
    }
    update()
}
