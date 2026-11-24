// SPDX-License-Identifier: GPL-3.0-only
// Load the distributable TypeScript unchanged apart from type erasure and ESM locations.
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

export function syncSourceDirectory(directory) {
    // Previous kits stored the modules inside Build/. Keep their comparison commands usable.
    if (basename(directory).toLowerCase() === 'build' && !existsSync(join(directory, 'fast-scan.ts'))) {
        return join(dirname(directory), 'src')
    }
    return directory
}

export async function loadSync(directory, pageParser) {
    const sourceDirectory = syncSourceDirectory(directory)
    const output = mkdtempSync(join(tmpdir(), 'rudonium-bidirectional-'))
    const hostName = fileURLToPath(new URL('./host.mjs', import.meta.url))
    const hostUrl = pathToFileURL(hostName).href
    const replaced = new Set(['anki', 'bidirectional-ui', 'anki-profile-ui', 'sync-audit', 'vault-backup',
        'setting-to-data', 'files-manager', 'file', 'constants', 'media-sync', 'card-preview-ui'])
    // The bidirectional branch of the command never executes one-way export or its dialogs.
    const fastUnused = new Set(['duplicate-review', 'duplicate-review-ui', 'export-review-ui', 'cloud-folder-check',
        'image-optimizer', 'cache-optimization', 'recovery-lookup', 'duplicate-preflight', 'export-batch',
        'export-operation-journal', 'export-operation-journal-ui'])
    const visited = new Set()
    const adapters = new Map()
    const host = await import(hostUrl)
    function load(name) {
        if (visited.has(name)) return
        visited.add(name)
        const ts = readFileSync(join(sourceDirectory, name + '.ts'), 'utf8')
        const js = stripTypeScriptTypes(ts, { mode: 'transform' }).replace(
            /^(import|export)\s+(\{[^}]*\}|\* as \w+)\s+from\s+['"]([^'"]+)['"]/gm,
            (source, kind, bindings, specifier) => {
                const child = specifier.replace(/^\.\//, '')
                if (specifier === 'obsidian' || specifier === 'ts-md5' || replaced.has(child) ||
                    (name === 'fast-scan' && fastUnused.has(child))) {
                    const alias = 'adapter-' + child
                    const exports = adapters.get(alias) ?? new Set()
                    adapters.set(alias, exports)
                    if (bindings.startsWith('{')) {
                        for (const item of bindings.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean)) {
                            exports.add(item.split(/\s+as\s+/)[0])
                        }
                    } else if (child === 'anki') {
                        for (const field of ['invoke','updateNoteFields','addTags','removeTags']) exports.add(field)
                    }
                    return `${kind} ${bindings} from './${alias}.mjs'`
                }
                if (!specifier.startsWith('./')) throw new Error('Unsupported dependency ' + specifier)
                load(child)
                return `${kind} ${bindings} from './${child}.mjs'`
            })
        writeFileSync(join(output, name + '.mjs'), js)
    }
    try {
        load('fast-scan')
        load('custom-regexp-worker')
        load('card-preview')
        for (const [alias, names] of adapters) {
            if (alias === 'adapter-file' && pageParser) {
                writeFileSync(join(output, alias + '.mjs'), stripTypeScriptTypes(pageParser()))
                continue
            }
            const source = [...names].map(name => {
                if ((alias === 'adapter-files-manager' && (name === 'mergeTags' || name === 'frontmatterTags'))) {
                    return `export { ${name} } from './portable-parser.mjs'`
                }
                if (Object.hasOwn(host, name)) return `export { ${name} } from ${JSON.stringify(hostUrl)}`
                return `export function ${name}() { throw new Error('Unexpected benchmark operation: ${alias}/${name}') }`
            })
            writeFileSync(join(output, alias + '.mjs'), source.join('\n'))
        }
        const { scanVaultFast, registerFastScan, openOneWayHistory } = await import(pathToFileURL(join(output, 'fast-scan.mjs')))
        const portableParser = await import(pathToFileURL(join(output, 'portable-parser.mjs')))
        const { parsePortableMarkdown } = portableParser
        const delta = await import(pathToFileURL(join(output, 'anki-delta.mjs')))
        const { linkedBulletSourceFields } = await import(pathToFileURL(join(output, 'linked-bullets.mjs')))
        const { customRegexpKey, matchCustomRegexps } = await import(pathToFileURL(join(output, 'custom-regexp-worker.mjs')))
        const { ankiIdRegexpSource } = await import(pathToFileURL(join(output, 'anki-id-marker.mjs')))
        const { cardRegexpWithSuffix } = await import(pathToFileURL(join(output, 'card-format-presets.mjs')))
        const { BidirectionalState } = await import(pathToFileURL(join(output, 'bidirectional-state.mjs')))
        const { previewBidirectionalSync, forgetConfirmedAnkiDeletions } = await import(pathToFileURL(join(output, 'bidirectional-sync.mjs')))
        const { cursorConfiguration } = await import(pathToFileURL(join(output, 'cursor-card.mjs')))
        const { previewCurrentCard } = await import(pathToFileURL(join(output, 'card-preview.mjs')))
        const archive = await import(pathToFileURL(join(output, 'archived-card.mjs')))
        const history = existsSync(join(output, 'sync-change-history.mjs')) ? await import(pathToFileURL(join(output, 'sync-change-history.mjs'))) : {}
        return { ...archive, ...history, openOneWayHistory, portableParser, delta, cardRegexpWithSuffix, forgetConfirmedAnkiDeletions, registerFastScan, scanVaultFast, previewBidirectionalSync, previewCurrentCard, cursorConfiguration, parsePortableMarkdown, linkedBulletSourceFields, BidirectionalState, customRegexpKey, matchCustomRegexps, ankiIdRegexpSource,
            dispose: () => rmSync(output, { recursive: true, force: true }) }
    } catch (error) {
        rmSync(output, { recursive: true, force: true })
        throw error
    }
}
