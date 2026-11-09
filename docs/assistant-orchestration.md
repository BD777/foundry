# 助理编排：聪明的助理指挥便宜的帮手

[Personal Agent](personal-agent.md) · [Model providers](model-providers-design.md) · [文档索引](README.md)

状态：2026-11-09 设计；(c) 模型配置已实现（[DEV-150](devlog/DEV-150-assistant-helper-model.md)）；本人对 §f 的决定见 §f，按流程选模型（§g）与一条“等你处理”管道（§h）实现中（DEV-152）。

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

| 环节           | 已有                                                                                                                         | 缺口与建议                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 接住           | Web / 飞书单聊 → 持久收件箱（`pa_inbox`），Server 回执，助理忙或离线时排队                                                   | —                                                                                                                  |
| 路由           | `find_workspace` / `get_workspace`、清单项的 `plan.route`（含 `clarify`）                                                    | 路由准确率是瓶颈（留出集约 55%，§13），与本设计无关                                                                |
| 分发           | `dispatch_item`（每 Workspace 一个写入者、预算、幂等），帮手用 executor 模型                                                 | 续用已有会话时配置不同就等待（见 §f-4）                                                                            |
| 帮手提问       | DEV-148：帮手的 `AskUserQuestion` / `ExitPlanMode` / Codex 审批以 “Foundry question:” 进助理收件箱，助理用 `send_message` 答 | 助理能答的自己答（便宜模型问的多是实现细节）；只有本人才能决定的，转述给本人                                       |
| 收回           | `pa_tasks` 监督：完成、失败、以提问结束、安静、连不上模型服务，合并后作为 Foundry 通知送回助理对话；完成前必须读证据         | —                                                                                                                  |
| 判断要不要找人 | 助理（强模型）读帮手的结果后决定；规则在提示词与 Server 策略里（`needs_confirmation` 卡片只能由本人接受）                    | —                                                                                                                  |
| 通知本人       | 助理回复进它的对话：飞书单聊本身就是推送；助理用原生 `AskUserQuestion` 提问时，它是本人的对话，问题卡片进「待处理」          | Web 对话里的普通回复没有推送。建议：助理需要本人决定时用原生提问卡片（结构化，进「待处理」与飞书卡片），不另加工具 |
| 助理停下或离线 | 停下时不再送通知；帮手的提问照样投给助理收件箱                                                                               | 当时的缺口（停下 / 离线时没人答）由 §h 解决：项直接记给本人，不再计时                                              |

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
| 助理停下或离线               | 帮手的项直接给本人（§h）                                                 |
| Issue                        | Issue 当前隐藏（DEV-148）；Issue 会话用 `ask_person`，结构化，不需要识别 |

选项：

1. **去掉回答识别（P2），保留结构化来源。**（推荐）没人用、要模型调用、与“助理是唯一入口”重叠；Chat 里的提问靠原生卡片；业界的收件箱也都来自结构化状态（§b 结论 4）。代价：Agent 用普通文字在回答结尾提问（不用卡片）时，「待处理」不会出现，要靠本人在对话里看到。
2. 保留，只用于本人直接开的对话（即现状：默认关闭、只读本人顶层对话）。代价：一个没人开的设置继续占维护成本。
3. 并入助理：助理开着时由它读本人直接开的对话。不推荐：成本高、越界。

删除要等本人决定；本次不改「待处理」。

## f. 本人的决定（2026-11-09，经编排会话）

| #   | 问题                        | 决定                                                                                                                        |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | 帮手模型在某台电脑用不了时  | 按建议：默认等待并告诉本人，可改为用那台电脑的默认（DEV-150 已实现）                                                        |
| 2   | 后台工作用哪个模型          | **改为每个流程分别可配**（本人：“记忆整理这种可能需要聪明模型……我倾向贵模型”），在设置里列出全部流程、触发时机与拓扑，见 §g |
| 3   | 按项目设帮手模型            | 先不做                                                                                                                      |
| 4   | 续用已有会话但模型不同      | 是：续用时沿用那个会话自己的模型，不再等待（`owner_configuration_differs` 取消）                                            |
| 5   | 回答识别（P2）              | 是：彻底去掉，包括代码、设置界面、存储与已有的 `answer` 项（本人：“历史的 pending 我也不看了”）                             |
| 6   | 助理停下 / 离线时帮手的提问 | 不要“10 分钟后再进待处理”（两套系统并存）；改为一条管道、每项记录由谁处理，见 §h                                            |

