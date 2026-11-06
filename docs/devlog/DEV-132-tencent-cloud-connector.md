# DEV-132 腾讯云 CLI 连接器

状态：代码与自验完成（至厂商登录页为止）；已部署 dev（Server `47f4d6a55b5d31c0`、Web `58e03f726e6b9de8`、Worker `…1793913792`）；真实腾讯云账号登录待本人；未提交。阿里云同批见 [DEV-133](DEV-133-alibaba-cloud-connector.md)。

## 问题与调研

本人要求按现有连接器规则接入腾讯云。依据（tencentcloud-cli 64ac02d，tccli 3.1.196.1 源码，加 scratch HOME 实跑）：

- tccli 只有 Python 包（[安装文档](https://cloud.tencent.com/document/product/440/34011)：pip / 源码 / Homebrew），没有单文件版本；虚拟环境约 670 MB（其中约一半是预编译的 `.pyc`），大部分是官方 SDK。
- 登录：`tccli auth login --browser no`（`tccli/plugins/auth/login.py`）打印 `https://cloud.tencent.com/open/authorize?...`，从 stdin 读页面给出的验证码（base64 JSON），写 `~/.tccli/<profile>.credential`（`type: oauth`，命令前自动续期）；3.0.1190.1 起。CIC：`tccli sso configure --url` + `tccli sso login --uin --rolename`（`plugins/sso/login.py`），打印登录页后自己轮询，`--uin`/`--rolename` 3.0.1341.1 起。OAuth 的 scope 固定为 `login`，权限来自 CAM 策略。
- 状态：`tccli sts GetCallerIdentity` 返回 Arn、AccountId 等非秘密字段；未配置 `secretId is invalid`，profile 不存在 `'_sys_param'`，密钥无效 `AuthFailure.SecretIdNotFound`（实测）。
- 隔离：配置目录固定为 `~/.tccli`，没有改目录的变量；`TCCLI_PROFILE` 指向不存在的 profile 时命令失败（实测），显式 `--profile default` 仍能读到。命令前的续期按 `--profile` 或 `default` 进行（`command.py`），不看 `TCCLI_PROFILE`。

为什么是设备持有型：tccli 没有可指向本机转发器的公开 endpoint 配置，“替身 + 本机转发”不成立（[方案](../research/connector-unification-20261105.md) 4.2）；它自己的 OAuth / CIC 登录是短期凭据加自动续期，留在设备上即可，与 AWS 同形。

## 实现

- 目录 `catalog.json` 的 `tencentcloud`：installer、最低 3.0.1190；登录方式 `oauth`（字段：默认地域）、`sso`（CIC 用户登录 URL、账号 UIN、权限配置名称、默认地域）、`terminal`；`signOut: false`；`isolationEnv.TCCLI_PROFILE=foundry-no-login`。
- Worker `connectors/tencentcloud.ts`：适配器、身份解析、两种登录（共用的 `cli-sign-in.ts` 管理运行中的 CLI）；粘贴的验证码先校验形状，失败只给固定句子，不回传 tccli 输出。`isolationEnvironment()` 另清空 `TENCENTCLOUD_*`、`TKE_*` 凭据变量。
- `connectors/tencentcloud-install.ts`：设备的 `python3`（3.7+，需 venv 模块）在 `~/.local/share/tccli/env-<时间>` 建环境，`pip install --no-compile --upgrade tccli`（设备的 pip 源与代理；不预编译整个 SDK，约 370 MB，pip 校验索引给出的哈希），`tccli --version` 确认后链接到 Foundry 工具目录与（空闲时）`~/.local/bin`，再删除旧环境。超时与 pip 错误映射为固定句子。
- `tool-links.ts`：从 `gh-install.ts` 抽出的链接与“不遮蔽别的副本”判断，gh、aliyun、tccli 共用。
- Web 不需要专用组件：Tab、登录方式与字段都来自目录。终端退出的说明原本写死 AWS 命令，改为通用句子。

## 验证

- Worker 单测 `connectors-tencentcloud.test.mjs` 11 项：目录、身份解析（只留 ARN 与账号，网络错误不带原文）、选项校验、页面解析（取自实跑输出）、假 tccli 下的 OAuth 粘贴完成与正反向会话检查、错误验证码只给固定句子、CIC 完成与错误 UIN、版本过低先拦、隔离变量、pip 错误映射、安装与旧环境清理。
- 真实 tccli（Foundry 安装器装进 scratch HOME，`pip --no-compile`）：装上 3.1.197.1（链接在 Foundry 工具目录与 `~/.local/bin`），状态读为未登录；`sign_in_begin` 得到 `https://cloud.tencent.com/open/authorize?scope=login&app_id=100038427476&…` 与验证码输入框，随后取消。同一 HOME 下：`TCCLI_PROFILE=foundry-no-login` 时 tccli 不读 profile（`'_sys_param'`），不设时读到 default（带假密钥时到达腾讯云返回 `AuthFailure.SecretIdNotFound`）。
- 负载很高（load 30+）时，不带 `--no-compile` 的 pip 在 15 分钟内装不完；改为 `--no-compile` 后 261 秒、372 MB，tccli 正常运行。
- `scripts/check-changed.sh --files`（29 个文件，经 `fdy-heavy`）：prettier、gofmt、protocol build/tests、web tsc、web tests 3 个文件、worker build、worker tests 16 个文件、Go `connectors`+`store`、15 项 UI 审计、契约与模块审计全部 PASS。
- 真实 Chromium（scratch stack `cloudcn`，Worker 以 scratch HOME 运行、装着下面两套真实 CLI；Server `FOUNDRY_INTEGRATIONS=off`）：两个 Tab 出现、设备行显示版本与“未登录”；键盘 Enter 打开登录；方式与字段来自目录，CIC 必填项为空时先在页面拦下；1280×900 亮色英文、390×844 暗色、中文界面各检查一遍。截图：`.foundry/attachments/dev132-133/`（`aliyun-*.png`、`tccli-*.png`）。

未验证：真实账号的登录完成、会话里的调用、到期与续期（没有腾讯云 / 阿里云账号）。

## 部署

2026-11-06（UTC+8），持 `/tmp/fdy-deploy.lock`，分支 rebase 到 `origin/main` `03967692` 后 `check-changed` 全部 PASS；以 diff 应用到 `~/workspace/foundry`（README 一行手工加入）。

- Server：`47f4d6a55b5d31c0`（原 `db5b7786b5baf9ed`，回滚 `releases/dev023-candidate/foundry-server.pre-dev132`），05:11–05:12；部署前在线备份 `backups/foundry-20261106-0511-pre-dev132.db`（integrity ok），数据库无结构变化，`/healthz` ok，7 台设备重新连上。从会话 shell 用 `pm2 restart --update-env` 会把会话变量（`FOUNDRY_SESSION_ID`、`CLAUDE_*` 等）带进 Server 进程；已用 `env -i` 按 ecosystem 重新创建进程，环境只剩 ecosystem 声明的变量。05:25 DEV-136 再次重启 Server（`6e8469a47a31550b`），目录里的 `tencentcloud`、`alibabacloud` 仍在。
- Web：`58e03f726e6b9de8`（原 `35bee92f39807d21`，回滚 `releases/dev132/previous-20261105T211628Z`），入口资源逐字节一致，API 回 JSON；`/api/connectors` 把两者列为内置连接器（#211 选择器的“公开”组）。
- Worker：与 DEV-135、DEV-136 合成一次发布 `0.5.7-dev.302.gc228d855.local.1793913792`（原 `0.5.7-dev.298.g03b62a30`，回滚 `worker-packages-rollback/before-dev132-*`、`release.before-dev132.json`）；打包前在主树构建并跑三方相关的 Worker 测试 78 项通过，包内含 `tencentcloud.js`、`alibabacloud.js`、`scope-history.js`、`external-profile-defaults.js`。经计算租约 `foundry-worker update`：CanWendeMac-mini、macbook（`~/.foundry-stacks/dev/bin`）、byte-dev、byte-dev-sg、cottoncpp、limen-canada、sg-chaos（本机，脱离会话的 systemd 单元）守护进程都报告新版。正在运行回合的旧执行宿主（byte-dev 一个 `…298`，sg-chaos 两个更旧的）未强停，回合结束后换新；之前在这些宿主上的会话里看不到这两个连接器。
- 磁盘：部署后约 7.7 GiB 可用；scratch HOME、scratch stack、Web 构建输出与 worktree 的 dist 已删除。

## 限制

- 显式 `--profile default` 能绕过隔离；与 AWS、bytedcli 相同，只防误用。被隔离的会话运行 tccli 时，tccli 仍会按 `default` 续期设备所有者的 OAuth 凭据（不把凭据交给会话）。
- CIC 登录在 macOS 设备上会顺带用 `webbrowser.open` 打开设备本机浏览器；Linux 无图形界面时无影响。
- 只支持国内站 OAuth（tccli 写死 `site=cn`）。
- 安装需要设备有 Python 3.7+ 与 venv（Debian/Ubuntu 需 `python3-venv`）；约 370 MB。
- 到期时间不显示：tccli 没有不读凭据文件就能拿到到期时间的公开命令；凭据失效时状态读为未登录。

## 人工验收

1. 打开 Connectors → 腾讯云 CLI，在设备行点“安装”。预期：显示进度后状态为“未登录”，版本 3.1.x。
2. 点“登录”→“腾讯云账号登录”，确认默认地域，开始。预期：出现腾讯云授权页链接；在浏览器登录后把页面上的验证码粘贴回来，点完成。预期：状态“已登录”，身份为 `qcs::cam::uin/…`，“会话可以使用”。
3. 在该设备的会话里运行 `tccli sts GetCallerIdentity`。预期：返回同一身份。
4. （有 CIC 时）用“CIC 身份中心”登录，填用户登录 URL、账号 UIN、权限配置名称。预期：链接打开 CIC 登录页，批准后自动完成，身份为该角色。
