# 交接说明：Agent Community

给接手的人或 Agent 看。**本文只写当前状态**——为什么变成这样、中间试过什么，在 RFC 和 git 历史里，不在这里。先读本文，再读仓库根目录的 `AGENTS.md`。

标"未验证"的就是没验证过。

---

## 1. 这是什么

**社区的机会路由**：让社群里的每一个需求，都找到能把它做成的人。方向见 [RFC 0010](../RFC/0010-opportunity-router.md)，交互原则见 [RFC 0011](../RFC/0011-one-focus-point.md)。

一条链路：

```
说清楚要什么 → 拆成需要的能力 → 匹配到人（附"为什么是他"）
→ 候选人的 Agent 起草预沟通 → 本人决定接不接 → 组队 → 交付
→ 需求方验收 → 验收过的交付成为能力证据 → 下次匹配更准
```

**人只在两端出现**：开头说要什么，结尾确认拿到了。中间的协调可以交给自己的 Agent。**承诺**（接受邀请、投入时间报酬）和**判断**（验收）永远不委托——接口层面拒绝，不是口头约定。

## 2. 代码在哪、怎么验证

机会路由第一阶段（v1.0.0）及后续加固（PR #1 ~ #7：语义匹配、存储解耦、PAT 登录、公开端点限流）已合并入 **`main`**。当前分支 **`open-on-the-routing-page`** 完成了全环境根路径重定向与登录指引。

```sh
npm test          # 离线，约 20 秒
npm run demo
npm run eval      # 端到端 14 个阶段，虚构场景
npm run router:demo   # 跑完评估后保持节点运行，可在浏览器里看
```

最近一次全量验证：**`npm test` 142/142**、`npm run demo` 正常、端到端评估 **14/14**。数字会变，以实际运行为准。

真实存储验证：先按第 6 节启动本机 FlareMo，再 `node apps/eval/cli.js --store flaremo-local`。

## 3. 已经能做什么

| | 说明 |
| --- | --- |
| **一句话发需求** | `{ text }` 即可。第一行成标题，`-` 开头的行成期望成果。缺什么由 `clarify` 指名，不挡发布 |
| **按意思匹配** | 向量对齐到社区自己长出来的能力词汇表。16 条真实群聊说法，前三名命中 16/16（关键词基线只认出 8/16） |
| **模型命名能力** | 需求超过 30 字才调模型；模型只起名字，名字要对上已有词条才算数，所以幻觉无害。三层兜底：模型 → 整段匹配 → 关键词 |
| **接入不碰密钥** | 页面生成一段可复制文本（一次性配对码），或 Agent 自己发起设备授权。人只登录并勾选 |
| **社区记录完全自管** | 基于 Durable Object 存储（`createDurableStore`），节点自持久化所有业务对象，不再需要修改上游 FlareMo 数据库 |
| **访问令牌登录** | 成员通过个人访问令牌（PAT）登录，浏览器端直连 FlareMo 验证，节点不触碰用户密码或服务级超级凭据 |
| **公开端点限流** | 匿名及未认证端点（`/api/login`、`/device` 等）内置滑动窗口防刷保护 |
| **全环境统一路由** | 根路径 `/` 默认 302 重定向到 `/router`（路由页）；Phase 2 页面提供令牌登录跳转指引 |
| **委托边界** | `route` 权限可让 Agent 代发邀请、代组队；默认不给。拒绝对自动化是终局，邀请有用量上限 |
| **小组可以加人** | 晚接受邀请的人加入同一个小组，不被锁在外面 |
| **评估框架** | 14 个阶段，外部 Agent 可以接进来按同一标准打分 |

