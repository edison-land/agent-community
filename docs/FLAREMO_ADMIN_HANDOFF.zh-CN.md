# 给 flaremo.kosx.ai 管理员的交接说明：Agent Community 对象扩展

> **暂缓。** 项目已决定不再改动 FlareMo，只调用它的公开接口（见[交接说明](HANDOFF.zh-CN.md)第 4 节），本文描述的扩展补丁因此不是当前方案。若仍要走这条路线，补丁必须先把 `0030_community_objects.sql` 重编号到 `0032`——上游已占用 0030。

你好。Agent Community 是一个"成员把自己的 Agent 接入社区、逐单授权执行"的社区节点，准备部署在 `https://agent-network.zwteam.top`（Cloudflare Workers）。它不自建数据库，所有社区数据保存在 FlareMo 里。为此需要在 flaremo.kosx.ai 上做下面几件事。**每一项都由你决定是否执行；我们不会直接修改你的实例。**

设计依据：[RFC 0005 存储扩展](../RFC/0005-core-objects-and-flaremo-store.md)、[RFC 0007 本机闭环](../RFC/0007-local-closed-loop.md)、[RFC 0008 Cloudflare 部署](../RFC/0008-cloudflare-deployment.md)。

## 需要你做的事（清单）

1. 确认线上部署的 FlareMo 版本，并部署扩展补丁（新增表和 `/api/community/v1`）。
2. 新建一个服务账号，授权它作为社区服务使用扩展。
3. 在 `FLAREMO_TRUSTED_ORIGINS` 中加入 `https://agent-network.zwteam.top`。
4. 确认 WAF / Bot 规则不会拦截来自 Cloudflare Worker 的服务端请求。
5. 同意或否决"在社区域名上用 FlareMo 账号密码登录"这一方式（见下文风险）。

## 1. 扩展补丁

- 文件：`flaremo-community-objects-v0.2.patch`（扩展版本 `community-objects/0.2.0`），由维护者单独发给你。它是 AGPL 代码的修改，所以不放在本仓库里。早先的 v0.1 已作废，请不要使用。
- SHA-256：`54553911f2f9cc49d2d26c5333c96addbf0d111f13a2c41ba63abc1c6c427a84`
- 基线：上游 `realchendahuang/FlareMo` main。补丁基于 `e42d98f` 生成，在干净的 `e42d98f` 和 2026-09-22 最新的 `d66432f` 源码上 `git apply --check` 都通过（这两个提交之间只改了 README）。
- v0.2 相比 v0.1 新增：
  - 机会路由用的 5 类记录：Match（匹配）、Suggestion（建议）、Preflight（预沟通）、Consent（成员协议签署）、AgentToken（成员给自己 Agent 的授权）；
  - 需求可以不绑定能力对象；
  - 小组角色必须引用小组成员。

  **没有新增表，也没有改迁移。**

内容全部是新增，不改已有表和已有接口的行为：

| 文件 | 作用 |
| --- | --- |
| `migrations/0030_community_objects.sql`（+ meta） | 新增 8 张表：`community_service_accounts`、`community_partitions`、`community_entity_versions`、`community_entities`、`community_relations`、`community_commands`、`community_events`、`community_blobs`。只有 `CREATE`，没有 `ALTER`/`DROP` |
| `packages/db/src/schema/community.ts`、`schema.ts` | Drizzle 表定义 |
| `packages/domain/src/community-objects.ts`、`index.ts` | 事务（按修订号的乐观并发、同社区引用约束、命令幂等回执）、事件游标、blob 校验 |
| `apps/worker/src/routes/community-api.ts`、`index.ts` | `/api/community/v1`：`service`、`transactions`、`objects`、`records`、`events`、`blobs`、`service-accounts` |
| `scripts/persistence-manifest.mjs` | 把新表登记为权威数据，纳入备份与恢复清单 |
| `apps/worker/src/api/community-objects.test.ts` | 8 项测试 |

访问规则：
- `/api/community/v1` 只接受 PAT，而且 PAT 必须属于已授权的服务账号。浏览器 Cookie 和匿名请求一律拒绝。
- 一个服务账号只能访问它自己创建的社区分区。
- 只有实例 owner 能授权或停用服务账号。

我们的验证：
- 在独立副本上，扩展测试 8/8 通过；FlareMo 全量测试 145 个文件、949 项全部通过；类型检查通过。
- 本机 FlareMo 运行 0.2.0 扩展时，社区侧把整条机会路由链路（需求 → 匹配 → 建议 → 预沟通 → 小组 → 交付 → 验收）真实写入，14 个阶段全部通过。
- 这套功能的公开演示：https://agent-network-demo.zwteam.top 。演示用虚构成员，不连任何 FlareMo，可以先看看它是做什么的。
- 本机 `wrangler dev --local` 实例与社区节点联调通过，覆盖对象存储、并发冲突、事务原子性、幂等重放、跨社区隔离。
- 这些结果**没有**在你的线上实例上验证过。

