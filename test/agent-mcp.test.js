// SIMULATED: members' agents connect over MCP — the node's streamable-HTTP
// endpoint (/mcp) and the downloadable stdio server (/agent-mcp.mjs). Tools are
// the actions this token may actually call: human-only actions are never tools,
// and delegated ones appear only when the principal granted the scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNode } from '../apps/node/server.js';
import { MemoryObjectStore } from '../packages/store/memory-objects.js';
import { createMockLogin } from '../packages/identity/mock.js';
import { SCOPES } from '../packages/router/manifest.js';
import { webUser, inviteAndJoin } from './support/harness.js';

const STDIO = fileURLToPath(new URL('../apps/node/public/agent-mcp.mjs', import.meta.url));
const ROSTER = [{ username: 'owner', displayName: 'Owner' }, { username: 'ed', displayName: 'Ed' }];

async function setup(t) {
  const node = await startNode({ port: 0, mode: 'simulated', store: new MemoryObjectStore(), login: createMockLogin({ members: ROSTER }) });
  t.after(node.close);
  const owner = webUser(node), ed = webUser(node);
  await owner.post('/login', { username: 'owner' });
  await owner.post('/community', { communityName: 'C', displayName: 'Owner' });
  await ed.post('/login', { username: 'ed' });
  await inviteAndJoin(owner, ed, 'Ed');
  const request = await owner.post('/router/requests', { title: '招聘数据看板', description: '需要招聘经验和数据能力', acceptanceCriteria: ['一周原型'] });
  const issued = await ed.post('/router/agents', { name: 'Ed 的 Agent', scopes: [...SCOPES] });
  const narrow = await ed.post('/router/agents', { name: '未授权代办的 Agent', scopes: ['read', 'suggest'] });
  return { node, owner, ed, request, issued, narrow };
}

