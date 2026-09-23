/**
 * REAL INTEGRATION (phase 4 recovery): live node and connector processes with
 * real local FlareMo storage are killed with SIGKILL mid-execution and
 * restarted. Execution uses the simulated Codex binary (timing control only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webUser, until, inviteAndJoin } from '../support/harness.js';
import { localState } from '../support/local.js';
import { liveNode, cli, connectorHome, startProcess, registerViaCli, claimViaWeb, FAKE_CODEX_BIN, RUNTIME } from '../support/processes.js';

const state = localState();
const account = label => state.accounts.find(item => item.label === label);

async function setup(t, mode) {
  let node = await liveNode();
  const stateDir = node.stateDir;
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: account('member-a').username, password: account('member-a').password });
  await b.post('/login', { username: account('member-b').username, password: account('member-b').password });
  await a.post('/community', { communityName: 'Live Recovery Community', displayName: 'Member A' });
  await inviteAndJoin(a, b, 'Member B');
  const c = connectorHome({ fakeMode: mode }); t.after(c.cleanup);
  const claimed = await claimViaWeb(b, await registerViaCli(node, c.env, { codexHome: c.codexHome }), { agentName: 'B agent' });
  const capability = await b.post('/capabilities', { agentId: claimed.agentId, title: 'Research', description: 'x' });
  const request = await a.post('/requests', { title: 'Recovery probe', description: 'x', capabilityId: capability.id, acceptanceCriteria: ['x'], materialPaths: ['oss-licenses/mit.md'] });
  const card = (await b.get('/confirmations')).find(item => item.requestId === request.id);
  const restartNode = async () => {
    node.kill('SIGKILL'); await node.exited;
    node = await liveNode({ COMMUNITY_STATE_DIR: stateDir });
    return node;
  };
  t.after(() => node.close());
  return { get node() { return node; }, a, b, c, request, card, restartNode };
}

test('node killed mid-execution: connector reconnects, delivers once; state survives in FlareMo', async t => {
  const env = await setup(t, 'slow:6000');
  const connector = startProcess('apps/connector/cli.js', ['start', '--codex-bin', FAKE_CODEX_BIN], env.c.env); t.after(() => connector.stop());
  await connector.waitFor(/"event":"connected"/);
  await env.b.post(`/requests/${env.request.id}/confirm`, { cardHash: env.card.cardHash, timeLimitSeconds: 120 });
  await connector.waitFor(/"event":"codex-started"/, 30000);
  await env.restartNode();
  await connector.waitFor(/"event":"disconnected"/, 15000).catch(() => null);
  // Node runtime: sessions live in process memory, so members sign in again after a restart
  // (the Worker keeps them in Durable Object storage; signing in again is harmless there).
  if (RUNTIME === 'worker') assert.ok((await env.a.get('/state')).me?.member, 'Worker: the session survived the restart');
  await env.a.post('/login', { username: account('member-a').username, password: account('member-a').password });
  const view = await until(async () => { const v = await env.a.get(`/requests/${env.request.id}`); return v.artifacts.length && v; }, { timeoutMs: 60000, intervalMs: 500 });
  assert.equal(view.executions[0].data.status, 'succeeded');
  assert.equal(view.executions[0].data.claimCount, 1, 'claimed once, never re-dispatched');
  assert.equal(connector.lines.filter(line => line.includes('"event":"codex-started"')).length, 1);
  assert.equal(view.request.data.status, 'review');
});

test('connector killed mid-execution: restart kills the orphan and reports "status pending"; no blind re-run', async t => {
  const env = await setup(t, 'hang');
  let connector = startProcess('apps/connector/cli.js', ['start', '--codex-bin', FAKE_CODEX_BIN], env.c.env);
  await connector.waitFor(/"event":"connected"/);
  const confirmed = await env.b.post(`/requests/${env.request.id}/confirm`, { cardHash: env.card.cardHash, timeLimitSeconds: 120 });
  await connector.waitFor(/"event":"codex-started"/, 30000);
  const pid = Number(JSON.parse(connector.lines.find(line => line.includes('"event":"codex-started"'))).pid);
  connector.child.kill('SIGKILL'); await connector.exited;
  assert.doesNotThrow(() => process.kill(pid, 0), 'the Codex child outlives a killed connector');
  connector = startProcess('apps/connector/cli.js', ['start', '--codex-bin', FAKE_CODEX_BIN], env.c.env); t.after(() => connector.stop());
  await connector.waitFor(/"event":"reported".*"outcome":"unknown"/, 30000);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeoutMs: 10000 });
  const view = await env.a.get(`/requests/${env.request.id}`);
  const execution = view.executions.find(item => item.id === confirmed.executionId);
  assert.deepEqual([execution.data.status, execution.data.failureCode], ['unknown', 'CONNECTOR_RESTARTED']);
  assert.equal(connector.lines.filter(line => line.includes('"event":"codex-started"')).length, 0, 'not re-run');
  const status = JSON.parse((await cli('apps/connector/cli.js', ['status'], env.c.env)).stdout);
  assert.equal(status.receipts[0].state, 'reported');
});
