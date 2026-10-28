# Codex 6.1 Sol：客户端差异根因与 Foundry 修复方案

日期：2026-10-16。状态：根因对照实验完成；本文是修复方案，尚未实施运行时或 UI 改动。

后续设计已收敛至 [Agent 执行依赖统一与自动更新设计](agent-runtime-unification-and-updates.md)：Codex 统一 app-server、Claude 统一官方 Agent SDK，所有 agent 共用更新控制器，仅跟随官方 stable。本文的故障证据保留；预览通道、SDK 随 worker 更新等早期建议由后续设计取代。

## 结论

本次失败的直接原因是 **Foundry 使用的旧 Codex CLI 无法通过该账号运行 `gpt-6.1-sol`**。账号本身有访问能力。在同一台 mac-laptop、同一个 `CODEX_HOME`、同一账号、同一模型及同一最小提示下，只替换可执行文件：`0.155.0` 失败，桌面 App 内置 `0.162.0-alpha.17.2` 成功。dev-server 的 `0.153.4` 也失败。

新版 CLI 使用 Foundry 的 app-server 客户端标识及官方环境变量覆盖，同样成功，且 High 推理等级可用。无需冒充 Codex Desktop、替换账号或直接调用推理 HTTP 接口。

Foundry 的缺陷是三个环节叠加：优先选到旧 CLI；版本健康检查只衡量 SDK 最低兼容版本；官网目录合并把新模型直接变成可选项，没有体现执行客户端的能力差异。

已确认的是“可执行文件版本/构建差异导致行为不同”。官方发布记录确认 `0.159.1` 已将 6.1 Sol 加入内置目录并设为默认模型；尚未通过版本二分确定该账号实际推理成功的最早版本，也未确定旧构建被服务端拒绝的具体内部条件。不能宣称所有 `0.162.x` 或某个稳定版已在本环境验证，更不能把 alpha 构建版本硬编码成通用最低版本。

## 版本含义与官方支持节点（后续核实）

| 组件                 | 含义                                                                                   | 本仓库/本次观察                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Codex CLI            | 安装在设备上的 `codex` 可执行程序；包含执行引擎、认证、模型发现及工具执行等能力        | `0.153.4`、`0.155.0`、`0.162.0-alpha.17.2` 均为它的版本                                           |
| app-server           | 同一程序的 `codex app-server` 运行方式，通过 JSON-RPC 提供线程、turn、事件、审批等接口 | 随所选 CLI 一起更新，不是独立 npm 服务版本；协议 schema 对应 CLI 构建                             |
| TypeScript Codex SDK | `@openai/codex-sdk`，供程序启动/恢复/流式运行 Codex 的库                               | 仓库依赖 `0.142.5`；本地该版本实现启动 `codex exec --experimental-json`，支持 executable override |
| Desktop App          | 图形客户端，有自己的版本，并可内置不同于 PATH 的 CLI 构建                              | App `26.1007.71326` 内含 CLI `0.162.0-alpha.17.2`                                                 |
| Foundry worker       | Foundry 的设备进程、调度和集成代码                                                     | 主聊天路径直接启动 CLI app-server；部分 stage/harness 路径仍用 SDK 并指定设备 executable          |

因此当前主路径是 `Foundry worker → codex app-server → Codex 引擎 → 服务端模型`，不是 `worker → SDK → 独立 app-server 服务`。仅升级 npm SDK 不会修复主聊天选中旧 CLI 的问题；仅升级 worker 也不保证外部 CLI 一并更新。

