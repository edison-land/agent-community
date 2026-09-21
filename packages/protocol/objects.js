import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const objectSchema = JSON.parse(readFileSync(new URL('../../protocols/community/v0.1/object.schema.json', import.meta.url)));
export const objectKinds = objectSchema.properties.kind.enum;
const fail = code => { throw new Error(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Deliberately limited to the keywords used by the bundled contract. Not a general
// JSON Schema engine or an authorization boundary; unknown keywords fail closed.
function check(schema, value) {
  const supported = ['$schema', '$defs', 'title', '$ref', 'oneOf', 'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'format'];
  if (Object.keys(schema).some(key => !supported.includes(key))) fail('UNSUPPORTED_SCHEMA_KEYWORD');
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/$defs/')) fail('UNSUPPORTED_SCHEMA_REF');
    const target = objectSchema.$defs[schema.$ref.slice(8)];
    if (!target) fail('UNKNOWN_SCHEMA_REF');
    check(target, value);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(branch => { try { check(branch, value); return true; } catch { return false; } });
    if (matches.length !== 1) fail('SCHEMA_UNION_MISMATCH');
  }
  if (Object.hasOwn(schema, 'const') && !equal(schema.const, value)) fail('SCHEMA_CONST');
  if (schema.enum && !schema.enum.some(item => equal(item, value))) fail('SCHEMA_ENUM');
  if (schema.type === 'object' && !record(value)) fail('SCHEMA_OBJECT');
  if (schema.type === 'array' && !Array.isArray(value)) fail('SCHEMA_ARRAY');
  if (schema.type === 'string' && typeof value !== 'string') fail('SCHEMA_STRING');
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) fail('SCHEMA_INTEGER');
  if (schema.minimum !== undefined && value < schema.minimum) fail('SCHEMA_MINIMUM');
  if (schema.properties) {
    if (!record(value)) fail('SCHEMA_OBJECT');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail('SCHEMA_REQUIRED');
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties, key)) check(schema.properties[key], item);
      else if (schema.additionalProperties === false) fail('SCHEMA_UNKNOWN_FIELD');
    }
  }
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) fail('SCHEMA_LENGTH');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail('SCHEMA_PATTERN');
    if (schema.format === 'uri') { try { new URL(value); } catch { fail('SCHEMA_URI'); } }
    if (schema.format === 'date-time') {
      // The community profile deliberately requires canonical UTC milliseconds.
      const time = Date.parse(value);
      if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail('SCHEMA_TIMESTAMP');
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('SCHEMA_ITEMS');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('SCHEMA_DUPLICATE_ITEMS');
    if (schema.items) for (const item of value) check(schema.items, item);
  }
}

export function validateObject(value) {
  check(objectSchema, value);
  if (value.updatedAt < value.createdAt) fail('TIME_REVERSED');
  if (value.kind === 'Community' && value.communityId !== value.id) fail('COMMUNITY_ID_MISMATCH');
  return true;
}

