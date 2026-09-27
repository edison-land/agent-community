/**
 * REAL INTEGRATION (phase 1): talks to the independent local FlareMo instance
 * over HTTP with the community service PAT. Run with `npm run test:live`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlareMoObjectStore } from '../../packages/store/flaremo-objects.js';
import { validateGraph } from '../../packages/protocol/objects.js';
import { freshGraph, bump } from '../support/graph.js';
import { localState, flaremo, signIn } from '../support/local.js';

const state = localState();
const store = new FlareMoObjectStore({ baseUrl: state.url, token: state.service.pat, allowLocal: true });
const writes = entities => entities.map(entity => ({ expectedRevision: entity.revision - 1, entity }));
const code = async promise => { try { await promise; return 'OK'; } catch (error) { return error.code; } };

async function seed() {
  const report = Buffer.from(`# Live storage probe ${Date.now()}\n`);
  const sha = (await import('node:crypto')).createHash('sha256').update(report).digest('hex');
  const g = freshGraph({ blobSha: sha });
  const [artifact, attestation] = g.objects.splice(7, 2);
  const first = await store.transact({ communityId: g.c, commandId: 'seed', writes: writes(g.objects) });
  const blob = await store.putBlob(g.c, report, 'text/markdown; charset=utf-8');
  artifact.data.blob.uri = store.blobUri(g.c, blob.sha256);
  await store.transact({ communityId: g.c, commandId: 'evidence', writes: writes([artifact, attestation]) });
  g.objects.push(artifact, attestation);
  return { ...g, first, report };
}

test('eight object kinds are stored in real local FlareMo with history, events and verified blobs', async () => {
  const g = await seed();
  const objects = await store.list(g.c, 'object');
  assert.equal(objects.length, 9);
  assert.deepEqual(new Set(objects.map(o => o.kind)).size, 8);
  const versions = new Map([[`${g.art}@1`, await store.version(g.c, 'object', g.art, 1)]]);
  assert.equal(validateGraph(objects, (id, revision) => versions.get(`${id}@${revision}`)), true);
  const { events } = await store.events(g.c, 0);
  assert.equal(events.length, 9);
  assert.ok(events.every((event, index) => index === 0 || event.cursor > events[index - 1].cursor));
  const blob = await store.getBlob(g.c, objects.find(o => o.kind === 'Artifact').data.blob.sha256);
  assert.equal(blob.bytes.toString(), g.report.toString());
});

test('stale and concurrent writers: exactly one revision wins, stale writers get 409', async () => {
  const g = await seed();
  const request = g.objects.find(o => o.kind === 'Request');
  const results = await Promise.all([1, 2, 3].map(n => code(store.transact({ communityId: g.c, commandId: `race-${n}`, writes: writes([bump(request, { title: `writer ${n}` }, n * 1000)]) }))));
  assert.equal(results.filter(r => r === 'OK').length, 1);
  assert.ok(results.filter(r => r !== 'OK').every(r => r === 'REVISION_CONFLICT'));
  assert.equal(await code(store.transact({ communityId: g.c, commandId: 'stale', writes: writes([bump(request, { title: 'stale' }, 9000)]) })), 'REVISION_CONFLICT');
  assert.equal((await store.get(g.c, 'object', request.id)).revision, 2);
});

test('multi-object transactions are atomic even when racing another writer', async () => {
  const g = await seed();
  const human = g.objects.find(o => o.id === g.a), request = g.objects.find(o => o.kind === 'Request');
  let partialObserved = 0, pairFailures = 0;
  let current = { human, request };
  for (let round = 0; round < 12; round += 1) {
    const pair = [bump(current.human, { displayName: `A${round}` }, 1000), bump(current.request, { title: `pair ${round}` }, 1000)];
    const solo = bump(current.request, { title: `solo ${round}` }, 2000);
    const sendPair = () => code(store.transact({ communityId: g.c, commandId: `pair-${round}`, writes: writes(pair) }));
    const sendSolo = () => code(store.transact({ communityId: g.c, commandId: `solo-${round}`, writes: writes([solo]) }));
    // Alternate who reaches FlareMo first so both outcomes are exercised.
    const [a, b] = round % 2 ? await Promise.all([sendPair(), sendSolo()]) : (await Promise.all([sendSolo(), sendPair()])).reverse();
    const humanNow = await store.get(g.c, 'object', g.a), requestNow = await store.get(g.c, 'object', request.id);
    if (a !== 'OK') {
      pairFailures += 1;
      if (humanNow.revision !== current.human.revision) partialObserved += 1;
    }
    assert.equal([a, b].filter(result => result === 'OK').length, 1, `round ${round}: ${a}/${b}`);
    assert.equal(requestNow.revision, current.request.revision + 1);
    current = { human: humanNow, request: requestNow };
  }
  assert.equal(partialObserved, 0);
  assert.ok(pairFailures > 0, 'the race produced at least one failed pair to inspect');
  // Invalid second write: the whole command is rejected and nothing lands.
  const before = await store.get(g.c, 'object', g.a);
  const broken = bump(current.request, { capabilityIds: ['urn:uuid:00000000-0000-4000-8000-000000000000'] }, 5000);
  assert.equal(await code(store.transact({ communityId: g.c, commandId: 'broken', writes: writes([bump(before, { displayName: 'should not land' }, 5000), broken]) })), 'MISSING_REFERENCE');
  assert.equal((await store.get(g.c, 'object', g.a)).revision, before.revision);
});

test('retried commands replay the original receipt; changed payloads are refused', async () => {
  const g = await seed();
  const request = g.objects.find(o => o.kind === 'Request');
  const edit = bump(request, { title: 'retried' });
  const first = await store.transact({ communityId: g.c, commandId: 'retry-me', writes: writes([edit]) });
  const again = await store.transact({ communityId: g.c, commandId: 'retry-me', writes: writes([edit]) });
  assert.deepEqual(again, { ...first, replayed: true });
  assert.equal((await store.events(g.c, first.cursor - 1)).events.length, 1);
  assert.equal(await code(store.transact({ communityId: g.c, commandId: 'retry-me', writes: writes([bump(request, { title: 'different' })]) })), 'IDEMPOTENCY_CONFLICT');
});

test('only the bound service identity reaches a community; references never cross communities', async () => {
  const g = await seed(), other = freshGraph();
  await store.transact({ communityId: other.c, commandId: 'second', writes: writes(other.objects.slice(0, 3)) });
  const leak = bump(other.objects[2], {}, 1000);
  leak.actor = { kind: 'Human', id: g.a, principalId: g.a };
  assert.equal(await code(store.transact({ communityId: other.c, commandId: 'leak', writes: writes([leak]) })), 'CROSS_COMMUNITY_REFERENCE');

  const b = state.accounts.find(account => account.label === 'member-b');
  const cookie = await signIn(state, b.username, b.password);
  const pat = (await flaremo(state, '/api/app/account/personal-access-tokens', { method: 'POST', cookie, body: { name: 'isolation-probe', expires_in_days: 1 } })).json.token;
  const intruder = new FlareMoObjectStore({ baseUrl: state.url, token: pat, allowLocal: true });
  assert.equal(await code(intruder.get(g.c, 'object', g.a)), 'SERVICE_ACCOUNT_REQUIRED');
  const owner = await signIn(state, 'owner', state.ownerPassword);
  assert.equal((await flaremo(state, '/api/community/v1/service-accounts', { method: 'POST', cookie: owner, body: { userId: b.id, status: 'active' } })).status, 200);
  try {
    assert.equal(await code(intruder.get(g.c, 'object', g.a)), 'COMMUNITY_NOT_FOUND');
    assert.equal(await code(intruder.transact({ communityId: g.c, commandId: 'hijack', writes: writes([bump(g.objects[1])]) })), 'COMMUNITY_NOT_FOUND');
  } finally {
    await flaremo(state, '/api/community/v1/service-accounts', { method: 'POST', cookie: owner, body: { userId: b.id, status: 'disabled' } });
  }
  assert.equal((await flaremo(state, `/api/community/v1/objects/${encodeURIComponent(g.a)}?communityId=${encodeURIComponent(g.c)}`, { cookie: owner })).status, 403);
});
