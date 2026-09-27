/**
 * Read-through cache in front of the object store. A community partition in
 * FlareMo has exactly one authorised writer (this node's service account), so
 * every write goes through `transact` here and invalidates what it touched:
 * reads after our own writes are always current, which keeps revocation
 * immediate. Writes made elsewhere are picked up from the change cursor at
 * most `syncIntervalMs` later. Blobs are content-addressed and never change.
 */
const CATEGORY = kind => ['Membership', 'IdentityLink', 'AgentBinding', 'Grant', 'Execution', 'Invitation', 'Match', 'Suggestion', 'Preflight', 'Consent', 'AgentToken'].includes(kind) ? 'record' : 'object';

export class CachedStore {
  #entities = new Map(); #lists = new Map(); #blobs = new Map(); #blobBytes = 0; #cursors = new Map(); #lastSync = new Map();
  constructor(inner, { syncIntervalMs = 30000, maxBlobBytes = 16 * 1024 * 1024, now = () => Date.now() } = {}) {
    this.inner = inner;
    this.kind = `${inner.kind}+cache`;
    this.origin = inner.origin;
    this.syncIntervalMs = syncIntervalMs;
    this.maxBlobBytes = maxBlobBytes;
    this.now = now;
    this.stats = { hits: 0, misses: 0, syncs: 0 };
  }

  #forget(communityId, kind, id) {
    if (id) this.#entities.delete(`${communityId}|${id}`);
    const category = CATEGORY(kind);
    this.#lists.delete(`${communityId}|${category}|${kind}`);
    this.#lists.delete(`${communityId}|${category}|*`);
  }

  /** Applies writes made by anyone else, using FlareMo's change cursor. */
  async #sync(communityId) {
    const last = this.#lastSync.get(communityId);
    if (last !== undefined && this.now() - last < this.syncIntervalMs) return;
    this.#lastSync.set(communityId, this.now());
    let cursor = this.#cursors.get(communityId);
    if (cursor === undefined) {
      // First contact: start from the current head; nothing is cached yet.
      for (;;) {
        const page = await this.inner.events(communityId, cursor ?? 0, 500);
        cursor = page.cursor;
        if (page.events.length < 500) break;
      }
      this.#cursors.set(communityId, cursor);
      return;
    }
    for (;;) {
      const page = await this.inner.events(communityId, cursor, 500);
      for (const event of page.events) this.#forget(communityId, event.kind, event.entityId);
      cursor = page.cursor;
      if (page.events.length < 500) break;
    }
    this.#cursors.set(communityId, cursor);
    this.stats.syncs += 1;
  }

  async service() { return this.inner.service(); }

  async transact(command) {
    try {
      const receipt = await this.inner.transact(command);
      // Advance past our own events so the next sync does not re-invalidate them.
      if (this.#cursors.has(command.communityId) && receipt.cursor > this.#cursors.get(command.communityId)) this.#cursors.set(command.communityId, receipt.cursor);
      return receipt;
    } finally {
      for (const { entity } of command.writes) this.#forget(command.communityId, entity.kind, entity.id);
    }
  }

  async get(communityId, category, id) {
    const entity = await this.find(communityId, category, id);
    if (!entity) {
      const { StoreError } = await import('./flaremo-objects.js');
      throw new StoreError('ENTITY_NOT_FOUND', 404);
    }
    return entity;
  }

  async find(communityId, category, id) {
    if (communityId) await this.#sync(communityId).catch(() => {});
    const key = `${communityId}|${id}`;
    if (this.#entities.has(key)) { this.stats.hits += 1; return structuredClone(this.#entities.get(key)); }
    this.stats.misses += 1;
    const entity = await this.inner.find(communityId, category, id);
    if (entity && (entity.protocol === 'community-records' ? 'record' : 'object') === category) this.#entities.set(key, entity);
    return entity ? structuredClone(entity) : null;
  }

  async list(communityId, category, kind) {
    await this.#sync(communityId).catch(() => {});
    const key = `${communityId}|${category}|${kind ?? '*'}`;
    if (this.#lists.has(key)) { this.stats.hits += 1; return structuredClone(this.#lists.get(key)); }
    this.stats.misses += 1;
    const items = await this.inner.list(communityId, category, kind);
    this.#lists.set(key, items);
    for (const item of items) this.#entities.set(`${communityId}|${item.id}`, item);
    return structuredClone(items);
  }

  version(...args) { return this.inner.version(...args); }
  events(...args) { return this.inner.events(...args); }
  putBlob(...args) { return this.inner.putBlob(...args); }

  async getBlob(communityId, sha256) {
    const key = `${communityId}|${sha256}`;
    if (this.#blobs.has(key)) { const blob = this.#blobs.get(key); return { bytes: Buffer.from(blob.bytes), mediaType: blob.mediaType }; }
    const blob = await this.inner.getBlob(communityId, sha256);
    if (blob.bytes.length <= this.maxBlobBytes / 4) {
      while (this.#blobBytes + blob.bytes.length > this.maxBlobBytes && this.#blobs.size) {
        const [oldest, value] = this.#blobs.entries().next().value;
        this.#blobs.delete(oldest); this.#blobBytes -= value.bytes.length;
      }
      this.#blobs.set(key, { bytes: Buffer.from(blob.bytes), mediaType: blob.mediaType }); this.#blobBytes += blob.bytes.length;
    }
    return blob;
  }

  blobUri(...args) { return this.inner.blobUri(...args); }
}
