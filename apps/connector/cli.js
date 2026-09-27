#!/usr/bin/env node
/**
 * Agent Network member connector for Codex CLI (RFC 0007, RFC 0009).
 *
 *   connector login                                  # without memory only: sign in to the separate CODEX_HOME;
 *                                                    # checks that your everyday Codex was not touched
 *   connector register --node https://… --memory with|without [--model gpt-5.4-mini] [--models a,b]
 *                      [--name "B's Mac"] [--profile-file profile.json] [--codex-home dir] [--no-wait]
 *        # the agent writes its own profile (who it is, what it can do, what it looks for),
 *        # then a claim link is printed; the owner opens it, types the last four fingerprint
 *        # characters shown here, and reviews/edits the profile before it is published
 *   connector start      # waits for the claim if needed, then dials out and runs approved orders
 *   connector status | rotate | stop | unbind
 *
 * with memory:    your own Codex (CODEX_HOME or ~/.codex): global instructions, skills, memories and
 *                 model provider; MCP servers, plugins, apps, browser/computer use and hooks are off
 *                 for community work; read-only sandbox; no web search.
 * without memory: a separate CODEX_HOME (~/.agent-community/codex-home) with its own login; none of
 *                 your instructions or memories load.
 * The connector never opens an inbound port and never reads or copies Codex credentials.
 */
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConnectorState } from '../../packages/connector/state.js';
import { Connector } from '../../packages/connector/runtime.js';
import { PERSONAL_HOME, ISOLATED_HOME, codexEnv, codexStateDigest, sameDir } from '../../packages/connector/codex.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  node: { type: 'string' }, model: { type: 'string', default: 'gpt-5.4-mini' }, models: { type: 'string' }, name: { type: 'string' },
  memory: { type: 'string', default: 'without' }, 'profile-file': { type: 'string' },
  'codex-home': { type: 'string' }, 'personal-codex-home': { type: 'string' }, 'codex-bin': { type: 'string' }, profile: { type: 'string', default: 'default' },
  'no-wait': { type: 'boolean', default: false },
} });
const state = new ConnectorState(values.profile);
const log = entry => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
const codexBin = values['codex-bin'] ?? 'codex';
const connector = new Connector({ state, codexBin, log });
const pidFile = join(state.dir, 'connector.pid');
const expand = path => resolve(path.replace(/^~(?=\/|$)/u, homedir()));
const memoryText = isolation => isolation === 'isolated-codex-home' ? '不带记忆（独立 CODEX_HOME，不加载你的个人指令和记忆）' : '带记忆（你自己的 Codex：全局指令、skills 和记忆；MCP 工具与插件已关闭）';

