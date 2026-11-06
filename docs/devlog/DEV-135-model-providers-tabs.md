# DEV-135 模型服务分 Tab；启动环境可设默认值

## 问题

2026-11-06 本人反馈两点：

1. 模型服务页的「订阅」「API 端点」「启动环境」是上下平铺的，要拖到很下面才能看到后面的部分。
2. 启动环境（目前只有 Limen）不能设默认配置（默认模型、effort 等）。它只是带着连接器的环境启动原生 Claude Code / Codex，订阅能设的默认值它也应该都能设。

## 调查

- 页面：`features/profiles/profiles-feature.tsx` 把 `SubscriptionsSection`、端点（`ProfileList` + `DiscoveredProviders`）和 `EnvironmentProviders` 依次渲染；路由 `/model-providers` 没有子路径。
- 默认值的现有机制：订阅行展开后是 `DeviceAccountDefaults`（模型目录 + `RuntimeDefaultFields`），保存走 `POST /api/agent-profiles` → Hub → Worker `upsertAgentProfileConfig`，写进 `~/.foundry/agent-profiles.local.json`；会话启动时 `profileConfigForSession` 读出，`claudeEffort(session, profile)` 等以会话值优先、profile 值兜底。Server 不存这些值，它们是设备上报的 profile 投影的一部分。
- 启动环境：Worker 每 5 分钟（有问题时 1 分钟）重新列连接器的服务，结果整份写进 `extension-model-providers.json`（DEV-127），`configuredAgentProfiles` 由它生成 profile。`upsertAgentProfileConfig` 对 `external` 直接抛错「External connections must be configured on the device」，Web 也没有入口。
- 所以不能把默认值写进连接器的列表：下一次重列就覆盖掉了；服务暂时不可用或退出再登录时也会丢。

## 设计

- **Tab**：`lib/provider-tabs.ts` 定义 `subscriptions | endpoints | environments`；路由加 `providerTab`，`/model-providers/<tab>`，与 Connectors 的 `connectorTab` 同一做法（`use-app-route-sync.ts` 管历史，popstate 回填）。裸 `/model-providers`、旧的 `/profiles`、`/connections` 和未知 tab 都打开「订阅」。`?provider=<id>`（打开某个端点的编辑框）切到「API 端点」。Tab 用 `SegmentedControl tone="navigation"`，设备/运行时筛选保留在 Tab 上方，对三个 Tab 都生效。
- **默认值，同一套机制**：
  - Web：启动环境每行加「默认值」展开按钮，展开后就是订阅用的 `DeviceAccountDefaults`（同一组件，`placement="below"` 放在行下），`connectionType: "external"`。模型目录是该服务自己列出的模型；文案写服务名而不是“官方目录”。不另做第二套控件。
  - Worker：`upsertAgentProfileConfig` 收到 `external` 时只保存本人的默认值（模型、Claude effort / 权限模式、Codex 推理 / 沙箱 / 审批 / 速度、上下文窗口），按 profile id 存进新文件 `~/.foundry/external-profile-defaults.json`（`harness/external-profile-defaults.ts`）。`configuredAgentProfiles` 最后把它叠加到每个 `external` profile 上。连接本身（helper、参数、身份、检查指纹）不变，所以检查结果和对话数据目录不受影响。
  - 保存的模型必须是服务列出的；之后服务不再提供它时，叠加时跳过，用服务自己的默认模型，其他默认值照常生效。
  - 把非 external 的 profile 改成别的连接方式仍然拒绝（原有行为）。
  - `deviceProfileRevision` 包含新文件，保存后下一次心跳就重新上报。

## 修改

- Web：`lib/provider-tabs.ts`（新）、`lib/routes.ts`、`lib/in-app-navigation.ts`、`app/use-app-route-sync.ts`、`app/active-view.tsx`、`App.tsx`、`features/profiles/profiles-feature.tsx`、`features/profiles/provider-sections.tsx`（新，Tab 控件与端点 Tab）、`device-providers.tsx`（启动环境为空时的说明）、`device-external-connections.tsx`（默认值展开）、`device-account-defaults.tsx`（external 文案与位置）、两种语言的 `profiles.ts`。
- Worker：`harness/external-profile-defaults.ts`（新）、`harness/profiles.ts`。
- 文档：`docs/connector-extensions.md`「模型接入」补默认值规则。

