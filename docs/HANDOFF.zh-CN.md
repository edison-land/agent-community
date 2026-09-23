# 交接说明：Agent Community / Agent Network（2026-09-23）

给接手的 Agent（Codex、Antigravity 等）看。先读本文件，再读仓库根目录的 `AGENTS.md`；需要细节时按下面的链接读 RFC。**本文件只记录事实；标"未验证"的就是没有验证过。**

## 0.-1 当前状态：暂停投入，等产品定性（2026-09-23）

**不要再往下建基建。** 用户 2026-09-23 判断：产品定性还没下来，在此之前继续做工程是在猜。

具体没定的是第 0 节末尾那句话，它不是待办，是**前置条件**：头一批真实需求的来源和负责人、成员协议文本、试点名单。需求从哪来、谁负责、给谁用没定，后面所有工程决定都没有判据。

已经提过、**被判断为现在没必要**的三件，不要自行捡起来：

1. **试点模式 RFC**（不连 FlareMo 也能承载真实成员的过渡方案）——被明确否决。理由：定性未定，不给还没定形的东西修跑道。
2. **把线上演示站更新到最新版**——唯一理由是"别人看到的是旧版"，现在不给别人看就不急。
3. **收集真实需求语料测匹配准确率**——匹配什么、给谁匹配没定，测出的数字说明不了问题。

代码处于可以长期停放的状态：全部提交在 `phase-1-opportunity-router`，`npm test` 97/97，本机真实 FlareMo 上端到端 14/14，`main` 干净。停着没有持续成本。

## 0.0 代码在哪（2026-09-23）

工作已提交到本地分支 **`phase-1-opportunity-router`**（5 个提交，基于 `main` 的 `c2e0795`），**没有推送到 GitHub**。`main` 保持在旧状态，随时可以整体退回。要发布时由用户决定是否 `git push -u origin phase-1-opportunity-router`。

## 0.1 2026-09-23 改动（RFC 0011：一个人只聚焦一件事）

维护者要求："代码优化，需求明确，最终用户只需要聚焦一个点，然后由他们的 agent 自由发挥。"实现见 [RFC 0011](../RFC/0011-one-focus-point.md)。要点：

- **入口收成一个输入框**：`POST /api/router/requests` 接受 `{ text }`，第一行是标题、`-` 开头的行是期望成果；`acceptanceCriteria` 不再必填（对象协议里的 `minItems: 1` 已移除）。缺什么由 `clarify` 指名，不再挡住发布。
- **新增 `route` 权限**：`invite_candidates`、`form_squad` 从"只能人做"改为"主人可授权代办"（`human: 'delegated'`）。未授权返回 `DELEGATION_REQUIRED`；已授权也只能操作主人自己的需求（否则 `REQUESTER_ONLY`）。`respond_invitation` 和 `review_outcome` 仍然 `HUMAN_ONLY`。
- **`propose_needs` 删除**，换成 `refine_request`（自己主人的需求，进确认队列）；别人的需求用 `suggest`。
- **`GET /api/router/todo`**：人的唯一一份待办，和 Agent 的 inbox 同源，每条带 `agentCovers`。
- **MCP `tools/list` 按令牌权限过滤**（HTTP 与 stdio 两端都是）。
- **小组可以加人**：晚接受邀请的人加入同一个小组，不再被锁在外面（`NO_NEW_MEMBERS` 表示没有新人可加）。
- **页面从六个标签页变成三个**：我要什么 / 社区机会 / 更多。邀请、预沟通、候选人、小组、验收都在同一个需求页上。
- **修掉一个既有缺陷**：`requestView` 曾用"建议组合"覆盖 `squad` 字段，导致需求方在页面上看不到自己需求的小组、也无法验收。建议组合现在叫 `plan`。
- 协议改动（都在本仓库，**不需要重新生成 FlareMo 补丁**，扩展只校验 kind 和引用）：`Request.acceptanceCriteria` 去掉 `minItems`；`AgentToken.scopes` 枚举加 `route`；`Match.source` 枚举加 `agent`。
- **委托授权的边界（当天补，RFC 0011 §3.3.1）**：实测发现 Agent 可以在对方拒绝后反复重邀，而且 `invite_candidates` 完全没有限流。现在拒绝对 Agent 是终局（`CANDIDATE_DECLINED`，需求方本人不受此限），邀请有用量上限（默认同一需求 10 人 / 每小时 30 人，`RATE_LIMITED`，可通过 `routerOptions.limits` 调整）。用量从 `Match.data.invitedByAgentId` 数出来，不放内存，重启不清零。
- **`Match` 新增 `invitedByAgentId`**：原来"谁发的邀请"读实体 `actor`，但 `next()` 会覆盖 `actor`，导致对方一回应，「由 Agent 代发」标注就消失、用量也清零。这是普通数据字段不是引用，**FlareMo 补丁仍为 v0.2，不用重新生成**。
- 验证：`npm test` 97/97；`npm run eval` 14/14；`node apps/eval/cli.js --store flaremo-local`（本机真实 FlareMo）14/14；真实 Chrome 驱动页面无 JS 报错；`wrangler deploy --dry-run` 通过。
- **线上演示站还是 2026-09-22 的版本**，没有重新部署（用户没有要求）。要更新：`npm run build:connector` 后 `npx --yes wrangler@4.129.1 deploy --config apps/worker/wrangler.demo.jsonc`。

