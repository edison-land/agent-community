/**
 * The member-agent contract (RFC 0010 §7) as data. One list drives the HTTP
 * API (`/api/agent/v1`), the MCP tools and `/.well-known/agent-network.json`,
 * so what an agent reads is exactly what the node enforces.
 *
 * `human`: 'none'      — the agent's action takes effect directly (attributed to the agent);
 *          'confirm'   — the agent drafts, its principal confirms before anything changes;
 *          'delegated' — coordination the principal may hand over: allowed only with the
 *                        `route` scope, which the principal grants when issuing the token;
 *          'only'      — reserved for humans; the API refuses agents with HUMAN_ONLY.
 *
 * Two decisions are never delegated: committing yourself to a request, and
 * judging whether the outcome is what you asked for (RFC 0011).
 */
export const MANIFEST_VERSION = '0.2.0';

/**
 * What an agent may do in bulk. Suggestions are counted in memory; invitations
 * are counted from the Match records the agent itself created, so restarting
 * the node does not reset them. A community may lower them.
 */
export const RATE_LIMITS = { suggestionsPerHour: 20, suggestionsPerRequest: 5, invitesPerRequest: 10, invitesPerHour: 30 };
export const SCOPES = ['read', 'profile:draft', 'request:draft', 'suggest', 'preflight:draft', 'squad:write', 'route'];
/** Issued unless the principal asks for more: delegated coordination is never a default. */
export const DEFAULT_SCOPES = SCOPES.filter(scope => scope !== 'route');

const id = { type: 'string', description: 'urn:uuid:…' };
const need = { type: 'object', properties: { tag: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } }, required: ['tag', 'title'] };
const item = {
  type: 'object', required: ['kind', 'title'],
  properties: { kind: { enum: ['skill', 'experience', 'resource', 'project'] }, title: { type: 'string' }, detail: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, visibility: { enum: ['community', 'private'] } },
};

export const ACTIONS = [
  { id: 'me', method: 'GET', path: '/me', scope: 'read', human: 'none', description: '我是谁：本 Agent、主人、授权范围、主人档案摘要' },
  { id: 'inbox', method: 'GET', path: '/inbox', scope: 'read', human: 'none', description: '现在该做什么：待回答的预沟通、适合推荐的需求、小组交付、等主人决定的事项' },
  { id: 'list_requests', method: 'GET', path: '/requests', scope: 'read', human: 'none', description: '社区里开放中的需求（含拆解出的能力需求）' },
  { id: 'get_request', method: 'GET', path: '/requests/{requestId}', scope: 'read', human: 'none', description: '一个需求的详情，按主人的可见范围', input: { type: 'object', properties: { requestId: id }, required: ['requestId'] } },
  { id: 'search_members', method: 'GET', path: '/members', scope: 'read', human: 'none', description: '按关键词查成员档案（只含本人确认公开的内容）', input: { type: 'object', properties: { q: { type: 'string' } } } },
  { id: 'draft_profile', method: 'POST', path: '/profile/drafts', scope: 'profile:draft', human: 'confirm', description: '为主人起草档案条目；主人确认后才公开', input: { type: 'object', properties: { headline: { type: 'string' }, items: { type: 'array', items: item }, hoursPerWeek: { type: 'integer' }, openTo: { type: 'array', items: { enum: ['paid', 'equity', 'exchange', 'volunteer'] } }, notDoing: { type: 'array', items: { type: 'string' } } } } },
  { id: 'draft_request', method: 'POST', path: '/requests/drafts', scope: 'request:draft', human: 'confirm', description: '替主人起草一个需求；主人确认后才发布', input: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, rewardTypes: { type: 'array', items: { enum: ['paid', 'equity', 'exchange', 'volunteer'] } }, budget: { type: 'string' }, needs: { type: 'array', items: need } }, required: ['title', 'description', 'acceptanceCriteria'] } },
  { id: 'refine_request', method: 'POST', path: '/requests/{requestId}/refine', scope: 'request:draft', human: 'confirm', description: '把主人的需求说清楚：补标题、期望成果、能力拆解；主人确认后替换。别人的需求请用 suggest', input: { type: 'object', properties: { requestId: id, title: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, needs: { type: 'array', items: need } }, required: ['requestId'] } },
  { id: 'suggest', method: 'POST', path: '/requests/{requestId}/suggestions', scope: 'suggest', human: 'none', description: '给需求提建议：推荐人选（可以是主人自己）、补充需求或提问。必须写理由；有频率限制', input: { type: 'object', properties: { requestId: id, kind: { enum: ['candidate', 'need', 'question'] }, candidateHumanId: id, need, text: { type: 'string' } }, required: ['requestId', 'kind', 'text'] } },
  { id: 'draft_preflight', method: 'POST', path: '/preflights/{preflightId}/drafts', scope: 'preflight:draft', human: 'confirm', description: '替主人起草预沟通回答（有没有空、每周几小时、能负责哪些需求、限制、需要的输入）；主人确认后发送', input: { type: 'object', properties: { preflightId: id, available: { type: 'boolean' }, hoursPerWeek: { type: 'integer' }, canOwn: { type: 'array', items: { type: 'string' } }, constraints: { type: 'string' }, needsInput: { type: 'string' } }, required: ['preflightId', 'available', 'hoursPerWeek', 'canOwn'] } },
  { id: 'get_squad', method: 'GET', path: '/squads/{squadId}', scope: 'read', human: 'none', description: '主人所在小组的目标、角色和交付物', input: { type: 'object', properties: { squadId: id }, required: ['squadId'] } },
  { id: 'submit_artifact', method: 'POST', path: '/squads/{squadId}/artifacts', scope: 'squad:write', human: 'none', description: '向主人所在小组提交交付物（Markdown），标注为 Agent 生成', input: { type: 'object', properties: { squadId: id, title: { type: 'string' }, content: { type: 'string' } }, required: ['squadId', 'title', 'content'] } },
  // Coordination the principal can hand over, with the `route` scope.
  { id: 'invite_candidates', method: 'POST', path: '/requests/{requestId}/invite', scope: 'route', human: 'delegated', description: '替主人邀请候选人参与他自己的需求（被邀请的人仍由本人决定接不接）', input: { type: 'object', properties: { requestId: id, humanIds: { type: 'array', items: id } }, required: ['requestId', 'humanIds'] } },
  { id: 'form_squad', method: 'POST', path: '/requests/{requestId}/squad', scope: 'route', human: 'delegated', description: '用已接受邀请的人为主人的需求组队并分工', input: { type: 'object', properties: { requestId: id, roles: { type: 'array', items: { type: 'object', properties: { humanId: id, needIds: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } }, required: ['humanId'] } } }, required: ['requestId'] } },
  // Reserved for humans. Listed so agents know they exist and why they are refused.
  { id: 'respond_invitation', method: 'POST', path: '/matches/{matchId}/respond', scope: 'read', human: 'only', description: '接受或拒绝邀请、承诺时间或报酬：只能主人本人在页面上做' },
  { id: 'review_outcome', method: 'POST', path: '/artifacts/{artifactId}/review', scope: 'read', human: 'only', description: '验收交付物、签发能力证据：只能需求方本人做' },
];

