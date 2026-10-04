import fs from 'node:fs/promises';
import path from 'node:path';
import {reserveFolder} from './storage.mjs';

const fields = ['assets','campaign','marketEvidence','manifestHash','run','events','inspectedAt','latestRelease','readyRelease','driftMessage'];
const exists = async file => {try {return await fs.lstat(file);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}};

// Archive only known generated paths. Original inputs, config and credentials are never moved.
export async function resetDemoWorkspace(engine) {
  if (!(await fs.lstat(engine.controlDir)).isDirectory()) throw new Error('Demo control files must be in a regular local directory.');
  const probe = new engine.constructor({root:engine.root,campaignDir:engine.campaignDir,artifactDir:engine.artifactDir,provider:engine.provider,renderAsset:engine.renderAsset,brandIdentitySha256:engine.brandIdentitySha256});
  await probe.scan();
  if (probe.assets.some(a => a.required && a.status === 'blocked')) throw new Error('Restore missing or invalid original assets before resetting the demo.');
  for (const asset of probe.campaign.assets) for (const input of [asset.source,...(asset.files || []).map(f=>f.path)].filter(Boolean)) {
    const relative = path.relative(await fs.realpath(engine.artifactDir),await fs.realpath(path.resolve(engine.campaignDir,input)));
    if (/^(working|releases|\.launch-control)(\/|$)/.test(relative) || relative === 'READY-TO-PUBLISH') throw new Error('An original input overlaps generated files. Reset was stopped before moving anything.');
  }
  const plans = [
    ['working', 'working', 'directory'], ['releases', 'releases', 'directory'],
    ['.launch-control/history','history','directory'], ['.launch-control/release-builds','release-builds','directory'],
    ['READY-TO-PUBLISH','READY-TO-PUBLISH','symlink'], ['.launch-control/state.json','state.json','file'],
  ];
  const moves=[];
  for (const [relative,destination,kind] of plans) {
    const source=path.join(engine.artifactDir,relative), stat=await exists(source);
    if (!stat) continue;
    if (!(kind==='directory'?stat.isDirectory():kind==='symlink'?stat.isSymbolicLink():stat.isFile()) || (kind!=='symlink' && stat.isSymbolicLink())) throw new Error(`Reset cannot move the unexpected file type at ${relative}.`);
    moves.push({relative,destination});
  }
  const archiveRelative=await reserveFolder(engine.controlDir,'demo-archives','reset-',3);
  const archive=path.join(engine.controlDir,archiveRelative);
  const marker=path.join(engine.controlDir,'reset-in-progress.json');
  const receipt={schemaVersion:1,resetAt:new Date().toISOString(),campaignId:engine.campaign.id,archive:archiveRelative,moves,status:'archiving'};
  await fs.writeFile(marker,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  const previous=Object.fromEntries(fields.map(key=>[key,engine[key]]));
  const moved=[];
  try {
    for (const move of moves) {
      await fs.rename(path.join(engine.artifactDir,move.relative),path.join(archive,move.destination));
      moved.push(move);
    }
    for (const key of fields) engine[key]=probe[key];
    engine.event('demo_reset',{archive:`.launch-control/${archiveRelative}`,originalAssets:engine.assets.length});
    await engine.save();
    receipt.status='complete';
    await fs.writeFile(path.join(archive,'reset-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    await fs.unlink(marker);
    return {archive:`.launch-control/${archiveRelative}`,originalAssets:engine.assets.length};
  } catch (error) {
    for (const key of fields) engine[key]=previous[key];
    try {
      for (const move of moved.reverse()) await fs.rename(path.join(archive,move.destination),path.join(engine.artifactDir,move.relative));
      await engine.save();
      await fs.unlink(marker);
    } catch {
      // Leave the journal and archive for recovery; startup must not pretend this is a clean reset.
      throw new Error(`Demo reset could not finish its recovery. Preserve ${engine.controlDir} and restore the paths listed in reset-in-progress.json before restarting.`);
    }
    throw error;
  }
}
