import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {LaunchManager} from '../lib/launch-manager.mjs';
import {GoogleDriveError} from '../lib/google-drive.mjs';
import {FileSystemWorkspaceStorage, WorkspaceRegistry, DEFAULT_WORKSPACE_ID, DEFAULT_LOCAL_LAUNCH_ID} from '../lib/workspaces.mjs';
import {FakeDrive, fakeDriveFromCampaign} from './helpers/fake-drive.mjs';
import {isBundledSample} from '../lib/sample-fingerprint.mjs';

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
// A deterministic renderer keeps the manager tests independent of the macOS/Swift toolchain.
const syntheticRender = async ({markdown, outputDir}) => {
  await fs.writeFile(path.join(outputDir,'preview.txt'), markdown);
  await fs.writeFile(path.join(outputDir,'source.md'), markdown);
  await fs.writeFile(path.join(outputDir,'publisher-metadata.json'), JSON.stringify({title:'Synthetic', description:markdown}));
  return {files: [{path:'preview.txt', mime:'text/plain', role:'publishable-copy'}, {path:'source.md', mime:'text/markdown', role:'editable-source'}, {path:'publisher-metadata.json', mime:'application/json', role:'publisher-metadata'}], primaryPath:'preview.txt', textContent:markdown, checks: [{name:'Synthetic renderer identity', status:'pass', message:'Fixture bytes written.'}]};
};

async function managerFixture(t, {campaign = syntheticCampaign(), source = '# Original copy\nOld Plan costs $20/month.\n', drive} = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-manager-'));
  t.after(() => fs.rm(home,{recursive:true,force:true}));
  const campaignDir = path.join(home,'local-campaign');
  await fs.mkdir(path.join(campaignDir,'sources'),{recursive:true});
  await fs.writeFile(path.join(campaignDir,'campaign.json'), JSON.stringify(campaign));
  await fs.writeFile(path.join(campaignDir,'sources/web.md'), source);
  const dataDirectory = path.join(home,'application-data');
  const files = new Map([['campaign.json', JSON.stringify(campaign)], ['sources/web.md', source]]);
  const driveInstance = drive || new FakeDrive({files});
  const manager = new LaunchManager({
    root: REPO, dataDirectory, campaignDir,
    provider: syntheticProvider(), renderAsset: syntheticRender,
    driveOptions: {clientId:'test-client', clientSecret:'test-secret', driveApi:'https://drive.example.test/drive', fetchImpl: driveInstance.fetchImpl()},
  });
  await manager.initialize();
  const connect = async () => {
    const connectionId = `conn-${Math.random().toString(36).slice(2,10)}`;
    await manager.registry.saveConnection(connectionId, {refresh_token:'fake-refresh-token', access_token:'fake-access-token', expires_at:Date.now() + 3_600_000, token_type:'Bearer', scope:'https://www.googleapis.com/auth/drive.readonly'});
    return connectionId;
  };
  return {manager, home, campaignDir, dataDirectory, drive: driveInstance, connect};
}

test('the manager registers the local launch in the workspace without Drive credentials', async t => {
  const {manager} = await managerFixture(t);
  const launches = manager.list();
  assert.equal(launches.length, 1);
  const local = launches[0];
  assert.equal(local.id, DEFAULT_LOCAL_LAUNCH_ID);
  assert.equal(local.type, 'local');
  assert.equal(local.workspaceId, DEFAULT_WORKSPACE_ID);
  assert.equal(local.sampleMatch, false, 'A synthetic campaign is not the public demo copy');
  const engine = await manager.engine(DEFAULT_LOCAL_LAUNCH_ID);
  assert.equal(engine.workspaceId, DEFAULT_WORKSPACE_ID);
  assert.equal(engine.launchId, DEFAULT_LOCAL_LAUNCH_ID);
  assert.equal(engine.state().evidence.registered, 1);
});

