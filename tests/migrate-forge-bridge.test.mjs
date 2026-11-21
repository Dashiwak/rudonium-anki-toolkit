// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import overlay from '../Build/overlay-source.cjs'

const uri = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const moduleText = name => stripTypeScriptTypes(readFileSync(overlay.file(name + '.ts'), 'utf8'))
const yamlHost = uri('export const fixtures = new Map(); export function parseYaml(input) { if (!fixtures.has(input)) throw Error("bad YAML"); return fixtures.get(input) }')
const { fixtures } = await import(yamlHost)
const { detectAnkiForge, detectAnkiBridge } = await import(uri(moduleText('migrate-forge-bridge')
    .replace("'obsidian'", JSON.stringify(yamlHost))
    .replace("'./migration-markdown'", JSON.stringify(uri(moduleText('migration-markdown'))))))
const file = 'Base/Австрия/Wien.md'
const auto = { t: en => en }
const forge = (text, settings = {}) => detectAnkiForge(file, text, { ...auto, ...settings })
const bridge = (text, settings = {}) => detectAnkiBridge(file, text, { ...auto, ...settings })

test('Forge imports the complete basic note and keeps its string anchor separate from an Anki ID', () => {
    const yaml = '"anki-deck": "Geography::Austria" # deck note\r\naliases: [Vienna] # keep\r\n'
    fixtures.set(yaml, { 'anki-deck': 'Geography::Austria', aliases: ['Vienna'] })
    const sample = '\uFEFF---\r\n' + yaml + '---\r\nСтолица? #card\r\nВена.\r\n\r\nЕщё абзац.\r\n^af-k3f8x2m1qz\r\n'
    const result = forge(sample)
    assert.equal(result.status, 'candidate')
    assert.equal(result.front, 'Столица?')
    assert.equal(result.back, 'Вена.\r\n\r\nЕщё абзац.')
    assert.equal(result.deck, 'Geography::Austria')
    assert.equal(result.externalKey, 'af-k3f8x2m1qz')
    assert.equal(result.anchor, result.externalKey)
    assert.equal(result.needsLink, true)
    assert.equal(result.id, undefined)
    assert.equal(result.prefix, '\uFEFF---\r\n# deck note\r\naliases: [Vienna] # keep\r\n---\r\n')
    assert.equal(forge('Q::A\n^af-1700000000123').id, undefined)
    assert.equal(forge('Q::A\n^af-1700000000123').needsLink, true)
})

test('Forge requires evidence for shared syntax, checks known historical state and rejects mixed cards', () => {
    const selected = { source: 'anki-forge' }
    for (const input of ['Q :: A', 'Q #card\nA']) {
        assert.equal(forge(input), undefined)
        assert.equal(forge(input, { forgeRegistryPresent: true }), undefined)
        assert.equal(forge(input, selected).status, 'candidate')
        assert.equal(forge(input, selected).needsLink, false)
        assert.equal(forge(input, { ...selected, forgeRegistryPresent: true }).needsLink, true)
    }
    assert.equal(forge('Q :: A\n^af-abcd', { source: 'flashcards' }), undefined)
    assert.equal(forge('```example\nQ::A\n^af-key\n```'), undefined)
    for (const input of ['Q:::A', 'Q::==A==', 'Q::A\n^af-ab\nOutside prose', 'Q::A\nQ2::A2', 'Q #card\nA\n\nOutside',
        'Q #card\nA #topic\n^af-ab', 'Q #card\nA\n^af-ab\n^af-ab', 'Q #card\nA\n^q-another\n^af-ab']) {
        assert.equal(forge(input, selected)?.status, 'review', input)
    }
    const yaml = 'anki-deck: "Deck"\n'
    fixtures.set(yaml, { 'anki-deck': 'Deck' })
    const file = '---\n' + yaml + '---\nQ::A'
    assert.equal(forge(file), undefined)
    assert.equal(forge(file, { forgeRegistryPresent: true }).needsLink, true)
    assert.equal(forge(file, selected).deck, 'Deck')
})

test('Bridge Basic and Dump parse official delimiters, use the source path and preserve other properties', () => {
    const settings = { bridgeRegistryPresent: true, vaultName: 'Knowledge' }
    const first = 'Question ⇢%%oab:basic:v1%%Answer'
    const basic = bridge(first, settings)
    assert.equal(basic.status, 'candidate')
    assert.equal(basic.front, 'Question')
    assert.equal(basic.back, 'Answer')
    assert.equal(basic.id, undefined)
    assert.equal(basic.needsLink, true)
    assert.equal(basic.externalKey, undefined)
    assert.equal(basic.deck, 'Obsidian Flashcards::Knowledge::Base::Австрия::Wien')
    assert.equal(bridge(first).needsLink, false)
    const dump = bridge('\uFEFF---\r\ntags: [a]\r\n---\r\nQuestion ⇢{%%oab:dump:v1%%\r\nFirst\r\n\r\n- Second\r\n}⇠%%oab:end:v1%%\r\n')
    assert.equal(dump.status, 'candidate')
    assert.equal(dump.back, 'First\r\n\r\n- Second')
    assert.equal(dump.prefix, '\uFEFF---\r\ntags: [a]\r\n---\r\n')
    assert.equal(bridge(first, { source: 'anki-forge' }), undefined)
})

test('Bridge leaves examples alone and directs unsupported templates, extra text and foreign identities to review', () => {
    const sample = 'Q ⇢%%oab:basic:v1%%A'
    for (const input of ['ordinary ⇢ sign', 'Q >> A', '```md\n' + sample + '\n```', '> ' + sample]) assert.equal(bridge(input), undefined)
    for (const input of [sample + '\nOutside', sample + '\n' + sample, sample + ' #priority',
        'Q ⇄%%oab:reverse:v1%%A', 'Q ⟦%%oab:cloze:v1%%A⟧%%oab:end:v1%%',
        'Q ⇢[%%oab:list:v1%%\n- A\n]⇠%%oab:end:v1%%', 'Q ⇢▣%%oab:image:v1%%![[a.jpg]]',
        'Q ⇢{%%oab:dump:v1%%\nA\n', 'Q ⇢{%%oab:dump:v1%%\n' + sample + '\n}⇠%%oab:end:v1%%',
        'Q ⇢{%%oab:dump:v1%%\nA\n<!--ID: 123-->\n}⇠%%oab:end:v1%%',
        sample + '\n<!--SR:!2025-01-01,5,2-->']) {
        assert.equal(bridge(input)?.status, 'review', input)
    }
})
