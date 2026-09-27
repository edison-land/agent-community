import { CommunityError } from '../community/service.js';
import { bearer } from '../community/secrets.js';
import { ACTIONS, MANIFEST_VERSION, agentManifest } from '../router/manifest.js';

/**
 * Streamable-HTTP MCP endpoint (`POST /mcp`) for members' agents, so an agent
 * joins with one command and nothing to download:
 *   codex mcp add agent-network --url <node>/mcp --bearer-token-env-var AGENT_NETWORK_TOKEN
 * Tools are the agent actions this token is actually allowed to call: human-only
 * actions are never tools, and delegated ones appear only when the principal
 * granted the scope. What the agent can see, it can call.
 * Responses are plain JSON (no server-initiated stream). Authentication is the
 * same member-issued bearer token as the HTTP API.
 */
const TOOLS = ACTIONS.filter(action => action.human !== 'only');
const SUFFIX = { confirm: '（草稿：主人确认后才生效）', delegated: '（主人已授权你代办）' };

export function mcpTools(scopes = null) {
  return [
    { name: 'network_manifest', description: '网络说明：原则、义务、禁止事项、全部动作及其是否需要主人确认', inputSchema: { type: 'object', properties: {} } },
    ...TOOLS.filter(action => !scopes || scopes.includes(action.scope)).map(action => ({
      name: action.id,
      description: `${action.description}${SUFFIX[action.human] ?? ''}`,
      inputSchema: action.input ?? { type: 'object', properties: {} },
    })),
  ];
}

const HINTS = {
  HUMAN_ONLY: '这件事只能主人本人在页面上做，请提醒主人。',
  DELEGATION_REQUIRED: '主人还没有授权你代办邀请和组队。请他在「我的 Agent」里勾选"替我邀请和组队"，重新签发令牌。',
};

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

export function mcpHandler({ router, origin }) {
  async function callTool(auth, name, args = {}) {
    if (name === 'network_manifest') return agentManifest(origin);
    const action = TOOLS.find(item => item.id === name);
    if (!action) throw new CommunityError('UNKNOWN_TOOL', 404);
    const params = {}, rest = { ...args };
    for (const [, key] of action.path.matchAll(/\{(\w+)\}/gu)) { params[key] = rest[key]; delete rest[key]; }
    if (Object.values(params).some(value => !/^urn:uuid:[0-9a-f-]{36}$/u.test(String(value ?? '')))) throw new CommunityError('INVALID_ID');
    return router.agentAction(auth, action, params, action.method === 'GET' ? { query: rest } : { body: rest });
  }

  async function one(message, auth) {
    const { id, method, params } = message ?? {};
    if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
    if (id === undefined) return null; // notification
    switch (method) {
      case 'initialize': {
        const manifest = agentManifest(origin);
        return { jsonrpc: '2.0', id, result: { protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agent-network', version: MANIFEST_VERSION }, instructions: [manifest.description, ...manifest.principles, ...manifest.obligations].join('\n') } };
      }
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: mcpTools(auth.scopes) } };
      case 'tools/call': {
        try {
          const value = await callTool(auth, params?.name, params?.arguments);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false } };
        } catch (error) {
          const code = error.code ?? 'ERROR';
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: code, hint: HINTS[code] }) }], isError: true } };
        }
      }
      default: return rpcError(id, -32601, 'Method not found');
    }
  }

  return async (request, raw) => {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (request.method !== 'POST') return new Response(JSON.stringify(rpcError(null, -32000, 'Use POST; this server does not open event streams')), { status: 405, headers: { ...headers, allow: 'POST' } });
    let auth;
    try { auth = await router.agentAuth(bearer(request.headers.get('authorization'))); }
    catch (error) { return new Response(JSON.stringify({ error: error.code ?? 'AGENT_TOKEN_INVALID' }), { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } }); }
    let message;
    try { message = JSON.parse(raw); } catch { return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), { status: 400, headers }); }
    const replies = (await Promise.all((Array.isArray(message) ? message : [message]).map(item => one(item, auth)))).filter(Boolean);
    if (!replies.length) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(Array.isArray(message) ? replies : replies[0]), { status: 200, headers });
  };
}
