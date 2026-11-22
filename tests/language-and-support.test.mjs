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

test('Help precedes the mode switch and the language selector appears immediately above About', async () => {
    const generated = installer.patchInterfaceSettings("containerEl.createEl('h2', {text: 'Obsidian_to_Anki settings'})\nthis.setup_workflows()")
    assert.match(generated, /installSettingsHelp\(containerEl,/)
    assert.doesNotMatch(generated, /Obsidian_to_Anki settings/)
    const actual = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8')
    const layout = actual.slice(actual.indexOf('setup_display(): void'))
    const calls = ['installSettingsHelp(', 'const modeContainer =', 'installNoteTypeRules(', 'this.setup_workflows(modeContainer)', 'installInterfaceLanguage(', 'installProjectInfo(']
    assert.ok(calls.every((call, i) => layout.includes(call) && (i === 0 || layout.indexOf(call) > layout.indexOf(calls[i - 1]))))
    assert.doesNotMatch(layout, /For more information check the wiki|Rudonium Anki Toolkit settings/)
    assert.match(generated, /installInterfaceLanguage\(this\.containerEl,[^\n]*\n\s*installProjectInfo\(this\.containerEl, \(this as any\)\.plugin, RUDONIUM_BUILD_VERSION\)/)
    for (const [initial, next, label, linkText] of [
        [undefined, 'ru', 'Interface Language', 'Rudonium help on GitFlic'],
        ['ru', 'en', 'Язык интерфейса', 'Помощь по Rudonium на GitFlic'],
    ]) {
        let saved, redrawn, link
        const root = { createEl(tag, options) { link = { tag, ...options } },
            querySelectorAll() { return [] }, querySelector() { return null } }
        const plugin = { settings: { INTERFACE_LANGUAGE: initial }, async saveAllData() { saved = this.settings.INTERFACE_LANGUAGE } }
        installSettingsHelp(root, plugin)
        assert.deepEqual(link, { tag: 'a', text: linkText, attr: { href: supportUrl } })
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

test('changing language in the open SettingsTab redraws About immediately below the selector', async () => {
    const { load } = await import('./benchmark/migration-modules.cjs').then(module => module.default)
    const raw = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8')
    const noop = () => {}
    const { settings: { SettingsTab } } = await load(['settings'], {
        PluginSettingTab: class {}, installInterfaceLanguage, installProjectInfo, installSettingsHelp,
        installNoteTypeRules: noop, installFolderTagSettings: noop, installCardLifecycleSettings: noop,
        finalizeSettingsLayout: noop,
    }, { settings: raw.replace('declare const RUDONIUM_BUILD_VERSION: string', 'const RUDONIUM_BUILD_VERSION = ' + JSON.stringify(release.version)) })
    const children = []
    const root = {
        empty() { children.length = 0 },
        createDiv() { return this.createEl('div') },
        createEl(tag, options) {
            const node = { ...this, tag, ...options }
            children.push(node)
            return node
        },
        createSpan(options) { return this.createEl('span', options) },
        set setting(row) { children.push(row) },
        querySelectorAll() { return [] },
        querySelector() { return null },
    }
    const plugin = { settings: {}, manifest: release, register: noop, saveAllData: async () => {} }
    const tab = new SettingsTab({}, plugin)
    tab.containerEl = root
    for (const name of ['setup_syntax', 'setup_defaults', 'setup_buttons', 'setup_workflows']) tab[name] = noop
    tab.display()
    for (const [language, about, next] of [['Interface Language', 'About the plugin', 'ru'], ['Язык интерфейса', 'О плагине', 'en']]) {
        const index = children.findIndex(node => node.label === language)
        assert.ok(index >= 0)
        assert.equal(children[index + 1].cls, 'rudonium-settings-about')
        assert.equal(children[index + 1].setting.label, about)
        assert.ok(children.some(node => node.attr?.href === supportUrl))
        await children[index].change(next)
    }
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
        installDefaultDeckSetting() {}, clock,
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
