# DEV-093 · 连接器：设备行里一键安装 CLI，并标明凭据在哪

状态：已部署 dev（Server `11f0862cf7b0f35e…` SIGHUP，Web `9f20776ab4fe506f`），编排会话据证据接受（委托 Agent 准出，见流水）；Worker 文件交 DEV-085 并入其 Worker 发布。未在本人真实设备上安装；人工验收待确认。未提交。

## 问题

用户在 Connectors → AWS CLI 页（截图）提出两点：

1. 缺 CLI 的设备只显示“Not installed”，页面上两大段文字要人自己去设备上跑 AWS 的安装程序，希望直接给一个安装按钮。
2. 连接器分“凭据在设备上”和“凭据在服务器上”两类（之前已约定），希望页面上标出来，并用一个信息图标说明含义和用法差异。

另外顺手整理 AWS 页：两段长文字压成一句简介，安装和登录的细节移到设备行里；每行常驻的“…”菜单里只有“Check again”（标题栏已有），去掉；行高收紧。

## 调查

- `POST /api/devices/{deviceId}/connectors/{kind}/install` 已存在，Server 只是把目录描述发给 Worker（`connector_request` / `install`，10 分钟超时）。Worker `DeviceHeldConnectors.install()` 只支持 `tool.source: "npm"`（bytedcli），AWS 的目录项是 `source: "device"`，所以 Web 不给按钮，Worker 也会拒绝。
- AWS 官方安装指南：Linux zip 内的 `install` 支持 `--install-dir/-i`、`--bin-dir/-b`，指向用户可写目录即可不用 sudo，已装过要加 `--update`；macOS pkg 可 `-target CurrentUserHomeDirectory` 加 `customLocation` 的 choices.xml 装到当前用户，但不建链接，需要手动 `ln -s`。指南现在推荐的用户级安装脚本布局是 `~/.local/share/aws-cli` + `~/.local/bin`，本项沿用这一布局，两种方式装出的副本互认。
- `aws configure sso --profile NAME`：CLI 源码（`awscli/customizations/configure/sso_commands.py` `_prompt_for_profile`）在传了 `--profile` 时直接用这个名字、不再问 profile 名。所以 `--profile default` 写出的是 Worker 默认凭据链读取的 profile，“下一步命令”是准确的。
- DEV-088 的运行时安装：进度、失败原因与重试、共享的 `SetupChecklist`。本项沿用同一个清单原语表示安装步骤和终端登录步骤。

## 方案与实现

**目录与协议（Server + protocol）**

- `tool.source` 新增 `"installer"`：厂商官方的当前用户安装程序，由 Worker 适配器运行；新增 `tool.minimumVersion`，低于它的副本显示为过旧并提供安装。AWS 目录项改为 `source: "installer"`、`minimumVersion: "2.0.0"`（v1 没有 SSO 命令）。`checkDescriptor` 校验两者。
- 新能力 `connector_installer_v1`；设备列表的每台设备带 `installerSupported`，旧 Worker 的行会提示先更新 Worker，而不是点了才报错。
- 无数据库迁移。

**Worker**

- `connectors/aws-install.ts`（新）：
  - 不用 sudo，装到 `~/.local/share/aws-cli`，`aws`、`aws_completer` 链接在 `~/.local/bin`，人自己的终端也能找到；
  - Linux：下载 `awscli-exe-linux-{x86_64,aarch64}.zip`，设备有 gpg 时用 AWS 公布的密钥（指纹 FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C，在临时 keyring 中）校验 `.sig`，要求 `VALIDSIG` 指纹一致；用系统 `unzip` 解包；运行 `aws/install --install-dir … --bin-dir …`，已有副本时加 `--update`；
  - macOS：下载 `AWSCLIV2.pkg`，`pkgutil --check-signature` 必须是 Amazon 的签名；写 choices.xml（customLocation = `~/.local/share`），`installer -pkg … -target CurrentUserHomeDirectory -applyChoiceChangesXML …`，再按文档建两个链接；
  - 下载经 undici `EnvHttpProxyAgent`，遵循设备的 HTTP(S)_PROXY / NO_PROXY，只允许 `https://awscli.amazonaws.com/`，400 MB 上限，写入私有临时目录，结束即删；
  - 最后运行 `~/.local/bin/aws --version`，必须是 `aws-cli/2.x`，再在 Foundry 工具目录链接一份，让会话优先用这份（状态显示“installed by Foundry”）；
  - `~/.local/bin/aws` 若是别的副本（如 pip 装的 v1）不覆盖，失败原因写明怎么处理；缺 unzip、签名不符、下载失败、安装程序失败都只给一句原因。
