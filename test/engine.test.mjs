import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LaunchEngine, containedFile} from '../lib/engine.mjs';

const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalFacts = {product: 'Old Plan', monthlyPrice: 20, sharing: true, maxTeammates: 2};
const change = {product: 'New Plan', monthlyPrice: 40, sharing: false, maxTeammates: 0, instruction: 'Apply only these confirmed facts.'};
const original = '# Original campaign\nOld Plan costs $20/month and includes sharing. Keep this useful editorial sentence.\n';
const candidate = '# Revised campaign\nNew Plan costs $40/month. Sharing is not included. Keep this useful editorial sentence.\n';

async function fixture(t, {missing = false, renderOutside = false, blocked = false, marketEvidence = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-engine-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const campaignDir = path.join(root, 'campaign');
  await fs.mkdir(campaignDir);
  const campaign = {id: 'isolated-test', name: 'Synthetic engine test only', facts: originalFacts, assets: [{id: 'VIDEO-1', title: 'Test video', channel: 'video', kind: 'video', source: 'video.md', required: true, metadata: {}}]};
  if (marketEvidence) {
    const categoryId = '10000000-0000-4000-8000-000000000001';
    const sourceUrl = `https://platform.tryprofound.com/${categoryId}/Reference/aei/prompts`;
    const observation = {schemaVersion: 1, sourceType: 'manual-browser-observation', observationId: 'synthetic-question', observedAtUTC: '2026-10-03T18:00:00Z', dataset: {brand: 'Synthetic reference', categoryId}, dateRange: {start: '2026-09-28', endInclusive: '2026-10-02', platformFilter: 'Synthetic test filter'}, sourceUrl, prompts: [{id: 'QUESTION-1', text: 'What workflow suits a small product team?', platformPromptId: null, topic: 'Team fit', sourceUrl, intentTags: ['team-fit'], observedMixpanelVisibilityPercent: null, executionsShown: null}], limitations: ['Synthetic test only; no live evidence or performance claim.']};
    campaign.marketEvidencePath = 'evidence/questions.json';
    campaign.productContext = {company: 'Synthetic company', fictional: true, category: 'Analytics', capabilities: ['Event analysis'], unconfirmed: ['Discounts']};
    await fs.mkdir(path.join(campaignDir, 'evidence'));
    await fs.writeFile(path.join(root, 'campaign', campaign.marketEvidencePath), JSON.stringify(observation));
  }
  await fs.writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  if (!missing) await fs.writeFile(path.join(campaignDir, 'video.md'), original);
  let calls = 0;
  // Transport substitutes exist only inside this isolated unit-test fixture.
  const provider = {
    providerStatus: () => ({provider: 'synthetic-test-only', configured: true, connected: false}),
    proposeAssets: async ({assets}) => { calls++; return {provider: 'synthetic-test-only', model: 'test-only', usage: {}, requests: [], assets: assets.map(a => ({id: a.id, disposition: 'changed', markdown: candidate, reason: 'Synthetic fixture.', issues: []}))}; },
    auditAssets: async ({assets}) => ({requests: [], assets: assets.map(a => ({id: a.id, status: blocked ? 'blocked' : 'pass', issues: blocked ? [{severity: 'error', message: 'Synthetic unresolved claim.', evidence: 'Test fixture.'}] : []}))}),
  };
  const renderAsset = async ({markdown, outputDir}) => {
    if (renderOutside) {
      await fs.writeFile(path.join(root, 'outside.txt'), 'Outside renderer output');
      return {files: [{path: path.relative(outputDir, path.join(root, 'outside.txt')), mime: 'text/plain', role: 'preview'}]};
    }
    await fs.writeFile(path.join(outputDir, 'preview.txt'), markdown);
    await fs.writeFile(path.join(outputDir, 'source.md'), markdown);
    await fs.writeFile(path.join(outputDir, 'youtube-metadata.json'), JSON.stringify({title: markdown.split('\n')[0], description: markdown, published: false}));
    return {files: [{path: 'preview.txt', mime: 'text/plain', role: 'publishable-copy'}, {path: 'source.md', mime: 'text/markdown', role: 'editable-source'}, {path: 'youtube-metadata.json', mime: 'application/json', role: 'publisher-metadata'}], primaryPath: 'preview.txt', textContent: markdown, checks: [{name: 'Synthetic renderer identity', status: 'pass', message: 'Fixture bytes written.'}]};
  };
  const engine = new LaunchEngine({root, campaignDir, provider, renderAsset});
  await engine.initialize();
  return {root, campaignDir, campaign, engine, provider, callCount: () => calls};
}
async function run(engine) {
  const {runId} = engine.start(change);
  await engine.task;
  return runId;
}
async function approve(engine) {
  return engine.decide(engine.run.id, {decision: 'approve', candidateHash: engine.run.candidateHash, reviewer: 'Synthetic test reviewer', comment: 'Unit test, not a live campaign approval.'});
}

test('restyling originals preserves the previous render generation and source text', async t => {
  const {engine, campaignDir} = await fixture(t);
  await engine.inspect();
  const firstFiles = engine.assets[0].sourceFiles.map(file => ({...file}));
  assert.ok(firstFiles.every(file => file.artifactPath.startsWith('assets/video/VIDEO-1-test-video/v01/')));
  const renderer = engine.renderAsset;
  engine.renderAsset = async input => {
    const result = await renderer(input);
    await fs.appendFile(path.join(input.outputDir, 'preview.txt'), '\nA revised visual presentation.');
    return result;
  };
  await engine.inspect();
  const newPaths = new Set(engine.assets[0].sourceFiles.map(file => file.artifactPath));
  assert.ok([...newPaths].every(file => file.startsWith('assets/video/VIDEO-1-test-video/v02/')));
  for (const file of firstFiles) {
    assert.equal(newPaths.has(file.artifactPath), false);
    assert.equal(sha(await fs.readFile(path.join(engine.artifactDir, file.artifactPath))), file.sha256);
  }
  assert.notEqual(engine.assets[0].sourceFiles[0].sha256, firstFiles[0].sha256);
  assert.equal(await fs.readFile(path.join(campaignDir, 'video.md'), 'utf8'), original);
});

test('asset-level feedback revises only the selected output, preserves files and resets all approvals', async t => {
  const {engine,provider,campaignDir,campaign}=await fixture(t);
  campaign.assets.push({id:'SALES-1',title:'Synthetic sales collateral',channel:'sales',kind:'sales',source:'sales.md',required:true});
  await fs.writeFile(path.join(campaignDir,'sales.md'),original);
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify(campaign));
  const id=await run(engine), selected=engine.assets.find(a=>a.id==='SALES-1');
  engine.run.reviewAssetIds=['VIDEO-1','SALES-1']; engine.run.candidateHash=await engine.computeCandidateHash();
  for(const assetId of engine.run.reviewAssetIds) await engine.reviewAsset(id,assetId,{candidateHash:engine.run.candidateHash});
  await approve(engine);
  const hash=engine.run.candidateHash, oldFiles=structuredClone(selected.candidateFiles), untouched=structuredClone(engine.assets[0].candidateFiles);
  let requested=0;
  provider.reviseAsset=async input=>{
    requested++;
    assert.equal(engine.run.approval,null); assert.deepEqual(engine.run.reviews,{});
    assert.equal(input.assets.length,1); assert.equal(input.assets[0].id,'SALES-1');
    assert.equal(input.assets[0].markdown,candidate);
    assert.deepEqual(input.reviewPresentation,{editable:true,label:'sales · sales'});
    assert.equal(input.feedback,'Remove the duplicate category label.');
    return {requests:[],assets:[{id:'SALES-1',markdown:candidate,reviewLabel:'Sales',disposition:'changed',reason:'Synthetic label correction.',issues:[]}]};
  };
  const audit=provider.auditAssets;
  provider.auditAssets=async input=>{assert.equal(input.assets.find(a=>a.id==='SALES-1').revisionContext.previousReviewLabel,'sales · sales');return audit(input);};
  await engine.requestRevision(id,'SALES-1',{candidateHash:hash,feedback:'Remove the duplicate category label.'});
  assert.equal(requested,1); assert.equal(engine.run.status,'review'); assert.equal(engine.run.approval,null); assert.deepEqual(engine.run.reviews,{});
  assert.notEqual(engine.run.candidateHash,hash);
  assert.equal(selected.candidateReviewLabel,'Sales'); assert.equal(selected.renderedReviewLabel,'Sales');
  assert.equal(selected.candidateText,candidate);
  assert.deepEqual(engine.assets[0].candidateFiles,untouched);
  for(const file of oldFiles) assert.equal(sha(await fs.readFile(path.join(engine.artifactDir,file.artifactPath))),file.sha256);
  assert.notEqual(selected.candidateFiles[0].artifactPath,oldFiles[0].artifactPath);
  assert.equal(engine.run.assetRevisions[0].status,'completed');
  await assert.rejects(engine.requestRevision(id,'SALES-1',{candidateHash:hash,feedback:'Stale correction.'}),/Candidate changed/);
  assert.equal(requested,1);
  await assert.rejects(engine.package(id,engine.run.candidateHash),/requires explicit human approval/);
  assert.equal(await fs.readFile(path.join(campaignDir,'sales.md'),'utf8'),original);
  selected.candidateReviewLabel='Unrendered label';
  await engine.recheck(id);
  assert.equal(selected.status,'blocked');
});

