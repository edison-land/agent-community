import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Codex CLI adapter for the member connector (RFC 0007). Runs `codex exec` in
 * non-interactive JSON mode, one ephemeral session per execution, read-only
 * sandbox, working directory containing only the approved materials. The task
 * text goes through stdin, never through a shell. Codex CLI is not treated as
 * an A2A server; the community gateway is.
 */
export const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['report_markdown', 'sources'],
  properties: {
    report_markdown: { type: 'string' },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'locator'], properties: { title: { type: 'string' }, locator: { type: 'string' } } } },
  },
};
/**
 * Profile the agent writes about itself when it joins (RFC 0009): who it is,
 * what it can do (becomes Capabilities after the owner reviews them), and what
 * work it is looking for. Structured-output schemas need every field required.
 */
export const PROFILE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'intro', 'can_do', 'seeking'],
  properties: {
    name: { type: 'string' },
    intro: { type: 'string' },
    can_do: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'description'], properties: { title: { type: 'string' }, description: { type: 'string' } } } },
    seeking: { type: 'array', items: { type: 'string' } },
  },
};
export const PERSONAL_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
export const ISOLATED_HOME = join(homedir(), '.agent-community', 'codex-home');
/** Memory mode chosen by the owner ↔ the isolation label recorded on the binding. */
export const MEMORY_MODES = { 'with-memory': 'personal-codex-home', 'without-memory': 'isolated-codex-home' };
export const sameDir = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };

// Features that act outside the read-only sandbox or on the owner's other
// accounts. Only names this Codex version knows are overridden.
const LOCKED_FEATURES = ['plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'hooks', 'image_generation', 'multi_agent',
  'in_app_browser', 'in_app_local_automation', 'remote_plugin', 'skill_mcp_dependency_install'];

export function codexEnv(codexHome) {
  // Only what Codex needs; no inherited tokens or unrelated secrets.
  // Proxy and CA settings are kept so Codex can reach its model provider where the network requires them.
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return { ...Object.fromEntries(keep.filter(key => process.env[key]).map(key => [key, process.env[key]])), CODEX_HOME: codexHome, NO_COLOR: '1' };
}

/**
 * With memory, Codex runs on the owner's own CODEX_HOME and configuration
 * (global instructions, skills, memories, model provider), but every tool that
 * could act beyond the read-only sandbox is switched off for this run: MCP
 * servers, plugins, apps, browser and computer use, hooks and notify, and
 * approvals can never escalate. Throws when that cannot be guaranteed.
 */
