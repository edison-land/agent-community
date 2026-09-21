# RFC 0005 — 八类核心对象与 FlareMo 持久化协议 v0.1

Status: Draft protocol; eight-object vocabulary and FlareMo target storage are maintainer-directed. Wire fields and the upstream extension require review and integration acceptance.
Date: 2026-09-21
Supersedes: the separate Community authoritative database assumption in the earlier blueprint. Refines RFC 0002/0003. Live execution is not authorized by this RFC.

## 决策与实际交付

八类对象是产品核心：Community、Human、Agent、Capability、Request、Workroom、Artifact、Attestation。必须先建立对象及其存储/通信契约，再扩大页面功能。

**目标：FlareMo 保存这八类对象的持久权威记录，Community 定义业务规则并执行授权。** 不再维护一份独立、可分别修改的 Community 主数据库。Community 的查询缓存可重建；私钥、密码、短期会话和运行环境凭证不进入这些对象。

本轮提供 [JSON Schema](../protocols/community/v0.1/object.schema.json)、[完整虚构对象图](../examples/protocol/eight-objects.json)、离线校验器和内存事务契约测试。它们尚未写入真实 FlareMo，不是生产授权服务。八类对象与六个代码层是不同维度。

## 对象、关键字段与写入责任

| 对象 | data 关键字段 | 写入责任与生命周期 |
| --- | --- | --- |
| Community | displayName, ownerHumanId, status | 创建者引导建立，之后管理员治理；active → archived |
| Human | personId, displayName, status | 成员管理自己的档案，成员状态由入群规则/管理员确认；active ↔ suspended，active/suspended → left |
| Agent | principalId, displayName, bindingStatus, interface | 负责的人声明，连接器控制权验证成功后服务才能标记 verified；unverified → verified → revoked；status active/disabled |
| Capability | providerKind/providerId, title, description, inputMediaTypes/outputMediaTypes, status | 提供者发布；draft → published → withdrawn；重新发布需核验当前归属和成员状态 |
| Request | requesterHumanId, capabilityIds, acceptanceCriteria, status | 请求者提出和验收；draft → open → assigned → review → accepted；可撤销，review 可返回 assigned 修改 |
| Workroom | requestId, participantHumanIds/participantAgentIds, status | 参与者经邀请/接受进入；forming → active → closed；参与者变化要撤销受影响的 Grant |
| Artifact | workroomId, producerId/principalId, mediaType, blob.uri/sha256, status | 执行者提交版本；draft → submitted → finalized/withdrawn；已引用的版本与文件不可覆盖 |
| Attestation | issuerHumanId, subjectId, requestId, artifactId/revision/sha256, outcome, statement | 有资格的真人签发；issued → revoked。正文不可改写，修订创建新对象并用 supersedesId 关联 |

精确定义见 [CONTEXT](../CONTEXT.md)。Capability 是声明，不是已证明的技能。Attestation 是某人的可追溯陈述，不是系统保证其结论正确；自评、他人验收必须区分。数字签名和独立验证密钥尚未实现，不能把目前 JSON 示例宣传为密码学证明。

v0.1 的 Human 是一个社区内的成员记录；personId 可关联同一个人在不同社区的已验证身份，但不可公开用于跨社区画像，绑定需本人确认。不同社区的 Human ID 不自动共享权限。Membership、IdentityLink、AgentBinding、Grant、Execution、BlobManifest、Outbox 是支撑记录，不取代或扩充八个产品核心对象。正式后端需要为它们另建结构化、可授权的存储记录，也使用 FlareMo 扩展的持久层。

## 公共对象信封

所有对象必须包含：

| 字段 | 约束 |
| --- | --- |
| protocol / schemaVersion | `community-objects` / `0.1.0`；未知版本拒绝，迁移显式执行 |
| kind / id | 八种类型之一；标准 UUID URN，创建后稳定，不含 GitHub owner、邮箱或名称 |
| communityId | 强制分区；Community 本身的 communityId 等于 id |
| revision | 从 1 起，每次成功更新严格加 1，由服务生成 |
| createdAt / updatedAt | UTC、带毫秒的标准时间；由服务生成，更新必须递增 |
| lifecycle | active 或 tombstoned；墓碑不能恢复为原 ID 的活动对象 |
| actor | 操作者类型、ID 和 principalId；由认证上下文和当前 AgentBinding 计算，不能信任提交者自填 |
| visibility | private / community / workroom；workroom 必须给出有效 Workroom ID |
| data | 对应类型的严格字段集合；额外未知字段拒绝 |

