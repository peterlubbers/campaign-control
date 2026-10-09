// Local walkthrough harness — demo only.
//
// Runs the real application (real HTTP routes, real launch manager, real Drive client) against a
// stand-in for Google, so the Drive flow can be exercised in a browser with no credentials, no
// Google account, and no network access. The AI provider is a synthetic stand-in too, so an update
// can run end to end without API keys and without the macOS renderer.
//
//   node scripts/demo-fake-google.mjs [--fresh] [--port 8142] [--fake-port 8143]
//
// Nothing here is shipped behavior: the application, the tests, and the docs never load this file.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../server.mjs';
import {LaunchManager} from '../lib/launch-manager.mjs';
import {fakeDriveFromCampaign} from '../test/helpers/fake-drive.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLED = path.join(ROOT, 'fictitious-ai/campaigns/pro500');
const BRAND = path.join(ROOT, 'fictitious-ai/brand/identity.json');
const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const APP_PORT = flag('port', 8142);
const FAKE_PORT = flag('fake-port', 8143);
const DEMO_ROOT = path.resolve(process.env.DEMO_ROOT || path.join(os.tmpdir(), 'campaign-control-demo'));
const MODEL = {provider:'openai', model:'gpt-6.1-sol'};

// Candidate copy for the stand-in model: mentions only the new facts, so the literal checks pass.
const demoCopy = (prefix, title) => `${prefix}${title.replaceAll('Pro500', 'Pro1000')}\n\nPro1000 is $1,000/month. Team sharing is no longer available, so an analysis stays with the person who created it.\n`;

// A stand-in model: reports the configured selection so nothing shows an unlisted-choice warning,
// while every answer is generated locally.
const syntheticProvider = () => ({
  providerStatus: () => ({...MODEL, configured:true, connected:false}),
  interpretBrief: async () => ({
    requests:[{kind:'demo-harness', detail:'Synthetic brief interpretation; no model call was made.'}],
    summary:'Pro500 becomes Pro1000 at $1,000/month, and team sharing is removed.',
    questions:[],
    change:{product:'Pro1000', monthlyPrice:1000, sharing:false, maxTeammates:0},
  }),
  proposeAssets: async ({assets}) => ({
    ...MODEL, usage:{}, requests:[],
    assets:assets.map(asset => ({
      id:asset.id, disposition:'changed',
      markdown:demoCopy('# ', asset.title),
      reason:'Synthetic candidate from the demo harness; no model call was made.', issues:[],
    })),
  }),
  auditAssets: async ({assets}) => ({requests:[], assets:assets.map(asset => ({id:asset.id, status:'pass', issues:[]}))}),
  reviseAsset: async ({assets}) => ({...MODEL, usage:{}, requests:[], assets:assets.map(asset => ({id:asset.id, disposition:'changed', markdown:demoCopy('# ', asset.title), reason:'Synthetic revision from the demo harness.', issues:[]}))}),
});
// Writes a plain-text preview for every asset, so the walkthrough needs no macOS toolchain.
const syntheticRender = async ({markdown, outputDir}) => {
  await fs.writeFile(path.join(outputDir, 'preview.txt'), markdown);
  return {files:[{path:'preview.txt', mime:'text/plain', role:'publishable-copy'}], primaryPath:'preview.txt', textContent:markdown, checks:[{name:'Demo harness renderer', status:'pass', message:'Synthetic preview bytes written; no real renderer ran.'}]};
};

async function prepareDemoCampaign() {
  if (process.argv.includes('--fresh')) await fs.rm(DEMO_ROOT, {recursive:true, force:true});
  const campaignDir = path.join(DEMO_ROOT, 'campaign');
  await fs.mkdir(DEMO_ROOT, {recursive:true, mode:0o700});
  await fs.rm(campaignDir, {recursive:true, force:true});
  await fs.cp(BUNDLED, campaignDir, {recursive:true});
  // Start from the original inventory: no earlier work, releases, or approval history.
  for (const leftover of ['working', 'releases', 'READY-TO-PUBLISH', '.campaign-control']) await fs.rm(path.join(campaignDir, leftover), {recursive:true, force:true});
  return campaignDir;
}

