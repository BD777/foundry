# DEV-154 连接器的 CLI 与 Skill 版本一致：按设备选版本、会话钉住 CLI、先金丝雀的绑定更新

## 问题

本人 2026-11-09（经编排会话 `sess_1794143153454726480`）：“我们管一下 connector 及对应的 skill 版本不一致的问题。connector 往往伴随 cli 和 skill，我希望能动态更新，且绑定更新（你也可以设计为手动升级，但二者需要一致）。”起因：sg-chaos 的 feishu-cli 是 v1.41.0（只在设备所有者点“安装”时才装），Skill 库每天跟随已到 v1.44.0，会话拿到的 `SKILL.md` 写着 `Requires feishu-cli v1.44.0+`，执行 `doc media-preview` 得到 “unknown subcommand”。飞书服务端的行为不在范围内。

## 调查

- 同一个 bundle（github.com/riba2534/feishu-cli）同时给 Skill 和 CLI：Server 每 24 小时跟随最新 release，自动生成 Skill revision（`skill_bundles.go`、`skill_repositories.go`），工具版本 = tag；CLI 只有设备所有者点“安装”才逐台变化（`skill_tools.go` → Worker `managed-tools.ts`）。
- 没有任何地方把两者对照：`skillarchive` 不读 `compatibility`；Worker 的 `verifiedFeishuCliVersions` 只写日志；v1.41.0 写死在 scope 预设与 `docs/connectors.md`。
- 会话 PATH 指向会移动的 `~/.foundry-tools/bin`，升级会改变正在运行的会话里的 CLI。

## 设计

本人批准的方案写在 [docs/skills.md › Bundle 版本](../skills.md)：CLI、Skill 和 Foundry 这一侧的连接器（网关兼容、scope 集）是一个版本；每台设备按它实际装的 CLI 取对应的 Skill；会话启动时钉住 CLI；默认自动、可切手动，两者都走“先金丝雀、检查、失败整体回滚”；通用，不为飞书开特例。

## 实现

