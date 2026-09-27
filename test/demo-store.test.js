// SIMULATED: the public demo's Durable Object store (apps/worker/src/demo-store.js)
// against an in-memory stand-in for Durable Object storage. A second store built
// on the same storage must see exactly what the first committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { durableDemoStore } from '../apps/worker/src/demo-store.js';
import { freshGraph } from './support/graph.js';

class FakeStorage {
  map = new Map();
  async list({ prefix = '' } = {}) { return new Map([...this.map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); }
  async put(entries) { if (Object.keys(entries).length > 128) throw new Error('too many keys'); for (const [key, value] of Object.entries(entries)) this.map.set(key, structuredClone(value)); }
  async deleteAll() { this.map.clear(); }
}

test('committed writes, events, idempotency receipts and blobs survive a restart of the object', async () => {
  const storage = new FakeStorage();
  const first = await durableDemoStore(storage);
  const g = freshGraph();
  const seed = g.objects.slice(0, 7).map(entity => ({ expectedRevision: 0, entity }));
  const receipt = await first.transact({ communityId: g.c, commandId: 'seed', writes: seed });
  const blob = await first.putBlob(g.c, Buffer.from('# report'), 'text/markdown');
  const human = await first.get(g.c, 'object', g.a);
  await first.transact({ communityId: g.c, commandId: 'rename', writes: [{ expectedRevision: 1, entity: { ...human, revision: 2, updatedAt: new Date(Date.parse(human.updatedAt) + 1).toISOString(), data: { ...human.data, displayName: 'Renamed' } } }] });

  const second = await durableDemoStore(storage);
  assert.equal((await second.get(g.c, 'object', g.a)).data.displayName, 'Renamed');
  assert.equal((await second.version(g.c, 'object', g.a, 1)).data.displayName, human.data.displayName, 'history reloaded');
  assert.deepEqual((await second.events(g.c, 0, 100)).events.map(event => event.cursor), [...Array(8).keys()].map(index => index + 1));
  assert.equal((await second.getBlob(g.c, blob.sha256)).bytes.toString(), '# report');
  const replay = await second.transact({ communityId: g.c, commandId: 'seed', writes: seed });
  assert.deepEqual([replay.replayed, replay.cursor], [true, receipt.cursor], 'the receipt survives, so retries stay idempotent');
  await assert.rejects(second.transact({ communityId: g.c, commandId: 'stale', writes: [{ expectedRevision: 1, entity: { ...human, revision: 2 } }] }), /REVISION_CONFLICT/);
  await storage.deleteAll();
  const wiped = await durableDemoStore(storage);
  await assert.rejects(wiped.get(g.c, 'object', g.a), /COMMUNITY_NOT_FOUND/, 'reset leaves nothing behind');
});