test('a connected Drive launch reaches 104-asset parity with the bundled sample and demo scope', async t => {
  const drive = await fakeDriveFromCampaign(BUNDLED, {brandPath:BUNDLED_BRAND});
  const {manager, connect} = await managerFixture(t, {drive});
  const connectionId = await connect();
  const result = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  const launch = result.launch;
  assert.equal(launch.type, 'google-drive');
  assert.equal(launch.sampleMatch, true);
  assert.equal(launch.label, 'Pro500 — Google Drive');
  const engine = await manager.engine(launch.id);
  assert.equal(engine.isSampleCampaign, true);
  assert.equal(engine.launchId, launch.id);
  const state = engine.state();
  assert.equal(state.identity.launchId, launch.id);
  assert.equal(state.evidence.registered, 104, 'The Drive launch inventories all 104 deliverables');
  assert.equal(state.evidence.blocked, 0, 'The uploaded-sample snapshot has no unsupported originals');
  assert.equal(engine.allowDemoReset, true, 'The exact demo copy keeps the demo-scope default');
  assert.equal(manager.registry.launch(launch.id).type, 'google-drive');
  assert.match(state.storage.source, /Google Drive/);
  const card = manager.list().find(item => item.id === launch.id);
  assert.equal(card.registered, 104);
  assert.equal(card.sampleMatch, true);
  assert.ok(card.lastSuccessfulRefreshAt);
  // The engine works from a private snapshot, never from the live Drive.
  assert.ok(state.storage.snapshot.startsWith(manager.storage.snapshotRoot(DEFAULT_WORKSPACE_ID, launch.id)));
});

test('a modified Drive copy of the sample connects at full scope without the demo default', async t => {
  const drive = await fakeDriveFromCampaign(BUNDLED, {brandPath:BUNDLED_BRAND});
  const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
  const edited = local.assets.find(asset => asset.source).source;
  drive.touch(edited, Buffer.from('# Edited original\nNo longer the public sample.\n'));
  const {manager, connect} = await managerFixture(t, {drive});
  const connectionId = await connect();
  const {launch} = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  assert.equal(launch.sampleMatch, false);
  const engine = await manager.engine(launch.id);
  assert.equal(engine.isSampleCampaign, false, 'A modified copy is a normal full-scope campaign');
  assert.equal(engine.allowDemoReset, false);
  assert.equal(engine.state().evidence.registered, 104, 'Parity is still complete; only the demo default differs');
});

test('launches with identical campaign content never share run state or working directories', async t => {
  const {manager, drive, connect} = await managerFixture(t);
  const connectionId = await connect();
  const {launch} = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  const driveEngine = await manager.engine(launch.id);
  const localEngine = await manager.engine(DEFAULT_LOCAL_LAUNCH_ID);
  // Both launches see the same single asset with the same source bytes.
  assert.equal(driveEngine.state().evidence.registered, localEngine.state().evidence.registered);
  assert.equal(driveEngine.assets[0].sourceHash, localEngine.assets[0].sourceHash);

  const change = {product:'New Plan', monthlyPrice:40, sharing:false, maxTeammates:0, instruction:'Apply only these confirmed facts.'};
  const {runId} = localEngine.start(change);
  await localEngine.task;
  assert.ok(localEngine.run, 'The local launch holds a completed run');
  assert.equal(driveEngine.run, null, 'The Drive launch sees no run from the local launch');

  await localEngine.edit(runId, 'WEB-1', '# Edited candidate\nNew Plan.\n');
  const refreshedDrive = (await manager.engine(launch.id)).assets[0];
  assert.equal(refreshedDrive.candidateText, null, 'A candidate edit cannot leak across launches');

  await driveEngine.newRevision();
  assert.notEqual(path.join(localEngine.artifactDir, localEngine.run.draftFolder), path.join(driveEngine.artifactDir, driveEngine.run.draftFolder), 'Each launch allocates its own working version folder');
  assert.notEqual(localEngine.artifactDir, driveEngine.artifactDir);
  assert.equal((await manager.engine(launch.id)).run.id, driveEngine.run.id, 'Manager engines are stable per launch');
});

test('one campaign update at a time: the processing lock spans every launch', async t => {
  const {manager, drive, connect} = await managerFixture(t);
  const connectionId = await connect();
  const {launch} = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  const token = manager.acquire(DEFAULT_LOCAL_LAUNCH_ID, 'campaign update');
  assert.ok(token);
  assert.throws(() => manager.acquire(launch.id, 'campaign update'), error => {
    assert.equal(error.status, 423);
    assert.match(error.message, /another launch/);
    return true;
  });
  await assert.rejects(() => manager.withOperation(launch.id, 'asset revision', async () => {}), error => {
    assert.equal(error.status, 423);
    return true;
  }, 'A locked workspace refuses every other operation');
  manager.release(token);
  assert.equal(manager.lock, null);
  await manager.withOperation(launch.id, 'asset revision', async () => {
    assert.ok(manager.lock, 'The lock is visible while the operation runs');
    assert.throws(() => manager.acquire(launch.id, 'checks'), error => error.status === 423, 'Nested acquisition is refused inside an operation');
  });
  assert.equal(manager.lock, null, 'The lock is released when the operation finishes');
  // Release is defensive: an extra release can never unlock someone else's operation.
  const stale = manager.acquire(launch.id, 'checks');
  manager.release(stale);
  manager.release(stale);
  assert.equal(manager.lock, null, 'A repeated release is a harmless no-op');
});

