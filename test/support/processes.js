import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
export const LIVE_NODE = 'http://127.0.0.1:4320';

/** Starts a long-running process and records every stdout/stderr line. */
export function startProcess(script, args = [], env = {}, { group = false } = {}) {
  // `group`: own process group, so signals reach every child (wrangler, workerd).
  const child = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
  const lines = [];
  let buffer = '';
  const onData = chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return {
    child, lines, exited,
    async waitFor(pattern, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = lines.find(line => pattern.test(line));
        if (hit) return hit;
        if (child.exitCode !== null) throw new Error(`process exited (${child.exitCode}): ${lines.slice(-5).join(' | ')}`);
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${pattern}: ${lines.slice(-5).join(' | ')}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    },
    kill(signal = 'SIGTERM') { if (group) { try { process.kill(-child.pid, signal); } catch { /* already gone */ } } else child.kill(signal); },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null) { this.kill(signal); await exited; }
      if (group) { await new Promise(resolve => setTimeout(resolve, 300)); try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group empty */ } }
    },
  };
}

/** Runs a CLI to completion; returns stdout lines, exit code and parsed JSON lines. */
export async function cli(script, args = [], env = {}) {
  try {
    const { stdout } = await run(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, json: stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) };
  } catch (error) {
    return { code: error.code, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}`, json: String(error.stdout ?? '').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) };
  }
}

/**
 * Fresh live node on :4320 (the origin FlareMo trusts) with its own community pointer.
 * COMMUNITY_RUNTIME=worker runs the Cloudflare Worker build under `wrangler dev --local`
 * (scripts/local/worker.mjs) instead of the Node process; the state directory then
 * holds the Durable Object storage.
 */
export const RUNTIME = process.env.COMMUNITY_RUNTIME === 'worker' ? 'worker' : 'node';
export async function liveNode(extraEnv = {}) {
  const stateDir = extraEnv.COMMUNITY_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'community-live-node-'));
  const node = startProcess(RUNTIME === 'worker' ? 'scripts/local/worker.mjs' : 'apps/node/server.js', [], {
    FLAREMO_LOCAL_STATE: join(process.env.AGENT_COMMUNITY_HOME ?? join(homedir(), '.agent-community'), 'local', 'flaremo.json'), ...extraEnv, COMMUNITY_STATE_DIR: stateDir,
  }, { group: RUNTIME === 'worker' });
  await node.waitFor(/Agent Community node \(live/, RUNTIME === 'worker' ? 120000 : 20000);
  return { ...node, url: LIVE_NODE, stateDir, async close() { await node.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
}

/** Isolated connector home; `codexBin` defaults to the real `codex` on PATH. */
export function connectorHome({ fakeMode } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'community-live-connector-'));
  const codexHome = join(home, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  if (fakeMode) writeFileSync(join(codexHome, 'fake-mode'), fakeMode);
  return { home, codexHome, env: { AGENT_COMMUNITY_HOME: home }, setMode: mode => writeFileSync(join(codexHome, 'fake-mode'), mode), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export const FAKE_CODEX_BIN = join(ROOT, 'test/fixtures/fake-codex.mjs');

/**
 * Live connection path (the only one): `connector register` prints a claim
 * link and fingerprint; the member claims it with the last four characters.
 */
export async function registerViaCli(node, env, { codexBin = FAKE_CODEX_BIN, codexHome, model = 'gpt-5.4-mini', models = [], name = 'live connector', profile, memory = 'without' } = {}) {
  const args = ['register', '--node', node.url, '--memory', memory, '--model', model, '--codex-home', codexHome, '--name', name, '--no-wait', ...(models.length ? ['--models', models.join(',')] : []), ...(codexBin ? ['--codex-bin', codexBin] : []), ...(profile ? ['--profile', profile] : [])];
  const result = await cli('apps/connector/cli.js', args, env);
  if (result.code !== 0) throw new Error(`register failed: ${result.stdout}`);
  const claimUrl = result.stdout.match(/(http:\/\/127\.0\.0\.1:\d+\/claim\/[A-Z0-9-]+)/u)[1];
  const fingerprint = result.stdout.match(/连接器指纹：([0-9a-f-]{19})/u)[1].replaceAll('-', '');
  return { claimUrl, code: claimUrl.split('/').pop(), fingerprint, stdout: result.stdout };
}

export async function claimViaWeb(member, registered, { agentId, agentName = 'B 的调研 Agent' } = {}) {
  return member.post(`/claims/${registered.code}`, { fingerprintSuffix: registered.fingerprint.slice(-4), ...(agentId ? { agentId } : { agentName }) });
}
