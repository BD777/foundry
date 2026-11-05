# DEV-136 连接器权限集：授权时可选、可更新、读回实际授予

状态：已部署 dev（Server `6e8469a47a31550b`、Web `bfc8f1d78dcf9db6`、Worker `0.5.7-dev.302.gc228d855.local.1793913792`），Agent 自验完成；未提交（编排会话负责）；待人工验收。

| 环节                | 状态   | 说明                                                                            |
| ------------------- | ------ | ------------------------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | 见“审计”“来源”                                                                  |
| 代码                | 已完成 | 见“改动”                                                                        |
| dev Server/Web 部署 | 未开始 | 部署前通知编排会话 `sess_1793894414908201185`                                   |
| Worker 更新         | 未开始 | GitHub 适配器、会话 gh、scope 历史在 Worker 里                                  |
| Agent 自验          | 已完成 | 单测、check-changed、scratch 栈真实 Chromium 24 项、隔离 HOME 真实 gh，见“验证” |
| 人工验收            | 待确认 | 见“验收步骤”                                                                    |

## 问题

2026-11-06 本人：Connector 里授权是“盲盒”，有 scope 的连接器没得选。要么完全可选，有推荐值、全选，还有手动；举一反三查其他连接器；涉及权限集的，授权时可选，也能更新。

同晚的实例（编排会话）：会话要推 `.github/workflows` 改动，需要 `workflow` scope；Connectors 只提供 Packages 三项，没有入口，于是 Agent 在会话里自己跑了 `gh auth refresh -s workflow`，绕过了 Connectors。本人问：这是隔离不够，还是一种正式的授权方式？

## 审计（2026-11-06）

| 连接器                           | 持有方       | 有权限集吗                                  | 之前怎么选                                                       | 能更新吗                                      | 读回实际授予                                          |
| -------------------------------- | ------------ | ------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| GitHub CLI（gh）                 | 设备         | 有：OAuth scope                             | 登录用 gh 默认（repo、read:org、gist）；只有 Packages 三项可追加 | 只能追加 Packages；其余要在会话里手动 refresh | `gh auth status` 的 Token scopes（白名单仅 Packages） |
| 飞书（用户 OAuth）               | Server       | 有：user scope                              | feishu-cli 推荐预设；“高级”里勾审批项或手填一串                  | 重新授权时同上，看不到当前已授予              | token 的 scope（`grantedScopes`），缺项提示           |
| 飞书（应用权限）                 | 飞书开放平台 | 有，但由应用配置决定                        | 无（只能去开放平台开通）                                         | 在开放平台                                    | 未读                                                  |
| Cloudflare（OAuth）              | Server       | 有：OAuth scope                             | 固定 6 项只读预设，不可选                                        | 不可（DNS 写入要“重新授权”且仍是同一预设）    | token 的 scope（卡片里分组显示）                      |
| AWS CLI                          | 设备         | 无：IAM 策略 / Identity Center 权限集       | 不适用                                                           | 在 AWS 控制台                                 | 只有身份（sts get-caller-identity）                   |
| Limen（扩展）                    | 设备         | 无（邀请码加入网关）                        | 不适用                                                           | 不适用                                        | 不适用                                                |
| bytedcli（扩展）                 | 设备         | 无（SSO；Meego 网页会话是凭据，不是 scope） | 不适用                                                           | 不适用                                        | 不适用                                                |
| 腾讯云 tccli（DEV-132，进行中）  | 设备         | 无：CAM 策略；登录 URL 固定 `scope=login`   | 不适用                                                           | 在 CAM 控制台                                 | 只有身份（sts GetCallerIdentity）                     |
| 阿里云 aliyun（DEV-133，进行中） | 设备         | 无：RAM 策略；OAuth 登录无 scope 参数       | 不适用                                                           | 在 RAM / CloudSSO 控制台                      | 只有身份                                              |

腾讯云 / 阿里云的结论来自 `sess_1793896656923516691` 对 CLI 源码与隔离 HOME 中实装 CLI 的核对（tccli `plugins/auth/login.py`，aliyun `config/oauth_manual.go`），双方约定它们使用本项的 `permissions` 字段，不做假选择器。

## 方案

一个模型，所有连接器共用：

