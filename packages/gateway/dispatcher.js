import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { EXTENSION_URI } from './a2a.js';
import { uuidPart } from '../community/secrets.js';

/**
 * Requester-side A2A client (official SDK). The community node uses it on the
 * requester's behalf after the agent principal confirmed the order; the
 * independent CLI in apps/a2a-client uses the same functions.
 */
export async function a2aClient({ endpoint, credential, fetchImpl = (...args) => fetch(...args) }) {
  const authFetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${credential}`);
    headers.set('A2A-Extensions', EXTENSION_URI);
    return fetchImpl(url, { ...init, headers, redirect: 'manual' });
  };
  // The Agent Card is not public (RFC 0008): it is fetched with the same execution credential.
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
  }));
  // The SDK resolves the well-known card path relative to the base URL.
  return factory.createFromUrl(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
}

export function dispatchMessage({ communityId, execution, grant, request, text, previous }) {
  const revision = grant.data.revision;
  return {
    messageId: `dispatch-${uuidPart(execution.id)}`, contextId: previous?.contextId ?? '', taskId: '', role: 1,
    referenceTaskIds: previous?.taskId ? [previous.taskId] : [], extensions: [EXTENSION_URI],
    parts: [{ content: { $case: 'text', value: text ?? [
      `需求：${request.data.title}`, '', request.data.description, '', '验收标准：', ...request.data.acceptanceCriteria.map(item => `- ${item}`),
      ...(revision ? ['', `第 ${revision.round} 轮：需求方对上一版报告（sha256 ${revision.artifactSha256.slice(0, 12)}…）的反馈：`, revision.feedback] : []),
    ].join('\n') }, metadata: {}, filename: '', mediaType: 'text/plain' }],
    metadata: { [EXTENSION_URI]: {
      profileVersion: '0.1.0', communityId, requestId: grant.data.requestId, workroomId: grant.data.workroomId,
      executionId: execution.id, grantId: grant.id, recipientAgentId: grant.data.agentId, capabilityId: grant.data.capabilityId,
      idempotencyKey: execution.data.idempotencyKey,
      actor: { kind: 'Human', id: grant.data.requesterHumanId, principalId: grant.data.requesterHumanId },
    } },
  };
}

export const sendParams = message => ({
  tenant: '', message, metadata: {},
  configuration: { acceptedOutputModes: ['text/markdown'], taskPushNotificationConfig: undefined, returnImmediately: true },
});

/** Dispatches one confirmed execution; retries reuse the same message id. */
export async function dispatchExecution({ service, executionId, credential, fetchImpl }) {
  const execution = await service.must('Execution', executionId);
  const grant = await service.must('Grant', execution.data.grantId);
  const request = await service.must('Request', execution.data.requestId);
  const client = await a2aClient({ endpoint: service.endpointUrl(execution.data.agentId), credential, fetchImpl });
  const message = dispatchMessage({ communityId: service.communityId, execution, grant, request, previous: await previousTask(service, execution) });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await client.sendMessage(sendParams(message)); }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1))); }
  }
  throw lastError;
}

/** Latest dispatched task in the same workroom: its contextId continues the conversation. */
export async function previousTask(service, execution) {
  const earlier = (await service.list('Execution'))
    .filter(item => item.id !== execution.id && item.data.workroomId === execution.data.workroomId && item.data.a2a)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  return earlier ? { contextId: earlier.data.a2a.contextId, taskId: earlier.data.a2a.taskId } : null;
}