private 默认仅归属者/经明确治理授权的管理员可读；归属按对象类型定义：Community owner、Human 自己、Agent principal、Capability provider 的 principal、Request requester、Workroom 所关联 Request 的 requester、Artifact principal、Attestation issuer。管理员治理权必须单独记录，不隐含为任意 Agent 的权利。community 可读范围为当前有效成员；workroom 为当前有效参与者且仍为有效社区成员。资料权限与对象可见性取交集；能看 Artifact 元数据不等于可下载原文件。

列表、按 ID 读取、历史版本、事件流、导出与向量检索都执行同一权限检查。直接按 ID 查询不能绕过社区分区。向量索引仅是发现工具。

## 关系与不变量

```text
Community ← Human → Agent → Capability
Community ← Capability ← Request → Workroom → Artifact → Attestation
                         ↑                         │          │
                      Requester                 Producer    Issuer
```

- 所有对象引用必须存在、类型正确且属于同一 communityId。v0.1 不接受跨社区对象引用；将来联邦通过专门的引用/授权协议引入。
- Agent principal 必须是该社区的 Human；Agent 参与 Workroom 时其 principal 也必须参与。
- Community 与首位 Human 存在互相引用，必须在同一次原子引导事务中建立；不能以关闭外键检查解决。
- Artifact 必须来自 Workroom 的合法参与者，producer 与 principal 要匹配；文件引用必须附内容哈希。
- Attestation 必须引用确定的 Artifact 版本和哈希，并匹配 Request/Workroom/贡献者；后来修改成果不能悄悄改变已有评价的对象。
- A2A completed 只结束 Execution，不自动将 Request 置为 accepted。接受需要请求者对具体成果的有效验收证据。
- Schema 校验不是授权。真实服务必须核验操作者、当前成员资格、Agent 绑定、Grant、状态转换及可见范围；不能把模拟数据里的 verified 字符串当成控制权证据。

## FlareMo 怎样保存

建议实现一个 **FlareMo Community Object 扩展模块**，复用其部署和 D1/R2 能力：

| 存储记录 | 用途 |
| --- | --- |
| community_objects | communityId、kind、id、revision、归属、可见性、严格 JSON、墓碑；保存当前版本 |
| community_object_versions | 不可覆盖的对象历史版本，供证据引用和迁移 |
| community_object_relations | 引用与类型、作用域检查，按社区查询 |
| community_commands / community_outbox | 幂等命令回执与同事务写入的变更事件 |
| community_identity_links / memberships / grants / executions | 支撑身份、权限和任务恢复；不是普通可编辑笔记 |
| blob manifest + R2 | Artifact 的文件、哈希、版本与下载权限；URL 只是定位，访问必须再授权 |

以上是新增设计，不是声称 FlareMo 已有这些表。扩展应在 FlareMo 内由认证且受限的服务身份调用；成员身份/Agent 归属由可信后端从记录验证，不接受任意 `actor` 请求头作为授权。Community 后端不持有任意管理员全权并把它暴露给 Agent。

普通 memo 可以保存这些对象的**可读展示副本/导出**，但复制的 JSON、标题或标签不能成为执行授权真源。结构化对象更新后再更新展示副本，失败只标记展示滞后，不产生两个独立主版本。

如管理员不能部署结构化扩展，可先测试 private memo 中的对象序列化、往返读取和人工演示；该模式必须声明不具备本协议的事务、并发和 ACL 保证，不能承载真实委派。不能静默改回独立权威数据库。

## 拟新增的存储 API（尚未实现）

以下路径是本项目提出的扩展接口，不是 FlareMo 当前可调用接口。

