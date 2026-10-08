import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {modelCatalog} from '../lib/model-catalog.mjs';

const app = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');

// Exercise the actual review renderer without a browser, model call, or live approval.
function reviewFixture() {
  const nodes = new Map();
  function parseControls(html) {
    for (const tag of html.matchAll(/<(?:button|textarea)\b[^>]*>/g)) {
      const id = /\bid="([^"]+)"/.exec(tag[0])?.[1];
      if (id) {const node = element(id); node.disabled = /\sdisabled(?:\s|>)/.test(tag[0]);}
    }
  }
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value:'', checked:false, disabled:false, hidden:false, textContent:'',listeners:{},open:false,dataset:{},
      addEventListener(type,fn) {this.listeners[type]=fn;}, setAttribute() {}, focus() {}, scrollIntoView() {},
      showModal() {this.open=true;},close() {this.open=false;},
      insertAdjacentHTML(_position, html) {this.insertedHTML=(this.insertedHTML || '')+html;parseControls(html);},
      set innerHTML(html) {this.html = html; parseControls(html);},
      get innerHTML() {return this.html || '';},
    });
    return nodes.get(id);
  }
  const ids = ['WEB002','VID-001','SOC-001','SAL-004'];
  const fixture = {
    busy:false, capabilities:{aiSettings:true,assetRevision:true,assetResolution:true},
    provider:{provider:'openai',model:'gpt-6.1-sol',configured:true,connected:false,listed:true}, processing:{elapsedSeconds:1,total:4},
    aiSettings:{selection:{provider:'openai',model:'gpt-6.1-sol'},catalog:modelCatalog(),ignoredOverrides:[],saving:false,credentials:{openai:true,anthropic:false}},
    branding:{company:'Synthetic only'},campaign:{facts:{product:'Original'}},evidence:{registered:4,channelCount:1,channels:{sales:4}},
    workspace:{status:'Ready for review',driftMessage:null},
    assets:ids.map(id=>({id,title:id,channel:'sales',kind:'copy',required:true,status:'checked',candidateText:'Synthetic candidate',checks:[],issues:[]})),
    run:{id:'synthetic-run',version:'v001',status:'review',candidateHash:'synthetic-hash',aiSelection:{provider:'anthropic',model:'claude-opus-5-5'},scope:{assetIds:ids,inventoryCount:4},reviewAssetIds:ids,change:{product:'New plan',monthlyPrice:40,sharing:false},reviews:Object.fromEntries(ids.slice(0,3).map(id=>[id,{candidateHash:'synthetic-hash'}]))},
  };
  const context = vm.createContext({
    document:{getElementById:element,addEventListener() {},querySelectorAll:() => [],querySelector:() => null},
    location:{origin:'http://localhost'}, URL, Intl, CSS:{escape:value=>value}, window:{scrollTo() {}},
    fetch:()=>new Promise(()=>{}), setInterval() {}, setTimeout() {}, clearTimeout() {}, fixture,
  });
  vm.runInContext(app,context);
  vm.runInContext("state=fixture;view='review';selectedId='SAL-004';",context);
  return {nodes,fixture,context,run:code=>vm.runInContext(code,context)};
}

test('polling unlocks the final review actions after a local request finishes', () => {
  const {nodes,run} = reviewFixture();
  run('requestBusy=true;renderReview();');
  assert.equal(nodes.get('mark-reviewed').disabled,true);
  assert.equal(nodes.get('request-revision').disabled,true);
  assert.match(nodes.get('asset-toolbar').innerHTML,/data-resolution="exclude"[^>]* disabled/);

  // Same candidate, selection and server busy state; only the local request ended.
  run('requestBusy=false;renderReview();');
  assert.equal(nodes.get('mark-reviewed').disabled,false);
  assert.equal(nodes.get('request-revision').disabled,false);
  assert.doesNotMatch(nodes.get('asset-toolbar').innerHTML,/data-resolution="exclude"[^>]* disabled/);
  assert.equal(nodes.get('approve-button').disabled,true,'Final approval still requires the fourth review and explicit confirmation');
});

