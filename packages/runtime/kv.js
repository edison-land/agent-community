/**
 * Small key-value contract for node-local coordination state (sessions,
 * pending connector registrations, execution credentials). Values expire.
 * The Node process uses MemoryKV; the Cloudflare Worker backs the same
 * contract with Durable Object storage so eviction and redeploys keep it.
 */
export class MemoryKV {
  #map = new Map();
  constructor(now = () => Date.now()) { this.now = now; }
  #live(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= this.now()) { this.#map.delete(key); return undefined; }
    return entry;
  }
  async get(key) { return structuredClone(this.#live(key)?.value); }
  async put(key, value, { ttlMs } = {}) { this.#map.set(key, { value: structuredClone(value), expiresAt: ttlMs ? this.now() + ttlMs : null }); }
  async delete(key) { return this.#map.delete(key); }
  async list(prefix) {
    const out = new Map();
    for (const key of [...this.#map.keys()]) if (key.startsWith(prefix) && this.#live(key)) out.set(key, structuredClone(this.#map.get(key).value));
    return out;
  }
}