- **有权限集**：授权组列出 scope（`id`、文案、`recommended`、`required`、`impliedBy`），加 `scopeSource {label,url,complete}`；共享选择器 `PermissionPicker` 提供「推荐 / 全部 / 自定义」与“粘贴清单”（手动），显示将申请的完整清单（含 `offline_access` 等总会申请的项）、相对当前授予的“新增 / 移除”，以及“授权只追加 / 取消勾选会移除 / 新授权替换旧授权”中实际适用的一种。**“全部”只在来源是权威完整清单时出现**，否则不显示，并写明来源不完整。
- **无权限集**（权限在 IAM/CAM/RAM 策略或应用配置）：描述符的 `permissions {managedBy:"vendor_policy", description, url}`，页面写明权限从哪里来、给控制台链接，不放选择器。
- **读回**：设备持有型由适配器用工具自己的命令读（GitHub：`gh auth status`），Server 持有型用 token 的 scope；Worker 记录每次读到的集合，变化时上报 `lastChange {source: foundry|outside, at, added, removed}`，页面显示“{{时间}}在 Foundry 之外发生变更：+workflow”。

### 各连接器

- **GitHub**：新授权组 `permissions`，列出 GitHub 文档中 github.com 的全部 34 个 OAuth scope（不含仅 GHES/GHEC 的 `site_admin`、企业 scope）；必选为 gh 自己的最小集 `repo`、`read:org`、`gist`；推荐再加 `workflow`、`read:packages`。授权走 gh 原生命令：已登录时 `gh auth refresh --hostname github.com --scopes <新增> --remove-scopes <移除>`，登录时 `gh auth login … --scopes <额外>`；可移除（`scopesRemovable`）。完成后读回核对，GitHub 没给全就报失败，不冒称成功。原 `packages-read` 组保留为“读取 GitHub Packages”能力（GHCR 依赖它），不再自带 scope 列表。**不提供 `offline_access`**：gh 的 OAuth 应用发不过期 token，gh 也从不刷新，要了它反而 8 小时后掉线。
- **Cloudflare**：选择器列表来自授权服务器自己的 OAuth 元数据 `scopes_supported`（RFC 8414，`https://mcp.cloudflare.com/.well-known/oauth-authorization-server`，2026-11-06 为 403 项），Server 缓存 1 小时；推荐即原只读预设；`offline_access`、`user:read`、`account:read` 总会申请。新授权替换旧授权（`replaces`）。Server 拒绝列表外的 scope（400），不再注册客户端。
- **飞书（用户 OAuth）**：通过某个应用登录时，列表是**这个应用自己的 scope**，用应用 tenant token 调「查询租户授权状态」`GET /open-apis/application/v6/scopes`（无需权限）读取，对这个应用是完整清单；应用尚未开通（`grant_status≠1`）或不在列表的预设项标“此应用尚未开通”且不可选。还没有应用时（扫码创建新应用）只能用 feishu-cli 预设，标为不完整，没有“全部”。`offline_access`、`auth:user.id:read` 总会申请（原有规则不变）。新授权不保证撤销旧 scope，按“只追加”显示。
- **飞书（应用权限）、AWS、腾讯云、阿里云**：`permissions` 说明；AWS 已加到 catalog（IAM 控制台链接）。腾讯云 / 阿里云待两个分支都合入后补上（链接已由 DEV-132/133 会话提供）。
- **Limen、bytedcli**：没有权限集，不变。

### 会话里不能改设备登录（编排会话追加的三问）

1. 选择器包含 `workflow`：是（见 GitHub 一节）。
2. 会话不应改设备的 GitHub 登录。实现：会话 PATH 上的 `gh` 改为 Foundry 的守卫脚本，执行设备上的真 gh，只拒绝 `gh auth login|logout|refresh|switch|setup-git`（退出码 4，提示到 Connectors → GitHub CLI → 该设备 → GitHub 权限添加）；`auth status`、`auth token`、git 凭据助手等照常。这是防误用，不是隔离墙：本人自己的会话仍能直接调真 gh 或改 `hosts.yml`（connector-unification §4.2 的“只选 profile”档）。没有做只读的 `GH_CONFIG_DIR` 视图：它会同时挡住 gh 自己对 token、keyring 和 `state.yml` 的正常写入。foundry skill 两份同步更新。
3. Foundry 之外的变更：见上“读回”。基线是本版本之后的第一次读取，今晚手动加的 `workflow` 不会被追溯标为“外部变更”，只作为当前已授予显示。

### “请求更多 scope”的入口（编排会话追加，复用现有能力）

