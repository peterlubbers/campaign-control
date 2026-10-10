import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {DRIVE_SNAPSHOT_MAX_FILE_BYTES, DRIVE_SNAPSHOT_MAX_TOTAL_BYTES, safeCampaignPath} from './sample-fingerprint.mjs';

export const GOOGLE_DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const NATIVE_DOCUMENT_PREFIX = 'application/vnd.google-apps.';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const marker = file => JSON.stringify({
  id:file.id,
  name:file.name ?? null,
  parents:file.parents ?? null,
  trashed:Boolean(file.trashed),
  version:file.version ?? null,
  headRevisionId:file.headRevisionId ?? null,
  modifiedTime:file.modifiedTime ?? null,
  size:file.size ?? null,
  md5Checksum:file.md5Checksum ?? null,
  mimeType:file.mimeType ?? null,
});

export class GoogleDriveError extends Error {
  constructor(message, status = 400, code = 'DRIVE_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeDriveId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{5,256}$/.test(value)) throw new GoogleDriveError('Enter a valid Google Drive folder ID or folder URL.', 400, 'INVALID_FOLDER_ID');
  return value;
}

function safeFolderName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    !['.', '..'].includes(value) && !/[\/\\\0]/.test(value);
}

function folderIdFromInput(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new GoogleDriveError('Enter a valid Google Drive folder ID or folder URL.', 400, 'INVALID_FOLDER_ID');
  const trimmed = value.trim();
  const match = /(?:\/folders\/|[?&]id=)([A-Za-z0-9_-]{5,256})(?:[/?&#]|$)/.exec(trimmed);
  return safeDriveId(match?.[1] || trimmed);
}

async function tokenResponse(fetchImpl, fields, tokenEndpoint = TOKEN_ENDPOINT) {
  const response = await fetchImpl(tokenEndpoint, {
    method:'POST',
    redirect:'error',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(fields),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new GoogleDriveError('Google authorization returned an unreadable token response.', 502, 'OAUTH_RESPONSE'); }
  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : '';
    throw new GoogleDriveError(code === 'invalid_grant' ? 'Google authorization expired or was revoked. Reconnect Google Drive.' : 'Google authorization failed. Check the OAuth client setup and try again.', 401, code === 'invalid_grant' ? 'REAUTH_REQUIRED' : 'OAUTH_FAILED');
  }
  return payload;
}

export class GoogleOAuth {
  constructor({registry, clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET,
    redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:8142/oauth/google/callback',
    authEndpoint = AUTH_ENDPOINT, tokenEndpoint = TOKEN_ENDPOINT, revokeEndpoint = REVOKE_ENDPOINT,
    fetchImpl = globalThis.fetch, now = () => Date.now()} = {}) {
    if (!registry) throw new Error('A workspace registry is required for Google OAuth.');
    this.registry = registry;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    // Endpoint overrides exist so repeatable offline demos and tests can serve a local fake Google.
    this.authEndpoint = authEndpoint;
    this.tokenEndpoint = tokenEndpoint;
    this.revokeEndpoint = revokeEndpoint;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pending = new Map();
  }

  configured() {
    try {
      const url = new URL(this.redirectUri);
      return Boolean(this.clientId && this.clientSecret && url.protocol === 'http:' &&
        ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && url.pathname === '/oauth/google/callback');
    } catch { return false; }
  }

  start({browserNonce} = {}) {
    if (!this.configured()) throw new GoogleDriveError('Google Drive is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to a registered localhost callback.', 503, 'OAUTH_NOT_CONFIGURED');
    if (this.pending.size >= 16) {
      for (const [state, pending] of this.pending) if (pending.expiresAt <= this.now()) this.pending.delete(state);
      if (this.pending.size >= 16) throw new GoogleDriveError('Too many Google authorization attempts are pending. Complete one and try again.', 429, 'OAUTH_BUSY');
    }
    const state = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    this.pending.set(state, {verifier, browserNonce, createdAt:this.now(), expiresAt:this.now() + 10 * 60 * 1000});
    const url = new URL(this.authEndpoint);
    url.search = new URLSearchParams({
      client_id:this.clientId,
      redirect_uri:this.redirectUri,
      response_type:'code',
      access_type:'offline',
      prompt:'consent',
      scope:GOOGLE_DRIVE_READONLY_SCOPE,
      state,
      code_challenge:challenge,
      code_challenge_method:'S256',
    }).toString();
    return url.toString();
  }

  async callback({code, state, error:oauthError, browserNonce}) {
    const pending = this.pending.get(state);
    if (!pending || pending.expiresAt <= this.now() || (pending.browserNonce && pending.browserNonce !== browserNonce)) {
      this.pending.delete(state);
      throw new GoogleDriveError('Google callback state is missing, invalid, or expired. Restart the connection flow.', 403, 'INVALID_OAUTH_STATE');
    }
    this.pending.delete(state);
    if (oauthError) throw new GoogleDriveError('Google authorization was not completed. No Drive launch was connected.', 401, 'OAUTH_DENIED');
    if (typeof code !== 'string' || !code || code.length > 4096) throw new GoogleDriveError('Google did not return a valid authorization code.', 400, 'OAUTH_CODE_INVALID');
    if (!this.configured()) throw new GoogleDriveError('Google OAuth is not configured on this server.', 503, 'OAUTH_NOT_CONFIGURED');
    const token = await tokenResponse(this.fetchImpl, {
      code,
      client_id:this.clientId,
      client_secret:this.clientSecret,
      redirect_uri:this.redirectUri,
      grant_type:'authorization_code',
      code_verifier:pending.verifier,
    },this.tokenEndpoint);
    if (typeof token.refresh_token !== 'string' || !token.refresh_token || typeof token.access_token !== 'string') throw new GoogleDriveError('Google did not grant offline Drive access. Restart authorization and approve the requested read-only access.', 401, 'OFFLINE_ACCESS_REQUIRED');
    if (token.scope && !token.scope.split(' ').includes(GOOGLE_DRIVE_READONLY_SCOPE)) throw new GoogleDriveError('The requested Drive read-only scope was not granted.',403,'SCOPE_NOT_GRANTED');
    const connectionId = randomUUID();
    await this.registry.saveConnection(connectionId, {
      refresh_token:token.refresh_token,
      access_token:token.access_token,
      expires_at:this.now() + (Number(token.expires_in) || 3600) * 1000,
      token_type:token.token_type || 'Bearer',
      scope:token.scope || GOOGLE_DRIVE_READONLY_SCOPE,
    });
    return connectionId;
  }

  async disconnect(connectionId) {
    const tokens = await this.registry.readConnection(connectionId);
    let revoked = !tokens;
    if (tokens) {
      try {
        const response = await this.fetchImpl(this.revokeEndpoint,{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
          headers:{'content-type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({token:tokens.refresh_token}),
        });
        revoked = response.ok;
      } catch { revoked = false; }
    }
    return {remoteRevocationConfirmed:revoked};
  }
}

export class GoogleDriveClient {
  constructor({registry, connectionId, clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET,
    driveApi = DRIVE_API, fetchImpl = globalThis.fetch, now = () => Date.now(), maxFileBytes = DRIVE_SNAPSHOT_MAX_FILE_BYTES,
    maxTotalBytes = DRIVE_SNAPSHOT_MAX_TOTAL_BYTES} = {}) {
    if (!registry || !connectionId) throw new Error('A workspace connection is required.');
    this.registry = registry;
    this.connectionId = connectionId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.driveApi = driveApi;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.access = null;
  }

  async accessToken({forceRefresh = false} = {}) {
    if (!forceRefresh && this.access && this.access.expiresAt > this.now() + 60_000) return this.access.token;
    const saved = await this.registry.readConnection(this.connectionId);
    if (!saved) throw new GoogleDriveError('Google Drive is disconnected. Reconnect this workspace before refreshing.', 401, 'DISCONNECTED');
    if (!forceRefresh && saved.access_token && Number(saved.expires_at) > this.now() + 60_000) {
      this.access = {token:saved.access_token,expiresAt:Number(saved.expires_at)};
      return this.access.token;
    }
    const token = await tokenResponse(this.fetchImpl, {
      refresh_token:saved.refresh_token,
      client_id:this.clientId,
      client_secret:this.clientSecret,
      grant_type:'refresh_token',
    });
    if (typeof token.access_token !== 'string' || !token.access_token) throw new GoogleDriveError('Google access expired. Reconnect Google Drive.', 401, 'REAUTH_REQUIRED');
    const updated = {
      ...saved,
      access_token:token.access_token,
      expires_at:this.now() + (Number(token.expires_in) || 3600) * 1000,
      token_type:token.token_type || saved.token_type || 'Bearer',
    };
    await this.registry.saveConnection(this.connectionId, updated);
    this.access = {token:updated.access_token,expiresAt:updated.expires_at};
    return this.access.token;
  }

  async request(url, {download = false} = {}) {
    const token = await this.accessToken();
    let response;
    try {
      response = await this.fetchImpl(url, {redirect:'error',signal:AbortSignal.timeout(60_000),headers:{Authorization:`Bearer ${token}`}});
    } catch {
      throw new GoogleDriveError('Google Drive could not be reached. Your local campaigns remain available.', 502, 'DRIVE_UNAVAILABLE');
    }
    if (response.status === 401) {
      this.access = null;
      const refreshed = await this.accessToken({forceRefresh:true});
      try {response = await this.fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(60_000),headers:{Authorization:`Bearer ${refreshed}`}});}
      catch {throw new GoogleDriveError('Google Drive could not be reached.',502,'DRIVE_UNAVAILABLE');}
      if (response.status === 401) throw new GoogleDriveError('Google Drive access expired or was revoked. Reconnect before refreshing this launch.', 401, 'REAUTH_REQUIRED');
    }
    if (response.status === 403) throw new GoogleDriveError('Google denied access to a selected campaign file. Verify access to the folder and every referenced descendant.', 403, 'FILE_FORBIDDEN');
    if (response.status === 404) throw new GoogleDriveError('A selected Drive folder or referenced file is missing or inaccessible.', 404, 'FILE_NOT_FOUND');
    if (!response.ok) throw new GoogleDriveError('Google Drive returned an error. No new snapshot was committed.', 502, 'DRIVE_REQUEST_FAILED');
    if (download) return response;
    let body;
    try { body = await response.json(); }
    catch { throw new GoogleDriveError('Google Drive returned unreadable metadata.', 502, 'DRIVE_RESPONSE_INVALID'); }
    return body;
  }

  async metadata(fileId) {
    const url = new URL(`${this.driveApi}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields','id,name,mimeType,parents,size,md5Checksum,version,headRevisionId,modifiedTime,shortcutDetails,webViewLink,trashed');
    url.searchParams.set('supportsAllDrives','true');
    return this.request(url);
  }

  async listChildren(folderId) {
    const files = [];
    let pageToken;
    const seenTokens = new Set();
    do {
      const url = new URL(`${this.driveApi}/files`);
      url.searchParams.set('q',`'${folderId}' in parents and trashed = false`);
      url.searchParams.set('pageSize','1000');
      url.searchParams.set('orderBy','name');
      url.searchParams.set('supportsAllDrives','true');
      url.searchParams.set('includeItemsFromAllDrives','true');
      url.searchParams.set('fields','nextPageToken,incompleteSearch,files(id,name,mimeType,parents,size,md5Checksum,version,headRevisionId,modifiedTime,shortcutDetails,webViewLink,trashed)');
      if (pageToken) url.searchParams.set('pageToken',pageToken);
      const page = await this.request(url);
      if (page.incompleteSearch) throw new GoogleDriveError('Drive search was incomplete. Refresh the folder or choose a fully accessible folder.', 409, 'INCOMPLETE_SEARCH');
      if (!Array.isArray(page.files)) throw new GoogleDriveError('Google Drive returned an invalid file page.', 502, 'DRIVE_RESPONSE_INVALID');
      files.push(...page.files);
      pageToken = page.nextPageToken || undefined;
      if (pageToken && seenTokens.has(pageToken)) throw new GoogleDriveError('Google Drive returned repeated pagination tokens.',502,'DRIVE_RESPONSE_INVALID');
      if (pageToken) seenTokens.add(pageToken);
      if (files.length > 20_000) throw new GoogleDriveError('Campaign folder contains too many files to safely inspect.', 413, 'FOLDER_TOO_LARGE');
    } while (pageToken);
    return files;
  }

  async remoteIndex(rootFolderId, {onProgress = () => {}} = {}) {
    const root = await this.metadata(rootFolderId);
    if (root.trashed || root.mimeType !== GOOGLE_FOLDER_MIME) throw new GoogleDriveError('The selected Drive item is not an accessible folder.', 400, 'NOT_A_FOLDER');
    const entries = new Map();
    const ambiguous = new Set();
    const visited = new Set([rootFolderId]);
    const queue = [{id:rootFolderId,relative:'',depth:0}];
    let inspected = 0;
    while (queue.length) {
      const parent = queue.shift();
      if (parent.depth > 32 || visited.size > 5000 || entries.size > 20_000) throw new GoogleDriveError('Campaign folder exceeds the supported inspection bounds.',413,'FOLDER_TOO_LARGE');
      const children = await this.listChildren(parent.id);
      inspected++;
      for (const file of children) {
        if (!file || typeof file.id !== 'string' || !safeFolderName(file.name) || file.trashed) continue;
        const relative = parent.relative ? `${parent.relative}/${file.name}` : file.name;
        if (entries.has(relative)) ambiguous.add(relative);
        else entries.set(relative,file);
        if (file.mimeType === GOOGLE_FOLDER_MIME && !visited.has(file.id)) {
          visited.add(file.id);
          queue.push({id:file.id,relative,depth:parent.depth+1});
        }
        // Shortcuts are entries, not traversal edges. Their target is never fetched implicitly.
      }
      onProgress({phase:'discovery', folders:inspected, items:entries.size,
        message:`Discovering Drive folder: ${inspected} folders inspected · ${entries.size} items found · ${queue.length} folders remaining…`});
    }
    return {root,entries,ambiguous};
  }

  async fileBytes(file) {
    if (file.mimeType === GOOGLE_SHORTCUT_MIME) throw new GoogleDriveError(`Drive shortcut “${file.name}” is not followed. Replace it with a file inside the selected campaign folder.`, 409, 'SHORTCUT_UNSUPPORTED');
    if (file.mimeType?.startsWith(NATIVE_DOCUMENT_PREFIX)) throw new GoogleDriveError(`Native Google document “${file.name}” has no original file bytes to snapshot in phase one. Export/edit support is a later feature.`, 409, 'NATIVE_GOOGLE_FILE_UNSUPPORTED');
    const url = new URL(`${this.driveApi}/files/${encodeURIComponent(file.id)}`);
    url.searchParams.set('alt','media');
    url.searchParams.set('supportsAllDrives','true');
    const response = await this.request(url, {download:true});
    const headerLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(headerLength) && headerLength > this.maxFileBytes) throw new GoogleDriveError(`Drive file “${file.name}” exceeds the per-file snapshot limit.`, 413, 'FILE_TOO_LARGE');
    const chunks = []; let length = 0;
    try {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > this.maxFileBytes) {throw new GoogleDriveError(`Drive file “${file.name}” exceeds the per-file snapshot limit.`,413,'FILE_TOO_LARGE');}
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof GoogleDriveError) throw error;
      throw new GoogleDriveError(`Download of “${file.name}” was interrupted. No valid snapshot was created.`,502,'SNAPSHOT_INCOMPLETE');
    }
    const bytes = Buffer.concat(chunks,length);
    if (bytes.length > this.maxFileBytes) throw new GoogleDriveError(`Drive file “${file.name}” exceeds the per-file snapshot limit.`, 413, 'FILE_TOO_LARGE');
    if (Number.isFinite(Number(file.size)) && bytes.length !== Number(file.size)) throw new GoogleDriveError(`Drive file “${file.name}” changed or was truncated during download.`, 409, 'SNAPSHOT_INCOMPLETE');
    if (file.md5Checksum && createHash('md5').update(bytes).digest('hex') !== file.md5Checksum) throw new GoogleDriveError(`Drive file “${file.name}” failed its source checksum.`, 409, 'SNAPSHOT_INTEGRITY');
    return bytes;
  }

  async createSnapshot({folderId:folderInput, destinationRoot, onProgress = () => {}, afterAcquire = async () => {}, beforeCommit = async () => {}} = {}) {
    const folderId = folderIdFromInput(folderInput);
    const {root,entries,ambiguous} = await this.remoteIndex(folderId,{onProgress});
    onProgress({phase:'manifest', message:'Discovery complete. Reading campaign.json and checking every referenced path…'});
    const manifestEntry = entries.get('campaign.json');
    if (ambiguous.has('campaign.json')) throw new GoogleDriveError('The selected folder contains multiple campaign.json files. Keep exactly one manifest in the folder root.', 409, 'AMBIGUOUS_MANIFEST');
    if (!manifestEntry) throw new GoogleDriveError('The selected folder has no campaign.json at its root. Choose a campaign folder with a valid manifest.', 400, 'MANIFEST_MISSING');
    if (manifestEntry.mimeType !== 'application/json' && manifestEntry.mimeType !== 'text/plain') throw new GoogleDriveError('campaign.json is not an uploaded JSON/text file. Native Google documents are not supported as manifests.', 400, 'MANIFEST_UNSUPPORTED');

    const manifestBytes = await this.fileBytes(manifestEntry);
    if (marker(manifestEntry) !== marker(await this.metadata(manifestEntry.id))) throw new GoogleDriveError('campaign.json changed while being downloaded.',409,'SOURCE_CHANGED_DURING_SNAPSHOT');
    if (manifestBytes.length > 2 * 1024 * 1024) throw new GoogleDriveError('campaign.json exceeds the supported 2 MiB manifest limit.', 413, 'MANIFEST_TOO_LARGE');
    let campaign;
    try { campaign = JSON.parse(manifestBytes.toString('utf8')); }
    catch { throw new GoogleDriveError('campaign.json could not be parsed. Choose a folder with a valid campaign manifest.', 400, 'MANIFEST_INVALID'); }
    if (!Array.isArray(campaign.assets) || !campaign.assets.length || campaign.assets.length > 1000) throw new GoogleDriveError('Campaign manifest must register 1–1,000 deliverables.', 400, 'MANIFEST_INVALID');

    const requiredPaths = new Set(['campaign.json']);
    for (const asset of campaign.assets) {
      if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string' || typeof asset.channel !== 'string') throw new GoogleDriveError('Campaign manifest contains an invalid deliverable.', 400, 'MANIFEST_INVALID');
      if (asset.source) {
        try { requiredPaths.add(safeCampaignPath(asset.source)); }
        catch (error) { throw new GoogleDriveError(error.message, 400, 'UNSAFE_PATH'); }
      }
      if (asset.files !== undefined && !Array.isArray(asset.files)) throw new GoogleDriveError(`Asset ${asset.id} has an invalid companion list.`, 400, 'MANIFEST_INVALID');
      for (const file of asset.files || []) {
        try { requiredPaths.add(safeCampaignPath(file?.path)); }
        catch (error) { throw new GoogleDriveError(error.message, 400, 'UNSAFE_PATH'); }
      }
    }
    if (campaign.marketEvidencePath) {
      try { requiredPaths.add(safeCampaignPath(campaign.marketEvidencePath)); }
      catch (error) { throw new GoogleDriveError(error.message, 400, 'UNSAFE_PATH'); }
    }
    // The public sample fingerprint includes its company identity, while unrelated campaigns may use the default theme.
    if (entries.has('brand/identity.json')) requiredPaths.add('brand/identity.json');

    const missing = [];
    for (const relative of requiredPaths) {
      const parts = relative.split('/');
      if (parts.some((_part,i) => ambiguous.has(parts.slice(0,i+1).join('/')))) throw new GoogleDriveError(`More than one Drive item maps to “${relative}”. Rename or remove duplicates before connecting the campaign.`, 409, 'AMBIGUOUS_FILE');
      if (!entries.has(relative)) missing.push(relative);
    }
    if (missing.length) {
      const parts = missing[0].split('/');
      const firstMissing = parts.findIndex((_part,i) => !entries.has(parts.slice(0,i+1).join('/')));
      const unresolved = parts.slice(0,firstMissing+1).join('/');
      const parent = parts.slice(0,firstMissing).join('/');
      const siblings = [...entries.keys()].filter(p => p.split('/').slice(0,-1).join('/') === parent).slice(0,5);
      throw new GoogleDriveError(`campaign.json was read, but ${missing.length} referenced file(s) are missing or inaccessible: ${missing.slice(0,5).map(p=>`“${p}”`).join(', ')}${missing.length>5 ? ` (and ${missing.length-5} more)` : ''}. First unresolved path: “${unresolved}”. ${siblings.length ? `Items visible alongside it: ${siblings.map(p=>`“${p}”`).join(', ')}. ` : ''}Check the selected folder, exact names and extensions, upload completion, and file permissions. No snapshot was committed.`,400,'REFERENCED_FILE_MISSING');
    }

    const stageId = `snapshot-${randomUUID()}`;
    const snapshotsRoot = path.resolve(destinationRoot);
    const stage = path.join(snapshotsRoot, `.${stageId}.tmp`);
    const destination = path.join(snapshotsRoot, stageId);
    await fs.mkdir(stage, {recursive:true, mode:0o700});
    const records = [];
    let totalBytes = 0;
    try {
      const stableEntries = [...requiredPaths].sort((a,b) => a.localeCompare(b));
      for (const relative of stableEntries) {
        onProgress({phase:'download', completed:records.length, total:stableEntries.length,
          message:`Creating verified snapshot: ${records.length} of ${stableEntries.length} files checked · Reading ${relative}…`});
        const file = entries.get(relative);
        if (file.mimeType === GOOGLE_FOLDER_MIME) throw new GoogleDriveError(`Manifest path “${relative}” refers to a folder, not a file.`, 400, 'EXPECTED_FILE');
        const before = await this.metadata(file.id);
        if (marker(file) !== marker(before)) throw new GoogleDriveError(`Drive source “${relative}” changed while resolving the manifest.`,409,'SOURCE_CHANGED_DURING_SNAPSHOT');
        if (file.mimeType === GOOGLE_SHORTCUT_MIME || file.mimeType?.startsWith(NATIVE_DOCUMENT_PREFIX)) {
          records.push({
            path:relative,fileId:file.id,name:file.name,parents:before.parents ?? null,trashed:false,
            mimeType:file.mimeType,version:before.version ?? null,headRevisionId:before.headRevisionId ?? null,
            modifiedTime:before.modifiedTime ?? null,remoteSize:before.size ?? null,md5Checksum:before.md5Checksum ?? null,
            status:'unsupported',capability:file.mimeType === GOOGLE_SHORTCUT_MIME ? 'shortcut-not-followed' : 'native-document-external-editor',
          });
          continue;
        }
        const bytes = relative === 'campaign.json' ? manifestBytes : await this.fileBytes(before);
        totalBytes += bytes.length;
        if (totalBytes > this.maxTotalBytes) throw new GoogleDriveError('Campaign folder exceeds the total snapshot size limit.', 413, 'CAMPAIGN_TOO_LARGE');
        const target = path.resolve(stage, ...relative.split('/'));
        if (!target.startsWith(stage + path.sep)) throw new GoogleDriveError('Campaign manifest contains an unsafe output path.', 400, 'UNSAFE_PATH');
        await fs.mkdir(path.dirname(target), {recursive:true, mode:0o700});
        await fs.writeFile(target, bytes, {flag:'wx',mode:0o600});
        const after = await this.metadata(file.id);
        if (marker(before) !== marker(after)) throw new GoogleDriveError(`Drive source “${relative}” changed during snapshot acquisition. Nothing was committed.`, 409, 'SOURCE_CHANGED_DURING_SNAPSHOT');
        records.push({
          path:relative,
          fileId:file.id,
          name:file.name,parents:after.parents ?? null,trashed:Boolean(after.trashed),
          mimeType:file.mimeType,
          version:after.version ?? null,
          headRevisionId:after.headRevisionId ?? null,
          modifiedTime:after.modifiedTime ?? null,
          remoteSize:after.size ?? null,
          md5Checksum:after.md5Checksum ?? null,
          sha256:digest(bytes),
          bytes:bytes.length,
          capability:file.mimeType?.startsWith(NATIVE_DOCUMENT_PREFIX) ? 'metadata-only-native-document' : 'downloaded-original-bytes',
          status:'downloaded',
        });
      }
      await afterAcquire({folderId,root,records,campaign});
      await beforeCommit({folderId,root,records,campaign});
      const snapshot = {
        id:stageId,
        folderId,
        folderName:root.name,
        snapshotAt:new Date(this.now()).toISOString(),
        campaignId:campaign.id,
        manifestSha256:digest(manifestBytes),
        files:records,
        totalBytes,
      };
      const folderAfter = await this.metadata(folderId);
      if (marker(root) !== marker(folderAfter)) throw new GoogleDriveError('Selected Drive folder changed during snapshot acquisition. Nothing was committed.', 409, 'SOURCE_CHANGED_DURING_SNAPSHOT');
      onProgress({phase:'verification', message:'Files acquired. Rechecking Drive identities before committing the snapshot…'});
      await this.verifySnapshot(snapshot,{onProgress});
      await fs.rename(stage, destination);
      return {snapshot, snapshotDir:destination};
    } catch (error) {
      await fs.rm(stage, {recursive:true,force:true}).catch(() => {});
      if (error instanceof GoogleDriveError) throw error;
      throw new GoogleDriveError('Drive snapshot failed before commit. No valid snapshot was created.', 502, 'SNAPSHOT_FAILED');
    }
  }

  async verifySnapshot(snapshot, {onlyPaths, onProgress = () => {}} = {}) {
    if (!snapshot || !Array.isArray(snapshot.files)) throw new GoogleDriveError('Drive snapshot evidence is missing. Refresh this launch before continuing.', 409, 'SNAPSHOT_UNVERIFIED');
    const relevant = onlyPaths ? new Set(onlyPaths) : null;
    const index = await this.remoteIndex(snapshot.folderId,{onProgress:progress=>onProgress({...progress,phase:'verification',message:`Verifying snapshot · ${progress.message}`})});
    let checked = 0;
    for (const file of snapshot.files) {
      if (relevant && !relevant.has(file.path)) continue;
      checked++;
      onProgress({phase:'verification', completed:checked-1, total:snapshot.files.length,
        message:`Verifying snapshot: ${checked-1} of ${snapshot.files.length} file identities checked…`});
      const parts = file.path.split('/');
      if (index.entries.get(file.path)?.id !== file.fileId || parts.some((_part,i) => index.ambiguous.has(parts.slice(0,i+1).join('/')))) throw new GoogleDriveError(`Drive path “${file.path}” no longer resolves unambiguously to the recorded file. Refresh and review again.`,409,'STALE_SOURCE');
      const current = await this.metadata(file.fileId);
      const recorded = {
        id:file.fileId,name:file.name,parents:file.parents ?? null,trashed:Boolean(file.trashed),version:file.version, headRevisionId:file.headRevisionId,
        modifiedTime:file.modifiedTime, size:file.remoteSize,
        md5Checksum:file.md5Checksum, mimeType:file.mimeType,
      };
      const currentMarker = marker(current);
      if (JSON.stringify(recorded) !== currentMarker) throw new GoogleDriveError(`Drive source “${file.path}” changed since its snapshot. Refresh and review a new version before continuing.`, 409, 'STALE_SOURCE');
      if (file.status !== 'unsupported' && file.version == null && file.headRevisionId == null && file.modifiedTime == null && file.md5Checksum == null) {
        const bytes = await this.fileBytes(current);
        if (digest(bytes) !== file.sha256) throw new GoogleDriveError(`Drive source “${file.path}” could not be verified as unchanged. Refresh and review it again.`, 409, 'SOURCE_UNVERIFIED');
      }
    }
    return {verifiedAt:new Date(this.now()).toISOString(),files:checked};
  }
}

export function driveFolderId(value) {
  return folderIdFromInput(value);
}