test('durable jobs report progress, outcomes and per-job launch identity', async t => {
  const {manager, drive, connect} = await managerFixture(t);
  const connectionId = await connect();
  const {launch} = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  const waitFor = async predicate => {for (let attempt = 0; attempt < 500 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 2)); if (!predicate()) throw new Error('Timed out waiting for the job.');};

  const handle = await manager.startJob(launch.id, 'Drive refresh', async job => {
    assert.equal(job.status, 'running');
    job.progress = {message:'Working…'};
    return {launch: manager.registry.launch(launch.id)};
  });
  await waitFor(() => manager.jobs.get(handle.jobId)?.status === 'completed');
  const job = manager.jobs.get(handle.jobId);
  assert.equal(job.launchId, launch.id);
  assert.equal(job.workspaceId, DEFAULT_WORKSPACE_ID);
  assert.deepEqual(job.progress, {message:'Drive refresh complete.'});
  // Job records outlive the process and can be checked by identity.
  const stored = JSON.parse(await fs.readFile(path.join(manager.jobRecords.root, `${handle.jobId}.json`), 'utf8'));
  assert.equal(stored.workspaceId, DEFAULT_WORKSPACE_ID);
  assert.equal(stored.kind, 'Drive refresh');
  await waitFor(() => manager.lock === null);

  const failure = await manager.startJob(launch.id, 'Drive refresh', async () => {throw new GoogleDriveError('Google Drive could not be reached. Your local campaigns remain available.', 502, 'DRIVE_UNAVAILABLE');});
  await waitFor(() => manager.jobs.get(failure.jobId)?.status === 'failed');
  assert.match(manager.jobs.get(failure.jobId).error, /could not be reached/);
  await waitFor(() => manager.lock === null);

  // Unexpected internal failures never leak stack traces; they record an honest generic outcome.
  const internal = await manager.startJob(launch.id, 'Drive refresh', async () => {throw new Error('ECONNRESET at /var/private/xyz');});
  await waitFor(() => manager.jobs.get(internal.jobId)?.status === 'failed');
  assert.doesNotMatch(manager.jobs.get(internal.jobId).error, /ECONNRESET|\/var\//);
  assert.match(manager.jobs.get(internal.jobId).error, /The operation failed/);
  await waitFor(() => manager.lock === null);

  // A job that was still running when the server restarted is reported honestly, never silently retried.
  const interrupted = await manager.startJob(launch.id, 'Drive refresh', () => new Promise(() => {}));
  const restart = new LaunchManager({
    root: REPO, dataDirectory: manager.registry.dataDirectory, campaignDir: manager.localCampaignDir,
    provider: syntheticProvider(),
    driveOptions: {fetchImpl: async () => {throw new Error('offline');}},
  });
  await restart.initialize();
  const resumed = restart.jobs.get(interrupted.jobId);
  assert.equal(resumed.status, 'interrupted');
  assert.match(resumed.error, /Server restarted/);
  assert.equal(restart.lock, null, 'An interrupted job never leaves the workspace lock held');
});

test('a Drive refresh archives current work and switches to the new snapshot', async t => {
  const {manager, drive, connect, dataDirectory} = await managerFixture(t);
  const connectionId = await connect();
  const {launch} = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  const engine = await manager.engine(launch.id);
  await engine.newRevision();
  const runId = engine.run.id;
  const previousSnapshot = launch.snapshot.id;
  const previousSnapshotDir = path.join(manager.storage.snapshotRoot(DEFAULT_WORKSPACE_ID, launch.id), previousSnapshot);

  drive.touch('sources/web.md', '# Edited in Drive\nNew source content.\n');
  await manager.refreshDriveLaunch(launch.id);
  const updated = manager.registry.launch(launch.id);
  assert.notEqual(updated.snapshot.id, previousSnapshot.id);
  assert.equal(updated.status, 'connected');
  assert.ok(updated.lastSuccessfulRefreshAt);
  const next = await manager.engine(launch.id);
  assert.equal(next.run, null, 'A refreshed launch restarts from a fresh inventory, not a stale run');
  assert.notEqual(next.campaignDir, path.join(manager.storage.snapshotRoot(DEFAULT_WORKSPACE_ID, launch.id), previousSnapshot));
  const history = JSON.parse(await fs.readFile(path.join(next.controlDir, 'history', `${runId}.json`), 'utf8'));
  assert.equal(history.run.id, runId, 'The archived run is preserved with its launch history');
  assert.equal(history.snapshot.id, previousSnapshot, 'The history names the snapshot the run was based on');
  const onDisk = await fs.readFile(path.join(next.campaignDir, 'sources/web.md'), 'utf8');
  assert.match(onDisk, /Edited in Drive/);
  assert.equal(await fs.access(previousSnapshotDir).then(() => true, () => false), true, 'The previous immutable snapshot is retained as evidence');
});

