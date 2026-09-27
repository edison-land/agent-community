// SIMULATED end-to-end evaluation (RFC 0010, RFC 0011): the whole request →
// people → squad → evidence chain, with the requester's own agent running the
// middle of it, with an outside agent process joining over the node's stdio MCP
// server, and with an agent that never shows up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../packages/eval/runner.js';
import { renderReport } from '../packages/eval/report.js';

const scenario = JSON.parse(readFileSync(new URL('../examples/scenarios/kosx-recruitment.json', import.meta.url), 'utf8'));
const REFERENCE = fileURLToPath(new URL('../examples/agents/reference-agent.mjs', import.meta.url));
const byId = result => Object.fromEntries(result.stages.map(stage => [stage.id, stage]));

test('scripted agents: every stage of the chain passes and every agent gets the verdict its behaviour deserves', async () => {
  const result = await runScenario(scenario);
  const stages = byId(result);
  assert.equal(result.verdict, 'pass', renderReport(result));
  assert.deepEqual(Object.keys(stages), ['community', 'profiles', 'agents', 'intake', 'matching', 'suggestions', 'preflight', 'decisions', 'squad', 'delivery', 'review', 'learning', 'rules', 'dashboard']);
  assert.equal(stages.intake.metrics.needRecall, 1);
  assert.equal(stages.matching.metrics.recallAt5, 1);
  assert.ok(stages.learning.checks.every(item => item.ok), 'a proven member ranks first next time');
  const verdicts = Object.fromEntries(result.agents.map(agent => [agent.member, agent.verdict]));
  assert.deepEqual(verdicts, { mia: 'duties done', edison: 'duties done', alice: 'duties done', carol: 'duties done', dan: 'violations attempted, all refused', eve: 'inactive (expected)' });
  // The requester said what she wanted; her agent invited and formed the squad.
  const mia = result.agents.find(agent => agent.member === 'mia');
  assert.deepEqual(mia.duties.map(duty => duty.name), ['接入并读取待办', '替主人邀请候选人', '替主人组队']);
  assert.ok(mia.duties.every(duty => duty.done));
  assert.ok(stages.preflight.checks.some(item => item.name.includes('Agent 替他发出邀请') && item.ok));
  assert.ok(stages.rules.checks.some(item => item.name.includes('没有被授权代办') && item.ok));
  assert.ok(result.agents.find(agent => agent.member === 'dan').conduct.includes('respond_invitation:HUMAN_ONLY'));
  const report = renderReport(result);
  assert.match(report, /## Agent 成绩单/u);
  assert.match(report, /网络从这次合作中学习（通过）/u);
});

test('an outside agent process joins over MCP as Edison\'s agent and is scored like the scripted ones', async t => {
  let child = null;
  const result = await runScenario(scenario, {
    external: ['edison'], externalTimeoutMs: 20000,
    onExternalReady: info => {
      child = spawn(process.execPath, [REFERENCE], { env: { ...process.env, AGENT_NETWORK_URL: info.node, AGENT_NETWORK_TOKEN: info.token, AGENT_POLL_MS: '100' }, stdio: ['ignore', 'pipe', 'inherit'] });
      t.after(() => child.kill());
    },
  });
  const edison = result.agents.find(agent => agent.member === 'edison');
  assert.equal(result.verdict, 'pass', renderReport(result));
  assert.equal(edison.mode, 'external');
  assert.deepEqual(edison.duties.map(duty => [duty.name, duty.done]), [['接入并读取待办', true], ['起草预沟通回答', true], ['在小组里提交交付物', true]]);
  assert.equal(edison.denied, 0, 'the reference agent never tries human-only actions');
  assert.equal(byId(result).delivery.checks.find(item => item.name.includes('署名')).ok, true);
});

test('an outside agent that never connects fails the run at the step it was needed, and the report says so', async () => {
  const result = await runScenario(scenario, { external: ['alice'], externalTimeoutMs: 600 });
  const stages = byId(result);
  assert.equal(result.verdict, 'fail');
  assert.equal(stages.agents.status, 'fail');
  assert.ok(stages.agents.checks.some(item => !item.ok && item.name.includes('Alice')));
  assert.equal(stages.preflight.status, 'fail', 'nobody drafted Alice\'s pre-flight');
  assert.equal(result.agents.find(agent => agent.member === 'alice').verdict, 'duties missed');
  assert.match(renderReport(result), /Alice：外部 Agent 已接入/u);
});
