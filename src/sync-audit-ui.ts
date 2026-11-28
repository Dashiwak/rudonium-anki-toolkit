/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { checkedCount } from './sync-outcome'
import { Modal, Notice } from 'obsidian'
import type { App, TFile } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, expectedAnkiProfile, isAnkiProfileLockEnabled, profileProblemText, requireExpectedAnkiProfile } from './anki-profile'
import { openAnkiProfileSettings } from './anki-profile-ui'
import type { ExportRepairTarget } from './export-review-ui'
import { auditRead, syncAuditDeckKey } from './sync-audit'
import type { SyncAuditAnkiProfile, SyncAuditDeckAssignment, SyncAuditResult, SyncAuditSource } from './sync-audit'
import { auditCandidateSnapshotCurrent, auditPluginSync } from './vault-sync-audit'
import type { VaultSyncAuditScope } from './vault-sync-audit'
import { openDuplicateIdReview, openExportJournal, previewVaultExport, scanVaultFast, waitForFastScanIdle,
    withFastScanReadLock } from './fast-scan'
import { openAuditAnkiNote, openAuditSource, openSyncDifferenceReview } from './sync-difference-ui'
import { openObsidianFile, ReviewModal } from './obsidian-navigation'
import { SyncAuditDeckPicker } from './sync-deck-picker'
import { resolveSyncScope, syncScopeSignature } from './sync-profiles'
import { describeDeckRoute } from './deck-routes'
import type { DeckRouteOrigin } from './deck-routes'
import { englishUi, uiFor } from './interface-language'
import type { UiText } from './interface-language'
import { openAnkiSourceRestore } from './anki-source-restore-ui'
import { openAuditRepair } from './audit-repair-ui'
import { openLostIdRecovery } from './lost-id-recovery-ui'
import { installModalLayout } from './modal-layout'
import { auditAttachmentPresence, hasAuditAttachmentSources, renderAttachmentContentChecks,
    verifyLocalAttachmentContents } from './audit-attachment-check'
import type { AuditAttachmentIssue } from './audit-attachment-check'
import { auditCardRows, checkAuditNewCards, filterAuditCards } from './audit-card-status'
import type { AuditCardRow, AuditCardStatus } from './audit-card-status'
import { isDuplicateFirstFieldErrorMessage } from './anki-transport'
import { readAnkiDeckKind } from './anki-study-state'

const reportPrefix = 'Anki sync audit '
const reportFrontmatter = '---\nanki-sync-audit-report: true\n---\n'
const previewRows = 8
const moreRows = 25
const previewDetails = 6
const openAudits = new WeakMap<MyPlugin, Modal>()
const auditsFromNotice = new WeakMap<MyPlugin, object>()
const resultScopeSignatures = new WeakMap<SyncAuditResult, string>()

const cardStatuses: Record<AuditCardStatus, readonly [string, string]> = {
    same: ['Matches', 'Совпадает'],
    'obsidian-edit': ['Changed in Obsidian', 'Правка в Obsidian'],
    'anki-edit': ['Changed in Anki', 'Правка в Anki'],
    conflict: ['Both sides changed the same field', 'Обе стороны изменили одно поле'],
    different: ['Differences', 'Есть расхождения'],
    unverified: ['Verification incomplete', 'Проверка неполна'],
    new: ['Not linked · creation not checked', 'Без связи · создание не проверено'],
    ready: ['Ready to create in Anki', 'Готова к созданию в Anki'],
    duplicate: ['Duplicate', 'Дубликат'],
    blocked: ['Creation rejected', 'Создание отклонено'],
    'missing-anki': ['Missing in Anki', 'Отсутствует в Anki'],
    'missing-source': ['Missing Obsidian source', 'В Obsidian нет источника'],
    'other-deck': ['Different Anki deck', 'В другой колоде Anki'],
    'outside-scope': ['Source outside the current scope', 'Источник вне области сверки'],
    'pending-deletion': ['Deletion marker', 'Метка удаления'],
    unrecognized: ['Card structure unrecognized', 'Карточка не распознана'],
}

function auditTitle(t: UiText): string {
    return t('Obsidian–Anki Sync Audit · Deck', 'Проверка синхронизации Obsidian и Anki · Колода')
}

function attachmentIssueTitle(issue: AuditAttachmentIssue, t: UiText): string {
    switch (issue.kind) {
        case 'missing-local': return t('Missing in Obsidian', 'Не найдено в Obsidian')
        case 'missing-anki': return t('Expected name absent in Anki', 'Ожидаемого имени нет в Anki')
        case 'same-local-name': return t('Same attachment name in Obsidian', 'Одинаковые имена вложений в Obsidian')
        case 'same-anki-name': return t('Equivalent attachment names in Anki', 'Совпадающие имена вложений в Anki')
        case 'different-anki-name': return t('Attachment spelling differs in Anki', 'Написание имени в Anki отличается')
    }
}

function exportIncompleteMessage(t: UiText): string {
    return t('The full export did not confirm all changes.', 'Часть изменений при экспорте не удалось подтвердить.')
}

const auditDiagnostics: ReadonlyArray<readonly [RegExp, string]> = [
    [/^the sync profile changed/i, 'Профиль папок изменился. Запустите проверку заново.'],
    [/^the export settings changed/i, 'Настройки экспорта изменились. Запустите проверку заново.'],
    [/^the Anki profile (?:changed|could no longer)/i, 'Профиль Anki изменился или перестал отвечать. Проверьте открытый профиль и повторите аудит.'],
    [/^expected Anki profile/i, 'В Anki открыт другой профиль. Откройте нужный и повторите аудит.'],
    [/^An Anki ID is inside a table cell/i, 'ID находится в ячейке. Перенесите строку ID под таблицу.'],
    [/^confirm the expected Anki profile/i, 'Подтвердите ожидаемый профиль Anki в настройках плагина и повторите аудит.'],
    [/^set Defaults|^Defaults → Deck is empty/i, 'Укажите колоду по умолчанию в настройках и повторите аудит.'],
    [/^the (?:file|vault) changed/i, 'Файл или хранилище изменилось во время чтения. Повторите аудит.'],
    [/^the editor has unsaved changes/i, 'В редакторе есть несохранённые правки. Сохраните заметку и повторите аудит.'],
    [/^could not parse YAML/i, 'Не удалось разобрать свойства YAML. Проверьте начало файла.'],
    [/^could not parse Markdown/i, 'Не удалось разобрать Markdown. Проверьте разметку файла.'],
    [/^card-like text is inside a math block/i, 'Текст похож на карточку и находится внутри математического блока. Карточка пропущена.'],
    [/^this source has an unresolved Anki creation/i, 'Создание записи Anki не подтверждено. Откройте проверку незавершённых созданий.'],
    [/^more than one new card in this deck has the same first field/i, 'У нескольких новых карточек в этой колоде совпадает первое поле.'],
    [/^check this card in export preview/i, 'Проверьте эту карточку в предпросмотре экспорта.'],
    [/^Anki deck membership changed/i, 'Состав колоды изменился во время проверки. Обновите отчёт.'],
    [/^this exact deck name requires numeric deck search/i, 'Для точной проверки этой колоды нужен поиск по её числовому ID. Проверьте версию AnkiConnect.'],
    [/^notesInfo:/i, 'Не удалось подтвердить поля, теги или карточки части записей Anki.'],
    [/^(?:getDecks|cardsInfo|cardsToNotes|findCards):/i, 'Не удалось подтвердить состав колод или расположение части карточек Anki.'],
    [/^findNotes:/i, 'Не удалось подтвердить наличие части записей в Anki по ID.'],
    [/^Anki deck inventory|^deckNames/i, 'Не удалось получить состав колоды Anki. Проверьте AnkiConnect и повторите аудит.'],
    [/timed out|timeout|did not reply in time/i, 'AnkiConnect не ответил вовремя. Повторите проверку.'],
    [/failed to fetch|connection refused|could not connect|network error/i, 'Нет связи с Anki. Откройте Anki и проверьте AnkiConnect.'],
]

function auditDiagnostic(raw: string, t: UiText): string {
    if (t('en', 'ru') === 'en') return raw
    const message = raw.replace(/^Error:\s*/, '')
    if (/^\p{Script=Cyrillic}/u.test(message)) return message
    if (isDuplicateFirstFieldErrorMessage(message)) return 'В Anki уже есть карточка с таким первым полем.'
    return auditDiagnostics.find(([pattern]) => pattern.test(message))?.[1] ??
        'Не удалось подтвердить данные. Повторите проверку. Технические подробности доступны в консоли Obsidian.'
}

type SourceLink = Pick<SyncAuditSource, 'path' | 'line' | 'endLine' | 'markerLine'> & { id?: number }
type IssueAction = { source: SourceLink; ankiId?: number; auditDeck?: string; repairId?: number } |
    { ankiId: number; restoreSource?: boolean } | { differenceId: number } | { duplicateId: number }
type RowAction = IssueAction | { assignment: SyncAuditDeckAssignment }

interface AuditSection {
    title: string
    count: number
    describe: (index: number, limit: number) => string
    attention: boolean
    review?: 'duplicates' | 'differences'
    action?: (index: number) => RowAction | undefined
}

function section<T>(
    title: string,
    items: readonly T[],
    describe: (item: T, limit: number) => string,
    attention = false,
    action?: (item: T) => RowAction | undefined,
): AuditSection {
    return { title, count: items.length, describe: (index, limit) => describe(items[index], limit), attention,
        action: action && (index => action(items[index])) }
}

