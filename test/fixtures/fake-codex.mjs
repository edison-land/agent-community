#!/usr/bin/env node
// SIMULATED Codex CLI for offline connector tests. Emits the event shapes
// observed from real codex-cli 0.153.4 `exec --json`. Behaviour comes from
// $CODEX_HOME/fake-mode: success | fail | hang | slow[:ms] | personal | profile-fail.
// $CODEX_HOME/fake-mcp.json lists MCP servers ({name, enabled, plugin?, stubborn?});
// every exec appends its argv to $CODEX_HOME/fake-exec-args.jsonl so tests can
// check which configuration a run used; $CODEX_HOME/fake-touch names a file that
// `login --device-auth` overwrites.
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? '';
const mode = existsSync(join(home, 'fake-mode')) ? readFileSync(join(home, 'fake-mode'), 'utf8').trim() : 'success';
const out = line => process.stdout.write(`${JSON.stringify(line)}\n`);
// `-c key=value` may come before the subcommand (global) or after it.
const overrides = [];
const args = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-c') { overrides.push(argv[i + 1]); if (args[0] !== 'exec') { i += 1; continue; } }
  args.push(argv[i]);
}
const off = key => overrides.includes(`${key}=false`);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-simulated'); process.exit(0); }
if (args[0] === 'login' && args[1] === '--device-auth') {
  console.log('Follow these steps to sign in with ChatGPT using device code authorization (simulated)');
  rmSync(join(home, 'fake-logged-out'), { force: true });
  writeFileSync(join(home, 'auth.json'), '{"simulated":true}');
  // Test hook: simulate something else modifying a file during the login.
  if (existsSync(join(home, 'fake-touch'))) writeFileSync(readFileSync(join(home, 'fake-touch'), 'utf8').trim(), `touched ${Date.now()}`);
  process.exit(0);
}
if (args[0] === 'login') { process.exit(existsSync(join(home, 'fake-logged-out')) ? 1 : 0); }
if (args[0] === 'features' && args[1] === 'list') {
  for (const name of ['plugins', 'apps', 'computer_use', 'hooks', 'multi_agent', 'shell_tool']) console.log(`${name.padEnd(40)} stable             ${off(`features.${name}`) ? 'false' : 'true'}`);
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  const servers = existsSync(join(home, 'fake-mcp.json')) ? JSON.parse(readFileSync(join(home, 'fake-mcp.json'), 'utf8')) : [];
  const listed = servers.filter(server => !(server.plugin && off('features.plugins')))
    .map(server => ({ name: server.name, enabled: server.enabled && (server.stubborn || !off(`mcp_servers.${server.name}.enabled`)), transport: { type: 'stdio' } }));
  console.log(JSON.stringify(listed));
  process.exit(0);
}
if (args[0] === 'debug') {
  console.log(JSON.stringify([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: mode === 'personal' ? '# AGENTS.md instructions\n<INSTRUCTIONS>personal</INSTRUCTIONS>' : 'environment context' }] }]));
  process.exit(0);
}
if (args[0] !== 'exec') process.exit(2);
appendFileSync(join(home, 'fake-exec-args.jsonl'), `${JSON.stringify(argv)}\n`);
const value = flag => args[args.indexOf(flag) + 1];
const outputFile = value('-o'), workdir = value('-C'), schema = readFileSync(value('--output-schema'), 'utf8');
const withMemory = !args.includes('--ignore-user-config');
let prompt = ''; process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', async () => {
  out({ type: 'thread.started', thread_id: 'simulated-thread' });
  out({ type: 'turn.started' });
  if (schema.includes('can_do')) {
    // Profile request at registration: the agent introduces itself.
    if (mode === 'profile-fail') { out({ type: 'turn.failed', error: { message: 'simulated profile error' } }); process.exit(1); }
    const profile = {
      name: withMemory ? '模拟 Agent（带记忆）' : '模拟 Agent',
      intro: `我是一个模拟的 Codex Agent（${withMemory ? '带着主人的全局指令与记忆' : '不带个人记忆'}），在只读沙箱中根据对方提供的资料写报告。提示词长度 ${prompt.length}。`,
      can_do: [{ title: '资料调研报告', description: '阅读你提供的公开资料，写一页中文调研报告并列出来源。' }, { title: '文档审阅', description: '审阅你提供的文档，指出问题并给出修改建议。' }],
      seeking: ['需要基于资料做比较分析的任务'],
    };
    writeFileSync(outputFile, JSON.stringify(profile));
    out({ type: 'turn.completed', usage: { input_tokens: 400, cached_input_tokens: 0, output_tokens: 120 } });
    process.exit(0);
  }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode.startsWith('slow')) await new Promise(resolve => setTimeout(resolve, Number(mode.split(':')[1] ?? 1500)));
  if (mode === 'fail') { out({ type: 'turn.failed', error: { message: 'simulated model error' } }); process.exit(1); }
  const files = readdirSync(join(workdir, 'materials'));
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: `cat materials/${files.join(' materials/')}`, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat', exit_code: 0, status: 'completed' } });
  const model = args.includes('-m') ? value('-m') : 'default';
  const previous = existsSync(join(workdir, 'previous-report.md'));
  const feedback = prompt.split('\n').find((line, index, lines) => lines[index - 1]?.includes('修改意见')) ?? '';
  const result = { report_markdown: `# 模拟报告\n\n本报告由模拟 Codex 生成（模型 ${model}），提示词长度 ${prompt.length}。${previous ? `\n\n已读取上一版报告，按意见修改：${feedback}` : ''}\n\n| 资料 | 字节 |\n|---|---|\n${files.map(f => `| ${f} | ${readFileSync(join(workdir, 'materials', f)).length} |`).join('\n')}\n`, sources: files.map(f => ({ title: f, locator: `materials/${f}` })) };
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: JSON.stringify(result) } });
  writeFileSync(outputFile, JSON.stringify(result));
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 300 } });
  process.exit(0);
});
