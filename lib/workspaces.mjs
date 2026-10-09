import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const DEFAULT_WORKSPACE_ID = 'workspace-local';
export const DEFAULT_LOCAL_LAUNCH_ID = 'launch-local-default';

const validIdentity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

export function applicationDataDirectory(env = process.env, home = os.homedir()) {
  const configured = env.CAMPAIGN_CONTROL_DATA_DIR;
  if (configured) return path.resolve(configured);
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, '.local', 'share');
  return path.join(base, 'campaign-control');
}

async function privateDirectory(directory, io = fs) {
  await io.mkdir(directory, {recursive:true, mode:0o700});
  const stat = await io.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Campaign Control private storage must be a regular directory.');
  await io.chmod(directory, 0o700);
}

export async function atomicJSONFile(file, value, {io = fs, mode = 0o600} = {}) {
  const directory = path.dirname(file);
  await privateDirectory(directory, io);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await io.open(temporary, 'wx', mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await io.rename(temporary, file);
    return value;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await io.unlink(temporary).catch(() => {});
    throw error;
  }
}

function validateRegistry(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 ||
      !Array.isArray(value.workspaces) || !Array.isArray(value.launches) ||
      value.workspaces.length > 100 || value.launches.length > 1000) {
    throw new Error('Saved Campaign Control registry is invalid. Preserve the registry file before continuing.');
  }
  const workspaceIds = new Set();
  for (const workspace of value.workspaces) {
    if (!validIdentity(workspace.id) || workspaceIds.has(workspace.id) || typeof workspace.name !== 'string') throw new Error('Saved Campaign Control workspace registry is invalid.');
    workspaceIds.add(workspace.id);
  }
  const launchIds = new Set();
  for (const launch of value.launches) {
    if (!validIdentity(launch.id) || launchIds.has(launch.id) || !workspaceIds.has(launch.workspaceId) ||
        !['local', 'google-drive'].includes(launch.type)) throw new Error('Saved Campaign Control launch registry is invalid.');
    if (launch.type === 'google-drive' && (!validIdentity(launch.connectionId) || typeof launch.folderId !== 'string' || !launch.folderId)) throw new Error('Saved Google Drive launch registry is invalid.');
    launchIds.add(launch.id);
  }
  return value;
}

export class WorkspaceRegistry {
  constructor({dataDirectory, io = fs, now = () => new Date().toISOString()} = {}) {
    if (!dataDirectory) throw new Error('A private application data directory is required.');
    this.dataDirectory = path.resolve(dataDirectory);
    this.file = path.join(this.dataDirectory, 'registry.json');
    this.io = io;
    this.now = now;
    this.data = null;
  }

