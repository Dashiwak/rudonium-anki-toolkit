// SPDX-License-Identifier: GPL-3.0-only
import createClassList from './dom-class-list.cjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import overlay from '../Build/overlay-source.cjs'
import { fileURLToPath } from 'node:url'

for (const layout of ['split', 'dense', 'remnote']) {
    test('bidirectional command, checkpoints and retries · ' + layout, () => {
        const directory = fileURLToPath(new URL('..', import.meta.url))
        const command = ['tests/benchmark/single-sync.mjs', overlay.directory, '20', '1']
        if (layout !== 'split') command.push('--one-file')
        if (layout === 'remnote') command.push('--plain-remnote')
        if (layout === 'dense') command.push('--browse-collision')
        const run = JSON.parse(execFileSync(process.execPath, command, { cwd: directory, encoding: 'utf8' }))
        assert.equal(run.files, layout === 'split' ? 20 : 1)
        if (layout === 'remnote') assert.equal(run.runs[0].regexpFiles, 1)
        if (layout === 'split') {
            const afterCurrent = run.runs.find(row => row.scenario === 'vault.afterCurrent')
            assert.equal(afterCurrent.reads, 1)
            assert.equal(afterCurrent.parses, 1)
        }
    })
}

async function previewHarness() {
    const { load } = await import('./benchmark/migration-modules.cjs').then(module => module.default)
    const notices = [], dialogs = []
    class Element {
        classList = createClassList()
        children = []
        constructor(text) { this.text = text }
        setText(text) { this.text = text }
        createEl(_tag, options = {}) {
            const child = new Element(options.text)
            this.children.push(child)
            return child
        }
        setAttribute(name, value) { this[name] = value }
        createDiv() { return this.createEl('div') }
        empty() { this.children = [] }
        find(text) { return (text instanceof RegExp ? text.test(this.text ?? '') : this.text === text) ? this : this.children.map(child => child.find(text)).find(Boolean) }
    }
    class Modal {
        contentEl = new Element()
        modalEl = new Element()
        titleEl = new Element()
        constructor(app) { this.app = app }
        open() { dialogs.push(this); this.onOpen() }
        close() { this.closes = (this.closes ?? 0) + 1; this.onClose() }
    }
    const api = { Modal, Notice: class { constructor(message) { notices.push(message) } }, installModalLayout() {}, renderFieldComparison() {} }
    const { 'bidirectional-ui': ui } = await load(['bidirectional-ui', 'interface-language'], api)
    const app = {}
    const preview = {scopeLabel:'Vault',profile:'Default',scanned:1,rows:[],canApply:true}
    return { ui, app, preview, notices, dialogs }
}

test('the preview closes once after a completed apply; partial writes and failures retain the report', async () => {
    const { ui, app, preview, notices, dialogs } = await previewHarness()
    for (const result of ['success','partial','throw','closed-during-apply']) {
        let finish, count=0
        const callback = (_choices, onPartial) => new Promise((resolve, reject) => {
            count++
            finish = () => {
                if (result === 'partial') onPartial()
                if (result === 'throw') reject(Error('Failed to sync'))
                else resolve('Summary')
            }
        })
        ui.openBidirectionalPreview(app,preview,callback)
        const modal=dialogs.at(-1), button=modal.contentEl.find('Apply Sync'), prior=notices.length
        button.onclick(); button.onclick()
        assert.equal(count,1)
        assert.equal(modal.closes,undefined)
        if (result === 'closed-during-apply') modal.close()
        finish(); await new Promise(resolve=>setImmediate(resolve))
        if (result === 'partial' || result === 'throw') {
            assert.equal(modal.closes,undefined)
            assert.ok(modal.contentEl.find(result === 'partial' ? 'Summary' : /Failed to sync.*refresh the preview/))
            modal.close()
        } else {
            assert.equal(modal.closes,1)
            assert.deepEqual(notices.slice(prior),['Summary'])
        }
    }
})