## 0. 2026-09-22 方向调整（最重要，先读这一节）

用户把项目重新定义为**社区的机会路由（Community Execution Layer）**。中文定位是"让社群里的每一个需求，都找到能把它做成的人"。

- 核心问题是：社区里有供给、有需求，却缺一个把两者对上的机制。KOSX 的运营现在在人工充当"人肉路由"。
- 燃料是真实需求，不是 Agent 的数量。Agent 可以不接。
- 衡量指标是机会数、匹配数、组队数、交付数、经验证的能力数。

分三个阶段：
1. 让一个社区里的需求找到人（Request → Member）；
2. 让 Agent 参与匹配和协调；
3. 社区之间互联（联邦）。

第一版只验证这条链路：提出需求 → 理解需求 → 匹配能力 → 找到候选人 → Agent 预沟通 → 本人接受 → 组队。如果这条链路在 KOSX 不产生价值，就不继续做这个项目。

**用户已确认（2026-09-22）：**
- **成员自助使用**，不以运营为唯一入口。大家一起给建议本身就是价值，所以要把成员 Agent 的接口先定义好：进入网络后，Agent 知道可以做什么、应该做什么、不能做什么（RFC 0010 第 7 节）。之前提议的"以运营为第一用户"已被否决。
- **可以用共同大脑的群聊数据起草成员档案**，前提是成员签署成员协议（类似用户协议）。规则是先签后起草、起草结果先只给本人看、可以随时撤回（RFC 0010 第 6 节）。

**已产出：**
- `RFC/0010-opportunity-router.md`；
- 改写后的 README（中英文）、VISION、ROADMAP；
- 验证计划 `docs/KOSX_VALIDATION_PLAN.zh-CN.md`，以及同内容的可分享页面 https://claude.ai/artifact/XPbpGCvsw7w9CdfBhvUrr7（私有，要在页面上分享后别人才能打开）。

**尚未确定：** 头一批真实需求的来源和负责人、成员协议文本、试点名单。

