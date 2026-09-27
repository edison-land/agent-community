/**
 * REAL INTEGRATION (phase 4): the member's real Codex CLI, logged in inside an
 * isolated CODEX_HOME, runs community tasks through the connector process.
 * Opt-in only because it uses the member's model quota:
 *   REAL_CODEX=1 CODEX_HOME_FOR_CONNECTOR=~/.agent-community/codex-home node --test test/live/codex-real.live.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EXTENSION_URI } from '../../packages/gateway/a2a.js';
import { webUser, until, inviteAndJoin } from '../support/harness.js';
import { localState } from '../support/local.js';
import { liveNode, cli, connectorHome, startProcess, registerViaCli, claimViaWeb } from '../support/processes.js';

const enabled = process.env.REAL_CODEX === '1';
const codexHome = (process.env.CODEX_HOME_FOR_CONNECTOR ?? join(homedir(), '.agent-community', 'codex-home')).replace(/^~/, homedir());
const state = enabled ? localState() : null;
const account = label => state.accounts.find(item => item.label === label);
const evidence = process.env.EVIDENCE_FILE;
const record = entry => { if (evidence) { mkdirSync(join(evidence, '..'), { recursive: true }); appendFileSync(evidence, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } };

async function setup(t, models) {
  const node = await liveNode({ COMMUNITY_AUTO_DISPATCH: '0' }); t.after(() => node.close());
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: account('member-a').username, password: account('member-a').password });
  await b.post('/login', { username: account('member-b').username, password: account('member-b').password });
  await a.post('/community', { communityName: 'Real Codex Community', displayName: 'Member A' });
  await inviteAndJoin(a, b, 'Member B');
  const c = connectorHome(); t.after(c.cleanup);
  const registered = await registerViaCli(node, c.env, { codexBin: null, codexHome, model: models[0], models, name: 'member-b real Codex' });
  assert.match(registered.stdout, /独立 CODEX_HOME，不加载个人全局指令/);
  const claimed = await claimViaWeb(b, registered, { agentName: 'B 的 Codex 调研 Agent' });
  const capability = await b.post('/capabilities', { agentId: claimed.agentId, title: '公开资料调研报告', description: '由 B 本机 Codex CLI 基于资料包撰写报告' });
  const order = async ({ title, description, criteria, model, timeLimitSeconds = 600 }) => {
    const request = await a.post('/requests', { title, description, capabilityId: capability.id, acceptanceCriteria: criteria, materialPaths: ['oss-licenses/mit.md', 'oss-licenses/apache-2.0.md', 'oss-licenses/agpl-3.0.md'] });
    const card = (await b.get('/confirmations')).find(item => item.requestId === request.id);
    const confirmed = await b.post(`/requests/${request.id}/confirm`, { cardHash: card.cardHash, timeLimitSeconds, model });
    const handoff = await a.post(`/executions/${confirmed.executionId}/credential`);
    const file = join(c.home, `handoff-${confirmed.executionId.slice(9)}.json`);
    writeFileSync(file, JSON.stringify(handoff), { mode: 0o600 });
    return { request, confirmed, handoff, file, card };
  };
  const client = (...args) => cli('apps/a2a-client/cli.js', args);
  const execution = async (requestId, executionId) => (await a.get(`/requests/${requestId}`)).executions.find(item => item.id === executionId);
  return { node, a, b, c, order, client, execution };
}

test('real Codex CLI: success, CLI failure, timeout, and connector restart', { skip: !enabled && 'set REAL_CODEX=1 to use the member model quota' }, async t => {
  const env = await setup(t, ['gpt-5.4-mini', 'gpt-invalid-model-for-failure-test']);
  let connector = startProcess('apps/connector/cli.js', ['start'], env.c.env);
  t.after(() => connector.stop());
  await connector.waitFor(/"event":"connected"/);

  // 1. Success through the independent A2A client process.
  const ok = await env.order({ title: '比较 MIT、Apache-2.0 与 AGPL-3.0 对社区平台复用代码的影响', description: '我们的社区平台以 MIT 发布，计划复用 AGPL-3.0 的 FlareMo 作为存储服务，并使用 Apache-2.0 的 A2A SDK。请基于资料包比较三种许可证在复制代码、网络服务提供和专利方面的差异，并给出对这种架构的具体建议。', criteria: ['包含三种许可证的对比表', '给出至少两条针对本架构的建议', '每个结论都能对应到资料包中的来源'], model: 'gpt-5.4-mini' });
  const started = Date.now();
  const sent = (await env.client('send', '--credential-file', ok.file)).json[0].result.task;
  const done = await until(async () => { const got = (await env.client('get', '--credential-file', ok.file, '--task', sent.id)).json[0]?.task; return ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'].includes(got?.status.state) && got; }, { timeoutMs: 600000, intervalMs: 2000 });
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(done.status));
  const view = await env.a.get(`/requests/${ok.request.id}`);
  const execution = view.executions[0];
  const report = (await env.a.get(`/artifacts/${execution.data.artifactId}`)).content;
  assert.match(report, /## 来源/);
  assert.equal(view.request.data.status, 'review');
  const status = JSON.parse((await cli('apps/connector/cli.js', ['status'], env.c.env)).stdout);
  const dir = join(env.c.home, 'connector', 'default', 'executions', execution.id.slice(9));
  assert.ok(existsSync(join(dir, 'events.jsonl')));
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(report, /"type":"turn\./);
  record({ case: 'real-success', model: 'gpt-5.4-mini', seconds: Math.round((Date.now() - started) / 1000), usage: execution.data.usage, reportSha256: view.artifacts[0].data.blob.sha256, reportChars: report.length, codexEvents: events.split('\n').length, a2aState: done.status.state, isolation: status.isolation, progress: execution.data.progress.map(p => p.message) });
  writeFileSync(join(process.env.EVIDENCE_DIR ?? env.c.home, 'real-report-round1.md'), report);

  // 2. Real CLI failure: the connector allows a model name the API rejects.
  const bad = await env.order({ title: '失败路径探针', description: '只需一句话回答。', criteria: ['一句话'], model: 'gpt-invalid-model-for-failure-test' });
  await env.client('send', '--credential-file', bad.file);
  const failed = await until(async () => { const e = await env.execution(bad.request.id, bad.confirmed.executionId); return ['failed', 'succeeded'].includes(e.data.status) && e; }, { timeoutMs: 180000, intervalMs: 1000 });
  assert.equal(failed.data.status, 'failed');
  assert.match(failed.data.failureCode, /^CODEX_EXIT_/);
  record({ case: 'real-cli-failure', failureCode: failed.data.failureCode, lastMessage: failed.data.progress.at(-1)?.message });

  // 3. Timeout: 30 s limit for a deliberately long task.
  const slow = await env.order({ title: '超时路径探针', description: '请逐字精读三份资料，逐条列出每一项许可、条件与限制，并对每一项给出不少于 300 字的分析与三个示例场景。', criteria: ['覆盖全部条款'], model: 'gpt-5.4-mini', timeLimitSeconds: 30 });
  await env.client('send', '--credential-file', slow.file);
  const timed = await until(async () => { const e = await env.execution(slow.request.id, slow.confirmed.executionId); return ['failed', 'succeeded'].includes(e.data.status) && e; }, { timeoutMs: 180000, intervalMs: 1000 });
  record({ case: 'real-timeout', status: timed.data.status, failureCode: timed.data.failureCode ?? null, note: timed.data.status === 'succeeded' ? 'model finished within 30 s; timeout not triggered' : undefined });

  // 4. Connector killed mid-run, then restarted: the run becomes "status pending", never re-run.
  const crash = await env.order({ title: '重启路径探针', description: '请比较三种许可证的专利条款并写出详细说明。', criteria: ['专利条款'], model: 'gpt-5.4-mini' });
  await env.client('send', '--credential-file', crash.file);
  await connector.waitFor(new RegExp(`"event":"codex-started","executionId":"${crash.confirmed.executionId}`), 120000);
  const pid = Number(JSON.parse(connector.lines.find(line => line.includes('"event":"codex-started"') && line.includes(crash.confirmed.executionId))).pid);
  connector.child.kill('SIGKILL'); await connector.exited;
  const orphanAlive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  connector = startProcess('apps/connector/cli.js', ['start'], env.c.env);
  const settled = await until(async () => { const e = await env.execution(crash.request.id, crash.confirmed.executionId); return ['unknown', 'succeeded', 'failed'].includes(e.data.status) && e; }, { timeoutMs: 120000, intervalMs: 1000 });
  assert.equal(settled.data.status, 'unknown');
  assert.equal(settled.data.failureCode, 'CONNECTOR_RESTARTED');
  const reran = connector.lines.some(line => line.includes('"event":"codex-started"') && line.includes(crash.confirmed.executionId));
  assert.equal(reran, false);
  record({ case: 'real-connector-restart', orphanAliveAfterKill: orphanAlive, status: settled.data.status, failureCode: settled.data.failureCode, rerun: reran });
});
