// SIMULATED (RFC 0009): the agent writes its own profile when it joins, the
// owner edits it before and after publishing, and the two memory modes run
// Codex with different configuration. Uses the simulated Codex binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulatedNode, webUser, inviteAndJoin, testConnector, registerAndClaim, communityWithAgent, until, FAKE_CODEX } from './support/harness.js';
import { taskPrompt } from '../packages/connector/codex.js';
import { createCommunityApp } from '../packages/app/community-app.js';
import { MemoryKV } from '../packages/runtime/kv.js';
import { MemoryObjectStore } from '../packages/store/memory-objects.js';
import { createMockLogin } from '../packages/identity/mock.js';
import { loadMaterials } from '../packages/community/materials.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../apps/connector/cli.js', import.meta.url));
const rejects = async (promise, code) => assert.rejects(promise, error => (error.code ?? error.message) === code);
const execArgs = home => readFileSync(join(home, 'fake-exec-args.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

async function members(t) {
  const node = await simulatedNode(); t.after(node.close);
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: 'demo-maker' });
  await a.post('/community', { communityName: 'C', displayName: 'A' });
  await b.post('/login', { username: 'demo-helper' });
  await inviteAndJoin(a, b, 'B');
  return { node, a, b };
}

test('the agent drafts its profile; the owner edits it on the claim page; the directory shows the published version', async t => {
  const { node, a, b } = await members(t);
  const c = testConnector(); t.after(c.cleanup);
  const registered = await c.connector.register({ node: node.url, name: 'B Mac', codexHome: c.codexHome, model: 'm', memory: 'without-memory' });
  assert.equal(registered.profile.canDo.length, 2, 'drafted by the agent itself');
  const profileRun = execArgs(c.codexHome)[0];
  assert.ok(profileRun.includes('--ignore-user-config') && profileRun.includes('read-only'), 'the draft is written by the same restricted Codex that will work');
  assert.equal((await node.service.list('Agent')).length, 0, 'nothing is published before the claim');

  const code = new URL(registered.claimUrl).pathname.split('/').pop();
  const view = await b.get(`/claims/${code}`);
  assert.match(view.profileDraft.intro, /不带个人记忆/u);
  assert.deepEqual(view.profileDraft.capabilities.map(item => item.title), ['资料调研报告', '文档审阅']);
  const edited = { intro: '我是 B 的调研 Agent，基于你给的资料写报告。', seeking: ['开源许可证相关的调研'], capabilities: [{ title: '许可证调研', description: '比较你提供的许可证文本并给出建议。' }] };
  const claimed = await b.post(`/claims/${code}`, { fingerprintSuffix: registered.fingerprint.slice(-4), agentName: 'B 的调研 Agent', profile: edited });
  const agent = await node.service.get('Agent', claimed.agentId);
  assert.deepEqual(agent.data.profile, { intro: edited.intro, seeking: edited.seeking, draftedBy: 'agent', editedByPrincipal: true });

  const found = await a.get('/discover');
  assert.equal(found.length, 1, 'only the capability the owner kept');
  assert.equal(found[0].title, '许可证调研');
  assert.equal(found[0].provider.profile.intro, edited.intro);
  assert.equal(found[0].provider.memory, 'without-memory');
});

test('claiming without edits publishes the draft as written, marked as not edited', async t => {
  const { node, b } = await members(t);
  const env = await registerAndClaim(node, b); t.after(env.cleanup);
  assert.equal(env.agent.data.profile.editedByPrincipal, false);
  assert.equal(env.agent.data.profile.draftedBy, 'agent');
  assert.deepEqual((await node.service.list('Capability')).map(item => item.data.title).sort(), ['文档审阅', '资料调研报告']);
});

