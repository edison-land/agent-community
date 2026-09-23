// SIMULATED (phase 2): in-memory store and fictional members; exercises the
// real node HTTP API, the register → claim protocol and the connector code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulatedNode, webUser, testConnector, communityWithAgent, registerAndClaim, inviteAndJoin } from './support/harness.js';
import { ConnectorState, unsafeStateDir } from '../packages/connector/state.js';

const rejects = async (promise, code) => assert.rejects(promise, error => (error.code ?? error.message) === code);
const codeOf = registered => new URL(registered.claimUrl).pathname.split('/').pop();

async function twoMembers(t) {
  const node = await simulatedNode(); t.after(node.close);
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: 'demo-maker' });
  await a.post('/community', { communityName: 'C', displayName: 'A' });
  await b.post('/login', { username: 'demo-helper' });
  await inviteAndJoin(a, b, 'B');
  return { node, a, b };
}

test('members join by verified identity; login alone grants nothing', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const a = webUser(node), b = webUser(node);
  await a.post('/login', { username: 'demo-maker' });
  await rejects(a.get('/agents'), 'MEMBERSHIP_REQUIRED');
  await a.post('/community', { communityName: 'C', displayName: 'A' });
  await b.post('/login', { username: 'demo-helper' });
  await rejects(b.get('/discover'), 'MEMBERSHIP_REQUIRED');
  await inviteAndJoin(a, b, 'B');
  await rejects(inviteAndJoin(a, b, 'B again'), 'ALREADY_MEMBER');
  const state = await b.get('/state');
  assert.equal(state.mode, 'simulated');
  assert.equal(state.me.member.membership.data.role, 'member');
  const links = await node.service.list('IdentityLink');
  assert.equal(links.length, 2);
  assert.ok(links.every(link => link.data.subject.startsWith('users/demo-')));
});

