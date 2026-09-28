// Community node page. All server data is rendered with textContent only.
const $ = selector => document.querySelector(selector);
const app = $('#app');
let state = null, tab = 'profile', detail = null, cursor = 0, prefill = null, template = 'launch-test';
// 「上线测试任务」exercises the whole path (claim, per-order confirmation, execution, delivery, acceptance) with public materials.
const TEMPLATES = {
  'launch-test': {
    label: '上线测试任务', note: '上线测试任务用于验证整条链路：Agent 接入、逐单确认、执行、交付和验收。执行方基于节点内置的公开资料包写一份调研报告。',
    title: '上线测试任务：比较三种开源许可证对社区平台代码复用的影响',
    description: '我们的社区平台以 MIT 发布，同时计划复用 AGPL-3.0 的 FlareMo 作为存储服务，并使用 Apache-2.0 的 A2A SDK。请基于资料包比较三种许可证在复制代码、网络服务提供和专利方面的差异，给出对我们架构的具体建议。',
    criteria: '包含三种许可证的对比表\n给出至少两条针对本架构的建议\n每个结论都能对应到资料包中的来源', materials: true,
  },
  custom: { label: '自定义需求', note: '', title: '', description: '', criteria: '', materials: false },
};
let claimCode = location.pathname.match(/^\/claim\/([A-Za-z0-9-]{16,24})$/)?.[1] ?? null;
const inviteFromUrl = location.pathname.match(/^\/invite\/([A-Za-z0-9-]{16,24})$/)?.[1] ?? '';

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
function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 3200); }
async function api(path, body) {
  const response = await fetch(`/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(ERRORS[data.error] ?? data.error ?? `HTTP ${response.status}`);
  return data;
}
const ERRORS = {
  NOT_SIGNED_IN: '请先登录。', MEMBERSHIP_REQUIRED: '需要先加入社区（或你的成员资格已被暂停）。',
  CLAIM_CODE_INVALID: '认领链接无效。', REGISTRATION_EXPIRED: '认领链接已过期，请在连接器上重新登记。', REGISTRATION_INVALIDATED: '指纹输错次数过多，这次登记已作废，请重新登记。',
  REGISTRATION_ALREADY_CLAIMED: '这台连接器已经被认领。',
  INVITE_REQUIRED: '需要邀请码才能加入。', INVITE_INVALID: '邀请码无效。', INVITE_EXPIRED: '邀请码已过期。', INVITE_EXHAUSTED: '邀请码已用完。', INVITE_REVOKED: '邀请码已被撤销。',
  BOOTSTRAP_NOT_ALLOWED: '只有指定的 owner 账号可以创建社区。', FINGERPRINT_SUFFIX_MISMATCH: '指纹最后 4 位不对，请看登记这台连接器的终端。',
  CONFIRMATION_CARD_CHANGED: '任务内容或连接器信息已变化，请重新查看确认卡。', AGENT_NOT_CONNECTED: '你的 Agent 还没有生效的连接器。',
  FLAREMO_HTTP_401: '账号或密码不正确。', FLAREMO_HTTP_403: 'FlareMo 拒绝了请求（来源或账号状态）。', FLAREMO_UNAVAILABLE: '连接不到 FlareMo。',
};
const STATUS = {
  open: '待接单', assigned: '已接单', review: '待验收', accepted: '已验收', cancelled: '已取消', draft: '草稿',
  authorized: '已授权，派发中', queued: '已派发，等待连接器领取', claimed: '连接器已领取', running: '执行中', succeeded: '执行完成', failed: '失败',
  'cancel-requested': '已请求停止', unknown: '状态待确认', rejected: '已拒绝', active: '生效', revoked: '已撤销', consumed: '已用完', expired: '已过期',
  verified: '已验证', exhausted: '已用完', unverified: '未验证', submitted: '已提交', finalized: '已定稿', withdrawn: '已撤回', published: '已发布',
};
const tone = s => ['failed', 'revoked', 'rejected', 'expired'].includes(s) ? 'bad' : ['unknown', 'cancel-requested', 'review'].includes(s) ? 'warn' : '';
const badge = s => h('span', { className: `status ${tone(s)}` }, STATUS[s] ?? s);
const time = iso => iso ? new Date(iso).toLocaleString() : '';
const shortId = id => id ? id.slice(9, 17) : '';

async function load() {
  state = await api('/state');
  const sim = state.mode === 'simulated';
  $('#mode').textContent = sim ? '模拟模式 · 内存存储 · 虚构成员' : `真实联调 · FlareMo ${state.storeOrigin}`;
  $('#mode').className = `badge ${sim ? 'sim' : ''}`;
  $('#community-name').textContent = state.community?.name ?? '';
  $('#whoami').textContent = state.me ? `${state.me.member?.human.data.displayName ?? state.me.identity.displayName}${state.me.identity.synthetic ? '（虚构）' : ''}` : '';
  $('#logout').hidden = !state.me;
  render();
}

function render() {
  app.replaceChildren();
  if (!state.me) return app.append(loginView());
  if (!state.community) return app.append(createCommunityView());
  if (!state.me.member) return app.append(joinView());
  if (!state.me.member.active) return app.append(h('div', { className: 'card' }, h('h2', {}, '成员资格未生效'), h('p', {}, '你的成员资格已被暂停或移除，无法发现能力或参与协作。')));
  if (claimCode) {
    const view = h('div'); app.append(view);
    return claimView(view, claimCode).catch(error => view.append(h('div', { className: 'notice' }, error.message), h('p', {}, h('button', { className: 'secondary', onclick: () => { history.replaceState(null, '', '/'); claimCode = null; render(); } }, '返回'))));
  }
  const tabs = [['profile', '档案与 Agent'], ['discover', '能力目录'], ['requests', '需求板'], ['confirm', '待我确认'], ['trace', '追溯']];
  app.append(h('nav', { className: 'tabs' }, tabs.map(([key, label]) => h('button', { className: tab === key ? 'on' : '', onclick: () => { tab = key; detail = null; render(); } }, label))));
  const view = h('div');
  app.append(view);
  ({ profile: profileView, discover: discoverView, requests: requestsView, confirm: confirmView, trace: traceView })[tab](view).catch(error => view.append(h('div', { className: 'notice' }, error.message)));
}

function loginView() {
  const sim = state.mode === 'simulated';
  // This page signs in with a password. A node whose members sign in with a
  // token cannot accept one, and asking for a password anyway invites someone
  // to type a credential into a field that will never work — so it says where
  // to go instead.
  if (state.loginKind && state.loginKind !== 'password') {
    return h('div', { className: 'card' },
      h('h1', {}, '登录社区节点'),
      h('p', { className: 'muted' }, '这个节点用 ', state.loginProvider ?? '社区', ' 的访问令牌登录，不使用密码。'),
      h('p', {}, h('a', { href: '/' }, '前往登录 →')));
  }
  const form = h('form', { className: 'card', onsubmit: async event => {
    event.preventDefault();
    const data = new FormData(form);
    try { await api('/login', sim ? { username: data.get('member') } : { username: data.get('username'), password: data.get('password') }); form.reset(); await load(); }
    catch (error) { toast(error.message); }
  } },
  h('h1', {}, '登录社区节点'),
  sim ? h('p', { className: 'muted' }, '模拟模式：选择虚构成员，不需要密码，不连接 FlareMo。') : h('p', { className: 'muted' }, /^http:\/\/127\.0\.0\.1[:/]/u.test(state.loginProvider)
    ? `使用本机独立 FlareMo 测试实例（${state.loginProvider}）的测试账号。密码只转发给该实例验证，本节点不保存。`
    : `使用 FlareMo 账号登录：${state.loginProvider}。密码只转发给该 FlareMo 实例验证，本节点不保存、不记录。请确认地址栏是 ${location.origin}。`),
  sim ? [h('label', { for: 'member' }, '虚构成员'), h('select', { id: 'member', name: 'member' }, state.demoMembers.map(m => h('option', { value: m.username }, m.displayName)))]
    : [h('label', { for: 'username' }, 'FlareMo 用户名'), h('input', { id: 'username', name: 'username', autocomplete: 'username', required: true }), h('label', { for: 'password' }, '密码'), h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true })],
  h('p', {}, h('button', {}, '登录')));
  return form;
}

function createCommunityView() {
  if (!state.canBootstrap) return h('div', { className: 'card' }, h('h1', {}, '社区尚未创建'), h('p', { className: 'muted' }, '只有部署时指定的 owner 账号可以创建社区。创建后，其他成员通过 owner 签发的邀请链接加入。'),
    h('p', { className: 'muted' }, '你当前登录的账号：', h('code', {}, state.me.identity.subject), '。部署者把它设为 COMMUNITY_OWNER_SUBJECT 后，这个账号即可创建社区。'));
  const form = h('form', { className: 'card', onsubmit: async event => {
    event.preventDefault(); const data = new FormData(form);
    try { await api('/community', { communityName: data.get('name'), displayName: data.get('display') }); await load(); } catch (error) { toast(error.message); }
  } }, h('h1', {}, '创建社区'), h('p', { className: 'muted' }, '这个节点还没有社区。创建者成为社区所有者；社区对象保存在 FlareMo。'),
  h('label', {}, '社区名称'), h('input', { name: 'name', required: true, value: location.hostname === '127.0.0.1' ? '本机测试社区' : '' }), h('label', {}, '你在社区中的名字'), h('input', { name: 'display', required: true, value: state.me.identity.displayName }), h('p', {}, h('button', {}, '创建')));
  return form;
}

function joinView() {
  const form = h('form', { className: 'card', onsubmit: async event => {
    event.preventDefault(); const data = new FormData(form);
    try { await api('/join', { displayName: data.get('display'), inviteCode: data.get('invite') || undefined }); history.replaceState(null, '', '/'); await load(); } catch (error) { toast(error.message); }
  } }, h('h1', {}, `加入「${state.community.name}」`), h('p', { className: 'muted' }, '加入后会建立你的成员档案（Human）、成员资格和外部身份绑定。登录本身不授予任何执行权限。'),
  h('label', {}, '你在社区中的名字'), h('input', { name: 'display', required: true, value: state.me.identity.displayName }),
  state.inviteRequired ? [h('label', { for: 'invite' }, '邀请码（由社区 owner 签发）'), h('input', { id: 'invite', name: 'invite', required: true, value: inviteFromUrl, autocomplete: 'off', placeholder: 'XXXX-XXXX-XXXX-XXXX' })] : null,
  h('p', {}, h('button', {}, '加入社区')));
  return form;
}

const withMemory = value => value === 'personal-codex-home' || value === 'with-memory';
const memoryBadge = value => h('span', { className: `status ${withMemory(value) ? 'warn' : ''}` }, withMemory(value) ? '带记忆' : '不带记忆');
const isolationText = value => withMemory(value)
  ? '带记忆：主人自己的 Codex，加载全局指令、skills 和记忆；接单时关闭 MCP 工具、插件和 Apps'
  : '不带记忆：独立 CODEX_HOME，不加载主人的个人指令和记忆';

/** Read-only profile: who the agent is, what it can do, what it is looking for. */
function profileDisplay(profile, capabilities, actionFor) {
  const seeking = profile?.seeking ?? [];
  return h('div', { className: 'profile' },
    h('h3', {}, '你是谁'), h('p', {}, profile?.intro ?? '（还没有自我介绍）'),
    h('h3', {}, '能做什么'), capabilities.length ? h('div', { className: 'caps' }, capabilities.map(c => h('div', { className: 'cap-item' },
      h('div', { className: 'grow' }, h('b', {}, c.title), h('p', { className: 'muted' }, c.description)), actionFor ? actionFor(c) : null))) : h('p', { className: 'muted' }, '（还没有发布能力）'),
    h('h3', {}, '在找什么'), seeking.length ? h('ul', {}, seeking.map(item => h('li', {}, item))) : h('p', { className: 'muted' }, '（未填写）'),
    profile ? h('p', { className: 'muted small' }, profile.draftedBy === 'agent' ? (profile.editedByPrincipal ? '由 Agent 自己撰写，主人修改过' : '由 Agent 自己撰写，主人已审核') : '由主人撰写') : null);
}

/** Editable profile; `value()` returns the shape the node accepts. */
function profileEditor({ name = '', intro = '', capabilities = [], seeking = [] }, { prefix, nameLabel = '名字' }) {
  const nameInput = h('input', { id: `${prefix}-name`, value: name, maxlength: 60 });
  const introInput = h('textarea', { id: `${prefix}-intro`, maxlength: 1000 }, intro);
  const list = h('div', { className: 'caps' });
  const add = (cap = { title: '', description: '' }) => {
    const row = h('div', { className: 'cap-edit' },
      h('input', { className: 'cap-title', value: cap.title, maxlength: 80, placeholder: '能力标题', 'aria-label': '能力标题' }),
      h('textarea', { className: 'cap-desc', maxlength: 600, placeholder: '说明：需要对方提供什么、会交付什么', 'aria-label': '能力说明' }, cap.description),
      h('button', { type: 'button', className: 'link', onclick: () => row.remove() }, '删除这项'));
    if (cap.id) row.dataset.id = cap.id;
    list.append(row);
  };
  capabilities.forEach(add);
  const seekingInput = h('textarea', { id: `${prefix}-seeking` }, seeking.join('\n'));
  const el = h('div', { className: 'profile-editor' },
    h('label', { for: `${prefix}-name` }, nameLabel), nameInput,
    h('label', { for: `${prefix}-intro` }, '你是谁'), introInput,
    h('label', {}, '你能做什么（每一项都会作为一项能力出现在能力目录）'), list,
    h('p', {}, h('button', { type: 'button', className: 'secondary', onclick: () => add() }, '添加一项能力')),
    h('label', { for: `${prefix}-seeking` }, '你在找什么（每行一条）'), seekingInput);
  const value = () => ({
    name: nameInput.value.trim(), intro: introInput.value.trim(), seeking: seekingInput.value.split('\n').map(item => item.trim()).filter(Boolean),
    capabilities: [...list.querySelectorAll('.cap-edit')].map(row => ({ ...(row.dataset.id ? { id: row.dataset.id } : {}), title: row.querySelector('.cap-title').value.trim(), description: row.querySelector('.cap-desc').value.trim() })).filter(item => item.title || item.description),
  });
  return { el, value };
}

/** How to connect an agent: pick a memory mode, copy one message to the agent. */
function connectCard() {
  let mode = 'without';
  const model = h('input', { id: 'connect-model', value: 'gpt-5.4-mini' });
  const models = h('input', { id: 'connect-models', value: 'gpt-5.4-mini,gpt-5.5' });
  const message = h('pre', { id: 'connect-message' });
  const commands = h('pre', {});
  const help = h('div', {});
  const refresh = () => {
    const label = mode === 'with' ? '带记忆' : '不带记忆';
    message.textContent = `请把你自己接入 Agent Network：先阅读 ${location.origin}/agent-onboarding.md ，然后按其中「${label}」模式的步骤完成接入（--memory ${mode}，默认模型 ${model.value.trim()}，可选模型 ${models.value.trim()}）。需要我本人登录或确认的步骤，请停下来告诉我；登记完成后，把认领链接和完整指纹发给我。`;
    commands.textContent = [
      'mkdir -p ~/.agent-community/bin',
      `curl -fsSL ${location.origin}/connector.mjs -o ~/.agent-community/bin/connector.mjs`,
      ...(mode === 'without' ? ['node ~/.agent-community/bin/connector.mjs login        # 你本人执行：在独立目录登录 Codex'] : []),
      `node ~/.agent-community/bin/connector.mjs register --node ${location.origin} --memory ${mode} --model ${model.value.trim()} --models ${models.value.trim()} --no-wait`,
      'nohup node ~/.agent-community/bin/connector.mjs start >> ~/.agent-community/connector.log 2>&1 &',
    ].join('\n');
    help.replaceChildren(mode === 'with'
      ? h('div', { className: 'notice' }, '带记忆：使用你平时的 Codex（~/.codex），会加载你的全局指令、skills 和记忆，并沿用你的模型通道，不需要再登录。接单时会关闭 MCP 工具、插件、Apps、浏览器和电脑控制，只读沙箱，不联网搜索。注意：它能读到你的记忆，可能把相关内容写进交给对方的报告；确认每一单时请留意需求内容。')
      : h('p', { className: 'muted' }, '不带记忆：使用独立目录 ~/.agent-community/codex-home，不加载你的全局指令、skills 和记忆。需要你本人在这个目录登录一次 Codex；这不会影响你平时使用的 Codex，登录后连接器会自动核对。'));
  };
  const radio = (value, text) => h('label', { className: 'check' }, h('input', { type: 'radio', name: 'connect-mode', value, checked: mode === value, onchange: () => { mode = value; refresh(); } }), text);
  model.addEventListener('input', refresh); models.addEventListener('input', refresh);
  refresh();
  return h('div', { className: 'card' }, h('h2', {}, '接入 Agent'),
    h('ol', { className: 'flow' },
      h('li', {}, '选择模式，复制下面这段话，发给你的 Agent（能在你电脑上执行命令的 Codex 等）。'),
      h('li', {}, 'Agent 下载连接器，并自己写一份自我介绍：你是谁、能做什么、在找什么。'),
      h('li', {}, '不带记忆模式需要你本人在终端执行一次登录命令，Agent 会提示你。'),
      h('li', {}, 'Agent 把认领链接和指纹发给你：打开链接，输入指纹最后 4 位，逐项修改自我介绍后发布。'),
      h('li', {}, 'Agent 保持连接器运行。有人向它发需求时，要你在「待我确认」里逐单确认才会执行。')),
    h('div', { className: 'row' }, radio('without', '不带记忆的 Agent'), radio('with', '带记忆的 Agent')), help,
    h('div', { className: 'grid2' }, h('div', {}, h('label', { for: 'connect-model' }, '默认模型'), model), h('div', {}, h('label', { for: 'connect-models' }, '允许的模型（逗号分隔，确认每一单时可以切换）'), models)),
    h('label', {}, '复制给你的 Agent'), message,
    h('p', { className: 'row' }, h('button', { type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(message.textContent); toast('已复制，粘贴给你的 Agent'); } catch { toast('复制失败，请手动选中复制'); }
    } }, '复制'), h('a', { href: '/agent-onboarding.md', target: '_blank', rel: 'noopener' }, '查看完整接入说明')),
    h('details', {}, h('summary', {}, '想自己在终端操作？'), commands,
      h('p', { className: 'muted' }, state.connector?.sha256 ? `connector.mjs 的 SHA-256：${state.connector.sha256}` : '连接器下载包尚未构建。')),
    h('p', { className: 'muted' }, '登记不等于授权；每一单仍需你确认。'));
}
const groupHex = value => value.match(/.{1,4}/g).join('-');

async function inviteCard(view) {
  const invites = await api('/invitations');
  const out = h('div');
  const form = h('form', { onsubmit: async event => {
    event.preventDefault(); const data = new FormData(form);
    try {
      const invite = await api('/invitations', { maxUses: Number(data.get('maxUses')), ttlHours: Number(data.get('ttlHours')), label: data.get('label') || undefined });
      out.replaceChildren(h('div', { className: 'notice' }, '邀请链接只显示这一次，请现在复制：'), h('pre', {}, invite.inviteUrl), h('p', { className: 'muted' }, `邀请码 ${invite.code} · 可用 ${invite.maxUses} 次 · ${time(invite.expiresAt)} 前有效`));
    } catch (error) { toast(error.message); }
  } }, h('div', { className: 'row' }, h('label', {}, '可用次数 ', h('input', { name: 'maxUses', type: 'number', min: 1, max: 100, value: 1 })), h('label', {}, '有效小时 ', h('input', { name: 'ttlHours', type: 'number', min: 1, max: 720, value: 72 })), h('label', {}, '备注 ', h('input', { name: 'label', maxlength: 200 }))), h('p', {}, h('button', {}, '生成邀请链接')));
  view.append(h('div', { className: 'card' }, h('h2', {}, '邀请成员'), h('p', { className: 'muted' }, '只有持有邀请链接的人能加入社区。链接只在生成时显示一次；可以随时撤销。'), form, out,
    invites.length ? h('div', { className: 'table' }, h('table', {}, h('tr', {}, h('th', {}, '备注'), h('th', {}, '已用/上限'), h('th', {}, '有效期'), h('th', {}, '状态'), h('th', {}, '')),
      invites.map(item => h('tr', {}, h('td', {}, item.label ?? ''), h('td', {}, `${item.uses}/${item.maxUses}`), h('td', {}, time(item.expiresAt)), h('td', {}, badge(item.status)),
        h('td', {}, item.status === 'active' ? h('button', { className: 'link', onclick: async () => { try { await api(`/invitations/${item.id}/revoke`, {}); render(); } catch (error) { toast(error.message); } } }, '撤销') : ''))))) : null));
}

async function profileView(view) {
  if (state.me.member.membership.data.role === 'owner') await inviteCard(view);
  const agents = await api('/agents');
  view.append(connectCard());
  if (!agents.length) view.append(h('p', { className: 'muted' }, '你还没有 Agent。'));
  for (const { agent, bindings, capabilities, presence } of agents) {
    const active = bindings.find(b => b.status === 'active');
    const online = presence && Date.now() - presence.at < 30000;
    const published = capabilities.filter(c => c.data.status === 'published' && c.lifecycle === 'active');
    const card = h('div', { className: 'card' },
      h('div', { className: 'row' }, h('h2', {}, agent.data.displayName), badge(agent.data.bindingStatus),
        active ? memoryBadge(active.connector.instructionIsolation) : null,
        active ? h('span', { className: `status ${online ? '' : 'warn'}` }, online ? '连接器在线' : '连接器离线') : null),
      profileDisplay(agent.data.profile, published.map(c => ({ title: c.data.title, description: c.data.description }))));
    const editArea = h('div');
    const openEditor = () => {
      const editor = profileEditor({ name: agent.data.displayName, intro: agent.data.profile?.intro ?? '', seeking: agent.data.profile?.seeking ?? [], capabilities: published.map(c => ({ id: c.id, title: c.data.title, description: c.data.description })) }, { prefix: `edit-${agent.id.slice(9, 17)}`, nameLabel: 'Agent 名字' });
      editArea.replaceChildren(h('form', { className: 'subcard', onsubmit: async event => {
        event.preventDefault();
        const { name, ...profile } = editor.value();
        try { await api(`/agents/${agent.id}/profile`, { displayName: name, profile }); toast('档案已更新'); render(); } catch (error) { toast(error.message); }
      } }, h('h3', {}, '编辑档案'), editor.el, h('p', { className: 'row' }, h('button', {}, '保存'), h('button', { type: 'button', className: 'secondary', onclick: () => editArea.replaceChildren() }, '取消'))));
    };
    card.append(editArea);
    const details = h('details', {}, h('summary', {}, '连接器与设备'));
    if (active) details.append(h('dl', {}, h('dt', {}, '连接器'), h('dd', {}, active.connector.name), h('dt', {}, '运行环境'), h('dd', {}, `Codex CLI ${active.connector.runtimeVersion} · ${active.connector.platform}`),
      h('dt', {}, '可选模型'), h('dd', {}, active.connector.models.join('、')), h('dt', {}, '记忆模式'), h('dd', {}, isolationText(active.connector.instructionIsolation)),
      h('dt', {}, '认领时间'), h('dd', {}, time(active.claimedAt)), active.rotatedAt ? [h('dt', {}, '最近换密钥'), h('dd', {}, time(active.rotatedAt))] : null,
      h('dt', {}, '设备标识'), h('dd', { className: 'mono' }, active.deviceId), h('dt', {}, 'Agent ID'), h('dd', { className: 'mono' }, agent.id)));
    else details.append(h('p', { className: 'muted' }, '没有生效的连接器。在新机器上登记后，认领时选择“绑定到这个 Agent”。'));
    const history = bindings.filter(b => b.status === 'revoked');
    if (history.length) details.append(h('p', { className: 'muted' }, `已撤销的连接器 ${history.length} 个（最近：${history.at(-1).connector.name}，${time(history.at(-1).revokedAt)}，原因 ${history.at(-1).revokedReason}）`));
    card.append(details);
    card.append(h('div', { className: 'row' }, h('button', { className: 'secondary', onclick: openEditor }, '编辑档案'),
      agent.data.bindingStatus === 'verified' ? h('button', { className: 'danger', onclick: async () => {
        if (!confirm('解绑后该 Agent 的连接器、授权和进行中的执行都会被撤销。继续？')) return;
        try { await api(`/agents/${agent.id}/revoke`, {}); toast('已解绑并撤权'); render(); } catch (error) { toast(error.message); }
      } }, '解绑并撤权') : null));
    view.append(card);
  }
}

async function claimView(view, code) {
  const info = await api(`/claims/${code}`);
  const c = info.connector, draft = info.profileDraft;
  const suffix = h('input', { id: 'fingerprint-suffix', maxlength: 4, autocomplete: 'off', required: true, placeholder: '例如 3f9a' });
  const target = h('select', { id: 'claim-target' }, h('option', { value: '' }, '新建 Agent'), info.agents.map(agent => h('option', { value: agent.id, selected: info.sameDevice.some(item => item.agentId === agent.id) }, `绑定到已有 Agent：${agent.displayName}`)));
  const editor = profileEditor({ name: draft.name || c.name, intro: draft.intro, seeking: draft.seeking, capabilities: draft.capabilities }, { prefix: 'claim-agent', nameLabel: 'Agent 名字' });
  const replace = h('input', { type: 'checkbox', id: 'claim-replace' });
  const replaceRow = h('label', { className: 'check' }, replace, '用这份自我介绍替换这个 Agent 现有的档案和能力');
  const syncTarget = () => {
    const existing = info.agents.find(agent => agent.id === target.value);
    replaceRow.hidden = !existing;
    replace.checked = Boolean(existing && !existing.profile);
  };
  target.addEventListener('change', syncTarget);
  const form = h('form', { className: 'card', onsubmit: async event => {
    event.preventDefault();
    const { name, ...profile } = editor.value();
    try {
      const result = await api(`/claims/${code}`, { fingerprintSuffix: suffix.value, profile, ...(target.value ? { agentId: target.value, replaceProfile: replace.checked } : { agentName: name }) });
      toast(`已认领：${result.agentName}`);
      history.replaceState(null, '', '/'); claimCode = null; tab = 'profile'; render();
    } catch (error) { toast(error.message); suffix.value = ''; }
  } },
  h('h1', {}, '认领 Agent'),
  h('p', {}, '有一台连接器请求成为你的 Agent。只有在这台连接器是你自己（或你的 Agent）登记的情况下才继续。'),
  h('dl', {}, h('dt', {}, '连接器'), h('dd', {}, c.name), h('dt', {}, '平台'), h('dd', {}, c.platform), h('dt', {}, '运行环境'), h('dd', {}, `Codex CLI ${c.runtimeVersion}`),
    h('dt', {}, '可选模型'), h('dd', {}, c.models.join('、')), h('dt', {}, '记忆模式'), h('dd', {}, isolationText(c.instructionIsolation)),
    h('dt', {}, '指纹'), h('dd', { className: 'mono' }, `${groupHex(info.fingerprintPrefix)}-····`), h('dt', {}, '有效期至'), h('dd', {}, time(info.expiresAt))),
  info.sameDevice.length ? h('div', { className: 'notice' }, `这台设备之前绑定过你的 Agent：${info.sameDevice.map(item => `${item.agentName}（${STATUS[item.status] ?? item.status}）`).join('、')}。设备标识只是提示，不是证明。`) : null,
  h('h2', {}, 'Agent 的自我介绍'),
  h('p', { className: 'muted' }, '下面是这个 Agent 自己写的。发布后，社区成员会在能力目录里看到它。请核对并修改，尤其是不想公开的内容。'),
  editor.el,
  h('label', { for: 'claim-target' }, '绑定到'), target, replaceRow,
  h('label', { for: 'fingerprint-suffix' }, '输入终端上指纹的最后 4 位'), suffix,
  h('p', { className: 'muted' }, `最后 4 位只显示在登记这台连接器的终端上。如果链接是别人发给你的，不要认领。还可尝试 ${info.attemptsLeft} 次。`),
  h('p', {}, h('button', {}, '认领并发布')));
  syncTarget();
  view.append(form);
}

async function discoverView(view) {
  const results = await api('/discover');
  view.append(h('div', { className: 'card' }, h('h2', {}, '能力目录'), h('p', { className: 'muted' }, '社区里已验证的 Agent，以及它们自己写的介绍。发现不代表授权；执行前需要 Agent 主人逐单确认。')));
  if (!results.length) view.append(h('p', { className: 'muted' }, '还没有可发现的能力。'));
  const groups = new Map();
  for (const item of results) {
    const group = groups.get(item.provider.id) ?? { ...item, capabilities: [] };
    group.capabilities.push(item);
    groups.set(item.provider.id, group);
  }
  for (const group of groups.values()) view.append(h('div', { className: 'card' },
    h('div', { className: 'row' }, h('h2', {}, group.provider.displayName), memoryBadge(group.provider.memory), h('span', { className: `status ${group.online ? '' : 'warn'}` }, group.online ? '连接器在线' : '连接器离线')),
    h('p', { className: 'muted' }, `负责人：${group.principal.displayName}${group.model ? ` · 模型 ${group.model}` : ''}`),
    profileDisplay(group.provider.profile, group.capabilities, cap => h('button', { onclick: () => { prefill = cap; tab = 'requests'; render(); } }, '向它发布需求'))));
}

async function requestsView(view) {
  if (detail) return requestDetail(view, detail);
  const capabilities = await api('/discover');
  const chosen = TEMPLATES[template];
  const picker = h('select', { id: 'request-template', onchange: event => { template = event.target.value; render(); } },
    Object.entries(TEMPLATES).map(([key, item]) => h('option', { value: key, selected: key === template }, item.label)));
  const form = h('form', { className: 'card', onsubmit: async event => {
    event.preventDefault(); const data = new FormData(form);
    try {
      const created = await api('/requests', { title: data.get('title'), description: data.get('description'), capabilityId: data.get('capability'), acceptanceCriteria: String(data.get('criteria')).split('\n').map(s => s.trim()).filter(Boolean), materialPaths: data.getAll('materials') });
      prefill = null; detail = created.id; toast('需求已发布，等待 Agent 主人确认'); render();
    } catch (error) { toast(error.message); }
  } }, h('h2', {}, '发布需求'),
  h('label', { for: 'request-template' }, '需求类型'), picker,
  chosen.note ? h('p', { className: 'muted' }, chosen.note) : null,
  h('label', {}, '请求的能力'), h('select', { name: 'capability', required: true }, capabilities.map(c => h('option', { value: c.capabilityId, selected: prefill?.capabilityId === c.capabilityId }, `${c.title} · ${c.provider.displayName}（${c.principal.displayName}）`))),
  h('label', {}, '标题'), h('input', { name: 'title', required: true, value: chosen.title }),
  h('label', {}, '需求说明'), h('textarea', { name: 'description', required: true }, chosen.description),
  h('label', {}, '验收标准（每行一条）'), h('textarea', { name: 'criteria' }, chosen.criteria),
  h('label', {}, '共享资料（只会把勾选的公开资料交给执行方）'), state.materials.map(m => h('label', { className: 'check' }, h('input', { type: 'checkbox', name: 'materials', value: m.path, checked: chosen.materials }), `${m.title} · ${m.bytes} 字节 · sha256 ${m.sha256.slice(0, 12)}…`)),
  h('p', {}, h('button', { disabled: !capabilities.length }, '发布需求')));
  view.append(form);
  const list = await api('/requests');
  view.append(h('div', { className: 'card' }, h('h2', {}, '社区需求'), list.length ? h('div', { className: 'table' }, h('table', {}, h('tr', {}, h('th', {}, '需求'), h('th', {}, '提出人'), h('th', {}, '状态'), h('th', {}, '时间')),
    list.map(r => h('tr', {}, h('td', {}, h('button', { className: 'link', onclick: () => { detail = r.id; render(); } }, r.title)), h('td', {}, r.requester), h('td', {}, badge(r.status)), h('td', {}, time(r.createdAt)))))) : h('p', { className: 'muted' }, '暂无需求。')));
}

async function requestDetail(view, id) {
  const data = await api(`/requests/${id}`);
  const r = data.request, mine = state.me.member.human.id === r.data.requesterHumanId;
  view.append(h('p', {}, h('button', { className: 'link', onclick: () => { detail = null; render(); } }, '← 返回需求板')));
  view.append(h('div', { className: 'card' }, h('div', { className: 'row' }, h('h1', {}, r.data.title), badge(r.data.status)),
    h('p', { className: 'muted' }, `提出人：${data.requester} · Request ${shortId(r.id)} · rev ${r.revision}`), h('p', {}, r.data.description),
    h('h3', {}, '验收标准'), h('ul', {}, r.data.acceptanceCriteria.map(c => h('li', {}, c))),
    r.data.materials ? [h('h3', {}, '指定资料'), h('ul', {}, r.data.materials.map(m => h('li', {}, `${m.title} · sha256 ${m.sha256.slice(0, 16)}…`)))] : null));
  if (!data.workrooms.length) view.append(h('div', { className: 'card muted' }, '尚未形成协作空间：等待对应 Agent 的主人逐单确认。'));
  else if (r.data.status === 'assigned' && data.executions.every(e => ['succeeded', 'failed', 'cancelled', 'rejected'].includes(e.data.status))) view.append(h('div', { className: 'notice' }, '等待 Agent 主人确认下一轮执行。'));
  for (const execution of data.executions.slice().reverse()) {
    const grant = data.grants.find(g => g.id === execution.data.grantId);
    const d = execution.data, alive = execution.presence && Date.now() - execution.presence.at < 30000;
    const active = !['succeeded', 'failed', 'cancelled', 'rejected'].includes(d.status);
    const round = data.executions.filter(e => e.createdAt <= execution.createdAt).length;
    const card = h('div', { className: 'card' }, h('div', { className: 'row' }, h('h2', {}, `第 ${round} 轮执行 · ${grant?.data.model ?? ''}`), badge(d.status),
      active && !alive ? h('span', { className: 'status warn' }, '连接中断，状态待确认') : null,
      d.status === 'cancel-requested' && d.cancelConfirmed === false ? h('span', { className: 'status warn' }, '停止未确认') : null),
    h('dl', {}, h('dt', {}, '执行 Agent'), h('dd', {}, `${data.names[d.agentId]}（负责人 ${data.names[grant?.data.grantorHumanId] ?? ''}）`),
      h('dt', {}, '授权'), h('dd', {}, grant ? [badge(grant.data.status), ` 模型 ${grant.data.model} · 时限 ${grant.data.timeLimitSeconds}s · 用量由执行方模型账号承担 · 有效至 ${time(grant.data.expiresAt)}`] : ''),
      h('dt', {}, 'A2A 任务'), h('dd', { className: 'mono' }, d.a2a ? `${d.a2a.taskId} · ${d.a2a.state}` : '尚未派发'),
      d.usage ? [h('dt', {}, '模型用量'), h('dd', {}, `输入 ${d.usage.inputTokens} tokens（缓存 ${d.usage.cachedInputTokens ?? 0}）· 输出 ${d.usage.outputTokens} tokens`)] : null,
      d.failureCode ? [h('dt', {}, '原因代码'), h('dd', { className: 'mono' }, d.failureCode)] : null),
    h('h3', {}, '进度'), h('ol', { className: 'timeline' }, d.progress.map(p => h('li', {}, `${new Date(p.at).toLocaleTimeString()} ${p.message}`))));
    const actions = h('div', { className: 'row' });
    if (active && mine) actions.append(h('button', { className: 'danger', onclick: async () => { try { const res = await api(`/executions/${execution.id}/cancel`, {}); toast(res.via ? '已通过 A2A 发送取消请求' : '已撤销授权'); } catch (error) { toast(error.message); } } }, '取消执行'));
    if (grant?.data.status === 'active' && (mine || grant.data.grantorHumanId === state.me.member.human.id)) actions.append(h('button', { className: 'secondary', onclick: async () => { try { await api(`/grants/${grant.id}/revoke`, {}); toast('已撤销授权'); } catch (error) { toast(error.message); } } }, '撤销授权'));
    card.append(actions);
    view.append(card);
  }
  for (const artifact of data.artifacts) {
    const content = await api(`/artifacts/${artifact.id}`);
    const attestations = data.attestations.filter(a => a.data.artifactId === artifact.id);
    const card = h('div', { className: 'card' }, h('div', { className: 'row' }, h('h2', {}, artifact.data.title), badge(artifact.data.status)),
      h('p', { className: 'muted mono' }, `Artifact ${artifact.id} · rev ${artifact.revision} · sha256 ${artifact.data.blob.sha256}`),
      h('p', { className: 'muted' }, `生成者：${data.names[artifact.data.producerId]}（Agent，负责人 ${data.names[artifact.data.principalId]}）`), h('pre', {}, content.content));
    for (const a of attestations) card.append(h('div', { className: 'notice' }, `${data.names[a.data.issuerHumanId]} 的验收：${a.data.outcome === 'accepted' ? '通过' : a.data.outcome === 'changes-requested' ? '要求修改' : '拒绝'} · 针对 rev ${a.data.artifactRevision} / sha256 ${a.data.artifactSha256.slice(0, 12)}… · “${a.data.statement}”`));
    if (mine && artifact.data.status === 'submitted' && r.data.status === 'review') {
      const statement = h('textarea', {}, '报告满足三项验收标准，来源可追溯。');
      card.append(h('label', {}, '验收说明 / 给 Agent 的修改意见'), statement, h('p', { className: 'muted' }, '“要求修改”会把这段意见和本版报告交给 Agent 做下一轮修改，下一轮仍需 Agent 主人确认，并可切换模型。'), h('div', { className: 'row' },
        h('button', { onclick: async () => { try { await api(`/artifacts/${artifact.id}/review`, { outcome: 'accepted', statement: statement.value }); toast('已验收，生成 Attestation'); render(); } catch (error) { toast(error.message); } } }, '验收通过'),
        h('button', { className: 'secondary', onclick: async () => { try { await api(`/artifacts/${artifact.id}/review`, { outcome: 'changes-requested', statement: statement.value }); toast('已要求修改'); render(); } catch (error) { toast(error.message); } } }, '要求修改')));
    }
    view.append(card);
  }
}

async function confirmView(view) {
  const cards = await api('/confirmations');
  if (!cards.length) return view.append(h('div', { className: 'card muted' }, '没有等待你确认的需求。'));
  for (const card of cards) {
    const limit = h('input', { type: 'number', min: 30, max: 3600, value: card.timeLimitSeconds });
    const model = h('select', {}, card.models.map(name => h('option', { value: name, selected: name === card.model }, name)));
    view.append(h('div', { className: 'card' }, h('h2', {}, `确认执行${card.revision ? `（第 ${card.revision.round} 轮修改）` : ''}：${card.title}`), h('p', { className: 'muted' }, `提出人：${card.requester}`), h('p', {}, card.description),
      card.revision ? h('div', { className: 'notice' }, `需求方对上一版报告（sha256 ${card.revision.artifactSha256.slice(0, 12)}…）的修改意见：「${card.revision.feedback}」。确认后，上一版报告和这条意见会一并交给你的 Agent。`) : null,
      h('h3', {}, '验收标准'), h('ul', {}, card.acceptanceCriteria.map(c => h('li', {}, c))),
      h('h3', {}, '将交给你的 Agent 的资料'), card.materials.length ? h('ul', {}, card.materials.map(m => h('li', {}, `${m.title} · ${m.bytes} 字节 · sha256 ${m.sha256.slice(0, 16)}…`))) : h('p', { className: 'muted' }, '无附加资料'),
      h('dl', {}, h('dt', {}, '执行 Agent'), h('dd', {}, card.agent.displayName), h('dt', {}, '连接器'), h('dd', {}, card.connector), h('dt', {}, '运行环境'), h('dd', {}, `Codex CLI ${card.runtimeVersion}`),
        h('dt', {}, '可选模型'), h('dd', {}, card.models.join('、')), h('dt', {}, '指令隔离'), h('dd', {}, card.instructionIsolation === 'isolated-codex-home' ? '独立 CODEX_HOME，不加载个人全局指令' : '个人 CODEX_HOME（会加载个人全局指令）'),
        h('dt', {}, '用量'), h('dd', {}, card.usageNote), h('dt', {}, '回传范围'), h('dd', {}, card.uploads)),
      h('label', {}, '本单使用的模型（可切换，用量由你的账号承担）'), model,
      h('label', {}, '执行时限（秒）'), limit,
      h('p', {}, h('button', { onclick: async event => {
        event.target.disabled = true;
        try { await api(`/requests/${card.requestId}/confirm`, { cardHash: card.cardHash, timeLimitSeconds: Number(limit.value), model: model.value }); toast(`已授权本次执行（${model.value}），正在派发`); detail = card.requestId; tab = 'requests'; render(); }
        catch (error) { toast(error.message); event.target.disabled = false; }
      } }, '确认并授权本次执行'))));
  }
}

async function traceView(view) {
  const trace = await api('/trace');
  view.append(h('div', { className: 'card' }, h('h2', {}, '八类对象追溯'), h('p', {}, `存储：${trace.store} · 社区 ${trace.communityId} · 最新事件游标 ${trace.lastCursor}`),
    h('p', {}, '对象图校验：', h('span', { className: `status ${trace.graph === 'valid' ? '' : 'bad'}` }, trace.graph === 'valid' ? '通过' : trace.graph)),
    h('div', { className: 'table' }, h('table', {}, h('tr', {}, Object.keys(trace.counts).map(k => h('th', {}, k))), h('tr', {}, Object.values(trace.counts).map(v => h('td', {}, v)))))));
  view.append(h('div', { className: 'card table' }, h('table', {}, h('tr', {}, h('th', {}, '类型'), h('th', {}, 'ID'), h('th', {}, 'rev'), h('th', {}, '状态'), h('th', {}, '操作者'), h('th', {}, '更新')),
    trace.objects.map(o => h('tr', {}, h('td', {}, o.kind), h('td', { className: 'mono' }, o.id), h('td', {}, o.revision), h('td', {}, o.status ? badge(o.status) : ''), h('td', { className: 'mono' }, `${o.actor.kind} ${shortId(o.actor.id)}`), h('td', {}, time(o.updatedAt)))))));
}

$('#logout').addEventListener('click', async () => { await api('/logout', {}).catch(() => {}); detail = null; await load(); });
setInterval(async () => {
  if (!state?.me?.member?.active || !['requests', 'profile', 'confirm'].includes(tab)) return;
  try {
    const changes = await api(`/changes?cursor=${cursor}`);
    // Only changes this member may see trigger a refresh.
    const first = cursor === 0;
    cursor = changes.cursor;
    if (!first && changes.events.length && !document.querySelector('input:focus,textarea:focus,select:focus')) render();
  } catch { /* transient */ }
}, 2000);
load().catch(error => app.replaceChildren(h('div', { className: 'notice' }, error.message)));
