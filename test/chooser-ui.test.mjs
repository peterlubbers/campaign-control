import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {modelCatalog} from '../lib/model-catalog.mjs';

const app = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');

// A minimal DOM: elements parse their innerHTML so card buttons and form controls can be inspected and driven.
function chooserFixture({search = '', fetch: fetchImpl, reconnect = null} = {}) {
  const nodes = new Map();
  function parseControls(html) {
    const parsed = [];
    for (const tag of html.matchAll(/<(?:button|textarea|input)\b[^>]*>/g)) {
      const id = /\bid="([^"]+)"/.exec(tag[0])?.[1];
      const data = {};
      for (const attribute of tag[0].matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)) data[attribute[1]] = attribute[2];
      const item = {id, data, disabled:/\sdisabled(?:\s|>)/.test(tag[0])};
      parsed.push(item);
      if (id) {const node = element(id); node.disabled = item.disabled;}
    }
    return parsed;
  }
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value:'', checked:false, disabled:false, hidden:false, textContent:'', href:'', className:'', open:false, dataset:{}, parsed:[],
      listeners:{},
      addEventListener(type,fn) {this.listeners[type]=fn;},
      setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {}, showModal() {this.open=true;}, close() {this.open=false;},
      insertAdjacentHTML(_position, html) {this.raw = `${this.raw || ''}${html}`; this.parsed.push(...parseControls(html));},
      set innerHTML(html) {this.raw = html; this.parsed = parseControls(html);},
      get innerHTML() {return this.raw || '';},
      querySelectorAll(selector) {
        const key = /\[data-([a-z-]+)\]/.exec(selector)?.[1];
        return this.parsed.filter(item => item.data[key]).map(item => ({
          dataset:item.data, disabled:item.disabled,
          addEventListener(_type,fn) {element(item.id || `card-${key}-${item.data[key]}`).listeners['card-click']=fn;},
        }));
      },
    });
    return nodes.get(id);
  }
  const baseProvider = {provider:'openai', model:'gpt-6.1-sol', configured:true, connected:false, listed:true};
  const aiSettings = {workspaceId:'workspace-local', selection:{provider:'openai', model:'gpt-6.1-sol'}, catalog:modelCatalog(), ignoredOverrides:[], saving:false, credentials:{openai:true, anthropic:false}};
  const assets = [
    {id:'WEB002', title:'Page', channel:'website', kind:'page', required:true, status:'checked', candidateText:'Candidate copy', sourceText:'Original copy', checks:[], issues:[], capabilities:{inspect:true, modify:'editable-source-and-metadata', externalEditorRequired:false, mediaStatus:null}, sourceFiles:[{path:'page.md', artifactPath:'sources/page.md', url:'/artifacts/sources/page.md', mime:'text/markdown', role:'editable-source'}], candidateFiles:[{path:'page.html', artifactPath:'working/v001/page.html', url:'/artifacts/working/v001/page.html', mime:'text/html', role:'review-preview'}]},
    {id:'VID-001', title:'Motion', channel:'video', kind:'video', required:true, status:'blocked', candidateText:null, sourceText:null, checks:[], issues:[{severity:'error', message:'Referenced native Google documents or shortcuts cannot be revised here.', evidence:'motion/native.mp4'}], capabilities:{inspect:true, modify:'external-editor-required', externalEditorRequired:true, mediaStatus:'Video original can be previewed; source copy is editable here. Video rendering still requires the supported macOS/Swift toolchain.'}, remoteUnsupported:[{path:'motion/native.mp4', mimeType:'application/vnd.google-apps.shortcut', capability:'shortcut-not-followed'}]},
  ];
  const chooser = {
    workspace:{id:'workspace-local', name:'My workspace'}, csrfToken:'token-1',
    aiSettings, provider: baseProvider, processingLock:null,
    google:{configured:true, scope:'https://www.googleapis.com/auth/drive.readonly', scopeDisclosure:'disclosed', connections:[]},
    launches:[
      {id:'launch-local-default', workspaceId:'workspace-local', type:'local', label:'Pro500 — Local example', source:'Local filesystem', status:'available', sampleMatch:true, lastSuccessfulRefreshAt:'2025-01-01T00:00:00.000Z', campaignName:'Pro500', registered:104, channelCount:11, readiness:{label:'Ready to review', tone:'info'}},
      {id:'launch-drive-1', workspaceId:'workspace-local', type:'google-drive', label:'Pro500 — Google Drive', source:'Google Drive · Pro500', status:'connected', sampleMatch:true, lastSuccessfulRefreshAt:'2025-01-01T00:00:00.000Z', campaignName:'Pro500', registered:104, channelCount:11, readiness:{label:'Connected · open to inspect', tone:'info'}, folderName:'Pro500'},
    ],
  };
  const launchStates = new Map();
  for (const id of ['launch-local-default','launch-drive-1']) launchStates.set(id, {
    identity:{workspaceId:'workspace-local', launchId:id},
    launch:{id, type:id === 'launch-drive-1' ? 'google-drive' : 'local', status:'connected', label:'Pro500'},
    capabilities:{aiSettings:true, assetRevision:true, assetResolution:true, demoReset:id === 'launch-drive-1', workspaceReset:id === 'launch-drive-1', demoScopeDefault:true},
    aiSettings, provider: baseProvider, versionProvider:{selection:{provider:'openai', model:'gpt-6.1-sol'}, canContinue:true},
    branding:{company:'Synthetic only'}, campaign:{id:'pro500-launch', facts:{product:'Pro500'}}, assets, run:null, job:null,
    evidence:{registered:2, channelCount:2, channels:{website:1, video:1}, blocked:1, checked:1},
    workspace:{path:'/private', status:'Draft', driftMessage:null}, storage:{source:'Local filesystem', originals:'/campaign', snapshot:null, working:'w', releases:'r'},
    processing:{elapsedSeconds:1, total:2}, marketEvidence:null, readyRelease:null, csrfToken:'token-1', processingLock:null,
  });
  const context = vm.createContext({
    document:{getElementById:element, addEventListener() {}, querySelectorAll:() => [], querySelector:() => null},
    location:{origin:'http://localhost', search, href:'http://localhost/'},
    URL, Intl, CSS:{escape:value=>value}, window:{scrollTo() {}},
    fetch: fetchImpl || (async () => new Promise(() => {})),
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    sessionStorage:{store:new Map(), getItem(key) {return this.store.has(key) ? this.store.get(key) : null;}, setItem(key, value) {this.store.set(key, String(value));}, removeItem(key) {this.store.delete(key);}},
    // app.js declares its own lexical `chooser`; the payload needs a non-colliding name.
    chooserPayload: chooser, launchStates,
  });
  // A relaunch after the Google redirect starts with the browser's stored reconnect target,
  // which the app reads while it loads.
  if (reconnect) vm.runInContext(`sessionStorage.setItem('cc-reconnect-launch', ${JSON.stringify(reconnect)});`, context);
  vm.runInContext(app, context);
  const run = code => vm.runInContext(code, context);
  const drain = async () => {for (let ticks = 0; ticks < 40; ticks++) await run('new Promise(resolve=>Promise.resolve().then(resolve));');};
  return {nodes, run, drain, chooser, launchStates, context};
}

