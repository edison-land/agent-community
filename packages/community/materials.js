import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildMaterials } from './materials-core.js';

export { buildMaterials };

/** Node loader for the material packs under examples/materials. */
export function loadMaterials(root = new URL('../../examples/materials/', import.meta.url)) {
  const base = root instanceof URL ? root.pathname : root;
  if (!existsSync(base)) return new Map();
  const packs = [];
  for (const pack of readdirSync(base).sort()) {
    const manifestPath = join(base, pack, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    packs.push({ pack, manifest, files: Object.fromEntries(manifest.files.map(({ file }) => [file, readFileSync(join(base, pack, file), 'utf8')])) });
  }
  return buildMaterials(packs);
}
