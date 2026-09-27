import { randomUUID, createHash } from 'node:crypto';

/** Fresh synthetic eight-kind graph (nine records incl. two Humans) with current timestamps. */
export function freshGraph({ blobSha, blobUri = 'http://127.0.0.1:8787/synthetic', now = Date.now() - 60000 } = {}) {
  const id = () => `urn:uuid:${randomUUID()}`;
  const at = new Date(now).toISOString();
  const c = id(), a = id(), b = id(), agent = id(), cap = id(), req = id(), room = id(), art = id(), att = id();
  const asA = { kind: 'Human', id: a, principalId: a }, asB = { kind: 'Human', id: b, principalId: b };
  const base = (kind, entityId, actor, data, visibility = { scope: 'community' }) => ({
    protocol: 'community-objects', schemaVersion: '0.1.0', kind, id: entityId, communityId: c, revision: 1,
    createdAt: at, updatedAt: at, lifecycle: 'active', actor, visibility, data,
  });
  const inRoom = { scope: 'workroom', workroomId: room };
  const sha = blobSha ?? createHash('sha256').update('# synthetic\n').digest('hex');
  const objects = [
    base('Community', c, asA, { displayName: 'Live Storage Probe', ownerHumanId: a, status: 'active' }),
    base('Human', a, asA, { personId: id(), displayName: 'Synthetic A', status: 'active' }),
    base('Human', b, asA, { personId: id(), displayName: 'Synthetic B', status: 'active' }),
    base('Agent', agent, asB, { principalId: b, displayName: 'Synthetic agent', bindingStatus: 'unverified', status: 'active', interface: { protocol: 'a2a', version: '1.0', cardUrl: 'http://127.0.0.1:4320/a2a/agents/x/.well-known/agent-card.json' } }),
    base('Capability', cap, asB, { providerKind: 'Agent', providerId: agent, title: 'Research', description: 'Synthetic capability', inputMediaTypes: ['text/plain'], outputMediaTypes: ['text/markdown'], status: 'published' }),
    base('Request', req, asA, { requesterHumanId: a, title: 'Synthetic request', description: 'Probe', capabilityIds: [cap], acceptanceCriteria: ['has sources'], status: 'review' }),
    base('Workroom', room, asA, { requestId: req, participantHumanIds: [a, b], participantAgentIds: [agent], status: 'active' }, inRoom),
    base('Artifact', art, { kind: 'Agent', id: agent, principalId: b }, { workroomId: room, producerKind: 'Agent', producerId: agent, principalId: b, title: 'Synthetic report', mediaType: 'text/markdown', blob: { uri: blobUri, sha256: sha }, status: 'submitted' }, inRoom),
    base('Attestation', att, asA, { issuerHumanId: a, subjectKind: 'Agent', subjectId: agent, requestId: req, artifactId: art, artifactRevision: 1, artifactSha256: sha, outcome: 'accepted', statement: 'Synthetic acceptance', status: 'issued' }, inRoom),
  ];
  return { c, a, b, agent, cap, req, room, art, att, objects };
}

export const bump = (entity, change = {}, offsetMs = 1000) => {
  const next = structuredClone(entity);
  next.revision += 1;
  next.updatedAt = new Date(Date.parse(entity.updatedAt) + offsetMs).toISOString();
  Object.assign(next.data, change);
  return next;
};
