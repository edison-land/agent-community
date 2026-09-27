/**
 * REAL INTEGRATION (phase 3): an independent A2A client process (official SDK
 * 1.2.0) talks JSON-RPC/SSE to the gateway inside the live node process; state
 * is in real local FlareMo; members sign in with real FlareMo test accounts.
 * The connector process executes with the simulated Codex binary here because
 * this phase checks A2A interoperability; phase 4 runs the real Codex CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_URI } from '../../packages/gateway/a2a.js';
import { webUser, until, inviteAndJoin } from '../support/harness.js';
import { localState } from '../support/local.js';
import { liveNode, cli, connectorHome, startProcess, registerViaCli, claimViaWeb, FAKE_CODEX_BIN } from '../support/processes.js';

const state = localState();
const account = label => state.accounts.find(item => item.label === label);

async function setup(t, fakeMode) {
  const node = await liveNode({ COMMUNITY_AUTO_DISPATCH: '0' }); t.after(() => node.close());
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: account('member-a').username, password: account('member-a').password });
  await b.post('/login', { username: account('member-b').username, password: account('member-b').password });
  await a.post('/community', { communityName: 'Live A2A Community', displayName: 'Member A' });
  await inviteAndJoin(a, b, 'Member B');
  const c = connectorHome({ fakeMode }); t.after(c.cleanup);
  const claimed = await claimViaWeb(b, await registerViaCli(node, c.env, { codexHome: c.codexHome }), { agentName: 'B agent' });
  const agent = { id: claimed.agentId };
  const capability = await b.post('/capabilities', { agentId: agent.id, title: 'Research', description: 'Public-material research' });
  const order = async () => {
    const request = await a.post('/requests', { title: 'Compare licenses', description: 'A2A live probe', capabilityId: capability.id, acceptanceCriteria: ['table'], materialPaths: ['oss-licenses/mit.md'] });
    const card = (await b.get('/confirmations')).find(item => item.requestId === request.id);
    const confirmed = await b.post(`/requests/${request.id}/confirm`, { cardHash: card.cardHash, timeLimitSeconds: 120 });
    const handoff = await a.post(`/executions/${confirmed.executionId}/credential`);
    const file = join(c.home, `handoff-${confirmed.executionId.slice(9)}.json`);
    writeFileSync(file, JSON.stringify(handoff), { mode: 0o600 });
    return { request, confirmed, handoff, file };
  };
  const client = (...args) => cli('apps/a2a-client/cli.js', args);
  return { node, a, b, agent, c, order, client };
}

test('independent A2A client process: card, send, retried send, get, SSE stream, completion ≠ acceptance', async t => {
  const env = await setup(t, 'slow');
  const first = await env.order();
  const card = (await env.client('card', '--credential-file', first.file)).json[0].card;
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.capabilities.extensions[0].uri, EXTENSION_URI);
  const sent = (await env.client('send', '--credential-file', first.file)).json[0].result.task;
  assert.equal(sent.status.state, 'TASK_STATE_SUBMITTED');
  const resent = (await env.client('send', '--credential-file', first.file)).json[0];
  assert.equal(resent.result.task.id, sent.id, 'retry returns the existing task');
  const connector = startProcess('apps/connector/cli.js', ['start', '--codex-bin', FAKE_CODEX_BIN], env.c.env); t.after(() => connector.stop());
  const done = await until(async () => { const got = (await env.client('get', '--credential-file', first.file, '--task', sent.id)).json[0].task; return got.status.state === 'TASK_STATE_COMPLETED' && got; }, { timeoutMs: 30000, intervalMs: 500 });
  assert.equal(done.metadata[EXTENSION_URI].platformStatus, 'succeeded');
  assert.match(done.artifacts[0].parts[0].text, /模拟报告/);
  const view = await env.a.get(`/requests/${first.request.id}`);
  assert.equal(view.request.data.status, 'review', 'A2A completion leaves the request awaiting human review');

  // Streaming dispatch (SendStreamingMessage over SSE) for a second order.
  const second = await env.order();
  const streamed = await env.client('send', '--credential-file', second.file, '--stream');
  const kinds = streamed.json.map(line => Object.keys(line.event)[0]);
  const states = streamed.json.map(line => line.event.statusUpdate?.status.state ?? line.event.task?.status.state).filter(Boolean);
  assert.equal(kinds[0], 'task');
  assert.ok(kinds.includes('artifactUpdate'));
  assert.ok(states.includes('TASK_STATE_WORKING'));
  assert.equal(states.at(-1), 'TASK_STATE_COMPLETED');
});

test('independent A2A client process: cancel semantics and refusals', async t => {
  const env = await setup(t, 'hang');
  const first = await env.order();
  // Forged principal and wrong audience are refused before anything is queued.
  const forged = structuredClone(first.handoff.message);
  forged.metadata[EXTENSION_URI].actor = { kind: 'Human', id: forged.metadata[EXTENSION_URI].recipientAgentId, principalId: forged.metadata[EXTENSION_URI].recipientAgentId };
  writeFileSync(join(env.c.home, 'forged.json'), JSON.stringify(forged));
  assert.match((await env.client('send', '--credential-file', first.file, '--dispatch-file', join(env.c.home, 'forged.json'))).stdout, /403|FORGED_PRINCIPAL|authorization denied/i);
  const otherHome = connectorHome({ fakeMode: 'success' }); t.after(otherHome.cleanup);
  const other = await claimViaWeb(env.b, await registerViaCli(env.node, otherHome.env, { codexHome: otherHome.codexHome, name: 'second connector' }), { agentName: 'Other agent' });
  const wrongAudience = { ...first.handoff, endpoint: first.handoff.endpoint.replace(env.agent.id.slice(9), other.agentId.slice(9)) };
  writeFileSync(join(env.c.home, 'wrong.json'), JSON.stringify(wrongAudience));
  assert.match((await env.client('send', '--credential-file', join(env.c.home, 'wrong.json'))).stdout, /403|WRONG_AUDIENCE|denied/i);

  const sent = (await env.client('send', '--credential-file', first.file)).json[0].result.task;
  const connector = startProcess('apps/connector/cli.js', ['start', '--codex-bin', FAKE_CODEX_BIN], env.c.env); t.after(() => connector.stop());
  await connector.waitFor(/"event":"codex-started"/, 30000);
  const pending = (await env.client('cancel', '--credential-file', first.file, '--task', sent.id)).json[0].task;
  assert.equal(pending.status.state, 'TASK_STATE_WORKING');
  assert.equal(pending.metadata[EXTENSION_URI].stopUnconfirmed, true);
  const canceled = await until(async () => { const got = (await env.client('get', '--credential-file', first.file, '--task', sent.id)).json[0].task; return got.status.state === 'TASK_STATE_CANCELED' && got; }, { timeoutMs: 30000, intervalMs: 500 });
  assert.equal(canceled.metadata[EXTENSION_URI].platformStatus, 'cancelled');

  // Revoked grant: the requester's client can no longer dispatch.
  const second = await env.order();
  await env.b.post(`/grants/${(await env.a.get(`/requests/${second.request.id}`)).grants[0].id}/revoke`);
  assert.match((await env.client('send', '--credential-file', second.file)).stdout, /403|GRANT_NOT_ACTIVE|denied/i);
});
