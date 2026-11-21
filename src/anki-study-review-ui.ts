/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { MarkdownView, Modal } from 'obsidian'
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import { readCardStudyDetails, sameCardIds } from './anki-card-impact'
import type { CardStudyDetail } from './anki-card-impact'
import { studyCardDescription } from './anki-card-impact-ui'
import { readReviewedNoteSnapshots, snapshotFields, snapshotKey } from './anki-delta'
import { requireExpectedAnkiProfile } from './anki-profile'
import { ankiStudyDeckKey, findFilteredAnkiCards, readAnkiDeckKind } from './anki-study-state'
import { hasPendingAnkiWrite, withAnkiDeadline, withAnkiWriteDeadline } from './anki-transport'
import { hasPendingBidirectionalWrite } from './bidirectional-sync'
import { withFastScanReadLock } from './fast-scan'
import { uiDiagnostic, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { installModalLayout } from './modal-layout'
import { auditRead } from './sync-audit'
import type { SyncAuditResult } from './sync-audit'
import { isSyncAuditReportPath, syncScopeSignature } from './sync-profiles'
import { indexVaultIds } from './vault-id-index'

interface StudyCard extends CardStudyDetail { suspended: boolean }
interface ReviewedStudyCards {
    record: string
    scope: string
    cards: StudyCard[]
}

export function canReviewMissingSourceCards(result: SyncAuditResult, id: number): boolean {
    const profile = result.ankiProfile
    return result.ankiInventoryComplete && result.vaultInventoryComplete && result.ankiDeckKind === 'ordinary' &&
        !!profile && 'active' in profile && (!profile.expected || profile.expected === profile.active) &&
        result.ankiOnly.some(note => note.id === id && note.metadataAvailable && note.markers.includes('vault-link'))
}

/** Ручной Obsidian URL в тексте недостаточен. Для изменения состояния нужна созданная плагином ссылка с точным ID. */
export function ownedMissingStudyLink(fields: readonly [string, string][], vault: string, id: number): string | undefined {
    const paths = new Set<string>()
    for (const [, html] of fields) {
        for (const match of html.matchAll(/<a href="(obsidian:\/\/anki-card\?[^"<>\r\n]*)" class="obsidian-link">Obsidian<\/a>/gu)) {
            try {
                const url = new URL(match[1].replace(/&amp;/gu, '&'))
                const names = url.searchParams.getAll('vault')
                const sources = url.searchParams.getAll('file')
                const ids = url.searchParams.getAll('nid')
                const source = sources[0]
                if (url.username || url.password || url.port || url.hash || names.length !== 1 ||
                    names[0].normalize('NFC') !== vault.normalize('NFC') || sources.length !== 1 ||
                    ids.length !== 1 || ids[0] !== String(id) || !source || !/\.md$/iu.test(source) ||
                    source.split('/').some(part => !part || part === '.' || part === '..') || source.includes('\\') || Array.from(source).some(character => character.charCodeAt(0) < 32)) continue
                paths.add(source)
            } catch {
                // Ошибочная ссылка не подтверждает принадлежность записи.
            }
        }
    }
    return paths.size === 1 ? paths.values().next().value : undefined
}

async function readSuspended(ids: number[]): Promise<boolean[]> {
    const answer = await withAnkiDeadline(() => AnkiConnect.invoke('areSuspended', { cards: ids }), 'AnkiConnect areSuspended')
    if (!Array.isArray(answer) || answer.length !== ids.length || !answer.every(value => typeof value === 'boolean')) {
        throw new Error('Anki did not confirm the suspension status of every requested card.')
    }
    return answer
}

function stale(t: UiText): Error {
    return new Error(t('The source, deck or study cards changed. Run the audit again.',
        'Источник, колода или учебные карточки изменились. Выполните аудит заново.'))
}

function unsavedMarkdown(plugin: MyPlugin): boolean {
    return plugin.app.workspace.getLeavesOfType('markdown').some(({ view }) =>
        view instanceof MarkdownView && view.getMode() === 'source' &&
        view.getViewData().replace(/\r\n/g, '\n') !== view.data.replace(/\r\n/g, '\n'))
}

