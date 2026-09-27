// Opportunity routing page (RFC 0010, RFC 0011). A member does one thing here:
// say what they want. Everything else that is still theirs to decide arrives in
// one list; everything else is their agent's job.
// All server data is rendered with textContent only.
const $ = selector => document.querySelector(selector);
const app = $('#app');
let base = null, state = null, tab = 'home', detail = null, who = null;
let authorizing = new URLSearchParams(location.search).get('authorize');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'className') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}
// DOM append() turns null into the text "null"; drop empty children everywhere.
for (const proto of [Element.prototype]) { const append = proto.append; proto.append = function (...nodes) { return append.apply(this, nodes.filter(node => node !== null && node !== undefined && node !== false)); }; }
function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 3200); }
const ERRORS = {
  HUMAN_ONLY: '这件事只能由本人做。', PREFLIGHT_REQUIRED: '请先回答预沟通，再接受邀请。', REQUESTER_ONLY: '只有需求方可以这样做。', NO_ACCEPTED_CANDIDATES: '还没有人接受邀请。',
  REASON_REQUIRED: '建议需要写理由。', DUPLICATE_SUGGESTION: '你已经推荐过这个人。', NOT_VISIBLE: '你看不到这个内容。', NOTHING_TO_REFINE: '没有要修改的内容。',
  DELEGATION_REQUIRED: '你还没有授权 Agent 代办这件事。', INVALID_TEXT: '内容为空或太长。', CANDIDATE_DECLINED: '这个人已经拒绝过这个需求。', RATE_LIMITED: '太频繁了，稍后再试。',
  DEVICE_CODE_INVALID: '这个接入请求不存在。', DEVICE_CODE_EXPIRED: '这个接入请求已经过期，请让 Agent 重新发起。', DEVICE_ALREADY_RESOLVED: '这个接入请求已经处理过了。',
  AGREEMENT_VERSION_MISMATCH: '协议版本已更新，请刷新页面。', INVITATION_CLOSED: '这个邀请已经处理过了。', REQUEST_NOT_OPEN: '这个需求已不在找人阶段。',
};
async function api(path, body) {
  const response = await fetch(`/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(ERRORS[data.error] ?? data.error ?? `HTTP ${response.status}`);
  return data;
}
const run = fn => async event => { event?.preventDefault?.(); try { await fn(); } catch (error) { toast(error.message); } };
const time = iso => iso ? new Date(iso).toLocaleString() : '';
const REWARD = { paid: '有偿', equity: '股份', exchange: '资源交换', volunteer: '公益' };
const STATUS = { open: '找人中', assigned: '小组进行中', review: '待验收', accepted: '已完成', invited: '已邀请', declined: '已拒绝', withdrawn: '已撤回', requested: '待回答', answered: '已回答', active: '生效', revoked: '已撤销' };
const SOURCE = { self: '本人填写', 'community-draft': '社区起草', 'agent-draft': 'Agent 起草', delivery: '交付验证' };
const badge = (text, tone = '') => h('span', { className: `status ${tone}` }, text);
const SCOPE_LABELS = [['profile:draft', '起草我的档案', true], ['request:draft', '起草和补全我的需求', true], ['suggest', '给别人的需求提建议', true], ['preflight:draft', '起草预沟通回答', true], ['squad:write', '在小组里提交交付物', true], ['route', '替我邀请候选人和组队', false]];
const chips = (needs, highlight = []) => h('div', { className: 'row' }, (needs ?? []).map(need => badge(need.title, highlight.includes(need.id) ? '' : 'warn')));

async function load() {
  base = await api('/state');
  $('#mode').textContent = base.mode === 'simulated' ? '模拟模式 · 虚构成员' : `FlareMo ${base.storeOrigin}`;
  $('#community-name').textContent = base.community?.name ?? '';
  $('#logout').hidden = !base.me;
  $('#whoami').textContent = base.me?.member?.human.data.displayName ?? base.me?.identity.displayName ?? '';
  // A different person (or none) starts from the one question again.
  const current = base.me?.member?.human.id ?? null;
  if (current !== who) { who = current; tab = 'home'; detail = null; }
  state = base.me?.member?.active ? await api('/router/state') : null;
  render();
}
$('#logout').addEventListener('click', run(async () => { await api('/logout', {}); await load(); }));

function render() {
  app.replaceChildren();
  if (base.mode === 'simulated' && location.protocol === 'https:') app.append(h('div', { className: 'notice' }, '公开演示：成员都是虚构的，任何人都可以用虚构身份或访客身份登录。请不要输入真实信息；演示数据会被重置。给你的 Agent 接入的说明见 ', h('a', { href: '/agents.md', target: '_blank', rel: 'noopener' }, '/agents.md'), '。'));
  if (!base.me) return app.append(loginView());
  if (!base.community) return app.append(h('div', { className: 'card' }, h('h2', {}, '演示社区还没有初始化'), h('p', { className: 'muted' }, '运营者会用评估框架初始化演示数据，请稍后再来。')));
  if (!base.me.member) {
    if (base.inviteRequired) return app.append(h('div', { className: 'card' }, h('h2', {}, '还不是社区成员'), h('p', {}, '请先在 ', h('a', { href: '/' }, '主页'), ' 用邀请链接加入社区。')));
    const name = h('input', { id: 'join-name', value: base.me.identity.displayName.replace(/（访客）$/u, ''), maxlength: 40 });
    return app.append(h('form', { className: 'card', onsubmit: run(async () => { await api('/join', { displayName: name.value }); await load(); }) }, h('h2', {}, `加入「${base.community.name}」`), h('label', { for: 'join-name' }, '你在社区里的名字'), name, h('p', {}, h('button', {}, '加入'))));
  }
  if (!base.me.member.active) return app.append(h('div', { className: 'card' }, h('h2', {}, '成员资格未生效'), h('p', {}, '你的成员资格已被暂停或移除。')));
  // An agent is waiting on this person's decision; nothing else matters until they make it.
  if (authorizing) {
    const view = h('div'); app.append(view);
    return authorizeView(view, authorizing).catch(error => view.append(h('div', { className: 'notice' }, error.message)));
  }
  const tabs = [['home', `我要什么${state.todo ? `（${state.todo}）` : ''}`], ['browse', '社区机会'], ['more', '更多']];
  app.append(h('nav', { className: 'tabs' }, tabs.map(([key, label]) => h('button', { className: tab === key ? 'on' : '', onclick: () => { tab = key; detail = null; render(); } }, label))));
  const view = h('div'); app.append(view);
  const views = { home: detail ? requestDetail : homeView, browse: detail ? requestDetail : browseView, more: moreView };
  views[tab](view).catch(error => view.append(h('div', { className: 'notice' }, error.message)));
}

/**
 * The first thing anyone sees. It has one job before the form: say what this
 * place is for. Then one way in, and a quieter second way for people who are
 * not on the roster — not two identical boxes competing for the same click.
 */
// A real community signs in with its own accounts. FlareMo has no redirect
// flow to send someone through, so the member makes a token there and brings it
// back once; the password never reaches this node. The addresses come from the
// node, so nothing here is written for one deployment.
function tokenLoginView() {
  const links = base.loginLinks ?? {};
  const token = h('input', { id: 'flaremo-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'memos_pat_…' });
  const open = (href, label, className) => h('a', { href, target: '_blank', rel: 'noopener', className }, label);
  return h('div', { className: 'entry' },
    h('div', { className: 'entry-body' },
      h('p', { className: 'eyebrow' }, base.community?.name ?? '机会路由'),
      h('h1', {}, '让社群里的每一个需求，', h('br'), h('em', {}, '都找到能把它做成的人。')),
      h('p', { className: 'lede' }, '用你的 ', h('b', {}, base.loginProvider?.replace(/^https?:\/\//u, '') ?? '社区'), ' 账号进入。密码不会经过这里：你在那边生成一个访问令牌，贴回来一次即可。'),
      h('ol', { className: 'entry-steps' },
        h('li', {}, '打开 ', open(links.token ?? links.signIn ?? '#', '账号设置 → 访问令牌', 'link'), '，新建一个令牌并复制。'),
        h('li', {}, '贴在下面，点「进入」。令牌用完即弃，我们不保存。')),
      h('form', { className: 'entry-form', onsubmit: run(async () => { await api('/login', { token: token.value.trim() }); await load(); }) },
        h('div', { className: 'field' }, h('span', { className: 'field-label' }, '访问令牌'), token, h('button', {}, '进入'))),
      h('p', { className: 'entry-alt' },
        '还没有账号？', open(links.register ?? '#', '去注册', 'link'),
        '　已登录但没有令牌？', open(links.signIn ?? '#', '去登录', 'link'))));
}

function loginView() {
  if (base.mode !== 'simulated') {
    if (base.loginKind === 'flaremo-token') return tokenLoginView();
    return h('div', { className: 'entry' }, h('div', { className: 'entry-body' }, h('p', { className: 'eyebrow' }, '需要登录'), h('h1', {}, '请先在主页登录'), h('p', { className: 'lede' }, h('a', { href: '/' }, '前往主页 →'))));
  }
  const select = h('select', { id: 'member' }, (base.demoMembers ?? []).map(member => h('option', { value: member.username }, member.displayName)));
  const guest = h('input', { id: 'guest-name', maxlength: 40, placeholder: '你的名字' });
  const slug = () => `guest-${Math.random().toString(36).slice(2, 8)}`;
  const asGuest = h('form', { className: 'entry-guest', hidden: true, onsubmit: run(async () => { await api('/login', { username: slug(), displayName: guest.value || '访客' }); await load(); }) },
    h('div', { className: 'field' }, guest, h('button', { className: 'secondary' }, '加入')));
  return h('div', { className: 'entry' },
    h('div', { className: 'entry-body' },
      h('p', { className: 'eyebrow' }, base.community?.name ?? '机会路由'),
      h('h1', {}, '让社群里的每一个需求，', h('br'), h('em', {}, '都找到能把它做成的人。')),
      h('p', { className: 'lede' }, '你说清楚要什么，网络把它拆成需要的能力、找到能做的人。接不接、成没成，始终由人决定。'),
      h('form', { className: 'entry-form', onsubmit: run(async () => { await api('/login', { username: select.value }); await load(); }) },
        h('div', { className: 'field' }, h('span', { className: 'field-label' }, '以成员身份进入'), select, h('button', {}, '进入'))),
      h('p', { className: 'entry-alt' },
        '演示里的成员都是虚构的，不需要密码。',
        h('button', { type: 'button', className: 'link', onclick: event => { asGuest.hidden = !asGuest.hidden; event.target.textContent = asGuest.hidden ? '或者用自己的名字加入' : '收起'; if (!asGuest.hidden) guest.focus(); } }, '或者用自己的名字加入')),
      asGuest));
}


// ---------- an agent is asking to act for you ----------
async function authorizeView(view, code) {
  const asked = await api(`/router/device/${code}`);
  const done = text => { authorizing = null; history.replaceState(null, '', location.pathname); toast(text); load(); };
  if (asked.status !== 'pending') return view.append(h('div', { className: 'card' }, h('h2', {}, '这个接入请求已经处理过了'), h('p', {}, h('button', { onclick: () => done('') }, '回到首页'))));

  const name = h('input', { id: 'dv-name', value: asked.agentName, maxlength: 120 });
  const boxes = SCOPE_LABELS.filter(([value]) => asked.scopes.includes(value))
    .map(([value, label, on]) => h('label', { className: 'check' }, h('input', { type: 'checkbox', value, checked: on && value !== 'route' }), label));
  const picked = () => boxes.map(label => label.firstChild).filter(box => box.checked).map(box => box.value);

  view.append(h('div', { className: 'card' },
    h('h1', {}, `「${asked.agentName}」想代表你接入`),
    h('div', { className: 'notice' }, '只有在你自己刚刚运行过接入命令时才点同意。如果这个链接是别人发给你的，请点拒绝——同意会让对方的 Agent 以你的名义行动。'),
    h('p', { className: 'muted' }, `请求编码 ${asked.userCode}，十分钟内有效。`),
    h('label', { for: 'dv-name' }, '给它起个名字（别人看到的就是这个）'), name,
    h('label', {}, '允许它做的事'), h('div', { className: 'row' }, boxes),
    h('p', { className: 'muted small' }, '起草的内容仍然要你确认。接受邀请和验收永远只能你本人做。随时可以在「更多 → 已签发的令牌」里撤销。'),
    h('div', { className: 'row' },
      h('button', { onclick: run(async () => { const result = await api(`/router/device/${code}/approve`, { scopes: picked(), name: name.value }); done(`已授权：${result.agentName}，回到你的终端就能用了`); }) }, '同意'),
      h('button', { className: 'danger', onclick: run(async () => { await api(`/router/device/${code}/deny`, {}); done('已拒绝'); }) }, '拒绝'))));
}

// ---------- the one thing: say what you want ----------
const requestRow = item => h('div', { className: 'cap-item' },
  h('div', { className: 'grow' },
    h('div', { className: 'row' }, h('b', {}, item.title), badge(STATUS[item.status] ?? item.status), item.mine ? badge('我提的') : null, item.invitedMe ? badge('邀请了我', 'warn') : null),
    h('p', { className: 'muted' }, `${item.requester} · ${time(item.createdAt)}${item.rewardTypes?.length ? ` · ${item.rewardTypes.map(reward => REWARD[reward]).join('、')}` : ''}`),
    chips(item.needs, item.needs.map(need => need.id))),
  h('button', { className: 'secondary', onclick: () => { detail = item.id; render(); } }, '查看'));

function askCard() {
  const text = h('textarea', { id: 'ask', required: true, maxlength: 4000, rows: 4, placeholder: '做一个香港招聘行业的 AI 情报产品，先验证雇主愿不愿意付费。\n- 两周内给出可演示的原型\n- 至少访谈 5 家本地雇主' });
  const rewards = Object.entries(REWARD).map(([value, label]) => h('label', { className: 'check' }, h('input', { type: 'checkbox', value }), label));
  const stage = h('select', { id: 'rq-stage' }, h('option', { value: 'explore' }, '探索'), h('option', { value: 'execute' }, '执行'));
  const source = h('select', { id: 'rq-source' }, [['member', '我自己的需求'], ['client', '企业客户'], ['lab', '实验室项目'], ['community-signal', '群里发现的线索']].map(([value, label]) => h('option', { value }, label)));
  const budget = h('input', { id: 'rq-budget', maxlength: 200, placeholder: '预算或回报的具体说明（可不填）' });
  const optional = h('div', { className: 'subcard', hidden: true },
    h('label', {}, '回报方式'), h('div', { className: 'row' }, rewards),
    h('div', { className: 'grid2' }, h('div', {}, h('label', { for: 'rq-stage' }, '阶段'), stage), h('div', {}, h('label', { for: 'rq-source' }, '来源'), source)),
    h('label', { for: 'rq-budget' }, '预算'), budget);
  const preview = h('div');
  const input = () => ({
    text: text.value, stage: stage.value, source: source.value, budget: budget.value || undefined,
    rewardTypes: rewards.map(label => label.firstChild).filter(box => box.checked).map(box => box.value),
  });
  return h('form', { className: 'card ask', onsubmit: run(async () => { const created = await api('/router/requests', input()); toast('已发布，网络开始找人'); detail = created.id; render(); }) },
    h('h1', {}, '你要什么？'),
    h('p', { className: 'muted' }, '用自己的话说清楚就够了。找人、预沟通、组队交给网络和你的 Agent——你只在最后确认拿到的是不是你要的。'),
    text,
    h('p', { className: 'muted small' }, '第一行会成为标题，以「-」开头的行会成为期望成果。'),
    h('p', { className: 'row' },
      h('button', {}, '发布'),
      h('button', { type: 'button', className: 'secondary', onclick: run(async () => { const { needs } = await api('/router/requests/understand', input()); preview.replaceChildren(h('label', {}, '网络识别出的能力需求'), needs.length ? chips(needs, needs.map(need => need.id)) : h('p', { className: 'muted' }, '还没识别出来。发布后可以补充，或者让你的 Agent 补。')); }) }, '先看看会拆成什么'),
      h('button', { type: 'button', className: 'link', onclick: () => { optional.hidden = !optional.hidden; } }, '回报、阶段、预算（可不填）')),
    optional, preview);
}

// ---------- the only list a member has to read ----------
const TODO_ACTION = { 'draft.confirm': '确认', 'consent.sign': '去签署', 'preflight.answer': '去回答', 'invitation.decide': '去决定', 'request.refine': '去补充', 'request.invite': '去邀请', 'squad.form': '去组队', 'review.accept': '去验收' };

async function todoCard() {
  const todo = await api('/router/todo');
  const card = h('div', { className: 'card' }, h('div', { className: 'row' }, h('h2', {}, '等我决定'), todo.mine ? badge(`${todo.mine} 件`, 'warn') : badge('没有')),
    h('p', { className: 'muted' }, todo.agents ? '只列你本人才能做的事。标注「Agent 会处理」的，你不用管。' : '只列你本人才能做的事。签发一个 Agent 令牌后，中间的协调就不用你做了。'));
  if (!todo.items.length) card.append(h('p', { className: 'muted' }, '没有待办。'));
  for (const item of todo.items) {
    const go = () => { detail = item.requestId ?? null; tab = 'home'; render(); };
    const buttons = item.type === 'draft.confirm'
      ? [h('button', { onclick: run(async () => { await api(`/router/drafts/${item.draftId}/confirm`, {}); toast('已确认'); await load(); }) }, '确认'),
        h('button', { className: 'secondary', onclick: run(async () => { await api(`/router/drafts/${item.draftId}/reject`, {}); toast('已拒绝'); await load(); }) }, '拒绝')]
      : item.type === 'consent.sign'
        ? [h('button', { onclick: run(async () => { const result = await api('/router/consent', { version: state.agreement.version }); toast(result.draft ? '已签署；起草的档案在这份列表里等你确认' : '已签署'); await load(); }) }, '签署成员协议')]
        : [h('button', { className: item.agentCovers ? 'secondary' : '', onclick: go }, item.agentCovers ? '我自己来' : TODO_ACTION[item.type] ?? '处理')];
    card.append(h('div', { className: 'cap-item' },
      h('div', { className: 'grow' }, h('div', { className: 'row' }, h('b', {}, item.title), item.agentCovers ? badge('Agent 会处理') : null), h('p', { className: 'muted' }, item.detail)),
      h('div', { className: 'row' }, buttons)));
  }
  return card;
}

async function homeView(view) {
  view.append(askCard());
  view.append(await todoCard());
  const mine = (await api('/router/requests')).filter(item => item.mine);
  if (mine.length) view.append(h('div', { className: 'card' }, h('h2', {}, '我提的需求'), mine.map(requestRow)));
}

async function browseView(view) {
  const list = await api('/router/requests');
  view.append(h('div', { className: 'card' }, h('h2', {}, '社区里的需求'), h('p', { className: 'muted' }, '你可以推荐合适的人，或者告诉需求方还缺什么。'),
    list.length ? list.map(requestRow) : h('p', { className: 'muted' }, '还没有需求。')));
}

// ---------- one request, one page ----------
async function requestDetail(view) {
  const data = await api(`/router/requests/${detail}`);
  const r = data.request.data;
  view.append(h('p', {}, h('button', { className: 'link', onclick: () => { detail = null; render(); } }, '← 返回')));
  view.append(h('div', { className: 'card' }, h('div', { className: 'row' }, h('h1', {}, r.title), badge(STATUS[r.status] ?? r.status)),
    h('p', { className: 'muted' }, `需求方：${data.requester}${r.rewardTypes?.length ? ` · 回报：${r.rewardTypes.map(reward => REWARD[reward]).join('、')}` : ''}${r.budget ? ` · 预算：${r.budget}` : ''}`), h('p', {}, r.description),
    r.acceptanceCriteria.length ? h('h3', {}, '期望成果') : null, r.acceptanceCriteria.length ? h('ul', {}, r.acceptanceCriteria.map(item => h('li', {}, item))) : null,
    h('h3', {}, '需要的能力'), r.needs.length ? chips(r.needs, r.needs.map(need => need.id)) : h('p', { className: 'muted' }, '还没识别出来。')));
  if (data.myMatch && !data.mine) view.append(invitationCard(data));
  if (data.mine && r.status === 'open') view.append(refineCard(data));
  if (data.mine && data.candidates) view.append(candidatesCard(data));
  if (data.mine && data.matches?.length) view.append(matchesCard(data));
  view.append(suggestionsCard(data));
  if (data.squad?.id && data.squad.visible !== false) view.append(await squadCard(data.squad, data.mine));
}
const answersText = (answers, needs) => `${answers.available ? '有兴趣' : '暂不参与'} · 每周 ${answers.hoursPerWeek} 小时 · 能负责：${answers.canOwn.map(id => needs.find(need => need.id === id)?.title ?? id).join('、') || '无'}${answers.constraints ? ` · 限制：${answers.constraints}` : ''}${answers.needsInput ? ` · 需要：${answers.needsInput}` : ''}`;

/** The invited member's own decision, on the same page as the request. */
function invitationCard(data) {
  const { myMatch: match, myPreflight: preflight } = data;
  const needs = data.request.data.needs;
  const card = h('div', { className: 'card' }, h('div', { className: 'row' }, h('h2', {}, '你收到了邀请'), badge(STATUS[match.data.status] ?? match.data.status)),
    h('h3', {}, '为什么找你'), h('ul', {}, match.data.reasons.map(reason => h('li', {}, reason))));
  if (preflight?.data.status === 'requested') {
    const available = h('input', { type: 'checkbox', checked: true });
    const hours = h('input', { type: 'number', min: 0, max: 80, value: 4, 'aria-label': '每周小时数' });
    const own = needs.map(need => h('label', { className: 'check' }, h('input', { type: 'checkbox', value: need.id, checked: match.data.needIds.includes(need.id) }), need.title));
    const constraints = h('input', { placeholder: '限制或不做的部分' });
    const needsInput = h('input', { placeholder: '开始前需要对方提供什么' });
    card.append(h('form', { className: 'subcard', onsubmit: run(async () => {
      await api(`/router/preflights/${preflight.id}/answer`, { answers: { available: available.checked, hoursPerWeek: Number(hours.value), canOwn: own.map(label => label.firstChild).filter(box => box.checked).map(box => box.value), constraints: constraints.value || undefined, needsInput: needsInput.value || undefined } });
      toast('预沟通已发送'); render();
    }) }, h('h3', {}, '预沟通'), h('label', { className: 'check' }, available, '我有兴趣、有时间参与'), h('label', {}, '每周能投入的小时数'), hours, h('label', {}, '我能负责'), h('div', { className: 'row' }, own), constraints, needsInput, h('p', {}, h('button', {}, '发送'))));
  } else if (preflight?.data.answers) card.append(h('p', { className: 'muted' }, `你的预沟通${preflight.data.draftedBy === 'agent' ? '（Agent 起草、你已确认）' : ''}：${answersText(preflight.data.answers, needs)}`));
  if (match.data.status === 'invited') card.append(h('div', { className: 'row' },
    h('button', { disabled: preflight?.data.status !== 'answered', onclick: run(async () => { await api(`/router/matches/${match.id}/respond`, { decision: 'accept' }); toast('已接受'); render(); }) }, '接受'),
    h('button', { className: 'secondary', onclick: run(async () => { await api(`/router/matches/${match.id}/respond`, { decision: 'decline' }); toast('已拒绝'); render(); }) }, '拒绝')));
  return card;
}

/** Everything that makes the request clearer, in one place. */
function refineCard(data) {
  const r = data.request.data;
  const needs = [...r.needs];
  const list = h('div', { className: 'row' });
  const draw = () => list.replaceChildren(...needs.map((need, index) => h('span', { className: 'status' }, need.title, ' ', h('button', { type: 'button', className: 'link', onclick: () => { needs.splice(index, 1); draw(); } }, '×'))));
  draw();
  const pick = h('select', { 'aria-label': '添加能力需求' }, state.taxonomy.map(entry => h('option', { value: entry.tag }, entry.title)));
  const criteria = h('textarea', { id: 'rq-criteria', placeholder: '每行一条，例如：两周内给出可演示的原型' }, r.acceptanceCriteria.join('\n'));
  const card = h('div', { className: 'card' }, h('h2', {}, '把需求说清楚'));
  if (data.clarify?.length) card.append(h('div', { className: 'notice' }, h('ul', {}, data.clarify.map(gap => h('li', {}, gap.why)))));
  else card.append(h('p', { className: 'muted' }, '这个需求已经够清楚了。想改还可以改。'));
  card.append(h('label', { for: 'rq-criteria' }, '期望成果（每行一条）'), criteria, h('label', {}, '需要的能力'), list,
    h('div', { className: 'row' }, pick,
      h('button', { type: 'button', className: 'secondary', onclick: () => { const entry = state.taxonomy.find(item => item.tag === pick.value); if (!needs.some(need => need.tag === entry.tag)) needs.push({ id: entry.tag, tag: entry.tag, title: entry.title }); draw(); } }, '添加'),
      h('button', { type: 'button', onclick: run(async () => { await api(`/router/requests/${detail}/refine`, { needs, acceptanceCriteria: criteria.value.split('\n').map(line => line.trim()).filter(Boolean) }); toast('已更新'); render(); }) }, '保存')));
  return card;
}

function candidatesCard(data) {
  const needs = data.request.data.needs;
  const boxes = [];
  const card = h('div', { className: 'card' }, h('h2', {}, '候选人'), h('p', { className: 'muted' }, '根据成员本人确认过的档案、验收过的交付，以及其他成员的推荐。每个人都附上"为什么是他"。授权过的 Agent 可以替你发出邀请。'));
  if (!data.candidates.length) card.append(h('p', { className: 'muted' }, '暂时没有匹配的成员。可以调整能力需求，或请大家推荐。'));
  for (const candidate of data.candidates) {
    const box = h('input', { type: 'checkbox', value: candidate.humanId, disabled: Boolean(candidate.matchStatus) });
    boxes.push(box);
    card.append(h('div', { className: 'cap-item' }, h('div', { className: 'grow' },
      h('div', { className: 'row' }, h('label', { className: 'check' }, box, h('b', {}, candidate.displayName)), badge(`匹配分 ${candidate.score}`), candidate.verified ? badge(`已验证 ${candidate.verified} 项`) : null, candidate.matchStatus ? badge(STATUS[candidate.matchStatus], 'warn') : null),
      chips(needs.filter(need => candidate.needIds.includes(need.id)), candidate.needIds), h('ul', {}, candidate.reasons.map(reason => h('li', { className: 'muted' }, reason))))));
  }
  if (data.plan?.roles?.length) card.append(h('h3', {}, '建议组合'), h('ul', {}, data.plan.roles.map(role => h('li', {}, `${role.displayName}：${role.title}`))));
  if (data.plan?.uncovered?.length) card.append(h('p', { className: 'notice' }, `社区里还没人覆盖：${data.plan.uncovered.map(need => need.title).join('、')}。可以请大家推荐。`));
  if (data.request.data.status === 'open') card.append(h('p', {}, h('button', { onclick: run(async () => { const humanIds = boxes.filter(box => box.checked).map(box => box.value); if (!humanIds.length) throw new Error('请先勾选候选人'); const result = await api(`/router/requests/${detail}/invite`, { humanIds }); toast(`已邀请 ${result.invited.length} 人，他们会先回答预沟通`); render(); }) }, '邀请所选（以我的名义）')));
  return card;
}

/** Someone accepted but is not in the squad yet; a squad can still grow. */
function joinable(data) {
  if (!['open', 'assigned'].includes(data.request.data.status)) return false;
  const seated = new Set(data.squad?.roles?.map(role => role.humanId) ?? []);
  return (data.matches ?? []).some(match => match.data.status === 'accepted' && !seated.has(match.data.humanId));
}

function matchesCard(data) {
  const r = data.request.data;
  return h('div', { className: 'card' }, h('h2', {}, '邀请进展'),
    data.matches.map(match => h('div', { className: 'cap-item' }, h('div', { className: 'grow' },
      h('div', { className: 'row' }, h('b', {}, match.name), badge(STATUS[match.data.status] ?? match.data.status, match.data.status === 'accepted' ? '' : 'warn'),
        match.data.invitedByAgentId ? badge('由 Agent 代发', 'warn') : null,
        match.preflight ? badge(`预沟通${STATUS[match.preflight.data.status]}${match.preflight.data.draftedBy === 'agent' ? '（Agent 起草、本人确认）' : ''}`) : null),
      match.preflight?.data.answers ? h('p', { className: 'muted' }, answersText(match.preflight.data.answers, r.needs)) : null))),
    joinable(data) ? h('p', {}, h('button', { onclick: run(async () => { await api(`/router/requests/${detail}/squad`, {}); toast('已加入小组'); await load(); }) }, data.squad?.roles ? '把新接受的人加入小组' : '用已接受的人组成小组')) : null);
}

function suggestionsCard(data) {
  const card = h('div', { className: 'card' }, h('h2', {}, '大家的建议'));
  for (const suggestion of data.suggestions) card.append(h('div', { className: 'cap-item' }, h('div', { className: 'grow' },
    h('div', { className: 'row' }, h('b', {}, suggestion.authorName), suggestion.actor.kind === 'Agent' ? badge('由 Agent 提出', 'warn') : null, badge({ candidate: '推荐人选', need: '补充需求', question: '提问' }[suggestion.data.kind])),
    h('p', {}, suggestion.data.kind === 'candidate' ? `推荐 ${suggestion.candidateName}：${suggestion.data.text}` : suggestion.data.kind === 'need' ? `${suggestion.data.need.title}：${suggestion.data.text}` : suggestion.data.text))));
  if (!data.suggestions.length) card.append(h('p', { className: 'muted' }, '还没有建议。'));
  if (['open', 'assigned'].includes(data.request.data.status)) {
    const kind = h('select', { id: 'sg-kind' }, h('option', { value: 'candidate' }, '推荐人选（可以是自己）'), h('option', { value: 'question' }, '提问'));
    const who = h('select', { id: 'sg-who' });
    api('/router/members').then(members => who.replaceChildren(...members.filter(member => member.humanId !== data.request.data.requesterHumanId).map(member => h('option', { value: member.humanId }, member.displayName)))).catch(() => {});
    const text = h('textarea', { id: 'sg-text', placeholder: '理由：他能覆盖哪些需求、做过什么' });
    card.append(h('form', { className: 'subcard', onsubmit: run(async () => { await api(`/router/requests/${detail}/suggestions`, { kind: kind.value, ...(kind.value === 'candidate' ? { candidateHumanId: who.value } : {}), text: text.value }); toast('已提交建议'); render(); }) },
      h('div', { className: 'grid2' }, h('div', {}, h('label', { for: 'sg-kind' }, '建议类型'), kind), h('div', {}, h('label', { for: 'sg-who' }, '推荐谁'), who)), h('label', { for: 'sg-text' }, '理由'), text, h('p', {}, h('button', {}, '提交建议'))));
  }
  return card;
}

async function squadCard(squad, mine) {
  const card = h('div', { className: 'card' }, h('div', { className: 'row' }, h('h2', {}, '小组'), badge(squad.status === 'active' ? '进行中' : '已结束')),
    h('ul', {}, squad.roles.map(role => h('li', {}, `${role.name}：${role.title}`))));
  for (const artifact of squad.artifacts) {
    card.append(h('div', { className: 'subcard' }, h('div', { className: 'row' }, h('b', {}, artifact.title), badge({ submitted: '待验收', finalized: '已验收', withdrawn: '已退回' }[artifact.data.status] ?? artifact.data.status), artifact.data.producerKind === 'Agent' ? badge(`由 ${artifact.producerName} 生成（主人 ${artifact.principalName}）`, 'warn') : badge(`由 ${artifact.producerName} 提交`)),
      h('pre', {}, artifact.content)));
    if (mine && artifact.data.status === 'submitted' && squad.request.status === 'review') {
      const statement = h('textarea', { id: `rv-${artifact.id.slice(9, 17)}` }, '满足期望成果。');
      card.append(h('label', { for: `rv-${artifact.id.slice(9, 17)}` }, '验收说明'), statement, h('div', { className: 'row' },
        h('button', { onclick: run(async () => { const result = await api(`/router/artifacts/${artifact.id}/review`, { outcome: 'accepted', statement: statement.value }); toast(`已验收；${result.evidence.length} 项能力被验证`); await load(); }) }, '验收通过'),
        h('button', { className: 'secondary', onclick: run(async () => { await api(`/router/artifacts/${artifact.id}/review`, { outcome: 'changes-requested', statement: statement.value }); toast('已要求修改'); render(); }) }, '要求修改')));
    }
  }
  if (squad.status === 'active') {
    const title = h('input', { id: 'af-title', placeholder: '交付物标题' });
    const content = h('textarea', { id: 'af-content', placeholder: 'Markdown 内容' });
    card.append(h('form', { className: 'subcard', onsubmit: run(async () => { await api(`/router/squads/${squad.id}/artifacts`, { title: title.value, content: content.value }); toast('已提交'); render(); }) }, h('h3', {}, '提交交付物'), title, content, h('p', {}, h('button', {}, '提交'))));
  }
  return card;
}

// ---------- everything you rarely touch ----------
async function moreView(view) {
  await profileCard(view);
  await agentsCard(view);
  await metricsCard(view);
}

async function profileCard(view) {
  const agreement = state.agreement, consent = state.consent;
  view.append(h('div', { className: 'card' }, h('div', { className: 'row' }, h('h2', {}, agreement.title), consent?.status === 'active' ? badge('已签署') : badge('未签署', 'warn')), h('ul', {}, agreement.points.map(point => h('li', {}, point))),
    consent?.status === 'active' ? h('button', { className: 'danger', onclick: run(async () => { if (!confirm('撤回后，社区起草的档案条目会被删除。继续？')) return; await api('/router/consent/withdraw', {}); toast('已撤回'); await load(); }) }, '撤回同意')
      : h('button', { onclick: run(async () => { const result = await api('/router/consent', { version: agreement.version }); toast(result.draft ? '已签署；社区起草的档案在「等我决定」里' : '已签署'); await load(); }) }, '签署成员协议')));
  const profile = state.profile ?? { items: [], hoursPerWeek: 0, openTo: [], notDoing: [] };
  const items = profile.items.map(item => ({ ...item }));
  const list = h('div', { className: 'caps' });
  const draw = () => list.replaceChildren(...items.map((item, index) => {
    const title = h('input', { value: item.title, disabled: item.verified, 'aria-label': '标题', oninput: event => { item.title = event.target.value; } });
    const detailInput = h('input', { value: item.detail ?? '', disabled: item.verified, 'aria-label': '说明', oninput: event => { item.detail = event.target.value; } });
    const visibility = h('select', { 'aria-label': '可见范围', onchange: event => { item.visibility = event.target.value; } }, h('option', { value: 'community', selected: item.visibility === 'community' }, '社区可见'), h('option', { value: 'private', selected: item.visibility === 'private' }, '仅自己'));
    return h('div', { className: 'cap-edit' }, h('div', { className: 'row' }, badge(SOURCE[item.source] ?? item.source, item.source === 'delivery' ? '' : 'warn'), item.verified ? badge('已验证') : null, visibility, h('button', { type: 'button', className: 'link', onclick: () => { items.splice(index, 1); draw(); } }, '删除')), title, detailInput);
  }));
  draw();
  const hours = h('input', { type: 'number', id: 'pf-hours', min: 0, max: 80, value: profile.hoursPerWeek });
  const openTo = Object.entries(REWARD).map(([value, label]) => h('label', { className: 'check' }, h('input', { type: 'checkbox', value, checked: profile.openTo.includes(value) }), label));
  view.append(h('form', { className: 'card', onsubmit: run(async () => { await api('/router/profile', { profile: { items, hoursPerWeek: Number(hours.value), openTo: openTo.map(label => label.firstChild).filter(box => box.checked).map(box => box.value), notDoing: profile.notDoing } }); toast('档案已保存'); await load(); }) },
    h('h2', {}, '我的档案'), h('p', { className: 'muted' }, '别人找你时看到的就是这些。每条都标了来源；"交付验证"是需求方验收后自动加入的，只能改可见范围。你的 Agent 也可以替你起草。'),
    list, h('p', {}, h('button', { type: 'button', className: 'secondary', onclick: () => { items.push({ kind: 'skill', title: '新条目', detail: '', tags: [], source: 'self', visibility: 'community', verified: false }); draw(); } }, '添加条目')),
    h('div', { className: 'grid2' }, h('div', {}, h('label', { for: 'pf-hours' }, '每周可投入小时（0 表示暂不接）'), hours), h('div', {}, h('label', {}, '接受的回报方式'), h('div', { className: 'row' }, openTo))),
    h('p', {}, h('button', {}, '保存档案'))));
}

async function agentsCard(view) {
  const out = h('div');
  const name = h('input', { id: 'ag-name', value: `${base.me.member.human.data.displayName} 的 Agent`, maxlength: 120 });
  const scopes = SCOPE_LABELS.map(([value, label, on]) => h('label', { className: 'check' }, h('input', { type: 'checkbox', value, checked: on }), label));
  const picked = () => scopes.map(label => label.firstChild).filter(box => box.checked).map(box => box.value);
  view.append(h('form', { className: 'card', onsubmit: run(async () => {
    const { instructions } = await api('/router/pairing', { name: name.value, scopes: picked() });
    out.replaceChildren(
      h('div', { className: 'notice' }, '把下面整段复制给你的 Agent —— Codex、Claude、ChatGPT，哪个都行。它自己会完成接入。'),
      h('pre', {}, instructions),
      h('p', { className: 'row' },
        h('button', { type: 'button', onclick: run(async () => { await navigator.clipboard.writeText(instructions); toast('已复制'); }) }, '复制'),
        h('span', { className: 'muted small' }, '配对码 10 分钟内有效、只能用一次。换成令牌后它就作废了，留在聊天记录里也没用。')));
    toast('已生成');
  }) }, h('h2', {}, '连接我的 Agent'), h('p', { className: 'muted' }, '勾上的事情你的 Agent 可以做，其中起草的内容仍要你确认。接受邀请和验收永远只能你本人做。30 天有效，随时可以撤销。'),
  h('label', { for: 'ag-name' }, 'Agent 名字'), name, h('label', {}, '允许它做的事'), h('div', { className: 'row' }, scopes),
  h('p', { className: 'muted small' }, '「替我邀请候选人和组队」默认不勾：勾上以后，你只要说清楚需求，找人和组队就不用你再点了；不勾就由你自己在需求页上做。'),
  h('p', {}, h('button', {}, '生成接入指令')), out));
  const tokens = await api('/router/agents');
  view.append(h('div', { className: 'card' }, h('h2', {}, '已签发的令牌'), tokens.length ? tokens.map(token => h('div', { className: 'cap-item' }, h('div', { className: 'grow' }, h('div', { className: 'row' }, h('b', {}, token.agentName), badge(STATUS[token.status] ?? token.status, token.status === 'active' ? '' : 'bad')), h('p', { className: 'muted' }, `${token.scopes.join('、')} · 有效至 ${time(token.expiresAt)}`)),
    token.status === 'active' ? h('button', { className: 'danger', onclick: run(async () => { await api(`/router/agents/tokens/${token.tokenId}/revoke`, {}); toast('已撤销'); await load(); }) }, '撤销') : null)) : h('p', { className: 'muted' }, '还没有签发。')));
}

async function metricsCard(view) {
  const m = await api('/router/metrics');
  const rows = [['机会', m.opportunities], ['已匹配', m.matched], ['发出邀请', m.invitations], ['接受邀请', m.accepted], ['接受率', m.acceptanceRate === null ? '—' : `${m.acceptanceRate}%`], ['组成小组', m.squads], ['完成交付', m.delivered], ['经验证的能力', m.verifiedCapabilities], ['社区建议', m.suggestions], ['合作关系', m.collaborationEdges], ['成员', m.members], ['已确认档案', m.profilesConfirmed], ['已签署协议', m.consented], ['从提需求到首个接受（中位数）', m.medianMsToFirstAccept === null ? '—' : `${Math.round(m.medianMsToFirstAccept / 60000)} 分钟`]];
  view.append(h('div', { className: 'card' }, h('h2', {}, '看板'), h('p', { className: 'muted' }, '衡量网络有没有把需求交到人手里；Agent 数量不是成果。'), h('div', { className: 'table' }, h('table', {}, rows.map(([label, value]) => h('tr', {}, h('td', {}, label), h('td', { className: 'mono' }, String(value))))))));
}

load().catch(error => app.replaceChildren(h('div', { className: 'notice' }, error.message)));