test('registration is refused without a profile, and malformed profiles are refused', async t => {
  const { node } = await members(t);
  const post = body => fetch(`${node.url}/connector/v1/registrations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => [r.status, (await r.json()).error]);
  const connector = { name: 'x', platform: 'p', runtime: 'codex-cli', runtimeVersion: 'v', model: 'm', models: ['m'], instructionIsolation: 'isolated-codex-home' };
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update('secret').digest('hex');
  const withFingerprint = { ...connector, fingerprint: createHash('sha256').update(hash).digest('hex').slice(0, 16) };
  const base = { connector: withFingerprint, credentialHash: hash, deviceId: 'urn:uuid:00000000-0000-4000-8000-000000000001' };
  assert.deepEqual(await post(base), [400, 'INVALID_PROFILE']);
  assert.deepEqual(await post({ ...base, profile: { intro: 'x', canDo: [] } }), [400, 'INVALID_PROFILE'], 'at least one capability');
  assert.deepEqual(await post({ ...base, profile: { intro: 'x', canDo: Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, description: 'd' })) } }), [400, 'INVALID_PROFILE'], 'at most six');
  assert.deepEqual(await post({ ...base, profile: { intro: 'x'.repeat(1001), canDo: [{ title: 't', description: 'd' }] } }), [400, 'INVALID_TEXT']);
});

test('the owner edits the profile later: rename, edit, remove and add capabilities; nobody else can', async t => {
  const { node, a, b } = await members(t);
  const env = await registerAndClaim(node, b); t.after(env.cleanup);
  const capabilities = await node.service.list('Capability');
  const [research, review] = ['资料调研报告', '文档审阅'].map(title => capabilities.find(item => item.data.title === title));
  const profile = { intro: '新的介绍', seeking: ['找长期合作'], capabilities: [{ id: research.id, title: '资料调研报告（中英）', description: research.data.description }, { title: '会议纪要整理', description: '把你提供的记录整理成纪要。' }] };
  await rejects(a.post(`/agents/${env.agent.id}/profile`, { profile }), 'NOT_AGENT_PRINCIPAL');
  const result = await b.post(`/agents/${env.agent.id}/profile`, { displayName: 'B 的新名字', profile });
  assert.equal(result.displayName, 'B 的新名字');
  assert.equal(result.profile.editedByPrincipal, true);
  const byTitle = Object.fromEntries((await node.service.list('Capability')).map(item => [item.data.title, item.data.status]));
  assert.deepEqual(byTitle, { '资料调研报告（中英）': 'published', [review.data.title]: 'withdrawn', '会议纪要整理': 'published' });
  assert.equal((await node.service.get('Capability', research.id)).revision, 2, 'edited in place, same capability id');
  assert.deepEqual((await a.get('/discover')).map(item => item.title).sort(), ['会议纪要整理', '资料调研报告（中英）']);
  const others = await registerAndClaim(node, b, { connector: testConnector({ profile: 'other' }), name: 'other' }); t.after(others.cleanup);
  const foreign = (await node.service.list('Capability')).find(item => item.data.providerId === others.agent.id);
  await rejects(b.post(`/agents/${env.agent.id}/profile`, { profile: { ...profile, capabilities: [{ id: foreign.id, title: 'x', description: 'y' }] } }), 'NOT_AGENT_CAPABILITY');
});

test('re-binding an existing agent keeps its profile unless the owner chooses to replace it', async t => {
  const { node, b } = await members(t);
  const first = await registerAndClaim(node, b); t.after(first.cleanup);
  await b.post(`/agents/${first.agent.id}/profile`, { profile: { intro: '手写的介绍', seeking: [], capabilities: [{ title: '手写能力', description: '说明' }] } });
  const kept = await registerAndClaim(node, b, { connector: testConnector({ root: first.root }), agentId: first.agent.id }); t.after(kept.cleanup);
  assert.equal(kept.agent.data.profile.intro, '手写的介绍');
  const replaced = await registerAndClaim(node, b, { connector: testConnector({ root: first.root }), agentId: first.agent.id, replaceProfile: true });
  assert.match(replaced.agent.data.profile.intro, /模拟的 Codex Agent/u);
  assert.deepEqual((await node.service.list('Capability')).filter(item => item.data.status === 'published').map(item => item.data.title).sort(), ['文档审阅', '资料调研报告']);
});

test('with memory: the owner\'s own Codex config loads, but MCP servers, plugins, apps and hooks are switched off for every run', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const home = mkdtempSync(join(tmpdir(), 'community-personal-home-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { root: home, mode: 'personal' };
  const probe = testConnector(options);
  writeFileSync(join(probe.codexHome, 'fake-mcp.json'), JSON.stringify([{ name: 'pencil', enabled: true }, { name: 'node_repl', enabled: true }, { name: 'cua_repl', enabled: true, plugin: true }, { name: 'off_already', enabled: false }]));
  const env = await communityWithAgent(node, { connectorOptions: options, memory: 'with-memory' }); t.after(env.cleanup);
  const [profileRun] = execArgs(env.codexHome);
  assert.ok(!profileRun.includes('--ignore-user-config'), 'personal configuration (instructions, skills, provider) is used');
  for (const expected of ['approval_policy="never"', 'notify=[]', 'features.plugins=false', 'features.apps=false', 'features.computer_use=false', 'features.hooks=false', 'mcp_servers.pencil.enabled=false', 'mcp_servers.node_repl.enabled=false']) {
    assert.ok(profileRun.includes(expected), `locked: ${expected}`);
  }
  assert.ok(!profileRun.some(arg => arg.includes('cua_repl')), 'plugin servers go away with the plugins feature, not by name');
  assert.equal((await env.a.get('/discover'))[0].provider.memory, 'with-memory');

  // An order runs with the same lockdown and the memory-aware rules.
  const controller = new AbortController(); t.after(() => controller.abort());
  const running = env.connector.run({ signal: controller.signal });
  const request = await env.a.post('/requests', { title: '上线测试任务：许可证', description: '比较', capabilityId: env.capability.id, acceptanceCriteria: ['含来源'], materialPaths: ['oss-licenses/mit.md'] });
  const [card] = await env.b.get('/confirmations');
  assert.equal(card.instructionIsolation, 'personal-codex-home', 'the owner sees the memory mode on every confirmation card');
  await env.b.post(`/requests/${request.id}/confirm`, { cardHash: card.cardHash });
  await until(async () => (await env.a.get(`/requests/${request.id}`)).artifacts.length, { timeoutMs: 15000 });
  const orderRun = execArgs(env.codexHome).at(-1);
  assert.ok(orderRun.includes('mcp_servers.pencil.enabled=false') && orderRun.includes('features.plugins=false') && !orderRun.includes('--ignore-user-config'));
  controller.abort(); await running;
});

test('with memory: registration stops when a tool cannot be switched off', async t => {
  const { node } = await members(t);
  for (const [servers, code] of [[[{ name: 'stubborn', enabled: true, stubborn: true }], 'MCP_TOOLS_NOT_DISABLED'], [[{ name: 'computer-use', enabled: true }], 'MCP_SERVER_NOT_DISABLEABLE']]) {
    const c = testConnector({ mode: 'personal' }); t.after(c.cleanup);
    writeFileSync(join(c.codexHome, 'fake-mcp.json'), JSON.stringify(servers));
    await rejects(c.connector.register({ node: node.url, codexHome: c.codexHome, model: 'm', memory: 'with-memory' }), code);
  }
});

test('the task prompt differs by memory mode; private information stays out of reports either way', () => {
  const task = { request: { title: 't', description: 'd', acceptanceCriteria: ['c'] }, materials: [], revision: null };
  assert.match(taskPrompt(task, { isolation: 'isolated-codex-home' }), /不读取工作目录以外的文件/u);
  const personal = taskPrompt(task, { isolation: 'personal-codex-home' });
  assert.match(personal, /参考主人的记忆/u);
  assert.match(personal, /不得出现主人的私人信息/u);
});

test('connector login signs in to the separate CODEX_HOME and proves the everyday Codex was not touched', async t => {
  const root = mkdtempSync(join(tmpdir(), 'community-login-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const personal = join(root, 'personal-codex'), isolated = join(root, 'isolated-codex');
  mkdirSync(join(personal, 'skills', 'mine'), { recursive: true }); mkdirSync(join(personal, 'memories'));
  for (const [file, text] of [['auth.json', '{"personal":true}'], ['config.toml', 'model = "x"'], ['AGENTS.md', '# mine'], ['skills/mine/SKILL.md', 's'], ['memories/m.md', 'm']]) writeFileSync(join(personal, file), text);
  mkdirSync(isolated); writeFileSync(join(isolated, 'fake-logged-out'), '');
  const cli = env => run(process.execPath, [CLI, 'login', '--codex-bin', FAKE_CODEX, '--codex-home', isolated, '--personal-codex-home', personal], { env: { ...process.env, AGENT_COMMUNITY_HOME: join(root, 'state'), ...env } }).then(r => ({ code: 0, out: r.stdout }), e => ({ code: e.code, out: `${e.stdout}${e.stderr}` }));

  const ok = await cli({});
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /独立目录已登录/u);
  assert.match(ok.out, /你平时使用的 Codex 未变化/u);
  assert.ok(existsSync(join(isolated, 'auth.json')), 'the new login lives only in the separate home');
  assert.equal(readFileSync(join(personal, 'auth.json'), 'utf8'), '{"personal":true}');

  // If something did change the everyday Codex during the login, the owner is told which part.
  writeFileSync(join(isolated, 'fake-logged-out'), '');
  writeFileSync(join(isolated, 'fake-touch'), join(personal, 'AGENTS.md'));
  const touched = await cli({});
  assert.equal(touched.code, 1);
  assert.match(touched.out, /警告：你平时使用的 Codex 有变化：AGENTS\.md/u);
  const same = await run(process.execPath, [CLI, 'login', '--codex-bin', FAKE_CODEX, '--codex-home', personal, '--personal-codex-home', personal]).catch(error => error);
  assert.match(`${same.stderr}`, /不能与你平时使用的 CODEX_HOME 相同/u);
});

test('the node serves the one-file connector and the onboarding page names its checksum', async () => {
  const origin = 'http://127.0.0.1:65001';
  const bundle = { sha256: 'a'.repeat(64), bytes: 3 };
  const app = await createCommunityApp({
    mode: 'simulated', store: new MemoryObjectStore(), login: createMockLogin(), kv: new MemoryKV(), materials: loadMaterials(), publicOrigin: origin, openBootstrap: true,
    onboarding: 'curl {{NODE}}/connector.mjs → {{CONNECTOR_SHA256}}', connectorBundle: bundle,
    assets: { 'index.html': '<!doctype html>', 'app.js': '', 'app.css': '', 'connector.mjs': 'x()', 'connector.json': JSON.stringify(bundle) },
  });
  const get = path => app.fetch(new Request(`${origin}${path}`));
  assert.equal(await (await get('/agent-onboarding.md')).text(), `curl ${origin}/connector.mjs → ${'a'.repeat(64)}`);
  const script = await get('/connector.mjs');
  assert.match(script.headers.get('content-type'), /text\/javascript/u);
  assert.equal(await script.text(), 'x()');
  assert.equal((await (await get('/api/state')).json()).connector.sha256, bundle.sha256);
  assert.equal((await get('/connector.exe')).status, 404);
});