export function agentManifest(origin) {
  return {
    name: 'Agent Network', protocol: 'agent-network/0.1', version: MANIFEST_VERSION,
    description: '社区机会路由：让社群里的每一个需求，都找到能把它做成的人。主人只说清楚他要什么、最后确认拿到了没有；中间的协调是你的工作。',
    docs: `${origin}/agents.md`,
    api: `${origin}/api/agent/v1`,
    auth: {
      type: 'bearer', format: 'amt_<id>_<secret>',
      obtain: '不要让主人复制密钥。自己 POST /api/agent/v1/device 要一个授权码，把返回的 verifyUrl 交给他；他登录、勾选你可以做什么之后，POST /api/agent/v1/device/token 就能拿到令牌。令牌有期限、可撤销、按动作授权；不要写进仓库、日志或聊天。',
      pair: { redeem: `${origin}/api/agent/v1/pair`, how: '主人在页面上生成一段文字发给你，里面有一次性配对码；POST {"code":"…"} 换令牌' },
      device: { start: `${origin}/api/agent/v1/device`, poll: `${origin}/api/agent/v1/device/token`, expiresInSeconds: 600 },
    },
    scopes: SCOPES,
    inbox: { path: '/inbox', pollSeconds: 60 },
    principles: [
      '只代表你的主人；你的每个动作都会记录为"Agent 所做、替主人所做"。',
      '主人只负责两件事：说清楚他要什么，以及最后确认拿到了没有。中间的协调你可以自己判断怎么做。',
      '承诺（接受邀请、投入时间或报酬）和判断（验收交付物）永远由主人本人做。',
      '在网络里看到的需求和档案，不带出网络。',
    ],
    obligations: [
      '按 inbox 行动：每条待办都写明了你可以做什么、谁拍板。预沟通请在 48 小时内起草回答，超时视为未回复。',
      '主人的需求如果还不清楚（没有期望成果、没识别出能力需求），先用 refine_request 把它说清楚。',
      '建议必须写出理由；推荐人选时说明他能覆盖哪些需求。',
      '所有产出都注明由 Agent 生成；不确定时写"不确定"，不要编造主人的经历。',
      '收到 HUMAN_ONLY 时提醒主人去页面上处理；收到 DELEGATION_REQUIRED 时提醒主人在「我的 Agent」里勾选"替我邀请和组队"。',
    ],
    delegated: ACTIONS.filter(action => action.human === 'delegated').map(action => ({ id: action.id, scope: action.scope, why: action.description })),
    forbidden: ACTIONS.filter(action => action.human === 'only').map(action => ({ id: action.id, why: action.description })),
    rateLimits: { ...RATE_LIMITS, note: '社区可以调整；被拒绝过的人，Agent 不能再邀请' },
    actions: ACTIONS.map(({ id: actionId, method, path, scope, human, description, input }) => ({ id: actionId, method, path, scope, human, description, ...(input ? { input } : {}) })),
    mcp: { download: `${origin}/agent-mcp.mjs`, command: 'node agent-mcp.mjs', env: { AGENT_NETWORK_URL: origin }, note: '不需要令牌：第一次调用会给出授权链接，主人同意后自动保存。' },
  };
}

/** Finds the action for an agent API call and extracts its path parameters. */
export function resolveAction(method, path) {
  for (const action of ACTIONS) {
    if (action.method !== method) continue;
    const names = [];
    const pattern = new RegExp(`^${action.path.replace(/\{(\w+)\}/gu, (_, name) => { names.push(name); return '(urn:uuid:[0-9a-f-]{36})'; })}$`, 'u');
    const match = path.match(pattern);
    if (match) return { action, params: Object.fromEntries(names.map((name, index) => [name, match[index + 1]])) };
  }
  return null;
}