## 部署

- 基于 `origin/main` c228d855。补丁用 `git apply` 合入主工作区 `~/workspace/foundry`；README 因其他会话改过，手工加了一行。部署时持有 `/tmp/fdy-deploy.lock`，排在 DEV-132/133 的 Web 部署之后。
- Web `6e73cf416cc0a0ee`（之前 `58e03f726e6b9de8`，已含 DEV-132/133 的 Web 改动），2026-11-06 05:18 UTC+8 由 `scripts/deploy-web-dev.sh` 发布。回滚入口在 `~/.foundry/server/web-releases/dev135/previous-20261105T211836Z/`。
- Server 不涉及。
- Worker `0.5.7-dev.302.gc228d855.local.1793913792`：按编排安排，由 `sess_1793896656923516691`（DEV-132/133）统一打包并更新设备，同包含 DEV-136。7 台设备都报告这个版本：CanWendeMac-mini、macbook、byte-dev、byte-dev-sg、cottoncpp、limen-canada、sg-chaos。byte-dev 上 1 个、sg-chaos 上 2 个旧执行宿主还有回合在跑，没有强停。
- 更新后的检查（dev DB 只读）：有 `limen_default` 的 5 台设备（CanWendeMac-mini、macbook、byte-dev、cottoncpp、sg-chaos）更新后上报的状态仍是 healthy，更新前那次 passed 检查仍然匹配。指纹如果变了，状态会退回「未检查」，所以连接没有变。sg-chaos 的指纹 `claude:external:34beee84…` 与 scratch stack 上看到的相同。还没人保存过默认值，所以 byte-dev、macbook、sg-chaos 上都没有 `external-profile-defaults.json`。
- dev 真实浏览器冒烟（e2e-alice，独立 headless profile）：`/model-providers` 落到 `/model-providers/subscriptions`；`/endpoints`、`/environments` 选中对应 Tab；旧的 `/profiles` 落到订阅；API 请求都发往 `https://dev.foundryapp.app`。

## 验证

- `scripts/check-changed.sh`（经 `fdy-heavy`）：web tsc、22 个 Web 测试文件、worker 构建、35 个 worker 测试文件、audit:ui（15 项）、audit:modules 全部 PASS。
- 新测试：`packages/worker/test/external-profile-defaults.test.mjs`（5 个）：保存后连接指纹不变；带 problem 重列、从列表消失、再列回来，默认值都在；会话按它启动（模型、effort，会话自己的选择优先）；服务不再提供保存的模型时用服务默认；不提供的模型拒绝；设备上没有的服务拒绝；模型目录是服务列出的模型。`apps/web/test/profiles-feature.test.mjs` 新增 Tab 与启动环境默认值往返两个测试；`app-navigation`、`devices-feature` 按新路径更新。
- 真实浏览器（scratch stack `provtabs`，dev DB 副本，Worker 跑本分支代码，状态根里装着真实的 Limen 扩展，由它真实列出 `limen_default`）：
  - `/model-providers` 落到 `/model-providers/subscriptions`；Tab 键盘可用（方向键移焦点、空格选中，地址变 `/model-providers/environments`）；后退、前进、刷新都停在对应 Tab。
  - 启动环境 Tab 展开「默认值」，模型列表是 Limen 给的 sonnet / opus / haiku；选 opus、effort High 保存，提示「Device defaults saved.」；状态根里 `external-profile-defaults.json` 写入 `{"limen_default":{"model":"opus","claudeEffort":"high"}}`。
  - 重列：停掉 Worker、删掉 `extension-model-providers.json` 再启动，Worker 重新向 Limen 列出服务后，`GET /api/agent-profiles` 里 `limen_default` 仍是 model opus、effort high，检查指纹不变（`claude:external:34beee84…`）。
  - 启动参数：用本分支 Worker 代码在同一状态根上解析 `profileId: limen_default` 的会话：启动模型 opus、effort high、权限 bypassPermissions、helper `bun`、身份保留；会话自己选 haiku / low 时以会话为准。
  - 浅色 / 深色 1440、浅色 390 宽截图检查过布局（`~/.foundry/devlog-evidence/dev135/`，不进仓库）。

## 限制

