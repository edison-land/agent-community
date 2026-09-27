// The community's own store. What a community is doing lives here, so these
// tests hold it to the two things that were missing before real members could
// depend on it: it survives the node restarting, and it refuses to grow past
// what it was given rather than failing later in some less legible way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDurableStore, DEFAULT_LIMITS } from '../packages/store/durable-objects.js';

/** Durable Object storage, as much of it as the store uses. */
function fakeStorage(initial = new Map()) {
  const data = new Map(initial);
  return {
    data,
    async put(entries) { for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value)); },
    async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : 1)); },
  };
}

const COMMUNITY = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const at = new Date('2026-09-27T00:00:00.000Z').toISOString();
let counter = 0;
const entity = (kind, data = {}, id = null) => ({
  id: id ?? `urn:uuid:22222222-2222-4222-8222-${String(++counter).padStart(12, '0')}`,
  communityId: COMMUNITY, kind, protocol: 'community-objects', revision: 1, lifecycle: 'active', createdAt: at, updatedAt: at,
  actor: { kind: 'Human', id: OWNER, principalId: OWNER }, visibility: { scope: 'community' }, data,
});
// A request belongs to whoever asked for it; the store refuses one that points nowhere.
const write = (kind, data = {}) => ({ expectedRevision: 0, entity: entity(kind, kind === 'Request' ? { requesterHumanId: OWNER, ...data } : data) });
// A community exists before anything can be written into it, and it is owned by
// someone: the store's first transaction creates both, and refuses either alone.
const OWNER = 'urn:uuid:33333333-3333-4333-8333-333333333333';
const found = store => store.transact({ communityId: COMMUNITY, commandId: `found-${++counter}`, writes: [
  { expectedRevision: 0, entity: entity('Human', { displayName: 'Mia' }, OWNER) },
  { expectedRevision: 0, entity: entity('Community', { displayName: '试点社区', ownerHumanId: OWNER }, COMMUNITY) },
] });

test('what the community commits is still there after the node restarts', async () => {
  const storage = fakeStorage();
  const first = await createDurableStore(storage, { serviceId: 'node-1', origin: 'https://node.example' });
  await found(first);
  const receipt = await first.transact({ communityId: COMMUNITY, commandId: 'c-1', writes: [write('Request', { title: '香港招聘行业的 AI 情报产品' })] });
  const id = receipt.entities[0].id;
  await first.putBlob(COMMUNITY, Buffer.from('# 交付', 'utf8'), 'text/markdown');

  // A new object over the same storage: this is what a deploy or eviction does.
  const second = await createDurableStore(storage, { serviceId: 'node-1', origin: 'https://node.example' });
  assert.equal((await second.get(COMMUNITY, 'object', id)).data.title, '香港招聘行业的 AI 情报产品');
  assert.equal((await second.list(COMMUNITY, 'object', 'Request')).length, 1);
  assert.equal((await second.events(COMMUNITY)).events.length, 3, '建社区两条，加这条需求');
  const sha = (await second.putBlob(COMMUNITY, Buffer.from('# 交付', 'utf8'), 'text/markdown')).sha256;
  assert.equal((await second.getBlob(COMMUNITY, sha)).bytes.toString('utf8'), '# 交付');
});

test('a command replayed after a restart does not write the thing twice', async () => {
  const storage = fakeStorage();
  const first = await createDurableStore(storage, { serviceId: 'node-1' });
  await found(first);
  // The same command means the same writes: a retry after a restart sends what
  // it sent before, and the store recognises it rather than acting twice.
  const writes = [write('Request', { title: '同一条命令' })];
  const once = await first.transact({ communityId: COMMUNITY, commandId: 'same', writes });
  const second = await createDurableStore(storage, { serviceId: 'node-1' });
  const twice = await second.transact({ communityId: COMMUNITY, commandId: 'same', writes });
  assert.equal(twice.replayed, true);
  assert.equal(twice.cursor, once.cursor);
  assert.equal((await second.list(COMMUNITY, 'object', 'Request')).length, 1);
});

