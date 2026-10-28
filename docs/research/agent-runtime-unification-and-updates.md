# Agent 执行依赖统一与自动更新设计

日期：2026-10-16。状态：已在工作区实现，未发布；实际变更与验收见 [实现记录](agent-runtime-update-implementation.md)。本文承接 `codex-6-1-sol-client-compatibility.md` 的实测，作为执行依赖与自动更新的后续设计；与旧文建议冲突时，以本文及用户本轮要求为准。

## 已确定的要求

- 每个 agent 内部采用一条适合 Foundry 的官方执行集成，不因聊天/辅助任务不同而无必要地维护两套客户端。
- 跟随官方最新 stable。排除 alpha、beta、rc，不把实测成功的桌面 alpha 构建作为目标。
- 更新调度封装为所有 agent 共用的机制，首批覆盖 Codex、Claude Code；新增 agent 只增加适配器。
- 更新不更换账号、配置来源、workspace 或模型，不中断执行中的任务；同一设备的所有 workspace 共享更新协调。

## 集成选型

| Agent  | 统一执行路径                                                                                | 理由                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex  | Foundry adapter → 官方 `codex app-server` → Codex 引擎                                      | 官方面向产品集成的协议，支持线程、流式事件、控制及审批；与 CLI 构建同步，没有额外 SDK 包装层的版本差异                                       |
| Claude | Foundry adapter → 官方 `@anthropic-ai/claude-agent-sdk` → 明确选择的 Claude Code executable | 官方推荐将 Claude Code 嵌入 TypeScript/Python 应用的接口，现有主聊天及 verifier 已使用它，保留权限回调、流式输入、恢复、结构化输出等正式 API |

不是“app-server 比 SDK 生成的答案一定更好”。模型、harness、提示、工具和权限等共同决定结果。选择依据是官方针对产品场景的定位、所需能力及维护成本；没有证据支持给两种传输方式做绝对质量排名。

Codex 与 Claude 底层接口不同有必要保留；Foundry 上层统一行为和生命周期，不自创跨厂商的推理引擎、不通过 provider HTTP 重写原生循环。

### Codex：移除不必要的 SDK 分支

现有 SDK 直接调用位于 `session/codex.ts`（独立 verifier）和 `provider-check.ts`（provider 检查）。它们都指定设备上的 executable，未发现必须依赖 SDK 的独有能力。`native-cli.ts` 还用 SDK 版本推导最低 CLI 版本，应一起移除。

主聊天已使用 `runner/codex-app-server.ts`。从中提取不依赖聊天 UI/全局会话状态的 transport/client；聊天、独立 verifier 和原生元数据读取都使用同一 client 与 runtime resolver。不能简单将聊天的全部配置和权限套到 verifier。

迁移验收矩阵：

| 行为       | 必须保持或明确改进                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------- |
| 启动和结束 | 显式完成/失败状态；最后一条 assistant 结果；usage 与 session ID；不能把断流当成功                  |
| 隔离       | verifier 的私有配置、OS 沙箱 launcher、只读目录、禁用宿主 skills/MCP 等策略原样保留                |
| 取消与超时 | 传递 AbortSignal，interrupt 对应 turn，可靠回收进程；不会继续后台推理                              |
| 输入输出   | 图片、PDF 文件访问、system instructions、JSON 结果解析；支持时使用原生 output schema；失败语义明确 |
| 配置       | 相同 executable/provider/model 解析；API-compatible 与官方登录的配置隔离保持                       |
| 审批       | 未实现的交互请求明确拒绝，不能因统一客户端而自动放行                                               |
| 元数据     | account/model 等原生读取共用 transport，但不创建推理 turn                                          |

所有调用迁移并回归通过后，删除 `@openai/codex-sdk` 的 dev/peer 依赖、安装清单、锁文件记录和仅服务 SDK 的版本检测逻辑；更新 `worker-install.ts` 的 SDK 安装策略。加静态检查禁止新业务路径重新引入该 SDK。

`provider-check.ts` 的现有后台推理检查不能成为更新验证步骤。更新仅使用版本、协议和元数据检查；自动推理探测退出自动调度。只有用户明确发起的兼容测试或正常会话才产生模型请求，并且走统一 adapter。

### Claude：保留 SDK，统一其入口

`runner/claude-launch.ts`、`session/claude.ts`、`native-inspection.ts`、`provider-check.ts` 目前分别使用 SDK。抽出共同的 SDK loader、executable resolver、进程登记、错误分类和生命周期控制；各场景保留不同的政策参数。

每次执行记录 SDK 版本和 Claude Code 完整版本，显式传递 `pathToClaudeCodeExecutable`，不让 SDK 悄悄选到另一份 bundled CLI。`official-skills.ts` 读取的 SDK 信息也必须来自同一生效依赖代次。

