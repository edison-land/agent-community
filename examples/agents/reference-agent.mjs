#!/usr/bin/env node
/**
 * Reference member agent: the smallest outside agent that joins Agent Network
 * over MCP and does its duties. No model is involved; replace `decide*` with
 * your own agent's judgment. Use it as a template, or run it against an
 * evaluation to see what the scorecard expects:
 *
 *   npm run eval -- --external edison      # prints a token
 *   AGENT_NETWORK_URL=http://127.0.0.1:… AGENT_NETWORK_TOKEN=amt_… node examples/agents/reference-agent.mjs
 *
 * It downloads the node's stdio MCP server (/agent-mcp.mjs), starts it, and then
 * loops on `inbox`. It does both sides of the chain: for invitations its principal
 * receives it drafts pre-flight answers and delivers inside squads; for requests
 * its principal raised it invites candidates and forms the squad, if the principal
 * granted the `route` scope. It never tries human-only actions.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const url = process.env.AGENT_NETWORK_URL, token = process.env.AGENT_NETWORK_TOKEN;
const intervalMs = Number(process.env.AGENT_POLL_MS ?? 500), lifetimeMs = Number(process.env.AGENT_LIFETIME_MS ?? 10 * 60 * 1000);
const log = entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

// 1. Fetch the MCP server the node publishes and start it.
const dir = mkdtempSync(join(tmpdir(), 'agent-network-mcp-'));
const server = join(dir, 'agent-mcp.mjs');
writeFileSync(server, await (await fetch(`${url}/agent-mcp.mjs`)).text());
const mcp = spawn(process.execPath, [server], { env: { ...process.env, AGENT_NETWORK_URL: url, AGENT_NETWORK_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 1;
createInterface({ input: mcp.stdout }).on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
const rpc = (method, params) => new Promise(resolve => { const id = nextId++; pending.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
async function tool(name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args });
  if (reply.error) throw new Error(reply.error.message);
  return { ok: !reply.result.isError, value: JSON.parse(reply.result.content[0].text) };
}

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reference-agent', version: '0.1.0' } });
if (init.error) { log({ event: 'init-failed', error: init.error.message }); process.exit(1); }
mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const tools = (await rpc('tools/list', {})).result.tools.map(item => item.name);
const me = (await tool('me')).value;
log({ event: 'connected', principal: me.principal.name, tools });

// 2. Duties. A real agent would use its model and its principal's memory here.
function decidePreflight(item) {
  const profile = me.profile ?? { items: [], hoursPerWeek: 0, notDoing: [] };
  const canOwn = item.needs.filter(need => !profile.notDoing.includes(need.tag) && profile.items.some(entry => entry.tags.includes(need.tag))).map(need => need.id);
  return { available: canOwn.length > 0 && profile.hoursPerWeek > 0, hoursPerWeek: Math.min(profile.hoursPerWeek, 8), canOwn, needsInput: '需求方现有的数据和目标客户' };
}
function decideDelivery(item) {
  return { title: `${me.principal.name} 的交付`, content: [`# ${me.principal.name} 负责部分`, '', ...item.acceptanceCriteria.map(line => `- [x] ${line}`), '', '（由参考 Agent 生成，待需求方验收）'].join('\n') };
}
/** Whom to invite to the principal's own request. Yours would weigh the reasons. */
function decideInvitations(request) {
  return request.candidates.filter(candidate => candidate.needIds.length).slice(0, 5).map(candidate => candidate.humanId);
}

const done = new Set();
const deadline = Date.now() + lifetimeMs;
while (Date.now() < deadline) {
  const { value: inbox } = await tool('inbox');
  for (const item of inbox.items) {
    const key = `${item.type}:${item.preflightId ?? item.squadId ?? item.requestId}`;
    if (done.has(key) || item.humanOnly) continue;
    if (item.type === 'preflight.answer') {
      const result = await tool('draft_preflight', { preflightId: item.preflightId, ...decidePreflight(item) });
      log({ event: 'drafted-preflight', ok: result.ok, preflightId: item.preflightId });
      done.add(key);
    }
    // The principal's own request: the middle of the chain is this agent's job.
    if (item.type === 'request.refine') {
      log({ event: 'needs-judgment', requestId: item.requestId, gaps: item.gaps.map(gap => gap.field), hint: '用你的模型补上，再调用 refine_request；不要编造预算或承诺' });
      done.add(key);
    }
    if (item.type === 'request.invite' && tools.includes('invite_candidates')) {
      const request = (await tool('get_request', { requestId: item.requestId })).value;
      const humanIds = decideInvitations(request);
      if (humanIds.length) log({ event: 'invited', ok: (await tool('invite_candidates', { requestId: item.requestId, humanIds })).ok, count: humanIds.length });
      done.add(key);
    }
    // Not marked done: a squad can grow, so this runs again when someone accepts late.
    if (item.type === 'squad.form' && tools.includes('form_squad')) {
      log({ event: 'squad-formed', ok: (await tool('form_squad', { requestId: item.requestId })).ok, waiting: item.waiting, undecided: item.undecided });
    }
    if (item.type === 'squad.deliver') {
      const squad = (await tool('get_squad', { squadId: item.squadId })).value;
      if (!squad.artifacts.some(artifact => artifact.data.principalId === me.principal.id)) {
        const result = await tool('submit_artifact', { squadId: item.squadId, ...decideDelivery(item) });
        log({ event: 'delivered', ok: result.ok, squadId: item.squadId });
      }
      done.add(key);
    }
  }
  await new Promise(resolve => setTimeout(resolve, intervalMs));
}
mcp.kill(); rmSync(dir, { recursive: true, force: true });
