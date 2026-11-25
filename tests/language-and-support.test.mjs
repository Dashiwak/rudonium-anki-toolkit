// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import overlay from '../Build/overlay-source.cjs'
import installer from '../Build/install.cjs'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

const asModule = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const readModule = name => stripTypeScriptTypes(
    readFileSync(overlay.file(name + '.ts'), 'utf8'), { mode: 'transform' })
const languageModule = asModule(readModule('interface-language'))
const identityModule = asModule(readModule('plugin-identity'))
const hostModule = asModule(`
    export class Notice {}
    export function setIcon(element, icon) { element.icon = icon }
    export class Setting {
        constructor(host) { host.setting = this }
        setName(label) { this.label = label; return this }
        setDesc() { return this }
        setHeading() { this.heading = true; return this }
        addDropdown(configure) {
            const row = this
            configure({
                selectEl: { setAttribute() {}, classList: { add() {} } },
                addOption() { return this },
                setValue(value) { row.value = value; return this },
                setDisabled() { return this },
                onChange(handler) { row.change = handler; return this },
            })
            return this
        }
    }
`)
const { uiFor } = await import(languageModule)
const { supportUrl } = await import(identityModule)
const source = readModule('interface-settings-ui')
    .replace("'obsidian'", JSON.stringify(hostModule))
    .replace("'./interface-language'", JSON.stringify(languageModule))
    .replace("'./plugin-identity'", JSON.stringify(identityModule))
    .replace("'./settings-layout'", JSON.stringify(asModule(readModule('settings-layout'))))
const { installSettingsHelp, installInterfaceLanguage, installProjectInfo, registerSupportCommand, legacySettingLabel, legacySettingDescription } = await import(asModule(source))
const release = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))

test('Fresh and legacy settings without a language show English. Explicit Russian is preserved.', () => {
    for (const settings of [undefined, {}, { INTERFACE_LANGUAGE: 'unsupported' }]) {
        assert.equal(uiFor(settings)('English', 'Русский'), 'English')
    }
    assert.equal(uiFor({ INTERFACE_LANGUAGE: 'ru' })('English', 'Русский'), 'Русский')
})