- 没有发起真实的 Limen 对话：sg-chaos 上 Limen 账号本周额度已用完（检查返回 `You've hit your weekly limit · resets 2pm (America/Toronto)`），所以对话选择器里它显示为未就绪。启动参数由上面的解析和单元测试覆盖，额度恢复后按验收步骤 3 实测。
- 默认值只存在设备上（与订阅默认值一致）：换一台设备要再设一次。设备离线时不能改。
- 面板里的「默认模型」显示的是生效值：没设过时显示 Limen 自己的默认（sonnet），旁边也有「使用 Limen 的默认」按钮。保存时会把当时显示的模型记成本人的选择。

## 验收步骤

1. 打开模型服务：顶部有「订阅 / API 端点 / 启动环境」三个 Tab，点哪个只显示哪一部分，地址变成 `/model-providers/<tab>`；刷新、后退仍停在对应 Tab。
2. 启动环境 Tab：设备下「Limen · default」一行有「默认值」按钮；展开后能选 Limen 提供的模型（sonnet / opus / haiku）、effort、权限模式，保存后提示已保存。
3. 在该设备的工作区用 Limen 新开对话：输入框默认显示刚设的模型和 effort；发一条消息，回复正常。
4. 几分钟后（Worker 至少重列一次）再展开，默认值仍在。

## 时间线

- 2026-11-06 05:18 UTC+8 Web `6e73cf416cc0a0ee` 已部署到 dev，Worker `0.5.7-dev.302.gc228d855.local.1793913792` 已更新到 7 台设备（与 DEV-132/133、DEV-136 同包）。未提交；真实 Limen 回合因周额度用完未验证。

## 后续修正：保存默认模型让已通过的检查失效（2026-11-06）

### 问题

本人在 Limen 上保存默认模型 opus 后，启动环境显示「未验证」、对话选择器里 Limen 显示未就绪，状态文字是「Checking that this provider answers.」，但其实没有检查在跑。本人按了「验证」：byte-dev 返回 `You've hit your weekly limit · resets 2pm (America/Toronto)`，白用了一次额度，页面显示为验证失败；CanWendeMac-mini 一直是 pending。

### 更正

上文「部署」和「验证」两节说“检查指纹不变”，那是 `profileFingerprint`（连接指纹，`claude:external:34beee84…`），不是检查结果用的 `providerCheckFingerprint`。后者把 `model` 算进去，而默认值在 `configuredAgentProfiles` 里叠加到 profile 上，所以一保存默认模型，存着的 passed 检查就对不上了。更新后那次核对之所以还是 healthy，是因为当时没人保存过默认值。

### 根因

- `harness/provider-check-state.ts` 的 `providerCheckFingerprint` 含 `model`；读（`discoveredProviderStatus` → `currentProviderCheck`）和写（`checkExternalConnection` → `checkProvider`）都拿叠加默认值之后的 profile 算。
- 没有当前检查时，状态文字固定是「Checking that this provider answers.」；external 连接从不自动检查（会耗额度），这句话不对，还原样显示在对话选择器里。
- 额度用完和连接坏了是同一种 `failed`。

### 修复

- Worker：`withExternalProfileDefaults` 把被默认值替换掉的字段原值记进 `asGiven`；新的 `externalConnectionAsGiven` 还原出连接器给的连接。`providerCheckFingerprint` 对 external 一律按它计算，`checkExternalConnection` 也用它跑那一轮对话。这样指纹回到 DEV-135 之前的算法，旧的 passed 结果不用重新检查就重新生效。模型有效性仍有保证：保存的默认模型必须是 Limen 列出的，服务不再提供时叠加会跳过它。
- 发现的 API 端点不受影响：它们没有这套设备默认值；在页面上改它是“提升”为新的 profile，那个 profile 不需要检查。
- 额度：`session/provider-check.ts` 新增 `checkFailureReason`，`hit your … limit`、`usage limit`、rate limit、`429`、`insufficient_quota` / `exceeded your current quota` 记为 `reason: "quota_exhausted"`，原文（含恢复时间）保留在 `message`。契约 `AgentProfileCheck.reason`（`contracts/models/profiles.yaml`，已重新生成）、`ExternalConnectionLiveState.check.reason`、Server `externalConnectionCheck.Reason` 都会带上它。
- 没有当前检查时，external 的状态文字改为「Not checked yet.」；发现的端点会自动检查，所以那边的文字不变。
- Web：`externalConnectionState` 新增 `quota_exhausted`。启动环境那一行显示橙色「额度已用完」标签和「Limen 的额度已用完 · resets 2pm (America/Toronto)」（恢复时间取自服务原话，没有就提示恢复后再验证），按「验证」得到的提示是 warning 而不是「没有正常回复」。默认值照常显示、照常可改；重试仍只有「验证」。两种语言都有文案。