无需为了形式一致而自己重写 Claude 的 subprocess/stream-json 控制协议。现有官方 SDK 正好覆盖 Foundry 所需能力。

## 通用更新架构

建议目录 `packages/worker/src/agent-runtime/`（尚未创建实现）：

- `registry.ts`：agent adapter 注册，不把 Codex/Claude 分支散落在调度器中。
- `descriptor.ts`：实际运行依赖组合及 generation。
- `update-controller.ts`：统一状态机、计划、重试与恢复。
- `maintenance.ts`：与执行入口共享的运行时维护锁、工作引用计数和新任务排队。
- `release-source.ts`：官方版本元数据读取、来源校验与缓存。
- `adapters/codex.ts`、`adapters/claude.ts`：各厂商的版本渠道、安装来源与验证能力。

适配器契约只定义通用步骤，保留厂商差异：

```ts
interface AgentUpdateAdapter {
  inspectInstalled(): Promise<InstalledRuntime[]>;
  resolveStableTarget(current: RuntimeDescriptor): Promise<UpdatePlan>;
  prepare(plan: UpdatePlan): Promise<PreparedUpdate>;
  validate(candidate: PreparedUpdate): Promise<ValidationResult>;
  activate(candidate: PreparedUpdate): Promise<RuntimeDescriptor>;
  recover(attempt: PersistedUpdateAttempt): Promise<RecoveryResult>;
}
```

这是接口草案，不是当前已存在的类型。UpdatePlan 必须声明安装所有者、是否支持 staging/rollback、受影响文件与依赖、目标完整版本；通用控制器不能假定任意安装器均可原子回滚。

RuntimeDescriptor 包含 agent ID、真实 executable 路径、完整版本、安装来源、可选 SDK 路径与版本、适配器版本及 generation。账号/配置指纹用于确认执行身份不变，单独存储，不进入公开 release 日志，不含 token。

### Stable 的精确定义

- Codex：官方最新正式 release，完整 semver 不含 prerelease；不能用去掉 `-alpha...` 的版本比较把 alpha 当 stable。
- Claude Code：遵循官方 `stable` 渠道。它通常比 `latest` 晚约一周；`latest` 并不等同 alpha，但不符合本轮指定的官方 stable 策略。新模型如果领先 stable，显示渠道差异，等待 stable，不自动越过渠道。
- Claude Agent SDK：官方包的最新非 prerelease 版本；与 CLI 作为依赖组合验证，不能假设版本号相等或可任意混配。
- 已安装预览版：标记渠道不一致，目标解析为官方 stable；即便版本号更低也属于切回 stable。仍要验证配置/会话格式可恢复，失败则明确报告，不能静默留在 alpha 并声称已满足策略。
- 目标始终是最新 stable；验证失败是临时阻塞并可见报告，不设置长期不更新的隐形版本上限。

### 更新状态与时序

持久化 `current / target / state / checkedAt / attempt / failure / nextRetryAt / previousGeneration`。状态为 `checking → available → preparing → waiting_idle → validating → activating → ready`；失败进入 `failed`，需要恢复时进入 `recovering`。

启动时及每 6 小时加 jitter 检查官方版本元数据；用户点击检查可立即执行。幂等检查与指数退避共用实现。只下载本机确实缺少的目标构建；已安装可用版本直接复用。准备阶段只有安装器保证不影响正在执行的版本时才可提前运行，否则也等空闲。

维护锁必须覆盖“最后一次空闲检查 + 生效切换”，与所有 launch 路径共享：普通聊天、verifier、元数据 helper 和明确发起的诊断。以真实进程/任务引用判断活跃，不用低 CPU 或 UI idle 判断。工具、子任务、后台任务、审批等待都算执行中。纯静态聊天记录和没有工作的进程缓存不永久阻塞更新。

新任务在临界切换期间排队，不能先启动再检查。活跃任务不被强杀。资源状态无法确认则保持旧运行并报告等待原因。若长期有后台工作，持续显示延后状态，不把更新标成成功。

新会话使用新 generation；已有会话在下个允许切换的启动点恢复，并核对会话格式兼容。仍持有旧 generation 的进程保持原 executable/SDK 引用。清理旧版前检查引用，不能仅依赖时间 TTL。

### Claude 自更新的协调

Claude 原生安装已有后台更新和 `claude update`。Foundry 不再另造一套厂商安装器，而让 Claude adapter 在维护窗口调用官方能力；已有 Homebrew 等来源按对应安装方式处理。

