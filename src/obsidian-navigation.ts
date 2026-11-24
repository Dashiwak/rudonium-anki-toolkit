/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { ItemView, MarkdownView, Modal, TFile } from 'obsidian'
import type { App, Editor, WorkspaceLeaf } from 'obsidian'
import type MyPlugin from '../main'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'

export interface NavigationOrigin {
    modal: Modal
    isClosed: () => boolean
}

type SettingsDialog = {
    close: () => void | Promise<void>
    open?: () => void
    openTabById?: (id: string) => unknown
    activeTab?: { id?: string; containerEl?: HTMLElement }
    containerEl?: HTMLElement
}

const reviewType = 'rudonium-anki-record-review'
const owners = new WeakMap<App, MyPlugin>()
const navigation = new WeakMap<App, Promise<void>>()
const editorTabs = new WeakMap<App, { leaf: WorkspaceLeaf; path: string }>()

function openSettingsDialog(app: App): SettingsDialog | undefined {
    const settings = (app as App & { setting?: SettingsDialog }).setting
    if (!settings || typeof settings.close !== 'function') return
    // Obsidian versions expose either the dialog shell or the current settings tab.
    // A cached tab can stay mounted in a hidden container after settings were dismissed.
    const shown = (el?: HTMLElement) => el?.isConnected && !el.hidden &&
        (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0)
    return shown(settings.activeTab?.containerEl) || shown(settings.containerEl) ? settings : undefined
}

// Obsidian owns the modal keyboard scope. Closing its shell releases that scope before
// moving the original title and content nodes (including all controls) into a workspace leaf.
export abstract class ReviewModal extends Modal {
    dock?: RecordReviewView
    protected abstract releaseReview(): void

    onClose(): void {
        if (!this.dock) this.releaseReview()
    }

    moveTo(view: RecordReviewView): void {
        if (this.dock === view) return
        this.dock = view
        this.shouldRestoreSelection = false
        const top = this.contentEl.scrollTop
        super.close()
        view.mount(this)
        view.contentEl.scrollTop = top
    }

    close(): void {
        const dock = this.dock
        if (!dock) { super.close(); return }
        dock.release()
        dock.leaf.detach()
    }
}

class RecordReviewView extends ItemView {
    private review?: ReviewModal
    private settingsButton?: HTMLButtonElement
    private readonly t: UiText

    constructor(leaf: WorkspaceLeaf, private readonly plugin: MyPlugin) {
        super(leaf)
        this.t = uiFor(plugin.settings)
    }

    getViewType(): string { return reviewType }
    getDisplayText(): string { return this.t('Anki review', 'Проверка Anki') }
    getIcon(): string { return 'list-checks' }
    get available(): boolean { return this.review === undefined }

    async onOpen(): Promise<void> {
        this.contentEl.createEl('p', { text: this.t('Open a record from an audit to view its report here.',
            'Откройте запись из аудита, чтобы видеть отчёт рядом с заметкой.') })
        this.offerSettings()
    }

    mount(review: ReviewModal): void {
        this.review = review
        this.contentEl.empty()
        this.settingsButton = undefined
        this.contentEl.append(review.titleEl, review.contentEl)
        review.titleEl.classList.add('rudonium-docked-title')
        review.contentEl.classList.add('rudonium-docked-content')
    }

    offerSettings(dialog?: SettingsDialog): void {
        const settings = dialog ?? (this.app as App & { setting?: SettingsDialog }).setting
        if (typeof settings?.open !== 'function' || typeof settings.openTabById !== 'function') return
        const id = dialog?.activeTab?.id ?? this.plugin.manifest.id
        const top = dialog?.activeTab?.containerEl?.scrollTop ?? 0
        const button = this.settingsButton ?? this.contentEl.createEl('button', {
            text: this.t('Return to settings', 'Вернуться к настройкам'),
        })
        this.settingsButton = button
        button.onclick = () => {
            settings.open?.()
            settings.openTabById?.(id)
            const tab = settings.activeTab?.containerEl
            if (tab && top) tab.ownerDocument.defaultView?.requestAnimationFrame(() => { tab.scrollTop = top })
        }
    }

    release(): void {
        const review = this.review
        if (!review) return
        this.review = undefined
        review.dock = undefined
        review.onClose()
    }

    async onClose(): Promise<void> { this.release() }
}

