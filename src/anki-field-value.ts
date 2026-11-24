/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
export function sameFieldValue(actual: string | undefined, expected: string): boolean {
    return actual === expected || (actual !== undefined && actual.normalize('NFC') === expected.normalize('NFC'))
}
