/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { setIcon } from 'obsidian'
import type { UiText } from './interface-language'

export function copyBlock(container: HTMLElement, value: string, label: string, t: UiText): HTMLPreElement {
    const block = container.createDiv({ cls: 'rudonium-copy-block' })
    const pre = block.createEl('pre')
    pre.createEl('code', { text: value })
    const status = container.createSpan({ cls: 'rudonium-copy-status', attr: { role: 'status' } })
    addCopyButton(block, () => value, label, t, status)
    return pre
}

export function addCopyButton(container: HTMLElement, value: () => string, label: string, t: UiText, status: HTMLElement): void {
    const button = container.createEl('button', { cls: 'clickable-icon',
        attr: { type: 'button', title: label, 'aria-label': label } })
    setIcon(button, 'copy')
    const copy = async (): Promise<void> => {
        status.setText('')
        try {
            await navigator.clipboard.writeText(value())
            status.setText(t('Copied.', 'Скопировано.'))
        } catch {
            status.setText(t('Select the text above and copy it manually.', 'Выделите текст выше и скопируйте его вручную.'))
        }
    }
    button.onclick = () => void copy()
}
