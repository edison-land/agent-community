// SIMULATED (phase 5): the full product loop through the node's web API with
// in-memory storage, fictional members and a simulated Codex CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatedNode, communityWithAgent, until } from './support/harness.js';

test('publish → discover → confirm → progress → report → review → attestation, all eight kinds traceable', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });

  const found = await env.a.get('/discover?q=调研');
  assert.equal(found.length, 1, 'search matches one of the two profile capabilities');
  assert.equal(found[0].provider.kind, 'Agent');
  const request = await env.a.post('/requests', { title: '许可证对比', description: '比较三种许可证', capabilityId: found[0].capabilityId, acceptanceCriteria: ['含对比表', '含来源'], materialPaths: ['oss-licenses/mit.md', 'oss-licenses/apache-2.0.md', 'oss-licenses/agpl-3.0.md'] });
  assert.equal(request.data.materials.length, 3);
  assert.deepEqual(await env.a.get('/confirmations'), [], 'requester is not asked to approve execution');

  const [card] = await env.b.get('/confirmations');
  assert.deepEqual([card.model, card.runtime, card.instructionIsolation, card.costBearer], ['simulated-model', 'codex-cli', 'isolated-codex-home', 'grantor-model-account']);
  assert.equal(card.materials.length, 3);
  await assert.rejects(env.b.post(`/requests/${request.id}/confirm`, { cardHash: 'stale', timeLimitSeconds: 60 }), /CONFIRMATION_CARD_CHANGED/);
  const confirmed = await env.b.post(`/requests/${request.id}/confirm`, { cardHash: card.cardHash, timeLimitSeconds: 120 });

  const reviewReady = await until(async () => { const view = await env.a.get(`/requests/${request.id}`); return view.artifacts.length && view; }, { timeoutMs: 15000 });
  const execution = reviewReady.executions.find(e => e.id === confirmed.executionId);
  assert.equal(execution.data.status, 'succeeded');
  assert.ok(execution.data.a2a.taskId, 'dispatched through the A2A gateway');
  assert.ok(execution.data.progress.some(p => /连接器已领取/.test(p.message)));
  assert.equal(reviewReady.request.data.status, 'review');

  // A non-participant member sees the request but not the workroom or artifact.
  const aHuman = (await env.a.get('/state')).me.member.human.id;
  const invite = await node.service.createInvitation({ humanId: aHuman, maxUses: 1, ttlHours: 1 });
  const outsider = await node.service.join({ identity: { provider: 'urn:agent-community:local-demo', subject: 'users/outsider' }, displayName: 'C', inviteCode: invite.code });
  const outsiderView = await node.service.requestView({ humanId: outsider.humanId, requestId: request.id });
  assert.deepEqual([outsiderView.workrooms.length, outsiderView.artifacts.length, outsiderView.executions.length], [0, 0, 0]);
  await assert.rejects(node.service.readArtifact({ humanId: outsider.humanId, artifactId: reviewReady.artifacts[0].id }), /NOT_VISIBLE/);
  // Nor does the change feed or the trace reveal that the workroom exists.
  const feed = kinds => [...new Set(kinds.events.map(event => event.kind))].sort();
  const outsiderFeed = await node.service.visibleChanges({ humanId: outsider.humanId });
  const outsiderKinds = feed(outsiderFeed);
  for (const hidden of ['Workroom', 'Artifact', 'Grant', 'Execution', 'AgentBinding', 'Invitation']) assert.ok(!outsiderKinds.includes(hidden), `outsider does not see ${hidden} events`);
  for (const event of outsiderFeed.events.filter(item => ['IdentityLink', 'Membership'].includes(item.kind))) {
    assert.equal((await node.service.store.find(node.service.communityId, 'record', event.entityId)).data.humanId, outsider.humanId, 'only their own identity link and membership');
  }
  assert.deepEqual(outsiderKinds.filter(kind => ['Request', 'Capability', 'Agent', 'Human'].includes(kind)), ['Agent', 'Capability', 'Human', 'Request']);
  const requesterKinds = feed(await env.a.get('/changes?cursor=0'));
  for (const seen of ['Workroom', 'Artifact', 'Grant', 'Execution']) assert.ok(requesterKinds.includes(seen), `participant sees ${seen} events`);
  const outsiderTrace = await node.service.trace({ humanId: outsider.humanId });
  assert.deepEqual([outsiderTrace.counts.Workroom, outsiderTrace.counts.Artifact], [0, 0], 'trace counts only visible objects');
  assert.equal((await node.service.visibleChanges({ humanId: outsider.humanId })).cursor, (await node.service.store.events(node.service.communityId, 0, 200)).cursor, 'the cursor still advances past hidden events');
  await assert.rejects(env.b.post(`/artifacts/${reviewReady.artifacts[0].id}/review`, { outcome: 'accepted', statement: 'self-accept' }), /REQUESTER_ONLY/);

  const attestation = await env.a.post(`/artifacts/${reviewReady.artifacts[0].id}/review`, { outcome: 'accepted', statement: '满足验收标准' });
  assert.equal(attestation.data.artifactSha256, reviewReady.artifacts[0].data.blob.sha256);
  const final = await env.a.get(`/requests/${request.id}`);
  assert.equal(final.request.data.status, 'accepted');
  assert.equal(final.workrooms[0].data.status, 'closed');
  assert.equal(final.artifacts[0].data.status, 'finalized');

  const trace = await env.a.get('/trace');
  assert.equal(trace.graph, 'valid');
  for (const [kind, count] of Object.entries(trace.counts)) assert.ok(count >= 1, `${kind} present`);
  const history = await node.service.store.version(node.service.communityId, 'object', final.artifacts[0].id, 1);
  assert.equal(history.data.status, 'submitted', 'the attested revision stays readable');
  controller.abort(); await run;
});

