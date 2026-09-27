// SIMULATED (phase 3): real A2A SDK client and gateway over loopback HTTP,
// in-memory store, fictional members, simulated Codex binary for execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { a2aClient, sendParams } from '../packages/gateway/dispatcher.js';
import { EXTENSION_URI } from '../packages/gateway/a2a.js';
import { simulatedNode, communityWithAgent, registerAndClaim, testConnector, until } from './support/harness.js';

async function order(env, { autoDispatch = false } = {}) {
  const request = await env.a.post('/requests', { title: '比较许可证', description: '调研', capabilityId: env.capability.id, acceptanceCriteria: ['有对比表'], materialPaths: ['oss-licenses/mit.md', 'oss-licenses/agpl-3.0.md'] });
  const card = (await env.b.get('/confirmations')).find(item => item.requestId === request.id);
  const confirmed = await env.b.post(`/requests/${request.id}/confirm`, { cardHash: card.cardHash, timeLimitSeconds: 60 });
  if (autoDispatch) return { request, confirmed };
  const handoff = await env.a.post(`/executions/${confirmed.executionId}/credential`);
  return { request, confirmed, handoff };
}
async function rpc(url, token, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'A2A-Extensions': EXTENSION_URI, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const reason = res => res.body.error?.data?.[0]?.reason;

test('agent card declares A2A 1.0 JSON-RPC, the required community extension and bearer auth', async t => {
  const node = await simulatedNode({ autoDispatch: false }); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const { handoff } = await order(env);
  const card = await (await fetch(node.service.cardUrl(env.agent.id), { headers: { authorization: `Bearer ${handoff.credential}` } })).json();
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.deepEqual(card.capabilities.extensions.map(e => [e.uri, e.required]), [[EXTENSION_URI, true]]);
  assert.equal(card.securitySchemes.executionBearer.httpAuthSecurityScheme.scheme, 'Bearer');
  assert.deepEqual(card.skills.map(skill => skill.name).sort(), ['文档审阅', '资料调研报告'], 'skills are the capabilities from the agent profile');
});

test('send, retried send, get, stream and completion (not acceptance) through the SDK', async t => {
  const node = await simulatedNode({ autoDispatch: false }); t.after(node.close);
  const env = await communityWithAgent(node, { connectorOptions: { mode: 'slow' } }); t.after(env.cleanup);
  const { handoff, confirmed } = await order(env);
  const client = await a2aClient({ endpoint: handoff.endpoint, credential: handoff.credential });
  const task = await client.sendMessage(sendParams(handoff.message));
  assert.equal(task.status.state, 1);
  const again = await client.sendMessage(sendParams(handoff.message));
  assert.equal(again.id, task.id, 'retried dispatch returns the same task');
  const different = await rpc(handoff.endpoint, handoff.credential, { jsonrpc: '2.0', id: 9, method: 'SendMessage', params: { message: { ...handoff.message, messageId: 'another' } } });
  assert.equal(reason(different), 'EXECUTION_ALREADY_DISPATCHED');
  assert.equal((await node.service.get('Execution', confirmed.executionId)).data.status, 'queued');

  // Live stream while the (simulated) connector runs the task.
  const controller = new AbortController();
  const running = env.connector.run({ signal: controller.signal });
  t.after(() => controller.abort());
  const states = [];
  const stream = client.resubscribeTask({ tenant: '', id: task.id });
  let artifactText = '';
  for await (const event of stream) {
    if (event.payload.$case === 'statusUpdate') states.push(event.payload.value.status.state);
    if (event.payload.$case === 'artifactUpdate') artifactText = event.payload.value.artifact.parts[0].content.value;
    if (states.at(-1) === 3) break;
  }
  assert.ok(states.includes(2), 'WORKING observed on the stream');
  assert.equal(states.at(-1), 3);
  assert.match(artifactText, /模拟报告/);
  const done = await client.getTask({ tenant: '', id: task.id });
  assert.equal(done.status.state, 3);
  assert.equal(done.metadata[EXTENSION_URI].platformStatus, 'succeeded');
  const request = await node.service.get('Request', (await node.service.get('Execution', confirmed.executionId)).data.requestId);
  assert.equal(request.data.status, 'review', 'A2A completed does not accept the request');
  assert.equal((await node.service.list('Attestation')).length, 0);
  controller.abort(); await running;
});

test('forged identity, wrong audience, missing extension and revoked grants are refused', async t => {
  const node = await simulatedNode({ autoDispatch: false }); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const { handoff, confirmed } = await order(env);
  const meta = handoff.message.metadata[EXTENSION_URI];
  const send = (message, token = handoff.credential, url = handoff.endpoint, headers) => rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message } }, headers);
  const withMeta = patch => ({ ...handoff.message, metadata: { [EXTENSION_URI]: { ...meta, ...patch } } });

  assert.equal((await send(handoff.message, null)).status, 401);
  assert.equal(reason(await send(handoff.message, `aex_${confirmed.executionId.slice(9)}_${'x'.repeat(43)}`)), 'CALLER_UNAUTHENTICATED');
  const forged = await send(withMeta({ actor: { kind: 'Human', id: meta.recipientAgentId, principalId: meta.recipientAgentId } }));
  assert.deepEqual([forged.status, reason(forged)], [403, 'FORGED_PRINCIPAL']);
  assert.equal(reason(await send(withMeta({ grantId: 'urn:uuid:00000000-0000-4000-8000-000000000000' }))), 'METADATA_MISMATCH:grantId');
  assert.equal(reason(await send(withMeta({ communityId: 'urn:uuid:00000000-0000-4000-8000-000000000000' }))), 'METADATA_MISMATCH:communityId');
  assert.equal(reason(await send(handoff.message, handoff.credential, handoff.endpoint, { 'A2A-Extensions': '' })), 'EXTENSION_REQUIRED');
  const other = await registerAndClaim(node, env.b, { connector: testConnector(), agentName: 'Other agent', name: 'second connector' }); t.after(other.cleanup);
  const audience = await send(handoff.message, handoff.credential, node.service.endpointUrl(other.agent.id));
  assert.deepEqual([audience.status, reason(audience)], [403, 'WRONG_AUDIENCE']);
  assert.equal(reason(await rpc(handoff.endpoint, handoff.credential, { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: 'not-mine' } })), 'TASK_NOT_IN_GRANT');
  assert.equal((await rpc(handoff.endpoint, handoff.credential, { jsonrpc: '2.0', id: 3, method: 'ListTasks', params: {} })).body.error.code, -32601);

  // Cross-community: a credential minted by another community node is unknown here.
  const foreignNode = await simulatedNode({ autoDispatch: false }); t.after(foreignNode.close);
  const foreign = await communityWithAgent(foreignNode); t.after(foreign.cleanup);
  const foreignOrder = await order(foreign);
  assert.equal(reason(await send(foreignOrder.handoff.message, foreignOrder.handoff.credential)), 'CALLER_UNAUTHENTICATED');

  // Revoked grant: dispatch refused; nothing is queued for the connector.
  await env.b.post(`/grants/${(await node.service.get('Execution', confirmed.executionId)).data.grantId}/revoke`);
  assert.equal(reason(await send(handoff.message)), 'GRANT_NOT_ACTIVE');
  assert.equal((await node.service.get('Execution', confirmed.executionId)).data.status, 'cancelled');
});

