# DEV-116 · Model providers 成为模型来源的唯一入口（订阅、API 端点、启动环境）

状态：P2 实现、自验与 dev 部署完成（2026-11-04 UTC+8），待本人在页面上确认是否符合直觉并完成一次真实订阅登录。P1 曾部署，其建模（订阅当连接器）已由 P2 纠正。方案：[Model providers 设计](../model-providers-design.md)。前置：[DEV-114](DEV-114-extension-sources.md)、[DEV-115](DEV-115-declarative-extensions.md)。

## 问题

本人体验 DEV-115 时指出：模型来源的配置散在 Model providers 页、每台设备的 Models 子标签和 Connectors 页（Limen）三处，订阅还要一台台设备进去授权，太割裂。要求统一到 Model providers 页，最多在页面里发现设备本地已有的 provider 并可提升；不为 Limen 写特化逻辑（它本来就是连接器）；页面发起登录可以，但请求到 Claude / OpenAI 的出口必须是设备自己的 IP；验证必须经官方 agent，不直接调用推理接口。

## 决定（本人批准，2026-11-04）

- 订阅（Claude Code、Codex）做成内置的设备持有型连接器，和 Limen 一样声明 `provides.modelAccess`；页面按能力取数据，不点名工具。
- 分组按来源：设备上的登录（所有 modelAccess 连接器）、服务端 API、在设备上发现。操作全部来自描述符（登录方式、`signIn.repeat`、可否登出）。
- 分期：P1（本项）只动后端和 Worker；P2 页面重做等 UI 会话迁完 Devices / Models；P3 删旧代码。

## 实现（P1）

- 目录 `apps/server/internal/connectors/catalog.json`：`claude-code`（“Claude subscription”）与 `codex`（“ChatGPT subscription”），设备持有型、`tool.source: installer`、`provides.modelAccess.runtimes` 为 `claude` / `codex`；登录方式各一个页面引导（Claude：打开页面后粘贴授权码；Codex：页面加一次性码）和一个终端命令。`catalog.go`：模型接入可服务 `codex`，但只限内置连接器（扩展的仍只服务 Claude，因为它经会话 helper 启动 Claude）。
- Worker `packages/worker/src/connectors/native-subscriptions.ts`：
  - CLI 位置用 Worker 自己的解析（`native-cli.ts`，含 ChatGPT 应用里的 Codex），经新的可选适配器钩子 `locate`（`device-held.ts`）。
  - 读登录 = 设备本地 profile 的同一个检查（`native-login.ts` 新增 `readNativeLoginHealth`），续期窗口内不运行 `auth status`。
  - 登录：`claude auth login --claudeai`（转达 `…/oauth/authorize?…` 页面，人粘贴的码写进 CLI 的 stdin，换取由 CLI 在设备上完成）、`codex login --device-auth`（转达页面和一次性码）；运行环境清空 API key 与端点变量（`nativeLoginEnvironment`），`BROWSER=true` 不在设备上开浏览器；失败只返回 CLI 的最后一句话，不含页面地址、state 或码。
  - Claude Code 的登录在 stdin 关闭后也不退出：sign-in 进程的 pid 记在 `native-sign-ins.json`，下一次登录或 daemon 启动时结束上一个 Worker 留下的。
  - 登出 `claude auth logout` / `codex logout`；安装走现有官方安装（`native-cli-install.ts`）。
  - 本机登录变化（经连接器登录、登出、安装，或检查读到不同的结果）累加 `nativeLoginRevision`，下一次心跳重新报告设备（`control-connection.ts`）。
  - 设备 profile 投影里，`local_login` 带 `connector: {kind: "claude-code" | "codex"}`（`profiles.ts`），与扩展的 external profile 一样按连接器 kind 关联。
- Server `GET /api/model-providers/overview`（`httpapi/model_providers_overview.go`，契约 `contracts/models/model_providers.yaml`）：调用者的设备；服务端 API 及其在各设备上的行；每个 modelAccess 连接器按设备的存储状态和它给出的 profile；设备上发现的端点 profile 及提升目标。只读已存储的数据，不向设备发请求。
- Worker 服务环境（顺带修复，2026-11-04 在 sg-chaos 发现）：在 Foundry 会话的 shell 里运行 `foundry-worker update` 会把那个会话的代理（含凭据的 Limen 运行代理）和 `connection-data/…/claude` 写进 systemd unit。`install/service.ts`：`FOUNDRY_SESSION_ID` 存在时只沿用已安装服务的设置；`native-runtime-paths.ts`：`connection-data/` 与 `native-runtime/` 一样视为 Foundry 生成的目录，服务从不保留。sg-chaos 的 unit 已手工修复（备份 `~/.foundry/foundry-worker.service.before-env-repair-20261104023350`）。

