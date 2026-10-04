import {createHash} from 'node:crypto';

const BASE = 'https://api.tryprofound.com';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ProfoundError extends Error {
  constructor(message) { super(message); this.name = 'ProfoundError'; }
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[^\s]+)?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ProfoundError('Provide a valid report date range.');
  return new Date(value).toISOString();
}
function metric(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (name === 'count' && !Number.isInteger(value))) throw new ProfoundError('Profound returned an invalid citation metric.');
  return value;
}
function normalizeReport(report, query) {
  if (!Array.isArray(report?.data) || !Number.isInteger(report?.info?.total_rows) || report.info.total_rows < report.data.length) throw new ProfoundError('Profound citation response does not match the documented report schema.');
  const dims = report.info.query?.dimensions || query.dimensions;
  const metrics = report.info.query?.metrics || query.metrics;
  if (JSON.stringify(dims) !== JSON.stringify(query.dimensions) || JSON.stringify(metrics) !== JSON.stringify(query.metrics)) throw new ProfoundError('Returned report columns do not match the requested citation evidence.');
  const rows = report.data.map(row => {
    if (!Array.isArray(row.dimensions) || row.dimensions.length !== dims.length || !Array.isArray(row.metrics) || row.metrics.length !== metrics.length) throw new ProfoundError('Citation evidence contains malformed rows.');
    let url;
    try { url = new URL(row.dimensions[dims.indexOf('url')]); } catch { throw new ProfoundError('Citation evidence contains an invalid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProfoundError('Citation URL is not safe to display.');
    const host = url.hostname.toLowerCase();
    return {url: url.href, hostname: host, channel: host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') ? 'youtube' : 'web', citationCount: metric(row.metrics[metrics.indexOf('count')], 'count'), citationShare: metric(row.metrics[metrics.indexOf('citation_share')], 'citation_share')};
  });
  return {rows, totalRows: report.info.total_rows, returnedRows: rows.length, truncated: report.info.total_rows > rows.length};
}

// No credentials, account data, or inferred success is exposed by status.
export function createProfound({env = process.env, fetchImpl = globalThis.fetch, now = () => new Date().toISOString()} = {}) {
  let verifiedAt = null;
  function profoundStatus() {
    const configured = Boolean(env.PROFOUND_API_KEY);
    const datasetConfigured = uuid.test(env.PROFOUND_ORGANIZATION_ID || '') && uuid.test(env.PROFOUND_CATEGORY_ID || '') && env.PROFOUND_DATASET_CONFIRMED === 'assigned-hackathon';
    return {provider: 'profound', configured, datasetConfigured, connected: Boolean(verifiedAt), verifiedAt, mode: 'read-only', message: !configured ? 'Optional Profound evidence is not connected. No API credential configured.' : !datasetConfigured ? 'Credential present; confirm the assigned hackathon organization and category before querying.' : verifiedAt ? 'Selected assigned-dataset citation query verified.' : 'Configured; selected-dataset access has not been verified.'};
  }
  async function request(path, body) {
    let response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {method: body ? 'POST' : 'GET', redirect: 'error', headers: {'X-API-Key': env.PROFOUND_API_KEY, ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(30000)});
    } catch { throw new ProfoundError('Profound evidence request failed or timed out.'); }
    if (!response.ok) throw new ProfoundError(`Profound evidence request returned HTTP ${response.status}.`);
    try { return await response.json(); } catch { throw new ProfoundError('Profound returned unreadable evidence.'); }
  }
  async function fetchCitationEvidence({startDate, endDate, limit = 100} = {}) {
    const status = profoundStatus();
    if (!status.configured || !status.datasetConfigured) throw new ProfoundError(status.message);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ProfoundError('Citation limit must be between 1 and 1,000.');
    const start = date(startDate); const end = date(endDate);
    if (Date.parse(start) >= Date.parse(end)) throw new ProfoundError('Report start must precede its end.');
    const organizationId = env.PROFOUND_ORGANIZATION_ID;
    const categoryId = env.PROFOUND_CATEGORY_ID;
    // Explicit organization filter prevents accidentally reading all accessible accounts.
    const categories = await request(`/v1/org/categories?organization_ids=${encodeURIComponent(organizationId)}`);
    if (!Array.isArray(categories) || !categories.some(c => c.id === categoryId && c.organization?.id === organizationId)) throw new ProfoundError('Selected category is not verified in the assigned organization.');
    const query = {category_id: categoryId, start_date: start, end_date: end, dimensions: ['url'], metrics: ['count', 'citation_share'], order_by: {count: 'desc'}, pagination: {limit, offset: 0}};
    // This POST executes a documented analytics query; it never edits remote content.
    const report = await request('/v1/reports/citations', query);
    const normalized = normalizeReport(report, query);
    verifiedAt = now();
    return {...normalized, source: 'profound-live-api', retrievedAt: verifiedAt, dataset: {organizationId, categoryId, scope: 'assigned-hackathon'}, query, reportHash: hash(report), endpoint: `${BASE}/v1/reports/citations`, interpretation: 'Citation frequency is prioritization evidence, not proof of causation or projected revenue. This dataset does not measure the fictional Fictitious AI brand.'};
  }
  return {profoundStatus, fetchCitationEvidence};
}
const liveProfound = createProfound();
export const profoundStatus = liveProfound.profoundStatus;
export const fetchCitationEvidence = liveProfound.fetchCitationEvidence;
