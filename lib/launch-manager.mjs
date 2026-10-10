import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CampaignEngine} from './engine.mjs';
import {renderAsset} from './render.mjs';
import {loadBrand, brandHash} from './brand.mjs';
import {GoogleDriveClient, GoogleDriveError} from './google-drive.mjs';
import {isBundledSample} from './sample-fingerprint.mjs';
import {
  DEFAULT_LOCAL_LAUNCH_ID, DEFAULT_WORKSPACE_ID, FileSystemWorkspaceStorage, WorkspaceRegistry,
} from './workspaces.mjs';
import {WorkflowError} from './engine.mjs';
import {FileSystemRecordStore} from './records.mjs';
import {resetDemoWorkspace} from './demo-reset.mjs';

function publicLaunch(launch) {
  if (launch.type === 'local') return {
    id:launch.id,
    workspaceId:launch.workspaceId,
    type:'local',
    label:launch.label,
    source:'Local filesystem',
    status:'available',
    sampleMatch:Boolean(launch.sampleMatch),
    lastSuccessfulRefreshAt:launch.lastSuccessfulRefreshAt || null,
  };
  return {
    id:launch.id,
    workspaceId:launch.workspaceId,
    type:'google-drive',
    label:launch.label,
    source:`Google Drive · ${launch.folderName || 'campaign folder'}`,
    status:launch.status || 'connected',
    lastSuccessfulRefreshAt:launch.lastSuccessfulRefreshAt || null,
    sampleMatch:Boolean(launch.sampleMatch),
    folderName:launch.folderName,
  };
}

export class LaunchManager {
  constructor({root, config, dataDirectory, registry, storage, engine: suppliedEngine, campaignDir, brandPath,
    aiSettings, provider, renderAsset:renderOverride, env = process.env, registryIO, driveOptions = {}} = {}) {
    this.root = root;
    this.config = config;
    this.env = env;
    this.registry = registry || new WorkspaceRegistry({dataDirectory,io:registryIO});
    this.storage = storage || new FileSystemWorkspaceStorage(dataDirectory);
    this.aiSettings = aiSettings;
    this.provider = provider;
    this.renderOverride = renderOverride;
    this.localCampaignDir = campaignDir;
    this.localBrandPath = brandPath;
    this.suppliedEngine = suppliedEngine;
    this.driveOptions = driveOptions;
    this.engines = new Map();
    this.lock = null;
    this.oauth = null;
    this.jobs = new Map();
    this.jobRecords = new FileSystemRecordStore(path.join(dataDirectory,'workspaces',DEFAULT_WORKSPACE_ID,'jobs'));
  }

  async initialize() {
    await this.registry.initialize();
    const workspace = this.registry.workspace(DEFAULT_WORKSPACE_ID);
    if (!workspace) throw new Error('The default Campaign Control workspace is unavailable.');
    if (this.aiSettings) this.aiSettings.workspaceId = workspace.id;
    const local = this.suppliedEngine || await this.createLocalEngine();
    local.workspaceId = workspace.id;
    local.launchId = DEFAULT_LOCAL_LAUNCH_ID;
    local.launchIdentity = {workspaceId:workspace.id,launchId:DEFAULT_LOCAL_LAUNCH_ID};
    if (this.aiSettings) {
      local.aiSettings = this.aiSettings;
      local.provider = this.aiSettings;
    }
    const sampleMatch = await isBundledSample(local.campaignDir,{brandPath:this.localBrandPath});
    local.isSampleCampaign = sampleMatch;
    local.allowDemoReset = sampleMatch;
    this.engines.set(DEFAULT_LOCAL_LAUNCH_ID,local);
    const existing = this.registry.launch(DEFAULT_LOCAL_LAUNCH_ID);
    const launches = this.registry.data.launches.map(item => item.id === DEFAULT_LOCAL_LAUNCH_ID ? {
      ...item,
      workspaceId:workspace.id,
      type:'local',
      label:sampleMatch ? 'Pro500 — Local example' : (local.campaign?.facts?.product || item.label || 'Local campaign'),
      sampleMatch,
    } : item);
    if (!existing) launches.unshift({id:DEFAULT_LOCAL_LAUNCH_ID,workspaceId:workspace.id,type:'local',label:'Local campaign',createdAt:new Date().toISOString(),sampleMatch});
    await this.registry.saveData({...this.registry.data,launches});
    for (const id of await this.jobRecords.list()) {
      const job = await this.jobRecords.read(id);
      if (['queued','running'].includes(job.status)) {job.status='interrupted';job.error='Server restarted during this job. No automatic retry was made.';await this.jobRecords.write(id,job);}
      this.jobs.set(id,job);
    }
    return this;
  }