### 证据

- 真实数据（sg-chaos 的 `provider-checks.json` + `extension-model-providers.json` 复制到临时状态根，HOME 也是临时的）：旧代码保存 `{"model":"opus"}` 后指纹不再匹配，状态是 `unavailable` / `pending` / 「Checking that this provider answers.」；新代码在同样的数据上 `limen_default` 仍是 `healthy`，检查 `passed`，`checkedAt` 还是 `2026-11-03T11:41:36.722Z`，和本人以前那次检查一致。
- 新测试：`external-profile-defaults.test.mjs`「saving a default model keeps the connection's passed check」（先按无默认值算的指纹记一次 passed，保存 opus 后投影仍 passed、`checkedAt` 不变；检查用的是连接器给的模型；换了身份就回到 pending 和「Not checked yet.」）；把指纹改回旧算法时这条测试失败。「a provider's limit reached is a used-up quota」覆盖周额度原文和其他额度措辞，也覆盖不该命中的情况。Web：`profile-status.test.mjs` 的 quota 状态；`profiles-feature.test.mjs`「a launch environment whose quota is used up is a warning…」验证显示的文案、没有「验证失败」、「再次验证」还在、默认值能展开。
- `scripts/check-changed.sh`：prettier、gofmt、protocol build/tests、web tsc、7 个 Web 测试文件、worker build、118 个 worker 测试文件、go httpapi/store、audit:contract、audit:openapi、audit:modules 全部 PASS；`pnpm audit:ui` PASS。

### 已有设备更新 Worker 之后

- 在保存默认值之后**没有**再按过「验证」的设备（如 CanWendeMac-mini）：存着的 passed 结果是按旧算法（不含默认值）记的，新算法对 external 也不计默认值，两者一致，更新后马上恢复 healthy，不需要再验证。
- 保存默认值之后按过「验证」的设备（byte-dev）：那次失败的结果覆盖了原来的 passed，指纹是按 opus 算的。更新后它既对不上（记为「Not checked yet」），也不能恢复原来的 passed。额度恢复后需要再验证一次。
- 本次未部署，Worker 也没更新到设备；上面是按代码和复制出来的真实数据推出的，还没有在设备上确认。

### 修正后的验收步骤

1. Worker 更新后，打开模型服务 › 启动环境：已保存默认模型、之后没再验证的设备上，Limen 一行是「可直接使用」，检查时间还是更新前那次；对话选择器里 Limen 可选。
2. byte-dev（或任何额度已用完的设备）：按「验证」后，这一行显示「额度已用完」和「Limen 的额度已用完 · resets …」，提示是警告色；默认值仍可展开、修改。
3. 没有检查结果的 Limen 行，状态文字是「Not checked yet.」，不再是「Checking that this provider answers.」。

### 部署与设备核对（2026-11-06 16:40，编排接手）

- Worker 部分在 `0.5.7-dev.303.g1837af21.local.1793945903` 里（打包 14:18 晚于改动 11:22），7 台在线设备都已是这个版本。Server 部分（`externalConnectionCheck.Reason`）此前没有生效：运行的是 05:25 的二进制。16:40 重新构建并重启，见 DEV-142 时间线。Web 部分在 build `71bb496ba70152fb`。
- 设备上的实际状态（`list_profiles`）：CanWendeMac-mini 的 Limen 保存了 opus/high，仍是 `healthy`，检查 `passed`、`checkedAt` 2026-10-26（验收步骤 1 成立）；byte-dev 保存过默认值后又验证过，现为 `unavailable` / `pending`，文字「Not checked yet.」（步骤 3 成立，与“已有设备更新 Worker 之后”的预期一致）。
- 未核对：步骤 2「额度已用完」标签。需要本人在 byte-dev 上按「验证」（仅限所有者，且会发起一次检查）。
