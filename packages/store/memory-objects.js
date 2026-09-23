import { createHash } from 'node:crypto';
import { StoreError } from './flaremo-objects.js';

/**
 * SIMULATED store for fast offline tests. It mirrors the FlareMo extension
 * contract (CAS, atomic batches, receipts, typed same-community references,
 * events, verified blobs) in process memory. Passing tests against it prove
 * Community logic only, never FlareMo persistence; it is not used by the
 * live node unless `--simulated-store` is passed explicitly.
 */
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fail = (code, status = 400) => { throw new StoreError(code, status); };

export function referencesOf(entity) {
  const d = entity.data, refs = [['actor.id', entity.actor.id, entity.actor.kind], ['actor.principalId', entity.actor.principalId, 'Human']];
  if (entity.visibility?.scope === 'workroom') refs.push(['visibility.workroomId', entity.visibility.workroomId, 'Workroom']);
  const many = (field, ids, kind) => ids.forEach(id => refs.push([field, id, kind]));
  switch (entity.kind) {
    case 'Community': refs.push(['ownerHumanId', d.ownerHumanId, 'Human']); break;
    case 'Agent': refs.push(['principalId', d.principalId, 'Human']); break;
    case 'Capability': refs.push(['providerId', d.providerId, d.providerKind]); break;
    case 'Request': refs.push(['requesterHumanId', d.requesterHumanId, 'Human']); many('capabilityIds', d.capabilityIds ?? [], 'Capability'); break;
    case 'Workroom': refs.push(['requestId', d.requestId, 'Request']); many('participantHumanIds', d.participantHumanIds, 'Human'); many('participantAgentIds', d.participantAgentIds, 'Agent'); many('roles.humanId', (d.roles ?? []).map(role => role.humanId), 'Human'); break;
    case 'Artifact': refs.push(['workroomId', d.workroomId, 'Workroom'], ['producerId', d.producerId, d.producerKind], ['principalId', d.principalId, 'Human']); break;
    case 'Attestation':
      refs.push(['issuerHumanId', d.issuerHumanId, 'Human'], ['subjectId', d.subjectId, d.subjectKind], ['requestId', d.requestId, 'Request'], ['artifactId', d.artifactId, 'Artifact']);
      if (d.supersedesId) refs.push(['supersedesId', d.supersedesId, 'Attestation']);
      break;
    case 'Membership': case 'IdentityLink': refs.push(['humanId', d.humanId, 'Human']); break;
    case 'Invitation': refs.push(['issuerHumanId', d.issuerHumanId, 'Human']); break;
    // Opportunity routing records (RFC 0010).
    case 'Match': refs.push(['requestId', d.requestId, 'Request'], ['humanId', d.humanId, 'Human']); break;
    case 'Suggestion': refs.push(['requestId', d.requestId, 'Request'], ['authorHumanId', d.authorHumanId, 'Human']); if (d.candidateHumanId) refs.push(['candidateHumanId', d.candidateHumanId, 'Human']); break;
    case 'Preflight': refs.push(['matchId', d.matchId, 'Match'], ['requestId', d.requestId, 'Request'], ['humanId', d.humanId, 'Human']); break;
    case 'Consent': refs.push(['humanId', d.humanId, 'Human']); break;
    case 'AgentToken': refs.push(['agentId', d.agentId, 'Agent'], ['principalId', d.principalId, 'Human']); break;
    case 'AgentBinding': refs.push(['agentId', d.agentId, 'Agent'], ['principalId', d.principalId, 'Human']); break;
    case 'Grant': refs.push(['requestId', d.requestId, 'Request'], ['workroomId', d.workroomId, 'Workroom'], ['agentId', d.agentId, 'Agent'], ['capabilityId', d.capabilityId, 'Capability'], ['grantorHumanId', d.grantorHumanId, 'Human'], ['requesterHumanId', d.requesterHumanId, 'Human']); break;
    case 'Execution':
      refs.push(['requestId', d.requestId, 'Request'], ['workroomId', d.workroomId, 'Workroom'], ['grantId', d.grantId, 'Grant'], ['agentId', d.agentId, 'Agent']);
      if (d.artifactId) refs.push(['artifactId', d.artifactId, 'Artifact']);
      break;
  }
  return refs;
}

