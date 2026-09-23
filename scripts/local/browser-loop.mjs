#!/usr/bin/env node
/**
 * Phase 5 browser check: two real browser sessions (member A, member B) drive
 * the node page end to end against a live node on :4320 and local FlareMo.
 * Playwright is NOT a dependency of this repository; point PLAYWRIGHT_MODULE
 * at an existing install (for example the FlareMo copy's node_modules).
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs [PLAYWRIGHT_CHANNEL=chrome] CODEX_MODE=fake|real \
 *     [CODEX_HOME_FOR_CONNECTOR=~/.agent-community/codex-home] [CONNECTOR_MODEL=gpt-5.4-mini] \
 *     [CONNECTOR_MODELS=gpt-5.4-mini,gpt-5.5] [SECOND_ROUND_MODEL=gpt-5.5] \
 *     node scripts/local/browser-loop.mjs <screenshot-dir>
 *
 * CODEX_MODE=fake uses the simulated Codex binary (UI check only);
 * CODEX_MODE=real runs the member's real Codex CLI (model usage on their account).
 * With SECOND_ROUND_MODEL set, A requests changes and B confirms a second round on that model.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localState } from '../../test/support/local.js';
import { liveNode, connectorHome, startProcess, registerViaCli, FAKE_CODEX_BIN } from '../../test/support/processes.js';

const out = process.argv[2] ?? 'browser-evidence';
mkdirSync(out, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const real = process.env.CODEX_MODE === 'real';
const state = localState();
const account = label => state.accounts.find(item => item.label === label);
const log = [];
const note = (step, detail = '') => { const line = `${new Date().toISOString()} ${step} ${detail}`; log.push(line); console.log(line); };

// Launch the browser first so a missing browser never leaves a node running.
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const node = await liveNode();
const c = connectorHome({ fakeMode: real ? undefined : 'slow' });
const codexHome = real ? (process.env.CODEX_HOME_FOR_CONNECTOR ?? '').replace(/^~/, process.env.HOME) : c.codexHome;
const codexBin = real ? 'codex' : FAKE_CODEX_BIN;
let connector;
const [ctxA, ctxB] = [await browser.newContext({ viewport: { width: 1180, height: 900 } }), await browser.newContext({ viewport: { width: 1180, height: 900 } })];
const [pageA, pageB] = [await ctxA.newPage(), await ctxB.newPage()];
for (const [name, page] of [['A', pageA], ['B', pageB]]) page.on('console', message => { if (message.type() === 'error') note(`console-${name}`, message.text()); });
try {
  const shot = async (page, name) => { await page.screenshot({ path: join(out, `${name}.png`), fullPage: true }); note('screenshot', name); };
  const login = async (page, label, url = node.url) => {
    await page.goto(url);
    await page.fill('#username', account(label).username);
    await page.fill('#password', account(label).password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
  };

  await login(pageA, 'member-a');
  await pageA.getByRole('button', { name: '创建', exact: true }).click();
  await pageA.waitForSelector('nav.tabs');
  note('A', 'signed in with real FlareMo account and created the community');
  // Joining is by invitation only: A issues a one-use link, B opens it, signs in and joins.
  await pageA.getByRole('button', { name: '生成邀请链接', exact: true }).click();
  const inviteUrl = (await pageA.locator('.notice + pre').first().textContent()).trim();
  note('A', `issued a one-use invitation link (${inviteUrl.replace(/[A-Z0-9]{4}$/u, '····')})`);
  await login(pageB, 'member-b', inviteUrl);
  if (!(await pageB.inputValue('#invite')).length) throw new Error('invite code was not prefilled from the link');
  await pageB.getByRole('button', { name: '加入社区', exact: true }).click();
  await pageB.waitForSelector('nav.tabs');
  await pageB.getByText('复制给你的 Agent').waitFor();
  await shot(pageB, '00-connect-agent');
  // The only connection path: the connector registers (the agent writes its own profile),
  // B opens the claim link, edits the profile and types the fingerprint tail.
  const registered = await registerViaCli(node, c.env, { codexBin: real ? null : codexBin, codexHome, model: process.env.CONNECTOR_MODEL ?? 'gpt-5.4-mini', models: (process.env.CONNECTOR_MODELS ?? '').split(',').filter(Boolean), name: real ? 'member-b real Codex connector' : 'member-b simulated connector' });
  note('connector', registered.stdout.trim().split('\n').join(' / ').replace(registered.fingerprint.slice(-4), '····'));
  await pageB.goto(registered.claimUrl);
  await pageB.getByRole('button', { name: '认领并发布' }).waitFor();
  await pageB.fill('#claim-agent-name', 'B 的调研 Agent');
  const drafted = await pageB.inputValue('#claim-agent-intro');
  await pageB.fill('#claim-agent-intro', `${drafted}（主人补充：只接公开资料任务。）`);
  await pageB.fill('#fingerprint-suffix', registered.fingerprint.slice(-4));
  await shot(pageB, '01-claim-page');
  await pageB.getByRole('button', { name: '认领并发布', exact: true }).click();
  await pageB.waitForSelector('text=主人修改过');
  note('B', 'claimed from the link; the agent-written profile was edited and published');
  // Later edits: add what the agent is looking for.
  await pageB.getByRole('button', { name: '编辑档案', exact: true }).click();
  const seeking = pageB.locator('textarea[id$="-seeking"]').first();
  await seeking.fill(`${await seeking.inputValue()}\n上线测试任务`.trim());
  await pageB.getByRole('button', { name: '保存', exact: true }).click();
  await pageB.locator('.profile li', { hasText: '上线测试任务' }).first().waitFor();
  await shot(pageB, '02-agent-profile');
  note('B', 'profile edited after publishing');
  connector = startProcess('apps/connector/cli.js', ['start', ...(real ? [] : ['--codex-bin', codexBin])], c.env);
  await connector.waitFor(/"event":"connected"/);

  await pageA.reload();
  await pageA.getByRole('button', { name: '能力目录', exact: true }).click();
  await pageA.getByRole('button', { name: '向它发布需求' }).first().waitFor();
  await shot(pageA, '03-discover');
  await pageA.getByRole('button', { name: '向它发布需求' }).first().click();
  if (!(await pageA.inputValue('input[name="title"]')).startsWith('上线测试任务')) throw new Error('the launch test task is not the default template');
  await shot(pageA, '03b-launch-test-request');
  await pageA.getByRole('button', { name: '发布需求', exact: true }).click();
  await pageA.waitForSelector('text=返回需求板');
  note('A', 'request published from the discovered capability');

  await pageB.getByRole('button', { name: '待我确认', exact: true }).click();
  await pageB.getByRole('button', { name: '确认并授权本次执行' }).first().waitFor();
  await shot(pageB, '04-confirmation-card');
  await pageB.getByRole('button', { name: '确认并授权本次执行' }).first().click();
  note('B', 'per-order confirmation given');

  await pageA.getByRole('button', { name: '验收通过' }).waitFor({ timeout: real ? 900000 : 60000 });
  await shot(pageA, '05-report-for-review');
  note('A', 'report visible for review');
  if (process.env.SECOND_ROUND_MODEL) {
    await pageA.locator('textarea').last().fill('请补充三种许可证在专利授权与专利报复条款上的差异，并说明对我们复用 FlareMo（AGPL）的具体影响。');
    await pageA.getByRole('button', { name: '要求修改', exact: true }).click();
    await pageA.getByText('等待 Agent 主人确认下一轮执行').waitFor();
    note('A', 'changes requested with feedback');
    await pageB.getByRole('button', { name: '待我确认', exact: true }).click();
    await pageB.getByText('第 2 轮修改').first().waitFor();
    await pageB.locator('select').last().selectOption(process.env.SECOND_ROUND_MODEL);
    await shot(pageB, '05b-round2-card-model-switched');
    await pageB.getByRole('button', { name: '确认并授权本次执行' }).first().click();
    note('B', `round 2 confirmed on ${process.env.SECOND_ROUND_MODEL}`);
    await pageA.getByText('第 2 轮执行').waitFor({ timeout: 60000 });
    await pageA.getByRole('button', { name: '验收通过' }).waitFor({ timeout: real ? 900000 : 60000 });
    await shot(pageA, '05c-round2-report');
    note('A', 'round 2 report visible');
  }
  await pageA.locator('textarea').last().fill('报告满足验收标准，来源可追溯。');
  await pageA.getByRole('button', { name: '验收通过', exact: true }).click();
  await pageA.waitForSelector('text=的验收：通过');
  await shot(pageA, '06-accepted');
  await pageA.getByRole('button', { name: '追溯', exact: true }).click();
  await pageA.waitForSelector('text=对象图校验');
  const graph = await pageA.textContent('.card .status');
  const counts = await pageA.locator('.card table').first().locator('tr').nth(1).locator('td').allTextContents();
  await shot(pageA, '07-trace');
  note('trace', `graph=${graph} counts=${counts.join(',')}`);
  if (graph !== '通过' || counts.length !== 8 || counts.some(value => Number(value) < 1)) throw new Error('trace incomplete');
  note('RESULT', `PASS (${real ? 'real Codex CLI' : 'simulated Codex binary'})`);
} catch (error) {
  note('RESULT', `FAIL ${error.message.split('\n')[0]}`);
  await pageA.screenshot({ path: join(out, 'failure-A.png'), fullPage: true }).catch(() => {});
  await pageB.screenshot({ path: join(out, 'failure-B.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'log.txt'), `${log.join('\n')}\n`);
  if (connector) { await connector.stop(); writeFileSync(join(out, 'connector.log'), `${connector.lines.join('\n')}\n`); }
  writeFileSync(join(out, 'node.log'), `${node.lines.join('\n')}\n`);
  await browser.close();
  await node.close();
  c.cleanup();
}
