/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
/** Anki и её клиенты могут нормализовать Unicode перед возвратом сохранённого поля. */
export function sameFieldValue(actual: string | undefined, expected: string): boolean {
    return actual === expected || (actual !== undefined && actual.normalize('NFC') === expected.normalize('NFC'))
}
