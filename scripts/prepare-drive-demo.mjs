import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {referencedCampaignFiles} from '../lib/sample-fingerprint.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function prepare(destination) {
  if (!destination) throw new Error('Usage: node scripts/prepare-drive-demo.mjs /path/to/new-drive-copy');
  const target = path.resolve(destination);
  const source = path.join(ROOT, 'fictitious-ai/campaigns/pro500');
  const brand = path.join(ROOT, 'fictitious-ai/brand/identity.json');
  const {files} = await referencedCampaignFiles(source, {brandPath:brand});
  await fs.mkdir(target, {recursive:false, mode:0o700});
  try {
    for (const entry of files) {
      const output = path.join(target, ...entry.path.split('/'));
      await fs.mkdir(path.dirname(output), {recursive:true, mode:0o700});
      await fs.copyFile(entry.actualPath, output, fs.constants.COPYFILE_EXCL);
      // copyFile inherits the source mode; the prepared copy stays private to this user.
      await fs.chmod(output, 0o600);
    }
  } catch (error) {
    throw new Error(`Could not prepare the copy at ${target}. The incomplete destination was left in place for inspection; remove it yourself before retrying. ${error.message}`);
  }
  process.stdout.write(`Prepared ${target}\n104 deliverables, ${files.length} referenced files including campaign.json and brand/identity.json.\nNo Drive access or upload was attempted.\n`);
}

prepare(process.argv[2]).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
