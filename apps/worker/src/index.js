import { DurableObject } from 'cloudflare:workers';
import { createCommunityApp } from '../../../packages/app/community-app.js';
import { buildMaterials } from '../../../packages/community/materials-core.js';
import { createFlareMoTokenLogin } from '../../../packages/identity/flaremo.js';
import { createMockLogin } from '../../../packages/identity/mock.js';
import { FixtureActivitySource } from '../../../packages/router/activity.js';
import { embeddingFrom } from '../../../packages/router/embedding.js';
import { Vocabulary } from '../../../packages/router/vocabulary.js';
import { ModelUnderstander, chatFrom } from '../../../packages/router/understanding.js';
import { sameDigest, sha256 } from '../../../packages/community/secrets.js';
import { durableDemoStore } from './demo-store.js';
import { createDurableStore } from '../../../packages/store/durable-objects.js';
import demoScenario from '../../../examples/scenarios/kosx-recruitment.json';
import onboarding from '../../../docs/agent-onboarding.md';
import agentGuide from '../../../docs/agents.md';
// Written by `npm run build:connector`; the bundle itself is served as a static asset.
import connectorBundle from '../../node/public/connector.json';
import licensesPack from '../../../examples/materials/oss-licenses/pack.json';
import mit from '../../../examples/materials/oss-licenses/mit.md';
import apache from '../../../examples/materials/oss-licenses/apache-2.0.md';
import agpl from '../../../examples/materials/oss-licenses/agpl-3.0.md';

/**
 * Cloudflare deployment of the community node (RFC 0008). Static pages are
 * served by Workers Static Assets; every dynamic request goes to one Durable
 * Object per community, which runs the same Fetch handler as the Node process.
 * The object's storage keeps sessions, pending connector registrations and
 * execution credentials across evictions and deploys; FlareMo stays the
 * authority for all community objects and records.
 */
const materials = buildMaterials([{ pack: 'oss-licenses', manifest: licensesPack, files: { 'mit.md': mit, 'apache-2.0.md': apache, 'agpl-3.0.md': agpl } }]);

