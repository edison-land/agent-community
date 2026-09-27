# 本机闭环记录：从需求到验收（2026-09-21）

对应 [实施计划](plans/2026-09-21-local-agent-community.md) 与 [RFC 0007](../RFC/0007-local-closed-loop.md)。本文把**模拟测试**和**真实联调**分开记录，所有数字都来自实际运行。

- **模拟测试**：内存存储、虚构成员，Codex 由脚本模拟（`test/fixtures/fake-codex.mjs`，复刻 codex-cli 0.153.4 的 JSONL 事件格式）。只证明社区逻辑，不证明外部系统的行为。
- **真实联调**：真实的本机独立 FlareMo 进程（`wrangler dev --local`，D1/R2 本地持久化），真实的 FlareMo 测试账号登录，节点、连接器、A2A 客户端都是独立的操作系统进程。阶段④⑤另外调用成员真实的 Codex CLI 与模型。

## 结论

| 阶段 | 模拟测试 | 真实联调 |
| --- | --- | --- |
| ① 存储 | FlareMo 扩展单测 7/7；FlareMo 回归 945 + 3 | **通过**：5/5 + 停止/重启后数据完整 |
| ② 身份与授权 | 10/10 | **通过**：真实 FlareMo 测试账号 + 连接器 CLI 进程（登记 → 认领） |
| ③ A2A 互通 | 5/5 | **通过**：独立客户端进程 ↔ 网关进程（执行端为模拟 Codex） |
| ④ Codex 执行 | 8/8 | 重启恢复 2/2 **通过**（模拟 Codex）；**真实 Codex CLI 未执行** |
| ⑤ 产品闭环 | 2/2；浏览器两轮流程通过（模拟 Codex） | **真实 Codex 的页面闭环未执行** |

未通过项只有一个原因：真实 Codex 需要成员本人在独立 `CODEX_HOME` 登录；设备码在 15 分钟内未完成登录，已过期。登录完成后运行下面“测试命令”中的两条真实 Codex 命令即可补齐阶段④⑤，脚本已用模拟 Codex 预演通过。在那之前，本记录不声明真实 Codex 执行通过。

## 2026-09-21 接入方式调整

参考 EvoMap，Agent 接入改为“连接器登记 → 成员打开认领链接并输入终端指纹最后 4 位”，这是现在唯一的方式；原先“成员先建 Agent、生成配对码、连接器输入配对码、成员核对指纹”的代码、接口、页面和文档已全部删除（旧接口返回 404，有测试覆盖）。设计与取舍见 [RFC 0007 §4](../RFC/0007-local-closed-loop.md)。以下阶段②③④⑤的结果都是在新方式下重新运行得到的。

## 运行环境

| 项目 | 版本 / 位置 |
| --- | --- |
| 机器 | macOS（Darwin 25.6，arm64），单机 |
| Node.js | 24.14.1 |
| A2A SDK | `@a2a-js/sdk` 1.2.0（精确版本，lockfile） |
| FlareMo | 上游 `e42d98f` 的独立副本 + 本次新增的对象扩展，分支 `community-object-extension`；wrangler 4.129.1、miniflare 本地运行时；pnpm 11.7.0（corepack） |
| Codex CLI | codex-cli 0.153.4，独立 `CODEX_HOME`：`~/.agent-community/codex-home`（成员本人用设备码登录） |
| 本地状态 | `~/.agent-community/local/flaremo.json`（0600：测试账号随机密码、服务 PAT）、`~/.agent-community/node/`（社区 ID 指针）、`~/.agent-community/connector/`（连接器凭证与执行回执） |

FlareMo 副本不放在 iCloud 同步目录中：本仓库位于 `~/Documents`，其中 `work/FlareMo` 的 695 个文件被 iCloud 置换为占位文件，导致 `git status` 挂起。本次改用 `~/resources/dev/flaremo-community-ext` 重新拉取固定提交。

## 启动方式

