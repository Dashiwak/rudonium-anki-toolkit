// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { load } = require('./benchmark/migration-modules.cjs')
const page = (id, question = 'Q', tail = '') => '# ' + question + ' #anki-page\n<!--ID: ' + id + '-->\nAnswer\n' + tail

async function fixture(t, initial) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rudonium-page-id-vault-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const root = path.join(tmp, 'Vault'), archives = path.join(tmp, 'Backups')
    const files = new Map(), leaves = [], calls = [], hooks = {}
    let revision = 0, locked = false
    const read = name => fs.readFileSync(path.join(root, name), 'utf8')
    function write(name, data) {
        const disk = path.join(root, name)
        fs.mkdirSync(path.dirname(disk), { recursive: true }); fs.writeFileSync(disk, data)
        if (name.endsWith('.md') && !name.startsWith('.')) {
            const file = files.get(name) ?? { path: name, extension: 'md' }
            const stat = fs.statSync(disk)
            file.stat = { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs }
            files.set(name, file)
        }
        revision++
    }
    for (const [name, data] of Object.entries(initial)) write(name, data)
    const zips = () => fs.existsSync(archives) ? fs.readdirSync(archives).filter(x => x.startsWith('Obsidian-Backup-')).map(x => path.join(archives,x,'Obsidian.zip')) : []
    class MarkdownView {}
    class Notice { setMessage(message) { hooks.notice?.(message, archives) } hide() {} }
    const plugin = { settings: { PAGE_ID_LOCATION: 'yaml', Defaults: { 'ID Comments': true }, VAULT_BACKUP: { directory: archives, enabled: false, includeAnki: true },
        ARCHIVE_TRANSFER: { useForBackups: true, includeFolders: ['Scope'] } },
        app: { vault: { adapter: { getBasePath: () => root }, getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: key => files.get(key),
            read: async f => read(f.path),
            async process(f, callback) {
                assert.ok(zips().length, 'the full ZIP was committed before any file change')
                calls.push(f.path)
                await hooks.beforeWrite?.(f)
                write(f.path, callback(read(f.path)))
                await hooks.afterWrite?.(f)
            } }, workspace: { getLeavesOfType: () => leaves } } }
    const modules = await load(['page-id-bulk','vault-id-index','vault-backup','vault-backup-zip','page-id-move','id-marker-conversion',
        'page-card','duplicate-markers','anki-id-marker','id-marker-literals','page-migration-router','migration-markdown',
        'interface-language','card-format-presets','export-recovery','page-id-location'], {
        MarkdownView, Notice, hasPendingAnkiWrite: () => false, hasPendingBidirectionalWrite: () => false,
        withFastScanReadLock: async (_plugin, fn) => { if (locked) throw Error('scan in progress'); locked = true
            try { return await fn(() => revision, () => 0) } finally { locked = false } },
    })
    const engine = modules['page-id-bulk']
    return { plugin, root, calls, hooks, read, write, zips, leaves,
        dirty: (name, content) => leaves.push({view: Object.assign(new MarkdownView(), { file: files.get(name), data: read(name),
            getMode: () => 'source', getViewData: () => content })}),
        preview: (src = 'all', dst = 'yaml') => engine.previewPageIdBulk(plugin, src, dst),
        apply: (plan, paths) => engine.applyPageIdBulk(plugin, plan, paths && new Set(paths)),
        restore: async zip => { const output = path.join(tmp,'Restored'); await modules['vault-backup-zip'].restoreVaultZip(zip, output); return output },
        where: name => modules['page-card'].readPageCard(read(name), { Basic: '@page' }, plugin.settings.Syntax) }
}

