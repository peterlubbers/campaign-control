import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assetFolder, reserveFolder} from '../lib/storage.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-control-storage-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('readable asset folders preserve identity and contain unsafe title characters', () => {
  assert.equal(assetFolder({id:'VID-001', channel:'video', title:'Meet Fictitious AI'}), 'video/VID-001-meet-fictitious-ai');
  assert.equal(assetFolder({id:'VID-002', channel:'video', title:'../../Café / launch?'}), 'video/VID-002-cafe-launch');
  assert.throws(() => assetFolder({id:'../../escape', channel:'video', title:'Example'}));
  assert.throws(() => assetFolder({id:'VID-001', channel:'../escape', title:'Example'}));
});

test('concurrent version allocation never overwrites earlier reviewed bytes', async t => {
  const root = await fixture(t);
  const dirs = await Promise.all(Array.from({length:8}, () => reserveFolder(root, 'assets/video/VID-001-launch', 'v')));
  assert.equal(new Set(dirs).size, 8);
  for (const dir of dirs) await fs.writeFile(path.join(root, dir, 'video.mp4'), dir);
  assert.equal(await reserveFolder(root, 'assets/video/VID-001-launch', 'v'), 'assets/video/VID-001-launch/v09');
  for (const dir of dirs) assert.equal(await fs.readFile(path.join(root, dir, 'video.mp4'), 'utf8'), dir);
});

test('folder allocation refuses traversal and replaced parent symlinks', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.symlink(outside, path.join(root, 'assets'));
  await assert.rejects(reserveFolder(root, 'assets/video', 'v'), /regular directory/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(reserveFolder(root, '../outside', 'v'), /Invalid output folder/);
  await assert.rejects(reserveFolder(root, 'drafts', '../escape'), /Invalid output folder/);
});
