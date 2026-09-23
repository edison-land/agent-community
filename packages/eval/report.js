/** Renders an evaluation result as Markdown (Chinese, for people reading the run). */
const MARK = { pass: '通过', warn: '通过（有提醒）', fail: '未通过' };
const VERDICT = { pass: '通过', 'pass-with-warnings': '通过（有提醒）', fail: '未通过' };
const cell = value => String(value ?? '').replace(/\|/gu, '\\|').replace(/\n/gu, ' ');

export function renderReport(result) {
  const lines = [
    `# 端到端评估：${result.scenario.title}`, '',
    `- 结果：**${VERDICT[result.verdict] ?? result.verdict}**`,
    `- 场景：\`${result.scenario.id}\`${result.scenario.synthetic ? '（虚构数据）' : ''}`,
    `- 节点：${result.node}`,
    `- 开始：${result.startedAt}，用时 ${(result.ms / 1000).toFixed(1)} 秒`,
    `- 外部 Agent：${result.external.length ? result.external.join('、') : '无（全部为脚本化 Agent）'}`, '',
    '## 链路各阶段', '', '| 阶段 | 结果 | 用时 | 未通过的检查 |', '| --- | --- | --- | --- |',
    ...result.stages.map(stage => `| ${cell(stage.title)} | ${MARK[stage.status] ?? stage.status} | ${stage.ms} ms | ${cell(stage.error ?? stage.checks.filter(item => !item.ok).map(item => `${item.name}${item.detail ? `（${item.detail}）` : ''}`).join('；'))} |`),
    '', '## Agent 成绩单', '', '| 成员 | Agent | 类型 | 调用（成功/被拒） | 职责 | 被拒记录 | 结论 |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...result.agents.map(agent => `| ${cell(agent.displayName)} | ${cell(agent.agentName)} | ${agent.mode} | ${agent.ok}/${agent.denied} | ${cell(agent.duties.map(duty => `${duty.done ? '✓' : '✗'} ${duty.name}${duty.ms ? `（${duty.ms} ms）` : ''}`).join('；'))} | ${cell(agent.conduct.join('、') || '无')} | ${cell(agent.verdict)} |`),
    '', '## 各阶段检查明细', '',
  ];
  for (const stage of result.stages) {
    lines.push(`### ${stage.title}（${MARK[stage.status] ?? stage.status}）`, '');
    for (const item of stage.checks) lines.push(`- ${item.ok ? '✓' : item.soft ? '△' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    if (stage.error) lines.push(`- ✗ 错误：${stage.error}`);
    const metrics = Object.entries(stage.metrics ?? {});
    if (metrics.length) lines.push('', `指标：${metrics.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(', ') : value}`).join('；')}`);
    lines.push('');
  }
  lines.push('> 说明：场景和成员都是虚构的；人的操作（确认草稿、接受、验收）由脚本代替，除非运行时指定了由真人操作。Agent 成绩依据节点自己的审计日志，外部 Agent 与脚本化 Agent 按同一标准评估。');
  return `${lines.join('\n')}\n`;
}
