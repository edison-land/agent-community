import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFlareMoLogin, identityFor } from '../packages/identity/flaremo.js';
import { startLoginUi } from '../apps/login-demo/server.js';

const secret = 'synthetic-access-secret';
async function fixture(t, options = {}) {
  const state = { subject: 'users/test-member', denied: false, failLogout: false, calls: [], ...options };
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    state.calls.push({ path: req.url, origin: req.headers.origin, cookie: req.headers.cookie });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.endsWith('/signin')) {
      if (state.redirect) { res.writeHead(302, { location: 'https://example.com/' }); return res.end(); }
      const input = JSON.parse(raw);
      if (input.passwordCredentials.password !== 'synthetic-password') return send(401, { error: secret });
      res.setHeader('set-cookie', ['flaremo.session_token=synthetic-cookie; HttpOnly; Secure', 'flaremo.refresh=synthetic-refresh; Secure']);
      return send(200, {
        accessToken: secret, accessTokenExpiresAt: new Date(Date.now() + (state.expiryMs ?? 600000)).toISOString(),
        user: { name: 'users/unverified-signin-value' },
      });
    }
    if (req.url.endsWith('/me')) {
      if (state.stall) return;
      if (state.denied) return send(403, { error: secret });
      if (req.headers.authorization !== `Bearer ${secret}`) return send(401, { error: secret });
      if (state.malformed) return send(200, { user: { email: 'not-a-subject@example.invalid' } });
      return send(200, { user: { name: state.subject, displayName: 'Synthetic Member', email: 'private@example.invalid' } });
    }
    if (req.url.endsWith('/signout')) return send(state.failLogout ? 503 : 200, {});
    send(404, {});
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const ui = await startLoginUi({ port: 0, baseUrl, allowLocal: true, timeoutMs: 200 }); t.after(ui.close);
  const post = (path, body = {}, cookie, origin = ui.url) => fetch(`${ui.url}${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const login = () => post('/api/login', { username: 'synthetic-member', password: 'synthetic-password' });
  const getSession = cookie => fetch(`${ui.url}/api/session`, { headers: { cookie } });
  return { state, ui, baseUrl, post, login, getSession };
}

test('login verifies upstream identity, isolates secrets, and logs out with original cookies', async t => {
  const f = await fixture(t); const result = await f.login(); assert.equal(result.status, 200);
  const data = await result.json(); const cookie = result.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal(data.identity.subject, 'users/test-member');
  assert.equal(data.identity.provider, f.baseUrl);
  const output = JSON.stringify(data) + cookie;
  for (const value of [secret, 'synthetic-cookie', 'synthetic-password', 'private@example.invalid']) assert.ok(!output.includes(value));
  assert.equal((await f.getSession(cookie)).status, 200);
  assert.equal(f.state.calls.filter(call => call.path.endsWith('/me')).length, 2);
  assert.ok(f.state.calls.every(call => call.origin === f.ui.url));
  const logout = await f.post('/api/logout', {}, cookie);
  assert.equal((await logout.json()).upstreamSignoutConfirmed, true);
  assert.match(f.state.calls.at(-1).cookie, /flaremo.refresh=synthetic-refresh/);
  assert.equal((await f.getSession(cookie)).status, 401);
  assert.ok(f.state.calls.every(call => call.path.startsWith('/api/v1/auth/')));
});

test('wrong passwords and foreign-origin login requests cannot establish a session', async t => {
  const f = await fixture(t);
  const bad = await f.post('/api/login', { username: 'member', password: 'wrong' });
  assert.equal(bad.status, 401); assert.ok(!(await bad.text()).includes(secret));
  const rejected = await f.post('/api/login', {}, undefined, 'https://foreign.example');
  assert.equal(rejected.status, 403); assert.equal(f.state.calls.length, 1);
  assert.equal((await f.post('/api/login', {})).status, 400);
});

test('upstream access withdrawal clears the local session', async t => {
  const f = await fixture(t); const cookie = (await f.login()).headers.get('set-cookie');
  f.state.denied = true;
  const response = await f.getSession(cookie); assert.equal(response.status, 403);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  f.state.denied = false;
  assert.equal((await f.getSession(cookie)).status, 401);
});

test('changed upstream identity cannot inherit another local identity', async t => {
  const f = await fixture(t); const cookie = (await f.login()).headers.get('set-cookie');
  f.state.subject = 'users/someone-else';
  const response = await f.getSession(cookie);
  assert.equal(response.status, 401); assert.equal((await response.json()).error, 'IDENTITY_CHANGED');
});

test('malformed identity and expired issued tokens cannot sign in', async t => {
  for (const options of [{ malformed: true }, { expiryMs: -1000 }]) {
    const f = await fixture(t, options); const response = await f.login();
    assert.equal(response.status, 502); assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('server-side expiry rejects a previously valid session even if cookie is replayed', async t => {
  const f = await fixture(t);
  const adapter = createFlareMoLogin({ baseUrl: f.baseUrl, allowLocal: true });
  const session = await adapter.signIn({ username: 'member', password: 'synthetic-password' }, f.ui.url);
  session.expiresAt = Date.now() - 1;
  await assert.rejects(adapter.verify(session, f.ui.url), /SESSION_EXPIRED/);
});

test('logout drops local access even when upstream logout fails', async t => {
  const f = await fixture(t); const cookie = (await f.login()).headers.get('set-cookie'); f.state.failLogout = true;
  const response = await f.post('/api/logout', {}, cookie);
  assert.deepEqual(await response.json(), { signedOut: true, upstreamSignoutConfirmed: false });
  assert.equal((await f.getSession(cookie)).status, 401);
});

test('redirects and timeouts fail closed without exposing upstream bodies', async t => {
  for (const options of [{ redirect: true }, { stall: true }]) {
    const f = await fixture(t, options); const response = await f.login();
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes(secret));
  }
});

test('provider configuration is fixed and instance identities cannot collide', () => {
  for (const baseUrl of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?key=x']) {
    assert.throws(() => createFlareMoLogin({ baseUrl }), /INVALID_AUTH_ORIGIN/);
  }
  const user = { name: 'users/a', displayName: 'Before' };
  const before = identityFor('https://one.example', user).id;
  assert.equal(before, identityFor('https://one.example', { ...user, displayName: 'After' }).id);
  assert.notEqual(before, identityFor('https://two.example', user).id);
});

test('unconfigured demo cannot accept credentials and page uses external module script', async t => {
  const ui = await startLoginUi({ port: 0 }); t.after(ui.close);
  assert.equal((await (await fetch(`${ui.url}/api/config`)).json()).configured, false);
  const result = await fetch(`${ui.url}/api/login`, { method: 'POST', headers: { origin: ui.url } });
  assert.equal(result.status, 503);
  const page = await fetch(ui.url);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /type="module"/);
});
