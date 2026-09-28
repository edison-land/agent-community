// SIMULATED: invitation-only joining, restricted bootstrap, persistent sessions
// through the KV contract, and the single-writer read cache in front of the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatedNode, webUser, inviteAndJoin } from './support/harness.js';
import { createCommunityApp } from '../packages/app/community-app.js';
import { MemoryKV } from '../packages/runtime/kv.js';
import { MemoryObjectStore } from '../packages/store/memory-objects.js';
import { CachedStore } from '../packages/store/cached.js';
import { createMockLogin } from '../packages/identity/mock.js';
import { loadMaterials } from '../packages/community/materials.js';
import { freshGraph } from './support/graph.js';

const rejects = async (promise, code) => assert.rejects(promise, error => (error.code ?? error.message) === code);
const identity = subject => ({ provider: 'urn:agent-community:local-demo', subject });

test('joining requires an owner-issued invitation; codes are shown once, limited, expiring and revocable', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: 'demo-maker' });
  await a.post('/community', { communityName: 'C', displayName: 'Owner' });
  await b.post('/login', { username: 'demo-helper' });
  await rejects(b.post('/join', { displayName: 'B' }), 'INVITE_REQUIRED');
  await rejects(b.post('/join', { displayName: 'B', inviteCode: 'AAAA-BBBB-CCCC-DDDD' }), 'INVITE_INVALID');
  await rejects(b.post('/invitations', { maxUses: 1 }), 'MEMBERSHIP_REQUIRED');

  const invite = await a.post('/invitations', { maxUses: 1, ttlHours: 1, label: 'first member' });
  assert.match(invite.code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  assert.equal(invite.inviteUrl, `${node.url}/invite/${invite.code}`);
  const listed = await a.get('/invitations');
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(invite.code) && !('codeHash' in listed[0]), 'the code is never listed again');
  await b.post('/join', { displayName: 'B', inviteCode: invite.code });
  assert.equal((await a.get('/invitations'))[0].status, 'exhausted');
  await rejects(b.post('/invitations', { maxUses: 1 }), 'OWNER_REQUIRED');

  const ownerId = (await a.get('/state')).me.member.human.id;
  const svc = node.service;
  await rejects(svc.join({ identity: identity('users/c'), displayName: 'C', inviteCode: invite.code }), 'INVITE_EXHAUSTED');
  const revoked = await a.post('/invitations', { maxUses: 5 });
  await a.post(`/invitations/${revoked.invitationId}/revoke`);
  await rejects(svc.join({ identity: identity('users/c'), displayName: 'C', inviteCode: revoked.code }), 'INVITE_REVOKED');
  const short = await svc.createInvitation({ humanId: ownerId, maxUses: 1, ttlHours: 0.00001 });
  await new Promise(resolve => setTimeout(resolve, 60));
  await rejects(svc.join({ identity: identity('users/c'), displayName: 'C', inviteCode: short.code }), 'INVITE_EXPIRED');

  // Two people racing for the last seat: the revision check lets exactly one in.
  const last = await svc.createInvitation({ humanId: ownerId, maxUses: 1, ttlHours: 1 });
  const results = await Promise.allSettled([
    svc.join({ identity: identity('users/racer-1'), displayName: 'R1', inviteCode: last.code }),
    svc.join({ identity: identity('users/racer-2'), displayName: 'R2', inviteCode: last.code }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INVITE_EXHAUSTED');
});

test('only the configured owner can create the community on a public node', async t => {
  const node = await simulatedNode({ openBootstrap: false, ownerSubject: 'users/demo-maker' }); t.after(node.close);
  const a = webUser(node), b = webUser(node);
  await b.post('/login', { username: 'demo-helper' });
  assert.equal((await b.get('/state')).canBootstrap, false);
  await rejects(b.post('/community', { communityName: 'Hijack', displayName: 'B' }), 'BOOTSTRAP_NOT_ALLOWED');
  await a.post('/login', { username: 'demo-maker' });
  assert.equal((await a.get('/state')).canBootstrap, true);
  await a.post('/community', { communityName: 'C', displayName: 'Owner' });
  const unconfigured = await simulatedNode({ openBootstrap: false }); t.after(unconfigured.close);
  const c = webUser(unconfigured); await c.post('/login', { username: 'demo-maker' });
  await rejects(c.post('/community', { communityName: 'C', displayName: 'X' }), 'BOOTSTRAP_NOT_CONFIGURED');
});

test('sessions live in the KV contract and survive a new app instance (Worker eviction)', async () => {
  const kv = new MemoryKV(), store = new MemoryObjectStore(), login = createMockLogin();
  const origin = 'http://127.0.0.1:65000';
  const make = () => createCommunityApp({ mode: 'simulated', store, login, kv, materials: loadMaterials(), onboarding: '', publicOrigin: origin, openBootstrap: true });
  const call = async (app, method, path, body, cookie) => app.fetch(new Request(`${origin}${path}`, {
    method, headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }));
  const first = await make();
  const login1 = await call(first, 'POST', '/api/login', { username: 'demo-maker' });
  const cookie = login1.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call(first, 'POST', '/api/community', { communityName: 'C', displayName: 'Owner' }, cookie)).status, 201);
  const second = await make();
  const state = await (await call(second, 'GET', '/api/state', undefined, cookie)).json();
  assert.equal(state.me.member.membership.data.role, 'owner', 'same session and community after re-creation');
  assert.equal((await call(second, 'GET', '/api/state', undefined, cookie)).headers.get('x-community-mode'), 'simulated');
  const wrongHost = await second.fetch(new Request('http://evil.example/api/state'));
  assert.equal(wrongHost.status, 403);
  await call(second, 'POST', '/api/logout', {}, cookie);
  assert.equal((await (await call(first, 'GET', '/api/state', undefined, cookie)).json()).me, null, 'logout reaches every instance');
});