test('the chooser lists every launch with its source, refresh state, and Drive controls', async () => {
  const fixture = chooserFixture();
  const {nodes, run, drain} = fixture;
  run(`fetch = async (route, init) => ({ok:true, status:200, headers:{get:() => 'application/json'}, json:async () => chooserPayload});`);
  run('refreshing=false;void refresh();');
  await drain();
  assert.equal(run('view'), 'chooser');
  const cards = nodes.get('launch-cards');
  assert.match(cards.innerHTML, /Pro500 — Local example/);
  assert.match(cards.innerHTML, /Pro500 — Google Drive/);
  assert.match(cards.innerHTML, /Google Drive · Pro500/);
  assert.match(cards.innerHTML, /Refreshed/);
  assert.equal(nodes.get('launch-count').textContent, 2);
  assert.equal(nodes.get('google-start').hidden, false, 'The connect button is visible before authorization');
  assert.equal(nodes.get('drive-launch-form').hidden, true, 'The folder form appears only after returning with a connection');
  assert.equal(nodes.get('chooser-notice').hidden, true, 'No setup warning when Google is configured');

  const driveButtons = cards.parsed.filter(item => item.data.refresh);
  assert.equal(driveButtons.length, 1, 'Only Drive cards expose snapshot refresh');
  assert.equal(driveButtons[0].data.refresh, 'launch-drive-1');
  const disconnectButtons = cards.parsed.filter(item => item.data.disconnect);
  assert.equal(disconnectButtons.length, 1);

  // A disconnected launch offers exactly one Drive action: reconnecting. Nothing to open, refresh, or revoke.
  fixture.chooser.launches[1].status = 'disconnected';
  run('renderChooser();');
  const disconnected = nodes.get('launch-cards').parsed;
  assert.equal(disconnected.filter(item => item.data.refresh).length, 0, 'A disconnected launch cannot refresh');
  assert.equal(disconnected.find(item => item.data.open === 'launch-drive-1').disabled, true);
  assert.equal(disconnected.find(item => item.data.disconnect).disabled, true);
  assert.equal(disconnected.find(item => item.data.reconnect).disabled, false, 'Reconnect is the one action a disconnected launch offers');
});

