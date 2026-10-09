import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CAMPAIGN = path.resolve(here, '../fictitious-ai/campaigns/pro500');
const BUNDLED_BRAND = path.resolve(here, '../fictitious-ai/brand/identity.json');
export const DRIVE_SNAPSHOT_MAX_FILE_BYTES = 250 * 1024 * 1024;
export const DRIVE_SNAPSHOT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export function safeCampaignPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Campaign manifest contains an unsafe relative path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Campaign manifest contains an unsafe relative path.');
  return parts.join('/');
}

export async function referencedCampaignFiles(campaignDir, {brandPath} = {}) {
  const manifestPath = path.join(campaignDir, 'campaign.json');
  const manifestBytes = await fs.readFile(manifestPath);
  if (manifestBytes.length > 2 * 1024 * 1024) throw new Error('Campaign manifest exceeds the supported size.');
  let campaign;
  try { campaign = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('Campaign folder must contain a valid campaign.json manifest.'); }
  if (!Array.isArray(campaign.assets) || !campaign.assets.length || campaign.assets.length > 1000) throw new Error('Campaign manifest must register 1–1,000 deliverables.');

  const paths = new Set(['campaign.json']);
  for (const asset of campaign.assets) {
    if (!asset || typeof asset !== 'object') throw new Error('Campaign manifest contains an invalid deliverable.');
    if (asset.source) paths.add(safeCampaignPath(asset.source));
    if (asset.files !== undefined && !Array.isArray(asset.files)) throw new Error('Campaign manifest contains an invalid companion list.');
    for (const file of asset.files || []) {
      if (!file || typeof file.path !== 'string') throw new Error('Campaign manifest contains an invalid companion path.');
      paths.add(safeCampaignPath(file.path));
    }
  }
  if (campaign.marketEvidencePath) paths.add(safeCampaignPath(campaign.marketEvidencePath));

  const selectedBrand = brandPath || path.join(campaignDir, 'brand/identity.json');
  if (await fs.access(selectedBrand).then(() => true, () => false)) paths.add('brand/identity.json');

  const root = await fs.realpath(campaignDir);
  const files = [];
  for (const relativePath of paths) {
    const actualPath = relativePath === 'brand/identity.json' ? selectedBrand : path.join(root, ...relativePath.split('/'));
    const resolved = await fs.realpath(actualPath);
    if (relativePath !== 'brand/identity.json' && !resolved.startsWith(root + path.sep)) throw new Error('Campaign input escapes the selected campaign folder.');
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error(`Campaign input is not a regular file: ${relativePath}`);
    if (stat.size > DRIVE_SNAPSHOT_MAX_FILE_BYTES) throw new Error(`Campaign input exceeds the ${DRIVE_SNAPSHOT_MAX_FILE_BYTES} byte snapshot limit: ${relativePath}`);
    files.push({path:relativePath, actualPath:resolved, bytes:stat.size});
  }
  return {campaign, manifestBytes, files:files.sort((a,b) => a.path.localeCompare(b.path))};
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function campaignFingerprint(campaignDir, {brandPath, maxTotalBytes = DRIVE_SNAPSHOT_MAX_TOTAL_BYTES} = {}) {
  const {campaign, files} = await referencedCampaignFiles(campaignDir, {brandPath});
  let totalBytes = 0;
  const entries = [];
  for (const file of files) {
    totalBytes += file.bytes;
    if (totalBytes > maxTotalBytes) throw new Error('Campaign exceeds the total snapshot size limit.');
    entries.push({path:file.path, bytes:file.bytes, sha256:await hashFile(file.actualPath)});
  }
  const identity = {assetCount:campaign.assets.length, entries};
  return {
    assetCount:campaign.assets.length,
    fileCount:entries.length,
    totalBytes,
    entries,
    fingerprint:createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  };
}

export async function bundledSampleFingerprint() {
  return campaignFingerprint(BUNDLED_CAMPAIGN, {brandPath:BUNDLED_BRAND});
}

export async function isBundledSample(campaignDir, options = {}) {
  try {
    const [expected, actual] = await Promise.all([
      bundledSampleFingerprint(),
      campaignFingerprint(campaignDir, options),
    ]);
    return actual.assetCount === 104 && actual.fingerprint === expected.fingerprint;
  } catch { return false; }
}
