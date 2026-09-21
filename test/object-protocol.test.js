import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { objectKinds, validateObject, validateGraph, MemoryObjectContract } from '../packages/protocol/objects.js';

const fixture = () => JSON.parse(readFileSync(new URL('../examples/protocol/eight-objects.json', import.meta.url))).objects;
const initial = objects => ({ communityId: objects[0].communityId, commandId: 'bootstrap', writes: objects.map(object => ({ expectedRevision: 0, object })) });
const changed = object => ({ ...structuredClone(object), revision: object.revision + 1, updatedAt: '2026-09-21T00:00:01.000Z' });

test('eight core types have strict shapes and a complete synthetic object graph', () => {
  const objects = fixture();
  assert.equal(objectKinds.length, 8); assert.deepEqual(new Set(objects.map(o => o.kind)), new Set(objectKinds));
  assert.equal(objects.length, 9); assert.equal(validateGraph(objects), true);
  const human = objects.find(o => o.kind === 'Human');
  for (const mutate of [o => { o.data.status = 'administrator'; }, o => { o.token = 'forbidden-field'; }, o => { o.revision = 0; }, o => { o.updatedAt = '2026-02-30T00:00:00.000Z'; }, o => { delete o.actor; }]) {
    const copy = structuredClone(human); mutate(copy); assert.throws(() => validateObject(copy));
  }
});

test('references cannot be missing, wrong-kind, cross-community, or forged principals', () => {
  for (const mutate of [
    objects => { objects.find(o => o.kind === 'Agent').data.principalId = 'urn:uuid:00000000-0000-0000-0000-000000000000'; },
    objects => { objects.find(o => o.kind === 'Agent').data.principalId = objects[0].id; },
    objects => { objects.find(o => o.kind === 'Agent').communityId = 'urn:uuid:00000000-0000-0000-0000-000000000000'; },
    objects => { objects.find(o => o.kind === 'Artifact').actor.principalId = objects[1].id; },
    objects => { objects.find(o => o.kind === 'Workroom').data.participantHumanIds = [objects[1].id]; },
  ]) { const objects = fixture(); mutate(objects); assert.throws(() => validateGraph(objects)); }
});

test('atomic bootstrap resolves mutual references; idempotent replay emits only one event', () => {
  const store = new MemoryObjectContract(), objects = fixture(), command = initial(objects);
  const receipt = store.transact(command);
  assert.equal(store.list().length, 9); assert.deepEqual(store.transact(command), receipt);
  assert.equal(store.eventsAfter().length, 1); assert.equal(store.eventsAfter(1).length, 0);
  const conflicting = structuredClone(command); conflicting.writes[0].object.data.displayName = 'Changed';
  assert.throws(() => store.transact(conflicting), /IDEMPOTENCY_CONFLICT/);
  const leaked = store.get(objects[0].id); leaked.data.displayName = 'External mutation';
  assert.equal(store.get(objects[0].id).data.displayName, 'Example Builders');
});

test('references to an existing object in a different community are rejected', () => {
  const first = fixture(), replacements = new Map(first.map(object => [object.id, `urn:uuid:${randomUUID()}`]));
  const second = JSON.parse(JSON.stringify(first), (_key, value) => replacements.get(value) ?? value);
  assert.equal(validateGraph([...first, ...second]), true);
  first.find(object => object.kind === 'Capability').data.providerId = second.find(object => object.kind === 'Agent').id;
  assert.throws(() => validateGraph([...first, ...second]), /CROSS_COMMUNITY_REFERENCE/);
});

test('failed graph transaction leaves no partial records or event', () => {
  const objects = fixture(), store = new MemoryObjectContract(); objects.pop();
  objects.find(o => o.kind === 'Agent').data.principalId = objects[0].id;
  assert.throws(() => store.transact(initial(objects)), /REFERENCE_KIND_MISMATCH/);
  assert.deepEqual(store.list(), []); assert.deepEqual(store.eventsAfter(), []);
});

test('stale writers cannot overwrite new revisions', () => {
  const objects = fixture(), store = new MemoryObjectContract(); store.transact(initial(objects));
  const request = objects.find(o => o.kind === 'Request'), object = changed(request); object.data.title = 'Updated scope';
  store.transact({ communityId: object.communityId, commandId: 'edit', writes: [{ expectedRevision: 1, object }] });
  assert.throws(() => store.transact({ communityId: object.communityId, commandId: 'stale-edit', writes: [{ expectedRevision: 1, object }] }), /REVISION_CONFLICT/);
  assert.equal(store.get(object.id).revision, 2); assert.equal(store.eventsAfter(1).length, 1);
});

test('attestations pin evidence version/hash and cannot rewrite a published claim', () => {
  const objects = fixture(), store = new MemoryObjectContract(); store.transact(initial(objects));
  const artifact = changed(objects.find(o => o.kind === 'Artifact')); artifact.data.blob.sha256 = 'b'.repeat(64);
  store.transact({ communityId: artifact.communityId, commandId: 'new-artifact-version', writes: [{ expectedRevision: 1, object: artifact }] });
  const attestation = objects.find(o => o.kind === 'Attestation');
  assert.equal(store.get(attestation.id).data.artifactRevision, 1);
  const edited = changed(attestation); edited.data.statement = 'Rewrite history';
  assert.throws(() => store.transact({ communityId: edited.communityId, commandId: 'rewrite', writes: [{ expectedRevision: 1, object: edited }] }), /ATTESTATION_IMMUTABLE/);
  const invalid = fixture(); invalid.find(o => o.kind === 'Attestation').data.artifactSha256 = 'f'.repeat(64);
  assert.throws(() => validateGraph(invalid), /ATTESTATION_EVIDENCE_MISMATCH/);
});

test('request acceptance requires matching requester evidence, not an execution success flag', () => {
  const objects = fixture().filter(o => o.kind !== 'Attestation'); objects.find(o => o.kind === 'Request').data.status = 'accepted';
  assert.throws(() => validateGraph(objects), /ACCEPTANCE_EVIDENCE_REQUIRED/);
});

test('A2A example uses selected v1 wire vocabulary and references the same object graph', () => {
  const profile = JSON.parse(readFileSync(new URL('../protocols/a2a/v0.1/profile.json', import.meta.url)));
  const message = JSON.parse(readFileSync(new URL('../examples/protocol/a2a-send-message.json', import.meta.url)));
  const objects = fixture(); const metadata = message.params.message.metadata[profile.extensionUri];
  assert.equal(profile.a2aWireVersion, '1.0'); assert.equal(profile.sdk.installed, false);
  assert.equal(message.method, 'SendMessage'); assert.equal(message.params.message.role, 'ROLE_USER');
  assert.equal(message.params.message.parts[0].kind, undefined);
  for (const [field, kind] of [['communityId','Community'],['requestId','Request'],['workroomId','Workroom'],['recipientAgentId','Agent'],['capabilityId','Capability']]) {
    assert.equal(objects.find(o => o.id === metadata[field])?.kind, kind);
  }
  assert.ok(message.params.message.extensions.includes(profile.extensionUri));
  assert.equal(metadata.actor.principalId, objects.find(o => o.kind === 'Request').data.requesterHumanId);
});
