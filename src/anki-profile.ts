/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type MyPlugin from '../main'
import * as AnkiConnect from './anki'
import { withAnkiDeadline } from './anki-transport'
import type { UiText } from './interface-language'

type ProfileProblem = 'unconfigured' | 'mismatch' | 'unreachable' | 'unavailable' | 'unsupported' | 'changed'

export class AnkiProfileError extends Error {
    constructor(readonly reason: ProfileProblem, readonly expected?: string, readonly actual?: string) {
        const messages: Record<ProfileProblem, string> = {
            unconfigured: 'Choose the expected Anki profile in Rudonium’s profile settings.',
            mismatch: `Expected Anki profile “${expected}”, but Anki has “${actual}” open. Switch profiles in Anki and try again.`,
            unreachable: 'Cannot connect to Anki. Start desktop Anki. If it is already open, check that AnkiConnect is enabled and try again.',
            unavailable: 'Anki has no open profile that could be confirmed. Open the expected profile and try again.',
            unsupported: 'This AnkiConnect installation cannot report the active profile. Update AnkiConnect, restart Anki and try again.',
            changed: 'The expected Anki profile changed after the operation was prepared. Start again.',
        }
        super(messages[reason])
        this.name = 'AnkiProfileError'
    }
}

export function profileProblemText(error: AnkiProfileError, t: UiText): string {
    switch (error.reason) {
        case 'unconfigured':
            return t('Open Profile Settings to link this vault to the profile you have open in Anki.',
                'Откройте настройки профиля, чтобы связать хранилище с профилем, открытым в Anki.')
        case 'mismatch':
            return t('Open the expected profile in Anki and check again.',
                'Откройте в Anki привязанный профиль и повторите проверку.')
        case 'changed':
            return t('The Anki profile or its binding changed. Check the profile again before restarting the operation.',
                'Профиль Anki или его привязка изменились. Повторно проверьте профиль перед запуском операции.')
        case 'unreachable':
            return t('Start desktop Anki and open your collection. If Anki is already running, make sure AnkiConnect is enabled, then check the connection again.',
                'Запустите Anki на компьютере и откройте коллекцию. Если Anki уже запущена, убедитесь, что AnkiConnect включён, и повторите проверку соединения.')
        case 'unavailable':
            return t('Anki did not confirm an open profile. Finish opening the collection in Anki, then check again.',
                'Anki не подтвердила открытый профиль. Дождитесь открытия коллекции в Anki и повторите проверку.')
        case 'unsupported':
            return t('This version of AnkiConnect cannot report the active profile. Update AnkiConnect and check again.',
                'Эта версия AnkiConnect не сообщает, какой профиль открыт. Обновите AnkiConnect и повторите проверку.')
    }
}

export function isAnkiProfileLockEnabled(plugin: MyPlugin): boolean {
    return plugin.settings.REQUIRE_ANKI_PROFILE === true
}

export function savedAnkiProfile(plugin: MyPlugin): string | undefined {
    const name = plugin.settings.EXPECTED_ANKI_PROFILE
    return typeof name === 'string' && name.trim() ? name : undefined
}

export function expectedAnkiProfile(plugin: MyPlugin): string | undefined {
    return isAnkiProfileLockEnabled(plugin) ? savedAnkiProfile(plugin) : undefined
}

export function annotateAnkiProfileError(error: unknown, expected: string): unknown {
    return error instanceof AnkiProfileError
        ? new AnkiProfileError(error.reason, error.expected ?? expected, error.actual)
        : error
}

export async function readActiveAnkiProfile(signal?: AbortSignal): Promise<string> {
    try {
        const response: unknown = await withAnkiDeadline(() => AnkiConnect.invoke('getActiveProfile'),
            'Anki profile check', 5_000, signal)
        if (typeof response === 'string' && response.trim()) return response
        throw new AnkiProfileError('unavailable')
    } catch (error) {
        if (signal?.aborted || error instanceof AnkiProfileError) throw error
        const text = error instanceof Error ? error.message : String(error)
        if (/unsupported action|unknown action|not implemented|unknown (?:api )?method/i.test(text)) {
            throw new AnkiProfileError('unsupported')
        }
        if (/collection is not available|no (?:active|open) profile|profile is not (?:open|available|loaded)|no collection/i.test(text)) {
            throw new AnkiProfileError('unavailable')
        }
        throw new AnkiProfileError('unreachable')
    }
}

export async function checkPinnedAnkiProfile(pinned: string, signal?: AbortSignal): Promise<string> {
    try {
        const actual = await readActiveAnkiProfile(signal)
        if (pinned !== actual) throw new AnkiProfileError('mismatch', pinned, actual)
        return actual
    } catch (error) {
        throw annotateAnkiProfileError(error, pinned)
    }
}

export async function requireExpectedAnkiProfile(plugin: MyPlugin, pinned?: string, signal?: AbortSignal): Promise<string> {
    const locked = isAnkiProfileLockEnabled(plugin)
    const expected = expectedAnkiProfile(plugin)
    if (expected !== undefined && pinned !== undefined && pinned !== expected) throw new AnkiProfileError('changed', pinned)
    const target = locked ? expected : pinned
    const actual = target === undefined ? await readActiveAnkiProfile(signal) : await checkPinnedAnkiProfile(target, signal)
    if (locked !== isAnkiProfileLockEnabled(plugin) || expected !== expectedAnkiProfile(plugin)) {
        throw new AnkiProfileError('changed', target ?? actual)
    }
    if (locked && expected === undefined) throw new AnkiProfileError('unconfigured', undefined, actual)
    return actual
}
