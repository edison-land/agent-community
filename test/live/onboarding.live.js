/**
 * REAL INTEGRATION (RFC 0009): the one-command join path against a live node
 * process (Node, or the Worker under wrangler with COMMUNITY_RUNTIME=worker) and
 * real local FlareMo accounts and storage. The connector is the single-file
 * bundle downloaded from the node; Codex is the simulated binary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FlareMoObjectStore } from '../../packages/store/flaremo-objects.js';
import { webUser, inviteAndJoin, until } from '../support/harness.js';
import { localState } from '../support/local.js';
import { liveNode, connectorHome, FAKE_CODEX_BIN, RUNTIME } from '../support/processes.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const state = localState();
const account = label => state.accounts.find(item => item.label === label);
const store = new FlareMoObjectStore({ baseUrl: state.url, token: state.service.pat, allowLocal: true });

test('one command: download the connector, sign in without memory, the agent introduces itself, the owner edits and claims, a 上线测试任务 completes', async t => {
  // The Node adapter serves the bundle it finds; the Worker script builds it itself.
  if (RUNTIME === 'node') assert.equal(spawnSync(process.execPath, [join(ROOT, 'scripts/build-connector.mjs')], { cwd: ROOT, stdio: 'ignore' }).status, 0);
  const node = await liveNode(); t.after(() => node.close());
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: account('member-a').username, password: account('member-a').password });
  await b.post('/login', { username: account('member-b').username, password: account('member-b').password });
  const { communityId } = await a.post('/community', { communityName: 'Live Onboarding Community', displayName: 'Member A' });
  await inviteAndJoin(a, b, 'Member B');

  // Step 2 of the onboarding doc: download and compare with the published checksum.
  const c = connectorHome(); t.after(c.cleanup);
  const bin = join(c.home, 'bin'); mkdirSync(bin, { recursive: true });
  const bundle = Buffer.from(await (await fetch(`${node.url}/connector.mjs`)).arrayBuffer());
  const file = join(bin, 'connector.mjs'); writeFileSync(file, bundle);
  const sha256 = createHash('sha256').update(bundle).digest('hex');
  const doc = await (await fetch(`${node.url}/agent-onboarding.md`)).text();
  assert.ok(doc.includes(`输出的哈希应当是：\`${sha256}\``), 'the onboarding doc names the checksum of the served bundle');
  assert.equal((await b.get('/state')).connector.sha256, sha256);
  const connector = (args, extra = {}) => run(process.execPath, [file, ...args, '--codex-bin', FAKE_CODEX_BIN], { env: { ...process.env, ...c.env, ...extra } })
    .then(r => ({ code: 0, out: r.stdout }), e => ({ code: e.code, out: `${e.stdout}${e.stderr}` }));

  // Step 3 (without memory): the owner signs in to the separate CODEX_HOME; the everyday one is checked.
  const personal = join(c.home, 'everyday-codex'); mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, 'auth.json'), '{"everyday":true}'); writeFileSync(join(personal, 'AGENTS.md'), '# everyday');
  writeFileSync(join(c.codexHome, 'fake-logged-out'), '');
  const login = await connector(['login', '--codex-home', c.codexHome, '--personal-codex-home', personal]);
  assert.equal(login.code, 0, login.out);
  assert.match(login.out, /你平时使用的 Codex 未变化/u);

  // Step 4: register; the agent writes its own profile.
  const registered = await connector(['register', '--node', node.url, '--memory', 'without', '--codex-home', c.codexHome, '--model', 'gpt-5.4-mini', '--models', 'gpt-5.4-mini,gpt-5.5', '--name', 'member-b bundle', '--no-wait']);
  assert.equal(registered.code, 0, registered.out);
  assert.match(registered.out, /Agent 自我介绍草稿：模拟 Agent；能做 2 项/u);
  const claimUrl = registered.out.match(/(http:\/\/127\.0\.0\.1:\d+\/claim\/[A-Z0-9-]+)/u)[1];
  const fingerprint = registered.out.match(/连接器指纹：([0-9a-f-]{19})/u)[1].replaceAll('-', '');
  assert.equal((await store.list(communityId, 'object', 'Agent')).length, 0, 'nothing in FlareMo before the claim');

  // Step 5: the owner edits the draft on the claim page and claims.
  const code = claimUrl.split('/').pop();
  const draft = (await b.get(`/claims/${code}`)).profileDraft;
  const profile = { intro: `${draft.intro}（主人补充：只接公开资料任务）`, seeking: [...draft.seeking, '上线测试任务'], capabilities: draft.capabilities.slice(0, 1) };
  const claimed = await b.post(`/claims/${code}`, { fingerprintSuffix: fingerprint.slice(-4), agentName: 'B 的 Agent', profile });
  const stored = await store.get(communityId, 'object', claimed.agentId);
  assert.deepEqual(stored.data.profile, { intro: profile.intro, seeking: profile.seeking, draftedBy: 'agent', editedByPrincipal: true }, 'the reviewed profile is in FlareMo');
  const capabilities = (await store.list(communityId, 'object', 'Capability')).filter(item => item.data.providerId === claimed.agentId);
  assert.deepEqual(capabilities.map(item => [item.data.title, item.data.status]), [[draft.capabilities[0].title, 'published']]);

  // Step 6: keep it running; a 上线测试任务 goes through confirmation, execution and acceptance.
  const started = execFile(process.execPath, [file, 'start', '--codex-bin', FAKE_CODEX_BIN], { env: { ...process.env, ...c.env } });
  t.after(() => started.kill('SIGTERM'));
  const [listing] = await a.get('/discover');
  assert.equal(listing.provider.profile.intro, profile.intro);
  assert.equal(listing.provider.memory, 'without-memory');
  await until(async () => (await a.get('/discover'))[0].online, { timeoutMs: 20000, intervalMs: 300 });
  const request = await a.post('/requests', { title: '上线测试任务：比较三种开源许可证', description: '基于资料包比较', capabilityId: listing.capabilityId, acceptanceCriteria: ['含对比表', '含来源'], materialPaths: ['oss-licenses/mit.md', 'oss-licenses/agpl-3.0.md'] });
  const card = (await b.get('/confirmations')).find(item => item.requestId === request.id);
  assert.equal(card.instructionIsolation, 'isolated-codex-home');
  await b.post(`/requests/${request.id}/confirm`, { cardHash: card.cardHash, model: 'gpt-5.5' });
  const view = await until(async () => { const v = await a.get(`/requests/${request.id}`); return v.artifacts.length && v; }, { timeoutMs: 60000, intervalMs: 500 });
  await a.post(`/artifacts/${view.artifacts[0].id}/review`, { outcome: 'accepted', statement: '上线测试通过' });
  assert.equal((await store.get(communityId, 'object', request.id)).data.status, 'accepted');
  assert.ok(existsSync(join(c.codexHome, 'fake-exec-args.jsonl')));
  const orderRun = readFileSync(join(c.codexHome, 'fake-exec-args.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.ok(orderRun.includes('--ignore-user-config') && orderRun.includes('gpt-5.5'), 'without memory, on the model chosen for this order');
});

test('with memory: registration from the downloaded bundle records the mode and the lockdown for the owner to see', async t => {
  if (RUNTIME === 'node') assert.equal(spawnSync(process.execPath, [join(ROOT, 'scripts/build-connector.mjs')], { cwd: ROOT, stdio: 'ignore' }).status, 0);
  const node = await liveNode(); t.after(() => node.close());
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: account('member-a').username, password: account('member-a').password });
  await b.post('/login', { username: account('member-b').username, password: account('member-b').password });
  await a.post('/community', { communityName: 'Live Memory Community', displayName: 'Member A' });
  await inviteAndJoin(a, b, 'Member B');
  const c = connectorHome({ fakeMode: 'personal' }); t.after(c.cleanup);
  writeFileSync(join(c.codexHome, 'fake-mcp.json'), JSON.stringify([{ name: 'pencil', enabled: true }, { name: 'cua_repl', enabled: true, plugin: true }]));
  const file = join(c.home, 'connector.mjs');
  writeFileSync(file, Buffer.from(await (await fetch(`${node.url}/connector.mjs`)).arrayBuffer()));
  const out = await run(process.execPath, [file, 'register', '--node', node.url, '--memory', 'with', '--codex-home', c.codexHome, '--codex-bin', FAKE_CODEX_BIN, '--no-wait'], { env: { ...process.env, ...c.env } });
  assert.match(out.stdout, /模式：带记忆/u);
  const profileRun = JSON.parse(readFileSync(join(c.codexHome, 'fake-exec-args.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.ok(!profileRun.includes('--ignore-user-config') && profileRun.includes('mcp_servers.pencil.enabled=false') && profileRun.includes('features.plugins=false'));
  const code = out.stdout.match(/\/claim\/([A-Z0-9-]+)/u)[1];
  const view = await b.get(`/claims/${code}`);
  assert.equal(view.connector.instructionIsolation, 'personal-codex-home');
  assert.match(view.profileDraft.intro, /带着主人的全局指令与记忆/u);
});
