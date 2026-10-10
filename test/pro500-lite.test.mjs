import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {referencedCampaignFiles, isBundledSample} from '../lib/sample-fingerprint.mjs';
import {renderAsset} from '../lib/render.mjs';
import {loadBrand} from '../lib/brand.mjs';

const lite = fileURLToPath(new URL('../fictitious-ai/campaigns/pro500-lite/',import.meta.url));
const original = fileURLToPath(new URL('../fictitious-ai/campaigns/pro500/',import.meta.url));

test('Pro500 Lite is self-contained, within the 20-file budget, and preserves original source bindings', async () => {
  const {campaign,files} = await referencedCampaignFiles(lite);
  assert.equal(campaign.id,'pro500-lite');
  assert.deepEqual(campaign.assets.map(a=>a.id),['WEB002','EML001','SAL-004']);
  const walk = async directory => {
    const results = [];
    for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
      if (['working','releases','.campaign-control','READY-TO-PUBLISH','.DS_Store'].includes(entry.name)) continue;
      const file = path.join(directory,entry.name);
      assert.equal(entry.isSymbolicLink(),false);
      if(entry.isDirectory()) results.push(...await walk(file));
      else results.push(path.relative(lite,file));
    }
    return results;
  };
  const shipped = await walk(lite);
  assert.equal(shipped.length,18);
  assert.ok(shipped.length<=20);
  assert.deepEqual(shipped.sort(),[...files.map(f=>f.path),'README.md'].sort());
  assert.equal(await isBundledSample(lite),false);
  for (const asset of campaign.assets) {
    assert.equal(asset.source,asset.files.find(f=>f.role==='editable-source').path);
    const source = await fs.readFile(path.join(lite,asset.source));
    const hash = createHash('sha256').update(source).digest('hex');
    for (const file of asset.files) {
      const bytes = await fs.readFile(path.join(lite,file.path));
      assert.deepEqual(bytes,await fs.readFile(path.join(original,file.path)));
      if (file.path.endsWith('.json')) assert.equal(JSON.parse(bytes).sourceSha256,hash);
    }
  }
});

test('all three lite sources render with publisher metadata without native media tools or AI', async t => {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-lite-'));
  t.after(()=>fs.rm(destination,{recursive:true,force:true}));
  const campaign = JSON.parse(await fs.readFile(path.join(lite,'campaign.json'),'utf8'));
  const brand = await loadBrand(path.join(lite,'brand/identity.json'));
  for (const asset of campaign.assets) {
    const markdown = await fs.readFile(path.join(lite,asset.source),'utf8');
    const result = await renderAsset({asset,markdown,outputDir:path.join(destination,asset.id),facts:campaign.facts,brand});
    assert.ok(result.checks.length);
    assert.deepEqual(result.checks.filter(c=>c.status!=='pass'),[]);
    assert.ok(result.files.some(f=>f.role==='publisher-metadata'));
  }
});