- **按设备选版本**（`httpapi/bundle_versions.go`）：`bundleVersionForDevice` 取工具版本与设备上 Foundry 所装版本相同的最新记录（早期没记工具的记录，单工具 bundle 按 tag 匹配：GitHub release、npm、PyPI 都适用）；会话派发（`session_dispatch.go`）与预热（`skill_preparation.go`）用它替换 bundle 成员的 revision，并下发 `toolPins`。Workspace 对单个 Skill 的版本固定仍优先。
- **会话钉住 CLI**（Worker `skills/session-tools.ts`、`session-ambient.ts`、`session-run.ts`）：每个会话一个 `session-tools/<会话>/`，被钉住的工具链接到版本目录，其余 Foundry 工具链接到会话开始时的当前版本；PATH 用它代替 `~/.foundry-tools/bin`。
- **暂存 / 激活 / 删除 / 检查**（`managed-tools.ts`、`skills/tool-check.ts`、`daemon/handlers/skills.ts`，能力 `bundle_rollout_v1`）：`install_tool` 增加 `activate:false`（装进版本目录、不切换）、`activate`（原子改 bin 链接）、`remove`（只删非当前版本）；`check_tool` 运行暂存版本自己的 `--version`，再在连接器给会话的同一种环境里运行目录声明的命令。
- **rollout**（`httpapi/skill_rollouts.go`）：金丝雀（在线、Worker 支持、优先有可用账号的设备）→ 暂存 → 检查 → 激活 → 其余设备逐台；离线的等待、重连继续，下一个版本接管；检查失败删除暂存、库回滚到设备原来的版本并暂停；安装失败隔 15 s、45 s 重试，仍失败只记失败、不回滚不暂停；自动开始从不替换同版本的 rollout；`auto` 的 bundle 若最新版本从未 rollout（库比设备先跟上，即起因中的状态），Server 启动、设备连上或切到 `auto` 时补做。`POST /api/skill-repositories/{id}/update`（`failCheck` 演练）与 `PUT …/update-policy`，均 Admin。
- **检查授权**（`gateway/checks.go`、`pipeline.go`）：`chk_` 前缀、只对这台设备、这位设备所有者本人的这个账号、5 分钟、检查结束即删；网关对它按“本人账号、本人设备、账号可用”判断，不涉及 Workspace。飞书的声明（`connectors/catalog.json`）：`auth status`、`auth refresh`、经网关的 `authen/v1/user_info`。
- **Scope 集跟着版本**（`externalaccounts/feishu_scopes.go`、`feishu_cli_scopes.json`、`scripts/feishu-cli-scopes.sh`）：预设按 Foundry 实际运行的 feishu-cli 版本取；新版本多出的 scope 对每个账号在“等你处理”里出现一条，打开 Connectors 重新授权（DEV-136 的选择器）；没有设备从 Foundry 运行 feishu-cli 时不提示。
- **检查只留一行结果**（`httpapi/check_steps.go`、Worker `tool-check.ts`、`connectors/catalog.json` 的 `result` / `show`）：通过的步骤不保存也不显示输出（账号检查会打出姓名、open_id、union_id、tenant_key、token profile、scope 清单），只留种类与一个值（`--version` 的版本；`user_info` 的 `data.name`）；失败步骤的输出对身份类字段打码，只放在折叠的“详情”里。旧记录在服务时同样清理，不改库。
- **页面**（本人 2026-11-09 看了 dev 的卡片：“这个展示有点过于凌乱了……把它优化一番”，编排会话给了要求）：每个 bundle 一个面板，头一行是名称 · 版本 · 一个状态（已是最新 / 更新中 2/4 / 检查失败 / 已暂停 / 有更新 / 更新失败）· “…”，下一行来源与检查时间，描述最多两行；检查失败是一行“未能检查更新：<原因> · 再检查一次”，原始输出折叠在等宽、限高可滚动的“详情”里；一行事实：Skill 数（展开名单）、已装 N/M 台 + 管理、更新方式（自动 / 手动）、“我的工作区默认使用”开关（新增 shadcn Switch，基于 `@radix-ui/react-switch`），下面一句短提示；rollout 只在进行中或刚结束时显示：一行进度 + 细进度条 + 时间，每台设备一行（金丝雀标记、状态、`v1.41.0 → v1.44.0` 或“仍是 v1.41.0”），金丝雀的检查折叠为“4 项检查通过”，展开是逐条一行结果；“已更新到 … · 改动 N 个”并入版本历史。Connectors 飞书页列出每台设备的 feishu-cli 与它对应的 Skill；“等你处理”新增 `bundle_update`（“更新已回滚 / 更新未能安装”，打开 Skill 库）与“重新授权：feishu-cli vX 需要新增 N 项权限”。非 Admin 列出仓库时只看到自己设备的状态。

## 合入

2026-11-09 23:34 CST 经 PR #237 squash 合入 main（`37e194d5`），CI 四项通过（go、packages、web、verify）；排在 DEV-153（#234）、DEV-152（#235）、check-changed（#236）之后。待本人验收。

## 部署 / 版本

2026-11-09 在 `/tmp/fdy-deploy.lock` 下把本分支（基于 `origin/main` `85173f04`）的改动合入 dev 主仓库：与 DEV-152 未提交的改动在 `store/pending_items.go`、`api/pending.ts`、`pending-item-card.tsx`、两份 `pending.ts` 文案、`pending-items.test.mjs` 上 3-way 合并（都是并列新增），其余文件只有本项改动；合入前主仓库原文件存于 `~/.foundry/server/releases/dev154/main-before/`，分支 diff 与新文件存于同目录。

