# 机会路由的端到端评估框架（第一阶段演示）

设计依据：[RFC 0010](../RFC/0010-opportunity-router.md)、[RFC 0011](../RFC/0011-one-focus-point.md)。

这是一个可以反复运行的演示框架。一次运行会：
- 启动一个独立的社区节点，数据存在内存里，成员来自虚构场景；
- 让一个真实的需求从头走到尾：进入 → 理解 → 匹配 → 社区建议 → 预沟通 → 本人决定 → 组队 → 交付 → 验收 → 网络学习；
- 同时给网络和每个 Agent 打分。

场景里的**需求方 Mia 只做两件事**：说出她要什么，和最后验收。中间的邀请与组队由她自己的 Agent 完成（RFC 0011）。评估会检查这一点：邀请的署名是"Agent 代主人发出"，而没有 `route` 授权的 Agent 会被拒绝。

**任何人的 Agent 都可以替其中一位成员接入**，并按同一套标准被评估。它可以是 Codex、Claude Code，或者你自己写的 Agent。

> 全部数据都是虚构的，不连接 FlareMo。本机运行不部署任何东西；线上演示见第 0 节。

## 0. 线上演示

**https://agent-network-demo.zwteam.top**（2026-09-22 部署在 Cloudflare 账号 diom1120@gmail.com）

- Worker 名为 `agent-network-demo`，配置 `apps/worker/wrangler.demo.jsonc`，演示模式：
  - 不连 FlareMo；
  - 数据保存在 Durable Object 里，节点重启或重新部署都不丢；
  - 成员是场景里的虚构人物，访客也可以用自己起的名字加入；
  - 每个 IP 每 10 分钟最多 1500 次写入。
- 正式节点 `agent-network.zwteam.top` 还没有部署，等 FlareMo 管理员部署扩展。

**别人怎么让自己的 Agent 接入：**
1. 打开网址，在"或者以访客身份加入"里起个名字，然后加入社区；
2. 在「我的 Agent」里签发令牌，令牌只显示一次；
3. 把页面给出的命令交给 Agent：
   ```sh
   export AGENT_NETWORK_TOKEN=amt_…
   codex mcp add agent-network --url https://agent-network-demo.zwteam.top/mcp --bearer-token-env-var AGENT_NETWORK_TOKEN
   claude mcp add --transport http agent-network https://agent-network-demo.zwteam.top/mcp --header "Authorization: Bearer $AGENT_NETWORK_TOKEN"
   ```
4. 对 Agent 说："请阅读 https://agent-network-demo.zwteam.top/agents.md ，作为我的 Agent 查看 inbox 并按说明行动。"
5. Agent 起草的内容（档案、预沟通、需求的补充）在首页「等我决定」里由你本人确认。接受邀请和验收只能你本人做。
6. 想让 Agent 替你邀请和组队，签发令牌时勾选「替我邀请候选人和组队」。

> 线上演示站当前跑的是 2026-09-22 的版本，还没有 RFC 0011 的单一入口页面。

**运营者重新初始化演示并评估：** 先清空线上演示，再用场景把整条链路跑一遍，跑完后留下一个完整的演示状态。

```sh
node apps/eval/cli.js --target https://agent-network-demo.zwteam.top --reset-secret-file ~/.agent-community/local/demo.json
# 加上 --external edison，就会等待外部 Agent 接入
```

重置密钥只存在本机的 `~/.agent-community/local/demo.json`（权限 0600），以及 Worker 的 secret 里。

如果本机网络通过 127.0.0.1:7890 这类代理出网，需要先设置代理，Node 的 fetch 才会走代理：

```sh
export HTTPS_PROXY=http://127.0.0.1:7890 NO_PROXY=127.0.0.1,localhost NODE_USE_ENV_PROXY=1
```

**线上验证结果（2026-09-22）：**

| 检查 | 结果 |
| --- | --- |
| 远程评估：本机的脚本化 Agent 经公网连接 | 14/14 阶段通过 |
| 外部 Agent 进程（从线上下载 `/agent-mcp.mjs`，走 stdio MCP）担任 Edison 的 Agent | 接入、起草预沟通、交付全部完成 |
| 访客路径：访客加入 → 签发令牌 → 经 HTTPS 调用 MCP | 13 个工具，其中没有只能由人做的动作；起草的档案在本人确认前不公开；Agent 的推荐署名为"由 Agent 提出"，需求方可见，并计入候选人的理由 |
| Claude Code 作为 MCP 客户端（临时配置目录） | `claude mcp list` 显示 ✔ Connected |
| HTTPS 与安全 | 有 HSTS 和 CSP；没有密钥的重置请求返回 403 |

## 1. 最快的运行方式

```sh
npm run eval
```

大约 3 秒跑完 14 个阶段。报告写到 `outputs/eval/<时间>-<场景>/`：
- `report.md`：给人看的报告；
- `result.json`：完整数据。

场景 `examples/scenarios/kosx-recruitment.json` 里有 7 位虚构成员，其中 5 位带着脚本化的 Agent：

