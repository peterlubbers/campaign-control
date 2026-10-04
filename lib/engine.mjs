import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadMarketEvidence, EvidenceError} from './evidence.mjs';
import {assetFolder, folderSlug, reserveFolder} from './storage.mjs';
import {deliveryFiles, hasDeliverable} from './delivery.mjs';
import {createReadStream} from 'node:fs';
import {launchReadiness} from './readiness.mjs';
import {ProviderError} from './provider-errors.mjs';
import {supportsReviewLabel, validReviewLabel, reviewLabelFor} from './review-label.mjs';
import {resetDemoWorkspace} from './demo-reset.mjs';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const jsonHash = value => digest(JSON.stringify(value));
const ACTIVE = new Set(['interpreting', 'proposing', 'rendering', 'checking']);
const CHANNELS = new Set(['website', 'email', 'social', 'paid', 'video', 'sales', 'support', 'partners', 'in-product', 'events', 'press']);
const clone = value => JSON.parse(JSON.stringify(value));
const fileHash = async file => {const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');};
const artifactURL = relative => `/artifacts/${relative.split('/').map(encodeURIComponent).join('/')}`;

export class WorkflowError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

export async function containedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) throw new WorkflowError('Invalid file reference.', 400);
  const base = await fs.realpath(root);
  const candidate = path.resolve(base, relative);
  if (!candidate.startsWith(base + path.sep)) throw new WorkflowError('File is outside the authorized campaign.', 400);
  const resolved = await fs.realpath(candidate);
  if (!resolved.startsWith(base + path.sep) || !(await fs.stat(resolved)).isFile()) throw new WorkflowError('File is outside the authorized campaign or not a regular file.', 400);
  return resolved;
}

async function atomicJSON(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(temporary, file);
}

export function validateFacts(value) {
  if (!value || typeof value.product !== 'string' || !value.product.trim() || value.product.length > 80 || /[<>\r\n]/.test(value.product)) throw new WorkflowError('Provide a short, plain-text product name.', 400);
  if (typeof value.monthlyPrice !== 'number' || !Number.isFinite(value.monthlyPrice) || value.monthlyPrice < 0 || value.monthlyPrice > 1000000) throw new WorkflowError('Monthly price must be a number between 0 and 1,000,000.', 400);
  if (typeof value.sharing !== 'boolean') throw new WorkflowError('Confirm whether sharing is supported.', 400);
  if (!Number.isInteger(value.maxTeammates) || value.maxTeammates < 0 || value.maxTeammates > 10000 || (!value.sharing && value.maxTeammates !== 0)) throw new WorkflowError('Confirm a valid teammate allowance; removed sharing requires zero.', 400);
  return {product: value.product.trim(), monthlyPrice: value.monthlyPrice, sharing: value.sharing, maxTeammates: value.maxTeammates};
}

// These checks catch literal contradictions. The independent model audit handles meaning.
export function literalChecks(markdown, original, target) {
  const checks = [];
  const escaped = original.product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (original.product !== target.product) checks.push({name: 'Retired product name', status: new RegExp(`\\b${escaped}\\b`, 'i').test(markdown) ? 'fail' : 'pass', message: 'Check the complete candidate for the retired product name, including publisher metadata.'});
  if (original.monthlyPrice !== target.monthlyPrice) {
    const formats = [String(original.monthlyPrice), original.monthlyPrice.toLocaleString('en-US')].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    checks.push({name: 'Retired monthly offer', status: new RegExp(`\\$\\s*(?:${formats.join('|')})(?:\\.00)?(?![\\d,])\\s*(?:\\/\\s*(?:mo(?:nth)?|month)|per month|monthly|a month)`, 'i').test(markdown) ? 'fail' : 'pass', message: 'Literal monthly-price check; contextual commercial claims also receive a semantic audit.'});
  }
  checks.push({name: 'Substantive source', status: markdown.trim().length >= 20 ? 'pass' : 'fail', message: 'The candidate must contain real content.'});
  return checks;
}

export class LaunchEngine {
  constructor({root, campaignDir, provider, renderAsset, artifactDir, brandIdentitySha256 = null, allowDemoReset = false}) {
    this.root = root; this.campaignDir = campaignDir; this.provider = provider; this.renderAsset = renderAsset;
    this.artifactDir = artifactDir || campaignDir;
    this.brandIdentitySha256 = brandIdentitySha256;
    this.allowDemoReset = allowDemoReset;
    this.controlDir = path.join(this.artifactDir, '.launch-control');
    this.stateFile = path.join(this.controlDir, 'state.json');
    this.assets = []; this.campaign = null; this.marketEvidence = null; this.run = null; this.busy = false; this.events = []; this.inspectedAt = null; this.latestRelease = null; this.readyRelease = null; this.driftMessage = null;
  }