  async initialize() {
    await privateDirectory(this.dataDirectory, this.io);
    let saved;
    try {
      const stat = await this.io.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
      saved = JSON.parse(await this.io.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Saved Campaign Control registry could not be read. Preserve it and inspect before continuing.');
    }
    if (saved) {
      this.data = validateRegistry(saved);
      if (!this.data.workspaces.some(workspace => workspace.id === DEFAULT_WORKSPACE_ID)) throw new Error('The default Campaign Control workspace is missing.');
      return this.data;
    }
    this.data = {
      schemaVersion:1,
      migratedAt:this.now(),
      workspaces:[{id:DEFAULT_WORKSPACE_ID, name:'My workspace', createdAt:this.now(), aiSettingsRef:'application-config'}],
      launches:[{id:DEFAULT_LOCAL_LAUNCH_ID, workspaceId:DEFAULT_WORKSPACE_ID, type:'local', label:'Local example', createdAt:this.now()}],
      connections:[],
    };
    await atomicJSONFile(this.file, this.data, {io:this.io});
    return this.data;
  }

  async saveData(value) {
    const next = validateRegistry({...value,connections:value.connections || []});
    await atomicJSONFile(this.file, next, {io:this.io});
    this.data = next;
    return next;
  }

  workspace(id = DEFAULT_WORKSPACE_ID) {
    return this.data?.workspaces.find(workspace => workspace.id === id) || null;
  }

  launch(id) {
    return this.data?.launches.find(launch => launch.id === id) || null;
  }

  async addDriveLaunch({id = randomUUID(), folderId, folderName, connectionId, snapshot, sampleMatch = false}) {
    if (!this.data) throw new Error('Initialize the workspace registry first.');
    const launch = {
      id,
      workspaceId:DEFAULT_WORKSPACE_ID,
      type:'google-drive',
      label:`${folderName || 'Drive campaign'} — Google Drive`,
      folderId,
      connectionId,
      snapshot,
      sampleMatch:Boolean(sampleMatch),
      createdAt:this.now(),
      lastSuccessfulRefreshAt:this.now(),
      status:'connected',
    };
    const next = {...this.data, launches:[...this.data.launches, launch]};
    validateRegistry(next);
    await this.saveData(next);
    return launch;
  }

  async updateDriveLaunch(id, update) {
    const current = this.launch(id);
    if (!current || current.type !== 'google-drive') throw new Error('Google Drive launch not found.');
    const launch = {...current, ...update};
    const next = {...this.data, launches:this.data.launches.map(item => item.id === id ? launch : item)};
    validateRegistry(next);
    await this.saveData(next);
    return launch;
  }

  async removeDriveLaunch(id) {
    const current = this.launch(id);
    if (!current || current.type !== 'google-drive') return false;
    const stillUsed = this.data.launches.some(item => item.id !== id && item.type === 'google-drive' && item.connectionId === current.connectionId);
    const next = {
      ...this.data,
      launches:this.data.launches.filter(item => item.id !== id),
      connections:stillUsed ? this.data.connections : (this.data.connections || []).filter(item => item.id !== current.connectionId),
    };
    await this.saveData(next);
    return true;
  }

  connectionFile(connectionId) {
    if (!validIdentity(connectionId)) throw new Error('Invalid Google connection identity.');
    return path.join(this.dataDirectory, 'workspaces', DEFAULT_WORKSPACE_ID, 'connections', `${connectionId}.json`);
  }

  async saveConnection(connectionId, tokens) {
    if (!validIdentity(connectionId) || !tokens || typeof tokens.refresh_token !== 'string') throw new Error('Google connection did not provide an offline refresh token.');
    await atomicJSONFile(this.connectionFile(connectionId), tokens, {io:this.io});
    if (!this.data.connections?.some(connection => connection.id === connectionId)) {
      const next = {...this.data, connections:[...(this.data.connections || []), {id:connectionId, workspaceId:DEFAULT_WORKSPACE_ID, provider:'google', createdAt:this.now()}]};
      await this.saveData(next);
    }
  }

  async readConnection(connectionId) {
    const file = this.connectionFile(connectionId);
    try {
      const stat = await this.io.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error();
      const value = JSON.parse(await this.io.readFile(file, 'utf8'));
      if (typeof value.refresh_token !== 'string' || !value.refresh_token) throw new Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('The private Google connection could not be read. Reconnect Google Drive.');
    }
  }

  async deleteConnection(connectionId) {
    try { await this.io.unlink(this.connectionFile(connectionId)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.saveData({...this.data, connections:(this.data.connections || []).filter(connection => connection.id !== connectionId)});
  }
}

export class FileSystemWorkspaceStorage {
  constructor(root) {
    if (!root) throw new Error('A workspace storage root is required.');
    this.root = path.resolve(root);
  }
  workspaceRoot(workspaceId) {
    if (!validIdentity(workspaceId)) throw new Error('Invalid workspace identity.');
    return path.join(this.root, 'workspaces', workspaceId);
  }
  launchRoot(workspaceId, launchId) {
    if (!validIdentity(launchId)) throw new Error('Invalid launch identity.');
    return path.join(this.workspaceRoot(workspaceId), 'launches', launchId);
  }
  snapshotRoot(workspaceId, launchId) {
    return path.join(this.launchRoot(workspaceId, launchId), 'snapshots');
  }
  artifactRoot(workspaceId, launchId) {
    return path.join(this.launchRoot(workspaceId, launchId), 'workspace');
  }
}