test('all-vault conversion verifies a full restorable ZIP, including plugin state, ignored folders and binary files', async t => {
    const original = { 'Scope/A.md': '\uFEFF---\r\ncity: Vienna\r\n---\r\n' + page(101, 'One', '<!--rudonium-answer-end-->\nprivate :: value\n').replace(/\n/g,'\r\n'),
        'Outside/B.md': page(102), 'Outside/Ordinary.md': 'Question :: Answer\n<!--ID: 13-->', 'Outside/New.md': '# Not linked #anki-page\nA',
        '.obsidian/plugins/example/data.json': '{"user":"keep"}', 'media/pic.bin': Buffer.from([0,255,0,93]) }
    const h=await fixture(t,original), plan=await h.preview()
    assert.equal(plan.scanned,4); assert.deepEqual(Array.from(plan.files,r=>r.path),['Outside/B.md','Scope/A.md'])
    assert.equal(h.zips().length,0); assert.equal(h.calls.length,0)
    const result=await h.apply(plan)
    assert.equal(result.changed,2); assert.equal(h.zips().length,1); assert.equal(result.backupPath,h.zips()[0])
    assert.equal(h.where('Scope/A.md').id,101); assert.equal(h.where('Outside/B.md').idLocation,'yaml')
    assert.ok(h.read('Scope/A.md').includes('\r\ncity: Vienna\r\n'))
    assert.ok(h.read('Scope/A.md').endsWith('<!--rudonium-answer-end-->\r\nprivate :: value\r\n'))
    const restored=await h.restore(result.backupPath)
    for (const [name,value] of Object.entries(original)) assert.deepEqual(fs.readFileSync(path.join(restored,name)),Buffer.from(value))
    const again=await h.preview(); assert.equal(again.files.length,0)
    assert.equal((await h.apply(again)).changed,0); assert.equal(h.zips().length,1)
    await assert.rejects(h.apply(plan),/preview/i)
})

test('source selection moves pages in every pair of locations, selected subset only, ID and fields preserved', async t=>{
    const h=await fixture(t,{'A.md':page(122),'B.md':page(123,'Second')})
    const dirs=['heading','yaml','after-answer']
    for(const src of dirs){
        if(h.where('A.md').idLocation!==src) await h.apply(await h.preview('all',src),['A.md'])
        for(const dst of dirs.filter(x=>x!==src)){
            const plan=await h.preview(src,dst)
            assert.ok(plan.files.some(row=>row.path==='A.md' && row.from===src))
            await h.apply(plan,['A.md'])
            const moved=h.where('A.md')
            assert.equal(moved.id,122);assert.equal(moved.front,'Q');assert.equal(moved.back,'Answer');assert.equal(moved.idLocation,dst)
            assert.equal(h.read('B.md'),page(123,'Second'))
            await h.apply(await h.preview(dst,src),['A.md'])
        }
    }
})

test('ordinary blocks, foreign links, open editor duplicates, ambiguous and annotated pages are left for review',async t=>{
    const h=await fixture(t,{'Keep.md':page(501),'Ordinary.md':'Q :: A\n<!--ID: 501-->','Y.md':page(502),
        'Yanki.md':"---\nnoteId: '502'\n---\nword\n\n---\nsense",'Draft.md':'Other','Open.md':page(503),
        'Busy.md':page(504),'Broken.md':'---\nanki-page-ID: not-a-number\n---\n# Broken #anki-page\nAnswer',
        'Annotated.md':'# Q #anki-page\n<!--ID: 51--> author text\nAnswer'})
    h.dirty('Draft.md','Term :: Meaning\n<!--ID: 503-->');h.dirty('Busy.md',page(504)+'unsaved')
    const plan=await h.preview()
    assert.equal(plan.files.length,0);assert.deepEqual(Array.from(plan.skipped,row=>row.path).sort(),
        ['Annotated.md','Broken.md','Busy.md','Keep.md','Open.md','Y.md'].sort())
    assert.equal((await h.apply(plan)).changed,0);assert.equal(h.zips().length,0)
})

test('an unsafe ZIP destination, a stale source and a newly claimed ID cannot modify a vault',async t=>{
    const h=await fixture(t,{'A.md':page(71),'Draft.md':'Draft'})
    h.plugin.settings.VAULT_BACKUP.directory=h.root
    await assert.rejects(h.apply(await h.preview()),/outside the vault/i)
    assert.equal(h.calls.length,0); assert.equal(h.zips().length,0)
    delete h.plugin.settings.VAULT_BACKUP.directory
    const before=await h.preview()
    h.write('A.md',page(71)+'changed\n')
    await assert.rejects(h.apply(before),/preview|ownership/i)
    const plan=await h.preview()
    h.dirty('Draft.md','Draft :: Entry\nID: 71')
    await assert.rejects(h.apply(plan),/preview|ownership/i)
    assert.equal(h.calls.length,0);assert.equal(h.zips().length,0)
})