test('manual preview keeps explicit Skip distinct from an unresolved conflict and restores direction on reopening', async () => {
    const { ui, app, preview, dialogs } = await previewHarness()
    const key = '17:front'
    const accepted = []
    const open = (decision, recommendedSide, allowedSide) => {
        const change = { key, field: 'Front', obsidian: 'local', anki: 'remote', decision,
            canChooseDirection: !allowedSide, canSkip: true, recommendedSide, allowedSide }
        ui.openBidirectionalPreview(app, { ...preview, canApply: decision !== 'conflict',
            rows: [{ id: 17, path: 'History.md', changes: [change] }] }, async choices => {
            accepted.push(choices.get(key))
            return 'Done'
        })
        const modal = dialogs.at(-1)
        return text => modal.contentEl.find(text)
    }
    for (const [decision, recommended] of [['conflict', 'anki'], ['obsidian'], ['anki'], ['conflict']]) {
        const find = open(decision, recommended)
        assert.equal(find('Skip')['aria-pressed'], 'false')
        assert.equal(find('Apply Sync').disabled, decision === 'conflict' && !recommended)
        find('Obsidian → Anki').onclick()
        find('Obsidian ← Anki').onclick()
        find('Skip').onclick()
        assert.equal(find('Skip')['aria-pressed'], 'true')
        assert.ok(find(/To Anki: 0 · To Obsidian: 0.*Unresolved conflicts: 0 · Skipped: 1/))
        assert.equal(find('Apply Sync').disabled, false)
        find('Apply Sync').onclick()
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(accepted.at(-1), 'skip')
        assert.equal(dialogs.at(-1).closes, 1)
    }
    for (const [decision, allowed, forbidden] of [['anki', 'Obsidian ← Anki', 'Obsidian → Anki'], ['obsidian', 'Obsidian → Anki', 'Obsidian ← Anki']]) {
        const find = open(decision, undefined, decision)
        assert.equal(find(forbidden), undefined)
        assert.equal(find(allowed)['aria-pressed'], 'true')
        find('Skip').onclick()
        find('Apply Sync').onclick()
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(accepted.at(-1), 'skip')
    }
    const find = open('conflict', undefined, 'anki')
    assert.equal(find('Obsidian → Anki'), undefined)
    find('Skip').onclick()
    find('Obsidian ← Anki').onclick()
    assert.equal(find('Skip')['aria-pressed'], 'false')
    find('Apply Sync').onclick()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(accepted.at(-1), 'anki')
})

