import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {GoogleOAuth, GoogleDriveClient, GoogleDriveError, driveFolderId, GOOGLE_DRIVE_READONLY_SCOPE} from '../lib/google-drive.mjs';
import {WorkspaceRegistry} from '../lib/workspaces.mjs';
import {FakeDrive, fakeDriveFromCampaign} from './helpers/fake-drive.mjs';

const BUNDLED = new URL('../fictitious-ai/campaigns/pro500', import.meta.url).pathname;
const BUNDLED_BRAND = new URL('../fictitious-ai/brand/identity.json', import.meta.url).pathname;
const TOKEN_HOST = 'https://oauth.example.test';
const DRIVE_HOST = 'https://drive.example.test';

async function registry() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-drive-'));
  const instance = new WorkspaceRegistry({dataDirectory:directory});
  await instance.initialize();
  return {instance, directory, cleanup: () => fs.rm(directory,{recursive:true,force:true})};
}

function oauthOptions(instance, {now, redirectUri} = {}) {
  return {
    registry: instance, clientId:'test-client', clientSecret:'test-secret',
    redirectUri: redirectUri || 'http://127.0.0.1:8142/oauth/google/callback',
    authEndpoint:'https://auth.example.test/authorize', tokenEndpoint:`${TOKEN_HOST}/token`, revokeEndpoint:`${TOKEN_HOST}/revoke`,
    fetchImpl: async () => new Response('{}'), now,
  };
}

test('oauth reports configured only with credentials and a localhost callback', async () => {
  const {instance,cleanup} = await registry();
  try {
    const configured = new GoogleOAuth(oauthOptions(instance));
    assert.equal(configured.configured(), true);
    for (const options of [{clientId:null},{clientSecret:null},{redirectUri:'https://example.com/oauth/google/callback'},{redirectUri:'http://127.0.0.1:8142/other'}]) {
      assert.equal(new GoogleOAuth({...oauthOptions(instance), ...options}).configured(), false);
    }
    assert.throws(() => new GoogleOAuth({...oauthOptions(instance), registry:null}), /registry is required/);
  } finally {await cleanup();}
});

test('authorization starts with state, PKCE S256, offline access and the read-only scope', async () => {
  const {instance,cleanup} = await registry();
  try {
    let clock = 1_000;
    const oauth = new GoogleOAuth(oauthOptions(instance, {now: () => clock}));
    const url = new URL(oauth.start({browserNonce:'browser-nonce'}));
    assert.equal(`${url.origin}${url.pathname}`, 'https://auth.example.test/authorize');
    const params = url.searchParams;
    assert.equal(params.get('client_id'),'test-client');
    assert.equal(params.get('redirect_uri'),'http://127.0.0.1:8142/oauth/google/callback');
    assert.equal(params.get('response_type'),'code');
    assert.equal(params.get('access_type'),'offline');
    assert.equal(params.get('prompt'),'consent');
    assert.equal(params.get('scope'),GOOGLE_DRIVE_READONLY_SCOPE);
    assert.match(params.get('code_challenge') || '',/^[A-Za-z0-9_-]+$/);
    assert.equal(params.get('code_challenge_method'),'S256');
    const state = params.get('state');
    assert.match(state, /^[A-Za-z0-9_-]+$/);

    // State expires after ten minutes and cannot be reused.
    clock += 11 * 60 * 1000;
    await assert.rejects(() => oauth.callback({code:'good-code', state, browserNonce:'browser-nonce'}), error => {
      assert.equal(error.code,'INVALID_OAUTH_STATE'); return true;
    });
  } finally {await cleanup();}
});

test('the callback rejects mismatched browser nonces, user denials, and unusable codes', async () => {
  const {instance,cleanup} = await registry();
  try {
    const drive = new FakeDrive({files:new Map([['campaign.json','{}']])});
    const options = {...oauthOptions(instance), fetchImpl: drive.fetchImpl()};
    const oauth = new GoogleOAuth(options);
    const state = new URL(oauth.start({browserNonce:'nonce-a'})).searchParams.get('state');
    await assert.rejects(() => oauth.callback({code:'good-code', state, browserNonce:'nonce-b'}), error => error.code === 'INVALID_OAUTH_STATE');
    const deniedState = new URL(oauth.start({browserNonce:'nonce-a'})).searchParams.get('state');
    await assert.rejects(() => oauth.callback({state:deniedState, error:'access_denied', browserNonce:'nonce-a'}), error => error.code === 'OAUTH_DENIED');
    const badCodeState = new URL(oauth.start({browserNonce:'nonce-a'})).searchParams.get('state');
    await assert.rejects(() => oauth.callback({code:'wrong-code', state:badCodeState, browserNonce:'nonce-a'}), error => error.code === 'REAUTH_REQUIRED');
  } finally {await cleanup();}
});

