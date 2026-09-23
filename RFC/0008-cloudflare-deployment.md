# RFC 0008 — 社区节点部署到 Cloudflare Workers，对接线上 FlareMo

Status: In review. The Worker build is implemented and verified under `wrangler dev --local` against a local FlareMo; nothing is deployed. Deployment waits for the maintainer's Cloudflare login and plan choice and for the FlareMo administrator (see open questions).
Date: 2026-09-22
Decision basis: the maintainer chose Cloudflare, the account `diom1120@gmail.com`, the domain `agent-network.zwteam.top` (zone `zwteam.top` already on Cloudflare), and the online FlareMo `https://flaremo.kosx.ai`, whose administrator the maintainer can contact. This RFC extends [RFC 0007](0007-local-closed-loop.md) from loopback to a public HTTPS origin and supersedes RFC 0004's "loopback only" restriction for this deployment under the conditions below. Runbook: [DEPLOY_CLOUDFLARE](../docs/DEPLOY_CLOUDFLARE.zh-CN.md). Administrator handoff: [FLAREMO_ADMIN_HANDOFF](../docs/FLAREMO_ADMIN_HANDOFF.zh-CN.md).

## 结论

社区节点作为一个 Cloudflare Worker 发布到自定义域名 `agent-network.zwteam.top`。静态页面由 Workers Static Assets 提供；其余请求（`/api/*`、`/a2a/*`、`/connector/*`、`/agent-onboarding.md`、`/healthz`）全部转给**同一个** Durable Object `CommunityNode`，它运行与本机 Node 进程完全相同的 Fetch 处理器（`packages/app/community-app.js`）。社区对象与记录的唯一权威仍是 FlareMo；Worker 不引入 D1、KV 或 R2。

这是成熟方案：Workers、Static Assets、SQLite 后端的 Durable Objects 都是 Cloudflare 正式产品，FlareMo 本身也跑在 Workers 上。节点代码在两种运行时之间共享，差别只在键值存储和静态资源由谁提供。

## 结构

| 部分 | Node 进程（本机开发、测试） | Cloudflare（生产） |
| --- | --- | --- |
| 入口 | `apps/node/server.js`，把 `http.IncomingMessage` 转成 `Request` | `apps/worker/src/index.js`，Worker 只做路由，`idFromName('community-node')` 取固定对象 |
| 业务 | `createCommunityApp`（同一份） | 同左，在 Durable Object 内运行 |
| 键值状态 | `MemoryKV`（进程内存，重启即失） | `DurableKV`：Durable Object 存储，值带过期时间，读取时惰性过期，每小时 alarm 清理 |
| 社区指针 | `COMMUNITY_STATE_DIR/community.json` | Durable Object 存储 `pointer:community` |
| 静态页面 | 进程读取 `apps/node/public` | Static Assets（同一目录），`/claim/*`、`/invite/*` 走 SPA 回退；安全头由 `_headers` 给出 |
| 资料包、接入说明 | 运行时读文件 | 打包时以 Text 模块内联（哈希与 Node 版一致） |
| 成员下载的连接器 `connector.mjs`（RFC 0009） | 进程读取构建产物 | Static Assets；校验值 `connector.json` 在打包时内联，所以部署前要先执行 `npm run build:connector` |
| FlareMo 读缓存 | `CachedStore`，30 秒从事件流同步外部写入 | 同左 |
| 节点给自己派单 | 进程内 `selfFetch` | 同左（不经网络回到自己） |

**为什么只用一个 Durable Object。** 一个节点只服务一个社区。单对象即单写者：连接器在线状态、长轮询唤醒、A2A 任务缓存、读缓存都在同一内存里，语义与本机进程一致，不需要跨实例协调。单个对象的吞吐上限远高于一个受邀社区的规模；将来多社区时按社区 ID 分对象，属于另一个 RFC。

**Durable Object 里存什么。** 只有短期状态：
- 登录会话：包含 FlareMo 访问令牌与上游 Cookie，最长 1 小时，退出即删除。RFC 0004 原本只把它们放在进程内存；这里改为持久化，是为了让对象被驱逐或重新部署后用户不必重新登录。Cloudflare 对 Durable Object 存储做静态加密。
- 待认领的连接器登记：10 分钟。
- 执行调用凭证与交接标记：24 小时。
- 社区指针。

