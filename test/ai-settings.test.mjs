import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AISettings} from '../lib/ai-settings.mjs';
import {loadConfiguration, saveAISettings, validateSettings} from '../lib/config.mjs';
import {MODELS, modelCatalog, concreteLegacySelection} from '../lib/model-catalog.mjs';
import {createProvider} from '../lib/provider.mjs';
import {CampaignEngine} from '../lib/engine.mjs';
import {createApplication} from '../server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sol = {provider:'openai',model:'gpt-6.1-sol'};
const opus = {provider:'anthropic',model:'claude-opus-5-5'};
const facts = {product:'Original',monthlyPrice:20,sharing:true,maxTeammates:2};
const change = {product:'Revised',monthlyPrice:40,sharing:false,maxTeammates:0};
const markdown = '# Original\nOriginal costs $20/month with sharing.\n';
const revised = '# Revised\nRevised costs $40/month without sharing.\n';
const env = {OPENAI_API_KEY:'SYNTHETIC_OPENAI_ONLY',ANTHROPIC_API_KEY:'SYNTHETIC_ANTHROPIC_ONLY'};
const deferred = () => {let resolve; const promise = new Promise(done=>{resolve=done;}); return {promise,resolve};};

async function fixture(t, {selection = sol, credentials = env, saveSettings, catalog} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'campaign-ai-settings-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const campaignDir = path.join(root,'campaign');
  await fs.mkdir(campaignDir);
  const configPath = path.join(root,'campaign-control.config.json');
  const originalConfig = {schemaVersion:1,campaign:{type:'local',path:'./campaign'},ai:selection,server:{port:8142}};
  await fs.writeFile(configPath,JSON.stringify(originalConfig));
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify({id:'synthetic-settings',name:'Synthetic only',facts,assets:[{id:'A',title:'Test copy',channel:'website',kind:'copy',source:'a.md'}]}));
  await fs.writeFile(path.join(campaignDir,'a.md'),markdown);
  const calls = [];
  const factory = selection => createProvider({...selection,env:credentials,fetchImpl:async (url,init)=>{
    const body=JSON.parse(init.body);
    const provider=selection.provider;
    const payload=JSON.parse(provider==='openai'?body.input[0].content:body.messages[0].content);
    const schema=provider==='openai'?body.text.format.schema:body.output_config.format.schema;
    const stage=schema.properties.summary?'brief':schema.properties.assets.items.properties.status?'audit':schema.properties.assets.items.properties.reviewLabel?'revision':'proposal';
    const saved=JSON.parse(await fs.readFile(path.join(campaignDir,'.campaign-control/state.json'),'utf8'));
    if(saved.run.aiSelection) assert.deepEqual(saved.run.aiSelection,{...selection,catalogVersion:saved.run.aiSelection.catalogVersion},'Model binding is persisted before every request');
    else assert.deepEqual({provider:saved.run.provider.provider,model:saved.run.provider.model},selection,'Legacy calls use recorded provenance');
    calls.push({provider,model:body.model,stage,url});
    const result=stage==='brief'?{...change,summary:'Synthetic interpretation.',questions:[]}:stage==='audit'?{assets:payload.assets.map(asset=>({id:asset.id,status:'pass',issues:[]}))}:{assets:payload.assets.map(asset=>({id:asset.id,disposition:'changed',markdown:stage==='revision'?asset.markdown+'\nA synthetic correction.':revised,reason:'Synthetic only.',issues:[],...(stage==='revision'?{reviewLabel:payload.reviewPresentation.editable?payload.reviewPresentation.label:null}:{})}))};
    const raw=provider==='openai'?{model:body.model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(result)}]}]}:{model:body.model,stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(result)}]};
    return new Response(JSON.stringify({...raw,usage:{input_tokens:1,output_tokens:2}}));
  }});
  const config=await loadConfiguration({root,env:credentials});
  const manager=new AISettings({config,env:credentials,providerFactory:factory,saveSettings,catalog});
  const renderAsset=async({markdown,outputDir})=>{
    await fs.writeFile(path.join(outputDir,'copy.md'),markdown);
    return {files:[{path:'copy.md',mime:'text/markdown',role:'publishable-copy'}],primaryPath:'copy.md',checks:[]};
  };
  const engine=new CampaignEngine({root:ROOT,campaignDir,provider:manager,aiSettings:manager,renderAsset});
  await engine.initialize();
  return {root,configPath,originalConfig,manager,engine,calls,factory,renderAsset,campaignDir};
}
async function run(f, brief = true) {
  const result=brief?f.engine.startBrief({brief:'Apply the confirmed change.'}):f.engine.start(change);
  await f.engine.task;
  assert.equal(f.engine.run.status,'review',f.engine.run.error);
  return result.runId;
}
async function restart(f, credentials = env, catalog) {
  const config=await loadConfiguration({root:f.root,env:credentials});
  const manager=new AISettings({config,env:credentials,providerFactory:f.factory,catalog});
  const engine=new CampaignEngine({root:ROOT,campaignDir:f.campaignDir,provider:manager,aiSettings:manager,renderAsset:f.renderAsset});
  await engine.initialize();
  return {...f,manager,engine};
}