- `device-held.ts`：适配器可选 `install(managedBin)`；`source: "installer"` 走适配器，旧适配器报“update the worker”。
- `managed-tools.ts`：`managedToolVersions` 只认 `../<name>/<version>/…` 形式的链接，AWS 的绝对路径链接不会被当成版本“bin”上报给技能依赖。
- `workspace-ops.ts`：声明 `connector_installer_v1`。

**Web**

- `credential-holding.tsx`（新）：每个连接器标签页（Connectors 页标签下方，以及工作区 Connectors 页每个分区标题下）显示图标 +“Credentials on each device / Credentials on the server”+ 信息按钮。按钮用 `Popover openOnHover`：悬停、键盘聚焦预览，点击或触摸固定，Escape 关闭。面板四行：保存位置、谁能用、离线时、如何撤销（AWS 的撤销写终端命令）。中英文案都有。
- `connector-installs.ts`（新）：本页发起的安装（跨标签切换保留，重复点击合并为同一次）。请求被代理截断时不当作失败：设备忙（`connector_busy`）期间每 5 s 重读，直到安装结束，以设备读数为准。
- `connector-setup-steps.tsx`（新）：设备行内的步骤，复用 `SetupChecklist`（新增 `surface="none"`，在行内不再画一层框）：
  - 未安装 / 过旧：说明安装方式，主按钮“Install AWS CLI”；设备离线时按钮禁用并写“设备离线，上线后即可安装”，旧 Worker 写“先更新 Worker”；
  - 安装中：转圈 +“Installing AWS CLI… On <设备> · 已用时间”；
  - 失败：设备给出的原因（去掉 Server 的前缀）+ “Retry”；
  - 成功：“AWS CLI 2.x installed”；
  - 终端登录（AWS 未登录时）：可复制的 `aws configure sso --profile default`（Foundry 装的副本写成 `~/.local/bin/aws …`，终端 PATH 里没有也能用），以及访问密钥 `aws configure`、续登 `aws sso login`。
- `device-connector-row.tsx`（从 `device-held-connector.tsx` 拆出）：状态徽标、一个动作、菜单放在设备名右侧同一行；菜单只在有“检查”以外的动作时出现（bytedcli 的退出 / 升级、AWS 的“Update AWS CLI”）。
- `device-held-connector.tsx`：删除 AWS 的长段安装说明，简介压成一句；有离线设备时每 20 s 重读列表，设备上线后按钮自动可用。
- `workspace-device-connectors.tsx`：同样的安装步骤；非所有者的提示改为“只有执行设备的所有者能在那里安装 CLI 或管理登录，请联系所有者”。
- `docs/connectors.md` AWS 一节同步。

## 自验

- Worker 单测：
  - `connectors-aws-install.test.mjs`（新，5 项）：Linux 参数（`--install-dir/--bin-dir`、`--update`、arm64、无 sudo、签名校验、临时目录删除、会话链接）；签名不符、缺 unzip 不安装；无 gpg 时仍可装；下载 / 安装程序失败只给一句原因；不覆盖 pip 的 `~/.local/bin/aws`；macOS 的 pkg 签名、`CurrentUserHomeDirectory`、choices.xml、链接；`installer` 连接器经适配器安装后重读状态，旧适配器提示更新 Worker；
  - `connectors-aws.test.mjs` 5/5（原“拒绝安装”断言改为“只经适配器安装”，并 stub 掉真实下载）；
  - `connectors-device-held.test.mjs` 15/15（开发中一度 14/15：模块封装审计报其他会话未提交的 Cloudflare 新文件 `httpapi/cloudflare_access.go`、`cloudflare_callback_page.go`，那边改完后通过）；本项新增的 `connectors/aws-install` 已登记到模块表；
  - `check-changed` 选出的 21 个 Worker 测试文件：177 通过、0 失败、1 跳过。