test('a completed callback exchanges PKCE for offline tokens and stores them privately', async () => {
  const {instance,cleanup} = await registry();
  try {
    const drive = new FakeDrive({files:new Map([['campaign.json','{}']])});
    const oauth = new GoogleOAuth({...oauthOptions(instance), fetchImpl: drive.fetchImpl()});
    const url = new URL(oauth.start({browserNonce:'nonce-a'}));
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    const connectionId = await oauth.callback({code:'good-code', state, browserNonce:'nonce-a'});
    assert.match(connectionId,/^[0-9a-f-]{36}$/);

    const exchange = drive.tokenRequests.at(-1);
    assert.equal(exchange.grant_type,'authorization_code');
    assert.equal(exchange.client_id,'test-client');
    assert.equal(exchange.client_secret,'test-secret');
    assert.equal(exchange.redirect_uri,'http://127.0.0.1:8142/oauth/google/callback');
    // The verifier must match the S256 challenge from the authorization URL.
    assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), challenge);

    const saved = await instance.readConnection(connectionId);
    assert.equal(saved.refresh_token,'fake-refresh-token');
    assert.equal(saved.scope,GOOGLE_DRIVE_READONLY_SCOPE);
    assert.ok(saved.expires_at > 0);

    // A state value can never be replayed for a second connection.
    await assert.rejects(() => oauth.callback({code:'good-code', state, browserNonce:'nonce-a'}), error => error.code === 'INVALID_OAUTH_STATE');
  } finally {await cleanup();}
});

test('offline access and the exact scope are required from the token endpoint', async () => {
  const {instance,cleanup} = await registry();
  try {
    const incomplete = new FakeDrive({files:new Map([['campaign.json','{}']])});
    incomplete.tokens = {access_token:'a', expires_in:3600}; // no refresh_token
    let oauth = new GoogleOAuth({...oauthOptions(instance), fetchImpl: incomplete.fetchImpl()});
    let state = new URL(oauth.start({browserNonce:'n'})).searchParams.get('state');
    await assert.rejects(() => oauth.callback({code:'good-code', state, browserNonce:'n'}), error => error.code === 'OFFLINE_ACCESS_REQUIRED');

    const narrowScope = new FakeDrive({files:new Map([['campaign.json','{}']])});
    narrowScope.tokens = {refresh_token:'r', access_token:'a', expires_in:3600, scope:'https://www.googleapis.com/auth/drive.file'};
    oauth = new GoogleOAuth({...oauthOptions(instance), fetchImpl: narrowScope.fetchImpl()});
    state = new URL(oauth.start({browserNonce:'n'})).searchParams.get('state');
    await assert.rejects(() => oauth.callback({code:'good-code', state, browserNonce:'n'}), error => error.code === 'SCOPE_NOT_GRANTED');
  } finally {await cleanup();}
});

test('disconnect revokes the stored refresh token with Google', async () => {
  const {instance,cleanup} = await registry();
  try {
    const drive = new FakeDrive({files:new Map([['campaign.json','{}']])});
    const oauth = new GoogleOAuth({...oauthOptions(instance), fetchImpl: drive.fetchImpl()});
    const state = new URL(oauth.start({browserNonce:'n'})).searchParams.get('state');
    const connectionId = await oauth.callback({code:'good-code', state, browserNonce:'n'});
    assert.equal(drive.revoked, false);
    const result = await oauth.disconnect(connectionId);
    assert.deepEqual(result, {remoteRevocationConfirmed:true});
    assert.equal(drive.revokes.at(-1)?.token, 'fake-refresh-token');
    assert.equal(drive.revoked, true);
    // The OAuth layer revokes remotely; the workspace keeps ownership of local token removal.
    assert.ok(await instance.readConnection(connectionId), 'The stored connection remains until its owner deletes it');
    await instance.deleteConnection(connectionId);
    assert.equal(await instance.readConnection(connectionId), null);
  } finally {await cleanup();}
});

