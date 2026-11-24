/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import { TFolder } from 'obsidian'
import type { Vault } from 'obsidian'
import type { UiText } from './interface-language'

export interface FolderTreeEntry {
    path: string
    keywords?: string
}

interface FolderNode {
    path: string
    name: string
    depth: number
    parent?: FolderNode
    entry?: FolderTreeEntry
    children: FolderNode[]
    key: string
}

type RowAction = HTMLButtonElement | HTMLSelectElement | HTMLInputElement

interface FolderTreeOptions<Action extends RowAction> {
    entries: readonly FolderTreeEntry[]
    t: UiText
    label?: string
    searchLabel?: string
    initiallyVisible?: readonly string[]
    viewState?: { expanded: Set<string>; query: string }
    onBranchToggle?: (expanded: ReadonlySet<string>) => void
    pickSearchResults?: boolean
    onExactMatch?: (path: string) => void
    renderAction: (row: HTMLElement, label: HTMLElement, entry: FolderTreeEntry) => Action | undefined
}

const pageSize = 80

function searchKey(value: string): string {
    return value.normalize('NFC').toLowerCase().trim()
}

export function vaultFolderEntries(vault: Vault): FolderTreeEntry[] {
    const root = vault.getRoot?.() ?? vault.getAbstractFileByPath('')
    if (!(root instanceof TFolder)) return []
    const pending = [root]
    const entries: FolderTreeEntry[] = []
    while (pending.length) {
        for (const child of pending.pop()!.children) {
            if (!(child instanceof TFolder)) continue
            entries.push({ path: child.path })
            pending.push(child)
        }
    }
    return entries
}

function makeTree(entries: readonly FolderTreeEntry[]): { roots: FolderNode[]; nodes: Map<string, FolderNode> } {
    const roots: FolderNode[] = []
    const nodes = new Map<string, FolderNode>()
    for (const entry of entries) {
        let path = ''
        let parent: FolderNode | undefined
        const components = entry.path.split('/')
        for (const [index, name] of components.entries()) {
            path = index === 0 ? name : `${path}/${name}`
            let node = nodes.get(path)
            if (!node) {
                node = { path, name, parent, depth: index, children: [], key: searchKey(path) }
                nodes.set(path, node)
                const siblings = parent?.children ?? roots
                siblings.push(node)
            }
            if (index === components.length - 1) {
                node.entry = entry
                if (entry.keywords) node.key = searchKey(`${path} ${entry.keywords}`)
            }
            parent = node
        }
    }
    const sort = (siblings: FolderNode[]) => siblings.sort((a, b) => a.name.localeCompare(b.name))
    sort(roots)
    for (const node of nodes.values()) sort(node.children)
    return { roots, nodes }
}

interface RenderedRow<Action extends RowAction> {
    item: HTMLElement
    row: HTMLElement
    childList?: HTMLUListElement
    toggle?: HTMLButtonElement
    action?: Action
}