- Go：`go build ./...`；`go test ./internal/connectors/` 通过；`go test ./internal/httpapi/ -run 'Connector|DeviceHeld|AWS'` 通过。
- `scripts/check-changed.sh --files <本项文件>`：gofmt、protocol 构建与测试、Web tsc、Web 测试（3 个文件）、Go（httpapi 4 项、connectors、store）、audit:ui（12 项）、audit:contract、audit:modules 通过；prettier 与 Worker 测试的两处失败分别是本文件当时未格式化（已修）和上面那项审计，单独重跑均通过。
- Web：`tsc --noEmit` 通过；`device-held-connectors.test.mjs` 13/13（新增“AWS 在行内安装：进度、失败原因与重试、成功后的准确命令；离线 / 旧 Worker 禁用；v1 显示过旧；菜单只在有实际动作时出现”和“标签页说明凭据位置，聚焦即打开说明”两项）；全部 `scripts/audit-*.mjs` 通过。
- 真实浏览器（scratch 栈：本树构建的 Server + Web，空数据库，`FOUNDRY_INTEGRATIONS=off`；配对的 Worker 用临时 HOME、`PATH=/usr/bin:/bin`，设备上没有 aws）：
  - 失败路径：Worker 出口指向死代理 `127.0.0.1:9`。键盘聚焦“Install AWS CLI on VM-x-y-debian”后回车，行内显示“Could not install AWS CLI on VM-x-y-debian · could not download https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip: connect ECONNREFUSED 127.0.0.1:9”和“Retry”。
  - 成功路径：恢复出口，回车“Retry”，行内显示“Installing AWS CLI… On VM-x-y-debian · 1s”，45 s 后变为“AWS CLI 2.39.1 installed”和“Sign in from VM-x-y-debian’s terminal”，命令为 `~/.local/bin/aws configure sso --profile default`；键盘回车复制后按钮变为“Command copied”。重载后行内为“AWS CLI 2.39.1, installed by Foundry”，终端登录步骤仍在；行内出现“…”菜单（含 Update AWS CLI）。
  - 设备上：`~/.local/share/aws-cli/v2/2.39.1`、`~/.local/bin/aws → …/v2/current/bin/aws`、Foundry 工具目录 `bin/aws → ~/.local/bin/aws`，`aws --version` 为 `aws-cli/2.39.1 Python/3.14.8 Linux/6.1.0-43-amd64 exe/x86_64.debian.12`；gpg 在设备上，签名校验通过才会走到安装。真实 HOME 下没有 `~/.local/share/aws-cli`、`~/.local/bin/aws`。
  - 信息按钮：键盘聚焦即打开四行说明，Escape 关闭，点击固定。
  - 宽度、主题与其他标签页的截图见流水。截图含主机名，留在本机不入库。
- 限制：
  - macOS 路径只有单测（本机是 Linux），需要在一台 Mac 上真实点一次；
  - 失败状态只保存在发起安装的浏览器页面里，重载后回到“未安装 + 安装按钮”（DEV-088 的运行时安装由设备上报，可跨页面保留；本项没有改设备状态结构，避免数据库迁移）；
  - 请求被代理截断但设备上安装失败时，显示的是截断的错误而不是设备的原因；
  - AWS 签名密钥 2027-07-01 到期，AWS 换钥后要同步更新 `aws-install.ts` 里的密钥（届时设备有 gpg 时安装会以“签名不符”失败，不会装未校验的包）；
  - 工作区 Connectors 页的安装步骤只有组件复用和单测，没有在浏览器里单独点（scratch 数据库里没有工作区）。

## 部署

