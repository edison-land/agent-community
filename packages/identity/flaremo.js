import { createHash } from 'node:crypto';

export class LoginError extends Error {
  constructor(code, status = 502) { super(code); this.status = status; }
}

// This experimental key is stable across username changes and separates instances.
export function identityFor(origin, user) {
  if (!user || typeof user.name !== 'string' || !/^users\/[A-Za-z0-9_-]{1,200}$/u.test(user.name)) {
    throw new LoginError('INVALID_IDENTITY');
  }
  return {
    id: createHash('sha256').update(JSON.stringify([origin, user.name])).digest('hex'),
    provider: origin,
    subject: user.name,
    displayName: typeof user.displayName === 'string' ? user.displayName.slice(0, 160) : user.name,
  };
}

export function createFlareMoLogin({ baseUrl, allowLocal = false, timeoutMs = 10000 }) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new LoginError('INVALID_AUTH_ORIGIN', 400); }
  const local = allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new LoginError('INVALID_AUTH_ORIGIN', 400);
  }
  const origin = url.origin;

  async function request(route, { browserOrigin, credentials, session } = {}) {
    const headers = { accept: 'application/json', origin: browserOrigin };
    if (credentials) headers['content-type'] = 'application/json';
    if (session) headers.authorization = `Bearer ${session.token}`;
    // Only signout needs the same-origin cookies issued at signin. They never reach the browser.
    if (route === 'signout' && session?.cookies) headers.cookie = session.cookies;
    try {
      const response = await fetch(`${origin}/api/v1/auth/${route}`, {
        method: route === 'me' ? 'GET' : 'POST', headers,
        body: credentials ? JSON.stringify({ passwordCredentials: credentials }) : undefined,
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new LoginError('FLAREMO_REDIRECT_REFUSED');
      }
      if (!response.ok) {
        await response.body?.cancel();
        const status = [401, 403, 429].includes(response.status) ? response.status : 502;
        throw new LoginError(`FLAREMO_HTTP_${response.status}`, status);
      }
      const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
      if (cookies.length > 16384) throw new LoginError('INVALID_AUTH_RESPONSE');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > 65536) throw new LoginError('INVALID_AUTH_RESPONSE');
        chunks.push(chunk);
      }
      if (route === 'signout') return {};
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new LoginError('INVALID_AUTH_RESPONSE'); }
      return { body, cookies };
    } catch (error) {
      if (error instanceof LoginError) throw error;
      throw new LoginError(error.name === 'TimeoutError' ? 'FLAREMO_TIMEOUT' : 'FLAREMO_UNAVAILABLE');
    }
  }

  return {
    origin,
    async signIn(credentials, browserOrigin) {
      if (typeof credentials?.username !== 'string' || !credentials.username.trim() || credentials.username.length > 200 ||
          typeof credentials?.password !== 'string' || !credentials.password || credentials.password.length > 1024) {
        throw new LoginError('INVALID_CREDENTIALS', 400);
      }
      const { body, cookies } = await request('signin', {
        browserOrigin, credentials: { username: credentials.username.trim(), password: credentials.password },
      });
      const expiresAt = Date.parse(body?.accessTokenExpiresAt);
      if (typeof body?.accessToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(body.accessToken) ||
          !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new LoginError('INVALID_AUTH_RESPONSE');
      const session = { token: body.accessToken, cookies, expiresAt: Math.min(expiresAt, Date.now() + 3600000) };
      try {
        const verified = await request('me', { browserOrigin, session });
        session.identity = identityFor(origin, verified.body?.user);
        return session;
      } catch (error) {
        await request('signout', { browserOrigin, session }).catch(() => {});
        throw error;
      }
    },
    async verify(session, browserOrigin) {
      if (session.expiresAt <= Date.now()) throw new LoginError('SESSION_EXPIRED', 401);
      const { body } = await request('me', { browserOrigin, session });
      const identity = identityFor(origin, body?.user);
      if (identity.id !== session.identity.id) throw new LoginError('IDENTITY_CHANGED', 401);
      return identity;
    },
    async signOut(session, browserOrigin) { await request('signout', { browserOrigin, session }); },
  };
}

/**
 * Sign in with a FlareMo personal access token, so a member's password never
 * reaches this node.
 *
 * FlareMo is not an identity provider: its Better Auth deployment enables
 * `username`, `organization` and `apiKey`, and no OIDC provider, so there is no
 * authorisation-code flow to redirect into. Its session cookie is SameSite=Lax,
 * so a browser will not carry it here either. What it does have is per-user
 * tokens, and `GET /api/v1/auth/me` accepts one as a bearer credential.
 *
 * The member creates a token on FlareMo and pastes it in once. We read the
 * identity behind it and then forget the token: nothing is stored, so nothing
 * here can be stolen or replayed. The cost is that a token revoked on FlareMo
 * still leaves this node's own session valid until it expires, which is why the
 * session is short. `links` tells the page where to send someone, so no
 * deployment's address is written into the page.
 */
export function createFlareMoTokenLogin({ baseUrl, allowLocal = false, timeoutMs = 10000, sessionTtlMs = 12 * 3600 * 1000 }) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new LoginError('INVALID_AUTH_ORIGIN', 400); }
  const local = allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new LoginError('INVALID_AUTH_ORIGIN', 400);
  }
  const origin = url.origin;

  // A bearer request without an Origin header is the server-to-server case
  // FlareMo allows; sending one would put us behind its trusted-origin list.
  async function whoIs(token) {
    let response;
    try {
      response = await fetch(`${origin}/api/v1/auth/me`, {
        method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new LoginError(error.name === 'TimeoutError' ? 'FLAREMO_TIMEOUT' : 'FLAREMO_UNAVAILABLE');
    }
    if (response.status === 401 || response.status === 403) throw new LoginError('INVALID_TOKEN', 401);
    if (!response.ok) throw new LoginError('FLAREMO_UNAVAILABLE');
    let body;
    try { body = await response.json(); } catch { throw new LoginError('INVALID_AUTH_RESPONSE'); }
    return identityFor(origin, body?.user);
  }

  return {
    origin,
    kind: 'flaremo-token',
    // Where a member goes to register, to sign in, and to make the token.
    links: { register: `${origin}/register`, signIn: `${origin}/login`, token: `${origin}/account` },
    async signIn(credentials) {
      const token = typeof credentials?.token === 'string' ? credentials.token.trim() : '';
      // The prefix is FlareMo's own, and checking it here keeps a mistyped
      // password from being sent anywhere.
      if (!token.startsWith('memos_pat_') || token.length > 8192 || !/^[\x21-\x7e]+$/u.test(token)) {
        throw new LoginError('INVALID_TOKEN', 400);
      }
      return { identity: await whoIs(token), expiresAt: Date.now() + sessionTtlMs };
    },
    // The token is not kept, so there is nothing to re-check: the session this
    // node issued stands on its own until it expires.
    async verify(session) {
      if (session.expiresAt <= Date.now()) throw new LoginError('SESSION_EXPIRED', 401);
      return session.identity;
    },
    async signOut() {},
  };
}
