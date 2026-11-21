// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('desktop runner waits for generated specs, log directories and complete fixture replacement', async t => {
    const original = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rudonium-wdio-'));
    t.after(() => {
        process.chdir(original);
        fs.rmSync(root, { recursive: true, force: true });
    });
    process.chdir(root);
    const { config } = await import('../wdio.conf.ts');
    const put = (filename, contents = '') => {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, contents);
    };
    put('tests/defaults/test_vault_suites/basic/note.md');
    put('tests/defaults/test_vault_suites/ng_custom/note.md');
    put('tests/defaults/test_vault_suites/README.md');
    put('tests/specs_gen/obsolete.e2e.ts');
    put('tests/defaults/specs/template.e2e.ts', 'template');
    await config.onPrepare();
    assert.deepEqual(fs.readdirSync('tests/specs_gen'), ['basic.e2e.ts']);
    assert.equal(fs.readFileSync('tests/specs_gen/basic.e2e.ts', 'utf8'), 'template');
    await config.onWorkerStart('0-0', {}, ['tests/specs_gen/basic.e2e.ts', 'tests/specs/ng_custom.e2e.ts']);
    assert.deepEqual(fs.readdirSync('logs').sort(), ['basic', 'ng_custom']);

    await config.onWorkerEnd(); // A spec with no desktop results.
    assert.equal(fs.existsSync('tests/test_outputs'), false);
    const incoming = 'tests/test_config/.local/share/test_outputs';
    put(incoming + '/basic/nested/new.md', 'new');
    put(incoming + '/readme.txt', 'not a suite');
    let linked = false;
    try {
        fs.symlinkSync('new.md', incoming + '/basic/nested/linked.md');
        linked = true;
    } catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }
    put('tests/test_outputs/basic/stale.md');
    put('tests/test_outputs/other/keep.md');
    await config.onWorkerEnd();
    assert.deepEqual(fs.readdirSync(incoming), ['readme.txt']);
    assert.deepEqual(fs.readdirSync('tests/test_outputs').sort(), ['basic', 'other']);
    assert.deepEqual(fs.readdirSync('tests/test_outputs/basic'), ['nested']);
    assert.equal(fs.readFileSync('tests/test_outputs/basic/nested/new.md', 'utf8'), 'new');
    assert.ok(fs.existsSync('tests/test_outputs/other/keep.md'));
    if (linked) {
        const link = 'tests/test_outputs/basic/nested/linked.md';
        assert.ok(fs.lstatSync(link).isSymbolicLink());
        assert.equal(fs.readlinkSync(link), 'new.md');
        assert.equal(fs.readFileSync(link, 'utf8'), 'new');
    }

    fs.unlinkSync('tests/defaults/specs/template.e2e.ts');
    await assert.rejects(config.onPrepare(), { code: 'ENOENT' });
    put('logs/blocked');
    await assert.rejects(config.onWorkerStart('0-0', {}, ['blocked.e2e.ts']), { code: 'EEXIST' });
    fs.rmSync(incoming, { recursive: true });
    put(incoming, 'not a directory');
    await assert.rejects(config.onWorkerEnd(), { code: 'ENOTDIR' });
});
