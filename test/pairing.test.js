// SIMULATED: joining from the page. A member picks what their agent may do and
// gets one block of text to paste into whichever agent they use; the code is
// bound to them, single use and short lived, and buys a real token once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startNode } from '../apps/node/server.js';
import { MemoryObjectStore } from '../packages/store/memory-objects.js';
import { createMockLogin } from '../packages/identity/mock.js';
import { webUser, inviteAndJoin } from './support/harness.js';

const ROSTER = [{ username: 'owner', displayName: 'Owner' }, { username: 'ed', displayName: 'Ed' }];

async function setup(t) {
  const node = await startNode({ port: 0, mode: 'simulated', store: new MemoryObjectStore(), login: createMockLogin({ members: ROSTER }) });
  t.after(node.close);
  const owner = webUser(node), ed = webUser(node);
  await owner.post('/login', { username: 'owner' });
  await owner.post('/community', { communityName: 'C', displayName: 'Owner' });
  await ed.post('/login', { username: 'ed' });
  await inviteAndJoin(owner, ed, 'Ed');
  const pair = body => fetch(`${node.url}/api/agent/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async response => ({ status: response.status, ...(await response.json()) }));
  return { node, owner, ed, pair };
}

test('one block of text, any agent: the member copies it, the agent redeems it once and is connected', async t => {
  const { node, ed, pair } = await setup(t);
  const made = await ed.post('/router/pairing', { name: 'Ed 的助手', scopes: ['profile:draft', 'suggest'] });

  // The text names an address, a code and what to do — no vendor's command anywhere.
  assert.match(made.instructions, new RegExp(`${node.url}/agents\\.md`, 'u'));
  assert.match(made.instructions, new RegExp(`${node.url}/api/agent/v1/pair`, 'u'));
  assert.match(made.instructions, new RegExp(`${node.url}/mcp`, 'u'));
  assert.ok(made.instructions.includes(made.code));
  assert.ok(!/claude |codex |npx /u.test(made.instructions), '不绑定任何一家的命令行');

  const connected = await pair({ code: made.code });
  assert.equal(connected.principal.name, 'Ed');
  assert.deepEqual(connected.scopes.sort(), ['profile:draft', 'read', 'suggest']);
  assert.match(connected.token, /^amt_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);

  const me = await fetch(`${node.url}/api/agent/v1/me`, { headers: { authorization: `Bearer ${connected.token}` } }).then(response => response.json());
  assert.equal(me.principal.name, 'Ed');

  // Redeemed, so the copy left in a chat transcript is worth nothing.
  assert.deepEqual([(await pair({ code: made.code })).status, (await pair({ code: made.code })).error], [404, 'PAIRING_CODE_INVALID']);
});

test('a pairing code is worthless without a member behind it, and carries only what they granted', async t => {
  const { ed, pair } = await setup(t);
  assert.equal((await pair({ code: 'AAAA-BBBB-CCCC-DDDD' })).error, 'PAIRING_CODE_INVALID');
  assert.equal((await pair({ code: '' })).error, 'PAIRING_CODE_INVALID');

  const narrow = await ed.post('/router/pairing', { scopes: ['suggest'] });
  const connected = await pair({ code: narrow.code });
  assert.deepEqual(connected.scopes.sort(), ['read', 'suggest'], '没勾的权限不会因为 Agent 想要就出现');
  assert.equal(connected.agentName, 'Ed 的 Agent', '没给名字就用主人的默认名');
  await assert.rejects(ed.post('/router/pairing', { scopes: ['everything'] }), /INVALID_SCOPES/u);
});
