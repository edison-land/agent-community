import { createHash } from 'node:crypto';
import { MemoryVectorIndex } from './embedding.js';

/**
 * The community's capability vocabulary (RFC 0010 §5, revised).
 *
 * There is no fixed taxonomy. Terms grow from what members say they can do,
 * and a request only ever *matches* existing terms — it never mints one. That
 * asymmetry is deliberate: every term has at least one person behind it, so a
 * need the vocabulary cannot express is an honest "nobody here does this"
 * rather than a silent miss.
 *
 * Whether 猎头招聘 and HRBP are the same capability has no global answer — it
 * depends on the request. So nothing is clustered into a canonical ontology:
 * two statements share a term only when they are near enough in embedding
 * space, and the vocabulary's resolution rises on its own as members describe
 * more distinct things.
 *
 * Embedding happens on write (a member confirms a profile item, a request is
 * published). Ranking stays a tag intersection, so the read path has no model
 * call and no vector query in it.
 *
 * Thresholds are measured against `@cf/qwen/qwen3-embedding-0.6b`, and they
 * depend on how much text is being compared. Short capability names sit closer
 * together than full sentences do: measured on names, wordings of one
 * capability score 0.71–0.91 while genuinely different ones reach 0.61, so a
 * threshold set from sentence-length text (0.60) wrongly folded SEO into
 * cross-border commerce and AI work into frontend. 0.65 separates the names.
 */
export const MERGE_THRESHOLD = 0.65;
export const MATCH_THRESHOLD = 0.42;
export const MAX_TERMS = 400;

const slug = title => `t-${createHash('sha256').update(title).digest('hex').slice(0, 8)}`;
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

export class Vocabulary {
  #terms = new Map();
  constructor({ embedding, index = new MemoryVectorIndex(), mergeThreshold = MERGE_THRESHOLD, matchThreshold = MATCH_THRESHOLD } = {}) {
    if (!embedding) throw new Error('EMBEDDING_REQUIRED');
    Object.assign(this, { embedding, index, mergeThreshold, matchThreshold });
  }

  /** Rebuilds the vector index from stored terms; the index is derived, the terms are the truth. */
  async load(terms = []) {
    this.#terms = new Map(terms.map(term => [term.tag, { ...term, aliases: term.aliases ?? [] }]));
    if (!this.#terms.size) return this;
    const list = [...this.#terms.values()];
    const vectors = await this.embedding.embed(list.map(term => this.#text(term)));
    await this.index.upsert(list.map((term, position) => ({ id: term.tag, values: vectors[position] })));
    return this;
  }

  #text(term) { return [term.title, ...term.aliases].join('；'); }
  get terms() { return [...this.#terms.values()]; }
  get size() { return this.#terms.size; }
  term(tag) { return this.#terms.get(tag) ?? null; }

  /**
   * Supply side: place one capability phrase. Near enough to a term, it joins
   * it as an alias and makes that term richer; otherwise it becomes a new one.
   */
  async align(phrase, { now = new Date().toISOString() } = {}) {
    const title = clean(phrase).slice(0, 120);
    if (!title) return null;
    const [vector] = await this.embedding.embed([title]);
    const [nearest] = await this.index.query(vector, { topK: 1 });
    if (nearest && nearest.score >= this.mergeThreshold) {
      const term = this.#terms.get(nearest.id);
      if (term && title !== term.title && !term.aliases.includes(title)) {
        term.aliases = [...term.aliases, title].slice(-8);
        const [updated] = await this.embedding.embed([this.#text(term)]);
        await this.index.upsert([{ id: term.tag, values: updated }]);
      }
      return { term, score: nearest.score, created: false };
    }
    if (this.#terms.size >= MAX_TERMS) return nearest ? { term: this.#terms.get(nearest.id), score: nearest.score, created: false } : null;
    const term = { tag: slug(title), title, aliases: [], createdAt: now };
    if (this.#terms.has(term.tag)) return { term: this.#terms.get(term.tag), score: 1, created: false };
    this.#terms.set(term.tag, term);
    await this.index.upsert([{ id: term.tag, values: vector }]);
    return { term, score: 1, created: true };
  }

  /** Demand side: which existing capabilities is this text asking for? Never mints a term. */
  async match(text, { limit = 6, threshold = this.matchThreshold } = {}) {
    const query = clean(text);
    if (!query || !this.#terms.size) return [];
    const [vector] = await this.embedding.embed([query.slice(0, 2000)]);
    const hits = await this.index.query(vector, { topK: limit, minScore: threshold });
    return hits.map(hit => ({ term: this.#terms.get(hit.id), score: Number(hit.score.toFixed(3)) })).filter(hit => hit.term);
  }
}