- DB：表 `skill_repositories` 新增两列 `update_policy`、`rollout_json`；重启前在线备份 `backups/foundry-20261109-1537-pre-dev154.db`（`VACUUM INTO`，integrity ok；删去最旧的 `…1620-pre-dev148b.db`，保留 3 份）。
- Server：最终 binary sha256 `5ad31ba67fa94888…`（`startedAt 2026-11-09T10:33:06Z`）；旧 binary `releases/dev023-candidate/foundry-server.pre-dev154`。
- Web：最终 `60c32b7cb3ca16ca`；入口历史在 `releases/dev154/previous-*`。
- Worker：最终 `0.5.7-dev.325.g85173f04.local.1794217605`（第一次部署为 `…1794210111`；上一版 `release.json` 在 `worker-packages-rollback/before-dev154/` 与 `before-dev154b/`）。每次打包前核对：线上包与主仓库构建的 dist 只在本项文件上不同。byte-dev、byte-dev-sg、cottoncpp、limen-canada、sg-chaos 经 compute 租约以 `systemd-run --user` 更新；macbook 用 `~/.foundry-stacks/dev/bin/foundry-worker update`；CanWendeMac-mini 第一次前台运行被自身重启打断，之后用 `nohup`。7 台都报告新版本并声明 `bundle_rollout_v1`。
- 依赖：`apps/web` 新增 `@radix-ui/react-switch`（lockfile 只增加该包及其 Radix 依赖）；主仓库已 `pnpm install --frozen-lockfile`。

## 检查

- Go：`bundle_rollout_test.go`——按设备选版本（当前 / 落后 / 按 tag / 不在记录中，npm 同样）；一条经真实 WebSocket 假 Worker 的完整流程：手动“有更新”不自动安装、切到自动补做（一次下载失败后重试成功）→ 暂存 → 检查 → 激活，会话的 Skill 与 CLI 钉住随设备变化；重连与过期读取不重复开始；自动检查失败 → 删除暂存、库回滚并暂停、在“等你处理”告诉跟随者；恢复后安装持续失败 → 记失败、不回滚不暂停；`failCheck` 演练；离线设备由下一版本接管；成员只看到自己的设备。`TestPendingItemAsksForTheScopesANewFeishuCLINeeds`；`gateway` 的检查授权测试；`externalaccounts` 的版本预设与新增 scope；`wire_drift` 与协议字段对照。
- 合同：feishu-cli v1.44.0（release 资产，校验和一致）跑 `TestFeishuCLIContractThroughTheGateway` 通过；`scripts/feishu-cli-scopes.sh v1.44.0` 与入库的集合完全一致（推荐 173 项），v1.41.0 的推荐清单复现（skill / approval 两组按原发布保留）。
- Worker：`bundle-rollout-tools`（暂存不进 bin、只删非当前版本、`check_tool` 用暂存版本与会话环境、无账号跳过命令、会话钉住与 bin 移动无关）、`managed-tools*`、`external-accounts`、`daemon-dispatch`。
- Web：`bundle-versions`（设备状态、空闲 rollout 不挡“更新”、等待中的设备不算目标）、`bundle-tool-status`、`pending-items`（两种新条目）等。
- `scripts/check-changed.sh`（80 个文件）：prettier、gofmt、protocol 构建与测试、Web tsc 与 22 个测试文件、Worker 构建、Go（connectors / externalaccounts / feishugateway / gateway / httpapi 全包 / store / sqlitestore）、`audit:ui`、`audit:contract`、`audit:openapi`、`audit:modules` 通过；Worker 测试 859 项中 12 项失败，全部是 `connectors-tencentcloud.test.mjs` 的前置条件（本机 `/usr/bin/node` 旁有 `python3`），与本项无关。之后的增量（安装重试、补做、成员可见范围、页面空闲 rollout）各自跑了相关 Go / Web 测试。

## E2E

### 草稿栈（scratch-admin，合成 Worker）

`scripts/scratch-stack.sh up dev154`（DB 副本，`FOUNDRY_INTEGRATIONS=off`；为让“恢复”读 npm 上游开了 `--egress`），合成 Worker `dev_7e8d59b1…` 的 `FOUNDRY_TOOLS_ROOT` 指向草稿目录（不碰本机 `~/.foundry-tools`）。用 agent-browser bundle（0.41.1 → 0.41.2，记录都带工具）：

