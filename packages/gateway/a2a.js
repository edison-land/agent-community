import { randomUUID } from 'node:crypto';
import { AgentCard, Task, SSE_HEADERS, formatSSEEvent, formatSSEErrorEvent, HTTP_EXTENSION_HEADER, A2A_VERSION_HEADER } from '@a2a-js/sdk';
import { AgentEvent, DefaultExecutionEventBus, DefaultRequestHandler, JsonRpcTransportHandler, defaultServerCallContextBuilder, validateVersion } from '@a2a-js/sdk/server';
import { CommunityError, CommunityService, TERMINAL } from '../community/service.js';
import { bearer, uuidPart } from '../community/secrets.js';

/**
 * Community A2A gateway (RFC 0006/0007). Standard A2A 1.0 JSON-RPC + SSE via
 * the official SDK for SendMessage/SendStreamingMessage/GetTask/SubscribeToTask.
 * Community authorization, dispatch de-duplication and CancelTask are handled
 * here because they depend on durable Execution records and on a connector
 * that may not confirm a stop. Codex CLI itself is not an A2A server.
 */
export const EXTENSION_URI = 'urn:uuid:8e7639ad-01a8-4e1d-9423-d7417db3ec09';
const STATE = { submitted: 1, working: 2, completed: 3, failed: 4, canceled: 5, rejected: 7 };
const STATE_NAME = { 1: 'TASK_STATE_SUBMITTED', 2: 'TASK_STATE_WORKING', 3: 'TASK_STATE_COMPLETED', 4: 'TASK_STATE_FAILED', 5: 'TASK_STATE_CANCELED', 7: 'TASK_STATE_REJECTED' };
const PLATFORM_TO_STATE = { authorized: 1, queued: 1, claimed: 2, running: 2, unknown: 2, 'cancel-requested': 2, succeeded: 3, failed: 4, cancelled: 5, rejected: 7 };

const agentMessage = (taskId, contextId, text) => ({
  role: 2, messageId: randomUUID(), taskId, contextId, parts: [{ content: { $case: 'text', value: text }, metadata: {}, filename: '', mediaType: 'text/plain' }],
  metadata: {}, extensions: [], referenceTaskIds: [],
});
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

/** In-memory A2A task views; durable truth is the Execution record in FlareMo. */
const TERMINAL_STATES = new Set([3, 4, 5, 7]);
class ExecutionTaskStore {
  constructor(gateway) { this.gateway = gateway; this.tasks = new Map(); }
  async save(task) {
    const previous = this.tasks.get(task.id);
    // The SDK drains events asynchronously; never let a late save regress a terminal view.
    if (previous && TERMINAL_STATES.has(previous.status?.state) && !TERMINAL_STATES.has(task.status?.state)) return;
    const next = structuredClone(task);
    const meta = this.gateway.latestMeta.get(task.id);
    if (meta) next.metadata = structuredClone(meta);
    this.tasks.set(task.id, next);
  }
  async load(taskId) {
    if (this.tasks.has(taskId)) return structuredClone(this.tasks.get(taskId));
    const execution = await this.gateway.executionForTask(taskId);
    if (!execution) return undefined;
    const task = await this.gateway.reconstruct(execution);
    this.tasks.set(taskId, task);
    return structuredClone(task);
  }
  async list() { return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 }; }
}

export class CommunityGateway {
  /** @param {{ service: CommunityService, log?: (entry: object) => void }} options */
  constructor({ service, log = () => {} }) {
    this.service = service;
    this.log = log;
    this.taskStore = new ExecutionTaskStore(this);
    this.buses = new Map();
    this.finishers = new Map();
    this.handlers = new Map();
    this.taskIndex = new Map();
    this.latestMeta = new Map();
  }

  // ----- task mapping -----
  async executionForTask(taskId) {
    const known = this.taskIndex.get(taskId);
    if (known) return this.service.get('Execution', known);
    const execution = (await this.service.list('Execution')).find(item => item.data.a2a?.taskId === taskId);
    if (execution) this.taskIndex.set(taskId, execution.id);
    return execution ?? null;
  }

  platformMetadata(execution) {
    const d = execution.data;
    return { [EXTENSION_URI]: {
      profileVersion: '0.1.0', executionId: execution.id, platformStatus: d.status, requestId: d.requestId, workroomId: d.workroomId,
      stopUnconfirmed: d.status === 'cancel-requested' && d.cancelConfirmed === false, ...(d.artifactId ? { artifactId: d.artifactId } : {}),
    } };
  }