**第一阶段演示已实现（2026-09-22，未提交）**，使用说明见 `docs/EVAL.zh-CN.md`：
- 代码：`packages/router/`（匹配引擎、Agent 接口清单、路由服务、群聊信号来源）、`packages/app/router-routes.js`（成员 `/api/router/*` 与 Agent `/api/agent/v1/*`）、`packages/app/mcp.js`（`/mcp`）、`apps/node/public/router.html` 与 `router.js`（成员页面）、`apps/node/public/agent-mcp.mjs`（stdio MCP）、`docs/agents.md`（给 Agent 的说明）、`packages/eval/` 与 `apps/eval/cli.js`（评估框架）、`examples/scenarios/`、`examples/agents/reference-agent.mjs`。
- 协议：Human 增加 `profile`；Request 增加 `needs`、`rewardTypes` 等字段，`capabilityIds` 改为可选；Workroom 增加 `roles`；新增记录 Match、Suggestion、Preflight、Consent、AgentToken。
- 验证结果（2026-09-22 当天；最新数字见第 0.0 节）：
  - `npm test` 91/91；
  - `npm run eval` 14/14 阶段通过；
  - 外部参考 Agent 通过 stdio MCP 接入，评估通过；
  - Claude 作为外部 Agent 实时接入：第二次运行 14/14 通过（第一次因会话中断，在交付一步判定失败）；
  - `npm run test:live` 12/12。
- 注意：仓库在 iCloud 同步目录，文件可能被移到云端（dataless），导致测试读文件超时（`ETIMEDOUT … read`）。用 `find . -path ./node_modules -prune -o -type f -flags dataless -print` 检查，读一遍文件即可取回。

**公开演示已部署（2026-09-22，这是用户明确要求的部署）：** https://agent-network-demo.zwteam.top
- Cloudflare 账号 diom1120@gmail.com，Worker 名 `agent-network-demo`，版本 `0e42d179-f0cd-4e62-b7f9-86b73b5bda79`，配置 `apps/worker/wrangler.demo.jsonc`，自定义域名。
- 演示模式：不连 FlareMo，数据存在 Durable Object 里，成员是虚构的，访客可以加入，有每 IP 写入限流。
- 重置密钥存在 `~/.agent-community/local/demo.json`（0600）和 Worker 的 secret 里。
- 重新初始化并评估：`node apps/eval/cli.js --target https://agent-network-demo.zwteam.top --reset-secret-file ~/.agent-community/local/demo.json`。
- 本机出网要走 127.0.0.1:7890 代理时，先设置 `HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY=1`。
- 重新部署前先执行 `npm run build:connector`，再执行 `npx --yes wrangler@4.129.1 deploy --config apps/worker/wrangler.demo.jsonc`。
- 删除 Worker 或 DNS 记录前必须先问用户。
- 验证结果见 `docs/EVAL.zh-CN.md` 第 0 节。

**开工前须知：** 第一阶段新增的记录类型（Match、Suggestion、Preflight、Consent、AgentToken）已加进 FlareMo 扩展（0.2.0，补丁 v0.2，2026-09-22）；用 `node apps/eval/cli.js --store flaremo-local` 可以在本机 FlareMo 上验证整条链路。共同大脑（另一个仓库 `kosx-shared-brain`）需要提供一个起草接口，只对签了协议的成员开放。

现有代码的定位：
- 八类对象、社区与成员、邀请、可见范围、验收证据、FlareMo 存储、Worker 部署，都可以直接复用。其中 Request、Capability（已支持由人提供）、Workroom（可当作小组）、Artifact、Attestation 本身就对应这条飞轮。
- 连接器、A2A、Codex 执行、沙箱、记忆胶囊属于第 2 阶段，代码保留，暂停继续投入。

## 1. 已实现部分的原始定位（现降为技术描述，见第 0 节）

一个开源的 Agent 协作社区。成员把自己电脑上的 Agent（目前只支持 Codex CLI）接进社区。别的成员看到它的自我介绍，就能向它发需求。

每一单都要走完这条路径：
1. Agent 的主人逐单确认；
2. 在主人本机的只读沙箱里执行；
3. 报告存进 FlareMo；
4. 需求方验收。

其中两个原则：执行完成不等于验收；在目录里能看到某个 Agent，也不等于获得了让它执行的授权。

