// SIMULATED (phase 4): connector runtime + gateway with a simulated Codex CLI
// binary (same JSONL shapes as real codex-cli 0.153.4). No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../packages/connector/codex.js';
import { simulatedNode, communityWithAgent, until, FAKE_CODEX } from './support/harness.js';

async function confirmed(env, node, timeLimitSeconds = 60) {
  const request = await env.a.post('/requests', { title: '许可证调研', description: '比较', capabilityId: env.capability.id, acceptanceCriteria: ['有来源'], materialPaths: ['oss-licenses/mit.md', 'oss-licenses/apache-2.0.md', 'oss-licenses/agpl-3.0.md'] });
  const card = (await env.b.get('/confirmations')).find(item => item.requestId === request.id);
  const result = await env.b.post(`/requests/${request.id}/confirm`, { cardHash: card.cardHash, timeLimitSeconds });
  await until(async () => (await node.service.get('Execution', result.executionId)).data.status === 'queued');
  return { request, executionId: result.executionId };
}
const execution = (node, id) => node.service.get('Execution', id);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('success: report + sources uploaded as a hash-pinned Artifact; full event log stays local', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const { request, executionId } = await confirmed(env, node);
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });
  const done = await until(async () => { const e = await execution(node, executionId); return e.data.status === 'succeeded' && e; });
  assert.deepEqual(done.data.usage, { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300 });
  const view = await env.a.get(`/requests/${request.id}`);
  assert.equal(view.request.data.status, 'review');
  assert.equal(view.grants[0].data.status, 'consumed');
  const artifact = await env.a.get(`/artifacts/${done.data.artifactId}`);
  assert.match(artifact.content, /## 来源/);
  assert.match(artifact.content, /materials\/agpl-3.0.md/);
  assert.doesNotMatch(artifact.content, /thread\.started|turn\.completed/);
  const receipt = env.state.receipt(executionId);
  assert.equal(receipt.state, 'reported');
  assert.ok(existsSync(join(env.state.executionDir(executionId), 'events.jsonl')), 'raw Codex events kept locally');
  controller.abort(); await run;
});

test('failure is reported with a reason code; the agent never marks work accepted', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node, { connectorOptions: { mode: 'fail' } }); t.after(env.cleanup);
  const { executionId } = await confirmed(env, node);
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });
  const failed = await until(async () => { const e = await execution(node, executionId); return e.data.status === 'failed' && e; });
  assert.equal(failed.data.failureCode, 'CODEX_EXIT_1');
  assert.match(failed.data.progress.at(-1).message, /simulated model error/);
  assert.equal(failed.data.a2a.state, 'TASK_STATE_FAILED');
  controller.abort(); await run;
});

test('timeout: the Codex process group is stopped and reported as TIMEOUT', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'community-timeout-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codexHome = join(dir, 'home'); rmSync(codexHome, { force: true, recursive: true });
  (await import('node:fs')).mkdirSync(codexHome); writeFileSync(join(codexHome, 'fake-mode'), 'hang');
  const task = { executionId: 'urn:uuid:00000000-0000-4000-8000-000000000001', request: { title: 't', description: 'd', acceptanceCriteria: ['x'] }, grant: { timeLimitSeconds: 1 }, materials: [] };
  const handle = runCodex({ codexBin: FAKE_CODEX, codexHome, model: 'm', task, dir: join(dir, 'exec') });
  const outcome = await handle.done;
  assert.deepEqual([outcome.outcome, outcome.code], ['failed', 'TIMEOUT']);
  await until(() => !alive(handle.pid), { timeoutMs: 8000 });
});

test('revoking the grant mid-run stops Codex and the stop is confirmed', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node, { connectorOptions: { mode: 'hang' } }); t.after(env.cleanup);
  const { executionId } = await confirmed(env, node);
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });
  await until(async () => (await execution(node, executionId)).data.status === 'running');
  const pid = env.state.receipt(executionId).pid;
  await env.b.post(`/grants/${(await execution(node, executionId)).data.grantId}/revoke`);
  const stopped = await until(async () => { const e = await execution(node, executionId); return e.data.status === 'cancelled' && e; });
  assert.equal(stopped.data.cancelConfirmed, true);
  await until(() => !alive(pid), { timeoutMs: 8000 });
  controller.abort(); await run;
});