test('https origins get Secure cookies and HSTS', async () => {
  const origin = 'https://agent-network.example';
  const app = await createCommunityApp({ mode: 'simulated', store: new MemoryObjectStore(), login: createMockLogin(), kv: new MemoryKV(), materials: loadMaterials(), onboarding: '', publicOrigin: origin, openBootstrap: true });
  const response = await app.fetch(new Request(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-maker' }) }));
  assert.match(response.headers.getSetCookie()[0], /; Secure$/);
  assert.match(response.headers.get('strict-transport-security'), /max-age=/);
});

test('read cache: repeated reads stay local, own writes are visible at once, outside writes after sync', async () => {
  const inner = new MemoryObjectStore();
  let calls = 0;
  const counting = new Proxy(inner, { get(target, prop) { const value = Reflect.get(target, prop); return typeof value === 'function' ? (...args) => { if (['find', 'get', 'list'].includes(prop)) calls += 1; return value.apply(target, args); } : value; } });
  let clock = 0;
  const cache = new CachedStore(counting, { syncIntervalMs: 1000, now: () => clock });
  const g = freshGraph();
  await cache.transact({ communityId: g.c, commandId: 'seed', writes: g.objects.slice(0, 7).map(entity => ({ expectedRevision: 0, entity })) });
  await cache.list(g.c, 'object', 'Human');
  const before = calls;
  for (let i = 0; i < 20; i += 1) { await cache.list(g.c, 'object', 'Human'); await cache.find(g.c, 'object', g.a); }
  assert.equal(calls, before, 'no store reads while warm');
  const human = await cache.get(g.c, 'object', g.a);
  await cache.transact({ communityId: g.c, commandId: 'rename', writes: [{ expectedRevision: 1, entity: { ...human, revision: 2, updatedAt: new Date(Date.parse(human.updatedAt) + 1).toISOString(), data: { ...human.data, displayName: 'Renamed' } } }] });
  assert.equal((await cache.get(g.c, 'object', g.a)).data.displayName, 'Renamed', 'own write visible immediately');
  const fresh = await inner.get(g.c, 'object', g.b);
  await inner.transact({ communityId: g.c, commandId: 'outside', writes: [{ expectedRevision: 1, entity: { ...fresh, revision: 2, updatedAt: new Date(Date.parse(fresh.updatedAt) + 1).toISOString(), data: { ...fresh.data, displayName: 'Changed elsewhere' } } }] });
  assert.equal((await cache.get(g.c, 'object', g.b)).data.displayName, 'Synthetic B', 'outside write not seen before the sync interval');
  clock += 1500;
  assert.equal((await cache.get(g.c, 'object', g.b)).data.displayName, 'Changed elsewhere', 'outside write seen after sync');
});

test('an invited member can still be joined through the HTTP API helper', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: 'demo-maker' });
  await a.post('/community', { communityName: 'C', displayName: 'Owner' });
  await b.post('/login', { username: 'demo-helper' });
  await inviteAndJoin(a, b, 'B');
  assert.equal((await b.get('/state')).me.member.membership.data.role, 'member');
});