已有可复用的路径：DEV-125「等你处理」的 `needs_hands` 规则从工具输出识别只有本人能处理的错误。新增规则 `github_scope`，匹配会话守卫的拒绝、gh 的 `missing required scopes [x]` 与 git 的 ``without `workflow` scope``。待处理列表视图带上会话的 `deviceId`（读时从会话取，不改表），卡片对该规则显示主按钮「在 Connectors 中添加 workflow」，打开 `/connectors/github?device=<id>&grant=workflow`；设备行挂载时读一次参数（随即从 URL 去掉），打开该设备的 GitHub 权限选择器并预选这些 scope，仍需本人确认。没有新增 MCP 工具。路由形状已与 DEV-140（`sess_1793898577031585451`，改 Connectors 选择器）确认不冲突：只用查询参数，不改 `lib/routes.ts`。

## 来源（“全部”的依据）

| 连接器     | “全部”是什么                             | 来源（类型）                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub     | github.com 的全部 OAuth scope（34 项）   | 官方文档 https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps ，源文件 github/docs `content/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps.md` 的 fpt 条目（权威）。代码注释与测试固定这份清单 |
| Cloudflare | 授权服务器支持的全部 scope（运行时读取） | OAuth 授权服务器元数据 `scopes_supported`（RFC 8414 列表接口，权威）                                                                                                                                                                      |
| 飞书       | 这个应用拥有的全部 scope（运行时读取）   | 「查询租户授权状态」https://open.feishu.cn/document/server-docs/application-v6/scope/list （列表接口，对该应用权威）；无应用时为 feishu-cli v1.41.0 推荐预设，**不是**全集，不提供“全部”                                                  |

## 改动（文件）

- 契约：`contracts/models/connectors.yaml`（`scopeSource`、`scopesRemovable`、`impliedBy`、`ConnectorScopeSource`、`ConnectorPermissions`、`ConnectorScopeChange`、`lastChange`、登录方式的 `scopesGroup`、描述符的 `permissions`），生成 `store/connectors_gen.go`、`contract-schema.json` ×2、`protocol/src/contract.gen.ts`；`protocol/src/connectors.ts`、`external-accounts.ts`（`ExternalScopeCatalog`）。
- Server：`connectors/catalog.json`（GitHub `permissions` 组、`device` 登录的 `scopesGroup`、AWS `permissions`）、`catalog.go` + `descriptor_checks.go`（scope 名、来源 https、`impliedBy` 只指向列出的 scope、`scopesGroup` 只引用有 scope 的组、`permissions` 校验）、`deviceheld.go`（`lastChange` 清洗）；`externalaccounts/scope_catalog.go`（新：`ScopeCataloger`、Cloudflare 元数据、飞书应用 scope、选择校验）、`authorization_code.go`（`BeginAuthorizationCodeWithScopes`；不同选择不复用待处理授权）、`cloudflare.go`、`store/external_accounts.go`；`httpapi`：`GET /api/connectors/cloudflare/scopes`、`GET /api/external-apps/{id}/scopes`、Cloudflare 登录接收 `scopes`、`ErrScopesUnsupported`→400、`pending_items.go`（`github_scope` 规则、视图 `deviceId`）。
- Worker：`connectors/github.ts`（scope 解析、隐含关系、`scopeChange`、refresh 增删、登录带 scope、会话 gh 守卫）、`device-held.ts`（把 catalog 组传给适配器、校验登录所选 scope、记录 scope 历史）、`scope-history.ts`（新）。
- Web：`authorization-scope-picker.tsx`（共享 `PermissionPicker`、`ScopeChangeNote`）、`permission-selection.ts`（新，纯函数）、`connector-permissions-note.tsx`（新）、`device-authorization-groups.tsx`、`device-sign-in-dialog.tsx`、`device-held-connector.tsx`（一行）、`cloudflare-connector.tsx`、`cloudflare-scopes.ts`、`sign-in.tsx`（飞书 `useScopeOptions` 改用共享选择器）、`connect-dialog.tsx`、`authorize-dialog.tsx`、`api/connectors.ts`、`api/pending.ts`、`features/pending/*`、`lib/in-app-navigation.ts`、中英文 `externalAccounts`、`pending`。
- foundry skill：`packages/worker/skills/foundry/references/device-and-accounts.md` = `apps/server/internal/builtinskills/…`。
- 测试：`packages/worker/test/connectors-github.test.mjs`（+6）、`connectors-session-environment.test.mjs`（会话 gh 为守卫）、`apps/web/test/permission-selection.test.mjs`（新）、`externalaccounts/cloudflare_test.go`、`service_test.go`、`externalaccountstest/fakefeishu.go`（应用 scope 端点）、`httpapi/pending_items_test.go`。

## 验证

