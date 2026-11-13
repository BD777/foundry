# DEV-205 设置面板读不到连接器提供的外部连接

## 状态

已实现，定向测试 7/7 通过。改动在 dev 检出中未提交（foundry 提交时间窗）。Worker `0.5.7-dev.357.g8f394c91.local.1794540840` 已于 2026-11-13 发布到 dev，并通过 `update_worker` 更新了 7 台设备；回滚用 `worker-packages/release.json.pre-dev205`。byte-dev 上的 Limen · default 已于 2026-11-13 验证通过，可以选用。

## 问题

本人在 byte-dev 上打开“Set up Limen · default on byte-dev”，面板显示 “No setup command is registered for this connection. Run its gateway's installer on byte-dev again.”

## 证据

- byte-dev 实际已装好：`~/.foundry/extension-model-providers.json` 中 Limen 扩展（0.2.1，内置）列出了 `limen_default`，没有 `problem`；helper（`~/.bun/bin/bun` + `~/.local/share/limen/host-connection-v1/connection.js`）存在。
- 它只是没有验证过：`provider-checks.json` 中上一次检查（2026-11-06）因周额度用完失败，而且指纹已经变了，所以状态是 “Not checked yet”。
- 其他设备也都没有登记安装命令（`externalSetup`）：DEV-111 之后 Limen 改由连接器扩展提供连接，不再调用 `connection add --setup-command`。

## 根因

Worker 回答设置状态的读取（`read_external_connection_setup` → `externalConnectionSetupState`）只查 `connection add` 写入的 `agent-profiles.local.json`（`listExternalConnections`），不查连接器扩展提供的连接。所以 Worker 回复中没有 `connection` 字段，Server 的 `externalSetupStage` 就把它当成“未登记”（`not_set_up`）。又因为没有任何设备登记过安装命令，面板显示 `noCommand`，而没有进入“已登记，未验证 → 验证一次”。

## 修复

- `external-connection-registry.ts` 新增 `externalConnectionState(id)`：从 `configuredAgentProfiles` 查找（与 `registeredExternalConnection` 和检查路径一致），手工登记的和连接器提供的都在其中；连接器报告 `problem` 的视为不可用。
- `externalConnectionSetupState` 改用它。连接器提供、已装好的连接在面板中直接进入 `unchecked`，面板自动验证一次，通过即选中。不需要安装命令。
- 测试：`external-connection-setup.test.mjs` 新增“the daemon reads a connection a connector extension gives the device”。

## 第二步：没装或没登录连接器的设备不再走到死路（2026-11-13）

### 问题

扩展路径不登记安装命令。在没有安装或没有登录该连接器的设备上，面板没有可做的操作。对于完全没装的设备，Server 根本不提供这个连接（offer 只来自登记过 `externalSetup` 的其他设备）。

### 实现（通用，代码中没有任何网关名）

- Server `externalConnectionOffers`：本人其他设备上由连接器提供的连接（`profile.Connector`）也提供给这台设备；offer 新增 `connector {kind,label}`。协议 `ExternalConnectionOffer.connector` 同步更新。
- Web 设置面板：带 `connector` 的 offer 不显示命令区，改为 `ConnectorSetupSection`。它读取 `/api/connectors/devices`，用一句话说明这台设备缺什么，并给出一个操作（`connectorSetupNeed`）：
  - 内置扩展没装：在面板里直接“在 {设备} 上安装 {扩展}”，与 Connectors 页的安装按钮调用同一个接口（`installDeviceExtension(bundledExtensionId)`）；
  - 没登录、需要从 git 源安装、工具未装或其他问题：打开 `/connectors/<kind>?setup=<deviceId>`，由本人在那里点一下继续（见下面“第三步”）。连接器自己报告的问题原文显示在面板里；
  - 设备离线：只说明，不给操作。
- 连接器装好并登录后，Worker（第一步的修复）即报告这个连接，面板进入“验证一次”，通过后选中。步骤清单改为两步：“{连接器} 已安装并登录” → “验证”。

### 检查

- Go：`go test ./internal/httpapi -run TestExternalConnection` 通过，新增 `TestExternalConnectionOffersIncludeConnectorGivenConnections`；`go vet ./internal/httpapi` 通过。
- Web：`test/external-connection-setup.test.mjs` 6/6 通过（新增连接器步骤与 `connectorSetupNeed` 两项）；`tsc --noEmit` 通过；buttons、copy、hints、feedback、state-layout、component-system、component-boundaries、feature-architecture、app-boundary 审计通过；`audit-module-boundaries` 通过。
- 截图（1280×800，合成数据：临时 Vite 页面只渲染该面板，API 由本地假数据回答，没有用到真实设备或账号，验后删除）：`~/workspace/foundry/.foundry/attachments/dev205/setup-dialog-install.png`（内置扩展未安装）、`setup-dialog-signin.png`（未登录）。