部署建议：
1. 核对线上实际部署的提交。如果不是 `e42d98f` 或 `d66432f`，先确认补丁能否打上；还要确认 `0030` 仍是下一个迁移编号，若已被占用，把迁移改到下一个编号。
2. 打上补丁，运行 `pnpm test` 与 lint。
3. 按 FlareMo 的 `docs/deploy.md`：先 `pnpm migrate:remote`，再 `pnpm deploy`。
4. 部署后，未授权的 PAT 访问 `GET /api/community/v1/service` 应返回 403。

注意：FlareMo 升级时补丁需要重新合入。长期更好的办法是作为上游 PR 提交，这由你和上游维护者决定。

## 2. 服务账号

建议账号名 `agent-network-service`，专门给社区节点用，不要用个人账号。

1. 你在管理员页新建这个用户，把激活链接交给社区维护者。
2. 维护者设置密码后，在"账号 → 个人访问令牌"里创建 PAT，有效期建议 90 天，然后直接在自己的终端执行 `wrangler secret put` 填入。这样 PAT 不经过你，也不经过聊天记录。
3. 你用 owner 账号登录 flaremo.kosx.ai，在该页面的浏览器控制台执行下面的命令，授权这个账号。`users/...` 是服务账号的资源名，可以在管理员用户列表或该账号的 `/api/v1/auth/me` 返回里找到。

   ```js
   await (await fetch('/api/community/v1/service-accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'users/<服务账号>', status: 'active' }) })).json()
   ```

   随时可以把 `status` 改成 `'disabled'`：社区节点对 FlareMo 的访问会立刻被切断，已有数据不受影响。

## 3. 信任来源

在 FlareMo 的环境变量 `FLAREMO_TRUSTED_ORIGINS` 中加入 `https://agent-network.zwteam.top`（多个来源用逗号分隔），然后重新发布。

社区节点代成员登录时，会带着这个 Origin 调用 `/api/v1/auth/signin`、`/api/v1/auth/me`、`/api/v1/auth/signout`。不加入这个来源，登录会被拒绝。

## 4. WAF / Bot 规则

社区节点从 Cloudflare Worker 发起服务端请求（不是浏览器），访问：
- `/api/v1/auth/*`
- `/api/community/v1/*`

如果 kosx.ai 开启了 Bot Fight Mode、质询或按 User-Agent 拦截的规则，请为这两个路径放行，或提供一个可以放行的请求特征。

## 5. 登录方式与风险（请明确表态）

当前方式：成员在 `agent-network.zwteam.top` 输入 flaremo.kosx.ai 的用户名和密码，节点转交给 FlareMo 一次，不保存也不记录。节点只保存 FlareMo 返回的访问令牌，最长 1 小时，退出即删除。

风险：成员要在另一个域名输入 FlareMo 密码，容易被人模仿成钓鱼页面。缓解措施：
- 只对受邀成员开放，加入必须凭 owner 签发的邀请；
- 页面标明登录的 FlareMo 实例；
- 你把该来源加入信任列表，本身就是明确同意。

更好的方案是 FlareMo 启用 OAuth/OIDC 跳转授权，密码只在 FlareMo 自己的页面输入。如果你倾向这个方案，我们会等它就绪再上线。

## 请求量估算

一个受邀规模的社区（几十名成员以内）对 FlareMo 的请求：
- 事件同步：有活动时每 30 秒 1 次，每天最多约 2,880 次。
- 身份复核：成员每次已登录的页面操作带 1 次 `/api/v1/auth/me`。
- 业务写入：每个业务动作 1 个事务，每份报告 1 个 blob（扩展上限 10 MB，通常只有几 KB）。
- 连接器心跳和重复读取：由节点侧缓存吸收，不打到 FlareMo。

## 数据与治理

- 存储的内容：社区、成员档案（显示名和 FlareMo 资源名的绑定）、Agent 与连接器元数据、能力、需求、工作室、报告与验收记录，以及它们的历史版本和事件。
- 不存储：密码，连接器凭证的明文（只存哈希），成员本机的 Codex 登录信息。
- 删除：扩展目前没有删除接口。需要清除某个社区时，按社区 ID 在 D1 中删除这 8 张表的对应行，再删除 R2 中 `community-objects/<社区 uuid>/` 前缀下的对象；这需要你和维护者共同确认。
- 回滚：停用服务账号即可立刻切断访问。迁移只新增表，回滚代码不需要删表。

## AGPL 义务

补丁是对 FlareMo（AGPL-3.0）的修改。在线上提供服务时，需要向这个实例的用户提供修改后的源代码，例如公开 fork 或合入上游。具体方式由你决定；社区节点本身的代码是 MIT 许可，不包含 FlareMo 代码。

## 需要你回复的信息

- 线上部署的提交号，以及是否可以部署补丁。
- 服务账号的资源名 `users/...`，授权完成后告诉我们。
- 信任来源是否已加入，WAF 是否需要放行。
- 对第 5 节登录方式的决定。
