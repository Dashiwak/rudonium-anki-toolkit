// SPDX-License-Identifier: GPL-3.0-only
export const deletionModes = ['keep', 'remove', 'mark', 'strike', 'hidden'] as const
export type AfterDeleteMode = typeof deletionModes[number]

interface DeletionSettings {
    AFTER_DELETE_MODE?: unknown
    CLEAN_DELETED_BLOCKS?: boolean
    MARK_DELETED_BLOCKS?: boolean
}

export function isAfterDeleteMode(value: unknown): value is AfterDeleteMode {
    return deletionModes.some(mode => mode === value)
}

export function afterDeleteMode(settings: DeletionSettings): AfterDeleteMode {
    const saved = settings.AFTER_DELETE_MODE
    if (saved !== undefined) return isAfterDeleteMode(saved) ? saved : 'keep'
    if (settings.CLEAN_DELETED_BLOCKS === true) return 'remove'
    return settings.MARK_DELETED_BLOCKS === true ? 'mark' : 'keep'
}