export function validateGraph(objects, historical = () => undefined) {
  const index = new Map();
  for (const object of objects) {
    validateObject(object);
    if (index.has(object.id)) fail('DUPLICATE_OBJECT_ID');
    index.set(object.id, object);
  }
  for (const object of objects) {
    if (object.lifecycle === 'tombstoned') continue;
    const get = (id, kind) => {
      const target = index.get(id);
      if (!target || target.lifecycle !== 'active') fail('MISSING_REFERENCE');
      if (target.kind !== kind) fail('REFERENCE_KIND_MISMATCH');
      if (target.communityId !== object.communityId) fail('CROSS_COMMUNITY_REFERENCE');
      return target;
    };
    get(object.communityId, 'Community');
    const actor = get(object.actor.id, object.actor.kind);
    get(object.actor.principalId, 'Human');
    if ((actor.kind === 'Human' ? actor.id : actor.data.principalId) !== object.actor.principalId) fail('ACTOR_PRINCIPAL_MISMATCH');
    if (object.visibility.scope === 'workroom') get(object.visibility.workroomId, 'Workroom');
    const d = object.data;
    switch (object.kind) {
      case 'Community': get(d.ownerHumanId, 'Human'); break;
      case 'Agent': get(d.principalId, 'Human'); break;
      case 'Capability': get(d.providerId, d.providerKind); break;
      case 'Request':
        get(d.requesterHumanId, 'Human');
        d.capabilityIds.forEach(id => get(id, 'Capability'));
        if (d.status === 'accepted' && !objects.some(item => item.kind === 'Attestation' && item.lifecycle === 'active' && item.data.requestId === object.id && item.data.status === 'issued' && item.data.outcome === 'accepted' && item.data.issuerHumanId === d.requesterHumanId)) fail('ACCEPTANCE_EVIDENCE_REQUIRED');
        break;
      case 'Workroom': {
        const request = get(d.requestId, 'Request');
        d.participantHumanIds.forEach(id => get(id, 'Human'));
        if (!d.participantHumanIds.includes(request.data.requesterHumanId)) fail('REQUESTER_NOT_IN_WORKROOM');
        for (const id of d.participantAgentIds) if (!d.participantHumanIds.includes(get(id, 'Agent').data.principalId)) fail('PRINCIPAL_NOT_IN_WORKROOM');
        if (object.visibility.scope === 'workroom' && object.visibility.workroomId !== object.id) fail('WORKROOM_SCOPE_MISMATCH');
        break;
      }
      case 'Artifact': {
        const room = get(d.workroomId, 'Workroom');
        const producer = get(d.producerId, d.producerKind); get(d.principalId, 'Human');
        if ((producer.kind === 'Human' ? producer.id : producer.data.principalId) !== d.principalId) fail('PRODUCER_PRINCIPAL_MISMATCH');
        if (!room.data.participantHumanIds.includes(d.principalId) || (producer.kind === 'Agent' && !room.data.participantAgentIds.includes(producer.id))) fail('PRODUCER_NOT_IN_WORKROOM');
        if (object.visibility.scope === 'workroom' && object.visibility.workroomId !== d.workroomId) fail('WORKROOM_SCOPE_MISMATCH');
        break;
      }
      case 'Attestation': {
        get(d.issuerHumanId, 'Human'); get(d.subjectId, d.subjectKind); get(d.requestId, 'Request');
        const current = get(d.artifactId, 'Artifact');
        const artifact = current.revision === d.artifactRevision ? current : historical(d.artifactId, d.artifactRevision);
        if (!artifact || artifact.kind !== 'Artifact' || artifact.communityId !== object.communityId || artifact.data.blob.sha256 !== d.artifactSha256) fail('ATTESTATION_EVIDENCE_MISMATCH');
        const room = get(artifact.data.workroomId, 'Workroom');
        if (room.data.requestId !== d.requestId || !room.data.participantHumanIds.includes(d.issuerHumanId)) fail('ATTESTATION_SCOPE_MISMATCH');
        if (artifact.data.producerId !== d.subjectId || artifact.data.producerKind !== d.subjectKind) fail('ATTESTATION_SUBJECT_MISMATCH');
        if (object.visibility.scope === 'workroom' && object.visibility.workroomId !== room.id) fail('WORKROOM_SCOPE_MISMATCH');
        if (object.actor.kind !== 'Human' || object.actor.id !== d.issuerHumanId) fail('ATTESTATION_ISSUER_MISMATCH');
        if (d.supersedesId) { if (d.supersedesId === object.id) fail('ATTESTATION_SELF_SUPERSEDES'); get(d.supersedesId, 'Attestation'); }
        break;
      }
    }
  }
  return true;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

// Trusted-fixture contract harness only. No disk, network, identity verification,
// ACL enforcement or FlareMo integration. A live repository MUST add these gates.
export class MemoryObjectContract {
  #objects = new Map(); #history = new Map(); #commands = new Map(); #events = [];
  get(id) { return structuredClone(this.#objects.get(id)); }
  list() { return structuredClone([...this.#objects.values()]); }
  eventsAfter(cursor = 0) { return structuredClone(this.#events.filter(event => event.cursor > cursor)); }
  transact({ communityId, commandId, writes }) {
    if (!commandId || !Array.isArray(writes) || !writes.length || writes.length > 100) fail('INVALID_TRANSACTION');
    const key = JSON.stringify([communityId, commandId]);
    const fingerprint = createHash('sha256').update(JSON.stringify(stable(writes))).digest('hex');
    const prior = this.#commands.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
      return structuredClone(prior.receipt);
    }
    const next = new Map(this.#objects), history = new Map(this.#history), seen = new Set();
    for (const { expectedRevision, object } of writes) {
      validateObject(object);
      if (object.communityId !== communityId) fail('TRANSACTION_SCOPE_MISMATCH');
      if (seen.has(object.id)) fail('DUPLICATE_WRITE'); seen.add(object.id);
      const previous = next.get(object.id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (previous?.revision ?? 0) !== expectedRevision || object.revision !== expectedRevision + 1) fail('REVISION_CONFLICT');
      if (previous) {
        for (const field of ['kind', 'id', 'communityId', 'createdAt']) if (previous[field] !== object[field]) fail('IMMUTABLE_FIELD');
        if (object.updatedAt <= previous.updatedAt) fail('UPDATE_TIME_NOT_INCREASING');
        if (previous.lifecycle === 'tombstoned') fail('TOMBSTONE_IS_FINAL');
        if (previous.kind === 'Attestation') {
          const { status: oldStatus, ...oldClaim } = previous.data;
          const { status: newStatus, ...newClaim } = object.data;
          if (oldStatus !== 'issued' || newStatus !== 'revoked' || !equal(stable(oldClaim), stable(newClaim))) fail('ATTESTATION_IMMUTABLE');
        }
      }
      next.set(object.id, structuredClone(object)); history.set(`${object.id}@${object.revision}`, structuredClone(object));
    }
    validateGraph([...next.values()], (id, revision) => history.get(`${id}@${revision}`));
    const cursor = this.#events.length + 1;
    const receipt = { commandId, communityId, cursor, objects: writes.map(({ object }) => ({ id: object.id, revision: object.revision })) };
    this.#objects = next; this.#history = history;
    this.#events.push({ cursor, communityId, commandId, objects: receipt.objects });
    this.#commands.set(key, { fingerprint, receipt });
    return structuredClone(receipt);
  }
}
