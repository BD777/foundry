# DEV-099 · AWS CLI：安装进度，以及不用终端的浏览器登录

状态：已部署 dev：Server `349362f9…`（SIGHUP）、Web `c0f4ee7e428fee44`、Worker `0.5.7-dev.168.ga0ba354a.local.1793343579`（已发布，设备空闲时更新）。Agent 自验通过（最后一步真实登录需要本人）。人工验收待确认。未提交。来源：[DEV-093](DEV-093-connector-cli-install.md) 的后续。编号说明：编排会话指定为 DEV-097，但 DEV-097（过程列表运行中效果）和 DEV-098（聊天右侧卡片恢复）已被其他事项占用，故用 DEV-099。

## 问题

本人在 Mac 上重新安装 AWS CLI 成功（签名检查的修正见 DEV-093 流水 13:55、14:01）。之后提了两点：

1. 通过设备代理下载用了约 3 分钟，行里只显示已用时间，看不出进度。
2. “能不能点一个 URL，跳转后回调？命令行应该是最后的选择，要对人友好。”此前行里只给 `aws configure sso`、`aws configure`、`aws sso login` 三条命令。

## 调查

在本机临时目录装了 AWS CLI 2.39.2（与真实设备同版本），读帮助、实际运行，并对照 AWS 文档与 CLI 源码：

- `aws login`（2.32 起）：用 AWS 管理控制台的登录换取 CLI 临时凭据，凭据和刷新令牌存在设备上。
  - 默认在本机起 localhost 回调。只有浏览器和 CLI 在同一台机器上才能用，而本人的浏览器通常不在设备上。
  - `--remote` 不起回调：打印 `https://<region>.signin.aws.amazon.com/v1/authorize?...`，确认页 `/v1/sessions/confirmation` 显示一个授权码，然后提示 “Enter the authorization code displayed in your browser”。实测输出与帮助一致。
  - 授权码要粘贴回 CLI。所以“点链接、自动回调”在设备不是本机时做不到，只能由 Foundry 页面收下授权码，交给设备上那个还在等的 CLI。
- IAM Identity Center：`aws sso login --use-device-code --no-browser`（2.22 起）。
  - 打印 URL 和形如 `ABCD-EFGH` 的码；还有一个自带 `user_code` 的 URL，打开即自动填码（输出格式见 `awscli/customizations/sso/utils.py`）。
  - CLI 自己轮询，不需要粘贴任何东西。
  - 需要先有配置：门户 URL、Identity Center 区域、账号 ID、角色名。可以用 `aws configure set … --profile` 非交互写入，交互式的 `aws configure sso` 用不上。
- 实测发现：`aws login` 遇到已配成 SSO 的 default profile 会拒绝（“Profile 'default' is already configured with SSO credentials”）。所以一次没成功的 SSO 登录不能先改 default。
- 下载进度：Worker 用 undici 下载，响应带 Content-Length，可以按字节报告。但安装请求本身是一次同步 RPC，过程中没有通道把进度送回来。

## 方案与实现

### 1. 安装进度（Worker + Server + Web）

- Worker `aws-install.ts`：
  - 下载时按收到的字节回调，最多每秒报告一次，下载结束时再报告一次：已收字节、总字节（Content-Length）、平均速度。
  - 之后依次报告 `verifying`（签名）、`installing`（运行安装程序）、`checking`（`aws --version`）。Linux zip 和 macOS pkg 走同一路径。
- 新的设备消息 `connector_progress`（Worker → Server，不回复）：
  - Worker 在连接器请求的处理中附带 progress 钩子（`daemon/handlers/connectors.ts` → `handleConnectorRequest(request, hooks)`）。
  - Server 在内存里保留每台设备、每种连接器的最新一条（`connector_progress.go`）：超过 30 s 不更新的不再显示；安装请求返回时清除。设备列表里的条目带 `progress`。
- Web：
  - 安装中的行先显示一个进度条，此时为不确定状态。有了报告后进度条显示实际进度，文字为 “Downloading 22.7 MB of 71.1 MB (31%) · 19.2 MB/s · On … · 1s”，下载之后是 “Running the installer…” 等。
  - 进度条从安装一开始就占着位置，报告到达时不会移动布局。用原生 `<progress>` 加 `aria-label`，读屏会读出数值。
  - 安装进行时，页面每 1.5 s 刷新一次列表（只读，不触发设备读取）。

