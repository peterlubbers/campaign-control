import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfound} from '../lib/profound.mjs';
const org = '10000000-0000-4000-8000-000000000001';
const category = '10000000-0000-4000-8000-000000000002';
const env = {PROFOUND_API_KEY: 'test-secret-only', PROFOUND_ORGANIZATION_ID: org, PROFOUND_CATEGORY_ID: category, PROFOUND_DATASET_CONFIRMED: 'assigned-hackathon'};
const params = {startDate: '2026-10-01', endDate: '2026-10-03'};
const reply = body => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
test('unconfigured or unconfirmed evidence never fetches account data', async () => {
  let calls = 0;
  for (const config of [{}, {...env, PROFOUND_DATASET_CONFIRMED: ''}]) {
    const p = createProfound({env: config, fetchImpl: async () => { calls++; }});
    assert.equal(p.profoundStatus().connected, false);
    await assert.rejects(p.fetchCitationEvidence(params));
  }
  assert.equal(calls, 0);
});
test('only queries selected verified organization/category, with honest ranked-slice evidence', async () => {
  const calls = [];
  const p = createProfound({env, fetchImpl: async (url, init) => {
    calls.push({url, init});
    assert.equal(init.headers['X-API-Key'], 'test-secret-only');
    if (init.method === 'GET') return reply([{id: category, organization: {id: org}}]);
    const query = JSON.parse(init.body);
    assert.equal(query.category_id, category);
    return reply({info: {total_rows: 7, query}, data: [{dimensions: ['https://www.youtube.com/watch?v=example'], metrics: [12, 0.4]}]});
  }});
  const result = await p.fetchCitationEvidence(params);
  assert.equal(calls[0].url, `https://api.tryprofound.com/v1/org/categories?organization_ids=${org}`);
  assert.equal(calls[1].url, 'https://api.tryprofound.com/v1/reports/citations');
  assert.equal(result.rows[0].channel, 'youtube');
  assert.equal(result.rows[0].citationCount, 12);
  assert.equal(result.truncated, true);
  assert.equal(result.source, 'profound-live-api');
  assert.equal(result.reportHash.length, 64);
  assert.equal(p.profoundStatus().connected, true);
  assert.ok(!JSON.stringify(result).includes('test-secret-only'));
});
test('wrong organization does not proceed to the report query', async () => {
  let calls = 0;
  const p = createProfound({env, fetchImpl: async () => { calls++; return reply([{id: category, organization: {id: category}}]); }});
  await assert.rejects(p.fetchCitationEvidence(params), /not verified/);
  assert.equal(calls, 1);
});
test('malformed or unsafe citation evidence fails rather than fabricating metrics', async () => {
  for (const row of [{dimensions: ['javascript:alert(1)'], metrics: [1, 0.1]}, {dimensions: ['https://example.com'], metrics: ['unknown', 0.1]}, {dimensions: ['https://example.com'], metrics: [1]}]) {
    const p = createProfound({env, fetchImpl: async (_, init) => init.method === 'GET' ? reply([{id: category, organization: {id: org}}]) : reply({info: {total_rows: 1}, data: [row]})});
    await assert.rejects(p.fetchCitationEvidence(params));
    assert.equal(p.profoundStatus().connected, false);
  }
});