test('node entry: GET / without query serves index.html (router) directly, while ?page=execution serves execution page', async () => {
  const origin = 'https://agent-network.example';
  const assets = { 'index.html': '<h1>Router</h1>', 'execution.html': '<h1>Execution</h1>' };
  const app = await createCommunityApp({
    mode: 'simulated',
    store: new MemoryObjectStore(),
    login: createMockLogin(),
    kv: new MemoryKV(),
    materials: loadMaterials(),
    onboarding: '',
    publicOrigin: origin,
    openBootstrap: true,
    assets,
  });
  const res = await app.fetch(new Request(`${origin}/`));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>Router</h1>');

  const execution = await app.fetch(new Request(`${origin}/?page=execution`));
  assert.equal(execution.status, 200);
  assert.equal(await execution.text(), '<h1>Execution</h1>');

  const noteRes = await app.fetch(new Request(`${origin}/agent-note.md`));
  assert.equal(noteRes.status, 200);
  assert.equal(noteRes.headers.get('content-type'), 'text/markdown; charset=utf-8');

  const noteNoExtRes = await app.fetch(new Request(`${origin}/agent-note`));
  assert.equal(noteNoExtRes.status, 200);
});

test('worker entry & config: serves router page directly on / and redirects /router to /', async () => {
  const { readFileSync } = await import('node:fs');
  const wrangler = readFileSync('apps/worker/wrangler.jsonc', 'utf8');
  assert.match(wrangler, /"run_worker_first":\s*\[\s*"\/",\s*"\/router",/);
  assert.match(wrangler, /"\/agent-note\.md"/, 'wrangler includes agent-note.md in run_worker_first');

  const workerSrc = readFileSync('apps/worker/src/index.js', 'utf8');
  assert.match(workerSrc, /execution\.html/);
  assert.match(workerSrc, /if \(url\.pathname === '\/router'\)/);

  const appJs = readFileSync('apps/node/public/app.js', 'utf8');
  assert.match(appJs, /if \(state\.loginKind && state\.loginKind !== 'password'\)/);

  const routerJs = readFileSync('apps/node/public/router.js', 'utf8');
  assert.match(routerJs, /if \(base\.canBootstrap\)/, 'router page allows online community bootstrap');
  assert.match(routerJs, /Cursor MCP/, 'router page offers direct Cursor MCP configuration');
  assert.match(routerJs, /Agent 接入/, 'router page has dedicated agent onboarding tab');
  assert.match(routerJs, /一键复制 Agent Note 接入指令/, 'router page has one-click copy for agent note');
  assert.match(wrangler, /"COMMUNITY_OPEN_BOOTSTRAP":\s*"1"/, 'wrangler sets open bootstrap for initial deploy');
});