test('six explicit catalog mappings include documentation, compatible endpoints and relative pricing', () => {
  assert.deepEqual(MODELS.map(item=>[item.name,item.model]),[
    ['Sol','gpt-6.1-sol'],['Astra','gpt-6-astra'],['Luna','gpt-6-luna'],
    ['Opus','claude-opus-5-5'],['Fable','claude-fable-5-1'],['Haiku','claude-haiku-5-5'],
  ]);
  for(const item of MODELS){
    assert.equal(item.concrete,true);assert.equal(item.structuredOutputs,true);assert.equal(item.verifiedAt,'2026-10-07');
    assert.ok(['developers.openai.com','platform.claude.com'].includes(new URL(item.source).hostname));
    assert.equal(item.endpoint,item.provider==='openai'?'responses':'messages');
    assert.ok(!item.model.includes('latest'));
  }
  assert.ok(MODELS[2].inputUSD < MODELS[0].inputUSD && MODELS[0].inputUSD < MODELS[1].inputUSD);
  assert.ok(MODELS[5].inputUSD < MODELS[3].inputUSD && MODELS[3].inputUSD < MODELS[4].inputUSD);
  assert.match(modelCatalog().pricingNote,/100,000/);
});

test('every catalog entry produces the correct adapter structured-output request with synthetic credentials', async () => {
  for(const selection of MODELS){
    let calls=0;
    const provider=createProvider({...selection,env,fetchImpl:async(url,init)=>{
      calls++;
      const body=JSON.parse(init.body);
      assert.equal(body.model,selection.model);
      assert.equal(url,selection.provider==='openai'?'https://api.openai.com/v1/responses':'https://api.anthropic.com/v1/messages');
      assert.equal(selection.provider==='openai'?body.text.format.type:body.output_config.format.type,'json_schema');
      const result={...change,summary:'Synthetic only.',questions:[]};
      return new Response(JSON.stringify({model:selection.model,usage:{input_tokens:1,output_tokens:1},...(selection.provider==='openai'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(result)}]}]}:{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(result)}]})}));
    }});
    assert.equal(provider.providerStatus().connected,false);
    await provider.interpretBrief({brief:'Use the confirmed change.',facts});
    assert.equal(calls,1);assert.equal(provider.providerStatus().connected,true);
  }
});

test('save persists only AI selection, sends no requests, and restores the last choice on restart', async t => {
  const f=await fixture(t);
  const before=structuredClone(f.originalConfig);
  before.campaign.brand='./brand/identity.json';
  // Unrelated forward-compatible fields are retained by the writer, not accepted as API input.
  before.unrelated={enabled:true};before.ai.unrelated='preserved';
  await fs.writeFile(f.configPath,JSON.stringify(before));
  await f.manager.save(f.engine,opus);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath,'utf8')),{...before,ai:{...before.ai,...opus}});
  assert.deepEqual(f.manager.selection,opus);assert.equal(f.calls.length,0);
  await fs.writeFile(f.configPath,JSON.stringify({...f.originalConfig,ai:opus}));
  const restored=await restart(f);
  assert.deepEqual(restored.manager.selection,opus);
  assert.equal(restored.manager.providerStatus().connected,false);
  assert.equal(restored.engine.run,null);
});

test('ignored override names never include their values or credentials and do not mutate the environment', async t => {
  const f=await fixture(t);
  const credentials={...env,LAUNCH_AI_PROVIDER:'DO_NOT_ECHO_PROVIDER',OPENAI_MODEL:'DO_NOT_ECHO_OPENAI',ANTHROPIC_MODEL:'DO_NOT_ECHO_ANTHROPIC'};
  const before={...credentials};
  const config=await loadConfiguration({root:f.root,env:credentials});
  const manager=new AISettings({config,env:credentials});
  assert.deepEqual(manager.selection,sol);
  assert.deepEqual(config.ignoredModelOverrides,['LAUNCH_AI_PROVIDER','OPENAI_MODEL','ANTHROPIC_MODEL']);
  const visible=JSON.stringify({...manager.state(),status:manager.providerStatus()});
  for(const secret of Object.values(credentials))assert.ok(!visible.includes(secret));
  assert.deepEqual(credentials,before);
});