  async createLocalEngine() {
    if (!this.localCampaignDir) throw new Error('Select a local campaign folder.');
    const aiSettings = this.aiSettings;
    const provider = aiSettings || this.provider;
    const brand = await loadBrand(this.localBrandPath);
    const engine = new CampaignEngine({
      root:this.root,
      campaignDir:this.localCampaignDir,
      artifactDir:this.localCampaignDir,
      provider,
      aiSettings,
      renderAsset:this.renderOverride || (input => renderAsset({...input,brand})),
      brandIdentitySha256:brandHash(brand),
      workspaceId:DEFAULT_WORKSPACE_ID,
      launchId:DEFAULT_LOCAL_LAUNCH_ID,
    });
    await engine.initialize();
    return engine;
  }

  driveClient(connectionId) {
    return new GoogleDriveClient({registry:this.registry,connectionId,...this.driveOptions});
  }

  snapshotPath(launch) {
    if (!launch.snapshot?.id || !/^snapshot-[A-Za-z0-9-]{20,100}$/.test(launch.snapshot.id)) throw new WorkflowError('Drive snapshot identity is missing or invalid. Refresh this launch.',409);
    return path.join(this.storage.snapshotRoot(launch.workspaceId,launch.id),launch.snapshot.id);
  }

  async createDriveEngine(launch) {
    const campaignDir = this.snapshotPath(launch);
    const artifactDir = this.storage.artifactRoot(launch.workspaceId,launch.id);
    const brandPathCandidate = path.join(campaignDir,'brand/identity.json');
    const brandPath = await fs.access(brandPathCandidate).then(()=>brandPathCandidate,()=>null);
    const brand = await loadBrand(brandPath);
    const client = this.driveClient(launch.connectionId);
    const engine = new CampaignEngine({
      root:this.root,
      campaignDir,
      artifactDir,
      provider:this.aiSettings || this.provider,
      aiSettings:this.aiSettings,
      renderAsset:this.renderOverride || (input => renderAsset({...input,brand})),
      brandIdentitySha256:brandHash(brand),
      sourceConnector:{
        verify:() => client.verifySnapshot(launch.snapshot),
        snapshot:launch.snapshot,
      },
      workspaceId:launch.workspaceId,
      launchId:launch.id,
      isSampleCampaign:Boolean(launch.sampleMatch),
      allowDemoReset:Boolean(launch.sampleMatch),
      sourceDisplay:`Google Drive · ${launch.folderName}`,
    });
    await engine.initialize();
    return engine;
  }

  async engine(launchId) {
    const launch = this.registry.launch(launchId);
    if (!launch) throw new WorkflowError('Unknown launch. Return to the launch chooser and refresh.',404);
    if (!this.engines.has(launchId)) {
      const engine = launch.type === 'local' ? this.engines.get(DEFAULT_LOCAL_LAUNCH_ID) : await this.createDriveEngine(launch);
      if (!engine) throw new WorkflowError('This launch is not available.',404);
      this.engines.set(launchId,engine);
    }
    return this.engines.get(launchId);
  }

  list() {
    return this.registry.data.launches.map(launch => {
      const engine = this.engines.get(launch.id);
      const state = engine?.state();
      return {
        ...publicLaunch(launch),
        campaignName:state?.campaign?.facts?.product || launch.snapshot?.campaignName || null,
        registered:state?.evidence?.registered ?? launch.snapshot?.assetCount ?? null,
        channelCount:state?.evidence?.channelCount ?? null,
        readiness:state?.launchReadiness || {
          label:launch.status === 'connected' ? 'Connected · open to inspect' : 'Not connected',
          tone:launch.status === 'connected' ? 'info' : 'warning',
        },
        workspacePath:launch.type === 'local' ? (engine?.campaignDir || this.localCampaignDir) : undefined,
      };
    });
  }

  acquire(launchId, kind) {
    if (this.lock) throw new WorkflowError(`Campaign Control is processing ${this.lock.kind} in another launch. Wait for it to finish.`,423);
    const token = randomUUID();
    this.lock = {token,launchId,kind,startedAt:new Date().toISOString()};
    return token;
  }