| 方法与路径 | 必须满足的语义 |
| --- | --- |
| POST /api/community/v1/transactions | `{communityId, commandId, writes:[{expectedRevision, object}]}`；最多 100 个对象，原子校验、写版本、关系、命令回执与 outbox |
| GET /api/community/v1/objects/{id} | 必填 communityId；当前授权读取，返回 revision/ETag |
| GET /api/community/v1/objects/{id}/versions/{revision} | 同等权限检查，读取原始版本，不把历史可见性当作当前授权 |
| GET /api/community/v1/objects | communityId + kind + opaque cursor；服务端先过滤权限再分页 |
| GET /api/community/v1/events | communityId + cursor；仅返回当前仍可读的变更提示；撤权仅发送失效指示，不携带撤回正文 |
| POST /api/community/v1/blobs | 有限大小与媒体类型、归属和 hash；完成文件验证后才能被已提交 Artifact 引用 |

新建 expectedRevision=0；更新值必须等于当前 revision。冲突返回 409，禁止最后写入覆盖。对象正文中的 revision 必须是 expectedRevision+1，时间/actor 等由服务校验并权威生成。响应含 commandId、communityId、事件 cursor 与各对象 id/revision。支持服务端生成 ID，也支持验证后接受标准 UUID；ID 与 memo 资源名分离。

真实命令幂等键域为 communityId + authenticated caller + commandId，同键同语义请求返回原回执，同键不同内容返回 409。日志中的敏感载荷不明文存入回执。写入中途失败必须全部回滚；提交成功但响应丢失时靠同一 commandId 查询/重试，不能新建另一个命令。服务必须定义保留期；未定前不开放无人值守执行。

对象生命周期墓碑、撤权和索引失效写入同一事务；硬删除与隐私擦除另外设计，不能伪装为撤销 Attestation。R2 与 D1 不假设跨服务事务：先上传临时文件并验证哈希，再提交引用；失败保留可清理的孤立文件，不暴露半提交成果。

## 事件与恢复

对象事务是权威写入点。每次提交产生单调 cursor，事件带 objectId/revision/changeType，不默认带私密正文。消费者持久保存游标、去重后按当前权限重新读对象。重复、延迟和乱序不覆盖新版本；断线从游标恢复，游标过期时重新获取有权限的快照。SSE/网页通知、向量检索和 memo 展示副本都是派生结果。

Agent 离线、A2A 状态和业务验收分别存储。断线后权限不确定时停止新的敏感操作；不从旧索引恢复授权。

## 当前上游能力与缺口

审阅 FlareMo `e42d98fb65a505dacd9bac6501d3df0344832e7f`：

- [memo routes](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/apps/worker/src/routes/memos-current/memo-routes.ts) 支持笔记 CRUD、附件和关系；create 不接受自定义 memoId，PATCH 调用现有 updateMemo，没有本协议的 expectedRevision/原子对象事务。
- [team mode](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/docs/team-mode.md) 的单团队共享不能直接当作 Workroom ACL。
- 现有 webhook 不能直接当作上述持久、授权过滤的对象事件游标，需要扩展设计和验收。

因此“全部对象存 FlareMo”是明确的目标，完成条件是结构化扩展通过测试，不能用普通笔记写入成功代替。FlareMo 上游 AGPL 代码不复制进本 MIT 仓库；本轮独立编写契约与模拟。若实现上游扩展，另行确定其仓库与许可证归属。

## 验收与下一步

本地：八类字段与关系完整；两位虚构 Human 共九条记录；原子引导、悬空引用、跨社区引用、错误 principal、证据版本、CAS 冲突、幂等重放、事件游标和返回值隔离测试。

内存 harness 仅检查结构、关系、版本冲突和部分证据约束；不实现真实身份、完整生命周期守卫、ACL、数据库隔离、签名、文件哈希读取或生产可靠性。

接下来请 FlareMo 管理员/维护者确认：能否部署该结构化扩展；服务身份与用户授权如何映射；现有团队与 Community 的部署关系；D1 原子更新/索引/导出恢复如何实现。第一轮只在本地模拟执行契约，管理员确认扩展后才做真实存储适配器。
