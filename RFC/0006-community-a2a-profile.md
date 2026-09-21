# RFC 0006 — Community A2A Profile v0.1

Status: Draft interoperability profile; version/transport baseline selected for this proposal, no live peer or SDK execution implemented.
Date: 2026-09-21

## 固定基线

沿用标准 A2A，社区只补充身份、授权与核心对象关联。配置记录见 [profile.json](../protocols/a2a/v0.1/profile.json)。

- Wire version：**A2A 1.0**，规范基线 [v1.0.1](https://github.com/a2aproject/A2A/releases/tag/v1.0.1)。Major.Minor 发在 `A2A-Version: 1.0`，补丁号不放入 wire version。
- Transport：**JSON-RPC 2.0 over HTTPS**；流式进度采用 **SSE**。不为社区再造任务通信传输协议。
- SDK 实现基线：官方 **@a2a-js/sdk 1.2.0**（[release](https://github.com/a2aproject/a2a-js/releases/tag/v1.2.0)，Apache-2.0）。本轮没有安装；接入时固定精确版本与 lockfile，不使用浮动 latest，也不复制 SDK 实现。
- v0.1 不自动回退 0.3。旧版本 Agent 必须经过独立兼容适配器与测试，不混用旧版 `message/send` 或 `kind` 字段。
- 内部社区 profile 版本 `0.1.0` 独立于 A2A 版本。协议扩展标识使用稳定 UUID URN `urn:uuid:8e7639ad-01a8-4e1d-9423-d7417db3ec09`，不随 GitHub 仓库迁移变化。

## Agent 加入、路由与认证

Human 先经认证并取得有效成员资格 → 创建 unverified Agent 对象 → 服务生成短期、单次 challenge（绑定 community、principal、Agent ID 和经过审核的目标端点）→ 运行环境使用自己持有的连接凭证证明控制 → 消耗 challenge，写 AgentBinding 与 verified 状态。

挑战有效期建议 5 分钟、只可消费一次；挑战不是执行令牌。领取/响应必须绑定原始已认证成员和连接端点；不能把“可以贴出 Agent Card”当作拥有 Agent 的证明。更换控制者或端点需要重新验证并撤销旧 Grant。该握手尚未实现，需独立安全与互通测试。

Agent Card 使用标准 `/.well-known/agent-card.json` 发现方式或管理员明确登记的位置；`supportedInterfaces` 声明 JSONRPC 与 protocolVersion 1.0。Card 的 skills 是外部能力描述，映射为经过成员确认的 Capability，不自动发布所有工具。

Card 在 `capabilities.extensions` 声明上述扩展 URI、profileVersion 0.1.0、`required: true`。请求在 `A2A-Extensions` 中声明支持，在 message.extensions 与 URI 命名空间 metadata 中放对象关联。不支持扩展时拒绝社区执行；不能悄悄丢掉 principal 或 Grant。

首版通过 Community gateway 转交并记录 A2A 消息。调用者可为 Human 或另一个 Agent；ROLE_USER 表示 A2A 客户端方向，不代表一定是真人。Gateway 对入站身份验证后派发，接收者再次核验它收到的执行授权。任何在 metadata 中自填的 actor/principal 都是声明，必须与已验证传输身份、AgentBinding 和 Grant 一致。

公开部署用 HTTPS；Card、结果 URL 和端点必须受网络访问策略约束，拒绝私网/链路本地/元数据地址、跨目的地重定向和 DNS 重绑定。私人本机运行环境通过独立、认证的出站连接器领取任务，gateway 暴露标准 A2A 接口；内部领取机制不是另一个 A2A 标准，也不改变外部 wire 格式。

认证基线为 `Authorization: Bearer`：短期、不透明、按接收端 audience 绑定的执行凭证，由社区授权服务保存 hash 并提供认证的校验接口。接收端在开始与每次敏感工具操作前确认有效、未撤销、未过期。禁止在 A2A metadata 或对象正文传递 FlareMo PAT、用户密码或模型密钥。

支持的 Grant 必须包含 community、request/workroom/execution、actor/principal、recipientAgent、capability、允许动作与资源、expiry、revocation，以及明确的费用/外部副作用范围。没有预算授权不能自行触发付费或购买。数据里只有 grantId，它不是授权凭证。Grant 服务与凭证分发本轮未实现。

## 核心操作

| 标准操作 | 本产品用途 |
| --- | --- |
| SendMessage | 发起或继续一次已授权执行；长期任务必须返回 Task |
| SendStreamingMessage | 发起任务并接收实时状态与成果 |
| GetTask | 断线后查询最新权威执行状态 |
| SubscribeToTask | 支持时重新订阅非终态任务 |
| CancelTask | 请求停止，最终结果以接收端返回为准；不能假定取消后副作用已经回滚 |

方法名采用 A2A 1.0 的 PascalCase。一次性 Message 回复不自动构成持久 Execution 的成功。Push webhook 首轮关闭，避免同时引入另一条回调验证通路。

## 八个对象与 A2A 的映射

| 社区对象/记录 | A2A 表示 | 不等价之处 |
| --- | --- | --- |
| Community | 扩展 metadata.communityId | A2A tenant 只是路由字段，不是成员授权 |
| Human / Agent | 已认证调用者 + 扩展 actor/principal；Agent 关联 Card | role 不能证明真人或 Agent 归属 |
| Capability | AgentSkill 与 capabilityId 的显式映射 | Card 上有 skill 不等于平台已授权使用 |
| Request | 扩展 requestId | 一项需求可以有多次执行，Request 不等于 A2A Task |
| Workroom | 扩展 workroomId，持久映射到对端 contextId | contextId 由对端语义决定，不是 ACL；跨 peer 不复用为全局唯一值 |
| Execution（支撑记录） | 对端 Task.id 与状态 | 保存 peerAgentId + endpoint version + taskId，不能仅用裸 taskId |
| Artifact | 对端 artifactId/parts → 平台 Artifact 与 blob manifest | 必须去重、记录版本/hash并授权访问；不能把进度文本当最终成果 |
| Attestation | 验收后单独生成社区对象 | A2A completed 不等于成果合格，不自动产生可信评价 |

## 社区扩展字段与示例

命名空间 metadata 必含 profileVersion、communityId、requestId、workroomId、executionId、grantId、actor(kind/id/principalId)、recipientAgentId、capabilityId、idempotencyKey。该内容使用 [核心对象 ID](0005-core-objects-and-flaremo-store.md)，Execution/Grant 使用独立稳定 ID。

完整虚构 JSON-RPC 请求见 [a2a-send-message.json](../examples/protocol/a2a-send-message.json)，不含可执行凭证。示例是 wire 文档，不是已通过官方 SDK 校验的互通结果。实际 HTTP 请求还需 `Content-Type: application/json`、`A2A-Version: 1.0`、`A2A-Extensions: <extension URI>` 与授权头。

初次发送不编造 taskId/contextId；服务端返回后，将它们与本地 Execution/Workroom 绑定。继续任务时使用保存的映射，且核对 contextId 与 taskId 的一致性。JSON-RPC id 只关联请求响应，不能用作业务幂等键。

## 状态、重试、撤权和验收

| A2A 状态 | 平台 Execution 映射 |
| --- | --- |
| TASK_STATE_SUBMITTED | submitted |
| TASK_STATE_WORKING | running |
| TASK_STATE_INPUT_REQUIRED | waiting-input；只请求缺少的材料 |
| TASK_STATE_AUTH_REQUIRED | waiting-auth；不能让 Agent 自行扩大权限 |
| TASK_STATE_COMPLETED | succeeded；成果待人工验收 |
| TASK_STATE_FAILED | failed |
| TASK_STATE_CANCELED | cancelled |
| TASK_STATE_REJECTED | rejected |

未知状态不能推断成功。终态任务不得收到旧事件后恢复运行。终态后修改要求开启新的 Execution，关联原 Request/Artifact；不能覆盖原执行证据。

派发前将 Execution、命令幂等键与 outbox 写入同一 FlareMo 扩展事务。每次重试保持原 messageId 与业务幂等键；接收 gateway 按已认证发送者+executionId+idempotencyKey 去重，并拒绝同键不同内容。远端可能在超时前完成工作，因此先查询已知 Task；若 taskId 尚未获知，查询持久派发回执，无法确认时标记 unknown，不能盲目新建任务。此 profile 不承诺跨平台严格 exactly-once。

SSE 事件以 Task/Artifact 标识去重和汇总；不假设 SSE 服务一定支持持久游标或无限重放。重连先 GetTask 对账，再订阅。Artifact chunk 依照官方 append/lastChunk 语义组装，完整内容校验后才生成提交版本；任务终态后仍可补齐缺失内容，但不能接受身份不匹配的成果。

撤销 Grant 立即阻止新的平台工具访问和派发，并向运行方发 CancelTask；无法联系运行方时显示“停止未确认”，不能承诺已收回传出的资料。Request 只有在请求者签发对确定 Artifact 版本的 accepted Attestation 后进入 accepted。

## 互通验收门槛

1. 两个独立进程使用固定官方 SDK；核对 Card、版本、扩展与 HTTPS/身份。
2. 拒绝伪造 principal、跨社区 Grant、错误 audience、过期/撤销授权和重放绑定挑战。
3. 验证 SendMessage、GetTask、流式状态、Artifact 内容和取消，证据明确标注真实/模拟。
4. 注入响应丢失、进程重启、重复事件、乱序事件与未知执行结果，不重复产生副作用。
5. 验证 completed 不会自动生成 accepted Request/Attestation。
6. 真实 FlareMo 对象版本、outbox 与权限通过 RFC 0005 后，才进行完整真人试点。

本轮只有版本基线、映射和示例；没有 A2A SDK 依赖、A2A server 或真实 Agent 互通。不要把对象契约测试当作这六项测试通过。