test('requester feedback starts a new round: owner re-confirms, switches model, same A2A context', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node, { models: ['simulated-model-large'] }); t.after(env.cleanup);
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = env.connector.run({ signal: controller.signal });
  const request = await env.a.post('/requests', { title: '许可证对比', description: '比较', capabilityId: env.capability.id, acceptanceCriteria: ['含来源'], materialPaths: ['oss-licenses/mit.md'] });
  const first = (await env.b.get('/confirmations')).find(card => card.requestId === request.id);
  assert.deepEqual(first.models, ['simulated-model', 'simulated-model-large']);
  assert.equal(first.revision, null);
  await assert.rejects(env.b.post(`/requests/${request.id}/confirm`, { cardHash: first.cardHash, timeLimitSeconds: 60, model: 'not-offered' }), /MODEL_NOT_OFFERED_BY_CONNECTOR/);
  await env.b.post(`/requests/${request.id}/confirm`, { cardHash: first.cardHash, timeLimitSeconds: 60, model: 'simulated-model' });
  const round1 = await until(async () => { const v = await env.a.get(`/requests/${request.id}`); return v.artifacts.length === 1 && v; }, { timeoutMs: 15000 });
  assert.match((await env.a.get(`/artifacts/${round1.artifacts[0].id}`)).content, /模型 simulated-model）/);

  await env.a.post(`/artifacts/${round1.artifacts[0].id}/review`, { outcome: 'changes-requested', statement: '请补充专利条款的对比' });
  const second = (await env.b.get('/confirmations')).find(card => card.requestId === request.id);
  assert.deepEqual([second.revision.round, second.revision.feedback, second.revision.artifactSha256], [2, '请补充专利条款的对比', round1.artifacts[0].data.blob.sha256]);
  await env.b.post(`/requests/${request.id}/confirm`, { cardHash: second.cardHash, timeLimitSeconds: 60, model: 'simulated-model-large' });
  const round2 = await until(async () => { const v = await env.a.get(`/requests/${request.id}`); return v.artifacts.filter(a => a.data.status === 'submitted').length === 1 && v.executions.length === 2 && v; }, { timeoutMs: 15000 });
  const [e1, e2] = round2.executions.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  assert.equal(e2.data.a2a.contextId, e1.data.a2a.contextId, 'the follow-up continues the workroom conversation');
  assert.notEqual(e2.data.a2a.taskId, e1.data.a2a.taskId);
  const grant2 = round2.grants.find(g => g.id === e2.data.grantId);
  assert.deepEqual([grant2.data.model, grant2.data.revision.feedback], ['simulated-model-large', '请补充专利条款的对比']);
  const latest = round2.artifacts.find(a => a.data.status === 'submitted');
  const content = (await env.a.get(`/artifacts/${latest.id}`)).content;
  assert.match(content, /模型 simulated-model-large/);
  assert.match(content, /已读取上一版报告，按意见修改：请补充专利条款的对比/);
  assert.equal(round2.workrooms.length, 1, 'rounds share one workroom');

  await env.a.post(`/artifacts/${latest.id}/review`, { outcome: 'accepted', statement: '第二轮满足要求' });
  const final = await env.a.get(`/requests/${request.id}`);
  assert.equal(final.request.data.status, 'accepted');
  assert.deepEqual(final.artifacts.map(a => a.data.status).sort(), ['finalized', 'withdrawn']);
  assert.equal((await env.a.get('/trace')).graph, 'valid');
  controller.abort(); await run;
});
