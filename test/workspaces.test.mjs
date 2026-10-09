import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {applicationDataDirectory, WorkspaceRegistry, FileSystemWorkspaceStorage} from '../lib/workspaces.mjs';

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-control-registry-'));
  return {directory, cleanup: () => fs.rm(directory,{recursive:true,force:true})};
}

test('the application data directory follows the explicit override, then XDG, then the home default', () => {
  const home = path.join(os.tmpdir(),'home-a');
  assert.equal(applicationDataDirectory({CAMPAIGN_CONTROL_DATA_DIR:'/tmp/explicit'}, home), path.resolve('/tmp/explicit'));
  assert.equal(applicationDataDirectory({XDG_DATA_HOME:'/tmp/xdg'}, home), '/tmp/xdg/campaign-control');
  assert.equal(applicationDataDirectory({}, home), path.join(home,'.local','share','campaign-control'));
});

test('a fresh registry initializes with the default workspace and local launch, and persists across restarts', async () => {
  const {directory,cleanup} = await temporaryDirectory();
  try {
    const first = new WorkspaceRegistry({dataDirectory:directory});
    await first.initialize();
    assert.equal(first.workspace().id,'workspace-local');
    assert.equal(first.launch('launch-local-default').type,'local');
    assert.deepEqual(first.data.connections,[]);

    const second = new WorkspaceRegistry({dataDirectory:directory});
    await second.initialize();
    assert.equal(second.launch('launch-local-default').type,'local');
    assert.equal(second.data.migratedAt, first.data.migratedAt, 'Restart reads the saved registry instead of re-migrating');

    const stat = await fs.lstat(path.join(directory,'registry.json'));
    assert.equal(stat.mode & 0o777, 0o600, 'Registry contents are private');
  } finally {await cleanup();}
});

test('a registry file that is not a regular file is rejected without being replaced', async () => {
  const {directory,cleanup} = await temporaryDirectory();
  try {
    const registry = new WorkspaceRegistry({dataDirectory:directory});
    await registry.initialize();
    const file = path.join(directory,'registry.json');
    await fs.unlink(file);
    await fs.symlink('/etc/hostname', file);
    await assert.rejects(() => new WorkspaceRegistry({dataDirectory:directory}).initialize(), /could not be read/);
  } finally {await cleanup();}
});

test('drive launches are added, updated, and removed; a shared connection survives until no launch uses it', async () => {
  const {directory,cleanup} = await temporaryDirectory();
  try {
    const registry = new WorkspaceRegistry({dataDirectory:directory});
    await registry.initialize();
    const connectionId = '11111111-1111-4111-8111-111111111111';
    await registry.saveConnection(connectionId, {refresh_token:'r', access_token:'a', expires_at:1});
    const launch = await registry.addDriveLaunch({
      folderId:'ABC1234567890', folderName:'Pro500', connectionId,
      snapshot:{id:'snapshot-abc', files:[{path:'campaign.json'}]},
    });
    assert.equal(launch.type,'google-drive');
    assert.equal(launch.workspaceId,'workspace-local');
    const second = await registry.addDriveLaunch({folderId:'XYZ0987654321', folderName:'Other', connectionId, snapshot:{id:'snapshot-def',files:[]}});
    await registry.updateDriveLaunch(launch.id, {status:'disconnected', sampleMatch:true});
    assert.equal(registry.launch(launch.id).status,'disconnected');
    assert.equal(registry.launch(launch.id).sampleMatch,true);

    await registry.removeDriveLaunch(launch.id);
    assert.equal(registry.launch(launch.id), null);
    assert.equal(registry.data.connections.length, 1, 'The shared connection stays while another launch still uses it');
    await registry.removeDriveLaunch(second.id);
    assert.deepEqual(registry.data.connections, [], 'The unused connection is dropped with its last launch');
  } finally {await cleanup();}
});

test('connection tokens are stored privately and disappear on disconnect', async () => {
  const {directory,cleanup} = await temporaryDirectory();
  try {
    const registry = new WorkspaceRegistry({dataDirectory:directory});
    await registry.initialize();
    const connectionId = '22222222-2222-4222-8222-222222222222';
    await registry.saveConnection(connectionId, {refresh_token:'secret-refresh', access_token:'secret-access', expires_at:12345});
    const file = path.join(directory,'workspaces','workspace-local','connections',`${connectionId}.json`);
    const stat = await fs.lstat(file);
    assert.equal(stat.mode & 0o777, 0o600, 'OAuth tokens are never group- or world-readable');
    const connectionDirectory = path.dirname(file);
    assert.equal((await fs.stat(connectionDirectory)).mode & 0o777, 0o700);

    assert.deepEqual(await registry.readConnection(connectionId), {refresh_token:'secret-refresh', access_token:'secret-access', expires_at:12345});
    await registry.deleteConnection(connectionId);
    assert.equal(await registry.readConnection(connectionId), null);
    await assert.rejects(() => fs.lstat(file), error => error.code === 'ENOENT');
  } finally {await cleanup();}
});

test('a saved registry missing the default workspace or with corrupt launches is rejected explicitly', async () => {
  const {directory,cleanup} = await temporaryDirectory();
  try {
    const registry = new WorkspaceRegistry({dataDirectory:directory});
    await registry.initialize();
    const file = path.join(directory,'registry.json');
    await fs.writeFile(file, JSON.stringify({schemaVersion:1, workspaces:[], launches:[], connections:[]}));
    await assert.rejects(() => new WorkspaceRegistry({dataDirectory:directory}).initialize(), /default Campaign Control workspace is missing/);
    await fs.writeFile(file, JSON.stringify({schemaVersion:1, workspaces:[{id:'workspace-local',name:'w'}], launches:[{id:'x',workspaceId:'workspace-local',type:'remote-sky'}], connections:[]}));
    await assert.rejects(() => new WorkspaceRegistry({dataDirectory:directory}).initialize(), /launch registry is invalid/);
  } finally {await cleanup();}
});

test('workspace storage paths keep every launch under its own private directory', async () => {
  const {directory,cleanup} = await temporaryDirectory();
  try {
    const storage = new FileSystemWorkspaceStorage(directory);
    const snapshots = storage.snapshotRoot('workspace-local','launch-a');
    const workspace = storage.artifactRoot('workspace-local','launch-a');
    assert.equal(snapshots, path.join(directory,'workspaces','workspace-local','launches','launch-a','snapshots'));
    assert.equal(workspace, path.join(directory,'workspaces','workspace-local','launches','launch-a','workspace'));
    assert.notEqual(snapshots, storage.snapshotRoot('workspace-local','launch-b'));
    assert.throws(() => storage.launchRoot('workspace-local','../escape'), /Invalid launch identity/);
    assert.throws(() => storage.launchRoot('../escape','launch-a'), /Invalid workspace identity/);
  } finally {await cleanup();}
});