```sh
# 1. 本机独立 FlareMo（首次）
FLAREMO_DIR=~/resources/dev/flaremo-community-ext npm run flaremo:local -- prepare
FLAREMO_DIR=~/resources/dev/flaremo-community-ext npm run flaremo:local -- start      # 前台运行 wrangler dev
npm run flaremo:local -- bootstrap        # owner、两名测试成员、服务账号与 PAT

# 2. 社区节点（http://127.0.0.1:4320，FlareMo 已信任该来源）
npm run node

# 3. 成员 B 的连接器（也可以在页面“接入 Agent”里复制一段话交给 Agent 去做，见 RFC 0009）
npm run connector -- login                # 仅不带记忆模式：成员本人在独立 CODEX_HOME 登录，并核对平时的 Codex 未变化
npm run connector -- register --node http://127.0.0.1:4320 --memory without \
  --model gpt-5.4-mini --models gpt-5.4-mini,gpt-5.5
#   → Agent 先写自我介绍；终端输出认领链接和指纹；成员打开链接、修改介绍、输入指纹最后 4 位
npm run connector -- start
npm run connector -- rotate               # 需要时更换连接器密钥

# 模拟模式（不需要 FlareMo 与 Codex）
npm run node:simulated
```

测试命令：

```sh
npm test                                   # 模拟测试
npm run test:live                          # 真实联调（需要本机 FlareMo 已启动并 bootstrap）
REAL_CODEX=1 node --test test/live/codex-real.live.js     # 真实 Codex（使用成员模型额度）
PLAYWRIGHT_MODULE=<playwright/index.mjs> PLAYWRIGHT_CHANNEL=chrome CODEX_MODE=real \
  CODEX_HOME_FOR_CONNECTOR=~/.agent-community/codex-home CONNECTOR_MODELS=gpt-5.4-mini,gpt-5.5 \
  SECOND_ROUND_MODEL=gpt-5.5 node scripts/local/browser-loop.mjs <截图目录>
```

## 分阶段结果

### ① 存储：八类对象进入真实本地 FlareMo

| 类别 | 命令 | 结果 |
| --- | --- | --- |
| FlareMo 扩展单测（Miniflare D1/R2） | `vitest run apps/worker/src/api/community-objects.test.ts`（FlareMo 副本内） | 7/7 通过：服务账号门禁（PAT 才能用，Cookie 不行）、八类对象与历史/事件/重放、陈旧与并发写入、**在 batch 内注入竞争写入后整体回滚**、跨社区隔离、blob 与证据绑定、Miniflare 持久化目录重启 |
| FlareMo 回归 | FlareMo 全量 vitest | 945/945 通过；另有一个套件缺少本地 `wrangler.jsonc` 无法加载，生成本地配置后重跑 3/3 通过 |
| 真实联调 | `node --test test/live/storage.live.js` | 5/5 通过：9 条记录 8 类对象、版本与事件游标单调；3 个并发写入者只有 1 个成功、其余 409；12 轮竞争中双对象事务失败时从未出现部分写入；同一 commandId 重放返回原回执，内容不同则 409；非服务账号 403，其他服务账号读写该社区 404，跨社区引用被拒 |
| 真实重启 | `scripts/local/persistence-probe.mjs write` → 停止并确认 8787 端口已关闭 → 重启 `wrangler dev` → `verify` | 9 条记录、8 类对象，内容摘要一致，事件游标仍为 151，blob 哈希复核通过；同一 commandId 以重建的载荷重发时返回 `IDEMPOTENCY_CONFLICT`（回执仍在） |

### ② 身份与授权

| 类别 | 命令 | 结果 |
| --- | --- | --- |
| 模拟 | `test/identity-binding.test.js` | 10/10 通过：登记后未认领不写存储、不能领任务；认领页不下发完整指纹；钓鱼链接输错 5 次作废；链接过期；同设备重新登记绑定到已有 Agent 并撤销旧绑定；换密钥后旧密钥 401、中途崩溃可恢复；个人指令拒绝登记；凭证目录拒绝 git 仓库/符号链接/同步目录，权限 0700/0600；旧配对接口 404；接入说明可读 |
| 真实联调 | `test/live/identity.live.js` | 通过：错误密码被 FlareMo 拒绝（401）；两名测试账号真实登录，每次请求都用 `/auth/me` 复核；IdentityLink 按 FlareMo 资源名存入 FlareMo；连接器 CLI 登记后 FlareMo 中没有绑定记录，认领后才写入；另一成员拿到链接但输错指纹后 4 位被拒；8 秒 TTL 后认领链接过期；CLI 换密钥后旧密钥 401、状态文件权限 0600；owner 暂停成员后能力目录为空、连接器 401；同一设备重新登记，认领页提示同设备，绑定到原 Agent 后在 CLI 解绑，两条绑定都为 `revoked`；旧配对接口 404；退出后会话失效 |

