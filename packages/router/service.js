import { randomBytes, randomUUID } from 'node:crypto';
import { CommunityError, CommunityService } from '../community/service.js';
import { claimCode, issueCredential, normalizeCode, parseCredential, sameDigest, sha256, uuidPart } from '../community/secrets.js';
import { DEFAULT_TAXONOMY, draftFromActivity, edgeKey, planSquad, rank, tagsIn, understand, validateTaxonomy } from './engine.js';
import { DEFAULT_SCOPES, RATE_LIMITS, SCOPES } from './manifest.js';

const fail = (code, status = 400) => { throw new CommunityError(code, status); };
const TAG = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const ITEM_ID = /^[a-z0-9-]{1,40}$/u;
const URN = /^urn:uuid:[0-9a-f-]{36}$/u;
const REWARDS = ['paid', 'equity', 'exchange', 'volunteer'];
const KINDS = ['skill', 'experience', 'resource', 'project'];
const str = (value, max, { required = false } = {}) => {
  if (value === undefined || value === null || value === '') { if (required) fail('INVALID_TEXT'); return undefined; }
  if (typeof value !== 'string' || value.trim().length > max) fail('INVALID_TEXT');
  const text = value.trim();
  if (required && !text) fail('INVALID_TEXT');
  return text;
};
const shortId = () => randomUUID().slice(0, 8);
const DAY = 24 * 3600 * 1000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_SECONDS = 3;
const PAIRING_TTL_MS = 10 * 60 * 1000;

/** What a member copies out of the page. Deliberately not any one vendor's command. */
export const pairingText = (origin, code) => [
  '# Agent Note：社区机会网络接入指南与操作指令',
  '',
  '请帮我接入社区机会网络（我是这个网络的成员，你将代表我行动）：',
  '',
  `1. 先读规范说明：${origin}/agents.md`,
  '2. 用下面这个一次性配对码换一个访问令牌：',
  `     POST ${origin}/api/agent/v1/pair`,
  `     {"code": "${code}"}`,
  '3. 之后带着返回的令牌（Authorization: Bearer …）调用：',
  `     HTTP  ${origin}/api/agent/v1/*`,
  `     MCP   ${origin}/mcp`,
  '4. 读一次 inbox，按里面写明的条目去行动。',
  '',
  '【核心原则】你可以起草需求、起草预沟通回答并整理交付物；但承诺（接受邀请）与验收永远只能由主人本人操作。',
  '【注意】配对码 10 分钟内有效，只能用一次；换到令牌后存入内存即可，不要写进任何文件或持久化记录。',
].join('\n');

/** Community member agreement. */
export const MEMBER_AGREEMENT = {
  version: 'member-agreement-0.1',
  title: '社区成员协议',
  points: [
    '网络会使用你本人在社区里的公开发言（例如群聊话题）为你起草档案，只用于档案和匹配。',
    '起草结果先只给你看，每条注明依据；你确认后才公开，任何一条都可以隐藏。',
    '群聊原文不进入网络，网络只保存你确认后的档案和来源编号。',
    '你可以随时撤回同意：起草的内容会从档案中删除，之后不再起草。',
    '你的 Agent 只能起草和建议；接受邀请、承诺时间或报酬、验收，只能由你本人做。',
  ],
};

export const PREFLIGHT_QUESTIONS = [
  { id: 'available', text: '这件事你有兴趣、有时间参与吗？' },
  { id: 'hours', text: '每周大概能投入多少小时？' },
  { id: 'own', text: '你能负责哪些需求？' },
  { id: 'constraints', text: '有什么限制或不做的部分？' },
  { id: 'input', text: '开始之前需要对方提供什么？' },
];

const DRAFT_TITLES = { profile: '确认档案条目', request: '确认新需求', preflight: '确认预沟通回答', refine: '确认需求的补充' };

const emptyProfile = () => ({ items: [], hoursPerWeek: 0, openTo: [], notDoing: [] });

/**
 * Opportunity routing (RFC 0010): request → need → match → suggestions →
 * pre-flight → human accept → squad → artifact → review → evidence.
 * Humans decide; agents draft into a confirmation queue, suggest, and deliver
 * inside squads. Every agent call is audited.
 */
export class RouterService {
  constructor({ service, kv, taxonomy = DEFAULT_TAXONOMY, activity = null, agreement = MEMBER_AGREEMENT, limits = {}, vocabulary = null, understander = null, clock = null }) {
    this.service = service; this.kv = kv; this.taxonomy = validateTaxonomy(taxonomy); this.activity = activity; this.agreement = agreement; this.clock = clock ?? (() => service.clock());
    // Optional: capability matching by meaning. Without it the keyword baseline runs, unchanged.
    this.vocabulary = vocabulary; this.vocabularyReady = null; this.understander = understander;
    this.limits = { ...RATE_LIMITS, ...limits };
    this.suggestionLog = new Map();
  }

  get s() { return this.service; }