async function fakeGoogleServer(drive) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${FAKE_PORT}`);
    if (url.pathname === '/demo/touch') {
      // Walkthrough control: simulate someone editing a file in Drive, so drift is visible.
      const pathKey = url.searchParams.get('path') || 'campaign.json';
      drive.touch(pathKey);
      const entry = drive.entries.get(pathKey);
      response.writeHead(200, {'content-type':'application/json'});
      response.end(JSON.stringify({path:pathKey, version:entry?.version ?? null, modifiedTime:entry?.modifiedTime ?? null}));
      return;
    }
    if (url.pathname === '/authorize') {
      // Google's consent screen, minus the sign-in: return to the app with an authorization code.
      const target = new URL(url.searchParams.get('redirect_uri'));
      target.searchParams.set('code', 'good-code');
      target.searchParams.set('state', url.searchParams.get('state'));
      response.writeHead(303, {Location:target.toString()});
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    // Drive metadata and media normally reach FakeDrive directly through fetchImpl; a browser or a
    // stray request can still arrive here, so pass an absolute URL and never let one crash the demo.
    try {
      const result = await drive.respond(new URL(request.url, `http://127.0.0.1:${FAKE_PORT}`).toString(),
        {method:request.method, headers:request.headers, body:Buffer.concat(chunks).toString('utf8')});
      const bytes = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(bytes);
    } catch (error) {
      response.writeHead(500, {'content-type':'application/json'});
      response.end(JSON.stringify({error:'demo harness could not serve this request', detail:error.message}));
    }
  });
  await new Promise(resolve => server.listen(FAKE_PORT, '127.0.0.1', resolve));
  return server;
}

const drive = await fakeDriveFromCampaign(BUNDLED, {brandPath:BRAND});
const campaignDir = await prepareDemoCampaign();
const dataDirectory = path.join(DEMO_ROOT, 'data');
const driveOptions = {clientId:'demo-harness-client', clientSecret:'demo-harness-secret', driveApi:`http://127.0.0.1:${FAKE_PORT}/drive`, fetchImpl:drive.fetchImpl()};
const manager = new LaunchManager({root:ROOT, dataDirectory, campaignDir, brandPath:BRAND, provider:syntheticProvider(), renderAsset:syntheticRender, driveOptions});
const {server} = await createApplication({campaignDir, brandPath:BRAND, dataDirectory, launchManager:manager,
  googleOptions:{...driveOptions, redirectUri:`http://127.0.0.1:${APP_PORT}/oauth/google/callback`,
    authEndpoint:`http://127.0.0.1:${FAKE_PORT}/authorize`, tokenEndpoint:`http://127.0.0.1:${FAKE_PORT}/token`, revokeEndpoint:`http://127.0.0.1:${FAKE_PORT}/revoke`}});
const fakeGoogle = await fakeGoogleServer(drive);
await new Promise(resolve => server.listen(APP_PORT, '127.0.0.1', resolve));

process.stdout.write([
  '',
  'Campaign Control — local Drive walkthrough (demo harness)',
  '',
  '  App                 http://127.0.0.1:' + APP_PORT + '/',
  '  Stand-in for Google http://127.0.0.1:' + FAKE_PORT + '/  (consent, token, revoke, Drive API)',
  '  Drive folder ID     ' + drive.rootId + '   (paste this into the folder field)',
  '  Local campaign      ' + campaignDir,
  '  Private state       ' + dataDirectory,
  '',
  '  Everything is local: no Google account, no network egress, no paid model calls.',
  '  Press Ctrl+C to stop.',
  '',
].join('\n'));

const stop = () => {server.closeAllConnections?.(); fakeGoogle.closeAllConnections?.(); server.close(); fakeGoogle.close(); process.exit(0);};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