## 纠正（本人，2026-11-04 晚）

P1 上线后本人看到 Connectors 页出现 “Claude subscription”、“ChatGPT subscription”，指出这“非常不合适”：订阅就是 model provider，没有 connector 的性质。我把“共用设备上的 CLI 登录机制”错当成了“它们是同一类东西”。之后又提议按“只提供模型”把 Limen 也挪到 Model providers，这与本人之前的判断（Limen 就是 connector）相反，被再次纠正。讨论后确定的划分（详见设计文档“原则”与“数据模型”）：

- **Model provider**：业界通用协议的模型来源，Foundry 按协议原生支持——官方订阅（Claude Code 的 claude.ai、Codex 的 ChatGPT 登录）与 Anthropic / OpenAI 兼容端点（Server 上的，以及设备配置里发现、可提升的）。
- **Connector**：第三方服务或工具，经 Foundry 的通用 connector 协议接入（飞书、Cloudflare、aws、gh、bytedcli、Limen）。
- **启动环境**：Limen 给出的模型相当于 “Claude Code 在 Limen 提供的环境里启动”。本人要求它出现在 Model providers 页，并设计通用表达：每个模型来源 = runtime × access × launch layers；连接器对模型的唯一输出是启动层。Limen 的登录、加入、移除仍在 Connectors。
- 设备页的官方账号配置（登录、默认模型、额度）收到 Model providers，设备页只留只读摘要和链接；设备配置里发现的兼容端点放在“在设备上发现”，可提升。

## 实现（P2）

- 撤掉 P1 的目录项：`catalog.json` / `catalog.go` 回到只有 aws、github 的设备持有型连接器，扩展的模型接入只服务 Claude；Worker 删掉 `connectors/native-subscriptions.ts` 和 `device-held.ts` 的 `locate` 钩子；`local_login` profile 不再带 `connector`。
- 订阅登录回到设备账号：
  - Worker `harness/native/native-sign-in.ts`（P1 的 CLI 登录实现搬过来：Claude 页面加粘贴码、Codex 设备码、无效码结束、遗留进程回收、登出）。
  - 新的 daemon 消息 `native_sign_in` / `native_sign_in_reply`（契约 `contracts/models/profiles.yaml` 的 `NativeSignIn*`，生成类型），处理器 `daemon/handlers/native-sign-in.ts`，登录完成或登出后回带新的注册。
  - Server `httpapi/native_sign_in.go`：`POST /api/devices/{id}/accounts/{runtime}/sign-in`、`…/sign-in/poll`、`…/sign-in/code`、`…/sign-in/dismiss`、`…/sign-out`，只限设备所有者，形状与连接器登录一致。
- 撤掉 P1 的聚合接口 `GET /api/model-providers/overview`：页面读实时的工作区投影（`agentProfiles`、`providerHealth`），设备重新报告后自动更新，接口没有使用者。
- Web：
  - `lib/model-provider-shape.ts`：数据模型的派生（runtime × access × layers）。
  - `components/device-sign-in/`：设备登录流程抽成共用组件（`DeviceSignInFlow` 加 `DeviceSignInTransport`），Connectors 的连接器登录和 Model providers 的订阅登录各给一个 transport，不再两套。
  - Model providers 页（`features/profiles`）：运行时与设备筛选（`?device=` 只在打开时读一次）；“订阅” 每个运行时一组、每台设备一行（登录、检查、安装 / 更新、恢复停用账号、退出登录、展开看额度与默认设置）；“API 端点” 是服务端模型服务（原编辑器与设备分配）加 “在设备上发现”（提升）；“启动环境” 按设备列出，检查在这里，管理链接到 Connectors。原设备页的账号与 provider 组件搬进这个 feature。
  - 设备页 “模型与账号” 改为只读摘要（两个订阅、分配的服务端 API、设备配置里的端点、启动环境）和 “在模型服务页管理” 链接（带 `?device=`）；删掉 `device-connections.tsx`。

