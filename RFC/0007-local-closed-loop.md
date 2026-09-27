# RFC 0007 — 本机闭环：Agent 归属证明、连接器协议与逐单执行授权

Status: Accepted for the local closed-loop experiment; public deployment and external members are out of scope
Date: 2026-09-21
Decision basis: the maintainer chose an independent local FlareMo, Codex CLI as the first adapter, per-order confirmation by the agent owner, and a research-report scenario ([plan](../docs/plans/2026-09-21-local-agent-community.md)). This RFC records the boundaries and implementation choices made while building it. Evidence and remaining gaps are in [the local loop record](../docs/LOCAL_LOOP.zh-CN.md).

## 目标

成员 A 发布调研需求 → 成员 B 逐单确认 → B 自己的 Codex CLI 在本机执行 → 报告存入 FlareMo → A 验收并签发 Attestation。A 可以提出修改意见进入下一轮，B 再次确认时可以切换模型。

## 组件与进程

| 进程 | 位置 | 职责 |
| --- | --- | --- |
| FlareMo（`wrangler dev --local`） | 独立源码副本，AGPL，分支 `community-object-extension`，基于 `e42d98f` | 八类对象与支撑记录的权威存储：D1 + R2 |
| Community node（`apps/node`） | 本仓库 | 页面、业务规则与授权、A2A 网关、连接器接口；只监听 127.0.0.1 |
| Member connector（`apps/connector`） | 本仓库，运行在成员机器 | 登记后由成员认领；主动出站连接，逐单领取、调用 Codex CLI、回传 |
| Requester A2A client（`apps/a2a-client`） | 本仓库 | 独立进程，用官方 SDK 与网关互通（阶段③验收） |

本仓库只包含 FlareMo 扩展的 HTTP 客户端，不复制上游 AGPL 代码。

## 1. FlareMo 对象扩展（实现 RFC 0005）

新增 `/api/community/v1`（仅 PAT，不接受浏览器 Cookie）：

- `POST /service-accounts`：只有实例 owner 能授权/停用“社区服务账号”。
- `POST /transactions`：≤100 个实体原子写入。版本约束由数据库本身保证：`community_entity_versions` 以 `(entity_id, revision)` 为主键，并用自引用外键 + CHECK 要求 `previous_revision = revision - 1`。陈旧写入、跳号或并发写入在同一 D1 batch 内失败并整体回滚，不依赖服务层预读。
- 命令回执键为 `communityId + 服务账号 + commandId`，同键同内容返回原回执（`replayed: true`），同键不同内容返回 409。
- `community_relations` 用复合外键 `(community_id, id)` 保证引用存在且在同一社区；引用字段由 FlareMo 按对象类型自行提取，调用方不能省略。
- 同一 batch 写入单调事件游标；`GET /events?cursor=` 断线补同步。
- `PUT /blobs/:sha256` 校验哈希后写 R2；Artifact 只能引用已验证的 blob，Attestation 必须与所引用 Artifact 版本的哈希一致，已签发 Attestation 只能撤销、不能改写。
- 社区分区在首次写入 Community 对象时绑定到调用的服务账号；其他服务账号读写该社区一律 404。

**与 RFC 0005 的差异（明确记录）**：RFC 0005 设想 FlareMo 对每个读取者过滤可见性。本实现中，FlareMo 负责服务身份与社区分区，按成员/Workroom 的可见性过滤由 Community node 在每条读取路径执行；扩展接口不对普通成员开放。若将来需要成员直接读取 FlareMo，再补读取者上下文。

新表已登记到 FlareMo 的备份清单（restore tables），FlareMo 全量单测 945 项通过（见记录）。

## 2. 支撑记录与 Schema 修订

[记录 Schema](../protocols/community/v0.1/record.schema.json) 定义 Membership、IdentityLink、AgentBinding、Grant、Execution。它们与八类对象同样存在 FlareMo 中、同样有版本与事件，但不是产品核心对象。

对草案 0.1.0 的增量修订（仍为 0.1.0 草案；旧版内置校验器会拒绝新增字段）：

