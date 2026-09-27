// SIMULATED: joining without the principal ever handling a token. An agent asks
// for a code, a signed-in member sees what is being asked and grants what they
// choose, and the agent polls for the result exactly once.
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
  const agent = (method, path, body) => fetch(`${node.url}/api/agent/v1${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async response => ({ status: response.status, ...(await response.json()) }));
  return { node, owner, ed, agent };
}

test('an agent joins with one call and no token: the member approves in a browser and the agent polls for it', async t => {
  const { node, ed, agent } = await setup(t);
  const started = await agent('POST', '/device', { name: 'Ed 的 Codex', scopes: ['profile:draft', 'suggest', 'route'] });
  assert.match(started.userCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/u);
  assert.ok(started.deviceCode.length >= 43 && started.deviceCode !== started.userCode);
  assert.equal(started.verifyUrl, `${node.url}/router.html?authorize=${started.userCode}`);

  assert.deepEqual(await agent('POST', '/device/token', { deviceCode: started.deviceCode }), { mode: 'simulated', status: 'pending', intervalSeconds: 3 });

  // The member sees what is being asked before granting anything.
  const asked = await ed.get(`/router/device/${started.userCode}`);
  assert.equal(asked.agentName, 'Ed 的 Codex');
  assert.equal(asked.userCode, started.userCode, '页面上显示的编码要和终端里打印的一字不差，人才能对照');
  assert.deepEqual(asked.scopes.sort(), ['profile:draft', 'read', 'route', 'suggest']);

  // They grant less than was asked for.
  const granted = await ed.post(`/router/device/${started.userCode}/approve`, { scopes: ['profile:draft', 'suggest'] });
  assert.deepEqual(granted.scopes.sort(), ['profile:draft', 'read', 'suggest'], 'routing was asked for but not given');

  const claimed = await agent('POST', '/device/token', { deviceCode: started.deviceCode });
  assert.equal(claimed.status, 'approved');
  assert.match(claimed.token, /^amt_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);

  // The token works, and carries only what was granted.
  const me = await fetch(`${node.url}/api/agent/v1/me`, { headers: { authorization: `Bearer ${claimed.token}` } }).then(response => response.json());
  assert.equal(me.principal.name, 'Ed');
  assert.ok(!me.scopes.includes('route'));

  // The code is single-use: nobody can replay it.
  assert.equal((await agent('POST', '/device/token', { deviceCode: started.deviceCode })).error, 'DEVICE_CODE_INVALID');
});

test('a code grants nothing on its own: unapproved, denied, replayed and guessed codes all fail', async t => {
  const { ed, agent } = await setup(t);
  assert.equal((await agent('POST', '/device/token', { deviceCode: 'not-a-real-code' })).error, 'DEVICE_CODE_INVALID');
  assert.equal((await ed.get('/router/device/AAAA-BBBB-CCCC-DDDD').catch(error => ({ error: error.message }))).error, 'DEVICE_CODE_INVALID');

  const denied = await agent('POST', '/device', { name: '不认识的 Agent' });
  await ed.post(`/router/device/${denied.userCode}/deny`, {});
  const refused = await agent('POST', '/device/token', { deviceCode: denied.deviceCode });
  assert.deepEqual([refused.status, refused.error], [403, 'DEVICE_DENIED']);
  assert.equal((await agent('POST', '/device/token', { deviceCode: denied.deviceCode })).error, 'DEVICE_CODE_INVALID', '拒绝之后码就作废了');

  const twice = await agent('POST', '/device', {});
  await ed.post(`/router/device/${twice.userCode}/approve`, {});
  await assert.rejects(ed.post(`/router/device/${twice.userCode}/approve`, {}), /DEVICE_ALREADY_RESOLVED/u);
});

test('approving requires being a signed-in member; a visitor cannot grant anything', async t => {
  const { node, agent } = await setup(t);
  const started = await agent('POST', '/device', { name: 'X' });
  const stranger = await fetch(`${node.url}/api/router/device/${started.userCode}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: node.url }, body: '{}',
  });
  assert.equal(stranger.status, 401);
  assert.equal((await agent('POST', '/device/token', { deviceCode: started.deviceCode })).status, 'pending');
});