test('cancel: queued work is canceled at once; running work waits for the connector to confirm', async t => {
  const node = await simulatedNode({ autoDispatch: false }); t.after(node.close);
  const env = await communityWithAgent(node, { connectorOptions: { mode: 'hang' } }); t.after(env.cleanup);
  const first = await order(env);
  const client = await a2aClient({ endpoint: first.handoff.endpoint, credential: first.handoff.credential });
  const queued = await client.sendMessage(sendParams(first.handoff.message));
  const canceled = await client.cancelTask({ tenant: '', id: queued.id, metadata: {} });
  assert.equal(canceled.status.state, 5);
  assert.equal((await node.service.get('Execution', first.confirmed.executionId)).data.status, 'cancelled');

  const second = await order(env);
  const client2 = await a2aClient({ endpoint: second.handoff.endpoint, credential: second.handoff.credential });
  const task = await client2.sendMessage(sendParams(second.handoff.message));
  const controller = new AbortController();
  const running = env.connector.run({ signal: controller.signal });
  t.after(() => controller.abort());
  await until(async () => (await node.service.get('Execution', second.confirmed.executionId)).data.status === 'running');
  const pending = await client2.cancelTask({ tenant: '', id: task.id, metadata: {} });
  assert.equal(pending.status.state, 2, 'not reported as canceled before the runtime stops');
  assert.equal(pending.metadata[EXTENSION_URI].stopUnconfirmed, true);
  await until(async () => (await node.service.get('Execution', second.confirmed.executionId)).data.status === 'cancelled');
  const final = await client2.getTask({ tenant: '', id: task.id });
  assert.equal(final.status.state, 5);
  assert.equal((await node.service.get('Execution', second.confirmed.executionId)).data.cancelConfirmed, true);
  controller.abort(); await running;
});

test('a follow-up may only continue its own workroom context', async t => {
  const node = await simulatedNode({ autoDispatch: false }); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const { handoff } = await order(env);
  const res = await rpc(handoff.endpoint, handoff.credential, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { ...handoff.message, contextId: 'context-from-elsewhere' } } });
  assert.deepEqual([res.status, reason(res)], [403, 'CONTEXT_NOT_IN_WORKROOM']);
});

test('the agent card is not public: members and holders of an execution credential for that agent only', async t => {
  const node = await simulatedNode({ autoDispatch: false }); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const url = node.service.cardUrl(env.agent.id);
  const status = async headers => (await fetch(url, { headers })).status;
  assert.equal(await status({}), 401, 'anonymous');
  assert.equal(await status({ authorization: 'Bearer aex_00000000-0000-4000-8000-000000000000_forged' }), 401, 'forged credential');
  const unknown = node.service.cardUrl('urn:uuid:00000000-0000-4000-8000-00000000abcd');
  assert.equal((await fetch(unknown)).status, 401, 'an outsider cannot tell whether an agent exists');
  // A signed-in active member reads it with the session cookie.
  const cookie = await (async () => { const r = await fetch(`${node.url}/api/login`, { method: 'POST', headers: { origin: node.url, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-maker' }) }); return r.headers.getSetCookie()[0].split(';')[0]; })();
  assert.equal(await status({ cookie }), 200, 'member session');
  const { handoff } = await order(env);
  assert.equal(await status({ authorization: `Bearer ${handoff.credential}` }), 200, 'execution credential for this agent');
  // A credential for this agent does not open another agent's card.
  const other = await registerAndClaim(node, env.b, { connector: testConnector({ profile: 'second' }), name: 'second' }); t.after(other.cleanup);
  assert.equal((await fetch(node.service.cardUrl(other.agent.id), { headers: { authorization: `Bearer ${handoff.credential}` } })).status, 403);
  // The requester-side SDK client sends its credential for the card as well.
  const client = await a2aClient({ endpoint: handoff.endpoint, credential: handoff.credential });
  assert.equal((await client.getAgentCard()).name, env.agent.data.displayName);
});