丢失这些状态不会破坏数据：用户重新登录；未认领的登记重新登记即可；进行中的执行按 RFC 0007 的恢复规则处理。

## 安全边界

- 只接受 `PUBLIC_ORIGIN`：`workers_dev: false`，只挂自定义域名；应用层仍校验 Host 与 Origin，写操作要求 JSON。
- HTTPS 下 Cookie 带 `Secure; HttpOnly; SameSite=Strict`，并下发 HSTS；页面 CSP 不允许内联脚本和样式。
- 创建社区只允许 `COMMUNITY_OWNER_SUBJECT` 指定的 FlareMo 账号（`users/...`）。未设置时拒绝创建（`BOOTSTRAP_NOT_CONFIGURED`），不会退回到"谁先来谁创建"。
- 只能凭邀请加入：owner 签发，链接只显示一次；有次数和有效期，可以撤销；并发抢占最后一个名额由修订号保证只成功一次。
- Agent 只能按 RFC 0007 接入：登记 → 认领链接 → 指纹后 4 位；5 次输错即作废。发现不等于授权，每一单仍由 Agent 的主人确认。
- Agent Card 不公开：成员会话或该 Agent 的执行凭证才能读取，匿名请求返回 401。
- 变更流 `/api/changes` 只返回当前成员有权看到的事件：对象按可见范围过滤；记录按相关人过滤，Grant、Execution 仅限工作室参与者，AgentBinding 仅限主人，IdentityLink 仅限本人，Invitation 仅限签发人。追溯页的计数也只统计可见对象。游标仍会越过隐藏事件，所以只能看出变更的总数。
- 密钥 `FLAREMO_SERVICE_PAT`、`COMMUNITY_OWNER_SUBJECT` 只通过 `wrangler secret put` 设置，不进仓库；本机联调用的 env 文件在 `~/.agent-community/local/`（0600），不在 iCloud 同步目录。
- 部署包已检查：不含 PAT，也不含本机路径。

**登录方式的风险（需要维护者和 FlareMo 管理员共同接受）。** 目前沿用 RFC 0004 的账号密码转交：用户在 `agent-network.zwteam.top` 输入自己的 FlareMo 用户名和密码，节点转交给 FlareMo 一次，不保存也不记录。公网上这样做意味着用户要在第三方域名输入 FlareMo 密码，容易被人模仿成钓鱼页面。可以接受的前提：
1. FlareMo 管理员把该来源加入 `FLAREMO_TRUSTED_ORIGINS`，明确同意；
2. 只对受邀的小范围成员开放；
3. 页面明确写出登录的是哪个 FlareMo 实例。

长期应改为 FlareMo 的 OAuth/OIDC 跳转授权，这需要 FlareMo 启用身份提供方插件，另开 RFC。

## 成本与请求量（Cloudflare 官方定价页，2026-09-22 读取）

| 项目 | Workers Free | Workers Paid（每月最低 5 美元） |
| --- | --- | --- |
| Worker 请求 | 每天 100,000 | 每月含 1,000 万，超出每百万 0.30 美元 |
| Worker CPU | **每次调用 10 毫秒** | 每月含 3,000 万 CPU 毫秒；单次默认 30 秒 |
| 静态资源请求 | 免费、不限 | 免费、不限 |
| Durable Object 请求 | 每天 100,000 | 每月含 100 万，超出每百万 0.15 美元 |
| Durable Object 时长 | 每天 13,000 GB-s | 每月含 40 万 GB-s，超出每百万 GB-s 12.50 美元 |
| SQLite 行读/写 | 每天 500 万 / 10 万 | 每月含 250 亿 / 5,000 万 |
| 存储 | 共 5 GB | 每月 5 GB-month |

**估算。**
- 连接器空闲时每 15 秒心跳一次（执行任务时每 3 秒，保证取消及时送达），长轮询最长 25 秒。每个在线连接器每天约 5,760 + 3,456 ≈ 9,200 次请求，Worker 和 Durable Object 各计一次。
- 只要有连接器在线，长轮询会让对象一直处于活跃状态：每天 86,400 秒 × 128 MB ≈ 10,800 GB-s，Free 与 Paid 的额度都够。
- Free 计划大约能撑 10 个同时在线的连接器，再加上页面访问。