test('two-way settings place the mode first inside the collapsed group in both languages and roll back a failed toggle', async () => {
    const { load } = await import('./benchmark/migration-modules.cjs').then(module => module.default)
    const notices = []
    class Row {
        constructor(parent) { this.controls=[]; parent.rows.push(this) }
        setName(name) { this.name=name;return this }
        setDesc(hint) { this.hint=hint;return this }
        addButton(fn) {
            const button = {buttonEl:{},setButtonText(v){this.text=v;return this},onClick(callback){this.run=callback;return this}}
            this.controls.push(button); fn(button); return this
        }
        addToggle(fn) {
            const toggle = {setValue(v){this.value=v;return this},onChange(callback){this.change=callback;return this},
                setDisabled(v){this.disabled=v;return this}}
            this.controls.push(toggle); fn(toggle); return this
        }
    }
    class Group {
        constructor(tag = 'div', text = '') { this.tag=tag; this.text=text; this.rows=[]; this.attributes={} }
        createEl(tag, options = {}) {
            const child = new Group(tag, options.text)
            this.rows.push(child)
            return child
        }
        createDiv() { return this.createEl('div') }
        getAttribute(key) { return this.attributes[key] }
        setAttribute(key, value) { this.attributes[key]=value }
    }
    const api = { Modal: class {}, Notice:class {constructor(message){notices.push(message)}}, Setting:Row,
        withFastScanReadLock: async (_plugin,task) => task()}
    const { 'bidirectional-field-settings': ui, 'bidirectional-preview-preference': preference } = await load(
        ['bidirectional-field-settings','bidirectional-preview-preference','interface-language','settings-layout'],api)
    for (const [lang,label,preview] of [['en','Bidirectional sync','Preview every sync'],['ru','Двусторонняя синхронизация','Предпросмотр при каждом запуске']]) {
        let scans = 0
        const plugin={settings:{INTERFACE_LANGUAGE:lang},saveAllData:async()=>{},scanVault:async()=>{scans++}}
        const top = new Group()
        ui.installBidirectionalSettings(top,plugin)
        assert.equal(top.rows.length, 1)
        const [disclosure] = top.rows
        assert.equal(disclosure.tag, 'details')
        assert.equal(disclosure.open, false)
        const [summary, options] = disclosure.rows
        assert.equal(summary.text, lang === 'ru' ? 'Настройки синхронизации' : 'Sync settings')
        const [mode] = options.rows
        assert.equal(mode.name, label)
        assert.match(mode.hint, lang === 'ru'
            ? /всего хранилища.*примерно в 10 раз.*односторонний экспорт/u
            : /full vault sync.*about 10 times as long as a one-way export/u)
        const sync = mode.controls.find(control => control.text === (lang === 'ru' ? 'Синхронизировать' : 'Sync now'))
        const modeToggle = mode.controls.find(control => control.change)
        const previewButton = options.rows.flatMap(row => row.controls).find(control => control.text === (lang === 'ru' ? 'Открыть предпросмотр' : 'Preview now'))
        assert.equal(sync.buttonEl.disabled, true)
        assert.equal(previewButton.buttonEl.disabled, true)
        assert.equal(modeToggle.value, false)
        const policyName = lang === 'ru' ? 'Применять более позднюю правку' : 'Apply the newer edit'
        const policy = options.rows.find(row => row.name === policyName).controls[0]
        assert.equal(policy.value, true)
        await policy.change(false)
        assert.equal(plugin.settings.BIDIRECTIONAL_CONFLICT_POLICY, 'skip')
        const restored = new Group()
        ui.installBidirectionalSettings(restored, {...plugin,settings:{...plugin.settings}})
        const [, restoredOptions] = restored.rows[0].rows
        assert.equal(restoredOptions.rows.find(row => row.name === policyName).controls[0].value, false)
        await policy.change(true)
        assert.equal(plugin.settings.BIDIRECTIONAL_CONFLICT_POLICY, 'latest')
        await modeToggle.change(true)
        assert.equal(scans, 0)
        assert.equal(sync.buttonEl.disabled, false)
        assert.equal(previewButton.buttonEl.disabled, false)
        await sync.run()
        assert.equal(scans, 1)
        const toggle=options.rows.find(row=>row.name===preview).controls[0]
        assert.equal(toggle.value,false)
        const dialog = {rows:[]}
        const unmount = preference.addPreviewPreference(dialog, plugin, 'preview')
        const onDialog = dialog.rows[0].controls[0]
        await onDialog.change(true)
        assert.equal(toggle.value,true)
        await toggle.change(false)
        assert.equal(onDialog.value,false)
        await toggle.change(true)
        assert.equal(plugin.settings.BIDIRECTIONAL_PREVIEW,true)
        plugin.saveAllData=async()=>{throw Error('Could not save / Ошибка сохранения')}
        await toggle.change(false)
        assert.equal(plugin.settings.BIDIRECTIONAL_PREVIEW,true)
        assert.equal(toggle.value,true)
        assert.equal(onDialog.value,true)
        await policy.change(false)
        assert.equal(plugin.settings.BIDIRECTIONAL_CONFLICT_POLICY,'latest')
        assert.equal(policy.value,true)
        await modeToggle.change(false)
        assert.equal(plugin.settings.BIDIRECTIONAL_SYNC,true)
        assert.equal(sync.buttonEl.disabled,false)
        unmount()
    }
    assert.equal(notices.length,6)
})

test('direction picker includes named blocks and pages with localized main fields, excluding primary and service fields', async () => {
    const { load } = await import('./benchmark/migration-modules.cjs').then(module => module.default)
    const modules = await load(['bidirectional-field-settings', 'bidirectional-blocks', 'page-card', 'card-format-presets'], { Modal: class {} })
    const select = modules['bidirectional-field-settings'].selectableDirectionFields
    const models = {
        Page: ['Вопрос', 'Ответ', 'Импортированный', 'Ссылка', 'Место', 'FrontLang'],
        Block: ['Prompt', 'Reply', 'Extra'],
        Bridge: ['CardKey', 'Question', 'Answer', 'Notes'],
        'ob-deck-basic': ['ob-deck-id', 'ob-deck-front', 'ob-deck-back', 'ob-deck-tags', 'Notes'],
        Cloze: ['Text', 'Back Extra', 'Other'],
    }
    const settings = { CUSTOM_REGEXPS: { Page: '@page' }, FILE_LINK_FIELDS: { Page: 'Ссылка' }, CONTEXT_FIELDS: { Page: 'Место' } }
    assert.deepEqual(JSON.parse(JSON.stringify(Object.fromEntries(select(models, settings)))), {
        Page: ['Импортированный'], Block: ['Extra'], Bridge: ['Notes'], 'ob-deck-basic': ['Notes'],
    })
})