test('invalid settings reject unknown fields, mismatched pairs and invented aliases without echoing values', async t => {
  const f=await fixture(t);
  const before=await fs.readFile(f.configPath,'utf8');
  for(const invalid of [null,[],{}, {...sol,apiKey:'DO_NOT_ECHO'}, {...sol,extra:true}, {...sol,provider:'anthropic'}, {...sol,model:'gpt-6.1-sol-latest'}, {...sol,model:'<script>DO_NOT_ECHO</script>'}]){
    assert.throws(()=>validateSettings(invalid),error=>error.status===400&&!error.message.includes('DO_NOT_ECHO'));
    await assert.rejects(f.manager.save(f.engine,invalid));
  }
  assert.equal(await fs.readFile(f.configPath,'utf8'),before);assert.deepEqual(f.manager.selection,sol);
});

test('write and rename failures preserve exact prior bytes and running selection; temporary files are cleaned', async t => {
  for(const method of ['writeFile','rename']){
    const f=await fixture(t);
    const before=await fs.readFile(f.configPath);
    const io={...fs,[method]:async()=>{throw new Error('DO_NOT_ECHO_FILESYSTEM');}};
    f.manager.saveSettings=(file,value)=>saveAISettings(file,value,{io});
    await assert.rejects(f.manager.save(f.engine,opus),error=>error.status===500&&!error.message.includes('DO_NOT_ECHO'));
    assert.deepEqual(await fs.readFile(f.configPath),before);assert.deepEqual(f.manager.selection,sol);
    assert.equal(f.engine.busy,false);assert.equal(f.manager.saving,false);
    assert.equal((await fs.readdir(f.root)).some(name=>name.endsWith('.tmp')),false);
  }
});

test('a concurrent external config edit is not overwritten by a settings save', async t => {
  const f=await fixture(t);
  const external={...f.originalConfig,server:{port:8242}};
  const io={...fs,writeFile:async(...args)=>{await fs.writeFile(...args);await fs.writeFile(f.configPath,JSON.stringify(external));}};
  await assert.rejects(saveAISettings(f.configPath,opus,{io}),/changed while saving/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath,'utf8')),external);
});

test('unconfigured selection can be saved but no run or fallback can start', async t => {
  const f=await fixture(t,{credentials:{OPENAI_API_KEY:'SYNTHETIC_OPENAI_ONLY'}});
  await f.manager.save(f.engine,opus);
  assert.equal(f.manager.providerStatus().configured,false);
  assert.throws(()=>f.engine.startBrief({brief:'Apply changes.'}),/ANTHROPIC_API_KEY/);
  assert.throws(()=>f.engine.start(change),/ANTHROPIC_API_KEY/);
  assert.equal(f.calls.length,0);assert.equal(f.engine.run,null);
});

test('an unlisted saved choice stays visible across restart and requires an explicit replacement', async t => {
  const selection={provider:'openai',model:'previous-account-model'};
  const f=await fixture(t,{selection});
  assert.deepEqual(f.manager.selection,selection);assert.equal(f.manager.providerStatus().listed,false);
  assert.throws(()=>f.engine.start(change),/supported model/);
  const restored=await restart(f);
  assert.deepEqual(restored.manager.selection,selection);
  await restored.manager.save(restored.engine,sol);
  assert.deepEqual(restored.manager.selection,sol);assert.equal(f.calls.length,0);
});

test('save lock rejects simultaneous saves and run starts; start lock rejects saves', async t => {
  const gate=deferred(), entered=deferred();
  const f=await fixture(t,{saveSettings:async(file,value)=>{entered.resolve();await gate.promise;return saveAISettings(file,value);}});
  const saving=f.manager.save(f.engine,opus);
  await entered.promise;
  assert.equal(f.engine.busy,true);assert.equal(f.manager.state().saving,true);
  assert.throws(()=>f.engine.start(change),/already working/);
  assert.throws(()=>f.engine.startBrief({brief:'Apply changes.'}),/already working/);
  await assert.rejects(f.manager.save(f.engine,sol),/already working/);
  gate.resolve();await saving;
  f.engine.start(change);
  await assert.rejects(f.manager.save(f.engine,sol),/already working/);
  await f.engine.task;
  assert.deepEqual(f.engine.run.aiSelection,{...opus,catalogVersion:modelCatalog().version});
});