test('Help and the language selector are available in English and Russian', async () => {
    const generated = installer.patchInterfaceSettings("containerEl.createEl('h2', {text: 'Obsidian_to_Anki settings'})\nthis.setup_workflows()")
    assert.match(generated, /installSettingsHelp\(containerEl,/)
    assert.doesNotMatch(generated, /Obsidian_to_Anki settings/)
    const actual = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8')
    const layout = actual.slice(actual.indexOf('setup_display(): void'))
    assert.doesNotMatch(layout, /For more information check the wiki|Rudonium Anki Toolkit settings/)
    assert.match(generated, /installInterfaceLanguage\(info,[^\n]*\n\s*installProjectInfo\(info, \(this as any\)\.plugin, RUDONIUM_BUILD_VERSION\)/)
    for (const [initial, next, label, linkText] of [
        [undefined, 'ru', 'Interface Language', 'Rudonium help on GitFlic'],
        ['ru', 'en', 'Язык интерфейса', 'Помощь по Rudonium на GitFlic'],
    ]) {
        let saved, redrawn, link
        const root = { createEl(tag, options) { if (tag === 'a') link = { tag, ...options }; return {} },
            createDiv() { return this },
            querySelectorAll() { return [] }, querySelector() { return null } }
        const plugin = { settings: { INTERFACE_LANGUAGE: initial }, async saveAllData() { saved = this.settings.INTERFACE_LANGUAGE } }
        installSettingsHelp(root, plugin)
        assert.deepEqual(link, { tag: 'a', cls: 'rudonium-settings-help', text: linkText, attr: { href: supportUrl } })
        installInterfaceLanguage(root, plugin, () => { redrawn = true })
        assert.equal(root.setting.label, label)
        assert.equal(root.setting.value, initial ?? 'en')
        await root.setting.change(next)
        assert.equal(saved, next)
        assert.ok(redrawn)
    }
})

test('About and public guides use GitFlic Issues, and the existing GitFlic help command is preserved', t => {
    const elements = []
    const root = {
        createEl(tag, options = {}) { elements.push({ tag, ...options }); return this },
        createDiv() { return this },
        createSpan(options) { return this.createEl('span', options) },
    }
    const expected = 'https://gitflic.ru/project/dashiwak/rudonium-anki-toolkit/issue'
    assert.equal(supportUrl, expected)
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    let destination
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { open(url) { destination = url } } })
    t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window)
    for (const [language, about, commandName, issueLabel] of [
        ['en', 'About the plugin', 'Get help on GitFlic', 'Questions and bug reports on GitFlic'],
        ['ru', 'О плагине', 'Обратиться за помощью на GitFlic', 'Вопросы и сообщения об ошибках на GitFlic'],
    ]) {
        elements.length = 0
        destination = undefined
        let command
        const plugin = { settings: { INTERFACE_LANGUAGE: language }, manifest: { version: '1.6.6' }, addCommand(value) { command = value } }
        installProjectInfo(root, plugin, release.version)
        assert.equal(root.setting.label, about)
        assert.equal(root.setting.heading, true)
        assert.ok(elements.some(el => el.text === 'Rudonium Anki Toolkit ' + release.version))
        assert.ok(elements.some(el => el.text?.includes('manifest.json') && el.text.includes('1.6.6')))
        assert.ok(elements.some(el => el.text?.includes('Obsidian to Anki') &&
            el.attr.href === 'https://github.com/ObsidianToAnki/Obsidian_to_Anki'))
        assert.ok(elements.some(el => el.text?.includes('dashiwak')))
        assert.ok(elements.some(el => el.tag === 'a' && el.attr?.href === supportUrl && el.text === issueLabel))
        assert.ok(elements.every(el => !el.attr?.href?.startsWith('mailto:') && !el.text?.includes('@')))
        assert.equal(elements.filter(el => el.attr?.href === expected).length, 1)
        installSettingsHelp(root, plugin)
        assert.equal(elements.filter(el => el.attr?.href === expected).length, 2)
        assert.ok(elements.some(el => el.text === 'GNU GPLv3'))
        registerSupportCommand(plugin)
        assert.equal(command.id, 'open-gitverse-support')
        assert.equal(command.name, commandName)
        command.callback()
        assert.equal(destination, expected)
    }
    for (const file of ['README.md', 'README.ru.md', 'CONTRIBUTING.md', 'docs/en/quick-start.md', 'docs/ru/quick-start.md']) {
        assert.ok(readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes(supportUrl), file)
    }
    assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).bugs.url, supportUrl)
})