export function personalLockdown({ codexBin = 'codex', codexHome }) {
  const env = codexEnv(codexHome);
  const features = spawnSync(codexBin, ['features', 'list'], { env, encoding: 'utf8', timeout: 20000 });
  if (features.status !== 0) throw Object.assign(new Error('CODEX_FEATURES_UNAVAILABLE'), { code: 'CODEX_FEATURES_UNAVAILABLE' });
  const known = new Set(features.stdout.split('\n').map(line => line.trim().split(/\s+/u)[0]).filter(Boolean));
  const args = ['-c', 'approval_policy="never"', '-c', 'notify=[]', ...LOCKED_FEATURES.filter(name => known.has(name)).flatMap(name => ['-c', `features.${name}=false`])];
  const enabledServers = extra => {
    const listed = spawnSync(codexBin, [...args, ...extra, 'mcp', 'list', '--json'], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    if (listed.status !== 0) throw Object.assign(new Error('CODEX_MCP_LIST_FAILED'), { code: 'CODEX_MCP_LIST_FAILED' });
    try { return JSON.parse(listed.stdout).filter(server => server.enabled).map(server => String(server.name)); }
    catch { throw Object.assign(new Error('CODEX_MCP_LIST_FAILED'), { code: 'CODEX_MCP_LIST_FAILED' }); }
  };
  for (const name of enabledServers([])) {
    if (!/^[A-Za-z0-9_]{1,64}$/u.test(name)) throw Object.assign(new Error('MCP_SERVER_NOT_DISABLEABLE'), { code: 'MCP_SERVER_NOT_DISABLEABLE', server: name });
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  if (enabledServers([]).length) throw Object.assign(new Error('MCP_TOOLS_NOT_DISABLED'), { code: 'MCP_TOOLS_NOT_DISABLED' });
  return args;
}

export function baseArgs({ workdir, model, outputFile, schemaFile, isolation = 'isolated-codex-home', lockdown = [] }) {
  const config = isolation === 'isolated-codex-home' ? ['--ignore-user-config'] : lockdown;
  return ['exec', '--json', '--ephemeral', ...config, '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'web_search="disabled"', '-C', workdir, '-o', outputFile, '--output-schema', schemaFile, ...(model ? ['-m', model] : []), '-'];
}
const execArgs = ({ codexBin, codexHome, isolation, ...rest }) =>
  baseArgs({ ...rest, isolation, lockdown: isolation === 'isolated-codex-home' ? [] : personalLockdown({ codexBin, codexHome }) });

/**
 * Preflight run at registration: CLI version, login state in the
 * chosen CODEX_HOME, and whether personal instructions would enter the prompt
 * (rendered with `codex debug prompt-input`, no model call).
 */
export function preflight({ codexBin = 'codex', codexHome, memory = 'without-memory' }) {
  if (!MEMORY_MODES[memory]) return { ok: false, reason: 'INVALID_MEMORY_MODE' };
  const env = codexEnv(codexHome);
  const version = spawnSync(codexBin, ['--version'], { env, encoding: 'utf8', timeout: 20000 });
  if (version.status !== 0) return { ok: false, reason: 'CODEX_NOT_FOUND' };
  const login = spawnSync(codexBin, ['login', 'status'], { env, encoding: 'utf8', timeout: 20000 });
  if (login.status !== 0) return { ok: false, reason: 'CODEX_NOT_LOGGED_IN', runtimeVersion: version.stdout.trim() };
  const empty = mkdtempSync(join(tmpdir(), 'community-preflight-'));
  let prompt;
  try {
    const rendered = spawnSync(codexBin, ['debug', 'prompt-input', '-c', 'web_search="disabled"', 'preflight'], { env, cwd: empty, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    prompt = rendered.status === 0 ? rendered.stdout : null;
  } finally { rmSync(empty, { recursive: true, force: true }); }
  const personalInstructions = prompt === null ? null : prompt.includes('# AGENTS.md instructions');
  const runtimeVersion = version.stdout.trim().slice(0, 200);
  if (memory === 'with-memory') {
    // The owner's own Codex, with the tool lockdown verified before registering.
    try { personalLockdown({ codexBin, codexHome }); } catch (error) { return { ok: false, reason: error.code, runtimeVersion }; }
    return { ok: true, runtimeVersion, isolation: 'personal-codex-home', personalInstructions };
  }
  if (sameDir(codexHome, PERSONAL_HOME) || personalInstructions !== false) {
    return { ok: false, reason: personalInstructions ? 'PERSONAL_INSTRUCTIONS_WOULD_LOAD' : 'PERSONAL_CODEX_HOME', runtimeVersion };
  }
  return { ok: true, runtimeVersion, isolation: 'isolated-codex-home', personalInstructions };
}

/**
 * Digest of the owner's everyday Codex state. `connector login` compares it
 * before and after signing in to the separate CODEX_HOME, so the owner can see
 * that their own login, instructions, skills and memories were not touched.
 */
export function codexStateDigest(home, { codexBin = 'codex' } = {}) {
  const file = name => { const path = join(home, name); return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null; };
  const tree = name => { const path = join(home, name); return existsSync(path) ? createHash('sha256').update(listTree(path).join('\n')).digest('hex') : null; };
  const status = spawnSync(codexBin, ['login', 'status'], { env: codexEnv(home), encoding: 'utf8', timeout: 20000 });
  return { 'auth.json': file('auth.json'), 'config.toml': file('config.toml'), 'AGENTS.md': file('AGENTS.md'), skills: tree('skills'), memories: tree('memories'), loggedIn: status.status === 0 };
}
function listTree(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(`${rel}/`, ...listTree(join(dir, entry.name), `${rel}/`));
    else { const info = statSync(join(dir, entry.name)); out.push(`${rel} ${info.size} ${info.mtimeMs}`); }
  }
  return out;
}

export function profilePrompt({ memory }) {
  return [
    '你正在加入一个 Agent 协作网络（Agent Network）。请用第一人称、中文，为自己写一份公开档案，回答三个问题：',
    '1. 你是谁：你是什么样的 Agent，擅长的领域和工作方式，以及你的限制。',
    '2. 你能做什么：1 到 5 项别人可以请你做的具体工作。每项写一个简短标题和一段说明，说明里写清楚你需要对方提供什么、会交付什么。',
    '3. 你在找什么：你希望接到什么样的任务或合作，0 到 5 条。',
    '',
    '你在网络中接单时的真实工作条件（请据此如实描述，不要夸大）：每一单都要主人逐单确认；你在只读沙箱中运行，不能联网搜索，不能修改文件，也不能使用任何外部工具或账号；你只能阅读对方随订单提供的资料，最后交付一份 Markdown 报告（可以含表格和代码片段）。',
    memory === 'with-memory'
      ? '你带着主人的全局指令和记忆，可以据此概括你熟悉的领域；但档案会公开给网络中的其他成员，只写能力层面的概括。'
      : '你不带主人的个人指令和记忆，请只根据你作为通用模型的能力来写。',
    '隐私规则：不要写入真实姓名、邮箱、账号、密钥、文件路径、机器信息、未公开的项目名称，或记忆中的任何具体内容。档案会先交给主人审核修改，再公开。',
    '',
    'name 为一个简短的 Agent 名字（不超过 30 个字）；intro 不超过 300 字；can_do 每项标题不超过 30 字、说明不超过 200 字；seeking 每条不超过 100 字。',
  ].join('\n');
}

/**
 * Asks the same Codex that will do the work (same CODEX_HOME, same memory
 * mode, same restrictions) to describe itself. The owner edits the draft on the
 * claim page before anything is published.
 */
export function generateProfile({ codexBin = 'codex', codexHome, isolation, model, memory, timeoutMs = 240000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'community-profile-'));
  const work = join(dir, 'work'), schemaFile = join(dir, 'profile.schema.json'), outputFile = join(dir, 'profile.json');
  mkdirSync(work);
  writeFileSync(schemaFile, JSON.stringify(PROFILE_SCHEMA));
  return new Promise(resolve => {
    let args;
    try { args = execArgs({ codexBin, codexHome, isolation, workdir: work, model, outputFile, schemaFile }); }
    catch (error) { rmSync(dir, { recursive: true, force: true }); return resolve({ ok: false, reason: error.code ?? 'PROFILE_GENERATION_FAILED' }); }
    const child = spawn(codexBin, args, { env: codexEnv(codexHome), cwd: work, stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    child.stdin.end(profilePrompt({ memory }));
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const finish = result => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); resolve(result); };
    child.on('error', () => finish({ ok: false, reason: 'SPAWN_FAILED' }));
    child.on('close', code => {
      if (code !== 0) return finish({ ok: false, reason: code === null ? 'PROFILE_TIMEOUT' : `CODEX_EXIT_${code}`, message: stderr.trim().split('\n').at(-1)?.slice(0, 300) });
      try { finish({ ok: true, profile: normalizeProfile(JSON.parse(readFileSync(outputFile, 'utf8'))) }); }
      catch { finish({ ok: false, reason: 'INVALID_PROFILE_OUTPUT' }); }
    });
  });
}

const clip = (value, max) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
/** Profile in the wire shape the node accepts (also used for --profile-file). */
export function normalizeProfile(input) {
  const canDo = (Array.isArray(input?.can_do ?? input?.canDo) ? input.can_do ?? input.canDo : [])
    .map(item => ({ title: clip(item?.title, 80), description: clip(item?.description, 600) })).filter(item => item.title && item.description).slice(0, 6);
  const profile = {
    name: clip(input?.name, 60), intro: clip(input?.intro, 1000),
    canDo, seeking: (Array.isArray(input?.seeking) ? input.seeking : []).map(item => clip(item, 300)).filter(Boolean).slice(0, 6),
  };
  if (!profile.intro || !profile.canDo.length) throw Object.assign(new Error('INVALID_PROFILE'), { code: 'INVALID_PROFILE' });
  return profile;
}

export function taskPrompt(task, { isolation = 'isolated-codex-home' } = {}) {
  const rules = isolation === 'isolated-codex-home'
    ? '规则：只使用当前工作目录 materials/ 下获准的资料；不访问网络；不读取工作目录以外的文件；不执行修改文件的命令。需要额外权限时直接说明，不要尝试绕过。'
    : '规则：以当前工作目录 materials/ 下获准的资料为依据；可以按你的全局指令参考主人的记忆作为背景，但交付给需求方的报告里不得出现主人的私人信息（姓名、账号、未公开项目、记忆原文、文件路径）；不访问网络；不执行修改文件的命令。需要额外权限时直接说明，不要尝试绕过。';
  const lines = [
    '你在执行 Agent Network 中一次已由 Agent 主人逐单确认的任务。',
    rules,
    '', `需求：${task.request.title}`, '', task.request.description, '', '验收标准：', ...task.request.acceptanceCriteria.map(item => `- ${item}`),
    '', '获准资料：', ...task.materials.map(item => `- materials/${item.path.split('/').pop()}（${item.title}，sha256 ${item.sha256.slice(0, 12)}…）`),
    ...(task.revision ? ['', `这是第 ${task.revision.round} 轮。上一版报告在 previous-report.md（sha256 ${task.revision.previousSha256.slice(0, 12)}…）。需求方的修改意见：`, task.revision.feedback, '请在上一版基础上按意见修改，并保持来源可追溯。'] : []),
    '', '输出：按给定 JSON Schema 返回。report_markdown 为交付给需求方的中文 Markdown 报告（按需求的篇幅，可含表格）；sources 列出实际引用的资料，title 为资料标题，locator 为 materials/ 路径或资料中给出的原始链接；没有引用资料时返回空数组。',
  ];
  return lines.join('\n');
}

export function prepareWorkdir(dir, task) {
  const work = join(dir, 'work');
  mkdirSync(join(work, 'materials'), { recursive: true });
  for (const item of task.materials) {
    const bytes = Buffer.from(item.content, 'utf8');
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('MATERIAL_HASH_MISMATCH');
    writeFileSync(join(work, 'materials', item.path.split('/').pop()), bytes);
  }
  if (task.revision) {
    const previous = Buffer.from(task.revision.previousReport, 'utf8');
    if (createHash('sha256').update(previous).digest('hex') !== task.revision.previousSha256) throw new Error('PREVIOUS_REPORT_HASH_MISMATCH');
    writeFileSync(join(work, 'previous-report.md'), previous);
  }
  const schemaFile = join(dir, 'report.schema.json');
  writeFileSync(schemaFile, JSON.stringify(REPORT_SCHEMA));
  return { work, schemaFile, outputFile: join(dir, 'result.json'), eventsFile: join(dir, 'events.jsonl') };
}

/** Human-readable progress from Codex JSONL events; full events stay local. */
export function describeEvent(event) {
  const item = event.item;
  if (event.type === 'turn.started') return '模型开始处理';
  if (event.type === 'item.started' && item?.type === 'command_execution') return `只读命令：${String(item.command ?? '').slice(0, 160)}`;
  if (event.type === 'item.completed' && item?.type === 'reasoning') return '推理中';
  if (event.type === 'item.completed' && item?.type === 'agent_message') return '已生成报告草稿';
  if (event.type === 'turn.failed' || event.type === 'error') return `运行错误：${String(event.error?.message ?? event.message ?? '').slice(0, 200)}`;
  return null;
}

/**
 * Starts one execution. Returns a handle with `done` (resolves to the outcome)
 * and `stop(reason)`. The child runs in its own process group so a stop also
 * ends anything Codex spawned.
 */
export function runCodex({ codexBin = 'codex', codexHome, isolation = 'isolated-codex-home', model, task, dir, onProgress = () => {} }) {
  const files = prepareWorkdir(dir, task);
  const child = spawn(codexBin, execArgs({ codexBin, codexHome, isolation, workdir: files.work, model, outputFile: files.outputFile, schemaFile: files.schemaFile }), {
    env: codexEnv(codexHome), cwd: files.work, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  child.stdin.end(taskPrompt(task, { isolation }));
  let usage = null, stderr = '', stopReason = null, buffer = '', lastError = null;
  const events = [];
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      events.push(line);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'turn.completed' && event.usage) usage = { inputTokens: event.usage.input_tokens ?? 0, cachedInputTokens: event.usage.cached_input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 };
      if (event.type === 'turn.failed' || event.type === 'error') lastError = String(event.error?.message ?? event.message ?? 'error').slice(0, 300);
      const text = describeEvent(event);
      if (text) onProgress(text);
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const timer = setTimeout(() => stop('TIMEOUT'), task.grant.timeLimitSeconds * 1000);
  function stop(reason) {
    if (stopReason || child.exitCode !== null) return;
    stopReason = reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  }
  const done = new Promise(resolve => {
    child.on('close', code => {
      clearTimeout(timer);
      writeFileSync(files.eventsFile, events.join('\n'));
      if (stopReason === 'TIMEOUT') return resolve({ outcome: 'failed', code: 'TIMEOUT', message: `超过 ${task.grant.timeLimitSeconds} 秒时限，已停止 Codex CLI`, usage });
      if (stopReason) return resolve({ outcome: 'cancelled', code: stopReason, message: '已按请求停止 Codex CLI', usage });
      if (code !== 0) return resolve({ outcome: 'failed', code: `CODEX_EXIT_${code}`, message: (lastError ?? stderr.trim().split('\n').at(-1) ?? 'Codex CLI failed').slice(0, 300), usage });
      const result = readResult(files.outputFile);
      if (!result) return resolve({ outcome: 'failed', code: 'INVALID_OUTPUT', message: 'Codex 输出不符合报告格式', usage });
      resolve({ outcome: 'succeeded', report: renderReport(task, result), usage });
    });
    child.on('error', error => { clearTimeout(timer); resolve({ outcome: 'failed', code: 'SPAWN_FAILED', message: error.code ?? 'spawn failed', usage }); });
  });
  return { pid: child.pid, done, stop, files };
}

export function readResult(file) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value.report_markdown !== 'string' || !value.report_markdown.trim() || !Array.isArray(value.sources)) return null;
    if (!value.sources.every(source => typeof source?.title === 'string' && typeof source?.locator === 'string')) return null;
    return value;
  } catch { return null; }
}

export function renderReport(task, result) {
  const sources = result.sources.length ? result.sources.map(source => `- ${source.title}：${source.locator}`).join('\n') : '- （报告未列出来源）';
  return `${result.report_markdown.trim()}\n\n## 来源\n\n${sources}\n\n---\n由成员自己的 Codex CLI 生成；资料范围：${task.materials.map(item => item.path).join('、') || '无附加资料'}。本报告在需求方验收前不代表已被接受。\n`;
}