test('folder input accepts Drive URLs and IDs and rejects anything malformed', () => {
  assert.equal(driveFolderId('ABC123-456789'), 'ABC123-456789');
  assert.equal(driveFolderId('https://drive.google.com/drive/folders/ABC123-456789?usp=sharing'), 'ABC123-456789');
  assert.equal(driveFolderId(' https://drive.google.com/drive/folders/ABC123-456789/edit '), 'ABC123-456789');
  for (const bad of ['', 'a b c', 'abc', 'ABC\n123', '../escape']) {
    assert.throws(() => driveFolderId(bad), error => error.code === 'INVALID_FOLDER_ID', `Expected rejection for ${JSON.stringify(bad)}`);
  }
});

async function connectedClient({pageSize, campaign = BUNDLED, files} = {}) {
  const setup = await registry();
  const drive = files ? new FakeDrive({files, pageSize}) : await fakeDriveFromCampaign(campaign, {brandPath:BUNDLED_BRAND, pageSize});
  const oauth = new GoogleOAuth({...oauthOptions(setup.instance), fetchImpl: drive.fetchImpl()});
  const state = new URL(oauth.start({browserNonce:'n'})).searchParams.get('state');
  const connectionId = await oauth.callback({code:'good-code', state, browserNonce:'n'});
  const client = new GoogleDriveClient({
    registry: setup.instance, connectionId, clientId:'test-client', clientSecret:'test-secret',
    driveApi: `${DRIVE_HOST}/drive`, fetchImpl: drive.fetchImpl(),
  });
  return {...setup, drive, client, connectionId};
}

test('the remote index paginates through every folder and preserves relative paths', async () => {
  const {client, drive, cleanup} = await connectedClient({pageSize: 7});
  try {
    const index = await client.remoteIndex(drive.rootId);
    const paths = [...index.entries.keys()].sort();
    assert.ok(paths.includes('campaign.json'));
    assert.ok(paths.includes('brand/identity.json'));
    assert.ok(paths.length > 100, `Expected the full campaign tree, got ${paths.length}`);
    assert.equal(index.ambiguous.size, 0);
    assert.equal(index.root.mimeType, 'application/vnd.google-apps.folder');
  } finally {await cleanup();}
});

async function rejection(work) {
  try {await work(); throw new Error('Missing expected rejection.');}
  catch (error) {if (error.message === 'Missing expected rejection.') throw error; return error;}
}

test('a snapshot preserves the exact original bytes and records Drive identity markers', async () => {
  const {client, drive, cleanup} = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const {snapshot} = await client.createSnapshot({folderId:drive.rootId, destinationRoot: destination});
    assert.equal(snapshot.folderId, drive.rootId);
    assert.equal(snapshot.campaignId, 'pro500');
    const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
    assert.equal(local.assets.length, 104);
    const downloaded = snapshot.files.find(file => file.path === 'campaign.json');
    assert.equal(downloaded.status, 'downloaded');
    assert.equal(downloaded.sha256, createHash('sha256').update(await fs.readFile(path.join(BUNDLED,'campaign.json'))).digest('hex'));
    const sourceFile = local.assets.find(asset => asset.source).source;
    const snapshotted = snapshot.files.find(file => file.path === sourceFile);
    const onDisk = await fs.readFile(path.join(destination, snapshot.id, ...sourceFile.split('/')));
    assert.equal(snapshotted.bytes, onDisk.length);
    assert.equal(snapshotted.sha256, createHash('sha256').update(onDisk).digest('hex'));
    assert.equal(snapshotted.version, 1);
    assert.ok(snapshotted.md5Checksum);
    assert.equal(snapshot.totalBytes, snapshot.files.reduce((sum, file) => sum + (file.bytes || 0), 0));
    // Every referenced original (plus manifest and brand) is snapshotted exactly once.
    const referenced = new Set(['campaign.json','brand/identity.json']);
    for (const asset of local.assets) {if (asset.source) referenced.add(asset.source); for (const file of asset.files || []) referenced.add(file.path);}
    assert.deepEqual(snapshot.files.map(file => file.path).sort(), [...referenced].sort());
    assert.equal(new Set(snapshot.files.map(file => file.path)).size, snapshot.files.length, 'No duplicate paths in a snapshot');
  } finally {await fs.rm(destination,{recursive:true,force:true}); await cleanup();}
});

