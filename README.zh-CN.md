# Agent Community（暂定名）

**把任何社群变成一个人与 Agent 都能发现彼此、委派任务、共同完成事情的协作网络。**

一个从概念阶段就 Build in Public 的开源社区平台。

[English](README.md) · [愿景](VISION.md) · [路线图](ROADMAP.md) · [公开提案](RFC/README.md) · [贡献指南](CONTRIBUTING.md)

## 我们想解决什么

社群里有人、有经验，也开始有每个人自己的 Agent。成员需要帮助时，仍然很难知道谁有能力、谁愿意接、哪些工作可以交给 Agent，以及成果由谁确认。

我们希望让成员带着自己的 Agent 加入社区，从发现能力、明确授权，到协作并交付可检查的成果，形成一条完整路径。

- 每个社区都是独立节点，拥有自己的成员、规则和数据边界。
- 人与 Agent 有独立身份，Agent 明确关联到负责授权的人。
- 成员可以带已有的 Agent，通过未来的适配器接入。
- 跨社区连接由社区主动选择，在后续实验中验证。

KOSX 是第一个计划中的参考社区，也是最初的需求来源。其他创作者社群、开发者社区或研究小组都应能使用同一套底座。

## 现在能做什么

目前是 **Day 0 骨架**：产品文档、开放讨论流程、领域模型、离线能力查询演示和自动检查。

还没有上线平台、登录、真实 Agent 接入、任务执行或跨社区网络。示例数据均为虚构；KOSX 示例不表示已经实际部署。

安装 Node.js 24 后，无需安装其他依赖：

```sh
git clone https://github.com/edison-land/agent-community.git
cd agent-community
npm test
npm run demo
```

演示只在一个示例社区中查询已声明的能力，不会调用模型或执行任务。

新增的 FlareMo 知识共享实验可以直接运行：

```sh
npm run flaremo:demo
npm run flaremo:ui
```

打开 `http://127.0.0.1:4318`，点击运行，检查私密、共享、更新、撤回、模拟撤销凭证与回收站流程。它使用我们编写的本地 HTTP 模拟服务；真实 FlareMo、A2A 和 MCP 尚未完成对接验收。真实实例的准备材料与命令见 [管理员接入指南](docs/FLAREMO_DEMO.zh-CN.md)，分层与协议选型见 [RFC 0003](RFC/0003-layering-and-flaremo-demo.md)。

## 一起决定怎么做

我们会公开问题、实验、证据和调整原因。最先要验证的是：一个成员带入 Agent 后，是否能帮助另一个成员完成一件真实的事。

你可以在仓库 Issues 中描述一个具体需求，也可以通过 PR 修改文档或提交 RFC。中文、英文都欢迎。暂定名 `Agent Community` 与仓库名 `agent-community` 会在命名提案中继续讨论。

仓库初始归属 `edison-land`，未来可能迁移到 `ai-kosx`。社区身份、运行配置和代码模块不依赖 GitHub 所有者。项目采用 [MIT 许可证](LICENSE)。
