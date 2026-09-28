# 部署社区节点到 Cloudflare（agent-network.zwteam.top）

设计与取舍见 [RFC 0008](../RFC/0008-cloudflare-deployment.md)。本文是操作手册。所有命令都在仓库根目录执行，wrangler 统一用固定版本：

```sh
W="npx --yes wrangler@4.129.1"
CFG="--config apps/worker/wrangler.jsonc"
```

**需要你本人完成的步骤**：Cloudflare 登录、选择计划（涉及费用）、输入 PAT。Agent 不代为登录，不索取密码或令牌。

## 0. 前置条件

架构已在 PR #6 全面解耦：**不再需要对 FlareMo 打补丁，不需要超级服务账号，不需要 FlareMo 管理员介入**。社区自身的所有业务对象（需求、匹配、小组、交付、验收）都保存在本节点自身的 Durable Object 存储中。

唯一外部依赖是成员身份验证：
- [ ] `https://flaremo.kosx.ai` 正常运行，成员可在其个人设置中生成个人访问令牌（PAT）用于登录。
- [ ] 不需要管理员修改数据库，不需要 `FLAREMO_SERVICE_PAT`。

## 1. 本机演练（可选，不需要 Cloudflare 账号）

```sh
node scripts/local/worker.mjs                                   # Worker 版节点，http://127.0.0.1:4320
COMMUNITY_RUNTIME=worker npm run test:live                      # 真实联调测试跑在 Worker 版上
```

## 2. 登录 Cloudflare（你本人）

```sh
npx --yes wrangler@4.129.1 login          # 浏览器里选择部署用的 Cloudflare 账号并授权
npx --yes wrangler@4.129.1 whoami         # 确认账号；zwteam.top 必须在这个账号下
```

如果该邮箱下有多个 Cloudflare 账号，发布前设置 `CLOUDFLARE_ACCOUNT_ID=<账号 ID>`。

## 3. 选择计划（费用，需要你确认）

- **Workers Free**：0 元。每次调用只有 10 毫秒 CPU，重的页面（追溯、A2A 处理）可能报错 1102；每天 10 万次请求，大约够 10 个同时在线的连接器。
- **Workers Paid**（推荐）：每月最低 5 美元，在控制台 Workers & Pages → Plans 开通。按 RFC 0008 的估算，小规模使用不会产生超额费用。

## 4. 首次发布

```sh
npm run build:connector      # 生成成员下载用的 connector.mjs 和校验值；Worker 打包时需要
$W deploy $CFG
```

这一步会：
- 创建 Worker `agent-network` 和 Durable Object 类 `CommunityNode`；
- 上传静态页面（访问 `/` 会自动 302 重定向到 `/router`）；
- 绑定自定义域名 `agent-network.zwteam.top`，DNS 记录和证书都会自动创建。

如果 `agent-network.zwteam.top` 已有 DNS 记录，发布会失败。先在控制台确认那条记录是否可以删除，删除需要你确认。

## 5. 设置密钥

解耦后节点**不需要** `FLAREMO_SERVICE_PAT`。只需配置谁有权初始化社区：

```sh
$W secret put COMMUNITY_OWNER_SUBJECT $CFG     # 输入允许创建社区的 FlareMo 资源名 users/...
```

填入的值为你自己在 FlareMo 上的资源名（例如 `users/mia` 或 `users/<your-id>`）。内容是交互式输入，不会出现在命令历史和仓库里。

每次 `secret put` 都会立即生成一个新版本。

## 6. 验收

```sh
curl -s https://agent-network.zwteam.top/healthz
curl -s https://agent-network.zwteam.top/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log({mode:j.mode,store:j.store,loginKind:j.loginKind,inviteRequired:j.inviteRequired})})'
curl -sI https://agent-network.zwteam.top/ | grep -i -E 'location|strict-transport|content-security'
```

期望结果：
- `store` 为 `durable`；
- `loginKind` 为 `flaremo-token`；
- `inviteRequired` 为 `true`；
- 根路径 `/` 响应 `302` 重定向至 `/router`；
- 页面响应带 HSTS 和 CSP 头。

页面上从头走一遍：
1. 打开 `https://agent-network.zwteam.top/router`，输入你本人的 FlareMo PAT 登录 → 创建社区。
2. 生成邀请链接，链接只显示一次。
3. 第二个成员打开邀请链接 → 使用自己的 FlareMo PAT 登录 → 加入社区。
4. 提交需求 → 向量/语义匹配到合适成员或推荐候选人 → 预沟通与组队。
5. 如需接入 Agent：在页面生成配对文本，由成员在自己的终端由 Agent 兑换（免去人肉复制密钥）。

逐项记录结果和部署版本号，不记录账号、Cookie、令牌，截图要先脱敏。没走通的项目记"待联调"。

## 7. 日常运维

| 操作 | 命令 / 位置 |
| --- | --- |
| 实时日志 | `$W tail $CFG --format pretty` |
| 更新代码 | `$W deploy $CFG`（Durable Object 状态保留，会话不丢） |
| 查看版本 | `$W deployments list $CFG` |
| 回滚 | `$W rollback $CFG` |
| 下线 | 控制台移除自定义域名；`$W delete $CFG` 会删除 Worker 及其 Durable Object 状态，属于破坏性操作，先确认 |

## 故障对照

| 现象 | 原因 |
| --- | --- |
| 访问 `/` 提示未登录或空白 | 确认已更新至带有根路径重定向的版本（或手动访问 `/router`） |
| `BOOTSTRAP_NOT_CONFIGURED` | 还没设置 `COMMUNITY_OWNER_SUBJECT` secret |
| 登录报无效令牌或 401 | 检查输入的 FlareMo PAT 是否有效、已过期，或 FlareMo 实例是否可达 |
| 连接器 `INSECURE_NODE_URL` | 节点地址必须是 `https://`（本机测试除外） |
| 偶发 1102 | Free 计划 CPU 超限，改用 Paid |