### 部署

- Server SHA-256 前缀 `01f62b831fa4b3a6`，回滚副本 `releases/dev023-candidate/foundry-server.pre-dev205b`，`/healthz` ok（startedAt 2026-11-13T04:02:13Z）。
- Web build `b60eb7e32dc83c25`（前一版 `bd0dd1640dd5e1a7`，保存在 `web-releases/dev205-connector-setup/`）。
- Worker 本步无改动。

## 第三步：链接只定位，不替人操作（2026-11-13）

### 原因

第二步里 Connectors 页读到 `?setup=<deviceId>` 就自己开始安装或登录。这样一来，任何链接（来自聊天、消息或其他网站）只要被本人点开，就能在本人的设备上触发操作。

### 实现

- `device-held-connector.tsx`：读取 `?setup=` 一次并从地址里去掉，只记住目标设备，不再调用安装或登录。
- `connector-setup-target.tsx` 新增 `useSetupTarget`：把目标行滚动到中间，用 `bg-accent-soft` 标出，加一行提示“From the setup panel: continue with the button on this row.”（中文“从设置窗口过来：点这一行的按钮继续。”），并把焦点放在该行动作区第一个可用按钮上。设备的读数晚到时，焦点会跟着下一步移动；但如果本人已经把焦点移到别处，就不再抢回。`DeviceConnectorRow` 与未安装扩展的设备行（`ExtensionInstallRow`）都使用它。
- 设置面板中按钮旁的说明改为“在连接器页打开该设备这一行，在那里点一下继续”。

### 检查

- Web：`test/connector-setup-target.test.mjs`（happy-dom）3/3：链接参数只读一次并保留其他参数；目标行有标记和提示，焦点在“Sign in”上，点击前 `onSignIn` 调用 0 次、点击后 1 次；读数晚到时焦点从“Check again”移到“Sign in”。`test/external-connection-setup.test.mjs` 6/6。`tsc --noEmit` 通过；buttons、copy、hints、feedback、state-layout、component-system、component-boundaries、feature-architecture、app-boundary、native-controls、inline-styles、style-invariants 审计通过。
- 真实浏览器端到端测试（`scripts/scratch-stack.sh` 空库临时栈；两台合成 Worker，各自独立状态根，装测试用扩展 `corp`：synthetic-a 已登录，提供 `corp_default`；synthetic-b 未登录）：
  1. synthetic-b 的工作区里，聊天模型菜单显示“Corp · default · Set up… · Not set up on this device”；打开后面板显示“corpcli is not signed in on synthetic-b”和按钮“Sign in to corpcli”（`e2e-1-dialog.png`）；
  2. 点击后跳转到 `/connectors/corpcli`（`setup` 参数已去掉）：synthetic-b 这一行被标出，带提示，焦点在“Sign in”上；页面上没有打开任何对话框，扩展的 `signIn.begin` 调用 0 次（`e2e-2-connectors-row.png`）；
  3. 本人按下按钮后才打开“Sign in to corpcli”登录对话框（`e2e-3-sign-in-started.png`）。
  - 第一次运行时，焦点落在“Check again”上（读数还没到），由此加了“焦点跟着下一步移动”，重新构建后复测通过。
- 截图在 `~/workspace/foundry/.foundry/attachments/dev205/`。临时栈、两台合成 Worker、空库和合成工作区在验证后已删除；没有用到真实设备，也没有卸载 Limen。

### 部署

- Web build `d0716b556ac15bf0`（2026-11-13 07:03 UTC，前一版 `db0ea127efea098b` 保存在 `web-releases/dev205-connector-setup/previous-20261113T070332Z`）。从 dev 检出构建，在 `/tmp/fdy-deploy.lock` 下完成；Server 本步无改动。
- 第一次部署时构建超过 30 分钟（机器负载约 15），后台任务被终止，没有发布。期间另一个会话从它自己的树部署了 `db0ea127`，其中只有第二步的代码，也就是会自动执行的链接。所以重新部署了一次，并在上线的包中确认含有新的提示文字。
