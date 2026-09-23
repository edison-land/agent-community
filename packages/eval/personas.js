/**
 * Scripted member agents for end-to-end evaluation. They use only the public
 * agent API (`/api/agent/v1`), exactly like an outside agent would, so the
 * evaluation exercises the same interface other people's agents connect to.
 *
 * responsive   — follows the inbox: drafts pre-flight answers from its principal's
 *                profile and delivers for squads its principal is responsible for.
 * connector    — responsive, plus recommends other members it was told about.
 * router       — the requester's own agent: makes the request clear, invites the
 *                candidates it was told about and forms the squad, so its principal
 *                only says what they want and later accepts the outcome (RFC 0011).
 * rule-breaker — tries things only humans may do, reads what it cannot see,
 *                skips reasons and spams; every attempt should be refused.
 * silent       — connects and does nothing (tests timeouts).
 */
export const PERSONAS = ['responsive', 'connector', 'router', 'rule-breaker', 'silent'];

export function startPersona({ persona, key, node, token, registry, config = {}, intervalMs = 400 }) {
  if (!PERSONAS.includes(persona)) throw new Error(`unknown persona ${persona}`);
  const stats = { persona, key, polls: 0, calls: [], attempts: {}, drafted: [], suggested: [], delivered: [], routed: [] };
  const done = new Set();
  let stopped = false, me = null, timer = null, running = Promise.resolve();

  async function call(method, path, body) {
    const response = await fetch(`${node}/api/agent/v1${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({}));
    stats.calls.push({ method, path, status: response.status, code: json.error });
    return { status: response.status, json };
  }
  async function attempt(name, expected, fn) {
    if (stats.attempts[name]) return;
    const { status, json } = await fn();
    stats.attempts[name] = { status, code: json.error ?? null, expected, refused: json.error === expected };
  }

  function answersFor(item) {
    const profile = me?.profile ?? { items: [], hoursPerWeek: 0, notDoing: [] };
    const owns = need => !profile.notDoing?.includes(need.tag) && profile.items.some(entry => entry.tags?.includes(need.tag));
    const canOwn = (item.needs ?? []).filter(owns).map(need => need.id);
    return {
      available: profile.hoursPerWeek > 0 && canOwn.length > 0, hoursPerWeek: Math.min(profile.hoursPerWeek ?? 0, 8), canOwn,
      ...(profile.notDoing?.length ? { constraints: `不负责：${profile.notDoing.join('、')}` } : {}),
      needsInput: '目标用户和现有数据的说明',
    };
  }

  async function tick() {
    if (persona === 'silent') { if (!me) me = (await call('GET', '/me')).json; return; }
    if (!me) me = (await call('GET', '/me')).json;
    const { json: inbox } = await call('GET', '/inbox');
    stats.polls += 1;
    for (const item of inbox.items ?? []) {
      const id = `${item.type}:${item.preflightId ?? item.squadId ?? item.requestId ?? ''}`;
      if (done.has(id)) continue;
      if (item.type === 'preflight.answer' && persona !== 'rule-breaker') {
        done.add(id);
        const { status } = await call('POST', `/preflights/${item.preflightId}/drafts`, { preflightId: item.preflightId, ...answersFor(item) });
        if (status === 200) stats.drafted.push({ preflightId: item.preflightId, at: Date.now() });
      }
      if (item.type === 'squad.deliver' && registry.deliverables.get(item.requestId) === key && persona !== 'rule-breaker') {
        done.add(id);
        const content = [`# ${me.principal.name} 负责部分的交付`, '', ...(item.acceptanceCriteria ?? []).map(line => `- [x] ${line}`), '', '本交付物由 Agent 根据主人的笔记整理，需求方验收前不代表已被接受。'].join('\n');
        const { status, json } = await call('POST', `/squads/${item.squadId}/artifacts`, { squadId: item.squadId, title: `${me.principal.name} 的交付：原型与数据方案`, content });
        if (status === 200) stats.delivered.push({ artifactId: json.id, at: Date.now() });
      }
      if (['opportunity.fit', 'request.suggest'].includes(item.type) && persona === 'connector' && registry.allowSuggestions) {
        for (const plan of config.suggest ?? []) {
          if (registry.requests.get(plan.request) !== item.requestId) continue;
          done.add(id);
          const candidateHumanId = registry.members.get(plan.candidate);
          const { status } = await call('POST', `/requests/${item.requestId}/suggestions`, { requestId: item.requestId, kind: 'candidate', candidateHumanId, text: plan.text });
          if (status === 200) stats.suggested.push({ requestId: item.requestId, candidate: plan.candidate, at: Date.now() });
        }
      }
      // The requester's own agent runs the middle of the chain, per request.
      if (persona === 'router' && registry.allowRouting) {
        for (const plan of config.route ?? []) {
          if (registry.requests.get(plan.request) !== item.requestId) continue;
          if (item.type === 'request.refine' && plan.refine) {
            done.add(id);
            const { status } = await call('POST', `/requests/${item.requestId}/refine`, { requestId: item.requestId, ...plan.refine });
            if (status === 200) stats.routed.push({ action: 'refine', request: plan.request, at: Date.now() });
          }
          if (item.type === 'request.invite' && plan.invite?.length) {
            done.add(id);
            const humanIds = plan.invite.map(member => registry.members.get(member)).filter(Boolean);
            const { status, json } = await call('POST', `/requests/${item.requestId}/invite`, { requestId: item.requestId, humanIds });
            if (status === 200) stats.routed.push({ action: 'invite', request: plan.request, count: json.invited.length, at: Date.now() });
          }
          // Not marked done: a squad can grow, so this runs again when someone accepts late.
          if (item.type === 'squad.form' && plan.squad !== false) {
            const { status, json } = await call('POST', `/requests/${item.requestId}/squad`, { requestId: item.requestId });
            if (status === 200) stats.routed.push({ action: 'squad', request: plan.request, squadId: json.id, at: Date.now() });
          }
        }
      }
      if (item.type === 'preflight.answer' && persona === 'rule-breaker') {
        await attempt('accept-invitation-for-principal', 'HUMAN_ONLY', () => call('POST', `/matches/${item.matchId}/respond`, { decision: 'accept' }));
        // Delegation is per principal: even an authorised agent cannot touch someone else's request.
        await attempt('invite-on-a-foreign-request', 'REQUESTER_ONLY', () => call('POST', `/requests/${item.requestId}/invite`, { humanIds: [me.principal.id] }));
        await attempt('suggest-without-reason', 'REASON_REQUIRED', () => call('POST', `/requests/${item.requestId}/suggestions`, { requestId: item.requestId, kind: 'question', text: 'ok' }));
        if (!stats.attempts['suggestion-spam']) {
          let last = null;
          for (let n = 1; n <= 6; n += 1) last = await call('POST', `/requests/${item.requestId}/suggestions`, { requestId: item.requestId, kind: 'question', text: `问题 ${n}：范围包括移动端吗？` });
          stats.attempts['suggestion-spam'] = { status: last.status, code: last.json.error ?? null, expected: 'RATE_LIMITED', refused: last.json.error === 'RATE_LIMITED' };
        }
      }
    }
    if (persona === 'rule-breaker') {
      for (const [requestKey, squadId] of registry.squads) {
        if (requestKey && !stats.attempts['read-foreign-squad']) await attempt('read-foreign-squad', 'NOT_VISIBLE', () => call('GET', `/squads/${squadId}`));
      }
      for (const artifactId of registry.artifacts) await attempt('review-as-principal', 'HUMAN_ONLY', () => call('POST', `/artifacts/${artifactId}/review`, { outcome: 'accepted', statement: '我替主人验收' }));
    }
  }

  const loop = () => {
    if (stopped) return;
    running = tick().catch(error => { stats.calls.push({ error: error.message }); }).finally(() => { if (!stopped) timer = setTimeout(loop, intervalMs); });
  };
  loop();
  return { stats, call, async stop() { stopped = true; clearTimeout(timer); await running; } };
}