  release(token) {
    if (this.lock?.token === token) this.lock = null;
  }

  async withOperation(launchId, kind, work) {
    const token = this.acquire(launchId,kind);
    try { return await work(); }
    finally { this.release(token); }
  }

  startOperation(launchId, kind, start) {
    const token = this.acquire(launchId,kind);
    let result;
    try { result = start(); }
    catch (error) { this.release(token); throw error; }
    const engine = this.engines.get(launchId);
    Promise.resolve(engine?.task).finally(() => this.release(token)).catch(() => {});
    return result;
  }

  async startJob(launchId,kind,work) {
    const token=this.acquire(launchId,kind);
    const job={id:randomUUID(),workspaceId:DEFAULT_WORKSPACE_ID,launchId,kind,status:'queued',startedAt:new Date().toISOString(),progress:{message:`Starting ${kind}.`}};
    try {await this.jobRecords.write(job.id,job);}
    catch(error) {this.release(token);throw error;}
    this.jobs.set(job.id,job);
    const task=(async()=>{
      job.status='running';await this.jobRecords.write(job.id,job);
      const result=await work(job);
      job.status='completed';job.result={launchId:result?.launch?.id || launchId};
      job.progress={message:`${kind} complete.`};
    })().catch(error=>{
      job.status='failed';
      job.error=error instanceof WorkflowError || error instanceof GoogleDriveError ? error.message : 'The operation failed. Existing snapshots and work were preserved.';
    }).finally(async()=>{
      job.completedAt=new Date().toISOString();
      try {await this.jobRecords.write(job.id,job);} finally {this.release(token);}
    });
    task.catch(()=>{});
    return {jobId:job.id,workspaceId:job.workspaceId,launchId};
  }

  async job(launchId,id) {
    const job=this.jobs.get(id);
    if (job && job.launchId===launchId) return job;
    const engine=await this.engine(launchId);
    if (engine.run?.id===id) return engine.state().job;
    throw new WorkflowError('Job does not belong to this launch.',404);
  }

  async resetLaunch(launchId,input) {
    const engine=await this.engine(launchId), launch=this.registry.launch(launchId);
    if (input.launchId !== launchId || input.runId !== (engine.run?.id ?? null)) throw new WorkflowError('The launch changed. Refresh before resetting.');
    if (launch.type==='local') return engine.resetDemo({campaignId:engine.campaign.id,runId:input.runId});
    // Only application-owned outputs/state are archived; immutable snapshots and Drive originals remain untouched.
    engine.idle();engine.busy=true;
    try {return await resetDemoWorkspace(engine,{allowBlockedOriginals:true});}
    finally {engine.busy=false;}
  }

  async addDriveLaunch({folderId, connectionId, onProgress}) {
    const connection = this.registry.data.connections?.find(item => item.id === connectionId);
    if (!connection || connection.workspaceId !== DEFAULT_WORKSPACE_ID) throw new WorkflowError('Authorize Google Drive in this workspace before adding a campaign.',403);
    const id = randomUUID();
    const root = this.storage.snapshotRoot(DEFAULT_WORKSPACE_ID,id);
    await fs.mkdir(root,{recursive:true,mode:0o700});
    const client = this.driveClient(connectionId);
    const report = message => {const update = {message}; if (typeof onProgress === 'function') onProgress(update);};
    report('Reading the Drive folder and reserving a private snapshot space…');
    const acquired = await client.createSnapshot({folderId,destinationRoot:root,onProgress});
    report(`Snapshot acquired. Verifying the campaign manifest (${acquired.snapshot.files.length} files)…`);
    const brandPath = path.join(acquired.snapshotDir,'brand/identity.json');
    const sampleMatch = await isBundledSample(acquired.snapshotDir,{brandPath});
    const manifest = JSON.parse(await fs.readFile(path.join(acquired.snapshotDir,'campaign.json'),'utf8'));
    const launch = await this.registry.addDriveLaunch({
      id,
      folderId:acquired.snapshot.folderId,
      folderName:acquired.snapshot.folderName,
      connectionId,
      snapshot:{...acquired.snapshot,assetCount:manifest.assets.length,campaignName:manifest.facts?.product,dirId:acquired.snapshot.id},
      sampleMatch,
    });
    await this.registry.updateDriveLaunch(id,{label:sampleMatch ? 'Pro500 — Google Drive' : `${manifest.facts?.product || acquired.snapshot.folderName} — Google Drive`,folderName:acquired.snapshot.folderName});
    const engine = await this.createDriveEngine(this.registry.launch(id));
    this.engines.set(id,engine);
    return {launch:this.registry.launch(id),state:engine.state()};
  }

