import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {referencedCampaignFiles} from '../../lib/sample-fingerprint.mjs';

// A repeatable fake Google: token/revoke endpoints plus a Drive v3-compatible read model
// built from real files on disk. No network access happens at any point.
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const idFor = value => `f${createHash('sha256').update(value).digest('hex').slice(0,20)}`;

const MIME = {'.json':'application/json','.md':'text/markdown','.txt':'text/plain','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4','.vtt':'text/vtt','.html':'text/html'};

export class FakeDrive {
  constructor({files, pageSize = 1000, rootName = 'Pro500 campaign'}) {
    // files: Map<relativePath, Buffer|string>
    this.files = new Map([...files].map(([key, value]) => [key, Buffer.isBuffer(value) ? value : Buffer.from(value)]));
    this.pageSize = pageSize;
    this.rootName = rootName;
    // The root folder id must match what child entries derive for their parent reference.
    this.rootId = idFor('folder:');
    this.tokenRequests = [];
    this.revokes = [];
    this.failDownloads = new Map();   // path -> remaining failure count
    this.nativeOverrides = new Map(); // path -> mimeType (to simulate native Google documents)
    this.metadataOverrides = new Map();// path -> patch applied on every metadata read
    this.tokens = {refresh_token:'fake-refresh-token', access_token:'fake-access-token', expires_in:3600, token_type:'Bearer'};
    this.validAccessTokens = new Set(['fake-access-token','fake-access-token-2']);
    this.revoked = false;
    this.metadataReadCounts = new Map();
    this.onMetadata = null; // (pathKey, readCount) => metadata patch or null
    this.duplicates = [];   // {of, id}: same name and parent as the source entry
    this.rebuild();
  }

  rebuild() {
    this.entries = new Map();
    this.entries.set('', {id:this.rootId, name:this.rootName, mimeType:'application/vnd.google-apps.folder', parents:null, trashed:false, folder:true});
    for (const [relative, bytes] of this.files) {
      const parts = relative.split('/');
      for (let i = 1; i < parts.length; i++) {
        const folderPath = parts.slice(0, i).join('/');
        if (!this.entries.has(folderPath)) this.entries.set(folderPath, {id:idFor(`folder:${folderPath}`), name:parts[i-1], mimeType:'application/vnd.google-apps.folder', parents:[idFor(`folder:${parts.slice(0,i-1).join('/')}`)], trashed:false, folder:true});
      }
      const override = this.nativeOverrides.get(relative);
      this.entries.set(relative, {
        id:idFor(`file:${relative}`),
        name:parts.at(-1),
        mimeType:override || MIME[path.extname(relative)] || 'application/octet-stream',
        parents:[idFor(`folder:${parts.slice(0,-1).join('/')}`)],
        trashed:false,
        size:bytes.length,
        md5Checksum:md5(bytes),
        version:1,
        headRevisionId:'1',
        modifiedTime:'2025-01-01T00:00:00.000Z',
        shortcutDetails:null,
        webViewLink:`https://drive.google.com/file/d/${idFor(`file:${relative}`)}/view`,
      });
    }
    for (const duplicate of this.duplicates) {
      const source = this.entries.get(duplicate.of);
      if (!source) continue;
      this.entries.set(`duplicate:${duplicate.id}:${duplicate.of}`, {...source, id:duplicate.id, duplicateOf:duplicate.of});
    }
  }

  set(pathKey, value) {this.files.set(pathKey, Buffer.isBuffer(value) ? value : Buffer.from(value)); this.rebuild();}
  delete(pathKey) {this.files.delete(pathKey); this.rebuild();}
  // Turn an uploaded file into a native Google document or a Drive shortcut.
  markNative(pathKey, mimeType) {this.nativeOverrides.set(pathKey, mimeType); this.rebuild();}
  // Add a second Drive item with the same name and parent: the client must treat the path as ambiguous.
  addDuplicate(pathKey) {this.duplicates.push({of:pathKey, id:`d${createHash('sha256').update(`duplicate:${pathKey}:${this.duplicates.length}`).digest('hex').slice(0,20)}`}); this.rebuild();}
  // Mutate like a Drive edit: new content, bumped version and modifiedTime.
  touch(pathKey, value = this.files.get(pathKey)) {
    this.files.set(pathKey, Buffer.isBuffer(value) ? value : Buffer.from(value));
    this.rebuild();
    const entry = this.entries.get(pathKey);
    entry.version += 1;
    entry.headRevisionId = String(entry.version);
    entry.modifiedTime = '2025-06-01T00:00:00.000Z';
  }
  failDownload(pathKey, times = 1) {this.failDownloads.set(pathKey, times);}