test('SettingsTab keeps connection directly under help, lifecycle directives out of Syntax and language above About', async () => {
    const { load } = await import('./benchmark/migration-modules.cjs').then(module => module.default)
    const raw = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8')
    const noop = () => {}, dialogs = []
    const { Setting } = await import(hostModule)
    class Row extends Setting {
        addButton(cb) {
            const row = this
            cb({
                setButtonText(label) { row.buttonLabel = label; return this },
                setClass() { return this },
                onClick(handler) { row.click = handler; return this },
            })
            return this
        }
        addText(cb) { cb({}); return this }
        addToggle() { return this }
        addSlider() { return this }
    }
    class Element {
        children = []
        attrs = new Map()
        constructor(tag, options) { this.tag = tag; Object.assign(this, options) }
        empty() { this.children.length = 0 }
        createDiv(options) { return this.createEl('div', options) }
        createSpan(options) { return this.createEl('span', options) }
        createEl(tag, options) { const node = new Element(tag, options); this.children.push(node); return node }
        set setting(row) { this.children.push(row) }
        setAttribute(key, value) { this.attrs.set(key, value) }
        getAttribute(key) { return this.attrs.get(key) }
        querySelectorAll(selector) {
            const walk = nodes => nodes.flatMap(node => [node, ...walk(node.children ?? [])])
            const all = walk(this.children)
            if (selector === 'details') return all.filter(node => node.tag === 'details')
            if (selector === 'details[data-rudonium-settings-group]') return all.filter(node => node.getAttribute?.('data-rudonium-settings-group'))
            return []
        }
        querySelector() { return null }
    }
    const { 'card-lifecycle-settings': { isLifecycleSyntax } } = await load(['card-lifecycle-settings'], {})
    const { settings: { SettingsTab }, 'settings-layout': layout } = await load(['settings', 'settings-layout', 'first-connection', 'page-migration-ui', 'card-format-presets'], {
        PluginSettingTab: class { hide() {} }, Setting: Row, Modal: class { open() { dialogs.push(this.constructor.name) } },
        uiFor, installInterfaceLanguage, installProjectInfo, installSettingsHelp, legacySettingLabel, isLifecycleSyntax, bindSyntaxEdit: noop,
        acknowledgeFormatSetup: noop, installBidirectionalSettings: noop, installNoteTypeRules: noop,
        installIgnoredFilesSetting: noop, installDefaultDeckSetting: noop, legacySettingDescription, installNoteTypeRefresh: noop,
        installFolderTagSettings: noop, installCardLifecycleSettings: noop, installAnkiProfileSettings: noop,
        installSyncProfileSettings: noop, installDeckRoutingSettings: noop, installIdMarkerSettings: noop,
        installZipImportSettings: noop, installImageOptimizationSettings: noop,
    }, { settings: raw.replace('declare const RUDONIUM_BUILD_VERSION: string', 'const RUDONIUM_BUILD_VERSION = ' + JSON.stringify(release.version)) })
    const root = new Element('root')
    root.classList = { add: noop, remove: noop }
    const storage = new Map()
    const app = {
        loadLocalStorage(key) { return structuredClone(storage.get(key)) },
        saveLocalStorage(key, value) { storage.set(key, structuredClone(value)) },
    }
    const plugin = { app, settings: { Defaults: {}, Syntax: { 'Frozen Fields Line': 'SHARED', 'End Note': 'END', 'Delete Note Line': 'DEL',
        'Suspend Line': 'PAUSE', 'Suspend Line Aliases': '[]' } }, fields_dict: {}, manifest: release, register: noop, saveAllData: async () => {} }
    const tab = new SettingsTab({}, plugin)
    tab.containerEl = root
    tab.display()
    for (const [language, about, connection, first, setupButton, migration, migrationButton, syntax, end, next] of [
        ['Interface Language', 'About the plugin', 'Anki Connection', 'Quick Start', 'Set up sync', 'Card file migration', 'Set up migration', 'Syntax Settings', 'End Note', 'ru'],
        ['Язык интерфейса', 'О плагине', 'Подключение к Anki', 'Быстрый старт', 'Настроить синхронизацию', 'Перенос карточек из файлов', 'Настроить перенос', 'Синтаксис карточек', 'Конец блока карточки', 'en'],
    ]) {
        const [header, group] = root.children
        const [controls, help] = header.children
        assert.equal(help.attr.href, supportUrl)
        assert.equal(root.children.filter(el => el.getAttribute?.('data-rudonium-settings-group') === 'connection').length, 1)
        assert.equal(group.tag, 'details')
        assert.equal(group.children[0].text, connection)
        const actions = group.children[1].children
        assert.deepEqual(actions.map(row => row.label), [first, migration])
        assert.deepEqual(actions.map(row => row.buttonLabel), [setupButton, migrationButton])
        if (!dialogs.length) {
            actions.forEach(row => row.click())
            assert.deepEqual(dialogs, ['FirstConnectionModal', 'PageMigrationWizard'])
        }
        const syntaxGroup = root.children.find(el => el.children?.[0]?.text === syntax)
        assert.deepEqual(syntaxGroup.children[1].children.map(row => row.label), [end])
        const groups = root.children.slice(1)
        assert.ok(groups.every(el => el.tag === 'details'))
        const keys = groups.map(el => el.getAttribute('data-rudonium-settings-group'))
        assert.deepEqual(keys.slice(0, 4), ['connection', 'syntax', 'defaults', 'actions'])
        const defaults = groups[keys.indexOf('defaults')]
        assert.ok(!defaults.open)
        const nested = defaults.children[1].createEl('details')
        const query = defaults.children[1].createEl('input', { value: 'Base', attr: { type: 'search' } })
        const expand = controls.children[0], collapse = controls.children[1]
        assert.deepEqual(controls.children.map(button => [button.tag, button.attr.type, button.icon]), [
            ['button', 'button', 'chevrons-up-down'], ['button', 'button', 'chevrons-down-up']])
        assert.deepEqual(controls.children.map(button => button.attr['aria-label']), next === 'ru'
            ? ['Expand all sections', 'Collapse all sections'] : ['Развернуть все разделы', 'Свернуть все разделы'])
        assert.ok(controls.children.every(button => button.attr.title === button.attr['aria-label']))
        expand.onclick()
        assert.ok(groups.every(section => section.open) && nested.open)
        collapse.onclick()
        assert.ok(groups.every(section => !section.open) && !nested.open)
        assert.equal(query.value, 'Base')
        const [selector, info] = groups[keys.indexOf('plugin-info')].children[1].children
        assert.equal(selector.label, language)
        assert.equal(info.children[0].label, about)
        await selector.change(next)
    }
    const section = (key) => root.querySelectorAll('details').find(node => node.getAttribute('data-rudonium-settings-group') === key)
    section('connection').open = true
    section('syntax').open = true
    section('syntax').ontoggle({})
    // Close before the native toggle event for "connection" is dispatched.
    tab.hide()
    root.empty()
    const restarted = { ...plugin, settings: { ...plugin.settings, INTERFACE_LANGUAGE: 'ru' } }
    const reopened = new SettingsTab(app, restarted)
    reopened.containerEl = root
    reopened.display()
    assert.ok(section('connection').open && section('syntax').open)
    assert.equal(section('defaults').open, false)
    assert.equal(section('connection').children[0].text, 'Подключение к Anki')
    const example = section('defaults').createEl('details')
    layout.rememberGroup(example, restarted, 'id-markers-example')
    layout.setAllSettingsGroupsOpen(root, restarted, true)
    example.open = false
    example.ontoggle({})
    section('syntax').open = false
    reopened.hide()
    root.empty()
    const again = { ...restarted }
    const last = new SettingsTab(app, again)
    last.containerEl = root
    last.display()
    const newExample = section('defaults').createEl('details')
    layout.rememberGroup(newExample, again, 'id-markers-example')
    assert.equal(newExample.open, false)
    assert.equal(section('syntax').open, false)
    assert.equal(section('defaults').open, true)
    layout.setAllSettingsGroupsOpen(root, again, false)
    last.hide()
    const fresh = new SettingsTab(app, { ...again })
    fresh.containerEl = new Element('root')
    fresh.containerEl.classList = root.classList
    fresh.display()
    assert.ok(fresh.containerEl.querySelectorAll('details').every(group => !group.open))
    assert.equal(storage.size, 1)
    fresh.containerEl.empty()
    const definitions = fresh.getSettingDefinitions()
    assert.equal(definitions[1].name, 'Подключение к Anki')
    assert.ok(definitions[1].aliases.includes('AnkiConnect'))
    assert.ok(definitions[2].aliases.includes('Двусторонняя синхронизация'))
    assert.equal(fresh.containerEl.children.length, 0, 'search indexing must not render controls')
    for (const definition of definitions) {
        const settingEl = fresh.containerEl.createDiv()
        settingEl.classList = root.classList
        definition.render({ settingEl })
    }
    const all = fresh.containerEl.querySelectorAll('details')
    assert.ok(all.some(el => el.getAttribute('data-rudonium-settings-group') === 'connection'))
    const buttons = fresh.containerEl.children[0].children[0].children[0].children
    buttons[0].onclick()
    assert.ok(all.every(el => el.open), 'native rows share the expand-all toolbar')
    buttons[1].onclick()
    assert.ok(all.every(el => !el.open))

})

