// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict')
const { test } = require('node:test')
const createClassList = require('./dom-class-list.cjs')
const { load } = require('./benchmark/migration-modules.cjs')

test('expanding and restoring a modal keeps its normal width class, scroll and translated control', async () => {
    const { 'modal-layout': { installModalLayout } } = await load(['modal-layout'], {
        setIcon(element, name) { element.icon = name },
    })
    for (const lang of ['en', 'ru']) {
        const button = { classList: createClassList(), setAttribute(key, value) { this[key] = value } }
        let created = false
        const modalEl = {
            classList: createClassList(),
            querySelector: name => name === '.anki-modal-size' && created ? button : null,
            createEl() { created = true; return button },
        }
        const titleEl = { classList: createClassList() }
        const contentEl = { scrollTop: 177, scrollLeft: 3 }
        modalEl.classList.add('rudonium-modal-48rem')
        const ui = (en, ru) => lang === 'ru' ? ru : en
        const modal = { modalEl, contentEl, titleEl }
        installModalLayout(modal, ui)
        assert.equal(button['aria-pressed'], 'false')
        button.onclick()
        assert.ok(modalEl.classList.contains('rudonium-modal-expanded'))
        assert.equal(button['aria-label'], ui('Restore Window Size', 'Восстановить размер окна'))
        assert.equal(button.icon, 'minimize-2')
        installModalLayout(modal, ui)
        button.onclick()
        assert.equal(modalEl.classList.contains('rudonium-modal-expanded'), false)
        assert.ok(modalEl.classList.contains('rudonium-modal-48rem'))
        assert.equal(button['aria-label'], ui('Expand Window', 'Развернуть окно'))
        assert.equal(button['aria-pressed'], 'false')
        assert.deepEqual(contentEl, { scrollTop: 177, scrollLeft: 3 })
    }
})