- **自动、金丝雀通过、瞬时下载失败重试**：回滚到 0.41.1 → 在合成设备安装 0.41.1 → 让本地 CONNECT 代理拒绝接下来两次到 registry.npmjs.org 的隧道（npm 关掉自身重试与缓存）→ 恢复。Server 日志：`installing agent-browser 0.41.2 … failed, trying again in 15s: … E503`、`… trying again in 45s …`；第三次安装成功，`agent-browser --version` 报 0.41.2，bin 链接改到 0.41.2，0.41.1 目录保留；库未回滚、未暂停。
- **手动“有更新”**：切到手动、设备回到 0.41.1、恢复跟随 → 库 0.41.2、设备“落后”、不自动安装；卡片显示“有更新 · 1 台设备不在 0.41.2 · 更新”（修正前因一个只等离线设备的旧 rollout 被隐藏）。
- **`failCheck` 演练**：更新 → 金丝雀暂存 0.41.2、真实 `--version` 通过、演练步骤失败 → 暂存的 0.41.2 被删（bin 仍是 0.41.1）、库回滚到 0.41.1（记录 #26）并暂停，0.41.2（#25）的检查记为失败（forced），设备“一致”。
- 截图（亮 / 暗 / 390 px 窄屏，整页）：`/tmp/dev154-shots/`。

### dev（真实设备）

**feishu-cli → v1.44.0（自动路径）**：本人 2026-11-09 17:07（UTC+8）在 Skill 库点“恢复更新”，库重新跟随 v1.44.0，自动 rollout（`trigger auto`）以 sg-chaos 为金丝雀：暂存 → `feishu-cli --version` 报 v1.44.0 → `auth status`、`auth refresh`、经网关的 `authen/v1/user_info`（检查授权，本人账号）全部通过 → 切换：`~/.foundry-tools/bin/feishu-cli → ../feishu-cli/v1.44.0/feishu-cli`，v1.41.0 目录保留。另一台在线的 VM-4-8-debian 随后更新，两台离线的等待。之后在 sg-chaos 新开的会话 `sess_1794217699912232652`：`feishu-cli --version` = v1.44.0，`feishu-cli doc media-preview --help` 输出帮助（起因中是 “unknown subcommand”）。

**会话钉住**：这次会话的 PATH 仍是 `~/.foundry-tools/bin`——sg-chaos 上正在运行的执行宿主还是 `0.5.7-dev.321…1794173489`（DEV-154 之前的版本），有会话在跑，按排空规则未切换；钉住由 Worker 测试与 Go 派发测试覆盖，宿主切换后再在 sg-chaos 上复验（见验收）。

**真实记录服务时已清理**：在新 DB 副本上读 `GET /api/skill-repositories`，金丝雀四个步骤为一行结果（版本 v1.44.0；Feishu 状态 / 刷新 / 读取），`open_id`、`union_id`、`tenant_key`、avatar、token profile、姓名均不出现。

部署后的第一次补做（`trigger auto`，金丝雀 sg-chaos）：agent-browser 0.38.2 → 0.41.2、playwright-cli 0.1.22 → 0.1.23 在 sg-chaos 上检查通过并切换（`~/.foundry-tools/bin/playwright-cli` → `0.1.23`），另一台有这些工具的设备（VM-4-8-debian `dev_a870…`）也已更新；另两台离线的等待。feishu-cli 的金丝雀在下载 `checksums.txt` 时遇到 GitHub 504，当时的版本把它当成检查失败，库回到 v1.41.0 并暂停（各设备会话仍一致地拿 v1.41.0）——据此改为安装重试、安装失败不回滚。

同一轮发现并修正：两次补做读到旧的仓库快照，替换了刚开始的同版本 rollout（改为自动开始不替换同版本）；`tool_checked` 未登记为回复（真实检查会挂到超时）；一台不再上线的设备会挡住之后所有更新；没有设备运行 feishu-cli 时也提示新增 scope；`bundle_update` 条目让“等你处理”卡片崩溃。

### 页面（真实浏览器）