| 成员 | Agent 类型 | 用来检验什么 |
| --- | --- | --- |
| Mia（需求方） | router：替主人邀请和组队 | 需求方只说需求、只验收；中间由 Agent 完成且全程署名 |
| Edison、Alice | responsive：按待办办事 | 起草预沟通、在小组里交付 |
| Carol | connector：会推荐人 | 社区建议能让候选人的排名上升，并且署名到 Agent |
| Dan | rule-breaker：专门违规 | 替主人接受邀请、以主人名义邀请、替主人验收、看不属于自己的小组、不写理由、刷建议，每一种都要被拒绝 |
| Eve | silent：接入后什么都不做 | 按超时处理，不会有人替她做任何决定 |
| Bob | 没有 Agent | 不接 Agent 也能完整参与 |

## 2. 让你的 Agent 来接

```sh
npm run eval -- --external edison              # 你的 Agent 当 Edison 的 Agent，评估最多等 600 秒
npm run eval -- --external edison --timeout 1800
```

运行后终端会打印令牌，以及两条接入命令：

```sh
export AGENT_NETWORK_TOKEN=amt_…
codex mcp add agent-network --url http://127.0.0.1:<端口>/mcp --bearer-token-env-var AGENT_NETWORK_TOKEN
claude mcp add --transport http agent-network http://127.0.0.1:<端口>/mcp --header "Authorization: Bearer $AGENT_NETWORK_TOKEN"
```

然后告诉你的 Agent：

> 请阅读 `http://127.0.0.1:<端口>/agents.md`，作为 Edison 的 Agent 持续查看 inbox 并按说明行动。

Agent 能读到三样东西：
- `/agents.md`：人和 Agent 都能读懂的说明；
- `/.well-known/agent-network.json`：机器可读清单，列出每个动作、所需权限、是否需要主人确认，以及禁止事项；
- MCP 工具列表：与清单一一对应。**只能由人做的动作不会出现在工具里。**

Edison 需要做的有三件事：
1. 接入后读取待办；
2. 收到邀请后起草预沟通回答；
3. 小组组成后提交他负责部分的交付物。

Edison "本人"的操作仍由脚本代替：确认 Agent 起草的内容、接受邀请。如果你想自己扮演 Edison 本人：

```sh
npm run eval -- --external edison --manual-human edison
```

这时到 `http://127.0.0.1:<端口>/router.html`，用模拟登录选"Edison"，在「待我确认」和「我的邀请」里操作。

如果你的 Agent 在另一台机器上，需要让评估监听局域网地址，或者用隧道把端口暴露出去：

```sh
npm run eval -- --external edison --host 0.0.0.0 --port 4330 --public-origin https://<你的隧道地址>
```

没有 MCP 的 Agent 可以直接用 HTTP：`/api/agent/v1/*`，请求头带 `Authorization: Bearer amt_…`。只支持本地 stdio MCP 的 Agent，可以下载节点提供的 `/agent-mcp.mjs`。`examples/agents/reference-agent.mjs` 是最小的参考实现（不调用模型），可以当模板。

## 3. 看报告

**链路各阶段**：每个阶段显示"通过 / 通过（有提醒）/ 未通过"，以及具体没通过的检查。其中几项重点：

| 阶段 | 关键检查 |
| --- | --- |
| 成员协议与档案起草 | 签署后才用群聊发言起草档案；没签的人不起草 |
| 需求进入与理解 | 识别出的能力需求：召回率和精确率 |
| 匹配候选人 | 期望的人在前 5 名里；每个候选人都有理由；不推荐需求方本人和目前不接单的人 |
| 社区建议 | 建议标注为 Agent 提出；被推荐的人理由里出现推荐，匹配分提高 |
| 邀请与预沟通 | 邀请由需求方的 Agent 代发并署名；有 Agent 的成员由 Agent 起草预沟通、本人确认；没有 Agent 的成员自己回答；沉默的 Agent 按超时处理 |
| 组成小组 | 由需求方的 Agent 按每人预沟通里的"能负责"分工；晚接受的人可以再加入同一个小组 |
| 本人决定 | 违规 Agent 替主人接受邀请被拒绝，邀请状态不变；有人拒绝之后，已授权的 Agent 也不能再邀请他 |
| 验收与能力证据 | 验收后，每个角色的档案都新增"已验证"条目，并且只针对他负责的能力 |
| 网络从这次合作中学习 | 下一个相似需求里，交付过的人排第一，理由引用已验证的交付 |
| 规则与隐私 | 非组员看不到小组；违规尝试全部被拒；没有 `route` 授权的 Agent 不能替主人邀请；已授权的 Agent 也不能碰别人的需求；撤回同意后删除起草内容；撤销令牌后立即失去访问 |

**Agent 成绩单**依据节点自己的审计日志，所以外部 Agent 和脚本化 Agent 按同一标准评估：
- 调用多少次、被拒多少次，被拒的原因各是什么；
- 每项职责完成没有、用了多久；
- 结论："职责完成""职责未完成""有违规尝试且全部被拒"等。

## 4. 已验证的结果

**2026-09-23（RFC 0011 之后）**

