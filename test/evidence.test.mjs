import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {loadMarketEvidence, validateMarketEvidence} from '../lib/evidence.mjs';

const categoryId = '10000000-0000-4000-8000-000000000001';
function observation() {
  const sourceUrl = `https://platform.tryprofound.com/${categoryId}/Reference/aei/prompts`;
  return {schemaVersion: 1, sourceType: 'manual-browser-observation', observationId: 'test-observation', observedAtUTC: '2026-10-03T18:00:00Z', dataset: {brand: 'Reference brand', categoryId}, dateRange: {start: '2026-09-28', endInclusive: '2026-10-02', platformFilter: 'Selected dashboard filters; not independently inspected'}, sourceUrl, prompts: [{id: 'QUESTION-1', text: 'Which analytical workflow fits a small product team?', platformPromptId: null, topic: 'Team fit', sourceUrl, intentTags: ['team-fit'], observedMixpanelVisibilityPercent: 40, executionsShown: 20}], limitations: ['Synthetic test record, not live observation evidence.']};
}
async function fixture(t, document = observation()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-control-evidence-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'evidence'));
  const relative = 'evidence/test.json';
  const raw = JSON.stringify(document, null, 2) + '\n';
  await fs.writeFile(path.join(root, relative), raw);
  return {root, relative, raw};
}

test('loader preserves provenance, computes exact raw-byte hash, and never claims an API connection', async t => {
  const {root, relative, raw} = await fixture(t);
  const evidence = await loadMarketEvidence(root, relative);
  assert.equal(evidence.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(evidence.sourceType, 'manual-browser-observation');
  assert.equal(evidence.prompts[0].executionsShown, 20);
  assert.equal(evidence.prompts[0].platformPromptId, null);
  assert.equal(evidence.connected, undefined);
  assert.equal(evidence.liveAPIConnected, undefined);
  await fs.appendFile(path.join(root, relative), '\n');
  assert.notEqual((await loadMarketEvidence(root, relative)).sha256, evidence.sha256);
});
test('absent configuration returns null while a configured missing file fails explicitly', async t => {
  const {root} = await fixture(t);
  assert.equal(await loadMarketEvidence(root, null), null);
  await assert.rejects(loadMarketEvidence(root, 'evidence/missing.json'), error => error.code === 'EVIDENCE_MISSING');
});
test('evidence cannot read other build files, traversal paths, or symlinks outside its subtree', async t => {
  const {root} = await fixture(t);
  await fs.writeFile(path.join(root, 'outside.json'), JSON.stringify(observation()));
  await fs.symlink(path.join(root, 'outside.json'), path.join(root, 'evidence', 'escape.json'));
  for (const relative of ['outside.json', 'evidence/../outside.json', 'evidence/escape.json', path.join(root, 'outside.json')]) await assert.rejects(loadMarketEvidence(root, relative), error => error.code === 'UNSAFE_EVIDENCE_PATH');
});
test('an evidence directory symlink cannot point outside the build root', async t => {
  const {root} = await fixture(t);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-control-evidence-outside-test-'));
  t.after(() => fs.rm(other, {recursive: true, force: true}));
  await fs.writeFile(path.join(other, 'test.json'), JSON.stringify(observation()));
  await fs.rm(path.join(root, 'evidence'), {recursive: true});
  await fs.symlink(other, path.join(root, 'evidence'));
  await assert.rejects(loadMarketEvidence(root, 'evidence/test.json'), error => error.code === 'UNSAFE_EVIDENCE_PATH');
});
test('unknown credential fields, asserted live connections, and supplied hashes fail without echoing content', async t => {
  for (const field of ['apiKey', 'liveAPIConnected', 'sha256']) {
    const data = {...observation(), [field]: 'sensitive-test-value'};
    const {root, relative} = await fixture(t, data);
    await assert.rejects(loadMarketEvidence(root, relative), error => error.code === 'INVALID_EVIDENCE' && !error.message.includes('sensitive-test-value'));
  }
});
test('duplicate IDs, malformed metrics, unsupported URLs, and oversized prompt collections fail', () => {
  const cases = [];
  let data = observation(); data.prompts.push({...data.prompts[0]}); cases.push(data);
  data = observation(); data.prompts[0].observedMixpanelVisibilityPercent = 101; cases.push(data);
  data = observation(); data.prompts[0].executionsShown = -1; cases.push(data);
  data = observation(); data.prompts[0].text = 'x'.repeat(1001); cases.push(data);
  data = observation(); data.prompts = Array.from({length: 51}, (_, i) => ({...data.prompts[0], id: `QUESTION-${i}`})); cases.push(data);
  data = observation(); data.sourceUrl = 'javascript:alert(1)'; cases.push(data);
  data = observation(); data.sourceUrl += '?token=sensitive-test-value'; cases.push(data);
  data = observation(); data.dataset.confirmedFacts = {monthlyPrice: 1}; cases.push(data);
  data = observation(); data.dateRange.start = '2026-02-31'; cases.push(data);
  for (const bad of cases) assert.throws(() => validateMarketEvidence(bad, {requireHash: false}), error => error.code === 'INVALID_EVIDENCE');
});
test('invalid JSON and oversized files fail without reading arbitrary content into evidence', async t => {
  const {root, relative} = await fixture(t);
  await fs.writeFile(path.join(root, relative), '{invalid');
  await assert.rejects(loadMarketEvidence(root, relative), /valid UTF-8 JSON/);
  await fs.writeFile(path.join(root, relative), 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(loadMarketEvidence(root, relative), /128 KiB/);
});
