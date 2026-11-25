/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Notice, Modal, sanitizeHTMLToDom } from 'obsidian'
import type { App } from 'obsidian'
import type { CardPreviewResult } from './card-preview'
import { englishUi } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'

const openPreviews = new WeakMap<App, CardPreviewModal>()
const activeMarkup = new Set([
    'applet', 'audio', 'base', 'button', 'embed', 'form', 'frame', 'frameset', 'iframe', 'input', 'link', 'meta',
    'noscript', 'object', 'option', 'script', 'select', 'source', 'style', 'svg', 'template', 'textarea', 'track', 'video',
])
const staticMarkup = new Set([
    'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'cite', 'code', 'col',
    'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q',
    'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
    'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
    'math', 'mfrac', 'mi', 'mmultiscripts', 'mn', 'mo', 'mover', 'mroot', 'mrow', 'ms', 'msqrt', 'mstyle', 'msub',
    'msubsup', 'msup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'semantics',
])
const staticAttributes = new Set([
    'alt', 'aria-hidden', 'aria-label', 'class', 'colspan', 'dir', 'height', 'id', 'lang', 'open', 'rowspan',
    'scope', 'start', 'style', 'title', 'width',
])
const localImage = /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z\d+/=\s]+$/i

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parseStaticMarkup(owner: Document | undefined, html: string): HTMLTemplateElement | undefined {
    if (!owner) return undefined
    const template = owner.adoptNode(createEl('template'))
    // Sanitize Anki HTML with the host API before applying the stricter offline preview allowlist.
    template.content.append(sanitizeHTMLToDom(html))
    for (const element of Array.from(template.content.querySelectorAll('*'))) {
        const name = element.localName.toLowerCase()
        if (activeMarkup.has(name)) {
            element.remove()
        } else if (!staticMarkup.has(name)) {
            element.replaceWith(...Array.from(element.childNodes))
        } else {
            for (const attr of Array.from(element.attributes)) {
                if (staticAttributes.has(attr.name)) continue
                if (name === 'img' && attr.name === 'src' && localImage.test(attr.value)) continue
                element.removeAttribute(attr.name)
            }
        }
    }
    return template
}

function fieldText(owner: Document | undefined, html: string, imageLabel: string): string {
    const parsed = parseStaticMarkup(owner, html)
    if (!parsed) return html
    for (const br of Array.from(parsed.content.querySelectorAll('br'))) br.replaceWith('\n')
    for (const block of Array.from(parsed.content.querySelectorAll('div,p,li,blockquote,pre,tr,h1,h2,h3,h4,h5,h6'))) {
        block.append('\n')
    }
    for (const image of Array.from(parsed.content.querySelectorAll('img'))) image.replaceWith(image.alt || imageLabel)
    return parsed.content.textContent?.trim() ?? ''
}