  async initialize() {
    await fs.mkdir(this.artifactDir, {recursive: true});
    try {await fs.lstat(path.join(this.controlDir,'reset-in-progress.json')); throw new WorkflowError('A demo reset was interrupted. Preserve the archive and recover the paths listed in .launch-control/reset-in-progress.json before restarting.',500);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    await this.readCampaign();
    try {
      const saved = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (saved.campaignId === this.campaign.id) {
        this.assets = saved.assets; this.run = saved.run; this.events = saved.events || []; this.inspectedAt = saved.inspectedAt; this.latestRelease = saved.latestRelease || null; this.readyRelease = saved.readyRelease || null; this.driftMessage = saved.driftMessage || null;
        if (this.run && ACTIVE.has(this.run.status)) {this.run.status = 'failed'; this.run.error = 'The server restarted during a run. Retained work is visible; start a new run to retry.'; this.run.approval = null;
          const timing = this.run.timings?.at(-1);
          if (timing && !timing.completedAt) {timing.completedAt = stamp(); timing.interrupted = true; timing.elapsedSeconds = null; this.run.metrics.elapsedSeconds = null;}
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new WorkflowError('Saved run state could not be read. Preserve it and inspect before continuing.', 500); }
    if (!this.assets.length) await this.scan();
    await this.refreshReadiness();
    await this.save();
  }

  async readCampaign() {
    const source = await fs.readFile(path.join(this.campaignDir, 'campaign.json'), 'utf8');
    const campaign = JSON.parse(source);
    validateFacts(campaign.facts);
    if (!Array.isArray(campaign.assets) || !campaign.assets.length || campaign.assets.length > 1000) throw new WorkflowError('Campaign must register 1–1,000 deliverables.', 400);
    const ids = new Set();
    for (const asset of campaign.assets) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(asset.id) || ids.has(asset.id) || !CHANNELS.has(asset.channel) || (asset.source != null && typeof asset.source !== 'string') || (asset.files != null && (!Array.isArray(asset.files) || asset.files.length > 100 || asset.files.some(file => !file || typeof file.path !== 'string')))) throw new WorkflowError('Campaign inventory has an invalid ID, duplicate, channel, or source.', 400);
      ids.add(asset.id);
    }
    let marketEvidence;
    try { marketEvidence = await loadMarketEvidence(this.campaignDir, campaign.marketEvidencePath); }
    catch (error) { if (error instanceof EvidenceError) throw new WorkflowError(error.message, 400); throw error; }
    this.campaign = campaign; this.manifestHash = digest(source); this.marketEvidence = marketEvidence;
  }

  event(type, details = {}) { this.events.push({at: stamp(), type, ...details}); }
  async save() { await atomicJSON(this.stateFile, {campaignId: this.campaign.id, assets: this.assets, run: this.run, events: this.events, inspectedAt: this.inspectedAt, latestRelease: this.latestRelease, readyRelease: this.readyRelease, driftMessage: this.driftMessage}); }
  idle() { if (this.busy) throw new WorkflowError('A run is already working. Wait for its current step.'); }
  assertRun(id) { if (!this.run || this.run.id !== id) throw new WorkflowError('That run is no longer current. Refresh the workbench.'); }
  async exclusive(work) {
    this.idle(); this.busy = true;
    try { return await work(); }
    catch (error) {
      if (this.run && ACTIVE.has(this.run.status)) {
        this.run.status = 'failed'; this.run.error = error instanceof ProviderError ? error.message : 'The current operation failed. No approval or completed package was created.';
        this.run.providerFailure = error instanceof ProviderError ? {code:error.code,details:error.details} : null;
        this.run.approval = null; this.run.package = null;
        this.event('operation_failed', {runId: this.run.id});
      }
      throw error;
    } finally { this.finishWork(); this.busy = false; await this.save(); }
  }

  async scan() {
    await this.readCampaign();
    const previous = new Map(this.assets.map(asset => [asset.id, asset]));
    this.assets = [];
    for (const entry of this.campaign.assets) {
      const asset = {...entry, required: entry.required !== false, sourceText: null, sourceHash: null, inputHash: null, inputFiles: [], sourcePreview: null, sourceFiles: [], candidateText: null, candidatePreview: null, candidateFiles: [], disposition: null, status: 'inventoried', reason: null, issues: [], checks: []};
      try {
        for (const input of entry.files || []) {
          const physical = await containedFile(this.campaignDir, input.path);
          const record = {path: path.basename(input.path), artifactPath: input.path, mime: typeof input.mime === 'string' ? input.mime : 'application/octet-stream', role: typeof input.role === 'string' ? input.role : 'existing-media', bytes: (await fs.stat(physical)).size, sha256: await fileHash(physical), url: artifactURL(input.path)};
          asset.inputFiles.push(record);
        }
        if (!entry.source) throw new WorkflowError('No editable source is linked. Supply a supported source or a manually revised replacement; this asset remains in scope.');
        if (!['.md', '.txt'].includes(path.extname(entry.source).toLowerCase())) throw new WorkflowError('This editable format has no revision adapter yet. Supply Markdown or plain-text copy, or handle its replacement manually.');
        const file = await containedFile(this.campaignDir, entry.source);
        if ((await fs.stat(file)).size > 250000) throw new WorkflowError('Source exceeds the supported text size.');
        asset.sourceText = new TextDecoder('utf-8', {fatal: true}).decode(await fs.readFile(file));
        if (asset.sourceText.includes('\0')) throw new WorkflowError('Editable copy must be UTF-8 text.');
        asset.inputHash = asset.sourceHash = digest(asset.sourceText);
        const old = previous.get(asset.id);
        if (old && (old.inputHash || old.sourceHash) === asset.inputHash && old.sourceHash === asset.sourceHash) {
          asset.sourceFiles = old.sourceFiles || []; asset.sourcePreview = old.sourcePreview;
        }
      } catch (error) {
        asset.status = 'blocked';
        asset.issues.push({severity: 'error', message: error instanceof WorkflowError ? error.message : 'A registered input is missing, unreadable, or outside the selected campaign.', evidence: entry.source || 'Editable source not linked'});
      }
      if (!asset.sourceFiles.length && asset.inputFiles.length) {
        asset.sourceFiles = clone(asset.inputFiles);
        const primary = asset.sourceFiles[0]; asset.sourcePreview = {url: primary.url, mime: primary.mime, role: primary.role};
      }
      this.assets.push(asset);
    }
    this.inspectedAt = stamp();
    this.event('inventory', {registered: this.assets.length, readable: this.assets.filter(a => a.sourceHash).length, manifestHash: this.manifestHash});
  }

  async clearReady() {
    this.readyRelease = null;
    const pointer = path.join(this.artifactDir, 'READY-TO-PUBLISH');
    try {
      const stat = await fs.lstat(pointer);
      if (!stat.isSymbolicLink()) throw new WorkflowError('READY-TO-PUBLISH is reserved for the release shortcut. Move the conflicting file before continuing.');
      await fs.unlink(pointer);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async createDraft(id = randomUUID()) {
    await this.clearReady();
    if (this.run) await atomicJSON(path.join(this.controlDir, 'history', `${this.run.id}.json`), {run: this.run, assets: this.assets});
    await this.scan();
    let originalFacts = clone(this.campaign.facts), baselineVersion = null;
    if (this.latestRelease && !this.latestRelease.partial) {
      const bytes = await fs.readFile(await containedFile(this.artifactDir, this.latestRelease.snapshotPath));
      if (digest(bytes) !== this.latestRelease.snapshotSha256) throw new WorkflowError('The approved source snapshot changed. Restore it before starting the next version.');
      const baseline = JSON.parse(bytes);
      originalFacts = clone(baseline.run.change); baselineVersion = this.latestRelease.version;
      const previous = new Map(baseline.assets.map(asset => [asset.id, asset]));
      for (const asset of this.assets) {
        const prior = previous.get(asset.id);
        // A changed external source is deliberate new input; unchanged inputs advance from the approved copy.
        if (prior?.candidateText && asset.inputHash === (prior.inputHash || prior.sourceHash)) {
          for (const file of prior.candidateFiles || []) {
            if (await fileHash(await containedFile(this.artifactDir, file.artifactPath)) !== file.sha256) throw new WorkflowError('An approved working representation changed. Restore it before using it as the next baseline.');
          }
          asset.sourceText = prior.candidateText; asset.sourceHash = digest(prior.candidateText);
          asset.sourceFiles = clone(prior.candidateFiles); asset.sourcePreview = clone(prior.candidatePreview);
          if (prior.candidateReviewLabel !== undefined) asset.sourceReviewLabel = prior.candidateReviewLabel;
          if (prior.nativeSlides) asset.metadata = {...asset.metadata, nativeSlides: clone(prior.nativeSlides)};
        }
      }
    }
    const draftFolder = await reserveFolder(this.artifactDir, 'working', 'v', 3);
    const productContext = this.campaign.productContext ? {capabilities: this.campaign.productContext.capabilities, unconfirmed: this.campaign.productContext.unconfirmed} : null;
    this.run = {id, version: path.basename(draftFolder), draftFolder, baselineVersion, brandIdentitySha256: this.brandIdentitySha256, status: 'draft', change: null, originalFacts, productContext: clone(productContext), marketEvidence: clone(this.marketEvidence), sourceManifestHash: this.manifestHash, startedAt: stamp(), completedAt: null, progress: {done: 0, total: this.assets.length, message: 'Draft. Confirm the change before requesting revisions.'}, candidateHash: null, approval: null, package: null, metrics: {activeHumanMinutes: null, manualBaselineMinutes: null, elapsedSeconds: null}, error: null, requests: []};
    this.driftMessage = null;
    this.event('draft_created', {runId: id, version: this.run.version, baselineVersion});
    await this.save();
  }

  async newRevision() {
    return this.exclusive(async () => {await this.createDraft(); return this.state();});
  }

  async resetDemo({campaignId, runId}) {
    this.idle();
    if (!this.allowDemoReset) throw new WorkflowError('Demo reset is available only for the included example campaign.',403);
    if (campaignId !== this.campaign.id || runId !== (this.run?.id ?? null)) throw new WorkflowError('The campaign changed. Refresh before resetting.');
    if (ACTIVE.has(this.run?.status)) throw new WorkflowError('Wait for the current update to finish before resetting.');
    this.busy=true;
    try {return await resetDemoWorkspace(this);}
    catch (error) {throw new WorkflowError(error.message,409);}
    finally {this.busy=false;}
  }

  // Opening a campaign checks its inventory without generating new originals.
  async openCampaign() {
    if (this.busy) return this.state();
    if (this.run) {
      await this.refreshReadiness();
      return this.exclusive(async () => {
        try {await this.assertSourcesCurrent();}
        catch (error) {
          await this.clearReady();
          this.run.status = 'stale'; this.run.approval = null; this.run.package = null;
          this.driftMessage = error.message;
        }
        return this.state();
      });
    }
    return this.exclusive(async () => {await this.scan(); return this.state();});
  }

  scopedAssets() {return this.run?.scope ? this.assets.filter(a => this.run.scope.assetIds.includes(a.id)) : this.assets;}

  resolutionFingerprint(asset) {
    return jsonHash({facts:this.run.change, sourceHash:asset.sourceHash, candidateText:asset.candidateText, files:asset.candidateFiles, checks:asset.checks, issues:asset.issues, proposalIssues:asset.proposalIssues, semanticAudit:asset.semanticAudit || null, nativeSlides:asset.nativeSlides || null, reviewLabel:asset.candidateReviewLabel ?? null});
  }

  canOverrideAI(asset) {
    const checks = asset?.checks || [];
    // A completed AI judgment can be accepted by a person. Missing audits, render
    // failures, literal contradictions and unresolved proposals cannot be waived.
    return Boolean(asset?.status === 'blocked' && asset.candidateText && hasDeliverable(asset)
      && checks.find(c => c.name === 'Independent semantic audit')?.status === 'fail'
      && checks.filter(c => c.name !== 'Independent semantic audit').every(c => c.status === 'pass')
      && ['Substantive source','Source to output identity','Publisher deliverable','Proposal resolved'].every(name => checks.some(c => c.name === name && c.status === 'pass'))
      && asset.issues?.some(i => i.severity === 'error') && !asset.proposalIssues?.some(i => i.severity === 'error')
      && (asset.semanticAudit ? asset.semanticAudit.status === 'blocked' : this.run?.counts?.audited > 0));
  }

  overrideCurrent(asset) {
    const decision = this.run?.assetDecisions?.[asset?.id];
    return Boolean(decision?.action === 'override' && this.canOverrideAI(asset) && decision.findingHash === this.resolutionFingerprint(asset));
  }

  assetCleared(asset) {return Boolean(asset && (asset.status === 'checked' || this.overrideCurrent(asset)));}

  async resolveAsset(id, assetId, {action, candidateHash, reviewer, reason, markReviewed = false}) {
    this.assertRun(id);
    if (!['override','exclude','restore'].includes(action) || typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 120 || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new WorkflowError('Choose a resolution and provide your name and a reason of 1–2,000 characters.',400);
    return this.exclusive(async () => {
      if (!['review','blocked','rejected','approved'].includes(this.run.status) || !this.run.candidateHash) throw new WorkflowError('Resolve assets in a checked, unreleased version.');
      const asset = this.assets.find(a => a.id === assetId), previous = this.run.assetDecisions?.[assetId];
      const included = this.scopedAssets().map(a => a.id);
      if (!asset || (!included.includes(assetId) && !(action === 'restore' && previous?.action === 'exclude'))) throw new WorkflowError('Unknown or out-of-scope asset.',404);
      await this.assertSourcesCurrent();
      if (!candidateHash || candidateHash !== this.run.candidateHash || candidateHash !== await this.computeCandidateHash({verify:false})) throw new WorkflowError('Candidate changed. Refresh before resolving this asset.');
      if (action === 'override' && !this.canOverrideAI(asset)) throw new WorkflowError('Only a completed AI finding can be overridden. Fix missing outputs, failed integrity checks or unresolved proposals first.');
      if (action === 'restore' && !previous) throw new WorkflowError('There is no recorded resolution to undo.');
      const nextIds = action === 'exclude' ? included.filter(value => value !== assetId) : action === 'restore' && previous.action === 'exclude' ? this.assets.filter(a => included.includes(a.id) || a.id === assetId).map(a => a.id) : included;
      if (!nextIds.length) throw new WorkflowError('Keep at least one asset in the release.');
      await this.computeCandidateHash({verifyAssetIds:nextIds});
      const oldReviews = clone(this.run.reviews || {});
      const record = {action, assetId, reviewer:reviewer.trim(), reason:reason.trim(), at:stamp(), previousCandidateHash:candidateHash,
        ...(action === 'override' ? {findingHash:this.resolutionFingerprint(asset), findings:clone(asset.issues), audit:clone(asset.checks.find(c => c.name === 'Independent semantic audit'))} : {})};
      await this.clearReady();
      this.run.assetDecisions ||= {};
      if (action === 'restore') delete this.run.assetDecisions[assetId]; else this.run.assetDecisions[assetId] = record;
      this.run.resolutionHistory ||= []; this.run.resolutionHistory.push(clone(record));
      this.run.scope = {assetIds:nextIds, excludedAssetIds:this.assets.filter(a => !nextIds.includes(a.id)).map(a => a.id), inventoryCount:this.assets.length, initialAssetIds:this.run.scope?.initialAssetIds || included};
      if (this.run.reviewAssetIds) {
        const reviews = this.run.reviewAssetIds.filter(value => nextIds.includes(value));
        const choices = this.scopedAssets().slice().sort((a,b) => Number(this.assetCleared(b)) - Number(this.assetCleared(a)) || Number(b.channel === asset.channel) - Number(a.channel === asset.channel));
        for (const a of choices) if (reviews.length < Math.min(4,nextIds.length) && !reviews.includes(a.id)) reviews.push(a.id);
        this.run.reviewAssetIds = reviews;
      }
      this.run.approval = null; this.run.package = null; this.run.reviews = {};
      this.run.candidateHash = await this.computeCandidateHash({verify:false});
      for (const [reviewId, review] of Object.entries(oldReviews)) if (reviewId !== assetId && this.run.reviewAssetIds?.includes(reviewId) && review.candidateHash === candidateHash && this.assetCleared(this.assets.find(a => a.id === reviewId))) {
        this.run.reviews[reviewId] = {...review,candidateHash:this.run.candidateHash,carriedForwardFrom:candidateHash,carriedForwardAt:record.at};
      }
      if (action === 'override' && markReviewed === true && this.run.reviewAssetIds?.includes(assetId)) this.run.reviews[assetId] = {candidateHash:this.run.candidateHash,at:record.at,recordedWith:'Explicit AI override',reviewer:record.reviewer};
      this.run.status = this.scopedAssets().some(a => a.required && !this.assetCleared(a)) ? 'blocked' : 'review';
      this.run.progress.message = 'Human resolution recorded. Review the current release scope before final approval.';
      this.event('asset_resolution', {runId:id, ...record, candidateHash:this.run.candidateHash});
      return this.state();
    });
  }

  beginWork(kind, startedAt = stamp()) {
    this.run.timings ||= [];
    this.run.timings.push({kind, startedAt, completedAt: null, elapsedSeconds: null});
    if (kind === 'update') this.run.startedAt = startedAt;
  }

  finishWork() {
    const timing = this.run?.timings?.at(-1);
    if (!timing || timing.completedAt) return;
    timing.completedAt = stamp();
    timing.elapsedSeconds = Math.max(0, (Date.parse(timing.completedAt) - Date.parse(timing.startedAt)) / 1000);
    this.run.metrics.elapsedSeconds = this.run.timings.some(item => item.interrupted) ? null : this.run.timings.reduce((sum, item) => sum + (item.elapsedSeconds || 0), 0);
  }

  processingSummary() {
    if (!this.run) return null;
    const timings = this.run.timings || [];
    const elapsedSeconds = timings.some(item => item.interrupted) ? null : timings.length ? timings.reduce((sum, item) => sum + (item.elapsedSeconds ?? Math.max(0, (Date.now() - Date.parse(item.startedAt)) / 1000)), 0) : this.run.metrics?.elapsedSeconds ?? null;
    return {total: this.scopedAssets().length, proposed: this.run.counts?.proposed || 0, produced: this.scopedAssets().filter(hasDeliverable).length, audited: this.run.counts?.audited || 0, elapsedSeconds, running: Boolean(timings.length && !timings.at(-1).completedAt)};
  }

  startBrief({brief, assetIds, reviewAssetIds}) {
    this.idle();
    const startedAt = stamp();
    if (typeof brief !== 'string' || !brief.trim() || brief.length > 4000) throw new WorkflowError('Provide a revision brief of 1–4,000 characters.', 400);
    if (assetIds !== undefined && (!Array.isArray(assetIds) || !assetIds.length || new Set(assetIds).size !== assetIds.length || assetIds.some(id => !this.assets.some(a => a.id === id)))) throw new WorkflowError('Choose existing assets for this release.', 400);
    if (reviewAssetIds !== undefined && (!Array.isArray(reviewAssetIds) || reviewAssetIds.length !== Math.min(4, assetIds?.length || this.assets.length) || new Set(reviewAssetIds).size !== reviewAssetIds.length || reviewAssetIds.some(id => !this.assets.some(a => a.id === id)))) throw new WorkflowError('Choose four distinct representative assets, or every asset when the scope is smaller.', 400);
    const requestedIds = assetIds ? [...assetIds] : null;
    const id = this.run?.status === 'draft' ? this.run.id : randomUUID();
    this.busy = true;
    this.task = (async () => {
      if (this.run?.id !== id || this.run.status !== 'draft') await this.createDraft(id);
      this.beginWork('update', startedAt);
      this.run.counts = {proposed: 0, audited: 0};
      const selected = requestedIds || this.assets.map(a => a.id);
      if (selected.some(id => !this.assets.some(a => a.id === id))) throw new WorkflowError('Campaign inventory changed. Choose the release scope again.');
      this.run.brief = brief;
      this.run.scope = {assetIds: selected, excludedAssetIds: this.assets.filter(a => !selected.includes(a.id)).map(a => a.id), inventoryCount: this.assets.length};
      if (reviewAssetIds?.some(id => !selected.includes(id))) throw new WorkflowError('Representative assets must be included in the release.');
      const preferred = ['website', 'video', 'social', 'sales'];
      const reviewIds = reviewAssetIds ? [...reviewAssetIds] : preferred.map(channel => this.scopedAssets().find(a => a.channel === channel)?.id).filter(Boolean);
      for (const asset of this.scopedAssets()) if (reviewIds.length < 4 && !reviewIds.includes(asset.id)) reviewIds.push(asset.id);
      this.run.reviewAssetIds = reviewIds; this.run.reviews = {};
      this.run.status = 'interpreting';
      this.run.progress = {done: 0, total: selected.length, message: 'Reading your brief and resolving the requested product changes.'};
      await this.save();
      const interpretation = await this.provider.interpretBrief({brief, facts: this.run.originalFacts, onRetry:async ({attempt,waitSeconds}) => {this.run.progress.message = `AI rate limit: waiting ${waitSeconds}s before retry ${attempt} of 2. Your brief and release scope are preserved.`; await this.save();}});
      this.run.requests.push(...(interpretation.requests || []));
      this.run.interpretation = interpretation.summary;
      this.run.questions = interpretation.questions;
      if (interpretation.questions.length) {this.run.status = 'blocked'; this.run.progress.message = 'Clarify the brief before revising assets.'; await this.save(); return;}
      const facts = validateFacts(interpretation.change);
      await this.build(id, {...facts, instruction: brief});
    })().catch(async error => {
      if (this.run?.id === id) {this.run.status = 'failed'; this.run.error = error.message; this.run.providerFailure = error instanceof ProviderError ? {code:error.code,details:error.details} : null; this.run.approval = null; this.event('run_failed', {runId: id, message: error.message});}
    }).finally(async () => {if (this.run?.id === id) this.finishWork(); this.busy = false; await this.save();});
    return {runId: id};
  }

  async reviewAsset(id, assetId, {candidateHash}) {
    this.assertRun(id);
    return this.exclusive(async () => {
      if (!['review', 'blocked', 'rejected'].includes(this.run.status) || !this.run.reviewAssetIds?.includes(assetId)) throw new WorkflowError('This asset is not awaiting a representative review.');
      await this.assertSourcesCurrent();
      if (!candidateHash || candidateHash !== this.run.candidateHash || candidateHash !== await this.computeCandidateHash()) throw new WorkflowError('Candidate changed. Refresh and review again.');
      if (!this.assetCleared(this.assets.find(a => a.id === assetId))) throw new WorkflowError('Resolve this asset’s checks before marking it reviewed.');
      this.run.reviews ||= {};
      this.run.reviews[assetId] = {candidateHash, at: stamp()};
      this.event('asset_reviewed', {runId: id, assetId, candidateHash});
      return this.state();
    });
  }

  async verifyRelease(release) {
    const manifestFile = await containedFile(this.artifactDir, `${release.directory}/manifest.json`);
    const raw = await fs.readFile(manifestFile);
    if (digest(raw) !== release.manifestSha256) throw new WorkflowError('Release manifest changed after approval.');
    const manifest = JSON.parse(raw);
    if (manifest.candidateHash !== release.candidateHash) throw new WorkflowError('Release identity changed after approval.');
    for (const file of [...manifest.assets.flatMap(asset => asset.files), ...manifest.companions]) {
      const actual = await fileHash(await containedFile(this.artifactDir, `${release.directory}/${file.path}`));
      if (actual !== file.sha256) throw new WorkflowError('A released file changed after approval.');
    }
    if (await fileHash(await containedFile(this.artifactDir, release.archivePath)) !== release.sha256) throw new WorkflowError('Release archive changed after approval.');
  }

  async refreshReadiness() {
    if (this.busy || !this.readyRelease) return;
    this.busy = true;
    try {
      await this.assertSourcesCurrent();
      if (!this.run?.approval || this.run.approval.candidateHash !== await this.computeCandidateHash()) throw new WorkflowError('Approval is no longer current.');
      await this.verifyRelease(this.readyRelease);
      if (await fs.readlink(path.join(this.artifactDir, 'READY-TO-PUBLISH')) !== this.readyRelease.directory) throw new WorkflowError('The ready-to-publish shortcut changed.');
    } catch {
      this.driftMessage = 'Campaign or release files changed. Start a new revision and review again. Previous release records are preserved.';
      if (this.run) {this.run.status = 'stale'; this.run.approval = null; this.run.package = null;}
      try {await this.clearReady();}
      catch {this.driftMessage += ' A conflicting READY-TO-PUBLISH file was preserved; move it before continuing.';}
      this.event('readiness_invalidated');
      await this.save();
    } finally {this.busy = false;}
  }

  async inspect() {
    return this.exclusive(async () => {
      if (this.run) throw new WorkflowError('Start a new run to rescan while preserving the current run record.');
      await this.scan();
      for (const asset of this.assets) if (asset.sourceText) {
        try { await this.render(asset, 'source', this.campaign.facts); }
        catch {asset.issues.push({severity: 'warning', message: 'Original preview could not be produced; the source text is available.', evidence: asset.source});}
      }
      return this.state();
    });
  }

  async render(asset, side, facts) {
    // Readable versions preserve reviewed bytes, including style-only changes.
    const parent = `${side === 'source' ? 'assets' : this.run.draftFolder}/${assetFolder(asset)}`;
    const relativeDir = await reserveFolder(this.artifactDir, parent, 'v');
    const outputDir = path.join(this.artifactDir, relativeDir);
    const text = side === 'source' ? asset.sourceText : asset.candidateText;
    const reviewLabel = side === 'source' ? asset.sourceReviewLabel : asset.candidateReviewLabel ?? asset.sourceReviewLabel;
    const result = await this.renderAsset({asset, markdown: text, outputDir, facts, reviewLabel});
    if (!Array.isArray(result.files) || !result.files.length) throw new WorkflowError('Renderer returned no files.');
    const files = [];
    for (const file of result.files) {
      const physical = await containedFile(outputDir, file.path);
      const bytes = await fs.readFile(physical);
      files.push({...file, artifactPath: `${relativeDir}/${file.path}`, sha256: digest(bytes), bytes: bytes.length, url: `/artifacts/${relativeDir}/${file.path.split(path.sep).map(encodeURIComponent).join('/')}`});
    }
    const primary = files.find(f => f.path === result.primaryPath) || files[0];
    asset[`${side}Files`] = files;
    asset[`${side}Preview`] = {url: primary.url, mime: primary.mime, role: primary.role};
    if (side === 'candidate') {
      asset.renderChecks = result.checks || [];
      asset.renderText = result.textContent;
      asset.renderedSourceHash = digest(text);
      if (reviewLabel !== undefined) asset.renderedReviewLabel = reviewLabel;
      asset.nativeSlides = result.nativeSlides || null;
    }
  }

  start(change) {
    this.idle();
    const startedAt = stamp();
    const facts = validateFacts(change);
    if (typeof change.instruction !== 'undefined' && (typeof change.instruction !== 'string' || change.instruction.length > 4000)) throw new WorkflowError('Keep the change instruction under 4,000 characters.', 400);
    const id = this.run?.status === 'draft' ? this.run.id : randomUUID();
    this.busy = true;
    this.task = this.build(id, {...facts, instruction: change.instruction || ''}, startedAt).catch(async error => {
      if (this.run?.id === id) {this.run.status = 'failed'; this.run.error = error.message; this.run.providerFailure = error instanceof ProviderError ? {code:error.code,details:error.details} : null; this.run.approval = null; this.event('run_failed', {runId: id, message: error.message});}
    }).finally(async () => {if (this.run?.id === id) this.finishWork(); this.busy = false; await this.save();});
    return {runId: id};
  }

  async build(id, change, startedAt = stamp()) {
    if (this.run?.id !== id || !['draft', 'interpreting'].includes(this.run.status)) await this.createDraft(id);
    if (this.run.status !== 'interpreting') this.beginWork('update', startedAt);
    await this.clearReady();
    this.run.change = change; this.run.status = 'proposing';
    this.run.counts = {proposed: 0, audited: 0};
    this.run.progress = {done: 0, total: this.scopedAssets().length, message: 'Reading all included assets and preparing coordinated revisions.'};
    const productContext = this.run.productContext;
    this.event('run_started', {runId: id, registered: this.assets.length, facts: change});
    await this.save();
    if (this.scopedAssets().some(a => a.required && !a.sourceHash)) {this.run.status = 'blocked'; this.run.progress.message = 'A required source cannot be read. Correct the inventory before retrying.'; return;}
    const inputs = this.scopedAssets().filter(a => a.sourceText).map(a => ({id: a.id, title: a.title, channel: a.channel, kind: a.kind, markdown: a.sourceText}));
    const result = await this.provider.proposeAssets({facts: this.run.originalFacts, change, assets: inputs, productContext: clone(this.run.productContext), marketEvidence: clone(this.run.marketEvidence), onProgress: async p => {this.run.progress = p; this.run.counts.proposed = p.done; await this.save();}});
    if (!Array.isArray(result.assets) || result.assets.length !== inputs.length || new Set(result.assets.map(a => a.id)).size !== inputs.length || result.assets.some(a => !inputs.find(i => i.id === a.id))) throw new WorkflowError('The proposal response does not cover the exact inventory.');
    this.run.requests.push(...(result.requests || [])); this.run.provider = {provider: result.provider, model: result.model, usage: result.usage};
    this.run.counts.proposed = result.assets.length;
    this.run.status = 'rendering';
    this.run.progress = {done: 0, total: inputs.length, message: 'Producing revised media and publisher companions.'};
    await this.save();
    for (const asset of this.scopedAssets()) {
      const proposal = result.assets.find(a => a.id === asset.id);
      if (!proposal) continue;
      asset.candidateText = proposal.markdown; asset.disposition = proposal.disposition; asset.reason = proposal.reason; asset.issues = proposal.issues || []; asset.proposalIssues = clone(asset.issues); asset.status = proposal.disposition;
      try {
        if (!asset.sourcePreview) await this.render(asset, 'source', this.run.originalFacts);
        await this.render(asset, 'candidate', change);
      } catch {asset.renderChecks = [{name: 'Output production', status: 'fail', message: 'Required output production failed. Review the format capability before retrying.'}]; asset.status = 'blocked';}
      this.run.progress = {done: this.assets.filter(a => a.candidateText !== null).length, total: this.scopedAssets().length, message: `Producing actual outputs: ${asset.title}`};
      await this.save();
    }
    await this.check();
  }

  async assertSourcesCurrent() {
    if ((this.run.brandIdentitySha256 || null) !== this.brandIdentitySha256) throw new WorkflowError('The selected brand changed. Start a new version and review its rendered outputs.');
    const manifest = await fs.readFile(path.join(this.campaignDir, 'campaign.json'), 'utf8');
    if (digest(manifest) !== this.run.sourceManifestHash) throw new WorkflowError('Campaign facts or scope changed since this run. Start a fresh run.');
    let evidence;
    try { evidence = await loadMarketEvidence(this.campaignDir, this.campaign.marketEvidencePath); }
    catch { throw new WorkflowError('Market evidence is no longer available or valid. Start a fresh run after restoring the intended evidence.'); }
    if (jsonHash(evidence) !== jsonHash(this.run.marketEvidence || null)) throw new WorkflowError('Market evidence changed since this run. Start a fresh run so proposals and checks use the same evidence.');
    for (const asset of this.assets) {
      for (const input of asset.inputFiles || []) {
        if (await fileHash(await containedFile(this.campaignDir, input.artifactPath)) !== input.sha256) throw new WorkflowError(`Registered media for ${asset.id} changed during this run.`);
      }
      if (!asset.inputHash && !asset.sourceHash) continue;
      let hash;
      try {hash = digest(await fs.readFile(await containedFile(this.campaignDir, asset.source)));} catch {throw new WorkflowError(`Source ${asset.id} is no longer available.`);}
      if (hash !== (asset.inputHash || asset.sourceHash)) throw new WorkflowError(`Source ${asset.id} changed during this run. Start a fresh run.`);
    }
  }

  async computeCandidateHash({verify = true, verifyAssetIds = this.scopedAssets().map(a => a.id)} = {}) {
    const assets = [];
    for (const asset of this.assets) {
      const files = [];
      for (const file of asset.candidateFiles || []) {
        if (verify && verifyAssetIds.includes(asset.id)) {
          const actual = digest(await fs.readFile(await containedFile(this.artifactDir, file.artifactPath)));
          if (actual !== file.sha256) throw new WorkflowError(`Rendered content for ${asset.id} changed after checking. Rerender and review.`);
        }
        files.push({path: file.path, artifactPath: file.artifactPath, sha256: file.sha256, mime: file.mime, role: file.role, bytes: file.bytes});
      }
      assets.push({id: asset.id, title: asset.title, channel: asset.channel, disposition: asset.disposition, required: asset.required, sourceHash: asset.sourceHash, candidateTextHash: asset.candidateText === null ? null : digest(asset.candidateText), reason: asset.reason, issues: asset.issues, files, checks: asset.checks, nativeSlides: asset.nativeSlides, ...(asset.candidateReviewLabel !== undefined ? {reviewLabel:asset.candidateReviewLabel} : {}), ...(asset.revisionContext ? {revisionContext:asset.revisionContext} : {})});
    }
    return jsonHash({scope: this.run.scope || null, reviewAssetIds: this.run.reviewAssetIds || null, brandIdentitySha256: this.run.brandIdentitySha256 || null, version: this.run.version, baselineVersion: this.run.baselineVersion, sourceManifestHash: this.run.sourceManifestHash, facts: this.run.change, productContext: this.run.productContext || null, marketEvidence: this.run.marketEvidence || null, assets, ...(Object.keys(this.run.assetDecisions || {}).length ? {assetDecisions:this.run.assetDecisions} : {})});
  }

  async check() {
    await this.clearReady();
    for (const [assetId, decision] of Object.entries(this.run.assetDecisions || {})) if (decision.action === 'override') {
      delete this.run.assetDecisions[assetId];
      const invalidated = {action:'invalidated',assetId,at:stamp(),reason:'Fresh AI checks require a new human override.',previousDecision:decision};
      (this.run.resolutionHistory ||= []).push(invalidated); this.event('override_invalidated',{runId:this.run.id,...invalidated});
    }
    this.run.approval = null; this.run.package = null; this.run.candidateHash = null; this.run.reviews = {}; this.run.status = 'checking';
    await this.assertSourcesCurrent();
    const candidates = this.scopedAssets().filter(a => a.candidateText).map(a => ({id: a.id, markdown: a.candidateText, sourceMarkdown: a.sourceText, ...(a.revisionContext ? {revisionContext:a.revisionContext} : {})}));
    this.run.counts ||= {proposed: candidates.length, audited: 0};
    this.run.counts.audited = 0;
    this.run.progress = {done: 0, total: candidates.length, message: 'Independently auditing every candidate and its publisher metadata.'};
    await this.save();
    const audit = await this.provider.auditAssets({facts: this.run.change, originalFacts: this.run.originalFacts, assets: candidates, productContext: clone(this.run.productContext || null), marketEvidence: clone(this.run.marketEvidence || null), onProgress: async p => {this.run.progress = p; this.run.counts.audited = p.done; await this.save();}});
    if (audit.assets.length !== candidates.length || new Set(audit.assets.map(a => a.id)).size !== candidates.length) throw new WorkflowError('Audit did not cover every candidate.');
    this.run.requests.push(...(audit.requests || []));
    this.run.counts.audited = audit.assets.length;
    for (const asset of this.scopedAssets()) {
      const finding = audit.assets.find(a => a.id === asset.id);
      asset.semanticAudit = finding ? clone(finding) : null;
      asset.checks = [...(asset.renderChecks || []), ...literalChecks(asset.candidateText || '', this.run.originalFacts, this.run.change)];
      asset.issues = [...(asset.proposalIssues || []), ...(finding?.issues || [])];
      const complete = asset.candidateFiles?.length && asset.renderedSourceHash === digest(asset.candidateText || '') && asset.renderedReviewLabel === (asset.candidateReviewLabel ?? asset.sourceReviewLabel);
      asset.checks.push({name: 'Source to output identity', status: complete ? 'pass' : 'fail', message: complete ? 'All recorded companions were produced from this exact candidate source.' : 'Required rendered output is missing or stale.'});
      asset.checks.push({name: 'Independent semantic audit', status: finding?.status === 'pass' ? 'pass' : 'fail', message: finding?.status === 'pass' ? 'A separate live model pass reviewed the complete candidate copy.' : 'The semantic audit has unresolved findings or is missing.'});
      asset.checks.push({name: 'Publisher deliverable', status: hasDeliverable(asset) ? 'pass' : 'fail', message: 'A release must contain a finished deliverable, not only editable source or review evidence.'});
      asset.checks.push({name: 'Proposal resolved', status: asset.disposition === 'blocked' ? 'fail' : 'pass', message: asset.disposition === 'blocked' ? 'The proposal requires human resolution before release.' : 'The candidate has no unresolved proposal block.'});
      asset.status = asset.checks.some(c => ['fail', 'blocked', 'error'].includes(c.status)) || asset.issues.some(i => i.severity === 'error') ? 'blocked' : 'checked';
    }
    await this.assertSourcesCurrent();
    this.run.candidateHash = await this.computeCandidateHash();
    this.run.completedAt = stamp();
    if (!this.run.timings?.length) this.run.metrics.elapsedSeconds = (Date.parse(this.run.completedAt) - Date.parse(this.run.startedAt)) / 1000;
    this.run.status = this.scopedAssets().some(a => a.required && a.status !== 'checked') ? 'blocked' : 'review';
    this.run.progress = {done: candidates.length, total: this.scopedAssets().length, message: this.run.status === 'review' ? 'Candidate ready for human review. No package exists yet.' : 'Resolve required exceptions before approval.'};
    this.event('checks_completed', {runId: this.run.id, candidateHash: this.run.candidateHash, blocked: this.assets.filter(a => a.status === 'blocked').map(a => a.id)});
    await this.save();
  }

  async requestRevision(id, assetId, {feedback, candidateHash}) {
    this.assertRun(id);
    if (typeof feedback !== 'string' || !feedback.trim() || feedback.length > 2000) throw new WorkflowError('Describe the correction in 1–2,000 characters.', 400);
    return this.exclusive(async () => {
      const asset = this.assets.find(a => a.id === assetId);
      if (!asset || !this.scopedAssets().includes(asset)) throw new WorkflowError('Unknown or out-of-scope asset.', 404);
      if (!['review', 'blocked', 'rejected', 'approved'].includes(this.run.status) || !asset.candidateText) throw new WorkflowError('This version is not available for an asset revision.');
      if (typeof this.provider.reviseAsset !== 'function') throw new WorkflowError('Restart Campaign Control to load asset revisions.', 503);
      await this.assertSourcesCurrent();
      if (!candidateHash || candidateHash !== this.run.candidateHash || candidateHash !== await this.computeCandidateHash()) throw new WorkflowError('Candidate changed. Refresh before requesting a revision.');
      const editable = supportsReviewLabel(asset);
      const previousMarkdown = asset.candidateText, previousReviewLabel = editable ? reviewLabelFor(asset) : null;
      const record = {assetId, feedback:feedback.trim(), requestedAt:stamp(), previousCandidateHash:candidateHash, status:'pending'};
      this.run.assetRevisions ||= []; this.run.assetRevisions.push(record);
      this.beginWork('asset-revision');
      await this.clearReady();
      this.run.approval = null; this.run.package = null; this.run.candidateHash = null; this.run.reviews = {}; this.run.error = null; this.run.providerFailure = null;
      this.run.status = 'proposing';
      this.run.progress = {done:0, total:1, message:`Applying your revision request to ${asset.id}. Other asset outputs are preserved.`};
      this.event('asset_revision_requested', {runId:id, ...record});
      await this.save();
      try {
        const result = await this.provider.reviseAsset({facts:this.run.change, originalFacts:this.run.originalFacts, feedback:record.feedback, reviewPresentation:{editable,label:previousReviewLabel}, assets:[{id:asset.id,title:asset.title,channel:asset.channel,kind:asset.kind,markdown:previousMarkdown,sourceMarkdown:asset.sourceText}], productContext:clone(this.run.productContext || null), marketEvidence:clone(this.run.marketEvidence || null), onProgress:async p => {this.run.progress = p; await this.save();}});
        const proposal = result.assets?.[0];
        if (result.assets?.length !== 1 || proposal.id !== asset.id || typeof proposal.markdown !== 'string' || proposal.markdown.trim().length < 20 || (editable ? !validReviewLabel(proposal.reviewLabel) : proposal.reviewLabel !== null)) throw new WorkflowError('The revision response does not match the selected asset.');
        this.run.requests.push(...(result.requests || []));
        asset.candidateText = proposal.markdown;
        if (editable) asset.candidateReviewLabel = proposal.reviewLabel;
        asset.revisionContext = {feedback:record.feedback, previousMarkdown, previousReviewLabel, reviewLabel:proposal.reviewLabel};
        asset.disposition = proposal.disposition === 'blocked' ? 'blocked' : (proposal.markdown === asset.sourceText && (!editable || proposal.reviewLabel === reviewLabelFor({...asset,candidateReviewLabel:undefined})) ? 'unchanged' : 'changed');
        asset.reason = proposal.reason; asset.proposalIssues = clone(proposal.issues || []); asset.issues = clone(asset.proposalIssues); asset.status = 'checking';
        this.run.status = 'rendering';
        this.run.progress = {done:0,total:1,message:`Producing a new revision of ${asset.id}. Earlier files stay intact.`};
        await this.save();
        await this.render(asset, 'candidate', this.run.change);
        await this.check();
        record.status = asset.status === 'checked' ? 'completed' : 'blocked'; record.reason = proposal.reason; record.candidateHash = this.run.candidateHash;
        this.event('asset_revision_completed', {runId:id,assetId,candidateHash:this.run.candidateHash,status:record.status});
      } catch (error) {record.status = 'failed'; throw error;}
      finally {record.completedAt = stamp();}
      return this.state();
    });
  }

  async edit(id, assetId, markdown) {
    this.assertRun(id);
    if (typeof markdown !== 'string' || markdown.trim().length < 20 || markdown.length > 100000) throw new WorkflowError('Provide a substantive candidate under 100,000 characters.', 400);
    return this.exclusive(async () => {
      const asset = this.assets.find(a => a.id === assetId);
      if (!asset || !this.scopedAssets().includes(asset)) throw new WorkflowError('Unknown or out-of-scope asset.', 404);
      if (this.run.status === 'packaged') throw new WorkflowError('Create a new revision before editing an approved release.');
      this.beginWork('correction');
      await this.clearReady();
      this.run.approval = null; this.run.package = null; this.run.candidateHash = null;
      asset.candidateText = markdown; asset.disposition = markdown === asset.sourceText ? 'unchanged' : 'changed'; asset.reason = 'Human-edited candidate; fresh checks required.'; asset.proposalIssues = []; asset.issues = []; asset.status = 'checking';
      this.run.status = 'rendering';
      this.event('human_revision', {runId: id, assetId, contentHash: digest(markdown)});
      await this.render(asset, 'candidate', this.run.change);
      await this.check();
      return this.state();
    });
  }

  async recheck(id) {
    this.assertRun(id);
    return this.exclusive(async () => {if (this.run.status === 'packaged') throw new WorkflowError('Create a new revision before rechecking a released version.'); this.beginWork('recheck'); await this.check(); return this.state();});
  }

  async decide(id, {decision, candidateHash, reviewer, comment = ''}) {
    this.assertRun(id);
    return this.exclusive(async () => {
      if (!['approve', 'reject'].includes(decision) || typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 120 || typeof comment !== 'string' || comment.length > 2000) throw new WorkflowError('Provide a reviewer and an explicit approve or reject decision.', 400);
      await this.assertSourcesCurrent();
      const currentHash = await this.computeCandidateHash();
      if (!candidateHash || candidateHash !== this.run.candidateHash || candidateHash !== currentHash) throw new WorkflowError('Candidate changed. Refresh and review the current version.');
      if (decision === 'approve' && (this.scopedAssets().some(a => a.required && !this.assetCleared(a)) || !['review', 'rejected'].includes(this.run.status))) throw new WorkflowError('Every required deliverable must be checked or have an explicit AI override before approval.');
      if (decision === 'approve' && this.run.reviewAssetIds?.some(id => this.run.reviews?.[id]?.candidateHash !== currentHash)) throw new WorkflowError('Review each representative asset before approving this version.');
      await this.clearReady();
      this.run.approval = {decision, candidateHash, reviewer: reviewer.trim(), comment: comment.trim(), at: stamp()};
      this.run.status = decision === 'approve' ? 'approved' : 'rejected'; this.run.package = null;
      this.event('human_decision', {runId: id, ...this.run.approval});
      return this.state();
    });
  }

  async package(id, candidateHash) {
    this.assertRun(id);
    return this.exclusive(async () => {
      await this.assertSourcesCurrent();
      const hash = await this.computeCandidateHash();
      if (!this.run.approval || this.run.approval.decision !== 'approve' || this.run.approval.candidateHash !== hash || candidateHash !== hash || this.scopedAssets().some(a => a.required && !this.assetCleared(a))) throw new WorkflowError('Packaging requires explicit human approval of this exact checked candidate.');
      if (this.run.package?.candidateHash === hash && this.readyRelease) {await this.verifyRelease(this.readyRelease); return this.run.package;}
      const version = this.run.version;
      const directory = `releases/${version}`;
      const destination = path.join(this.artifactDir, directory);
      try {await fs.lstat(destination); throw new WorkflowError('This release version already exists. Start a new revision; released versions are never overwritten.');} catch (error) {if (error.code !== 'ENOENT') throw error;}
      const reserved = await reserveFolder(this.artifactDir, '.launch-control/release-builds', `${version}-attempt-`);
      const stage = path.join(this.artifactDir, reserved, 'contents');
      await fs.mkdir(stage);
      const evidence = this.run.marketEvidence;
      const manifest = {version, status: 'approved', scope: this.run.scope || null, representativeReviews: this.run.reviews || {}, candidateHash: hash, campaignId: this.campaign.id, facts: this.run.change, createdAt: stamp(), approval: this.run.approval, marketEvidence: evidence ? {sourceType: evidence.sourceType, observationId: evidence.observationId, dataset: evidence.dataset, dateRange: evidence.dateRange, sourceUrl: evidence.sourceUrl, sha256: evidence.sha256, questionIds: evidence.prompts.map(prompt => prompt.id), limitations: evidence.limitations} : null, publishing: 'Not performed. Human publisher handoff only.', assets: [], companions: []};
      manifest.assetDecisions = clone(this.run.assetDecisions || {});
      manifest.resolutionHistory = clone(this.run.resolutionHistory || []);
      for (const asset of this.scopedAssets()) {
        if (!asset.required && !this.assetCleared(asset)) continue;
        if (!hasDeliverable(asset)) throw new WorkflowError(`No publisher deliverable exists for ${asset.id}.`);
        const entry = {id: asset.id, title: asset.title, channel: asset.channel, files: []};
        for (const file of deliveryFiles(asset)) {
          const source = await containedFile(this.artifactDir, file.artifactPath);
          const bytes = await fs.readFile(source);
          if (digest(bytes) !== file.sha256) throw new WorkflowError('An output changed during packaging. No completed package was produced.');
          const name = `${assetFolder(asset)}/${file.path}`;
          const target = path.resolve(stage, name);
          if (!target.startsWith(stage + path.sep)) throw new WorkflowError('Invalid output path.');
          await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, bytes);
          entry.files.push({path: name, mime: file.mime, role: file.role, sha256: file.sha256, bytes: bytes.length});
        }
        manifest.assets.push(entry);
      }
      const resolutionNotes = Object.values(manifest.assetDecisions).map(d => `${d.action === 'exclude' ? 'EXCLUDED' : 'HUMAN AI OVERRIDE'}: ${d.assetId} — ${d.reason} (Reviewer: ${d.reviewer})`).join('\n');
      const instructions = `APPROVED RELEASE ${version} — ${this.run.change.product}\nNothing has been published.\nRelease scope: ${manifest.assets.length} of ${this.assets.length} registered assets. Assets outside this release are not approved by this package.\n${resolutionNotes ? resolutionNotes + '\n' : ''}Use READY-TO-PUBLISH for the currently approved release. A retained release folder alone does not mean it is still current.\nFiles are grouped by channel and asset name. Publish each deliverable with its exact metadata, captions, and thumbnails.\nAuthoring sources and review evidence remain in the campaign workspace. Changed content requires a new version and approval.\n`;
      await fs.writeFile(path.join(stage, 'PUBLISHER-README.txt'), instructions);
      manifest.companions.push({path: 'PUBLISHER-README.txt', sha256: digest(instructions)});
      await atomicJSON(path.join(stage, 'manifest.json'), manifest);
      const filename = `${folderSlug(this.campaign.id)}-${folderSlug(this.run.change.product)}-${version}.tar.gz`;
      const archivePath = `${reserved}/${filename}`;
      await exec('tar', ['-czf', path.join(this.artifactDir, archivePath), '-C', stage, '.'], {timeout: 60000});
      await this.assertSourcesCurrent();
      if (await this.computeCandidateHash() !== hash) throw new WorkflowError('Candidate changed while packaging. The completed package was withheld.');
      const releaseRoot = path.join(this.artifactDir, 'releases');
      await fs.mkdir(releaseRoot, {recursive: true});
      if (!(await fs.lstat(releaseRoot)).isDirectory()) throw new WorkflowError('Releases must be a regular campaign directory.');
      await fs.rename(stage, destination);
      const snapshotPath = `${reserved}/approved-snapshot.json`;
      await atomicJSON(path.join(this.artifactDir, snapshotPath), {run: this.run, assets: this.assets});
      const release = {id: version, version, directory, partial: manifest.assets.length < this.assets.length, candidateHash: hash, createdAt: stamp(), assetCount: manifest.assets.length, filename, archivePath, sha256: await fileHash(path.join(this.artifactDir, archivePath)), manifestSha256: await fileHash(path.join(destination, 'manifest.json')), snapshotPath, snapshotSha256: await fileHash(path.join(this.artifactDir, snapshotPath)), downloadUrl: artifactURL(archivePath)};
      await this.verifyRelease(release);
      await this.clearReady();
      await fs.symlink(directory, path.join(this.artifactDir, 'READY-TO-PUBLISH'), 'dir');
      this.run.package = release; this.latestRelease = clone(release); this.readyRelease = clone(release);
      this.run.status = 'packaged'; this.event('release_created', {runId: id, version, candidateHash: hash});
      return release;
    });
  }

  state() {
    const included = new Set(this.scopedAssets().map(a => a.id));
    const assets = this.assets.map(asset => ({...asset,resolution:{decision:this.run?.assetDecisions?.[asset.id] || null,excluded:!included.has(asset.id),overridden:this.overrideCurrent(asset),canOverride:included.has(asset.id) && this.canOverrideAI(asset)}}));
    const counts = {};
    for (const asset of this.assets) counts[asset.channel] = (counts[asset.channel] || 0) + 1;
    const status = this.readyRelease ? 'Ready to publish' : ({draft: 'Draft', interpreting: 'In progress', proposing: 'In progress', rendering: 'In progress', checking: 'In progress', review: 'Ready for review', blocked: 'Needs attention', rejected: 'Needs changes', approved: 'Approved — create release', failed: 'Needs attention', stale: 'Draft'})[this.run?.status] || 'Draft';
    return clone({launchReadiness: launchReadiness(this), processing: this.processingSummary(), workspace: {path: this.campaignDir, status, version: this.run?.version || null, baselineVersion: this.run?.baselineVersion || null, latestApprovedVersion: this.latestRelease?.version || null, readyPath: this.readyRelease ? 'READY-TO-PUBLISH' : null, driftMessage: this.driftMessage}, readyRelease: this.readyRelease, campaign: this.campaign, assets, run: this.run, marketEvidence: this.run ? this.run.marketEvidence || null : this.marketEvidence, provider: this.provider.providerStatus(), evidence: {registered: this.assets.length, inspected: this.assets.filter(a => a.sourceHash).length, channels: counts, channelCount: Object.keys(counts).length, changed: this.assets.filter(a => a.disposition === 'changed').length, unchanged: this.assets.filter(a => a.disposition === 'unchanged').length, blocked: this.assets.filter(a => a.status === 'blocked').length, checked: this.assets.filter(a => a.status === 'checked').length, inspectedAt: this.inspectedAt, events: this.events.slice(-30)}, busy: this.busy});
  }
}
