// Explicit mappings verified against provider documentation, not inferred from display names.
export const CATALOG_VERSION = '2026-10-07.1';
export const VERIFIED_AT = '2026-10-07';
const openaiSource = id => `https://developers.openai.com/api/docs/models/${id}`;
const claudeSource = name => `https://platform.claude.com/docs/en/models/${name}/overview`;
export const MODELS = Object.freeze([
  {provider:'openai',model:'gpt-6.1-sol',name:'Sol',version:'GPT-6.1 Sol',description:'Balances capability and cost for complex work.',inputUSD:2,outputUSD:10,source:openaiSource('gpt-6.1-sol')},
  {provider:'openai',model:'gpt-6-astra',name:'Astra',version:'GPT-6 Astra',description:'OpenAI’s most capable model for demanding work; higher cost than Sol.',inputUSD:10,outputUSD:50,source:openaiSource('gpt-6-astra')},
  {provider:'openai',model:'gpt-6-luna',name:'Luna',version:'GPT-6 Luna',description:'Lower-cost OpenAI choice for focused, high-volume tasks.',inputUSD:0.1,outputUSD:0.5,source:openaiSource('gpt-6-luna')},
  {provider:'anthropic',model:'claude-opus-5-5',name:'Opus',version:'Claude Opus 5.5',description:'Anthropic’s recommended starting point for most workloads; lower cost than Fable.',inputUSD:4,outputUSD:20,source:claudeSource('opus-5-5')},
  {provider:'anthropic',model:'claude-fable-5-1',name:'Fable',version:'Claude Fable 5.1',description:'For demanding reasoning and long-horizon work; higher cost than Opus.',inputUSD:10,outputUSD:50,source:claudeSource('fable-5-1')},
  {provider:'anthropic',model:'claude-haiku-5-5',name:'Haiku',version:'Claude Haiku 5.5',description:'Lower-cost Anthropic choice; pricing increases above 100,000 input tokens.',inputUSD:0.1,outputUSD:0.5,source:claudeSource('haiku-5-5')},
].map(item => Object.freeze({...item,verifiedAt:VERIFIED_AT,concrete:true,structuredOutputs:true,endpoint:item.provider === 'openai' ? 'responses' : 'messages'})));

export function validSelection(value) {
  return value && ['openai','anthropic'].includes(value.provider) && typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value.model);
}
export function catalogModel(value, models = MODELS) {
  return models.find(item => item.provider === value?.provider && item.model === value?.model);
}
export function resolveSelection(value, catalog = modelCatalog()) {
  const entry = catalogModel(value,catalog.models);
  if (!entry) throw new Error('Choose a supported model in AI settings before starting a new update.');
  return {provider:entry.provider,model:entry.model,catalogVersion:catalog.version};
}
export function modelCatalog() {
  return {version:CATALOG_VERSION,verifiedAt:VERIFIED_AT,models:MODELS,
    requirements:'Responses or Messages API with strict structured JSON output. Account access is checked only by an actual run.',
    maintenance:'Mappings are reviewed against official documentation and updated through tested app releases, not automatically. Existing saved selections and runs are never rewritten.',
    pricingNote:'USD per million standard uncached input / output tokens, checked on the verification date, not a run-cost estimate. OpenAI long-context, regional and service-tier rates can differ. Haiku costs $0.50 / $2.50 above 100,000 input tokens. Check official pricing before running.',
    compatibilitySources:['https://platform.claude.com/docs/en/build-with-claude/structured-outputs','https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions']};
}

// Legacy aliases are not guessed. Only documented pinned IDs can continue without migration.
export function concreteLegacySelection(run) {
  if (run?.aiSelection) return validSelection(run.aiSelection) ? {provider:run.aiSelection.provider,model:run.aiSelection.model} : null;
  const records = run?.requests || [];
  const candidate = validSelection(run?.provider) ? run.provider : records[0];
  if (!validSelection(candidate)) return null;
  const pinned = catalogModel(candidate) || (candidate.provider === 'anthropic' && (
    candidate.model === 'claude-sonnet-4-6' || /^claude-(?:sonnet|opus|haiku)-\d+-\d+-\d{8}$/.test(candidate.model)));
  if (!pinned || records.some(record => record.provider !== candidate.provider || record.model !== candidate.model)) return null;
  return {provider:candidate.provider,model:candidate.model};
}
