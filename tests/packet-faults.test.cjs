// SPDX-License-Identifier: GPL-3.0-only
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {execFileSync} = require('node:child_process')
const path = require('node:path')
const { exercise } = require('./benchmark/changed-oneway.cjs')
const overlay = require('../Build/overlay-source.cjs')

for (const packed of [true,false]) test('Batch retry preserves successful fields and pending IDs · '+(packed?'one file':'many files'), () => {
    const result = execFileSync(process.execPath,[path.join(__dirname,'benchmark/single-sync.mjs'),overlay.directory,
        '130','1','--offline-start','--packet-faults',...(packed?['--one-file','--plain-remnote']:[])],{encoding:'utf8'})
    assert.equal(JSON.parse(result).size,130)
})

test('one-way export keeps remote-only fields and tags across an applied packet with a lost acknowledgement', async () => {
    const result = await exercise(path.resolve(__dirname,'..'),700,11,true)
    assert.equal(result.interrupted,true)
})
