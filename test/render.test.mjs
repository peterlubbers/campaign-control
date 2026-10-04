import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {BRAND,BRAND_HASH,loadBrand,brandHash} from '../lib/brand.mjs';
import {renderAsset,parseVideo,parsePublisherMetadata,visualMarkdown,PUBLISHER_FIELDS} from '../lib/render.mjs';

async function temporary(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'launch-control-render-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true})); return dir;
}
const asset={id:'TEST-001',title:'Test-only rendering example',channel:'website',kind:'page',metadata:{}};
const publisherBlock = (channel,overrides={}) => '\n\n## Publisher metadata\n\n'+Object.entries({...Object.fromEntries(PUBLISHER_FIELDS[channel].map(key=>[key,`Test-only ${key}`])),...overrides}).map(([key,value])=>`${key}: ${value}`).join('\n')+'\n';

test('requested preview-label revisions preserve publisher copy and reject unsupported layout control',async t=>{
  const outputDir=await temporary(t), sales={...asset,channel:'sales',kind:'sales'};
  const markdown='# Sales content\n\nUnrelated content remains intact.\n'+publisherBlock('sales');
  await renderAsset({asset:sales,markdown,outputDir:path.join(outputDir,'before')});
  assert.match(await readFile(path.join(outputDir,'before/review.html'),'utf8'),/>sales · sales<\/div>/);
  await renderAsset({asset:sales,markdown,outputDir:path.join(outputDir,'after'),reviewLabel:'Sales & enablement'});
  assert.match(await readFile(path.join(outputDir,'after/review.html'),'utf8'),/>Sales &amp; enablement<\/div>/);
  assert.equal(await readFile(path.join(outputDir,'before/publish-copy.md'),'utf8'),await readFile(path.join(outputDir,'after/publish-copy.md'),'utf8'));
  assert.equal(JSON.parse(await readFile(path.join(outputDir,'after/render-manifest.json'),'utf8')).reviewLabel,'Sales & enablement');
  await assert.rejects(renderAsset({asset:sales,markdown,outputDir,reviewLabel:'<img src=x>'}),/invalid or unsupported/);
  await assert.rejects(renderAsset({asset:{...sales,kind:'video'},markdown,outputDir,reviewLabel:'Video label'}),/invalid or unsupported/);
});

test('HTML reflects exact current input and escapes executable markup',async t=>{
  const outputDir=await temporary(t);
  const markdown='# Fresh & current\n\nLiteral <script>alert("no")</script>\n\nPrice: $713/month.\n';
  const result=await renderAsset({asset,markdown,outputDir,facts:{product:'Test-only'}});
  const html=await readFile(path.join(outputDir,result.primaryPath),'utf8');
  assert.match(html,/Fresh &amp; current/); assert.match(html,/&lt;script&gt;/); assert.doesNotMatch(html,/<script>/);
  assert.match(html,/\$713\/month/); assert.equal(await readFile(path.join(outputDir,'source.md'),'utf8'),markdown);
  assert.equal(result.textContent,markdown); assert.ok(result.files.every(f=>!path.isAbsolute(f.path)&&!f.path.includes('..')));
});

test('graphics derive visible copy from input and preserve separate editorial caption',async t=>{
  const outputDir=await temporary(t);
  const markdown='# Test graphic\n\n## Headline\n\nA changed offer & context\n\n## Main copy\n\nThe new statement is visible.\n\n## Caption\n\nA separate editorial caption.\n\n## Call to action\n\nRead the evidence.\n'+publisherBlock('social',{alt_text:'Publisher-only alt text & an exact description.'});
  const result=await renderAsset({asset:{...asset,kind:'graphic',channel:'social',metadata:{width:1200,height:1200}},markdown,outputDir});
  const svg=await readFile(path.join(outputDir,'graphic.svg'),'utf8');
  assert.match(svg,/A changed offer &amp;/); assert.match(svg,/The new statement is visible/);
  assert.doesNotMatch(svg,/Publisher-only|alt_text|post_caption/);
  assert.equal(result.primaryPath,'graphic.svg'); assert.ok(result.files.some(f=>f.role==='editable-source'));
  assert.match(await readFile(path.join(outputDir,'review.html'),'utf8'),/A separate editorial caption/);
});