test('review controls stay locked during real processing and blocked assets cannot be marked reviewed', () => {
  const {nodes,run} = reviewFixture();
  run('state.busy=true;renderReview();');
  assert.equal(nodes.get('mark-reviewed').disabled,true);
  assert.equal(nodes.get('request-revision').disabled,true);
  run("state.busy=false;state.run.status='blocked';state.assets[3].status='blocked';renderReview();");
  assert.equal(nodes.get('mark-reviewed').disabled,true);
  assert.equal(nodes.get('request-revision').disabled,false);
  assert.doesNotMatch(nodes.get('asset-toolbar').innerHTML,/data-resolution="exclude"[^>]* disabled/);
  assert.equal(nodes.get('approve-button').disabled,true);
});

test('picker renders friendly names, version and API ID, and separates credential presence from access', () => {
  const {nodes,run}=reviewFixture();
  run('openAISettings();');
  assert.equal(nodes.get('ai-settings-dialog').open,true);
  const list=nodes.get('ai-model-list').innerHTML;
  assert.match(list,/<strong>Sol<\/strong>/);assert.match(list,/GPT-6.1 Sol/);assert.match(list,/gpt-6.1-sol/);
  assert.match(nodes.get('ai-credential-status').textContent,/credential: configured/);
  assert.match(nodes.get('ai-credential-status').textContent,/not verified/);
  assert.match(nodes.get('ai-saved-selection').textContent,/Sol/);
  assert.match(nodes.get('ai-version-selection').textContent,/Opus/);
  assert.equal(nodes.get('save-ai-settings').disabled,true);
});

test('selection and Cancel are local only; provider changes require an explicit model choice', () => {
  const {nodes,run}=reviewFixture();
  run("openAISettings();$('ai-provider').value='anthropic';$('ai-provider').listeners.change();");
  assert.equal(run('aiDraft.model'),'');
  assert.equal(nodes.get('save-ai-settings').disabled,true);
  assert.match(nodes.get('ai-model-list').innerHTML,/Fable/);
  assert.match(nodes.get('ai-credential-status').textContent,/not configured/);
  run("$('ai-model-list').listeners.change({target:{name:'ai-model',value:'claude-fable-5-1'}});");
  assert.equal(nodes.get('save-ai-settings').disabled,false);
  run('cancelAISettings();');
  assert.equal(nodes.get('ai-settings-dialog').open,false);
  assert.equal(run('state.aiSettings.selection.model'),'gpt-6.1-sol');
});

test('model changes and polling retain native radio nodes for keyboard focus', () => {
  const {nodes,run}=reviewFixture();
  run('openAISettings();');
  const list=nodes.get('ai-model-list').innerHTML;
  run("$('ai-model-list').listeners.change({target:{name:'ai-model',value:'gpt-6-astra'}});renderAISettings();");
  assert.equal(nodes.get('ai-model-list').innerHTML,list);
  assert.equal(run('aiDraft.model'),'gpt-6-astra');
  assert.equal(nodes.get('save-ai-settings').disabled,false);
});

test('polling preserves unsaved drafts and all processing or saving states lock changes', () => {
  const {nodes,run}=reviewFixture();
  run("openAISettings();aiDraft={provider:'anthropic',model:'claude-opus-5-5'};renderAISettings();renderAISettings();");
  assert.equal(run('aiDraft.model'),'claude-opus-5-5');
  for(const status of ['interpreting','proposing','rendering','checking']){
    run(`state.run.status='${status}';renderAISettings();`);
    assert.equal(nodes.get('ai-provider').disabled,true);assert.equal(nodes.get('ai-model-choices').disabled,true);
    assert.equal(nodes.get('save-ai-settings').disabled,true);assert.equal(nodes.get('ai-settings-button').disabled,true);
  }
  run("state.run.status='review';requestBusy=true;aiSaving=true;renderAISettings();");
  assert.equal(nodes.get('cancel-ai-settings').disabled,true);
  run('requestBusy=false;aiSaving=false;renderAISettings();');
  assert.equal(nodes.get('ai-provider').disabled,false);
  assert.equal(nodes.get('save-ai-settings').disabled,false);
});