test('opening a launch scopes every request to its identity and keeps drafts per launch', async () => {
  const fixture = chooserFixture();
  const {nodes, run, drain} = fixture;
  run(`requested = [];
  fetch = async (route, init) => {
    requested.push(route);
    let payload;
    if (route === '/api/state' && !launch) payload = chooserPayload;
    else if (route.endsWith('/state') || route.endsWith('/campaign/open')) payload = launchStates.get(launch.launchId);
    else payload = {...(launchStates.get(launch.launchId) || chooserPayload)};
    return {ok:true, status:200, headers:{get:() => 'application/json'}, json:async () => payload};
  };
  refreshing=false;void refresh();`);
  await drain();
  assert.equal(run('view'), 'chooser');

  run(`void openLaunch('launch-local-default');`);
  await drain();
  assert.equal(run('view'), 'dashboard');
  assert.equal(run('launch.launchId'), 'launch-local-default');
  assert.equal(run('launch.workspaceId'), 'workspace-local');
  assert.ok(run('requested').at(-1).includes('/api/workspaces/workspace-local/launches/launch-local-default/state'), 'State polling is launch-scoped');
  assert.equal(nodes.get('reset-demo-button').textContent, 'Reset demo');

  // An unsaved draft on the local launch is captured under that launch's identity.
  run(`candidateDrafts.set(candidateDraftKey('run-1','WEB002'), {candidateHash:'hash-a', text:'Unsaved local edit'});`);
  assert.equal(run('candidateDrafts.size'), 1);

  // Switching to the chooser and opening the other launch preserves the draft.
  run(`$('home-button').listeners.click();`);
  assert.equal(run('view'), 'chooser');
  assert.equal(run('launch'), null);
  run(`void openLaunch('launch-drive-1');`);
  await drain();
  assert.equal(run('launch.launchId'), 'launch-drive-1');
  assert.equal(run('launch.workspaceId'), 'workspace-local');
  assert.equal(run('candidateDrafts.size'), 1, 'Switching launches preserves the other launch’s unsaved work');
  assert.equal(run("candidateDrafts.has('workspace-local/launch-local-default/run-1/WEB002')"), true);
  assert.equal(run("candidateDrafts.has(candidateDraftKey('run-1','WEB002'))"), false, 'The Drive launch has its own draft keys');
  assert.equal(nodes.get('reset-demo-button').textContent, 'Reset workspace');

  // Capability badges distinguish inspectable, editable, and external-editor assets.
  run(`state.run={id:'run-2',status:'review',candidateHash:'hash-b',version:'v001',scope:{assetIds:['WEB002','VID-001'],inventoryCount:2},reviewAssetIds:['WEB002','VID-001'],change:{product:'Pro1000',monthlyPrice:1000,sharing:false,maxTeammates:0},reviews:{},assetRevisions:[]};view='review';selectedId='VID-001';renderReview();`);
  assert.match(nodes.get('asset-toolbar').innerHTML, /External editor required/);
  assert.match(nodes.get('asset-toolbar').innerHTML, /motion\/native\.mp4/);
  run(`selectedId='WEB002';renderReview(true);`);

  // A cross-launch processing lock disables actions in every launch that shows it.
  run(`state.processingLock={launchId:'launch-local-default', kind:'campaign update'};renderReview(true);`);
  assert.equal(run('otherLaunchProcessing()'), true);
  assert.equal(run('isBusy()'), true);
  assert.equal(nodes.get('request-revision').disabled, true);
  run(`state.processingLock=null;renderReview(true);`);
  assert.equal(nodes.get('request-revision').disabled, false, 'The same asset unlocks once the other launch finishes');

  // Resetting this launch clears only its own drafts.
  run(`candidateDrafts.set(candidateDraftKey('run-2','WEB002'), {candidateHash:'hash-b', text:'Drive edit'});`);
  assert.equal(run('candidateDrafts.size'), 2);
  run(`clearLaunchDrafts();`);
  assert.equal(run('candidateDrafts.size'), 1, 'The local launch’s draft survives the Drive launch reset');
  assert.equal(run("candidateDrafts.has('workspace-local/launch-local-default/run-1/WEB002')"), true);
});

