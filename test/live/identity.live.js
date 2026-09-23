/**
 * REAL INTEGRATION (phase 2): live node process + real local FlareMo accounts
 * (password sign-in and /auth/me re-verification) + FlareMo object storage +
 * connector CLI processes using the register → claim path. The connector's
 * Codex preflight uses the simulated binary because registration never runs a
 * model; phase 4 uses the real CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FlareMoObjectStore } from '../../packages/store/flaremo-objects.js';
import { webUser, inviteAndJoin } from '../support/harness.js';
import { localState } from '../support/local.js';
import { liveNode, cli, connectorHome, registerViaCli, claimViaWeb } from '../support/processes.js';

const state = localState();
const account = label => state.accounts.find(item => item.label === label);
const store = new FlareMoObjectStore({ baseUrl: state.url, token: state.service.pat, allowLocal: true });
const status = async env => JSON.parse((await cli('apps/connector/cli.js', ['status'], env)).stdout).binding;

test('two real FlareMo test accounts join; register → claim, phishing, expiry, rotation, re-bind, revocation', async t => {
  const node = await liveNode({ COMMUNITY_REGISTRATION_TTL_MS: '8000' }); t.after(() => node.close());
  const a = webUser(node), b = webUser(node), intruder = webUser(node);

  await assert.rejects(intruder.post('/login', { username: account('member-a').username, password: 'wrong-password' }), /FLAREMO_HTTP_401/);
  await a.post('/login', { username: account('member-a').username, password: account('member-a').password });
  await b.post('/login', { username: account('member-b').username, password: account('member-b').password });
  const identityA = (await a.get('/state')).me.identity;
  assert.equal(identityA.provider, state.url);
  assert.equal(identityA.synthetic, false);
  const created = await a.post('/community', { communityName: 'Live Local Community', displayName: 'Member A' });
  await inviteAndJoin(a, b, 'Member B');
  const links = await store.list(created.communityId, 'record', 'IdentityLink');
  assert.deepEqual(links.map(link => link.data.subject).sort(), [account('member-a').id, account('member-b').id].sort());

  // Register on B's machine; nothing reaches FlareMo until B claims it.
  const c = connectorHome({ fakeMode: 'success' }); t.after(c.cleanup);
  const registered = await registerViaCli(node, c.env, { codexHome: c.codexHome, models: ['gpt-5.5'], name: 'member-b live connector' });
  assert.match(registered.stdout, /只在这里显示/);
  assert.equal(await status(c.env), 'awaiting-claim');
  assert.equal((await store.list(created.communityId, 'record', 'AgentBinding')).length, 0);

  // Phishing: the link reaches A, who does not have B's terminal.
  const view = await a.get(`/claims/${registered.code}`);
  assert.equal(view.fingerprintPrefix, registered.fingerprint.slice(0, 12));
  await assert.rejects(a.post(`/claims/${registered.code}`, { fingerprintSuffix: registered.fingerprint.slice(-4) === '0000' ? '1111' : '0000' }), /FINGERPRINT_SUFFIX_MISMATCH/);
  const claimed = await claimViaWeb(b, registered);
  assert.equal(await status(c.env), 'active');
  const [binding] = await store.list(created.communityId, 'record', 'AgentBinding');
  assert.deepEqual([binding.id, binding.data.status, binding.data.connector.models], [claimed.bindingId, 'active', ['gpt-5.4-mini', 'gpt-5.5']]);

  // Expiry: an unclaimed registration dies after the configured TTL.
  const late = await registerViaCli(node, c.env, { codexHome: c.codexHome, profile: 'late' });
  await new Promise(resolve => setTimeout(resolve, 8500));
  await assert.rejects(claimViaWeb(b, late), /REGISTRATION_EXPIRED/);
  assert.equal(await status(c.env), 'active', 'the claimed connector is unaffected');

  // Rotation: new secret works, old one is refused immediately.
  const stateFile = join(c.home, 'connector', 'default', 'state.json');
  const oldToken = JSON.parse(readFileSync(stateFile, 'utf8')).token;
  const rotated = await cli('apps/connector/cli.js', ['rotate'], c.env);
  assert.equal(rotated.code, 0, rotated.stdout);
  assert.equal(await status(c.env), 'active');
  const old = await fetch(`${node.url}/connector/v1/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${oldToken}`, 'content-type': 'application/json' }, body: '{}' });
  assert.deepEqual([old.status, (await old.json()).error], [401, 'CONNECTOR_CREDENTIAL_INVALID']);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.ok((await store.get(created.communityId, 'record', claimed.bindingId)).data.rotatedAt);

  // Owner suspends B: discovery empties and the connector is refused.
  const capability = await b.post('/capabilities', { agentId: claimed.agentId, title: 'Live capability', description: 'live' });
  assert.equal((await a.get('/discover')).some(item => item.capabilityId === capability.id), true);
  const bHuman = (await b.get('/state')).me.member.human.id;
  await a.post(`/members/${bHuman}/status`, { status: 'suspended' });
  assert.equal((await a.get('/discover')).length, 0);
  assert.match(await status(c.env), /BINDING_REVOKED/);
  await a.post(`/members/${bHuman}/status`, { status: 'active' });

  // Re-register on the same device and bind to the existing agent; then unbind from the CLI.
  const again = await registerViaCli(node, c.env, { codexHome: c.codexHome, profile: 'reinstall', name: 'member-b reinstalled' });
  const hint = await b.get(`/claims/${again.code}`);
  assert.ok(hint.sameDevice.some(item => item.agentId === claimed.agentId), 'same device id shown');
  await claimViaWeb(b, again, { agentId: claimed.agentId });
  const reinstallEnv = c.env;
  assert.equal(JSON.parse((await cli('apps/connector/cli.js', ['status', '--profile', 'reinstall'], reinstallEnv)).stdout).binding, 'active');
  assert.equal((await cli('apps/connector/cli.js', ['unbind', '--profile', 'reinstall'], reinstallEnv)).code, 0);
  assert.equal((await store.get(created.communityId, 'object', claimed.agentId)).data.bindingStatus, 'revoked');
  const bindingsNow = await store.list(created.communityId, 'record', 'AgentBinding');
  assert.deepEqual(bindingsNow.map(item => item.data.status).sort(), ['revoked', 'revoked']);

  // The removed pairing endpoints do not exist on the live node either.
  assert.equal((await fetch(`${node.url}/connector/v1/pairing/claim`, { method: 'POST', body: '{}' })).status, 404);

  const out = await a.post('/logout');
  assert.equal(out.signedOut, true);
  await assert.rejects(a.get('/agents'), /NOT_SIGNED_IN/);
});