test('HTTP MCP: bearer-authenticated JSON-RPC; tools mirror the manifest; human-only actions are not offered', async t => {
  const { node, request, issued } = await setup(t);
  const post = (body, token = issued.token) => fetch(`${node.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, null)).status, 401);
  assert.equal((await fetch(`${node.url}/mcp`)).status, 405);
  const [init, list] = await (await post([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /永远由主人本人做/u);
  const names = list.result.tools.map(tool => tool.name);
  assert.ok(names.includes('inbox') && names.includes('draft_preflight') && names.includes('network_manifest'));
  assert.ok(!names.includes('respond_invitation') && !names.includes('review_outcome'), 'committing and judging are not tools');
  assert.ok(names.includes('invite_candidates'), 'a token granted `route` may route');
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const called = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_request', arguments: { requestId: request.id } } })).json();
  assert.equal(JSON.parse(called.result.content[0].text).request.id, request.id);
  const bad = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_request', arguments: { requestId: 'not-an-id' } } })).json();
  assert.equal(bad.result.isError, true);
});

test('a token without the route scope is not even offered the delegated tools', async t => {
  const { node, narrow } = await setup(t);
  const post = body => fetch(`${node.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${narrow.token}` }, body: JSON.stringify(body) });
  const listed = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
  const names = listed.result.tools.map(tool => tool.name);
  assert.ok(names.includes('suggest') && !names.includes('invite_candidates') && !names.includes('form_squad'));
  assert.ok(!names.includes('draft_preflight'), 'the same rule applies to every scope');
  const refused = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'invite_candidates', arguments: { requestId: 'urn:uuid:00000000-0000-4000-8000-000000000000', humanIds: [] } } })).json();
  const body = JSON.parse(refused.result.content[0].text);
  assert.deepEqual([refused.result.isError, body.error], [true, 'DELEGATION_REQUIRED'], 'calling it anyway is refused, and says what to ask the principal for');
  assert.match(body.hint, /「我的 Agent」/u);
});

test('with no token the stdio server asks the node for an authorization link and hands it to its principal', async t => {
  const { node } = await setup(t);
  const home = await mkdtemp(join(tmpdir(), 'agent-network-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [STDIO], { env: { ...process.env, AGENT_NETWORK_URL: node.url, AGENT_NETWORK_TOKEN: '', AGENT_NETWORK_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const waiting = new Map(); let id = 0;
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); waiting.get(message.id)?.(message); });
  const rpc = (method, params) => new Promise(resolve => { id += 1; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'agent-network', '没有令牌也能连上');
  const body = JSON.parse((await rpc('tools/call', { name: 'me', arguments: {} })).result.content[0].text);
  assert.equal(body.error, 'AUTHORIZE_PENDING');
  assert.match(body.authorize_url, new RegExp(`^${node.url}/router\\.html\\?authorize=[A-Z0-9-]+$`, 'u'), '给主人的是一个链接，不是一个要他复制的密钥');
  assert.match(body.action, /给你的主人/u);
});

test('the whole join, end to end: link, the member approves, the agent works and remembers the token', async t => {
  const { node, ed } = await setup(t);
  const home = await mkdtemp(join(tmpdir(), 'agent-network-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_NETWORK_URL: node.url, AGENT_NETWORK_TOKEN: '', AGENT_NETWORK_HOME: home, AGENT_NETWORK_AGENT_NAME: 'Ed 的 Codex' };
  const connect = () => {
    const child = spawn(process.execPath, [STDIO], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    t.after(() => child.kill());
    const waiting = new Map(); let id = 0;
    createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); waiting.get(message.id)?.(message); });
    return (method, params) => new Promise(resolve => { id += 1; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  };
  const call = async (rpc, name) => JSON.parse((await rpc('tools/call', { name, arguments: {} })).result.content[0].text);

  const rpc = connect();
  await rpc('initialize', { protocolVersion: '2025-06-18' });
  const asked = await call(rpc, 'me');
  const code = new URL(asked.authorize_url).searchParams.get('authorize');

  // The member opens the link, sees the agent's own name, and grants part of what it asked.
  assert.equal((await ed.get(`/router/device/${code}`)).agentName, 'Ed 的 Codex');
  await ed.post(`/router/device/${code}/approve`, { scopes: ['profile:draft', 'suggest'] });

  const working = await call(rpc, 'me');
  assert.equal(working.principal.name, 'Ed', '同一个进程，主人点完就能用，不用重启');
  assert.deepEqual(working.scopes.sort(), ['profile:draft', 'read', 'suggest']);

  // A second run needs no approval: the token was kept, 0600, outside the repository.
  const again = await call(connect(), 'me');
  assert.equal(again.principal.name, 'Ed');
  const saved = JSON.parse(await readFile(join(home, `${new URL(node.url).host.replace(/[^\w.-]/gu, '_')}.json`), 'utf8'));
  assert.equal(saved.url, node.url);
  assert.match(saved.token, /^amt_/u);
  assert.equal((await stat(join(home, `${new URL(node.url).host.replace(/[^\w.-]/gu, '_')}.json`))).mode & 0o777, 0o600);
});

test('stdio MCP (the file the node serves): initialize, list tools, call them; a bad URL is reported', async t => {
  const { node, issued } = await setup(t);
  const start = env => {
    const child = spawn(process.execPath, [STDIO], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    t.after(() => child.kill());
    const waiting = new Map(); let id = 0;
    createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); waiting.get(message.id)?.(message); });
    return (method, params) => new Promise(resolve => { id += 1; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  };
  const broken = start({ AGENT_NETWORK_URL: 'http://example.com', AGENT_NETWORK_TOKEN: '' });
  assert.match((await broken('initialize', {})).error.message, /https/u);
  const rpc = start({ AGENT_NETWORK_URL: node.url, AGENT_NETWORK_TOKEN: issued.token });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'agent-network');
  const tools = (await rpc('tools/list', {})).result.tools.map(tool => tool.name);
  assert.ok(tools.includes('suggest') && tools.includes('invite_candidates') && !tools.includes('review_outcome'));
  const me = JSON.parse((await rpc('tools/call', { name: 'me', arguments: {} })).result.content[0].text);
  assert.equal(me.principal.name, 'Ed');
  const refused = await rpc('tools/call', { name: 'draft_preflight', arguments: { preflightId: 'bad' } });
  assert.equal(refused.result.isError, true);
});