## g. 助理的流程与各自的模型

助理用到模型的流程（代码核对，2026-11-09 `85173f04`；“角色”是 `personalagent.RunPreference` 的键）：

| 流程         | 角色           | 触发                                                                                                                                                                                                                              | 在哪里开始                                                              |
| ------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 对话与安排   | `coordinator`  | 每条本人消息（Web 收件箱、飞书单聊），每 2 秒取一次；以及 Foundry 送进对话的通知：帮手完成 / 失败 / 提问 / 安静 / 连不上（事件 + 每 30 秒检查），电脑重新上线，到点提醒（每分钟），每日摘要（设定时间，默认关），提议被接受或拒绝 | `assistant/inbox.go`（快照）；通知经 `assistant.go` `tell` 续在原对话里 |
| 交出去的工作 | `executor`     | 助理调用 `dispatch_item`；每 2 秒投递                                                                                                                                                                                             | `assistant/operations.go`                                               |
| 项目概括     | `digest`（新） | 项目里会话结束或 Issue 变化后（30 分钟防抖、每个项目至多 6 小时一次），电脑上线时到期的，安家时全部排队                                                                                                                           | `httpapi/workspace_digests.go`，只读工具会话                            |
| 记忆整理     | `memory`       | 知识库条目变化（每 30 秒检查，约 1 分钟后开始）；也可手动重试                                                                                                                                                                     | `assistant/maintenance.go`，只读审阅会话                                |
| 项目整理     | `governance`   | 本人拥有的项目的目的或 `AGENTS.md` / `README` 变化（同上）                                                                                                                                                                        | `assistant/maintenance.go`，只读审阅会话                                |

拓扑：本人消息 → 对话与安排 →（`dispatch_item`）交出去的工作 →（完成 / 失败 / 提问）通知 → 对话与安排；项目里的会话结束 → 项目概括 → 项目文件变化 → 项目整理 → 采纳的补丁 → 项目概括；知识条目变化 → 记忆整理；清单的提醒、每日摘要、电脑上线、提议决定 → 对话与安排。会话标题命名是 Foundry 的通用功能（沿用会话自己的配置），不属于助理。

**设置**：“用哪个模型”一节先列出上面的拓扑（每条链一行，流程加粗，事件是普通文字），再按流程各一组，写明触发时机，每组只做选择。原计划用 Mermaid（已有的 `MarkdownContent` / Streamdown）画图，但在设置页里 Streamdown 的图一直停在加载（同一段图在对话里能渲染，原因未查清），所以用结构化列表：

- 对话与安排：家电脑上的来源、模型、强度（DEV-150）。
- 其他流程：与助理相同 / 各电脑的默认 / 指定一个（来源按 id 合并各电脑），以及用不了时等待或改用电脑的默认。默认：交出去的工作沿用 DEV-150 的设置；项目概括、记忆整理、项目整理默认与助理相同（判断性工作，本人倾向贵模型）。

**存储**：沿用 `roleOverrides`，键增加 `digest`。没有覆盖时：`coordinator` 用 `runDefault`（再旧字段）；`executor` 按 DEV-150；`memory`、`governance`、`digest` 用助理的选择（`roleOverrides.coordinator` → `runDefault` → 旧字段），去掉设备，在各自的目标项目所在电脑解析。

**续用已有会话（§f-4）**：`dispatch_item.sessionId` 续用时，会话沿用自己的账号与模型；只检查它所在的电脑可用、本人仍有权限。新开的帮手才用 executor 的选择。

**已知限制**：通知续在原对话里，用对话开始时固定的模型；助理的选择改了，下一条本人消息会开新对话，通知不会单独换模型。

## h. 一条“等你处理”管道

### 原则

