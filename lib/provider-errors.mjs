import {setTimeout as delay} from 'node:timers/promises';

export class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_FAILURE', details = null) {
    super(message); this.name = 'ProviderError'; this.code = code; this.details = details;
  }
}

const quotaActions = {
  credit_balance_exhausted: 'The API credit balance is exhausted. The account owner must restore credits before retrying.',
  organization_spend_limit_exceeded: 'The organization API spend limit was reached. Ask its owner to review the limit or wait for its reset.',
  project_spend_limit_exceeded: 'This project reached its API spend limit. Ask the project owner to review the limit or wait for its reset.',
  organization_usage_limit_exceeded: 'The organization reached its approved API usage limit. Ask its owner to review the usage limit.',
  insufficient_quota: 'API quota is unavailable. Check credits and usage limits for the project that owns this key. Waiting or changing the campaign brief will not restore quota.',
};
const temporaryCodes = new Set(['rate_limit_exceeded','rate_limit_error','slow_down','server_is_overloaded']);

function retrySeconds(value, time) {
  if (!value) return null;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value)*1000 : Date.parse(value)-time;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds / 1000) : null;
}

export async function responseError(response, provider, time = Date.now()) {
  let error;
  try {error = (await response.json())?.error;} catch { /* Never surface an untrusted response body. */ }
  const code = typeof error?.code === 'string' && Object.hasOwn(quotaActions,error.code) ? error.code : typeof error?.type === 'string' && Object.hasOwn(quotaActions,error.type) ? error.type : null;
  const label = provider === 'openai' ? 'OpenAI' : 'Anthropic';
  const details = {status:response.status, providerCode:code, retryAfterSeconds:null};
  if (code) return new ProviderError(`${label}: ${quotaActions[code]} (HTTP ${response.status})`, 'QUOTA_EXCEEDED', details);
  const temporary = temporaryCodes.has(error?.code) ? error.code : temporaryCodes.has(error?.type) ? error.type : null;
  if ((response.status === 429 || response.status === 503) && temporary) {
    details.providerCode = temporary;
    details.retryAfterSeconds = retrySeconds(response.headers?.get('retry-after'),time);
    return new ProviderError(`${label} is temporarily rate-limiting or overloaded (HTTP ${response.status}). ${details.retryAfterSeconds !== null ? `Wait at least ${details.retryAfterSeconds} seconds before retrying.` : 'Pause before retrying; reduce concurrent requests if this persists.'}`, 'RATE_LIMITED', details);
  }
  if (response.status === 401) return new ProviderError(`${label} rejected API authentication (HTTP 401). Check the server key and its project permissions.`, 'AUTHENTICATION_FAILED', details);
  if (response.status === 403 || response.status === 404) return new ProviderError(`${label} did not allow this API request (HTTP ${response.status}). Check the selected model and project access.`, 'ACCESS_DENIED', details);
  if (response.status === 429) return new ProviderError(`${label} returned HTTP 429 without a recognized error code. Check this API project's quota and rate limits before retrying.`, 'HTTP_ERROR', details);
  return new ProviderError(`${label} request returned HTTP ${response.status}. Check model support and provider availability.`, 'HTTP_ERROR', details);
}

// Only confirmed temporary rejections retry. No raw bodies or credentials enter diagnostics.
export async function requestWithRetry({fetchImpl, endpoint, init, provider, onRetry = () => {}, sleep = delay, random = Math.random}) {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      init.signal?.throwIfAborted();
      response = await fetchImpl(endpoint,init);
    } catch {throw new ProviderError('Live AI request failed, was canceled, or timed out. No fallback content was generated.', 'NETWORK_ERROR');}
    if (response.ok) return {response,attempts:attempt+1};
    const error = await responseError(response,provider);
    const waitMs = Math.max(2000*2**attempt,(error.details?.retryAfterSeconds || 0)*1000) + Math.floor(random()*250);
    if (error.code !== 'RATE_LIMITED' || attempt >= 2 || waited+waitMs > 30000 || init.signal?.aborted) throw error;
    await onRetry({attempt:attempt+1,waitSeconds:Math.ceil(waitMs/1000)});
    try {await sleep(waitMs,undefined,{signal:init.signal});}
    catch {throw new ProviderError('Live AI retry was canceled or timed out. No fallback content was generated.', 'NETWORK_ERROR');}
    waited += waitMs;
  }
}
