import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream, watch} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {LaunchEngine, WorkflowError, containedFile} from './lib/engine.mjs';
import {createProvider} from './lib/provider.mjs';
import {renderAsset} from './lib/render.mjs';
import {BRAND, brandCSS, brandLogoSVG, loadBrand, brandHash} from './lib/brand.mjs';
import {profoundStatus, fetchCitationEvidence, ProfoundError} from './lib/profound.mjs';
import {loadConfiguration, applyModelConfiguration} from './lib/config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.pdf':'application/pdf','.mp4':'video/mp4','.vtt':'text/vtt; charset=utf-8','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8','.gz':'application/gzip'};

function json(response, status, body) {
  response.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  response.end(JSON.stringify(body));
}

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new WorkflowError('Send a JSON request.',415);
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 400000) throw new WorkflowError('Request is too large.',413);
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new WorkflowError('Request must contain a JSON object.',400); }
}

async function serveFile(request, response, file, {artifact = false, download = false} = {}) {
  const stat = await fs.stat(file); const mime = MIME[path.extname(file)] || 'application/octet-stream';
  response.setHeader('Content-Type',mime);
  // Candidate HTML and SVG are untrusted campaign content, isolated from the workbench.
  if (artifact) response.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
  if (download) response.setHeader('Content-Disposition',`attachment; filename="${path.basename(file).replace(/[^A-Za-z0-9_.-]/g,'_')}"`);
  response.setHeader('Accept-Ranges','bytes');
  let start = 0, end = stat.size - 1, status = 200;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match || (!match[1] && !match[2])) {response.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); response.end(); return;}
    if (!match[1]) start = Math.max(0,stat.size - Number(match[2]));
    else {start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]),end);}
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {response.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); response.end(); return;}
    status = 206; response.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);
  }
  response.setHeader('Content-Length',Math.max(0,end - start + 1));
  response.writeHead(status);
  if (request.method === 'HEAD' || !stat.size) {response.end(); return;}
  await new Promise((resolve,reject) => {
    const stream = createReadStream(file,{start,end});
    stream.on('error',reject); response.on('close',() => {stream.destroy(); resolve();}); response.on('finish',resolve); stream.pipe(response);
  });
}

