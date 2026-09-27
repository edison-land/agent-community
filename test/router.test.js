// SIMULATED (RFC 0010): opportunity routing rules over the real HTTP surface —
// consent gating, explainable ranking, the confirmation queue, agent scopes,
// human-only decisions, visibility and evidence. In-memory store, fictional members.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startNode } from '../apps/node/server.js';
import { MemoryObjectStore } from '../packages/store/memory-objects.js';
import { createMockLogin } from '../packages/identity/mock.js';
import { FixtureActivitySource } from '../packages/router/activity.js';
import { ACTIONS } from '../packages/router/manifest.js';
import { webUser, inviteAndJoin } from './support/harness.js';

const rejects = async (promise, code) => assert.rejects(promise, error => error.message === code);
const ROSTER = ['owner', 'ed', 'al', 'bo', 'zed'].map(username => ({ username, displayName: username.toUpperCase() }));
const SIGNALS = {
  ed: [{ topicId: 't1', title: '香港猎头行业', messages: 10, tags: ['recruitment', 'hk-market'], excerpt: '做了五年猎头' }, { topicId: 't2', title: '采集职位数据', messages: 2, tags: ['data'] }],
  al: [{ topicId: 't3', title: 'B2B 交互设计', messages: 6, tags: ['product-design'] }],
};

