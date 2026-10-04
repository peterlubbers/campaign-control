import { mkdir, readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BRAND, brandHash, brandLogoSVG, validateBrand } from './brand.mjs';
import {supportsReviewLabel, validReviewLabel, reviewLabelFor} from './review-label.mjs';
import {renderPDF} from './pdf.mjs';

const execute = promisify(execFile);
const swiftSource = fileURLToPath(new URL('../scripts/render-video.swift', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain = value => String(value).replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
const titleOf = (asset, markdown) => /^#\s+(.+)$/m.exec(markdown)?.[1] || asset.title;
const brandOf = asset => String(asset.metadata?.brand || 'Campaign');
const usesCompanyMark = (asset, brand) => Boolean(brand.company.logo) && brandOf(asset) === brand.company.name;
const safeId = value => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
let encoderPromise;

export const PUBLISHER_FIELDS = Object.freeze({
  website: ['page_title','meta_description','url_path'],
  email: ['subject','preheader','sender_name'],
  social: ['platform','post_caption','alt_text','hashtags'],
  paid: ['placement','ad_headline','ad_description','call_to_action','destination_instruction'],
  video: ['platform','visibility','audience_instruction','rights_instruction'],
  sales: ['document_title','audience','distribution_instruction'],
  support: ['article_title','article_summary','help_center_path'],
  partners: ['listing_title','partner_description','distribution_instruction'],
  'in-product': ['surface','message_title','message_body','call_to_action','targeting_instruction'],
  events: ['event_title','event_format','audience','registration_instruction'],
  press: ['release_title','summary','media_contact_instruction','release_instruction'],
});
const VIDEO_PUBLISHER_HEADINGS = new Set(['youtube title','youtube description','tags','chapters','publisher instructions']);

export function sectionsOf(markdown) {
  const sections = [];
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) { current = {heading: match[1].trim(), lines: []}; sections.push(current); }
    else if (current) current.lines.push(line);
  }
  return sections.map(s => ({heading: s.heading, text: s.lines.join('\n').trim()}));
}

export function parsePublisherMetadata(markdown, channel) {
  const required = PUBLISHER_FIELDS[channel];
  if (!required) throw new Error(`Unsupported publisher channel: ${channel}.`);
  const sections = sectionsOf(markdown).filter(s => s.heading.toLowerCase() === 'publisher metadata');
  if (sections.length !== 1) throw new Error('Exactly one ## Publisher metadata section is required.');
  const fields = Object.create(null); let currentKey = null;
  for (const line of sections[0].text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^ {2,}\S/.test(line) && currentKey) { fields[currentKey] += `${fields[currentKey] ? '\n' : ''}${line.slice(2)}`; continue; }
    const match = /^([a-z][a-z0-9_]{0,63}):[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error('Publisher metadata must use lowercase_snake_case: value lines; indent multiline continuations by two spaces.');
    if (Object.hasOwn(fields,match[1])) throw new Error(`Publisher metadata field is duplicated: ${match[1]}.`);
    currentKey = match[1]; fields[currentKey] = match[2];
  }
  const missing = required.filter(key => !fields[key]?.trim());
  if (missing.length) throw new Error(`Publisher metadata is missing required ${channel} fields: ${missing.join(', ')}.`);
  if (Object.keys(fields).length > 60) throw new Error('Publisher metadata exceeds 60 fields.');
  return {fields,markdown:`## Publisher metadata\n\n${sections[0].text}\n`};
}

export function visualMarkdown(markdown, kind) {
  let omit = false;
  return markdown.split(/\r?\n/).filter(line => {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      const normalized = heading[1].trim().toLowerCase();
      omit = normalized === 'publisher metadata' || (kind === 'video' && VIDEO_PUBLISHER_HEADINGS.has(normalized));
    }
    return !omit;
  }).join('\n').trimEnd()+'\n';
}

function markdownHTML(markdown) {
  const out = []; let paragraph = []; let list = [];
  const flush = () => {
    if (paragraph.length) { out.push(`<p>${escape(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`); paragraph = []; }
    if (list.length) { out.push(`<ul>${list.map(s => `<li>${escape(s)}</li>`).join('')}</ul>`); list = []; }
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { flush(); const n = heading[1].length; out.push(`<h${n}>${escape(heading[2])}</h${n}>`); }
    else if (/^-\s+/.test(line)) { if (paragraph.length) flush(); list.push(line.replace(/^-\s+/, '')); }
    else if (!line.trim()) flush();
    else { if (list.length) flush(); paragraph.push(line); }
  }
  flush(); return out.join('\n');
}

