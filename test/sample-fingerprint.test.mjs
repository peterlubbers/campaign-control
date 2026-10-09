import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {referencedCampaignFiles, isBundledSample, safeCampaignPath} from '../lib/sample-fingerprint.mjs';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);
const BUNDLED = path.join(REPO,'fictitious-ai/campaigns/pro500');

test('the prepare-drive-demo script creates an exact, private, Drive-ready copy of the 104-asset sample', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-prepare-'));
  t.after(() => fs.rm(home,{recursive:true,force:true}));
  const destination = path.join(home,'drive-copy');
  const {stdout} = await exec(process.execPath, [path.join(REPO,'scripts/prepare-drive-demo.mjs'), destination], {cwd:REPO});
  assert.match(stdout,/104 deliverables/);
  assert.match(stdout,/No Drive access or upload was attempted/);

  // The copy is byte-identical to the bundled sample, including the brand identity.
  assert.equal(await isBundledSample(destination), true, 'A copied folder fingerprints as the public demo copy');
  const manifest = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
  for (const asset of manifest.assets.slice(0, 5)) {
    if (!asset.source) continue;
    const copied = await fs.readFile(path.join(destination, ...asset.source.split('/')));
    const bundled = await fs.readFile(path.join(BUNDLED, ...asset.source.split('/')));
    assert.deepEqual(copied, bundled);
  }
  const stat = await fs.stat(path.join(destination,'brand/identity.json'));
  assert.equal(stat.mode & 0o777, 0o600, 'Copied files are private to this user');
});

test('the prepare script refuses to overwrite an existing destination', async t => {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-prepare-'));
  t.after(() => fs.rm(destination,{recursive:true,force:true}));
  await fs.writeFile(path.join(destination,'keep.txt'),'sentinel');
  const result = await exec(process.execPath, [path.join(REPO,'scripts/prepare-drive-demo.mjs'), destination], {cwd:REPO}).catch(error => error);
  assert.ok(result.code || result.stderr, 'A non-empty destination is refused');
  assert.match(String(result.stderr),/already exists|EEXIST|Could not prepare/);
  assert.equal((await fs.readFile(path.join(destination,'keep.txt'),'utf8')),'sentinel');
  assert.deepEqual(await fs.readdir(destination), ['keep.txt'], 'The existing folder is untouched');
});

test('referenced campaign files reject unsafe or oversized manifests without touching the campaign', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-fingerprint-'));
  t.after(() => fs.rm(home,{recursive:true,force:true}));
  const write = async (name, content) => {await fs.mkdir(path.join(home,name),{recursive:true}); await fs.writeFile(path.join(home,name,'campaign.json'), content); return path.join(home,name);};

  const good = await write('good', JSON.stringify({id:'x', facts:{product:'P', monthlyPrice:1, sharing:false, maxTeammates:0}, assets:[{id:'A', title:'a', channel:'website', kind:'copy', source:'a.md', required:true}]}));
  await fs.writeFile(path.join(good,'a.md'),'hello');
  const {files, campaign} = await referencedCampaignFiles(good);
  assert.deepEqual(files.map(file => file.path), ['a.md','campaign.json']);
  assert.equal(campaign.assets.length, 1);

  await assert.rejects(async () => referencedCampaignFiles(await write('bad-json','{')), /valid campaign\.json/);
  await assert.rejects(async () => referencedCampaignFiles(await write('empty-assets', JSON.stringify({assets:[]}))), /1–1,000/);
  const big = await write('oversize', JSON.stringify({id:'x', facts:{product:'P', monthlyPrice:1, sharing:false, maxTeammates:0}, assets:[{id:'A', channel:'website', source:'../escape.md'}]}));
  await fs.writeFile(path.join(home,'escape.md'),'outside');
  await assert.rejects(() => referencedCampaignFiles(big), /unsafe relative path/);
  const missing = await write('missing', JSON.stringify({id:'x', facts:{product:'P', monthlyPrice:1, sharing:false, maxTeammates:0}, assets:[{id:'A', channel:'website', source:'nope.md'}]}));
  await assert.rejects(() => referencedCampaignFiles(missing), /not a regular file|no such file/i);
});

test('safe campaign paths refuse traversal, absolute paths, and null bytes', () => {
  assert.equal(safeCampaignPath('sources/a.md'), 'sources/a.md');
  assert.equal(safeCampaignPath('a b/c-d.json'), 'a b/c-d.json');
  for (const bad of ['../up.md','/abs.md','C:\\win.md','a\\b.md','a/./b.md','a/../b.md','', 'a\0b', 'a//b.md']) {
    assert.throws(() => safeCampaignPath(bad), /unsafe relative path/, `Expected rejection for ${JSON.stringify(bad)}`);
  }
});