test('autoscan slider shows minutes and manual mode in both languages', () => {
    const key = 'Scheduling Interval'
    assert.equal(legacySettingLabel(key, uiFor()), 'Auto-scan interval (minutes)')
    assert.equal(legacySettingLabel(key, uiFor({ INTERFACE_LANGUAGE: 'ru' })), 'Интервал автосканирования (минуты)')
    assert.match(legacySettingDescription(key, '', uiFor()), /0 to scan manually/)
    assert.match(legacySettingDescription(key, '', uiFor({ INTERFACE_LANGUAGE: 'ru' })), /0 для ручного запуска/)
})

test('saved automatic scans restart on load, use one interval, stop at zero and cannot restart after unload', async t => {
    const { load } = await import('./benchmark/migration-modules.cjs').then(m => m.default)
    const timers = new Map()
    const clock = {
        next: 0,
        setInterval(fn, delay) { timers.set(++this.next, { fn, delay }); return this.next },
        clearInterval(id) { timers.delete(id) },
    }
    let cleanup, sliderChanged, scans = 0
    class Row {
        setName() { return this }
        setDesc() { return this }
        setHeading() { return this }
        addToggle() { return this }
        addText() { return this }
        addSlider(install) {
            install({ setLimits() { return this }, setValue() { return this }, setDynamicTooltip() { return this },
                onChange(fn) { sliderChanged = fn; return this } })
            return this
        }
    }
    const raw = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8')
    const { settings: { SettingsTab } } = await load(['settings'], { PluginSettingTab: class {}, Setting: Row,
        uiFor: () => en => en, legacySettingLabel: key => key, legacySettingDescription: () => '',
        installDefaultDeckSetting() {}, createSettingsGroup: container => container.createDiv(), clock,
    }, { settings: "import { clock } from 'test-clock'\nconst window = clock\n" + raw })
    const plugin = { settings: { Defaults: { 'Scheduling Interval': 5 } }, register(fn) { cleanup = fn },
        async saveAllData() {}, async scanVault() { scans++ } }
    const tab = new SettingsTab({}, plugin)
    t.after(() => cleanup())
    tab.containerEl = { createDiv() { return {} } }
    assert.equal(timers.size, 1)
    const timer = [...timers.values()][0]
    assert.equal(timer.delay, 300000)
    timer.fn()
    assert.equal(scans, 1)
    tab.setup_defaults()
    await sliderChanged(10)
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].delay, 600000)
    await sliderChanged(0)
    assert.equal(timers.size, 0)
    let saved
    plugin.saveAllData = () => new Promise(resolve => { saved = resolve })
    const pending = sliderChanged(15)
    cleanup()
    saved()
    await pending
    assert.equal(timers.size, 0)
})