- `scripts/check-changed.sh --files <55 个文件>`（2026-11-06，基于 03967692）：prettier、gofmt、protocol build/tests、web tsc、web tests 9 个文件、worker build、worker tests 14 个文件、`go test` connectors/externalaccounts/httpapi/store、audit:ui（15 项）、audit:contract、audit:openapi、audit:modules 全部 PASS。之后只把选择器列表高度从 `max-h-80` 调到 `max-h-56`，`device-held-connectors` 22/22 复跑通过。
- 单项：Worker `connectors-github` 17（会话 gh 守卫由真实 `/bin/sh` 执行：`auth status`、`pr list` 透传；五个登录变更子命令退出码 4、不执行真 gh）；Go Cloudflare 元数据清单/推荐/缓存/拒绝列表外 scope 且不注册客户端/授权链接 `scope` 恰为所选；飞书应用清单与未开通项；`pending_items_test` 的 `github_scope` 三种输出；Web `permission-selection` 6、`pending-items` 14、`external-accounts` 18、`device-held-connectors` 22。
- 先前 `external-accounts.test.mjs` 会卡住：旧测试断言已删除的“Permissions”输入框，失败后对话框留在页面、扫码轮询计时器不停，后续测试拿到旧对话框连锁失败且进程不退出。测试文件加 `afterEach` 卸载残留并清空页面，单个失败不再拖住整个文件。
- 真实 gh 2.67.0、独立临时 HOME：`gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key --scopes workflow,read:packages` 到达 GitHub 设备码页面（未输入验证码）；未登录时 `gh auth refresh --scopes … --remove-scopes …` 报未登录，参数被接受。
- scratch 栈（线上 DB 副本，`FOUNDRY_INTEGRATIONS=off`、出网走死代理）真实 Chromium，24/24：只在浏览器内为合成设备 `dev_dev136_synthetic` 应答设备列表、其 sign-in POST、一条合成待处理项与 Cloudflare scope 清单，不接触真实设备、GitHub 或 Cloudflare。覆盖：GitHub 行“9 of 34 listed scopes granted”和“Changed outside Foundry … +delete_repo”；选择器从已授予开始、有“全部”及 GitHub 文档来源、`repo` 必选、`repo:status` 已包含；新增 workflow + 移除 delete_repo 的计划与说明；键盘 Enter 提交，sign-in 请求为 `repo,workflow,read:org,gist`，出现验证码；推荐 5 项、全部 16 项（顶层）、筛选 GPG 3 项、粘贴清单忽略 `site_admin`；待处理项主按钮「Add workflow in Connectors」打开 GitHub 页并预选 workflow、URL 参数随即清除；AWS 说明与 IAM 链接；中文文案；Cloudflare 先出选择器（推荐 = 原只读 6 项）、替换说明、提交体为所选 scope。截图（1280×900 light、390×844 dark、中文）：`.foundry/attachments/dev136/`。scratch 栈已 down。

## 部署

