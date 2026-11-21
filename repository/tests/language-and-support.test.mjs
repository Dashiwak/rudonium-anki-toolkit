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
const { supportUrl, authorEmail } = await import(identityModule)
const source = readModule('interface-settings-ui')
    .replace("'obsidian'", JSON.stringify(hostModule))
    .replace("'./interface-language'", JSON.stringify(languageModule))
    .replace("'./plugin-identity'", JSON.stringify(identityModule))
    .replace("'./settings-layout'", JSON.stringify(asModule(readModule('settings-layout'))))
const { installSettingsHeader, installProjectInfo, registerSupportCommand, legacySettingLabel, legacySettingDescription } = await import(asModule(source))
const release = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))

test('Fresh and legacy settings without a language show English. Explicit Russian is preserved.', () => {
    for (const settings of [undefined, {}, { INTERFACE_LANGUAGE: 'unsupported' }]) {
        assert.equal(uiFor(settings)('English', 'Русский'), 'English')
    }
    assert.equal(uiFor({ INTERFACE_LANGUAGE: 'ru' })('English', 'Русский'), 'Русский')
})

test('Settings header follows the title, rewrites the original support target and changes the language', async () => {
    const generated = installer.patchInterfaceSettings("containerEl.createEl('h2', {text: 'Obsidian_to_Anki settings'})\nthis.setup_workflows()")
    assert.match(generated, /installSettingsHeader\(this\.containerEl,/)
    assert.ok(generated.includes('installProjectInfo(this.containerEl, (this as any).plugin, RUDONIUM_BUILD_VERSION)'))
    for (const [initial, next, label, linkText] of [
        [undefined, 'ru', 'Interface Language', 'Rudonium help on GitFlic'],
        ['ru', 'en', 'Язык интерфейса', 'Помощь по Rudonium на GitFlic'],
    ]) {
        let placed, saved, redrawn, replacement
        const top = { createEl(tag, options) { return { tag, ...options } } }
        const oldLink = { textContent: 'For more information check the wiki', replaceWith(anchor) { replacement = anchor } }
        const title = { after(node) { placed = node } }
        const root = { querySelector: query => query.startsWith('h1') ? title : null, createDiv: () => top,
            querySelectorAll: query => query === 'a' ? [oldLink] : [] }
        const plugin = { settings: { INTERFACE_LANGUAGE: initial }, async saveAllData() { saved = this.settings.INTERFACE_LANGUAGE } }
        installSettingsHeader(root, plugin, () => { redrawn = true })
        assert.equal(placed, top)
        assert.deepEqual(replacement, { tag: 'a', text: linkText, attr: { href: supportUrl } })
        assert.equal(top.setting.label, label)
        assert.equal(top.setting.value, initial ?? 'en')
        await top.setting.change(next)
        assert.equal(saved, next)
        assert.ok(redrawn)
    }
})

test('About, the help command and both public guides share a single support destination', t => {
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
    for (const [language, about, label, commandName] of [
        ['en', 'About the plugin', 'Help and issues on GitFlic', 'Get help on GitFlic'],
        ['ru', 'О плагине', 'Помощь и обращения на GitFlic', 'Обратиться за помощью на GitFlic'],
    ]) {
        elements.length = 0
        destination = undefined
        let command
        const plugin = { settings: { INTERFACE_LANGUAGE: language }, manifest: { version: '1.6.6' }, addCommand(value) { command = value } }
        installProjectInfo(root, plugin, release.version)
        assert.ok(elements.some(el => el.text === about))
        assert.ok(elements.some(el => el.text === 'Rudonium Anki Toolkit ' + release.version))
        assert.ok(elements.some(el => el.text?.includes('manifest.json') && el.text.includes('1.6.6')))
        assert.ok(elements.some(el => el.text?.includes('Obsidian to Anki') &&
            el.attr.href === 'https://github.com/ObsidianToAnki/Obsidian_to_Anki'))
        assert.ok(elements.some(el => el.attr?.href === 'mailto:' + authorEmail))
        assert.ok(elements.some(el => el.text === label && el.attr?.href === expected))
        assert.ok(elements.some(el => el.text === 'GNU GPLv3'))
        registerSupportCommand(plugin)
        assert.equal(command.id, 'open-gitverse-support')
        assert.equal(command.name, commandName)
        command.callback()
        assert.equal(destination, expected)
    }
    for (const file of ['README.md', 'README.ru.md', 'CONTRIBUTING.md', 'docs/en/quick-start.md', 'docs/ru/quick-start.md']) {
        assert.ok(readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes(expected), file)
    }
    assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).bugs.url, expected)
})

test('autoscan slider shows minutes and manual mode in both languages', () => {
    const key = 'Scheduling Interval'
    assert.equal(legacySettingLabel(key, uiFor()), 'Auto-scan interval (minutes)')
    assert.equal(legacySettingLabel(key, uiFor({ INTERFACE_LANGUAGE: 'ru' })), 'Интервал автосканирования (минуты)')
    assert.match(legacySettingDescription(key, '', uiFor()), /0 to scan manually/)
    assert.match(legacySettingDescription(key, '', uiFor({ INTERFACE_LANGUAGE: 'ru' })), /0 для ручного запуска/)
})