- `Agent.interface.cardUrl` 与 `Artifact.blob.uri` 允许 `http://127.0.0.1[:port]/`，仅用于本机阶段；公网仍要求 HTTPS。
- `Request.materials`：请求者选定、按哈希固定的公开资料。
- `AgentBinding`：只有 `active` / `revoked` 两种状态，字段为 agentId、principalId、connector（含允许的模型列表 `models`）、credentialHash、deviceId、claimedAt、rotatedAt、revokedAt、revokedReason；不再有挑战码相关字段。`Grant.model` 必须在连接器允许的模型列表内。
- `Grant.revision`：下一轮修改时，共享给 Agent 的上一版报告（id/revision/sha256）与请求者的修改意见。

## 3. 身份与成员资格

- 本机真实联调使用独立 FlareMo 的测试账号：`scripts/local/flaremo.mjs bootstrap` 生成 owner、两名测试成员和一个服务账号，随机密码与服务 PAT 只写入 `~/.agent-community/local/flaremo.json`（0600），不进仓库、不打印。
- 登录沿用 RFC 0004：用户名密码只转发给配置的 FlareMo，随后以 `/auth/me` 核验；节点每个已登录请求都重新核验。IdentityLink 以“FlareMo origin + users/ 资源名”识别，不按邮箱或显示名合并。虚构账号只在 `--simulated` 模式出现。
- 加入策略：2026-09-22 起，只能凭 owner 签发的邀请加入：一次性显示，有次数和有效期，可撤销。设置了 `COMMUNITY_OWNER_SUBJECT` 时，只有该账号能创建社区；本机 Node 版未设置时，仍允许首位成员创建社区并成为 owner（见 RFC 0008）。owner 可暂停/移除成员，暂停会级联撤销其 Agent 绑定、Grant 与进行中的执行。

## 4. Agent 接入：连接器登记 → 成员认领（唯一方式）