### 2. 浏览器登录（Worker + Server + Web）

方式按情况选：

| 方式                   | 适用                                | 设备上运行                                                                                                                                            | 本人操作                                                                                                          |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| AWS 控制台登录（默认） | IAM 用户、能登控制台的角色/联合身份 | `aws login --remote --region <区域>`                                                                                                                  | 点“Open AWS sign-in”，在 AWS 页面登录，把页面显示的授权码粘贴回 Foundry，点 “Finish sign-in”                      |
| IAM Identity Center    | 公司用 AWS 访问门户                 | 先写入 staging profile `foundry-sign-in`，再运行 `aws sso login --use-device-code --no-browser --profile foundry-sign-in`；成功后才把设置写入 default | 填门户 URL、账号 ID、角色名（区域可选），点 “Get sign-in code”，打开 AWS 页面，确认显示的码一致后批准；不需要粘贴 |

- Worker（`aws-sign-in.ts`，新）：
  - 校验页面传来的选项：区域、https 门户 URL、12 位账号、角色名格式；拒绝任何可能拼进命令行的内容。
  - 把 CLI 作为子进程放在单独的进程组里运行，保留到成功、失败、取消或 5 分钟到期。
  - 从输出里取 URL 和码；授权码由 `sign_in_input` 写进 CLI 的 stdin；失败时给出 CLI 的一句原因。
  - 控制台登录前，如果 default profile 没有区域，就补上（会话读取 default）。
  - CLI 版本低于 2.32（控制台登录）或 2.22（Identity Center）时，提示先更新 AWS CLI。
- `device-held.ts`：
  - 工具可以以交互方式运行（`run.spawn`），sign-in 开始时带上页面的选项；
  - 新动作 `sign_in_input`；
  - 关闭（dismiss）时结束设备上那个还在等的 CLI。
  - 新能力 `connector_browser_sign_in_v1`。
- Server：
  - 目录给 AWS 加 `browserSignIn: ["console","sso"]`，并做校验。
  - sign-in begin 接受 `signInOptions`（最多 8 项，每项不超过 512 字节），原样转给设备。
  - 新接口 `POST /api/devices/{id}/connectors/{kind}/sign-in/code`：只限设备所有者；只在该操作仍在等待、且设备声明需要授权码时接受。授权码只经过内存，不记录、不入库。
  - dismiss 现在也通知支持浏览器登录的设备。
- Web（`aws-browser-sign-in.tsx`，新；接入设备行的登录步骤）：
  - 默认显示 “Sign in to AWS”：区域，以及 “Open AWS sign-in” 主按钮。
  - 点击时立即打开一个空白窗口（这样不会被弹窗拦截），设备给出链接后跳到 AWS 页面。同时行内显示 “Open AWS sign-in page” 链接（复制按钮、授权码输入框和 “Finish sign-in”），所以弹窗被拦截时也能继续。
  - Identity Center 有单独的小表单，提交后显示码和复制按钮，自动轮询。
  - 失败时显示设备给出的原因和 “Try again”；有 “Cancel”。完成后这一行直接变为 “Signed in as …”。
  - 终端命令收进折叠的 “Use the terminal on … instead”，作为最后手段。
  - 文案中英文都有。旧 Worker 或设备离线时，仍然只显示终端命令。

## 自验

- Worker：
  - `connectors-aws-sign-in.test.mjs`（新，6 项），用假的 `aws` 可执行文件端到端测试：
    - 选项校验；
    - 按 2.39 实际输出解析 URL/码；
    - 控制台登录：显示链接，粘贴正确码后完成，并能读到已登录；
    - 错误码给出 CLI 的原因；取消之后再输入会被拒绝；
    - Identity Center：只写 staging profile，成功后才写 default；
    - 版本过旧时提示更新。
  - `connectors-aws-install.test.mjs` 新增 2 项：下载进度最多每秒一次，步骤顺序正确，Linux 和 macOS 都覆盖；安装请求带上连接器种类转发进度。
  - `connectors-aws.test.mjs` 与 `connectors-device-held.test.mjs` 通过。
