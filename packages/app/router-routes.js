import { CommunityError } from '../community/service.js';
import { bearer } from '../community/secrets.js';
import { resolveAction } from '../router/manifest.js';

/**
 * HTTP routes for opportunity routing (RFC 0010).
 * - `humanRoutes`: `/api/router/*` for signed-in members (session cookie). Every
 *   human-only decision lives here.
 * - `agentRoutes`: `/api/agent/v1/*` for members' agents (bearer token), driven
 *   by the manifest, so the published contract and the enforced one are the same list.
 */
export function humanRoutes({ router, service }) {
  const U = '(urn:uuid:[0-9a-f-]{36})';
  const routes = [
    ['GET', '/state', async ({ humanId }) => {
      const [human, consent, todo, membership] = await Promise.all([service.must('Human', humanId), router.consentOf(humanId), router.todo(humanId), service.activeMember(humanId)]);
      return {
        agreement: router.agreement, consent: consent ? { status: consent.data.status, version: consent.data.agreementVersion, signedAt: consent.data.signedAt } : null,
        profile: router.profileView(human, humanId), todo: todo.mine, agents: todo.agents, activitySource: Boolean(router.activity),
        taxonomy: router.taxonomy.map(({ tag, title }) => ({ tag, title })), isOwner: membership.membership.data.role === 'owner',
      };
    }],
    ['POST', '/consent', ({ humanId, body }) => router.signConsent(humanId, { version: body.version })],
    ['POST', '/consent/withdraw', ({ humanId }) => router.withdrawConsent(humanId)],
    ['GET', '/todo', ({ humanId }) => router.todo(humanId)],
    ['GET', '/drafts', ({ humanId }) => router.drafts(humanId)],
    ['POST', `/drafts/([0-9a-f-]{36})/confirm`, ({ humanId, body, m }) => router.confirmDraft(humanId, m[1], { edits: body.edits })],
    ['POST', `/drafts/([0-9a-f-]{36})/reject`, ({ humanId, m }) => router.rejectDraft(humanId, m[1])],
    ['POST', '/profile', ({ humanId, body }) => router.setProfile(humanId, body.profile)],
    ['GET', '/members', ({ humanId, params }) => router.directory(humanId, { q: params.get('q') ?? '' })],
    ['GET', '/requests', ({ humanId }) => router.listRequests(humanId)],
    ['POST', '/requests', ({ humanId, body }) => router.createRequest(humanId, body)],
    ['POST', '/requests/understand', async ({ body }) => ({ needs: await router.understandNeeds(router.cleanRequest({ ...body, needs: undefined })) })],
    ['GET', `/requests/${U}`, ({ humanId, m }) => router.requestView(humanId, m[1])],
    ['POST', `/requests/${U}/refine`, ({ humanId, body, m }) => router.refineRequest(humanId, m[1], body)],
    ['POST', `/requests/${U}/invite`, ({ humanId, body, m }) => router.invite(humanId, m[1], body.humanIds)],
    ['POST', `/requests/${U}/suggestions`, ({ humanId, body, m }) => router.suggest({ humanId }, m[1], body)],
    ['POST', `/requests/${U}/squad`, ({ humanId, body, m }) => router.formSquad(humanId, m[1], { roles: body.roles })],
    ['GET', '/invitations', ({ humanId }) => router.invitations(humanId)],
    ['POST', `/preflights/${U}/answer`, ({ humanId, body, m }) => router.answerPreflight(humanId, m[1], body.answers)],
    ['POST', `/matches/${U}/respond`, ({ humanId, body, m }) => router.respond(humanId, m[1], { decision: body.decision, note: body.note })],
    ['GET', `/squads/${U}`, ({ humanId, m }) => router.squadView(humanId, m[1])],
    ['POST', `/squads/${U}/artifacts`, ({ humanId, body, m }) => router.submitArtifact({ humanId }, m[1], body)],
    ['POST', `/artifacts/${U}/review`, ({ humanId, body, m }) => router.review(humanId, m[1], { outcome: body.outcome, statement: body.statement })],
    ['POST', '/pairing', ({ humanId, body }) => router.createPairing(humanId, { name: body.name, scopes: body.scopes })],
    ['GET', `/device/([A-Z0-9-]{16,24})`, ({ m }) => router.deviceRequest(m[1])],
    ['POST', `/device/([A-Z0-9-]{16,24})/approve`, ({ humanId, body, m }) => router.approveDevice(humanId, m[1], { scopes: body.scopes, name: body.name })],
    ['POST', `/device/([A-Z0-9-]{16,24})/deny`, ({ humanId, m }) => router.denyDevice(humanId, m[1])],
    ['GET', '/agents', ({ humanId }) => router.agentTokens(humanId)],
    ['POST', '/agents', ({ humanId, body }) => router.issueAgentToken(humanId, { name: body.name, scopes: body.scopes, ttlDays: body.ttlDays, agentId: body.agentId })],
    ['POST', `/agents/tokens/${U}/revoke`, ({ humanId, m }) => router.revokeAgentToken(humanId, m[1])],
    ['GET', '/metrics', () => router.metrics()],
    ['GET', '/audit', async ({ humanId }) => {
      if ((await service.activeMember(humanId)).membership.data.role !== 'owner') throw new CommunityError('OWNER_REQUIRED', 403);
      return router.auditLog();
    }],
  ].map(([method, pattern, run]) => ({ method, pattern: new RegExp(`^${pattern}$`, 'u'), run }));

  return async ({ method, path, params, body, humanId }) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = path.match(route.pattern);
      if (m) return { status: 200, value: await route.run({ humanId, params, body, m }) };
    }
    return null;
  };
}

export function agentRoutes({ router }) {
  return async (request, path, query, body) => {
    // Joining is the one thing an agent does before it has a token. Nothing
    // here grants anything: a code is worthless until a member approves it.
    if (request.method === 'POST' && path === '/pair') return { status: 200, value: await router.redeemPairing(body.code, { name: body.name }) };
    if (request.method === 'POST' && path === '/device') return { status: 200, value: await router.startDeviceAuthorization({ name: body.name, scopes: body.scopes }) };
    if (request.method === 'POST' && path === '/device/token') return { status: 200, value: await router.pollDevice(body.deviceCode) };
    const resolved = resolveAction(request.method, path);
    if (!resolved) return { status: 404, value: { error: 'NOT_FOUND' } };
    const auth = await router.agentAuth(bearer(request.headers.get('authorization')));
    const value = await router.agentAction(auth, resolved.action, resolved.params, { query: Object.fromEntries(query), body });
    return { status: 200, value };
  };
}
