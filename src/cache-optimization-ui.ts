/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Modal, Notice } from 'obsidian'
import type MyPlugin from '../main'
import type { CacheOptimizationPlan } from './cache-optimization'
import { applyCacheOptimization, previewCacheOptimization } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import { installModalLayout } from './modal-layout'

const activePreviews = new WeakMap<MyPlugin, CacheOptimizationModal>()
const pathLimit = 20

function formatBytes(bytes: number): string {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MiB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
    return `${bytes.toLocaleString()} B`
}

function hasChanges({ summary }: CacheOptimizationPlan): boolean {
    return summary.hashes > 0 || summary.fileEntries > 0 || summary.idEntries > 0 || summary.mediaLinks > 0
}

class CacheOptimizationModal extends Modal {
    private closed = false
    private running = false

    constructor(private readonly plugin: MyPlugin) {
        super(plugin.app)
    }

    onOpen(): void {
        const t = uiFor(this.plugin.settings)
        this.titleEl.setText(t('Optimize Cache', 'Оптимизация кэша'))
        this.modalEl.classList.add('rudonium-modal-38rem')
        installModalLayout(this, t)
        void this.run()
    }

    onClose(): void {
        this.closed = true
        activePreviews.delete(this.plugin)
        this.contentEl.empty()
    }

    private footer(recheck = false): HTMLElement {
        const t = uiFor(this.plugin.settings)
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
        footer.classList.add('rudonium-wrap-controls')
        if (recheck) footer.createEl('button', { text: t('Recheck', 'Проверить снова') }).onclick = () => { void this.run() }
        return footer
    }

    private status(message: string, failed = false): void {
        const status = this.contentEl.createEl('p', {
            text: message,
            attr: failed ? { role: 'alert' } : { role: 'status', 'aria-live': 'polite' },
        })
        status.classList.add('rudonium-wrap-anywhere')
        if (failed) status.classList.add('rudonium-text-error')
    }

    private showResult(plan: CacheOptimizationPlan, applied: boolean): void {
        const t = uiFor(this.plugin.settings)
        const { summary, paths } = plan
        const changed = hasChanges(plan)
        this.contentEl.empty()
        this.status(applied
            ? changed ? t('Cache optimized.', 'Кэш оптимизирован.') : t('The cache is already up to date.', 'Кэш уже актуален.')
            : changed ? t('Review the obsolete cache entries before applying.', 'Сверьте список устаревших записей кэша перед удалением.') : t('There are no confirmed obsolete entries.', 'Подтверждённых устаревших записей нет.'))
        const metrics: Array<[string, number]> = [
            [t('File hashes (MD5)', 'Хеши файлов (MD5)'), summary.hashes],
            [t('File metadata entries', 'Записи метаданных файлов'), summary.fileEntries],
            [t('Anki ID index entries', 'Записи индекса Anki ID'), summary.idEntries],
            [t('Media links to missing notes', 'Ссылки на медиа отсутствующих записей'), summary.mediaLinks],
        ]
        const list = this.contentEl.createEl('ul', { attr: { 'aria-label': applied ? t('Removed entries', 'Удалённые записи') : t('Entries to remove', 'Записи для удаления') } })
        for (const [label, count] of metrics) {
            list.createEl('li', { text: `${label} · ${count.toLocaleString()}` })
        }
        this.contentEl.createEl('p', {
            text: `${applied ? t('Cache index size', 'Размер индекса кэша') : t('Estimated cache index size', 'Оценка размера индекса кэша')} · ${formatBytes(summary.bytesBefore)} → ${formatBytes(summary.bytesAfter)}`,
        })
        if (summary.skipped) {
            this.contentEl.createEl('p', {
                text: t(`${summary.skipped.toLocaleString()} paths kept because their absence could not be confirmed.`, `Пути сохранены, так как их отсутствие не подтверждено: ${summary.skipped.toLocaleString()}.`),
            })
        }
        if (paths.length) {
            const details = this.contentEl.createEl('details')
            details.createEl('summary', { text: t(`Obsolete paths · ${paths.length.toLocaleString()}`, `Устаревшие пути · ${paths.length.toLocaleString()}`) })
            const pathList = details.createEl('ul')
            for (const path of paths.slice(0, pathLimit)) {
                pathList.createEl('li', { text: path }).classList.add('rudonium-wrap-anywhere')
            }
            if (paths.length > pathLimit) {
                pathList.createEl('li', { text: t(`And ${(paths.length - pathLimit).toLocaleString()} more paths`, `Остальные пути: ${(paths.length - pathLimit).toLocaleString()}`) })
            }
        }
        if (applied) return
        const footer = this.footer(!changed)
        if (changed) footer.createEl('button', { text: t('Apply', 'Очистить кэш от этих записей'), cls: 'mod-cta' }).onclick = () => { void this.run(plan) }
    }

    private async run(plan?: CacheOptimizationPlan): Promise<void> {
        const t = uiFor(this.plugin.settings)
        if (this.running || this.closed) return
        this.running = true
        this.contentEl.empty()
        this.status(plan ? t('Rechecking paths and saving the cache…', 'Повторная проверка путей и сохранение кэша…') : t('Checking cache paths across the vault…', 'Проверка путей в кэше хранилища…'))
        try {
            const result = plan
                ? await applyCacheOptimization(this.plugin, plan)
                : await previewCacheOptimization(this.plugin)
            if (!this.closed) this.showResult(result, Boolean(plan))
            else if (plan) new Notice(hasChanges(result) ? t('Cache optimized.', 'Кэш оптимизирован.') : t('The cache is already up to date.', 'Кэш уже актуален.'))
        } catch (error) {
            const message = uiDiagnostic(error, t)
            if (!this.closed) {
                this.contentEl.empty()
                this.status(message, true)
                this.footer(true)
            } else if (plan) new Notice(t(`Could not optimize the cache. ${message}`, `Не удалось оптимизировать кэш. ${message}`))
        } finally {
            this.running = false
        }
    }
}

export function openCacheOptimization(plugin: MyPlugin): void {
    if (activePreviews.has(plugin)) return
    const modal = new CacheOptimizationModal(plugin)
    activePreviews.set(plugin, modal)
    modal.open()
}
