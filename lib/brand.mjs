import {readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const brandHash = brand => createHash('sha256').update(JSON.stringify(brand)).digest('hex');

// Only bounded data is accepted; a company theme cannot inject CSS or SVG markup.
export function validateBrand(brand) {
  const invalid = () => {throw new Error('Invalid brand identity. Use bounded colors, fonts, company name, and rectangle logo geometry.');};
  if (!brand || typeof brand !== 'object' || typeof brand.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(brand.id)) invalid();
  if (!brand.company || typeof brand.company.name !== 'string' || !brand.company.name.trim() || brand.company.name.length > 100 || /[<>\r\n]/.test(brand.company.name)) invalid();
  for (const name of ['graphite','steel','silver','white','muted','blue']) if (!/^#[0-9a-f]{6}$/i.test(brand.colors?.[name])) invalid();
  if (Object.keys(brand.colors).some(key => !['graphite','steel','silver','white','muted','blue'].includes(key))) invalid();
  for (const name of ['sans','mono','videoRegular','videoBold']) if (typeof brand.typography?.[name] !== 'string' || !/^[a-zA-Z0-9 ,"'_-]{1,160}$/.test(brand.typography[name])) invalid();
  const logo = brand.company.logo;
  if (logo != null) {
    if (!Array.isArray(logo.viewBox) || logo.viewBox.length !== 4 || logo.viewBox.some(n => !Number.isFinite(n) || n < 0 || n > 4096) || logo.viewBox[2] <= 0 || logo.viewBox[3] <= 0 || !Array.isArray(logo.rects) || !logo.rects.length || logo.rects.length > 32) invalid();
    for (const rect of logo.rects) for (const key of ['x','y','width','height']) if (!Number.isFinite(rect?.[key]) || rect[key] < 0 || rect[key] > 4096) invalid();
  }
  return brand;
}

export const BRAND = validateBrand(JSON.parse(readFileSync(new URL('../brand/identity.json', import.meta.url), 'utf8')));
export const BRAND_HASH = brandHash(BRAND);

export async function loadBrand(identityPath) {
  if (!identityPath) return BRAND;
  try {
    if ((await fs.stat(identityPath)).size > 16384) throw new Error();
    return validateBrand(JSON.parse(await fs.readFile(identityPath, 'utf8')));
  } catch {throw new Error('Could not load the configured company brand. Check its identity file before starting.');}
}

export function brandCSS(brand = BRAND) {
  validateBrand(brand);
  const colors = Object.entries(brand.colors).map(([name, value]) => `--brand-${name}:${value};`);
  return `:root{${colors.join('')}--brand-sans:${brand.typography.sans};--brand-mono:${brand.typography.mono};}\n`;
}

export function brandLogoSVG(brand = BRAND, size = 80) {
  validateBrand(brand);
  const logo = brand.company.logo;
  const relay = !logo && brand.company.mark === 'relay';
  const name = `${brand.company.name} ${logo ? 'signal mark' : relay ? 'Relay mark' : 'monogram'}`;
  if (relay) return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${escape(name)}"><rect x="1" y="1" width="62" height="62" fill="#0E1B27" stroke="#00B2FF" stroke-width="1.4"/><path d="M12 32H27L39 15H51 M27 32H51 M27 32L39 49H51" fill="none" stroke="#00B2FF" stroke-width="4.6" stroke-linejoin="bevel"/><path d="M47 11H55V19H47Z M47 28H55V36H47Z M47 45H55V53H47Z" fill="#00B2FF"/><rect x="9" y="28" width="8" height="8" fill="#00B2FF"/></svg>`;
  const initials = brand.company.name.split(/\s+/).map(word => word[0]).slice(0,2).join('');
  const symbol = `<text x="20" y="27" text-anchor="middle" font-family="Arial, sans-serif" font-size="21" font-weight="700">${escape(initials)}</text>`;
  const geometry = logo ? logo.rects.map(({x,y,width,height}) => `<rect x="${x}" y="${y}" width="${width}" height="${height}"/>`).join('') : `<rect x="1" y="1" width="38" height="38" fill="${brand.colors.graphite}" stroke="${brand.colors.blue}" stroke-width="1"/>${symbol}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${(logo?.viewBox || [0,0,40,40]).join(' ')}" role="img" aria-label="${escape(name)}"><g fill="${brand.colors.blue}">${geometry}</g></svg>`;
}
