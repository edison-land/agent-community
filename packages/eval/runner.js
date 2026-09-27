import { startNode } from '../../apps/node/server.js';
import { MemoryObjectStore } from '../store/memory-objects.js';
import { createMockLogin } from '../identity/mock.js';
import { FixtureActivitySource } from '../router/activity.js';
import { startPersona } from './personas.js';

/**
 * End-to-end evaluation of opportunity routing (RFC 0010). One run starts its
 * own node (in-memory store, the scenario's synthetic members), drives every
 * step through the public page API and agent API, and scores both the network
 * (did the request reach people who could do it?) and each agent (did it act
 * on its inbox, stay inside its rules, and get attributed?).
 *
 * Members listed in `external` get no scripted agent: the run prints their
 * token and waits for an outside agent (Codex, Claude Code, …) to connect and
 * act. Their human side (confirming drafts, accepting) stays scripted unless
 * listed in `manualHumans`, in which case the run waits for a person on the page.
 */
export async function runScenario(scenario, {
  port = 0, host = '127.0.0.1', publicOrigin = null, external = [], manualHumans = [],
  target = null, resetSecret = null, store = null,
  waitMs = target ? 30000 : 8000, silentWaitMs = target ? 3000 : 1200, externalTimeoutMs = 600000, onExternalReady = () => {}, log = () => {}, keepNode = false,
} = {}) {
  const roster = scenario.members.map(({ username, displayName }) => ({ username, displayName }));
  const signals = Object.fromEntries(scenario.members.filter(member => member.activity).map(member => [member.username, member.activity]));
  let node;
  if (target) {
    // A deployed demo node (apps/worker, demo mode) with the same scenario roster. Wipe it first.
    const origin = new URL(target).origin;
    const reset = await fetch(`${origin}/__demo/reset`, { method: 'POST', headers: { 'x-demo-secret': resetSecret ?? '' } });
    if (!reset.ok) throw new Error(`DEMO_RESET_FAILED ${reset.status}`);
    node = { url: origin, close: async () => {} };
  } else {
    node = await startNode({
      // `store`: e.g. a FlareMo-backed store, to check the chain persists in real storage (fictional members either way).
      port, host, publicOrigin, mode: 'simulated', store: store ?? new MemoryObjectStore(), login: createMockLogin({ members: roster }), openBootstrap: true,
      router: { ...(scenario.community.taxonomy ? { taxonomy: scenario.community.taxonomy } : {}), activity: service => new FixtureActivitySource({ service, signals }) },
    });
  }
  const started = Date.now();
  const members = new Map(scenario.members.map(member => [member.key, member]));
  const web = new Map(), agents = new Map(), personas = new Map();
  // Shared with scripted personas; `allowSuggestions` keeps scripted suggestions out of the pre-suggestion snapshot.
  const registry = { requests: new Map(), members: new Map(), squads: new Map(), deliverables: new Map(), artifacts: new Set(), allowSuggestions: false, allowRouting: false };
  const isExternal = key => external.includes(key);
  const waitFor = key => (isExternal(key) || manualHumans.includes(key) ? externalTimeoutMs : waitMs);
  const stages = [];
  const owner = scenario.members.find(member => member.role === 'owner') ?? scenario.members[0];

  async function stage(id, title, fn) {
    const record = { id, title, status: 'pass', checks: [], metrics: {}, ms: 0 };
    const t0 = Date.now();
    try { await fn(record); } catch (error) { record.status = 'fail'; record.error = error.message; }
    record.ms = Date.now() - t0;
    if (record.status === 'pass' && record.checks.some(item => !item.ok)) record.status = record.checks.some(item => !item.ok && !item.soft) ? 'fail' : 'warn';
    stages.push(record);
    log({ stage: id, title, status: record.status, ms: record.ms, failed: record.checks.filter(item => !item.ok).map(item => item.name), error: record.error });
    return record;
  }
  const check = (record, name, ok, detail = '', { soft = false } = {}) => { record.checks.push({ name, ok: Boolean(ok), detail: String(detail), soft }); return ok; };
  async function until(fn, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  const humanOf = key => web.get(key);
  const idOf = key => registry.members.get(key);
  const keyOf = humanId => [...registry.members].find(([, id]) => id === humanId)?.[0];

  try {
    // 1. Community and members join by invitation.
    await stage('community', '社区与成员加入', async record => {
      for (const member of scenario.members) web.set(member.key, client(node.url));
      await humanOf(owner.key).post('/login', { username: owner.username });
      const created = await humanOf(owner.key).post('/community', { communityName: scenario.community.name, displayName: owner.displayName });
      registry.members.set(owner.key, created.humanId);
      for (const member of scenario.members.filter(item => item !== owner)) {
        await humanOf(member.key).post('/login', { username: member.username });
        const invite = await humanOf(owner.key).post('/invitations', { maxUses: 1, ttlHours: 1 });
        const joined = await humanOf(member.key).post('/join', { displayName: member.displayName, inviteCode: invite.code });
        registry.members.set(member.key, joined.humanId);
      }
      record.metrics.members = registry.members.size;
      check(record, '全部成员凭邀请加入', registry.members.size === scenario.members.length, `${registry.members.size}/${scenario.members.length}`);
    });

    // 2. Member agreement → profile drafted from community activity → the member confirms.
    await stage('profiles', '成员协议与档案起草', async record => {
      let drafted = 0, confirmed = 0;
      for (const member of scenario.members) {
        const user = humanOf(member.key);
        const state = await user.get('/router/state');
        if (member.consent) {
          const signed = await user.post('/router/consent', { version: state.agreement.version });
          if (member.activity?.length) {
            if (check(record, `${member.displayName}：签署后起草了档案`, signed.draft, signed.draft ? `${signed.draft.payload.items.length} 条` : '无草稿')) {
              drafted += 1;
              await user.post(`/router/drafts/${signed.draft.id}/confirm`, {});
            }
          }
        } else {
          check(record, `${member.displayName}：未签署协议，不起草`, !(await user.get('/router/drafts')).some(draft => draft.origin === 'community'));
        }
        const profile = (await user.get('/router/state')).profile;
        const next = member.profile ? member.profile : { items: profile?.items ?? [], ...(member.availability ?? {}) };
        await user.post('/router/profile', { profile: { items: next.items ?? [], hoursPerWeek: next.hoursPerWeek ?? 0, openTo: next.openTo ?? [], notDoing: next.notDoing ?? [] } });
        confirmed += 1;
      }
      record.metrics.draftedFromActivity = drafted;
      record.metrics.profilesConfirmed = confirmed;
    });

    // 3. Members issue tokens; scripted agents start, external agents are invited to connect.
    await stage('agents', 'Agent 接入', async record => {
      for (const member of scenario.members.filter(item => item.agent)) {
        const issued = await humanOf(member.key).post('/router/agents', { name: member.agent.name ?? `${member.displayName} 的 Agent`, ...(member.agent.scopes ? { scopes: member.agent.scopes } : {}) });
        agents.set(member.key, issued);
        if (isExternal(member.key)) {
          await onExternalReady({ member: member.key, displayName: member.displayName, node: node.url, token: issued.token, manifest: `${node.url}/.well-known/agent-network.json`, guide: `${node.url}/agents.md`, mcp: `${node.url}/mcp` });
        } else {
          personas.set(member.key, startPersona({ persona: member.agent.persona, key: member.key, node: node.url, token: issued.token, registry, config: member.agent }));
        }
      }
      for (const [key, issued] of agents) {
        const connected = await until(async () => (await humanOf(owner.key).get('/router/audit')).some(entry => entry.agentId === issued.agentId), waitFor(key));
        check(record, `${members.get(key).displayName}：${isExternal(key) ? '外部 Agent' : members.get(key).agent.persona} 已接入`, connected, isExternal(key) ? '等待外部 Agent 调用 me 或 inbox' : '');
      }
      record.metrics.agents = agents.size;
      record.metrics.external = external.length;
    });

    // 4. The request enters and is broken into capability needs.
    const r1 = scenario.requests[0];
    const expect1 = r1.expect ?? {};
    await stage('intake', '需求进入与理解', async record => {
      const created = await humanOf(r1.by).post('/router/requests', { title: r1.title, description: r1.description, acceptanceCriteria: r1.acceptanceCriteria, rewardTypes: r1.rewardTypes, source: r1.source });
      registry.requests.set(r1.key, created.id);
      const tags = created.data.needs.map(need => need.tag);
      const expected = expect1.needs ?? [];
      const hits = expected.filter(tag => tags.includes(tag));
      record.metrics.needs = tags;
      record.metrics.needRecall = expected.length ? Number((hits.length / expected.length).toFixed(2)) : null;
      record.metrics.needPrecision = tags.length ? Number((tags.filter(tag => expected.includes(tag)).length / tags.length).toFixed(2)) : null;
      check(record, '识别出期望的能力需求', hits.length === expected.length, `${hits.length}/${expected.length}：缺 ${expected.filter(tag => !tags.includes(tag)).join('、') || '无'}`);
    });

    const view = () => humanOf(r1.by).get(`/router/requests/${registry.requests.get(r1.key)}`);
    // 5. Matching with explainable reasons and a proposed squad.
    let before = null;
    await stage('matching', '匹配候选人', async record => {
      before = await view();
      const top = before.candidates.slice(0, 5).map(candidate => keyOf(candidate.humanId));
      const expected = expect1.candidates ?? [];
      record.metrics.top5 = top;
      record.metrics.recallAt5 = expected.length ? Number((expected.filter(key => top.includes(key)).length / expected.length).toFixed(2)) : null;
      check(record, '期望的人出现在前 5 名', expected.every(key => top.includes(key)), `前 5：${top.join('、')}`, { soft: true });
      check(record, '每位候选人都有理由', before.candidates.every(candidate => candidate.reasons.length > 0));
      check(record, '没有推荐需求方本人', !before.candidates.some(candidate => candidate.humanId === idOf(r1.by)));
      check(record, '没有推荐目前不接单的人', !before.candidates.some(candidate => members.get(keyOf(candidate.humanId))?.profile?.hoursPerWeek === 0 || members.get(keyOf(candidate.humanId))?.availability?.hoursPerWeek === 0));
      record.metrics.squadUncovered = before.plan.uncovered.map(need => need.tag);
      check(record, '建议组合覆盖全部需求', !before.plan.uncovered.length, `未覆盖：${record.metrics.squadUncovered.join('、') || '无'}`, { soft: true });
    });

    // 6. Members' agents suggest people (the community gives advice together).
    await stage('suggestions', '社区建议', async record => {
      registry.allowSuggestions = true;
      const planned = scenario.members.flatMap(member => (member.agent?.suggest ?? []).filter(plan => plan.request === r1.key).map(plan => ({ ...plan, by: member.key })));
      if (!planned.length) { check(record, '场景没有安排建议', true); return; }
      const arrived = await until(async () => {
        const current = await view();
        return planned.every(plan => current.suggestions.some(item => item.data.candidateHumanId === idOf(plan.candidate) && item.data.authorHumanId === idOf(plan.by))) && current;
      }, Math.max(...planned.map(plan => waitFor(plan.by))));
      if (!check(record, '建议在限时内到达', arrived, `${planned.length} 条`)) return;
      for (const plan of planned) {
        const suggestion = arrived.suggestions.find(item => item.data.candidateHumanId === idOf(plan.candidate));
        check(record, `${members.get(plan.by).displayName} 的建议标注为 Agent 提出`, suggestion.actor.kind === 'Agent');
        const candidate = arrived.candidates.find(item => item.humanId === idOf(plan.candidate));
        const was = before.candidates.find(item => item.humanId === idOf(plan.candidate));
        check(record, `${members.get(plan.candidate).displayName} 的理由里出现社区推荐`, candidate?.reasons.some(reason => reason.includes('推荐')));
        check(record, `${members.get(plan.candidate).displayName} 的匹配分因推荐提高`, candidate && (!was || candidate.score > was.score), `${was?.score ?? '未上榜'} → ${candidate?.score}`);
      }
      record.metrics.suggestions = arrived.suggestions.length;
    });

    // 7. The requester invites; candidates (or their agents) pre-flight; humans confirm drafts.
    const invitedAt = new Map(), answered = new Map();
    await stage('preflight', '邀请与预沟通', async record => {
      const invite = (expect1.invite ?? []).map(idOf);
      const byAgent = personas.get(r1.by)?.stats.persona === 'router' || (isExternal(r1.by) && members.get(r1.by).agent?.persona === 'router');
      let invited = [];
      if (byAgent) {
        // The requester said what they wanted and stopped there; their agent invites.
        registry.allowRouting = true;
        const view = await until(async () => {
          const current = await humanOf(r1.by).get(`/router/requests/${registry.requests.get(r1.key)}`);
          return current.matches?.length >= invite.length ? current : null;
        }, waitFor(r1.by));
        if (check(record, `${members.get(r1.by).displayName} 的 Agent 替他发出邀请`, view, view ? `${view.matches.length}/${invite.length}` : '超时')) {
          invited = view.matches.map(match => ({ humanId: match.data.humanId, matchId: match.id }));
          check(record, '邀请署名为「Agent 代主人发出」', view.matches.every(match => match.data.invitedByAgentId === agents.get(r1.by)?.agentId && match.actor.principalId === idOf(r1.by)));
          check(record, '需求方本人没有点过任何一次邀请', true, '本轮邀请全部来自 Agent');
        }
      } else {
        const result = await humanOf(r1.by).post(`/router/requests/${registry.requests.get(r1.key)}/invite`, { humanIds: invite });
        invited = result.invited;
        check(record, '邀请全部发出', result.invited.length === invite.length, `${result.invited.length}/${invite.length}`);
      }
      for (const item of invited) invitedAt.set(keyOf(item.humanId), Date.now());
      const expectAnswer = [...(expect1.accept ?? [])];
      await Promise.all(expectAnswer.map(async key => {
        const member = members.get(key), user = humanOf(key);
        const done = await until(async () => {
          const [entry] = (await user.get('/router/invitations')).filter(item => item.request.id === registry.requests.get(r1.key));
          if (entry?.preflight?.data.status === 'answered') return entry.preflight;
          if (!member.agent) {
            if (member.human?.answersPreflight && !manualHumans.includes(key)) await user.post(`/router/preflights/${entry.preflight.id}/answer`, { answers: member.human.answersPreflight });
            return null;
          }
          if (!manualHumans.includes(key)) {
            const draft = (await user.get('/router/drafts')).find(item => item.type === 'preflight' && item.payload.preflightId === entry.preflight.id);
            if (draft) await user.post(`/router/drafts/${draft.id}/confirm`, {});
          }
          return null;
        }, waitFor(key));
        if (done) answered.set(key, { ms: Date.now() - invitedAt.get(key), draftedBy: done.data.draftedBy, answers: done.data.answers });
        check(record, `${member.displayName}：预沟通已回答${member.agent ? '（Agent 起草、本人确认）' : '（本人回答）'}`, done && (member.agent ? done.data.draftedBy === 'agent' : done.data.draftedBy === 'human'), done ? `${answered.get(key).ms} ms` : '超时');
      }));
      for (const key of expect1.noResponse ?? []) {
        await new Promise(resolve => setTimeout(resolve, silentWaitMs));
        const [entry] = (await humanOf(key).get('/router/invitations')).filter(item => item.request.id === registry.requests.get(r1.key));
        check(record, `${members.get(key).displayName}：未回应，按超时处理`, entry?.preflight?.data.status === 'requested', '沉默的 Agent 没有替主人做任何决定');
      }
      record.metrics.answered = answered.size;
      record.metrics.medianAnswerMs = median([...answered.values()].map(item => item.ms));
    });

    // 8. Only humans decide. The rule-breaking agent has tried to accept on its principal's behalf by now.
    await stage('decisions', '本人决定（Agent 不能代替）', async record => {
      for (const key of expect1.accept ?? []) {
        const [entry] = (await humanOf(key).get('/router/invitations')).filter(item => item.request.id === registry.requests.get(r1.key));
        if (manualHumans.includes(key)) {
          check(record, `${members.get(key).displayName}：本人在页面上接受`, await until(async () => (await humanOf(key).get('/router/invitations')).find(item => item.match.id === entry.match.id && item.match.data.status === 'accepted'), externalTimeoutMs));
        } else {
          const response = await humanOf(key).post(`/router/matches/${entry.match.id}/respond`, { decision: 'accept' });
          check(record, `${members.get(key).displayName}：本人接受`, response.data.status === 'accepted');
        }
      }
      for (const key of expect1.decline ?? []) {
        const breaker = personas.get(key);
        if (breaker?.stats.persona === 'rule-breaker') {
          const tried = await until(() => breaker.stats.attempts['accept-invitation-for-principal'], waitMs);
          check(record, `${members.get(key).displayName} 的 Agent 试图替主人接受邀请，被拒绝`, tried?.refused, tried ? `${tried.status} ${tried.code}` : '没有尝试');
        }
        const [entry] = (await humanOf(key).get('/router/invitations')).filter(item => item.request.id === registry.requests.get(r1.key));
        check(record, `${members.get(key).displayName}：Agent 尝试后邀请仍未被接受`, entry.match.data.status === 'invited');
        const response = await humanOf(key).post(`/router/matches/${entry.match.id}/respond`, { decision: 'decline', note: '方向不太匹配' });
        check(record, `${members.get(key).displayName}：本人拒绝`, response.data.status === 'declined');
      }
      // A "no" is final for automation: an authorised agent cannot ask the same person again.
      // The probe uses a throwaway token so it does not show up on a real agent's scorecard.
      const refused = (expect1.decline ?? [])[0];
      if (refused) {
        const probe = await humanOf(r1.by).post('/router/agents', { name: '评估用的一次性 Agent', scopes: ['read', 'route'] });
        const retry = await fetch(`${node.url}/api/agent/v1/requests/${registry.requests.get(r1.key)}/invite`, {
          method: 'POST', headers: { authorization: `Bearer ${probe.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ humanIds: [idOf(refused)] }),
        });
        await humanOf(r1.by).post(`/router/agents/tokens/${probe.tokenId}/revoke`, {});
        const body = await retry.json();
        check(record, `${members.get(refused).displayName} 拒绝后，需求方的 Agent 不能再邀请他`, body.error === 'CANDIDATE_DECLINED', `${retry.status} ${body.error ?? ''}`);
        check(record, `${members.get(refused).displayName} 没有收到第二份邀请`, (await humanOf(refused).get('/router/invitations')).filter(item => item.request.id === registry.requests.get(r1.key)).length === 1);
      }
      const accepted = (await view()).matches.filter(item => item.data.status === 'accepted').length;
      record.metrics.accepted = accepted;
      record.metrics.acceptanceRate = Number((accepted / Math.max(1, (expect1.invite ?? []).length)).toFixed(2));
    });

    // 9. The requester forms a squad from the people who accepted.
    let squad = null, r2Before = null;
    await stage('squad', '组成小组', async record => {
      if (personas.get(r1.by)?.stats.persona === 'router') {
        // A squad can grow, so wait until everyone who accepted has a role in it.
        const view = await until(async () => {
          const current = await humanOf(r1.by).get(`/router/requests/${registry.requests.get(r1.key)}`);
          return current.squad?.roles?.length >= (expect1.accept ?? []).length ? current : null;
        }, waitFor(r1.by));
        if (!check(record, `${members.get(r1.by).displayName} 的 Agent 替他组队`, view, view ? '' : '超时')) return;
        squad = { id: view.squad.id, data: { roles: view.squad.roles.map(({ humanId, needIds, title }) => ({ humanId, needIds, title })) } };
      } else {
        squad = await humanOf(r1.by).post(`/router/requests/${registry.requests.get(r1.key)}/squad`, {});
      }
      registry.squads.set(r1.key, squad.id);
      if (expect1.deliverer) registry.deliverables.set(registry.requests.get(r1.key), expect1.deliverer);
      const needs = (await view()).request.data.needs;
      const covered = new Set(squad.data.roles.flatMap(role => role.needIds));
      record.metrics.roles = squad.data.roles.map(role => `${keyOf(role.humanId)}: ${role.title}`);
      record.metrics.coverage = Number((covered.size / needs.length).toFixed(2));
      check(record, '小组成员都是接受了邀请的人', squad.data.roles.every(role => (expect1.accept ?? []).includes(keyOf(role.humanId))));
      check(record, '小组覆盖了需求', covered.size === needs.length, `未覆盖：${needs.filter(need => !covered.has(need.id)).map(need => need.title).join('、') || '无'}`, { soft: true });
      const r2 = scenario.requests.find(item => item.expect?.learnsFrom === r1.key);
      if (r2) {
        const created = await humanOf(r2.by).post('/router/requests', { title: r2.title, description: r2.description, acceptanceCriteria: r2.acceptanceCriteria, rewardTypes: r2.rewardTypes, source: r2.source });
        registry.requests.set(r2.key, created.id);
        r2Before = await humanOf(r2.by).get(`/router/requests/${created.id}`);
      }
    });

    // 10. The deliverer's agent (or the deliverer) submits the outcome inside the squad.
    let artifact = null;
    await stage('delivery', '交付', async record => {
      const key = expect1.deliverer;
      const member = members.get(key);
      if (!member?.agent) {
        artifact = (await humanOf(key).post(`/router/squads/${squad.id}/artifacts`, { title: '交付', content: '# 交付\n本人提交。' }));
      } else {
        artifact = (await until(async () => (await humanOf(r1.by).get(`/router/squads/${squad.id}`)).artifacts.find(item => item.data.principalId === idOf(key)), waitFor(key)));
      }
      if (!check(record, `${member.displayName}${member.agent ? ' 的 Agent' : ''} 提交了交付物`, artifact, artifact ? artifact.title ?? artifact.data?.title : '超时')) return;
      registry.artifacts.add(artifact.id);
      const data = artifact.data;
      check(record, '交付物署名正确（谁做的、替谁做的）', data.principalId === idOf(key) && data.producerKind === (member.agent ? 'Agent' : 'Human'), `${data.producerKind} → ${keyOf(data.principalId)}`);
    });

    // 11. The requester accepts; every role becomes verified capability evidence.
    await stage('review', '验收与能力证据', async record => {
      if (!artifact) { check(record, '有交付物可验收', false); return; }
      const outcome = await humanOf(r1.by).post(`/router/artifacts/${artifact.id}/review`, { outcome: 'accepted', statement: '原型可演示，访谈纪要完整' });
      record.metrics.evidence = outcome.evidence.map(item => `${keyOf(item.humanId)}:${item.tag}`);
      check(record, '生成验收记录', outcome.attestation.data.outcome === 'accepted');
      for (const role of squad.data.roles) {
        const profile = (await humanOf(keyOf(role.humanId)).get('/router/state')).profile;
        check(record, `${members.get(keyOf(role.humanId)).displayName} 的档案新增已验证能力`, profile.items.some(item => item.verified && item.evidence?.some(ref => ref.attestationId === outcome.attestation.id)));
      }
    });

    // 12. The network learns: a similar request now ranks the proven member higher, with verified reasons.
    await stage('learning', '网络从这次合作中学习', async record => {
      const r2 = scenario.requests.find(item => item.expect?.learnsFrom === r1.key);
      if (!r2 || !r2Before) { check(record, '场景没有安排后续需求', true, '', { soft: true }); return; }
      const after = await humanOf(r2.by).get(`/router/requests/${registry.requests.get(r2.key)}`);
      const top = after.candidates[0];
      const target = idOf(r2.expect.topCandidate);
      const was = r2Before.candidates.find(item => item.humanId === target), now = after.candidates.find(item => item.humanId === target);
      record.metrics.before = r2Before.candidates.slice(0, 3).map(item => `${keyOf(item.humanId)}:${item.score}`);
      record.metrics.after = after.candidates.slice(0, 3).map(item => `${keyOf(item.humanId)}:${item.score}`);
      check(record, `${members.get(r2.expect.topCandidate).displayName} 排第一`, top?.humanId === target, `第一：${keyOf(top?.humanId)}`);
      check(record, '匹配分因已验证的交付提高', now && was && now.score > was.score, `${was?.score} → ${now?.score}`);
      check(record, '理由引用已验证的交付', now?.reasons.some(reason => reason.includes('已验证')));
      check(record, '记录了合作关系', (await humanOf(owner.key).get('/router/metrics')).collaborationEdges > 0);
    });

    // 13. Rules and privacy hold for everyone, including misbehaving agents.
    await stage('rules', '规则与隐私', async record => {
      const outsider = expect1.outsider;
      if (outsider) {
        const denied = await humanOf(outsider).get(`/router/squads/${squad.id}`).then(() => null, error => error.message);
        check(record, `非小组成员（${members.get(outsider).displayName}）看不到小组`, denied === 'NOT_VISIBLE', denied ?? '看到了');
      }
      for (const [key, persona] of personas) {
        if (persona.stats.persona !== 'rule-breaker') continue;
        await until(() => Object.keys(persona.stats.attempts).length >= 6, waitMs);
        for (const [name, result] of Object.entries(persona.stats.attempts)) check(record, `${members.get(key).displayName} 的 Agent：${name} 被拒绝（${result.expected}）`, result.refused, `${result.status} ${result.code}`);
      }
      // An agent whose principal never granted `route` cannot invite, even on its principal's own request.
      const narrow = await humanOf(r1.by).post('/router/agents', { name: '未授权代办的 Agent', scopes: ['read', 'suggest'] });
      const refused = await fetch(`${node.url}/api/agent/v1/requests/${registry.requests.get(r1.key)}/invite`, {
        method: 'POST', headers: { authorization: `Bearer ${narrow.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ humanIds: [idOf(owner.key)] }),
      });
      check(record, '没有被授权代办的 Agent 不能替主人邀请', (await refused.json()).error === 'DELEGATION_REQUIRED', String(refused.status));
      await humanOf(r1.by).post(`/router/agents/tokens/${narrow.tokenId}/revoke`, {});

      const withdrawer = expect1.outsider;
      if (withdrawer && members.get(withdrawer).consent) {
        const result = await humanOf(withdrawer).post('/router/consent/withdraw', {});
        const profile = (await humanOf(withdrawer).get('/router/state')).profile;
        check(record, `${members.get(withdrawer).displayName} 撤回同意后，社区起草的条目被删除`, !profile.items.some(item => item.source === 'community-draft'), `删除 ${result.removed} 条`);
      }
      for (const [key, issued] of agents) {
        if (personas.get(key)?.stats.persona !== 'rule-breaker') continue;
        await humanOf(key).post(`/router/agents/tokens/${issued.tokenId}/revoke`, {});
        const response = await fetch(`${node.url}/api/agent/v1/inbox`, { headers: { authorization: `Bearer ${issued.token}` } });
        check(record, `${members.get(key).displayName} 撤销令牌后，Agent 立即失去访问`, response.status === 401, String(response.status));
      }
    });

    // 14. What the organizer sees.
    await stage('dashboard', '运营看板', async record => {
      const metrics = await humanOf(owner.key).get('/router/metrics');
      delete metrics.mode;
      record.metrics = metrics;
      check(record, '看板记录了交付', metrics.delivered >= 1);
      check(record, '看板记录了经验证的能力', metrics.verifiedCapabilities >= 1);
    });

    // Agent scorecards from the node's own audit log, so outside agents are scored the same way.
    const audit = await humanOf(owner.key).get('/router/audit');
    const scorecards = [];
    for (const [key, issued] of agents) {
      const member = members.get(key), entries = audit.filter(entry => entry.agentId === issued.agentId);
      const persona = personas.get(key)?.stats;
      const denied = entries.filter(entry => entry.outcome === 'denied');
      const invited = (expect1.invite ?? []).includes(key), deliverer = expect1.deliverer === key;
      const drafted = entries.some(entry => entry.action === 'draft_preflight' && entry.outcome === 'ok');
      const delivered = entries.some(entry => entry.action === 'submit_artifact' && entry.outcome === 'ok');
      const suggested = entries.filter(entry => entry.action === 'suggest' && entry.outcome === 'ok').length;
      const mode = isExternal(key) ? 'external' : member.agent.persona;
      const duties = [
        { name: '接入并读取待办', done: entries.some(entry => ['me', 'inbox'].includes(entry.action)) },
        ...(invited && mode !== 'rule-breaker' && mode !== 'silent' ? [{ name: '起草预沟通回答', done: drafted, ms: answered.get(key)?.ms }] : []),
        ...(deliverer ? [{ name: '在小组里提交交付物', done: delivered }] : []),
        ...((member.agent.suggest ?? []).length ? [{ name: '按计划推荐成员', done: suggested >= member.agent.suggest.length }] : []),
        ...(mode === 'router' ? [
          { name: '替主人邀请候选人', done: entries.some(entry => entry.action === 'invite_candidates' && entry.outcome === 'ok') },
          { name: '替主人组队', done: entries.some(entry => entry.action === 'form_squad' && entry.outcome === 'ok') },
        ] : []),
      ];
      const conduct = denied.map(entry => `${entry.action}:${entry.code}`);
      scorecards.push({
        member: key, displayName: member.displayName, agentName: issued.agentName, mode, calls: entries.length, ok: entries.length - denied.length,
        denied: denied.length, conduct, duties,
        verdict: mode === 'silent' ? 'inactive (expected)' : mode === 'rule-breaker' ? (denied.length && Object.values(persona?.attempts ?? {}).every(item => item.refused) ? 'violations attempted, all refused' : 'violations not refused') : duties.every(item => item.done) ? (denied.length ? 'duties done, with refused calls' : 'duties done') : 'duties missed',
      });
    }

    const failed = stages.filter(item => item.status === 'fail');
    return {
      scenario: { id: scenario.id, title: scenario.title, synthetic: Boolean(scenario.synthetic) },
      node: node.url, startedAt: new Date(started).toISOString(), ms: Date.now() - started,
      verdict: failed.length ? 'fail' : stages.some(item => item.status === 'warn') ? 'pass-with-warnings' : 'pass',
      stages, agents: scorecards, external, remote: Boolean(target),
      ...(keepNode ? { nodeHandle: node } : {}),
    };
  } finally {
    await Promise.all([...personas.values()].map(persona => persona.stop()));
    if (!keepNode) await node.close();
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Minimal cookie-keeping page client (same API the browser uses). */
function client(origin) {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: { origin, accept: 'application/json', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).find(value => value.startsWith('community_node_session='));
    if (set) cookie = set;
    const json = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(json.error ?? `HTTP_${response.status}`); error.status = response.status; throw error; }
    return json;
  };
  return { get: path => call('GET', path), post: (path, body) => call('POST', path, body ?? {}) };
}