test('ambiguous paths, missing files, and non-folder selections fail with honest errors', async () => {
  const {client, drive, cleanup} = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
    const referencedSource = local.assets.find(asset => asset.source).source;

    drive.addDuplicate('campaign.json');
    const ambiguous = await rejection(() => client.createSnapshot({folderId:drive.rootId, destinationRoot: destination}));
    assert.equal(ambiguous.code, 'AMBIGUOUS_MANIFEST');
    assert.match(ambiguous.message, /campaign\.json/);
    drive.duplicates.pop(); drive.rebuild();

    drive.delete(referencedSource);
    const missing = await rejection(() => client.createSnapshot({folderId:drive.rootId, destinationRoot: destination}));
    assert.equal(missing.code, 'REFERENCED_FILE_MISSING');
    assert.match(missing.message, new RegExp(referencedSource.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    const leftovers = await fs.readdir(destination);
    assert.deepEqual(leftovers, [], 'A failed snapshot never commits files into the destination');

    const invalid = await rejection(() => client.createSnapshot({folderId:'not a folder', destinationRoot: destination}));
    assert.equal(invalid.code, 'INVALID_FOLDER_ID');
  } finally {await fs.rm(destination,{recursive:true,force:true}); await cleanup();}
});

test('native Google documents and shortcuts are recorded honestly instead of silently transformed', async () => {
  const {client, drive, cleanup} = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
    const nativeTarget = local.assets.find(asset => asset.source).source;
    drive.markNative(nativeTarget, 'application/vnd.google-apps.document');
    const {snapshot} = await client.createSnapshot({folderId:drive.rootId, destinationRoot: destination});
    const native = snapshot.files.find(file => file.path === nativeTarget);
    assert.equal(native.status, 'unsupported');
    assert.equal(native.capability, 'native-document-external-editor');
    assert.equal(native.bytes, undefined, 'A native document never contributes downloaded bytes');
    assert.ok(native.fileId && native.version, 'The Drive identity of the unsupported file is still recorded for drift checks');
    const onDisk = await fs.readFile(path.join(destination, snapshot.id, ...nativeTarget.split('/'))).then(() => true, () => false);
    assert.equal(onDisk, false, 'Native documents are not written into the snapshot');
    drive.markNative(nativeTarget, null); drive.nativeOverrides.delete(nativeTarget); drive.rebuild();

    // A manifest that is itself a native document is refused outright.
    drive.markNative('campaign.json', 'application/vnd.google-apps.document');
    await assert.rejects(() => client.createSnapshot({folderId:drive.rootId, destinationRoot: destination}), error => error.code === 'MANIFEST_UNSUPPORTED');
  } finally {await fs.rm(destination,{recursive:true,force:true}); await cleanup();}
});

test('per-file and total size budgets stop oversized campaigns before any commit', async () => {
  const small = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const limited = new GoogleDriveClient({...small.client, maxFileBytes: 10, maxTotalBytes: 1024 * 1024});
    await assert.rejects(() => limited.createSnapshot({folderId:small.drive.rootId, destinationRoot: destination}), error => error.code === 'FILE_TOO_LARGE');
    const total = new GoogleDriveClient({...small.client, maxFileBytes: 1024 * 1024, maxTotalBytes: 10});
    await assert.rejects(() => total.createSnapshot({folderId:small.drive.rootId, destinationRoot: destination}), error => error.code === 'CAMPAIGN_TOO_LARGE');
    assert.deepEqual(await fs.readdir(destination), []);
  } finally {await fs.rm(destination,{recursive:true,force:true}); await small.cleanup();}
});

test('an interrupted download never produces a partial snapshot', async () => {
  const {client, drive, cleanup} = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
    drive.failDownload(local.assets.find(asset => asset.source).source);
    await assert.rejects(() => client.createSnapshot({folderId:drive.rootId, destinationRoot: destination}), error => error.code === 'SNAPSHOT_INCOMPLETE');
    assert.deepEqual(await fs.readdir(destination), [], 'Nothing is committed when a download dies mid-stream');
  } finally {await fs.rm(destination,{recursive:true,force:true}); await cleanup();}
});

test('a checksum mismatch between Drive metadata and bytes stops the snapshot', async () => {
  const {client, drive, cleanup} = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
    const target = local.assets.find(asset => asset.source).source;
    drive.metadataOverrides.set(target, {md5Checksum:'0'.repeat(32)});
    await assert.rejects(() => client.createSnapshot({folderId:drive.rootId, destinationRoot: destination}), error => error.code === 'SNAPSHOT_INTEGRITY');
    assert.deepEqual(await fs.readdir(destination), []);
  } finally {await fs.rm(destination,{recursive:true,force:true}); await cleanup();}
});

