import {mkdir, readFile, writeFile, stat, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {brandHash} from './brand.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../scripts/render-pdf.swift',import.meta.url));
let compiler;
async function renderer() {
  if (process.platform !== 'darwin') throw new Error('PDF collateral requires macOS and Swift/Xcode Command Line Tools.');
  if (!compiler) compiler = (async()=>{
    const hash = createHash('sha256').update(await readFile(source)).digest('hex');
    const cache = path.join(os.tmpdir(),`campaign-control-pdf-${hash.slice(0,20)}`);
    await mkdir(cache,{recursive:true});
    const binary = path.join(cache,'render-pdf');
    try {await stat(binary); return binary;} catch {}
    const temporary = `${binary}-${process.pid}`;
    try {await execute('swiftc',['-O','-module-cache-path',path.join(cache,'modules'),source,'-o',temporary],{timeout:180000,maxBuffer:100000});}
    catch {throw new Error('The local Swift compiler could not build the PDF renderer. Check Xcode Command Line Tools and compiler-cache permissions, then restart.');}
    await rename(temporary,binary); return binary;
  })();
  return compiler;
}

export function pdfBlocks(markdown) {
  const blocks = []; let paragraph = [];
  const flush = () => {if(paragraph.length) blocks.push({kind:'body',text:paragraph.join(' ')}); paragraph=[];};
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {flush(); blocks.push({kind:heading[1].length===1?'title':'heading',text:heading[2]});}
    else if (/^-\s+/.test(line)) {flush(); blocks.push({kind:'body',text:line});}
    else if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush(); return blocks;
}

export async function renderPDF({asset,markdown,outputDir,brand,sourceSha256}) {
  const binary = await renderer();
  const blocks = pdfBlocks(markdown);
  const payload = {assetId:asset.id,brand:asset.metadata?.brand || 'Campaign',title:blocks.find(b=>b.kind==='title')?.text || asset.title,label:asset.metadata?.documentLabel || 'Sales collateral',sourceSha256,brandIdentitySha256:brandHash(brand),style:{colors:brand.colors,regularFont:brand.typography.videoRegular,boldFont:brand.typography.videoBold,logo:asset.metadata?.brand===brand.company.name?brand.company.logo:null},blocks};
  const input = path.join(outputDir,'pdf-layout.json'), output = path.join(outputDir,'document.pdf'), verification = path.join(outputDir,'pdf-verification.json');
  await writeFile(input,JSON.stringify(payload,null,2)+'\n');
  for (const name of ['document.pdf','document-preview.png','pdf-verification.json']) await rm(path.join(outputDir,name),{force:true});
  try {await execute(binary,[input,output,verification],{timeout:60000,maxBuffer:100000});}
  catch(error) {
    const detail = /message\("([^"\n]{1,220})/.exec(String(error.stderr || ''))?.[1];
    throw new Error(detail || 'PDF rendering or content verification failed.');
  }
  const proof = JSON.parse(await readFile(verification,'utf8'));
  const bytes = await readFile(output);
  if (!bytes.subarray(0,5).equals(Buffer.from('%PDF-')) || bytes.length<1000 || proof.textVerified!==true || proof.sourceSha256!==sourceSha256 || proof.brandIdentitySha256!==brandHash(brand)) throw new Error('PDF output failed verification.');
  return proof;
}