test('connecting Drive sends the browser to Google and returns ready for exactly one folder choice', async () => {
  const chooserPayload = chooserFixture().chooser;
  const jsonResponse = payload => ({ok:true, status:200, headers:{get:() => 'application/json'}, json:async () => payload});
  const routed = async route => route === '/api/google/authorize'
    ? jsonResponse({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=abc', csrfToken:'token-1'})
    : jsonResponse(chooserPayload);
  const fixture = chooserFixture({fetch: routed});
  const {nodes, run, drain} = fixture;
  assert.equal(run('view'), 'home');
  await drain();
  assert.equal(run('view'), 'chooser');
  run(`$('google-start').listeners.click();`);
  await drain();
  assert.equal(run('location.href').startsWith('https://accounts.google.com/o/oauth2/v2/auth'), true, 'The browser is sent to Google consent');
  assert.equal(nodes.get('drive-launch-form').hidden, true, 'The folder form appears only after returning with a connection');

  // After the redirect, the app boots with a connection identity and shows the folder form.
  const booted = chooserFixture({search:'?googleConnection=conn-123', fetch: async () => jsonResponse(chooserPayload)});
  const {nodes: bootNodes, run: bootRun, drain: bootDrain} = booted;
  await bootDrain();
  assert.equal(bootRun('pendingConnectionId'), 'conn-123');
  assert.equal(bootNodes.get('drive-launch-form').hidden, false);
  assert.equal(bootNodes.get('google-start').hidden, true);
  assert.equal(bootNodes.get('chooser-notice').hidden, true);
});

test('a disconnected launch reconnects in place instead of adding a second launch', async () => {
  const chooserPayload = chooserFixture().chooser;
  chooserPayload.launches[1].status = 'disconnected';
  const jsonResponse = payload => ({ok:true, status:200, headers:{get:() => 'application/json'}, json:async () => payload});
  const calls = [];
  const routed = async (route, init) => {
    calls.push({route, body:init?.body ? JSON.parse(init.body) : null});
    if (route.endsWith('/connection')) return jsonResponse({jobId:'job-reconnect', workspaceId:'workspace-local', launchId:'launch-drive-1'});
    if (route === '/api/google/authorize') return jsonResponse({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=abc', csrfToken:'token-1'});
    return jsonResponse(chooserPayload);
  };
  const fixture = chooserFixture({fetch: routed});
  const {nodes, run, drain} = fixture;
  await drain();
  assert.equal(run('view'), 'chooser');

  // The disconnected card offers exactly one Drive action: reconnecting.
  const controls = nodes.get('launch-cards').parsed;
  assert.equal(controls.filter(item => item.data.reconnect).length, 1);
  assert.equal(controls.filter(item => item.data.refresh).length, 0, 'A disconnected launch cannot refresh');
  assert.equal(controls.find(item => item.data.disconnect).disabled, true, 'There is no connection left to revoke');
  assert.equal(controls.find(item => item.data.open === 'launch-drive-1').disabled, true);

  nodes.get('card-reconnect-launch-drive-1').listeners['card-click']();
  await drain();
  assert.equal(run('location.href').startsWith('https://accounts.google.com/o/oauth2/v2/auth'), true, 'Reconnect sends the browser to Google consent');
  assert.equal(run("sessionStorage.getItem('cc-reconnect-launch')"), 'launch-drive-1', 'The launch identity survives the redirect');

  // Coming back from consent replaces that launch's connection; no folder form and no second launch.
  const returning = chooserFixture({search:'?googleConnection=conn-999', reconnect:'launch-drive-1', fetch: routed});
  const {nodes: returnNodes, run: returnRun, drain: returnDrain} = returning;
  await returnDrain();
  const posted = calls.find(call => call.route.endsWith('/connection'));
  assert.equal(posted.route, '/api/workspaces/workspace-local/launches/launch-drive-1/connection');
  assert.deepStrictEqual(posted.body, {launchId:'launch-drive-1', connectionId:'conn-999'});
  assert.equal(returnRun('pendingConnectionId'), null);
  assert.equal(returnRun('reconnectTarget'), null);
  assert.equal(returnNodes.get('drive-launch-form').hidden, true, 'Returning for an existing launch never asks for a folder again');
  assert.equal(calls.some(call => call.route === '/api/google/launches'), false, 'Reconnecting adds no launch');
});