test('settings refuse all active processing statuses even if a stale busy flag is false', async t => {
  const f=await fixture(t);
  for(const status of ['interpreting','proposing','rendering','checking']){
    f.engine.run={status};
    await assert.rejects(f.manager.save(f.engine,opus),/current operation/);
    assert.deepEqual(f.manager.selection,sol);
  }
  f.engine.run=null;
});

test('interpretation, proposals, audits and corrections stay pinned across selection changes and restart', async t => {
  const f=await fixture(t);
  await run(f);
  const oldRun=structuredClone(f.engine.run), hash=f.engine.run.candidateHash;
  assert.deepEqual(f.calls.map(call=>call.stage),['brief','proposal','audit']);
  await f.manager.save(f.engine,opus);
  assert.deepEqual(f.engine.run,oldRun);assert.equal(await f.engine.computeCandidateHash(),hash);
  const restored=await restart(f);
  await restored.engine.requestRevision(oldRun.id,'A',{feedback:'Add a synthetic correction.',candidateHash:hash});
  await restored.engine.recheck(oldRun.id);
  await restored.engine.edit(oldRun.id,'A',revised+'\nA second synthetic correction.');
  assert.ok(f.calls.every(call=>call.provider===sol.provider && call.model===sol.model));
  assert.equal(restored.engine.run.aiSelection.model,sol.model);
  await run(restored,false);
  assert.equal(restored.engine.run.aiSelection.model,opus.model);
  assert.equal(f.calls.at(-1).model,opus.model);
});

test('changing a new run’s model binding invalidates its candidate hash, not legacy hashes', async t => {
  const f=await fixture(t);await run(f,false);
  const hash=f.engine.run.candidateHash;
  f.engine.run.aiSelection={...opus,catalogVersion:modelCatalog().version};
  assert.notEqual(await f.engine.computeCandidateHash(),hash);
});

test('missing credentials for a pinned version never use the next selection or invalidate existing approval', async t => {
  const f=await fixture(t);await run(f,false);
  await f.engine.decide(f.engine.run.id,{decision:'approve',candidateHash:f.engine.run.candidateHash,reviewer:'Synthetic only'});
  await f.manager.save(f.engine,opus);
  const config=await loadConfiguration({root:f.root,env:{}});
  const manager=new AISettings({config,env:{ANTHROPIC_API_KEY:'SYNTHETIC_ONLY'}});
  f.engine.aiSettings=manager;f.engine.provider=manager;
  const before=structuredClone(f.engine.run);
  assert.equal(manager.providerStatus().configured,true);
  assert.equal(manager.versionStatus(f.engine.run).canContinue,false);
  await assert.rejects(f.engine.recheck(before.id),/OPENAI_API_KEY/);
  assert.deepEqual(f.engine.run,before);
});

test('a known concrete legacy run remains pinned without rewriting hashes or review state', async t => {
  const f=await fixture(t);await run(f,false);
  delete f.engine.run.aiSelection;
  f.engine.run.candidateHash=await f.engine.computeCandidateHash();
  await f.engine.save();
  const before=structuredClone(f.engine.run);
  await f.manager.save(f.engine,opus);
  const restored=await restart(f);
  assert.deepEqual(restored.engine.run,before);
  assert.equal(await restored.engine.computeCandidateHash(),before.candidateHash);
  await restored.engine.recheck(before.id);
  assert.equal(f.calls.at(-1).model,sol.model);
  assert.equal(restored.engine.run.aiSelection,undefined);
});

test('catalog updates do not rewrite saved selection or existing run bindings', async t => {
  const f=await fixture(t);await run(f,false);
  const oldRun=structuredClone(f.engine.run), before=await fs.readFile(f.configPath);
  const catalog={...modelCatalog(),version:'synthetic-next-release',models:MODELS.filter(item=>item.model!==sol.model)};
  const restored=await restart(f,env,catalog);
  assert.deepEqual(restored.manager.selection,sol);
  assert.equal(restored.manager.providerStatus().listed,false);
  assert.deepEqual(restored.engine.run,oldRun);
  assert.deepEqual(await fs.readFile(f.configPath),before);
  await restored.engine.recheck(oldRun.id);
  assert.equal(f.calls.at(-1).model,sol.model);
  assert.throws(()=>restored.engine.start(change),/supported model/);
});

test('legacy concrete provenance can continue but mixed or moving aliases cannot', () => {
  assert.deepEqual(concreteLegacySelection({provider:sol,requests:[sol]}),sol);
  assert.deepEqual(concreteLegacySelection({provider:{provider:'anthropic',model:'claude-sonnet-4-6'},requests:[]}),{provider:'anthropic',model:'claude-sonnet-4-6'});
  for(const run of [{requests:[]},{provider:sol,requests:[opus]},{provider:{provider:'openai',model:'chat-latest'}},{provider:{provider:'anthropic',model:'claude-sonnet-4-5'}}]){
    assert.equal(concreteLegacySelection(run),null);
  }
});

