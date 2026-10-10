import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../server.mjs';
import {FakeDrive, fakeDriveFromCampaign} from './helpers/fake-drive.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);
const BUNDLED = path.join(REPO,'fictitious-ai/campaigns/pro500');
const BUNDLED_BRAND = path.join(REPO,'fictitious-ai/brand/identity.json');

const syntheticCampaign = () => ({
  id:'isolated-test', name:'Synthetic launch test only',
  facts:{product:'Old Plan', monthlyPrice:20, sharing:true, maxTeammates:2},
  assets:[{id:'WEB-1', title:'Test page', channel:'website', kind:'copy', source:'sources/web.md', required:true, metadata:{}}],
});
const syntheticProvider = () => ({
  providerStatus: () => ({provider:'synthetic-test-only', configured:true, connected:false}),
  proposeAssets: async ({assets}) => ({provider:'synthetic-test-only', model:'test-only', usage:{}, requests:[], assets: assets.map(a => ({id:a.id, disposition:'changed', markdown:'# Candidate copy\nNew Plan costs $40/month.\n', reason:'Synthetic fixture.', issues:[]}))}),
  auditAssets: async ({assets}) => ({requests:[], assets: assets.map(a => ({id:a.id, status:'pass', issues:[]}))}),
});
const syntheticRender = async ({markdown, outputDir}) => {
  await fs.writeFile(path.join(outputDir,'preview.txt'), markdown);
  return {files: [{path:'preview.txt', mime:'text/plain', role:'publishable-copy'}], primaryPath:'preview.txt', textContent:markdown, checks: [{name:'Synthetic renderer identity', status:'pass', message:'Fixture bytes written.'}]};
};

async function freePort() {
  return new Promise((resolve,reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {const port = probe.address().port; probe.close(() => resolve(port));});
  });
}