test('unbinding mid-run: platform access ends at once; the stop stays "unconfirmed"', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node, { connectorOptions: { mode: 'hang' } }); t.after(env.cleanup);
  const { executionId } = await confirmed(env, node);
  const run = env.connector.run();
  await until(async () => (await execution(node, executionId)).data.status === 'running');
  const pid = env.state.receipt(executionId).pid;
  await env.b.post(`/agents/${env.agent.id}/revoke`);
  const result = await run;
  assert.equal(result.stopped, 'BINDING_REVOKED');
  await until(() => !alive(pid), { timeoutMs: 8000 });
  const after = await execution(node, executionId);
  assert.deepEqual([after.data.status, after.data.cancelConfirmed], ['cancel-requested', false], 'revoked connector cannot confirm; UI shows 停止未确认');
});

test('connector restart: finished-but-unreported work is recovered, never re-run', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const { executionId } = await confirmed(env, node);
  // First connector process claims and starts, then "crashes" after Codex wrote its result.
  const token = env.state.load().token;
  const claim = await (await fetch(`${node.url}/connector/v1/tasks/next?wait=0`, { headers: { authorization: `Bearer ${token}` } })).json();
  await fetch(`${node.url}/connector/v1/executions/${executionId.slice(9)}/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'started' }) });
  const dir = env.state.executionDir(executionId);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ report_markdown: '# 崩溃前完成的报告', sources: [{ title: 'MIT', locator: 'materials/mit.md' }] }));
  env.state.writeReceipt(executionId, { state: 'started', pid: 999999, claimedTaskId: claim.task.taskId });
  writeFileSync(join(env.codexHome, 'fake-mode'), 'fail'); // would fail loudly if re-run
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });
  const done = await until(async () => { const e = await execution(node, executionId); return e.data.status === 'succeeded' && e; });
  const artifact = await env.a.get(`/artifacts/${done.data.artifactId}`);
  assert.match(artifact.content, /崩溃前完成的报告/);
  assert.equal(env.state.receipt(executionId).recovered, true);
  assert.ok(!existsSync(join(dir, 'events.jsonl')), 'Codex was not started again');
  controller.abort(); await run;
});

test('connector restart: an orphaned or unknown run becomes "status pending", not a blind retry', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const { executionId } = await confirmed(env, node);
  const token = env.state.load().token;
  await fetch(`${node.url}/connector/v1/tasks/next?wait=0`, { headers: { authorization: `Bearer ${token}` } });
  await fetch(`${node.url}/connector/v1/executions/${executionId.slice(9)}/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'started' }) });
  const orphan = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  env.state.writeReceipt(executionId, { state: 'started', pid: orphan.pid });
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });
  const pending = await until(async () => { const e = await execution(node, executionId); return e.data.status === 'unknown' && e; });
  assert.equal(pending.data.failureCode, 'CONNECTOR_RESTARTED');
  await until(() => !alive(orphan.pid), { timeoutMs: 8000 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await execution(node, executionId)).data.status, 'unknown', 'unknown work is not re-dispatched');
  assert.ok(!existsSync(join(env.state.executionDir(executionId), 'events.jsonl')));
  controller.abort(); await run;
});

test('claimed but never started (no receipt): safe to start after restart', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const { executionId } = await confirmed(env, node);
  const token = env.state.load().token;
  await fetch(`${node.url}/connector/v1/tasks/next?wait=0`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await execution(node, executionId)).data.status, 'claimed');
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });
  const done = await until(async () => { const e = await execution(node, executionId); return e.data.status === 'succeeded' && e; });
  assert.equal(done.data.claimCount, 1);
  assert.ok(readFileSync(join(env.state.executionDir(executionId), 'events.jsonl'), 'utf8').includes('turn.completed'));
  controller.abort(); await run;
});
