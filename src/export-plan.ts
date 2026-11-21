/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
import { Md5 } from 'ts-md5'
import type { OneWayFieldConflict } from './anki-delta'
import type { LocalDeleteEffect } from './deletion-source'
import type { SuspendSelection } from './suspend-label'
import type { ReviewedCardImpact } from './anki-card-impact'

export type ExportOperationKind = 'field' | 'tags' | 'deck' | 'create' | 'delete' | 'media' | 'suspend' | 'id-date'

export interface ExportPreviewOperation {
    key: string
    kind: ExportOperationKind
    id?: number
    line?: number
    modelName?: string
    deck?: string
    values: readonly { name: string; before?: string; after?: string }[]
    deletion?: { local: LocalDeleteEffect; alreadyAbsent: boolean }
    suspendSelection?: SuspendSelection
    cardImpact?: ReviewedCardImpact
    requiresExplicitSelection?: boolean
    mediaAliasSources?: readonly string[]
}

export interface ExportPreviewSelection {
    paths: ReadonlyMap<string, ReadonlySet<string>>
    conflicts: ReadonlySet<string>
    mediaAliasSources?: ReadonlySet<string>
}

/** Подтверждение относится к конкретным исходным и предложенным значениям. */
export function exportOperationKey(kind: ExportOperationKind, evidence: unknown): string {
    return kind + ':' + Md5.hashStr(JSON.stringify(evidence))
}

/** Подтверждение относится к точным значениям источника и назначения, показанным пользователю. */
export function oneWayFieldChoice(conflict: OneWayFieldConflict): string {
    const evidence: unknown[] = [conflict.id, conflict.name, conflict.source, conflict.actual, conflict.kind]
    if (conflict.cardImpact) evidence.push(conflict.cardImpact.cardIds)
    return JSON.stringify(evidence)
}