test('unresolved or failed feedback cannot retain approval or quietly become release-ready', async t => {
  const {engine,provider}=await fixture(t);
  const id=await run(engine);
  provider.reviseAsset=async ({assets})=>({requests:[],assets:[{id:assets[0].id,markdown:assets[0].markdown,reviewLabel:null,disposition:'blocked',reason:'Unsupported layout change.',issues:[{severity:'error',message:'Replacing footage needs a supported editor.',evidence:'Replace every shot.'}]}]});
  await assert.rejects(engine.requestRevision(id,'VIDEO-1',{candidateHash:engine.run.candidateHash,feedback:' '}),/Describe the correction/);
  await assert.rejects(engine.requestRevision(id,'MISSING',{candidateHash:engine.run.candidateHash,feedback:'Change this.'}),/Unknown or out-of-scope/);
  await engine.requestRevision(id,'VIDEO-1',{candidateHash:engine.run.candidateHash,feedback:'Replace every shot.'});
  assert.equal(engine.run.status,'blocked'); assert.equal(engine.run.assetRevisions[0].status,'blocked');
  await assert.rejects(approve(engine),/Every required deliverable must be checked/);
  const files=structuredClone(engine.assets[0].candidateFiles);
  provider.reviseAsset=async ()=>{throw new Error('Synthetic transport failure');};
  await assert.rejects(engine.requestRevision(id,'VIDEO-1',{candidateHash:engine.run.candidateHash,feedback:'Try again.'}),/Synthetic transport failure/);
  assert.equal(engine.run.status,'failed'); assert.equal(engine.run.candidateHash,null); assert.equal(engine.run.approval,null);
  assert.deepEqual(engine.assets[0].candidateFiles,files); assert.equal(engine.run.assetRevisions.at(-1).status,'failed');
});

test('a checked candidate cannot be packaged without explicit approval, and rejection also blocks it', async t => {
  const {engine} = await fixture(t);
  const id = await run(engine);
  assert.equal(engine.run.status, 'review');
  assert.equal(engine.run.package, null);
  await assert.rejects(engine.package(id, engine.run.candidateHash), /requires explicit human approval/);
  await assert.rejects(fs.stat(path.join(engine.artifactDir, 'READY-TO-PUBLISH')), {code: 'ENOENT'});
  await engine.decide(id, {decision: 'reject', candidateHash: engine.run.candidateHash, reviewer: 'Synthetic test reviewer'});
  assert.equal(engine.run.status, 'rejected');
  await assert.rejects(engine.package(id, engine.run.candidateHash), /requires explicit human approval/);
});

test('stale hashes cannot approve or package the current candidate', async t => {
  const {engine} = await fixture(t);
  const id = await run(engine);
  await assert.rejects(engine.decide(id, {decision: 'approve', candidateHash: '0'.repeat(64), reviewer: 'Synthetic test reviewer'}), /Candidate changed/);
  await approve(engine);
  await assert.rejects(engine.package(id, '0'.repeat(64)), /exact checked candidate/);
});

test('source changes after approval prevent a release', async t => {
  const {engine, campaignDir} = await fixture(t);
  const id = await run(engine);
  await approve(engine);
  await fs.appendFile(path.join(campaignDir, 'video.md'), '\nAn external source change.');
  await assert.rejects(engine.package(id, engine.run.candidateHash), /Source VIDEO-1 changed/);
  assert.equal(engine.run.package, null);
});

test('manifest and confirmed fact changes after checking require a new run', async t => {
  const {engine, campaignDir, campaign} = await fixture(t);
  const id = await run(engine);
  campaign.facts.monthlyPrice = 21;
  await fs.writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  await assert.rejects(approve(engine), /facts or scope changed/);
  await assert.rejects(engine.package(id, engine.run.candidateHash), /facts or scope changed/);
});

test('tampering with a rendered companion is caught before approval and packaging', async t => {
  const {engine} = await fixture(t);
  const id = await run(engine);
  await approve(engine);
  const companion = engine.assets[0].candidateFiles.find(f => f.role === 'publisher-metadata');
  await fs.writeFile(path.join(engine.artifactDir, companion.artifactPath), JSON.stringify({title: 'Tampered metadata'}));
  await assert.rejects(engine.package(id, engine.run.candidateHash), /Rendered content.*changed/);
  assert.equal(engine.run.package, null);
});

test('human revisions invalidate approval and regenerate candidate identity', async t => {
  const {engine} = await fixture(t);
  const id = await run(engine);
  await approve(engine);
  const approvedHash = engine.run.candidateHash;
  const oldFiles = engine.assets[0].candidateFiles.map(f => f.artifactPath);
  await engine.edit(id, 'VIDEO-1', `${candidate}\nA human-authored final line.\n`);
  assert.equal(engine.run.status, 'review');
  assert.equal(engine.run.approval, null);
  assert.notEqual(engine.run.candidateHash, approvedHash);
  assert.notDeepEqual(engine.assets[0].candidateFiles.map(f => f.artifactPath), oldFiles);
  await assert.rejects(engine.package(id, approvedHash), /explicit human approval/);
});

test('approval binds shipped metadata as well as file bytes', async t => {
  const {engine} = await fixture(t);
  const id = await run(engine);
  await approve(engine);
  engine.assets[0].candidateFiles[0].mime = 'application/octet-stream';
  await assert.rejects(engine.package(id, engine.run.candidateHash), /exact checked candidate|changed/);
  assert.equal(engine.run.package, null);
});