test('ambiguous legacy provenance blocks only further AI operations and retains approved downloads', async t => {
  const f=await fixture(t);await run(f,false);
  delete f.engine.run.aiSelection;
  f.engine.run.provider={provider:'openai',model:'ambiguous-latest'};
  f.engine.run.candidateHash=await f.engine.computeCandidateHash();
  await f.engine.decide(f.engine.run.id,{decision:'approve',candidateHash:f.engine.run.candidateHash,reviewer:'Synthetic test only'});
  const release=await f.engine.package(f.engine.run.id,f.engine.run.candidateHash);
  const restored=await restart(f);
  const before=structuredClone(restored.engine.run);
  assert.equal(restored.manager.versionStatus(restored.engine.run).canContinue,false);
  await assert.rejects(restored.engine.recheck(before.id),/ambiguous legacy/);
  await assert.rejects(restored.engine.requestRevision(before.id,'A',{feedback:'Synthetic',candidateHash:before.candidateHash}),/ambiguous legacy/);
  await assert.rejects(restored.engine.edit(before.id,'A',revised),/ambiguous legacy/);
  assert.deepEqual(restored.engine.run,before);
  const {server}=await createApplication({engine:restored.engine});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base+release.downloadUrl)).status,200);
    assert.equal((await fetch(base+'/api/state')).status,200);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('HTTP settings enforce CSRF, local origin, allowlisted input, and safe status responses', async t => {
  const f=await fixture(t);
  const {server}=await createApplication({engine:f.engine});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const state=await(await fetch(base+'/api/state')).json();
    const route=base+'/api/settings/ai', headers={'content-type':'application/json'};
    assert.equal((await fetch(route,{method:'POST',headers,body:JSON.stringify(opus)})).status,403);
    headers['X-Campaign-Control-Token']=state.csrfToken;
    assert.equal((await fetch(route,{method:'POST',headers:{...headers,origin:'https://outside.example'},body:JSON.stringify(opus)})).status,403);
    assert.equal((await fetch(route,{method:'POST',headers,body:JSON.stringify({...opus,apiKey:'DO_NOT_ECHO'})})).status,400);
    const response=await fetch(route,{method:'POST',headers,body:JSON.stringify(opus)});
    assert.equal(response.status,200);
    const text=await response.text(), saved=JSON.parse(text);
    assert.deepEqual(saved.aiSettings.selection,opus);
    for(const secret of Object.values(env))assert.ok(!text.includes(secret));
    assert.equal(saved.provider.connected,false);assert.equal(saved.provider.configured,true);
    assert.equal(f.calls.length,0);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('diagnostic script uses the saved choice and names-only notices with a mocked transport', async t => {
  const f=await fixture(t);
  const script=new URL('../scripts/check-ai.mjs',import.meta.url).href;
  const bootstrap=`
    process.argv=[process.execPath,'check-ai.mjs','--config',${JSON.stringify(f.configPath)}];
    globalThis.fetch=async(url,init)=>{
      const body=JSON.parse(init.body);
      if(url!=='https://api.openai.com/v1/responses'||body.model!=='gpt-6.1-sol')throw new Error('Wrong saved selection');
      const input=JSON.parse(body.input[0].content);
      return new Response(JSON.stringify({model:body.model,status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({...input.confirmedFacts,summary:'Synthetic diagnostic.',questions:[]})}]}]}));
    };
    await import(${JSON.stringify(script)});
  `;
  const {stdout,stderr}=await promisify(execFile)(process.execPath,['--input-type=module','-e',bootstrap],{env:{PATH:process.env.PATH,OPENAI_API_KEY:'SYNTHETIC_DIAGNOSTIC_ONLY',LAUNCH_AI_PROVIDER:'DO_NOT_ECHO_PROVIDER',OPENAI_MODEL:'DO_NOT_ECHO_MODEL',ANTHROPIC_MODEL:'DO_NOT_ECHO_ANTHROPIC'}});
  assert.equal(stderr,'');
  assert.match(stdout,/LAUNCH_AI_PROVIDER, OPENAI_MODEL, ANTHROPIC_MODEL/);
  assert.match(stdout,/"ok": true/);assert.match(stdout,/"model": "gpt-6.1-sol"/);
  assert.ok(!stdout.includes('DO_NOT_ECHO'));assert.ok(!stdout.includes('SYNTHETIC_DIAGNOSTIC_ONLY'));
});
