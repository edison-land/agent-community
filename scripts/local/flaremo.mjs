#!/usr/bin/env node
/**
 * Operator tooling for an INDEPENDENT local FlareMo test instance (RFC 0007).
 * It never targets a public instance: every URL must be http://127.0.0.1.
 *
 *   FLAREMO_DIR=/path/to/flaremo-copy node scripts/local/flaremo.mjs prepare
 *   FLAREMO_DIR=... node scripts/local/flaremo.mjs start        # foreground wrangler dev
 *   node scripts/local/flaremo.mjs bootstrap                    # owner, 2 test members, service PAT
 *
 * Generated local secrets and synthetic test-account passwords are written only
 * to $AGENT_COMMUNITY_HOME/local (default ~/.agent-community/local, mode 0600)
 * and FLAREMO_DIR/.dev.vars (ignored by FlareMo's git). Nothing is printed.
 */
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.AGENT_COMMUNITY_HOME ?? join(homedir(), '.agent-community');
const LOCAL = join(HOME, 'local');
const STATE = join(LOCAL, 'flaremo.json');
const FLAREMO_URL = process.env.FLAREMO_URL ?? 'http://127.0.0.1:8787';
const NODE_ORIGIN = process.env.COMMUNITY_ORIGIN ?? 'http://127.0.0.1:4320';
const PNPM = ['corepack', ['pnpm@11.7.0']];

function assertLocal(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error(`Refusing non-local URL: ${url}`);
}
assertLocal(FLAREMO_URL); assertLocal(NODE_ORIGIN);

function flaremoDir() {
  const dir = process.env.FLAREMO_DIR;
  if (!dir || !existsSync(join(dir, 'apps/worker/src/routes/community-api.ts'))) {
    throw new Error('Set FLAREMO_DIR to a FlareMo copy that contains the community object extension.');
  }
  return dir;
}
function pnpm(dir, args, options = {}) {
  const result = spawnSync(PNPM[0], [...PNPM[1], ...args], { cwd: dir, stdio: 'inherit', env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }, ...options });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}
const secret = () => randomBytes(32).toString('base64url');
function saveState(state) {
  mkdirSync(LOCAL, { recursive: true, mode: 0o700 });
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(STATE, 0o600);
}
export function loadLocalState() { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null; }

async function prepare() {
  const dir = flaremoDir();
  if (!existsSync(join(dir, 'wrangler.jsonc'))) copyFileSync(join(dir, 'wrangler.json'), join(dir, 'wrangler.jsonc'));
  const vars = join(dir, '.dev.vars');
  if (!existsSync(vars)) {
    const state = loadLocalState() ?? {};
    state.ownerPassword ??= secret();
    state.bootstrapSecret ??= secret();
    saveState(state);
    writeFileSync(vars, [
      '# Local-only FlareMo test instance for Agent Community. Generated; not for production.',
      'FLAREMO_SINGLE_USER_EMAIL=owner@community.test',
      'FLAREMO_SINGLE_USER_NAME=Local Owner',
      `FLAREMO_PUBLIC_URL=${FLAREMO_URL}`,
      `FLAREMO_TRUSTED_ORIGINS=${NODE_ORIGIN}`,
      `BETTER_AUTH_SECRET=${secret()}`,
      `FLAREMO_BOOTSTRAP_SECRET=${state.bootstrapSecret}`,
      '',
    ].join('\n'), { mode: 0o600 });
  }
  if (!existsSync(join(dir, 'apps/web/dist/index.html'))) pnpm(dir, ['--filter', '@flaremo/web', 'exec', 'vite', 'build']);
  pnpm(dir, ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', 'wrangler.jsonc']);
  console.log('Local FlareMo prepared (migrations applied to .wrangler/state).');
}

function start() {
  const dir = flaremoDir();
  const child = spawn(PNPM[0], [...PNPM[1], 'exec', 'wrangler', 'dev', '--config', 'wrangler.jsonc', '--local', '--ip', '127.0.0.1', '--port', new URL(FLAREMO_URL).port || '8787', '--show-interactive-dev-session=false'], {
    cwd: dir, stdio: 'inherit', env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code ?? 0));
}

// ---- HTTP helpers against the local instance ----
async function call(path, { method = 'GET', body, cookie, token, headers = {} } = {}) {
  const response = await fetch(`${FLAREMO_URL}${path}`, {
    method, redirect: 'error',
    headers: { accept: 'application/json', origin: FLAREMO_URL, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, cookies: response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') };
}
const must = (result, ...ok) => { if (!ok.includes(result.status)) throw new Error(`Unexpected HTTP ${result.status}: ${JSON.stringify(result.json)?.slice(0, 200)}`); return result; };

async function signIn(username, password) {
  return must(await call('/api/auth/sign-in/username', { method: 'POST', body: { username, password } }), 200).cookies;
}

async function createMember(ownerCookie, { label, name, email }) {
  const created = must(await call('/api/app/admin/users', { method: 'POST', cookie: ownerCookie, body: { name, email } }), 201).json;
  const token = new URL(created.activation_path, FLAREMO_URL).searchParams.get('token');
  const password = secret();
  must(await call('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: password } }), 200);
  return { label, id: created.id, username: created.username, email, password };
}

async function bootstrap() {
  const state = loadLocalState() ?? fail('Run prepare first.');
  if (state.service) { console.log('Local FlareMo already bootstrapped; state kept.'); return; }
  const status = must(await call('/api/auth/flaremo/bootstrap/status'), 200).json;
  if (!status?.initialized) {
    must(await call('/api/auth/flaremo/bootstrap', { method: 'POST', headers: { 'x-flaremo-bootstrap-secret': state.bootstrapSecret }, body: { username: 'owner', name: 'Local Owner', email: 'owner@community.test', password: state.ownerPassword } }), 201);
  }
  const owner = await signIn('owner', state.ownerPassword);
  const accounts = [];
  for (const member of [
    { label: 'member-a', name: 'Test Member A', email: 'member-a@community.test' },
    { label: 'member-b', name: 'Test Member B', email: 'member-b@community.test' },
    { label: 'community-service', name: 'Community Service', email: 'community-service@community.test' },
  ]) accounts.push(await createMember(owner, member));
  const service = accounts.find(account => account.label === 'community-service');
  const serviceCookie = await signIn(service.username, service.password);
  const pat = must(await call('/api/app/account/personal-access-tokens', { method: 'POST', cookie: serviceCookie, body: { name: 'agent-community', expires_in_days: 30 } }), 201).json;
  must(await call('/api/community/v1/service-accounts', { method: 'POST', cookie: owner, body: { userId: service.id, status: 'active' } }), 200);
  saveState({ ...state, url: FLAREMO_URL, nodeOrigin: NODE_ORIGIN, accounts: accounts.filter(a => a.label !== 'community-service'), service: { userId: service.id, username: service.username, pat: pat.token } });
  console.log(`Bootstrapped local FlareMo: 2 synthetic test members and one service account. State: ${STATE}`);
}
function fail(message) { throw new Error(message); }

const command = process.argv[2];
const commands = { prepare, start, bootstrap };
if (!commands[command]) { console.error('Usage: node scripts/local/flaremo.mjs prepare|start|bootstrap'); process.exit(2); }
try { await commands[command](); } catch (error) { console.error(error.message); process.exit(1); }