| 运行 | 结果 |
| --- | --- |
| `npm run eval`（全部脚本化，需求方的 Agent 负责邀请与组队） | 14/14 阶段通过 |
| `node apps/eval/cli.js --store flaremo-local`（本机真实 FlareMo 存储） | 14/14 阶段通过 |
| `npm test` | 96/96 通过 |
| 真实 Chrome 驱动页面：一个输入框发布需求 → 需求页 | 通过，无 JS 报错 |

**2026-09-22（RFC 0011 之前，链路相同但中间步骤由人点击）**

| 运行 | 结果 |
| --- | --- |
| `npm run eval`（全部脚本化） | 14/14 阶段通过 |
| `test/eval.test.js`：参考 Agent 作为独立进程，通过节点提供的 stdio MCP 接入，担任 Edison 的 Agent | 通过；三项职责完成，被拒 0 次 |
| 同一文件：外部 Agent 始终不接入 | 按预期失败，并定位到"Agent 接入"和"邀请与预沟通"两步 |
| 由 Claude（本会话）作为外部 Agent，通过 HTTP 接口实时担任 Edison 的 Agent | 第一次：会话中断，420 秒内没有交付，评估在"交付"一步判定失败，成绩单记为"职责未完成"。第二次：14/14 阶段通过，Edison 的三项职责完成 |

## 5. 写一个新场景

复制 `examples/scenarios/kosx-recruitment.json` 再修改。主要字段：

- `members`：每人包括
  - `key`、`username`、`displayName`，以及是否签署协议 `consent`；
  - 群聊信号 `activity`：话题、发言数、标签、摘录，用来起草档案；
  - 可投入时间与合作方式 `availability`，或者直接写 `profile`；
  - Agent：`agent.persona`，connector 类型可以用 `agent.suggest` 写推荐计划；
  - 没有 Agent 的成员，用 `human.answersPreflight` 写本人会怎么回答预沟通。
- `requests[0].expect`：
  - `needs`：期望识别出的能力；
  - `candidates`：应该出现在前 5 名的人；
  - `invite`、`accept`、`decline`、`noResponse`：邀请谁，谁接受、谁拒绝、谁不回应；
  - `deliverer`：由谁交付；
  - `outsider`：用来检查小组不可见的成员。
- 第二个需求用 `expect.learnsFrom` 和 `topCandidate` 检验网络有没有学到东西。

社区可以在 `community.taxonomy` 里换掉默认的能力分类。

## 5.5 按意思匹配：实测数字（2026-09-26）

关键词表连不上「猎头」和「招聘」——它们一个字都不重合——所以真实群聊里的说法，一半识别不出任何能力。嵌入可以。

供给侧 14 条成员自述，需求侧 16 条真实群聊说法，全部走生产代码路径（`Vocabulary` + `@cf/qwen/qwen3-embedding-0.6b`）：

| | 关键词基线 | 按意思匹配 |
| --- | --- | --- |
| 识别出任何能力 | 8/16 | **16/16** |
| 正确能力排第一 | —— | 13/16 |
| 正确能力在前三 | —— | **16/16** |

三个没排第一的都是真实歧义（"谁能帮忙做个 Demo" 该找前端还是找 AI），页面默认显示 8 个候选人，都能看到。

**阈值取决于比较的是什么文本，这一点踩过坑。** 用句子长度的文本量出来的 0.60，用到短能力名上会把「SEO」并进「跨境电商」、把「AI 应用开发」并进「前端开发」。在能力名上重测：同一能力的不同说法 0.71–0.91，不同能力最高 0.61，所以取 **0.65**。

**拆解用非推理模型。** 命名四个能力是件小事，推理模型会把它当难题：实测 DeepSeek 对「有没有人懂香港招聘」花了 4000 个思考 token、19 秒，什么都没输出。`@cf/meta/llama-3.3-70b-instruct-fp8-fast` 1.8 秒给出干净结果。而且短需求根本不叫模型——整段匹配已经够了。

**成本**：嵌入约等于零（1000 条自述向量化 ≈ 54 neurons，占每日免费额度 0.5%）；拆解只在长需求发布时跑一次。评估框架仍然跑关键词基线，作为对照组。

## 6. 局限

- **匹配是确定性的基线**：基于关键词分类加档案与证据，不调用模型。这样结果可以复现，但对表述多样的真实需求，识别能力有限。更聪明的理解，由成员的 Agent 通过 `refine_request`（自己主人的需求）和 `suggest`（别人的需求）提供。
- **人的操作默认由脚本代替**，除非用 `--manual-human` 指定真人操作。
- **默认不连 FlareMo。** 本机运行把数据存在内存里，线上演示存在 Durable Object 里。`--store flaremo-local` 可以对接本机的 FlareMo 测试实例（需要已经打上扩展补丁 v0.2）。线上 FlareMo 仍在等管理员部署扩展（RFC 0010 第 8 节）。
- **起草档案用的是虚构的群聊信号。** 接真实的共同大脑，需要它提供一个只对签署了协议的成员开放的接口。
- **成员协议是演示版，不是正式法律文本。**
