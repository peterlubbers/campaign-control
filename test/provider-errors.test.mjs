import test from 'node:test';
import assert from 'node:assert/strict';
import {requestWithRetry, responseError} from '../lib/provider-errors.mjs';

const failure=(code,type=code,headers={})=>new Response(JSON.stringify({error:{code,type,message:'private credentials must not be echoed'}}),{status:429,headers});
const options=fetchImpl=>({fetchImpl,endpoint:'https://api.openai.com/v1/responses',provider:'openai',init:{signal:new AbortController().signal},random:()=>0,sleep:async()=>{}});

test('quota and spend failures never retry, including when Retry-After is present', async()=>{
  for (const code of ['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded']) {
    let calls=0;
    await assert.rejects(requestWithRetry(options(async()=>{calls++;return failure(code,'insufficient_quota',{'retry-after':'1'});})),error=>error.code==='QUOTA_EXCEEDED'&&error.details.providerCode===code&&!JSON.stringify(error).includes('private'));
    assert.equal(calls,1);
  }
});

test('temporary throttling honors Retry-After, reports the wait, and returns actual attempts', async()=>{
  let calls=0;const waits=[],messages=[];
  const result=await requestWithRetry({...options(async()=>++calls<3?failure('rate_limit_exceeded','rate_limit_error',{'retry-after':'5'}):new Response('{}')),sleep:async ms=>waits.push(ms),onRetry:async p=>messages.push(p)});
  assert.equal(result.attempts,3);assert.deepEqual(waits,[5000,5000]);
  assert.deepEqual(messages,[{attempt:1,waitSeconds:5},{attempt:2,waitSeconds:5}]);
});

test('retries stop after three attempts or a delay beyond the wait budget', async()=>{
  let calls=0;
  await assert.rejects(requestWithRetry(options(async()=>{calls++;return failure('slow_down');})),error=>error.code==='RATE_LIMITED');
  assert.equal(calls,3);calls=0;
  await assert.rejects(requestWithRetry(options(async()=>{calls++;return failure('slow_down','rate_limit_error',{'retry-after':'60'});})),error=>error.details.retryAfterSeconds===60);
  assert.equal(calls,1);
});

test('HTTP-date hints are respected; invalid hints use exponential backoff', async()=>{
  const now=Date.parse('2026-10-03T21:00:00Z');
  const error=await responseError(failure('rate_limit_exceeded','rate_limit_error',{'retry-after':'Sat, 03 Oct 2026 21:00:10 GMT'}),'openai',now);
  assert.equal(error.details.retryAfterSeconds,10);
  let calls=0;const waits=[];
  await requestWithRetry({...options(async()=>++calls<3?failure('slow_down','rate_limit_error',{'retry-after':'invalid'}):new Response('{}')),sleep:async ms=>waits.push(ms)});
  assert.deepEqual(waits,[2000,4000]);
});

test('unknown codes, bodies, and header contents never become diagnostics or retries', async()=>{
  let calls=0;
  await assert.rejects(requestWithRetry(options(async()=>{calls++;return failure('private-secret-code','private-secret-type',{'retry-after':'private-secret-header'});})),error=>error.code==='HTTP_ERROR'&&!JSON.stringify(error).includes('private'));
  assert.equal(calls,1);
});

test('cancellation during backoff sends no further request', async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(requestWithRetry({...options(async()=>{calls++;return failure('rate_limit_exceeded');}),init:{signal:controller.signal},sleep:async()=>controller.abort()}),error=>error.code==='NETWORK_ERROR');
  assert.equal(calls,1);
});