test('a failed human-edit render clears approval and leaves a visible failed state', async t => {
  const {engine} = await fixture(t);
  const id = await run(engine);
  await approve(engine);
  engine.renderAsset = async () => { throw new Error('Synthetic renderer outage.'); };
  await assert.rejects(engine.edit(id, 'VIDEO-1', `${candidate}\nAnother requested change.\n`), /renderer outage/);
  assert.equal(engine.run.status, 'failed');
  assert.equal(engine.run.approval, null);
  assert.equal(engine.run.package, null);
  assert.equal(engine.busy, false);
});

test('a required missing source blocks execution before any proposal request', async t => {
  const {engine, callCount} = await fixture(t, {missing: true});
  await run(engine);
  assert.equal(engine.run.status, 'blocked');
  assert.equal(callCount(), 0);
  assert.equal(engine.run.candidateHash, null);
  await assert.rejects(approve(engine), /Candidate changed/);
});

test('semantic errors require a separate recorded override before an approval click', async t => {
  const {engine} = await fixture(t, {blocked: true});
  await run(engine);
  assert.equal(engine.run.status, 'blocked');
  await assert.rejects(approve(engine), /Every required deliverable/);
});

test('a named human override preserves the AI finding and exact bytes in the release record', async t => {
  const {engine,campaignDir}=await fixture(t,{blocked:true});const id=await run(engine);
  // Older saved runs did not persist semanticAudit separately; current findings remain eligible.
  delete engine.assets[0].semanticAudit;
  const old=engine.run.candidateHash, files=structuredClone(engine.assets[0].candidateFiles);
  await engine.resolveAsset(id,'VIDEO-1',{action:'override',candidateHash:old,reviewer:'Synthetic reviewer',reason:'Synthetic test: editorial discussion is not shared access.'});
  assert.equal(engine.run.status,'review');assert.equal(engine.assets[0].status,'blocked');
  assert.equal(engine.state().assets[0].resolution.overridden,true);assert.equal(engine.assets[0].checks.find(c=>c.name==='Independent semantic audit').status,'fail');
  assert.notEqual(engine.run.candidateHash,old);assert.deepEqual(engine.assets[0].candidateFiles,files);
  await approve(engine);const release=await engine.package(id,engine.run.candidateHash);
  const manifest=JSON.parse(await fs.readFile(path.join(campaignDir,release.directory,'manifest.json'),'utf8'));
  assert.equal(manifest.assetDecisions['VIDEO-1'].reviewer,'Synthetic reviewer');assert.equal(manifest.assetDecisions['VIDEO-1'].findings[0].severity,'error');
  assert.match(await fs.readFile(path.join(campaignDir,release.directory,'PUBLISHER-README.txt'),'utf8'),/HUMAN AI OVERRIDE: VIDEO-1/);
});

async function resolutionFixture(t) {
  const f=await fixture(t),{campaign,campaignDir,engine,provider}=f;
  for(let i=1;i<=3;i++){campaign.assets.push({id:`EXTRA-${i}`,title:`Extra ${i}`,channel:'website',kind:'copy',source:`extra-${i}.md`,required:true});await fs.writeFile(path.join(campaignDir,`extra-${i}.md`),original);}
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify(campaign));await engine.openCampaign();
  provider.interpretBrief=async()=>({change,summary:'Synthetic test.',questions:[],requests:[]});
  provider.auditAssets=async({assets})=>({requests:[],assets:assets.map(a=>({id:a.id,status:a.id==='VIDEO-1'?'blocked':'pass',issues:a.id==='VIDEO-1'?[{severity:'error',message:'Synthetic AI finding.',evidence:'Fixture.'}]:[]}))});
  engine.startBrief({brief:'Synthetic update.'});await engine.task;
  for(const assetId of ['EXTRA-1','EXTRA-2','EXTRA-3'])await engine.reviewAsset(engine.run.id,assetId,{candidateHash:engine.run.candidateHash});
  return f;
}

test('override and review is one explicit action and carries forward untouched reviews',async t=>{
  const {engine}=await resolutionFixture(t),old=engine.run.candidateHash;
  await engine.resolveAsset(engine.run.id,'VIDEO-1',{action:'override',candidateHash:old,reviewer:'Synthetic reviewer',reason:'Accept this exact finding.',markReviewed:true});
  assert.equal(Object.keys(engine.run.reviews).length,4);
  assert.equal(engine.run.reviews['VIDEO-1'].recordedWith,'Explicit AI override');
  assert.equal(engine.run.reviews['EXTRA-1'].carriedForwardFrom,old);
  await approve(engine);assert.equal(engine.run.status,'approved');
});

test('exclude removes publisher files, keeps remaining reviews, and produces a partial release',async t=>{
  const {engine,campaignDir}=await resolutionFixture(t),old=engine.run.candidateHash;
  await engine.resolveAsset(engine.run.id,'VIDEO-1',{action:'exclude',candidateHash:old,reviewer:'Synthetic reviewer',reason:'Hold this asset for a later release.'});
  assert.equal(engine.run.status,'review');assert.deepEqual(engine.run.scope.excludedAssetIds,['VIDEO-1']);assert.equal(engine.run.reviewAssetIds.length,3);
  assert.equal(Object.keys(engine.run.reviews).length,3);
  await approve(engine);const release=await engine.package(engine.run.id,engine.run.candidateHash);assert.equal(release.partial,true);assert.equal(release.assetCount,3);
  const manifest=JSON.parse(await fs.readFile(path.join(campaignDir,release.directory,'manifest.json'),'utf8'));
  assert.equal(manifest.assets.some(a=>a.id==='VIDEO-1'),false);assert.equal(manifest.assetDecisions['VIDEO-1'].action,'exclude');
  await engine.newRevision();assert.equal(engine.run.originalFacts.product,originalFacts.product);assert.equal(engine.run.assetDecisions,undefined);
});

test('undo restores the blocker without losing untouched reviews or changing candidate files',async t=>{
  const {engine}=await resolutionFixture(t);const files=structuredClone(engine.assets[0].candidateFiles);
  for(const action of ['exclude','restore'])await engine.resolveAsset(engine.run.id,'VIDEO-1',{action,candidateHash:engine.run.candidateHash,reviewer:'Synthetic reviewer',reason:`Synthetic ${action}.`});
  assert.equal(engine.run.status,'blocked');assert.equal(engine.run.scope.assetIds.length,4);assert.equal(Object.keys(engine.run.reviews).length,3);assert.deepEqual(engine.assets[0].candidateFiles,files);
  await assert.rejects(approve(engine),/Every required/);
});

test('overrides require current evidence and reasons; integrity failures cannot be overridden',async t=>{
  const {engine,campaignDir}=await fixture(t,{blocked:true});await run(engine);
  const request={action:'override',candidateHash:engine.run.candidateHash,reviewer:'Synthetic reviewer',reason:'Synthetic reason.'};
  await assert.rejects(engine.resolveAsset(engine.run.id,'VIDEO-1',{...request,reason:' '}),/provide your name and a reason/);
  await assert.rejects(engine.resolveAsset(engine.run.id,'VIDEO-1',{...request,candidateHash:'stale'}),/Candidate changed/);
  engine.assets[0].checks.push({name:'Missing native output',status:'fail'});engine.run.candidateHash=await engine.computeCandidateHash();
  await assert.rejects(engine.resolveAsset(engine.run.id,'VIDEO-1',{...request,candidateHash:engine.run.candidateHash}),/Only a completed AI finding/);
  engine.assets[0].checks.pop();engine.run.candidateHash=await engine.computeCandidateHash();
  await fs.appendFile(path.join(campaignDir,engine.assets[0].candidateFiles[0].artifactPath),'tampered');
  await assert.rejects(engine.resolveAsset(engine.run.id,'VIDEO-1',{...request,candidateHash:engine.run.candidateHash}),/Rendered content/);
  assert.equal(engine.run.assetDecisions,undefined);
});