export function registerRecordReview(plugin: MyPlugin): void {
    plugin.registerView(reviewType, leaf => new RecordReviewView(leaf, plugin))
    owners.set(plugin.app, plugin)
    plugin.register(() => {
        owners.delete(plugin.app)
        editorTabs.delete(plugin.app)
        for (const leaf of plugin.app.workspace.getLeavesOfType(reviewType)) leaf.detach()
    })
}

async function showReviewAlongside(app: App, origin: NavigationOrigin | undefined, settings?: SettingsDialog): Promise<void> {
    const review = origin?.modal instanceof ReviewModal ? origin.modal : undefined
    if (!owners.has(app) || !review && !settings) {
        if (origin) { origin.modal.shouldRestoreSelection = false; origin.modal.close() }
        return
    }
    const workspace = app.workspace
    let view = review?.dock
    if (!view) {
        const spare = workspace.getLeavesOfType(reviewType).map(leaf => leaf.view)
            .find((item): item is RecordReviewView => item instanceof RecordReviewView && item.available)
        if (spare) view = spare
        else {
            const leaf = workspace.getRightLeaf(false)
            if (!leaf) throw new Error('Could not open the Anki review pane.')
            try {
                await leaf.setViewState({ type: reviewType, active: false })
                await (leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.()
                if (!(leaf.view instanceof RecordReviewView)) throw new Error('Could not open the Anki review pane.')
                if (origin?.isClosed()) { leaf.detach(); return }
                view = leaf.view
            } catch (error) { leaf.detach(); throw error }
        }
    }
    if (review) review.moveTo(view)
    else if (origin) { origin.modal.shouldRestoreSelection = false; origin.modal.close() }
    if (settings) view.offerSettings(settings)
    await workspace.revealLeaf(view.leaf)
}

/** Consecutive clicks share one editor tab and cannot create competing review panes. */
export function openObsidianFile(app: App, path: string, origin?: NavigationOrigin,
    select?: (editor: Editor) => void): Promise<void> {
    const last = navigation.get(app)
    const open = () => navigateToFile(app, path, origin, select)
    const current = last ? last.then(open, open) : open()
    navigation.set(app, current)
    return current.finally(() => { if (navigation.get(app) === current) navigation.delete(app) })
}

async function navigateToFile(app: App, path: string, origin?: NavigationOrigin,
    select?: (editor: Editor) => void): Promise<void> {
    if (origin?.isClosed()) return
    const file = app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error(`${path} has moved or is missing. Recheck to update the source.`)

    const settings = openSettingsDialog(app)
    const settingsTab = settings?.activeTab
    const workspace: App['workspace'] & { revealLeaf?: (leaf: WorkspaceLeaf) => Promise<void> | void } = app.workspace
    const previous = editorTabs.get(app)
    const reusable = previous && previous.leaf.view instanceof MarkdownView &&
        previous.leaf.view.file?.path === previous.path && previous.leaf.view.containerEl.isConnected
    const leaf = reusable && previous ? previous.leaf : workspace.getLeaf('tab')
    const source = { mode: 'source', source: true }
    await leaf.openFile(file, select ? { active: false, state: source } : { active: false })
    await (leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.()
    if (select && leaf.view instanceof MarkdownView) {
        const state = leaf.getViewState()
        if (leaf.view.getMode() !== 'source' || state.state?.source !== true) {
            await leaf.setViewState({ ...state, active: false, state: { ...state.state, ...source } })
        }
    }
    const view = leaf.view
    if (!(view instanceof MarkdownView) || view.file?.path !== file.path || (select && view.getMode() !== 'source')) {
        throw new Error('The Markdown note could not be opened.')
    }
    if (origin?.isClosed()) return
    select?.(view.editor)
    await showReviewAlongside(app, origin, settings)
    if (origin?.isClosed() && origin.modal instanceof ReviewModal) return
    editorTabs.set(app, { leaf, path })
    if (settings && openSettingsDialog(app) === settings && settings.activeTab === settingsTab) {
        try {
            await settings.close?.()
        } catch (error) {
            console.warn('[Export to Anki] Could not close Obsidian settings', error)
        }
    }
    await workspace.revealLeaf?.(leaf)
    view.containerEl?.ownerDocument.defaultView?.focus()
    workspace.setActiveLeaf?.(leaf, { focus: true })
    if (select) view.editor.focus()
}
