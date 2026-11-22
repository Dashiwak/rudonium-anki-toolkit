// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {execFileSync} = require("node:child_process");
const {overrideDirectoryHints} = require("./fixtures/directory-hints.cjs");
const {scanTree, writeZip, readZip, hashFile} = require("../Build/workflow-files.cjs");
const {recordBuild, prepareRelease, verifyBuild, verifyReplaceableBuild} = require("../Build/prepare-release.cjs");
const id = "rudonium-anki-toolkit", version="0.10.6", baseId = "b".repeat(64);
const install = "Rudonium-0.10.6-Install.zip", repository = "Rudonium-0.10.6-Repository.zip";
const put = (root,name,body) => {
    const file = path.join(root,name);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,body);
};
function fixture(t, legacy=false, prepareRuntime) {
    const family=fs.mkdtempSync(path.join(os.tmpdir(),"rudonium-release-test-"));
    t.after(()=>fs.rmSync(family,{recursive:true,force:true}));
    const repo=path.join(family,id), build=path.join(family,"Rudonium-Builds",version);
    const runtime=legacy ? path.join(build,"install",id) : path.join(build,"install");
    const notices=legacy ? runtime : path.join(build,"notices");
    const commit = () => { git(["add","--all"]); git(["-c","user.name=QA","-c","user.email=qa@example.invalid","commit","-qm","fixture"]); };
    const git = args => execFileSync("git",["-C",repo,...args],{encoding:"utf8"});
    const files={"manifest.json":JSON.stringify({id,version}),"styles.css":"body {}","LICENSE":"license","NOTICE.md":"notice"};
    for (const [name,body] of Object.entries(files)) { put(repo,name,body); put(name==="LICENSE" || name==="NOTICE.md" ? notices : runtime,name,body); }
    put(repo,".gitignore","node_modules/\n");
    git(["init","-q"]); commit();
    put(repo,".github/workflows/CI.yml","source added after commit\n");
    put(repo,"one.md","working tree bytes\n");
    put(runtime,"main.js","module.exports = {};\n");
    if (prepareRuntime) prepareRuntime(notices);
    let oldHash;
    const sourceManifest=scanTree(repo), params={version,baseVersion:"0.10.4",baseId,sourceManifest};
    if (legacy) {
        const oldZip = path.join(build,"install",install);
        const entries = fs.readdirSync(runtime).map(name => ({name:id+"/"+name,data:fs.readFileSync(path.join(runtime,name))}));
        writeZip(oldZip, [{name:"INSTALL.txt",data:Buffer.from("install")}, ...entries]);
        oldHash=hashFile(oldZip);
        const assets = Object.fromEntries(fs.readdirSync(runtime).map(name=>[name, hashFile(path.join(runtime,name))]));
        put(build,"SOURCE-MANIFEST.json",JSON.stringify(sourceManifest));
        put(build,"BUILD-INFO.json",JSON.stringify({schema:1,pluginId:id,version,baseVersion:params.baseVersion,
            baseId,sourceId:sourceManifest.id,result:"built",assets,installer:{name:install,sha256:oldHash}}));
    } else {
        recordBuild(build,params);
        assert.deepEqual(fs.readdirSync(runtime).sort(), ["main.js", "manifest.json", "styles.css"]);
        assert.equal(fs.existsSync(path.join(build, "release")), false);
    }
    assert.equal(verifyBuild(build,params).result,"built");
    return {repo,build,runtime,notices,params,commit,git,sourceManifest,family,oldHash};
}
test("Uses built bytes, archives new uncommitted files, verifies subsequent commit without rewriting the release",async t=>{
    const f=fixture(t,true), head=f.git(["rev-parse","HEAD"]).trim();
    const result=await prepareRelease(f.repo,{version,id:f.sourceManifest.id}), dir=result.directory;
    assert.equal(result.releaseCommit,null);
    assert.equal(f.git(["rev-parse","HEAD"]).trim(),head);
    const info=JSON.parse(fs.readFileSync(path.join(dir,"RELEASE-INFO.json")));
    assert.equal(info.status,"prepared"); assert.equal(info.releaseCommit,null); assert.equal(info.observedHead,head);
    assert.equal(info.baseId,baseId); assert.equal(info.sourceId,f.sourceManifest.id);
    assert.equal(hashFile(path.join(dir,install)),f.oldHash);
    assert.equal(hashFile(path.join(dir,repository)),hashFile(result.repositoryArchive));
    const archive=readZip(result.repositoryArchive);
    assert.ok(archive.has(id+"/.github/workflows/CI.yml")); assert.ok(archive.has("RESTORE.md"));
    assert.equal(JSON.parse(archive.get("SOURCE-MANIFEST.json")).id,f.sourceManifest.id);
    const checksums=fs.readFileSync(path.join(dir,"SHA256SUMS.txt"),"utf8");
    for (const name of fs.readdirSync(dir)) if (name!=="SHA256SUMS.txt") assert.ok(checksums.includes(hashFile(path.join(dir,name))+"  "+name+"\n"));
    assert.equal(checksums.includes("  SHA256SUMS.txt"),false);
    const before=fs.statSync(path.join(dir,"RELEASE-INFO.json")).mtimeMs;
    f.commit();
    const again=await prepareRelease(f.repo);
    assert.equal(again.releaseCommit,f.git(["rev-parse","HEAD"]).trim());
    assert.equal(fs.statSync(path.join(dir,"RELEASE-INFO.json")).mtimeMs,before);
    assert.equal(fs.readFileSync(path.join(dir,"SHA256SUMS.txt"),"utf8"),checksums);
});
test("Rejects a changed working file, asset or selected version",async t=>{
    const f=fixture(t);
    await assert.rejects(prepareRelease(f.repo,{version:"0.10.5"}),/requires version/);
    await assert.rejects(prepareRelease(f.repo,{id:"c".repeat(64)}),/differ from the selected/);
    put(f.repo,"one.md","new content"); await assert.rejects(prepareRelease(f.repo),/Source contents changed: one.md/);
    put(f.repo,"one.md","working tree bytes\n");
    put(f.runtime,"main.js","bad"); await assert.rejects(prepareRelease(f.repo),/Changed or missing installation files: main.js/);
    assert.equal(fs.existsSync(path.join(f.build,"release")),false);
});
test("Preserves a different Incoming copy and detects tampering in an existing release",async t=>{
    const f=fixture(t), incoming=path.join(f.family,"Rudonium-Incoming");
    put(incoming,repository,"preserve");
    await assert.rejects(prepareRelease(f.repo),/different full source archive/);
    assert.equal(fs.readFileSync(path.join(incoming,repository),"utf8"),"preserve");
    assert.equal(fs.existsSync(path.join(f.build,"release")),false);
    fs.unlinkSync(path.join(incoming,repository));
    const result=await prepareRelease(f.repo);
    put(result.directory,"main.js","bad");
    await assert.rejects(prepareRelease(f.repo),/Changed or unexpected release files: main.js/);
    assert.equal(fs.readFileSync(path.join(result.directory,"main.js"),"utf8"),"bad");
});
test("keeps nested install files when entry type hints disagree with the filesystem", async t => {
    overrideDirectoryHints(t, (dir, name) => {
        if (path.basename(dir) === "notices" && name === "LICENSES") return "file";
        if (path.basename(dir) === "LICENSES" && name === "notice") return "directory";
    });
    const f = fixture(t, false, runtime => put(runtime, "LICENSES/notice", "license bytes"));
    const info = JSON.parse(fs.readFileSync(path.join(f.build, "BUILD-INFO.json")));
    assert.equal(info.notices["LICENSES/notice"], hashFile(path.join(f.notices, "LICENSES/notice")));
    const release = await prepareRelease(f.repo, {version, id:f.sourceManifest.id});
    const bytes = readZip(path.join(release.directory, install)).get(id + "/LICENSES/notice");
    assert.deepEqual(bytes, Buffer.from("license bytes"));
});
test("refuses to replace unknown build files and validates a previously prepared legacy release", async t => {
    for (const legacy of [true, false]) {
        const f = fixture(t, legacy);
        assert.equal(verifyReplaceableBuild(f.build, f.params).schema, legacy ? 1 : 2);
        const release = await prepareRelease(f.repo);
        verifyReplaceableBuild(f.build, f.params);
        fs.mkdirSync(path.join(f.build,"my-files"));
        assert.throws(() => verifyReplaceableBuild(f.build, f.params), /Unexpected build directory/);
        fs.rmdirSync(path.join(f.build,"my-files"));
        put(f.build,"keep.txt","personal file");
        assert.throws(() => verifyReplaceableBuild(f.build, f.params), /Unexpected build file/);
        fs.unlinkSync(path.join(f.build,"keep.txt"));
        put(release.directory, "main.js", "changed");
        assert.throws(() => verifyReplaceableBuild(f.build, f.params), /Changed previous release files/);
    }
});
test("keeps an earlier verified same-version Repository.zip when preparing a revised build", async t => {
    const f = fixture(t);
    const previous = await prepareRelease(f.repo);
    const history = path.join(f.family,"Rudonium-Builds","previous-releases",version+"-"+f.sourceManifest.id);
    fs.mkdirSync(path.dirname(history));
    fs.renameSync(previous.directory,history);
    const original = hashFile(previous.repositoryArchive);
    put(f.repo,"one.md","new revision");
    const sourceManifest = scanTree(f.repo);
    fs.rmSync(path.join(f.build,"SOURCE-MANIFEST.json"));
    fs.rmSync(path.join(f.build,"BUILD-INFO.json"));
    recordBuild(f.build,{...f.params,sourceManifest});
    const updated = await prepareRelease(f.repo);
    assert.equal(hashFile(previous.repositoryArchive),original);
    assert.notEqual(updated.repositoryArchive,previous.repositoryArchive);
    assert.equal(hashFile(updated.repositoryArchive),hashFile(path.join(updated.directory,repository)));
    assert.equal((await prepareRelease(f.repo)).repositoryArchive,updated.repositoryArchive);
});