function reviewHTML(asset, markdown, nativeSlides, publisher, brand, reviewLabel) {
  const colors = brand.colors;
  const label = reviewLabel ?? reviewLabelFor({...asset, candidateReviewLabel:undefined});
  const nativeLink = nativeSlides ? `<a class="native" href="${escape(nativeSlides.url)}" target="_blank" rel="noreferrer">Open verified native Google Slides</a>` : '';
  const pageTitle = publisher?.page_title || publisher?.article_title || titleOf(asset,markdown);
  const description = publisher?.meta_description || publisher?.article_summary;
  const descriptionTag = description ? `<meta name="description" content="${escape(description)}">` : '';
  const mark = usesCompanyMark(asset,brand) ? brandLogoSVG(brand,36) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(pageTitle)}</title>${descriptionTag}<style>*{box-sizing:border-box}body{margin:0;background:${colors.white};color:${colors.graphite};font-family:${brand.typography.sans};line-height:1.65}header{padding:30px max(28px,calc((100vw - 850px)/2));background:${colors.graphite};color:${colors.white};border-bottom:4px solid ${colors.blue}}.brand{display:flex;align-items:center;gap:14px;font-weight:700;font-size:19px;letter-spacing:-.4px}.brand svg{flex:none}.asset-id{color:${colors.muted};font-size:13px;font-family:${brand.typography.mono};margin-left:auto}.meta{font-size:11px;letter-spacing:1.1px;text-transform:uppercase;color:${colors.muted};margin-top:14px}main{max-width:906px;margin:0 auto;padding:64px 28px 90px}h1{font-weight:700;font-style:normal;font-size:clamp(32px,5vw,54px);line-height:1.08;letter-spacing:-1.8px;margin:0 0 42px;max-width:780px}h2{font-size:23px;letter-spacing:-.5px;margin:36px 0 10px}h3{font-size:19px}p,li{font-size:17px;max-width:730px}p{margin:12px 0 20px}ul{padding-left:24px}li{margin:10px 0}.native{display:inline-block;margin-bottom:28px;color:${colors.graphite};text-decoration-thickness:2px;text-underline-offset:4px;text-decoration-color:${colors.blue};font-weight:700}footer{border-top:1px solid ${colors.silver};max-width:850px;margin:auto;padding:22px 0 38px;color:${colors.steel};font-size:12px}a{color:${colors.graphite}}@media print{body{background:white}header{background:white;color:${colors.graphite}}main{padding-top:24px}}</style></head><body><header><div class="brand">${mark}<span>${escape(brandOf(asset))}</span><span class="asset-id">${escape(asset.id)}</span></div><div class="meta">${escape(label)}</div></header><main>${nativeLink}${markdownHTML(markdown)}</main><footer>Unpublished campaign asset · ${escape(asset.id)} · Review before use.</footer></body></html>`;
}

function wrap(text, limit) {
  const lines = []; let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > limit) { lines.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function graphicSVG(asset, markdown, thumbnail, brand) {
  const colors = brand.colors;
  const width = thumbnail ? 1280 : (Number(asset.metadata?.width) || 1200);
  const height = thumbnail ? 720 : (Number(asset.metadata?.height) || 1200);
  if (width < 300 || width > 4096 || height < 300 || height > 4096) throw new Error('Graphic dimensions are outside supported bounds.');
  const sections = sectionsOf(markdown);
  const find = heading => plain(sections.find(s => s.heading.toLowerCase() === heading)?.text || '');
  const firstScene = sections.find(s => /^Scene\s+\d+/i.test(s.heading));
  const headline = thumbnail ? (firstScene?.text.split(/\n\s*\n/)[0] || asset.title) : find('headline') || asset.title;
  const body = thumbnail ? (firstScene?.text.split(/\n\s*\n/).slice(1).join(' ') || '') : find('main copy');
  const cta = thumbnail ? brandOf(asset) : find('call to action');
  const headlineSize = height < 800 ? 58 : 76;
  const headlineLines = wrap(headline, Math.floor((width - 150) / (headlineSize * .60)));
  const bodyLines = wrap(body, Math.floor((width - 150) / 20));
  const headlineY = height < 800 ? 196 : 320;
  const bodyY = headlineY + headlineLines.length * headlineSize * 1.13 + 40;
  if (bodyY + bodyLines.length * 46 > height - 125) throw new Error('Graphic copy exceeds the readable layout. Shorten the copy or select a larger canvas.');
  const lines = (value, x, y, fontSize, leading, color, weight=400) => value.map((line,i) => `<text x="${x}" y="${y+i*leading}" fill="${color}" font-family="${escape(brand.typography.sans)}" font-size="${fontSize}" font-weight="${weight}">${escape(line)}</text>`).join('');
  const hasMark = usesCompanyMark(asset,brand);
  const mark = hasMark ? `<g transform="translate(72 55)">${brandLogoSVG(brand,48)}</g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(headline)}</title><desc>${escape(body)}</desc><rect width="${width}" height="${height}" fill="${colors.graphite}"/><rect x="${width-18}" width="18" height="${height}" fill="${colors.blue}"/>${mark}${lines([brandOf(asset)],hasMark?138:72,90,28,34,colors.white,700)}${lines(headlineLines,72,headlineY,headlineSize,headlineSize*1.13,colors.white,700)}${lines(bodyLines,72,bodyY,34,46,colors.silver)}<line x1="72" x2="${width-72}" y1="${height-102}" y2="${height-102}" stroke="${colors.steel}"/>${lines(wrap(cta,70),72,height-56,25,32,colors.blue,700)}<text x="${width-72}" y="${height-57}" text-anchor="end" fill="${colors.muted}" font-family="${escape(brand.typography.mono)}" font-size="16">${escape(asset.id)}</text></svg>`;
}

export function parseVideo(markdown) {
  const sections = sectionsOf(markdown);
  const scenes = [];
  for (const section of sections) {
    const match = /^Scene\s+\d+\s*\|\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/i.exec(section.heading);
    if (!match) continue;
    const start = Number(match[1]), end = Number(match[2]);
    const paragraphs = section.text.split(/\n\s*\n/).map(plain).filter(Boolean);
    if (!paragraphs.length || end <= start || end-start > 30 || Math.abs(start-(scenes.at(-1)?.end ?? 0)) > .001) throw new Error('Video scene timing must be contiguous, start at zero, and contain readable copy.');
    scenes.push({start, end, headline: paragraphs[0], body: paragraphs.slice(1).join('\n\n')});
  }
  if (!scenes.length || scenes.length > 20 || scenes.at(-1).end > 180) throw new Error('Video requires 1–20 explicitly timed scenes, at most 180 seconds.');
  const required = ['YouTube title','YouTube description','Tags','Chapters','Publisher instructions'];
  const values = Object.fromEntries(required.map(name => [name, sections.find(s => s.heading.toLowerCase() === name.toLowerCase())?.text?.trim()]));
  const missing = required.filter(name => !values[name]);
  if (missing.length) throw new Error(`Video publisher bundle is missing: ${missing.join(', ')}.`);
  return {scenes, metadata: {title: values['YouTube title'], description: values['YouTube description'], tags: values.Tags.split(',').map(s => s.trim()).filter(Boolean), chapters: values.Chapters, publisherInstructions: values['Publisher instructions'], publicationStatus: 'unpublished'}, metadataMarkdown: required.map(name => `## ${name}\n\n${values[name]}`).join('\n\n')+'\n'};
}