test('native presentation is gated by the exact Markdown and brand hashes; ordinary sales collateral is not',async t=>{
  const outputDir=await temporary(t); const markdown='# Test-only presentation\n\nFresh copy.\n'+publisherBlock('sales');
  const presentation={...asset,kind:'sales',channel:'sales',metadata:{presentation:true}};
  let result=await renderAsset({asset:presentation,markdown,outputDir});
  assert.equal(result.checks.find(c=>c.name==='native-google-slides').status,'blocked');
  presentation.metadata.nativeSlides={url:'https://docs.google.com/presentation/d/TEST_ONLY_REFERENCE/edit',verified:true,contentSha256:createHash('sha256').update(markdown).digest('hex')};
  result=await renderAsset({asset:presentation,markdown,outputDir});
  assert.equal(result.checks.find(c=>c.name==='native-google-slides').status,'blocked');
  presentation.metadata.nativeSlides.brandIdentitySha256='stale-identity';
  result=await renderAsset({asset:presentation,markdown,outputDir});
  assert.equal(result.checks.find(c=>c.name==='native-google-slides').status,'blocked');
  presentation.metadata.nativeSlides.brandIdentitySha256=BRAND_HASH;
  result=await renderAsset({asset:presentation,markdown,outputDir});
  assert.equal(result.checks.find(c=>c.name==='native-google-slides').status,'pass');
  result=await renderAsset({asset:presentation,markdown:markdown.replace('Fresh copy.','Changed copy.'),outputDir});
  assert.equal(result.checks.find(c=>c.name==='native-google-slides').status,'blocked');
  result=await renderAsset({asset:{...presentation,metadata:{presentation:false}},markdown,outputDir});
  assert.ok(result.checks.every(c=>c.status==='pass'));
});

test('video scenes exclude publisher instructions while metadata preserves full supplied values',()=>{
  const markdown='# Test video\n\n## Scene 1 | 00-06\n\nNew headline\n\nNew on-screen detail.\n\n## YouTube title\n\nAn exact changed title\n\n## YouTube description\n\nA changed description & special punctuation.\n\n## Tags\n\nresearch, updated offer\n\n## Chapters\n\n00:00 New headline\n\n## Publisher instructions\n\nHUMAN REVIEW BEFORE UPLOAD.\n';
  const parsed=parseVideo(markdown);
  assert.equal(parsed.scenes[0].headline,'New headline'); assert.equal(parsed.scenes[0].body,'New on-screen detail.');
  assert.equal(parsed.metadata.title,'An exact changed title'); assert.deepEqual(parsed.metadata.tags,['research','updated offer']);
  assert.equal(parsed.metadata.publicationStatus,'unpublished'); assert.doesNotMatch(JSON.stringify(parsed.scenes),/HUMAN REVIEW/);
  assert.throws(()=>parseVideo(markdown.replace('## Tags','## Missing tags')),/missing: Tags/);
  assert.throws(()=>parseVideo(markdown.replace('00-06','01-06')),/timing/);
});

test('invalid asset identity cannot escape the render destination',async t=>{
  const outputDir=await temporary(t);
  await assert.rejects(()=>renderAsset({asset:{...asset,id:'../escape'},markdown:'# Example',outputDir}),/safe asset ID/);
});

test('all supported publisher schemas retain editable extra fields and multiline values',()=>{
  for(const channel of Object.keys(PUBLISHER_FIELDS)) {
    const markdown='# Visible body\n\nKeep this separate.'+publisherBlock(channel,{editorial_note:'First line: with a colon\n  Second line & punctuation.'});
    const result=parsePublisherMetadata(markdown,channel);
    assert.equal(result.fields.editorial_note,'First line: with a colon\nSecond line & punctuation.');
    for(const key of PUBLISHER_FIELDS[channel]) assert.equal(result.fields[key],`Test-only ${key}`);
    assert.doesNotMatch(visualMarkdown(markdown,'page'),/editorial_note|Second line/);
  }
});

