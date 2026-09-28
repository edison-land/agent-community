/**
 * Deterministic routing engine (RFC 0010 §5, §9). No model is called here:
 * the baseline understands needs and ranks members from a community taxonomy,
 * so tests and evaluations are reproducible. Members' own agents add
 * intelligence through the agent API (proposed needs, suggestions,
 * pre-flight answers); humans decide.
 */

/** A community-agnostic starting taxonomy; a community can replace it. */
export const DEFAULT_TAXONOMY = [
  { tag: 'recruitment', title: '人才招聘', keywords: ['招聘', '猎头', '人才', '求职', '人力资源', 'hr', 'hiring', 'recruit', 'recruitment', 'jobsdb'] },
  { tag: 'data', title: '数据工程', keywords: ['数据', '爬虫', '采集', '情报', '数据管道', '聊天记录', '数据提取', '提取', '数据处理', '文本处理', '清洗', '知识加工', 'data', 'pipeline', 'scraping', 'etl'] },
  { tag: 'ai-engineering', title: '智能算法工程', keywords: ['ai', 'agent', 'llm', '大模型', 'rag', '智能体', '模型微调', '知识库', '知识工程', '自然语言', '语义', '问答', 'nlp', '智能', '自动化', 'codex'] },
  { tag: 'product-design', title: '产品设计', keywords: ['产品设计', '交互', '原型', '软件产品', '产品规划', '需求分析', '方案设计', '业务流程', 'ui', 'ux', 'figma', 'prototype', '用户体验'] },
  { tag: 'frontend', title: '前端开发', keywords: ['前端', '网页', '小程序', '微信小程序', 'web', 'h5', 'react', 'vue', 'frontend', 'web app'] },
  { tag: 'backend', title: '服务端研发', keywords: ['后端', '服务器', '部署', '数据库', '软件开发', '系统开发', '接口开发', 'api', 'backend', 'devops', 'cloudflare'] },
  { tag: 'bd', title: '商务拓展', keywords: ['商务', '企业资源', '销售', '渠道', '拓展', '客户资源', 'bd', 'sales', 'partnership'] },
  { tag: 'hk-market', title: '香港市场', keywords: ['香港', '港澳', 'hong kong', 'hk'] },
  { tag: 'legal', title: '合规风控', keywords: ['律师', '法律', '合规', '合同', '知识产权', 'legal', 'compliance'] },
  { tag: 'content', title: '内容运营', keywords: ['内容', '小红书', '抖音', '视频号', '社媒', '文案', '创作者', 'kol', 'content'] },
  { tag: 'web3', title: 'Web3', keywords: ['web3', '区块链', '链上', 'crypto', 'defi', 'nft'] },
  { tag: 'research', title: '行业调研', keywords: ['调研', '行业研究', '市场研究', '研究报告', '行业报告', 'research', 'market research'] },
  { tag: 'hardware', title: '硬件研发', keywords: ['硬件', '芯片', '嵌入式', 'hardware', 'iot'] },
  { tag: 'fundraising', title: '融资规划', keywords: ['融资', '投资', '天使轮', '投资人', 'fundraising', 'vc'] },
];

const TAG = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const ASCII = /^[\x20-\x7e]+$/u;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function validateTaxonomy(taxonomy) {
  if (!Array.isArray(taxonomy) || !taxonomy.length || taxonomy.length > 200) throw new Error('INVALID_TAXONOMY');
  for (const entry of taxonomy) {
    if (!TAG.test(entry?.tag ?? '') || typeof entry.title !== 'string' || !Array.isArray(entry.keywords) || !entry.keywords.length) throw new Error('INVALID_TAXONOMY');
  }
  return taxonomy;
}

function hit(text, keyword) {
  const k = keyword.toLowerCase();
  // ASCII keywords match whole words, so "ai" does not match "email"; CJK keywords match as substrings.
  return ASCII.test(k) ? new RegExp(`(^|[^a-z0-9])${escape(k)}([^a-z0-9]|$)`, 'u').test(text) : text.includes(k);
}

/** Tags whose keywords occur in `text`, with the keywords that matched. */
export function tagsIn(text, taxonomy) {
  const lower = String(text ?? '').toLowerCase();
  const found = [];
  for (const entry of taxonomy) {
    const keywords = entry.keywords.filter(keyword => hit(lower, keyword));
    if (keywords.length) found.push({ tag: entry.tag, title: entry.title, keywords });
  }
  return found;
}

/** Baseline need understanding: which capabilities does this request mention? */
export function understand({ title = '', description = '', acceptanceCriteria = [] }, taxonomy) {
  return tagsIn([title, description, ...acceptanceCriteria].join('\n'), taxonomy)
    .map(({ tag, title: needTitle, keywords }) => ({ id: tag, tag, title: needTitle, detail: `从需求中识别：${keywords.slice(0, 3).join('、')}` }));
}

/**
 * Tags an item carries: explicit ones plus those its text implies. Delivery
 * evidence counts only for the need it was verified against; its title names
 * the request, and inferring tags from that text would credit the whole squad
 * with every capability the request mentioned.
 */