const timestamp = seconds => {
  const ms = Math.round(seconds*1000);
  return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
};

async function getEncoder() {
  if (process.platform !== 'darwin') throw new Error('MP4 production needs macOS AVFoundation and Swift. A supported renderer is required before release.');
  if (!encoderPromise) encoderPromise = (async () => {
    const source = await readFile(swiftSource);
    const cache = path.join(os.tmpdir(), `launch-control-video-${sha256(source).slice(0,20)}`);
    await mkdir(cache,{recursive:true});
    const binary = path.join(cache,'render-video');
    try { await stat(binary); return binary; } catch {}
    const temporary = `${binary}-${process.pid}`;
    try { await execute('swiftc',['-O',swiftSource,'-o',temporary],{timeout:180000,maxBuffer:100000}); }
    catch { throw new Error('The local Swift compiler could not build the MP4 encoder. Check Xcode Command Line Tools and compiler-cache permissions, then restart the application.'); }
    await rename(temporary,binary); return binary;
  })();
  return encoderPromise;
}

async function encodeVideo(outputDir, scenes, asset, brand) {
  const encoder = await getEncoder();
  const payload = {width:1280,height:720,fps:24,assetId:asset.id,brand:brandOf(asset),categoryLabel:String(asset.metadata?.categoryLabel || 'CAMPAIGN / PRELAUNCH'),style:{colors:brand.colors,regularFont:brand.typography.videoRegular,boldFont:brand.typography.videoBold,logo:usesCompanyMark(asset,brand)?brand.company.logo:null,brandIdentitySha256:brandHash(brand)},scenes};
  const input = path.join(outputDir,'video-scenes.json');
  const output = path.join(outputDir,'video.mp4');
  await writeFile(input,JSON.stringify(payload,null,2)+'\n');
  // A failed retry must not leave an older video masquerading as the new candidate.
  await rm(output,{force:true});
  try { await execute(encoder,[input,output],{timeout:180000,maxBuffer:100000}); }
  catch(error) {
    const detail = /message\("([^"\n]{1,220})/.exec(String(error.stderr || ''))?.[1];
    throw new Error(detail || 'The local MP4 encoder failed or timed out. Check media-service access and scene layout before retrying.');
  }
  const videoStat = await stat(output);
  if (videoStat.size < 1024) throw new Error('Video encoder returned an empty or invalid file.');
}