function sourceLocation(source: Pick<SyncAuditSource, 'path' | 'line'>, t: UiText): string {
    return source.line === undefined ? source.path : t(`${source.path}, line ${source.line}`, `${source.path}, строка ${source.line}`)
}

function scopedSourceLocation(source: SyncAuditSource, t: UiText): string {
    const reason = source.excludedByProfile ? t('excluded by profile', 'исключено профилем') :
        source.inExportScope === false ? t('outside included folders', 'вне выбранных папок') : ''
    return sourceLocation(source, t) + (reason ? ` · ${reason}` : '')
}

function describeList<T>(items: readonly T[], limit: number, describe: (item: T) => string, t: UiText): string {
    const descriptions = items.slice(0, limit).map(describe)
    if (items.length > limit) descriptions.push(t(`${items.length - limit} more`, `ещё ${items.length - limit}`))
    return descriptions.join(', ')
}

function scopeDescription(deck: string, t: UiText): string {
    return t(`Deck — ${deck}. Obsidian cards are included when their export target resolves to this exact deck and the file is in scope. Subdecks are checked separately. Duplicate IDs are checked across the vault.`,
        `Колода — ${deck}. Учитываются карточки для этой колоды из выбранных файлов. Подколоды проверяются отдельно. Повторяющиеся ID проверяются во всём хранилище.`)
}

function folderProfileLabel(profile: NonNullable<SyncAuditResult['folderProfile']>, t: UiText): string {
    return !profile.named && profile.label === 'Entire vault' ? t('Entire vault', 'Всё хранилище') : profile.label
}

function folderProfileDescription(profile: NonNullable<SyncAuditResult['folderProfile']>, t: UiText): string {
    const label = folderProfileLabel(profile, t)
    return t(`Sync Profile — ${label} · ${profile.files} ${profile.files === 1 ? 'file' : 'files'} in scope`,
        `Профиль папок — ${label} · файлов в области проверки — ${profile.files}`)
}

function ankiProfileDescription(result: SyncAuditResult, t: UiText): string {
    const profile = result.ankiProfile
    const active = profile && 'active' in profile ? profile.active : t('Unconfirmed', 'Не подтверждён')
    return t(`Active Anki profile — ${active}`, `Активный профиль Anki — ${active}`)
}

function auditModeDescription(t: UiText, exportedScope?: string): string {
    return exportedScope
        ? t(`Audit mode — After export of ${exportedScope}`, `Режим проверки — после экспорта (${exportedScope})`)
        : t('Audit mode — Read-only', 'Режим проверки — только чтение')
}

function firstSource(occurrences: readonly SyncAuditSource[], ankiId?: number, auditDeck?: string): IssueAction | undefined {
    const source = occurrences[0]
    if (source) return { source, ankiId, auditDeck }
    if (ankiId !== undefined) return { ankiId }
}

function deckRouteText(route: DeckRouteOrigin | undefined, t: UiText): string {
    return route ? ` (${describeDeckRoute(route, t)})` : ''
}

function describeDeckTarget(source: SyncAuditSource, describeLocation: (source: SyncAuditSource) => string, t: UiText): string {
    const location = describeLocation(source)
    const deck = source.assignedDeck
    if (!deck) return location
    return t(`${location} · Obsidian target — ${deck}`, `${location} · колода из Obsidian — ${deck}`) + deckRouteText(source.deckRoute, t)
}

function deckFileText(file: SyncAuditDeckAssignment['files'][number], t: UiText): string {
    const route = file.deckRoute ? ` · ${describeDeckRoute(file.deckRoute, t)}` : ''
    return t(`${file.path} · ${file.linked} linked, ${file.unlinked} unlinked`,
        `${file.path} · с привязкой — ${file.linked}, без привязки — ${file.unlinked}`) + route
}

function summaryLines(result: SyncAuditResult, t: UiText): string[] {
    const { counts, ankiInventoryComplete, vaultInventoryComplete } = result
    const incomplete = vaultInventoryComplete ? '' : t(' · check incomplete', ' · проверка неполная')
    const lines = [
        checkedCount(counts.filesScanned, 'file', t),
        t(`Duplicate Anki IDs across the vault — ${counts.duplicateIds}`, `Повторяющихся ID Anki в хранилище — ${counts.duplicateIds}`) + incomplete,
    ]
    if (result.ankiDeckKind === 'filtered') {
        lines.push(t('Filtered deck — cards currently present', 'Фильтрованная колода — карточки, которые сейчас в ней'),
            t(`Linked Obsidian IDs in the current cards — ${counts.vaultIds}`, `ID из Obsidian в этих карточках — ${counts.vaultIds}`))
    } else {
        lines.push(t(`Obsidian IDs targeting this deck — ${counts.vaultIds}`, `ID в Obsidian для этой колоды — ${counts.vaultIds}`),
            t(`Obsidian cards without an Anki link — ${counts.unlinkedNotes}`, `Карточки Obsidian без привязки к Anki — ${counts.unlinkedNotes}`))
    }
    if (ankiInventoryComplete) {
        lines.push(t(`Anki notes in this deck — ${counts.ankiNotes}`, `Записей Anki в колоде — ${counts.ankiNotes}`),
            t(`Anki cards in this deck — ${counts.ankiCards}`, `Карточек Anki в колоде — ${counts.ankiCards}`),
            t(`Matching note IDs in this deck — ${counts.matchedIds}`, `Совпадающих ID записей в колоде — ${counts.matchedIds}`),
            t(`Notes compared — ${counts.comparedIds} of ${counts.comparisonCandidates}`,
                `Сопоставлено записей — ${counts.comparedIds} из ${counts.comparisonCandidates}`))
        if (result.ankiDeckKind !== 'filtered' && counts.ankiFilteredCards) {
            lines.push(t(`Cards temporarily in filtered decks — ${counts.ankiFilteredCards}`,
                `Карточек временно в фильтрованных колодах — ${counts.ankiFilteredCards}`))
        }
    } else {
        lines.push(t('The Anki inventory for this deck is unavailable.', 'Не удалось получить содержимое колоды Anki.'))
    }
    return lines
}

