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

const base = String(process.env.AGENT_NETWORK_URL ?? '').replace(/\/+$/u, '');
const token = String(process.env.AGENT_NETWORK_TOKEN ?? '');
const ID = /^urn:uuid:[0-9a-f-]{36}$/u;
let manifest = null, scopes = null;

function checkConfig() {
  let url;
  try { url = new URL(base); } catch { return 'AGENT_NETWORK_URL is missing or invalid'; }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) return 'AGENT_NETWORK_URL must be https (or a loopback address)';
  if (!/^amt_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u.test(token)) return 'AGENT_NETWORK_TOKEN is missing; ask your principal to issue one on the page';
  return null;
}

async function loadManifest() {
  if (manifest) return manifest;
  const response = await fetch(`${base}/.well-known/agent-network.json`, { redirect: 'error' });
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  manifest = await response.json();
  // The token decides which actions exist for this agent; a failure here is not fatal.
  const me = await call('me').catch(() => null);
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
