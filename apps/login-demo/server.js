import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createFlareMoLogin, LoginError } from '../../packages/identity/flaremo.js';
import { createMockLogin, demoMembers } from '../../packages/identity/mock.js';

const cookieName = 'community_login_demo';
async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new LoginError('JSON_REQUIRED', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new LoginError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LoginError('INVALID_JSON', 400); }
}

export async function startLoginUi({ port = 4319, baseUrl, allowLocal = false, timeoutMs, mock = false } = {}) {
  const provider = mock ? createMockLogin() : baseUrl ? createFlareMoLogin({ baseUrl, allowLocal, timeoutMs }) : null;
  const html = await readFile(new URL('./index.html', import.meta.url));
  const script = await readFile(new URL('./client.js', import.meta.url));
  const sessions = new Map();
  let attempts = [], busy = false;
  const server = createServer(async (request, response) => {
    const host = `127.0.0.1:${server.address().port}`;
    const browserOrigin = `http://${host}`;
    const cookie = (value = '', seconds = 0) => response.setHeader('set-cookie',
      `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}`);
    const reply = (status, value, type = 'application/json') => {
      response.writeHead(status, {
        'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    if (request.headers.host !== host) return reply(403, { error: 'INVALID_HOST' });
    if (request.headers['sec-fetch-site'] === 'cross-site' ||
        (request.method !== 'GET' && request.headers.origin !== browserOrigin)) {
      return reply(403, { error: 'INVALID_ORIGIN' });
    }
    const sessionId = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const session = sessions.get(sessionId);
    const forget = () => { sessions.delete(sessionId); cookie(); };
    try {
      if (request.method === 'GET' && request.url === '/') return reply(200, html, 'text/html');
      if (request.method === 'GET' && request.url === '/client.js') return reply(200, script, 'text/javascript');
      if (request.method === 'GET' && request.url === '/api/config') return reply(200, {
        configured: Boolean(provider), provider: provider?.origin ?? null, browserOrigin,
        mode: mock ? 'synthetic-local-login' : 'local-login-experiment', demoMembers: mock ? demoMembers : [],
      });
      if (!provider) return reply(503, { error: 'LOGIN_NOT_CONFIGURED' });
      if (request.method === 'POST' && request.url === '/api/login') {
        if (busy) return reply(429, { error: 'LOGIN_BUSY' });
        attempts = attempts.filter(time => time > Date.now() - 60000);
        if (attempts.length >= 8) return reply(429, { error: 'LOGIN_RATE_LIMITED' });
        for (const [id, entry] of sessions) if (entry.expiresAt <= Date.now()) sessions.delete(id);
        if (sessions.size >= 8) return reply(429, { error: 'SESSION_LIMIT' });
        attempts.push(Date.now()); busy = true;
        try {
          const credentials = await readJson(request);
          const next = await provider.signIn(credentials, browserOrigin);
          if (session) await provider.signOut(session, browserOrigin).catch(() => {});
          forget();
          const id = randomBytes(32).toString('hex');
          sessions.set(id, next);
          cookie(id, Math.max(1, Math.floor((next.expiresAt - Date.now()) / 1000)));
          return reply(200, { identity: next.identity, expiresAt: next.expiresAt });
        } finally { busy = false; }
      }
      if (request.method === 'GET' && request.url === '/api/session') {
        if (!session) { cookie(); return reply(401, { error: 'NOT_SIGNED_IN' }); }
        try {
          const identity = await provider.verify(session, browserOrigin);
          // A concurrent logout must not be undone by an in-flight verification.
          if (sessions.get(sessionId) !== session) throw new LoginError('NOT_SIGNED_IN', 401);
          return reply(200, { identity, expiresAt: session.expiresAt });
        } catch (error) {
          if ([401, 403].includes(error.status)) forget();
          throw error;
        }
      }
      if (request.method === 'POST' && request.url === '/api/logout') {
        forget();
        let upstreamSignoutConfirmed = false;
        if (session) {
          try { await provider.signOut(session, browserOrigin); upstreamSignoutConfirmed = !mock; }
          catch { /* Local logout still succeeds; report remote uncertainty explicitly. */ }
        }
        return reply(200, { signedOut: true, upstreamSignoutConfirmed });
      }
      return reply(404, { error: 'NOT_FOUND' });
    } catch (error) {
      return reply(error instanceof LoginError ? error.status : 500, {
        error: error instanceof LoginError ? error.message : 'LOGIN_DEMO_FAILED',
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { sessions.clear(); server.close(resolve); server.closeAllConnections(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mock = process.argv.includes('--mock');
    const ui = await startLoginUi({ baseUrl: process.env.FLAREMO_AUTH_URL, mock });
    console.log(`Community local login experiment: ${ui.url}`);
    console.log(mock ? 'Synthetic accounts only. No FlareMo requests or real passwords.' : 'Live login requires a configured instance and its trusted-origin allowance. No credentials are logged.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await ui.close(); process.exit(0); });
  } catch { console.error('Cannot start login experiment: check origin configuration and port 4319.'); process.exitCode = 1; }
}