function resultSections(result: SyncAuditResult, t: UiText): AuditSection[] {
    const deckKey = syncAuditDeckKey(result.deck)
    const noteLabel = (id: number) => t(`Note ID ${id}`, `ID записи ${id}`)
    const location = (source: SyncAuditSource) => sourceLocation(source, t)
    const scopedLocation = (source: SyncAuditSource) => scopedSourceLocation(source, t)
    const ankiMarked: Array<SyncAuditResult['ankiOnly'][number]> = []
    const ankiUnmarked: Array<SyncAuditResult['ankiOnly'][number]> = []
    const ankiUnknown: Array<SyncAuditResult['ankiOnly'][number]> = []
    for (const note of result.ankiOnly) {
        if (!note.metadataAvailable) ankiUnknown.push(note)
        else if (note.markers.length) ankiMarked.push(note)
        else ankiUnmarked.push(note)
    }
    const describeAnki = (note: SyncAuditResult['ankiOnly'][number]): string => {
        const details = [
            note.modelName,
            note.markers.includes('configured-tag') ? t('export tag', 'тег экспорта') : undefined,
            note.markers.includes('vault-link') ? t('vault link', 'ссылка на хранилище') : undefined,
        ].filter(Boolean)
        return [noteLabel(note.id), ...details].join(' · ')
    }
    const browseAnki = (note: SyncAuditResult['ankiOnly'][number]): IssueAction => ({ ankiId: note.id, restoreSource: true })
    const differences = { ...section(
        t('Differences in matched notes', 'Различия в связанных записях'), result.differences, (note, limit) => {
            const details: string[] = []
            if (note.model) details.push(t(`note type ${note.model.actual} → ${note.model.expected}`,
                `тип записи ${note.model.actual} → ${note.model.expected}`))
            if (note.fields.length) details.push(t('fields — ', 'поля — ') + describeList(note.fields, limit, field =>
                field.kind === 'missing' ? t(`${field.name} (missing in Anki)`, `${field.name} (отсутствует в Anki)`) : field.name, t))
            if (note.decks.length) {
                const decks = describeList(note.decks, limit, card => t(`card ID ${card.cardId}, ${card.actual} → ${card.expected}`,
                    `ID карточки ${card.cardId}, ${card.actual} → ${card.expected}`), t)
                details.push(t('decks — ', 'колоды — ') + decks + deckRouteText(note.deckRoute, t))
            }
            if (note.missingTags.length) details.push(t('tags missing from Anki — ', 'теги отсутствуют в Anki — ') +
                describeList(note.missingTags, limit, String, t))
            if (note.extraTags.length) details.push(t('extra Anki tags — ', 'дополнительные теги Anki — ') +
                describeList(note.extraTags, limit, String, t))
            if (!note.complete) details.push(t('some data unavailable', 'часть данных недоступна'))
            return [noteLabel(note.id), location(note), ...details].join(' · ')
        }, true, note => ({ differenceId: note.id }),
    ), review: 'differences' as const }
    const duplicates = { ...section(t('Duplicate Anki IDs in Obsidian', 'Повторяющиеся ID Anki в Obsidian'), result.duplicateIds, (note, limit) =>
        `${noteLabel(note.id)} · ${describeList(note.occurrences, limit, scopedLocation, t)}`, true,
        note => ({ duplicateId: note.id })), review: 'duplicates' as const }
    const only = result.ankiInventoryComplete ? [
        section(t('Obsidian only · IDs missing from Anki', 'Только в Obsidian · ID отсутствуют в Anki'), result.obsidianOnly, (note, limit) =>
            `${noteLabel(note.id)} · ${describeList(note.occurrences, limit, location, t)}`, true, note => {
            const source = note.occurrences[0]
            return source ? { source: { ...source, id: note.id }, repairId: note.id } : undefined
        }),
        section(t('Anki only · with an export tag or vault link', 'Только в Anki · есть тег экспорта или ссылка на хранилище'), ankiMarked, describeAnki, true, browseAnki),
        section(t('Anki only · without export markers', 'Только в Anki · без меток экспорта'), ankiUnmarked, describeAnki, false, browseAnki),
        section(t('Anki only · export markers not checked', 'Только в Anki · метки экспорта не проверены'), ankiUnknown, describeAnki, true, browseAnki),
        section(t('In this Anki deck · Obsidian source unverified', 'В этой колоде Anki · источник в Obsidian не подтверждён'),
            result.unverifiedSourceIds, noteLabel,
            false, id => ({ ankiId: id })),
    ] : []
    const profileExcluded: SyncAuditResult['outsideObsidianScope'] = []
    const profileOutside: SyncAuditResult['outsideObsidianScope'] = []
    const otherDeck: SyncAuditResult['outsideObsidianScope'] = []
    const unknownDeck: SyncAuditResult['outsideObsidianScope'] = []
    const targetsOtherDeck = (source: SyncAuditSource): boolean =>
        source.inExportScope !== false && !!source.assignedDeck && syncAuditDeckKey(source.assignedDeck) !== deckKey
    for (const note of result.outsideObsidianScope) {
        const inside = note.occurrences.some(source => source.inExportScope !== false)
        if (result.folderProfile?.named && !inside) {
            if (note.occurrences.every(source => source.excludedByProfile)) profileExcluded.push(note)
            else profileOutside.push(note)
        } else if (note.occurrences.some(targetsOtherDeck)) otherDeck.push(note)
        else unknownDeck.push(note)
    }
    const describeOutsideScope = (note: SyncAuditResult['outsideObsidianScope'][number], limit: number) =>
        `${noteLabel(note.id)} · ${describeList(note.occurrences, limit, source =>
            describeDeckTarget(source, scopedLocation, t), t)}` + t(` · in Anki — ${result.deck}`, ` · в Anki — ${result.deck}`)
    const openOutsideScope = (note: SyncAuditResult['outsideObsidianScope'][number]) => firstSource(note.occurrences, note.id)
    const deckMismatches = result.ankiInventoryComplete ? [
        section(t('Obsidian targets this deck · absent from it in Anki', 'Для этой колоды в Obsidian · отсутствуют в ней в Anki'), result.outsideAnkiDeck, (note, limit) => {
            const actual = note.actualDecks.length ? describeList(note.actualDecks, limit, String, t)
                : note.deckDetailsComplete ? t('no generated cards', 'нет созданных карточек') : t('card decks unavailable', 'колоды карточек недоступны')
            const partial = note.actualDecks.length && !note.deckDetailsComplete
                ? t(' · some deck details unavailable', ' · часть сведений о колодах недоступна') : ''
            return `${noteLabel(note.id)} · ${describeList(note.occurrences, limit, source =>
                describeDeckTarget(source, location, t), t)}` + t(` · in Anki — ${actual}`, ` · в Anki — ${actual}`) + partial
        }, true, note => firstSource(note.occurrences, note.id,
            note.deckDetailsComplete && note.actualDecks.length === 1 ? note.actualDecks[0] : undefined)),
        section(t('In this Anki deck · Obsidian targets another deck', 'В этой колоде Anki · в Obsidian выбрана другая колода'), otherDeck, describeOutsideScope, true, note => {
            const occurrences = note.occurrences.filter(targetsOtherDeck)
            const targets = new Map(occurrences.map(source => [syncAuditDeckKey(source.assignedDeck!), source.assignedDeck!] as const))
            return firstSource(occurrences, note.id, targets.size === 1 ? targets.values().next().value : undefined)
        }),
        section(t('In this Anki deck · Obsidian target deck unverified', 'В этой колоде Anki · колода в Obsidian не подтверждена'),
            unknownDeck, describeOutsideScope, true, openOutsideScope),
        section(t('In this Anki deck · Obsidian source outside the selected profile', 'В этой колоде Anki · источник вне выбранного профиля папок'),
            profileOutside, describeOutsideScope, false, openOutsideScope),
        section(t('In this Anki deck · Obsidian source excluded by profile', 'В этой колоде Anki · источник исключён профилем папок'),
            profileExcluded, describeOutsideScope, false, openOutsideScope),
    ] : []
    const filteredAction = (card: SyncAuditResult['filteredCards'][number]): IssueAction => card.path
        ? { source: { path: card.path, line: card.line }, ankiId: card.id } : { ankiId: card.id }
    return [
        duplicates, differences, ...deckMismatches, ...only,
        section(t('Filtered cards with a different home deck', 'Фильтрованные карточки с другой исходной колодой'),
            result.filteredCards.filter(card => card.homeMismatch), card => noteLabel(card.id) +
            t(` · temporary — ${card.filteredDeck} · home differs from ${card.expectedHomeDeck}`,
                ` · временно в ${card.filteredDeck} · исходная колода отличается от ${card.expectedHomeDeck}`),
        true, filteredAction),
        section(t('Obsidian files with unlinked cards', 'Файлы Obsidian с непривязанными карточками'), result.unlinked, (note, limit) => {
            const count = t(`${note.path} · ${note.count} ${note.count === 1 ? 'card' : 'cards'}`, `${note.path} · карточек — ${note.count}`)
            if (!note.lines?.length) return count
            const lines = describeList(note.lines, limit, String, t)
            return count + t(` · ${note.lines.length === 1 ? 'line' : 'lines'} ${lines}`,
                ` · ${note.lines.length === 1 ? 'строка' : 'строки'} ${lines}`)
        }, false, note => ({ source: { path: note.path, line: note.lines?.[0] } })),
        section(t('Deletion commands in Obsidian', 'Команды удаления в Obsidian'), result.pendingDeletions, note =>
            `${noteLabel(note.id)} · ${scopedLocation(note)}`, false, note => ({ source: note })),
        section(t('Anki IDs outside recognised cards', 'ID Anki вне распознанных карточек'), result.unparsedIds, note =>
            `${noteLabel(note.id)} · ${scopedLocation(note)}`, true, note => ({ source: note })),
        section(t('Obsidian audit errors', 'Ошибки проверки в Obsidian'), result.fileErrors, error => `${error.path} · ${auditDiagnostic(error.message, t)}`, true,
            error => /\.md$/i.test(error.path) ? { source: { path: error.path } } : undefined),
        section(t('Anki read errors', 'Ошибки чтения Anki'), result.ankiErrors, error => auditDiagnostic(error, t), true),
        section(t('Cards temporarily in filtered decks', 'Карточки временно в фильтрованных колодах'),
            result.filteredCards.filter(card => !card.homeMismatch), card =>
            noteLabel(card.id) + (card.homeDeck ? ` · ${card.homeDeck} → ${card.filteredDeck}`
                : t(` · temporary — ${card.filteredDeck} · home deck unverified`,
                    ` · временно в ${card.filteredDeck} · исходная колода не подтверждена`)), false, filteredAction),
        section(t('Markdown formatting warnings', 'Предупреждения о разметке Markdown'), result.markdownWarnings ?? [], warning =>
            `${sourceLocation(warning, t)} · ${auditDiagnostic(warning.message, t)}`, true, warning => ({ source: warning })),
        section(t('Other Obsidian export decks', 'Другие колоды для экспорта из Obsidian'),
            result.deckAssignments.filter(assignment => syncAuditDeckKey(assignment.deck) !== deckKey),
            assignment => t(`${assignment.deck} · ${assignment.files.length} ${assignment.files.length === 1 ? 'file' : 'files'}`,
                `${assignment.deck} · файлов — ${assignment.files.length}`),
            false, assignment => ({ assignment })),
    ]
}

function auditIncomplete(result: SyncAuditResult): boolean {
    return !!(result.ankiProfile && 'problem' in result.ankiProfile) ||
        !result.ankiInventoryComplete || !result.vaultInventoryComplete || result.ankiErrors.length > 0
}

function resultNotes(result: SyncAuditResult, t: UiText): string[] {
    const notes: string[] = []
    const profile = result.ankiProfile
    if (profile && 'problem' in profile) {
        const target = profile.expected
            ? t(`Expected Anki profile “${profile.expected}” could not be confirmed.`, `Не удалось подтвердить ожидаемый профиль Anki «${profile.expected}».`)
            : t('The active Anki profile could not be confirmed.', 'Не удалось подтвердить активный профиль Anki.')
        notes.push(`${target} ${auditDiagnostic(profile.problem, t)}`)
    } else if (profile && 'active' in profile && profile.expected && profile.active !== profile.expected) {
        notes.push(t(`Expected Anki profile “${profile.expected}”. This read-only report checked “${profile.active}”.`,
            `Ожидаемый профиль Anki — «${profile.expected}». В режиме чтения проверен профиль «${profile.active}».`))
    }
    if (result.ankiDeckExists === false) notes.push(t(`Anki returned no deck named “${result.deck}”.`, `В Anki не найдена колода «${result.deck}».`))
    if (!result.ankiInventoryComplete) {
        notes.push(t('Deck membership could not be confirmed. Missing-note lists are hidden until the Anki inventory can be read.',
            'Не удалось подтвердить состав колоды. Списки отсутствующих записей появятся, когда плагин сможет прочитать данные Anki.'))
    } else if (result.ankiErrors.length || !result.vaultInventoryComplete) {
        notes.push(t('The audit is incomplete. Results cover the data that could be read.',
            'Проверка неполная. Отчёт содержит данные, которые удалось прочитать.'))
    }
    if (result.ankiInventoryComplete && !result.vaultInventoryComplete) {
        notes.push(t('Some Obsidian files could not be checked. Anki notes with unverified sources are listed separately.',
            'Часть файлов Obsidian не удалось проверить. Записи Anki с неподтверждёнными источниками вынесены в отдельный список.'))
    }
    return notes
}

