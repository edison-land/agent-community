import { createHash } from 'node:crypto';

/**
 * Client for the FlareMo community object extension (`/api/community/v1`,
 * RFC 0005/0007). The service PAT never appears in errors or logs. Errors carry
 * the extension's stable code so callers can distinguish conflicts from denials.
 */
export class StoreError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export class FlareMoObjectStore {
  constructor({ baseUrl, token, allowLocal = false, timeoutMs = 15000 }) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new StoreError('INVALID_BASE_URL'); }
    const local = allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new StoreError('INVALID_BASE_URL');
    }
    if (typeof token !== 'string' || !/^memos_pat_[\x21-\x7e]{8,512}$/u.test(token)) throw new StoreError('SERVICE_TOKEN_REQUIRED');
    this.origin = url.origin;
    this.kind = 'flaremo';
    this.#token = token;
    this.timeoutMs = timeoutMs;
  }

  #token;

  async #request(method, route, { body, bytes, contentType, raw = false } = {}) {
    const headers = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    if (bytes !== undefined) { headers['content-type'] = contentType; payload = bytes; }
    let response;
    try {
      response = await fetch(`${this.origin}/api/community/v1${route}`, {
        method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new StoreError(error.name === 'TimeoutError' ? 'STORE_TIMEOUT' : 'STORE_UNAVAILABLE');
    }
    // Redirects are never followed: the store origin is fixed by configuration.
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new StoreError('STORE_REDIRECT_REFUSED', response.status); }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw new StoreError('STORE_RESPONSE_TOO_LARGE', response.status);
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      try { code = JSON.parse(buffer.toString('utf8'))?.error?.code ?? code; } catch { /* keep HTTP code */ }
      throw new StoreError(code, response.status);
    }
    if (raw) return { buffer, headers: response.headers };
    try { return JSON.parse(buffer.toString('utf8')); } catch { throw new StoreError('INVALID_STORE_RESPONSE', response.status); }
  }

  service() { return this.#request('GET', '/service'); }

  /** Atomic multi-entity write. Returns the receipt; replays return the original. */
  transact({ communityId, commandId, writes }) {
    return this.#request('POST', '/transactions', {
      body: { communityId, commandId, writes: writes.map(({ expectedRevision, entity }) => ({ expectedRevision, entity })) },
    });
  }

  #scoped(path, communityId, extra = {}) {
    const query = new URLSearchParams({ communityId, ...extra });
    return `${path}?${query}`;
  }

  get(communityId, category, id) {
    return this.#request('GET', this.#scoped(`/${category === 'record' ? 'records' : 'objects'}/${encodeURIComponent(id)}`, communityId));
  }

  async find(communityId, category, id) {
    try { return await this.get(communityId, category, id); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  version(communityId, category, id, revision) {
    return this.#request('GET', this.#scoped(`/${category === 'record' ? 'records' : 'objects'}/${encodeURIComponent(id)}/versions/${revision}`, communityId));
  }

  async list(communityId, category, kind) {
    const items = [];
    let cursor;
    do {
      const page = await this.#request('GET', this.#scoped(`/${category === 'record' ? 'records' : 'objects'}`, communityId, {
        limit: '500', ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}),
      }));
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  events(communityId, cursor = 0, limit = 200) {
    return this.#request('GET', this.#scoped('/events', communityId, { cursor: String(cursor), limit: String(limit) }));
  }

  async putBlob(communityId, bytes, mediaType) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.#request('PUT', this.#scoped(`/blobs/${sha256}`, communityId), { bytes, contentType: mediaType });
  }

  /** Downloads and re-verifies the content hash before returning bytes. */
  async getBlob(communityId, sha256) {
    const { buffer, headers } = await this.#request('GET', this.#scoped(`/blobs/${sha256}`, communityId), { raw: true });
    if (createHash('sha256').update(buffer).digest('hex') !== sha256) throw new StoreError('BLOB_HASH_MISMATCH');
    return { bytes: buffer, mediaType: headers.get('content-type') };
  }

  blobUri(communityId, sha256) {
    return `${this.origin}/api/community/v1/blobs/${sha256}?${new URLSearchParams({ communityId })}`;
  }
}