[官方 changelog](https://learn.chatgpt.com/docs/changelog) 的 2026-09-29 / Codex CLI `0.159.1` 条目明确记录：将 GPT-6.1 Sol 加入 bundled catalog 和 Bedrock catalogs，并作为默认模型。这是可引用的原生目录支持节点；不是“所有账号从该版本必定有权限”的承诺。不要把该条目扩展成所有新模型或所有 app-server RPC 的统一最低版本。

app-server 基本线程/turn/model-list 能力在本次旧 `0.153.4` 中已经工作；本次缺失的不是 app-server 子命令。不同 RPC/字段有各自版本边界，应按实际使用的协议生成 schema/做兼容测试，而非从 SDK 版本粗略推导。官方 [app-server 文档](https://learn.chatgpt.com/docs/app-server) 明确说明生成的 schema 对应所运行的 CLI 版本。

## 空闲自动更新设计（新增建议，尚未实现）

可以由 worker 自动检查并在空闲时更新 Codex，但应独立于 worker 自更新管理。当前 `native-cli-install.ts` 是请求驱动的安装入口，`native-cli.ts` 只检测已安装版本/生成更新提示，没有原生 CLI 的定期版本检查调度器。`worker-self-update.ts` 负责 worker 自更新；工作树的 `execution-host/update.ts` 有等待旧执行工作结束的逻辑，可借鉴其状态与锁设计，但不能当作原生 CLI 自动更新已部署。

建议设备提供三种明确策略：仅通知、空闲自动更新稳定版、锁定版本；预览通道单独选择。首次启用自动更新后按持久化策略执行，后续每次正常更新无需反复确认。

建议状态流：`检查 → 有新版 → 等待空闲 → 更新 → 验证 → 生效`，失败进入 `保留旧版/回退 → 延后重试`。建议启动时以及每 6 小时加随机抖动检查一次发布元数据；失败指数退避。该周期是产品建议，不是现有实现。

“空闲”不能用 CPU 使用率判断：须在同一运行时的维护锁下检查活跃 turn、工具/后台工作、待审批、已接收待执行输入、持有该构建的 app-server；切换前再检查一次。维护期间新输入排队，避免检查后刚好启动新任务的竞态。空闲聊天记录本身不必阻止更新；仍有工作的原生进程必须保留。状态不可确认时延后，不强杀进程腾出窗口。

按来源处理：

- 独立安装 CLI：使用对应的官方发行渠道，固定目标版本，核对真实解析路径及完整版本。安装器不具备可恢复的分阶段安装时，先限定为通知/人工更新；不能仅声称具有原子回滚。
- Foundry 管理且用户已选择的独立 runtime：采用版本目录并存，先验证候选，再原子切换引用，保留上一版。设备已有符合条件的程序时直接复用，不重复下载安装。删除旧版本前确认无引用。
- npm/Homebrew 管理 CLI：尊重其管理权与锁；自动更新能力按适配器实现，不使用通用安装脚本覆盖另一种来源。
- App 内置 CLI：由 App 的更新机制维护，Foundry 不修改已签名 `.app` 内部。可检测 App 已完成更新并在空闲时重新解析；需要无人值守更新 Codex 时可由用户选择独立 CLI 来源。
- 显式 pin 或自定义 executable：默认不自动覆盖、不偷偷更换来源；显示可用更新及锁定原因。

候选验证不自动消耗模型额度：先检查 `--version`、真实路径、协议 initialize、所需 RPC/schema、账号配置来源保持不变，以及原生 model/list 的可用性与降级状态。成功切换后清理 CLI 检测缓存、原生目录缓存、服务端和前端目录缓存，并更新 runtime generation。只有正常用户 turn 成功或明确执行的兼容测试成功，才记录模型推理已验证；离线目录不等于在线权限。

SDK 随 worker 构建、锁文件和集成测试更新，不在运行中的 worker `node_modules` 内热替换。CLI 自动更新选择官方稳定且满足 Foundry 已验证兼容范围的版本，保留完整 prerelease 信息；未知协议变化先验证，不能盲目追随任意最新构建。

新增回归重点：更新与新任务竞态、长后台工作、worker 重启后恢复 pending update、安装失败保留旧版、版本锁定、App 来源不被覆盖、更新后仍解析到旧 PATH 的检测、两台设备目录失效隔离、账号及配置不变。

## 实测证据

| 场景                            | 执行程序                                                | 配置及模型                                                 | 结果                                                          |
| ------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| 原失败 Foundry 会话，dev-server | CLI `0.153.4`，原生 app-server                          | `~/.codex`；6.1 Sol；High                                  | 400：ChatGPT account 不支持该模型                             |
| dev-server 直接运行原生 CLI     | 同一 `0.153.4`；`exec --ephemeral --ignore-user-config` | 清除网关环境变量；临时工作目录；6.1 Sol                    | 相同 400；另提示模型元数据不存在                              |
| mac-laptop 桌面 App 原成功会话  | App 内置 `0.162.0-alpha.17.2`                           | `~/.codex-personal`；6.1 Sol；Medium                       | 原生记录有 assistant 回复及 `task_complete`                   |
| mac-laptop 旧 CLI 对照          | `~/.local/bin/codex`，`0.155.0`                         | 同一 `~/.codex-personal`；忽略用户配置；6.1 Sol            | 相同 400及元数据缺失提示                                      |
| mac-laptop 新 CLI 对照          | App 内置 `0.162.0-alpha.17.2`                           | 同一账号和目录；相同参数及提示                             | exit 0，回复 `OK`，`turn.completed`                           |
| mac-laptop Foundry 协议对照     | App 内置 CLI；`app-server --listen stdio://`            | `clientInfo.name=foundry`；官方环境变量覆盖；6.1 Sol；High | `thread_model=gpt-6.1-sol`；回复 `OK`；turn completed，无错误 |

最小提示均为 `Reply with OK only. Do not call any tools.`。所有推理实验通过本机已安装 Codex CLI 完成，无直接 provider 推理 HTTP、无安装或下载、无登录切换、无凭据复制。临时工作目录已清理，远程 compute 租约已释放。

原失败会话：`sess_1792126822114064042`；原生记录：`01a14315-2b39-7403-9426-c6f4cc41aaae`。原成功桌面会话：`01a14317-db03-74b3-a419-f7a5aa8aa49a`。

两边登录邮箱均为 `<user>@example.com`，Pro，账号 ID 的 SHA-256 前 16 位均为 `9e3140df366e97b8`。只输出身份与哈希，未输出 token。相同邮箱本身不足以判定相同账号，因此额外对比了账号 ID。

mac-laptop 的 App 是 `/Applications/ChatGPT.app`，版本 `26.1007.71326`、build `20398`；内置 CLI 路径是 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`。成功原生会话确认实际模型为 `gpt-6.1-sol`，并非仅凭模型下拉框或模型自己的回答判断。

旧 CLI 的原生 `model/list` 返回 6 Astra 和 5.6 系列。新版同一 RPC 返回 6.1 Sol、6 Astra、6 Sol、6 Luna 及 5.6 系列。RPC 目录可能来自缓存/内置数据，成功推理实验才是本次兼容性验证的关键证据。

## 代码中的因果链

1. `packages/worker/src/native-cli.ts`：`codexCommandCandidates()` 将显式覆盖及 PATH 放在 App 内置 CLI 前；`resolveDeviceCommand()` 选择第一个 `--version` 能运行的程序，不比较其他候选。mac-laptop 因此会优先拿到独立安装的 `0.155.0`，即使 App 中已经有可用新版。dev-server 当前使用 `0.153.4`。
2. 同文件的 `minimumCliVersion()` 从 SDK major/minor 推导最低版本。仓库 `@openai/codex-sdk` 是 `0.142.5`，推导出 `0.142.0`，所以旧 CLI 可以通过这个检查。SDK 协议兼容不等于支持最新模型。
3. `packages/worker/src/native-inspection.ts` 的 `readOfficialCodexCatalog()` 调用 `withPublishedCodexModels()`。后者位于 `published-codex-models.ts`，将官网卡片和原生目录取并集，官网项优先；原生目录失败时也返回官网模型。
4. `packages/worker/test/published-codex-models.test.mjs` 还明确要求旧原生目录补入 `gpt-6.1-sol`。这属于现有设计行为，不是偶发缓存污染。
5. `packages/worker/src/runner/codex-app-server.ts` 正确把模型传给 `thread/start`，将 effort 传给 `turn/start`；真实失败记录也确认传入 ID 正确。新版实测说明这条基本协议无须重写。
6. `apps/server/internal/httpapi/agent_model_catalog.go` 的目录缓存包含设备和 profile 字段，但没有实际 CLI 版本、配置来源及原生账号身份代次。前端 `use-chat-runtime.ts` 也按 `deviceId:profileId` 保存目录。升级/重新登录后，现有目录可能继续存在。

Catalog device 是执行目录发现的设备，不是增加权限的设置，也不是原会话执行设备的切换器。本次聊天发现请求包含所选 profile 的 deviceId，尚无证据表明失败由错误的 Catalog device 路由造成。

## 修复设计与实施顺序

### P0：让实际执行环境支持模型

为设备的原生运行时提供明确的可执行文件来源选择，显示实际绝对路径、完整版本、来源（PATH / App / 用户指定）和执行配置目录。检测所有已安装候选并按真实路径去重。显式 `FOUNDRY_CODEX_BIN` / `CODEX_CLI_PATH` 应优先且失败时给出明确错误，不能悄悄落到另一程序。

mac-laptop 已有可用的 App 内置 CLI，可以让用户明确选择该来源；保持当前执行账号目录不变。更换 executable 与更换账号是两件独立操作。尤其不能因为 App 用 `~/.codex-personal`，便自动把 Foundry 的登录目录改为该目录。

dev-server 需要升级其实际执行 CLI 并复测。先查官方可用构建及兼容性；按设备更新流程安装合适版本，再核对真实路径与版本，重新读取目录，并用 6.1 Sol 完成一次最小运行。当前未验证 Linux 新版，不把 macOS alpha 成功当成 Linux 发布验收。

自动模式保持保守：不能仅按版本数字自动切到预览版或改变显式选择。发现已安装的较新候选时提供可见操作。已运行会话维持原执行环境，新会话使用新的选择。

涉及：`native-cli.ts`、`native-cli-install.ts`、`provider-health.ts`、运行时设置与设备账号页，以及相应 protocol/store 字段。把“协议最低版本”“检测到更新候选”“模型在当前运行时的发现/执行状态”分开呈现。

### P0：模型目录绑定实际执行环境

官方登录的可选目录以所选执行客户端的原生发现为来源，移除官网模型的无条件并集。官网信息可用于提示有新模型发布，但不充当账号或执行环境的可用性证据。兼容 API 连接继续使用其自身 `/models`。

为发现结果增加来源、读取时间、是否降级，以及执行环境标识。原生发现失败时明确报告不可用/缓存状态，不能静默把官网或 bundled 目录当成实时账号权限。原生目录缺失不等于绝对无权限：已有会话保存的模型仍显示，标注“当前环境未发现”，不悄悄改成另一模型。手动指定流程应有明确的未验证状态，而不是猜测订阅权限。

模型发现与实际运行共用同一 resolved runtime descriptor：设备、绝对 executable 路径、完整版本、CODEX_HOME、provider 配置和非敏感账号 fingerprint。原生发现当前独立从 `nativeSources()[0]` 读取，不能让未来的来源选择仅影响执行端。

涉及：`native-inspection.ts`、`published-codex-models.ts`、`models.ts`、protocol/store 的模型目录返回类型、聊天模型选择器。不要仅修改官网解析规则或硬编码删除 `gpt-6.1-sol`。

### P1：更新与缓存失效闭环

设备报告 runtime generation/fingerprint；CLI 来源、版本、配置目录或原生账号身份变化时更新。服务端缓存和前端目录状态包含该代次；变化时清空并重新发现。刷新操作必须贯穿前端、服务端和原生层，并真实显示降级情况，不能保证原生 RPC 一定在线。

旧运行时与新运行时不得复用不匹配的活动 client。新会话记录脱敏诊断快照：路径、完整版本、配置目录、账号身份 fingerprint、provider、选中模型、目录来源/时间。不要记录 token、完整进程环境或敏感 URL 参数。

涉及：`agent_model_catalog.go`、worker 注册/更新通知、`use-chat-runtime.ts`、`runner/active-runtimes.ts`、运行事件与诊断展示。

### P1：错误应指导恢复

保留原生错误，但对该 400 增加解释：模型在“此设备、此客户端及当前登录环境”被拒绝。给出刷新目录、查看实际 CLI、更新/选择已安装客户端的操作。不要据此宣称账号没有权限、要求重登、把整个账号标成额度耗尽，或自动切换模型。

## 验收与回归

| 范围       | 必须通过的结果                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 候选选择   | PATH 旧版与 App 新版共存时两个来源可见；显式 pin 被保留；预览版不静默替换；路径去重及完整 prerelease 版本保留 |
| 账号隔离   | 仅切 executable 不改变 CODEX_HOME、账号或 workspace；取消/失败不改变执行环境                                  |
| 目录       | 旧原生列表不会被官网 6.1 Sol 自动补为可用；原生失败、离线/bundled 降级可辨；已有模型值不静默被替换            |
| 缓存       | 版本、路径、账号代次变动后服务端与前端目录失效；并发请求去重不串设备或账号                                    |
| 错误       | unsupported-model 不触发账号额度 hold，不误报认证失效；新旧原生错误保留足够上下文                             |
| 协议       | 新客户端使用真实 Foundry identity，6.1 Sol + High 完成；无直接推理 HTTP、无 first-party 冒充                  |
| 真机端到端 | mac-laptop 以及升级后的 dev-server 分别从 Foundry UI 发送、接收完成回复，并用原生日志核对实际模型和 CLI 版本  |
| 浏览器     | 若实施 UI，验收键盘、选中/未选中、busy/error、light/dark、窄屏及完整页面正常比例；记录证据                    |

更新/扩展 `native-cli.test.mjs`、`native-inspection.test.mjs`、官网合并测试、服务端目录缓存测试及前端 runtime 选择测试。重点验证上述行为，不用快照固化错误的并集设计。协议类型变动后先构建 `@bd777/foundry-protocol`，最后按改动文件运行 `scripts/check-changed.sh --files ...`。

本次只完成研究和 CLI/app-server 对照，没有升级设备、修改 Foundry 运行配置或实施 UI，因此不能将本报告视为修复已上线或浏览器验收完成。

## 官方依据与边界

- [OpenAI Models](https://learn.chatgpt.com/docs/models)：模型可用性受账号、客户端和 rollout 影响，6.1 Sol 已覆盖符合条件的 Codex 桌面和 CLI；仅选中模型不会赋予访问能力。
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)：模型选择应对应选中账号；app-server 的 `model/list` 可能使用缓存/内置目录。文档中的直接 token 请求不是本方案实施授权；Foundry 继续遵守原生 SDK/CLI 和现有元数据例外边界。

后续只有在新版实际执行成功、目录与执行来源一致、更新失效链及 UI 验收通过后，才能宣布该问题修复。