function markdownText(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()<>#+!|]/g, '\\$&')
}

export function formatSyncAuditMarkdown(result: SyncAuditResult, exportIncomplete = false, exportedScope?: string, t: UiText = englishUi): string {
    const startedAt = new Date(result.startedAt).toLocaleString(t('en-GB', 'ru-RU'))
    const lines = [
        reportFrontmatter,
        `# ${auditTitle(t)}`,
        '',
        t('Vault — ', 'Хранилище — ') + markdownText(result.vaultName),
        markdownText(auditModeDescription(t, exportedScope)),
        ...(result.folderProfile ? [markdownText(folderProfileDescription(result.folderProfile, t))] : []),
        markdownText(ankiProfileDescription(result, t)),
        t(`Anki check started — ${startedAt}`, `Начало проверки Anki — ${startedAt}`),
        '',
        markdownText(scopeDescription(result.deck, t)),
        '',
        ...(exportIncomplete ? ['> ' + exportIncompleteMessage(t)] : []),
        ...resultNotes(result, t).map(note => '> ' + markdownText(note)),
        '',
        ...summaryLines(result, t).map(line => '- ' + markdownText(line)),
    ]
    for (const item of resultSections(result, t)) {
        lines.push('', `## ${item.title} · ${item.count}`, '')
        for (let index = 0; index < item.count; index++) {
            lines.push('- ' + markdownText(item.describe(index, Infinity)))
            const action = item.action?.(index)
            if (action && 'assignment' in action) {
                for (const file of action.assignment.files) lines.push('  - ' + markdownText(deckFileText(file, t)))
            }
        }
    }
    return lines.join('\n') + '\n'
}

function localReportStamp(date: Date): string {
    const pad = (part: number) => String(part).padStart(2, '0')
    const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-')
    const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join('-')
    return `${day} ${time}`
}

async function saveReport(app: App, result: SyncAuditResult, exportIncomplete: boolean, exportedScope: string | undefined, t: UiText): Promise<TFile> {
    const stem = reportPrefix + localReportStamp(new Date())
    const markdown = formatSyncAuditMarkdown(result, exportIncomplete, exportedScope, t)
    for (let suffix = 1; ; suffix++) {
        const path = `${stem}${suffix === 1 ? '' : ` (${suffix})`}.md`
        if (app.vault.getAbstractFileByPath(path)) continue
        try {
            return await app.vault.create(path, markdown)
        } catch (error) {
            if (!app.vault.getAbstractFileByPath(path)) throw error
        }
    }
}

const phaseLabels = {
    vault: ['Reading Markdown in Obsidian', 'Чтение Markdown в Obsidian'],
    ids: ['Reading Anki inventory', 'Чтение списка записей Anki'],
    details: ['Reading Anki fields and tags', 'Чтение полей и тегов Anki'],
    decks: ['Checking card decks', 'Проверка колод карточек'],
} as const

interface AuditOpening {
    repair?: ExportRepairTarget
    snapshot?: SyncAuditResult
    chooseMode?: boolean
    exportIncomplete?: boolean
    exportedScope?: string
}

interface AuditPlan {
    deck: string
    folderScope: NonNullable<SyncAuditResult['folderProfile']>
    scopeSignature: string
    expectedProfile?: string
    profileLocked: boolean
    bidirectional: boolean
}

interface AuditRun {
    deck?: string
    scopeSignature?: string
    pendingExport?: AuditPlan & { runProfile?: string }
    afterExport?: AuditPlan & { profile: string }
}

class SyncAuditModal extends ReviewModal {
    private readonly plugin: MyPlugin
    private readonly auditScope: VaultSyncAuditScope
    private readonly t: UiText
    private snapshot?: SyncAuditResult
    private renderedSnapshot?: SyncAuditResult
    private readonly chooseMode: boolean
    private repair?: ExportRepairTarget
    private choice?: AuditPlan
    private exportIncomplete: boolean
    private exportedScope?: string
    private readonly abort = new AbortController()
    private closed = false
    private running = false

    constructor(plugin: MyPlugin, auditScope: VaultSyncAuditScope, opening: AuditOpening) {
        super(plugin.app)
        this.plugin = plugin
        this.auditScope = auditScope
        this.t = uiFor(plugin.settings)
        this.snapshot = opening.snapshot
        this.repair = opening.repair
        this.chooseMode = opening.chooseMode === true
        this.exportIncomplete = opening.exportIncomplete === true
        this.exportedScope = opening.exportedScope
    }

    onOpen(): void {
        this.titleEl.setText(auditTitle(this.t))
        this.modalEl.classList.add('rudonium-modal-50rem')
        installModalLayout(this, this.t)
        const snapshot = this.snapshot
        this.snapshot = undefined
        if (snapshot) this.showResult(snapshot)
        else if (this.chooseMode) this.showModeChoice()
        else void this.run()
    }

    protected releaseReview(): void {
        this.closed = true
        this.renderedSnapshot = undefined
        this.choice = undefined
        this.abort.abort()
        if (openAudits.get(this.plugin) === this) openAudits.delete(this.plugin)
        this.contentEl.empty()
    }

    private readDeck(): string {
        const deck = typeof this.auditScope === 'object' ? this.auditScope.deck : this.plugin.settings.Defaults.Deck
        if (typeof deck !== 'string' || !deck.trim()) throw new Error(this.t('Choose a deck in Defaults → Deck and retry.',
            'Укажите колоду по умолчанию в настройках и повторите проверку.'))
        return deck
    }

    private readPlan(): AuditPlan {
        const deck = this.readDeck()
        const folderScope = resolveSyncScope(this.plugin)
        return {
            deck,
            folderScope: { label: folderScope.label, files: folderScope.paths.size, named: !!folderScope.profileId },
            scopeSignature: folderScope.signature,
            expectedProfile: expectedAnkiProfile(this.plugin),
            profileLocked: isAnkiProfileLockEnabled(this.plugin),
            bidirectional: this.plugin.settings.BIDIRECTIONAL_SYNC === true,
        }
    }

    private showAlert(text: string): void {
        const alert = this.contentEl.createEl('p', { text, attr: { role: 'alert' } })
        alert.classList.add('rudonium-text-error')
    }

    private addProfileSettingsButton(container: HTMLElement): void {
        container.createEl('button', { text: this.t('Open Profile Settings', 'Открыть настройки профиля') }).onclick = () => {
            this.close()
            openAnkiProfileSettings(this.plugin)
        }
    }

    private showModeChoice(reason?: string): void {
        if (this.closed) return
        const t = this.t
        this.choice = undefined
        this.titleEl.setText(auditTitle(t))
        this.contentEl.empty()
        if (reason) this.showAlert(reason)
        let plan: AuditPlan
        try {
            plan = this.readPlan()
        } catch (error) {
            this.showAlert(error instanceof Error ? error.message : String(error))
            const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
            buttons.createEl('button', { text: t('Retry', 'Повторить'), cls: 'mod-cta' }).onclick = () => this.showModeChoice()
            return
        }
        this.choice = plan
        this.contentEl.createEl('h3', { text: t('Audit Scope', 'Что будет проверено') })
        this.contentEl.createEl('p', { text: scopeDescription(plan.deck, t) }).classList.add('rudonium-wrap-anywhere')
        this.contentEl.createEl('h3', { text: t('Export Scope', 'Что будет экспортировано') })
        this.contentEl.createEl('p', { text: folderProfileDescription(plan.folderScope, t) }).classList.add('rudonium-wrap-anywhere')
        this.contentEl.createEl('p', {
            text: t('If you choose export, it runs for this folder scope before the audit and may update other decks targeted by those files. Explicit DELETE commands can remove notes in Anki.',
                'Если выбрать экспорт, он обработает файлы выбранного профиля до начала проверки. Эти файлы могут обновить другие колоды. Явные команды DELETE могут удалить записи в Anki.'),
        })
        const expected = plan.expectedProfile ?? t('Unconfigured', 'Не выбран')
        const profileHint = plan.profileLocked
            ? t(`Expected Anki profile — ${expected}`, `Ожидаемый профиль Anki — ${expected}`)
            : t('Anki profile — currently open in Anki', 'Профиль Anki — открытый в Anki')
        this.contentEl.createEl('p', { text: profileHint }).classList.add('rudonium-wrap-anywhere')
        const missingBinding = plan.profileLocked && !plan.expectedProfile
        if (plan.bidirectional) this.contentEl.createEl('p', { text: t('Export from this screen is unavailable while Bidirectional Sync is enabled.',
            'При включённой двусторонней синхронизации в этом окне доступна проверка без записи.') })
        else if (missingBinding) this.contentEl.createEl('p', { text: t('Open Profile Settings to enable export.',
            'Выберите профиль Anki, чтобы использовать экспорт.') })
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        buttons.classList.add('rudonium-wrap-controls')
        const read = buttons.createEl('button', { text: t('Check Deck Without Writing', 'Проверить без записи'), cls: 'mod-cta' })
        read.onclick = () => {
            if (this.choice !== plan) return
            this.confirmPlan(plan, false)
        }
        const write = buttons.createEl('button', { text: t('Export Folder Profile, Then Audit Deck', 'Экспортировать и проверить колоду') })
        write.disabled = plan.bidirectional || missingBinding
        write.onclick = () => {
            if (this.choice !== plan) return
            this.confirmPlan(plan, true)
        }
        if (missingBinding) this.addProfileSettingsButton(buttons)
        read.focus()
    }