  async respond(url, init = {}) {
    const parsed = new URL(url);
    const send = (body, {status = 200, headers = {}} = {}) => new Response(body, {status, headers});
    const authorized = () => {
      const header = init.headers?.Authorization || init.headers?.authorization;
      return this.validAccessTokens.has(/^Bearer\s+(.+)$/.exec(header || '')?.[1] || '');
    };
    if (parsed.pathname === '/token') {
      const fields = Object.fromEntries(new URLSearchParams(init.body instanceof URLSearchParams ? init.body : String(init.body || '')));
      this.tokenRequests.push(fields);
      if (fields.grant_type === 'authorization_code') {
        if (fields.code !== 'good-code') return send(JSON.stringify({error:'invalid_grant'}), {status:400});
        return send(JSON.stringify({...this.tokens, scope:this.tokens.scope || 'https://www.googleapis.com/auth/drive.readonly'}));
      }
      if (fields.grant_type === 'refresh_token') {
        if (this.revoked || fields.refresh_token !== this.tokens.refresh_token) return send(JSON.stringify({error:'invalid_grant'}), {status:400});
        return send(JSON.stringify({access_token:'fake-access-token-2', expires_in:3600, token_type:'Bearer'}));
      }
      return send(JSON.stringify({error:'unsupported_grant_type'}), {status:400});
    }
    if (parsed.pathname === '/revoke') {
      const fields = Object.fromEntries(new URLSearchParams(init.body instanceof URLSearchParams ? init.body : String(init.body || '')));
      this.revokes.push(fields);
      if (fields.token === this.tokens.refresh_token) {this.revoked = true; return send(null, {status:200});}
      return send(JSON.stringify({error:'invalid_token'}), {status:400});
    }
    if (parsed.pathname === '/drive/files') {
      if (!authorized()) return send(JSON.stringify({error:'invalid credentials'}), {status:401});
      const query = /'([^']+)' in parents and trashed = false/.exec(parsed.searchParams.get('q') || '');
      const parent = query?.[1] || null;
      const children = [...this.entries].filter(([key, entry]) =>
        entry.parents?.[0] === parent && !entry.trashed && (entry.name !== '' || entry.folder !== true)).filter(([key]) => key !== '');
      const token = parsed.searchParams.get('pageToken');
      let start = 0;
      if (token) {
        const match = /page-(\d+)/.exec(token);
        if (!match) return send(JSON.stringify({error:'bad token'}), {status:400});
        start = Number(match[1]);
      }
      const page = children.slice(start, start + this.pageSize);
      const next = start + this.pageSize < children.length ? `page-${start + this.pageSize}` : null;
      return send(JSON.stringify({nextPageToken:next, incompleteSearch:false, files:page.map(([key, entry]) => this.metadataFor(key))}));
    }
    const fileMatch = /^\/drive\/files\/([^/?]+)$/.exec(parsed.pathname);
    if (fileMatch) {
      if (!authorized()) return send(JSON.stringify({error:'invalid credentials'}), {status:401});
      const entry = [...this.entries].find(([, value]) => value.id === fileMatch[1]);
      if (!entry) return send(JSON.stringify({error:'notFound'}), {status:404});
      if (parsed.searchParams.get('alt') === 'media') {
        if (entry[1].folder) return send(JSON.stringify({error:'isFolder'}), {status:400});
        const pathKey = entry[1].duplicateOf || entry[0];
        const remaining = this.failDownloads.get(pathKey);
        if (remaining) {
          this.failDownloads.set(pathKey, remaining - 1);
          // A response that dies partway through the body, like an interrupted download.
          const bytes = this.files.get(pathKey);
          const stream = new ReadableStream({
            start(controller) {controller.enqueue(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)))); controller.error(new Error('connection reset'));}
          });
          return new Response(stream, {status:200, headers:{'content-length':String(bytes.length)}});
        }
        const bytes = this.files.get(pathKey);
        return send(bytes, {headers:{'content-length':String(bytes.length), 'content-type':entry[1].mimeType}});
      }
      const count = (this.metadataReadCounts.get(entry[0]) || 0) + 1;
      this.metadataReadCounts.set(entry[0], count);
      const hookPatch = this.onMetadata?.(entry[0], count) || {};
      return send(JSON.stringify({...this.metadataFor(entry[0]), ...hookPatch}));
    }
    return send(JSON.stringify({error:'unknown endpoint'}), {status:404});
  }

  metadataFor(pathKey) {
    const entry = this.entries.get(pathKey);
    if (!entry) return null;
    const patch = this.metadataOverrides.get(pathKey) || {};
    return {...entry, ...patch};
  }

  fetchImpl() {
    return (url, init) => this.respond(url, init);
  }
}

// Read a local campaign into the fake Drive: manifest, every referenced original, and the brand.
export async function fakeDriveFromCampaign(campaignDir, {brandPath, pageSize, rootName} = {}) {
  const {files} = await referencedCampaignFiles(campaignDir, {brandPath});
  const map = new Map();
  for (const file of files) map.set(file.path, await fs.readFile(file.actualPath));
  return new FakeDrive({files:map, pageSize, rootName});
}