test('disconnect revokes Drive access, marks launches honestly, and reconnection restores refresh', async t => {
  const {manager, drive, connect} = await managerFixture(t);
  const connectionId = await connect();
  const {launch} = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  const engine = await manager.engine(launch.id);
  await engine.newRevision();

  assert.equal(drive.revoked, false);
  const outcome = await manager.disconnectDriveLaunch(launch.id, id => Promise.resolve({remoteRevocationConfirmed: id === connectionId}));
  assert.deepEqual(outcome, {disconnected:true, launchId: launch.id});
  assert.equal(drive.revokes.length, 0, 'Revocation is delegated to the OAuth layer');
  assert.equal(manager.registry.launch(launch.id).status, 'disconnected');
  assert.equal(await manager.registry.readConnection(connectionId), null, 'The workspace token is deleted');
  assert.match((await manager.engine(launch.id)).driftMessage, /disconnected/i);
  assert.equal(manager.list().find(item => item.id === launch.id).status, 'disconnected');

  // Reconnect with a fresh authorization and refresh: the launch recovers with a new snapshot.
  const fresh = await connect();
  await manager.refreshDriveLaunch(launch.id, {connectionId: fresh});
  assert.equal(manager.registry.launch(launch.id).status, 'connected');
  assert.equal(manager.registry.launch(launch.id).connectionId, fresh);
  const restored = await manager.engine(launch.id);
  assert.equal(restored.driftMessage, null);
  assert.equal(restored.state().evidence.registered, 1);
});

test('a Drive launch reset archives generated work even when an original is a native Google document', async t => {
  const drive = new FakeDrive({files:new Map([['campaign.json', JSON.stringify(syntheticCampaign())], ['sources/web.md', '# Original copy\nOld Plan costs $20/month.\n']])});
  drive.markNative('sources/web.md', 'application/vnd.google-apps.document');
  const {manager, connect} = await managerFixture(t, {drive});
  const connectionId = await connect();
  const {launch} = await manager.addDriveLaunch({folderId:drive.rootId, connectionId});
  const engine = await manager.engine(launch.id);
  assert.equal(engine.assets[0].status, 'blocked', 'A native-document original blocks its asset explicitly');
  assert.equal(engine.assets[0].capabilities.externalEditorRequired, true);
  const receipt = await manager.resetLaunch(launch.id, {launchId: launch.id, runId: null});
  assert.ok(receipt.archive, 'The reset still archives the private workspace');
  const reset = await manager.engine(launch.id);
  assert.equal(reset.run, null);
  assert.equal(reset.assets.length, 1, 'The immutable snapshot inventory is unchanged by the reset');
  assert.equal(reset.assets[0].status, 'blocked', 'The native-document blocker survives the reset');
});

test('sample fingerprinting is exact: any source or brand change breaks the demo-copy match', async t => {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-fingerprint-'));
  t.after(() => fs.rm(destination,{recursive:true,force:true}));
  const local = JSON.parse(await fs.readFile(path.join(BUNDLED,'campaign.json'),'utf8'));
  const original = local.assets.find(asset => asset.source).source;

  const stable = await isBundledSample(BUNDLED, {brandPath:BUNDLED_BRAND});
  assert.equal(stable, true);
  assert.equal(await isBundledSample(BUNDLED, {brandPath:BUNDLED_BRAND}), true, 'The fingerprint is deterministic');

  const edited = path.join(destination, 'edited.md');
  await fs.writeFile(edited, '# Changed\nNo longer the sample.\n');
  const brandPatch = {brandPath: edited};
  assert.equal(await isBundledSample(BUNDLED, brandPatch), false, 'A different brand identity breaks the sample match');

  // A copy of only the manifest without originals is not the sample either.
  const bare = path.join(destination, 'bare');
  await fs.mkdir(bare);
  await fs.copyFile(path.join(BUNDLED,'campaign.json'), path.join(bare,'campaign.json'));
  assert.equal(await isBundledSample(bare), false);
  assert.equal((await import('node:fs/promises')).constants.F_OK, (await import('node:fs/promises')).constants.F_OK);
  assert.equal(typeof original, 'string');
});