  async reconstruct(execution) {
    const d = execution.data;
    const state = PLATFORM_TO_STATE[d.status] ?? STATE.working;
    const last = d.progress.at(-1)?.message;
    const artifacts = [];
    if (d.artifactId) artifacts.push(await this.artifactFor(execution));
    return {
      id: d.a2a.taskId, contextId: d.a2a.contextId, artifacts, history: [], metadata: this.platformMetadata(execution),
      status: { state, message: last ? agentMessage(d.a2a.taskId, d.a2a.contextId, last) : undefined, timestamp: execution.updatedAt },
    };
  }

  async artifactFor(execution) {
    const artifact = await this.service.must('Artifact', execution.data.artifactId);
    const { bytes } = await this.service.store.getBlob(this.service.communityId, artifact.data.blob.sha256);
    return {
      artifactId: uuidPart(artifact.id), name: artifact.data.title, description: `sha256:${artifact.data.blob.sha256}`,
      parts: [{ content: { $case: 'text', value: bytes.toString('utf8') }, metadata: {}, filename: 'report.md', mediaType: 'text/markdown' }],
      metadata: { [EXTENSION_URI]: { artifactId: artifact.id, revision: artifact.revision, sha256: artifact.data.blob.sha256, reviewStatus: 'pending-human-review' } }, extensions: [],
    };
  }