export async function renderAsset({asset,markdown,outputDir,facts,brand = BRAND,reviewLabel}) {
  validateBrand(brand);
  if (!asset || !safeId(asset.id)) throw new Error('Renderer requires a safe asset ID.');
  if (reviewLabel !== undefined && (!supportsReviewLabel(asset) || !validReviewLabel(reviewLabel))) throw new Error('This preview label is invalid or unsupported by the asset format.');
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 100000) throw new Error('Renderer requires nonempty bounded Markdown.');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new Error('Renderer requires an absolute output directory.');
  await mkdir(outputDir,{recursive:true});
  const files = []; const checks = []; const sourceHash = sha256(markdown);
  const write = async (name,content,mime,role) => { await writeFile(path.join(outputDir,name),content); files.push({path:name,mime,role}); };
  const register = (name,mime,role) => files.push({path:name,mime,role});
  const native = asset.metadata?.nativeSlides;
  const nativeValid = Boolean(native?.verified === true && native.contentSha256 === sourceHash && native.brandIdentitySha256 === brandHash(brand) && /^https:\/\/docs\.google\.com\/presentation\/d\/[a-zA-Z0-9_-]+\//.test(native.url || ''));
  await write('source.md',markdown,'text/markdown','editable-source');
  let publisher = null;
  try {
    publisher = parsePublisherMetadata(markdown,asset.channel);
    await write('publisher-metadata.md',publisher.markdown,'text/markdown','publisher-metadata');
    await write('publisher-metadata.json',JSON.stringify({schemaVersion:1,assetId:asset.id,channel:asset.channel,sourceSha256:sourceHash,handoffState:'unpublished',fields:publisher.fields},null,2)+'\n','application/json','publisher-metadata');
    checks.push({name:'publisher-metadata',status:'pass',message:`Publisher metadata includes all required ${asset.channel} fields and is bound to the complete source hash. No publishing performed.`});
  } catch(error) { checks.push({name:'publisher-metadata',status:'blocked',message:error.message}); }
  const visibleCopy = visualMarkdown(markdown,asset.kind);
  const pdf = asset.metadata?.outputFormat === 'pdf';
  if (pdf && (asset.kind !== 'sales' || asset.metadata?.presentation === true)) throw new Error('PDF output is supported for sales collateral, not presentations.');
  if (['page','copy','sales'].includes(asset.kind) && asset.metadata?.presentation !== true && !pdf) {
    await write('publish-copy.md',visibleCopy,'text/markdown','publishable-copy');
  }
  await write('review.html',reviewHTML(asset,visibleCopy,nativeValid?native:null,publisher?.fields,brand,reviewLabel),'text/html','review-preview');
  let primaryPath = 'review.html';
  checks.push({name:'source-render-binding',status:'pass',message:`Rendered from the supplied Markdown; SHA-256 ${sourceHash}.`});
  if (pdf) {
    try {
      const proof = await renderPDF({asset,markdown:visibleCopy,outputDir,brand,sourceSha256:sourceHash});
      register('document.pdf','application/pdf','pdf-document');
      register('document-preview.png','image/png','document-preview');
      register('pdf-layout.json','application/json','render-evidence');
      register('pdf-verification.json','application/json','render-evidence');
      primaryPath = 'document.pdf';
      checks.push({name:'pdf-document',status:'pass',message:`${proof.pageCount}-page PDF created and reopened; every visible source block verified in extracted PDF text.`});
    } catch(error) {checks.push({name:'pdf-document',status:'blocked',message:error.message});}
  }
  if (asset.metadata?.presentation === true) {
    checks.push({name:'native-google-slides',status:nativeValid?'pass':'blocked',message:nativeValid?'Verified native Google Slides content is bound to this exact Markdown and current brand identity.':'This presentation requires a verified native Google Slides source matching the current Markdown and brand identity. HTML is a copy review, not a completed presentation.'});
    if (nativeValid) await write('native-slides.json',JSON.stringify(native,null,2)+'\n','application/json','native-presentation-reference');
  }
  if (asset.kind === 'graphic') {
    try { await write('graphic.svg',graphicSVG(asset,visibleCopy,false,brand),'image/svg+xml','graphic'); primaryPath='graphic.svg'; checks.push({name:'graphic-layout',status:'pass',message:'Input-driven editable SVG created with bounded, readable text layout.'}); }
    catch(error) { checks.push({name:'graphic-layout',status:'blocked',message:error.message}); }
  }
  if (asset.kind === 'video') {
    try {
      const video = parseVideo(markdown);
      await write('youtube-metadata.md',video.metadataMarkdown,'text/markdown','youtube-metadata');
      await write('youtube-metadata.json',JSON.stringify(video.metadata,null,2)+'\n','application/json','youtube-metadata');
      const vtt = 'WEBVTT\n\n'+video.scenes.map((s,i) => `${i+1}\n${timestamp(s.start)} --> ${timestamp(s.end)}\n${[s.headline,s.body].filter(Boolean).join('\n').replace(/-->/g,'→')}\n`).join('\n');
      await write('captions.vtt',vtt,'text/vtt','captions');
      await write('thumbnail.svg',graphicSVG(asset,visibleCopy,true,brand),'image/svg+xml','thumbnail');
      await encodeVideo(outputDir,video.scenes,asset,brand);
      register('video.mp4','video/mp4','native-video');
      register('video-scenes.json','application/json','video-scene-source');
      register('thumbnail.png','image/png','thumbnail');
      register('video-verification.json','application/json','render-evidence');
      for(let i=1;i<video.scenes.length;i++) register(`scene-${String(i+1).padStart(2,'0')}-proof.png`,'image/png','render-evidence');
      primaryPath='video.mp4';
      checks.push({name:'video-publisher-bundle',status:'pass',message:`Actual silent MP4 (${video.scenes.at(-1).end}s, 1280×720, 24fps), timed on-screen-copy captions, thumbnail, and input-driven publisher metadata created. No upload performed.`});
    } catch(error) { checks.push({name:'video-publisher-bundle',status:'blocked',message:`Video bundle incomplete: ${error.message}`}); }
  }
  const manifest = {assetId:asset.id,createdAtUTC:new Date().toISOString(),sourceSha256:sourceHash,brandIdentitySha256:brandHash(brand),facts: facts || null,files:[...files],checks,limitations:asset.kind==='video'?['Silent motion typography; no narration.','Captions repeat on-screen copy.','Chapters are an editorial outline; platform chapter eligibility is not asserted.']:[]};
  if (reviewLabel !== undefined) manifest.reviewLabel = reviewLabel;
  await write('render-manifest.json',JSON.stringify(manifest,null,2)+'\n','application/json','render-evidence');
  return {files,primaryPath,textContent:markdown,checks};
}
