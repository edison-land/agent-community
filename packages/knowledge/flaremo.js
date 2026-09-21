/** Small REST adapter. No token or response body is included in errors. */
export class FlareMoError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'FlareMoError';
    this.status = status;
  }
}

export class FlareMoClient {
  constructor({ baseUrl, token, allowWrite = false, allowLocal = false, access = {}, timeoutMs = 10000 }) {
    const url = new URL(baseUrl);
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1' && allowLocal;
    if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new FlareMoError('INVALID_BASE_URL');
    }
    if (!token || typeof token !== 'string' || /[\r\n]/u.test(token)) throw new FlareMoError('TOKEN_REQUIRED');
    if (Boolean(access.id) !== Boolean(access.secret)) throw new FlareMoError('INCOMPLETE_ACCESS_CREDENTIALS');
    this.baseUrl = url.origin;
    this.token = token;
    this.allowWrite = allowWrite;
    this.access = access;
    this.timeoutMs = timeoutMs;
  }

  memoPath(name) {
    if (typeof name !== 'string' || !/^memos\/[A-Za-z0-9_-]+$/u.test(name)) throw new FlareMoError('INVALID_MEMO_NAME');
    return `/api/v1/${name}`;
  }

  async request(method, path, body) {
    const target = new URL(path, this.baseUrl);
    if (target.origin !== this.baseUrl || !/^\/api\/v1\/memos(?:\/[A-Za-z0-9_-]+)?$/u.test(target.pathname)) {
      throw new FlareMoError('INVALID_RESOURCE_URL');
    }
    if (method !== 'GET' && !this.allowWrite) throw new FlareMoError('WRITE_NOT_ENABLED');
    const headers = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (this.access.id) {
      headers['CF-Access-Client-Id'] = this.access.id;
      headers['CF-Access-Client-Secret'] = this.access.secret;
    }
    try {
      const response = await fetch(target, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new FlareMoError(`HTTP_${response.status}`, response.status);
      }
      const content = await response.text();
      if (!content.trim()) return null;
      try { return JSON.parse(content); }
      catch { throw new FlareMoError('INVALID_JSON_RESPONSE'); }
    } catch (error) {
      if (error instanceof FlareMoError) throw error;
      throw new FlareMoError(error.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'TRANSPORT_ERROR');
    }
  }

  validateMemo(memo) {
    this.memoPath(memo?.name);
    if (typeof memo.content !== 'string' || !['PRIVATE', 'PROTECTED', 'PUBLIC'].includes(memo.visibility)) {
      throw new FlareMoError('INVALID_MEMO_RESPONSE');
    }
    return memo;
  }

  async get(name) { return this.validateMemo(await this.request('GET', this.memoPath(name))); }
  async create(content) {
    return this.validateMemo(await this.request('POST', '/api/v1/memos', { content, visibility: 'PRIVATE' }));
  }
  async update(name, changes) {
    const keys = Object.keys(changes);
    if (!keys.length || keys.some(key => !['content', 'visibility'].includes(key))) throw new FlareMoError('INVALID_UPDATE');
    if ('visibility' in changes && !['PRIVATE', 'PROTECTED'].includes(changes.visibility)) throw new FlareMoError('INVALID_VISIBILITY');
    return this.validateMemo(await this.request('PATCH', `${this.memoPath(name)}?updateMask=${keys.join(',')}`, changes));
  }
  async trash(name) { return this.request('DELETE', this.memoPath(name)); }
}
