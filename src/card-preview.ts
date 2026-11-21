/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { activeCardMarkdown, archivedCardRanges } from './archived-card'
import { Notice } from 'obsidian'
import { ankiIdNumberTokens } from './anki-id-marker'
import type { Editor, TFile } from 'obsidian'
import type MyPlugin from '../main'
import { AnkiProfileError, expectedAnkiProfile, profileProblemText, requireExpectedAnkiProfile } from './anki-profile'
import { editorPreviewMetadata } from './card-preview-metadata'
import { buildBasicCardVariants, readCardTemplateVariants } from './card-preview-render'
import type { CardPreviewField, CardPreviewVariant } from './card-preview-render'
import { cursorConfiguration, staleCursorCard } from './cursor-card'
import type { CursorCardTarget } from './cursor-card'
import { previewVaultExport } from './fast-scan'
import { openCardPreview } from './card-preview-ui'
import { describeDeckRoute } from './deck-routes'
import * as syntax from './constants'
import { findIdMarkers } from './duplicate-markers'
import { findLinkedBullets, readLinkedBulletModels } from './linked-bullets'
import type { LinkedBullet, LinkedBulletModel } from './linked-bullets'
import { findMarkdownSyntaxSpans, makeSpanLookup } from './markdown-pipeline'
import { cardAtOffset, containsCardOffset, parsePortableMarkdown, portableCardExportRule, portableCardExportRuleRoute,
    portableDeckRoute } from './portable-parser'
import { describeExportRule } from './export-rules'
import { settingToData } from './setting-to-data'
import { auditRead } from './sync-audit'
import { describeSyncPath, scanProfileFreeSettings } from './sync-profiles'
import { uiFor } from './interface-language'
import type { UiText } from './interface-language'

export interface CardPreviewResult {
    source: string
    target?: CursorCardTarget
    line: number
    unsaved?: boolean
    fields: readonly CardPreviewField[]
    modelName: string
    deck: string
    deckReason: string
    id?: number
    variants: readonly CardPreviewVariant[]
    previewNotice?: string
    cautions?: readonly string[]
}

const latestPreview = new WeakMap<MyPlugin, number>()
const readTimeoutMs = 3500

function errorText(error: unknown, t: UiText): string {
    if (error instanceof AnkiProfileError) {
        const names = error.reason === 'mismatch' && error.expected && error.actual
            ? ` Ожидался «${error.expected}», открыт «${error.actual}».` : ''
        return t(error.message, profileProblemText(error, t) + names)
    }
    return error instanceof Error ? error.message : String(error)
}