export class MemoryObjectStore {
  kind = 'simulated-memory';
  origin = 'http://127.0.0.1:1';
  #service;
  #entities = new Map(); #versions = new Map(); #commands = new Map(); #events = []; #blobs = new Map(); #partitions = new Map();
  #onChange = null;
  constructor({ serviceId = 'simulated-service' } = {}) { this.#service = serviceId; }

  /**
   * Persistence hooks for a durable demo (apps/worker, demo mode): `onChange`
   * receives each committed delta before the write returns; `load` restores
   * a state saved from those deltas. The in-memory rules are unchanged.
   */
  onChange(fn) { this.#onChange = fn; }
  load({ entities = [], versions = [], commands = [], events = [], blobs = [], partitions = [] }) {
    this.#entities = new Map(entities.map(entity => [entity.id, entity]));
    this.#versions = new Map(versions.map(entity => [`${entity.id}@${entity.revision}`, entity]));
    this.#commands = new Map(commands.map(({ key, fingerprint, receipt }) => [key, { fingerprint, receipt }]));
    this.#events = [...events].sort((a, b) => a.cursor - b.cursor);
    this.#blobs = new Map(blobs.map(({ key, bytes, mediaType }) => [key, { bytes: Buffer.from(bytes), mediaType }]));
    this.#partitions = new Map(partitions.map(({ communityId, service }) => [communityId, service]));
  }

  async service() { return { extension: 'community-objects/0.1.0 (simulated)', serviceUserId: this.#service }; }

  #partition(communityId) {
    if (this.#partitions.get(communityId) !== this.#service) fail('COMMUNITY_NOT_FOUND', 404);
  }

  async transact({ communityId, commandId, writes }) {
    const key = JSON.stringify([communityId, this.#service, commandId]);
    const fingerprint = createHash('sha256').update(JSON.stringify(stable(writes.map(({ expectedRevision, entity }) => ({ expectedRevision, entity }))))).digest('hex');
    const bound = this.#partitions.get(communityId);
    if (bound && bound !== this.#service) fail('COMMUNITY_NOT_FOUND', 404);
    const prior = this.#commands.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409);
      return structuredClone({ ...prior.receipt, replayed: true });
    }
    if (!bound && !writes.some(({ expectedRevision, entity }) => expectedRevision === 0 && entity.kind === 'Community' && entity.id === communityId)) fail('COMMUNITY_BOOTSTRAP_REQUIRED', 404);
    const next = new Map(this.#entities), seen = new Set();
    for (const { expectedRevision, entity } of writes) {
      if (entity.communityId !== communityId) fail('TRANSACTION_SCOPE_MISMATCH');
      if (seen.has(entity.id)) fail('DUPLICATE_WRITE'); seen.add(entity.id);
      const previous = next.get(entity.id);
      if ((previous?.revision ?? 0) !== expectedRevision || entity.revision !== expectedRevision + 1) fail(expectedRevision === 0 && previous ? 'ENTITY_ALREADY_EXISTS' : 'REVISION_CONFLICT', 409);
      if (previous) {
        for (const field of ['protocol', 'kind', 'id', 'communityId', 'createdAt']) if (previous[field] !== entity[field]) fail('IMMUTABLE_FIELD');
        if (entity.updatedAt <= previous.updatedAt) fail('UPDATE_TIME_NOT_INCREASING');
        if (previous.lifecycle === 'tombstoned') fail('TOMBSTONE_IS_FINAL');
        if (previous.kind === 'Attestation') {
          const { status: a, ...oldClaim } = previous.data, { status: b, ...newClaim } = entity.data;
          if (a !== 'issued' || b !== 'revoked' || JSON.stringify(stable(oldClaim)) !== JSON.stringify(stable(newClaim))) fail('ATTESTATION_IMMUTABLE');
        }
      }
      next.set(entity.id, structuredClone(entity));
    }
    for (const { entity } of writes) {
      if (entity.lifecycle === 'tombstoned') continue;
      for (const [, id, kind] of referencesOf(entity)) {
        const target = next.get(id);
        if (!target || target.lifecycle !== 'active') fail('MISSING_REFERENCE');
        if (target.communityId !== communityId) fail('CROSS_COMMUNITY_REFERENCE');
        if (target.kind !== kind) fail('REFERENCE_KIND_MISMATCH');
      }
      if (entity.kind === 'Artifact' && !this.#blobs.has(`${communityId}/${entity.data.blob.sha256}`)) fail('BLOB_NOT_VERIFIED');
      if (entity.kind === 'Attestation' && !this.#entities.has(entity.id)) {
        const evidence = next.get(entity.data.artifactId)?.revision === entity.data.artifactRevision ? next.get(entity.data.artifactId) : this.#versions.get(`${entity.data.artifactId}@${entity.data.artifactRevision}`);
        if (evidence?.data.blob.sha256 !== entity.data.artifactSha256) fail('ATTESTATION_EVIDENCE_MISMATCH');
      }
    }
    if (!bound) this.#partitions.set(communityId, this.#service);
    this.#entities = next;
    for (const { expectedRevision, entity } of writes) {
      this.#versions.set(`${entity.id}@${entity.revision}`, structuredClone(entity));
      this.#events.push({ cursor: this.#events.length + 1, communityId, commandId, entityId: entity.id, category: entity.protocol === 'community-records' ? 'record' : 'object', kind: entity.kind, revision: entity.revision, changeType: entity.lifecycle === 'tombstoned' ? 'tombstoned' : expectedRevision === 0 ? 'created' : 'updated', createdAt: new Date().toISOString() });
    }
    const receipt = { communityId, commandId, cursor: this.#events.at(-1).cursor, entities: writes.map(({ entity }) => ({ id: entity.id, kind: entity.kind, revision: entity.revision })), replayed: false };
    this.#commands.set(key, { fingerprint, receipt });
    await this.#onChange?.({
      entities: writes.map(({ entity }) => structuredClone(entity)), events: this.#events.slice(-writes.length).map(event => ({ ...event })),
      command: { key, fingerprint, receipt: structuredClone(receipt) }, partition: bound ? null : { communityId, service: this.#service },
    });
    return structuredClone(receipt);
  }

  #category(entity) { return entity.protocol === 'community-records' ? 'record' : 'object'; }

  async get(communityId, category, id) {
    this.#partition(communityId);
    const entity = this.#entities.get(id);
    if (!entity || entity.communityId !== communityId || this.#category(entity) !== category) fail('ENTITY_NOT_FOUND', 404);
    return structuredClone(entity);
  }
  async find(communityId, category, id) {
    try { return await this.get(communityId, category, id); } catch (error) { if (error.status === 404) return null; throw error; }
  }
  async version(communityId, category, id, revision) {
    this.#partition(communityId);
    const entity = this.#versions.get(`${id}@${revision}`);
    if (!entity || entity.communityId !== communityId || this.#category(entity) !== category) fail('VERSION_NOT_FOUND', 404);
    return structuredClone(entity);
  }
  async list(communityId, category, kind) {
    this.#partition(communityId);
    return structuredClone([...this.#entities.values()].filter(entity => entity.communityId === communityId && this.#category(entity) === category && (!kind || entity.kind === kind)).sort((a, b) => a.id.localeCompare(b.id)));
  }
  async events(communityId, cursor = 0, limit = 200) {
    this.#partition(communityId);
    const events = this.#events.filter(event => event.communityId === communityId && event.cursor > cursor).slice(0, limit);
    return structuredClone({ events, cursor: events.at(-1)?.cursor ?? cursor });
  }
  async putBlob(communityId, bytes, mediaType) {
    this.#partition(communityId);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${communityId}/${sha256}`;
    if (!this.#blobs.has(key)) {
      this.#blobs.set(key, { bytes: Buffer.from(bytes), mediaType });
      await this.#onChange?.({ blob: { key, bytes: new Uint8Array(bytes), mediaType } });
    }
    return { sha256, size: bytes.length, mediaType };
  }
  async getBlob(communityId, sha256) {
    this.#partition(communityId);
    const blob = this.#blobs.get(`${communityId}/${sha256}`);
    if (!blob) fail('BLOB_NOT_FOUND', 404);
    return { bytes: Buffer.from(blob.bytes), mediaType: blob.mediaType };
  }
  blobUri(communityId, sha256) { return `${this.origin}/api/community/v1/blobs/${sha256}?${new URLSearchParams({ communityId })}`; }
}
