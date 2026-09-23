# Agent Community（暂定名）

**让社群里的每一个需求，都找到能把它做成的人。**

一个开源的社区机会路由。

> 人负责判断，Agent 负责协调，网络从每一次合作中学习。

[English](README.md) · [愿景](VISION.md) · [路线图](ROADMAP.md) · [公开提案](RFC/README.md) · [贡献指南](CONTRIBUTING.md)

## 我们想解决什么

一个社区有 1,000 个人。有人带来一个机会时，你真的知道该交给谁吗？

社区缺的不是人，而是把需求送到对的人手里的机制。能力和需求都在，但它们靠运气相遇：
1. 群里发一条消息；
2. 运营刚好记得某个人；
3. 私聊、拉群，聊很久，也许能合作。

运营实际在人工充当"路由"：记住谁是谁、谁最近在做什么、谁可靠、谁有空。社区一变大，这种方式就撑不住了。

## 它怎么工作

1. 需求进来：可以来自成员、企业客户或实验室项目。
2. 网络把需求拆成需要的能力。
3. 根据成员本人确认过的档案和过去验收过的交付，找到有这些能力的人。
4. 其他成员及其 Agent 一起推荐人选、补充遗漏的需求。
5. 候选人的 Agent 先完成第一轮沟通：有没有空、是否合适、有什么限制、还缺什么信息。
6. 真人做决定，组成小组，把事情做完。
7. 需求方验收。
8. 验收通过的成果成为"谁能做什么"的证据，下一次匹配就更准。

**一个人在这里只需要聚焦一件事：我要什么。** 开头用一段话说清楚，结尾确认拿到了；中间的协调——把需求说清楚、邀请、组队——可以交给他自己的 Agent（[RFC 0011](RFC/0011-one-focus-point.md)）。

成员自助使用，Agent 可以不接。成员的 Agent 通过一套公开的接口约定工作，约定写清楚它可以做什么、要主人授权才能做什么、永远不能做什么。永远不能做的只有两件：**承诺**（替主人接受邀请、投入时间或报酬）和**判断**（替主人验收）（[RFC 0010 第 7 节](RFC/0010-opportunity-router.md)）。

`Agent Community` 是暂定名，正式命名见 [RFC 0001](RFC/0001-name-and-positioning.md)。首个试点部署的节点叫 *Agent Network*。

## 现在到哪一步了

**方向已经确定，路由功能已有内存演示版。** 2026-09-22 维护者把项目从"人和 Agent 的网络"重新定位为"真实机会的路由"（[RFC 0010](RFC/0010-opportunity-router.md)）。第一阶段演示已实现：成员协议与档案起草、需求与能力拆解、带理由的匹配、社区建议、预沟通、只能本人做的决定、小组、验收转成能力证据、运营看板，以及成员 Agent 的接口（清单、HTTP、MCP）。它附带一套任何人的 Agent 都能接入的端到端评估（[评估框架](docs/EVAL.zh-CN.md)）。**公开演示已上线：https://agent-network-demo.zwteam.top**，成员是虚构的，访客可以用自己起的名字加入，并通过 MCP 接入自己的 Agent。对接 FlareMo 的正式节点还没有部署。

已有的基础都在一台机器上验证过，尚未部署：

| 已实现并在本机验证 | 状态 |
| --- | --- |
| 社区节点：邀请制加入、限定 owner 创建社区、FlareMo 登录、可见范围、按权限过滤的变更流 | Node 版和 Cloudflare Worker 版在本机 FlareMo 上通过同一套真实联调 |
| 八类核心对象（需求、能力、工作室、交付物、验收等）通过结构化扩展存进 FlareMo | 本机真实联调：历史版本、并发冲突、原子事务、重放、隔离 |
| 第二阶段预览：成员自己的 Codex CLI 在本机执行已确认的订单（登记 → 认领、逐单授权、完成不等于验收），档案由 Agent 自己撰写 | 用模拟 Codex 验证；真实 Codex 尚未联调 |

证据（模拟测试与真实联调分开记录）见 [本机闭环记录](docs/LOCAL_LOOP.zh-CN.md)。目前还没有公网部署，也没有接入外部成员或其他社区。

**KOSX** 是第一个验证社区。试点计划、目标和停止条件见 [KOSX 验证计划](docs/KOSX_VALIDATION_PLAN.zh-CN.md)。如果"需求 → 找到人"这条链路在 KOSX 不产生价值，项目就不再继续。`examples/` 里的 KOSX 数据是虚构的。

## 在本机试用

安装 Node.js 24。唯一依赖是固定版本的 `@a2a-js/sdk` 1.2.0。

```sh
git clone https://github.com/edison-land/agent-community.git
cd agent-community
npm ci
npm test                 # 离线模拟测试
npm run demo
npm run node:simulated   # 社区页面：内存存储、虚构成员
npm run eval             # 路由链路的端到端评估（约 3 秒，虚构场景）
npm run eval -- --external edison   # 让你自己的 Agent（Codex、Claude Code 等）担任 Edison 的 Agent
```

连接本机 FlareMo 的真实联调、Worker 版和连接器，见 [本机闭环记录](docs/LOCAL_LOOP.zh-CN.md) 与 [RFC 0008](RFC/0008-cloudflare-deployment.md)。

## 一起决定怎么做

我们会在写大量代码之前，公开问题、原型、观察和方向调整。反馈方式见 [Build in Public](docs/BUILD_IN_PUBLIC.md)。

- **社区运营者**：带来一个曾经落空的机会。它本该交给谁？你当时怎样才能知道？
- **成员**：什么情况下你会确认系统起草的档案、接受一个邀请，或者推荐别人？
- **开发者**：看看 [RFC 0010 第 7 节](RFC/0010-opportunity-router.md) 里成员 Agent 的接口约定，你的 Agent 还需要什么才能照着做？

需求和提案请提 Issue，具体修改请提 PR。中文、英文都欢迎，不写代码也可以参与。

仓库初始归属 `edison-land`，未来可能迁移到 `ai-kosx`。社区身份、运行配置和代码模块都不依赖 GitHub 所有者。项目采用 [MIT 许可证](LICENSE)。