test('unlisted saved model and ignored override notices are visible without substitution', () => {
  const {nodes,run}=reviewFixture();
  run("state.aiSettings.selection.model='legacy-model';state.provider.model='legacy-model';state.provider.listed=false;state.aiSettings.ignoredOverrides=['OPENAI_MODEL'];openAISettings();dashboard();");
  assert.equal(run('aiDraft.model'),'legacy-model');
  assert.match(nodes.get('ai-saved-selection').textContent,/legacy-model/);
  assert.match(nodes.get('ai-settings-notice').textContent,/has not been replaced/);
  assert.match(nodes.get('ai-settings-notice').textContent,/OPENAI_MODEL/);
  assert.equal(nodes.get('update-button').disabled,true);
  assert.equal(nodes.get('save-ai-settings').disabled,true);
});

test('Save sends only the chosen pair; success updates next model but not the version model', async () => {
  const {nodes,run}=reviewFixture();
  run("openAISettings();aiDraft={provider:'anthropic',model:'claude-fable-5-1'};renderAISettings();requests=[];fetch=async(route,options)=>{requests.push({route,options});return {ok:true,json:async()=>({...fixture,aiSettings:{...fixture.aiSettings,selection:{...aiDraft}},provider:{provider:'anthropic',model:aiDraft.model,configured:false,connected:false,listed:true}})};};");
  await run('saveAISettings();');
  assert.equal(run('requests[0].route'),'/api/settings/ai');
  assert.deepEqual(JSON.parse(run('requests[0].options.body')),{provider:'anthropic',model:'claude-fable-5-1'});
  assert.equal(run('state.aiSettings.selection.model'),'claude-fable-5-1');
  assert.equal(run('state.run.aiSelection.model'),'claude-opus-5-5');
  assert.equal(nodes.get('ai-settings-dialog').open,false);
  assert.equal(nodes.get('update-button').disabled,true,'An unconfigured saved provider cannot start a run');
});

test('failed Save keeps the modal, saved selection and editable draft for retry', async () => {
  const {nodes,run}=reviewFixture();
  run("openAISettings();aiDraft={provider:'anthropic',model:'claude-opus-5-5'};renderAISettings();fetch=async()=>({ok:false,json:async()=>({error:'Settings could not be saved.'})});");
  await run('saveAISettings();');
  assert.equal(nodes.get('ai-settings-dialog').open,true);
  assert.equal(run('state.aiSettings.selection.model'),'gpt-6.1-sol');
  assert.equal(run('aiDraft.model'),'claude-opus-5-5');
  assert.equal(nodes.get('ai-settings-error').hidden,false);
  assert.equal(nodes.get('save-ai-settings').disabled,false);
});

test('review shows the pinned model and ambiguous legacy status disables only AI correction controls', () => {
  const {nodes,run}=reviewFixture();
  run('renderReview();');
  assert.match(nodes.get('asset-content').insertedHTML,/This version’s model: Opus/);
  assert.match(nodes.get('review-timing').textContent,/Opus/);
  run("state.versionProvider={canContinue:false,selection:{provider:'openai',model:'ambiguous-latest'},message:'Start a new version for further AI operations.'};renderReview();");
  for(const id of ['request-revision','submit-revision','save-candidate'])assert.equal(nodes.get(id).disabled,true);
  assert.equal(nodes.get('mark-reviewed').disabled,false,'Viewing and human review remain available');
});

