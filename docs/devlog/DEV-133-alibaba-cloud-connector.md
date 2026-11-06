# DEV-133 阿里云 CLI 连接器

状态：代码与自验完成（至厂商登录页为止）；已部署 dev（Server `47f4d6a55b5d31c0`、Web `58e03f726e6b9de8`、Worker `…1793913792`）；真实阿里云账号登录待本人；未提交。腾讯云同批见 [DEV-132](DEV-132-tencent-cloud-connector.md)。

## 问题与调研

本人要求按现有连接器规则接入阿里云。依据（aliyun-cli f44a323，aliyun 3.5.3 源码，加 scratch HOME 实跑）：

- aliyun 是单个静态 Go 程序；GitHub release 提供各平台 tgz 与 `SHASUMS256.txt`，阿里云 CDN `aliyuncli.alicdn.com` 提供同名版本文件（无校验文件）。`aliyun version` 输出版本号。
- 登录：[OAuth 凭证文档](https://help.aliyun.com/zh/cli/oauth-credentials)。`aliyun configure --mode OAuth --no-browser`（3.5.2 起，`config/oauth_manual.go`）打印 `https://signin.aliyun.com/oauth2/v1/auth?...`，登录后浏览器跳到打不开的 `http://127.0.0.1:12345/cli/callback?code=…&state=…`，要把整个地址粘贴回去；之后依次问默认地域、语言（站点类型在 profile 尚未设置时最先问，`--oauth-site-type` 此处不生效，实测）。前提：RAM 管理员在“集成管理 › OAuth 应用（公测）› 第三方应用”安装 official-cli 并在“允许访问的身份”添加用户，否则报 “You are not allowed to do this action”。OAuth 不带 scope，权限来自 RAM 策略。
- 云 SSO：`aliyun configure sso login --sso-session S --cloud-sso-sign-in-url URL` 显示 `SignIn url` 与 `User code` 并自行轮询（`cloudsso/login.go`），之后 `aliyun configure set --mode CloudSSO --sso-session S --cloud-sso-account-id --cloud-sso-access-config` 指定账号与访问配置（实测可用）。
- 状态：`aliyun sts GetCallerIdentity`；失败时 stderr 是一个 JSON（`recovery.action`、`error_code`）。未配置 `check_configuration`，密钥无效 `InvalidAccessKeyId.NotFound`，网络 `retry_or_fix_endpoint`（实测）。`aliyun configure get` 不带键名会打印明文密钥，Foundry 不用它。
- 隔离：`ALIBABA_CLOUD_IGNORE_PROFILE=TRUE` 时 aliyun 不读配置文件，`--profile default` 也一样（`config/configuration.go`，实测）。

为什么是设备持有型：没有可指向本机转发器的公开 endpoint 配置；OAuth / 云 SSO 是短期凭据加自动续期（每次续期轮换 refresh token，多处共用一份登录会互相作废），凭据留在设备、由 aliyun 自己续期最合适。

## 实现

- 目录 `catalog.json` 的 `alibabacloud`：installer、最低 3.5.2；登录方式 `oauth`（站点下拉：中国站 / 国际站；默认地域）、`sso`（云 SSO 用户登录地址、账号 UID、访问配置 ID、默认地域）、`terminal`；`signOut: false`；`isolationEnv.ALIBABA_CLOUD_IGNORE_PROFILE=TRUE`。
- Worker `connectors/alibabacloud.ts`：适配器、身份解析（只留校验过的 ARN 与账号）、两种登录。OAuth 按 aliyun 的提示逐行回答（它每次提示新建一个 scanner，提前写入会被吞掉）；粘贴的地址先校验是 `http://127.0.0.1:12345/cli/callback?` 且带 `state` 与 `code`；aliyun 拒绝后会再次等待，Foundry 看到这句就结束这次登录并给出原因。云 SSO 的会话名固定为 `foundry`。`isolationEnvironment()` 另清空 `ALIBABA_CLOUD_*`、`ALIBABACLOUD_*`、`ALICLOUD_*` 凭据变量。
- 登录步骤新增 `codeEntryFormat: "callback_url"`（Worker `SignInStep`、协议 `DeviceConnectorSignIn`、Server `store.DeviceConnectorSignIn`，Server 只接受这个值且须同时有 `codeEntry`）；Web 的粘贴框据此显示“登录后浏览器打开的地址（页面打不开是正常的）”与示例地址，中英文同改。
- `connectors/alibabacloud-install.ts`：版本取 GitHub release 的跳转，`SHASUMS256.txt` 取自 GitHub；压缩包先从 CDN 下载，校验不符或失败再从 GitHub 下载，都按 SHA-256 校验；放到 `~/.local/share/aliyun-cli/<版本>/aliyun`，`aliyun version` 确认后链接，删除旧版本。

## 验证

- Worker 单测 `connectors-alibabacloud.test.mjs` 11 项：目录、身份解析（含 SSO 角色 ARN、未配置 / 密钥无效 / SSO 过期读为未登录，网络错误不带原文）、选项与粘贴地址校验、页面与设备码解析、假 aliyun 下逐行回答提示并完成 OAuth 与正反向会话检查、旧地址与 RAM 拒绝各给原因、云 SSO 完成后 `configure set` 的参数、版本过低先拦、隔离变量、安装器（CDN 优先、CDN 文件不符或不可达时改用 GitHub、校验不符拒绝、旧版本清理）。Web `device-held-connectors.test.mjs` 新增一项：站点下拉与默认地域、`codeEntryFormat` 时的地址输入框与提交。
- 真实 aliyun 3.5.3（Foundry 安装器装进 scratch HOME，98 秒）：状态未登录；`sign_in_begin` 得到 `https://signin.aliyun.com/oauth2/v1/auth?client_id=4038181954557748008&…` 与地址输入框；粘贴一个 state 不对的回调地址后，真实 aliyun 回 “invalid state”，Foundry 结束这次登录并显示“paste the address from this sign-in, not an earlier one”（页面上也走了一遍）。
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

- 两种登录都把设备的 `default` profile 设为当前 profile（aliyun 自己的行为）；设备所有者原来用别的 profile 作当前时会被切换。
- 云 SSO 登录会尝试用 `xdg-open` / `open` 打开设备本机浏览器（aliyun 自己的行为），Linux 无图形界面时无影响。
- profile 已设为另一站点时，OAuth 不再问站点；Foundry 发现与所选站点不符就停止并说明。
- 只用 aliyun 前缀的凭据变量做隔离；会话自己环境里的通用 `ACCESS_KEY_ID` 不是设备登录，不清空。
- 不显示到期时间；凭据失效时读为未登录。

## 人工验收

1. 打开 Connectors → 阿里云 CLI，在设备行点“安装”。预期：下载进度后状态“未登录”，版本 3.5.x。
2. 确认 RAM 控制台已安装 official-cli 并允许你的身份。点“登录”→“阿里云账号登录”，选站点和默认地域，开始。预期：出现阿里云登录链接和“登录后浏览器打开的地址”输入框；登录后复制地址栏里 `http://127.0.0.1:12345/cli/callback?...` 的完整地址，粘贴并完成。预期：状态“已登录”，身份 `acs:ram::…`，“会话可以使用”。
3. 在该设备的会话里运行 `aliyun sts GetCallerIdentity`。预期：同一身份。
4. （有云 SSO 时）用“云 SSO”登录，填登录地址、账号 UID、访问配置 ID。预期：显示登录码，批准后完成，身份为 `assumed-role/…`。

- 2026-11-06 16:45 UTC+8（编排接手）：sg-chaos 上用设备已安装的 Worker `…303` 自带的 `parseAliyunIdentity`，读真实 `aliyun sts GetCallerIdentity`（与适配器同参数）的输出：全新 HOME（首次运行）和真实 HOME 都得到 `{"signedIn":false}`，不再报错。Connectors 里存着的读数仍是 02:58 UTC 旧 Worker 留下的“identity check failed”，要等所有者在 Connectors › 阿里云 › sg-chaos 按「再次检查」才会刷新（该接口仅限设备所有者）。

- 2026-11-06 18:05 UTC+8（编排）：合并前发现 `apps/server/internal/httpapi/connectors_test.go` 的两个用例（`TestDeviceHeldConnectorThroughTheDevice`、#211 加的 `TestConnectorsPageDoesNotWaitForAStalledDevice`）仍按 aws/github/corpcli 三种连接器断言，加上腾讯云、阿里云后失败（本分支基于 #211 之前的 main，`check-changed` 没覆盖到）。测试里的假 Worker 现在对四种内置设备连接器都回答 status；断言改为 5 种；“别人的会话用不到 alice 的登录”一项也逐个检查 `tencentcloud`（`TCCLI_PROFILE`）和 `alibabacloud`（`ALIBABA_CLOUD_IGNORE_PROFILE`）。`go test ./internal/httpapi -run Connector|DeviceHeld`、`./internal/connectors` 通过。分支未提交的改动同时移到当前 main（`1837af21`）上，3-way 无冲突。
