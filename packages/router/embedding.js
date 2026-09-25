/**
 * Embedding and vector-index contracts for capability matching, plus an
 * implementation that runs offline.
 *
 * The contracts are plain objects so the routing engine never sees a runtime
 * type: the Cloudflare Worker adapts Workers AI and Vectorize to them, and
 * tests inject whatever they like. A provider embeds text; an index stores
 * vectors and answers nearest-neighbour queries.
 *
 * `LocalEmbedding` is a TEST STUB, not a semantic fallback. It hashes character
 * bigrams and words, so it only sees shared characters: it scores "香港猎头"
 * against "香港招聘" at 0.08 and cannot connect 猎头 with 招聘 at all, because
 * they share no character. Use it to exercise the plumbing offline; never to
 * judge matching quality. Real matching needs a real model (measured:
 * `@cf/qwen/qwen3-embedding-0.6b` puts the same pair at 0.62).
 */
export const EMBEDDING_DIMENSIONS = 256;

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/u;
const LATIN = /[a-z0-9]+/gu;

/** Character bigrams for CJK runs, whole words for Latin. Both are kept. */
export function features(text) {
  const value = String(text ?? '').toLowerCase();
  const out = [];
  for (const word of value.match(LATIN) ?? []) out.push(`w:${word}`);
  let run = '';
  for (const char of value) {
    if (CJK.test(char)) run += char;
    else { if (run) out.push(...runFeatures(run)); run = ''; }
  }
  if (run) out.push(...runFeatures(run));
  return out;
}
function runFeatures(run) {
  const out = [`c:${run.length === 1 ? run : run.slice(0, 1)}`];
  for (let index = 0; index + 1 < run.length; index += 1) out.push(`b:${run.slice(index, index + 2)}`);
  if (run.length > 1) out.push(`c:${run.slice(-1)}`);
  return out;
}

function bucket(token, dimensions) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % dimensions;
}

export class LocalEmbedding {
  model = 'local-char-bigram';
  constructor({ dimensions = EMBEDDING_DIMENSIONS } = {}) { this.dimensions = dimensions; }
  async embed(texts) {
    return texts.map(text => {
      const vector = new Array(this.dimensions).fill(0);
      for (const token of features(text)) vector[bucket(token, this.dimensions)] += 1;
      return normalise(vector);
    });
  }
}

/**
 * Cloudflare Workers AI over its REST API, for the Node process and for
 * evaluations. Inside a Worker, bind `env.AI` and adapt it instead — same
 * contract, one less network hop.
 */
export class RestEmbedding {
  constructor({ accountId, token, model = '@cf/qwen/qwen3-embedding-0.6b', dimensions = 1024, batch = 16, fetchImpl = fetch }) {
    if (!accountId || !token) throw new Error('EMBEDDING_NOT_CONFIGURED');
    Object.assign(this, { accountId, token, model, dimensions, batch, fetchImpl });
  }
  async embed(texts) {
    const out = [];
    for (let index = 0; index < texts.length; index += this.batch) {
      const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`, {
        method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: texts.slice(index, index + this.batch) }),
      });
      const body = await response.json();
      if (!body.success) throw new Error(`EMBEDDING_FAILED ${JSON.stringify(body.errors).slice(0, 200)}`);
      out.push(...(body.result.data ?? body.result.embeddings));
    }
    return out;
  }
}

/**
 * Remembers vectors by text. Capability statements and requests are embedded
 * far more often than they change — every alignment re-embeds the same phrase —
 * so this turns a burst of identical round trips into one. `warm` embeds a
 * whole batch up front, which matters because providers batch but `align`
 * asks one phrase at a time.
 */
export class CachedEmbedding {
  #cache = new Map();
  constructor(inner, { max = 2000 } = {}) { this.inner = inner; this.max = max; this.model = inner.model; this.dimensions = inner.dimensions; this.calls = 0; }
  async warm(texts) { await this.embed(texts); return this; }
  async embed(texts) {
    const missing = [...new Set(texts.filter(text => !this.#cache.has(text)))];
    if (missing.length) {
      this.calls += 1;
      const fresh = await this.inner.embed(missing);
      missing.forEach((text, index) => {
        if (this.#cache.size >= this.max) this.#cache.delete(this.#cache.keys().next().value);
        this.#cache.set(text, fresh[index]);
      });
    }
    return texts.map(text => this.#cache.get(text));
  }
}

export function normalise(vector) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length ? vector.map(value => value / length) : vector;
}

/** Both vectors are expected to be normalised, so this is a dot product. */
export function cosine(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

/**
 * In-process vector index. The community's vocabulary is small (hundreds of
 * terms), and the index is rebuilt from the vocabulary on start, so nothing is
 * lost if it goes away — the same "derived, rebuildable" rule the object store
 * follows for its own read cache.
 */
export class MemoryVectorIndex {
  #vectors = new Map();
  async upsert(vectors) { for (const { id, values } of vectors) this.#vectors.set(id, values); }
  async remove(ids) { for (const id of ids) this.#vectors.delete(id); }
  async query(vector, { topK = 10, minScore = 0 } = {}) {
    const scored = [];
    for (const [id, values] of this.#vectors) {
      const score = cosine(vector, values);
      if (score >= minScore) scored.push({ id, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
  get size() { return this.#vectors.size; }
}

/**
 * Cloudflare's Workers AI binding, for code running inside a Worker. Same
 * contract as `RestEmbedding`, one less network hop.
 */
export class BindingEmbedding {
  constructor({ ai, model = '@cf/qwen/qwen3-embedding-0.6b', dimensions = 1024 }) {
    if (!ai) throw new Error('EMBEDDING_NOT_CONFIGURED');
    Object.assign(this, { ai, model, dimensions });
  }
  async embed(texts) {
    const result = await this.ai.run(this.model, { text: texts });
    return result.data ?? result.embeddings;
  }
}

/**
 * Builds the provider a deployment is configured for, or null to stay on the
 * keyword baseline. Matching by meaning is opt-in: without credentials the node
 * behaves exactly as it did before.
 */
export function embeddingFrom({ ai = null, accountId = null, token = null, fetchImpl } = {}) {
  if (ai) return new CachedEmbedding(new BindingEmbedding({ ai }));
  if (accountId && token) return new CachedEmbedding(new RestEmbedding({ accountId, token, ...(fetchImpl ? { fetchImpl } : {}) }));
  return null;
}
