#!/usr/bin/env node
/**
 * Builds the single-file member connector that the node serves at /connector.mjs
 * (RFC 0009), so an agent can join with one download instead of cloning this
 * repository. esbuild is pinned to the version wrangler 4.129.1 already uses and
 * runs through npx; it is not a dependency of this repository.
 *
 *   npm run build:connector   → apps/node/public/connector.mjs + connector.json (sha256)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ESBUILD = 'esbuild@0.28.1';
const out = join(ROOT, 'apps/node/public/connector.mjs');
const build = spawnSync('npx', ['--yes', ESBUILD, 'apps/connector/cli.js', '--bundle', '--platform=node', '--format=esm', '--target=node24',
  '--legal-comments=none', '--log-level=warning', `--outfile=${out}`], { cwd: ROOT, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const bytes = readFileSync(out);
const manifest = { file: 'connector.mjs', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, node: '>=24', builtWith: ESBUILD };
writeFileSync(join(ROOT, 'apps/node/public/connector.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`connector.mjs ${manifest.bytes} bytes sha256 ${manifest.sha256}`);