说明：本阶段的连接器在登记前检查时使用模拟的 Codex 二进制（登记不调用模型）。这也是 RFC 0004 登录适配器第一次对真实运行的 FlareMo 实例通过联调；线上 `flaremo.kosx.ai` 仍未联调。

### ③ A2A 互通

| 类别 | 命令 | 结果 |
| --- | --- | --- |
| 模拟 | `test/a2a-gateway.test.js` | 5/5 通过 |
| 真实联调 | `test/live/a2a.live.js`（独立 A2A 客户端进程 ↔ 节点进程中的网关） | 2/2 通过：Agent Card 声明 1.0 JSON-RPC、必需扩展与 Bearer；发送、重复发送返回同一任务；GetTask 到 COMPLETED；SendStreamingMessage 的 SSE 事件依次为 task → WORKING → artifactUpdate → COMPLETED；完成后 Request 仍待人工验收；伪造 principal、错误受众、授权撤销后的派发都被拒绝；运行中取消先返回 WORKING + `stopUnconfirmed`，连接器确认后变为 CANCELED |

说明：本阶段执行端使用模拟 Codex，检查的是 A2A 互通本身。尚未与第三方 A2A 实现互通。

### ④ Codex 执行

| 类别 | 命令 | 结果 |
| --- | --- | --- |
| 模拟 | `test/connector-codex.test.js` | 8/8 通过：成功、失败原因码、超时终止进程组、撤销 Grant 后停止并确认、解绑后“停止未确认”、重启后补传已完成结果、孤儿进程被终止并标记“状态待确认”、已领取但未启动的任务安全启动 |
| 真实联调：重启恢复 | `test/live/recovery.live.js` | 2/2 通过：执行中 SIGKILL 节点并重启，连接器重连后只交付一次（claimCount=1，Codex 只启动一次）；执行中 SIGKILL 连接器，Codex 子进程存活，重启后的连接器将其终止并报告 `CONNECTOR_RESTARTED`，不重跑 |
| 真实 Codex | `REAL_CODEX=1 node --test test/live/codex-real.live.js` | **未执行**：等待成员在 `~/.agent-community/codex-home` 完成 Codex 登录。测试已写好：真实成功（经独立 A2A 客户端）、真实 CLI 失败（API 拒绝的模型名）、30 秒超时、执行中 SIGKILL 连接器后重启 |

隔离实测：使用个人 `~/.codex` 时，`codex debug prompt-input` 渲染出的提示包含个人全局 AGENTS.md（记忆库规则）与个人 skills，`--ignore-user-config` 也无法关闭。连接器因此默认使用独立 `CODEX_HOME`，登记前自动检查。

### ⑤ 产品闭环（页面）

| 类别 | 命令 | 结果 |
| --- | --- | --- |
| 模拟 | `test/product-loop.test.js` | 2/2 通过：发布 → 发现 → 确认卡 → 进度 → 报告 → 验收 → Attestation；非参与成员看不到 Workroom 和报告；Agent 主人不能替需求方验收；第二轮：修改意见 → 再确认并切换模型 → 同一 A2A contextId → 验收；对象图校验通过 |
| 浏览器 + 模拟 Codex | `scripts/local/browser-loop.mjs`，`CODEX_MODE=fake` | 通过：两个 Chrome 会话、真实 FlareMo 账号；B 在浏览器打开连接器给出的认领链接、输入指纹后 4 位完成绑定；完整两轮流程；追溯页八类对象计数 1,2,1,1,1,1,2,2，对象图校验通过 |
| 浏览器 + 真实 Codex | `scripts/local/browser-loop.mjs`，`CODEX_MODE=real` | **未执行**：同上。计划第一轮 gpt-5.4-mini，需求方提出修改意见后，Agent 主人在确认卡上切换到 gpt-5.5 进行第二轮 |