  // ---------- capability vocabulary (embedding on write; ranking stays a tag intersection) ----------
  /** Loads the community's terms once, rebuilding the vector index from them. */
  async #vocab() {
    if (!this.vocabulary) return null;
    this.vocabularyReady ??= this.vocabulary.load(await this.kv.get('vocabulary:terms') ?? []).catch(error => { this.vocabularyReady = null; throw error; });
    await this.vocabularyReady;
    return this.vocabulary;
  }
  async #saveVocabulary() { if (this.vocabulary) await this.kv.put('vocabulary:terms', this.vocabulary.terms); }

  /**
   * Places each profile item in the community's vocabulary, so a member who
   * writes "香港猎头" and a request asking for "香港招聘" meet on the same term.
   * Keyword tags are kept alongside, so the baseline keeps working.
   */
  async alignProfileItems(items) {
    const vocabulary = await this.#vocab();
    if (!vocabulary) return items;
    const out = [];
    for (const item of items) {
      if (item.verified) { out.push(item); continue; }
      const aligned = await vocabulary.align(`${item.title}${item.detail ? ` ${item.detail}` : ''}`);
      out.push(aligned?.term ? { ...item, tags: [...new Set([aligned.term.tag, ...item.tags])].slice(0, 8) } : item);
    }
    await this.#saveVocabulary();
    return out;
  }

  /**
   * What capabilities is this request asking for?
   *
   * A model names them, each name is looked up in the community's own
   * vocabulary, and only terms someone actually claims survive — so a made-up
   * capability matches nobody instead of inventing a need. Three levels, each
   * catching the one above: model naming → matching the whole text → the
   * keyword baseline. A request is always publishable.
   *
   * All of it runs once, when the request is published. Reads never come here.
   */
  async understandNeeds(request) {
    const vocabulary = await this.#vocab();
    if (!vocabulary) return understand(request, this.taxonomy);
    const text = [request.title, request.description, ...(request.acceptanceCriteria ?? [])].filter(Boolean).join('\n');
    const found = new Map();
    const take = hits => { for (const hit of hits) if ((found.get(hit.term.tag)?.score ?? 0) < hit.score) found.set(hit.term.tag, hit); };
    const phrases = this.understander ? await this.understander.decompose(text) : [];
    for (const phrase of phrases) take(await vocabulary.match(phrase, { limit: 2 }));
    if (!found.size) take(await vocabulary.match(text, { limit: 6 }));
    if (!found.size) return understand(request, this.taxonomy);
    return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 6)
      .map(({ term, score }) => ({ id: term.tag, tag: term.tag, title: term.title, detail: `社区里有人做过类似的事（相似 ${score}）` }));
  }
  actor(human) { return CommunityService.actorOf(human); }

  async members() {
    const [humans, memberships] = await Promise.all([this.s.list('Human'), this.s.list('Membership')]);
    const active = new Set(memberships.filter(item => item.data.status === 'active').map(item => item.data.humanId));
    return humans.filter(human => human.lifecycle === 'active' && human.data.status === 'active' && active.has(human.id)).map(human => ({ human }));
  }
  async #human(humanId) { return (await this.s.activeMember(humanId)).human; }
  async #names() { return new Map((await this.s.list('Human')).map(human => [human.id, human.data.displayName])); }

  // ---------- member agreement and consent ----------
  async consentOf(humanId) {
    return (await this.s.list('Consent')).filter(item => item.data.humanId === humanId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async signConsent(humanId, { version } = {}) {
    const human = await this.#human(humanId);
    if (version !== this.agreement.version && version !== 'member-agreement-0.1-demo') fail('AGREEMENT_VERSION_MISMATCH', 409);
    const current = await this.consentOf(humanId);
    if (current?.data.status === 'active') return { consent: current, draft: null };
    const consent = this.s.create('Consent', { humanId, agreementVersion: version, scopes: ['profile-drafting-from-community-activity', 'matching'], status: 'active', signedAt: this.s.now() }, this.actor(human));
    await this.s.commit(`consent:${uuidPart(consent.id)}`, [consent]);
    // Drafting starts only after signing, and only from this member's own activity.
    let draft = null;
    const signals = this.activity ? await this.activity.signalsFor(human) : [];
    const items = draftFromActivity(signals, this.taxonomy);
    if (items.length) draft = await this.#queueDraft(humanId, { type: 'profile', origin: 'community', payload: { items } });
    return { consent, draft };
  }

  async withdrawConsent(humanId) {
    const human = await this.#human(humanId);
    const current = await this.consentOf(humanId);
    if (current?.data.status !== 'active') fail('NO_ACTIVE_CONSENT', 409);
    for (const draft of await this.drafts(humanId)) if (draft.origin === 'community') await this.kv.delete(this.#draftKey(humanId, draft.id));
    return this.s.retrying(async () => {
      const fresh = await this.s.must('Human', humanId);
      const profile = fresh.data.profile ?? emptyProfile();
      const writes = [this.s.next(current, { status: 'withdrawn', withdrawnAt: this.s.now() }, this.actor(human))];
      writes.push(this.s.next(fresh, { profile: { ...profile, items: profile.items.filter(item => item.source !== 'community-draft') } }, this.actor(human)));
      await this.s.commit(`consent-withdraw:${shortId()}`, writes);
      return { status: 'withdrawn', removed: profile.items.filter(item => item.source === 'community-draft').length };
    });
  }

  // ---------- the confirmation queue: agents propose, humans dispose ----------
  #draftKey(humanId, draftId) { return `draft:${uuidPart(humanId)}:${draftId}`; }
  async #queueDraft(humanId, { type, origin, payload, agent = null }) {
    const draft = { id: randomUUID(), humanId, type, origin, payload, agentId: agent?.id ?? null, agentName: agent?.data.displayName ?? null, createdAt: this.s.now() };
    await this.kv.put(this.#draftKey(humanId, draft.id), draft, { ttlMs: 30 * DAY });
    return draft;
  }
  async drafts(humanId) {
    return [...(await this.kv.list(`draft:${uuidPart(humanId)}:`)).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async confirmDraft(humanId, draftId, { edits } = {}) {
    const draft = await this.kv.get(this.#draftKey(humanId, draftId));
    if (!draft) fail('DRAFT_NOT_FOUND', 404);
    const payload = edits ?? draft.payload;
    let result;
    switch (draft.type) {
      case 'profile': result = await this.#mergeProfile(humanId, payload, draft.origin === 'community' ? 'community-draft' : 'agent-draft'); break;
      case 'request': result = await this.createRequest(humanId, payload); break;
      case 'refine': result = await this.refineRequest(humanId, payload.requestId, payload); break;
      case 'preflight': result = await this.answerPreflight(humanId, payload.preflightId, payload.answers, { draftedBy: 'agent' }); break;
      default: fail('UNKNOWN_DRAFT');
    }
    await this.kv.delete(this.#draftKey(humanId, draftId));
    return { type: draft.type, result };
  }
  async rejectDraft(humanId, draftId) {
    if (!await this.kv.delete(this.#draftKey(humanId, draftId))) fail('DRAFT_NOT_FOUND', 404);
    return { rejected: draftId };
  }

  // ---------- profiles ----------
  #cleanItem(input, { source, existing }) {
    if (!input || typeof input !== 'object') fail('INVALID_PROFILE');
    const verifiedLock = existing?.verified;
    const item = {
      id: existing?.id ?? (ITEM_ID.test(input.id ?? '') ? input.id : `${source === 'self' ? 's' : source === 'agent-draft' ? 'a' : 'c'}-${shortId()}`),
      kind: verifiedLock ? existing.kind : KINDS.includes(input.kind) ? input.kind : 'skill',
      title: verifiedLock ? existing.title : str(input.title, 120, { required: true }),
      detail: verifiedLock ? existing.detail : (str(input.detail, 600) ?? ''),
      tags: verifiedLock ? existing.tags : [...new Set((Array.isArray(input.tags) ? input.tags : []).filter(tag => typeof tag === 'string' && TAG.test(tag)))].slice(0, 8),
      source: existing?.source ?? source,
      visibility: input.visibility === 'private' ? 'private' : 'community',
      verified: Boolean(existing?.verified),
      ...(existing?.evidence?.length ? { evidence: existing.evidence } : input.evidence && source === 'community-draft' ? { evidence: input.evidence.slice(0, 20).map(ref => ({ topicId: String(ref.topicId).slice(0, 120) })) } : {}),
    };
    if (!item.tags.length) item.tags = tagsIn(`${item.title} ${item.detail}`, this.taxonomy).map(found => found.tag).slice(0, 8);
    return item;
  }
  #cleanSettings(input, base) {
    const hours = input.hoursPerWeek ?? base.hoursPerWeek;
    if (!Number.isInteger(hours) || hours < 0 || hours > 80) fail('INVALID_PROFILE');
    const openTo = input.openTo ?? base.openTo;
    const notDoing = input.notDoing ?? base.notDoing;
    if (!Array.isArray(openTo) || !openTo.every(value => REWARDS.includes(value))) fail('INVALID_PROFILE');
    if (!Array.isArray(notDoing) || !notDoing.every(value => typeof value === 'string' && TAG.test(value))) fail('INVALID_PROFILE');
    return { hoursPerWeek: hours, openTo: [...new Set(openTo)], notDoing: [...new Set(notDoing)].slice(0, 20), ...(input.headline !== undefined ? { headline: str(input.headline, 200) } : base.headline ? { headline: base.headline } : {}) };
  }

  /** The member edits their own profile directly. Verified items keep their content. */
  async setProfile(humanId, input) {
    const human = await this.#human(humanId);
    if (!input || typeof input !== 'object' || !Array.isArray(input.items) || input.items.length > 60) fail('INVALID_PROFILE');
    return this.s.retrying(async () => {
      const fresh = await this.s.must('Human', humanId);
      const base = fresh.data.profile ?? emptyProfile();
      const byId = new Map(base.items.map(item => [item.id, item]));
      const items = await this.alignProfileItems(input.items.map(item => this.#cleanItem(item, { source: 'self', existing: byId.get(item.id) })));
      const profile = { ...this.#cleanSettings(input, base), items, confirmedAt: this.s.now() };
      await this.s.commit(`profile:${shortId()}`, [this.s.next(fresh, { profile }, this.actor(human))]);
      return profile;
    });
  }

  async #mergeProfile(humanId, payload, source) {
    const human = await this.#human(humanId);
    return this.s.retrying(async () => {
      const fresh = await this.s.must('Human', humanId);
      const base = fresh.data.profile ?? emptyProfile();
      const incoming = await this.alignProfileItems((payload.items ?? []).map(item => this.#cleanItem(item, { source, existing: undefined })));
      const kept = base.items.filter(item => !incoming.some(next => next.id === item.id));
      if (kept.length + incoming.length > 60) fail('INVALID_PROFILE');
      const profile = { ...this.#cleanSettings(payload, base), items: [...kept, ...incoming], confirmedAt: this.s.now() };
      await this.s.commit(`profile-draft:${shortId()}`, [this.s.next(fresh, { profile }, this.actor(human))]);
      return profile;
    });
  }

  profileView(human, viewerId) {
    const profile = human.data.profile;
    if (!profile) return null;
    const self = viewerId === human.id;
    return { ...profile, items: profile.items.filter(item => self || item.visibility === 'community') };
  }

  async directory(humanId, { q = '' } = {}) {
    await this.#human(humanId);
    const query = String(q).trim().toLowerCase();
    const tags = query ? new Set(tagsIn(query, this.taxonomy).map(found => found.tag)) : null;
    return (await this.members()).filter(({ human }) => human.data.profile).map(({ human }) => ({ humanId: human.id, displayName: human.data.displayName, profile: this.profileView(human, humanId) }))
      .filter(entry => !query || entry.displayName.toLowerCase().includes(query) || entry.profile.items.some(item => `${item.title} ${item.detail}`.toLowerCase().includes(query) || item.tags.some(tag => tags?.has(tag))));
  }

  // ---------- requests and need understanding ----------
  #cleanNeeds(needs) {
    if (!Array.isArray(needs) || needs.length > 12) fail('INVALID_NEEDS');
    const seen = new Set();
    return needs.map(need => {
      if (!need || !TAG.test(need.tag ?? '')) fail('INVALID_NEEDS');
      let id = ITEM_ID.test(need.id ?? '') ? need.id : need.tag;
      while (seen.has(id)) id = `${need.tag}-${seen.size + 1}`;
      seen.add(id);
      return { id, tag: need.tag, title: str(need.title, 120, { required: true }), ...(need.detail ? { detail: str(need.detail, 400) } : {}) };
    });
  }
  #cleanCriteria(list) {
    if (!Array.isArray(list)) fail('INVALID_TEXT');
    const criteria = [...new Set(list.map(item => str(item, 300, { required: true })))];
    if (criteria.length > 20) fail('INVALID_TEXT');
    return criteria;
  }

  /**
   * The one thing a requester has to do is say what they want. `text` alone is
   * enough: the title is its first line and bullet lines become expected
   * outcomes. Anything still missing is reported by `clarify` instead of being
   * demanded up front, so the requester or their agent can fill it in later.
   */
  cleanRequest(input) {
    const text = str(input?.text, 4000);
    const lines = (text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    const BULLET = /^(?:[-*•]|\d+[.、)])\s+/u;
    const bullets = lines.filter(line => BULLET.test(line)).map(line => line.replace(BULLET, '').slice(0, 300));
    const prose = lines.filter(line => !BULLET.test(line));
    const title = str(input?.title, 200) ?? str((prose[0] ?? lines[0]?.replace(BULLET, ''))?.slice(0, 200), 200, { required: true });
    // The bullets become expected outcomes, so they are not repeated in the description.
    const description = str(input?.description, 4000) ?? (prose.length ? prose.join('\n') : text) ?? title;
    const criteria = this.#cleanCriteria(input?.acceptanceCriteria ?? bullets);
    const rewardTypes = input.rewardTypes ?? [];
    if (!Array.isArray(rewardTypes) || !rewardTypes.every(value => REWARDS.includes(value))) fail('INVALID_REWARDS');
    const request = {
      title, description, acceptanceCriteria: criteria,
      rewardTypes: [...new Set(rewardTypes)], stage: input.stage === 'execute' ? 'execute' : 'explore',
      source: ['member', 'client', 'lab', 'community-signal'].includes(input.source) ? input.source : 'member',
      ...(input.budget ? { budget: str(input.budget, 200) } : {}),
    };
    request.needs = input.needs?.length ? this.#cleanNeeds(input.needs) : understand(request, this.taxonomy);
    return request;
  }

  /** What is still unclear about a request, in the words the requester will read. */
  clarify(request) {
    const data = request.data ?? request;
    const gaps = [];
    if (!data.needs?.length) gaps.push({ field: 'needs', why: '没识别出需要什么能力，不会匹配到任何人' });
    if (!data.acceptanceCriteria?.length) gaps.push({ field: 'acceptanceCriteria', why: '没写期望成果，验收时容易有分歧' });
    if (!data.rewardTypes?.length) gaps.push({ field: 'rewardTypes', why: '没写回报方式，对方难以判断要不要接' });
    return gaps;
  }

  async createRequest(humanId, input) {
    const human = await this.#human(humanId);
    const clean = this.cleanRequest(input);
    if (!input.needs?.length) clean.needs = await this.understandNeeds(clean);
    const request = this.s.create('Request', { requesterHumanId: humanId, status: 'open', ...clean }, this.actor(human));
    await this.s.commit(`request:${uuidPart(request.id)}`, [request]);
    return request;
  }

  /** Requester only: make an open request clearer. Every field is optional. */
  async refineRequest(humanId, requestId, input = {}) {
    const human = await this.#human(humanId);
    const change = {
      ...(input.title !== undefined ? { title: str(input.title, 200, { required: true }) } : {}),
      ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: this.#cleanCriteria(input.acceptanceCriteria) } : {}),
      ...(input.needs !== undefined ? { needs: this.#cleanNeeds(input.needs) } : {}),
      ...(input.rewardTypes !== undefined ? { rewardTypes: [...new Set(Array.isArray(input.rewardTypes) ? input.rewardTypes : fail('INVALID_REWARDS'))] } : {}),
    };
    if (change.rewardTypes && !change.rewardTypes.every(value => REWARDS.includes(value))) fail('INVALID_REWARDS');
    if (!Object.keys(change).length) fail('NOTHING_TO_REFINE');
    return this.s.retrying(async () => {
      const request = await this.s.must('Request', requestId);
      if (request.data.requesterHumanId !== humanId) fail('REQUESTER_ONLY', 403);
      if (request.data.status !== 'open') fail('REQUEST_NOT_OPEN', 409);
      const next = this.s.next(request, change, this.actor(human));
      await this.s.commit(`refine:${shortId()}`, [next]);
      return next;
    });
  }

  async #routingRecords(requestId) {
    const [matches, suggestions, preflights] = await Promise.all([this.s.list('Match'), this.s.list('Suggestion'), this.s.list('Preflight')]);
    return { matches: matches.filter(item => item.data.requestId === requestId), suggestions: suggestions.filter(item => item.data.requestId === requestId), preflights: preflights.filter(item => item.data.requestId === requestId) };
  }

  async edges(preloaded = null) {
    const [rooms, requests] = preloaded ?? await Promise.all([this.s.list('Workroom'), this.s.list('Request')]);
    const accepted = new Set(requests.filter(item => item.data.status === 'accepted').map(item => item.id));
    const edges = new Map();
    for (const room of rooms) {
      if (!accepted.has(room.data.requestId) || !room.data.roles?.length) continue;
      const people = room.data.roles.map(role => role.humanId);
      for (let i = 0; i < people.length; i += 1) for (let j = i + 1; j < people.length; j += 1) edges.set(edgeKey(people[i], people[j]), (edges.get(edgeKey(people[i], people[j])) ?? 0) + 1);
    }
    return edges;
  }

  /**
   * Ranked candidates and a proposed line-up for a request (requester's view).
   * The proposal is `plan`; `squad` always means the workroom that was formed.
   */
  async candidates(requestId, preloaded = null) {
    const request = preloaded?.request ?? await this.s.must('Request', requestId);
    const { matches, suggestions } = preloaded ?? await this.#routingRecords(requestId);
    const members = preloaded?.members ?? await this.members();
    const excluded = new Set(matches.filter(item => item.data.status === 'declined').map(item => item.data.humanId));
    const ranked = rank({ request, members, suggestions, excluded, taxonomy: this.taxonomy });
    const status = new Map(matches.map(item => [item.data.humanId, item.data.status]));
    const withStatus = ranked.map(candidate => ({ ...candidate, matchStatus: status.get(candidate.humanId) ?? null }));
    return { candidates: withStatus, plan: planSquad({ request, candidates: ranked, edges: await this.edges() }) };
  }

  #suggestionVisible(item, humanId, request) {
    return item.data.kind !== 'candidate' || humanId === request.data.requesterHumanId || humanId === item.data.authorHumanId || humanId === item.data.candidateHumanId;
  }

  async listRequests(humanId) {
    await this.#human(humanId);
    const [requests, names, matches] = await Promise.all([this.s.list('Request'), this.#names(), this.s.list('Match')]);
    return requests.filter(item => item.data.needs && item.data.status !== 'draft' && item.data.status !== 'cancelled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(item => ({
        id: item.id, title: item.data.title, status: item.data.status, requester: names.get(item.data.requesterHumanId), mine: item.data.requesterHumanId === humanId,
        needs: item.data.needs, rewardTypes: item.data.rewardTypes, stage: item.data.stage, source: item.data.source, createdAt: item.createdAt,
        invitedMe: matches.some(match => match.data.requestId === item.id && match.data.humanId === humanId),
      }));
  }

  async requestView(humanId, requestId) {
    await this.#human(humanId);
    const request = await this.s.must('Request', requestId);
    if (!request.data.needs) fail('NOT_A_ROUTED_REQUEST', 404);
    const [names, records, rooms] = await Promise.all([this.#names(), this.#routingRecords(requestId), this.s.list('Workroom')]);
    const { matches, suggestions, preflights } = records;
    const mine = request.data.requesterHumanId === humanId;
    const squad = rooms.find(room => room.data.requestId === requestId && room.data.roles);
    const inSquad = squad?.data.participantHumanIds.includes(humanId);
    const view = {
      request, requester: names.get(request.data.requesterHumanId), mine,
      suggestions: suggestions.filter(item => this.#suggestionVisible(item, humanId, request)).map(item => ({ ...item, authorName: names.get(item.data.authorHumanId), candidateName: item.data.candidateHumanId ? names.get(item.data.candidateHumanId) : undefined })),
      myMatch: matches.find(item => item.data.humanId === humanId) ?? null,
      myPreflight: preflights.find(item => item.data.humanId === humanId) ?? null,
      squad: squad && (inSquad || mine) ? await this.squadView(humanId, squad.id) : squad ? { id: squad.id, visible: false } : null,
      clarify: mine ? this.clarify(request) : undefined,
    };
    if (mine) {
      Object.assign(view, await this.candidates(requestId, { ...records, request }));
      view.matches = matches.map(item => ({ ...item, name: names.get(item.data.humanId), preflight: preflights.find(p => p.data.matchId === item.id) ?? null }));
    }
    return view;
  }

  // ---------- invitations, pre-flight and decisions ----------
  async invite(humanId, requestId, humanIds, { agent = null } = {}) {
    const human = await this.#human(humanId);
    if (!Array.isArray(humanIds) || !humanIds.length || humanIds.length > 10 || !humanIds.every(id => URN.test(id))) fail('INVALID_CANDIDATES');
    const actor = agent ? CommunityService.agentActor(agent) : this.actor(human);
    return this.s.retrying(async () => {
      const request = await this.s.must('Request', requestId);
      if (request.data.requesterHumanId !== humanId) fail('REQUESTER_ONLY', 403);
      if (request.data.status !== 'open') fail('REQUEST_NOT_OPEN', 409);
      const [allMatches, suggestions, members] = await Promise.all([this.s.list('Match'), this.s.list('Suggestion'), this.members()]);
      const matches = allMatches.filter(item => item.data.requestId === requestId);
      const ranked = rank({ request, members, suggestions: suggestions.filter(item => item.data.requestId === requestId), taxonomy: this.taxonomy, limit: 100 });
      const active = new Set(members.map(member => member.human.id));
      // An agent's budget is counted from the invitations it actually sent, so a restart does not reset it.
      const quota = agent ? this.#inviteQuota(allMatches, agent, requestId) : null;
      const writes = [], invited = [];
      for (const candidateId of [...new Set(humanIds)]) {
        if (candidateId === humanId || !active.has(candidateId)) fail('CANDIDATE_NOT_ELIGIBLE', 409);
        if (matches.some(item => item.data.humanId === candidateId && ['invited', 'accepted'].includes(item.data.status))) continue;
        // A person's "no" is final for whoever automated the asking. Their principal may ask again in person.
        if (agent && matches.some(item => item.data.humanId === candidateId && item.data.status === 'declined')) fail('CANDIDATE_DECLINED', 409);
        if (quota) {
          quota.perRequest -= 1; quota.perHour -= 1;
          if (quota.perRequest < 0 || quota.perHour < 0) fail('RATE_LIMITED', 429);
        }
        const found = ranked.find(item => item.humanId === candidateId);
        const match = this.s.create('Match', {
          requestId, humanId: candidateId, needIds: found?.needIds ?? [], score: found?.score ?? 0, reasons: found?.reasons.length ? found.reasons : ['需求方直接邀请'],
          source: agent ? 'agent' : found?.suggested ? 'suggestion' : 'system', status: 'invited', invitedAt: this.s.now(),
          ...(agent ? { invitedByAgentId: agent.id } : {}),
        }, actor);
        const preflight = this.s.create('Preflight', { matchId: match.id, requestId, humanId: candidateId, questions: PREFLIGHT_QUESTIONS, status: 'requested' }, actor);
        writes.push(match, preflight);
        invited.push({ matchId: match.id, preflightId: preflight.id, humanId: candidateId });
      }
      if (writes.length) await this.s.commit(`invite:${shortId()}`, writes);
      return { invited };
    });
  }

  /**
   * How many more people this agent may invite, counted from the invitations it
   * sent. `invitedByAgentId` is used rather than the entity actor, because the
   * actor is overwritten when the invited member responds.
   */
  #inviteQuota(allMatches, agent, requestId) {
    const mine = allMatches.filter(item => item.data.invitedByAgentId === agent.id);
    const since = this.clock() - 3600 * 1000;
    return {
      perRequest: this.limits.invitesPerRequest - mine.filter(item => item.data.requestId === requestId).length,
      perHour: this.limits.invitesPerHour - mine.filter(item => Date.parse(item.createdAt) > since).length,
    };
  }

  async invitations(humanId) {
    await this.#human(humanId);
    const [matches, preflights, requests, names] = await Promise.all([this.s.list('Match'), this.s.list('Preflight'), this.s.list('Request'), this.#names()]);
    return matches.filter(item => item.data.humanId === humanId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(match => {
      const request = requests.find(item => item.id === match.data.requestId);
      return { match, preflight: preflights.find(item => item.data.matchId === match.id) ?? null, request: { id: request.id, title: request.data.title, description: request.data.description, needs: request.data.needs, rewardTypes: request.data.rewardTypes, requester: names.get(request.data.requesterHumanId), status: request.data.status } };
    });
  }

  cleanAnswers(answers, request) {
    if (!answers || typeof answers.available !== 'boolean' || !Number.isInteger(answers.hoursPerWeek) || answers.hoursPerWeek < 0 || answers.hoursPerWeek > 80 || !Array.isArray(answers.canOwn)) fail('INVALID_ANSWERS');
    const needIds = new Set((request.data.needs ?? []).map(need => need.id));
    if (!answers.canOwn.every(id => needIds.has(id))) fail('UNKNOWN_NEED');
    return { available: answers.available, hoursPerWeek: answers.hoursPerWeek, canOwn: [...new Set(answers.canOwn)], ...(answers.constraints ? { constraints: str(answers.constraints, 600) } : {}), ...(answers.needsInput ? { needsInput: str(answers.needsInput, 600) } : {}) };
  }

  async answerPreflight(humanId, preflightId, answers, { draftedBy = 'human' } = {}) {
    const human = await this.#human(humanId);
    return this.s.retrying(async () => {
      const preflight = await this.s.must('Preflight', preflightId);
      if (preflight.data.humanId !== humanId) fail('NOT_YOUR_PREFLIGHT', 403);
      const request = await this.s.must('Request', preflight.data.requestId);
      const next = this.s.next(preflight, { answers: this.cleanAnswers(answers, request), status: 'answered', draftedBy, answeredAt: this.s.now() }, this.actor(human));
      await this.s.commit(`preflight:${shortId()}`, [next]);
      return next;
    });
  }

  /** Human only: accept or decline an invitation. Accepting needs a sent pre-flight answer. */
  async respond(humanId, matchId, { decision, note } = {}) {
    const human = await this.#human(humanId);
    if (!['accept', 'decline'].includes(decision)) fail('INVALID_DECISION');
    return this.s.retrying(async () => {
      const match = await this.s.must('Match', matchId);
      if (match.data.humanId !== humanId) fail('NOT_YOUR_INVITATION', 403);
      if (match.data.status !== 'invited') fail('INVITATION_CLOSED', 409);
      if (decision === 'accept') {
        const preflight = (await this.s.list('Preflight')).find(item => item.data.matchId === matchId);
        if (preflight?.data.status !== 'answered') fail('PREFLIGHT_REQUIRED', 409);
      }
      const next = this.s.next(match, { status: decision === 'accept' ? 'accepted' : 'declined', respondedAt: this.s.now(), ...(note ? { note: str(note, 500) } : {}) }, this.actor(human));
      await this.s.commit(`respond:${shortId()}`, [next]);
      return next;
    });
  }

  // ---------- suggestions ----------
  #rateLimit(agentId, requestId) {
    const now = this.clock(), log = (this.suggestionLog.get(agentId) ?? []).filter(entry => entry.at > now - 3600 * 1000);
    if (log.length >= this.limits.suggestionsPerHour) fail('RATE_LIMITED', 429);
    if (log.filter(entry => entry.requestId === requestId).length >= this.limits.suggestionsPerRequest) fail('RATE_LIMITED', 429);
    log.push({ at: now, requestId });
    this.suggestionLog.set(agentId, log);
  }

  async suggest({ humanId, agent = null }, requestId, input) {
    const human = await this.#human(humanId);
    if (!['candidate', 'need', 'question'].includes(input?.kind)) fail('INVALID_SUGGESTION');
    const text = str(input.text, 600, { required: true });
    if (text.length < 4) fail('REASON_REQUIRED');
    const request = await this.s.must('Request', requestId);
    if (!request.data.needs || !['open', 'assigned'].includes(request.data.status)) fail('REQUEST_NOT_OPEN', 409);
    const data = { requestId, authorHumanId: humanId, kind: input.kind, text };
    if (input.kind === 'candidate') {
      if (!URN.test(input.candidateHumanId ?? '')) fail('CANDIDATE_REQUIRED');
      if (input.candidateHumanId === request.data.requesterHumanId) fail('CANDIDATE_NOT_ELIGIBLE', 409);
      if (!(await this.members()).some(member => member.human.id === input.candidateHumanId)) fail('CANDIDATE_NOT_ELIGIBLE', 409);
      const { suggestions } = await this.#routingRecords(requestId);
      if (suggestions.some(item => item.data.kind === 'candidate' && item.data.authorHumanId === humanId && item.data.candidateHumanId === input.candidateHumanId)) fail('DUPLICATE_SUGGESTION', 409);
      data.candidateHumanId = input.candidateHumanId;
    }
    if (input.kind === 'need') {
      if (!TAG.test(input.need?.tag ?? '')) fail('INVALID_NEEDS');
      data.need = { tag: input.need.tag, title: str(input.need.title, 120, { required: true }) };
    }
    if (agent) this.#rateLimit(agent.id, requestId);
    const suggestion = this.s.create('Suggestion', data, agent ? CommunityService.agentActor(agent) : this.actor(human));
    await this.s.commit(`suggestion:${uuidPart(suggestion.id)}`, [suggestion]);
    return suggestion;
  }

  // ---------- squads, delivery, review and evidence ----------
  /**
   * Requester only (or their agent with `route`): put the people who accepted
   * into a squad, with a role each. Someone who accepts later is added to the
   * same squad rather than being locked out, so nobody has to wait for every
   * answer before starting.
   */
  async formSquad(humanId, requestId, { roles, agent = null } = {}) {
    const human = await this.#human(humanId);
    const actor = agent ? CommunityService.agentActor(agent) : this.actor(human);
    return this.s.retrying(async () => {
      const request = await this.s.must('Request', requestId);
      if (request.data.requesterHumanId !== humanId) fail('REQUESTER_ONLY', 403);
      if (!['open', 'assigned'].includes(request.data.status)) fail('REQUEST_NOT_OPEN', 409);
      const [{ matches, preflights }, rooms] = await Promise.all([this.#routingRecords(requestId), this.s.list('Workroom')]);
      const accepted = matches.filter(item => item.data.status === 'accepted');
      if (!accepted.length) fail('NO_ACCEPTED_CANDIDATES', 409);
      const existing = rooms.find(room => room.data.requestId === requestId && room.data.roles);
      if (existing && existing.data.status !== 'active') fail('SQUAD_CLOSED', 409);
      const seated = new Set(existing?.data.roles.map(role => role.humanId) ?? []);
      const needIds = new Set(request.data.needs.map(need => need.id));
      const wanted = roles ?? accepted.filter(match => !seated.has(match.data.humanId)).map(match => ({ humanId: match.data.humanId, needIds: preflights.find(item => item.data.matchId === match.id)?.data.answers?.canOwn ?? match.data.needIds }));
      if (existing && !wanted.length) fail('NO_NEW_MEMBERS', 409);
      const planned = wanted.map(role => {
        if (!accepted.some(match => match.data.humanId === role.humanId)) fail('ROLE_NOT_ACCEPTED', 409);
        const ids = [...new Set(role.needIds ?? [])].filter(id => needIds.has(id));
        return { humanId: role.humanId, needIds: ids, title: str(role.title, 120) ?? (ids.map(id => request.data.needs.find(need => need.id === id).title).join(' + ') || '协作者') };
      });
      const kept = (existing?.data.roles ?? []).filter(role => !planned.some(item => item.humanId === role.humanId));
      const allRoles = [...kept, ...planned];
      const people = [...new Set([humanId, ...allRoles.map(role => role.humanId)])];
      const tokens = (await this.s.list('AgentToken')).filter(item => item.data.status === 'active' && item.data.scopes.includes('squad:write') && people.includes(item.data.principalId) && Date.parse(item.data.expiresAt) > this.clock());
      const agentIds = [...new Set([...(existing?.data.participantAgentIds ?? []), ...tokens.map(item => item.data.agentId)])];
      if (existing) {
        const next = this.s.next(existing, { participantHumanIds: people, participantAgentIds: agentIds, roles: allRoles }, actor);
        await this.s.commit(`squad-join:${shortId()}`, [next]);
        return next;
      }
      const workroom = this.s.create('Workroom', { requestId, participantHumanIds: people, participantAgentIds: agentIds, status: 'active', roles: allRoles }, actor);
      workroom.visibility = { scope: 'workroom', workroomId: workroom.id };
      await this.s.commit(`squad:${uuidPart(workroom.id)}`, [workroom, this.s.next(request, { status: 'assigned' }, actor)]);
      return workroom;
    });
  }

  async squadView(humanId, squadId) {
    const room = await this.s.must('Workroom', squadId);
    if (!room.data.participantHumanIds.includes(humanId)) fail('NOT_VISIBLE', 404);
    const [names, artifacts, attestations, request] = await Promise.all([this.#names(), this.s.list('Artifact'), this.s.list('Attestation'), this.s.must('Request', room.data.requestId)]);
    const own = artifacts.filter(item => item.data.workroomId === squadId);
    const withContent = [];
    for (const artifact of own) {
      const { bytes } = await this.s.store.getBlob(this.s.communityId, artifact.data.blob.sha256);
      withContent.push({ ...artifact, content: bytes.toString('utf8'), producerName: names.get(artifact.data.producerId) ?? (await this.s.get('Agent', artifact.data.producerId))?.data.displayName, principalName: names.get(artifact.data.principalId) });
    }
    return {
      id: room.id, status: room.data.status, request: { id: request.id, title: request.data.title, status: request.data.status, needs: request.data.needs, acceptanceCriteria: request.data.acceptanceCriteria, requesterHumanId: request.data.requesterHumanId },
      roles: room.data.roles.map(role => ({ ...role, name: names.get(role.humanId) })), participantAgentIds: room.data.participantAgentIds,
      artifacts: withContent, attestations: attestations.filter(item => own.some(artifact => artifact.id === item.data.artifactId)),
    };
  }

  async submitArtifact({ humanId, agent = null }, squadId, { title, content }) {
    const human = await this.#human(humanId);
    const text = str(content, 200000, { required: true });
    const blob = await this.s.store.putBlob(this.s.communityId, Buffer.from(text, 'utf8'), 'text/markdown; charset=utf-8');
    return this.s.retrying(async () => {
      const room = await this.s.must('Workroom', squadId);
      if (!room.data.participantHumanIds.includes(humanId)) fail('NOT_VISIBLE', 404);
      if (room.data.status !== 'active') fail('SQUAD_CLOSED', 409);
      const request = await this.s.must('Request', room.data.requestId);
      const actor = agent ? CommunityService.agentActor(agent) : this.actor(human);
      const writes = [];
      let current = room;
      if (agent && !room.data.participantAgentIds.includes(agent.id)) { current = this.s.next(room, { participantAgentIds: [...room.data.participantAgentIds, agent.id] }, actor); writes.push(current); }
      const artifact = this.s.create('Artifact', {
        workroomId: squadId, producerKind: agent ? 'Agent' : 'Human', producerId: agent ? agent.id : humanId, principalId: humanId,
        title: str(title, 200, { required: true }), mediaType: 'text/markdown', blob: { uri: this.s.store.blobUri(this.s.communityId, blob.sha256), sha256: blob.sha256 }, status: 'submitted',
      }, actor, { scope: 'workroom', workroomId: squadId });
      writes.push(artifact);
      if (request.data.status === 'assigned') writes.push(this.s.next(request, { status: 'review' }, actor));
      await this.s.commit(`deliver:${uuidPart(artifact.id)}`, writes);
      return artifact;
    });
  }

  /** Requester only. Acceptance turns every role in the squad into verified capability evidence. */
  async review(humanId, artifactId, { outcome, statement }) {
    const human = await this.#human(humanId);
    if (!['accepted', 'changes-requested'].includes(outcome)) fail('INVALID_OUTCOME');
    return this.s.retrying(async () => {
      const artifact = await this.s.must('Artifact', artifactId);
      const room = await this.s.must('Workroom', artifact.data.workroomId);
      const request = await this.s.must('Request', room.data.requestId);
      if (request.data.requesterHumanId !== humanId) fail('REQUESTER_ONLY', 403);
      if (artifact.data.status !== 'submitted' || request.data.status !== 'review') fail('NOT_UNDER_REVIEW', 409);
      const { bytes } = await this.s.store.getBlob(this.s.communityId, artifact.data.blob.sha256);
      if (sha256(bytes) !== artifact.data.blob.sha256) fail('ARTIFACT_HASH_MISMATCH', 409);
      const actor = this.actor(human);
      const attestation = this.s.create('Attestation', {
        issuerHumanId: humanId, subjectKind: artifact.data.producerKind, subjectId: artifact.data.producerId, requestId: request.id,
        artifactId, artifactRevision: artifact.revision, artifactSha256: artifact.data.blob.sha256, outcome, statement: str(statement, 2000, { required: true }), status: 'issued',
      }, actor, { scope: 'workroom', workroomId: room.id });
      const writes = [attestation];
      const evidence = [];
      if (outcome === 'accepted') {
        writes.push(this.s.next(request, { status: 'accepted' }, actor), this.s.next(artifact, { status: 'finalized' }, actor), this.s.next(room, { status: 'closed' }, actor));
        const humans = new Map((await this.s.list('Human')).map(item => [item.id, item]));
        for (const role of room.data.roles) {
          const member = humans.get(role.humanId) ?? fail('MEMBER_NOT_FOUND', 404);
          const profile = member.data.profile ?? emptyProfile();
          const items = [...profile.items];
          for (const needId of role.needIds) {
            const need = request.data.needs.find(item => item.id === needId);
            const id = `d-${need.tag}`.slice(0, 40);
            const existing = items.findIndex(item => item.id === id);
            const ref = { attestationId: attestation.id, requestId: request.id };
            if (existing >= 0) items[existing] = { ...items[existing], verified: true, evidence: [...(items[existing].evidence ?? []), ref].slice(-20) };
            else items.push({ id, kind: 'skill', title: `${need.title}（交付过：${request.data.title}）`.slice(0, 120), detail: `由需求方验收：${statement}`.slice(0, 600), tags: [need.tag], source: 'delivery', visibility: 'community', verified: true, evidence: [ref] });
            evidence.push({ humanId: role.humanId, tag: need.tag });
          }
          writes.push(this.s.next(member, { profile: { ...profile, items } }, actor));
        }
      } else {
        writes.push(this.s.next(request, { status: 'assigned' }, actor), this.s.next(artifact, { status: 'withdrawn' }, actor));
      }
      await this.s.commit(`route-review:${uuidPart(attestation.id)}`, writes);
      return { attestation, evidence };
    });
  }

  // ---------- joining from the page: one block of text, any agent ----------
  /**
   * The member is already signed in on the page, so there is nothing left to
   * approve: they pick what their agent may do, press a button, and get one
   * block of text to paste into whatever agent they use. No vendor's CLI, no
   * MCP-specific command — just an address, a code and what to do with them.
   *
   * The code is bound to them server-side, but it is single use and short
   * lived, and it is exchanged for the real token. That matters because the
   * text lands in a chat transcript: a pairing code that has been redeemed, or
   * that sat for ten minutes, is worth nothing to whoever reads it later. A
   * permanent personal code pasted into a transcript would be a password.
   */
  async createPairing(humanId, { name, scopes } = {}) {
    const human = await this.#human(humanId);
    const wanted = Array.isArray(scopes) && scopes.length ? scopes : DEFAULT_SCOPES;
    if (!wanted.every(scope => SCOPES.includes(scope))) fail('INVALID_SCOPES');
    const code = claimCode();
    const record = {
      code, humanId, agentName: str(name, 120) ?? `${human.data.displayName} 的 Agent`,
      scopes: [...new Set([...wanted, 'read'])], expiresAt: new Date(this.clock() + PAIRING_TTL_MS).toISOString(),
    };
    await this.kv.put(`pairing:${normalizeCode(code)}`, record, { ttlMs: PAIRING_TTL_MS });
    return { code, expiresAt: record.expiresAt, scopes: record.scopes, instructions: pairingText(this.s.publicOrigin, code) };
  }

  /** Any agent, with the code its principal gave it, exchanged once for a token. */
  async redeemPairing(code, { name } = {}) {
    const key = `pairing:${normalizeCode(code)}`;
    const record = await this.kv.get(key);
    if (!record) fail('PAIRING_CODE_INVALID', 404);
    await this.kv.delete(key); // single use, whatever happens next
    if (Date.parse(record.expiresAt) <= this.clock()) fail('PAIRING_CODE_EXPIRED', 410);
    const issued = await this.issueAgentToken(record.humanId, { name: str(name, 120) ?? record.agentName, scopes: record.scopes });
    const human = await this.#human(record.humanId);
    return { ...issued, principal: { id: human.id, name: human.data.displayName }, api: `${this.s.publicOrigin}/api/agent/v1`, mcp: `${this.s.publicOrigin}/mcp`, guide: `${this.s.publicOrigin}/agents.md` };
  }

  // ---------- joining from the terminal (device authorization) ----------
  /**
   * An agent should not ask its principal to copy a secret. It asks for a code
   * instead, shows them a link, and polls; the person signs in, sees what is
   * being asked for and grants it. The token goes straight from the node to the
   * agent and is handed over exactly once (RFC 8628's shape, not its wire format).
   *
   * The request is unauthenticated — that is the point — so it carries no
   * standing: nothing exists until a signed-in member approves it, and a code
   * that nobody approves expires in ten minutes.
   */
  async startDeviceAuthorization({ name, scopes } = {}) {
    const wanted = Array.isArray(scopes) && scopes.length ? scopes : DEFAULT_SCOPES;
    if (!wanted.every(scope => SCOPES.includes(scope))) fail('INVALID_SCOPES');
    const userCode = claimCode();
    const deviceCode = randomBytes(32).toString('base64url');
    const record = {
      userCode, secretHash: sha256(deviceCode), agentName: str(name, 120) ?? '一个 Agent',
      scopes: [...new Set([...wanted, 'read'])], status: 'pending', createdAt: this.s.now(),
      expiresAt: new Date(this.clock() + DEVICE_TTL_MS).toISOString(),
    };
    await this.kv.put(this.#deviceKey(userCode), record, { ttlMs: DEVICE_TTL_MS });
    await this.kv.put(`device-secret:${record.secretHash}`, userCode, { ttlMs: DEVICE_TTL_MS });
    return {
      userCode, deviceCode, verifyUrl: `${this.s.publicOrigin}/router.html?authorize=${userCode}`,
      expiresInSeconds: DEVICE_TTL_MS / 1000, intervalSeconds: DEVICE_POLL_SECONDS,
    };
  }

  #deviceKey(userCode) { return `device:${normalizeCode(userCode)}`; }
  async #device(userCode) {
    const record = await this.kv.get(this.#deviceKey(userCode));
    if (!record) fail('DEVICE_CODE_INVALID', 404);
    if (Date.parse(record.expiresAt) <= this.clock()) fail('DEVICE_CODE_EXPIRED', 410);
    return record;
  }
  async #closeDevice(record) {
    await this.kv.delete(this.#deviceKey(record.userCode));
    await this.kv.delete(`device-secret:${record.secretHash}`);
  }

  /**
   * What the person is being asked to approve. The code comes back in the form
   * their terminal printed, dashes and all, because comparing the two is how
   * they tell their own request apart from a link somebody sent them.
   */
  async deviceRequest(userCode) {
    const record = await this.#device(userCode);
    return { userCode: record.userCode, agentName: record.agentName, scopes: record.scopes, status: record.status };
  }

  /** Human only: grant an agent the powers they actually want it to have. */
  async approveDevice(humanId, userCode, { scopes, name } = {}) {
    const record = await this.#device(userCode);
    if (record.status !== 'pending') fail('DEVICE_ALREADY_RESOLVED', 409);
    const granted = Array.isArray(scopes) && scopes.length ? scopes.filter(scope => record.scopes.includes(scope)) : record.scopes;
    const issued = await this.issueAgentToken(humanId, { name: str(name, 120) ?? record.agentName, scopes: granted.length ? granted : ['read'] });
    await this.kv.put(this.#deviceKey(record.userCode), { ...record, status: 'approved', humanId, issued }, { ttlMs: DEVICE_TTL_MS });
    return { agentName: issued.agentName, scopes: issued.scopes, expiresAt: issued.expiresAt };
  }

  async denyDevice(humanId, userCode) {
    const record = await this.#device(userCode);
    if (record.status !== 'pending') fail('DEVICE_ALREADY_RESOLVED', 409);
    await this.kv.put(this.#deviceKey(record.userCode), { ...record, status: 'denied' }, { ttlMs: DEVICE_TTL_MS });
    return { status: 'denied' };
  }

  /** The agent polls with its device code. The token is handed over once, then the code is gone. */
  async pollDevice(deviceCode) {
    const digest = sha256(String(deviceCode ?? ''));
    const userCode = await this.kv.get(`device-secret:${digest}`);
    if (!userCode) fail('DEVICE_CODE_INVALID', 404);
    const record = await this.#device(userCode);
    if (!sameDigest(record.secretHash, digest)) fail('DEVICE_CODE_INVALID', 404);
    if (record.status === 'pending') return { status: 'pending', intervalSeconds: DEVICE_POLL_SECONDS };
    await this.#closeDevice(record);
    if (record.status === 'denied') fail('DEVICE_DENIED', 403);
    return { status: 'approved', ...record.issued };
  }

  // ---------- member agents ----------
  async issueAgentToken(humanId, { name, scopes = DEFAULT_SCOPES, ttlDays = 30, agentId } = {}) {
    const human = await this.#human(humanId);
    if (!Array.isArray(scopes) || !scopes.length || !scopes.every(scope => SCOPES.includes(scope))) fail('INVALID_SCOPES');
    if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 90) fail('INVALID_TTL');
    const actor = this.actor(human);
    const writes = [];
    let agent;
    if (agentId) {
      agent = await this.s.must('Agent', agentId);
      if (agent.data.principalId !== humanId) fail('NOT_AGENT_PRINCIPAL', 403);
    } else {
      agent = this.s.create('Agent', { principalId: humanId, displayName: str(name, 120, { required: true }), bindingStatus: 'verified', status: 'active', interface: { protocol: 'a2a', version: '1.0', cardUrl: 'https://placeholder.invalid/' } }, actor);
      agent.data.interface.cardUrl = this.s.cardUrl(agent.id);
      writes.push(agent);
    }
    const record = this.s.create('AgentToken', { agentId: agent.id, principalId: humanId, tokenHash: '0'.repeat(64), scopes: [...new Set([...scopes, 'read'])], status: 'active', expiresAt: new Date(this.clock() + ttlDays * DAY).toISOString(), label: agent.data.displayName.slice(0, 200) }, actor);
    const credential = issueCredential('amt', record.id);
    record.data.tokenHash = credential.hash;
    writes.push(record);
    await this.s.commit(`agent-token:${uuidPart(record.id)}`, writes);
    return { agentId: agent.id, agentName: agent.data.displayName, tokenId: record.id, token: credential.token, scopes: record.data.scopes, expiresAt: record.data.expiresAt };
  }

  async agentTokens(humanId) {
    await this.#human(humanId);
    const [tokens, agents] = await Promise.all([this.s.list('AgentToken'), this.s.list('Agent')]);
    return tokens.filter(item => item.data.principalId === humanId).map(item => ({ tokenId: item.id, agentId: item.data.agentId, agentName: agents.find(agent => agent.id === item.data.agentId)?.data.displayName, scopes: item.data.scopes, status: item.data.status, expiresAt: item.data.expiresAt, createdAt: item.createdAt }));
  }

  async revokeAgentToken(humanId, tokenId) {
    const human = await this.#human(humanId);
    return this.s.retrying(async () => {
      const token = await this.s.must('AgentToken', tokenId);
      if (token.data.principalId !== humanId) fail('NOT_AGENT_PRINCIPAL', 403);
      await this.s.commit(`agent-token-revoke:${shortId()}`, [this.s.next(token, { status: 'revoked', revokedAt: this.s.now() }, this.actor(human))]);
      return { tokenId, status: 'revoked' };
    });
  }

  async agentAuth(token) {
    const parsed = parseCredential('amt', token);
    if (!parsed) fail('AGENT_TOKEN_INVALID', 401);
    const record = await this.s.get('AgentToken', parsed.recordId);
    if (!record || !sameDigest(record.data.tokenHash, parsed.secretHash)) fail('AGENT_TOKEN_INVALID', 401);
    if (record.data.status !== 'active') fail('AGENT_TOKEN_REVOKED', 401);
    if (Date.parse(record.data.expiresAt) <= this.clock()) fail('AGENT_TOKEN_EXPIRED', 401);
    const agent = await this.s.must('Agent', record.data.agentId);
    if (agent.data.status !== 'active') fail('AGENT_DISABLED', 401);
    await this.s.activeMember(record.data.principalId).catch(() => fail('PRINCIPAL_NOT_ACTIVE', 401));
    return { record, agent, principalId: record.data.principalId, scopes: record.data.scopes };
  }

  async audit(entry) {
    await this.kv.put(`audit:${String(this.clock()).padStart(15, '0')}:${shortId()}`, { at: this.s.now(), ...entry }, { ttlMs: 7 * DAY });
  }
  async auditLog({ agentId } = {}) {
    return [...(await this.kv.list('audit:')).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value).filter(entry => !agentId || entry.agentId === agentId);
  }

  /**
   * Runs one agent API action. Human-only actions are refused (and audited)
   * with HUMAN_ONLY; drafting actions land in the principal's confirmation queue.
   */
  async agentAction(auth, action, params, { query = {}, body = {} } = {}) {
    const started = this.clock();
    const record = (outcome, code) => this.audit({ agentId: auth.agent.id, principalId: auth.principalId, action: action.id, outcome, code, ms: this.clock() - started });
    try {
      if (action.human === 'only') fail('HUMAN_ONLY', 403);
      if (!auth.scopes.includes(action.scope)) fail(action.human === 'delegated' ? 'DELEGATION_REQUIRED' : 'SCOPE_REQUIRED', 403);
      const result = await this.#agentDispatch(auth, action.id, params, query, body);
      await record('ok');
      return result;
    } catch (error) {
      await record('denied', error.code ?? 'ERROR');
      throw error;
    }
  }

  async #agentDispatch({ agent, principalId, scopes }, id, params, query, body) {
    const principal = await this.#human(principalId);
    switch (id) {
      case 'me': return { agent: { id: agent.id, name: agent.data.displayName }, principal: { id: principalId, name: principal.data.displayName }, scopes, profile: this.profileView(principal, principalId), consent: (await this.consentOf(principalId))?.data.status ?? 'none' };
      case 'inbox': return this.inbox(principalId, { scopes });
      case 'list_requests': return this.listRequests(principalId);
      case 'get_request': {
        const view = await this.requestView(principalId, params.requestId);
        // The agent sees what its principal sees; candidate lists stay with the requester's page.
        return { ...view, candidates: view.candidates?.map(({ humanId, displayName, needIds, reasons, matchStatus }) => ({ humanId, displayName, needIds, reasons, matchStatus })) };
      }
      case 'search_members': return this.directory(principalId, { q: query.q ?? '' });
      case 'draft_profile': {
        const payload = { ...(body.headline !== undefined ? { headline: body.headline } : {}), items: (body.items ?? []).map(item => this.#cleanItem(item, { source: 'agent-draft' })), ...(body.hoursPerWeek !== undefined ? { hoursPerWeek: body.hoursPerWeek } : {}), ...(body.openTo ? { openTo: body.openTo } : {}), ...(body.notDoing ? { notDoing: body.notDoing } : {}) };
        this.#cleanSettings(payload, principal.data.profile ?? emptyProfile());
        return this.#queueDraft(principalId, { type: 'profile', origin: 'agent', payload, agent });
      }
      case 'draft_request': return this.#queueDraft(principalId, { type: 'request', origin: 'agent', payload: this.cleanRequest(body), agent });
      case 'refine_request': {
        const request = await this.s.must('Request', params.requestId);
        if (request.data.requesterHumanId !== principalId) fail('REQUESTER_ONLY', 403);
        if (request.data.status !== 'open') fail('REQUEST_NOT_OPEN', 409);
        const payload = { requestId: request.id, ...['title', 'acceptanceCriteria', 'needs', 'rewardTypes'].reduce((out, key) => body[key] === undefined ? out : { ...out, [key]: body[key] }, {}) };
        if (Object.keys(payload).length === 1) fail('NOTHING_TO_REFINE');
        if (payload.needs) payload.needs = this.#cleanNeeds(payload.needs);
        if (payload.acceptanceCriteria) payload.acceptanceCriteria = this.#cleanCriteria(payload.acceptanceCriteria);
        return this.#queueDraft(principalId, { type: 'refine', origin: 'agent', payload, agent });
      }
      case 'invite_candidates': return this.invite(principalId, params.requestId, body.humanIds, { agent });
      case 'form_squad': return this.formSquad(principalId, params.requestId, { roles: body.roles, agent });
      case 'suggest': return this.suggest({ humanId: principalId, agent }, params.requestId, body);
      case 'draft_preflight': {
        const preflight = await this.s.must('Preflight', params.preflightId);
        if (preflight.data.humanId !== principalId) fail('NOT_YOUR_PREFLIGHT', 403);
        if (preflight.data.status !== 'requested') fail('PREFLIGHT_ALREADY_ANSWERED', 409);
        const answers = this.cleanAnswers(body, await this.s.must('Request', preflight.data.requestId));
        return this.#queueDraft(principalId, { type: 'preflight', origin: 'agent', payload: { preflightId: preflight.id, answers }, agent });
      }
      case 'get_squad': return this.squadView(principalId, params.squadId);
      case 'submit_artifact': return this.submitArtifact({ humanId: principalId, agent }, params.squadId, body);
      default: fail('NOT_FOUND', 404);
    }
  }

  /** What an agent should do now for its principal. `humanOnly` items are reminders to pass on. */
  async inbox(humanId, { scopes = null } = {}) {
    const human = await this.#human(humanId);
    const [requests, matches, preflights, rooms, drafts, consent] = await Promise.all([this.s.list('Request'), this.s.list('Match'), this.s.list('Preflight'), this.s.list('Workroom'), this.drafts(humanId), this.consentOf(humanId)]);
    const items = [];
    // Coordination the principal may or may not have handed over.
    const routes = scopes === null || scopes.includes('route');
    const coordinate = (item, hint) => routes ? { ...item, hint } : { ...item, action: undefined, humanOnly: true, hint: `主人还没有授权你代办这件事。提醒他去页面上处理，或在「我的 Agent」里勾选"替我邀请和组队"。（${hint}）` };
    const pendingPreflightDrafts = new Set(drafts.filter(draft => draft.type === 'preflight').map(draft => draft.payload.preflightId));
    if (consent?.data.status !== 'active' && this.activity) items.push({ type: 'consent.sign', humanOnly: true, summary: '主人尚未签署成员协议；签署后网络才会用他的社区发言起草档案', hint: '提醒主人在页面「我的档案」查看协议' });
    if (!human.data.profile?.items.length) items.push({ type: 'profile.draft', action: 'draft_profile', humanOnly: false, summary: '主人的档案还是空的', hint: '根据你对主人的了解起草档案条目；不要编造，主人确认后才公开' });
    if (drafts.length) items.push({ type: 'drafts.pending', humanOnly: true, count: drafts.length, summary: `${drafts.length} 份草稿等主人确认`, hint: '提醒主人在页面「待我确认」处理' });
    const openMatches = new Set(matches.filter(item => item.data.status === 'invited').map(item => item.id));
    for (const preflight of preflights.filter(item => item.data.humanId === humanId && item.data.status === 'requested' && openMatches.has(item.data.matchId) && !pendingPreflightDrafts.has(item.id))) {
      const request = requests.find(item => item.id === preflight.data.requestId);
      items.push({ type: 'preflight.answer', action: 'draft_preflight', humanOnly: false, preflightId: preflight.id, matchId: preflight.data.matchId, requestId: request.id, summary: `「${request.data.title}」邀请主人参与，需要回答预沟通`, needs: request.data.needs, questions: preflight.data.questions, hint: '根据主人档案起草回答；主人确认后才发送。不确定就写 available=false 或在 constraints 说明' });
    }
    for (const match of matches.filter(item => item.data.humanId === humanId && item.data.status === 'invited')) {
      const preflight = preflights.find(item => item.data.matchId === match.id);
      if (preflight?.data.status === 'answered') items.push({ type: 'invitation.decide', humanOnly: true, matchId: match.id, requestId: match.data.requestId, summary: '预沟通已发送，等主人决定是否接受', hint: '只能主人本人在页面「我的邀请」接受或拒绝' });
    }
    const invitedTo = new Set(matches.filter(item => item.data.humanId === humanId).map(item => item.data.requestId));
    for (const request of requests.filter(item => item.data.needs && item.data.status === 'open' && item.data.requesterHumanId !== humanId && !invitedTo.has(item.id)).slice(0, 10)) {
      const ranked = rank({ request, members: [{ human }], taxonomy: this.taxonomy });
      items.push({ type: ranked.length ? 'opportunity.fit' : 'request.suggest', action: 'suggest', humanOnly: false, requestId: request.id, summary: ranked.length ? `「${request.data.title}」与主人档案有重合：${ranked[0].reasons.slice(0, 2).join('；')}` : `「${request.data.title}」正在找人`, needs: request.data.needs, hint: ranked.length ? '如果主人合适，可以推荐主人自己（写明理由）；也可以推荐更合适的成员' : '如果你知道谁合适，推荐他并写明理由；也可以补充遗漏的需求' });
    }
    // The principal's own requests: get them clear, get them in front of people, close them.
    for (const request of requests.filter(item => item.data.needs && item.data.requesterHumanId === humanId && ['open', 'review'].includes(item.data.status))) {
      const gaps = this.clarify(request);
      const own = matches.filter(item => item.data.requestId === request.id);
      if (request.data.status === 'review') {
        items.push({ type: 'review.pending', humanOnly: true, requestId: request.id, summary: `「${request.data.title}」有交付物等主人验收`, hint: '验收只能主人本人在页面上做，请提醒他' });
        continue;
      }
      if (gaps.length) items.push({ type: 'request.refine', action: 'refine_request', humanOnly: false, requestId: request.id, summary: `主人的需求「${request.data.title}」还不够清楚`, gaps, hint: '用 refine_request 补上缺的部分；主人确认后才替换。不要替他编造预算或承诺' });
      else if (!own.length) items.push(coordinate({ type: 'request.invite', action: 'invite_candidates', humanOnly: false, requestId: request.id, summary: `主人的需求「${request.data.title}」还没有邀请任何人` }, '用 get_request 看候选人和理由，挑最合适的几位邀请；被邀请的人自己决定接不接'));
      else {
        const room = rooms.find(item => item.data.requestId === request.id && item.data.roles);
        const seated = new Set(room?.data.roles.map(role => role.humanId) ?? []);
        const waiting = own.filter(item => item.data.status === 'accepted' && !seated.has(item.data.humanId)).length;
        const undecided = own.filter(item => item.data.status === 'invited').length;
        if (waiting && room?.data.status !== 'closed') {
          items.push(coordinate({ type: 'squad.form', action: 'form_squad', humanOnly: false, requestId: request.id, waiting, undecided, summary: room ? `又有 ${waiting} 人接受了「${request.data.title}」的邀请` : `已经有 ${waiting} 人接受「${request.data.title}」的邀请，可以组队了` },
            `按每个人预沟通里写的"能负责"来分工${undecided ? `。还有 ${undecided} 人没回应，晚接受的人可以再加入，不必等齐` : ''}`));
        }
      }
    }
    for (const room of rooms.filter(item => item.data.roles && item.data.status === 'active' && item.data.participantHumanIds.includes(humanId))) {
      const request = requests.find(item => item.id === room.data.requestId);
      const role = room.data.roles.find(item => item.humanId === humanId);
      items.push({ type: 'squad.deliver', action: 'submit_artifact', humanOnly: false, squadId: room.id, requestId: request.id, summary: `小组「${request.data.title}」进行中${role ? `，主人负责：${role.title}` : ''}`, acceptanceCriteria: request.data.acceptanceCriteria, hint: '把主人负责部分的成果整理成交付物提交；验收只能由需求方本人做' });
    }
    return { principalId: humanId, items, pollSeconds: 60 };
  }

  /**
   * The member's single list: only what is theirs to decide, newest concern
   * first. Same facts as the agent inbox, minus everything an agent can do
   * alone; `agentCovers` says which items an agent they authorised is already
   * working on, so the page can leave those alone.
   */
  async todo(humanId) {
    await this.#human(humanId);
    const [requests, matches, preflights, rooms, artifacts, drafts, consent, tokens] = await Promise.all([
      this.s.list('Request'), this.s.list('Match'), this.s.list('Preflight'), this.s.list('Workroom'), this.s.list('Artifact'), this.drafts(humanId), this.consentOf(humanId), this.s.list('AgentToken'),
    ]);
    const live = tokens.filter(item => item.data.principalId === humanId && item.data.status === 'active' && Date.parse(item.data.expiresAt) > this.clock());
    const granted = new Set(live.flatMap(item => item.data.scopes));
    const titleOf = requestId => requests.find(item => item.id === requestId)?.data.title ?? '';
    const items = [];

    if (this.activity && consent?.data.status !== 'active') items.push({ type: 'consent.sign', agentCovers: false, title: '签署成员协议', detail: '签署后网络才会用你在社区里的发言为你起草档案。' });
    for (const draft of drafts) items.push({ type: 'draft.confirm', agentCovers: false, draftId: draft.id, title: DRAFT_TITLES[draft.type] ?? '确认草稿', detail: draft.origin === 'community' ? '社区依据你的群聊发言起草，你确认后才公开。' : `${draft.agentName ?? '你的 Agent'} 起草，你确认后才生效。` });
    for (const match of matches.filter(item => item.data.humanId === humanId && item.data.status === 'invited')) {
      const preflight = preflights.find(item => item.data.matchId === match.id);
      if (preflight?.data.status === 'answered') items.push({ type: 'invitation.decide', agentCovers: false, matchId: match.id, requestId: match.data.requestId, title: `决定接不接：「${titleOf(match.data.requestId)}」`, detail: '预沟通已经发出。答应投入时间只能你本人做。' });
      else if (preflight) items.push({ type: 'preflight.answer', agentCovers: granted.has('preflight:draft'), preflightId: preflight.id, matchId: match.id, requestId: match.data.requestId, title: `回答预沟通：「${titleOf(match.data.requestId)}」`, detail: '有没有空、每周几小时、能负责哪些需求。' });
    }
    for (const request of requests.filter(item => item.data.needs && item.data.requesterHumanId === humanId)) {
      const own = matches.filter(item => item.data.requestId === request.id);
      const gaps = request.data.status === 'open' ? this.clarify(request) : [];
      if (gaps.length) items.push({ type: 'request.refine', agentCovers: granted.has('request:draft'), requestId: request.id, gaps, title: `把「${request.data.title}」说清楚`, detail: gaps.map(gap => gap.why).join('；') });
      else if (request.data.status === 'open' && !own.length) items.push({ type: 'request.invite', agentCovers: granted.has('route'), requestId: request.id, title: `邀请人来做「${request.data.title}」`, detail: '候选人和"为什么是他"已经排好了。' });
      else if (['open', 'assigned'].includes(request.data.status)) {
        const room = rooms.find(item => item.data.requestId === request.id && item.data.roles);
        const seated = new Set(room?.data.roles.map(role => role.humanId) ?? []);
        const waiting = own.filter(item => item.data.status === 'accepted' && !seated.has(item.data.humanId)).length;
        if (waiting && room?.data.status !== 'closed') items.push({ type: 'squad.form', agentCovers: granted.has('route'), requestId: request.id, title: `为「${request.data.title}」组队`, detail: room ? `又有 ${waiting} 人接受了邀请，可以加入小组。` : `已经有 ${waiting} 人接受了邀请。` });
      }
      if (request.data.status === 'review') {
        for (const artifact of artifacts.filter(item => item.data.status === 'submitted' && rooms.some(room => room.id === item.data.workroomId && room.data.requestId === request.id))) {
          items.push({ type: 'review.accept', agentCovers: false, artifactId: artifact.id, requestId: request.id, title: `验收「${request.data.title}」`, detail: `交付物「${artifact.data.title}」。这是不是你要的，只有你能判断。` });
        }
      }
    }
    items.sort((a, b) => Number(a.agentCovers) - Number(b.agentCovers));
    return { humanId, agents: live.length, mine: items.filter(item => !item.agentCovers).length, items };
  }

  // ---------- organizer dashboard ----------
  async metrics() {
    const [requests, matches, suggestions, rooms, humans, consents, members] = await Promise.all([this.s.list('Request'), this.s.list('Match'), this.s.list('Suggestion'), this.s.list('Workroom'), this.s.list('Human'), this.s.list('Consent'), this.members()]);
    const routed = requests.filter(item => item.data.needs);
    const responded = matches.filter(item => ['accepted', 'declined'].includes(item.data.status));
    const accepted = matches.filter(item => item.data.status === 'accepted');
    const firstAccept = routed.map(request => {
      const times = accepted.filter(match => match.data.requestId === request.id && match.data.respondedAt).map(match => Date.parse(match.data.respondedAt));
      return times.length ? Math.min(...times) - Date.parse(request.createdAt) : null;
    }).filter(value => value !== null).sort((a, b) => a - b);
    return {
      opportunities: routed.length,
      matched: routed.filter(request => matches.some(match => match.data.requestId === request.id)).length,
      invitations: matches.length, accepted: accepted.length,
      acceptanceRate: responded.length ? Math.round(100 * accepted.length / responded.length) : null,
      squads: rooms.filter(item => item.data.roles).length,
      delivered: routed.filter(item => item.data.status === 'accepted').length,
      verifiedCapabilities: humans.reduce((sum, human) => sum + (human.data.profile?.items.filter(item => item.verified).length ?? 0), 0),
      suggestions: suggestions.length,
      medianMsToFirstAccept: firstAccept.length ? firstAccept[Math.floor(firstAccept.length / 2)] : null,
      members: members.length,
      profilesConfirmed: members.filter(member => member.human.data.profile?.confirmedAt).length,
      consented: new Set(consents.filter(item => item.data.status === 'active').map(item => item.data.humanId)).size,
      collaborationEdges: (await this.edges([rooms, requests])).size,
    };
  }
}
