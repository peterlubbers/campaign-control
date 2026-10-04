import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryFiles, hasDeliverable} from '../lib/delivery.mjs';

test('publisher selection excludes authoring source and internal review files', () => {
  const roles = ['publishable-copy','graphic','native-video','captions','thumbnail','publisher-metadata','youtube-metadata','native-presentation-reference','pdf-document','editable-source','review-preview','document-preview','render-evidence','video-scene-source','unknown'];
  const selected = deliveryFiles({candidateFiles: roles.map(role => ({role, path: `${role}.txt`}))});
  assert.deepEqual(selected.map(file => file.role), roles.slice(0, 9));
});

test('a PDF is a publisher deliverable, while its rendered thumbnail is review evidence',()=>{
  assert.equal(hasDeliverable({candidateFiles:[{role:'document-preview'},{role:'publisher-metadata'}]}),false);
  assert.equal(hasDeliverable({candidateFiles:[{role:'pdf-document'}]}),true);
});

test('metadata and thumbnails alone cannot masquerade as a finished deliverable', () => {
  const asset = {candidateFiles: [{role: 'thumbnail'}, {role: 'publisher-metadata'}, {role: 'editable-source'}]};
  assert.equal(hasDeliverable(asset), false);
  asset.candidateFiles.push({role: 'native-video'});
  assert.equal(hasDeliverable(asset), true);
});
