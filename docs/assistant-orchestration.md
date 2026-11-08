# 助理编排：聪明的助理指挥便宜的帮手

[Personal Agent](personal-agent.md) · [Model providers](model-providers-design.md) · [文档索引](README.md)

状态：2026-11-09 设计；(c) 模型配置已实现并部署 dev（[DEV-150](devlog/DEV-150-assistant-helper-model.md)）。其余各节是建议，待本人决定（见 §f）。

## 本人的要求（2026-11-09，原话摘要）

1. 用聪明的模型指挥没那么聪明的模型干活是个好办法：聪明的模型贵，不能什么都让它做。
2. 助理在 Model providers 里选一个配置（也可以用它所在电脑上的订阅）；派到各 Workspace 干活的会话另配一个模型。
3. 这份配置与 Chat 互不干扰：Chat 里某个 Workspace 也会用一个聪明模型指挥其他模型，助理的配置不能影响 Chat，也不沿用 Chat 里 Workspace 的默认模型。
4. 本人只和助理一个会话交互：助理接住、分发到各 Workspace、收回结果、整理出哪些需要人并通知人。由此怀疑 Chat 里用小模型识别“待处理”已不再合理，请分析并参考业界。

## a. 现状（代码，2026-11-09 `08add543`）

### 助理自己用什么模型

- 助理的对话（Web 首页、飞书单聊）都经 Server 的收件箱（`personalagent/assistant/inbox.go`）开回合：`run.Resolver.Pin(…, "coordinator", 助理 Workspace)` 固定一份运行快照，再用它建会话或续上一会话。Web 的 `assistantRuntime()`（`features/personal-agent/assistant-model.ts`）已没有调用方。
- 角色偏好（`personalagent/run_config.go` `RunPreference`）：`roleOverrides.coordinator` → `runDefault`（设置页的“共享默认”）→ 旧字段 `assistantProfileId` / `assistantModel` → `device_default`。账号只在家电脑上找：家电脑上的订阅（`claude_local`、`codex_local`）、启动环境（`limen_default`）与分配给它的服务端 API（model_service）都可选；model 与 effort 按该账号检查（`run/resolve.go`）。
- 同一个 coordinator 偏好还用于项目概括会话（`workspace_digests.go`，每人每天至多 50 次）；记忆维护（memory）与项目维护（governance）两个后台角色默认也继承 `runDefault`。也就是说，今天给助理选了贵模型，后台整理也用贵模型。

### 助理派出的会话用什么模型

- 助理不能自己 `create_session`：Server 拒绝并要求用 `dispatch_item`（`session_service.go` `errAssistantStartsByDispatch`）。派出都经持久的操作（`assistant/operations.go`）：`Pin(…, "executor", 目标 Workspace)`，新会话用这份快照的账号、模型、effort、预算，`ParentSessionID` 是助理会话。
- executor 偏好：`roleOverrides.executor` → `runDefault`（**即助理的选择**）→ `delegateModel = same_as_assistant` 时助理的旧字段 → `device_default`。`device_default` 在目标电脑上选：本人在该 Workspace 最近完成工作用的账号 → 第一个可用的；模型是该账号自己的默认。它**不读** Chat 的 Workspace 默认模型（`agent_defaults`），但“最近用的账号”来自 Chat 里的使用。
- 设置页（`settings-models.tsx`）是“共享默认 + 四个角色各自覆盖”的工程化表单：执行设备、账号、运行时、模型、effort、token 预算、超时、显式备用。没有“派出的工作用另一个模型”这一显式选择；`delegateModel` 在页面上已不出现。
- 选中的账号在目标电脑上不可用：操作进入 `waiting`（`execution_configuration_unavailable`），只有显式配置、限定 Workspace 的备用才会换账号；助理在派出那一刻不知道，要等它下次读清单才看到。
- 续用已有会话（`dispatch_item.sessionId`）时，若该会话的账号 / 模型 / effort 与 executor 快照不同，操作等待（`owner_configuration_differs`），直到助理用 `replaceOwner` 换一个新会话。

### 与 Chat 的接触点

