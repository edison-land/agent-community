// A member signs in with a FlareMo token, so this node never sees a password.
// FlareMo's own rules are what these tests hold us to: the bearer request must
// carry no Origin header (otherwise it falls under FlareMo's trusted-origin
// list), and the token is FlareMo's `memos_pat_` kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createFlareMoTokenLogin, LoginError } from '../packages/identity/flaremo.js';

/** A stand-in for FlareMo that records what it was asked, and by whom. */
async function fakeFlareMo({ tokens = { memos_pat_good: 'users/edison' }, status = null } = {}) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, method: request.method, authorization: request.headers.authorization ?? null, origin: request.headers.origin ?? null });
    response.setHeader('content-type', 'application/json');
    if (status) { response.writeHead(status); return response.end('{}'); }
    const token = (request.headers.authorization ?? '').replace(/^Bearer /u, '');
    const name = tokens[token];
    if (!name) { response.writeHead(401); return response.end(JSON.stringify({ error: 'unauthorized' })); }
    response.writeHead(200);
    response.end(JSON.stringify({ user: { name, displayName: 'Edison' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/`, async close() { server.close(); await once(server, 'close'); } };
}

const login = flaremo => createFlareMoTokenLogin({ baseUrl: flaremo.baseUrl, allowLocal: true });

test('a valid token identifies the member, and the token is not kept', async () => {
  const flaremo = await fakeFlareMo();
  try {
    const session = await login(flaremo).signIn({ token: 'memos_pat_good' });
    assert.equal(session.identity.subject, 'users/edison');
    assert.equal(session.identity.displayName, 'Edison');
    assert.ok(session.expiresAt > Date.now());
    assert.equal(JSON.stringify(session).includes('memos_pat_good'), false, '会话里不该留下令牌');
  } finally { await flaremo.close(); }
});

test('the bearer request carries no Origin, which is what FlareMo lets through', async () => {
  const flaremo = await fakeFlareMo();
  try {
    await login(flaremo).signIn({ token: 'memos_pat_good' });
    assert.equal(flaremo.seen.length, 1);
    assert.equal(flaremo.seen[0].url, '/api/v1/auth/me');
    assert.equal(flaremo.seen[0].method, 'GET');
    assert.equal(flaremo.seen[0].authorization, 'Bearer memos_pat_good');
    assert.equal(flaremo.seen[0].origin, null, 'Origin 头会让请求落进 FlareMo 的可信来源名单');
  } finally { await flaremo.close(); }
});

test('a token FlareMo does not know is refused, and says so as 401', async () => {
  const flaremo = await fakeFlareMo();
  try {
    await assert.rejects(login(flaremo).signIn({ token: 'memos_pat_wrong' }), error => {
      assert.ok(error instanceof LoginError);
      assert.equal(error.message, 'INVALID_TOKEN');
      assert.equal(error.status, 401);
      return true;
    });
  } finally { await flaremo.close(); }
});

test('something that is not a FlareMo token never leaves this node', async () => {
  const flaremo = await fakeFlareMo();
  try {
    for (const token of ['', '  ', 'hunter2', 'Bearer memos_pat_good', 'sk-live-0000']) {
      await assert.rejects(login(flaremo).signIn({ token }), error => error.message === 'INVALID_TOKEN' && error.status === 400);
    }
    assert.equal(flaremo.seen.length, 0, '一个像密码的字符串不该被发出去');
  } finally { await flaremo.close(); }
});

test('the page is told where to register, sign in and make a token', async () => {
  const flaremo = await fakeFlareMo();
  try {
    const { links, kind, origin } = login(flaremo);
    assert.equal(kind, 'flaremo-token');
    assert.deepEqual(links, { register: `${origin}/register`, signIn: `${origin}/login`, token: `${origin}/account` });
  } finally { await flaremo.close(); }
});

test('the session stands on its own until it expires, and then stops', async () => {
  const flaremo = await fakeFlareMo();
  try {
    const provider = login(flaremo);
    const session = await provider.signIn({ token: 'memos_pat_good' });
    flaremo.seen.length = 0;
    assert.equal((await provider.verify(session)).subject, 'users/edison');
    assert.equal(flaremo.seen.length, 0, '没有留下令牌，就没有东西可以复查');
    await assert.rejects(provider.verify({ ...session, expiresAt: Date.now() - 1 }), error => error.message === 'SESSION_EXPIRED' && error.status === 401);
  } finally { await flaremo.close(); }
});

test('a FlareMo that is down is reported as unavailable, not as a bad token', async () => {
  const flaremo = await fakeFlareMo({ status: 500 });
  try {
    await assert.rejects(login(flaremo).signIn({ token: 'memos_pat_good' }), error => error.message === 'FLAREMO_UNAVAILABLE');
  } finally { await flaremo.close(); }
});

test('only a real origin is accepted as the provider address', async () => {
  for (const baseUrl of ['not a url', 'http://flaremo.example/', 'https://flaremo.example/path', 'https://user:pw@flaremo.example/']) {
    assert.throws(() => createFlareMoTokenLogin({ baseUrl }), error => error instanceof LoginError);
  }
  assert.equal(createFlareMoTokenLogin({ baseUrl: 'https://flaremo.example/' }).origin, 'https://flaremo.example');
});
