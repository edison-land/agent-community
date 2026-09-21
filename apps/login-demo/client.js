const el = id => document.getElementById(id);
const messages = {
  FLAREMO_HTTP_401: '账号信息未通过验证，或登录已过期。',
  FLAREMO_HTTP_403: 'FlareMo 拒绝了请求。请管理员检查页面来源白名单与账号状态。',
  FLAREMO_HTTP_429: 'FlareMo 请求过于频繁，请稍后再试。',
  FLAREMO_UNAVAILABLE: '无法连接 FlareMo，请检查实例地址与访问策略。',
  FLAREMO_TIMEOUT: 'FlareMo 响应超时，请稍后重试。',
  LOGIN_NOT_CONFIGURED: '尚未配置 FlareMo 实例。',
  LOGIN_RATE_LIMITED: '本地登录尝试过于频繁，请一分钟后重试。',
  LOGIN_BUSY: '已有登录请求正在处理，请稍后再试。',
  SESSION_EXPIRED: '登录已过期，请重新登录。',
  NOT_SIGNED_IN: '请登录以验证身份。',
  IDENTITY_CHANGED: '身份核验结果发生变化，请重新登录。',
};
let configured = false;
function showIdentity(identity, expiresAt) {
  el('login').hidden = Boolean(identity); el('member').hidden = !identity;
  el('name').textContent = identity?.displayName ?? '';
  el('expiry').textContent = identity ? `本次登录最晚有效至 ${new Date(expiresAt).toLocaleTimeString()}` : '';
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(messages[data.error] ?? '验证未完成，请检查实例配置后重试。');
  return data;
}
async function verify() {
  // Hide previously verified information while checking current authority.
  showIdentity(null);
  try {
    const data = await api('/api/session'); showIdentity(data.identity, data.expiresAt);
    el('status').textContent = '已向 FlareMo 核验当前身份。';
  } catch (error) { el('status').textContent = error.message; }
}
el('login').addEventListener('submit', async event => {
  event.preventDefault(); if (!configured) return;
  el('submit').disabled = true; el('status').textContent = '正在登录并核验身份…';
  const credentials = { username: el('username').value, password: el('password').value };
  el('password').value = '';
  try {
    const pending = api('/api/login', credentials); credentials.password = '';
    const data = await pending; showIdentity(data.identity, data.expiresAt);
    el('status').textContent = '身份已验证。下一步是建立社区成员档案。';
  } catch (error) { el('status').textContent = error.message; }
  finally { credentials.password = ''; el('submit').disabled = false; }
});
el('verify').addEventListener('click', verify);
el('logout').addEventListener('click', async () => {
  el('logout').disabled = true;
  try {
    const data = await api('/api/logout', {}); showIdentity(null);
    el('status').textContent = data.upstreamSignoutConfirmed ? '已退出本地登录，FlareMo 已响应退出请求。' : '已退出本地登录；未确认 FlareMo 退出，请在 FlareMo 中检查会话。';
  } catch { showIdentity(null); el('status').textContent = '退出请求未完成，请重试或停止本地服务。'; }
  finally { el('logout').disabled = false; }
});
try {
  const config = await api('/api/config'); configured = config.configured;
  el('provider').textContent = configured ? `连接到 ${config.provider}` : '尚未配置实例。请按接入文档设置 FLAREMO_AUTH_URL 并重启。';
  for (const id of ['username', 'password', 'submit']) el(id).disabled = !configured;
  if (configured) await verify();
} catch { el('status').textContent = '本地登录服务不可用。'; }
