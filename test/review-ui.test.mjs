import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

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
      value:'', checked:false, disabled:false, hidden:false, textContent:'',
      addEventListener() {}, setAttribute() {}, focus() {}, scrollIntoView() {},
      insertAdjacentHTML(_position, html) {parseControls(html);},
      set innerHTML(html) {this.html = html; parseControls(html);},
      get innerHTML() {return this.html || '';},
    });
    return nodes.get(id);
  }
  const ids = ['WEB002','VID-001','SOC-001','SAL-004'];
  const fixture = {
    busy:false, capabilities:{assetRevision:true,assetResolution:true},
    provider:{model:'synthetic-ui-test'}, processing:{elapsedSeconds:1,total:4},
    assets:ids.map(id=>({id,title:id,channel:'sales',kind:'copy',required:true,status:'checked',candidateText:'Synthetic candidate',checks:[],issues:[]})),
    run:{id:'synthetic-run',version:'v001',status:'review',candidateHash:'synthetic-hash',scope:{assetIds:ids,inventoryCount:4},reviewAssetIds:ids,change:{product:'New plan',monthlyPrice:40,sharing:false},reviews:Object.fromEntries(ids.slice(0,3).map(id=>[id,{candidateHash:'synthetic-hash'}]))},
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
