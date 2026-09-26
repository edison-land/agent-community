import { randomBytes } from 'node:crypto';
import { CommunityService, CommunityError, TERMINAL } from '../community/service.js';
import { CommunityGateway } from '../gateway/a2a.js';
import { connectorRoutes } from '../gateway/connector-api.js';
import { dispatchExecution, dispatchMessage, previousTask, a2aClient } from '../gateway/dispatcher.js';
import { LoginError } from '../identity/flaremo.js';
import { demoMembers } from '../identity/mock.js';
import { RouterService } from '../router/service.js';
import { agentManifest } from '../router/manifest.js';
import { humanRoutes, agentRoutes } from './router-routes.js';
import { mcpHandler } from './mcp.js';

const COOKIE = 'community_node_session';
const MAX_BODY = 4 * 1024 * 1024;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * The community node as one Fetch handler (Request in, Response out). The Node
 * process (apps/node) and the Cloudflare Durable Object (apps/worker) both wrap
 * this; they differ only in the key-value store behind sessions, pending
 * registrations and execution credentials, and in where static assets live.
 *
 * `mode` is 'live' (FlareMo store and FlareMo login) or 'simulated' (in-memory
 * store, fictional members); every API response states which one is running.
 */
export async function createCommunityApp({
  mode = 'live', store, login, kv, materials, onboarding, agentGuide = '', assets = null, connectorBundle = null, publicOrigin, router: routerOptions = {},
  autoDispatch = true, registrationTtlMs, ownerSubject = null, openBootstrap = false, openJoin = false,
  pointer = null, log = () => {},
}) {
  const origin = new URL(publicOrigin).origin;
  const secureCookies = origin.startsWith('https://');
  const savedPointer = pointer ? await pointer.load() : await kv.get('pointer:community');
  let communityId = null;
  if (savedPointer?.storeOrigin === store.origin && await store.find(savedPointer.communityId, 'object', savedPointer.communityId).catch(() => null)) communityId = savedPointer.communityId;
  const service = new CommunityService({ store, kv, communityId, publicOrigin: origin, materials, ownerSubject, openBootstrap, openJoin });
  if (registrationTtlMs) service.registrationTtlMs = registrationTtlMs;
  const gateway = new CommunityGateway({ service, log });
  // Opportunity routing (RFC 0010). `activity` builds the community-activity source for profile drafting.
  const router = new RouterService({ service, kv, taxonomy: routerOptions.taxonomy, limits: routerOptions.limits, vocabulary: routerOptions.vocabulary ?? null, understander: routerOptions.understander ?? null, activity: routerOptions.activity ? routerOptions.activity(service) : null });
  const routerApi = humanRoutes({ router, service });
  const agentApi = agentRoutes({ router });
  const mcp = mcpHandler({ router, origin });
  const connector = connectorRoutes({ service, gateway, log });
  let app;

  const cookie = (value, seconds) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secureCookies ? '; Secure' : ''}`;
  const reply = (status, value, { cookie: setCookie, type = 'application/json' } = {}) => {
    const headers = new Headers({ 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-community-mode': mode, 'content-security-policy': CSP });
    if (secureCookies) headers.set('strict-transport-security', 'max-age=31536000');
    if (setCookie) headers.append('set-cookie', setCookie);
    return new Response(type === 'application/json' ? JSON.stringify(value) : value, { status, headers });
  };

  async function remember() {
    const value = { communityId: service.communityId, storeOrigin: store.origin };
    if (pointer) await pointer.save(value); else await kv.put('pointer:community', value);
  }

  async function sessionFrom(request) {
    const id = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!id || !/^[0-9a-f]{64}$/u.test(id)) return null;
    const session = await kv.get(`session:${id}`);
    return session && session.expiresAt > Date.now() ? { ...session, cookieId: id } : null;
  }

  async function me(session) {
    if (!session) return null;
    const member = await service.memberFor(session.identity).catch(() => null);
    return { identity: { displayName: session.identity.displayName, subject: session.identity.subject, provider: session.identity.provider, synthetic: Boolean(session.identity.synthetic) }, member };
  }
  async function requireMember(session) {
    const current = await me(session);
    if (!current) throw new CommunityError('NOT_SIGNED_IN', 401);
    if (!current.member?.active) throw new CommunityError('MEMBERSHIP_REQUIRED', 403);
    return current.member.human.id;
  }

  // The node dispatches for the requester through its own A2A endpoint, in process:
  // the full JSON-RPC wire format, without a network hop back to itself.
  const selfFetch = (url, init) => app.fetch(new Request(url, init));
  async function dispatch(executionId, credential) {
    await kv.put(`credential:${executionId}`, credential, { ttlMs: 24 * 3600 * 1000 });
    try { await dispatchExecution({ service, executionId, credential, fetchImpl: selfFetch }); }
    catch (error) { log({ event: 'dispatch-failed', executionId, error: error.message }); }
  }

  async function api(request, path, params, body, session) {
    // JSON objects carry the mode; arrays stay arrays (the mode is also a response header).
    const out = (status, value, options) => reply(status, Array.isArray(value) ? value : { mode, ...value }, options);
    const m = pattern => path.match(pattern);
    let match;
    if (request.method === 'GET' && path === '/state') {
      const community = service.communityId ? await service.get('Community', service.communityId) : null;
      return out(200, {
        mode, store: store.kind, storeOrigin: store.origin, loginProvider: login.origin, demoMembers: mode === 'simulated' ? (login.members ?? demoMembers) : [],
        community: community ? { id: community.id, name: community.data.displayName } : null, me: await me(session),
        canBootstrap: !community && Boolean(session) && (openBootstrap || (ownerSubject && session.identity.subject === ownerSubject)),
        inviteRequired: !openJoin, connector: connectorBundle ? { sha256: connectorBundle.sha256, bytes: connectorBundle.bytes } : null,
        materials: [...service.materials.values()].map(item => ({ path: item.path, title: item.title, pack: item.packTitle, sha256: item.sha256, bytes: item.bytes.length })),
      });
    }
    if (request.method === 'POST' && path === '/login') {
      const signed = await login.signIn(body, origin);
      const id = randomBytes(32).toString('hex');
      const ttlMs = Math.max(1000, signed.expiresAt - Date.now());
      await kv.put(`session:${id}`, signed, { ttlMs });
      return out(200, { mode, signedIn: true }, { cookie: cookie(id, Math.floor(ttlMs / 1000)) });
    }
    if (request.method === 'POST' && path === '/logout') {
      if (session) {
        await login.signOut(session, origin).catch(() => {});
        await kv.delete(`session:${session.cookieId}`);
      }
      return out(200, { mode, signedOut: true }, { cookie: cookie('', 0) });
    }
    if (!session) throw new CommunityError('NOT_SIGNED_IN', 401);
    // Live mode re-verifies the external identity on every authenticated call.
    if (mode === 'live') await login.verify(session, origin);
    if (request.method === 'POST' && path === '/community') {
      const result = await service.bootstrap({ identity: session.identity, displayName: body.displayName, communityName: body.communityName });
      await remember();
      return out(201, result);
    }
    if (request.method === 'POST' && path === '/join') return out(201, await service.join({ identity: session.identity, displayName: body.displayName, inviteCode: body.inviteCode }));
    const humanId = await requireMember(session);
    if (request.method === 'GET' && path === '/agents') {
      const [agents, bindings, capabilities] = await Promise.all([service.list('Agent'), service.list('AgentBinding'), service.list('Capability')]);
      return out(200, agents.filter(agent => agent.data.principalId === humanId).map(agent => ({
        agent, bindings: bindings.filter(b => b.data.agentId === agent.id).map(b => ({ id: b.id, status: b.data.status, connector: b.data.connector, deviceId: b.data.deviceId, claimedAt: b.data.claimedAt, rotatedAt: b.data.rotatedAt ?? null, revokedAt: b.data.revokedAt ?? null, revokedReason: b.data.revokedReason ?? null })),
        capabilities: capabilities.filter(c => c.data.providerId === agent.id), presence: service.presence.get(agent.id) ?? null,
      })));
    }
    if (request.method === 'GET' && path === '/invitations') return out(200, await service.listInvitations({ humanId }));
    if (request.method === 'POST' && path === '/invitations') return out(201, await service.createInvitation({ humanId, maxUses: body.maxUses, ttlHours: body.ttlHours, label: body.label }));
    if (request.method === 'POST' && (match = m(/^\/invitations\/(urn:uuid:[0-9a-f-]{36})\/revoke$/u))) return out(200, await service.revokeInvitation({ humanId, invitationId: match[1] }));
    if ((match = m(/^\/claims\/([A-Za-z0-9-]{16,24})$/u))) {
      if (request.method === 'GET') return out(200, await service.claimView({ humanId, code: match[1] }));
      if (request.method === 'POST') return out(201, await service.claimRegistration({ humanId, code: match[1], fingerprintSuffix: body.fingerprintSuffix, agentId: body.agentId, agentName: body.agentName, profile: body.profile, replaceProfile: body.replaceProfile === true }));
    }
    if (request.method === 'POST' && (match = m(/^\/agents\/(urn:uuid:[0-9a-f-]{36})\/revoke$/u))) return out(200, await service.revokeAgent({ humanId, agentId: match[1] }));
    if (request.method === 'POST' && (match = m(/^\/agents\/(urn:uuid:[0-9a-f-]{36})\/profile$/u))) return out(200, await service.updateAgentProfile({ humanId, agentId: match[1], displayName: body.displayName, profile: body.profile }));
    if (request.method === 'POST' && path === '/capabilities') return out(201, await service.publishCapability({ humanId, agentId: body.agentId, title: body.title, description: body.description }));
    if (request.method === 'POST' && (match = m(/^\/capabilities\/(urn:uuid:[0-9a-f-]{36})\/withdraw$/u))) return out(200, await service.withdrawCapability({ humanId, capabilityId: match[1] }));
    if (request.method === 'GET' && path === '/discover') return out(200, await service.discover({ humanId, query: params.get('q') ?? '' }));
    if (request.method === 'POST' && path === '/requests') {
      return out(201, await service.createRequest({ humanId, title: body.title, description: body.description, capabilityIds: [body.capabilityId], acceptanceCriteria: body.acceptanceCriteria, materialPaths: body.materialPaths ?? [] }));
    }
    if (request.method === 'GET' && path === '/requests') {
      const [requests, humans] = await Promise.all([service.list('Request'), service.list('Human')]);
      return out(200, requests.filter(item => item.visibility.scope === 'community').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => ({
        id: item.id, title: item.data.title, status: item.data.status, requester: humans.find(h => h.id === item.data.requesterHumanId)?.data.displayName, mine: item.data.requesterHumanId === humanId, createdAt: item.createdAt,
      })));
    }
    if (request.method === 'GET' && (match = m(/^\/requests\/(urn:uuid:[0-9a-f-]{36})$/u))) return out(200, await service.requestView({ humanId, requestId: match[1] }));
    if (request.method === 'GET' && path === '/confirmations') {
      const cards = [];
      for (const item of (await service.list('Request')).filter(r => ['open', 'assigned'].includes(r.data.status))) {
        try { cards.push(await service.confirmationCard({ humanId, requestId: item.id })); } catch { /* not addressed to this member */ }
      }
      const executions = await service.list('Execution');
      return out(200, cards.filter(card => !executions.some(e => e.data.requestId === card.requestId && !TERMINAL.has(e.data.status))));
    }
    if (request.method === 'POST' && (match = m(/^\/requests\/(urn:uuid:[0-9a-f-]{36})\/confirm$/u))) {
      const result = await service.confirmOrder({ humanId, requestId: match[1], cardHash: body.cardHash, timeLimitSeconds: body.timeLimitSeconds, model: body.model });
      if (autoDispatch) await dispatch(result.executionId, result.callerCredential);
      else {
        await kv.put(`credential:${result.executionId}`, result.callerCredential, { ttlMs: 24 * 3600 * 1000 });
        await kv.put(`handover:${result.executionId}`, true, { ttlMs: 24 * 3600 * 1000 });
      }
      return out(201, { workroomId: result.workroomId, grantId: result.grantId, executionId: result.executionId });
    }
    if (request.method === 'POST' && (match = m(/^\/executions\/(urn:uuid:[0-9a-f-]{36})\/credential$/u))) {
      // Manual-dispatch mode: the requester takes the execution credential once for their own A2A client.
      const execution = await service.must('Execution', match[1]);
      const grant = await service.must('Grant', execution.data.grantId);
      if (grant.data.requesterHumanId !== humanId) throw new CommunityError('REQUESTER_ONLY', 403);
      if (!await kv.delete(`handover:${execution.id}`)) throw new CommunityError('CREDENTIAL_NOT_AVAILABLE', 409);
      const message = dispatchMessage({ communityId: service.communityId, execution, grant, request: await service.must('Request', execution.data.requestId), previous: await previousTask(service, execution) });
      return out(200, { executionId: execution.id, credential: await kv.get(`credential:${execution.id}`), endpoint: service.endpointUrl(execution.data.agentId), cardUrl: service.cardUrl(execution.data.agentId), expiresAt: execution.data.callerCredentialExpiresAt, message });
    }
    if (request.method === 'POST' && (match = m(/^\/grants\/(urn:uuid:[0-9a-f-]{36})\/revoke$/u))) return out(200, await service.revokeGrant({ humanId, grantId: match[1] }));
    if (request.method === 'POST' && (match = m(/^\/executions\/(urn:uuid:[0-9a-f-]{36})\/cancel$/u))) {
      const execution = await service.must('Execution', match[1]);
      const grant = await service.must('Grant', execution.data.grantId);
      if (grant.data.requesterHumanId !== humanId) throw new CommunityError('REQUESTER_ONLY', 403);
      const credential = await kv.get(`credential:${execution.id}`);
      if (!credential || !execution.data.a2a) return out(200, await service.revokeGrant({ humanId, grantId: grant.id }));
      const client = await a2aClient({ endpoint: service.endpointUrl(execution.data.agentId), credential, fetchImpl: selfFetch });
      const task = await client.cancelTask({ tenant: '', id: execution.data.a2a.taskId, metadata: {} });
      return out(200, { a2aState: task.status?.state, via: 'A2A CancelTask' });
    }
    if (request.method === 'GET' && (match = m(/^\/artifacts\/(urn:uuid:[0-9a-f-]{36})$/u))) return out(200, await service.readArtifact({ humanId, artifactId: match[1] }));
    if (request.method === 'POST' && (match = m(/^\/artifacts\/(urn:uuid:[0-9a-f-]{36})\/review$/u))) return out(201, await service.review({ humanId, artifactId: match[1], outcome: body.outcome, statement: body.statement }));
    if (request.method === 'POST' && (match = m(/^\/members\/(urn:uuid:[0-9a-f-]{36})\/status$/u))) return out(200, await service.setMembership({ ownerHumanId: humanId, humanId: match[1], status: body.status }));
    if (request.method === 'GET' && path === '/trace') return out(200, await service.trace({ humanId }));
    if (request.method === 'GET' && path === '/changes') return out(200, await service.visibleChanges({ humanId, cursor: Number(params.get('cursor') ?? 0) }));
    if (path.startsWith('/router/')) {
      const routed = await routerApi({ method: request.method, path: path.slice('/router'.length), params, body, humanId });
      if (routed) return out(routed.status, routed.value);
    }
    return out(404, { error: 'NOT_FOUND' });
  }

  async function handle(request) {
    const url = new URL(request.url);
    // Only the configured public origin is served (DNS-rebinding and host-header safety).
    if (url.host !== new URL(origin).host) return reply(403, { error: 'INVALID_HOST' });
    const path = url.pathname;
    let raw = '';
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return reply(413, { error: 'BODY_TOO_LARGE' });
      raw = await request.text();
      if (raw.length > MAX_BODY) return reply(413, { error: 'BODY_TOO_LARGE' });
    }
    try {
      const a2a = path.match(/^\/a2a\/agents\/([0-9a-f-]{36})(\/\.well-known\/agent-card\.json)?$/u);
      if (a2a) {
        let memberViewer = false;
        if (a2a[2] && request.method === 'GET') {
          const session = await sessionFrom(request);
          if (session && (mode !== 'live' || await login.verify(session, origin).then(() => true, () => false))) memberViewer = Boolean((await me(session))?.member?.active);
        }
        return await gateway.handle(request, a2a[1], raw, { memberViewer });
      }
      if (path.startsWith('/connector/v1/')) return await connector(request, path.slice('/connector/v1'.length), raw);
      if (request.method === 'GET' && path === '/healthz') return reply(200, { ok: true, mode, store: store.kind, communityId: service.communityId });
      // Member agents (RFC 0010 §7): the contract, the guide, and the API. No cookies or Origin checks: bearer tokens only.
      if (request.method === 'GET' && path === '/.well-known/agent-network.json') return reply(200, agentManifest(origin));
      if (request.method === 'GET' && path === '/agents.md') return reply(200, agentGuide.replaceAll('{{NODE}}', origin), { type: 'text/markdown' });
      if (path === '/mcp') return await mcp(request, raw);
      if (path.startsWith('/api/agent/v1/')) {
        let body = {};
        if (raw) { try { body = JSON.parse(raw); } catch { return reply(400, { error: 'INVALID_JSON' }); } }
        const result = await agentApi(request, path.slice('/api/agent/v1'.length), url.searchParams, body);
        return reply(result.status, Array.isArray(result.value) ? result.value : { mode, ...result.value });
      }
      if (request.method === 'GET' && path === '/agent-onboarding.md') {
        return reply(200, onboarding.replaceAll('{{NODE}}', origin).replaceAll('{{CONNECTOR_SHA256}}', connectorBundle?.sha256 ?? '（节点尚未构建连接器下载包）'), { type: 'text/markdown' });
      }
      // Node adapter only; on Cloudflare these are Static Assets.
      if (assets && request.method === 'GET' && (path === '/' || path === '/app.js' || path === '/app.css' || (assets[path.slice(1)] && /^\/(connector\.(mjs|json)|agent-mcp\.mjs|router\.(html|js|css))$/u.test(path)) || /^\/(claim|invite)\/[A-Za-z0-9-]{16,24}$/u.test(path))) {
        const name = path === '/' || /^\/(claim|invite)\//u.test(path) ? 'index.html' : path.slice(1);
        const type = /\.m?js$/u.test(name) ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'text/html';
        return reply(200, assets[name], { type });
      }
      if (path.startsWith('/api/')) {
        if (request.method !== 'GET' && (request.headers.get('origin') !== origin || request.headers.get('content-type')?.split(';')[0] !== 'application/json')) return reply(403, { error: 'INVALID_ORIGIN' });
        let body = {};
        if (raw) { try { body = JSON.parse(raw); } catch { return reply(400, { error: 'INVALID_JSON' }); } }
        const response = await api(request, path.slice(4), url.searchParams, body, await sessionFrom(request));
        return response;
      }
      return reply(404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof CommunityError || error instanceof LoginError || error?.name === 'StoreError') {
        const status = error.status >= 400 && error.status < 600 ? error.status : 400;
        return reply(status, { mode, error: error.code ?? error.message });
      }
      log({ event: 'node-error', error: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });
      return reply(500, { mode, error: 'INTERNAL_ERROR' });
    }
  }

  app = {
    service, gateway, router,
    fetch: handle,
    close() { for (const finish of gateway.finishers.values()) finish(); },
  };
  return app;
}
