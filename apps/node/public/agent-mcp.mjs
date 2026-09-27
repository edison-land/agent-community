#!/usr/bin/env node
/**
 * Agent Network MCP server over stdio, for agents that only launch local MCP
 * servers. It is served verbatim by the node at /agent-mcp.mjs and needs only
 * Node.js 20+ (no packages). Tools come from the node's published manifest,
 * narrowed to what this token is allowed to call.
 *
 *   AGENT_NETWORK_URL=https://… AGENT_NETWORK_TOKEN=amt_… node agent-mcp.mjs
 *
 * Codex:        codex mcp add agent-network --env AGENT_NETWORK_URL=… --env AGENT_NETWORK_TOKEN=… -- node agent-mcp.mjs
 * Claude Code:  claude mcp add agent-network -e AGENT_NETWORK_URL=… -e AGENT_NETWORK_TOKEN=… -- node agent-mcp.mjs
 */
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = String(process.env.AGENT_NETWORK_URL ?? '').replace(/\/+$/u, '');
const ID = /^urn:uuid:[0-9a-f-]{36}$/u;
const TOKEN = /^amt_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u;
const HOME = process.env.AGENT_NETWORK_HOME ?? join(homedir(), '.agent-network');
let manifest = null, scopes = null;
let token = String(process.env.AGENT_NETWORK_TOKEN ?? '');
let pending = null; // an authorization the principal has not answered yet

/**
 * The principal should never copy a secret. With no token, this asks the node
 * for an authorization code and hands the link back through the tool result —
 * so the agent can show it to them — then polls until they approve and keeps
 * the token for next time (0600, outside any repository).
 */
const tokenFile = () => join(HOME, `${new URL(base).host.replace(/[^\w.-]/gu, '_')}.json`);
function rememberToken(value) {
  token = value;
  try {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile(), JSON.stringify({ url: base, token: value }), { mode: 0o600 });
  } catch (error) { process.stderr.write(`agent-network: could not save the token (${error.message})\n`); }
}
function loadToken() {
  if (TOKEN.test(token)) return true;
  try {
    const saved = JSON.parse(readFileSync(tokenFile(), 'utf8'));
    if (saved.url === base && TOKEN.test(saved.token)) { token = saved.token; return true; }
  } catch { /* nothing saved yet */ }
  return false;
}

const post = (path, body) => fetch(`${base}/api/agent/v1${path}`, {
  method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(response => response.json());

/** Returns null once authorized, or what to tell the principal while it waits. */
async function authorize() {
  if (loadToken()) return null;
  if (!pending) {
    const started = await post('/device', { name: process.env.AGENT_NETWORK_AGENT_NAME || `${process.env.USER || '某位成员'} 的 Agent` });
    if (started.error) throw new Error(started.error);
    pending = started;
    process.stderr.write(`agent-network: 等待授权 ${pending.verifyUrl}\n`);
  }
  const polled = await post('/device/token', { deviceCode: pending.deviceCode });
  if (polled.status === 'approved') { rememberToken(polled.token); pending = null; return null; }
  if (polled.error) { const url = pending.verifyUrl; pending = null; throw new Error(`${polled.error}（请重新发起：${url}）`); }
  return {
    error: 'AUTHORIZE_PENDING',
    action: '请把下面这个链接给你的主人，让他打开、登录并勾选你可以做什么。他同意之后，再调用一次就可以了。',
    authorize_url: pending.verifyUrl,
  };
}

function checkConfig() {
  let url;
  try { url = new URL(base); } catch { return 'AGENT_NETWORK_URL is missing or invalid'; }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) return 'AGENT_NETWORK_URL must be https (or a loopback address)';
  return null;
}

async function loadManifest() {
  if (manifest) return manifest;
  const response = await fetch(`${base}/.well-known/agent-network.json`, { redirect: 'error' });
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  manifest = await response.json();
  // The token decides which actions exist for this agent; a failure here is not fatal.
  const me = TOKEN.test(token) ? await call('me').catch(() => null) : null;
  scopes = Array.isArray(me?.scopes) ? me.scopes : null;
  return manifest;
}

const SUFFIX = { confirm: '（草稿：主人确认后才生效）', delegated: '（主人已授权你代办）' };

function tools() {
  return [
    { name: 'network_manifest', description: '网络说明：原则、义务、禁止事项、全部动作及其是否需要主人确认', inputSchema: { type: 'object', properties: {} } },
    ...manifest.actions.filter(action => action.human !== 'only' && (!scopes || scopes.includes(action.scope))).map(action => ({
      name: action.id, description: `${action.description}${SUFFIX[action.human] ?? ''}`, inputSchema: action.input ?? { type: 'object', properties: {} },
    })),
  ];
}

async function call(name, args = {}) {
  if (name === 'network_manifest') return { ok: true, manifest };
  const waiting = await authorize();
  if (waiting) return { ok: false, ...waiting };
  const action = manifest.actions.find(item => item.id === name && item.human !== 'only');
  if (!action) return { ok: false, error: 'UNKNOWN_TOOL' };
  const rest = { ...args };
  let path = action.path;
  for (const [placeholder, key] of action.path.matchAll(/\{(\w+)\}/gu)) {
    if (!ID.test(String(rest[key] ?? ''))) return { ok: false, error: 'INVALID_ID', field: key };
    path = path.replace(placeholder, rest[key]);
    delete rest[key];
  }
  const url = new URL(`${base}/api/agent/v1${path}`);
  let body;
  if (action.method === 'GET') { for (const [key, value] of Object.entries(rest)) url.searchParams.set(key, String(value)); }
  else body = JSON.stringify(rest);
  const response = await fetch(url, { method: action.method, redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, ...json };
}

const HINTS = {
  HUMAN_ONLY: '这件事只能主人本人在页面上做，请提醒主人。',
  DELEGATION_REQUIRED: '主人还没有授权你代办邀请和组队。请他在「我的 Agent」里勾选"替我邀请和组队"，重新签发令牌。',
};

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notifications need no reply
  try {
    switch (method) {
      case 'initialize': {
        const problem = checkConfig();
        if (problem) return error(id, -32002, problem);
        await loadManifest();
        await authorize().catch(() => {});
        return reply(id, { protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agent-network', version: manifest.version }, instructions: [manifest.description, ...manifest.principles, ...manifest.obligations].join('\n') });
      }
      case 'ping': return reply(id, {});
      case 'tools/list': await loadManifest(); return reply(id, { tools: tools() });
      case 'tools/call': {
        await loadManifest();
        const result = await call(params?.name, params?.arguments);
        const hint = HINTS[result.error];
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(hint ? { ...result, hint } : result, null, 2) }], isError: !result.ok });
      }
      default: return error(id, -32601, 'Method not found');
    }
  } catch (failure) {
    return error(id, -32603, String(failure?.message ?? failure).slice(0, 300));
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return error(null, -32700, 'Parse error'); }
  handle(message);
});