test('fresh bundled-example sessions start in demo mode and state the 4-of-104 split before starting', async () => {
  const {nodes,run,fixture}=reviewFixture();
  const demoChannels=['website','video','social','sales'];
  const allChannels=['website','email','social','paid','video','sales','support','partners','in-product','events','press'];
  fixture.assets.forEach((asset,index)=>{asset.channel=demoChannels[index];});
  for(let i=0;i<100;i++)fixture.assets.push({id:`EXTRA-${i}`,title:`Extra ${i}`,channel:allChannels[i%11],kind:'copy',required:true,status:'checked',candidateText:null,checks:[],issues:[]});
  fixture.evidence={...fixture.evidence,registered:104,channelCount:11};
  fixture.capabilities.demoScopeDefault=true;
  await run("(async()=>{state={...fixture,run:null};view='dashboard';refreshing=false;fetch=async()=>({ok:true,json:async()=>state});await refresh();})()");
  assert.equal(run('demoModeLoaded'),true);
  assert.equal(run('demoMode'),true);
  assert.equal(nodes.get('demo-mode').checked,true);
  assert.equal(nodes.get('demo-mode').disabled,false);
  assert.equal(nodes.get('scope-heading').textContent,'Demo update: 4 of 104 assets.');
  assert.equal(nodes.get('full-scope-count').textContent,'4 demo assets · 4 channels');
  assert.equal(nodes.get('scope-description').textContent,'Only these 4 demo assets and their publisher files will be updated and checked. The other 100 assets stay unchanged.');
  run("$('demo-mode').checked=false;$('demo-mode').listeners.change();");
  assert.equal(run('demoMode'),false);
  assert.equal(nodes.get('scope-heading').textContent,'Full campaign: all 104 assets.');
  assert.equal(nodes.get('full-scope-count').textContent,'104 assets · 11 channels');
  assert.equal(nodes.get('scope-description').textContent,'All 104 assets and their publisher metadata will be processed and checked.');
  await run("(async()=>{refreshing=false;await refresh();})()");
  assert.equal(run('demoMode'),false,'Only fresh sessions adopt the default; later state refreshes keep the operator choice');
  assert.equal(nodes.get('demo-mode').checked,false);
});

test('an existing version keeps its recorded scope; the switch only chooses the next update', () => {
  const {nodes,run}=reviewFixture();
  run("state={...fixture,run:{...fixture.run,scope:{assetIds:fixture.run.scope.assetIds,excludedAssetIds:[],inventoryCount:104}}};view='dashboard';demoMode=false;demoModeLoaded=true;dashboard();");
  assert.equal(nodes.get('demo-mode').checked,false);
  assert.equal(nodes.get('scope-heading').textContent,'Full campaign: all 4 assets.');
  run("setView('review');");
  assert.equal(nodes.get('demo-mode').checked,true,'During review the switch display follows the recorded run scope');
  assert.equal(nodes.get('demo-mode').disabled,true);
  assert.equal(nodes.get('scope-heading').textContent,'Demo update: 4 of 104 assets.');
  assert.equal(run('demoMode'),false,'The stored next-update choice is unchanged by the existing version');
  run("setView('dashboard');");
  assert.equal(nodes.get('demo-mode').checked,false,'Back on the dashboard the switch again selects the next update');
  assert.equal(nodes.get('scope-heading').textContent,'Full campaign: all 4 assets.');
});

test('reset returns the workbench to the fresh-session demo default', async () => {
  const {nodes,run,fixture}=reviewFixture();
  fixture.capabilities.demoScopeDefault=true;
  await run("(async()=>{state={...fixture,run:null};view='dashboard';refreshing=false;fetch=async()=>({ok:true,json:async()=>state});await refresh();})()");
  assert.equal(run('demoMode'),true);
  run("$('demo-mode').checked=false;$('demo-mode').listeners.change();");
  assert.equal(run('demoMode'),false);
  run("resetTarget={campaignId:'isolated-test',runId:null};fetch=async()=>({ok:true,json:async()=>({...state,run:null,capabilities:{...state.capabilities,demoScopeDefault:true}})});$('confirm-reset-demo').listeners.click();");
  for(let ticks=0;ticks<25;ticks++)await run('new Promise(resolve=>Promise.resolve().then(resolve));');
  assert.equal(run('demoMode'),true,'Reset restores the fresh-session default, not the last toggle choice');
  assert.equal(nodes.get('demo-mode').checked,true);
  assert.equal(nodes.get('reset-demo-dialog').open,false);
  assert.equal(nodes.get('message').hidden,false);
  assert.match(nodes.get('message').textContent,/Demo reset/);
});

