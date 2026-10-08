import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validSelection, catalogModel} from './model-catalog.mjs';

export class SettingsError extends Error {
  constructor(message, status = 409) {super(message); this.status = status;}
}

export function ignoredModelOverrides(env = process.env) {
  return ['CAMPAIGN_CONTROL_AI_PROVIDER','LAUNCH_AI_PROVIDER','OPENAI_MODEL','ANTHROPIC_MODEL'].filter(name => Object.hasOwn(env,name));
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported configuration fields. Keep credentials in environment variables, not configuration files.');
}

export async function loadConfiguration({root, args = [], env = process.env, cwd = process.cwd()}) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--campaign'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: npm start [-- --config file.json] [--campaign /path/to/campaign]');
    options[args[i]] = args[i + 1];
  }
  const configPath = options['--config'] ? path.resolve(cwd, options['--config']) : path.join(root, 'campaign-control.config.json');
  let config;
  try {
    const raw = await fs.readFile(configPath);
    if (raw.length > 16384) throw new Error();
    config = JSON.parse(raw.toString('utf8'));
  } catch { throw new Error('Could not read a valid Campaign Control configuration file.'); }
  fields(config, ['schemaVersion', 'campaign', 'ai', 'server']);
  if (config.schemaVersion !== 1) throw new Error('Unsupported configuration schema version.');
  fields(config.campaign, ['type', 'path', 'folderId', 'brand']);
  fields(config.ai, ['provider', 'model']);
  fields(config.server, ['port']);
  const override = options['--campaign'] || env.CAMPAIGN_CONTROL_CAMPAIGN_DIR || env.LAUNCH_CAMPAIGN_DIR;
  if (!override && config.campaign.type === 'google-drive') throw new Error('Google Drive is a planned connector, not implemented. Select a local campaign folder to run this version.');
  if (!override && config.campaign.type !== 'local') throw new Error('Unsupported campaign connector.');
  const requested = override || config.campaign.path;
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw new Error('Configure a local campaign folder.');
  const campaignDir = path.resolve(override ? cwd : path.dirname(configPath), requested);
  const sameCampaign = config.campaign.type === 'local' && typeof config.campaign.path === 'string' && campaignDir === path.resolve(path.dirname(configPath), config.campaign.path);
  if (config.campaign.brand != null && (typeof config.campaign.brand !== 'string' || !config.campaign.brand.trim() || config.campaign.brand.includes('\0'))) throw new Error('Provide a company brand identity path or omit it for Campaign Control defaults.');
  // External campaign overrides must not inherit the sample company's identity.
  const brandPath = sameCampaign && config.campaign.brand ? path.resolve(path.dirname(configPath), config.campaign.brand) : null;
  const provider = config.ai.provider;
  if (!['openai', 'anthropic'].includes(provider)) throw new Error('Select openai or anthropic as the AI provider.');
  const model = config.ai.model;
  if (!validSelection({provider,model})) throw new Error('Provide a supported model identifier for the selected provider.');
  const port = Number(env.PORT || config.server.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
  return {campaignDir, brandPath, provider, model, port, configPath, ignoredModelOverrides:ignoredModelOverrides(env)};
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value,'provider') || !Object.hasOwn(value,'model') || !catalogModel(value)) {
    throw new SettingsError('Select a provider and model from the supported choices. No other settings or credentials are accepted.',400);
  }
  return {provider:value.provider,model:value.model};
}

export async function saveAISettings(configPath, selection, {io = fs} = {}) {
  const next = validateSettings(selection);
  let temporary;
  try {
    // Follow an operator's config symlink rather than replacing it.
    const target = await io.realpath(configPath);
    const stat = await io.stat(target);
    if (!stat.isFile() || stat.size > 16384) throw new Error();
    const before = await io.readFile(target);
    const config = JSON.parse(before.toString('utf8'));
    if (config.schemaVersion !== 1 || !config.ai || typeof config.ai !== 'object' || Array.isArray(config.ai)) throw new Error();
    const bytes = JSON.stringify({...config,ai:{...config.ai,...next}},null,2) + '\n';
    if (Buffer.byteLength(bytes) > 16384) throw new Error();
    temporary = `${target}.${randomUUID()}.tmp`;
    await io.writeFile(temporary,bytes,{flag:'wx',mode:stat.mode & 0o777});
    if (!(await io.readFile(target)).equals(before)) throw new SettingsError('Configuration changed while saving. Refresh settings and try again.');
    await io.rename(temporary,target);
    temporary = null;
    return next;
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    throw new SettingsError('AI settings could not be saved. The previous selection is unchanged.',500);
  } finally {
    if (temporary) await io.unlink(temporary).catch(() => {});
  }
}