- Server：
  - `TestAWSBrowserSignInCarriesChoicesAndTheCode`：选项到达设备；他人、错误操作或空码被拒；授权码去掉首尾空白后到达设备；轮询到完成后读到已登录。
  - `TestInstallProgressIsListedWhileTheInstallRuns`：进度出现在列表里；非法种类被丢弃；安装结束后清除。
  - 原有连接器与链路测试通过；`audit-contract` 通过。
- Web：
  - `device-held-connectors.test.mjs` 17/17，新增 3 项：
    - 进度条一开始就在，报告后显示数值，然后切到 “Running the installer…”；
    - 控制台登录：弹窗跳到 AWS 链接，`opener` 已清空，链接为 noopener；授权码提交后行内变为已登录；终端命令折叠；
    - Identity Center：提交的选项正确，显示码与复制按钮，失败时有原因和 “Try again”。
  - tsc 与 12 项 UI 审计通过。
- 真实浏览器（scratch 栈：本树的 Server 和 Web，空库，开放出口；配对的 Worker 用临时 HOME，`PATH=/usr/bin:/bin`）：
  - 安装进度：键盘回车开始安装，行内依次显示：
    - Starting…；
    - Downloading 22.7 MB of 71.1 MB (31%) · 19.2 MB/s；
    - 36.1 MB (50%)；
    - 63.9 MB (89%)；
    - Running the installer…；
    - Checking the installed copy…
      进度条的 value/max 与字节数一致。17 s 后装好 AWS CLI 2.39.2。
  - 控制台登录：点击 “Open AWS sign-in” 后，弹窗跳到真实的 `us-east-1.signin.aws.amazon.com/v1/authorize`。行内显示链接、复制按钮和授权码输入框，设备上 `aws login --remote` 在等待。
    - Cancel 之后，设备上的 aws 进程已结束（检查了进程表）。
    - 再试一次，粘贴一个假的授权码：行内显示 “Sign-in did not finish: Failed to decode the verification code.”（真实 CLI 的原因），没有遗留进程。
  - Identity Center 失败路径：用键盘填一个不存在的门户。显示 “Sign-in did not finish: An error occurred (InvalidRequestException) when calling the StartDeviceAuthorization operation (reached max retries: 0): Invalid request”，以及 “Try again”。default profile 没有被改动，只有 staging profile 写入了设置。
  - 1280 浅色、390 深色：无横向溢出。期间修了一个问题：390 下表单被 auto-fill 网格撑宽，已用 `minmax(0,1fr)` 约束。
  - 最后一步（在 AWS 页面真实登录并拿到授权码）需要本人，没有做。

## 部署

- Server（2026-10-30 14:57:44 UTC+8，SIGHUP）：从共享树构建。共享树 = HEAD 加上已上线的 DEV-085 第 4 轮、DEV-095、DEV-096，再加本项。sha256 `349362f9910809085de1dbb75b905305a40b6baaabd81c9d9c108435d6052c37`，回滚副本为硬链接 `releases/dev023-candidate/foundry-server.pre-dev099`（上一版 `8f2dfeb9…`）。
  - 新进程接管后 `/healthz` 200，`/proc/<pid>/exe` 与新二进制一致，7 台设备全部重连。
  - 旧进程 15.0 s 后才退出（exit status 1）。01:41 那次交接中旧进程也是这样，那次退出的是 DEV-096 之前的二进制，所以不是本项引起的；原因未查。
- Web（14:59:03，`deploy-web-dev.sh`）：`c0f4ee7e428fee44`，从共享树构建，包含已上线的 DEV-097、DEV-098（聊天卡片）等改动。上一版 `871c74cf41b6aa0e` 保存在 `releases/dev099-web/previous-20261030T065903Z`。
- Worker（14:59:59）：`0.5.7-dev.168.ga0ba354a.local.1793343579`。在 `foundry-dev085b` worktree（a0ba354 + 编排会话的 Mac 签名修正 + DEV-085 supervisor 改动）加入本项的 Worker/协议文件后打包，与共享树的 `packages/worker/src`、`packages/protocol/src`、skills 逐文件一致。该 worktree 中 40 个相关测试通过。
  - 上一版 `release.json` 备份为 `worker-packages/release.before-dev099.json`，旧包保留；`/api/worker/release` 返回新版本。
  - 本项没有更新任何设备；那台 Mac 需在空闲时从“设备”页更新 Worker 后才能使用浏览器登录和下载进度。旧 Worker 上，页面仍显示终端命令和已用时间。

