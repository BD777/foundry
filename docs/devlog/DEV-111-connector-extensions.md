# DEV-111 · 连接器可插拔：私有连接器以扩展安装，Limen 成为连接器

状态：实现、自验与 dev 部署完成（2026-11-03 UTC+8），待人工验收。未提交（提交窗口 22:00–09:00），改动在集成树中随其他会话一起部署。

## 问题

- Limen（私有 Claude 网关）以独立的“外部模型连接”机制存在：`foundry-worker connection add` 登记、Devices 页专区、聊天选择器的专用安装面板，约 3.3k 行，和设备持有型连接器（安装、登录、状态、到期、共享）的生命周期重复，而且只有 Limen 一个实现者。
- bytedcli（公司内部 CLI）直接内置在公开仓库：目录条目、447 行适配器、文案、测试数据和 foundry skill 都带着私有名字。根源是 2026-10-15 的决定“新连接器 = 代码改动 + 目录数据”。
- 本人要求：Limen 这类依赖本地 CLI、有授权的东西放进连接器；私有项目可插拔；协议通用高效、兼容已有全部连接器；连接器的授权方式、scope、表单差异要有通用抽象。

## 调研与决定

调研（三路：现有连接器盘点、业界插件协议、业界连接器建模）见 [research/connector-extensions.md](../research/connector-extensions.md)；规范见 [connector-extensions.md](../connector-extensions.md)。本人批准的决定（2026-11-03）：

- 三层：纯数据（以后的私有 SaaS，Server 不跑扩展代码）/ manifest + 设备上的扩展进程（私有连接器）/ 内置代码（飞书、Cloudflare 的网关）。私有 ≈ 设备持有型。
- 自定义协议（MCP stdio 帧 + LSP 式生命周期 + 1Password 式领域），不以 MCP 为载体。
- 扩展只由设备所有者在本机安装，跨设备只显示安装命令。
- 先统一抽象，再接 Limen，再移出 bytedcli。

## 实现

- 协议与描述符（`packages/protocol/src/connectors.ts`、`connector-extensions.ts`）：多语言名称与说明、`signIn.methods`（guided / terminal，字段 text/secret/url/select + required/default/pattern/showWhen）、`provides`（tool / modelAccess）、`extension`、`setup`。Server 校验在 `internal/connectors/descriptor_checks.go`。
- Server：设备上报扩展提供的连接器（`DeviceProjection.connectors`，注册时校验，非所有者看不到），按设备解析（`ConnectorOn`、`ConnectorsFor`），`GET /api/connectors`；内置目录去掉 bytedcli，AWS 改用描述符登录方式；技能包的终端登录提示改由包自己声明（`foundry.signIn`），不再写死 bytedcli。
- Worker：`connectors/extensions/`（manifest、注册表与摘要、JSON-RPC 进程宿主、适配器、模型接入），`foundry-worker extension add|list|remove`；内置 AWS 与扩展走同一个设备持有型运行时；扩展提供的模型服务成为设备 profile（`connector` 字段），同 id 覆盖手工登记；扩展增删时及时上报。
- Web：标签页来自目录；统一登录对话框（选方式 → 填字段 → 链接/码/二维码/粘贴码；终端方式显示命令并检查）；“添加连接器”说明；扩展连接器标明来源，未安装的设备显示安装命令；Devices 页的外部连接标明“来自某连接器”并可跳到其登录管理；删除 AWS 定制表单与写死的连接器列表。
- 私有部分（不在本仓库）：Limen 扩展在 Limen 仓库 `tools/host/foundry-extension/`（6.6 KB 薄适配层：`limen status/join/remove` 与已安装的会话助手 `--describe`）；bytedcli 扩展在 `~/workspace/foundry-private-connectors/bytedcli/`（原适配器移植）。
- 部署中发现并修复：扩展提供的模型服务验证通过后结果被立即删除（`withExternalCheck` 只认登记文件）；`--workspace` 指向未初始化目录时设备上报在定时器里抛错导致 Worker 退出（改为跳过并记日志）。

## 自验

- 测试：Server `connectors`、`httpapi`（连接器、设备放置、技能工具）、`skillrepo`、`skilltools`、`sqlitestore`、`builtinskills`（foundry skill revision 21）；Worker `connector-extensions.test.mjs`（11 项：安装/更新/拒绝、协议版本、文件篡改、状态/安装进度/二维码/粘贴码/附加授权/登出、崩溃重启、模型接入与指纹、检查结果保留）及受影响的 66 个测试文件；Web 全量 1003 项（含 descriptor 驱动的登录方式、字段校验、终端方式、扩展来源与安装命令）；协议字段对齐；`audit:ui`、`audit:contract`、`audit:modules`。
- scratch 栈（集成树构建）：临时 Worker 装 Limen 扩展 → Server 识别连接器（ready，default）→ 设备页验证 Limen 通过（真实一轮对话）；浏览器检查 AWS 登录方式选择、字段校验、终端方式、添加连接器对话框（light/dark/390 宽），修正字号、序号、字段对齐。
- dev：e2e-alice 的合成设备（`~/.foundry/dev111-acceptance/`）装 Limen 扩展，连接器页、设备页验证、经 `Limen · default` 的真实对话（回复 `DEV111 LIMEN OK`）均在真实浏览器中确认。
- 真实设备：7 台 Worker 更新到本批包；4 台（sg-chaos、cottoncpp、CanWendeMac-mini、macbook）装 Limen 扩展并移除手工登记，扩展给出的 `limen_default` 与原登记字节一致（检查指纹不变，原“验证通过”保留，Server 上 healthy）；3 台（byte-dev、byte-dev-sg、macbook）装 bytedcli 扩展，byte-dev 上经扩展读到已登录（0.183.0，site cn，到期时间，附加授权组状态）。

