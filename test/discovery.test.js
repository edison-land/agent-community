import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discoverCapabilities } from '../packages/core/discovery.js';
import { MockGateway } from '../packages/gateway/mock.js';

const generic = JSON.parse(await readFile(new URL('../examples/communities/generic.json', import.meta.url)));
const kosx = JSON.parse(await readFile(new URL('../examples/communities/kosx.json', import.meta.url)));
const combined = Object.fromEntries(Object.keys(generic).map(key => [key, [...generic[key], ...kosx[key]]]));

test('discovery keeps community scope and distinguishes actor from principal', () => {
  const results = discoverCapabilities(combined, { communityId: 'c-001', query: ' RESEARCH ' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'cap-002');
  assert.deepEqual(results[0].provider, { kind: 'agent', id: 'a-001' });
  assert.equal(results[0].principalId, 'h-001');
  assert.equal(discoverCapabilities(combined, { communityId: 'c-002' }).length, 2);
});

test('revoked membership removes both human and agent offers', () => {
  const catalog = structuredClone(generic);
  catalog.memberships[0].status = 'revoked';
  assert.deepEqual(discoverCapabilities(catalog, { communityId: 'c-001' }), []);
});

test('revoked or orphaned agents cannot advertise', () => {
  for (const mutate of [
    catalog => { catalog.agents[0].status = 'revoked'; },
    catalog => { catalog.agents[0].principalId = 'h-missing'; },
    catalog => { catalog.agents = []; },
  ]) {
    const catalog = structuredClone(generic);
    mutate(catalog);
    assert.deepEqual(discoverCapabilities(catalog, { communityId: 'c-001' }).map(item => item.id), ['cap-001']);
  }
});

test('a known principal from a different community cannot advertise locally', () => {
  const catalog = structuredClone(combined);
  catalog.capabilities.push({ ...catalog.capabilities[3], id: 'cap-forged', communityId: 'c-001' });
  assert.equal(discoverCapabilities(catalog, { communityId: 'c-001' }).length, 2);
});

test('unknown scope is rejected and unmatched queries are empty', () => {
  assert.throws(() => discoverCapabilities(generic, { communityId: 'unknown' }), /UNKNOWN_COMMUNITY/);
  assert.deepEqual(discoverCapabilities(generic, { communityId: 'c-001', query: 'unavailable' }), []);
});

test('renaming a community leaves behavior unchanged and results cannot mutate input', () => {
  const renamed = structuredClone(generic);
  renamed.communities[0].name = 'Independent Research Group';
  const results = discoverCapabilities(renamed, { communityId: 'c-001' });
  assert.deepEqual(results, discoverCapabilities(generic, { communityId: 'c-001' }));
  results[0].provider.id = 'changed';
  assert.equal(renamed.capabilities[0].provider.id, 'h-001');
});

test('mock describes itself honestly and refuses execution and cancellation', async () => {
  const gateway = new MockGateway();
  assert.deepEqual(gateway.describe(), { adapter: 'mock', synthetic: true, operations: ['describe'] });
  await assert.rejects(gateway.submit(), /NOT_IMPLEMENTED/);
  await assert.rejects(gateway.cancel(), /NOT_IMPLEMENTED/);
});