test('candidate edits survive re-renders, polling, and asset navigation', async () => {
  const {nodes,run}=reviewFixture();
  run('renderReview();');
  nodes.get('candidate-editor').value='Synthetic candidate with a hand correction';
  run("$('candidate-editor').listeners.input();");
  assert.equal(run('candidateDrafts.size'),1,'Typing captures an unsaved draft');
  // A forced re-render (any completed action) restores the draft, not the stored candidate.
  run('renderReview(true);');
  assert.match(nodes.get('asset-content').innerHTML,/hand correction/);
  // Navigating to another asset shows that asset's stored candidate…
  run("selectedId='WEB002';renderReview(true);");
  assert.doesNotMatch(nodes.get('asset-content').innerHTML,/hand correction/);
  // …and returning to the asset restores the draft.
  run("selectedId='SAL-004';renderReview(true);");
  assert.match(nodes.get('asset-content').innerHTML,/hand correction/);
  // An unchanged poll rebuilds nothing and keeps the draft.
  run("fetch=async()=>({ok:true,json:async()=>({...state})});");
  await run("(async()=>{refreshing=false;await refresh();})()");
  assert.equal(run('candidateDrafts.size'),1);
  assert.match(nodes.get('asset-content').innerHTML,/hand correction/);
});

test('unsaved candidate edits are identified and gate review and approval until saved or discarded', () => {
  const {nodes,run}=reviewFixture();
  run("state.run.reviews['SAL-004']={candidateHash:'synthetic-hash'};$('confirm-facts').checked=true;$('reviewer').value='Reviewer';renderReview();");
  assert.equal(nodes.get('approve-button').disabled,false,'With everything recorded, approval is available');
  // A draft on one included asset gates the whole approval.
  run("candidateDrafts.set('synthetic-run:WEB002',{candidateHash:'synthetic-hash',text:'A different correction'});renderReview(true);");
  assert.equal(nodes.get('approve-button').disabled,true,'An unsaved edit on any included asset blocks approval');
  assert.match(nodes.get('approval-readiness').textContent,/Save or discard unsaved candidate edits on WEB002/);
  assert.match(nodes.get('review-cards').innerHTML,/✎ Unsaved edits/);
  run("selectedId='WEB002';renderReview(true);$('discard-draft').listeners.click();");
  assert.equal(run('candidateDrafts.size'),0);
  assert.equal(nodes.get('approve-button').disabled,false,'Discarding the edit restores approval availability');
  // The selected asset's own edits gate marking it reviewed.
  run("delete state.run.reviews['SAL-004'];selectedId='SAL-004';renderReview(true);");
  assert.equal(nodes.get('mark-reviewed').disabled,false,'SAL-004 awaits review');
  nodes.get('candidate-editor').value='Synthetic candidate with edits';
  run("$('candidate-editor').listeners.input();");
  assert.equal(nodes.get('mark-reviewed').disabled,true,'Unsaved edits cannot be marked reviewed');
  assert.equal(nodes.get('approve-button').disabled,true,'Approval stays gated while the draft exists');
  run('renderReview(true);');
  assert.match(nodes.get('asset-content').innerHTML,/draft-note/);
  assert.match(nodes.get('asset-content').innerHTML,/Unsaved edits/);
  assert.match(nodes.get('review-cards').innerHTML,/✎ Unsaved edits/);
  run("$('discard-draft').listeners.click();");
  assert.equal(run('candidateDrafts.size'),0);
  assert.equal(nodes.get('mark-reviewed').disabled,false,'Discarding unlocks review again');
});

test('a failed save retains the draft and keeps it identified', async () => {
  const {nodes,run}=reviewFixture();
  run('renderReview();');
  nodes.get('candidate-editor').value='Synthetic candidate with a risky correction';
  run("$('candidate-editor').listeners.input();");
  run("fetch=async()=>{throw new Error('Synthetic save failure');};");
  run("$('save-candidate').listeners.click();");
  for(let ticks=0;ticks<25;ticks++)await run('new Promise(resolve=>Promise.resolve().then(resolve));');
  assert.equal(run('candidateDrafts.size'),1,'The failed save keeps the draft');
  assert.match(nodes.get('asset-content').innerHTML,/risky correction/,'The rebuilt editor restores the draft');
  assert.match(nodes.get('message').textContent,/Synthetic save failure/);
  assert.equal(nodes.get('save-candidate').disabled,false,'Save can be retried');
});