async function community(t, { limits } = {}) {
  const node = await startNode({ port: 0, mode: 'simulated', store: new MemoryObjectStore(), login: createMockLogin({ members: ROSTER }), router: { limits, activity: service => new FixtureActivitySource({ service, signals: SIGNALS }) } });
  t.after(node.close);
  const users = Object.fromEntries(ROSTER.map(({ username }) => [username, webUser(node)]));
  await users.owner.post('/login', { username: 'owner' });
  await users.owner.post('/community', { communityName: 'C', displayName: 'OWNER' });
  for (const { username, displayName } of ROSTER.slice(1)) { await users[username].post('/login', { username }); await inviteAndJoin(users.owner, users[username], displayName); }
  const ids = {};
  for (const [name, user] of Object.entries(users)) ids[name] = (await user.get('/state')).me.member.human.id;
  const agentOf = async (name, body = {}) => {
    const issued = await users[name].post('/router/agents', { name: `${name} agent`, ...body });
    const call = (method, path, payload) => fetch(`${node.url}/api/agent/v1${path}`, { method, headers: { authorization: `Bearer ${issued.token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined }).then(async r => ({ status: r.status, ...(await r.json()) }));
    return { ...issued, call };
  };
  return { node, users, ids, agentOf };
}
async function profile(user, fields) {
  const current = (await user.get('/router/state')).profile ?? { items: [] };
  return user.post('/router/profile', { profile: { items: current.items, hoursPerWeek: 6, openTo: ['paid'], notDoing: [], ...fields } });
}
const REQUEST = { title: '香港招聘 AI 情报产品', description: '需要招聘行业经验、数据、AI Agent，还要产品设计和香港企业商务拓展', acceptanceCriteria: ['两周原型'], rewardTypes: ['paid'] };

test('the manifest is the contract: human-only actions are listed but refused, and every action is documented', async t => {
  const { node } = await community(t);
  const manifest = await (await fetch(`${node.url}/.well-known/agent-network.json`)).json();
  assert.equal(manifest.actions.length, ACTIONS.length);
  assert.deepEqual(manifest.forbidden.map(item => item.id).sort(), ['respond_invitation', 'review_outcome'], 'committing and judging are never delegated');
  assert.deepEqual(manifest.delegated.map(item => item.id).sort(), ['form_squad', 'invite_candidates']);
  assert.ok(manifest.delegated.every(item => item.scope === 'route'));
  assert.ok(manifest.principles.length && manifest.obligations.length && manifest.auth.type === 'bearer');
  const guide = await (await fetch(`${node.url}/agents.md`)).text();
  assert.ok(guide.includes(`${node.url}/mcp`) && !guide.includes('{{NODE}}'));
  for (const action of manifest.actions.filter(item => item.human !== 'only')) assert.ok(guide.includes(action.id) || ['me', 'list_requests', 'search_members', 'get_squad'].includes(action.id), `${action.id} explained in agents.md`);
  assert.match((await (await fetch(`${node.url}/agent-mcp.mjs`)).text()), /Agent Network MCP server over stdio/u);
});

test('profiles are drafted from community activity only after the member signs, stay private until confirmed, and go away on withdrawal', async t => {
  const { users } = await community(t);
  const agreement = (await users.ed.get('/router/state')).agreement;
  assert.deepEqual(await users.ed.get('/router/drafts'), [], 'nothing drafted before signing');
  await rejects(users.ed.post('/router/consent', { version: 'old' }), 'AGREEMENT_VERSION_MISMATCH');
  const { draft } = await users.ed.post('/router/consent', { version: agreement.version });
  assert.equal(draft.payload.items.length, 1, 'topics with too little participation are not drafted');
  assert.deepEqual(draft.payload.items[0].evidence, [{ topicId: 't1' }]);
  assert.equal((await users.al.get('/router/members')).length, 0, 'the draft is invisible to others until confirmed');
  await users.ed.post(`/router/drafts/${draft.id}/confirm`, {});
  const listed = await users.al.get('/router/members');
  assert.equal(listed[0].profile.items[0].source, 'community-draft');
  const withdrawn = await users.ed.post('/router/consent/withdraw', {});
  assert.equal(withdrawn.removed, 1);
  assert.equal((await users.ed.get('/router/state')).profile.items.length, 0);
  await rejects(users.ed.post('/router/consent/withdraw', {}), 'NO_ACTIVE_CONSENT');
});

test('needs are understood from the request; candidates come with reasons; the requester, the unavailable and "not doing" are left out', async t => {
  const { users, ids } = await community(t);
  const version = (await users.ed.get('/router/state')).agreement.version;
  for (const name of ['ed', 'al']) { const { draft } = await users[name].post('/router/consent', { version }); await users[name].post(`/router/drafts/${draft.id}/confirm`, {}); }
  await profile(users.ed, { notDoing: ['product-design'], items: [...(await users.ed.get('/router/state')).profile.items, { kind: 'skill', title: '交互设计入门', tags: ['product-design'] }] });
  await profile(users.al, {});
  await profile(users.bo, { hoursPerWeek: 0, items: [{ kind: 'skill', title: '香港企业商务拓展', tags: ['bd', 'hk-market'] }] });
  await profile(users.owner, { items: [{ kind: 'skill', title: '招聘', tags: ['recruitment'] }] });
  const request = await users.owner.post('/router/requests', REQUEST);
  assert.deepEqual(request.data.needs.map(need => need.tag).sort(), ['ai-engineering', 'bd', 'data', 'hk-market', 'product-design', 'recruitment']);
  const view = await users.owner.get(`/router/requests/${request.id}`);
  const byId = Object.fromEntries(view.candidates.map(candidate => [candidate.humanId, candidate]));
  assert.ok(byId[ids.ed].reasons.some(reason => reason.includes('香港猎头行业')), 'reasons quote the profile item');
  assert.ok(!byId[ids.ed].needIds.includes('product-design'), '"not doing" is respected');
  assert.ok(byId[ids.al].needIds.includes('product-design'));
  assert.equal(byId[ids.bo], undefined, 'no available hours → not ranked');
  assert.equal(byId[ids.owner], undefined, 'never the requester');
  assert.ok(view.plan.uncovered.some(need => need.tag === 'bd'), 'the plan says which needs nobody covers');
  // A suggestion brings in someone the profiles alone would not.
  await users.al.post(`/router/requests/${request.id}/suggestions`, { kind: 'candidate', candidateHumanId: ids.bo, text: 'Bo 认识香港企业 HR' });
  const after = await users.owner.get(`/router/requests/${request.id}`);
  assert.ok(after.candidates.find(candidate => candidate.humanId === ids.bo).reasons.some(reason => reason.includes('推荐')));
  await rejects(users.al.post(`/router/requests/${request.id}/suggestions`, { kind: 'candidate', candidateHumanId: ids.bo, text: '再推荐一次' }), 'DUPLICATE_SUGGESTION');
  await rejects(users.al.post(`/router/requests/${request.id}/suggestions`, { kind: 'candidate', candidateHumanId: ids.owner, text: '推荐需求方本人' }), 'CANDIDATE_NOT_ELIGIBLE');
});

test('agents draft into the confirmation queue; only the principal confirms; scopes and revocation are enforced', async t => {
  const { users, agentOf } = await community(t);
  const agent = await agentOf('ed');
  const draft = await agent.call('POST', '/requests/drafts', REQUEST);
  assert.equal(draft.status, 200);
  assert.equal((await users.al.get('/router/requests')).length, 0, 'an agent-drafted request is not published');
  const [queued] = await users.ed.get('/router/drafts');
  assert.equal(queued.agentName, 'ed agent');
  const confirmed = await users.ed.post(`/router/drafts/${queued.id}/confirm`, {});
  assert.equal(confirmed.result.data.requesterHumanId, (await users.ed.get('/state')).me.member.human.id);
  assert.equal((await users.al.get('/router/requests')).length, 1);
  const narrow = await agentOf('al', { scopes: ['suggest'] });
  assert.equal((await narrow.call('POST', '/profile/drafts', { items: [{ kind: 'skill', title: 'x' }] })).error, 'SCOPE_REQUIRED');
  assert.ok(!(await agentOf('bo')).scopes.includes('route'), 'a token never gets routing delegation unless it was asked for');
  await users.al.post(`/router/agents/tokens/${narrow.tokenId}/revoke`, {});
  const revoked = await narrow.call('GET', '/inbox');
  assert.deepEqual([revoked.status, revoked.error], [401, 'AGENT_TOKEN_REVOKED']);
  assert.equal((await agent.call('GET', '/inbox', undefined)).status, 200, 'the other agent is unaffected');
});

test('human-only decisions are refused to agents and audited; accepting needs a sent pre-flight', async t => {
  const { users, ids, agentOf } = await community(t);
  await profile(users.ed, { items: [{ kind: 'skill', title: '猎头', tags: ['recruitment'] }] });
  const request = await users.owner.post('/router/requests', REQUEST);
  const agent = await agentOf('ed');
  const { invited: [invite] } = await users.owner.post(`/router/requests/${request.id}/invite`, { humanIds: [ids.ed] });
  const inbox = await agent.call('GET', '/inbox');
  assert.ok(inbox.items.some(item => item.type === 'preflight.answer' && item.matchId === invite.matchId));
  for (const [path, body] of [[`/matches/${invite.matchId}/respond`, { decision: 'accept' }], [`/artifacts/${invite.matchId}/review`, { outcome: 'accepted', statement: 'x' }]]) {
    const refused = await agent.call('POST', path, body);
    assert.deepEqual([refused.status, refused.error], [403, 'HUMAN_ONLY'], path);
  }
  // Delegation is never a default, and even once granted it is only for its own principal's requests.
  const ungranted = await agent.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.al] });
  assert.deepEqual([ungranted.status, ungranted.error], [403, 'DELEGATION_REQUIRED']);
  const authorised = await agentOf('ed', { scopes: ['read', 'route'] });
  const crossed = await authorised.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.al] });
  assert.deepEqual([crossed.status, crossed.error], [403, 'REQUESTER_ONLY']);
  const audit = await users.owner.get('/router/audit');
  assert.equal(audit.filter(entry => entry.code === 'HUMAN_ONLY').length, 2);
  await rejects(users.al.get('/router/audit'), 'OWNER_REQUIRED');
  const [entry] = await users.ed.get('/router/invitations');
  await rejects(users.ed.post(`/router/matches/${entry.match.id}/respond`, { decision: 'accept' }), 'PREFLIGHT_REQUIRED');
  assert.equal((await agent.call('POST', `/preflights/${invite.preflightId}/drafts`, { preflightId: invite.preflightId, available: true, hoursPerWeek: 5, canOwn: ['nope'] })).error, 'UNKNOWN_NEED');
  await agent.call('POST', `/preflights/${invite.preflightId}/drafts`, { preflightId: invite.preflightId, available: true, hoursPerWeek: 5, canOwn: ['recruitment'] });
  const [pf] = await users.ed.get('/router/drafts');
  await users.ed.post(`/router/drafts/${pf.id}/confirm`, {});
  assert.equal((await users.ed.post(`/router/matches/${entry.match.id}/respond`, { decision: 'accept' })).data.status, 'accepted');
  await rejects(users.ed.post(`/router/matches/${entry.match.id}/respond`, { decision: 'decline' }), 'INVITATION_CLOSED');
});

test('squads are private; delivery is attributed; acceptance verifies only the needs each person owned', async t => {
  const { users, ids, agentOf } = await community(t);
  await profile(users.ed, { items: [{ kind: 'skill', title: '猎头', tags: ['recruitment'] }, { kind: 'skill', title: '数据采集', tags: ['data'] }] });
  await profile(users.al, { items: [{ kind: 'skill', title: 'Figma 设计', tags: ['product-design'] }] });
  const request = await users.owner.post('/router/requests', REQUEST);
  const { invited } = await users.owner.post(`/router/requests/${request.id}/invite`, { humanIds: [ids.ed, ids.al] });
  for (const [name, own] of [['ed', ['recruitment', 'data']], ['al', ['product-design']]]) {
    const preflight = invited.find(item => item.humanId === ids[name]).preflightId;
    await users[name].post(`/router/preflights/${preflight}/answer`, { answers: { available: true, hoursPerWeek: 4, canOwn: own } });
    const [entry] = await users[name].get('/router/invitations');
    await users[name].post(`/router/matches/${entry.match.id}/respond`, { decision: 'accept' });
  }
  const agent = await agentOf('ed');
  const squad = await users.owner.post(`/router/requests/${request.id}/squad`, {});
  assert.deepEqual(Object.fromEntries(squad.data.roles.map(role => [role.humanId === ids.ed ? 'ed' : 'al', role.needIds])), { ed: ['recruitment', 'data'], al: ['product-design'] }, 'roles come from each pre-flight answer');
  await rejects(users.owner.post(`/router/requests/${request.id}/squad`, {}), 'NO_NEW_MEMBERS');
  await rejects(users.bo.get(`/router/squads/${squad.id}`), 'NOT_VISIBLE');
  const outsiderAgent = await agentOf('bo');
  assert.equal((await outsiderAgent.call('GET', `/squads/${squad.id}`)).error, 'NOT_VISIBLE');
  const artifact = await agent.call('POST', `/squads/${squad.id}/artifacts`, { title: '原型', content: '# 原型' });
  assert.deepEqual([artifact.data.producerKind, artifact.data.principalId], ['Agent', ids.ed]);
  await rejects(users.al.post(`/router/artifacts/${artifact.id}/review`, { outcome: 'accepted', statement: '我是组员' }), 'REQUESTER_ONLY');
  const { evidence } = await users.owner.post(`/router/artifacts/${artifact.id}/review`, { outcome: 'accepted', statement: '满足要求' });
  assert.deepEqual(evidence.map(item => `${item.humanId === ids.ed ? 'ed' : 'al'}:${item.tag}`).sort(), ['al:product-design', 'ed:data', 'ed:recruitment']);
  // Regression: the verified design item names the whole request, but only counts for design.
  const next = await users.owner.post('/router/requests', { title: '招聘数据看板', description: '猎头公司需要招聘数据看板', acceptanceCriteria: ['一周'], rewardTypes: ['paid'] });
  const ranked = (await users.owner.get(`/router/requests/${next.id}`)).candidates;
  assert.equal(ranked[0].humanId, ids.ed);
  assert.ok(!ranked.find(candidate => candidate.humanId === ids.al)?.needIds.includes('recruitment'), 'design evidence does not verify recruitment');
  const metrics = await users.owner.get('/router/metrics');
  assert.deepEqual([metrics.delivered, metrics.verifiedCapabilities, metrics.collaborationEdges], [1, 3, 1]);
});

test('someone who accepts after the squad formed joins it instead of being locked out', async t => {
  const { users, ids } = await community(t);
  await profile(users.ed, { items: [{ kind: 'skill', title: '猎头', tags: ['recruitment'] }] });
  await profile(users.al, { items: [{ kind: 'skill', title: 'Figma 设计', tags: ['product-design'] }] });
  const request = await users.owner.post('/router/requests', REQUEST);
  const { invited } = await users.owner.post(`/router/requests/${request.id}/invite`, { humanIds: [ids.ed, ids.al] });
  const accept = async (name, canOwn) => {
    await users[name].post(`/router/preflights/${invited.find(item => item.humanId === ids[name]).preflightId}/answer`, { answers: { available: true, hoursPerWeek: 4, canOwn } });
    await users[name].post(`/router/matches/${(await users[name].get('/router/invitations'))[0].match.id}/respond`, { decision: 'accept' });
  };
  await accept('ed', ['recruitment']);
  const first = await users.owner.post(`/router/requests/${request.id}/squad`, {});
  assert.equal(first.data.roles.length, 1);
  await accept('al', ['product-design']);
  const view = await users.owner.get(`/router/requests/${request.id}`);
  assert.equal(view.request.data.status, 'assigned');
  assert.equal((await users.owner.get('/router/todo')).items.filter(item => item.type === 'squad.form').length, 1, 'the late acceptance shows up as something to do');
  const grown = await users.owner.post(`/router/requests/${request.id}/squad`, {});
  assert.equal(grown.id, first.id, 'the same squad, not a second one');
  assert.deepEqual(grown.data.roles.map(role => role.humanId).sort(), [ids.ed, ids.al].sort());
  assert.equal((await users.al.get(`/router/squads/${first.id}`)).roles.length, 2, 'the late joiner can see the squad');
  await users.al.post(`/router/squads/${first.id}/artifacts`, { title: '设计稿', content: '# 设计稿' });
  await rejects(users.owner.post(`/router/requests/${request.id}/squad`, {}), 'REQUEST_NOT_OPEN');
});

test('a decline is final for automation, and a delegated agent has a bounded invitation budget', async t => {
  const { users, ids, agentOf } = await community(t, { limits: { invitesPerRequest: 2 } });
  for (const name of ['ed', 'al', 'bo']) await profile(users[name], { items: [{ kind: 'skill', title: '猎头', tags: ['recruitment'] }] });
  const request = await users.owner.post('/router/requests', REQUEST);
  const agent = await agentOf('owner', { scopes: ['read', 'route'] });
  assert.equal((await agent.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.ed] })).invited.length, 1);

  const entry = (await users.ed.get('/router/invitations'))[0];
  await users.ed.post(`/router/preflights/${entry.preflight.id}/answer`, { answers: { available: false, hoursPerWeek: 0, canOwn: [] } });
  await users.ed.post(`/router/matches/${entry.match.id}/respond`, { decision: 'decline' });
  const again = await agent.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.ed] });
  assert.deepEqual([again.status, again.error], [409, 'CANDIDATE_DECLINED'], 'automation cannot repeat the asking');
  assert.equal((await users.ed.get('/router/invitations')).length, 1, 'Ed is not asked a second time');
  // The person whose request it is may still ask again in their own name.
  assert.equal((await users.owner.post(`/router/requests/${request.id}/invite`, { humanIds: [ids.ed] })).invited.length, 1);

  // The budget counts the invitations this agent actually sent, not the calls it made.
  assert.equal((await agent.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.al] })).invited.length, 1);
  const capped = await agent.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.bo] });
  assert.deepEqual([capped.status, capped.error], [429, 'RATE_LIMITED']);
  assert.equal((await users.bo.get('/router/invitations')).length, 0, 'nobody is invited once the budget runs out');
  assert.equal((await users.owner.post(`/router/requests/${request.id}/invite`, { humanIds: [ids.bo] })).invited.length, 1, 'the requester is not on a budget');
  assert.deepEqual((await users.owner.get('/router/audit')).filter(item => item.action === 'invite_candidates' && item.outcome === 'denied').map(item => item.code), ['CANDIDATE_DECLINED', 'RATE_LIMITED']);
});

test('suggestions from agents are attributed, need a reason, and are rate limited', async t => {
  const { users, ids, agentOf } = await community(t);
  const request = await users.owner.post('/router/requests', REQUEST);
  const agent = await agentOf('al');
  assert.equal((await agent.call('POST', `/requests/${request.id}/suggestions`, { kind: 'question', text: 'ok' })).error, 'REASON_REQUIRED');
  const made = await agent.call('POST', `/requests/${request.id}/suggestions`, { kind: 'candidate', candidateHumanId: ids.ed, text: 'Ed 做过猎头' });
  assert.equal(made.actor.kind, 'Agent');
  assert.equal(made.actor.principalId, ids.al);
  for (let n = 0; n < 4; n += 1) assert.equal((await agent.call('POST', `/requests/${request.id}/suggestions`, { kind: 'question', text: `问题 ${n}：范围？` })).status, 200);
  assert.equal((await agent.call('POST', `/requests/${request.id}/suggestions`, { kind: 'question', text: '第六条问题？' })).error, 'RATE_LIMITED');
  const seenByOthers = (await users.bo.get(`/router/requests/${request.id}`)).suggestions;
  assert.ok(!seenByOthers.some(item => item.data.kind === 'candidate'), 'who recommended whom stays with the requester, the author and the candidate');
  assert.equal((await users.ed.get(`/router/requests/${request.id}`)).suggestions.filter(item => item.data.kind === 'candidate').length, 1);
  const refined = await agent.call('POST', `/requests/${request.id}/refine`, { acceptanceCriteria: ['我替别人改需求'] });
  assert.deepEqual([refined.status, refined.error], [403, 'REQUESTER_ONLY'], 'only the requester\'s own agent may refine a request');
});

test('one sentence is enough to publish; what is still unclear is named, and the requester\'s agent can fix it', async t => {
  const { users, ids, agentOf } = await community(t);
  const request = await users.owner.post('/router/requests', { text: '做一个香港招聘行业的 AI 情报产品\n- 两周内给出可演示的原型\n- 访谈 5 家本地雇主' });
  assert.equal(request.data.title, '做一个香港招聘行业的 AI 情报产品', 'the first line is the title');
  assert.deepEqual(request.data.acceptanceCriteria, ['两周内给出可演示的原型', '访谈 5 家本地雇主'], 'bullet lines are the expected outcomes');
  assert.equal(request.data.description, '做一个香港招聘行业的 AI 情报产品', 'the outcomes are not repeated in the description');
  assert.ok(request.data.needs.length, 'needs are understood without being asked for');
  assert.deepEqual((await users.owner.get(`/router/requests/${request.id}`)).clarify.map(gap => gap.field), ['rewardTypes'], 'only what is actually missing is reported');

  const vague = await users.owner.post('/router/requests', { text: '想找人一起做点关于招聘的事' });
  const gaps = (await users.owner.get(`/router/requests/${vague.id}`)).clarify.map(gap => gap.field);
  assert.deepEqual(gaps, ['acceptanceCriteria', 'rewardTypes'], 'a vague request is published and marked unclear, not refused');
  await rejects(users.owner.post('/router/requests', { text: '   ' }), 'INVALID_TEXT');

  // The requester's agent proposes the missing parts; nothing changes until the requester confirms.
  const agent = await agentOf('owner');
  const inbox = await agent.call('GET', '/inbox');
  assert.ok(inbox.items.some(item => item.type === 'request.refine' && item.requestId === vague.id && item.action === 'refine_request'));
  await agent.call('POST', `/requests/${vague.id}/refine`, { acceptanceCriteria: ['一页可执行的方案'], rewardTypes: ['exchange'] });
  assert.deepEqual((await users.owner.get(`/router/requests/${vague.id}`)).request.data.acceptanceCriteria, [], 'the draft is not applied yet');
  const [draft] = (await users.owner.get('/router/drafts')).filter(item => item.type === 'refine');
  await users.owner.post(`/router/drafts/${draft.id}/confirm`, {});
  const fixed = await users.owner.get(`/router/requests/${vague.id}`);
  assert.deepEqual(fixed.request.data.acceptanceCriteria, ['一页可执行的方案']);
  assert.deepEqual(fixed.clarify, []);
  assert.equal(ids.owner, fixed.request.data.requesterHumanId);
});

test('the requester says what they want and decides at the end; an authorised agent does the middle', async t => {
  const { users, ids, agentOf } = await community(t);
  await profile(users.ed, { items: [{ kind: 'skill', title: '猎头', tags: ['recruitment'] }] });
  const request = await users.owner.post('/router/requests', REQUEST);
  const byDefault = await agentOf('owner');
  const refused = await byDefault.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.ed] });
  assert.deepEqual([refused.status, refused.error], [403, 'DELEGATION_REQUIRED'], 'routing is opt-in');

  const router = await agentOf('owner', { scopes: ['read', 'route'] });
  const todoBefore = await users.owner.get('/router/todo');
  assert.ok(todoBefore.items.find(item => item.type === 'request.invite').agentCovers, 'the page can say the agent is on it');
  const invited = await router.call('POST', `/requests/${request.id}/invite`, { humanIds: [ids.ed] });
  assert.equal(invited.invited.length, 1);
  const match = (await users.ed.get('/router/invitations'))[0].match;
  assert.deepEqual([match.actor.kind, match.actor.principalId, match.data.source], ['Agent', ids.owner, 'agent'], 'invitations say Agent-on-behalf-of-whom');
  assert.equal(match.data.invitedByAgentId, router.agentId);

  // The invited member still decides for themselves, and the requester still judges the outcome.
  await users.ed.post(`/router/preflights/${(await users.ed.get('/router/invitations'))[0].preflight.id}/answer`, { answers: { available: true, hoursPerWeek: 4, canOwn: ['recruitment'] } });
  assert.deepEqual([403, 'HUMAN_ONLY'], [(await router.call('POST', `/matches/${match.id}/respond`, { decision: 'accept' })).status, (await router.call('POST', `/matches/${match.id}/respond`, { decision: 'accept' })).error]);
  await users.ed.post(`/router/matches/${match.id}/respond`, { decision: 'accept' });
  // The entity actor becomes whoever wrote last, so attribution has to live in the record itself.
  const answered = (await users.ed.get('/router/invitations'))[0].match;
  assert.deepEqual([answered.actor.kind, answered.data.invitedByAgentId], ['Human', router.agentId], 'who sent the invitation survives the answer');
  const squad = await router.call('POST', `/requests/${request.id}/squad`, {});
  assert.equal(squad.actor.kind, 'Agent');
  const artifact = await users.ed.post(`/router/squads/${squad.id}/artifacts`, { title: '原型', content: '# 原型' });
  const todo = await users.owner.get('/router/todo');
  const review = todo.items.find(item => item.type === 'review.accept');
  assert.deepEqual([review.artifactId, review.agentCovers], [artifact.id, false], 'accepting the outcome is never covered by an agent');
  assert.equal(todo.mine, todo.items.filter(item => !item.agentCovers).length);
});