test('a source that changes mid-snapshot aborts the whole acquisition without committing', async () => {
  const {client, drive, cleanup} = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
    const target = local.assets.find(asset => asset.source).source;
    // The second metadata read for this file reports a newer version, as if someone edited it during the walk.
    drive.onMetadata = (pathKey, count) => pathKey === target && count >= 2 ? {version: 99, headRevisionId:'99', modifiedTime:'2025-09-01T00:00:00.000Z'} : null;
    await assert.rejects(() => client.createSnapshot({folderId:drive.rootId, destinationRoot: destination}), error => error.code === 'SOURCE_CHANGED_DURING_SNAPSHOT');
    assert.deepEqual(await fs.readdir(destination), []);
  } finally {await fs.rm(destination,{recursive:true,force:true}); await cleanup();}
});

test('snapshot verification passes while Drive is unchanged and reports exact drift when it moves', async () => {
  const {client, drive, cleanup} = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
    const {snapshot} = await client.createSnapshot({folderId:drive.rootId, destinationRoot: destination});
    const verified = await client.verifySnapshot(snapshot);
    assert.equal(verified.files, snapshot.files.length);

    const target = local.assets.find(asset => asset.source).source;
    drive.touch(target, Buffer.from('Edited after the snapshot was taken.'));
    const stale = await rejection(() => client.verifySnapshot(snapshot));
    assert.equal(stale.code, 'STALE_SOURCE');
    assert.match(stale.message, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));

    // Verification can also check a subset, and rename collisions are drift, not silence.
    const second = await client.createSnapshot({folderId:drive.rootId, destinationRoot: destination});
    drive.addDuplicate('campaign.json');
    const ambiguous = await rejection(() => client.verifySnapshot(second.snapshot));
    assert.equal(ambiguous.code, 'STALE_SOURCE');
    const partial = await client.verifySnapshot(second.snapshot, {onlyPaths:['brand/identity.json']});
    assert.equal(partial.files, 1);
  } finally {await fs.rm(destination,{recursive:true,force:true}); await cleanup();}
});

test('expired access tokens refresh transparently, and revocation requires an explicit reconnect', async () => {
  const setup = await connectedClient();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-snapshot-'));
  try {
    const {client, drive} = setup;
    // The saved access token was invalidated server-side; the client must refresh and retry once.
    drive.validAccessTokens.delete('fake-access-token');
    const index = await client.remoteIndex(drive.rootId);
    assert.ok(index.entries.size > 0);
    assert.equal(drive.tokenRequests.at(-1).grant_type, 'refresh_token');
    assert.equal(drive.tokenRequests.at(-1).refresh_token, 'fake-refresh-token');
    const saved = await setup.instance.readConnection(setup.connectionId);
    assert.equal(saved.access_token, 'fake-access-token-2', 'The refreshed token is persisted for the next start');

    // A revoked refresh token surfaces as an explicit reauthorization requirement.
    drive.revoked = true;
    drive.validAccessTokens.delete('fake-access-token-2');
    await assert.rejects(() => client.remoteIndex(drive.rootId), error => error.code === 'REAUTH_REQUIRED');

    // A missing connection file is reported as disconnected rather than crashing.
    await setup.instance.deleteConnection(setup.connectionId);
    await assert.rejects(() => client.remoteIndex(drive.rootId), error => error.code === 'DISCONNECTED');
  } finally {await fs.rm(destination,{recursive:true,force:true}); await setup.cleanup();}
});

test('the client surfaces Drive unavailability without touching local campaigns', async () => {
  const {client, cleanup} = await connectedClient();
  try {
    const unreachable = new GoogleDriveClient({...client, fetchImpl: async () => {throw new Error('network down');}});
    await assert.rejects(() => unreachable.remoteIndex('ABC123-4567890'), error => error.code === 'DRIVE_UNAVAILABLE');
    assert.ok(errorIsHonest(new GoogleDriveError('message', 502, 'DRIVE_ERROR')));
  } finally {await cleanup();}
});

function errorIsHonest(error) {return error instanceof GoogleDriveError && typeof error.status === 'number' && typeof error.code === 'string';}