test('register → claim: pending registrations stay in memory and cannot fetch work', async t => {
  const { node, b } = await twoMembers(t);
  const c = testConnector(); t.after(c.cleanup);
  const registered = await c.connector.register({ node: node.url, name: 'B laptop', codexHome: c.codexHome, model: 'm', models: ['m2'] });
  assert.match(registered.claimUrl, /^http:\/\/127\.0\.0\.1:\d+\/claim\/[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  assert.equal(registered.isolation, 'isolated-codex-home');
  assert.equal((await c.connector.binding()).status, 'awaiting-claim');
  assert.equal((await node.service.list('AgentBinding')).length, 0, 'nothing written to storage before the claim');
  const token = c.state.load().token;
  const early = await fetch(`${node.url}/connector/v1/tasks/next?wait=0`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual([early.status, (await early.json()).error], [403, 'REGISTRATION_NOT_CLAIMED']);

  // The claim page withholds the fingerprint tail that only the terminal shows.
  const view = await b.get(`/claims/${codeOf(registered)}`);
  assert.equal(view.fingerprintPrefix, registered.fingerprint.slice(0, 12));
  assert.equal(view.fingerprintPrefix.length, 12);
  assert.equal(view.connector.fingerprint, undefined, 'the full fingerprint is never sent to the page');
  assert.ok(!JSON.stringify(view).includes(registered.fingerprint), 'the full fingerprint appears nowhere in the page data');
  assert.deepEqual(view.connector.models, ['m', 'm2']);
  const claimed = await b.post(`/claims/${codeOf(registered)}`, { fingerprintSuffix: registered.fingerprint.slice(-4), agentName: 'B 的调研 Agent' });
  assert.equal(claimed.bindingId, registered.registrationId, 'binding keeps the registration id, so the credential stays valid');
  assert.equal((await c.connector.binding()).status, 'active');
  const agent = await node.service.get('Agent', claimed.agentId);
  assert.deepEqual([agent.data.bindingStatus, agent.data.displayName], ['verified', 'B 的调研 Agent']);
  const binding = await node.service.get('AgentBinding', claimed.bindingId);
  assert.ok(!JSON.stringify(binding).includes(token.split('_').at(-1)), 'only the hash is stored');
  assert.equal(binding.data.connector.fingerprint, createHash('sha256').update(binding.data.credentialHash).digest('hex').slice(0, 16));
  assert.equal(binding.data.deviceId, c.state.load().deviceId);
  await rejects(b.post(`/claims/${codeOf(registered)}`, { fingerprintSuffix: registered.fingerprint.slice(-4) }), 'REGISTRATION_ALREADY_CLAIMED');
});

test('phishing: a claim link from someone else cannot be completed without their terminal', async t => {
  const { node, a, b } = await twoMembers(t);
  // A (attacker here) registers their own connector and sends the link to B.
  const attacker = testConnector(); t.after(attacker.cleanup);
  const registered = await attacker.connector.register({ node: node.url, name: 'looks like B laptop', codexHome: attacker.codexHome, model: 'm' });
  const code = codeOf(registered);
  const tail = registered.fingerprint.slice(-4);
  const wrong = ['0000', '1111', '2222', '3333', '4444'].filter(value => value !== tail).slice(0, 5);
  for (const [index, guess] of wrong.entries()) {
    await rejects(b.post(`/claims/${code}`, { fingerprintSuffix: guess }), index < 4 ? 'FINGERPRINT_SUFFIX_MISMATCH' : 'REGISTRATION_INVALIDATED');
  }
  // After five wrong attempts even the right tail no longer works.
  await rejects(b.post(`/claims/${code}`, { fingerprintSuffix: tail }), 'REGISTRATION_INVALIDATED');
  const status = await fetch(`${node.url}/connector/v1/binding`, { headers: { authorization: `Bearer ${attacker.state.load().token}` } });
  assert.deepEqual([status.status, (await status.json()).status], [410, 'invalidated']);
  assert.equal((await node.service.list('AgentBinding')).length, 0);
  // Non-members and signed-out visitors cannot even view a claim.
  const stranger = webUser(node);
  await rejects(stranger.get(`/claims/${code}`), 'NOT_SIGNED_IN');
  void a;
});

test('claim links expire; unknown codes are rejected', async t => {
  const { node, b } = await twoMembers(t);
  node.service.registrationTtlMs = 20;
  const c = testConnector(); t.after(c.cleanup);
  const registered = await c.connector.register({ node: node.url, codexHome: c.codexHome, model: 'm' });
  await new Promise(resolve => setTimeout(resolve, 40));
  await rejects(b.post(`/claims/${codeOf(registered)}`, { fingerprintSuffix: registered.fingerprint.slice(-4) }), 'REGISTRATION_EXPIRED');
  assert.equal((await c.connector.waitForClaim({ intervalMs: 10 })).status, 'expired');
  await rejects(b.get('/claims/AAAA-BBBB-CCCC-DDDD'), 'CLAIM_CODE_INVALID');
});

test('re-register on the same device and bind to an existing agent; the old binding is revoked', async t => {
  const { node, b } = await twoMembers(t);
  const root = mkdtempSync(join(tmpdir(), 'community-device-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = await registerAndClaim(node, b, { connector: testConnector({ root, profile: 'first' }) });
  const second = testConnector({ root, profile: 'second' });
  const registered = await second.connector.register({ node: node.url, name: 'reinstalled', codexHome: second.codexHome, model: 'm' });
  const view = await b.get(`/claims/${codeOf(registered)}`);
  assert.deepEqual(view.sameDevice.map(item => [item.agentId, item.status]), [[first.agent.id, 'active']], 'same device id is shown as a hint');
  await b.post(`/claims/${codeOf(registered)}`, { fingerprintSuffix: registered.fingerprint.slice(-4), agentId: first.agent.id });
  const bindings = await node.service.list('AgentBinding');
  assert.deepEqual(bindings.map(item => [item.id === first.claimed.bindingId ? 'old' : 'new', item.data.status, item.data.revokedReason ?? null]).sort(), [['new', 'active', null], ['old', 'revoked', 'replaced']]);
  await rejects(first.connector.binding(), 'BINDING_REVOKED');
  assert.equal((await second.connector.binding()).status, 'active');
  // Only the principal can bind to their agent.
  const other = testConnector(); t.after(other.cleanup);
  const again = await other.connector.register({ node: node.url, codexHome: other.codexHome, model: 'm' });
  const a = webUser(node); await a.post('/login', { username: 'demo-maker' });
  await rejects(a.post(`/claims/${codeOf(again)}`, { fingerprintSuffix: again.fingerprint.slice(-4), agentId: first.agent.id }), 'NOT_AGENT_PRINCIPAL');
});

test('credential rotation: the new secret works, the old one is refused at once', async t => {
  const { node, b } = await twoMembers(t);
  const env = await registerAndClaim(node, b); t.after(env.cleanup);
  const oldToken = env.state.load().token;
  await env.connector.rotate();
  const newToken = env.state.load().token;
  assert.notEqual(newToken, oldToken);
  assert.equal((await env.connector.binding()).status, 'active');
  const old = await fetch(`${node.url}/connector/v1/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${oldToken}`, 'content-type': 'application/json' }, body: '{}' });
  assert.deepEqual([old.status, (await old.json()).error], [401, 'CONNECTOR_CREDENTIAL_INVALID']);
  assert.ok((await node.service.get('AgentBinding', env.claimed.bindingId)).data.rotatedAt);
  // Interrupted rotation: server already switched, local file only has the pending token.
  const config = env.state.load();
  const { randomBytes } = await import('node:crypto');
  const secret = randomBytes(32).toString('base64url');
  const pending = `acc_${config.bindingId.slice(9)}_${secret}`;
  const binding = await node.service.get('AgentBinding', config.bindingId);
  await node.service.rotateCredential({ binding, agent: env.agent, credentialHash: createHash('sha256').update(secret).digest('hex') });
  env.state.save({ ...config, pendingToken: pending });
  assert.equal(await env.connector.recoverRotation(), true);
  assert.equal(env.state.load().token, pending);
});

test('without memory, the connector refuses a CODEX_HOME whose personal instructions would load; with memory it is recorded as such', async t => {
  const { node } = await twoMembers(t);
  const c = testConnector({ mode: 'personal' }); t.after(c.cleanup);
  await rejects(c.connector.register({ node: node.url, codexHome: c.codexHome, model: 'm', memory: 'without-memory' }), 'PERSONAL_INSTRUCTIONS_WOULD_LOAD');
  const explicit = await c.connector.register({ node: node.url, codexHome: c.codexHome, model: 'm', memory: 'with-memory' });
  assert.equal(explicit.isolation, 'personal-codex-home');
});

test('connector credentials are never stored in a git repo, behind a symlink or in a synced folder', t => {
  const root = mkdtempSync(join(tmpdir(), 'community-unsafe-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  assert.equal(unsafeStateDir(join(root, 'repo', 'home', 'connector')), 'STATE_DIR_IN_GIT_REPO');
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'link'));
  assert.equal(unsafeStateDir(join(root, 'link', 'connector')), 'STATE_DIR_SYMLINK');
  const fakeHome = join(root, 'home');
  mkdirSync(join(fakeHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents'), { recursive: true });
  mkdirSync(join(fakeHome, 'Documents'), { recursive: true });
  assert.equal(unsafeStateDir(join(fakeHome, 'Documents', 'agent'), fakeHome), 'STATE_DIR_CLOUD_SYNCED');
  assert.equal(unsafeStateDir(join(fakeHome, '.agent-community', 'connector'), fakeHome), null);
  const state = new ConnectorState('default', join(root, 'repo', 'home'));
  assert.throws(() => state.save({ token: 'x' }), /STATE_DIR_IN_GIT_REPO/);
  const safe = new ConnectorState('default', join(root, 'safe'));
  safe.save({ token: 'x' });
  assert.equal(statSync(safe.file).mode & 0o777, 0o600);
  assert.equal(statSync(safe.dir).mode & 0o777, 0o700);
  const id = safe.deviceId();
  assert.equal(readFileSync(join(root, 'safe', 'device-id'), 'utf8').trim(), id);
  assert.equal(safe.deviceId(), id, 'device id is stable');
});

test('unbind and membership suspension revoke the binding and deny later connector access', async t => {
  const node = await simulatedNode(); t.after(node.close);
  const env = await communityWithAgent(node); t.after(env.cleanup);
  assert.equal((await env.a.get('/discover')).length, 2, 'both capabilities from the agent profile');
  const bId = (await env.b.get('/state')).me.member.human.id;
  await env.a.post(`/members/${bId}/status`, { status: 'suspended' });
  assert.equal((await env.a.get('/discover')).length, 0);
  await rejects(env.connector.binding(), 'BINDING_REVOKED');
  await rejects(env.b.get('/agents'), 'MEMBERSHIP_REQUIRED');
  await env.a.post(`/members/${bId}/status`, { status: 'active' });
  assert.equal((await node.service.get('Agent', env.agent.id)).data.bindingStatus, 'revoked');

  // Re-register, claim onto the same agent, then unbind from the connector side.
  const again = await registerAndClaim(node, env.b, { agentId: env.agent.id }); t.after(again.cleanup);
  assert.equal((await again.connector.binding()).status, 'active');
  const token = again.state.load().token;
  await again.connector.unbind();
  const denied = await fetch(`${node.url}/connector/v1/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.deepEqual([denied.status, (await denied.json()).error], [401, 'BINDING_REVOKED']);
});

test('only one connection path exists: old pairing endpoints are gone; onboarding doc is served', async t => {
  const { node, b } = await twoMembers(t);
  const legacy = await fetch(`${node.url}/connector/v1/pairing/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(legacy.status, 404);
  await rejects(b.post('/agents', { displayName: 'direct' }), 'NOT_FOUND');
  await rejects(b.post('/agents/urn:uuid:00000000-0000-4000-8000-000000000000/pairing'), 'NOT_FOUND');
  await rejects(b.post('/bindings/urn:uuid:00000000-0000-4000-8000-000000000000/confirm', {}), 'NOT_FOUND');
  const doc = await (await fetch(`${node.url}/agent-onboarding.md`)).text();
  assert.match(doc, new RegExp(`社区节点：\`${node.url.replaceAll('.', '\\.')}\``));
  for (const rule of ['登记不等于授权', '每一单都要主人确认', '心跳和事件不授权任何新动作', '拒绝写入 git 仓库']) assert.ok(doc.includes(rule), rule);
  const page = await fetch(`${node.url}/claim/AAAA-BBBB-CCCC-DDDD`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent Community/);
});