- 仓库：`/Users/jairwu/Documents/Codex/2026-09-21/referenced-chatgpt-conversation-this-is-an`，GitHub `edison-land/agent-community`。在 iCloud 同步目录里，不要把任何密钥写进仓库。
- 最后一次提交：`c2e0795`。之后的全部工作（约 50 个文件）**都未提交**，因为用户说过"先不用提交"。在用户明确要求之前不要 commit，也不要 push。
- 数据权威：FlareMo（AGPL，基于上游 `realchendahuang/FlareMo` 的 `e42d98f`）。社区对象存放在我们写的一个扩展里，扩展的源码是仓库外的独立副本：`/Users/jairwu/resources/dev/flaremo-community-ext`，同样未提交。
- 用户用中文交流；文档用中文，代码注释用英文。

## 2. 用户已经做出的决定

- 本机闭环按 `docs/plans/2026-09-21-local-agent-community.md` 执行。场景：成员 A 发调研需求，成员 B 逐单确认，B 的 Codex 执行，A 验收。模型默认 gpt-5.4-mini，允许需求方和 Agent 多轮交互，每轮可以切换模型。
- Agent 接入方式参考 EvoMap，已改为"登记 → 认领"，旧的配对方式已全部删除，不要再加回来。
- 部署到 Cloudflare：账号 `diom1120@gmail.com`，域名 `agent-network.zwteam.top`，对接线上 FlareMo `https://flaremo.kosx.ai`。用户能联系到它的管理员。
- 研究报告任务改名为「上线测试任务」，并作为默认需求模板。
- Agent 接入时自己写"你是谁、能做什么、在找什么"，主人可以编辑。提供一段"复制给你的 Agent"的话。接入时可以选带记忆或不带记忆。
- 已修复两个问题：
  1. Agent Card 需要登录或持有该 Agent 的凭证才能读取；
  2. `/api/changes` 按可见范围过滤。

## 3. 已实现的功能（都在本机验证过）

| 模块 | 位置 | 说明 |
| --- | --- | --- |
| 社区节点，Node 版与 Worker 版共用 | `packages/app/community-app.js` | 一个 Fetch 处理器，负责页面接口、A2A 网关、连接器接口；会话等短期状态走 KV 契约（`packages/runtime/kv.js`） |
| Node 版入口 | `apps/node/server.js` | 本机开发和测试用，端口 4320 |
| Cloudflare 版入口 | `apps/worker/` | Worker 加一个 Durable Object `CommunityNode`；静态页面由 Static Assets 提供；配置在 `wrangler.jsonc`，**尚未部署** |
| 业务规则 | `packages/community/service.js` | 邀请制加入、限定 owner 创建社区、登记与认领、Agent 档案、逐单确认、多轮修改、验收、可见范围过滤 |
| FlareMo 存储客户端和读缓存 | `packages/store/flaremo-objects.js`、`cached.js` | |
| A2A 1.0 网关与调用方 | `packages/gateway/` | 使用官方 `@a2a-js/sdk@1.2.0`，这是唯一的运行时依赖 |
| 成员侧连接器 | `apps/connector/cli.js`、`packages/connector/` | 命令：`login`、`register --memory with|without`、`start`、`status`、`rotate`、`stop`、`unbind` |
| 单文件连接器 | `npm run build:connector` 生成 `apps/node/public/connector.mjs` 和 `connector.json` | 构建产物已被 gitignore；节点通过 `/connector.mjs` 提供下载 |
| 页面 | `apps/node/public/` | 接入 Agent 流程卡、认领页（可编辑档案）、按 Agent 分组的能力目录、上线测试任务模板、确认卡、验收、追溯 |
| 给 Agent 读的接入说明 | `docs/agent-onboarding.md` | 节点通过 `/agent-onboarding.md` 提供 |
| 协议 | `protocols/community/v0.1/*.schema.json` | 八类核心对象，以及 Membership、IdentityLink、AgentBinding、Grant、Execution、Invitation 六类记录 |