test('publisher metadata is a bound companion, separate from the visible body and safely escaped in HTML metadata',async t=>{
  const outputDir=await temporary(t);
  const metadata={page_title:'Search title <untrusted> & exact',meta_description:'A "quoted" description <script>not executable</script>',url_path:'/test-only',editorial_note:'Keep outside the page body.'};
  const markdown='# Visible heading\n\nVisible body stays intact.'+publisherBlock('website',metadata);
  const result=await renderAsset({asset,markdown,outputDir});
  assert.equal(result.checks.find(c=>c.name==='publisher-metadata').status,'pass');
  const json=JSON.parse(await readFile(path.join(outputDir,'publisher-metadata.json'),'utf8'));
  assert.deepEqual(json.fields,metadata); assert.equal(json.assetId,asset.id); assert.equal(json.handoffState,'unpublished');
  assert.equal(json.sourceSha256,createHash('sha256').update(markdown).digest('hex'));
  assert.equal(result.textContent,markdown); assert.ok(result.files.filter(f=>f.role==='publisher-metadata').length===2);
  const html=await readFile(path.join(outputDir,'review.html'),'utf8');
  assert.match(html,/<title>Search title &lt;untrusted&gt; &amp; exact<\/title>/);
  assert.match(html,/content="A &quot;quoted&quot; description &lt;script&gt;/);
  const body=html.split('<body>')[1];
  assert.match(body,/Visible heading/); assert.doesNotMatch(body,/Search title|description|editorial_note|Keep outside|Publisher metadata/);
  const publishCopy=await readFile(path.join(outputDir,'publish-copy.md'),'utf8');
  assert.match(publishCopy,/Visible body stays intact/);
  assert.doesNotMatch(publishCopy,/Publisher metadata|editorial_note|Keep outside/);
  assert.equal(result.files.find(file=>file.path==='publish-copy.md').role,'publishable-copy');
  assert.match(await readFile(path.join(outputDir,'publisher-metadata.md'),'utf8'),/editorial_note: Keep outside/);
});

test('metadata-only edits change the source binding and exported fields',async t=>{
  const outputDir=await temporary(t); const original='# Same visible body'+publisherBlock('website',{page_title:'First metadata title'});
  await renderAsset({asset,markdown:original,outputDir});
  const before=JSON.parse(await readFile(path.join(outputDir,'publisher-metadata.json'),'utf8'));
  const changed=original.replace('First metadata title','Revised metadata title');
  await renderAsset({asset,markdown:changed,outputDir});
  const after=JSON.parse(await readFile(path.join(outputDir,'publisher-metadata.json'),'utf8'));
  assert.equal(after.fields.page_title,'Revised metadata title'); assert.notEqual(after.sourceSha256,before.sourceSha256);
  assert.equal(visualMarkdown(original,'page'),visualMarkdown(changed,'page'));
});

test('absent, incomplete, duplicate, or malformed publisher metadata blocks completion',async t=>{
  const outputDir=await temporary(t);
  const missing=await renderAsset({asset,markdown:'# Visible body only',outputDir});
  assert.equal(missing.checks.find(c=>c.name==='publisher-metadata').status,'blocked');
  assert.ok(!missing.files.some(f=>f.role==='publisher-metadata'));
  const valid='# Body'+publisherBlock('website');
  assert.throws(()=>parsePublisherMetadata(valid.replace('meta_description: Test-only meta_description',''),'website'),/missing required/);
  assert.throws(()=>parsePublisherMetadata(valid+'page_title: duplicate\n','website'),/duplicated/);
  assert.throws(()=>parsePublisherMetadata(valid+publisherBlock('website'),'website'),/Exactly one/);
  assert.throws(()=>parsePublisherMetadata(valid+'__proto__: not allowed\n','website'),/lowercase_snake_case/);
});

test('video visual copy omits both publisher sections while the full source remains auditable',()=>{
  const markdown='# Video body\n\n## Scene 1 | 00-06\n\nVisible scene\n\nVisible detail.\n\n## YouTube title\n\nPublisher-only title\n\n## YouTube description\n\nPublisher-only description\n\n## Tags\n\nmetadata-only\n\n## Chapters\n\n00:00 Intro\n\n## Publisher instructions\n\nPublisher-only instruction.'+publisherBlock('video');
  const visual=visualMarkdown(markdown,'video');
  assert.match(visual,/Visible scene/); assert.doesNotMatch(visual,/Publisher-only|metadata-only|audience_instruction|rights_instruction/);
  assert.equal(parseVideo(markdown).metadata.title,'Publisher-only title');
  assert.equal(parsePublisherMetadata(markdown,'video').fields.platform,'Test-only platform');
});

test('active campaign has 104 distinct sources across eleven channels and complete publisher bundles',async()=>{
  const root=new URL('../fictitious-ai/campaigns/pro500/',import.meta.url);
  const campaign=JSON.parse(await readFile(new URL('campaign.json',root),'utf8'));
  assert.equal(campaign.assets.length,104); assert.equal(new Set(campaign.assets.map(a=>a.id)).size,104);
  assert.equal(new Set(campaign.assets.map(a=>a.channel)).size,11);
  assert.equal(campaign.assets.filter(a=>a.metadata.presentation===true).length,0);
  assert.equal(campaign.assets.filter(a=>a.metadata.outputFormat==='pdf').length,1);
  const content=new Set();
  for(const item of campaign.assets) {
    const markdown=await readFile(new URL(item.source,root),'utf8'); content.add(markdown);
    assert.ok(markdown.length>250,`${item.id} must contain substantive original copy`);
    parsePublisherMetadata(markdown,item.channel);
    if(item.kind==='video') assert.equal(parseVideo(markdown).scenes.length,3);
  }
  assert.equal(content.size,104);
});

test('PDF collateral renders original and changed copy, verifies every block, and never substitutes a preview for delivery',{skip:process.platform!=='darwin'},async t=>{
  const outputDir=await temporary(t);
  const collateral={...asset,channel:'sales',kind:'sales',metadata:{outputFormat:'pdf'}};
  const original='# Synthetic battlecard\n\n## Current offer\n\nTest Alpha is $271/month.\n\n## Review\n\nChallenge the analytical assumptions.'+publisherBlock('sales');
  for(const [name,markdown] of [['original',original],['revision',original.replace('Test Alpha is $271/month.','Test Beta is $943/month.')]]) {
    const directory=path.join(outputDir,name);
    const result=await renderAsset({asset:collateral,markdown,outputDir:directory});
    assert.equal(result.primaryPath,'document.pdf');
    assert.ok(result.checks.every(c=>c.status==='pass'),JSON.stringify(result.checks));
    const bytes=await readFile(path.join(directory,'document.pdf'));
    assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    const proof=JSON.parse(await readFile(path.join(directory,'pdf-verification.json'),'utf8'));
    assert.equal(proof.textVerified,true);assert.equal(proof.pageCount,1);
    assert.equal(proof.sourceSha256,createHash('sha256').update(markdown).digest('hex'));
    assert.ok(result.files.some(f=>f.role==='pdf-document'&&f.mime==='application/pdf'));
    assert.ok(result.files.some(f=>f.role==='document-preview'));
    assert.ok(!result.files.some(f=>f.role==='publishable-copy'||f.role==='native-presentation-reference'));
    const payload=JSON.parse(await readFile(path.join(directory,'pdf-layout.json'),'utf8'));
    assert.ok(payload.blocks.some(b=>b.text==='Challenge the analytical assumptions.'));
    assert.ok(!payload.blocks.some(b=>b.text.includes('document_title:')));
  }
  assert.notDeepEqual(await readFile(path.join(outputDir,'original/document.pdf')),await readFile(path.join(outputDir,'revision/document.pdf')));
  const bad=await renderAsset({asset:collateral,markdown:'# Unrenderable\n\n'+('An oversized paragraph. '.repeat(800))+publisherBlock('sales'),outputDir:path.join(outputDir,'oversize')});
  assert.equal(bad.checks.find(c=>c.name==='pdf-document').status,'blocked');
  assert.ok(!bad.files.some(f=>f.role==='pdf-document'||f.role==='publishable-copy'));
  await assert.rejects(renderAsset({asset:{...collateral,metadata:{outputFormat:'pdf',presentation:true}},markdown:original,outputDir}),/not presentations/);
});


test('selected company identity styles graphics and HTML without adding its mark to other organizations',async t=>{
  const outputDir=await temporary(t);
  const identity=await loadBrand(new URL('../fictitious-ai/brand/identity.json',import.meta.url));
  const markdown='# Identity example\n\n## Headline\n\nA clear product question\n\n## Main copy\n\nInspect the answer.\n\n## Call to action\n\nRead the example.'+publisherBlock('social');
  for(const brand of [identity.company.name,'Independent example']) {
    await renderAsset({asset:{...asset,kind:'graphic',channel:'social',metadata:{brand}},markdown,outputDir,brand:identity});
    const svg=await readFile(path.join(outputDir,'graphic.svg'),'utf8');
    const html=await readFile(path.join(outputDir,'review.html'),'utf8');
    assert.match(svg,new RegExp(identity.colors.blue)); assert.match(svg,new RegExp(identity.colors.graphite));
    assert.doesNotMatch(svg,/Georgia|Times New Roman|#205e52|#e6eee4/i);
    assert.doesNotMatch(html,/Georgia|Times New Roman|#205e52|#e6eee4/i);
    assert.equal(svg.includes('aria-label="Fictitious AI signal mark"'),brand===identity.company.name);
    assert.equal(html.includes('aria-label="Fictitious AI signal mark"'),brand===identity.company.name);
    assert.ok(!svg.includes(BRAND.copy.tagline)); assert.ok(!html.includes(BRAND.copy.principle));
    const manifest=JSON.parse(await readFile(path.join(outputDir,'render-manifest.json'),'utf8'));
    assert.equal(manifest.brandIdentitySha256,brandHash(identity));
  }
});