test('rechecking withdraws prior overrides and requires a new human decision',async t=>{
  const {engine}=await fixture(t,{blocked:true});await run(engine);
  await engine.resolveAsset(engine.run.id,'VIDEO-1',{action:'override',candidateHash:engine.run.candidateHash,reviewer:'Synthetic reviewer',reason:'Synthetic reason.'});
  await engine.recheck(engine.run.id);assert.equal(engine.run.status,'blocked');assert.equal(engine.state().assets[0].resolution.overridden,false);assert.equal(engine.run.assetDecisions['VIDEO-1'],undefined);
  assert.equal(engine.run.resolutionHistory.at(-1).action,'invalidated');
});

test('an excluded broken candidate cannot block the remaining release or be restored silently',async t=>{
  const {engine,campaignDir}=await resolutionFixture(t);
  await fs.unlink(path.join(campaignDir,engine.assets[0].candidateFiles[0].artifactPath));
  await engine.resolveAsset(engine.run.id,'VIDEO-1',{action:'exclude',candidateHash:engine.run.candidateHash,reviewer:'Synthetic reviewer',reason:'Missing output; hold this asset.'});
  await assert.rejects(engine.resolveAsset(engine.run.id,'VIDEO-1',{action:'restore',candidateHash:engine.run.candidateHash,reviewer:'Synthetic reviewer',reason:'Try restore.'}));
  await approve(engine);assert.equal((await engine.package(engine.run.id,engine.run.candidateHash)).assetCount,3);
});

test('an override survives restart but decision tampering invalidates approval',async t=>{
  const {engine}=await fixture(t,{blocked:true});await run(engine);
  await engine.resolveAsset(engine.run.id,'VIDEO-1',{action:'override',candidateHash:engine.run.candidateHash,reviewer:'Synthetic reviewer',reason:'Synthetic reason.'});
  const restarted=new LaunchEngine({root:engine.root,campaignDir:engine.campaignDir,provider:engine.provider,renderAsset:engine.renderAsset});await restarted.initialize();
  assert.equal(restarted.state().assets[0].resolution.overridden,true);await approve(restarted);
  restarted.run.assetDecisions['VIDEO-1'].reason='Changed after approval';
  await assert.rejects(restarted.package(restarted.run.id,restarted.run.candidateHash),/exact checked candidate/);
});

test('the last release asset cannot be excluded',async t=>{
  const {engine}=await fixture(t,{blocked:true});await run(engine);
  await assert.rejects(engine.resolveAsset(engine.run.id,'VIDEO-1',{action:'exclude',candidateHash:engine.run.candidateHash,reviewer:'Synthetic reviewer',reason:'Hold.'}),/at least one/);
});

test('HTTP asset resolutions require CSRF and preserve the failed AI check',async t=>{
  const {engine}=await fixture(t,{blocked:true});await run(engine);
  const {createApplication}=await import('../server.mjs');const {server}=await createApplication({root:engine.root,engine});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const base=`http://127.0.0.1:${server.address().port}`,state=await(await fetch(base+'/api/state')).json();
    assert.equal(state.capabilities.assetResolution,true);
    const route=`${base}/api/runs/${engine.run.id}/assets/VIDEO-1/resolution`,body=JSON.stringify({action:'override',candidateHash:state.run.candidateHash,reviewer:'Synthetic reviewer',reason:'Synthetic HTTP resolution.'}),headers={'Content-Type':'application/json'};
    assert.equal((await fetch(route,{method:'POST',headers,body})).status,403);
    headers['X-Launch-Control-Token']=state.csrfToken;
    const response=await fetch(route,{method:'POST',headers,body});assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.run.status,'review');assert.equal(result.assets[0].resolution.overridden,true);assert.equal(result.assets[0].status,'blocked');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('renderer paths outside the output root block the candidate', async t => {
  const {engine} = await fixture(t, {renderOutside: true});
  await run(engine);
  assert.equal(engine.run.status, 'blocked');
  assert.equal(engine.assets[0].candidateFiles.length, 0);
  await assert.rejects(approve(engine), /Every required deliverable/);
});

test('contained files reject traversal, absolute paths, directories, and symlink escapes', async t => {
  const {root, campaignDir} = await fixture(t);
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'Do not read through the campaign root.');
  await fs.symlink(outside, path.join(campaignDir, 'escape.txt'));
  for (const reference of ['../outside.txt', outside, '.', 'escape.txt', 'bad\0name']) {
    await assert.rejects(containedFile(campaignDir, reference));
  }
  assert.equal(await containedFile(campaignDir, 'video.md'), await fs.realpath(path.join(campaignDir, 'video.md')));
});

test('an approved package contains exact approved bytes and leaves originals unchanged', async t => {
  const {engine, root, campaignDir} = await fixture(t);
  const id = await run(engine);
  await approve(engine);
  const result = await engine.package(id, engine.run.candidateHash);
  assert.equal(result.assetCount, 1);
  assert.equal(result.filename, 'isolated-test-new-plan-v001.tar.gz');
  assert.equal(await fs.readlink(path.join(engine.artifactDir, 'READY-TO-PUBLISH')), 'releases/v001');
  assert.equal(engine.run.draftFolder, 'working/v001');
  assert.equal(engine.run.status, 'packaged');
  const archive = path.join(engine.artifactDir, result.downloadUrl.replace('/artifacts/', ''));
  assert.equal(sha(await fs.readFile(archive)), result.sha256);
  const extracted = path.join(root, 'extracted');
  await fs.mkdir(extracted);
  await exec('tar', ['-xzf', archive, '-C', extracted]);
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'manifest.json'), 'utf8'));
  assert.equal(manifest.candidateHash, engine.run.approval.candidateHash);
  assert.equal(manifest.approval.reviewer, 'Synthetic test reviewer');
  for (const asset of manifest.assets) {
    assert.equal(new Set(asset.files.map(file => file.path)).size, asset.files.length, 'A release manifest must not contain duplicate output paths.');
    for (const file of asset.files) assert.equal(sha(await fs.readFile(path.join(extracted, file.path))), file.sha256, file.path);
  }
  assert.equal(await fs.readFile(path.join(campaignDir, 'video.md'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(extracted, 'video/VIDEO-1-test-video/preview.txt'), 'utf8'), candidate);
  await assert.rejects(fs.stat(path.join(extracted, 'video/VIDEO-1-test-video/source.md')), {code: 'ENOENT'});
  assert.match(await fs.readFile(path.join(extracted, 'PUBLISHER-README.txt'), 'utf8'), /Nothing has been published/);
});