## 自验

- 探测（scratch 配置目录，不碰真实登录）：`claude auth login --claudeai` 在非 TTY 下打印页面并从 stdin 读码，错码返回 `Login failed: Request failed with status code 403` 退出 1；它监听一个随机本地端口（不是固定端口，不会互相卡住），stdin 关闭后不退出。`codex login --device-auth` 打印带颜色的页面与一次性码，`codex login status` 未登录退出 1。
- 测试：Worker `connectors-native-subscriptions.test.mjs`（解析、Claude 错码与正确码、Codex 设备码、登出、遗留 sign-in 被结束、API key 不进登录、不开浏览器、登录后重新报告）、`service-stack.test.mjs`（会话内更新保留服务自己的设置、connection-data 不进服务）；相关 Worker 测试 181 项通过；Server `connectors`（目录、扩展的 codex 模型接入被拒）、`httpapi`（连接器页与新接口 `TestModelProvidersOverview`）。

## 部署（2026-11-04 UTC+8，自 foundry-int）

- Server：`dev023-candidate/foundry-server` sha256 `6abea010a14fe347…`（回滚副本 `foundry-server.pre-dev116`），restart handoff 接管，`/healthz` 200；e2e-alice 调 `GET /api/model-providers/overview` 返回 2 台合成设备、`claude-code`/`codex`/`limen` 三个设备上的登录来源。
- Worker：先发 `…1793780632`，真实浏览器自验发现问题（见下）后修复再发 `0.5.7-dev.250.g30a4f4c8.local.1793782021`；经 compute lease 在 7 台设备运行 `foundry-worker update`，7 台 daemon 都在 `…1793782021`（macbook 的状态根是 `~/.foundry-stacks/dev`）。执行宿主：limen-canada、byte-dev-sg、cottoncpp、macbook、CanWendeMac-mini 已切换（CanWendeMac-mini 第一次更新在释放 lease 时被中断，只装了包没重启；重跑后 daemon 与执行宿主都在 `…1793782021`，`update` 自己的 120 秒上线检查超时，但设备随后上线），sg-chaos 与 byte-dev 在更早版本——它们还承载运行中的会话，空闲后切换，未强停。
- sg-chaos 的 systemd unit 更新后没有代理或 `connection-data` 行（只剩 `NO_PROXY`、`CODEX_HOME` 等本人设置）。
- 真实设备用已安装的运行时读两个新连接器（只读 `auth status` / `login status`）：sg-chaos Claude 未登录、ChatGPT 就绪；macbook 两者就绪；cottoncpp Claude 未登录、ChatGPT 就绪，与设备 profile 的状态一致。

- 真实浏览器（dev，e2e-alice，合成设备 VM-4-8-debian 跑部署的 Worker）：Connectors 页出现 “Claude subscription”、“ChatGPT subscription” 标签；Claude 行 “Signed out” 与 “Sign in”；点 “Sign in” 直接进入 “Sign in with Claude”，给出 `https://claude.com/cai/oauth/authorize?…` 链接、二维码、授权码输入框。聚合接口把 `claude_local`、`codex_local`、`limen_default` 分别归到 `claude-code`、`codex`、`limen` 下。
- 发现并修复：粘贴不完整的码（没有 `#state`）时 Claude Code 回 “Invalid code. Please make sure the full code was copied.” 后继续等待，对话框却一直显示 “Waiting for you to approve…”。现在 Worker 把这句话作为失败返回并结束 CLI；修复后真实浏览器显示 “The sign-in did not finish: Invalid code. …” 和 “Try again”，设备上没有残留的 `claude auth login`。同时修复了被取消的登录进程退出时把下一次登录标成结束的竞态（GitHub CLI 的登录有同样问题，一并修复）。

## P2 自验与部署（2026-11-04 晚，自 foundry-int，main `97415a6e` 之上）