async function application(t, {drive} = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-server-'));
  t.after(() => fs.rm(home,{recursive:true,force:true}));
  const campaignDir = path.join(home,'local-campaign');
  await fs.mkdir(path.join(campaignDir,'sources'),{recursive:true});
  await fs.writeFile(path.join(campaignDir,'campaign.json'), JSON.stringify(syntheticCampaign()));
  await fs.writeFile(path.join(campaignDir,'sources/web.md'), '# Original copy\nOld Plan costs $20/month.\n');
  const port = await freePort();
  const dataDirectory = path.join(home,'application-data');
  const manager = new (await import('../lib/launch-manager.mjs')).LaunchManager({
    root: REPO, dataDirectory, campaignDir, provider: syntheticProvider(), renderAsset: syntheticRender,
    driveOptions: {clientId:'test-client', clientSecret:'test-secret', driveApi:'https://drive.example.test/drive', fetchImpl: drive.fetchImpl()},
  });
  const {server} = await createApplication({
    campaignDir, dataDirectory, launchManager: manager,
    googleOptions: {
      clientId:'test-client', clientSecret:'test-secret',
      redirectUri: `http://127.0.0.1:${port}/oauth/google/callback`,
      authEndpoint:'https://auth.example.test/authorize', tokenEndpoint:'https://token.example.test/token', revokeEndpoint:'https://token.example.test/revoke',
      fetchImpl: drive.fetchImpl(),
    },
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  // undici keep-alive sockets must be dropped before close() or the suite never ends.
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, {method = 'GET', body, token, headers = {}} = {}) => {
    const response = await fetch(base + route, {
      method, redirect:'manual',
      headers: {
        ...(body !== undefined ? {'content-type':'application/json'} : {}),
        ...(token ? {'x-campaign-control-token':token} : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') || '';
    const json = contentType.includes('json') ? await response.json().catch(() => null) : null;
    const text = json === null ? await response.text() : null;
    return {status:response.status, json, text, headers:response.headers};
  };
  // Async predicates must be awaited: a bare Promise object is always truthy.
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 2000 && !(await predicate()); attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    if (!(await predicate())) throw new Error('Timed out waiting for the operation.');
  };
  return {port, base, request, manager, drive, campaignDir, waitFor};
}

test('the homepage state is a chooser that lists launches and discloses the Drive scope', async t => {
  const drive = new FakeDrive({files:new Map([['campaign.json','{}']])});
  const {request} = await application(t, {drive});
  const chooser = await request('/api/state');
  assert.equal(chooser.status, 200);
  assert.equal(chooser.json.workspace.id, 'workspace-local');
  assert.ok(Array.isArray(chooser.json.launches));
  assert.equal(chooser.json.launches.length, 1);
  assert.equal(chooser.json.launches[0].type, 'local');
  assert.equal(chooser.json.launches[0].source, 'Local filesystem');
  assert.equal(chooser.json.google.configured, true);
  assert.match(chooser.json.google.scopeDisclosure, /only reads within the campaign root you select/);
  assert.ok(chooser.json.csrfToken, 'The chooser carries the CSRF token for the first mutation');
  assert.equal(chooser.json.processingLock, null);
});

test('campaign operations require an explicit launch identity and a CSRF token', async t => {
  const drive = new FakeDrive({files:new Map([['campaign.json','{}']])});
  const {request} = await application(t, {drive});
  const chooser = await request('/api/state');
  const token = chooser.json.csrfToken;
  const scoped = id => `/api/workspaces/workspace-local/launches/${id}`;

  const unscoped = await request('/api/runs', {method:'POST', body:{brief:'anything'}, token});
  assert.equal(unscoped.status, 404);
  assert.match(unscoped.json.error, /Choose a workspace and launch/);

  const crossWorkspace = await request('/api/workspaces/workspace-other/launches/launch-local-default/state');
  assert.equal(crossWorkspace.status, 404);

  const missingToken = await request(`${scoped('launch-local-default')}/revisions`, {method:'POST', body:{}});
  assert.equal(missingToken.status, 403);
  assert.match(missingToken.json.error, /Refresh the workbench/);

  const goodToken = await request(`${scoped('launch-local-default')}/revisions`, {method:'POST', body:{}, token});
  assert.equal(goodToken.status, 200);
  assert.equal(goodToken.json.identity.launchId, 'launch-local-default');
  assert.equal(goodToken.json.capabilities.demoScopeDefault, false, 'A synthetic campaign is not the demo copy');
  assert.equal(goodToken.json.capabilities.workspaceReset, false);
});

test('OAuth return navigation may load the chooser but cross-site APIs remain blocked', async t => {
  const drive = new FakeDrive({files:new Map([['campaign.json','{}']])});
  const {base} = await application(t, {drive});
  const navigate = (route, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + route, {
      method:extra.method || 'GET',
      headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document',...extra.headers},
    }, response => {response.resume(); response.on('end', () => resolve(response.statusCode));});
    req.on('error', reject);
    req.end();
  });
  assert.equal(await navigate('/?googleConnection=test-connection'), 200);
  assert.equal(await navigate('/api/state'), 403);
  assert.equal(await navigate('/api/google/authorize', {method:'POST'}), 403);
  assert.equal(await navigate('/', {method:'POST'}), 403);
  assert.equal(await navigate('/', {headers:{'sec-fetch-mode':'cors'}}), 403);
  assert.equal(await navigate('/', {headers:{'sec-fetch-dest':'iframe'}}), 403);
  assert.equal(await navigate('/', {headers:{origin:'https://evil.example'}}), 403);
  assert.equal(await navigate('/oauth/google/callback?state=forged&code=bad'), 403);
});

test('the OAuth round trip issues one connection, rejects forged callbacks, and connects a Drive launch as a durable job', async t => {
  const drive = await fakeDriveFromCampaign(BUNDLED, {brandPath:BUNDLED_BRAND});
  const {request, manager, waitFor} = await application(t, {drive});
  const chooser = await request('/api/state');
  const token = chooser.json.csrfToken;

  // A callback with no matching authorization state is refused.
  const forged = await request('/oauth/google/callback?state=forged&code=good-code');
  assert.equal(forged.status, 403);

  const authorize = await request('/api/google/authorize', {method:'POST', body:{}, token});
  assert.equal(authorize.status, 200);
  assert.match(authorize.json.authorizationUrl, /^https:\/\/auth\.example\.test\/authorize\?/);
  const params = new URL(authorize.json.authorizationUrl).searchParams;
  assert.equal(params.get('code_challenge_method'), 'S256');
  const cookie = /cc-oauth=([A-Za-z0-9_-]+)/.exec(authorize.headers.get('set-cookie') || '')?.[1];
  assert.ok(cookie, 'The authorize response plants the browser nonce cookie');

  const callback = await request(`/oauth/google/callback?state=${encodeURIComponent(params.get('state'))}&code=good-code`, {headers:{cookie:`cc-oauth=${cookie}`}});
  assert.equal(callback.status, 303);
  const connectionId = new URL(callback.headers.get('location'), 'http://x').searchParams.get('googleConnection');
  assert.match(connectionId, /^[0-9a-f-]{36}$/);

  const connect = await request('/api/google/launches', {method:'POST', body:{connectionId, folderId:drive.rootId}, token});
  assert.equal(connect.status, 202);
  assert.ok(connect.json.jobId);
  const scoped = id => `/api/workspaces/workspace-local/launches/${id}`;
  await waitFor(async () => (await request(`/api/jobs/${connect.json.jobId}`)).json?.status === 'completed' && manager.lock === null);
  const job = (await request(`/api/jobs/${connect.json.jobId}`)).json;
  assert.equal(job.status, 'completed');
  const driveLaunch = (await request('/api/state')).json.launches.find(item => item.type === 'google-drive');
  assert.equal(job.result.launchId, driveLaunch.id);

  const list = (await request('/api/state')).json.launches;
  assert.equal(list.length, 2);
  const card = list.find(item => item.type === 'google-drive');
  assert.equal(card.sampleMatch, true);
  assert.equal(card.label, 'Pro500 — Google Drive');
  assert.equal(card.registered, 104);

  const state = await request(`${scoped(card.id)}/state`);
  assert.equal(state.status, 200);
  assert.equal(state.json.evidence.registered, 104);
  assert.equal(state.json.capabilities.demoScopeDefault, true);
  assert.equal(state.json.capabilities.workspaceReset, true);
  assert.equal(state.json.launch.type, 'google-drive');
  // A launch-bound job cannot be read through another launch's route.
  const wrongJobRoute = await request(`${scoped('launch-local-default')}/jobs/${connect.json.jobId}`);
  assert.equal(wrongJobRoute.status, 404);
});

test('runs, artifacts and approvals stay scoped to one launch identity over HTTP', async t => {
  const drive = await fakeDriveFromCampaign(BUNDLED, {brandPath:BUNDLED_BRAND});
  const {request, manager, waitFor} = await application(t, {drive});
  const chooser = await request('/api/state');
  const token = chooser.json.csrfToken;
  const scoped = id => `/api/workspaces/workspace-local/launches/${id}`;

  const authorize = await request('/api/google/authorize', {method:'POST', body:{}, token});
  const params = new URL(authorize.json.authorizationUrl).searchParams;
  const cookie = /cc-oauth=([A-Za-z0-9_-]+)/.exec(authorize.headers.get('set-cookie') || '')?.[1];
  const callback = await request(`/oauth/google/callback?state=${encodeURIComponent(params.get('state'))}&code=good-code`, {headers:{cookie:`cc-oauth=${cookie}`}});
  const connectionId = new URL(callback.headers.get('location'), 'http://x').searchParams.get('googleConnection');
  const connect = await request('/api/google/launches', {method:'POST', body:{connectionId, folderId:drive.rootId}, token});
  await waitFor(async () => (await request(`/api/jobs/${connect.json.jobId}`)).json?.status === 'completed' && manager.lock === null);
  const driveLaunch = (await request('/api/state')).json.launches.find(item => item.type === 'google-drive');

  // Start a run on the local launch only. The synthetic provider fails its first AI step,
  // which is enough to prove run state stays inside the launch that started it.
  const started = await request(`${scoped('launch-local-default')}/runs`, {method:'POST', body:{brief:'Update the pricing everywhere.', reviewAssetIds:['WEB-1']}, token});
  assert.equal(started.status, 202);
  await waitFor(async () => {
    const localState = await request(`${scoped('launch-local-default')}/state`);
    return localState.json.run && !['interpreting','proposing','rendering','checking'].includes(localState.json.run.status) && manager.lock === null;
  });
  const localState = await request(`${scoped('launch-local-default')}/state`);
  assert.ok(localState.json.run, 'The local launch has its run');
  assert.equal(localState.json.job.launchId, 'launch-local-default');
  const driveState = await request(`${scoped(driveLaunch.id)}/state`);
  assert.equal(driveState.json.run, null, 'The Drive launch never observes the local run');
  assert.equal(driveState.json.job, null);

  // Requests that name a different launch are refused, not redirected.
  const crossed = await request(`${scoped('launch-local-default')}/demo/reset`, {method:'POST', body:{launchId: driveLaunch.id, campaignId:'isolated-test', runId:null}, token});
  assert.equal(crossed.status, 409);

  // Artifact URLs are launch-scoped and serve exact original bytes only within that launch.
  const opened = await request(`${scoped(driveLaunch.id)}/campaign/open`, {method:'POST', body:{}, token});
  assert.equal(opened.status, 200);
  const asset = opened.json.assets[0];
  const sourceURL = asset.sourceFiles[0].url;
  assert.match(sourceURL, new RegExp(`^/api/workspaces/workspace-local/launches/${driveLaunch.id}/artifacts/`));
  const bytes = await request(sourceURL);
  assert.equal(bytes.status, 200);
  const originalOnDisk = await fs.readFile(path.join(BUNDLED, asset.sourceFiles[0].artifactPath), 'utf8');
  assert.equal(bytes.text, originalOnDisk, 'The snapshot serves the exact original bytes');

  const unscopedArtifact = await request(`/artifacts/${asset.sourceFiles[0].artifactPath}`);
  assert.equal(unscopedArtifact.status, 404, 'Artifacts never resolve without a launch identity');
  const wrongLaunch = await request(`${scoped('launch-local-default')}${sourceURL.replace(/^\/api\/workspaces\/workspace-local\/launches\/[^/]+/, '')}`);
  assert.equal(wrongLaunch.status, 404, 'Another launch cannot serve this launch’s originals');
});

test('disconnect requires the launch identity and returns the chooser with the connection revoked', async t => {
  const drive = await fakeDriveFromCampaign(BUNDLED, {brandPath:BUNDLED_BRAND});
  const {request, manager, waitFor} = await application(t, {drive});
  const chooser = await request('/api/state');
  const token = chooser.json.csrfToken;
  const scoped = id => `/api/workspaces/workspace-local/launches/${id}`;

  const authorize = await request('/api/google/authorize', {method:'POST', body:{}, token});
  const params = new URL(authorize.json.authorizationUrl).searchParams;
  const cookie = /cc-oauth=([A-Za-z0-9_-]+)/.exec(authorize.headers.get('set-cookie') || '')?.[1];
  const callback = await request(`/oauth/google/callback?state=${encodeURIComponent(params.get('state'))}&code=good-code`, {headers:{cookie:`cc-oauth=${cookie}`}});
  const connectionId = new URL(callback.headers.get('location'), 'http://x').searchParams.get('googleConnection');
  const connect = await request('/api/google/launches', {method:'POST', body:{connectionId, folderId:drive.rootId}, token});
  await waitFor(async () => (await request(`/api/jobs/${connect.json.jobId}`)).json?.status === 'completed' && manager.lock === null);
  const driveLaunch = (await request('/api/state')).json.launches.find(item => item.type === 'google-drive');

  assert.equal(drive.revoked, false);
  const disconnect = await request(`${scoped(driveLaunch.id)}/disconnect`, {method:'POST', body:{launchId: driveLaunch.id}, token});
  assert.equal(disconnect.status, 200);
  assert.equal(disconnect.json.launches.length, 2, 'The chooser snapshot comes back after disconnect');
  assert.equal(drive.revoked, true, 'Google confirms the token revocation');
  const card = disconnect.json.launches.find(item => item.id === driveLaunch.id);
  assert.equal(card.status, 'disconnected');
});

test('a Drive launch refreshes and reconnects over its scoped HTTP routes', async t => {
  const drive = await fakeDriveFromCampaign(BUNDLED, {brandPath:BUNDLED_BRAND});
  const {request, manager, waitFor} = await application(t, {drive});
  const token = (await request('/api/state')).json.csrfToken;
  const scoped = id => `/api/workspaces/workspace-local/launches/${id}`;

  // Seed a stored connection directly so this test exercises the refresh paths, not authorization.
  await manager.registry.saveConnection('conn-refresh-a', {refresh_token:'fake-refresh-token', access_token:'fake-access-token', expires_at:Date.now() + 3600_000, token_type:'Bearer', scope:'https://www.googleapis.com/auth/drive.readonly'});
  const added = await manager.addDriveLaunch({folderId:drive.rootId, connectionId:'conn-refresh-a'});
  const launchId = added.launch.id;
  assert.equal(added.launch.sampleMatch, true);

  // A refresh needs the CSRF token, and a local launch never accepts a Drive refresh.
  const unauthenticated = await request(`${scoped(launchId)}/refresh`, {method:'POST', body:{launchId}});
  assert.equal(unauthenticated.status, 403);
  const wrongType = await request(`${scoped('launch-local-default')}/refresh`, {method:'POST', body:{launchId:'launch-local-default'}, token});
  assert.equal(wrongType.status, 404);
  assert.match(wrongType.json.error, /not a Google Drive launch/);
  const wrongTypeReconnect = await request(`${scoped('launch-local-default')}/connection`, {method:'POST', body:{launchId:'launch-local-default', connectionId:'conn-refresh-a'}, token});
  assert.equal(wrongTypeReconnect.status, 404, 'A failed-only job is refused before it is queued');

  const first = await request(`${scoped(launchId)}/refresh`, {method:'POST', body:{launchId}, token});
  assert.equal(first.status, 202);
  await waitFor(async () => (await request(`${scoped(launchId)}/jobs/${first.json.jobId}`)).json?.status === 'completed' && manager.lock === null);
  const firstJob = (await request(`${scoped(launchId)}/jobs/${first.json.jobId}`)).json;
  assert.equal(firstJob.status, 'completed');
  assert.equal(firstJob.result.launchId, launchId);
  const firstSnapshotId = manager.registry.launch(launchId).snapshot.id;
  assert.equal(manager.registry.launch(launchId).snapshot.assetCount, 104);
  assert.ok(manager.registry.launch(launchId).lastSuccessfulRefreshAt, 'The card records the refresh time it displays');

  // A Drive edit produces a new verified snapshot, not a silently reused one.
  drive.touch('campaign.json');
  const second = await request(`${scoped(launchId)}/refresh`, {method:'POST', body:{launchId}, token});
  await waitFor(async () => (await request(`${scoped(launchId)}/jobs/${second.json.jobId}`)).json?.status === 'completed' && manager.lock === null);
  const card = (await request('/api/state')).json.launches.find(item => item.id === launchId);
  assert.equal(card.status, 'connected');
  assert.equal(card.registered, 104);
  const refreshed = manager.registry.launch(launchId);
  assert.notEqual(refreshed.snapshot.id, firstSnapshotId, 'The refresh switched the launch to the new snapshot');

  // Reconnecting replaces the connection and removes the superseded one from private storage.
  await manager.registry.saveConnection('conn-refresh-b', {refresh_token:'fake-refresh-token', access_token:'fake-access-token', expires_at:Date.now() + 3600_000, token_type:'Bearer', scope:'https://www.googleapis.com/auth/drive.readonly'});
  const reconnect = await request(`${scoped(launchId)}/connection`, {method:'POST', body:{launchId, connectionId:'conn-refresh-b'}, token});
  assert.equal(reconnect.status, 202);
  await waitFor(async () => (await request(`${scoped(launchId)}/jobs/${reconnect.json.jobId}`)).json?.status === 'completed' && manager.lock === null);
  assert.equal(manager.registry.launch(launchId).connectionId, 'conn-refresh-b');
  assert.equal(await manager.registry.readConnection('conn-refresh-a'), null, 'The replaced connection is deleted, not orphaned');
  assert.ok(await manager.registry.readConnection('conn-refresh-b'));
});