| 方向                    | 现状                                                                                                                                                                                                                                      | 结论     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 助理读 Chat 的默认模型  | 不读。executor 走自己的偏好，不经 `agent_defaults` 的飞书群 / 飞书 Bot / Workspace 三层。                                                                                                                                                 | 符合     |
| 助理写 Chat 的默认模型  | 不写（`personalagent` 里没有任何 `SetAgentDefault`）。                                                                                                                                                                                    | 符合     |
| 助理的配置影响 Chat     | **影响**：会话不指定账号时（MCP 不带 profile、飞书消息、只给运行时），`pickAccount` 的第二优先级是“本人助理的账号”（`session_accounts.go` `defaultAccountOf` → `assistant.DefaultAccount`，2026-10-15 起，见 `models-and-accounts.md`）。 | 需要去掉 |
| Chat 的使用影响助理派出 | `device_default` 取“本人在该 Workspace 最近用的账号”。这是设备上的事实，不是 Chat 的配置。                                                                                                                                                | 可接受   |
| Chat 里的编排           | Chat 会话派子会话不指定账号时，同一 Workspace 内沿用父会话的账号（模型取账号默认，`resolveNewSession` 的 runLikeParent），否则走 Workspace 默认。与助理无关。                                                                             | 保持不变 |

## b. 业界怎么做“强编排、弱执行”

访问日期 2026-11-09；文档滚动更新，引用的是机制，不是效果宣传。