    private confirmPlan(plan: AuditPlan, write: boolean, runProfile?: string): void {
        if (this.closed || this.running) return
        let current: AuditPlan
        try {
            current = this.readPlan()
        } catch (error) {
            this.showModeChoice(error instanceof Error ? error.message : String(error))
            return
        }
        if (current.deck !== plan.deck || current.scopeSignature !== plan.scopeSignature ||
            current.folderScope.files !== plan.folderScope.files || current.expectedProfile !== plan.expectedProfile ||
            current.profileLocked !== plan.profileLocked || current.bidirectional !== plan.bidirectional ||
            (write && ((current.profileLocked && !current.expectedProfile) || current.bidirectional))) {
            this.showModeChoice(this.t('The audit deck, export scope or sync settings changed. Review the current scopes and choose again.',
                'Колода, область экспорта или настройки синхронизации изменились. Сверьте их и выберите действие заново.'))
            return
        }
        this.choice = undefined
        this.exportIncomplete = false
        void this.run({ deck: current.deck, scopeSignature: current.scopeSignature,
            pendingExport: write ? { ...current, runProfile } : undefined })
    }

    private showExportWarning(container: HTMLElement): void {
        container.createEl('p', { text: exportIncompleteMessage(this.t), cls: 'mod-warning' })
    }

    private showProfileBlocked(plan: AuditPlan, problem?: AnkiProfileError, runProfile?: string): void {
        const t = this.t
        this.contentEl.empty()
        const heading = t('The export stopped because the Anki profile could not be verified.',
            'Экспорт остановлен, потому что профиль Anki не удалось подтвердить.')
        const advice = problem ? t(problem.message, profileProblemText(problem, t)) : heading
        this.showAlert(advice)
        if (problem?.reason === 'mismatch' && problem.expected && problem.actual) {
            this.contentEl.createEl('p', {
                text: t(`Expected — ${problem.expected} · Active — ${problem.actual}`,
                    `Ожидаемый профиль — ${problem.expected} · Активный профиль — ${problem.actual}`),
            }).classList.add('rudonium-wrap-anywhere')
        }
        this.showExportWarning(this.contentEl)
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        buttons.classList.add('rudonium-wrap-controls')
        buttons.createEl('button', { text: t('Check Again and Export', 'Проверить профиль и экспортировать') }).onclick = () =>
            this.confirmPlan(plan, true, runProfile)
        buttons.createEl('button', { text: t('Run Read-Only Audit', 'Проверить без записи'), cls: 'mod-cta' }).onclick = () => { void this.run({ deck: plan.deck }) }
        this.addProfileSettingsButton(buttons)
    }

    private async run(options: AuditRun = {}): Promise<void> {
        if (this.closed || this.running) return
        const t = this.t
        this.running = true
        this.contentEl.empty()
        let { deck, pendingExport, afterExport } = options
        this.exportedScope = afterExport && folderProfileLabel(afterExport.folderScope, t)
        const scopeHint = this.contentEl.createEl('p')
        const status = this.contentEl.createEl('p', { text: t('Starting audit…', 'Начинаю проверку…') })
        status.setAttribute('role', 'status')
        const progress = this.contentEl.createEl('progress')
        progress.setAttribute('aria-label', t('Audit progress', 'Ход проверки'))

        try {
            deck ??= this.readDeck()
            this.titleEl.setText(`${auditTitle(t)} · ${deck}`)
            scopeHint.setText(scopeDescription(deck, t))
            const scopeSignature = options.scopeSignature ?? afterExport?.scopeSignature ?? this.repair?.scopeSignature ?? syncScopeSignature(this.plugin.settings)
            if (pendingExport) {
                const plan = pendingExport
                pendingExport = undefined
                this.exportIncomplete = true
                const hint = this.contentEl.createEl('p', { text: folderProfileDescription(plan.folderScope, t) +
                    t('. Export is running before this deck is checked. Closing stops it after the current batch.',
                        '. Идёт экспорт перед проверкой колоды. Если закрыть окно, он остановится после текущей группы файлов.') })
                let profile = plan.runProfile ?? plan.expectedProfile
                if (profile === undefined) {
                    try {
                        profile = await requireExpectedAnkiProfile(this.plugin, undefined, this.abort.signal)
                    } catch (error) {
                        if (this.closed) return
                        if (!(error instanceof AnkiProfileError)) throw error
                        this.showProfileBlocked(plan, error)
                        return
                    }
                }
                if (this.closed) return
                let profileProblem: AnkiProfileError | undefined
                const outcome = await scanVaultFast(this.plugin, true, false, undefined, undefined, {
                    signal: this.abort.signal,
                    scopeSignature,
                    onProfileBlocked: error => { profileProblem = error },
                    onProgress: update => {
                        if (this.closed) return
                        status.setText(t(`Export to Anki · ${update.stage}`, `Экспорт в Anki · ${update.stage}`))
                        if (update.total > 0) {
                            progress.max = update.total
                            progress.value = Math.min(update.confirmed, update.total)
                        }
                    },
                }, undefined, profile)
                if (this.closed) return
                if (outcome === 'busy') {
                    pendingExport = { ...plan, runProfile: profile }
                    this.exportIncomplete = false
                    throw new Error(t('An export or cache reset is already running. Retry when it finishes.',
                        'Уже выполняется экспорт или сброс кэша. Повторите попытку после завершения.'))
                }
                if (outcome === 'blocked-profile') {
                    this.showProfileBlocked(plan, profileProblem, profile)
                    return
                }
                afterExport = { ...plan, profile }
                this.exportedScope = folderProfileLabel(plan.folderScope, t)
                this.exportIncomplete = outcome !== 'completed'
                hint.remove()
                progress.removeAttribute('value')
                status.setText(t('Starting audit…', 'Начинаю проверку…'))
            }
            const result = await auditPluginSync(this.plugin, update => {
                if (this.closed) return
                const hasTotal = update.total > 0
                const phase = phaseLabels[update.phase]
                status.setText(t(phase[0], phase[1]) +
                    (hasTotal ? t(` · ${update.completed} of ${update.total}`, ` · ${update.completed} из ${update.total}`) : '…'))
                if (hasTotal) {
                    progress.max = update.total
                    progress.value = Math.min(update.completed, update.total)
                } else {
                    progress.removeAttribute('value')
                }
            }, this.abort.signal, { deck }, scopeSignature, this.repair?.profile ? { profile: this.repair.profile } : afterExport && { profile: afterExport.profile })
            resultScopeSignatures.set(result, scopeSignature)
            if (this.closed) return
            const target = this.repair
            this.repair = undefined
            if (target) {
                const group = result.obsidianOnly.find(group => group.id === target.id)
                if (this.canRepair(result) && group?.occurrences.length === 1 && group.occurrences[0].path === target.path) {
                    this.reviewRepairs({ ...result, obsidianOnly: [group] }, target.id)
                    return
                }
            }
            this.showResult(result)
            if (target) this.showAlert(t(`Could not confirm missing ID ${target.id} at ${target.path}. Check the current results.`,
                `Не удалось подтвердить отсутствие ID ${target.id} для файла ${target.path}. Проверьте текущие результаты.`))
        } catch (error) {
            if (this.closed) return
            this.contentEl.empty()
            console.warn('[Export to Anki] Ошибка аудита', error)
            this.showAlert(t('The audit stopped. ', 'Проверка остановлена. ') + auditDiagnostic(error instanceof Error ? error.message : String(error), t))
            if (this.exportIncomplete) this.showExportWarning(this.contentEl)
            const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
            buttons.classList.add('rudonium-wrap-controls')
            buttons.createEl('button', { text: t('Retry', 'Повторить'), cls: 'mod-cta' }).onclick = () => {
                if (pendingExport) this.confirmPlan(pendingExport, true, pendingExport.runProfile)
                else void this.run({ deck, afterExport })
            }
            if (afterExport || this.exportIncomplete) {
                buttons.createEl('button', { text: t('Run Read-Only Audit', 'Проверить без записи') }).onclick = () => { void this.run({ deck }) }
            }
        } finally {
            this.running = false
        }
    }

    private reviewDifferences(result: SyncAuditResult, initialId?: number): void {
        this.close()
        const scope = { deck: result.deck }
        openSyncDifferenceReview(this.app, result.differences, () => openSyncAudit(this.plugin, scope), initialId,
            () => showAuditModal(this.plugin, scope, { snapshot: result, exportIncomplete: this.exportIncomplete, exportedScope: this.exportedScope }),
            result.ankiProfile, this.t)
    }

    private reviewDuplicate(id: number): void {
        this.close()
        openDuplicateIdReview(this.plugin, id)
    }

    private canRepair(result: SyncAuditResult): boolean {
        const profile = result.ankiProfile
        return result.obsidianOnly.length > 0 && result.ankiInventoryComplete && result.vaultInventoryComplete &&
            !!profile && 'active' in profile && (!profile.expected || profile.active === profile.expected)
    }