  // ----- agent cards -----
  async card(agentUuid) {
    const agent = await this.service.must('Agent', `urn:uuid:${agentUuid}`);
    const community = await this.service.must('Community', this.service.communityId);
    const skills = (await this.service.list('Capability')).filter(item => item.data.providerId === agent.id && item.data.status === 'published').map(item => ({
      id: uuidPart(item.id), name: item.data.title, description: item.data.description, tags: ['community-capability'], examples: [],
      inputModes: item.data.inputMediaTypes, outputModes: item.data.outputMediaTypes, securityRequirements: [],
    }));
    return {
      name: agent.data.displayName, description: 'Community-mediated endpoint. Executes only under a per-order grant approved by the agent principal; completion is not acceptance.',
      version: '0.1.0', supportedInterfaces: [{ url: this.service.endpointUrl(agent.id), protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
      provider: { organization: community.data.displayName, url: this.service.publicOrigin },
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, extensions: [{ uri: EXTENSION_URI, description: 'Agent Community profile 0.1.0: community/request/workroom/execution/grant/actor metadata', required: true, params: { profileVersion: '0.1.0' } }] },
      securitySchemes: { executionBearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: 'Opaque per-execution credential bound to this agent', scheme: 'Bearer', bearerFormat: 'opaque' } } } },
      securityRequirements: [{ schemes: { executionBearer: { list: [] } } }],
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/markdown'], skills, signatures: [],
    };
  }

  async handlerFor(agentUuid) {
    const card = await this.card(agentUuid);
    // Rebuilt per request so skills/binding changes are never served stale.
    const handler = new DefaultRequestHandler(card, this.taskStore, this.executor(), this.busManager());
    return { card, transport: new JsonRpcTransportHandler(handler) };
  }

  busManager() {
    const gateway = this;
    return {
      createOrGetByTaskId(taskId) {
        if (!gateway.buses.has(taskId)) gateway.buses.set(taskId, new DefaultExecutionEventBus());
        return gateway.buses.get(taskId);
      },
      getByTaskId(taskId) { return gateway.buses.get(taskId); },
      cleanupByTaskId(taskId) { gateway.buses.delete(taskId); },
    };
  }

  executor() {
    const gateway = this;
    return {
      async execute(requestContext, bus) {
        const { execution } = requestContext.context.state.get('community');
        const { taskId, contextId } = requestContext;
        let queued;
        try {
          queued = await gateway.service.updateExecution(execution.id, current => {
            if (current.data.status !== 'authorized') throw new CommunityError('EXECUTION_ALREADY_DISPATCHED', 409);
            return { status: 'queued', a2a: { taskId, contextId, state: 'TASK_STATE_SUBMITTED', messageId: requestContext.userMessage.messageId }, progress: gateway.service.progressEntry(current, '已派发，等待成员连接器领取') };
          }, requestContext.context.state.get('community').actor);
        } catch (error) {
          bus.publish(AgentEvent.task({ id: taskId, contextId, artifacts: [], history: [requestContext.userMessage], metadata: {},
            status: { state: STATE.rejected, message: agentMessage(taskId, contextId, `dispatch rejected: ${error.code ?? 'ERROR'}`), timestamp: new Date().toISOString() } }));
          bus.finished();
          return;
        }
        gateway.taskIndex.set(taskId, execution.id);
        bus.publish(AgentEvent.task({ id: taskId, contextId, artifacts: [], history: [requestContext.userMessage], metadata: gateway.platformMetadata(queued),
          status: { state: STATE.submitted, message: agentMessage(taskId, contextId, '已派发，等待成员连接器领取'), timestamp: new Date().toISOString() } }));
        gateway.log({ event: 'dispatched', executionId: execution.id, taskId });
        gateway.service.wake(queued.data.agentId);
        const grant = await gateway.service.must('Grant', queued.data.grantId);
        await new Promise(resolve => {
          const timer = setTimeout(finish, (grant.data.timeLimitSeconds + 900) * 1000);
          function finish() { clearTimeout(timer); resolve(); }
          gateway.finishers.set(taskId, finish);
        });
        gateway.finishers.delete(taskId);
        bus.finished();
      },
      // CancelTask is intercepted before the SDK; see handleCancel.
      async cancelTask() { throw new CommunityError('CANCEL_HANDLED_BY_GATEWAY', 500); },
    };
  }

  /** Mirrors a durable Execution change into the A2A task view and live stream. */
  async publish(execution, { message, artifact = false } = {}) {
    const d = execution.data;
    if (!d.a2a) return;
    const { taskId, contextId } = d.a2a;
    const state = PLATFORM_TO_STATE[d.status] ?? STATE.working;
    const events = [];
    if (artifact) events.push(AgentEvent.artifactUpdate({ taskId, contextId, artifact: await this.artifactFor(execution), append: false, lastChunk: true, metadata: {} }));
    events.push(AgentEvent.statusUpdate({ taskId, contextId, metadata: this.platformMetadata(execution),
      status: { state, message: message ? agentMessage(taskId, contextId, message) : undefined, timestamp: new Date().toISOString() } }));
    this.latestMeta.set(taskId, this.platformMetadata(execution));
    // Update the served view first (durable truth is already committed), then stream.
    const task = await this.taskStore.load(taskId) ?? await this.reconstruct(execution);
    for (const event of events) {
      if (event.kind === 'artifactUpdate') task.artifacts = [event.data.artifact];
      else task.status = event.data.status;
    }
    await this.taskStore.save(task);
    const bus = this.buses.get(taskId);
    if (bus) for (const event of events) bus.publish(event);
    if (TERMINAL.has(d.status)) this.finishers.get(taskId)?.();
  }

  // ----- HTTP entry (Fetch API: Request in, Response out; Node and Workers alike) -----
  async handle(request, agentUuid, rawBody, { memberViewer = false } = {}) {
    let id = null;
    const send = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
    try {
      if (request.method === 'GET') {
        if (!new URL(request.url).pathname.endsWith('/.well-known/agent-card.json')) return send(404, { error: 'NOT_FOUND' });
        // The card names the community and the agent's capabilities, so it is not public:
        // signed-in members, or a caller holding an execution credential for this agent.
        // Authentication comes first, so an outsider cannot probe which agents exist.
        if (!memberViewer) {
          try { await this.service.callerAuth(bearer(request.headers.get('authorization')), agentUuid); }
          catch (error) { return send(error.status === 403 ? 403 : 401, { error: error.code ?? 'CARD_AUTH_REQUIRED' }, { 'www-authenticate': 'Bearer' }); }
        }
        return send(200, AgentCard.toJSON(await this.card(agentUuid)));
      }
      let body;
      try { body = JSON.parse(rawBody); } catch { return send(400, rpcError(null, -32700, 'Parse error')); }
      id = body?.id ?? null;
      const method = body?.method;
      if (!['SendMessage', 'SendStreamingMessage', 'GetTask', 'SubscribeToTask', 'CancelTask'].includes(method)) return send(200, rpcError(id, -32601, 'Method not supported by this community profile'));
      const auth = await this.service.callerAuth(bearer(request.headers.get('authorization')), agentUuid);
      const { execution, grant } = auth;
      const requestedExtensions = String(request.headers.get(HTTP_EXTENSION_HEADER) ?? '').split(',').map(item => item.trim());
      if (!requestedExtensions.includes(EXTENSION_URI)) throw new CommunityError('EXTENSION_REQUIRED', 400);
      const requester = { kind: 'Human', id: grant.data.requesterHumanId, principalId: grant.data.requesterHumanId };

      if (method === 'SendMessage' || method === 'SendStreamingMessage') {
        const message = body.params?.message;
        if (!message?.extensions?.includes(EXTENSION_URI)) throw new CommunityError('EXTENSION_REQUIRED', 400);
        CommunityService.checkDispatchMetadata(message.metadata?.[EXTENSION_URI], { execution, grant, communityId: this.service.communityId });
        if (message.taskId) throw new CommunityError('CONTINUATION_NOT_SUPPORTED', 400);
        if (message.contextId) {
          // Workroom ↔ contextId: a follow-up round may only continue this workroom's conversation.
          const known = (await this.service.list('Execution')).some(item => item.data.workroomId === execution.data.workroomId && item.data.a2a?.contextId === message.contextId);
          if (!known) throw new CommunityError('CONTEXT_NOT_IN_WORKROOM', 403);
        }
        if (execution.data.a2a) {
          // Retried dispatch: same message id returns the existing task, never a new run.
          if (execution.data.a2a.messageId !== message.messageId) throw new CommunityError('EXECUTION_ALREADY_DISPATCHED', 409);
          const task = await this.taskStore.load(execution.data.a2a.taskId);
          return send(200, { jsonrpc: '2.0', id, result: { task: Task.toJSON(task) } });
        }
        if (grant.data.status !== 'active' || Date.parse(grant.data.expiresAt) <= Date.now()) throw new CommunityError('GRANT_NOT_ACTIVE', 403);
        if (execution.data.status !== 'authorized') throw new CommunityError('EXECUTION_NOT_DISPATCHABLE', 409);
        await this.service.activeMember(grant.data.requesterHumanId);
        await this.service.activeMember(grant.data.grantorHumanId);
      } else {
        const taskId = body.params?.id;
        if (!execution.data.a2a || execution.data.a2a.taskId !== taskId) throw new CommunityError('TASK_NOT_IN_GRANT', 404);
        if (method === 'CancelTask') return send(200, { jsonrpc: '2.0', id, result: await this.handleCancel(execution, requester) });
        if (method === 'SubscribeToTask' && !this.buses.has(taskId)) {
          // No live bus after restart or completion: reconcile with GetTask instead.
          return send(200, rpcError(id, -32004, 'Live subscription unavailable; call GetTask to reconcile', [{ reason: TERMINAL.has(execution.data.status) ? 'TASK_TERMINAL' : 'NO_LIVE_STREAM' }]));
        }
      }

      const { card, transport } = await this.handlerFor(agentUuid);
      const headerBag = Object.fromEntries(request.headers.entries());
      const context = defaultServerCallContextBuilder({ extensions: [EXTENSION_URI], user: { isAuthenticated: true, userName: grant.data.requesterHumanId }, headers: headerBag, requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined });
      context.state.set('community', { execution, grant, actor: requester });
      context.addActivatedExtension(EXTENSION_URI);
      validateVersion(context.requestedVersion, card, 'JSONRPC');
      const result = await transport.handle(body, context);
      const headers = { [HTTP_EXTENSION_HEADER]: EXTENSION_URI };
      if (typeof result?.[Symbol.asyncIterator] !== 'function') return send(200, result, headers);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { value, done } = await result.next();
            if (done) controller.close(); else controller.enqueue(encoder.encode(formatSSEEvent(value)));
          } catch (error) {
            controller.enqueue(encoder.encode(formatSSEErrorEvent(rpcError(id, -32603, error.message))));
            controller.close();
          }
        },
        async cancel() { await result.return?.(); },
      });
      return new Response(stream, { status: 200, headers: { ...SSE_HEADERS, ...headers } });
    } catch (error) {
      if (error instanceof CommunityError) {
        this.log({ event: 'a2a-denied', code: error.code, agentUuid });
        return send(error.status, rpcError(id, -32010, 'Community authorization denied', [{ reason: error.code }]));
      }
      this.log({ event: 'a2a-error', error: error.message });
      return send(500, rpcError(id, -32603, 'Internal error'));
    }
  }

  /** Cancellation is only reported as canceled once nothing can still run. */
  async handleCancel(execution, actor) {
    const updated = await this.service.updateExecution(execution.id, current => {
      if (TERMINAL.has(current.data.status)) return null;
      if (['authorized', 'queued'].includes(current.data.status)) return { status: 'cancelled', cancelConfirmed: true, finishedAt: this.service.now(), a2a: { ...current.data.a2a, state: 'TASK_STATE_CANCELED' }, progress: this.service.progressEntry(current, '需求方取消；尚未开始执行') };
      if (current.data.status === 'cancel-requested') return null;
      return { status: 'cancel-requested', cancelRequestedAt: this.service.now(), cancelConfirmed: false, progress: this.service.progressEntry(current, '需求方请求停止，等待成员连接器确认') };
    }, actor);
    this.service.wake(updated.data.agentId);
    await this.publish(updated, { message: updated.data.progress.at(-1)?.message });
    return Task.toJSON(await this.taskStore.load(updated.data.a2a.taskId));
  }
}

export { STATE_NAME, PLATFORM_TO_STATE };