## 部署

见下方时间线。Server/Web/Worker 从集成树构建（`foundry-int` = 线上内容 + 本项），部署锁 `/tmp/fdy-deploy.lock`。

## 部署后补验（2026-11-03 20:30 UTC+8）

- dev 真实浏览器（e2e-alice，浅色/深色）：飞书、Cloudflare 标签正常渲染，“Credentials on the server”说明点开后写明 Cloudflare，页面无 API 错误。
- 设备端直接调用已安装的 bytedcli 扩展：macbook 已登录（0.183.0，site cn，30 天到期，网页会话可自举）；byte-dev-sg 装有 0.118.0、未登录，网页会话提示需升级 CLI（与部署前 Server 记录的 signed_out 一致）；byte-dev 见上文。

## 验收步骤

1. 打开 Connectors：标签为 飞书 / Cloudflare / AWS CLI / Limen / bytedcli（后两个只在装了扩展的设备所有者账号下出现）；右上角“Add a connector”说明如何装扩展并列出已装扩展。
2. Limen 标签：sg-chaos、cottoncpp、CanWendeMac-mini、macbook 显示“Signed in as default”和“Gives this device's chats Claude through Limen”；其余设备在下方列为未安装。
3. 任意 Limen 设备的设备页 → Models & accounts → Model providers：`Limen · default` 标“Through the Limen connector”，“Manage Limen sign-in”跳到连接器页；点“Check”通过后刷新仍为通过。
4. 在 Limen 设备的工作区新建对话，选 `Limen · default`，发消息，正常回复。
5. bytedcli 标签：byte-dev 显示已登录与到期时间；Meego 网页会话状态在行内；未登录的设备点“Sign in”直接出二维码。
6. AWS 标签：未登录设备点“Sign in”，对话框列出三种方式；IAM Identity Center 不填必填项会提示；终端方式显示命令并可“检查”。未安装的设备行内一行说明，右侧是状态徽标与“Install AWS CLI”，没有嵌套的框。
7. 工作区 → Connectors：AWS CLI / Limen / bytedcli 每节的设备行与 Connectors 标签页同一种行：状态徽标、安装或更新、登录、“Check again”都在行右侧；附加授权的说明写的是该连接器的登录（不再提飞书），每个附加授权不再各带一个“Check again”。窄屏（390 宽）操作在卡片内换行。

## 限制

- Limen 邀请码加入（guided 方式）只做了协议级测试，没有用真实邀请码走通。
- Cloudflare 登录固定只申请只读 scope，`dns_edit` 实际难以选中（调研时发现，未在本项修复）。
- 跨设备“替我安装”（远程执行安装命令）尚未迁到连接器，扩展只显示命令；旧的外部连接安装面板仍服务手工登记的连接。

## 时间线

- 2026-11-03 16:00–18:30 UTC+8：调研、实现、检查（main 与集成树）。
- 2026-11-03 18:42：Server（`d7e2f16e…`）与 Web（`ae8696f676448ca4`）部署；Worker `0.5.7-dev.226.ga27bcc97.local.1793702605` 发布并更新 7 台设备，扩展安装完成。
- 2026-11-03 19:0x：发现并修复验证结果丢失、未初始化工作区导致退出两处问题。
- 2026-11-03 19:30–19:45：持共享部署锁 `/tmp/fdy-deploy.lock`，本项补丁 3-way 合入 `foundry-int`（无冲突），在其上检查全部通过（prettier、gofmt、协议、tsc、Web 23 个测试文件、Worker 66 个测试文件、Go connectors/externalaccounts/httpapi/builtinskills/sqlitestore 等、audit:ui/contract/modules）。从 `foundry-int` 部署：Server `ce310095edcc1d4b…`（19:36 交接，回滚副本 `dev023-candidate/foundry-server.pre-dev111b`），Web `ae8696f676448ca4`（内容不变），Worker `0.5.7-dev.225.g1d4bdcf3.local.1793705806` 更新 6 台在线设备（sg-chaos、cottoncpp、CanWendeMac-mini、byte-dev、byte-dev-sg、limen-canada）。sg-chaos 上 `foundry-worker connection check limen_default` 通过，结果保留（`checkedAt 2026-11-03T11:41:36Z`）。macbook 19:09 起离线，20:20 上线后持部署锁更新到同一包，两个扩展上报正常，`limen_default` healthy（7 台全部完成）。
- 释放部署锁，通知 DEV-107 编排会话与 UI 会话。dev 上的合成验收设备（e2e-alice，`~/.foundry/dev111-acceptance/`）Worker 已停止，数据保留供复验。

- 2026-11-03 20:4x：按本人截图修 AWS 标签样式（安装步骤并入设备行、去掉嵌套框、状态不重复、带附加授权的连接器徽标为“基础登录就绪”），Web `de726783b7693e21`。
- 2026-11-03 21:15–21:40：同类问题排查（scratch 栈 + 模拟数据，light/dark/390 宽截图）。工作区 Connectors 改用同一个设备行组件（`DeviceConnectorRow` 增加 `showCheck`/`note`/`children`），删除只剩一处用的 `ConnectorSetupSteps`；附加授权说明不再写死“飞书”，去掉每组重复的“Check again”；版本过旧时按钮为“Update …”；单独一行的检查时间首字母大写；窄屏行内操作换行不溢出。检查：prettier、tsc、Web 测试 3 个文件、audit:ui 全部通过。持部署锁从 `foundry-int` 部署 Web `4c566f5c98a24d4a`，e2e-alice 打开 `/connectors/aws`、`/connectors/limen`、`/workspace/connectors` 无 API/页面错误。