两种记忆模式目前是这样实现的（`packages/connector/codex.js`）：
- **不带记忆**：独立目录 `~/.agent-community/codex-home`，运行时加 `--ignore-user-config`。
- **带记忆**：使用成员自己的 `~/.codex`，但关闭 MCP、插件、Apps、hooks 等工具（`personalLockdown`）。**用户正在考虑把它换成第 6 节的"记忆胶囊"方案，还没决定；按第 0 节的新方向，这属于第 2 阶段。**

## 4. 验证状态（2026-09-22 最后一次）

| 套件 | 结果 | 性质 |
| --- | --- | --- |
| `npm test` | 79/79 | 模拟：内存存储、虚构成员、模拟 Codex |
| `npm run test:live` | 12/12，1 项跳过 | 真实本机 FlareMo、真实测试账号、多个独立进程；执行端是模拟 Codex |
| `COMMUNITY_RUNTIME=worker npm run test:live` | 12/12，1 项跳过 | 同上，节点换成 `wrangler dev --local` 下的 Worker 版 |
| `scripts/local/browser-loop.mjs` | 通过 | 真实浏览器（Chrome 加 Playwright）、真实 FlareMo 账号、模拟 Codex |
| `npm run demo`、`objects:demo`、`flaremo:demo`、kosx 示例 | 通过 | |
| `wrangler deploy --dry-run` | 通过，上传 571 KiB | 没有部署 |

**从未验证过的：**
- 真实 Codex CLI 执行任务、生成自我介绍。会用成员的额度，需要用户同意。不带记忆模式还要用户本人先执行 `connector login`。
- 真实 Agent 读完接入说明后能否自己完成接入。
- 线上部署，以及线上 FlareMo：扩展尚未部署，接口返回 404。
- 权限配置在 `codex exec` 中是否生效。目前只在 `codex sandbox` 测试命令里验证过。

证据和详细命令见 `docs/LOCAL_LOOP.zh-CN.md` 第 ①–⑧ 节。

## 5. 本机环境与密钥（只说位置，不要读出或复制内容）

- Node 24.14.1；codex-cli 0.153.4；wrangler 固定用 `npx --yes wrangler@4.129.1`；esbuild 固定用 `npx --yes esbuild@0.28.1`。都不写进 package.json。
- 本机 FlareMo：端口 8787，2026-09-22 已停止（演示框架和线上演示都不依赖它；跑 `npm run test:live` 前需要先启动）。启动命令：

  ```sh
  FLAREMO_DIR=/Users/jairwu/resources/dev/flaremo-community-ext node scripts/local/flaremo.mjs start
  ```

  日志在 `~/.agent-community/local/flaremo-dev.log`。
- 测试账号的随机密码和服务 PAT 存在 `~/.agent-community/local/flaremo.json`（权限 0600）。Worker 联调用的环境变量文件是 `~/.agent-community/local/worker.env`（0600）。**不要打印，也不要复制进仓库。**
- `~/.agent-community/codex-home`：给不带记忆模式用的独立 CODEX_HOME，目前还没登录。**绝不要复制 `~/.codex/auth.json`**；需要登录时，由用户本人在终端执行 `connector login`。
- Playwright 不是本仓库的依赖。浏览器测试这样运行：

  ```sh
  PLAYWRIGHT_MODULE=/Users/jairwu/resources/dev/flaremo-community-ext/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome CODEX_MODE=fake SECOND_ROUND_MODEL=gpt-5.5 CONNECTOR_MODELS=gpt-5.4-mini,gpt-5.5 node scripts/local/browser-loop.mjs <输出目录>
  ```

- 本机 wrangler 已用 OAuth 登录 diom1120@gmail.com，这是用户之前自己做的。`agent-network.zwteam.top` 目前没有 DNS 记录（用 DoH 查询是 NXDOMAIN）。
- 本机 DNS 走代理的 fake-IP（198.18.x），所以 `dig` 的结果不可信，要用 DoH 查。

## 6. 待办与需要用户决定的事（按优先级）