    private reviewRepairs(result: SyncAuditResult, id?: number): void {
        if (!this.canRepair(result)) return
        this.close()
        openAuditRepair(this.plugin, result, () => openSyncAudit(this.plugin, { deck: result.deck }), id)
    }

    private sourceButton(container: HTMLElement, source: SourceLink, repair = false): void {
        const t = this.t
        const button = container.createEl('button', {
            text: repair
                ? t('Show Note in Obsidian', 'Показать запись в Obsidian') : t('Open in Obsidian', 'Открыть в Obsidian'),
            title: sourceLocation(source, t),
        })
        button.onclick = async () => {
            button.disabled = true
            try {
                await openAuditSource(this.app, source, { modal: this, isClosed: () => this.closed }, t)
            } catch (error) {
                new Notice(error instanceof Error ? error.message : String(error))
            } finally {
                button.disabled = false
            }
        }
    }

    private ankiButton(container: HTMLElement, id: number, auditProfile: SyncAuditAnkiProfile | undefined): void {
        const t = this.t
        const label = t('Open in Anki', 'Открыть в Anki')
        const button = container.createEl('button', {
            text: label,
            title: t(`Open Anki note ${id}`, `Открыть запись Anki ${id}`),
        })
        button.onclick = async () => {
            button.disabled = true
            button.setText(t('Opening Anki…', 'Открываю Anki…'))
            try {
                await openAuditAnkiNote(id, auditProfile, t)
            } catch (error) {
                new Notice(error instanceof Error ? error.message : String(error))
            } finally {
                button.setText(label)
                button.disabled = false
            }
        }
    }

    private addIssueAction(container: HTMLElement, result: SyncAuditResult, action: IssueAction): void {
        if ('source' in action) {
            this.sourceButton(container, action.source, action.repairId !== undefined)
            if (action.ankiId !== undefined) this.ankiButton(container, action.ankiId, result.ankiProfile)
            if (action.auditDeck !== undefined) this.checkDeckButton(container, action.auditDeck)
            if (action.repairId !== undefined && this.canRepair(result)) {
                container.createEl('button', { text: this.t('Review Repair', 'Исправить запись') }).onclick = () =>
                    this.reviewRepairs(result, action.repairId)
            }
        } else if ('ankiId' in action) {
            this.ankiButton(container, action.ankiId, result.ankiProfile)
            const profile = result.ankiProfile
            if (action.restoreSource && result.vaultInventoryComplete && result.ankiInventoryComplete && profile && 'active' in profile) {
                const scope = { deck: result.deck }
                container.createEl('button', {
                    text: this.t('Restore Note in Obsidian', 'Восстановить запись в Obsidian'),
                    title: this.t(`Preview Markdown for Anki note ${action.ankiId}`, `Предпросмотр Markdown для записи Anki ${action.ankiId}`),
                }).onclick = () => openAnkiSourceRestore(this.plugin, action.ankiId, profile.active, result.deck, () => this.close(),
                    () => openSyncAudit(this.plugin, scope))
            }
        } else {
            const t = this.t
            const compare = 'differenceId' in action
            const noteId = compare ? action.differenceId : action.duplicateId
            const text = compare ? t('Compare Fields', 'Сравнить поля') : t('Review Duplicate', 'Посмотреть повторение')
            const button = container.createEl('button', {
                text,
                title: t(`Review note ${noteId}`, `Посмотреть запись ${noteId}`),
            })
            button.onclick = () => {
                if ('differenceId' in action) this.reviewDifferences(result, action.differenceId)
                else this.reviewDuplicate(action.duplicateId)
            }
        }
    }

    private checkDeckButton(container: HTMLElement, deck: string): void {
        container.createEl('button', { text: this.t('Check This Deck', 'Проверить эту колоду'), title: deck }).onclick = () => {
            this.close()
            openSyncAudit(this.plugin, { deck })
        }
    }

    private addRowAction(row: HTMLElement, result: SyncAuditResult, action: RowAction): void {
        if ('assignment' in action) {
            const t = this.t
            const { deck, files } = action.assignment
            this.checkDeckButton(row, deck)
            const details = row.createEl('details')
            details.createEl('summary', { text: t('Source Files', 'Исходные файлы') })
            const list = details.createEl('ul')
            let shown = 0
            const more = details.createEl('button')
            const appendFiles = (count: number) => {
                const end = Math.min(files.length, shown + count)
                for (; shown < end; shown++) {
                    const file = files[shown]
                    const item = list.createEl('li', { text: deckFileText(file, t) })
                    this.sourceButton(item, file)
                }
                more.hidden = shown === files.length
                if (!more.hidden) {
                    const count = Math.min(moreRows, files.length - shown)
                    more.setText(t(`Show ${count} more files`, `Показать ещё файлы (+${count})`))
                }
            }
            more.onclick = () => appendFiles(moreRows)
            details.ontoggle = () => {
                if (details.open && !shown) appendFiles(previewRows)
            }
        } else {
            const buttons = row.createDiv()
            buttons.classList.add('rudonium-sync-audit-buttons')
            this.addIssueAction(buttons, result, action)
        }
    }

    private showSection(result: SyncAuditResult, item: AuditSection, open: boolean): void {
        const t = this.t
        const details = this.contentEl.createEl('details', { cls: item.attention ? 'sync-audit-issue' : undefined })
        const heading = details.createEl('summary', { text: `${item.title} · ${item.count}` })
        details.open = open
        details.classList.add('rudonium-sync-audit-details')
        if (item.attention) {
            heading.classList.add('rudonium-sync-audit-heading')
        }
        const renderRows = () => {
            if (!details.open) return
            details.ontoggle = null
            if (item.review === 'duplicates') {
                details.createEl('button', { text: t('Review Duplicates', 'Посмотреть повторения') }).onclick = () => this.reviewDuplicate(result.duplicateIds[0].id)
            } else if (item.review === 'differences') {
                details.createEl('button', { text: t('Review Differences', 'Посмотреть различия') }).onclick = () => this.reviewDifferences(result)
            }
            const preview = details.createEl('ul')
            let shown = 0
            const appendRows = (count: number) => {
                const end = Math.min(shown + count, item.count)
                for (; shown < end; shown++) {
                    const row = preview.createEl('li', { cls: item.attention ? 'sync-audit-issue-row' : undefined })
                    row.classList.add('rudonium-sync-audit-row')
                    const description = row.createSpan({ text: item.describe(shown, previewDetails) })
                    description.classList.add('rudonium-wrap-anywhere')
                    if (item.attention) description.classList.add('rudonium-text-error')
                    const action = item.action?.(shown)
                    if (action) this.addRowAction(row, result, action)
                }
            }
            appendRows(previewRows)
            if (item.count > shown) {
                const status = details.createEl('p', { attr: { role: 'status' } })
                const more = details.createEl('button')
                const showCount = () => {
                    status.setText(t(`Showing ${shown} of ${item.count}.`, `Показано ${shown} из ${item.count}.`))
                    more.hidden = shown === item.count
                    if (!more.hidden) {
                        const count = Math.min(moreRows, item.count - shown)
                        more.setText(t(`Show ${count} more`, `Показать ещё ${count}`))
                    }
                }
                more.onclick = () => { appendRows(moreRows); showCount() }
                showCount()
            }
        }
        if (open) renderRows()
        else details.ontoggle = renderRows
    }