function frameDocument(owner: Document | undefined, html: string, css = '', ordinal = 0): string {
    const markup = parseStaticMarkup(owner, html)?.innerHTML ?? escapeHtml(html)
    const style = css.replace(/</g, '\\3c ')
    const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="${policy}">
        <style>html{color-scheme:light}body{font:1rem system-ui,sans-serif;margin:1rem;overflow-wrap:anywhere}
        img{max-width:100%;height:auto}pre{white-space:pre-wrap}a{text-decoration:underline}</style>
        <style>${style}</style></head><body class="card card${ordinal + 1}"><div id="qa" dir="auto">${markup}</div></body></html>`
}

function selectButton(button: HTMLButtonElement, selected: boolean): void {
    button.setAttribute('aria-pressed', String(selected))
    if (selected) button.addClass('mod-cta')
    else button.removeClass('mod-cta')
}

class CardPreviewModal extends Modal {
    constructor(app: App, private readonly result: CardPreviewResult, private readonly t: UiText,
        private readonly sync?: () => Promise<void>) {
        super(app)
    }

    onOpen(): void {
        const { t } = this
        this.titleEl.setText(t('Preview Anki Card', 'Предпросмотр карточки Anki'))
        this.modalEl.classList.add('rudonium-modal-48rem')
        installModalLayout(this, t)
        const { source, line, unsaved, modelName, deck, deckReason, id, cautions,
            fields, variants, previewNotice } = this.result
        const location = t(`Line ${line}`, `Строка ${line}`)
        const edits = unsaved ? t(' · Unsaved edits', ' · Несохранённые правки') : ''
        const path = this.contentEl.createEl('p', { text: `${source} · ${location}${edits}` })
        path.classList.add('rudonium-wrap-anywhere')
        this.contentEl.createEl('p', { text: t('Read-only preview', 'Предпросмотр без записи') })
            .classList.add('rudonium-text-muted')

        const metadata = this.contentEl.createEl('dl')
        metadata.classList.add('rudonium-card-preview-metadata')
        for (const [label, value] of [
            [t('Note Type', 'Тип записи'), modelName],
            [t('Deck', 'Колода'), deckReason ? `${deck} · ${deckReason}` : deck],
            ['Anki ID', id === undefined ? t('New note', 'Новая запись') : String(id)],
        ]) {
            metadata.createEl('dt', { text: label }).classList.add('rudonium-semibold')
            const description = metadata.createEl('dd', { text: value })
            description.classList.add('rudonium-card-preview-description')
        }
        for (const message of cautions ?? []) {
            const warning = this.contentEl.createEl('p', { text: message, attr: { role: 'status' } })
            warning.classList.add('rudonium-text-warning')
        }

        const tabs = this.contentEl.createDiv({ attr: { role: 'group', 'aria-label': t('Preview mode', 'Режим предпросмотра') } })
        tabs.classList.add('rudonium-card-preview-tabs')
        const fieldTab = tabs.createEl('button', { text: t('Fields', 'Поля'), attr: { type: 'button' } })
        const cardTab = tabs.createEl('button', { text: t('Card View', 'Вид карточки'), attr: { type: 'button' } })
        const fieldPanel = this.contentEl.createDiv()
        const cardPanel = this.contentEl.createDiv()

        for (const { name, html } of fields) {
            const field = fieldPanel.createEl('section')
            field.createEl('h3', { text: name })
            const value = field.createEl('pre', { text: fieldText(this.contentEl.ownerDocument, html, t('[Image]', '[Изображение]')) || '—' })
            value.classList.add('rudonium-card-preview-value')
            const details = field.createEl('details')
            details.createEl('summary', { text: t('Exported HTML', 'HTML для экспорта') })
            const raw = details.createEl('pre', { text: html })
            raw.classList.add('rudonium-wrapped-text')
        }

        let preparedCardView = false
        const select = (visual: boolean) => {
            selectButton(fieldTab, !visual)
            selectButton(cardTab, visual)
            fieldPanel.hidden = visual
            cardPanel.hidden = !visual
            if (visual && !preparedCardView) {
                preparedCardView = true
                this.showCardView(cardPanel, variants, previewNotice)
            }
        }
        fieldTab.onclick = () => select(false)
        cardTab.onclick = () => select(true)
        select(false)
        if (this.sync) {
            const actions = this.contentEl.createDiv({ cls: 'modal-button-container' })
            const sync = actions.createEl('button', { text: t('Sync this card', 'Синхронизировать эту карточку'), cls: 'mod-cta' })
            sync.onclick = async () => {
                sync.disabled = true
                try { await this.sync!() }
                catch (error) {
                    new Notice(error instanceof Error ? error.message : String(error))
                } finally { sync.disabled = false }
            }
        }
    }

    onClose(): void {
        if (openPreviews.get(this.app) === this) openPreviews.delete(this.app)
        this.contentEl.empty()
    }

    private showCardView(parent: HTMLElement, variants: CardPreviewResult['variants'], notice?: string): void {
        const { t } = this
        if (notice) parent.createEl('p', { text: notice, attr: { role: 'status' } })
        if (!variants.length) {
            if (!notice) parent.createEl('p', { text: t(
                'A card template is unavailable. Open Fields to review the exported values.',
                'Шаблон карточки недоступен. Откройте «Поля», чтобы проверить значения для экспорта.') })
            return
        }
        const controls = parent.createDiv({ attr: { role: 'group', 'aria-label': t('Card direction and side', 'Направление и сторона карточки') } })
        controls.classList.add('rudonium-card-preview-controls')
        const choices = variants.length > 1 ? variants.map(({ name }) =>
            controls.createEl('button', { text: name, attr: { type: 'button' } })) : []
        const flip = controls.createEl('button', { attr: { type: 'button' } })
        const frame = parent.createEl('iframe', { attr: { sandbox: '', referrerpolicy: 'no-referrer' } })
        frame.classList.add('rudonium-card-preview-frame')
        let selected = 0
        let back = false
        const render = () => {
            const variant: CardPreviewResult['variants'][number] & { ordinal?: number } = variants[selected]
            const ordinal = typeof variant.ordinal === 'number' && Number.isSafeInteger(variant.ordinal) &&
                variant.ordinal >= 0 ? variant.ordinal : selected
            choices.forEach((choice, index) => selectButton(choice, index === selected))
            flip.setText(back ? t('Show Front', 'Показать лицевую сторону') : t('Show Back', 'Показать оборот'))
            frame.setAttribute('title', `${variant.name} · ${back ? t('Back', 'Оборот') : t('Front', 'Лицевая сторона')}`)
            frame.srcdoc = frameDocument(this.contentEl.ownerDocument, back ? variant.back : variant.front, variant.css, ordinal)
        }
        choices.forEach((choice, index) => { choice.onclick = () => {
            selected = index
            back = false
            render()
        } })
        flip.onclick = () => { back = !back; render() }
        render()
    }
}

export function openCardPreview(app: App, result: CardPreviewResult, t: UiText = englishUi, sync?: () => Promise<void>): void {
    openPreviews.get(app)?.close()
    const modal = new CardPreviewModal(app, result, t, sync)
    openPreviews.set(app, modal)
    modal.open()
}

export { fieldText as previewFieldText }
