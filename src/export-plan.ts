/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { Md5 } from 'ts-md5'
import type { OneWayFieldConflict } from './anki-delta'
import type { LocalDeleteEffect } from './deletion-source'
import type { SuspendSelection } from './suspend-label'
import type { ReviewedCardImpact } from './anki-card-impact'

export type ExportOperationKind = 'field' | 'tags' | 'deck' | 'create' | 'delete' | 'media' | 'suspend' | 'id-date' | 'spacing'

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

export function exportOperationKey(kind: ExportOperationKind, evidence: unknown): string {
    return kind + ':' + Md5.hashStr(JSON.stringify(evidence))
}

export function oneWayFieldChoice(conflict: OneWayFieldConflict): string {
    const evidence: unknown[] = [conflict.id, conflict.name, conflict.source, conflict.actual, conflict.kind]
    if (conflict.cardImpact) evidence.push(conflict.cardImpact.cardIds)
    return JSON.stringify(evidence)
}