    private showAttachmentAudit(result: SyncAuditResult): void {
        if (!hasAuditAttachmentSources(result)) return
        const t = this.t
        const panel = this.contentEl.createEl('details')
        panel.createEl('summary', { text: t('Attachments', 'Вложения') })
        panel.createEl('p', { text: t('Check attachment references from the Markdown files in this report. Anki returns only filenames.',
            'Проверьте ссылки на вложения из файлов Markdown в этом отчёте. В Anki запрашиваются только имена файлов.') })
        const check = panel.createEl('button', { text: t('Check Attachment Names', 'Проверить имена вложений') })
        const feedback = panel.createEl('p', { attr: { role: 'status' } })
        const rows = panel.createDiv()
        renderAttachmentContentChecks(panel, this.app, result, t, this.abort.signal)
        const active = () => !this.closed && panel.parentElement === this.contentEl
        check.onclick = async () => {
            check.disabled = true
            rows.empty()
            feedback.setText(t('Checking attachment names…', 'Проверяю имена вложений…'))
            try {
                const report = await auditAttachmentPresence(this.app, result, this.abort.signal)
                if (!active()) return
                const count = report.issues.length
                feedback.setText(t(`Attachment findings: ${count}. Anki · `, `Замечаний по вложениям: ${count}. Anki · `) + checkedCount(report.namesChecked, 'name', t))
                if (report.remoteProblem) {
                    rows.createEl('p', { text: t('Anki attachment names could not be verified. Check the profile and AnkiConnect, then try again.',
                        'Не удалось проверить имена вложений в Anki. Проверьте профиль и AnkiConnect, затем повторите.') })
                        .classList.add('rudonium-text-error')
                    console.warn('[Rudonium Anki Toolkit] Не удалось проверить вложения Anki', report.remoteProblem)
                }
                if (!result.vaultInventoryComplete || !result.ankiInventoryComplete) {
                    rows.createEl('p', { text: t('The deck audit was incomplete. Only available sources were checked.',
                        'Аудит колоды неполный. Проверены только доступные источники.') })
                }
                if (!count) return
                const list = rows.createEl('ul')
                const more = rows.createEl('button', { text: t('Show More', 'Показать ещё') })
                let shown = 0
                const render = () => {
                    const end = Math.min(shown + moreRows, count)
                    for (; shown < end; shown++) {
                        const issue = report.issues[shown]
                        const item = list.createEl('li')
                        item.createEl('p', { text: `${attachmentIssueTitle(issue, t)} · ${issue.name}` })
                        const locations = issue.locations ?? issue.sources
                        if (locations.length) item.createEl('p', { text: describeList(locations, previewDetails, String, t) })
                        const [path] = issue.sources
                        if (path) this.sourceButton(item, { path })
                        if (issue.kind === 'same-local-name' && issue.locations?.length) {
                            const locations = issue.locations
                            const verify = item.createEl('button', { text: t('Compare Contents', 'Сравнить содержимое') })
                            const verification = item.createEl('p', { attr: { role: 'status' } })
                            verify.onclick = async () => {
                                verify.disabled = true
                                verification.setText(t('Reading local copies…', 'Читаю локальные копии…'))
                                try {
                                    const identical = await verifyLocalAttachmentContents(this.app, locations, this.abort.signal)
                                    if (active()) verification.setText(identical
                                        ? t('Local copies are identical.', 'Локальные копии совпадают.')
                                        : t('Local copies contain different data.', 'Содержимое локальных копий различается.'))
                                } catch (error) {
                                    if (active()) {
                                        console.warn('[Rudonium Anki Toolkit] Не удалось сравнить локальные вложения', error)
                                        verification.setText(t('Comparison unavailable. Check whether the files changed or exceed 32 MiB in total.',
                                            'Сравнение недоступно. Проверьте, изменились ли файлы и не превышает ли их общий размер 32 МиБ.'))
                                    }
                                } finally { verify.disabled = false }
                            }
                        }
                    }
                    more.hidden = shown === count
                }
                more.onclick = render
                render()
            } catch (error) {
                if (active()) {
                    console.warn('[Rudonium Anki Toolkit] Ошибка проверки вложений', error)
                    feedback.setText(t('Attachment verification could not finish.', 'Не удалось завершить проверку вложений.'))
                }
            } finally { check.disabled = false }
        }
    }

    private addScopedPreview(container: HTMLElement, result: SyncAuditResult): void {
        const profile = result.ankiProfile
        const scopeSignature = resultScopeSignatures.get(result)
        if (this.plugin.settings.BIDIRECTIONAL_SYNC || result.ankiDeckKind !== 'ordinary' || auditIncomplete(result) ||
            !scopeSignature || !profile || !('active' in profile) || profile.expected && profile.active !== profile.expected) return
        const excluded = new Set([...result.duplicateIds, ...result.outsideObsidianScope, ...result.outsideAnkiDeck,
            ...result.filteredCards].map(item => item.id))
        const candidates = result.differences.filter(item => item.complete && !item.model && !item.decks.length &&
            !excluded.has(item.id) && !!(item.fields.length || item.missingTags.length || item.extraTags.length))
        if (!candidates.length) return
        const t = this.t
        container.createEl('button', { text: t('Preview Field Changes', 'Просмотреть изменения полей') }).onclick = () => {
            if (syncScopeSignature(this.plugin.settings) !== scopeSignature) {
                new Notice(t('The folder profile changed. Recheck the deck before preparing changes.',
                    'Профиль папок изменился. Проверьте колоду заново перед предпросмотром изменений.'))
                return
            }
            this.close()
            void previewVaultExport(this.plugin, { deck: result.deck, ankiProfile: profile.active, scopeSignature,
                paths: new Set(candidates.map(item => item.path)), ids: new Set(candidates.map(item => item.id)) })
        }
    }

    private showCardStatuses(result: SyncAuditResult): void {
        const t = this.t
        const details = this.contentEl.createEl('details', { cls: 'rupos-audit-card-statuses' })
        details.createEl('summary', { text: t('Card Statuses', 'Состояния карточек') })
        const active = () => !this.closed && !this.running && this.renderedSnapshot === result
        details.ontoggle = () => {
            if (!details.open || !active()) return
            details.ontoggle = null
            const rows = auditCardRows(result)
            const controls = details.createDiv({ cls: 'modal-button-container' })
            controls.classList.add('rudonium-wrap-controls')
            const search = controls.createEl('input', { attr: { type: 'search',
                'aria-label': t('Search by card, file, or ID', 'Поиск по карточке, файлу или ID'),
                placeholder: t('Card, file, or ID', 'Карточка, файл или ID') } })
            const filter = controls.createEl('select', { attr: { 'aria-label': t('Card status', 'Состояние карточки') } })
            filter.createEl('option', { text: t('All statuses', 'Все состояния'), value: '' })
            for (const [value, labels] of Object.entries(cardStatuses)) filter.createEl('option', { text: t(...labels), value })
            const counter = details.createEl('p', { attr: { role: 'status' } })
            const list = details.createEl('ul')
            const pageButtons = details.createDiv({ cls: 'modal-button-container' })
            pageButtons.classList.add('rudonium-wrap-controls')
            const previous = pageButtons.createEl('button', { text: t('Previous Page', 'Предыдущая страница') })
            const next = pageButtons.createEl('button', { text: t('Next Page', 'Следующая страница') })
            const check = pageButtons.createEl('button', { text: t('Check New Cards on This Page', 'Проверить новые карточки на странице') })
            check.title = t('Read-only check of the current deck and note fields in Anki. Attachment verification is separate.',
                'Проверка колоды и полей записи в Anki без записи. Проверка вложений выполняется отдельно.')
            const feedback = details.createEl('p', { attr: { role: 'status' } })
            let page = 0
            let checking = false
            let current: readonly AuditCardRow[] = []
            const timerWindow = search.ownerDocument.defaultView ?? window
            let timer: number | undefined
            const differenceIds = new Set(result.differences.map(item => item.id))
            const duplicateIds = new Set(result.duplicateIds.map(item => item.id))
            const render = () => {
                if (!active()) return
                const matched = filterAuditCards(rows, filter.value as AuditCardStatus | '', search.value)
                const last = Math.max(0, Math.ceil(matched.length / moreRows) - 1)
                page = Math.min(page, last)
                const start = page * moreRows
                current = matched.slice(start, start + moreRows)
                counter.setText(matched.length
                    ? t(`Showing ${start + 1}–${start + current.length} of ${matched.length}`,
                        `Показано ${start + 1}–${start + current.length} из ${matched.length}`)
                    : t('No cards match the search.', 'Таких карточек нет.'))
                previous.disabled = page === 0
                next.disabled = page >= last
                check.disabled = checking || !current.some(row => row.status === 'new' && row.candidate)
                list.empty()
                for (const row of current) {
                    const item = list.createEl('li')
                    const address = row.path ? sourceLocation({ path: row.path, line: row.line }, t) : undefined
                    item.createEl('p', { text: [t(...cardStatuses[row.status]), row.caption, address,
                        row.id === undefined ? undefined : `Anki ID ${row.id}`].filter(Boolean).join(' · ') })
                    if (row.message) item.createEl('p', { text: auditDiagnostic(row.message, t) })
                    const { id, path } = row
                    if (id !== undefined && row.status === 'missing-anki' && path) {
                        this.addIssueAction(item, result, { source: { ...row, path }, repairId: id })
                    } else if (id !== undefined && row.status === 'missing-source') {
                        this.addIssueAction(item, result, { ankiId: id, restoreSource: true })
                    } else {
                        if (path) this.sourceButton(item, { ...row, path })
                        if (id !== undefined) {
                            this.ankiButton(item, id, result.ankiProfile)
                            if (duplicateIds.has(id)) this.addIssueAction(item, result, { duplicateId: id })
                            else if (differenceIds.has(id)) this.addIssueAction(item, result, { differenceId: id })
                        }
                    }
                }
            }
            const reset = () => { page = 0; feedback.setText(''); render() }
            search.oninput = () => { timerWindow.clearTimeout(timer); timer = timerWindow.setTimeout(reset, 120) }
            filter.onchange = reset
            previous.onclick = () => { page--; render() }
            next.onclick = () => { page++; render() }
            check.onclick = async () => {
                const profile = result.ankiProfile
                if (checking || !profile || !('active' in profile)) return
                const candidates = current
                const verify = async () => {
                    if (!active() || !auditCandidateSnapshotCurrent(result)) return false
                    const sameProfile = await requireExpectedAnkiProfile(this.plugin, profile.active, this.abort.signal) === profile.active
                    const ordinary = sameProfile && await readAnkiDeckKind(result.deck, (action, params) =>
                        auditRead(action, params ?? {}, this.abort.signal, 12_000)) === 'ordinary'
                    return ordinary && active() && auditCandidateSnapshotCurrent(result)
                }
                checking = true
                check.disabled = true
                feedback.setText(t('Checking in Anki…', 'Проверяю в Anki…'))
                try {
                    const count = await withFastScanReadLock(this.plugin, () => checkAuditNewCards(candidates, notes =>
                        auditRead('canAddNotesWithErrorDetail', { notes }, this.abort.signal, 12_000), verify))
                    if (active()) feedback.setText(count ? checkedCount(count, 'card', t) + ' ' + t('No writes.', 'Данные сохранены без изменений.')
                        : t('Could not confirm readiness. Recheck the current deck and files.', 'Не удалось подтвердить готовность. Перепроверьте колоду и файлы.'))
                } catch (error) {
                    if (active()) {
                        console.warn('[Rudonium Anki Toolkit] Не удалось проверить готовность карточек', error)
                        feedback.setText(t('Readiness check unavailable. Recheck the current deck and profile.',
                            'Проверка готовности недоступна. Перепроверьте колоду и профиль Anki.'))
                    }
                } finally {
                    checking = false
                    render()
                }
            }
            render()
        }
    }

