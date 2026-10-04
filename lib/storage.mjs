import fs from 'node:fs/promises';
import path from 'node:path';

// Human-readable paths identify the asset; content hashes remain in manifests.
export function folderSlug(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '') || 'asset';
}

export function assetFolder(asset) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(asset.id) || !/^[a-z][a-z-]*$/.test(asset.channel)) throw new Error('Invalid asset folder identity.');
  return `${asset.channel}/${asset.id}-${folderSlug(asset.title)}`;
}

export async function reserveFolder(root, parent, prefix, digits = 2) {
  if (!/^[a-z0-9-]+$/.test(prefix) || path.isAbsolute(parent) || parent.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw new Error('Invalid output folder.');
  const base = await fs.realpath(root);
  let directory = base;
  // Do not follow a replaced output directory outside the campaign.
  for (const part of parent.split('/')) {
    directory = path.join(directory, part);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Output folder must be a regular directory.');
  }
  for (let version = 1; version <= 999999; version++) {
    const name = `${prefix}${String(version).padStart(digits, '0')}`;
    try {
      await fs.mkdir(path.join(directory, name));
      return `${parent}/${name}`;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Output version limit reached.');
}