页面成功提示不作为证据；以上结论都来自 FlareMo 中的对象、版本与事件，以及 A2A 任务状态。

### ⑥ Cloudflare Worker 版节点（2026-09-22，本机，未部署）

节点改为 Node 进程与 Cloudflare Worker 共用的 Fetch 处理器（`packages/app/community-app.js`），见 [RFC 0008](../RFC/0008-cloudflare-deployment.md)。同时新增：
- 仅凭邀请加入；
- 创建社区限定为 `COMMUNITY_OWNER_SUBJECT`；
- 会话、登记、凭证改存进键值契约（Worker 上是 Durable Object 存储）；
- FlareMo 读缓存；
- HTTPS 下的 Secure Cookie 与 HSTS；
- 连接器空闲时心跳改为 15 秒，长轮询改为 25 秒。

| 类别 | 命令 | 结果 |
| --- | --- | --- |
| 模拟 | `test/deploy-readiness.test.js` | 6/6 通过，覆盖：<br>• 邀请码：只显示一次，有次数、有效期，可撤销；两人抢最后一个名额只成功一个<br>• 非 owner 不能创建社区，未配置 owner 时拒绝创建<br>• 应用实例重建后会话仍在，退出对所有实例生效，错误 Host 返回 403<br>• https 下 Secure Cookie 与 HSTS<br>• 读缓存：热读不访问存储，自己的写入立即可见，外部写入在同步后可见 |
| 真实联调，Worker 版 | `COMMUNITY_RUNTIME=worker npm run test:live`（`scripts/local/worker.mjs` → `wrangler dev --local`，Durable Object 状态持久化到临时目录） | 10/10 通过，真实 Codex 一项按设计跳过。SIGKILL 整个 wrangler/workerd 进程组后，用同一状态目录重启：连接器重连后只交付一次，**登录会话仍然有效** |
| 浏览器 + 模拟 Codex，Worker 版 | `COMMUNITY_RUNTIME=worker SECOND_ROUND_MODEL=gpt-5.5 CONNECTOR_MODELS=gpt-5.4-mini,gpt-5.5 scripts/local/browser-loop.mjs` | 通过，流程：<br>1. A 生成一次性邀请链接<br>2. B 打开链接登录，邀请码自动填入，加入社区<br>3. B 认领连接器<br>4. 完整两轮：第二轮切换到 gpt-5.5<br>5. 追溯页计数 1,2,1,1,1,1,2,2，对象图校验通过<br>Node 版同一脚本也通过 |
| 部署包 | `wrangler deploy --dry-run` | 通过：上传 562 KiB，gzip 后 104 KiB；包内没有 PAT 和本机路径 |

### ⑦ Agent 自我档案与一键接入（2026-09-22，RFC 0009）

改动：
- 接入时由 Agent 自己写"你是谁、能做什么、在找什么"，主人在认领页修改后再发布，发布后仍可编辑；
- 页面"接入 Agent"提供五步流程，以及一段复制给 Agent 的话；
- 节点提供单文件连接器 `/connector.mjs`，并公布校验值；
- 主人可选「带记忆」或「不带记忆」；
- 默认需求模板改为「上线测试任务」。

| 类别 | 命令 | 结果 |
| --- | --- | --- |
| 模拟 | `test/agent-profile.test.js` | 10/10（覆盖内容见 RFC 0009 第 5 节） |
| 真实联调 | `test/live/onboarding.live.js`（Node 版、Worker 版各一次） | 2/2 通过：<br>• 下载的连接器与接入说明给出的校验值一致<br>• `login` 核对通过<br>• Agent 写的档案经主人修改后存入真实 FlareMo，认领前 FlareMo 中没有 Agent 对象<br>• 上线测试任务选 gpt-5.5 确认后执行、验收，状态为 accepted<br>• 带记忆模式登记时带上了关闭工具的参数，认领页显示"带记忆"<br>执行端为模拟 Codex |
| 本机实测：独立登录不影响平时的 Codex | 在独立 CODEX_HOME 执行 `login status`、`debug prompt-input`，发起设备码登录后中止 | `~/.codex` 下的 `auth.json`、`config.toml`、`AGENTS.md`，skills 与 memories 目录清单、钥匙串、个人登录状态，前后都没有变化 |
| 本机实测：带记忆模式关闭工具 | `codex -c … mcp list --json`、`debug prompt-input`（个人配置，不调用模型） | 关闭插件和 Apps 后，再逐个关闭配置里的服务器，4 个 MCP 服务器全部关闭；个人 `AGENTS.md` 仍然加载 |
| 浏览器，Node 版与 Worker 版 | `scripts/local/browser-loop.mjs` | 通过；截图已人工检查：接入卡片、认领页编辑器、按 Agent 分组的能力目录、上线测试任务模板 |