    private showResult(result: SyncAuditResult): void {
        this.renderedSnapshot = result
        this.contentEl.empty()
        const t = this.t
        this.titleEl.setText(`${auditTitle(t)} · ${result.deck}`)
        this.contentEl.createEl('p', { text: auditModeDescription(t, this.exportedScope) })
        this.contentEl.createEl('p', { text: ankiProfileDescription(result, t) })
        if (result.folderProfile) this.contentEl.createEl('p', { text: folderProfileDescription(result.folderProfile, t) })
        const sections = resultSections(result, t).filter(item => item.count > 0)
        const issues = sections.filter(item => item.attention)
        const incomplete = auditIncomplete(result)
        const missingDeck = result.ankiDeckExists === false
        const profile = result.ankiProfile
        const mismatchedProfile = profile && 'active' in profile && profile.expected && profile.active !== profile.expected
        const needsAttention = this.exportIncomplete || missingDeck || mismatchedProfile || issues.length > 0
        const status = this.contentEl.createDiv({ cls: 'sync-audit-status', attr: { role: 'status' } })
        if (t('en', 'ru') === 'ru' && (result.fileErrors.length || result.ankiErrors.length)) {
            console.warn('[Export to Anki] Подробности аудита', { obsidian: result.fileErrors, anki: result.ankiErrors })
        }
        const statusTitle = status.createEl('strong', {
            text: incomplete ? t('Audit incomplete', 'Проверка неполная')
                : needsAttention ? t('Needs attention', 'Есть замечания') : t('No discrepancies found', 'Расхождений нет'),
        })
        if (incomplete || needsAttention) {
            status.addClass('sync-audit-issue')
            status.classList.add('rudonium-sync-audit-status')
            statusTitle.classList.add('rudonium-text-error')
        }
        const issueCount = issues.reduce((total, item) => total + item.count, 0)
        if (issueCount) status.createDiv({ text: t(`${issueCount} ${issueCount === 1 ? 'item' : 'items'} to review`, `Замечаний для проверки — ${issueCount}`) })
        if (this.exportIncomplete) this.showExportWarning(status)
        for (const note of resultNotes(result, t)) status.createDiv({ text: note })
        if (result.counts.unlinkedNotes > 0 && result.ankiDeckKind !== 'filtered') {
            const hint = this.contentEl.createDiv()
            const count = result.counts.unlinkedNotes
            hint.createEl('p', { text: t(`Cards without an ID in this deck: ${count}. Some may already exist in Anki.`,
                `Карточек без ID в этой колоде — ${count}. Некоторые из них могут уже быть в Anki.`) })
            hint.createEl('button', { text: t('Check cards without an ID', 'Проверить карточки без ID') }).onclick = () => {
                const scopeSignature = resultScopeSignatures.get(result)
                if (!scopeSignature || scopeSignature !== syncScopeSignature(this.plugin.settings)) {
                    new Notice(t('The folder profile changed. Recheck this deck.', 'Профиль папок изменился. Проверьте колоду повторно.'))
                    return
                }
                const scope = { deck: result.deck, scopeSignature,
                    profile: profile && 'active' in profile ? profile.active : profile?.expected }
                openLostIdRecovery(this.plugin, scope, changed => {
                    if (changed) openSyncAudit(this.plugin, { deck: result.deck })
                    else showAuditModal(this.plugin, { deck: result.deck }, { snapshot: result,
                        exportIncomplete: this.exportIncomplete, exportedScope: this.exportedScope })
                }, () => this.close())
            }
        }
        const navigation = this.contentEl.createDiv({ cls: 'modal-button-container' })
        navigation.classList.add('rudonium-wrap-controls')
        this.addScopedPreview(navigation, result)
        navigation.createEl('button', { text: t('Recheck', 'Проверить повторно') }).onclick = () => {
            if (this.running) return
            this.exportIncomplete = false
            void this.run({ deck: result.deck })
        }
        navigation.createEl('button', { text: t('Choose Deck', 'Выбрать колоду') }).onclick = () => {
            this.close()
            openSyncAuditDeckPicker(this.plugin, result.deckAssignments.map(assignment => assignment.deck), false)
        }
        navigation.createEl('button', { text: t('Export Journal', 'Журнал экспорта') }).onclick = () => {
            this.close()
            void openExportJournal(this.plugin, result.deck)
        }
        if (this.canRepair(result)) {
            navigation.createEl('button', { text: t('Find Anki Notes by First Field', 'Найти записи в Anki по первому полю') }).onclick = () =>
                this.reviewRepairs(result)
        }
        for (const [index, item] of issues.entries()) this.showSection(result, item, index === 0)
        const other = sections.filter(item => !item.attention)
        if (other.length) {
            this.contentEl.createEl('h3', { text: t('Other Results', 'Другие результаты') })
            for (const item of other) this.showSection(result, item, false)
        }
        this.showCardStatuses(result)
        this.showAttachmentAudit(result)
        const auditDetails = this.contentEl.createEl('details')
        auditDetails.createEl('summary', { text: t('Audit Details', 'Подробности проверки') })
        auditDetails.createEl('p', { text: result.vaultName })
        auditDetails.createEl('p', { text: scopeDescription(result.deck, t) })
        const summary = auditDetails.createEl('ul')
        for (const line of summaryLines(result, t)) summary.createEl('li', { text: line })

        const feedback = this.contentEl.createDiv()
        feedback.setAttribute('role', 'status')
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        const save = buttons.createEl('button', { text: t('Save Markdown Report', 'Сохранить отчёт Markdown'), cls: 'mod-cta' })
        save.onclick = async () => {
            save.disabled = true
            feedback.setText(t('Saving report…', 'Сохраняю отчёт…'))
            try {
                const file = await saveReport(this.app, result, this.exportIncomplete, this.exportedScope, t)
                if (this.closed) {
                    new Notice(t(`Report saved to ${file.path}`, `Отчёт сохранён в ${file.path}`))
                    return
                }
                feedback.setText(t('Report saved. ', 'Отчёт сохранён. '))
                const open = feedback.createEl('a', { text: file.path, attr: { href: '#' } })
                open.onclick = async event => {
                    event.preventDefault()
                    try {
                        await openObsidianFile(this.app, file.path, { modal: this, isClosed: () => this.closed })
                    } catch (error) {
                        console.warn('[Export to Anki] Ошибка открытия отчёта', error)
                        new Notice(t(`Could not open the report. ${String(error)}`, 'Не удалось открыть отчёт. Проверьте, что файл доступен.'))
                    }
                }
            } catch (error) {
                console.warn('[Export to Anki] Ошибка сохранения отчёта', error)
                const message = t(`Could not save the report. ${String(error)}`, 'Не удалось сохранить отчёт. Проверьте доступ к хранилищу.')
                if (this.closed) new Notice(message)
                else feedback.setText(message)
            } finally {
                save.disabled = false
            }
        }
    }
}

function showAuditModal(plugin: MyPlugin, scope: VaultSyncAuditScope, opening: AuditOpening = {}): void {
    const existing = openAudits.get(plugin)
    if (existing) {
        if (existing instanceof ReviewModal && existing.dock) void plugin.app.workspace.revealLeaf(existing.dock.leaf)
        return
    }
    const modal = new SyncAuditModal(plugin, scope, opening)
    openAudits.set(plugin, modal)
    modal.open()
}

export function openSyncAudit(plugin: MyPlugin, scope: VaultSyncAuditScope = 'default-deck'): void {
    showAuditModal(plugin, scope)
}

export async function openAuditForExportIssue(plugin: MyPlugin, deck?: string, repair?: ExportRepairTarget): Promise<void> {
    const request = {}
    auditsFromNotice.set(plugin, request)
    openAudits.get(plugin)?.close()
    await waitForFastScanIdle(plugin)
    if (auditsFromNotice.get(plugin) !== request) return
    auditsFromNotice.delete(plugin)
    if (!repair && plugin.settings.Defaults.Deck?.trim()) showAuditModal(plugin, 'default-deck')
    else if (deck?.trim()) showAuditModal(plugin, { deck }, { repair })
    else openSyncAuditDeckPicker(plugin, [], false, repair)
}

export function startSyncAudit(plugin: MyPlugin, scope: VaultSyncAuditScope = 'default-deck'): void {
    showAuditModal(plugin, scope, { chooseMode: true })
}

export function openSyncAuditDeckPicker(plugin: MyPlugin, obsidianDecks: readonly string[] = [], startNewAudit = true, repair?: ExportRepairTarget): void {
    if (openAudits.has(plugin)) return
    const defaultDeck = plugin.settings.Defaults.Deck
    const localDecks = defaultDeck?.trim() ? [defaultDeck, ...obsidianDecks] : obsidianDecks
    const dismiss = () => { if (openAudits.get(plugin) === modal) openAudits.delete(plugin) }
    const modal = new SyncAuditDeckPicker(plugin.app, deck => {
        if (startNewAudit) startSyncAudit(plugin, { deck })
        else showAuditModal(plugin, { deck }, { repair })
    }, localDecks, dismiss, uiFor(plugin.settings))
    openAudits.set(plugin, modal)
    modal.open()
}