为了使 Foundry 的空闲调度生效，Foundry 启动的 Claude 子进程及 SDK 启动配置统一设置 `DISABLE_AUTOUPDATER=1`，避免进程自己在任务中另开更新流程。该变量仅关闭后台 updater，官方手动 `claude update/install` 仍可工作；不要设置会封锁所有路径的 `DISABLE_UPDATES`。实际生效需检查 settings/env 优先级，并做安装方式回归。

只对 Foundry 管理的进程施加此环境，不悄悄改用户终端的全局设置。若用户终端/外部程序也管理同一安装，外部更新不受 Foundry 锁控制：检测到版本变化后重读路径并验证；不能承诺对外部 updater 的全局互斥。需要严格维护窗口的部署应使用明确选定、单一所有者的安装来源。

### SDK 也更新，但不热改正在运行的 worker

Claude 的更新单位是 `adapter + SDK + CLI` 依赖组合。将 SDK 安装到版本化运行时依赖目录，由隔离的 runtime runner 子进程加载。新组合先完成无推理协议/元数据验证，再让空闲后的新 runner 使用；已运行 runner 继续使用原 SDK。不能在 worker 的活跃 `node_modules` 中执行升级后期待模块缓存自动刷新。

复用 execution-host 的调度/进程登记，不另做一套会话所有者；为 runner generation 增加依赖包生命周期。若最新 SDK 要求 adapter 代码变更，则先交付兼容 worker 更新，再激活组合；界面显示真实阻塞，不能假装 SDK 已更新。SDK 自动升级也不允许从任意第三方包源导入代码。

App 内置 CLI 属于 App 的安装所有者，Foundry 不改写签名 bundle。若选择 App 来源，监测 App 更新，缺少所需 stable 时显示等待来源更新；若要求独立无人值守跟随 stable，应使用用户明确选择的独立安装来源，复用已有独立 CLI。

### 生效后的统一动作

验证安装路径/版本与目标一致、所需协议/SDK 能力、配置及账号来源不变；不自动请求模型生成。更新 generation，清空 CLI 检测缓存、原生目录缓存、服务端和前端目录状态，失效不能跨 generation 复用的活动 client。展示当前/最新 stable、上次检查、等待原因及失败恢复结果。

回滚只对明确可恢复的安装执行；安装或协议失败可恢复旧 executable/SDK，但不宣称自动倒退共享用户配置/数据库的 migration。验证阶段尽量使用隔离配置，涉及共享格式升级需单独评估，不能以文件替换代替完整回滚证明。

## 实施分解与验收

1. 提取 Codex transport、统一所有执行和元数据入口，迁移 verifier，移除 Codex SDK。保留 Claude SDK，归并 loader/生命周期入口。
2. 引入 RuntimeDescriptor/generation、真实路径及完整版本报告、模型目录来源；修复旧客户端被官网目录补齐的问题。
3. 建立通用 update controller、维护锁和持久化恢复。先完成 Codex/Claude 两个 adapter；新增 mock adapter 验证调度没有厂商硬编码。
4. Claude SDK/CLI 依赖组合及 runner generation 更新；原生自更新与外部安装所有者协调。
5. 设备页面提供当前版本、最新 stable、自动更新状态及失败恢复操作。UI 遵守共享控件、两种语言和真实浏览器验收。

回归必须覆盖：Codex SDK 静态依赖消失；verifier 沙箱和结构化结果不退化；Claude 权限回调/流式输入/恢复/目录读取保持；stable 过滤及完整 semver；更新与任务启动竞态；后台工作阻塞；两种 agent 互不串锁且共享安装资源不冲突；中途断电/worker 重启恢复；失败保留旧版；更新后缓存失效；账号不变；App bundle 不被写入；不产生自动推理探测。

真机验证 mac-laptop 与 dev-server 的最新版 stable，分别通过 Foundry 运行 Codex/Claude 正常会话；用事件核对 executable、SDK（若有）、model、generation。新增 agent 用适配器契约测试验证可接入，不宣称未实现的厂商已受支持。

设计记录保留选型依据；以 [实现记录](agent-runtime-update-implementation.md) 为实际交付范围与验收证据，尚未更新真实设备。

## 官方依据

- [OpenAI：Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)：面向将 agent 集成进产品的场景推荐 app-server；SDK 用于简化程序化任务调用。
- [Anthropic：Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)：在 TypeScript/Python 应用中嵌入 Claude Code 使用 Agent SDK，其运行 Claude Code binary 并提供权限、会话、hooks 等能力。
- [Anthropic：Advanced setup](https://code.claude.com/docs/en/setup)：原生自更新、stable/latest 区别、安装来源差异、版本化安装以及 `DISABLE_AUTOUPDATER` 的作用范围。