/** KV contract (packages/runtime/kv.js) on Durable Object storage. */
class DurableKV {
  constructor(storage) { this.storage = storage; }
  async get(key) {
    const entry = await this.storage.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) { await this.storage.delete(key); return undefined; }
    return entry.value;
  }
  async put(key, value, { ttlMs } = {}) { await this.storage.put(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null }); }
  async delete(key) { return this.storage.delete(key); }
  async list(prefix) {
    const out = new Map(), now = Date.now();
    for (const [key, entry] of await this.storage.list({ prefix })) if (!entry.expiresAt || entry.expiresAt > now) out.set(key, entry.value);
    return out;
  }
  async purge() {
    const now = Date.now(), expired = [];
    for (const [key, entry] of await this.storage.list()) if (entry?.expiresAt && entry.expiresAt <= now) expired.push(key);
    for (let index = 0; index < expired.length; index += 128) await this.storage.delete(expired.slice(index, index + 128));
    return expired.length;
  }
}

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export class CommunityNode extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.kv = new DurableKV(ctx.storage);
    this.ready = null;
  }

  async #app() {
    this.ready ??= (async () => {
      const env = this.env;
      if (env.COMMUNITY_MODE === 'demo') return this.#demoApp();
      for (const name of ['PUBLIC_ORIGIN', 'FLAREMO_URL']) if (!env[name]) throw Object.assign(new Error(`MISSING_${name}`), { code: `MISSING_${name}` });
      const allowLocal = env.ALLOW_LOCAL_FLAREMO === '1';
      // FlareMo keeps what is its own — who a member is, and that member's own
      // agent memory. What the community is doing lives in this object, because
      // FlareMo has no public interface that holds it and we do not patch it.
      const store = await createDurableStore(this.ctx.storage, {
        serviceId: new URL(env.PUBLIC_ORIGIN).host, origin: env.PUBLIC_ORIGIN,
        limits: env.COMMUNITY_ENTITY_LIMIT ? { entities: Number(env.COMMUNITY_ENTITY_LIMIT) } : {},
      });
      // A token, not a password: the member makes one on FlareMo and brings it
      // here once. See packages/identity/flaremo.js for why there is no
      // redirect to send them through instead.
      const login = createFlareMoTokenLogin({ baseUrl: env.FLAREMO_URL, allowLocal });
      const app = await createCommunityApp({
        mode: 'live', store, login, kv: this.kv, materials, onboarding, agentGuide, connectorBundle, publicOrigin: env.PUBLIC_ORIGIN,
        autoDispatch: env.COMMUNITY_AUTO_DISPATCH !== '0',
        registrationTtlMs: env.COMMUNITY_REGISTRATION_TTL_MS ? Number(env.COMMUNITY_REGISTRATION_TTL_MS) : undefined,
        ownerSubject: env.COMMUNITY_OWNER_SUBJECT || null,
        router: this.#vocabulary(),
        openBootstrap: env.COMMUNITY_OPEN_BOOTSTRAP === '1',
        openJoin: env.COMMUNITY_OPEN_JOIN === '1',
        log: entry => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
      });
      // Hourly clean-up of expired sessions, registrations and credentials.
      if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
      return app;
    })().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }

  /** Matching by meaning, when Workers AI is bound; otherwise the keyword baseline. */
  #vocabulary() {
    const embedding = embeddingFrom({ ai: this.env.AI });
    if (!embedding) return {};
    const chat = chatFrom({ ai: this.env.AI, model: this.env.CLOUDFLARE_AI_CHAT_MODEL });
    return { vocabulary: new Vocabulary({ embedding }), ...(chat ? { understander: new ModelUnderstander({ chat }) } : {}) };
  }

  /**
   * Public demo (no FlareMo, fictional members): the scenario's roster plus
   * visitor guests, profiles drafted from the scenario's fictional chat signals,
   * state kept in this object's storage.
   */
  async #demoApp() {
    const env = this.env;
    if (!env.PUBLIC_ORIGIN) throw Object.assign(new Error('MISSING_PUBLIC_ORIGIN'), { code: 'MISSING_PUBLIC_ORIGIN' });
    const signals = Object.fromEntries(demoScenario.members.filter(member => member.activity).map(member => [member.username, member.activity]));
    return createCommunityApp({
      mode: 'simulated', store: await durableDemoStore(this.ctx.storage), kv: this.kv, materials, onboarding, agentGuide, connectorBundle,
      login: createMockLogin({ members: demoScenario.members.map(({ username, displayName }) => ({ username, displayName })), allowGuests: true }),
      publicOrigin: env.PUBLIC_ORIGIN, ownerSubject: env.COMMUNITY_OWNER_SUBJECT || null, openBootstrap: !env.COMMUNITY_OWNER_SUBJECT, openJoin: true, autoDispatch: false,
      router: { ...this.#vocabulary(), activity: service => new FixtureActivitySource({ service, signals }) },
      log: entry => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
    });
  }

  // Demo only: wipe everything (operator secret), and a coarse per-IP write limit.
  async #demoGuard(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__demo/reset') {
      const given = request.headers.get('x-demo-secret') ?? '';
      if (request.method !== 'POST' || !this.env.DEMO_RESET_SECRET || !sameDigest(sha256(given), sha256(this.env.DEMO_RESET_SECRET))) return json(403, { error: 'FORBIDDEN' });
      this.ready?.then(app => app.close()).catch(() => {});
      this.ready = null;
      await this.ctx.storage.deleteAll();
      return json(200, { reset: true });
    }
    if (request.method === 'GET' || request.method === 'HEAD') return null;
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown', now = Date.now();
    this.writes ??= new Map();
    const recent = (this.writes.get(ip) ?? []).filter(at => at > now - 10 * 60 * 1000);
    if (recent.length >= 1500) return json(429, { error: 'DEMO_RATE_LIMITED' });
    recent.push(now); this.writes.set(ip, recent);
    return null;
  }

  async fetch(request) {
    if (this.env.COMMUNITY_MODE === 'demo') { const refused = await this.#demoGuard(request); if (refused) return refused; }
    let app;
    try { app = await this.#app(); }
    catch (error) { console.error(JSON.stringify({ event: 'node-init-failed', code: error.code ?? error.message })); return json(503, { error: 'NODE_NOT_READY', reason: error.code ?? 'INIT_FAILED' }); }
    return app.fetch(request);
  }

  async alarm() {
    const purged = await this.kv.purge();
    const callers = await this.ready?.then(app => app.purge()).catch(() => null);
    console.log(JSON.stringify({ event: 'kv-purge', purged, callers }));
    await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      // The landing page is published separately, under its own headers: this node's
      // content policy is written for the app and would strip the page bare. Old links
      // are sent on rather than silently answered with the app shell.
      if (env.LANDING_URL && (url.pathname === '/landing' || url.pathname === '/landing.html')) {
        return Response.redirect(env.LANDING_URL, 302);
      }
      // Every node opens on the routing page. The execution (Phase 2) page is
      // still here, and still reached by the links that carry their own query.
      if (url.pathname === '/') {
        if (!url.search) return Response.redirect(new URL('/router', request.url).toString(), 302);
        return env.ASSETS.fetch(request);
      }
    }
    // One node per deployment; the object's name is stable across deploys.
    const stub = env.COMMUNITY_NODE.get(env.COMMUNITY_NODE.idFromName('community-node'));
    return stub.fetch(request);
  },
};
