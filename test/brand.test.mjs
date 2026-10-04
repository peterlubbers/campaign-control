import test from 'node:test';
import assert from 'node:assert/strict';
import {BRAND, brandHash, brandCSS, brandLogoSVG, loadBrand, validateBrand} from '../lib/brand.mjs';

test('Campaign Control defaults have their own identity and no example-company mark', async () => {
  assert.equal(BRAND.company.name,'Campaign Control');
  assert.equal(await loadBrand(null),BRAND);
  assert.doesNotMatch(JSON.stringify(BRAND),/Fictitious|signal/);
  assert.match(brandLogoSVG(),/Campaign Control Relay mark/);
  assert.doesNotMatch(brandLogoSVG(),/<text/);
  assert.match(brandLogoSVG(),/<rect[^>]+stroke=/);
  assert.doesNotMatch(brandLogoSVG(),/Fictitious/);
});

test('the moved company identity keeps the exact native-slide and media verification hash', async () => {
  const company = await loadBrand(new URL('../fictitious-ai/brand/identity.json',import.meta.url));
  assert.equal(brandHash(company),'7004e7a7bf0a829ed2fbf506950ef13741aa315025d60203ff8da8f56f5f7ae1');
  assert.match(brandLogoSVG(company),/Fictitious AI signal mark/);
  assert.equal((brandLogoSVG(company).match(/<rect /g)||[]).length,4);
  assert.match(brandCSS(company),/--brand-blue:#00B2FF/);
  assert.notEqual(brandCSS(),brandCSS(company));
});

test('unsafe styling and unreadable company files fail without silently using another identity', async () => {
  for (const modify of [
    value=>value.colors.blue='red; background:url(https://invalid.test)',
    value=>value.typography.sans='Arial; color:red',
    value=>value.company.name='<script>',
    value=>value.company.logo={viewBox:[0,0,40,40],rects:[{x:'<script>',y:0,width:2,height:2}]}
  ]) {
    const value=structuredClone(BRAND); modify(value);
    assert.throws(()=>validateBrand(value),/Invalid brand identity/);
  }
  await assert.rejects(()=>loadBrand('/private/tmp/launch-brand-does-not-exist/identity.json'),/Could not load/);
});