- 草稿栈 Admin 视图（真实 Chromium，亮 / 暗 / 390 px）：四种状态——检查失败（bytedcli：CanWendeMac-mini 解析不了 bnpm.byted.org，`ENOTFOUND`，本机当时离开公司网络）、已暂停（feishu-cli，旧回滚）、更新中（agent-browser，真实 rollout）、已是最新（playwright-cli，草稿库中伪造的完成记录）；键盘：Enter 展开 Skill 名单（`aria-expanded=true`），“1 项检查通过”展开为“版本 0.41.2”，空格切换默认开关，bytedcli 的“详情”为等宽、限高 160 px 可滚动。
- dev 成员视图（e2e-alice，中文，亮 / 暗 / 390 px）：只看到自己的设备（DEV023、两台 VM-4-8-debian），看不到 sg-chaos、金丝雀与检查输出，“再检查一次”只给 Admin。
- `audit:ui` 15 项通过（含 component-system、state-layout）。
- 截图（改前 / 改后）：`.foundry/attachments/dev154/`——`before-person-dev.png`（本人截图）、`before-*.png`、`after-checkfailed-paused-uptodate-{light,dark}.png`、`after-rolling-light.png`、`after-390.png`、`after-dev-data-admin-{light,dark}.png`、`after-dev-member-e2e-alice-{light,dark,390}.png`、`interact-*.png`。

### 编排复核后的两处修正（2026-11-09 18:3x）

- **设备计数一致**：事实行只数“你的设备”（“你的 3 台设备中已装 1 台”；没有时“你还没有可安装的设备”，不显示“管理”），rollout 一行数“跟随它的设备”（“跟随它的设备 2/4”），状态标记与 rollout 同一集合；不是你的设备在行内写明属于谁（“· e2e-alice 的”）。之前两处都写“台设备”，Admin 看到“已装在 0/0 台设备”旁边列着 4 台设备。
- **设备名**：rollout 与检查里的设备名在服务时取 Foundry 现在的名字（改名后的显示名，否则主机名），不再用 rollout 开始时记下的；同一个人两台同名设备加 id 尾（“VM-4-8-debian …4146 / …8dec”），别人的设备再加属主。Go 测试覆盖改名、他人设备属主、同人同名加 id 尾。
- “再检查一次”改为按钮样式；“详情”与错误文字左对齐。截图：`after-fix-counts-names-light.png`、`after-fix-counts-names-390.png`。

## 验收

1. Skill 库（Admin）：feishu-cli 卡片头一行是“feishu-cli · v1.44.0 · 更新中 2/4”（离线两台连上后变“已是最新”），下面一行来源；展开金丝雀“4 项检查通过”，看到“版本 v1.44.0 / 已登录 · 令牌有效 / 令牌已刷新 / 以 <你的显示名> 的身份连上 Feishu”，页面上没有 JSON、open_id、scope 清单。
2. bytedcli 卡片：一行“未能检查更新：CanWendeMac-mini 解析不了 bnpm.byted.org · 再检查一次”；Mac mini 连上公司网络后点“再检查一次”应消失。
3. 在 sg-chaos 新开会话运行 `feishu-cli doc media-preview --help`：输出帮助。sg-chaos 的执行宿主切到 `…1794217605` 后（无会话在旧宿主上时），再开会话：`echo $PATH` 第一项为 `…/session-tools/<会话 id>`，`readlink -f $(command -v feishu-cli)` 指向 `…/feishu-cli/v1.44.0/feishu-cli`。
4. 演练（可选，Admin）：把某个 bundle 切到“手动”，在有更新时 `POST /api/skill-repositories/{id}/update {"failCheck":true}`：金丝雀检查先过真实步骤再判失败，暂存版本被删、库回滚并“已暂停”，“等你处理”出现“更新已回滚：…”；点“恢复更新”继续。
5. 某个 Feishu 账号缺 v1.44.0 新增的 scope 时，“等你处理”出现“重新授权 <账号>：feishu-cli v1.44.0 需要新增 N 项权限”，打开 Connectors 重新授权后消失。

## 限制

- 检查授权的命令步骤只在设备所有者本人有可用的 Server 持有型账号时运行，否则记为跳过并写明原因。
- Device-held 连接器（gh、aws 等）目前没有 bundle，检查只做 `--version`。
- Admin 在 Skill 库操作；成员只看到自己设备的状态。读取仓库的设备名（“由 X 读取”及其检查失败原因）在本项之前就对成员可见，未改。
- 会话钉住在真实设备上待执行宿主切换后复验（验收 3）；已有的 dev rollout 记录里，第一轮因下载 504 被旧逻辑记为“回滚”的 feishu-cli 记录仍在版本历史中。
- 页面截图中“已是最新”的 playwright-cli 状态来自草稿库中手写的完成记录（只在草稿 DB 副本上）。