async function examineStudyCards(plugin: MyPlugin, result: SyncAuditResult, id: number,
    apply?: { preview: ReviewedStudyCards; card: StudyCard }, stopped = () => false): Promise<ReviewedStudyCards> {
    const t = uiFor(plugin.settings)
    const profile = result.ankiProfile
    if (!canReviewMissingSourceCards(result, id) || !profile || !('active' in profile)) throw stale(t)
    return withFastScanReadLock(plugin, async (currentRevision, pathRevision) => {
        const revision = currentRevision()
        const scope = syncScopeSignature(plugin.settings)
        const stillCurrent = () => !stopped() && currentRevision() === revision &&
            syncScopeSignature(plugin.settings) === scope && !unsavedMarkdown(plugin)
        if (!stillCurrent() || apply && apply.preview.scope !== scope) throw stale(t)
        if (hasPendingAnkiWrite(plugin.app) || hasPendingBidirectionalWrite(plugin.app)) {
            throw new Error(t('Wait for the previous Anki request to finish.', 'Дождитесь завершения предыдущего запроса к Anki.'))
        }
        await requireExpectedAnkiProfile(plugin, profile.active)
        const { vault } = plugin.app
        // Подтверждаем отсутствие ID во всём хранилище. Перед записью перечитываем файлы.
        const files = vault.getMarkdownFiles().filter(file => !isSyncAuditReportPath(file.path))
        const index = await indexVaultIds(plugin, files, plugin.settings.Syntax, pathRevision, {
            force: !!apply, shouldStop: () => !stillCurrent(),
        })
        if (!index.complete || index.first.has(id) || index.duplicates.has(id) || !stillCurrent()) throw stale(t)
        const source = (await readReviewedNoteSnapshots([id])).get(id)
        if (!source || !source.cards.length || !ownedMissingStudyLink(snapshotFields(source), vault.getName(), id)) {
            throw new Error(t('Could not confirm the study cards or a generated link to this vault.',
                'Не удалось подтвердить учебные карточки или созданную плагином ссылку на это хранилище.'))
        }
        const record = snapshotKey(source)
        if (apply && record !== apply.preview.record) throw stale(t)
        if (await readAnkiDeckKind(result.deck, (action, params) => auditRead(action, params)) !== 'ordinary') throw stale(t)
        const cards = await readCardStudyDetails(id, source.cards, ids => auditRead('cardsInfo', { cards: ids }))
        const filtered = await findFilteredAnkiCards(source.cards, (action, params) => auditRead(action, params ?? {}))
        if (filtered.size || cards.some(card => !card.deck || ankiStudyDeckKey(card.deck) !== ankiStudyDeckKey(result.deck))) {
            throw new Error(t('This action requires all cards to be in the exact ordinary deck in this audit.',
                'Для этого действия все карточки должны находиться в обычной колоде, выбранной в аудите.'))
        }
        const ids = cards.map(card => card.id)
        const suspension = await readSuspended(ids)
        await requireExpectedAnkiProfile(plugin, profile.active)
        if (!stillCurrent()) throw stale(t)
        if (!apply) return { scope, record, cards: cards.map((card, index) => ({ ...card, suspended: suspension[index] })) }
        const indexToChange = ids.indexOf(apply.card.id)
        if (indexToChange < 0 || suspension[indexToChange] !== apply.card.suspended) throw stale(t)
        const target = !apply.card.suspended
        const action = target ? 'suspend' : 'unsuspend'
        await withAnkiWriteDeadline(plugin.app, () => {
            if (!stillCurrent()) throw stale(t)
            return AnkiConnect.invoke(action, { cards: [apply.card.id] })
        }, `AnkiConnect ${action}`)
        await requireExpectedAnkiProfile(plugin, profile.active)
        const verified = (await readReviewedNoteSnapshots([id])).get(id)
        const after = await readSuspended(ids)
        await requireExpectedAnkiProfile(plugin, profile.active)
        if (!verified || !sameCardIds(verified.cards, ids) ||
            after.some((value, index) => value !== (index === indexToChange ? target : suspension[index]))) {
            throw new Error(t('Anki did not confirm the exact result. Run the audit again before taking another action.',
                'Anki не подтвердила точный результат. Выполните аудит заново перед следующим действием.'))
        }
        return { scope, record, cards: cards.map((card, index) => ({ ...card, suspended: after[index] })) }
    })
}

class StudyCardsModal extends Modal {
    private readonly t: UiText
    private openNow = false
    constructor(private readonly plugin: MyPlugin, private readonly result: SyncAuditResult, private readonly id: number) {
        super(plugin.app)
        this.t = uiFor(plugin.settings)
    }

    onOpen(): void {
        this.openNow = true
        installModalLayout(this, this.t)
        this.titleEl.setText(this.t('Study cards', 'Учебные карточки'))
        void this.review()
    }

    onClose(): void { this.openNow = false; this.contentEl.empty() }

    private async review(apply?: { preview: ReviewedStudyCards; card: StudyCard }): Promise<void> {
        const t = this.t
        this.contentEl.empty()
        const status = this.contentEl.createEl('p', { text: t('Checking the source and card IDs…', 'Проверяем источник и ID карточек…'), attr: { role: 'status' } })
        try {
            const preview = await examineStudyCards(this.plugin, this.result, this.id, apply, () => !this.openNow)
            if (!this.openNow) return
            status.setText(apply ? t('Anki confirmed the change for the same card ID.', 'Anki подтвердила изменение по тому же ID карточки.')
                : t('Select a single study card to change its suspension status.', 'Выберите одну учебную карточку для изменения её статуса.'))
            const items = this.contentEl.createEl('ul')
            for (const card of preview.cards) {
                const item = items.createEl('li', { text: studyCardDescription({ ...card, queue: undefined }, t) + ' · ' +
                    (card.suspended ? t('suspended', 'приостановлена') : t('available for review', 'доступна для повторения')) })
                const button = item.createEl('button', { text: card.suspended ? t('Resume reviews', 'Возобновить повторение')
                    : t('Suspend reviews', 'Приостановить повторение') })
                button.onclick = () => { if (this.openNow) void this.review({ preview, card }) }
            }
        } catch (error) {
            if (!this.openNow) return
            status.setText(uiDiagnostic(error, t))
            status.setAttribute('role', 'alert')
        }
    }
}

export function openAuditStudyCards(plugin: MyPlugin, result: SyncAuditResult, id: number): void {
    if (canReviewMissingSourceCards(result, id)) new StudyCardsModal(plugin, result, id).open()
}