test('proposal and audit use the same evidence snapshot without treating product identity as a capability', async t => {
  const {engine, provider, root, campaign} = await fixture(t, {marketEvidence: true});
  const seen = [];
  for (const stage of ['proposeAssets', 'auditAssets']) {
    const originalCall = provider[stage];
    provider[stage] = async args => {
      seen.push({stage, evidence: structuredClone(args.marketEvidence), context: structuredClone(args.productContext)});
      return originalCall(args);
    };
  }
  await run(engine);
  assert.equal(engine.run.status, 'review');
  assert.deepEqual(seen[0].evidence, seen[1].evidence);
  assert.equal(seen[0].evidence.sha256, sha(await fs.readFile(path.join(root, 'campaign', campaign.marketEvidencePath))));
  assert.deepEqual(seen[0].context, {capabilities: ['Event analysis'], unconfirmed: ['Discounts']});
  assert.equal(engine.state().marketEvidence.sourceType, 'manual-browser-observation');
  assert.equal(engine.state().marketEvidence.connected, undefined);
  await approve(engine);
  const result = await engine.package(engine.run.id, engine.run.candidateHash);
  const extracted = path.join(root, 'evidence-package');
  await fs.mkdir(extracted);
  await exec('tar', ['-xzf', path.join(engine.artifactDir, result.downloadUrl.replace('/artifacts/', '')), '-C', extracted]);
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'manifest.json'), 'utf8'));
  assert.equal(manifest.marketEvidence.sha256, seen[0].evidence.sha256);
  assert.deepEqual(manifest.marketEvidence.questionIds, ['QUESTION-1']);
});

test('evidence changes or disappears after review cannot produce an approved package', async t => {
  const {engine, root, campaign} = await fixture(t, {marketEvidence: true});
  await run(engine);
  await approve(engine);
  const evidenceFile = path.join(root, 'campaign', campaign.marketEvidencePath);
  await fs.appendFile(evidenceFile, '\n');
  await assert.rejects(engine.package(engine.run.id, engine.run.candidateHash), /Market evidence changed/);
  assert.equal(engine.run.package, null);
  await fs.rm(evidenceFile);
  await assert.rejects(engine.package(engine.run.id, engine.run.candidateHash), /Market evidence is no longer available/);
});

test('evidence changed during proposal stops before the audit and clears the candidate approval', async t => {
  const {engine, provider, root, campaign} = await fixture(t, {marketEvidence: true});
  const originalCall = provider.proposeAssets;
  let audits = 0;
  provider.proposeAssets = async args => {
    const result = await originalCall(args);
    await fs.appendFile(path.join(root, 'campaign', campaign.marketEvidencePath), '\n');
    return result;
  };
  provider.auditAssets = async () => {audits++; throw new Error('An audit must not consume mixed evidence.');};
  await run(engine);
  assert.equal(audits, 0);
  assert.equal(engine.run.status, 'failed');
  assert.match(engine.run.error, /Market evidence changed/);
  assert.equal(engine.run.approval, null);
  assert.equal(engine.run.package, null);
});

test('new versions reset readiness, advance from approved copy, and preserve released bytes', async t => {
  const {engine, provider, campaignDir} = await fixture(t);
  await run(engine); await approve(engine);
  const first = await engine.package(engine.run.id, engine.run.candidateHash);
  const firstManifest = await fs.readFile(path.join(campaignDir, first.directory, 'manifest.json'));
  assert.equal(engine.state().workspace.status, 'Ready to publish');
  await engine.newRevision();
  assert.equal(engine.run.version, 'v002');
  assert.equal(engine.run.status, 'draft');
  assert.equal(engine.run.approval, null);
  assert.equal(engine.run.package, null);
  assert.equal(engine.assets[0].sourceText, candidate);
  assert.equal(engine.run.originalFacts.product, 'New Plan');
  assert.equal(engine.state().workspace.status, 'Draft');
  await assert.rejects(fs.lstat(path.join(campaignDir, 'READY-TO-PUBLISH')), {code:'ENOENT'});
  let observed;
  const call = provider.proposeAssets;
  provider.proposeAssets = async args => {observed = structuredClone({assets:args.assets,facts:args.facts}); return call(args);};
  const secondId = await run(engine);
  assert.equal(engine.run.version, 'v002');
  assert.equal(engine.run.status, 'review', engine.run.error);
  assert.equal(observed.assets[0].markdown, candidate);
  assert.equal(observed.facts.product, 'New Plan');
  await approve(engine);
  const second = await engine.package(secondId, engine.run.candidateHash);
  assert.equal(second.directory, 'releases/v002');
  assert.equal(await fs.readlink(path.join(campaignDir, 'READY-TO-PUBLISH')), 'releases/v002');
  assert.deepEqual(await fs.readFile(path.join(campaignDir, first.directory, 'manifest.json')), firstManifest);
  assert.equal(await fs.readFile(path.join(campaignDir, 'video.md'), 'utf8'), original);
  await assert.rejects(engine.edit(secondId, 'VIDEO-1', candidate+'New text.'), /new revision/);
});

test('external source changes invalidate readiness while preserving the released version', async t => {
  const {engine, campaignDir} = await fixture(t);
  await run(engine); await approve(engine);
  const release = await engine.package(engine.run.id, engine.run.candidateHash);
  await fs.appendFile(path.join(campaignDir,'video.md'), '\nChanged externally.');
  await engine.refreshReadiness();
  assert.equal(engine.state().workspace.status, 'Draft');
  assert.equal(engine.readyRelease, null);
  assert.equal(engine.run.approval, null);
  await assert.rejects(fs.lstat(path.join(campaignDir,'READY-TO-PUBLISH')), {code:'ENOENT'});
  assert.ok(await fs.stat(path.join(campaignDir,release.directory,'manifest.json')));
});

test('tampering with a released deliverable clears READY-TO-PUBLISH', async t => {
  const {engine, campaignDir} = await fixture(t);
  await run(engine); await approve(engine);
  const release = await engine.package(engine.run.id,engine.run.candidateHash);
  await fs.appendFile(path.join(campaignDir,release.directory,'video/VIDEO-1-test-video/preview.txt'),'\nUnexpected change.');
  await engine.refreshReadiness();
  assert.equal(engine.readyRelease,null);
  await assert.rejects(fs.lstat(path.join(campaignDir,'READY-TO-PUBLISH')),{code:'ENOENT'});
});

test('optional sources retain binary assets in scope and block unsupported revisions', async t => {
  const {engine,campaignDir,campaign,callCount} = await fixture(t);
  await fs.mkdir(path.join(campaignDir,'Existing team folder'));
  await fs.writeFile(path.join(campaignDir,'Existing team folder','launch.mp4'),Buffer.from([0,1,2,255]));
  campaign.assets[0].source = null;
  campaign.assets[0].files = [{path:'Existing team folder/launch.mp4',mime:'video/mp4'}];
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify(campaign));
  await engine.inspect();
  assert.equal(engine.assets.length,1);
  assert.equal(engine.assets[0].inputFiles.length,1);
  assert.equal(engine.assets[0].sourceText,null);
  assert.match(engine.assets[0].issues[0].message,/No editable source/);
  assert.equal(engine.assets[0].sourcePreview.url,'/artifacts/Existing%20team%20folder/launch.mp4');
  await run(engine);
  assert.equal(callCount(),0);
  assert.equal(engine.run.status,'blocked');
  await assert.rejects(fs.lstat(path.join(campaignDir,'READY-TO-PUBLISH')),{code:'ENOENT'});
  // Existing folder names are accepted when a supported source is linked.
  await fs.writeFile(path.join(campaignDir,'Existing team folder','script.txt'),original);
  campaign.assets[0].source = 'Existing team folder/script.txt';
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify(campaign));
  await run(engine);
  assert.equal(engine.run.status,'review');
  await fs.appendFile(path.join(campaignDir,'Existing team folder','launch.mp4'),'changed');
  await assert.rejects(approve(engine),/Registered media/);
});

