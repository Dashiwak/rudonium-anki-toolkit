// SPDX-License-Identifier: GPL-3.0-only
import type { PluginSettings } from './interfaces/settings-interface'

type FormatSettings = Pick<PluginSettings, 'QUICK_START_STATUS' | 'CUSTOM_REGEXPS' | 'FILE_LINK_FIELDS' |
    'CONTEXT_FIELDS' | 'NOTE_TYPE_RULE_MODELS'>

export function needsFormatSetup(settings: FormatSettings, fields: Readonly<Record<string, readonly string[]>>): boolean {
    if (settings.QUICK_START_STATUS === 'pending') return true
    if (settings.QUICK_START_STATUS === 'complete' || settings.QUICK_START_STATUS === 'dismissed') return false

    // Profiles saved before Quick Start tracked completion already contain their Anki models.
    // An empty regexp for a known model is valid: the user may be using START/END.
    return !Object.keys(fields).length && !Object.keys(settings.CUSTOM_REGEXPS ?? {}).length &&
        !Object.keys(settings.FILE_LINK_FIELDS ?? {}).length && !Object.keys(settings.CONTEXT_FIELDS ?? {}).length &&
        !settings.NOTE_TYPE_RULE_MODELS?.length
}