test('the node counts what it is already holding, instead of starting from zero', async () => {
  const storage = fakeStorage();
  const first = await createDurableStore(storage, { serviceId: 'node-1' });
  await found(first);
  await first.transact({ communityId: COMMUNITY, commandId: 'c-1', writes: [write('Request', {}), write('Request', {})] });
  await first.putBlob(COMMUNITY, Buffer.alloc(1024), 'application/octet-stream');
  assert.equal(first.usage().entities, 4, '社区、拥有者，加上两条需求');

  const second = await createDurableStore(storage, { serviceId: 'node-1' });
  assert.equal(second.usage().entities, 4, '重启后应当记得已经存了多少');
  assert.equal(second.usage().blobBytes, 1024);
});

test('a community that outgrows its node is told so, and nothing is half-written', async () => {
  const store = await createDurableStore(fakeStorage(), { serviceId: 'node-1', limits: { entities: 4 } });
  await found(store);
  await store.transact({ communityId: COMMUNITY, commandId: 'c-1', writes: [write('Request', {}), write('Request', {})] });
  await assert.rejects(
    store.transact({ communityId: COMMUNITY, commandId: 'c-2', writes: [write('Request', {})] }),
    error => error.name === 'StoreError' && error.message === 'COMMUNITY_FULL' && error.status === 507,
  );
  assert.equal((await store.list(COMMUNITY, 'object', 'Request')).length, 2, '被拒绝的那次不该留下任何东西');
  assert.equal(store.usage().entities, 4);
});

test('a full community can still be wound down: updates are not new entities', async () => {
  const store = await createDurableStore(fakeStorage(), { serviceId: 'node-1', limits: { entities: 3 } });
  await found(store);
  const receipt = await store.transact({ communityId: COMMUNITY, commandId: 'c-1', writes: [write('Request', { title: '第一条' })] });
  const existing = await store.get(COMMUNITY, 'object', receipt.entities[0].id);
  const later = new Date(Date.parse(at) + 1000).toISOString();
  await store.transact({ communityId: COMMUNITY, commandId: 'c-2', writes: [{ expectedRevision: 1, entity: { ...existing, revision: 2, updatedAt: later, data: { ...existing.data, title: '关闭' } } }] });
  assert.equal((await store.get(COMMUNITY, 'object', existing.id)).data.title, '关闭');
});

test('one oversized delivery is refused; the rest of the community is untouched', async () => {
  const store = await createDurableStore(fakeStorage(), { serviceId: 'node-1', limits: { blobSize: 64 } });
  await found(store);
  await assert.rejects(
    store.putBlob(COMMUNITY, Buffer.alloc(65), 'text/markdown'),
    error => error.name === 'StoreError' && error.message === 'BLOB_TOO_LARGE' && error.status === 413,
  );
  const ok = await store.putBlob(COMMUNITY, Buffer.alloc(64), 'text/markdown');
  assert.equal(ok.size, 64);
});

test('deliveries stop when the node is out of room for them', async () => {
  const store = await createDurableStore(fakeStorage(), { serviceId: 'node-1', limits: { blobBytes: 100, blobSize: 100 } });
  await found(store);
  await store.putBlob(COMMUNITY, Buffer.from('a'.repeat(60)), 'text/markdown');
  await assert.rejects(
    store.putBlob(COMMUNITY, Buffer.from('b'.repeat(60)), 'text/markdown'),
    error => error.name === 'StoreError' && error.message === 'COMMUNITY_STORAGE_FULL' && error.status === 507,
  );
});

test('a stored delivery names the node that actually holds it', async () => {
  const store = await createDurableStore(fakeStorage(), { serviceId: 'node-1', origin: 'https://agent-network.example' });
  await found(store);
  assert.ok(store.blobUri(COMMUNITY, 'a'.repeat(64)).startsWith('https://agent-network.example/'));
  assert.equal(store.kind, 'community-durable');
});

test('the node refuses to start without an identity of its own', async () => {
  await assert.rejects(createDurableStore(fakeStorage(), {}), error => error.name === 'StoreError' && error.message === 'MISSING_SERVICE_ID');
});

test('the defaults are the ones a pilot is given', () => {
  assert.deepEqual(DEFAULT_LIMITS, { entities: 50_000, blobBytes: 64 * 1024 * 1024, blobSize: 2 * 1024 * 1024 });
});