export async function buildCardPreview(plugin: MyPlugin, file: TFile, text: string, offset: number,
    unsaved = false, rebuildMetadata = unsaved): Promise<CardPreviewResult> {
    const t = uiFor(plugin.settings)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
        throw new Error(t('The cursor is outside this note. Open the preview again.',
            'Курсор находится за пределами заметки. Откройте предпросмотр ещё раз.'))
    }
    const source = file.path
    const configuration = cursorConfiguration(plugin)
    const settings: MyPlugin['settings'] = JSON.parse(JSON.stringify(plugin.settings))
    const fieldsDictionary: Record<string, string[]> = JSON.parse(JSON.stringify(plugin.fields_dict))
    const { app } = plugin
    if (text.includes('RUDONIUM-ARCHIVE') && archivedCardRanges(text).some(r => r.start <= offset && offset < r.end)) {
        throw new Error(t('This card was deleted from Anki and is archived in Markdown.', 'Эта карточка удалена из Anki и хранится в архиве Markdown.'))
    }
    const markers = findIdMarkers(text, settings.Syntax)
    // ID из текущего файла позволяют распознать связанные блоки. Их наличие в Anki проверяется отдельно.
    const ids = ankiIdNumberTokens(text.includes('RUDONIUM-ARCHIVE') ? activeCardMarkdown(text) : text)
    const bullets = findLinkedBullets(text, false, settings.Syntax)
    const atCursor = bullets.filter(bullet => containsCardOffset(bullet, text, offset))
    if (atCursor.length > 1) throw new Error(t('More than one Anki card matches the cursor. Check the card boundaries.',
        'Курсор находится в области нескольких карточек Anki. Проверьте границы карточек в заметке.'))
    let bullet: LinkedBullet | undefined = atCursor[0]
    if (bullet) {
        const { code, math } = findMarkdownSyntaxSpans(text, syntax.OBS_DISPLAY_CODE_REGEXP,
            syntax.OBS_CODE_REGEXP, syntax.OBS_DISPLAY_MATH_REGEXP, syntax.OBS_INLINE_MATH_REGEXP)
        if (makeSpanLookup(code.concat(math))(bullet.start)) bullet = undefined
    }
    let pinnedProfile = expectedAnkiProfile(plugin)
    let verifiedProfile: string | undefined
    const verifyProfile = async () => {
        pinnedProfile = await requireExpectedAnkiProfile(plugin, pinnedProfile)
        verifiedProfile = pinnedProfile
        return pinnedProfile
    }
    let linkedModels = new Map<number, LinkedBulletModel>()
    let connectionProblem: string | undefined
    const cautions: string[] = []
    if (bullet) {
        try {
            await verifyProfile()
            linkedModels = await readLinkedBulletModels(new Set([bullet.id]), undefined,
                notes => auditRead('notesInfo', { notes }, undefined, readTimeoutMs))
            await verifyProfile()
            if (!linkedModels.has(bullet.id)) {
                cautions.push(t(`The linked record ${bullet.id} or its Front and Back fields could not be confirmed in Anki.`,
                    `В Anki не удалось подтвердить запись ${bullet.id} или её поля Front и Back.`))
            }
        } catch (error) {
            linkedModels.clear()
            connectionProblem = errorText(error, t)
        }
    }
    const data = await settingToData(app, scanProfileFreeSettings(settings), fieldsDictionary, [])
    const savedMetadata = app.metadataCache.getCache(source)
    const metadata = rebuildMetadata || !savedMetadata ? editorPreviewMetadata(text, savedMetadata) : savedMetadata
    const parsed = await parsePortableMarkdown(app, data, file, text, ids,
        { audit: true, preview: true, models: linkedModels, bullets, metadata, syntax: settings.Syntax })
    const selected = cardAtOffset(parsed, text, offset)
    let fields: CardPreviewField[]
    let modelName: string
    let deck: string
    let id: number | undefined
    let start: number
    let tags: readonly string[] = []
    const fallbackBullet = bullet && !linkedModels.has(bullet.id) ? bullet : undefined
    if (fallbackBullet) {
        const sourceFields = { Front: fallbackBullet.front, Back: fallbackBullet.back, ...fallbackBullet.metadata }
        fields = Object.entries(sourceFields).flatMap(([name, value]) => typeof value === 'string'
            ? [{ name, html: parsed.formatter.format(value, false, false) }] : [])
        modelName = t('Unconfirmed Anki note type', 'Тип записи Anki не подтверждён')
        deck = parsed.target_deck
        id = fallbackBullet.id
        start = fallbackBullet.start
        cautions.push(t('Only the fields recognizable from Markdown are shown. The linked Anki note type could not be confirmed.',
            'Показаны поля, распознанные в Markdown. Подтвердить тип записи в Anki не удалось.'))
    } else if (selected) {
        const { note } = selected
        fields = Object.entries(note.fields).map(([name, html]) => ({ name, html }))
        modelName = note.modelName
        deck = note.deckName
        id = selected.identifier
        start = selected.start
        tags = note.tags
    } else {
        throw new Error(t('No Anki card at the cursor. Place it within the card text or its ID line and check the card format.',
            'Карточка Anki под курсором не найдена. Поставьте курсор в текст карточки или на строку с ID и проверьте формат.'))
    }

    for (const warning of parsed.idDateWarnings ?? []) if (warning.id === id) cautions.push(t(warning.message, warning.russianMessage))

    const appliedRule = selected && !fallbackBullet ? portableCardExportRule(selected.note) : undefined
    const ruleRoute = selected && !fallbackBullet ? portableCardExportRuleRoute(selected.note) : undefined
    if (appliedRule && (!ruleRoute || appliedRule.modelCheckRequired)) cautions.push(describeExportRule(appliedRule, t))
    const route = ruleRoute ?? portableDeckRoute(data, source, text, parsed)
    try {
        const scope = describeSyncPath(plugin, source, settings)
        if (!scope.included) cautions.push(t(`This note is outside the export scope “${scope.label}”.`,
            `Заметка находится вне области экспорта «${scope.label}».`))
    } catch (error) {
        cautions.push(errorText(error, t))
    }
    if (id && markers.filter(marker => marker.id === id).length > 1) {
        cautions.push(t(`Anki ID ${id} is repeated in this note.`, `Anki ID ${id} повторяется в этой заметке.`))
    }
    if (unsaved) cautions.push(t('This preview uses the current editor text. Attachment and link metadata may reflect the last save.',
        'Показан текущий текст редактора. Вложения и ссылки могут отображаться по данным последнего сохранения.'))

    let variants = buildBasicCardVariants(fields, modelName, t)
    let previewNotice = t('Basic preview · Anki card template unavailable.', 'Упрощённый вид · Шаблон Anki недоступен.')
    if (!connectionProblem && selected && !fallbackBullet) {
        try {
            const layout = await readCardTemplateVariants(modelName, fields, verifyProfile, undefined, { deck, tags }, t)
            if (layout.variants.length) {
                variants = layout.variants
                previewNotice = t('Anki template preview · static rendering.', 'Статический предпросмотр шаблона Anki.')
            }
            cautions.push(...layout.cautions)
        } catch (error) {
            connectionProblem = errorText(error, t)
        }
    }
    if (connectionProblem) cautions.push(connectionProblem)
    if (fields.some(({ html }) => /<(?:img|audio|video)\b|\[sound:/i.test(html))) {
        cautions.push(t('Attachments and audio are shown as references in this static preview.',
            'В статическом предпросмотре вложения и аудио показаны как ссылки.'))
    }
    const target = selected && !fallbackBullet && verifiedProfile ? {
        path: source, text, offset, id, model: modelName, deck, profile: verifiedProfile, configuration,
    } : undefined
    return { source, target, line: text.slice(0, start).split(/\r\n?|\n/).length, unsaved, fields,
        modelName, deck, deckReason: describeDeckRoute(route, t), id, variants, previewNotice, cautions }
}