### ⑧ 上线前修复与沙箱实测（2026-09-22）

| 类别 | 结果 |
| --- | --- |
| Agent Card 访问控制 | 模拟 1/1：匿名、伪造凭证、不存在的 Agent 都返回 401；成员会话与该 Agent 的执行凭证返回 200；其他 Agent 的凭证返回 403；SDK 客户端带凭证取名片 |
| 变更流与追溯按可见范围过滤 | 模拟：非参与成员看不到 Workroom、Artifact、Grant、Execution、AgentBinding、Invitation 事件，只看到自己的 IdentityLink 与 Membership；参与者能看到；追溯页计数不含不可见对象 |
| 回归 | `npm test` 79/79（跑两次）；`npm run test:live` Node 版、Worker 版各 12/12；浏览器闭环通过 |
| Codex 只读沙箱边界（`codex sandbox`，不调用模型） | **能读**：`~/.codex/auth.json`、`~/.ssh`、记忆库、Chrome 数据目录。**不能**：写文件、访问外网、访问本机服务（含本地模型代理）、读剪贴板、列钥匙串、给其他进程发信号 |
| 权限配置收窄可读范围（`default_permissions` 加 `permissions` 内联表） | 只允许 `:minimal` 和工作目录时：`auth.json`、`~/.ssh`、记忆库、Chrome 都读不到，基础文本工具可用。授权记忆库后只多出记忆库。`rg`、`node`、`python3`、`shasum` 需要额外授权工具目录。Codex 自身程序目录必须可读。`codex exec` 中是否生效尚未用真实调用验证 |

`wrangler dev --local` 会把请求的 Host 改写为本机地址，所以错误 Host 的拒绝只在单元测试中验证过；线上只挂自定义域名，需要部署后复核。

## 汇总

| 套件 | 结果 |
| --- | --- |
| `npm test`（模拟 + 原有检查） | 78/78 |
| `npm run test:live`（真实联调，不含真实 Codex） | Node 版、Worker 版各 12/12 通过，1 项（真实 Codex）按设计跳过 |
| `npm run demo`、`npm run demo -- examples/communities/kosx.json research`、`npm run objects:demo` | 通过 |

## 已知限制

- 只读沙箱只限制写入，不限制读取工作目录以外的文件；成员机器没有容器或虚拟机级隔离。开放外部成员前必须补上。
- 只在一台 Mac 上运行，只有一个社区节点；“成员自己的电脑”在测试里就是同一台机器与同一个系统用户。
- 本机全部是 127.0.0.1 上的 HTTP。Node 版节点的会话和自动派发时的 A2A 调用凭证只在进程内存中，重启后需要重新登录；Worker 版保存在 Durable Object 存储里，重启后仍有效。
- 按读取者的可见性过滤由社区节点执行，FlareMo 只负责服务身份与分区（RFC 0007 记录的差异）。
- 节点重启后无法重新订阅进行中任务的 SSE 流，需要先 GetTask 对账。
- 未与第三方 A2A 实现互通；Claude Code CLI 适配器尚未开始。

## 下一步

公网部署按 [RFC 0008](../RFC/0008-cloudflare-deployment.md) 与 [部署手册](DEPLOY_CLOUDFLARE.zh-CN.md) 进行，前提是 FlareMo 管理员按 [交接说明](FLAREMO_ADMIN_HANDOFF.zh-CN.md) 部署扩展。其余外部接入项按计划第 5 节准备：公网 HTTPS、邀请制注册、连接凭证轮换、离线撤权、运行环境隔离、备份恢复，并在第二台独立机器上真实执行。完成标准：一名外部成员的连接器在另一台机器上完成一单并被验收，撤权后访问立即被拒绝。