export function itemTags(item, taxonomy) {
  if (item.source === 'delivery') return item.tags ?? [];
  return [...new Set([...(item.tags ?? []), ...tagsIn(`${item.title} ${item.detail ?? ''}`, taxonomy).map(found => found.tag)])];
}

const WEIGHT = { verified: 30, confirmed: 12, suggestion: 10 };

/**
 * Ranks community members for a request. Every candidate carries reasons a
 * person can check ("why me"), which needs they cover, and whether any of it
 * is verified by past accepted work.
 */
export function rank({ request, members, suggestions = [], excluded = new Set(), taxonomy, limit = 8 }) {
  const needs = request.data.needs ?? [];
  const candidates = [];
  for (const member of members) {
    const id = member.human.id;
    if (id === request.data.requesterHumanId || excluded.has(id)) continue;
    const profile = member.human.data.profile;
    const suggested = suggestions.filter(item => item.data.kind === 'candidate' && item.data.candidateHumanId === id);
    if (!profile && !suggested.length) continue;
    if (profile && profile.hoursPerWeek === 0 && !suggested.length) continue;
    const items = (profile?.items ?? []).filter(item => item.visibility === 'community');
    let score = 0, verified = 0;
    const needIds = [], reasons = [];
    for (const need of needs) {
      if (profile?.notDoing?.includes(need.tag)) continue;
      const matching = items.filter(item => itemTags(item, taxonomy).includes(need.tag)).sort((a, b) => Number(b.verified) - Number(a.verified));
      if (!matching.length) continue;
      const best = matching[0];
      score += best.verified ? WEIGHT.verified : WEIGHT.confirmed;
      if (best.verified) verified += 1;
      needIds.push(need.id);
      reasons.push(`「${need.title}」← ${best.verified ? '已验证：' : ''}${best.title}`);
    }
    if (suggested.length) {
      score += Math.min(2, suggested.length) * WEIGHT.suggestion;
      reasons.push(`被 ${suggested.length} 位成员推荐：${suggested[0].data.text.slice(0, 80)}`);
    }
    if (!needIds.length && !suggested.length) continue;
    const rewards = request.data.rewardTypes ?? [];
    if (rewards.length && profile?.openTo?.length && !rewards.some(type => profile.openTo.includes(type))) {
      score = Math.max(0, score - 5);
      reasons.push('合作方式可能不一致（请在预沟通中确认）');
    }
    if (profile && profile.hoursPerWeek === 0) reasons.push('档案显示目前没有可投入时间');
    candidates.push({ humanId: id, displayName: member.human.data.displayName, score, needIds, verified, reasons, suggested: suggested.length > 0 });
  }
  return candidates.sort((a, b) => b.score - a.score || b.verified - a.verified || a.displayName.localeCompare(b.displayName)).slice(0, limit);
}

/**
 * A proposed squad: greedily cover the request's needs with ranked candidates,
 * preferring people who already worked well together. Returns the roles and
 * whichever needs nobody in the community covers yet.
 */
export function planSquad({ request, candidates, edges = new Map() }) {
  const needs = request.data.needs ?? [];
  const uncovered = new Set(needs.map(need => need.id));
  const roles = [];
  const pool = [...candidates];
  while (uncovered.size && pool.length) {
    const together = candidate => roles.reduce((sum, role) => sum + (edges.get(edgeKey(role.humanId, candidate.humanId)) ?? 0), 0);
    pool.sort((a, b) => b.needIds.filter(id => uncovered.has(id)).length - a.needIds.filter(id => uncovered.has(id)).length || together(b) - together(a) || b.score - a.score);
    const next = pool.shift();
    const gain = next.needIds.filter(id => uncovered.has(id));
    if (!gain.length) break;
    gain.forEach(id => uncovered.delete(id));
    roles.push({ humanId: next.humanId, displayName: next.displayName, needIds: gain, title: gain.map(id => needs.find(need => need.id === id).title).join(' + ') });
  }
  return { roles, uncovered: needs.filter(need => uncovered.has(need.id)) };
}

export const edgeKey = (a, b) => [a, b].sort().join('|');

/**
 * Drafts profile items from a member's own community activity (RFC 0010 §6).
 * Only topics with enough participation become items; each item cites the
 * topics it came from. Nothing is published until the member confirms.
 */
export function draftFromActivity(signals, taxonomy, { minMessages = 3 } = {}) {
  return signals.filter(signal => signal.messages >= minMessages).slice(0, 12).map((signal, index) => {
    const tags = [...new Set([...(signal.tags ?? []), ...tagsIn(`${signal.title} ${signal.excerpt ?? ''}`, taxonomy).map(found => found.tag)])].slice(0, 8);
    return {
      id: `c-${index + 1}-${String(signal.topicId).toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 20) || 'topic'}`,
      kind: 'experience', title: `常在「${signal.title}」话题中分享经验`.slice(0, 120),
      detail: `${signal.messages} 条发言${signal.excerpt ? `，例如：“${signal.excerpt}”` : ''}`.slice(0, 600),
      tags, source: 'community-draft', visibility: 'community', verified: false, evidence: [{ topicId: String(signal.topicId).slice(0, 120) }],
    };
  });
}
