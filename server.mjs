import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream, watch} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {CampaignEngine, WorkflowError, containedFile} from './lib/engine.mjs';
import {AISettings} from './lib/ai-settings.mjs';
import {renderAsset} from './lib/render.mjs';
import {BRAND, brandCSS, brandLogoSVG, loadBrand, brandHash} from './lib/brand.mjs';
import {profoundStatus, fetchCitationEvidence, ProfoundError} from './lib/profound.mjs';
import {loadConfiguration, SettingsError} from './lib/config.mjs';
import {LaunchManager} from './lib/launch-manager.mjs';
import {GoogleOAuth, GoogleDriveError, GOOGLE_DRIVE_READONLY_SCOPE} from './lib/google-drive.mjs';
import {applicationDataDirectory, DEFAULT_WORKSPACE_ID, DEFAULT_LOCAL_LAUNCH_ID} from './lib/workspaces.mjs';

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

export async function createApplication({root = ROOT, campaignDir, brandPath = null, engine: suppliedEngine, config, aiSettings: suppliedSettings,
  dataDirectory = applicationDataDirectory(), launchManager: suppliedManager, googleOptions = {}, env = process.env} = {}) {
  if (!campaignDir && !suppliedEngine && !suppliedManager) throw new Error('Select a local campaign folder.');
  // The explicit single-engine injection is retained for existing isolated engine/HTTP tests.
  // A real application always uses identity-scoped routes, never a global selected launch.
  const legacyMode = Boolean(suppliedEngine);
  const aiSettings = suppliedSettings || suppliedEngine?.aiSettings || (suppliedManager?.aiSettings) || (!suppliedEngine ? new AISettings({config:config || await loadConfiguration({root}),env,workspaceId:DEFAULT_WORKSPACE_ID}) : null);
  const manager = legacyMode ? null : suppliedManager || new LaunchManager({root,config,dataDirectory,campaignDir,brandPath,aiSettings,env,driveOptions:googleOptions});
  if (manager) await manager.initialize();
  const engine = suppliedEngine || await manager.engine(DEFAULT_LOCAL_LAUNCH_ID);
  if (legacyMode) await engine.initialize();
  const defaultBrand = await loadBrand(brandPath);
  const oauth = manager ? new GoogleOAuth({registry:manager.registry,...googleOptions}) : null;
  const brands = new Map();
  const brandFor = async selected => {
    if (!manager || selected.launchId === DEFAULT_LOCAL_LAUNCH_ID) return defaultBrand;
    if (!brands.has(selected.launchId)) {
      const file=path.join(selected.campaignDir,'brand/identity.json');
      brands.set(selected.launchId,await loadBrand(await fs.access(file).then(()=>file,()=>null)));
    }
    return brands.get(selected.launchId);
  };
  const csrfToken = randomBytes(32).toString('hex');
  const evidence = new Map();
  const state = async selected => {
    const brand = await brandFor(selected);
    const launch = manager?.registry.launch(selected.launchId);
    return {...selected.state(),aiSettings:aiSettings?.state() || null,versionProvider:aiSettings?.versionStatus(selected.run) || null,
      globalBusy:Boolean(manager?.lock),processingLock:manager?.lock ? {launchId:manager.lock.launchId,kind:manager.lock.kind,startedAt:manager.lock.startedAt} : null,
      launch:launch ? {id:launch.id,type:launch.type,status:launch.status,label:launch.label,lastSuccessfulRefreshAt:launch.lastSuccessfulRefreshAt || null} : null,
      capabilities:{aiSettings:Boolean(aiSettings),assetRevision:true,assetResolution:true,demoReset:selected.allowDemoReset,
        workspaceReset:launch?.type==='google-drive' || selected.allowDemoReset,demoScopeDefault:legacyMode ? selected.allowDemoReset : selected.isSampleCampaign},
      branding:{company:brand.company.name,custom:brand!==BRAND},csrfToken,profound:{...profoundStatus(),evidence:evidence.get(selected.launchId) || null}};
  };
  const chooser = () => ({workspace:{id:DEFAULT_WORKSPACE_ID,name:manager.registry.workspace().name},launches:manager.list(),csrfToken,
    aiSettings:aiSettings?.state() || null,provider:aiSettings?.providerStatus() || null,processingLock:manager.lock ? {launchId:manager.lock.launchId,kind:manager.lock.kind} : null,
    google:{configured:oauth.configured(),scope:GOOGLE_DRIVE_READONLY_SCOPE,scopeDisclosure:'Google consent permits reading all Drive files available to your account. Campaign Control only reads within the campaign root you select.',
      connections:(manager.registry.data.connections || []).map(item=>({id:item.id,workspaceId:item.workspaceId}))}});
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
      const url = new URL(request.url,`http://${request.headers.host}`);
      const callback = manager && url.pathname === '/oauth/google/callback';
      const origin = request.headers.origin;
      if (origin && ![...hosts].some(host => origin === `http://${host}`)) throw new WorkflowError('Cross-site requests are not allowed.',403);
      if (!callback && request.headers['sec-fetch-site'] === 'cross-site') throw new WorkflowError('Cross-site requests are not allowed.',403);
      let pathname = decodeURIComponent(url.pathname);
      if (!['GET','HEAD','POST'].includes(request.method)) throw new WorkflowError('Method is not supported.',405);
      if (callback) {
        if (request.method!=='GET' || url.origin!==new URL(oauth.redirectUri).origin || ['state','code','error'].some(key=>url.searchParams.getAll(key).length>1)) throw new WorkflowError('Invalid Google callback.',403);
        const browserNonce=/(?:^|;\s*)cc-oauth=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || '')?.[1];
        const connectionId=await oauth.callback({state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error'),browserNonce});
        response.writeHead(303,{'Location':`/?googleConnection=${encodeURIComponent(connectionId)}`,'Set-Cookie':'cc-oauth=; HttpOnly; SameSite=Lax; Path=/oauth/google/callback; Max-Age=0'});
        response.end();return;
      }
      let selected = engine, selectedLaunchId = null;
      const scoped = /^\/api\/workspaces\/([A-Za-z0-9_-]+)\/launches\/([A-Za-z0-9_-]+)(\/.*)$/.exec(pathname);
      if (scoped) {
        if (!manager || scoped[1]!==DEFAULT_WORKSPACE_ID || manager.registry.launch(scoped[2])?.workspaceId!==scoped[1]) throw new WorkflowError('Launch does not belong to this workspace.',404);
        selectedLaunchId=scoped[2];selected=await manager.engine(selectedLaunchId);
        pathname=scoped[3].startsWith('/artifacts/') || scoped[3].startsWith('/brand') ? scoped[3] : '/api'+scoped[3];
      } else if (manager && pathname.startsWith('/api/workspaces/')) {
        const workspaceRoute=/^\/api\/workspaces\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
        if (!workspaceRoute || workspaceRoute[1]!==DEFAULT_WORKSPACE_ID) throw new WorkflowError('Unknown workspace.',404);
        pathname=workspaceRoute[2] ? '/api'+workspaceRoute[2] : '/api/chooser';
      } else if (manager && pathname.startsWith('/api/') &&
        !['/api/health','/api/state','/api/chooser','/api/settings/ai'].includes(pathname) &&
        !pathname.startsWith('/api/jobs/') && !pathname.startsWith('/api/google/')) {
        // Every remaining operation is launch-scoped; an unscoped path has no implicit selected launch.
        throw new WorkflowError('Choose a workspace and launch for this operation.',404);
      }
      const operation = (kind,work) => manager ? manager.withOperation(selectedLaunchId || DEFAULT_LOCAL_LAUNCH_ID,kind,work) : work();
      if (request.method === 'POST') {
        const actual = Buffer.from(request.headers['x-campaign-control-token'] || ''); const expected = Buffer.from(csrfToken);
        if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw new WorkflowError('Refresh the workbench before making changes.',403);
        const input = await body(request);
        if (manager && input.launchId && input.launchId!==selectedLaunchId) throw new WorkflowError('Request targets the wrong launch.',409);
        if (pathname === '/api/google/authorize' && manager) {
          const browserNonce=randomBytes(32).toString('base64url');
          const authorizationUrl=oauth.start({browserNonce});
          response.setHeader('Set-Cookie',`cc-oauth=${browserNonce}; HttpOnly; SameSite=Lax; Path=/oauth/google/callback; Max-Age=600`);
          return json(response,200,{authorizationUrl});
        }
        if (pathname === '/api/google/launches' && manager) {
          if (typeof input.connectionId !== 'string' || !input.connectionId) throw new WorkflowError('Complete the Google authorization step before choosing a folder.',400);
          const job=await manager.startJob(null,'Drive connection',running=>manager.addDriveLaunch({folderId:input.folderId,connectionId:input.connectionId,onProgress:progress=>{running.progress=progress;}}));
          return json(response,202,job);
        }
        // Drive-only operations refuse a non-Drive launch synchronously; a job that can only fail is never queued.
        if ((pathname === '/api/connection' || pathname === '/api/refresh') && manager && selectedLaunchId && manager.registry.launch(selectedLaunchId)?.type !== 'google-drive') throw new WorkflowError('This launch is not a Google Drive launch.',404);
        if (pathname === '/api/connection' && manager && selectedLaunchId) return json(response,202,await manager.startJob(selectedLaunchId,'Drive reconnection',running=>manager.refreshDriveLaunch(selectedLaunchId,{connectionId:input.connectionId,onProgress:progress=>{running.progress=progress;}})));
        if (pathname === '/api/refresh' && manager && selectedLaunchId) return json(response,202,await manager.startJob(selectedLaunchId,'Drive refresh',running=>manager.refreshDriveLaunch(selectedLaunchId,{onProgress:progress=>{running.progress=progress;}})));
        if (pathname === '/api/disconnect' && manager && selectedLaunchId) {
          await operation('Drive disconnect',()=>manager.disconnectDriveLaunch(selectedLaunchId,id=>oauth.disconnect(id)));
          return json(response,200,chooser());
        }
        if (pathname === '/api/settings/ai') {if (!aiSettings) throw new WorkflowError('Restart Campaign Control to enable AI settings.',503); await operation('settings save',()=>aiSettings.save(selected,input)); return json(response,200,selectedLaunchId || legacyMode ? await state(selected) : chooser());}
        if (manager && !selectedLaunchId) throw new WorkflowError('This operation requires a launch identity.',404);
        if (pathname === '/api/campaign/open') {if (!manager?.lock) await operation('inventory',()=>selected.openCampaign()); return json(response,200,await state(selected));}
        if (pathname === '/api/inspect') {await operation('inspection',()=>selected.inspect()); return json(response,200,await state(selected));}
        if (pathname === '/api/revisions') {await operation('new revision',()=>selected.newRevision()); return json(response,200,await state(selected));}
        if (pathname === '/api/demo/reset') {const reset=await operation('workspace reset',()=>manager ? manager.resetLaunch(selectedLaunchId,input) : selected.resetDemo(input)); return json(response,200,{...await state(selected),reset});}
        if (pathname === '/api/runs') {
          const start=()=>typeof input.brief === 'string' ? selected.startBrief(input) : selected.start(input.change);
          return json(response,202,manager ? manager.startOperation(selectedLaunchId,'campaign update',start) : start());
        }
        if (pathname === '/api/profound/evidence') {const result=await fetchCitationEvidence(input);evidence.set(selected.launchId,result);return json(response,200,{profound:{...profoundStatus(),evidence:result}});}
        const edit = /^\/api\/runs\/([A-Za-z0-9-]+)\/assets\/([A-Za-z0-9_.-]+)$/.exec(pathname);
        if (edit) {await operation('candidate edit',()=>selected.edit(edit[1],edit[2],input.markdown)); return json(response,200,await state(selected));}
        const revision = /^\/api\/runs\/([A-Za-z0-9-]+)\/assets\/([A-Za-z0-9_.-]+)\/revision$/.exec(pathname);
        if (revision) {await operation('asset revision',()=>selected.requestRevision(revision[1],revision[2],input)); return json(response,200,await state(selected));}
        const resolution = /^\/api\/runs\/([A-Za-z0-9-]+)\/assets\/([A-Za-z0-9_.-]+)\/resolution$/.exec(pathname);
        if (resolution) {await operation('asset resolution',()=>selected.resolveAsset(resolution[1],resolution[2],input)); return json(response,200,await state(selected));}
        const review = /^\/api\/runs\/([A-Za-z0-9-]+)\/reviews\/([A-Za-z0-9_.-]+)$/.exec(pathname);
        if (review) {await operation('human review',()=>selected.reviewAsset(review[1],review[2],input)); return json(response,200,await state(selected));}
        const action = /^\/api\/runs\/([A-Za-z0-9-]+)\/(check|decision|package)$/.exec(pathname);
        if (action) {
          if (action[2] === 'check') await operation('checks',()=>selected.recheck(action[1]));
          if (action[2] === 'decision') await operation('human decision',()=>selected.decide(action[1],input));
          if (action[2] === 'package') return json(response,200,await operation('packaging',()=>selected.package(action[1],input.candidateHash)));
          return json(response,200,await state(selected));
        }
        throw new WorkflowError('Unknown operation.',404);
      }
      if (manager && (pathname==='/api/chooser' || pathname==='/api/state' && !selectedLaunchId)) return json(response,200,chooser());
      if (manager && pathname.startsWith('/api/jobs/')) {
        const id=pathname.slice('/api/jobs/'.length);
        if (selectedLaunchId) return json(response,200,await manager.job(selectedLaunchId,id));
        const job=manager.jobs.get(id);
        if (!job || job.workspaceId!==DEFAULT_WORKSPACE_ID || job.launchId!==null) throw new WorkflowError('Unknown workspace connection job.',404);
        return json(response,200,job);
      }
      if (pathname === '/api/state') {await selected.refreshReadiness(); return json(response,200,await state(selected));}
      if (pathname === '/api/health') return json(response,200,{ok:true,service:'campaign-control'});
      if (['/brand.css','/brand/logo.svg','/brand/default.css','/brand/default-logo.svg'].includes(pathname)) {
        const css = pathname.endsWith('.css');
        const selectedBrand = pathname.includes('default') ? BRAND : await brandFor(selected);
        response.writeHead(200, {'Content-Type': css ? MIME['.css'] : MIME['.svg']});
        response.end(request.method === 'HEAD' ? undefined : css ? brandCSS(selectedBrand) : brandLogoSVG(selectedBrand));
        return;
      }
      const assetMatch = /^\/api\/assets\/([A-Za-z0-9_.-]+)$/.exec(pathname);
      if (assetMatch) {const asset = selected.state().assets.find(a => a.id === assetMatch[1]); if (!asset) throw new WorkflowError('Unknown asset.',404); return json(response,200,asset);}
      if (pathname.startsWith('/artifacts/')) {
        const relative = pathname.slice('/artifacts/'.length);
        if (manager && !selectedLaunchId) throw new WorkflowError('Artifact requires a launch identity.',404);
        const files = selected.assets.flatMap(asset => [...(asset.sourceFiles || []),...(asset.candidateFiles || [])]);
        const file=files.find(file=>file.artifactPath===relative);
        const download = selected.readyRelease?.archivePath === relative;
        if (!download && !file) throw new WorkflowError('Artifact is not part of this launch’s current review.',404);
        if (download) {
          await selected.refreshReadiness();
          if (!selected.readyRelease) throw new WorkflowError('Approval is no longer current. Review again before downloading.');
        }
        return await serveFile(request,response,await containedFile(file?.origin==='original' ? selected.campaignDir : selected.artifactDir,relative),{artifact:true,download});
      }
      const webFile = {'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'}[pathname];
      if (!webFile) throw new WorkflowError('Not found.',404);
      await serveFile(request,response,await containedFile(path.join(root,'web'),webFile));
    } catch (error) {
      if (response.headersSent) {response.destroy(); return;}
      const expected = error instanceof WorkflowError || error instanceof ProfoundError || error instanceof SettingsError || error instanceof GoogleDriveError;
      const status = error.status || (expected ? 409 : error.code === 'ENOENT' ? 404 : 500);
      json(response,status,{error:expected ? error.message : status === 404 ? 'File not found.' : 'The operation failed. Existing inputs were preserved; check the current run for details.'});
    }
  });
  server.requestTimeout = 300000; server.headersTimeout = 15000;
  // Any external edit clears the current-ready marker after full integrity checks.
  let timer;
  const watcher = watch(engine.campaignDir, {recursive: true}, (_event, filename) => {
    if (filename?.toString().startsWith('.campaign-control/')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {void engine.refreshReadiness().catch(() => {});}, 250);
    timer.unref();
  });
  watcher.unref();
  server.on('close', () => {clearTimeout(timer); watcher.close();});
  return {server,engine,manager,oauth};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadConfiguration({root: ROOT, args: process.argv.slice(2)});
  const {port} = config;
  if (config.ignoredModelOverrides.length) process.stdout.write(`Model environment overrides ignored: ${config.ignoredModelOverrides.join(', ')}. Choose the model in the app.\n`);
  const {server} = await createApplication({campaignDir: config.campaignDir, brandPath: config.brandPath,config});
  server.listen(port,'127.0.0.1',() => process.stdout.write(`Campaign Control is ready at http://127.0.0.1:${port}\n`));
}
