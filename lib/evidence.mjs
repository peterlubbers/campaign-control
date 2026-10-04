import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MAX_BYTES = 128 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOP_FIELDS = ['schemaVersion', 'sourceType', 'observationId', 'observedAtUTC', 'dataset', 'dateRange', 'sourceUrl', 'prompts', 'limitations'];

export class EvidenceError extends Error {
  constructor(message, code = 'INVALID_EVIDENCE') { super(message); this.name = 'EvidenceError'; this.code = code; }
}
function invalid() { throw new EvidenceError('Market evidence does not match the supported browser-observation schema.'); }
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k)) || fields.some(k => !Object.hasOwn(value, k))) invalid();
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function list(value, maximum, itemMaximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  return value.map(item => text(item, itemMaximum));
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) invalid();
  return value;
}
function sourceUrl(value, categoryId) {
  text(value, 2000);
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'platform.tryprofound.com' || url.port || url.username || url.password || !url.pathname.startsWith(`/${categoryId}/`) || [...url.searchParams.keys()].some(k => /token|secret|password|credential|authorization|api.?key|session|^code$|^auth$/i.test(k))) invalid();
  return url.href;
}
function optionalNumber(value, max, integer = false) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) invalid();
  return value;
}

// This reconstructs plain data; callers must still render strings as text, never HTML.
// External evidence stays outside the product-fact authority boundary.
export function validateMarketEvidence(value, {requireHash = true} = {}) {
  object(value, requireHash ? [...TOP_FIELDS, 'sha256'] : TOP_FIELDS);
  if (value.schemaVersion !== 1 || value.sourceType !== 'manual-browser-observation' || !ID.test(value.observationId)) invalid();
  if (requireHash && !/^[a-f0-9]{64}$/.test(value.sha256)) invalid();
  if (typeof value.observedAtUTC !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.observedAtUTC) || !Number.isFinite(Date.parse(value.observedAtUTC)) || new Date(value.observedAtUTC).toISOString().slice(0,19) !== value.observedAtUTC.slice(0,19)) invalid();
  object(value.dataset, ['brand', 'categoryId']);
  const dataset = {brand: text(value.dataset.brand, 100), categoryId: text(value.dataset.categoryId, 36)};
  if (!UUID.test(dataset.categoryId)) invalid();
  object(value.dateRange, ['start', 'endInclusive', 'platformFilter']);
  const dateRange = {start: day(value.dateRange.start), endInclusive: day(value.dateRange.endInclusive), platformFilter: text(value.dateRange.platformFilter, 500)};
  if (dateRange.start > dateRange.endInclusive) invalid();
  if (!Array.isArray(value.prompts) || !value.prompts.length || value.prompts.length > 50) invalid();
  const ids = new Set();
  const prompts = value.prompts.map(prompt => {
    object(prompt, ['id', 'text', 'platformPromptId', 'topic', 'sourceUrl', 'intentTags', 'observedMixpanelVisibilityPercent', 'executionsShown']);
    if (typeof prompt.id !== 'string' || !ID.test(prompt.id) || ids.has(prompt.id)) invalid();
    ids.add(prompt.id);
    const tags = list(prompt.intentTags, 12, 50);
    if (new Set(tags).size !== tags.length || tags.some(tag => !/^[a-z][a-z0-9-]*$/.test(tag))) invalid();
    return {id: prompt.id, text: text(prompt.text, 1000), platformPromptId: prompt.platformPromptId === null ? null : text(prompt.platformPromptId, 128), topic: text(prompt.topic, 180), sourceUrl: sourceUrl(prompt.sourceUrl, dataset.categoryId), intentTags: tags, observedMixpanelVisibilityPercent: optionalNumber(prompt.observedMixpanelVisibilityPercent, 100), executionsShown: optionalNumber(prompt.executionsShown, 1000000000, true)};
  });
  return {schemaVersion: 1, sourceType: 'manual-browser-observation', observationId: value.observationId, observedAtUTC: value.observedAtUTC, dataset, dateRange, sourceUrl: sourceUrl(value.sourceUrl, dataset.categoryId), prompts, limitations: list(value.limitations, 20, 1000, 1), ...(requireHash ? {sha256: value.sha256} : {})};
}

export async function loadMarketEvidence(root, relativePath) {
  if (relativePath === null || typeof relativePath === 'undefined') return null;
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw new EvidenceError('Evidence path must identify a file inside the campaign evidence directory.', 'UNSAFE_EVIDENCE_PATH');
  let base, evidenceRoot, resolved;
  try {
    base = await fs.realpath(root);
    const candidate = path.resolve(base, relativePath);
    if (!candidate.startsWith(path.join(base, 'evidence') + path.sep)) throw new EvidenceError('Evidence path is outside the campaign evidence directory.', 'UNSAFE_EVIDENCE_PATH');
    evidenceRoot = await fs.realpath(path.join(base, 'evidence'));
    if (evidenceRoot !== path.join(base, 'evidence')) throw new EvidenceError('Evidence directory must not redirect to another directory.', 'UNSAFE_EVIDENCE_PATH');
    resolved = await fs.realpath(candidate);
    if (!resolved.startsWith(evidenceRoot + path.sep)) throw new EvidenceError('Evidence file resolves outside the evidence directory.', 'UNSAFE_EVIDENCE_PATH');
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('Configured market evidence is missing or unreadable.', 'EVIDENCE_MISSING');
  }
  let handle;
  try {
    handle = await fs.open(resolved, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_BYTES) throw new EvidenceError('Market evidence must be a JSON file no larger than 128 KiB.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const {bytesRead} = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new EvidenceError('Market evidence exceeds the supported file size.');
    const bytes = buffer.subarray(0, size);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { throw new EvidenceError('Market evidence is not valid UTF-8 JSON.'); }
    const data = validateMarketEvidence(parsed, {requireHash: false});
    return {...data, sha256: createHash('sha256').update(bytes).digest('hex')};
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('Configured market evidence could not be read.', 'EVIDENCE_MISSING');
  } finally { await handle?.close(); }
}
