// SPDX-License-Identifier: GPL-3.0-only

// Only blocks with this signature on their ID line own trailing hashtags in
// their first field. Ordinary notes retain the vault's Add Obsidian Tags setting.
export const blockFieldTagSignature = '@field-tags'

export function hasBlockFieldTags(idLine: string): boolean {
    return /[ \t]@field-tags(?:[ \t]*-->)?[ \t]*$/u.test(idLine)
}

const obsidianTagName = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D_-]+(?:\/[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D_-]+)*$/u
function validName(value: string): boolean {
    return obsidianTagName.test(value) && /[\p{L}\p{M}\p{Extended_Pictographic}_-]/u.test(value)
}

export function blockFieldHashtag(tag: string): string | undefined {
    // A literal slash in Anki is distinct from the :: hierarchy separator.
    if (tag.includes('/')) return
    const name = tag.replace(/::/gu, '/')
    if (validName(name)) return '#' + name
}

export function readBlockFieldTags(value: string): { text: string; tags: string[] } {
    let end = value.trimEnd().length
    const tags: string[] = []
    while (end > 0) {
        let start = end
        while (start > 0 && !/\s/u.test(value[start - 1])) start--
        if (value[start] !== '#') break
        const name = value.slice(start + 1, end)
        if (!validName(name)) break
        tags.push(name.replace(/\//gu, '::'))
        end = start
        while (end > 0 && /\s/u.test(value[end - 1])) end--
    }
    return { text: value.slice(0, end), tags: tags.reverse() }
}
