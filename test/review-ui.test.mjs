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
      value:'', checked:false, disabled:false, hidden:false, textContent:'',listeners:{},open:false,
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
    document:{getElementById:element,addEventListener() {}},
    location:{origin:'http://localhost'}, URL, Intl,
    fetch:()=>new Promise(()=>{}), setInterval() {}, setTimeout() {}, clearTimeout() {}, fixture,
  });
  vm.runInContext(app,context);
  vm.runInContext("state=fixture;view='review';selectedId='SAL-004';",context);
  return {nodes,run:code=>vm.runInContext(code,context)};
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