参考 EvoMap 的“Agent 先注册、主人用链接认领”（[skill.md](https://evomap.ai/skill.md)），并针对成员制社区做了收紧。**早先“成员先建 Agent、生成配对码、连接器输入配对码、成员核对指纹”的做法已删除，代码、接口、页面和文档中都不再保留。**

1. **登记（连接器发起，无需凭证）**：连接器在成员机器本地生成 32 字节随机密钥，只提交它的 SHA-256；指纹 = `sha256(凭证哈希)` 前 16 位，由节点复核推导关系。同时提交连接器信息（名称、平台、Codex 版本、默认与允许的模型、指令隔离）和本机设备标识（`~/.agent-community/device-id`，随机 UUID）。
2. **只在内存中挂起**：节点返回一次性认领链接 `/claim/XXXX-XXXX-XXXX-XXXX`（16 字符，约 78 bit），10 分钟有效。未认领的登记**不写入 FlareMo**，不能领取任务（`403 REGISTRATION_NOT_CLAIMED`）；登记接口限流，挂起数量有上限。
3. **认领（成员）**：成员登录后打开链接，页面显示连接器信息和指纹**前 12 位**；成员必须输入**终端上指纹的最后 4 位**。输错 5 次这次登记作废。只有能看到那台终端的人才知道后 4 位，所以别人发来的认领链接无法被认领（防钓鱼）。
4. **绑定**：认领时可新建 Agent，或绑定到自己已有的 Agent（原有生效绑定随之撤销，原因 `replaced`）。一个事务写入 Agent（`verified`）与 AgentBinding；AgentBinding 沿用登记 ID，所以连接器的凭证 `acc_<bindingId>_<secret>` 不变。平台只保存哈希。
5. **设备提示**：同一设备标识之前绑定过该成员的 Agent 时，认领页提示“这台设备之前绑定过”。设备标识由连接器自报，只是提示，不是证明。
6. **密钥轮换**：`connector rotate` 生成新密钥，先在本地记为待生效，再请求节点替换哈希；成功后旧密钥立即返回 `401 CONNECTOR_CREDENTIAL_INVALID`。若轮换在中途崩溃，连接器下次启动时会自动采用节点接受的那一把。
7. **凭证存放**：连接器状态写在 `~/.agent-community/`（目录 0700、文件 0600），拒绝写入 git 仓库、符号链接，以及 iCloud Drive、“桌面与文稿”同步、Dropbox、OneDrive、Google Drive 等同步目录。
8. **给 Agent 读的接入说明**：节点在 `/agent-onboarding.md` 提供说明（源文件 [docs/agent-onboarding.md](../docs/agent-onboarding.md)），写明登记不等于授权、每一单都要主人确认、心跳和事件不授权任何新动作。

它证明的是“输入指纹后 4 位的这位成员能看到这台连接器的终端”，不证明模型能力或运行环境隔离。解绑（页面或连接器）、成员暂停都会立即使后续访问返回 401。

与 EvoMap 的差异：未认领的连接器什么都不能做（EvoMap 允许未认领节点使用部分协议）；认领有效期 10 分钟而非 24 小时；密钥在成员机器生成，而非服务端下发明文；认领要求输入指纹后 4 位；每个 Agent 都必须有负责的成员（不设无主“机器账号”）；通信仍用 A2A 1.0，而非 EvoMap 自有的 GEP-A2A。

## 5. 连接器协议（内部，不是 A2A）

出站连接，成员电脑无需开放端口：

| 接口 | 用途 |
| --- | --- |
| `POST /connector/v1/registrations` | 登记：连接器信息、凭证哈希、设备标识；返回认领链接（每分钟 10 次上限，无需凭证） |
| `GET /binding` | 查询状态：`awaiting-claim` / `expired` / `invalidated`（登记阶段）或 `active`（认领后） |
| `POST /credential/rotate` | 替换凭证哈希，旧密钥立即失效 |
| `POST /heartbeat` | 在线状态；返回必须停止的执行列表 |
| `GET /tasks/next?wait=` | 长轮询领取已授权任务；重连时返回需要对账的执行 |
| `POST /executions/:id/events` | started / progress / failed / cancelled / unknown |
| `POST /executions/:id/artifact` | 报告 + 用量；原子写 Artifact、Execution、Grant、Request |
| `POST /unbind` | 连接器侧解绑 |

未列出的路径（包括已删除的旧配对接口）在认证前直接返回 404。

**本地回执与重启规则**：启动 Codex 前先写回执。重启后只有“确定从未启动”的执行才会启动；已完成但未回传的结果会补传；可能执行过但无法确认的，结束遗留进程并标记“状态待确认”（`unknown`），不自动重跑。撤销 Grant 时，平台只接受连接器的终态回报；撤销绑定后连接器无法再回报，页面显示“停止未确认”。

## 6. 逐单执行授权

- **确认卡**：展示任务内容、验收标准、按哈希列出的共享资料、连接器与 Codex 版本、可选模型、指令隔离状态、时限，并说明用量由 B 自己的模型账号承担、只回传报告、来源与状态。确认时提交卡片哈希；需求或连接器信息一旦变化，确认会被拒绝。
- **确认后在一个事务里写入**：Workroom（首轮）、Grant（动作 `execute-research-report`、资料哈希、模型、时限、到期、费用承担方、可选的修订上下文）、Execution（`authorized`）、Request→`assigned`。
- **执行凭证**：`aex_<executionId>_<secret>`，只绑定该执行、该 Agent 端点，带到期时间，只存哈希。默认由节点代表请求者通过 A2A 派发；手动模式（`COMMUNITY_AUTO_DISPATCH=0`）下，请求者可一次性取走凭证交给自己的 A2A 客户端。
- **完成 ≠ 验收**：Agent 完成只让 Request 进入 `review`；只有请求者对特定 Artifact 版本和哈希签发 accepted Attestation 后，Request 才会 `accepted`。
- **交互与模型切换**：请求者选择“要求修改”时，签发 changes-requested Attestation，并把意见写进下一轮 Grant。B 必须再次确认，可以换一个连接器允许的模型；下一轮在同一 Workroom、沿用同一个 A2A `contextId` 作为新任务派发。Agent 只拿到按哈希固定的上一版报告和这条意见。

## 7. A2A 网关（实现 RFC 0006）

- 依赖：`@a2a-js/sdk` 精确 1.2.0（Apache-2.0，含 lockfile），唯一传递依赖是 `jose`；Express/gRPC 可选对等依赖未安装，网关直接挂在 `node:http` 上。
- 每个已绑定 Agent 一个端点：`/a2a/agents/<uuid>`，Agent Card 位于 `/.well-known/agent-card.json`，声明 JSONRPC、1.0、必需的社区扩展和 Bearer 方案。
- SDK 负责：SendMessage、SendStreamingMessage（SSE）、GetTask、SubscribeToTask（只针对进行中的任务）。网关负责：认证、元数据与授权核对（community/request/workroom/execution/grant/recipient/capability/idempotencyKey、actor=请求者本人）、派发去重（相同 messageId 返回原任务，其他派发 409）、Workroom 与 contextId 的对应关系，以及 CancelTask。
- **与 SDK 默认取消语义的差异**：SDK 在没有活动事件总线时会直接把任务写成 CANCELED。网关自己处理 CancelTask：尚未领取的任务立即取消；已在运行的返回 WORKING，并在元数据中标记 `stopUnconfirmed: true`，等连接器确认后才变为 CANCELED。
- 节点重启后，任务视图由 FlareMo 中的 Execution 重建；这类任务的 SubscribeToTask 返回 UnsupportedOperation，客户端应先 GetTask 对账。ListTasks 与推送通知不开放。
- Codex CLI 本身不被声明为 A2A 服务；对外的 A2A 端点是社区网关。

## 8. Codex CLI 适配

- 命令：`codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check --sandbox read-only -c web_search="disabled" -C <工作目录> -o <结果> --output-schema <schema> -m <本单模型> -`；任务文本经 stdin 传入，不拼 shell；进程组独立，超时或停止时整组终止。
- **实测**（codex-cli 0.153.4）：用个人 `~/.codex` 时，即使加 `--ignore-user-config`，个人全局 AGENTS.md（含个人记忆库规则）和个人 skills 仍会进入模型提示；没有配置项可以关闭。因此连接器默认使用独立的 `CODEX_HOME`，由成员自己在该目录登录。登记前用 `codex debug prompt-input` 渲染提示检查（不调用模型），发现个人指令就拒绝登记。2026-09-22 起改为由主人选择模式：`--memory without`（上述独立目录，默认）或 `--memory with`（主人自己的 Codex，关闭 MCP 服务器、插件、Apps、hooks 等工具）。确认卡上会注明所选模式，见 [RFC 0009](0009-agent-profile-and-onboarding.md)。
- 工作目录只放按哈希校验过的资料（修改轮另加上一版报告）。只回传报告、来源和用量；原始 JSONL 事件、结果文件和回执留在本机。

## 9. 安全边界与已知限制

- 只读沙箱限制写入，**不限制读取**工作目录以外的文件；提示词里的“不读取其他文件”是约束而非强制隔离。开放外部成员前，需要容器/虚拟机级隔离（计划第 5 节）。
- 全部为 127.0.0.1 上的 HTTP。Node 版节点的会话存在进程内存中，重启后需要重新登录；A2A 调用方凭证在自动派发模式下也只存在内存里。Worker 版把两者都存进 Durable Object 存储（RFC 0008）。
- 单节点、单社区验证；未做多租户、TLS、凭证轮换、备份恢复演练，也未做第二台机器实测。
- 同一台机器上的连接器与节点共享系统用户；成员“自己的机器”在本机测试中是同一台 Mac。

## 验收

分阶段证据（模拟测试与真实联调分列）、命令与结果见 [本机闭环记录](../docs/LOCAL_LOOP.zh-CN.md)。

## 开放问题

- 外部成员接入：公网 HTTPS、邀请制注册、连接凭证轮换、离线撤权、运行环境隔离。
- 读取者级 ACL 是否下沉到 FlareMo 扩展。
- 修改轮是否允许请求者直接追加资料（当前只允许原资料 + 上一版报告）。
- Claude Code CLI 适配器（计划中的第二个运行时）。
- 成员邀请码（owner 签发，带角色、次数上限、有效期，只显示一次、可撤销），放到外部接入阶段实现。

## Decision

Accepted by the maintainer's plan for the local experiment only. Public exposure, second-machine execution and external members need a new decision after the gates in the plan's section 5.
