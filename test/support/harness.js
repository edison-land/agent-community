import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNode } from '../../apps/node/server.js';
import { MemoryObjectStore } from '../../packages/store/memory-objects.js';
import { createMockLogin } from '../../packages/identity/mock.js';
import { ConnectorState } from '../../packages/connector/state.js';
import { Connector } from '../../packages/connector/runtime.js';

export const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));

/** Browser-like member session against a node (cookie jar + Origin header). */
export function webUser(node) {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${node.url}/api${path}`, {
      method, headers: { origin: node.url, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).find(value => value.startsWith('community_node_session='));
    if (set) cookie = set;
    const json = await response.json();
    if (!response.ok) { const error = new Error(json.error); error.status = response.status; throw error; }
    return json;
  };
  return { get: path => call('GET', path), post: (path, body = {}) => call('POST', path, body) };
}

/** Simulated node: in-memory store + fictional login. Caller must close(). */
export async function simulatedNode(options = {}) {
  const logs = [];
  const node = await startNode({ port: 0, mode: 'simulated', store: new MemoryObjectStore(), login: createMockLogin(), log: entry => logs.push(entry), ...options });
  return { ...node, logs };
}

/** Connector with its own temp home and CODEX_HOME. `mode` configures fake Codex. */
export function testConnector({ codexBin = FAKE_CODEX, mode = 'success', heartbeatMs = 300, pollWait = 1, root = mkdtempSync(join(tmpdir(), 'community-connector-')), profile = 'default' } = {}) {
  const codexHome = join(root, `codex-home-${profile}`);
  mkdirSync(codexHome, { recursive: true });
  const setMode = value => writeFileSync(join(codexHome, 'fake-mode'), value);
  setMode(mode);
  const state = new ConnectorState(profile, root);
  const logs = [];
  const connector = new Connector({ state, codexBin, heartbeatMs, pollWait, log: entry => logs.push(entry) });
  return { connector, state, codexHome, setMode, logs, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * The only connection path: the connector registers, the member opens the
 * claim link and types the last four fingerprint characters from the terminal.
 */
export async function registerAndClaim(node, member, { connector = testConnector(), models = [], agentId, agentName = 'B 的调研 Agent', name = 'test connector', memory = 'without-memory', profile, replaceProfile } = {}) {
  const registered = await connector.connector.register({ node: node.url, name, codexHome: connector.codexHome, model: 'simulated-model', models, memory });
  const code = new URL(registered.claimUrl).pathname.split('/').pop();
  const claimed = await member.post(`/claims/${code}`, { fingerprintSuffix: registered.fingerprint.slice(-4), ...(agentId ? { agentId, replaceProfile } : { agentName }), ...(profile ? { profile } : {}) });
  return { ...connector, registered, code, claimed, agent: await node.service.get('Agent', claimed.agentId) };
}

/** The owner issues a one-time invitation and the member joins with it (the only way in). */
export async function inviteAndJoin(owner, member, displayName) {
  const invite = await owner.post('/invitations', { maxUses: 1, ttlHours: 1 });
  return member.post('/join', { displayName, inviteCode: invite.code });
}

/**
 * Two members A (requester) and B (agent owner) with a verified agent. The
 * agent's capabilities come from its own profile, published at claim time;
 * `capability` is the first of them (the simulated agent's "资料调研报告").
 */
export async function communityWithAgent(node, { connectorOptions, models = [], memory } = {}) {
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: 'demo-maker' });
  await a.post('/community', { communityName: 'Simulated Community', displayName: 'A（需求方）' });
  await b.post('/login', { username: 'demo-helper' });
  await inviteAndJoin(a, b, 'B（Agent 主人）');
  const c = await registerAndClaim(node, b, { connector: testConnector(connectorOptions), models, memory });
  const capability = (await node.service.list('Capability')).find(item => item.data.providerId === c.agent.id && item.data.title === '资料调研报告');
  return { a, b, capability, ...c };
}

export async function until(check, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