try {
  switch (positionals[0]) {
    case 'login': {
      // Without memory: the owner signs in to a separate CODEX_HOME themselves.
      const isolated = expand(values['codex-home'] ?? ISOLATED_HOME);
      const personal = expand(values['personal-codex-home'] ?? PERSONAL_HOME);
      if (sameDir(isolated, personal)) throw new Error('独立目录不能与你平时使用的 CODEX_HOME 相同');
      mkdirSync(isolated, { recursive: true, mode: 0o700 });
      const before = codexStateDigest(personal, { codexBin });
      console.log(`在独立目录登录 Codex：${isolated}`);
      console.log(`你平时使用的 Codex（${personal}）不会被修改；登录结束后会自动核对。`);
      const login = spawnSync(codexBin, ['login', '--device-auth'], { env: codexEnv(isolated), stdio: 'inherit' });
      const after = codexStateDigest(personal, { codexBin });
      const changed = Object.keys(before).filter(key => before[key] !== after[key]);
      const isolatedOk = spawnSync(codexBin, ['login', 'status'], { env: codexEnv(isolated), stdio: 'ignore' }).status === 0;
      console.log(isolatedOk ? '独立目录已登录。' : '独立目录尚未登录成功。');
      console.log(changed.length
        ? `警告：你平时使用的 Codex 有变化：${changed.join('、')}。如果这段时间你没有自己使用 Codex，请停止并检查。`
        : `已核对：你平时使用的 Codex 未变化（登录状态、auth.json、config.toml、AGENTS.md、skills、memories）${after.loggedIn ? '，并且仍处于登录状态' : ''}。`);
      log({ event: 'login-checked', isolatedLoggedIn: isolatedOk, personalUnchanged: !changed.length, changed });
      if (login.status !== 0 || !isolatedOk || changed.length) process.exitCode = 1;
      break;
    }
    case 'register': {
      if (!values.node) throw new Error('register needs --node');
      const memory = { with: 'with-memory', without: 'without-memory' }[values.memory];
      if (!memory) throw new Error('--memory must be "with" or "without"');
      const codexHome = expand(values['codex-home'] ?? (memory === 'with-memory' ? PERSONAL_HOME : ISOLATED_HOME));
      const profile = values['profile-file'] ? JSON.parse(readFileSync(expand(values['profile-file']), 'utf8')) : undefined;
      const result = await connector.register({
        node: values.node, name: values.name, codexHome, memory, model: values.model, profile,
        models: (values.models ?? '').split(',').map(item => item.trim()).filter(Boolean), onProgress: text => console.log(text),
      });
      const grouped = result.fingerprint.match(/.{4}/gu).join('-');
      console.log(`Agent 自我介绍草稿：${result.profile.name || '（未起名）'}；能做 ${result.profile.canDo.length} 项；在找 ${result.profile.seeking.length} 条。认领时可以逐项修改。`);
      console.log('已登记。请 Agent 的主人登录社区后打开认领链接：');
      console.log(`  ${result.claimUrl}`);
      console.log(`连接器指纹：${grouped}（认领页会要求输入最后 4 位：${result.fingerprint.slice(-4)}；只在这里显示）`);
      console.log(`有效期至 ${new Date(result.expiresAt).toLocaleString()} · Codex ${result.runtimeVersion} · 模式：${memoryText(result.isolation)}`);
      if (values['no-wait']) break;
      console.log('等待认领（最长 10 分钟）…');
      const final = await connector.waitForClaim();
      console.log(final.status === 'active' ? `已认领并绑定：${final.agentName}` : `未完成认领：${final.status}`);
      if (final.status !== 'active') process.exitCode = 1;
      break;
    }
    case 'rotate': {
      const result = await connector.rotate();
      console.log(`连接器密钥已更换（${result.rotatedAt}）；旧密钥立即失效。`);
      break;
    }
    case 'start': {
      if (!state.load()?.token) throw new Error('Not registered. Run register first.');
      const claim = await connector.waitForClaim();
      if (claim.status === 'awaiting-claim' || claim.status !== 'active') { log({ event: 'not-claimed', status: claim.status }); process.exitCode = 1; break; }
      writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
      const controller = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { log({ event: 'stopping' }); controller.abort(); setTimeout(() => process.exit(0), 8000).unref(); });
      log({ event: 'started', node: state.load().node, agentName: claim.agentName, memory: state.load().memory ?? state.load().isolation });
      const result = await connector.run({ signal: controller.signal });
      log({ event: 'exited', ...result });
      rmSync(pidFile, { force: true });
      if (result.stopped !== 'signal') process.exitCode = 3;
      break;
    }
    case 'status': {
      const config = state.load();
      if (!config) { console.log('未登记'); break; }
      let remote;
      try { remote = config.token ? await connector.binding() : { status: 'unbound-locally' }; } catch (error) { remote = { status: `unreachable-or-denied (${error.code})` }; }
      console.log(JSON.stringify({ node: config.node, bindingId: config.bindingId, deviceId: config.deviceId, memory: memoryText(config.isolation), model: config.model, models: config.models, runtimeVersion: config.runtimeVersion, binding: remote.status,
        running: existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null,
        receipts: state.receipts().map(r => ({ executionId: r.executionId, state: r.state, outcome: r.outcome, code: r.code, updatedAt: r.updatedAt })) }, null, 2));
      break;
    }
    case 'stop': {
      if (!existsSync(pidFile)) { console.log('没有运行中的连接器'); break; }
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM');
      console.log('已发送停止信号');
      break;
    }
    case 'unbind': {
      await connector.unbind();
      console.log('已解绑；平台上的绑定与授权已撤销。');
      break;
    }
    default:
      console.error('Usage: connector login|register|start|status|rotate|stop|unbind [options]');
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`connector: ${error.code ?? error.message}${error.detail ? ` (${error.detail})` : ''}`);
  process.exitCode = 1;
}