export function createFolderTree<Action extends RowAction>(parent: HTMLElement, options: FolderTreeOptions<Action>) {
    const { entries, t } = options
    const { roots, nodes } = makeTree(entries)
    const expanded = options.viewState?.expanded ?? new Set<string>()
    const searchCollapsed = new Set<string>()
    for (const path of options.initiallyVisible ?? []) {
        for (let node = nodes.get(path)?.parent; node && !expanded.has(node.path); node = node.parent) expanded.add(node.path)
    }

    const search = parent.createEl('label', { text: options.searchLabel ?? t('Search folders', 'Поиск папок') })
        .createEl('input', { attr: { type: 'search', autocomplete: 'off' } })
    search.classList.add('rudonium-folder-tree-search')
    const status = parent.createEl('small', { attr: { role: 'status' } })
    const viewport = parent.createDiv({ attr: { role: 'group', 'aria-label': options.label ?? t('Folder tree', 'Дерево папок'), tabindex: '0' } })
    viewport.classList.add('rudonium-folder-tree-viewport')
    const pager = parent.createDiv()
    let more: HTMLButtonElement | undefined
    const rendered = new Map<string, RenderedRow<Action>>()
    let disabled = false
    let query = ''
    let exactMatch: string | undefined
    let singleMatch: string | undefined
    let filtered: Set<string> | undefined
    let matchCount = 0
    let limit = pageSize

    const makeList = (container: HTMLElement, indent = false) => {
        const list = container.createEl('ul', { attr: { role: 'list' } })
        list.classList.add('rudonium-folder-tree-list')
        list.classList.toggle('rudonium-folder-list-indented', indent)
        return list
    }
    const isOpen = (path: string) => query ? !searchCollapsed.has(path) : expanded.has(path)
    const focusRow = (path?: string, disclosure = false) => {
        const entry = path === undefined ? rendered.values().next().value : rendered.get(path)
        if (!entry) return
        const target = disclosure ? entry.toggle ?? entry.action ?? entry.row : entry.action ?? entry.toggle ?? entry.row
        target.focus()
        target.scrollIntoView({ block: 'nearest' })
    }

    function* visibleFolders(): Generator<FolderNode> {
        const levels = [{ siblings: roots, index: 0 }]
        while (levels.length) {
            const level = levels[levels.length - 1]
            const node = level.siblings[level.index++]
            if (!node) { levels.pop(); continue }
            if (filtered && !filtered.has(node.path)) continue
            yield node
            if (node.children.length && isOpen(node.path)) levels.push({ siblings: node.children, index: 0 })
        }
    }

    let visible = visibleFolders()
    let nextPage: FolderNode[] = []

    const takeRows = (count: number) => {
        const rows: FolderNode[] = []
        while (rows.length < count) {
            const item = visible.next()
            if (item.done) break
            rows.push(item.value)
        }
        return rows
    }

    const rootList = makeList(viewport)
    const render = (append = false) => {
        const scroll = viewport.scrollTop
        if (!append) {
            rendered.clear()
            rootList.empty()
            visible = visibleFolders()
        }
        const rows = append ? nextPage : takeRows(limit)
        for (const node of rows) {
            const parentRow = node.parent ? rendered.get(node.parent.path) : undefined
            const list = parentRow ? parentRow.childList ??= makeList(parentRow.item, node.depth <= 10) : rootList
            const item = list.createEl('li')
            const row = item.createDiv({ attr: { 'data-folder-path': node.path, tabindex: '-1' } })
            row.classList.add('rudonium-folder-tree-row')
            const hasChildren = filtered ? node.children.some(child => filtered!.has(child.path)) : node.children.length > 0
            const open = hasChildren && isOpen(node.path)
            let toggle: HTMLButtonElement | undefined
            if (hasChildren) {
                const ariaLabel = open ? t(`Collapse ${node.path}`, `Свернуть ${node.path}`) : t(`Expand ${node.path}`, `Развернуть ${node.path}`)
                toggle = row.createEl('button', { text: open ? '▾' : '▸', title: ariaLabel,
                    attr: { type: 'button', 'aria-label': ariaLabel, 'aria-expanded': String(open) } })
                toggle.classList.add('rudonium-folder-tree-toggle')
                toggle.disabled = disabled
                toggle.onclick = () => {
                    if (query) {
                        if (open) searchCollapsed.add(node.path)
                        else searchCollapsed.delete(node.path)
                    } else {
                        if (open) expanded.delete(node.path)
                        else expanded.add(node.path)
                        options.onBranchToggle?.(expanded)
                    }
                    render()
                    focusRow(node.path, true)
                }
                toggle.onkeydown = event => {
                    if (event.key === (open ? 'ArrowLeft' : 'ArrowRight')) {
                        event.preventDefault()
                        toggle?.click()
                    }
                }
            } else row.createSpan({ attr: { 'aria-hidden': 'true' } })
            const label = row.createDiv({ title: node.path })
            label.classList.add('rudonium-wrap-anywhere')
            const name = (options.pickSearchResults && query.includes('/') ? node.path : node.name).normalize('NFC')
            const at = options.pickSearchResults && query ? name.toLowerCase().indexOf(query) : -1
            if (at < 0) label.createSpan({ text: node.name })
            else {
                label.createSpan({ text: name.slice(0, at) })
                label.createEl('mark', { text: name.slice(at, at + query.length) })
                label.createSpan({ text: name.slice(at + query.length) })
            }
            const action = node.entry && options.renderAction(row, label, node.entry)
            if (action) action.disabled = disabled
            const focusTarget: HTMLElement | undefined = action
            if (focusTarget && options.pickSearchResults) focusTarget.addEventListener('keydown', event => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                const choices = [...rendered].filter(([path, entry]) => entry.action && nodes.get(path)!.key.includes(query))
                const index = choices.findIndex(([path]) => path === node.path)
                const target = choices[index + (event.key === 'ArrowDown' ? 1 : -1)]
                if (target) {
                    event.preventDefault()
                    focusRow(target[0])
                } else if (event.key === 'ArrowUp' && index === 0) {
                    event.preventDefault()
                    search.focus()
                }
            })
            rendered.set(node.path, { item, row, toggle, action })
        }

        viewport.hidden = rendered.size === 0
        nextPage = takeRows(pageSize)
        if (nextPage.length) {
            if (!more) {
                more = pager.createEl('button', { attr: { type: 'button' } })
                more.onclick = () => {
                    limit += pageSize
                    render(true)
                }
            }
            more.disabled = disabled
            more.setText(t(`Show more folders (+${nextPage.length})`, `Показать ещё папки (+${nextPage.length})`))
        } else if (more) {
            pager.empty()
            more = undefined
        }
        status.setText(query ? matchCount === 0 ? t('No matching folders.', 'Подходящих папок нет.')
            : t(`Matching folders · ${matchCount}`, `Найдено папок · ${matchCount}`)
            : entries.length ? t(`Folders · ${entries.length}`, `Папок · ${entries.length}`) : t('No folders.', 'Папок нет.'))
        viewport.scrollTop = scroll
        if (append && rows.length) focusRow(rows[0].path)
    }

    const filter = () => {
        if (options.viewState) options.viewState.query = search.value
        query = searchKey(search.value)
        searchCollapsed.clear()
        filtered = query ? new Set<string>() : undefined
        matchCount = 0
        exactMatch = undefined
        singleMatch = undefined
        if (filtered) {
            for (const node of nodes.values()) {
                if (!node.entry || !node.key.includes(query)) continue
                matchCount++
                if (options.pickSearchResults) singleMatch = matchCount === 1 ? node.path : undefined
                if (searchKey(node.path) === query) exactMatch = exactMatch === undefined ? node.path : ''
                for (let ancestor: FolderNode | undefined = node; ancestor && !filtered.has(ancestor.path); ancestor = ancestor.parent) {
                    filtered.add(ancestor.path)
                }
            }
        }
        limit = pageSize
        render()
        viewport.scrollTop = 0
    }
    search.oninput = filter
    search.onkeydown = event => {
        if (event.isComposing) return
        if (event.key === 'Escape' && search.value) {
            event.preventDefault()
            event.stopPropagation()
            search.value = ''
            filter()
            return
        }
        if (!rendered.size) return
        const suggested = exactMatch || singleMatch
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            const firstMatch = options.pickSearchResults && query
                ? [...rendered.keys()].find(path => nodes.get(path)!.key.includes(query) && rendered.get(path)?.action) : undefined
            focusRow(firstMatch)
        } else if (event.key === 'Enter' && suggested && options.onExactMatch) {
            event.preventDefault()
            options.onExactMatch(suggested)
        }
    }
    search.value = options.viewState?.query ?? ''
    if (search.value) filter()
    else render()
    return {
        search,
        get more() { return more },
        action: (path: string) => rendered.get(path)?.action,
        focus: () => search.focus(),
        setDisabled(value: boolean) {
            disabled = value
            search.disabled = value
            if (more) more.disabled = value
            for (const { toggle, action } of rendered.values()) {
                if (toggle) toggle.disabled = value
                if (action) action.disabled = value
            }
        },
    }
}
