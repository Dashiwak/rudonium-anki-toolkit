/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
// Showdown randomized numeric entities in the address and label of email autolinks.
// Compare those generated links by their actual address so a rescan needn't rewrite them.
function normalizeEmailLinks(html: string): string {
    if (!html.includes('&#') || !html.includes('<a href="')) return html
    const decodeAscii = (text: string) => text.replace(/&#(?:(\d{1,3})|x([\da-f]{1,2}));/gi,
        (entity: string, decimal: string | undefined, hex: string | undefined) => {
            const code = decimal === undefined ? Number.parseInt(hex ?? '', 16) : Number(decimal)
            return code >= 33 && code <= 126 ? String.fromCharCode(code) : entity
        })
    return html.replace(/<a href="([^"<>\s]+)">([^<>\s]+)<\/a>/g, (original: string, target: string, label: string) => {
        const address = decodeAscii(label)
        if (!/^[\w.!#$%+\-]+@[\w.-]+$/u.test(address) || decodeAscii(target) !== 'mailto:' + address) return original
        return '<a href="mailto:' + address + '">' + address + '</a>'
    })
}

export function sameFieldValue(actual: string | undefined, expected: string): boolean {
    return actual === expected || (actual !== undefined &&
        normalizeEmailLinks(actual).normalize('NFC') === normalizeEmailLinks(expected).normalize('NFC'))
}