test('changed candidate versions surface stale drafts instead of silently reapplying them', () => {
  const {nodes,run}=reviewFixture();
  run('renderReview();');
  nodes.get('candidate-editor').value='Synthetic candidate with an old correction';
  run("$('candidate-editor').listeners.input();");
  // The candidate changes under the draft, for example a completed revision.
  run("state.run.candidateHash='new-hash';state.assets.find(a=>a.id==='SAL-004').candidateText='Fresh candidate content';renderReview(true);");
  assert.doesNotMatch(nodes.get('asset-content').innerHTML,/old correction/,'The stale draft is not silently reapplied');
  assert.match(nodes.get('asset-content').innerHTML,/Fresh candidate content/);
  assert.match(nodes.get('asset-content').innerHTML,/stale-draft/);
  assert.match(nodes.get('asset-content').innerHTML,/Continue your edit/);
  assert.equal(run('candidateDrafts.size'),1,'The stale draft is not silently discarded');
  // Explicitly continuing the edit applies it against the new candidate.
  run("$('apply-stale-draft').listeners.click();");
  assert.match(nodes.get('asset-content').innerHTML,/old correction/);
  // Explicitly discarding removes it for good.
  run("state.run.candidateHash='third-hash';renderReview(true);$('discard-stale-draft').listeners.click();");
  assert.equal(run('candidateDrafts.size'),0);
  assert.doesNotMatch(nodes.get('asset-content').innerHTML,/old correction/);
});

test('pending actions show a busy state and reject duplicate submissions', async () => {
  const {nodes,context,run}=reviewFixture();
  run('renderReview();');
  nodes.get('mark-reviewed').textContent='Mark reviewed →';
  run("window.__calls=0;fetch=async()=>{window.__calls++;return {ok:true,json:async()=>state};};");
  run("$('mark-reviewed').listeners.click();");
  assert.equal(context.window.__calls,1);
  assert.equal(nodes.get('mark-reviewed').disabled,true,'The button shows a pending state');
  assert.equal(nodes.get('mark-reviewed').textContent,'Recording…');
  // A second click while the request is in flight is ignored.
  run("$('mark-reviewed').listeners.click();");
  assert.equal(context.window.__calls,1,'No duplicate submission');
  for(let ticks=0;ticks<25;ticks++)await run('new Promise(resolve=>Promise.resolve().then(resolve));');
  assert.equal(context.window.__calls,1);
  assert.equal(nodes.get('mark-reviewed').textContent,'Mark reviewed →','The label is restored');
  assert.equal(nodes.get('mark-reviewed').disabled,false);
});

test('the dashboard opens as soon as the real cross-check completes, with no staged delay', async () => {
  const {nodes,context,run}=reviewFixture();
  const delays=[];
  context.setTimeout=(fn,ms)=>{delays.push(ms);return setTimeout(()=>fn(),Math.min(ms||0,5));};
  run("state={...fixture,run:null,evidence:{...fixture.evidence,registered:104,channelCount:11}};view='home';refreshing=false;fetch=async()=>({ok:true,json:async()=>({...state})});");
  await run("(async()=>{await openCampaign();})()");
  assert.equal(run('view'),'dashboard');
  assert.match(nodes.get('loading-message').textContent,/104 assets found/);
  assert.ok(!delays.some(ms=>ms>1000),`no artificial transition delay (saw ${JSON.stringify(delays)})`);
});

test('pending actions on structured controls never destroy their content', async () => {
  const {nodes,run}=reviewFixture();
  nodes.get('campaign-button').children=[{}];
  nodes.get('campaign-button').textContent='Campaign card with rich children';
  run("state={...fixture,run:null,evidence:{...fixture.evidence,registered:104,channelCount:11}};view='home';refreshing=false;fetch=async()=>({ok:true,json:async()=>({...state})});");
  await run("(async()=>{await openCampaign();})()");
  assert.equal(nodes.get('campaign-button').textContent,'Campaign card with rich children','A structured control keeps its content through a pending action');
  assert.equal(nodes.get('campaign-button').disabled,false);
});
