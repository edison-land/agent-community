#!/usr/bin/env node
/**
 * End-to-end evaluation of opportunity routing (RFC 0010).
 *
 *   npm run eval                                   # scripted agents only; writes outputs/eval/<run>/
 *   npm run eval -- --external edison              # Edison's agent is yours: connect it, the run waits for it
 *   npm run eval -- --external edison --manual-human edison   # you also play Edison's human side on the page
 *   npm run eval -- --serve                        # keep the node running afterwards to explore the page
 *   npm run eval -- --port 4330 --public-origin https://<tunnel>   # so agents on other machines can reach it
 *   npm run eval -- --target https://agent-network-demo.zwteam.top --reset-secret-file ~/.agent-community/local/demo.json
 *
 * Everything runs in memory with the scenario's fictional members; nothing is deployed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../packages/eval/runner.js';
import { renderReport } from '../../packages/eval/report.js';
import { FlareMoObjectStore } from '../../packages/store/flaremo-objects.js';
import { CachedStore } from '../../packages/store/cached.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  scenario: { type: 'string', default: join(ROOT, 'examples/scenarios/kosx-recruitment.json') },
  external: { type: 'string', default: '' }, 'manual-human': { type: 'string', default: '' },
  port: { type: 'string', default: '0' }, host: { type: 'string', default: '127.0.0.1' }, 'public-origin': { type: 'string' },
  timeout: { type: 'string', default: '600' }, out: { type: 'string', default: join(ROOT, 'outputs/eval') }, serve: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  target: { type: 'string' }, 'reset-secret-file': { type: 'string' }, store: { type: 'string', default: 'memory' },
} });
const list = value => value.split(',').map(item => item.trim()).filter(Boolean);
const scenario = JSON.parse(readFileSync(resolve(values.scenario), 'utf8'));
const external = list(values.external), manualHumans = list(values['manual-human']);
for (const key of [...external, ...manualHumans]) if (!scenario.members.some(member => member.key === key && (external.includes(key) ? member.agent : true))) throw new Error(`${key} is not a member with an agent in ${scenario.id}`);

const say = text => process.stderr.write(`${text}\n`);
const result = await runScenario(scenario, {
  port: Number(values.port), host: values.host, publicOrigin: values['public-origin'] ?? null, external, manualHumans,
  // --target: evaluate a deployed demo node instead of a local one (wiped first; needs the operator's reset secret).
  // --store flaremo-local: the local FlareMo test instance (scripts/local/flaremo.mjs), through the same cache production uses.
  store: values.store === 'flaremo-local' ? (() => { const local = JSON.parse(readFileSync(join(process.env.AGENT_COMMUNITY_HOME ?? join(process.env.HOME, '.agent-community'), 'local', 'flaremo.json'), 'utf8')); return new CachedStore(new FlareMoObjectStore({ baseUrl: local.url, token: local.service.pat, allowLocal: true })); })() : null,
  target: values.target ?? null, resetSecret: values['reset-secret-file'] ? JSON.parse(readFileSync(resolve(values['reset-secret-file'].replace(/^~(?=\/)/u, process.env.HOME)), 'utf8')).resetSecret : null,
  externalTimeoutMs: Number(values.timeout) * 1000, keepNode: values.serve,
  log: entry => say(`[${entry.status === 'pass' ? '通过' : entry.status === 'warn' ? '提醒' : '未通过'}] ${entry.title}（${entry.ms} ms）${entry.failed?.length ? ` — ${entry.failed.join('；')}` : ''}${entry.error ? ` — ${entry.error}` : ''}`),
  onExternalReady: info => say([
    '', `== ${info.displayName} 的 Agent 由你来接：把下面交给你的 Agent（Codex、Claude Code 等），评估会等待它最多 ${values.timeout} 秒 ==`,
    `export AGENT_NETWORK_TOKEN=${info.token}`,
    `codex mcp add agent-network --url ${info.mcp} --bearer-token-env-var AGENT_NETWORK_TOKEN`,
    `claude mcp add --transport http agent-network ${info.mcp} --header "Authorization: Bearer $AGENT_NETWORK_TOKEN"`,
    `说明：${info.guide}    清单：${info.manifest}`,
    `然后对 Agent 说：请阅读 ${info.guide}，作为 ${info.displayName} 的 Agent 持续查看 inbox 并按说明行动。`,
    ...(manualHumans.includes(info.member) ? [`你本人的操作在 ${info.node}/router.html（登录选「${info.displayName}」）：确认 Agent 起草的内容、接受邀请。`] : []), '',
  ].join('\n')),
});

const run = `${result.startedAt.replace(/[:.]/gu, '-')}-${scenario.id}`;
const dir = join(resolve(values.out), run);
mkdirSync(dir, { recursive: true });
const { nodeHandle, ...serializable } = result;
writeFileSync(join(dir, 'result.json'), `${JSON.stringify(serializable, null, 2)}\n`);
writeFileSync(join(dir, 'report.md'), renderReport(serializable));
say(`\n结果：${result.verdict} · 报告 ${join(dir, 'report.md')}`);
if (values.json) process.stdout.write(`${JSON.stringify(serializable)}\n`);
if (values.serve && nodeHandle) {
  say(`节点保持运行：${nodeHandle.url}/router.html （模拟登录可选：${scenario.members.map(member => member.displayName).join('、')}）。Ctrl+C 结束。`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await nodeHandle.close(); process.exit(0); });
} else process.exitCode = result.verdict === 'fail' ? 1 : 0;