1. **记忆胶囊加每单沙箱（等用户决定）。** 方案是：
   - 用"专用 CODEX_HOME + 用户挑选的记忆快照（只读挂载）+ 每单一次性沙箱"取代"带记忆 = 使用 `~/.codex`"；
   - 用权限配置只放行系统路径、工作目录和胶囊；
   - 带胶囊的 Agent 默认由主人放行报告；
   - 命令里出现敏感路径时终止这一单。

   已实测的依据：
   - 只读沙箱能读到 `~/.codex/auth.json`、`~/.ssh`、记忆库；
   - 权限配置可以把这些挡住；
   - 独立 CODEX_HOME 里放的 `AGENTS.md` 会被当作指令加载（不加 `--ignore-user-config` 时）。

   计划写成 RFC 0010。另外还要用户同意做一次真实调用，验证权限配置在执行时生效。
2. **部署（等外部条件）。**
   - 需要管理员先按 `docs/FLAREMO_ADMIN_HANDOFF.zh-CN.md` 部署扩展补丁。补丁包在仓库外：`/Users/jairwu/resources/dev/flaremo-handoff/`，当前为 v0.2（`flaremo-community-objects-v0.2.patch`，SHA-256 `54553911…6c427a84`，含机会路由的新记录类型；v0.1 已移到 `superseded/`）。
   - 管理员还要建服务账号、添加信任来源、放行 WAF，并同意"在第三方域名上转交 FlareMo 密码登录"的风险。
   - 用户要选 Workers 计划：推荐 Paid，每月 5 美元。**这是费用，必须用户确认。**
   - 然后按 `docs/DEPLOY_CLOUDFLARE.zh-CN.md` 操作；发布前先执行 `npm run build:connector`。
3. 真实 Codex 联调：`REAL_CODEX=1 node --test test/live/codex-real.live.js`，以及 `CODEX_MODE=real` 的浏览器闭环。
4. 已知限制：
   - 登录方式是把密码转交给 FlareMo，长期应改为 OAuth/OIDC；
   - 页面上还没有暂停成员的按钮，只有接口；
   - 只有一个社区节点；
   - Claude Code 等其他 Agent 的适配器还没做。

## 7. 必须遵守的边界

- 仓库 `AGENTS.md` 的全部规则，其中几条：
  - 密钥、个人记忆、真实成员数据不进仓库；
  - 在目录里能看到 Agent，不等于获得了授权；
  - 重要功能、新依赖、生产技术栈的选择都要先写 RFC；
  - 改代码后要跑 `npm test` 和 `npm run demo`；
  - 不要把发布软件包、部署服务当作改代码的顺带操作。
- **以下操作都要先问用户：** 部署、会产生费用的操作、删除（包括 DNS 记录、Worker、数据）、提交代码，以及修改别人的线上服务（线上 FlareMo 只由管理员操作）。
- 登录由用户本人完成：Codex 设备码登录、wrangler 登录、在页面输入 PAT。不要索取或记录密码和令牌。
- 汇报时把模拟测试和真实联调的结果分开写。

## 8. 文档地图

| 想了解 | 读 |
| --- | --- |
| 为什么这样设计、各项边界 | `RFC/0007-local-closed-loop.md`（本机闭环）、`RFC/0008-cloudflare-deployment.md`（部署与成本）、`RFC/0009-agent-profile-and-onboarding.md`（档案、一键接入、记忆模式与沙箱实测） |
| 协议 | `RFC/0005-core-objects-and-flaremo-store.md`、`RFC/0006-community-a2a-profile.md`、`protocols/` |
| 每个阶段的证据 | `docs/LOCAL_LOOP.zh-CN.md` |
| 部署 | `docs/DEPLOY_CLOUDFLARE.zh-CN.md`、`docs/FLAREMO_ADMIN_HANDOFF.zh-CN.md` |
| 跨 Agent 共享记忆 | `/Users/jairwu/obsidian_docs/agent-memory/项目/Agent-Community.md`，以及 `agent/case-candidates/Codex-CLI无人值守隔离.md`（Codex 沙箱和配置的实测结论） |