**建议使用 Workers Paid（每月 5 美元）。** Free 计划每次调用只有 10 毫秒 CPU，追溯视图（全图校验）、报告哈希、A2A 请求处理有可能超时并报错 1102。按上面的估算，Paid 计划在小规模下不会产生超额费用。计划由维护者决定；这是费用，需要维护者明确确认。

FlareMo 一侧的请求量（写给管理员）：
- 事件同步：有活动时每 30 秒一次，每天最多约 2,880 次。
- 身份复核：每次已登录的 API 调用各有一次 `/api/v1/auth/me`，逐次复核以便及时撤权。
- 业务写入：每个业务动作 1 个事务。
- 缓存未命中时的读取。
- 心跳和页面刷新的重复读取由缓存吸收，不打到 FlareMo。

## 依赖

- 运行时依赖不变，只有 `@a2a-js/sdk@1.2.0`。它的 server/client 只依赖 jose，可以在 Workers 上运行。
- 部署工具 wrangler 以 `npx --yes wrangler@4.129.1` 固定版本调用，不写进 `package.json`，仓库照旧保持零开发依赖。
- 用到的兼容选项：`nodejs_compat`，只用于 `node:crypto` 与 `Buffer`。

## 验证

**本机模拟与联调（均未触及 Cloudflare 账号）。**

| 检查 | 结果 |
| --- | --- |
| `npm test` | 78/78（2026-09-22，含 RFC 0009） |
| `npm run test:live`，Node 版节点 | 12/12（真实 Codex 一项按设计跳过） |
| `COMMUNITY_RUNTIME=worker npm run test:live`，Worker 版节点 | 12/12 |
| 浏览器闭环，Node 版与 Worker 版各跑一次 | 通过 |
| `wrangler deploy --dry-run` | 通过，上传 571 KiB，gzip 后 107 KiB（静态资源 6 个文件，含 `connector.mjs`） |

Worker 版联调在 `wrangler dev --local` 下运行，连接真实的本机 FlareMo 和真实的测试账号，节点与连接器分属独立进程。覆盖的内容：
- 八类对象、事务和并发写入；
- 注册认领、钓鱼防护、过期、轮换、撤销；
- 独立 A2A 客户端；
- SIGKILL 节点和连接器后的恢复。Worker 版会额外断言：重启后登录会话仍然有效。

浏览器闭环（假 Codex）走完整条路径：邀请链接 → 加入 → 认领 → 发布需求 → 逐单确认 → 执行 → 验收 → 追溯。

**尚未验证。**
- 真实 Cloudflare 部署和自定义域名。
- 线上 FlareMo：扩展还没部署，`/api/community/v1/service` 返回 404。
- Worker 跨账号访问 `flaremo.kosx.ai` 时，是否会被 WAF 或 Bot 规则拦截。
- 生产环境中对象被驱逐后的行为。
- 伪造 Host 请求被拒：`wrangler dev --local` 会把 Host 改写成本机地址，这一项只能上线后验证。
- 真实 Codex 执行。

## 回滚与备份

- 回滚：`wrangler rollback` 回到上一版本。停用节点可以在 Cloudflare 控制台暂停路由，或删除 Worker；删除是破坏性操作，需要维护者确认。
- 备份：社区数据全部在 FlareMo，由管理员的 D1 备份与 Time Travel 负责。Durable Object 里只有短期状态，不备份。

## 未决问题

1. FlareMo 管理员是否同意部署扩展（迁移 `0030_community_objects` 与 `/api/community/v1`），并提供服务账号与信任来源？这是对他人线上服务的修改，只能由管理员决定和执行。长期看应当向上游提 PR，否则每次 FlareMo 升级都要重新合入补丁。
2. 是否接受上面所说的账号密码转交登录，还是先等 FlareMo 启用 OIDC？
3. Workers Free 还是 Paid？
4. owner 账号用维护者哪一个 FlareMo 账号（`users/...`）？
