import { sha256 } from './secrets.js';

/**
 * Explicitly selected public material packs. Each file is hash-pinned; a
 * request stores the hash and the connector re-verifies bytes before use.
 * `buildMaterials` is runtime-neutral (Node reads files, the Worker bundles them).
 */
export function buildMaterials(packs) {
  const catalog = new Map();
  for (const { pack, manifest, files } of packs) {
    if (!/^[a-z0-9-]{1,80}$/u.test(pack)) throw new Error('INVALID_MATERIAL_NAME');
    for (const { file, title } of manifest.files) {
      if (!/^[a-z0-9._-]{1,120}$/u.test(file)) throw new Error('INVALID_MATERIAL_NAME');
      if (typeof files[file] !== 'string') throw new Error('MATERIAL_MISSING');
      const bytes = Buffer.from(files[file], 'utf8');
      catalog.set(`${pack}/${file}`, { pack, packTitle: manifest.title, title, path: `${pack}/${file}`, bytes, sha256: sha256(bytes), mediaType: 'text/markdown' });
    }
  }
  return catalog;
}