- Server（2026-10-30 02:06:48 UTC+8，SIGHUP）：构建树 = `d4537b1` + DEV-085（`d5df9a12…`）、DEV-090（`b0359af3…`）、DEV-091 Server（`220affa7…`）、DEV-092 v1（`ea205e1e…`）+ v2 增量（`fdd85229…`）+ 本项 Server 补丁（`3ca36723…`，5 个文件，在前四项之上与 HEAD 版本一致、无冲突），即线上 `6120e1c9…` 的同一来源加本项，不含共享树中其他未完成改动。在该树上 gofmt、`go vet`（connectors、store）、`go test ./internal/connectors ./internal/store` 和 httpapi 的 Connector/DeviceHeld/AWS/Cloudflare 子集通过。新二进制 sha256 `11f0862cf7b0f35e487ec65669395fab126a6af75cf9394acfab3564b02d0c1a`；回滚副本为硬链接 `releases/dev023-candidate/foundry-server.pre-dev093`（`6120e1c9…`）。无数据库迁移，未另做库备份（磁盘约 9 GiB，库 1.25 GB）。新进程 2 s 内接管，旧进程 806 ms 退出；`/proc/<pid>/exe` 校验和一致；`/healthz` 200；7 台设备 8 s 内全部重连；Feishu bot 重连；日志无 panic。线上 `/api/connectors/devices` 的 AWS 描述已是 `{"source":"installer","minimumVersion":"2.0.0"}`。
- Web（02:07:18，`scripts/deploy-web-dev.sh`）：`9f20776ab4fe506f` = DEV-092 发布的候选树（线上 `a47d655fe9f8385a` 的来源，发布后未改动）+ 本项 16 个 Web/协议文件（两个语言文件与候选的差异只在本项的 `holding`、`setupSteps`、`deviceHeld`、`deviceOwnerOnly` 段）。候选上 tsc 通过，`device-held-connectors` 与 `external-accounts` 测试 31/31。上一版保存在 `releases/dev093-web/previous-20261029T180718Z`，本项补丁与新文件也存放在同一目录。发布后用 e2e-alice（无痕 profile，只读，登录后登出）复查：`version.json` 为新构建；AWS 标签显示 “Credentials on each device”，Feishu 显示 “Credentials on the server”；无页面错误。e2e-alice 的合成设备均离线且未读取过，所以没有安装步骤，符合预期；未点击任何安装。
- Worker：不自行发布。本项 9 个 Worker/协议/审计文件交给 DEV-085（sess_1793284747610054843），并入其 `0.5.7-dev.158…` 重打包（同一包另含 DEV-085 与 DEV-090 Skill 修订 14）。在设备加载新 Worker 之前，新 Server 对旧 Worker 的行显示“先更新 Worker”。

## 第二轮：拉丁标点的全角间隙与深色弹层（2026-10-30）

**问题（编排会话复查截图）：** “device’ s own credential chain”“members’ sessions”这类撇号后面多出一段空白；深色模式下信息弹层和页面融在一起。

**原因：**