  async refreshDriveLaunch(launchId,{connectionId,onProgress} = {}) {
    const launch = this.registry.launch(launchId);
    if (!launch || launch.type !== 'google-drive') throw new WorkflowError('Google Drive launch not found.',404);
    if (connectionId !== undefined) {
      const connection = this.registry.data.connections?.find(item => item.id === connectionId);
      if (!connection || connection.workspaceId !== launch.workspaceId) throw new WorkflowError('Reconnect Google Drive in this workspace before refreshing.',403);
      const previousConnectionId = launch.connectionId;
      await this.registry.updateDriveLaunch(launchId,{connectionId,status:'connected'});
      // A replaced connection that no launch uses anymore is removed from private storage.
      if (previousConnectionId !== connectionId && !this.registry.data.launches.some(item => item.connectionId === previousConnectionId)) await this.registry.deleteConnection(previousConnectionId);
    }
    const report = message => {if (typeof onProgress === 'function') onProgress({message});};
    report('Re-reading the Drive folder and building a fresh snapshot…');
    const client = this.driveClient(this.registry.launch(launchId).connectionId);
    const destinationRoot = this.storage.snapshotRoot(launch.workspaceId,launch.id);
    await fs.mkdir(destinationRoot,{recursive:true,mode:0o700});
    const acquired = await client.createSnapshot({folderId:launch.folderId,destinationRoot,onProgress});
    report('Verifying the new snapshot before switching this launch to it…');
    const manifest = JSON.parse(await fs.readFile(path.join(acquired.snapshotDir,'campaign.json'),'utf8'));
    const brandPath = path.join(acquired.snapshotDir,'brand/identity.json');
    const sampleMatch = await isBundledSample(acquired.snapshotDir,{brandPath});
    const snapshot = {...acquired.snapshot,assetCount:manifest.assets.length,campaignName:manifest.facts?.product,dirId:acquired.snapshot.id};
    const oldEngine=await this.engine(launchId);
    if (oldEngine.run) {
      await oldEngine.records.write(`history/${oldEngine.run.id}`,{run:oldEngine.run,assets:oldEngine.assets,snapshot:launch.snapshot});
      await oldEngine.clearReady();
      oldEngine.run=null;oldEngine.assets=[];oldEngine.latestRelease=null;oldEngine.readyRelease=null;
      await oldEngine.save();
    }
    await this.registry.updateDriveLaunch(launchId,{
      folderName:acquired.snapshot.folderName,
      label:sampleMatch ? 'Pro500 — Google Drive' : `${manifest.facts?.product || acquired.snapshot.folderName} — Google Drive`,
      snapshot,
      sampleMatch,
      status:'connected',
      lastSuccessfulRefreshAt:snapshot.snapshotAt,
    });
    this.engines.delete(launchId);
    // A completed refresh clears any disconnect notice: the launch again works from a verified snapshot.
    const engine = await this.engine(launchId);
    if (engine.driftMessage) {engine.driftMessage = null; await engine.save();}
    return {launch:this.registry.launch(launchId),state:engine.state()};
  }

  async disconnectDriveLaunch(launchId, revoke) {
    const launch = this.registry.launch(launchId);
    if (!launch || launch.type !== 'google-drive') throw new WorkflowError('Google Drive launch not found.',404);
    // The caller holds the workspace processing lock for this operation; no run can be mid-flight.
    await revoke?.(launch.connectionId);
    await this.registry.deleteConnection(launch.connectionId);
    for (const item of this.registry.data.launches.filter(item => item.connectionId === launch.connectionId)) {
      await this.registry.updateDriveLaunch(item.id,{status:'disconnected'});
      const engine = this.engines.get(item.id);
      if (engine) {await engine.clearReady(); engine.driftMessage='Google Drive is disconnected. The recorded work is preserved; reconnect and refresh before continuing.'; await engine.save();}
    }
    return {disconnected:true,launchId};
  }

  async cardState(launchId) {
    const launch = this.registry.launch(launchId);
    if (!launch) throw new WorkflowError('Unknown launch.',404);
    const engine = await this.engine(launchId);
    return {launch:publicLaunch(launch),state:engine.state()};
  }
}