test('restart restores an approved pointer and revalidates its exact release', async t => {
  const {engine,root,campaignDir,provider} = await fixture(t);
  await run(engine); await approve(engine);
  await engine.package(engine.run.id,engine.run.candidateHash);
  const restarted = new LaunchEngine({root,campaignDir,provider,renderAsset:engine.renderAsset});
  await restarted.initialize();
  assert.equal(restarted.state().workspace.status,'Ready to publish');
  await fs.appendFile(path.join(campaignDir,'releases/v001/manifest.json'),' ');
  const changed = new LaunchEngine({root,campaignDir,provider,renderAsset:engine.renderAsset});
  await changed.initialize();
  assert.equal(changed.readyRelease,null);
  assert.equal(changed.state().workspace.status,'Draft');
});

test('a changed approved working representation cannot become the next baseline', async t => {
  const {engine,campaignDir} = await fixture(t);
  await run(engine); await approve(engine);
  await engine.package(engine.run.id,engine.run.candidateHash);
  await fs.appendFile(path.join(campaignDir,engine.assets[0].candidateFiles[0].artifactPath),'Unexpected edit.');
  await assert.rejects(engine.newRevision(),/approved working representation changed/);
  assert.equal(engine.readyRelease,null);
});

test('switching the selected identity invalidates an existing release on restart', async t => {
  const {engine,root,campaignDir,provider} = await fixture(t);
  engine.brandIdentitySha256 = 'test-brand-a';
  await run(engine); await approve(engine);
  await engine.package(engine.run.id,engine.run.candidateHash);
  const restarted = new LaunchEngine({root,campaignDir,provider,renderAsset:engine.renderAsset,brandIdentitySha256:'test-brand-b'});
  await restarted.initialize();
  assert.equal(restarted.readyRelease,null);
  assert.equal(restarted.run.approval,null);
  assert.equal(restarted.state().workspace.status,'Draft');
});

test('a replaced ready shortcut invalidates approval without deleting the conflicting user file', async t => {
  const {engine,campaignDir} = await fixture(t);
  await run(engine); await approve(engine);
  await engine.package(engine.run.id,engine.run.candidateHash);
  const pointer = path.join(campaignDir,'READY-TO-PUBLISH');
  await fs.unlink(pointer); await fs.writeFile(pointer,'User content; preserve me.');
  await engine.refreshReadiness();
  assert.equal(engine.readyRelease,null); assert.equal(engine.run.approval,null);
  assert.equal(engine.state().workspace.status,'Draft');
  assert.equal(await fs.readFile(pointer,'utf8'),'User content; preserve me.');
  assert.match(engine.driftMessage,/conflicting/);
});

