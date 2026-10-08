import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadConfiguration} from '../lib/config.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-control-config-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = {schemaVersion: 1, campaign: {type: 'local', path: './example/campaign'}, ai: {provider: 'openai', model: 'test-openai'}, server: {port: 8142}};
  const write = async value => fs.writeFile(path.join(root, 'campaign-control.config.json'), JSON.stringify(value));
  await write(config);
  return {root, config, write};
}

test('default configuration resolves relative to the package, independent of shell location', async t => {
  const {root} = await fixture(t);
  const value = await loadConfiguration({root, cwd: '/', env: {}});
  assert.equal(value.campaignDir, path.join(root, 'example/campaign'));
  assert.equal(value.provider, 'openai'); assert.equal(value.model, 'test-openai'); assert.equal(value.port, 8142);
});

test('external config resolves campaign paths beside itself; CLI and environment overrides resolve from cwd', async t => {
  const {root, config} = await fixture(t);
  await fs.mkdir(path.join(root, 'external'));
  await fs.writeFile(path.join(root, 'external', 'custom.json'), JSON.stringify(config));
  const base = {root, cwd: root, env: {}, args: ['--config', 'external/custom.json']};
  assert.equal((await loadConfiguration(base)).campaignDir, path.join(root, 'external/example/campaign'));
  assert.equal((await loadConfiguration({...base, env: {CAMPAIGN_CONTROL_CAMPAIGN_DIR: './team'}})).campaignDir, path.join(root, 'team'));
  assert.equal((await loadConfiguration({...base, env: {CAMPAIGN_CONTROL_CAMPAIGN_DIR: './team'}, args: [...base.args, '--campaign', './chosen']})).campaignDir, path.join(root, 'chosen'));
  assert.equal((await loadConfiguration({...base, env: {LAUNCH_CAMPAIGN_DIR: './legacy'}})).campaignDir, path.join(root, 'legacy'));
});

test('saved selection ignores model overrides without mutating environment values', async t => {
  const {root} = await fixture(t);
  const env = {LAUNCH_AI_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'test-anthropic', OPENAI_MODEL: 'unused-openai', PORT: '8242'};
  const value = await loadConfiguration({root, env});
  assert.equal(value.provider, 'openai'); assert.equal(value.model, 'test-openai'); assert.equal(value.port, 8242);
  assert.deepEqual(value.ignoredModelOverrides,['LAUNCH_AI_PROVIDER','OPENAI_MODEL','ANTHROPIC_MODEL']);
  assert.ok(!JSON.stringify(value).includes('test-anthropic'));
  assert.equal(env.OPENAI_MODEL, 'unused-openai'); assert.equal(env.ANTHROPIC_MODEL, 'test-anthropic');
  const noticed = await loadConfiguration({root, env: {CAMPAIGN_CONTROL_AI_PROVIDER: 'anthropic'}});
  assert.deepEqual(noticed.ignoredModelOverrides, ['CAMPAIGN_CONTROL_AI_PROVIDER']);
  const saved = await loadConfiguration({root, env: {LAUNCH_AI_PROVIDER: 'anthropic'}});
  assert.equal(saved.model, 'test-openai');
});

test('Drive configuration fails honestly without attempting a connector; local override works', async t => {
  const {root, config, write} = await fixture(t);
  await write({...config, campaign: {type: 'google-drive', folderId: 'test-only'}});
  await assert.rejects(() => loadConfiguration({root, env: {}}), /planned connector, not implemented/);
  assert.equal((await loadConfiguration({root, cwd: root, env: {}, args: ['--campaign', './local']})).campaignDir, path.join(root, 'local'));
});

test('unknown fields, credential fields, invalid model identifiers, and ports fail without echoing values', async t => {
  const {root, config, write} = await fixture(t);
  const invalid = [
    {...config, apiKey: 'TEST_ONLY_SECRET_SENTINEL'},
    {...config, ai: {...config.ai, token: 'TEST_ONLY_SECRET_SENTINEL'}},
    {...config, ai: {...config.ai, model: 'invalid model'}},
    {...config, ai: {...config.ai, provider: 'unsupported'}},
    {...config, server: {port: 0}}, {...config, schemaVersion: 2}
  ];
  for (const data of invalid) {
    await write(data);
    await assert.rejects(() => loadConfiguration({root, env: {}}), error => !error.message.includes('TEST_ONLY_SECRET_SENTINEL'));
  }
});

test('bad CLI arguments and malformed configuration fail explicitly', async t => {
  const {root} = await fixture(t);
  for (const args of [['--campaign'], ['--unknown', 'value'], ['--campaign', 'one', '--campaign', 'two']]) {
    await assert.rejects(() => loadConfiguration({root, args, env: {}}), /Usage:/);
  }
  await fs.writeFile(path.join(root, 'campaign-control.config.json'), '{bad JSON');
  await assert.rejects(() => loadConfiguration({root, env: {}}), /Could not read/);
});

test('company branding follows the configured campaign and never leaks into an external override', async t => {
  const {root,config,write} = await fixture(t);
  assert.equal((await loadConfiguration({root,env:{}})).brandPath,null);
  config.campaign.brand = './company/brand/identity.json';
  await write(config);
  assert.equal((await loadConfiguration({root,env:{}})).brandPath,path.join(root,'company/brand/identity.json'));
  assert.equal((await loadConfiguration({root,cwd:root,env:{},args:['--campaign','./another-team']})).brandPath,null);
  assert.equal((await loadConfiguration({root,cwd:root,env:{LAUNCH_CAMPAIGN_DIR:'./another-team'}})).brandPath,null);
  config.campaign.brand = {apiKey:'TEST_ONLY_SENTINEL'};
  await write(config);
  await assert.rejects(() => loadConfiguration({root,env:{}}),/brand identity path/);
});
