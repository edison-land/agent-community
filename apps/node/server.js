import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCommunityApp } from '../../packages/app/community-app.js';
import { loadMaterials } from '../../packages/community/materials.js';
import { MemoryKV } from '../../packages/runtime/kv.js';
import { FlareMoObjectStore } from '../../packages/store/flaremo-objects.js';
import { CachedStore } from '../../packages/store/cached.js';
import { MemoryObjectStore } from '../../packages/store/memory-objects.js';
import { createFlareMoLogin } from '../../packages/identity/flaremo.js';
import { createMockLogin } from '../../packages/identity/mock.js';
import { embeddingFrom } from '../../packages/router/embedding.js';
import { Vocabulary } from '../../packages/router/vocabulary.js';
import { ModelUnderstander, chatFrom } from '../../packages/router/understanding.js';

/**
 * Node adapter for the community node (development and tests). The same Fetch
 * handler runs in the Cloudflare Worker (apps/worker). Loopback HTTP only.
 */
export async function startNode({ port = 4320, host = '127.0.0.1', publicOrigin: fixedOrigin = null, mode = 'live', store, login, stateDir, registrationTtlMs, autoDispatch = true, ownerSubject = null, openBootstrap = true, openJoin = false, router = {}, log = () => {} } = {}) {
  const pointerFile = stateDir ? join(stateDir, 'community.json') : null;
  const assets = Object.fromEntries(await Promise.all(['index.html', 'app.js', 'app.css', 'router.html', 'router.js', 'agent-mcp.mjs'].map(async name => [name, await readFile(new URL(`./public/${name}`, import.meta.url))])));
  const agentGuide = await readFile(new URL('../../docs/agents.md', import.meta.url), 'utf8');
  // The downloadable connector exists after `npm run build:connector`.
  let connectorBundle = null;
  if (existsSync(new URL('./public/connector.json', import.meta.url))) {
    connectorBundle = JSON.parse(readFileSync(new URL('./public/connector.json', import.meta.url), 'utf8'));
    for (const name of ['connector.mjs', 'connector.json']) assets[name] = await readFile(new URL(`./public/${name}`, import.meta.url));
  }
  const onboarding = await readFile(new URL('../../docs/agent-onboarding.md', import.meta.url), 'utf8');
  const server = createServer();
  server.requestTimeout = 0;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  // A tunnel (e.g. for other people's agents) sets the public origin; otherwise loopback.
  const publicOrigin = fixedOrigin ?? `http://127.0.0.1:${server.address().port}`;
  const app = await createCommunityApp({
    mode, store, login, kv: new MemoryKV(), materials: loadMaterials(), onboarding, agentGuide, assets, connectorBundle, publicOrigin, autoDispatch, registrationTtlMs, router,
    ownerSubject, openBootstrap, openJoin, log,
    pointer: pointerFile ? {
      load: async () => existsSync(pointerFile) ? JSON.parse(readFileSync(pointerFile, 'utf8')) : null,
      save: async value => { await mkdir(stateDir, { recursive: true, mode: 0o700 }); await writeFile(pointerFile, JSON.stringify(value), { mode: 0o600 }); },
    } : null,
  });

  server.on('request', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let request;
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) for (const item of [].concat(value)) headers.append(key, item);
      request = new Request(`http://${req.headers.host ?? 'invalid.invalid'}${req.url}`, {
        method: req.method, headers, signal: controller.signal,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: req, duplex: 'half' }),
      });
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'INVALID_REQUEST' }));
    }
    const response = await app.fetch(request);
    const outHeaders = {};
    for (const [key, value] of response.headers) if (key !== 'set-cookie') outHeaders[key] = value;
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outHeaders['set-cookie'] = cookies;
    res.writeHead(response.status, outHeaders);
    if (!response.body) return res.end();
    try { for await (const chunk of response.body) { if (res.destroyed) break; res.write(chunk); } }
    catch { /* client went away */ }
    res.end();
  });

  return {
    url: publicOrigin, service: app.service, gateway: app.gateway, router: app.router, port: server.address().port,
    close: () => new Promise(resolve => { app.close(); server.close(resolve); server.closeAllConnections(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const simulated = process.argv.includes('--simulated');
  const home = process.env.AGENT_COMMUNITY_HOME ?? join(homedir(), '.agent-community');
  let store, login, stateDir;
  if (simulated) {
    store = new MemoryObjectStore();
    login = createMockLogin();
  } else {
    const local = JSON.parse(readFileSync(process.env.FLAREMO_LOCAL_STATE ?? join(home, 'local', 'flaremo.json'), 'utf8'));
    store = new CachedStore(new FlareMoObjectStore({ baseUrl: local.url, token: local.service.pat, allowLocal: true }));
    await store.service();
    login = createFlareMoLogin({ baseUrl: local.url, allowLocal: true });
    stateDir = process.env.COMMUNITY_STATE_DIR ?? join(home, 'node');
  }
  // Matching by meaning is on only when embedding credentials are present.
  const ai = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_AI_TOKEN };
  const embedding = embeddingFrom(ai);
  const chat = chatFrom({
    ...ai, model: process.env.CHAT_MODEL ?? process.env.CLOUDFLARE_AI_CHAT_MODEL,
    baseUrl: process.env.CHAT_BASE_URL, apiKey: process.env.CHAT_API_KEY,
    ...(process.env.CHAT_MAX_TOKENS ? { maxTokens: Number(process.env.CHAT_MAX_TOKENS) } : {}),
  });
  const node = await startNode({
    port: Number(process.env.COMMUNITY_PORT ?? 4320), mode: simulated ? 'simulated' : 'live', store, login, stateDir,
    router: embedding ? { vocabulary: new Vocabulary({ embedding }), ...(chat ? { understander: new ModelUnderstander({ chat }) } : {}) } : {},
    autoDispatch: process.env.COMMUNITY_AUTO_DISPATCH !== '0',
    registrationTtlMs: process.env.COMMUNITY_REGISTRATION_TTL_MS ? Number(process.env.COMMUNITY_REGISTRATION_TTL_MS) : undefined,
    ownerSubject: process.env.COMMUNITY_OWNER_SUBJECT ?? null, openBootstrap: !process.env.COMMUNITY_OWNER_SUBJECT,
    openJoin: process.env.COMMUNITY_OPEN_JOIN === '1',
    log: entry => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
  });
  console.log(`Agent Community node (${simulated ? 'SIMULATED: in-memory store, fictional members' : `live: FlareMo ${store.origin}`}): ${node.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await node.close(); process.exit(0); });
}
