import test from 'node:test';
import assert from 'node:assert/strict';
import {launchReadiness} from '../lib/readiness.mjs';

const assets = [{sourceHash:'original',required:true,status:'inventoried'}];
test('original campaign readiness requires readable required assets', () => {
  assert.equal(launchReadiness({assets}).label,'Launch ready');
  for (const inventory of [[], [{required:true}], [{sourceHash:'original',required:true,status:'blocked'}]]) {
    assert.equal(launchReadiness({assets:inventory}).tone,'danger');
  }
});

test('current work withdraws green readiness before human approval and packaging', () => {
  for (const [status,label] of Object.entries({draft:'Draft · not launch ready',interpreting:'Updating',proposing:'Updating',rendering:'Updating',checking:'Updating',review:'Awaiting approval',approved:'Approved · package pending',failed:'Needs attention',blocked:'Needs attention',rejected:'Changes requested',stale:'Review required'})) {
    const readiness=launchReadiness({assets,run:{status},readyRelease:{assetCount:1}});
    assert.equal(readiness.label,label);
    assert.notEqual(readiness.tone,'ready');
  }
});

test('only an exact approved full release returns to green', () => {
  const run={status:'packaged',approval:{decision:'approve',candidateHash:'checked'}};
  const readyRelease={candidateHash:'checked',assetCount:1,partial:false};
  assert.equal(launchReadiness({assets,run,readyRelease}).tone,'ready');
  for (const release of [null,{...readyRelease,candidateHash:'old'},{...readyRelease,partial:true},{...readyRelease,assetCount:0}]) {
    assert.notEqual(launchReadiness({assets,run,readyRelease:release}).tone,'ready');
  }
  assert.equal(launchReadiness({assets,run,readyRelease,driftMessage:'Output changed.'}).label,'Review required');
});
