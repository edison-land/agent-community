#!/usr/bin/env node
/**
 * Runs the Cloudflare Worker build of the community node (apps/worker) under
 * `wrangler dev --local` against the INDEPENDENT local FlareMo test instance.
 * Nothing is deployed and no Cloudflare account is used.
 *
 *   node scripts/local/worker.mjs                     # state in ~/.agent-community/local/worker-state
 *   COMMUNITY_STATE_DIR=/tmp/x node scripts/local/worker.mjs
 *
 * The FlareMo service PAT is passed through an --env-file written to
 * $AGENT_COMMUNITY_HOME/local/worker.env (mode 0600), never into the repository.
 * Durable Object storage (sessions, pending registrations, credentials) is
 * persisted to COMMUNITY_STATE_DIR, so a restart with the same directory keeps it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WRANGLER = 'wrangler@4.129.1';
const HOME = process.env.AGENT_COMMUNITY_HOME ?? join(homedir(), '.agent-community');
const LOCAL = join(HOME, 'local');
const state = JSON.parse(readFileSync(process.env.FLAREMO_LOCAL_STATE ?? join(LOCAL, 'flaremo.json'), 'utf8'));
const port = Number(process.env.COMMUNITY_PORT ?? 4320);
const origin = `http://127.0.0.1:${port}`;
for (const url of [state.url, origin]) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error(`Refusing non-local URL: ${url}`);
}

const persistTo = process.env.COMMUNITY_STATE_DIR ?? join(LOCAL, 'worker-state');
mkdirSync(persistTo, { recursive: true, mode: 0o700 });
mkdirSync(LOCAL, { recursive: true, mode: 0o700 });
const envFile = join(LOCAL, 'worker.env');
writeFileSync(envFile, [
  `PUBLIC_ORIGIN=${origin}`, `FLAREMO_URL=${state.url}`, `FLAREMO_SERVICE_PAT=${state.service.pat}`, 'ALLOW_LOCAL_FLAREMO=1',
].join('\n') + '\n', { mode: 0o600 });
chmodSync(envFile, 0o600);

// Non-secret switches, mirroring apps/node/server.js.
const vars = {
  COMMUNITY_OWNER_SUBJECT: process.env.COMMUNITY_OWNER_SUBJECT ?? '',
  COMMUNITY_OPEN_BOOTSTRAP: process.env.COMMUNITY_OWNER_SUBJECT ? '0' : '1',
  COMMUNITY_OPEN_JOIN: process.env.COMMUNITY_OPEN_JOIN ?? '0',
  COMMUNITY_AUTO_DISPATCH: process.env.COMMUNITY_AUTO_DISPATCH ?? '1',
  ...(process.env.COMMUNITY_REGISTRATION_TTL_MS ? { COMMUNITY_REGISTRATION_TTL_MS: process.env.COMMUNITY_REGISTRATION_TTL_MS } : {}),
};
const args = [
  '--yes', WRANGLER, 'dev', '--config', 'apps/worker/wrangler.jsonc', '--local', '--ip', '127.0.0.1', '--port', String(port),
  '--local-upstream', `127.0.0.1:${port}`, '--persist-to', persistTo, '--env-file', envFile, '--show-interactive-dev-session=false',
  ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}:${value}`]),
];
// The Worker bundles connector.json and serves connector.mjs as a static asset.
const built = spawnSync(process.execPath, [join(ROOT, 'scripts/build-connector.mjs')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
if (built.status !== 0) throw new Error('npm run build:connector failed');
const child = spawn('npx', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' } });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));

// Ready once the Durable Object has started the app and reached FlareMo.
for (const deadline = Date.now() + 90000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 300))) {
  const response = await fetch(`${origin}/api/state`).catch(() => null);
  if (response?.ok) {
    const body = await response.json();
    console.log(`Agent Community node (live worker: FlareMo ${body.storeOrigin}, ${body.store}): ${origin}`);
    break;
  }
  if (response && response.status !== 503) { console.error(`node not ready: HTTP ${response.status} ${await response.text()}`); }
}