- 2026-11-06 05:25 UTC+8：编排会话批准后，分支 rebase 到 `origin/main` c228d855，在 `/tmp/fdy-deploy.lock` 下把 `git diff origin/main --binary`（含新文件）逐块 `--check` 后应用到 `~/workspace/foundry`（其中已有 #211/DEV-140 等其他会话的改动）。唯一不能直接应用的是 `device-held-connector.tsx`：DEV-140 改了其下方的“重新检查”按钮，本项只有一行 import 与一行 `<ConnectorPermissionsNote>`，手工放入。合并树上 DEV-139 已把 `LoadingState` 换成 `Skeleton`，本项新增的 Cloudflare 清单加载随之改用 `Skeleton`（分支同步修改）。
- 合并树：protocol build、`go build`、web `tsc` 通过；`device-held-connectors` 25（含 DEV-140 新增）、`external-accounts` 18、`pending-items` 14、`permission-selection` 6 通过。
- DB 先用 Python `sqlite3` backup 备份到 `~/.foundry/server/backups/foundry-20261106-pre-dev136.db`（922 MB）；原二进制保留为 `releases/dev023-candidate/foundry-server.pre-dev136`；`pm2 restart foundry-server`（不带 `--update-env`），`/healthz` ok，7 台设备全部重新在线。Server `6e8469a47a31550b`。
- Web：`vite build`（fdy-heavy）后 `scripts/deploy-web-dev.sh`，`bfc8f1d78dcf9db6`（前一版 `6e73cf416cc0a0ee` 保存在 `~/.foundry/web-releases/dev136/previous-20261105T212703Z`），入口资源一致、API 同源 JSON。真实 Chromium 以 e2e-alice 打开 dev 的 Connectors → AWS CLI，显示 IAM 权限说明与“前往管理”链接（中文）。
- Worker（部署时）：未自行打包。`github.ts`、`device-held.ts`、`scope-history.ts`、foundry skill 与两个测试文件已在主树，交给 `sess_1793896656923516691` 与 DEV-132/133、DEV-135 一次打包、更新 7 台设备；更新前设备仍是旧适配器（GitHub 权限行要等新 Worker 上报后出现，会话 gh 守卫随新会话环境生效）。
- Worker `0.5.7-dev.302.gc228d855.local.1793913792` 由 `sess_1793896656923516691` 统一打包（含 DEV-132/133、DEV-135），7 台设备上报新版；byte-dev 1 个、sg-chaos 2 个仍在跑回合的旧执行宿主未打断。sg-chaos 上用已安装的新版适配器对真实 gh 只读复查（只跑 `gh auth status`，未改授权）：`permissions` ready，授予 `repo` 及其 5 个子项、`workflow`、`read:packages`、`read:org`、`gist`、`delete_repo`；`packages-read` ready；`ghcr-docker` ready。会话 gh 守卫用已安装新版在临时状态根生成：`gh auth status` 透传为 BD777，`gh auth refresh -s workflow` 被拒（退出码 4，提示去 Connectors）。已有会话的 bin 仍链接真 gh（由旧版准备），新会话或下一次会话准备时换成守卫。
- 磁盘：备份后约 6.6 GiB 空闲（94%），低于 10 GiB 提示线；未删除任何他人备份。
- 腾讯云 / 阿里云的 `permissions` 字段待 DEV-132/133 合入后再加。

## 尚未做 / 限制

- 飞书选择器未在浏览器中逐项点验（单测覆盖）；scratch 栈没有可用的飞书应用 secret 读取（集成关闭）。
- 没有替本人改任何真实授权；真实 GitHub 增删 scope、Cloudflare/飞书按选择重新授权都需要本人在页面确认。
- 飞书应用 scope 读取需要应用 secret 可用；读取失败时退回预设并提示。
- 会话 gh 守卫只防误用。

## 验收步骤

1. Connectors → GitHub CLI → sg-chaos →「GitHub 权限」行显示“已授予清单中 N/34 项”，点「更改权限」。预期：默认停在“自定义”且勾选当前已授予（含 `workflow`）；`repo`、`read:org`、`gist` 不可取消；`repo:status` 等随 `repo` 显示“已包含在 repo 中”；有“全部”，下方写明来源为 GitHub 文档并有链接；底部列出将申请的清单和“新增/移除”。
2. 取消勾选 `delete_repo`，确认。预期：GitHub 设备码；完成后该行不再含 `delete_repo`，显示“{{时间}}在 Foundry 中变更：−delete_repo”。
3. 在会话里运行 `gh auth refresh -s workflow`。预期：被拒绝并提示去 Connectors；「等你处理」出现一项，按钮「在 Connectors 中添加 workflow」打开第 1 步的选择器且已预选。
4. Connectors → Cloudflare →「连接」或身份的「重新授权」。预期：先出现选择器（推荐即原只读集，有“全部”，来源为 Cloudflare OAuth 元数据），选择后才出现 Cloudflare 授权链接，Cloudflare 页面列出的权限与所选一致。
5. Connectors → 飞书 → 某应用「授权另一个账号」或身份「重新授权」→ 展开权限摘要。预期：列表为该应用自己的 scope，有“全部”；未开通的项不可选。
6. Connectors → AWS CLI。预期：说明权限来自 IAM 策略 / Identity Center 权限集，并有 IAM 控制台链接，没有选择器。

## 时间线

- 2026-11-06 02:00 前后：审计、契约与三类连接器实现、单测；与 DEV-132/133（腾讯云/阿里云）、DEV-140（Connectors 选择器）对齐字段与路由；编排会话批准“会话不改设备登录”的设计与复用「等你处理」的入口。
- 2026-11-06 04:00：修复 `external-accounts.test.mjs` 卡住（见“验证”）；契约、tsc、hint 审计修正；rebase 到 #209（DEV-138 待处理改版），GitHub scope 动作改为新卡片的主操作（`pendingPrimary` = `grant`）。
- 2026-11-06 05:30：check-changed 全部通过；scratch 栈真实浏览器 24/24，选择器列表调矮使摘要与提交按钮在 1280×900 一屏可见。