test('a reported failure after writing rolls back all completed files and supports a fresh retry',async t=>{
    const original={'A.md':page(81),'B.md':page(82),'C.md':page(83)}
    const h=await fixture(t,original)
    let fail=true
    h.hooks.afterWrite=f=>{ if(f.path==='B.md' && fail){ fail=false;throw Error('drive failed after the write') } }
    await assert.rejects(h.apply(await h.preview()),/Verified full vault ZIP:[^]*Obsidian\.zip/)
    for (const [name,content] of Object.entries(original)) assert.equal(h.read(name),content)
    assert.equal(h.zips().length,1)
    assert.equal((await h.apply(await h.preview())).changed,3)
})

test('a competing edit survives rollback and a newly introduced owner blocks the rest of the transaction',async t=>{
    const original={'A.md':page(91),'B.md':page(92),'Draft.md':'draft'}
    const h=await fixture(t,original)
    let injected=false
    h.hooks.afterWrite=f=>{ if(f.path!=='B.md'||injected)return;injected=true
        h.write('Draft.md','Other :: Same\nID: 91');h.write('A.md',h.read('A.md')+'new author text\n') }
    await assert.rejects(h.apply(await h.preview()),error=>/Obsidian\.zip/.test(error.message) && error.message.includes('Check these files: A.md'))
    assert.equal(h.read('B.md'),original['B.md'])
    assert.ok(h.read('A.md').endsWith('new author text\n'));assert.ok(h.read('Draft.md').endsWith('ID: 91'))
    assert.equal(h.zips().length,1)
})


test('a damaged full-vault ZIP cannot authorize the first Markdown write',async t=>{
    const note=page(111), h=await fixture(t,{'A.md':note, '.obsidian/app.json':'{}', 'Files/blob.bin':Buffer.from('payload')})
    let corrupted=false
    h.hooks.notice=(message,directory)=>{
        if(corrupted || !message.includes(' · verify'))return
        const stage=fs.readdirSync(directory).find(name=>name.startsWith('.pending-'))
        assert.ok(stage)
        const archive=path.join(directory,stage,'Obsidian.zip')
        const size=fs.statSync(archive).size
        fs.truncateSync(archive,Math.floor(size/2))
        corrupted=true
    }
    await assert.rejects(h.apply(await h.preview()))
    assert.equal(corrupted,true);assert.equal(h.calls.length,0)
    assert.equal(h.read('A.md'), note);assert.equal(h.zips().length,0)
})

test('ID conversion retains a numbered page pause across all three destinations and defers a pending delete', async t => {
    const prefix = '# Q #anki-page\r\n'
    const tail = 'Answer\r\n<!--rudonium-answer-end-->\r\nA private example\r\nDELETE\r\nID: 77\r\n'
    const before = prefix + 'пАуЗа_1,3\r\n<!--ID: 19-->\r\n' + tail
    const deleting = prefix + 'УдАлИтЬ[.]\r\n<!--ID: 20-->\r\nAnswer'
    const h = await fixture(t, { 'Pause.md':before, 'Delete.md':deleting })
    h.plugin.settings.Syntax = { 'Suspend Line': 'Пауза', 'Delete Note Line': 'Удалить[.]' }
    for (const [src, dst] of [['heading','yaml'],['yaml','after-answer'],['after-answer','heading']]) {
        const plan = await h.preview(src,dst)
        assert.deepEqual(Array.from(plan.files, row => row.path), ['Pause.md'], JSON.stringify(plan))
        if (src === 'heading') assert.ok(plan.skipped.some(row => row.path === 'Delete.md' && /deletion|удаления/i.test(row.reason)))
        await h.apply(plan)
        const result = h.read('Pause.md')
        assert.ok(result.includes(prefix + 'пАуЗа_1,3\r\n'))
        assert.ok(result.endsWith('<!--rudonium-answer-end-->\r\nA private example\r\nDELETE\r\nID: 77\r\n'))
        assert.equal(h.read('Delete.md'), deleting)
        assert.equal(h.where('Pause.md').id, 19)
    }
})