test('HTTP version reset requires a token and withdraws the previous release download', async t => {
  const {engine} = await fixture(t);
  await run(engine); await approve(engine);
  const release = await engine.package(engine.run.id,engine.run.candidateHash);
  const {createApplication} = await import('../server.mjs');
  const {server} = await createApplication({engine});
  await new Promise((resolve,reject) => {server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.workspace.status,'Ready to publish');
    assert.equal((await fetch(base+release.downloadUrl)).status,200);
    assert.equal((await fetch(`${base}/artifacts/.launch-control/state.json`)).status,404);
    assert.equal((await fetch(base+release.downloadUrl.replace(release.filename,'approved-snapshot.json'))).status,404);
    const headers = {'Content-Type':'application/json'};
    assert.equal((await fetch(`${base}/api/revisions`,{method:'POST',headers,body:'{}'})).status,403);
    assert.equal(engine.run.version,'v001');
    headers['X-Launch-Control-Token'] = state.csrfToken;
    const reset = await fetch(`${base}/api/revisions`,{method:'POST',headers,body:'{}'});
    assert.equal(reset.status,200);
    const draft = await reset.json();
    assert.equal(draft.workspace.status,'Draft'); assert.equal(draft.workspace.version,'v002');
    assert.equal(draft.readyRelease,null); assert.equal(draft.run.approval,null);
    assert.equal((await fetch(base+release.downloadUrl)).status,404);
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});

test('demo reset archives generated work and approvals, retains originals, and restarts at v001', async t => {
  const {engine,campaignDir}=await fixture(t);
  engine.allowDemoReset=true;
  await engine.inspect();
  const originals=structuredClone(engine.assets[0].sourceFiles);
  await run(engine); await approve(engine);
  const release=await engine.package(engine.run.id,engine.run.candidateHash);
  const oldRun=structuredClone(engine.run), outputs=structuredClone(engine.assets[0].candidateFiles);
  const request={campaignId:engine.campaign.id,runId:oldRun.id};
  const reset=await engine.resetDemo(request), archive=path.join(campaignDir,reset.archive);
  assert.equal(engine.run,null); assert.equal(engine.latestRelease,null); assert.equal(engine.readyRelease,null);
  assert.equal(engine.state().launchReadiness.label,'Launch ready');
  assert.equal(engine.assets[0].candidateText,null); assert.equal(engine.assets[0].sourceText,original);
  assert.equal(JSON.parse(await fs.readFile(path.join(archive,'state.json'),'utf8')).run.approval.candidateHash,oldRun.approval.candidateHash);
  for(const file of outputs) assert.equal(sha(await fs.readFile(path.join(archive,file.artifactPath))),file.sha256);
  assert.equal(sha(await fs.readFile(path.join(archive,release.archivePath.replace(/^\.launch-control\//,'')))),release.sha256);
  for(const file of originals) assert.equal(sha(await fs.readFile(path.join(campaignDir,file.artifactPath))),file.sha256);
  for(const relative of ['working','releases','READY-TO-PUBLISH','.launch-control/release-builds','.launch-control/reset-in-progress.json']) await assert.rejects(fs.lstat(path.join(campaignDir,relative)),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(campaignDir,'video.md'),'utf8'),original);
  await assert.rejects(engine.resetDemo(request),/campaign changed/);
  await run(engine); assert.equal(engine.run.version,'v001'); assert.notEqual(engine.run.id,oldRun.id);
  const resetAgain=await engine.resetDemo({campaignId:engine.campaign.id,runId:engine.run.id});
  assert.notEqual(resetAgain.archive,reset.archive);
  assert.equal(JSON.parse(await fs.readFile(path.join(archive,'reset-receipt.json'),'utf8')).status,'complete');
});

test('demo reset refuses external campaigns, concurrent runs and replaced output directories', async t => {
  const {engine,campaignDir}=await fixture(t);
  const request={campaignId:engine.campaign.id,runId:null};
  await assert.rejects(engine.resetDemo(request),/only for the included/);
  engine.allowDemoReset=true; engine.busy=true;
  await assert.rejects(engine.resetDemo(request),/already working/);
  engine.busy=false;
  await fs.symlink('video.md',path.join(campaignDir,'working'));
  await assert.rejects(engine.resetDemo(request),/unexpected file type/);
  assert.equal(await fs.readlink(path.join(campaignDir,'working')),'video.md');
  assert.equal(await fs.readFile(path.join(campaignDir,'video.md'),'utf8'),original);
});

test('failed demo reset restores existing state, files and the ready shortcut', async t => {
  const {engine,campaignDir}=await fixture(t); engine.allowDemoReset=true;
  await run(engine);await approve(engine);const release=await engine.package(engine.run.id,engine.run.candidateHash);
  const id=engine.run.id, save=engine.save.bind(engine);
  engine.save=async()=>{if(engine.run===null)throw new Error('Synthetic fresh-state write failure');return save();};
  await assert.rejects(engine.resetDemo({campaignId:engine.campaign.id,runId:id}),/Synthetic fresh-state write failure/);
  assert.equal(engine.run.id,id);assert.equal(engine.run.status,'packaged');
  assert.equal(await fs.readlink(path.join(campaignDir,'READY-TO-PUBLISH')),release.directory);
  assert.equal(sha(await fs.readFile(path.join(campaignDir,release.archivePath))),release.sha256);
  assert.equal(JSON.parse(await fs.readFile(engine.stateFile,'utf8')).run.id,id);
  await assert.rejects(fs.lstat(path.join(engine.controlDir,'reset-in-progress.json')),{code:'ENOENT'});
});

test('an interrupted reset journal prevents a silently empty campaign on startup', async t => {
  const {engine}=await fixture(t);
  await fs.writeFile(path.join(engine.controlDir,'reset-in-progress.json'),'{}');
  await assert.rejects(engine.initialize(),/reset was interrupted/);
});

test('HTTP demo reset requires CSRF, isolates the archive and withdraws old artifact URLs', async t => {
  const {engine}=await fixture(t);engine.allowDemoReset=true;await run(engine);
  const previous=engine.assets[0].candidateFiles[0].url;
  const {createApplication}=await import('../server.mjs');const {server}=await createApplication({engine});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const base=`http://127.0.0.1:${server.address().port}`,state=await (await fetch(`${base}/api/state`)).json();
    const body=JSON.stringify({campaignId:state.campaign.id,runId:state.run.id}),headers={'Content-Type':'application/json'};
    assert.equal((await fetch(`${base}/api/demo/reset`,{method:'POST',headers,body})).status,403);
    headers['X-Launch-Control-Token']=state.csrfToken;
    const response=await fetch(`${base}/api/demo/reset`,{method:'POST',headers,body});assert.equal(response.status,200);
    const reset=await response.json();assert.equal(reset.run,null);assert.equal(reset.busy,false);
    assert.equal((await fetch(base+previous)).status,404);
    assert.equal((await fetch(`${base}/artifacts/${reset.reset.archive}/state.json`)).status,404);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('fresh-session state advertises the demo-scope default only for the bundled example', async t => {
  const {engine}=await fixture(t);
  const {createApplication}=await import('../server.mjs');const {server}=await createApplication({engine});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    let state=await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.capabilities.demoReset,false);
    assert.equal(state.capabilities.demoScopeDefault,false,'An external campaign folder starts fresh sessions in full-campaign mode');
    // The bundled example is selected exactly when its default artifact folder is in use, the same selection that enables demo reset.
    engine.allowDemoReset=true;
    state=await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.capabilities.demoReset,true);
    assert.equal(state.capabilities.demoScopeDefault,true,'The bundled example starts fresh sessions in demo mode');
  } finally {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
});

test('a prompt-driven focused release requires exact representative review and declares excluded assets', async t => {
  const {engine,campaign,campaignDir,provider}=await fixture(t);
  campaign.assets.push({id:'OUTSIDE',title:'Outside release',channel:'website',kind:'copy',source:'outside.md',required:true});
  await fs.writeFile(path.join(campaignDir,'outside.md'),original);
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify(campaign));
  await engine.openCampaign();
  const brief='Use New Plan at $40/month with no sharing. Preserve editorial copy.';
  provider.interpretBrief=async input=>{assert.equal(input.brief,brief);return {change,summary:'Synthetic interpretation.',questions:[],requests:[]};};
  const proposal=provider.proposeAssets;
  provider.proposeAssets=async input=>{assert.equal(input.change.instruction,brief);assert.deepEqual(input.assets.map(a=>a.id),['VIDEO-1']);return proposal(input);};
  const {runId}=engine.startBrief({brief,assetIds:['VIDEO-1']});await engine.task;
  assert.equal(engine.run.status,'review');assert.equal(engine.assets.find(a=>a.id==='OUTSIDE').candidateText,null);
  assert.deepEqual(engine.run.scope.excludedAssetIds,['OUTSIDE']);
  await assert.rejects(approve(engine),/Review each representative/);
  await assert.rejects(engine.reviewAsset(runId,'OUTSIDE',{candidateHash:engine.run.candidateHash}),/not awaiting/);
  await assert.rejects(engine.reviewAsset(runId,'VIDEO-1',{candidateHash:'stale'}),/Candidate changed/);
  await engine.reviewAsset(runId,'VIDEO-1',{candidateHash:engine.run.candidateHash});
  await approve(engine);
  const release=await engine.package(runId,engine.run.candidateHash);
  assert.equal(release.assetCount,1);assert.equal(release.partial,true);
  const manifest=JSON.parse(await fs.readFile(path.join(campaignDir,release.directory,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.scope.excludedAssetIds,['OUTSIDE']);assert.ok(manifest.representativeReviews['VIDEO-1']);
  await engine.newRevision();
  assert.equal(engine.run.originalFacts.product,originalFacts.product,'Partial releases cannot promote target facts across unrevised assets.');
  assert.equal(engine.run.baselineVersion,null);
  assert.equal(await fs.readFile(path.join(campaignDir,'outside.md'),'utf8'),original);
});

test('ambiguous briefs stop before proposals and candidate edits invalidate representative reviews', async t => {
  const {engine,provider,callCount}=await fixture(t);
  provider.interpretBrief=async()=>({change,summary:'Needs clarity.',questions:['Which price?'],requests:[]});
  engine.startBrief({brief:'Change the offer.'});await engine.task;
  assert.equal(engine.run.status,'blocked');assert.equal(callCount(),0);assert.equal(engine.run.change,null);
  provider.interpretBrief=async()=>({change,summary:'Clear.',questions:[],requests:[]});
  engine.startBrief({brief:'New Plan, $40/month, no sharing.'});await engine.task;
  await engine.reviewAsset(engine.run.id,'VIDEO-1',{candidateHash:engine.run.candidateHash});
  await engine.edit(engine.run.id,'VIDEO-1',candidate+'\nMore useful editorial context.');
  assert.deepEqual(engine.run.reviews,{});
  await assert.rejects(approve(engine),/Review each representative/);
});

test('opening a campaign inventories registered files without rerendering originals', async t => {
  const {engine}=await fixture(t);
  engine.renderAsset=()=>assert.fail('Opening must not render originals.');
  await engine.openCampaign();assert.equal(engine.assets.length,1);assert.equal(engine.run,null);
});

test('a prompt run reuses an explicitly created draft version and opening detects unreleased input drift', async t => {
  const {engine,campaignDir,provider}=await fixture(t);
  provider.interpretBrief=async()=>({change,summary:'Clear.',questions:[],requests:[]});
  await engine.newRevision();const draftId=engine.run.id,version=engine.run.version;
  engine.startBrief({brief:'New Plan at $40/month with no sharing.'});await engine.task;
  assert.equal(engine.run.id,draftId);assert.equal(engine.run.version,version);
  await fs.appendFile(path.join(campaignDir,'video.md'),'\nExternal edit.');
  await engine.openCampaign();assert.equal(engine.run.status,'stale');assert.match(engine.driftMessage,/changed during/);
  assert.equal(engine.run.approval,null);
});

test('four representative reviews do not restrict full-campaign execution or approval checks', async t => {
  const {engine,provider,campaign,campaignDir}=await fixture(t);
  for (const [index,channel] of ['website','social','sales','email'].entries()) {
    const source=`additional-${index}.md`;
    await fs.writeFile(path.join(campaignDir,source),original);
    campaign.assets.push({id:`EXTRA-${index}`,title:`Additional ${channel}`,channel,kind:'text',source,required:true,metadata:{}});
  }
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify(campaign));
  await engine.openCampaign();
  provider.interpretBrief=async()=>({change,summary:'Clear.',questions:[],requests:[]});
  const selected=['VIDEO-1','EXTRA-0','EXTRA-1','EXTRA-2'];
  assert.throws(()=>engine.startBrief({brief:'Update the plan.',reviewAssetIds:selected.slice(0,2)}),/four distinct/);
  engine.startBrief({brief:'New Plan at $40/month with no sharing.',reviewAssetIds:selected});
  await engine.task;
  assert.equal(engine.run.status,'review',engine.run.error);
  assert.equal(engine.run.scope.assetIds.length,5);
  assert.deepEqual(engine.run.scope.excludedAssetIds,[]);
  assert.deepEqual(engine.run.reviewAssetIds,selected);
  const processing=engine.state().processing;
  assert.deepEqual([processing.total,processing.proposed,processing.produced,processing.audited],[5,5,5,5]);
  assert.equal(processing.running,false);
  assert.ok(engine.assets.every(asset=>asset.candidateText===candidate));
  for (const id of selected) await engine.reviewAsset(engine.run.id,id,{candidateHash:engine.run.candidateHash});
  assert.equal(engine.state().launchReadiness.label,'Awaiting approval');
  const audit=provider.auditAssets;
  provider.auditAssets=async input=>{
    const result=await audit(input);
    Object.assign(result.assets.find(asset=>asset.id==='EXTRA-3'),{status:'blocked',issues:[{severity:'error',message:'Unresolved claim outside the four review samples.',evidence:'Synthetic test.'}]});
    return result;
  };
  await engine.recheck(engine.run.id);
  assert.equal(engine.run.status,'blocked');
  assert.equal(engine.state().launchReadiness.label,'Needs attention');
  await assert.rejects(approve(engine));
});

test('processing time includes interpretation, freezes for review, and records correction separately', async t => {
  const {engine,provider}=await fixture(t);
  let start;
  provider.interpretBrief=async()=>{
    start=engine.run.startedAt;
    assert.equal(engine.state().processing.running,true);
    assert.equal(engine.state().launchReadiness.label,'Updating');
    return {change,summary:'Clear.',questions:[],requests:[]};
  };
  engine.startBrief({brief:'New Plan at $40/month with no sharing.'});await engine.task;
  assert.equal(engine.run.startedAt,start);
  assert.equal(engine.run.timings.length,1);
  const first=engine.run.timings[0];
  assert.equal(first.elapsedSeconds,(Date.parse(first.completedAt)-Date.parse(start))/1000);
  const elapsed=engine.state().processing.elapsedSeconds;
  await engine.reviewAsset(engine.run.id,'VIDEO-1',{candidateHash:engine.run.candidateHash});
  assert.equal(engine.state().processing.elapsedSeconds,elapsed);
  await engine.edit(engine.run.id,'VIDEO-1',candidate+'\nAdditional editorial context.');
  assert.deepEqual(engine.run.timings.map(timing=>timing.kind),['update','correction']);
  assert.equal(engine.state().processing.elapsedSeconds,engine.run.timings.reduce((sum,timing)=>sum+timing.elapsedSeconds,0));
  assert.equal(engine.state().processing.running,false);
});

test('interrupted processing has no invented completion time after restart', async t => {
  const {engine,root,campaignDir,provider}=await fixture(t);
  await engine.newRevision();
  engine.beginWork('update');engine.run.status='rendering';await engine.save();
  const restarted=new LaunchEngine({root,campaignDir,provider,renderAsset:engine.renderAsset});
  await restarted.initialize();
  assert.equal(restarted.run.status,'failed');
  assert.equal(restarted.state().processing.elapsedSeconds,null);
  assert.equal(restarted.state().processing.running,false);
  assert.equal(restarted.state().launchReadiness.label,'Needs attention');
});

test('demo scope processes and packages four of 104 assets; the next full run includes all 104', async t => {
  const {engine,provider,campaign,campaignDir}=await fixture(t);
  for (let i=0;i<103;i++) {
    const source=`asset-${i}.md`;
    await fs.writeFile(path.join(campaignDir,source),original);
    campaign.assets.push({id:`ASSET-${i}`,title:`Test asset ${i}`,channel:['website','social','sales'][i%3],kind:'text',source,required:true,metadata:{}});
  }
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify(campaign));
  await engine.openCampaign();
  const demoIds=campaign.assets.slice(0,4).map(asset=>asset.id);
  let proposedIds,auditedIds;
  const propose=provider.proposeAssets,audit=provider.auditAssets;
  provider.interpretBrief=async()=>({change,summary:'Synthetic scoped update.',questions:[],requests:[]});
  provider.proposeAssets=async input=>{proposedIds=input.assets.map(a=>a.id);return propose(input);};
  provider.auditAssets=async input=>{auditedIds=input.assets.map(a=>a.id);return audit(input);};
  engine.startBrief({brief:'New Plan at $40/month with no sharing.',assetIds:demoIds,reviewAssetIds:demoIds});await engine.task;
  assert.deepEqual(proposedIds,demoIds);
  assert.deepEqual(auditedIds,demoIds);
  assert.equal(engine.run.scope.excludedAssetIds.length,100);
  assert.equal(engine.state().processing.total,4);
  for (const asset of engine.assets.filter(a=>!demoIds.includes(a.id))) {
    assert.equal(asset.candidateText,null);
    assert.equal(asset.candidateFiles.length,0);
    assert.equal(await fs.readFile(path.join(campaignDir,asset.source),'utf8'),original);
  }
  for (const id of demoIds) await engine.reviewAsset(engine.run.id,id,{candidateHash:engine.run.candidateHash});
  await approve(engine);
  const release=await engine.package(engine.run.id,engine.run.candidateHash);
  assert.equal(release.assetCount,4);assert.equal(release.partial,true);
  assert.equal(engine.state().launchReadiness.label,'Partial release ready');
  const manifest=JSON.parse(await fs.readFile(path.join(campaignDir,release.directory,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.assets.map(a=>a.id),demoIds);
  assert.equal(manifest.scope.excludedAssetIds.length,100);
  await engine.newRevision();
  engine.startBrief({brief:'New Plan at $40/month with no sharing.',reviewAssetIds:demoIds});await engine.task;
  assert.equal(engine.run.status,'review',engine.run.error);
  assert.equal(proposedIds.length,104);assert.equal(auditedIds.length,104);
  assert.equal(engine.state().processing.total,104);
  assert.deepEqual(engine.run.scope.excludedAssetIds,[]);
});