export async function createApplication({root = ROOT, campaignDir, brandPath = null, artifactDir = campaignDir, engine: suppliedEngine} = {}) {
  if (!campaignDir && !suppliedEngine) throw new Error('Select a campaign folder with --campaign /path/to/campaign or LAUNCH_CAMPAIGN_DIR.');
  const brand = await loadBrand(brandPath);
  const engine = suppliedEngine || new LaunchEngine({root,campaignDir,artifactDir,provider:createProvider(),renderAsset: input => renderAsset({...input,brand}),brandIdentitySha256:brandHash(brand)});
  if (!suppliedEngine) engine.allowDemoReset = await fs.realpath(campaignDir) === await fs.realpath(path.join(ROOT,'fictitious-ai/campaigns/pro500')) && path.resolve(artifactDir) === path.resolve(campaignDir);
  await engine.initialize();
  const csrfToken = randomBytes(32).toString('hex');
  let profoundEvidence = null;
  const state = () => ({...engine.state(),capabilities:{assetRevision:true,assetResolution:true,demoReset:engine.allowDemoReset},branding:{company:brand.company.name,custom:Boolean(brandPath)},csrfToken,profound:{...profoundStatus(),evidence:profoundEvidence}});
  const server = http.createServer(async (request,response) => {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Frame-Options','SAMEORIGIN');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const expectedPort = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${expectedPort}`,`localhost:${expectedPort}`,`[::1]:${expectedPort}`]);
      if (!hosts.has(request.headers.host)) throw new WorkflowError('This workbench accepts local requests only.',403);
      const origin = request.headers.origin;
      if (origin && ![...hosts].some(host => origin === `http://${host}`)) throw new WorkflowError('Cross-site requests are not allowed.',403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new WorkflowError('Cross-site requests are not allowed.',403);
      const url = new URL(request.url,`http://${request.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      if (!['GET','HEAD','POST'].includes(request.method)) throw new WorkflowError('Method is not supported.',405);
      if (request.method === 'POST') {
        const actual = Buffer.from(request.headers['x-launch-control-token'] || ''); const expected = Buffer.from(csrfToken);
        if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw new WorkflowError('Refresh the workbench before making changes.',403);
        const input = await body(request);
        if (pathname === '/api/campaign/open') {await engine.openCampaign(); return json(response,200,state());}
        if (pathname === '/api/inspect') {await engine.inspect(); return json(response,200,state());}
        if (pathname === '/api/revisions') {await engine.newRevision(); return json(response,200,state());}
        if (pathname === '/api/demo/reset') {const reset=await engine.resetDemo(input); return json(response,200,{...state(),reset});}
        if (pathname === '/api/runs') return json(response,202,typeof input.brief === 'string' ? engine.startBrief(input) : engine.start(input.change));
        if (pathname === '/api/profound/evidence') {profoundEvidence = await fetchCitationEvidence(input); return json(response,200,{profound:{...profoundStatus(),evidence:profoundEvidence}});}
        const edit = /^\/api\/runs\/([A-Za-z0-9-]+)\/assets\/([A-Za-z0-9_.-]+)$/.exec(pathname);
        if (edit) {await engine.edit(edit[1],edit[2],input.markdown); return json(response,200,state());}
        const revision = /^\/api\/runs\/([A-Za-z0-9-]+)\/assets\/([A-Za-z0-9_.-]+)\/revision$/.exec(pathname);
        if (revision) {await engine.requestRevision(revision[1],revision[2],input); return json(response,200,state());}
        const resolution = /^\/api\/runs\/([A-Za-z0-9-]+)\/assets\/([A-Za-z0-9_.-]+)\/resolution$/.exec(pathname);
        if (resolution) {await engine.resolveAsset(resolution[1],resolution[2],input); return json(response,200,state());}
        const review = /^\/api\/runs\/([A-Za-z0-9-]+)\/reviews\/([A-Za-z0-9_.-]+)$/.exec(pathname);
        if (review) {await engine.reviewAsset(review[1],review[2],input); return json(response,200,state());}
        const action = /^\/api\/runs\/([A-Za-z0-9-]+)\/(check|decision|package)$/.exec(pathname);
        if (action) {
          if (action[2] === 'check') await engine.recheck(action[1]);
          if (action[2] === 'decision') await engine.decide(action[1],input);
          if (action[2] === 'package') return json(response,200,await engine.package(action[1],input.candidateHash));
          return json(response,200,state());
        }
        throw new WorkflowError('Unknown operation.',404);
      }
      if (pathname === '/api/state') {await engine.refreshReadiness(); return json(response,200,state());}
      if (pathname === '/api/health') return json(response,200,{ok:true,service:'launch-control'});
      if (['/brand.css','/brand/logo.svg','/brand/default.css','/brand/default-logo.svg'].includes(pathname)) {
        const css = pathname.endsWith('.css');
        const selectedBrand = pathname.includes('default') ? BRAND : brand;
        response.writeHead(200, {'Content-Type': css ? MIME['.css'] : MIME['.svg']});
        response.end(request.method === 'HEAD' ? undefined : css ? brandCSS(selectedBrand) : brandLogoSVG(selectedBrand));
        return;
      }
      const assetMatch = /^\/api\/assets\/([A-Za-z0-9_.-]+)$/.exec(pathname);
      if (assetMatch) {const asset = engine.assets.find(a => a.id === assetMatch[1]); if (!asset) throw new WorkflowError('Unknown asset.',404); return json(response,200,asset);}
      if (pathname.startsWith('/artifacts/')) {
        const relative = pathname.slice('/artifacts/'.length);
        const files = engine.assets.flatMap(asset => [...(asset.sourceFiles || []),...(asset.candidateFiles || [])]);
        const download = engine.readyRelease?.downloadUrl === pathname;
        if (!download && !files.some(file => file.artifactPath === relative)) throw new WorkflowError('Artifact is not part of the current review.',404);
        if (download) {
          await engine.refreshReadiness();
          if (!engine.readyRelease) throw new WorkflowError('Approval is no longer current. Review again before downloading.');
        }
        return await serveFile(request,response,await containedFile(engine.artifactDir,relative),{artifact:true,download});
      }
      const webFile = {'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'}[pathname];
      if (!webFile) throw new WorkflowError('Not found.',404);
      await serveFile(request,response,await containedFile(path.join(root,'web'),webFile));
    } catch (error) {
      if (response.headersSent) {response.destroy(); return;}
      const expected = error instanceof WorkflowError || error instanceof ProfoundError;
      const status = error.status || (expected ? 409 : error.code === 'ENOENT' ? 404 : 500);
      json(response,status,{error:expected ? error.message : status === 404 ? 'File not found.' : 'The operation failed. Existing inputs were preserved; check the current run for details.'});
    }
  });
  server.requestTimeout = 300000; server.headersTimeout = 15000;
  // Any external edit clears the current-ready marker after full integrity checks.
  let timer;
  const watcher = watch(engine.campaignDir, {recursive: true}, (_event, filename) => {
    if (filename?.toString().startsWith('.launch-control/')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {void engine.refreshReadiness().catch(() => {});}, 250);
    timer.unref();
  });
  watcher.unref();
  server.on('close', () => {clearTimeout(timer); watcher.close();});
  return {server,engine};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadConfiguration({root: ROOT, args: process.argv.slice(2)});
  applyModelConfiguration(config);
  const {port} = config;
  const {server} = await createApplication({campaignDir: config.campaignDir, brandPath: config.brandPath});
  server.listen(port,'127.0.0.1',() => process.stdout.write(`Campaign Control is ready at http://127.0.0.1:${port}\n`));
}