| 来源                                                                                                                                                                                                                                                             | 谁选工人的模型                                                                                                                                              | “需要人”怎么来                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic 多智能体研究系统（[engineering](https://www.anthropic.com/engineering/multi-agent-research-system)）                                                                                                                                                   | Opus 4 主导、Sonnet 4 子 Agent，内部评测比单 Opus 高 90.2%；总 token 约为普通对话 15 倍；子 Agent 返回浓缩结果，主导者综合、决定是否再派                    | 同步等待一批子 Agent；主导者不能中途改子 Agent                                                                                                      |
| [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)                                                                                                                                                                     | orchestrator-workers：中心模型运行时拆任务、派给工人、综合结果；另有按难度路由到 Haiku / Sonnet                                                             | 在检查点或遇阻时停下等人；设迭代上限                                                                                                                |
| Claude Code subagents（[docs](https://code.claude.com/docs/en/sub-agents)）                                                                                                                                                                                      | 顺序：本次调用的 `model` → agent frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` → 主对话的模型（`inherit`）；可强制统一；被白名单拦下时换成允许的并**提示用户** | `Notification` hook 的 `permission_prompt` / `agent_needs_input` 等结构化类型（[hooks](https://code.claude.com/docs/en/hooks)）                     |
| OpenAI Agents SDK（[multi-agent](https://openai.github.io/openai-agents-python/multi_agent/)、[models](https://openai.github.io/openai-agents-python/models/)、[HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/)）                        | 每个 Agent 自己的 `model`，文档建议分诊用小模型；manager（agents-as-tools，主控保留最终答复）与 handoff（专家接管）可混用                                   | 工具 `needs_approval` → `result.interruptions`，`RunState` 可持久化后 approve / reject 再继续                                                       |
| LangGraph supervisor（[repo](https://github.com/langchain-ai/langgraph-supervisor-py)，已归档，改推荐“用工具直接实现 supervisor”）                                                                                                                               | supervisor 与每个 worker 各自 `model=`；`output_mode` 决定回传全部历史还是最后一条                                                                          | `interrupt()` 暂停图，需 checkpointer，`Command(resume=…)` 继续（[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)）         |
| Google ADK（[multi-agents](https://google.github.io/adk-docs/agents/multi-agents/)、[LLM agents](https://adk.dev/agents/llm-agents/)）                                                                                                                           | 每个 `LlmAgent` 自己的 `model`，`set_default_model` 设全局默认、个别覆盖；`AgentTool`（委派后返回）与 `transfer_to_agent`（移交）                           | `LongRunningFunctionTool` 返回待办票据并暂停；`require_confirmation` 发结构化确认事件（[confirmation](https://adk.dev/tools-custom/confirmation/)） |
| Magentic-One / Magentic-UI（[MSR](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)、[paper](https://arxiv.org/html/2507.22358)）                                                       | 默认全用 GPT-4o；试过 o1-preview 只做编排外环与 Coder；任务账本 + 进度账本，停滞 > 2 次重排计划                                                             | 高风险动作前停下问人；会话侧栏“需要输入”的状态点；只有“可能不可逆”的动作交给 LLM 判官                                                               |
| Devin（[coordinator](https://docs.devin.ai/work-with-devin/advanced-capabilities.md)、[session API](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md)、[Fusion](https://docs.devin.ai/cli/fusion.md)）                               | Fusion：前沿模型主导规划与审查，便宜的 sidekick 实现；coordinator 会话派子会话                                                                              | 子会话完成或需要输入时**唤醒** coordinator，不轮询；状态枚举 `waiting_for_user` / `waiting_for_approval`；Slack 私信通知                            |
| Codex subagents（[docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)）                                                                                                                                                                          | 派生请求 → `[agents]` 默认 → 父会话；agent 文件优先                                                                                                         | 非活动线程的审批带来源标签浮出；非交互运行时退回父会话                                                                                              |
| Cursor Cloud Agents（[Slack](https://cursor.com/docs/integrations/slack)）、Copilot 云端 Agent（[model picker](https://github.blog/changelog/2026-02-19-model-picker-for-copilot-coding-agent-for-copilot-business-and-enterprise-users/)）、Manus Wide Research | 消息里点名或面板默认；Copilot 默认 Auto；Manus 主控派并行子 Agent，协调都经主控                                                                             | 完成通知（Slack 反应、PR 请求评审）；未查到“需要输入”的通知机制                                                                                     |
| 模型回退：Claude Code [`--fallback-model`](https://code.claude.com/docs/en/model-config)、[OpenRouter](https://openrouter.ai/docs/guides/routing/model-fallbacks)、[LiteLLM](https://docs.litellm.ai/docs/proxy/reliability)                                     | Claude Code 只在过载 / 不可用时按序回退，认证、计费、限流不回退，**切换时提示**、只管当前回合；OpenRouter 回答里写实际模型；LiteLLM 只在响应头与日志里      | —                                                                                                                                                   |

结论：

1. “强模型主导、便宜模型执行”是成熟做法；主导者负责规划、综合、审查，执行者返回浓缩结果。总 token 会明显变多，省钱来自执行部分换便宜模型。
2. 工人模型的选择普遍分三层：本次调用点名 → 按 Agent 定义 → 全局默认，最后才继承主导者。Foundry 的对应：`dispatch_item` 不让助理点名（由 Server 固定），“派出的工作”的设置就是全局默认这一层。
3. 回退要可见、有界：按序、不静默（提示或回答字段）、只管一次。与 DEV-023 的“默认不跨账号自动切换、显式备用”一致。
4. “需要人”都来自结构化状态（显式提问 / 审批 / interrupt 工具，或会话状态枚举），子会话的提问上交给主导者或带来源标签浮出。**没有查到任何产品用一个小模型读输出来决定哪些进收件箱**；LLM 分类器只用于动作风险判定（Claude Code auto mode、Magentic-UI ActionGuard）和事后抽样评审。
5. 每个会话一个清楚的注意力信号（状态点、状态标签）有效，用户还想要跨任务的汇总视图——Foundry 的「待处理」就是这个汇总。

## c. 模型配置（本次实现）

### 两个选择，一个页面节

设置“用哪个模型”一节改成两组，取代“共享默认 + 四个角色覆盖”的首屏：

1. **助理**：助理自己对话、理解、路由、核对证据用的模型。选项 = 家电脑上能用的模型来源：订阅、启动环境、分配给家电脑的服务端 API；再选模型与思考强度。没分配到家电脑的服务端 API 也列出，但不可选，写明“在 Model providers 里分配给 <家电脑>”。
2. **派出的工作**：帮手会话（在各项目里实际干活的会话）用的模型。三选一：
   - **与助理相同**（不另设）；
   - **各电脑的默认**（目标电脑上本人最近用的账号，账号自己的默认模型）；
   - **指定一个**：模型来源（按 id 合并各电脑的同一来源，例如“Claude 订阅 · 在 3/4 台电脑上可用”，服务端 API 写明分配给几台）、模型、思考强度。
   - 指定的在某台电脑上用不了时：**等待并告诉我**（默认）或 **改用那台电脑的默认并告诉我**。

两组都只做选择：来源的登录、分配、默认模型都在 Model providers 里做，选项旁给“在 Model providers 管理 →”链接。控件与 Chat 的默认模型、待处理识别同一套（`SelectMenu` + 运行时标记 + 账号模型目录 `listAgentModels`）。下方一行说明：“项目里你自己开的对话不受影响，仍用各项目自己的默认模型。”

后台维护（记忆、项目维护）的覆盖、预算、超时与显式备用移到同节“高级”折叠区，行为不变。

### 存储与解析（不新增表）

| 选择                   | 写入                                                                    | 解析                                                  |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| 助理                   | `runDefault`（旧字段 `assistantProfileId/Model` 同步写，兼容旧 Server） | coordinator，同现状                                   |
| 派出：与助理相同       | 删除 `roleOverrides.executor`，`delegateModel = same_as_assistant`      | executor 继承 `runDefault`（无则旧字段）              |
| 派出：各电脑的默认     | `roleOverrides.executor = {profileId: device_default}`                  | 目标电脑上选，同现状                                  |
| 派出：指定一个         | `roleOverrides.executor = {profileId, runtime, model, effort, …}`       | 在目标 Workspace 的电脑上找同 id 的来源               |
| 不可用时改用电脑的默认 | `roleOverrides.executor.whenUnavailable = device_default`（新字段）     | 找不到或模型不在目录：改用 `device_default`，记下原因 |

- 订阅与启动环境的 profile id 在各电脑上相同（dev 上 `claude_local`、`codex_local` 各在 12 台设备上报，`limen_default` 6 台），服务端 API 的 id 全局唯一、按设备分配；所以“指定一个”与电脑无关，到了目标电脑再解析。
- 快照（`PersonalAgentRunSnapshot.selectionReason`）记下 `configured` / `device_default` / `configured_fallback` / 新的 `unavailable_used_device_default`，会话本身记录实际运行的账号与模型。
- `dispatch_item` 的回答增加 `helper`：这一步预计用哪个来源、模型、思考强度，或为什么现在用不了（不可用的原因与该电脑上能用的来源）。助理当场知道，用人话告诉本人，不必等到下次读清单。

### 与 Chat 隔离

- 去掉 `pickAccount` 里“本人助理的账号”这一级：会话不指定账号时，只看本人在该 Workspace 最近用的账号，再到第一个可用的。助理的设置从此不进入任何非助理会话的选择。
- 助理不读、不写 `agent_defaults`；Chat 派子会话的规则不变。Chat 里要“聪明模型指挥便宜模型”，仍由 Chat 的编排会话在 `create_session` 时点名 `profileId` / `model`，与本节无关。

### 不可用时谁决定、本人是否知道

- 默认等待：派出前预检，不可用时 `dispatch_item` 立刻告诉助理原因，操作进入 `waiting`，可用后（例如本人在 Model providers 里登录或分配）自动继续。助理用一句话告诉本人缺什么和去哪里修。
- 本人选了“改用那台电脑的默认”：Server 换，不由模型换；回答与快照写明换了什么，助理汇报时说一句（“『家庭记账』那台电脑没有你选的模型，这次用了它的默认”）。
- 显式备用（高级）与 DEV-023 一致：只有本人列出的设备 + 账号 + Workspace 才会自动换。

### 粒度：要不要按项目设

不做按项目的帮手模型。理由：本人的要求是“另配一个”；同一个来源按 id 在各电脑解析，已覆盖“不同电脑”；真正需要按项目的场景（某项目必须走公司网关）已有显式备用和项目所在电脑的账号限制。等出现“同一电脑上两个项目要不同模型”的实际需求再加 `roleOverrides.executor.byWorkspace`。

## d. 编排回路

本人只对助理说话；助理接住、分发、收回、只在需要时找人。已有的部件和缺口：

| 环节           | 已有                                                                                                                         | 缺口与建议                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接住           | Web / 飞书单聊 → 持久收件箱（`pa_inbox`），Server 回执，助理忙或离线时排队                                                   | —                                                                                                                                                                                                           |
| 路由           | `find_workspace` / `get_workspace`、清单项的 `plan.route`（含 `clarify`）                                                    | 路由准确率是瓶颈（留出集约 55%，§13），与本设计无关                                                                                                                                                         |
| 分发           | `dispatch_item`（每 Workspace 一个写入者、预算、幂等），帮手用 executor 模型                                                 | 续用已有会话时配置不同就等待（见 §f-4）                                                                                                                                                                     |
| 帮手提问       | DEV-148：帮手的 `AskUserQuestion` / `ExitPlanMode` / Codex 审批以 “Foundry question:” 进助理收件箱，助理用 `send_message` 答 | 助理能答的自己答（便宜模型问的多是实现细节）；只有本人才能决定的，转述给本人                                                                                                                                |
| 收回           | `pa_tasks` 监督：完成、失败、以提问结束、安静、连不上模型服务，合并后作为 Foundry 通知送回助理对话；完成前必须读证据         | —                                                                                                                                                                                                           |
| 判断要不要找人 | 助理（强模型）读帮手的结果后决定；规则在提示词与 Server 策略里（`needs_confirmation` 卡片只能由本人接受）                    | —                                                                                                                                                                                                           |
| 通知本人       | 助理回复进它的对话：飞书单聊本身就是推送；助理用原生 `AskUserQuestion` 提问时，它是本人的对话，问题卡片进「待处理」          | Web 对话里的普通回复没有推送。建议：助理需要本人决定时用原生提问卡片（结构化，进「待处理」与飞书卡片），不另加工具                                                                                          |
| 助理停下或离线 | 停下时不再送通知；帮手的提问照样投给助理收件箱                                                                               | **缺口**：助理停下 / 家电脑离线时，帮手的提问没人答。建议：帮手提问投递后 10 分钟助理仍未开始处理（停下、离线或忙），把问题同时放进本人的「待处理」，来源写“助理派出的工作”；本人在那里答，答案照常回到帮手 |

## e. “待处理”识别是否被助理取代

「待处理」有两类来源：

- **结构化来源（不用模型）**：原生提问卡片与审批（DEV-148）、回合失败、需要你动手（`needs_hands`）、账号与登录过期。dev 上至今 71 项全部来自这类来源（question 29、turn_failed 33、needs_hands 9）。
- **回答识别（P2，用小模型）**：本人顶层对话每回合结束后起一个 `triage` 工具会话读回答。默认关闭；dev 上 `pending_triage_settings` 为空，没有人打开过，`answer` 来源 0 项。

助理只看得到它派出的会话：本人直接在项目里开的对话不是它的子会话，它既收不到这些对话的事件，也不该收（每回合都让强模型读一遍，比小模型贵一个数量级，而且把本人亲自在做的事变成助理的事）。所以“被取代”只对助理派出的工作成立。

| 场景                         | 谁发现“需要你”                                                           |
| ---------------------------- | ------------------------------------------------------------------------ |
| 助理派出的工作               | 助理（强模型）读帮手结果后决定；帮手的原生提问先给助理                   |
| 本人直接在项目里开的对话     | 本人就在对话里；原生提问卡片、失败、需要动手进「待处理」                 |
| 本人在 Chat 里自己的编排会话 | 同上；它派的子会话提问先给它（DEV-148）                                  |
| 助理停下或离线               | 帮手提问超时后进「待处理」（§d 建议）                                    |
| Issue                        | Issue 当前隐藏（DEV-148）；Issue 会话用 `ask_person`，结构化，不需要识别 |

选项：

1. **去掉回答识别（P2），保留结构化来源。**（推荐）没人用、要模型调用、与“助理是唯一入口”重叠；Chat 里的提问靠原生卡片；业界的收件箱也都来自结构化状态（§b 结论 4）。代价：Agent 用普通文字在回答结尾提问（不用卡片）时，「待处理」不会出现，要靠本人在对话里看到。
2. 保留，只用于本人直接开的对话（即现状：默认关闭、只读本人顶层对话）。代价：一个没人开的设置继续占维护成本。
3. 并入助理：助理开着时由它读本人直接开的对话。不推荐：成本高、越界。

删除要等本人决定；本次不改「待处理」。

## f. 需要本人决定的事

| #   | 决定                                                       | 建议                                                                                                                                   |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 帮手模型在某台电脑用不了时                                 | 默认“等待并告诉我”，可在设置里改为“改用那台电脑的默认并告诉我”（本次已实现两种）                                                       |
| 2   | 后台工作（项目概括、记忆与项目维护）用助理的模型还是帮手的 | 改用帮手的模型（这些是整理工作，现在默认跟着助理，即贵模型）。本次未改，等决定                                                         |
| 3   | 是否按项目设帮手模型                                       | 先不做（§c）                                                                                                                           |
| 4   | 续用已有会话但它的模型与帮手模型不同                       | 续用时沿用那个会话自己的模型（中途换模型不安全，原生也不支持把对话历史交给另一个来源）；只有新开的帮手用帮手模型。本次未改，现状是等待 |
| 5   | 回答识别（P2）                                             | 去掉，保留结构化来源（§e 选项 1）                                                                                                      |
| 6   | 助理停下 / 离线时帮手的提问                                | 10 分钟未处理就同时进「待处理」（§d）                                                                                                  |