- 一个存储（`pending_items`）、一个生命周期、只用结构化信号：提问 / 审批（原生卡片，DEV-148）、回合失败、需要本人动手（工具错误）、帮手卡住（连不上模型服务或超过“可能卡住”时长）。覆盖助理派出的帮手和本人直接开的对话。
- 每项记录**由谁处理**：`handler = assistant | person`。本人只看一个列表“等你处理”：「待处理」页、对话输入框上方的条、助理首页的入口读同一份数据，没有单独的“Chat 待处理”。

### 数据

`pending_items` 增加列 `handler`（默认 `person`），载荷增加 `note`（助理交给本人时写的话）、`handedAt`；来源增加 `helper_stuck`。删除来源 `answer` 及其数据、`pending_triage_settings` 表与 `triage` 会话来源。

### 谁先处理

| 来源                                          | 记录时的 `handler`                                                   |
| --------------------------------------------- | -------------------------------------------------------------------- |
| 本人直接开的对话（顶层 chat，含助理对话本身） | `person`                                                             |
| 助理派出的帮手（`pa_tasks` 里有它）           | 助理在运行且家电脑在线：`assistant`；否则 `person`（立即，无计时器） |
| Issue 的提问、账号与登录过期                  | `person`                                                             |

帮手的子会话（孙辈）提问照 DEV-148 交给帮手自己，不记项。

### 状态转换

```
            记录(handler=assistant)                记录(handler=person)
                   │                                      │
                   ▼                                      ▼
   ┌────── open · assistant ──── hand_over(note) ───► open · person ──── 本人回复 / 完成 / 忽略 ──► replied / done / dismissed
   │               │   ▲                                   ▲
   │  助理回答帮手 / 帮手有新输入 / 回合完成 / 取消              │
   │               ▼   │ 助理停下：全部交给本人（note=已停下）       │
   └──► resolve ───────┴─► done / replied / superseded       家电脑离线：交给本人（handedReason=assistant_offline），回来后仍是本人的
```

- **认领**：助理通过已有的通道收到它负责的项：帮手的提问经 DEV-148 的转达（“Foundry question”）进助理收件箱；失败、提问结束、卡住经 `pa_tasks` 的监督通知。转达和通知里写明可用 `needs_you` 处理。
- **解决**：助理用 `send_message` 回答帮手、或重新派出后，帮手收到新输入，它的提问 / 失败 / 卡住项自动标为已回复；回合完成后失败项自动作废。助理用别的办法解决（例如换账号重来、放弃）时调用 `needs_you op=resolve`。
- **交给本人**：助理调用 `needs_you op=hand_over`，带一句给本人的话（`note`）：项改为 `person`，本人在“等你处理”里看到助理的话和原问题，回复直接发给那个帮手（作为答案）；帮手继续后助理照常收到监督通知。帮手只在正文里提问（没有卡片）时，助理可以按会话 id 交一项给本人。
- **助理停下**：停止开关把所有 `assistant` 项交给本人；停下期间帮手的提问直接记为 `person`，也不再转达到助理收件箱（恢复后不会收到过期的问题）。**家电脑离线**：本人读列表时，助理负责的未结项交给本人（`handedReason = assistant_offline`），离线期间新记的项直接是本人的。电脑回来后它们**仍留在本人的列表里**，直到任一方解决：助理仍可 `resolve`，或用 `hand_over` 补一句说明；不会从本人的列表里消失又出现（编排会话 2026-11-09 的要求；测试 `TestNeedsYouOfflineItemsStayWithThePerson`）。
- **助理能看到本人的项**：`needs_you op=list` 列出两类未结项；每轮上下文里附一行“等你处理的有 N 件”及前几件的标题，助理汇报时可以提到。

### 界面

- 「待处理」页改名“等你处理”，只列本人要处理的项（含助理交来的，显示助理的话）；“助理在处理（N）”作为页尾一组，只读，可展开看。
- 计数（侧栏、对话列表筛选、输入框上方的条）只算本人要处理的项。
- 助理首页增加“等你处理 · N ›”入口，列前三项标题，打开同一页面。

### 为什么新增一个工具

DEV-094 撤回过“让每个会话都能往待处理里放东西”的工具，理由是它出现在每个会话的工具列表里、引导 Agent 去问人。`needs_you` 只给助理角色（`personal_agent`）：分拣“哪些要人”正是助理的职责，普通会话的工具列表不变。