- 检查：Server `go test`（connectors、store、httpapi 相关）、Worker 42 项（含 `native-sign-in`、`service-stack`）、Web 142 项（含新的 `native-sign-in`、`model-provider-accounts`、`devices-feature` 摘要）、`audit:ui`、prettier、`generate-contracts --check`（无破坏性变更）。
- 部署：Server `578d86a9…`（回滚 `foundry-server.pre-dev116p2`）；Web `a41c8eaf`；Worker `0.5.7-dev.269.g97415a6e.local.1793805731`，6 台在线设备 daemon 已更新（macbook 离线，上线后再更新），同一个包里也带了另一会话的 GitHub CLI 修复。
- 真实浏览器（dev，e2e-alice，合成设备跑部署的 Worker）：
  - Model providers：运行时与设备筛选；“订阅”两组（Claude 0/2、ChatGPT 2/2 已登录），离线设备的操作禁用；“API 端点”（服务器上的 + 在设备上发现）；“启动环境”列出 `Limen · default`，有“检查”和“管理 Limen 登录”。浅色、深色、420px 窄屏都看过。
  - 订阅登录：点 “Sign in” 由设备上的 Claude Code 发起登录，对话框有二维码、打开链接、粘贴授权码；关闭后设备上没有残留的 `claude auth login`。
  - Connectors：只剩飞书、Cloudflare、AWS、GitHub、Limen。
  - 设备页 “模型与账号”：只读摘要（两个订阅、服务端 API、设备配置里的端点、启动环境），“在模型服务页管理” 打开 `/model-providers?device=<id>` 并已筛选。
- 自验中发现并修复：
  - 轮询时 Worker 只回 `pending`，对话框里的授权码输入框随之消失；现在等待中的轮询重复登录页的信息（测试覆盖）。
  - 页面结构：“启动环境”“在设备上发现”出现卡片套卡片；服务器上的列表标题与“API 端点”同级；空状态文案还说“官方账号在各台设备上管理”；启动环境行写着 “External connection”。均已改。
  - sg-chaos 的 systemd unit 又带上了一个会话的 Limen 代理和 `connection-data` 下的 Claude 身份目录（不清楚是哪次从会话环境里更新写入的；之后每次重装沿用已安装的值）。手工修复（备份在 `~/.foundry/foundry-worker.service.before-env-repair-*`）并重启 daemon；`install/service.ts` 现在也丢弃指向 `connection-data` / `native-runtime` 的 `CLAUDE_SECURESTORAGE_CONFIG_DIR`、`FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME`（测试覆盖）。来源经集成会话确认：它在自己的会话 shell 里（清掉了 `FOUNDRY_SESSION_ID`）三次运行 `foundry-worker update`，会话的代理和 Claude 身份目录随之写进 unit。根因修复：`update`（`reinstallService`）只沿用已安装服务的设置，不再读调用者的 shell；只有显式的 `install` 从它自己的 shell 取设置（不读 Foundry 会话的）。测试覆盖一个没有会话标记、却带着代理和原生目录的 shell。

## 验收步骤

1. 打开 Model providers：从上到下是“订阅”（Claude 订阅、ChatGPT 订阅，每台设备一行）、“API 端点”（服务器上的、在设备上发现）、“启动环境”（如 Limen · default）。看分组和文案是否符合直觉。
2. 在一台 Claude 未登录的设备（如 sg-chaos、cottoncpp）上点 “Sign in” → 打开链接、批准、把页面上的授权码粘贴回来 → 这一行变成已登录并显示账号。粘贴不完整的码应看到 Claude Code 自己的提示和 “Try again”。
3. ChatGPT 订阅在一台未登录的设备上 “Sign in”：对话框给出 OpenAI 页面和一次性码，在那边输入后这一行就绪。
4. 已登录的行菜单 “Sign out”（先确认）：设备上的 CLI 退出，这一行回到未登录（选一台不在用的设备）。
5. 展开一行看额度与默认模型；设备筛选选一台设备，所有分组只剩它。
6. 设备页 “模型与账号” 是只读摘要；“在模型服务页管理” 打开已筛选的 Model providers。
7. Connectors 页不再有订阅；Limen 仍在那里管理。

## 限制

- 设备行的版本写作 “Claude subscription 2.1.311”（通用组件用连接器名称），P2 改为程序名。
- P2 之前，Connectors 页会因为目录多了两项而多出 “Claude subscription”、“ChatGPT subscription” 两个标签（通用组件渲染，无 Web 代码改动）；设备页的 Official accounts 仍在。
- 旧版 Worker 的 `local_login` profile 不带 `connector`，聚合接口里要等设备更新后才归到订阅下。
- Claude 的页面登录需要人在 claude.ai 批准并粘贴码，Agent 无法自验完整登录；Codex 同理需要人在 OpenAI 页面输入码。
