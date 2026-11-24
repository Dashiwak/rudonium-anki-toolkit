/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
const action = 'anki-card'
const linkClass = ' class="obsidian-link">Obsidian</a>'

export function cardSourceFieldPatch(fields: Record<string, string>, sourceUrl: string,
    vault: string, path: string, id: number, fieldName?: string): Record<string, string> {
    if (!fieldName || !sourceUrl || !vault || !path || !Number.isSafeInteger(id) || id <= 0 ||
        ['frontlang', 'backlang'].includes(fieldName.toLowerCase()) ||
        !Object.prototype.hasOwnProperty.call(fields, fieldName)) return {}
    const field = fields[fieldName]
    if (typeof field !== 'string') return {}
    const escapedUrl = sourceUrl.replace(/&/g, '&amp;')
    const anchor = (url: string) => `<br><a href="${url}"${linkClass}`
    const generated = [anchor(sourceUrl), anchor(escapedUrl)]
    const offsets = generated.map(value => field.lastIndexOf(value))
    const offset = Math.max(...offsets)
    if (offset < 0) return {}
    const original = generated[offsets.indexOf(offset)]
    const link = `obsidian://${action}?vault=${encodeURIComponent(vault)}&amp;file=${encodeURIComponent(path)}&amp;nid=${id}`
    return { [fieldName]: field.slice(0, offset) + anchor(link) + field.slice(offset + original.length) }
}

export function linkFieldsToCard(fields: Record<string, string>, sourceUrl: string,
    vault: string, path: string, id: number, fieldName?: string): Record<string, string> {
    const patch = cardSourceFieldPatch(fields, sourceUrl, vault, path, id, fieldName)
    return Object.keys(patch).length ? { ...fields, ...patch } : fields
}