## 本人需要点的（验收步骤）

1. 打开 连接器 → AWS CLI，找到已安装、未登录的设备（例如那台 Mac；它需要先更新到含本项的 Worker）。
2. 行内 “Sign in to AWS”：区域保持 `us-east-1`（或填你的区域），点 “Open AWS sign-in”。
3. 新标签页打开 AWS 登录页，用你的 AWS 控制台账号登录（和平时登录控制台一样），确认后页面会显示一个授权码，点复制。
4. 回到 Foundry 这一行，把授权码粘贴到 “Authorization code from AWS”，点 “Finish sign-in”。几秒后这一行变成 “Signed in as arn:aws:…”。
5. 如果你们用 IAM Identity Center（访问门户）：在第 2 步点 “Use IAM Identity Center instead”，填访问门户 URL、AWS 账号 ID、权限集名称，点 “Get sign-in code”。打开 AWS 页面，确认页面上的码与 Foundry 显示的一致，批准即可，不需要粘贴。
6. 安装进度：在一台没装 AWS CLI 的设备上点 “Install AWS CLI”，行内会显示下载字节、百分比和速度。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 剩余动作                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 2026-10-30 14:10 | 接手（编排会话 sess_1793310871114448129）；本机临时装 AWS CLI 2.39.2，读 `aws login`、`aws sso login` 帮助并实际运行，核对 CLI 源码输出格式                                                                                                                                                                                                                                                                                                                                                                                     | 实现                                                     |
| 2026-10-30 14:40 | Worker、Server、Web 实现与测试；scratch 栈：进度、控制台登录到 URL 和授权码输入、取消结束进程、错误码、SSO 失败路径；发现并修复 SSO 设置先写 default 的问题（改为 staging profile）和 390 宽度溢出                                                                                                                                                                                                                                                                                                                              | 部署                                                     |
| 2026-10-30 15:00 | 部署：Server `349362f9…`、Web `c0f4ee7e428fee44`、Worker `.1793343579` 发布（未更新设备），见“部署”                                                                                                                                                                                                                                                                                                                                                                                                                             | 那台 Mac 空闲时更新 Worker；本人完成真实登录（验收步骤） |
| 2026-10-30 17:33 | 本人反馈“不是说好做成 URL 跳转吗”：截图里该 Mac 当时离线（17:28 服务器 70 s 没收到数据断开），离线设备不报告能力，行内于是退回“在终端登录”。改为：连接器支持浏览器登录时，离线设备仍显示浏览器登录，“Open AWS sign-in”禁用并写“{设备} 当前离线，重新上线后即可在这里登录”，终端命令仍折叠；在线但 Worker 过旧才用终端。新增测试（18/18），check-changed 通过（prettier、tsc、web tests、12 项 UI 审计）。Web `557763179a1e2094` 经部署脚本发布（上一版存于 `releases/dev099b-web/`）；线上 bundle 已含新文案。该 Mac 已重新在线 | 本人刷新页面后点“Open AWS sign-in”                       |
| 2026-10-30 17:44 | 本人问“为啥要选 AWS region，能管全部吗”：区域不是权限范围，登录后可用账号允许的所有区域；它只是命令未指定区域时的默认值（`aws login` 需要一个）。改为默认折叠：行内写“登录后可使用账号允许的所有 AWS 区域；命令没指定区域时默认用 us-east-1”，旁边“修改默认区域”才展开输入框；SSO 的 Identity Center 区域字段不变。测试更新，check-changed 通过；Web `2ecf91c04d8887ee` 发布（上一版存于 `releases/dev099c-web/`）。本轮未做真实浏览器截图                                                                                      | 本人刷新后确认                                           |
