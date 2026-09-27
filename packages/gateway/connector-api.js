import { CommunityError, TERMINAL } from '../community/service.js';
import { bearer } from '../community/secrets.js';

/**
 * Internal connector protocol (RFC 0007): the member's connector dials out,
 * proves its binding with a bearer whose hash is stored on the AgentBinding,
 * long-polls for approved work and reports status. It is not an A2A surface.
 */
const LABEL = /^[\x20-\x7e]{1,200}$/u;
const MAX_JSON = 3 * 1024 * 1024;

export function connectorRoutes({ service, gateway, log = () => {} }) {
  const registrationAttempts = [];
  const lastProgressWrite = new Map();

  const send = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const json = raw => { try { return JSON.parse(raw || '{}'); } catch { throw new CommunityError('INVALID_JSON', 400); } };

  function connectorInfo(input) {
    const c = input ?? {};
    const info = {
      name: c.name, platform: c.platform, runtime: c.runtime, runtimeVersion: c.runtimeVersion, model: c.model,
      instructionIsolation: c.instructionIsolation, fingerprint: c.fingerprint,
    };
    for (const key of ['name', 'platform', 'runtimeVersion', 'model']) if (typeof info[key] !== 'string' || !LABEL.test(info[key])) throw new CommunityError(`INVALID_CONNECTOR_${key.toUpperCase()}`);
    if (info.runtime !== 'codex-cli') throw new CommunityError('UNSUPPORTED_RUNTIME');
    if (!['isolated-codex-home', 'personal-codex-home'].includes(info.instructionIsolation)) throw new CommunityError('INVALID_ISOLATION');
    if (!/^[0-9a-f]{16}$/u.test(info.fingerprint ?? '')) throw new CommunityError('INVALID_FINGERPRINT');
    const models = Array.isArray(c.models) && c.models.length ? [...new Set(c.models)] : [info.model];
    if (models.length > 10 || !models.every(model => typeof model === 'string' && LABEL.test(model)) || !models.includes(info.model)) throw new CommunityError('INVALID_CONNECTOR_MODELS');
    return { ...info, models };
  }

  const ROUTES = [['POST', /^\/registrations$/u], ['GET', /^\/binding$/u], ['POST', /^\/credential\/rotate$/u], ['POST', /^\/heartbeat$/u],
    ['GET', /^\/tasks\/next$/u], ['POST', /^\/executions\/[0-9a-f-]{36}\/(events|artifact)$/u], ['POST', /^\/unbind$/u]];

  return async function handle(request, path, raw) {
    try {
      // Unknown routes (including the removed pairing endpoint) are 404 before any auth.
      if (!ROUTES.some(([method, pattern]) => method === request.method && pattern.test(path))) return send(404, { error: 'NOT_FOUND' });
      if (request.method === 'POST' && path === '/registrations') {
        // Unauthenticated by design: it only creates a pending, in-memory entry that a member must claim.
        const now = Date.now();
        while (registrationAttempts.length && registrationAttempts[0] < now - 60000) registrationAttempts.shift();
        if (registrationAttempts.length >= 10) return send(429, { error: 'REGISTRATION_RATE_LIMITED' });
        registrationAttempts.push(now);
        if (!service.communityId) throw new CommunityError('COMMUNITY_NOT_CREATED', 404);
        const body = json(raw);
        const result = await service.register({ connector: connectorInfo(body.connector), credentialHash: body.credentialHash, deviceId: body.deviceId, profile: body.profile });
        log({ event: 'connector-registered', registrationId: result.registrationId });
        return send(201, result);
      }

      if (request.method === 'GET' && path === '/binding') {
        const token = bearer(request.headers.get('authorization'));
        const pending = await service.pendingRegistration(token);
        if (pending && pending.status !== 'claimed') {
          return send(pending.status === 'pending' ? 200 : 410, { status: pending.status === 'pending' ? 'awaiting-claim' : pending.status, registrationId: pending.id, expiresAt: new Date(pending.expiresAt).toISOString() });
        }
        const { binding, agent } = await service.connectorAuth(token);
        return send(200, { status: binding.data.status, bindingId: binding.id, agentId: agent.id, agentName: agent.data.displayName, communityId: service.communityId });
      }

      const { binding, agent } = await service.connectorAuth(bearer(request.headers.get('authorization')));

      if (request.method === 'POST' && path === '/credential/rotate') {
        const result = await service.rotateCredential({ binding, agent, credentialHash: json(raw).credentialHash });
        log({ event: 'credential-rotated', bindingId: binding.id });
        return send(200, result);
      }

      if (request.method === 'POST' && path === '/heartbeat') {
        const body = json(raw);
        service.heartbeat(agent.id, { model: binding.data.connector.model, running: Array.isArray(body.running) ? body.running.slice(0, 10) : [] });
        return send(200, { bindingStatus: binding.data.status, stop: await service.stopList({ agent }) });
      }

      if (request.method === 'GET' && path.startsWith('/tasks/next')) {
        service.heartbeat(agent.id, { model: binding.data.connector.model });
        const wait = Math.min(Math.max(Number(new URL(request.url).searchParams.get('wait') ?? 20), 0), 25) * 1000;
        const deadline = Date.now() + wait;
        for (;;) {
          const task = await service.claimNext({ agent });
          if (task) {
            if (!task.resume) {
              const execution = await service.must('Execution', task.executionId);
              await gateway.publish(execution, { message: '成员连接器已领取任务' });
            }
            log({ event: task.resume ? 'reconcile' : 'claimed', executionId: task.executionId });
            return send(200, { task });
          }
          const left = deadline - Date.now();
          if (left <= 0 || request.signal?.aborted) return send(204);
          await service.waitFor(agent.id, Math.min(left, 2000));
        }
      }

      const match = path.match(/^\/executions\/([0-9a-f-]{36})\/(events|artifact)$/u);
      if (match && request.method === 'POST') {
        const executionId = `urn:uuid:${match[1]}`;
        if (match[2] === 'events') {
          const body = json(raw);
          let persist = true;
          if (body.type === 'progress') {
            const grant = await service.must('Grant', (await service.must('Execution', executionId)).data.grantId);
            if (grant.data.status !== 'active') throw new CommunityError('GRANT_NOT_ACTIVE', 403);
            persist = Date.now() - (lastProgressWrite.get(executionId) ?? 0) > 5000;
          }
          const { execution } = await service.connectorEvent({ agent, executionId, type: body.type, message: body.message, code: body.code, persistProgress: persist });
          if (persist) lastProgressWrite.set(executionId, Date.now());
          await gateway.publish(execution, { message: String(body.message ?? '').slice(0, 500) || undefined });
          log({ event: `execution-${body.type}`, executionId, status: execution.data.status });
          return send(200, { status: execution.data.status, terminal: TERMINAL.has(execution.data.status) });
        }
        const body = json(raw);
        if (typeof body.report !== 'string') throw new CommunityError('REPORT_REQUIRED');
        if (Buffer.byteLength(raw) > MAX_JSON) throw new CommunityError('REPORT_TOO_LARGE', 413);
        const usage = body.usage && Number.isSafeInteger(body.usage.inputTokens) && Number.isSafeInteger(body.usage.outputTokens)
          ? { inputTokens: body.usage.inputTokens, outputTokens: body.usage.outputTokens, ...(Number.isSafeInteger(body.usage.cachedInputTokens) ? { cachedInputTokens: body.usage.cachedInputTokens } : {}) } : undefined;
        const { artifact, sha256 } = await service.submitArtifact({ executionId, agent, report: body.report, usage });
        const execution = await service.must('Execution', executionId);
        await gateway.publish(execution, { message: '报告已提交，等待需求方验收（完成 ≠ 验收）', artifact: true });
        log({ event: 'artifact-submitted', executionId, artifactId: artifact.id, sha256 });
        return send(200, { artifactId: artifact.id, sha256 });
      }

      if (request.method === 'POST' && path === '/unbind') {
        await service.revokeAgent({ humanId: agent.data.principalId, agentId: agent.id, reason: 'unbound-by-connector' });
        log({ event: 'unbound-by-connector', agentId: agent.id });
        return send(200, { status: 'revoked' });
      }
      return send(404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof CommunityError || error?.name === 'StoreError') {
        const status = error.status && error.status >= 400 ? error.status : 400;
        return send(status, { error: error.code });
      }
      log({ event: 'connector-error', error: error.message });
      return send(500, { error: 'INTERNAL_ERROR' });
    }
  };
}