export async function previewCurrentCard(plugin: MyPlugin, editor: Editor, file: TFile, savedText?: string, clickedOffset?: number,
    newCardProfile?: string): Promise<void> {
    const t = uiFor(plugin.settings)
    const revision = (latestPreview.get(plugin) ?? 0) + 1
    latestPreview.set(plugin, revision)
    try {
        const source = file.path
        const text = editor.getValue()
        const offset = clickedOffset ?? editor.posToOffset(editor.getCursor('head'))
        const unsaved = savedText !== undefined && text.replace(/\r\n/g, '\n') !== savedText.replace(/\r\n/g, '\n')
        const result = await buildCardPreview(plugin, file, text, offset, unsaved, unsaved || savedText === undefined)
        if (latestPreview.get(plugin) !== revision) return
        if (file.path !== source || editor.getValue() !== text) {
            throw new Error(t('The note changed while opening the preview. Open it again for the current text.',
                'Заметка изменилась при открытии предпросмотра. Откройте его снова для актуального текста.'))
        }
        if (newCardProfile && result.id !== undefined) throw new Error(t(
            'This card already has an ID. Place the cursor inside a new card.',
            'У этой карточки уже есть ID. Поставьте курсор в текст новой карточки.'))
        const target = result.target
        if (newCardProfile && target && target.profile !== newCardProfile) throw staleCursorCard()
        openCardPreview(plugin.app, result, t, target ? async () => {
            if (file.path !== source || editor.getValue() !== text || plugin.app.vault.getAbstractFileByPath(source) !== file ||
                cursorConfiguration(plugin) !== target.configuration) throw staleCursorCard()
            await previewVaultExport(plugin, undefined, new Set([source]), target)
        } : undefined)
    } catch (error) {
        if (latestPreview.get(plugin) === revision) {
            const message = errorText(error, t)
            new Notice(t(`Anki card preview · ${message}`, `Предпросмотр карточки Anki · ${message}`))
        }
    }
}

export function registerCardPreview(plugin: MyPlugin): void {
    plugin.addCommand({
        id: 'anki-preview-current-card',
        name: uiFor(plugin.settings)('Preview Current Card', 'Предпросмотр текущей карточки'),
        editorCallback: (editor, view) => {
            if (view.file?.extension.toLowerCase() === 'md') {
                void previewCurrentCard(plugin, editor, view.file,
                    'data' in view && typeof view.data === 'string' ? view.data : undefined)
            }
        },
    })
    plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
        const file = view.file
        if (file?.extension.toLowerCase() !== 'md') return
        const t = uiFor(plugin.settings)
        menu.addItem(item => item.setTitle(t('Preview Anki Card', 'Предпросмотр карточки Anki')).setIcon('eye').onClick(() => {
            void previewCurrentCard(plugin, editor, file, 'data' in view && typeof view.data === 'string' ? view.data : undefined)
        }))
    }))
}