- 字体：根字体栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`。在没有这些具名字体的系统上（本机 Linux：`fc-match` 对每一个都返回 Noto Sans CJK SC），文字落到通用 `sans-serif`，即 CJK 字体。CJK 字体里的 ’ ‘ “ ” · … — 是全角字形。和 `lang` 无关：`lang=en` 时一样。macOS 上 SF 排在最前、自带这些字形，所以本人截图里没有这个问题；Windows/Linux 的中文环境会有。
- 弹层：`.fdy-popover`/`.fdy-tooltip` 用 `--fdy-dark-surface`（#26241f），它在浅色页面上是反色浮层；深色主题下页面 `--fdy-paper` 也是 #26241f，边框 `--fdy-dark-border` 又等于面板色，所以看不出边界。

**修复（仅 Web，`styles/00-foundation.css`）：**

- 新增字体族 “Foundry Latin Punctuation”：两个 `@font-face`（常规 100–549、粗体 550–900），`src` 只用 `local()` 指向常见拉丁系统字体（Segoe UI、Helvetica Neue、Arial、Roboto、Noto Sans、Liberation Sans、DejaVu Sans），`unicode-range` 只含 U+00B7、U+2010–2015、U+2018–201F、U+2022、U+2026、U+2032–2033、U+2039–203A。放在根字体栈 `-apple-system, BlinkMacSystemFont` 之后、其他字体之前。字母和汉字仍用原来的字体；文案一个字符都没改；中英文两种语言一样生效。
- 新令牌 `--fdy-floating-surface`/`--fdy-floating-border`：浅色主题仍是原来的反色浮层；深色主题改为菜单同款的 `--fdy-paper-main` 与 `--fdy-line-strong`。`.fdy-popover`、`.fdy-tooltip` 及其箭头都改用这两个令牌。
- 新测试 `apps/web/test/latin-punctuation-font.test.mjs`（3 项）：
  - 两个字体面覆盖上述标点，且只覆盖标点；
  - 所有样式表里含 `sans-serif` 的字体栈都在通用回退之前带上这个字体族；
  - 浮层使用浮层令牌，且深色主题下浮层面不等于页面色。
- `scripts/audit-v3-layout-contract.mjs` 中记录的根字体栈同步更新，审计债务仍为 3。

**验证：**

- 本地夹具（同一 CSS，`lang=en`/`zh-CN`、常规/粗体）：’ 从 1.00 em 降到 0.32 em（粗体 0.38），· 从 1.00 降到 0.32，中文里的 “ 从 1.00 降到 0.52；… 和 — 由 DejaVu Sans 绘制，本来就是 1 em。
- 线上，e2e-alice 只读，登录后登出：逐个测量页面文本里每个标点的实际宽度。
  - 修复前：Connectors → AWS 的 ’ 为 1.00 em；Devices、Pending、Chats 的 · 为 1.00 em。
  - 修复后：’ 为 0.32 em，· 为 0.38 em。浅色/深色、英文/中文都一样；中文是在浏览器里把账号语言改成 zh-CN 后测的，`html lang=zh-CN`，没有写回服务器。
  - 无页面错误。深色弹层有了可见边框，背景比页面亮一级。
- `check-changed`：UI 审计只有布局契约一项失败，原因就是这次有意修改的字体栈，已同步，12 项审计全部通过；新测试通过。
- 发布：Web `3c5a4213c1199f52`（以 `9f20776ab4fe506f` 的候选树加上这两个文件构建；入口 JS 与上一版只差引用的资源文件名），2026-10-30 02:14:54（UTC+8）用 `deploy-web-dev.sh` 发布，上一版保存在 `releases/dev093-web/previous-20261029T181454Z`。
- 修复前后截图：`.foundry/attachments/20261029/dev093/` 下的 `before-`/`after-` 文件（不入库）。

**限制：**

- 设备上一个拉丁系统字体都没有时（只装了 CJK 字体），这些标点仍会用 CJK 字形。要彻底解决只能自带一个只含标点的子集字体，这次没有引入。
- 浅色主题的浮层保持原来的反色样式。

## 验收步骤（给用户）

1. 打开 Connectors → AWS CLI：标签下方显示“Credentials on each device”和信息按钮；悬停、Tab 聚焦或点击都会打开四行说明。切到 Feishu、Cloudflare，显示“Credentials on the server”及对应说明。
2. 没有 AWS CLI 的在线设备：行内写“AWS CLI is not installed yet”和安装方式，按钮“Install AWS CLI”。点击后显示“Installing AWS CLI… 用时”，约 1 分钟后显示“AWS CLI 2.x installed”，下面是可复制的 `~/.local/bin/aws configure sso --profile default`。在那台设备的终端运行它（或 `aws configure` 用访问密钥），然后点“Check again”，行变为“Signed in as …”。
3. 离线设备：按钮灰色，写“设备离线，上线后即可安装”；设备上线后约 20 s 内按钮可用。
4. 失败时（比如设备不能访问 awscli.amazonaws.com）：行内显示一句原因和“Retry”。
5. 已装 AWS CLI 的行不再有常驻的“…”；只有 Foundry 装的那份才有菜单（Update AWS CLI）。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 剩余动作                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 2026-10-30 00:00 | 接手（编排会话 sess_1793063405185071529）；调查安装路由、Worker 处理、AWS 官方安装文档与 `configure sso --profile` 源码                                                                                                                                                                                                                                                                                                                                                                                                                                                | 实现                                               |
| 2026-10-30 00:45 | Worker / Server / Web 实现；Worker 5+5 项、Web 13 项、Go 连接器测试通过；UI 审计通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | scratch 端到端                                     |
| 2026-10-30 01:10 | scratch 栈（空库，免去 1.25 GB 库副本）+ 隔离 HOME 的 Worker：死代理失败路径；真实安装 AWS CLI 2.39.1（45 s）；命令复制；重载后状态；真实 HOME 未被写入                                                                                                                                                                                                                                                                                                                                                                                                                | 离线 / 上线、截图                                  |
| 2026-10-30 01:40 | 离线设备：按钮禁用并说明原因；重启 Worker 后 19 s 内按钮自动可用（不刷新页面）。截图：1280 浅色/深色、390 浅色/深色、信息面板悬停与聚焦、Feishu / Cloudflare / bytedcli 标签（无横向溢出、无页面错误）。scratch 栈已关闭，临时 HOME（含 276 MB 的 AWS CLI）已删除                                                                                                                                                                                                                                                                                                      | 统一部署交接；Mac 上真实点一次；人工验收           |
| 2026-10-30 02:07 | 编排会话（sess_1793063405185071529）据证据接受本项并要求部署（委托 Agent 准出，范围为已自验的内容；人工验收仍待用户）。Server `11f0862c…` SIGHUP、Web `9f20776ab4fe506f` 上线，详见“部署”；截图存于 `.foundry/attachments/20261029/dev093/`（不入库）                                                                                                                                                                                                                                                                                                                  | Worker 随 DEV-085 发布；Mac 上真实点一次；人工验收 |
| 2026-10-30 02:15 | 第二轮：拉丁标点全角间隙（CJK 回退字体）与深色弹层修复，Web `3c5a4213c1199f52` 发布，线上测量与截图见“第二轮”                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 人工验收                                           |
| 2026-10-30 13:42 | 后续：页面被一台链路卡住的设备拖住数十秒，另立 [DEV-096](DEV-096-connectors-page-stalled-device.md)（页面最多等 3 s、checking 状态、服务器等待时检查链路），已部署                                                                                                                                                                                                                                                                                                                                                                                                     | 见 DEV-096                                         |
| 2026-10-30 13:55 | 本人在 Mac 上点“Install AWS CLI”失败：“the downloaded AWS CLI package is not signed by Amazon”。在该 Mac 上下载真实 `AWSCLIV2.pkg` 后 `pkgutil --check-signature`：已签名、经 Apple 公证，但证书名是 “Developer ID Installer: AMZN Mobile LLC (94KV3E626L)”，旧代码要求输出含 “Amazon”，而单测用的是猜测的证书名。改为：要求 Apple 分发证书链，且第一项为 Team ID `94KV3E626L` 的 Developer ID Installer（`signedByAws`），证书名不作判断；新增测试用真实输出，冒名 Team ID 与非 Apple 链都拒绝。Worker `0.5.7-dev.168.ga0ba354a.local.1793339535` 发布，该 Mac 已更新 | 本人在 Mac 上重试安装                              |
| 2026-10-30 14:01 | 本人在 Mac 上重试：安装成功。设备上 `~/.local/bin/aws --version` → `aws-cli/2.39.2 … Darwin … arm64`，链接指向 `~/.local/share/aws-cli/aws`，临时目录已删除。下载约 3 分钟（同一台机器用 curl 直连 12 s），Worker 的下载走设备的代理设置，较慢；行内一直显示已用时间，没有进度百分比                                                                                                                                                                                                                                                                                   | 人工验收以本人页面所见为准                         |
| 2026-10-30 15:00 | 后续：安装下载进度、浏览器登录（AWS 控制台 `aws login --remote` / IAM Identity Center 设备码），另立 [DEV-099](DEV-099-aws-progress-and-browser-sign-in.md)，已部署                                                                                                                                                                                                                                                                                                                                                                                                    | 见 DEV-099                                         |