test('imported ignore patterns remain editable after clearing and recover from a failed save', async () => {
    const { load } = await import('./benchmark/migration-modules.cjs').then(module => module.default)
    const events = {}, notices = []
    let area
    class Row {
        setName() { return this }
        setDesc() { return this }
        addTextArea(render) {
            area = {
                setValue(value) { this.value = value; return this },
                getValue() { return this.value },
                setDisabled(value) { this.disabled = value; return this },
                inputEl: { addEventListener(key, handler) { events[key] = handler } },
            }
            render(area)
        }
    }
    const { 'settings-search': { installIgnoredFilesSetting } } = await load(['settings-search'], {
        uiFor, Setting: Row, Notice: class { constructor(value) { notices.push(value) } }, uiDiagnostic: String,
        createSettingsGroup() { return {} }, withFastScanReadLock: (_plugin, task) => task(),
    })
    let writes = 0, fail = false
    const plugin = { settings: {}, async saveAllData() { writes++; if (fail) throw Error('Storage failure') } }
    const blur = async value => { area.value = value; events.blur(); await new Promise(resolve => setImmediate(resolve)) }
    installIgnoredFilesSetting({}, plugin)
    assert.equal(area, undefined)
    plugin.settings.LEGACY_IGNORED_FILE_GLOBS = ['Templates/**']
    installIgnoredFilesSetting({}, plugin)
    assert.equal(area.value, 'Templates/**')
    await blur('**/*.tmp\n\nDrafts/**')
    assert.equal(writes, 1)
    assert.deepEqual([...plugin.settings.LEGACY_IGNORED_FILE_GLOBS], ['**/*.tmp', 'Drafts/**'])
    fail = true
    await blur('')
    assert.equal(area.value, '**/*.tmp\nDrafts/**')
    assert.equal(notices.length, 1)
    fail = false
    await blur('')
    assert.deepEqual([...plugin.settings.LEGACY_IGNORED_FILE_GLOBS], [])
    area = undefined
    installIgnoredFilesSetting({}, plugin)
    assert.equal(area.value, '')
})