**匹配和模型默认关闭**：不配 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN`（或 Worker 的 `AI` binding），行为与关键词基线完全一致。关键词基线保留作对照组。

界面在 `apps/node/public/router.{html,js,css}`，视觉身份与落地页一致（近黑、橙色、等宽小字、全圆角）。旧的 `app.css` 留给第二阶段那个执行页面。

## 4. 明确的决定

- **不再改动 FlareMo。** 只调用它的公开接口，需要适配就在我们这边做中间层。原因：上游持续更新，侵入式补丁每次都可能碎（`0030` migration 撞号就是第一次）。
- **FlareMo 的职责收敛成两件**：成员身份（登录），以及成员自己的 Agent 记忆（`user_id` 作用域，社区读不到）。社区在做什么——需求、匹配、小组、验收——存在我们自己的节点里。
- **不做全局能力标签体系。** 两个能力是不是一回事取决于具体需求，没有全局答案。词汇表只从供给侧生长，需求侧只匹配不造词。
- **模型不在读路径上。** 嵌入只在写入时算，排序是标签求交，毫秒级。

## 5. 开着的事

| 事项 | 状态 / 卡在哪 |
| --- | --- |
| **按第 4 节解耦**：生产存储换成自己的 Durable Object 存储 | **已完成**（PR #6，`createDurableStore` 落地，无需修改 FlareMo） |
| ~~给 FlareMo 管理员的补丁~~ | **已废弃**（存储解耦后彻底不再需要对 FlareMo 打补丁） |
| 访问令牌登录与公开端点限流 | **已完成**（PR #5、PR #7） |
| 根路径默认重定向到路由页 | **已完成**（分支 `open-on-the-routing-page`，全环境统一） |
| 落地页的社交预览图 | **已完成**（`docs/assets/og-image.png`，1200x630 标准规范） |
| 线上演示站 / 生产节点部署 | `agent-network.zwteam.top` 目前无 DNS 记录，需配置 DNS 并部署最新 Worker |
| Agent 读主人的 FlareMo 记忆，自动起草能力档案 | 需要知道 KOSX 有多少人真在用 FlareMo 记忆。这个数只有用户能拿到 |
| 产品定性 | 头一批真实需求的来源和负责人、成员协议文本、试点名单——**这是前置条件，不是待办** |
| 真实 Codex 联调、MCP OAuth、设计 token 与落地页共用 | 未开始 |

**落地页**在 `docs/index.html`，由 GitHub Pages 从默认分支的 `/docs` 目录发布（同目录下还有 `.nojekyll`、`robots.txt`、`sitemap.xml`、`llms.txt`）。本地预览 `npm run landing`。它不经过应用运行时：Node 适配器的静态资源白名单不含它，Worker 也不再提供它。`apps/node/public/_headers` 是 Worker 静态资源的 CSP 响应头，与落地页无关。

## 6. 本机环境与密钥（只说位置，不要读出或复制内容）

- Node 24.14.1；codex-cli 0.153.4；wrangler 固定用 `npx --yes wrangler@4.129.1`；esbuild 固定用 `npx --yes esbuild@0.28.1`。都不写进 package.json。
- 本机 FlareMo：端口 8787，2026-09-22 已停止（演示框架和线上演示都不依赖它；跑 `npm run test:live` 前需要先启动）。启动命令：

  ```sh
  FLAREMO_DIR=<你的 FlareMo 副本目录> node scripts/local/flaremo.mjs start
  ```

  日志在 `~/.agent-community/local/flaremo-dev.log`。
- 测试账号的随机密码和服务 PAT 存在 `~/.agent-community/local/flaremo.json`（权限 0600）。Worker 联调用的环境变量文件是 `~/.agent-community/local/worker.env`（0600）。**不要打印，也不要复制进仓库。**
- `~/.agent-community/codex-home`：给不带记忆模式用的独立 CODEX_HOME，目前还没登录。**绝不要复制 `~/.codex/auth.json`**；需要登录时，由用户本人在终端执行 `connector login`。
- Playwright 不是本仓库的依赖。浏览器测试这样运行：

  ```sh
  PLAYWRIGHT_MODULE=<某个已安装 Playwright 的 node_modules/playwright/index.mjs> PLAYWRIGHT_CHANNEL=chrome \\
    CODEX_MODE=fake node scripts/local/browser-loop.mjs <输出目录>
  ```

- `agent-network.zwteam.top` 目前没有 DNS 记录。如果本机 DNS 经过代理，`dig` 的结果可能不可信，用 DoH 查证。


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
| 产品方向和交互原则 | `RFC/0010`（机会路由）、`RFC/0011`（一个人只聚焦一件事） |
| 设计理由与边界 | `RFC/0007`（本机闭环）、`RFC/0008`（部署与成本）、`RFC/0009`（档案、接入、记忆模式与沙箱实测） |
| 协议 | `RFC/0005`、`RFC/0006`、`protocols/` |
| 怎么跑评估、测出过什么数字 | `docs/EVAL.zh-CN.md` |
| 给成员 Agent 的说明 | `docs/agents.md`（节点会把 `{{NODE}}` 替换成自己的地址后提供） |
| 部署 | `docs/DEPLOY_CLOUDFLARE.zh-CN.md` |
| 试点计划与停止条件 | `docs/KOSX_VALIDATION_PLAN.zh-CN.md` |
