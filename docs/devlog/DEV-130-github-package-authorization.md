# DEV-130 GitHub Packages 补授权

状态：已部署 dev，Agent 自验完成；待本人在 GitHub 确认授权及人工验收；未提交。

## 问题与原因

`sess_1793887488081951927` 列出 `nwverse` 的容器包时，GitHub 返回缺少 `read:packages` 的 403。Foundry 已允许使用设备登录，但基础 GitHub CLI 登录未申请该 scope，“重新检查”也不会增加 scope。本人要求从 Foundry 点击授权，无需 SSH。

## 实现

复用已有设备附加授权协议、所有者检查、操作收据、轮询、验证码弹窗及中英文能力标签，不新增协议或另一套 UI。GitHub catalog 声明 `packages-read` revision 1。适配器读取原生 `gh auth status --active` 的 scope，区分需要授权、具备读取权限和无法确认；没有 scope 输出时不冒称已具备权限。点击后通过原生 `gh auth refresh --hostname github.com --scopes read:packages` 追加权限，凭据仍由 gh 保存在设备。授权前须已登录；完成后核对账号，并由既有 Server 流程重新读取能力状态。GitHub 的组织与具体包访问权仍独立生效。

## 验证

- `scripts/check-changed.sh --files packages/worker/src/connectors/github.ts packages/worker/test/connectors-github.test.mjs apps/server/internal/connectors/catalog.json`：格式、Worker build、相关 12 个测试文件、模块审计全部通过。
- GitHub 适配器 11 项测试通过，包括 scope 判读、无 scope、未登录、官方 refresh 参数、验证码、pending/complete、账号改变拒绝和非法能力拒绝。
- Server connectors 测试通过。
- agent-browser 真实 Chromium，e2e-alice 的 dev 页面，仅拦截合成 `dev_dev130_synthetic` 的设备读取与授权请求；不操作真实设备登录：键盘 Enter 打开授权、GitHub 链接/测试验证码、pending 禁用入口、失败与重试、成功后能力变为 ready；1280×900 light、390×844 dark 全页截图检查。截图在 `/tmp/dev130-{light,code,dark-narrow,ready}.png`。实际 GitHub 同意步骤留给本人，合成流程不代表用户已经授权。

## 部署

部署前发现 `foundry-int` 工作树含未发布 triage 改动。Server 从该树已暂存的部署基线单独提取到 `/tmp/dev130-server-source`，只替换 GitHub catalog；Worker 新旧包逐文件比较只差 GitHub JS 与版本元数据；协议复用线上包内容，仅更新打包版本，未带入 triage。现有主树与 int 的其他改动保留。

- 2026-11-05 22:29 UTC+8：Server `a91174139ce946d8`，SIGHUP 无缝交接，`127.0.0.1:31982/healthz` 返回 ok、startedAt `2026-11-05T14:29:22Z`。保留原二进制与 worker manifest 在 `~/.foundry/server/releases/dev130/`。
- Worker `0.5.7-dev.269.g97415a6e.local.1793888612` 已发布；sg-chaos、CanWendeMac-mini、byte-dev、byte-dev-sg、cottoncpp、limen-canada 的守护进程已更新并重连。macbook 使用独立 `.foundry-stacks/dev` 状态根，随后更新成功，守护进程与执行宿主均已加载新版。
- 执行宿主实查：CanWendeMac-mini、byte-dev-sg、cottoncpp、limen-canada 已加载新版；sg-chaos 与 byte-dev 保留正在使用的旧宿主，未强停会话。连接器请求由新版 **daemon/handlers/connectors.ts** 直接处理，本次补授权不依赖旧会话宿主换代。
- sg-chaos 用已安装新版适配器与真实 gh 只读复查：`packages-read` 为 `needs_auth`（14:31:32Z），准确反映仍待本人授权。
- Web 未改代码，复用线上 `27a08cb78b0c432d`；撤掉所有浏览器 mock 后，真实 dev GitHub 页面已出现该能力，离线设备授权按钮正确禁用。
- 构建前后磁盘均约 14 GiB 空闲；没有提交或中断运行中会话。

## 人工验收

1. 刷新 Foundry，打开连接器 → GitHub CLI，找到 sg-chaos。
2. “读取 GitHub Packages”旁点“授权能力”。预期出现 GitHub 链接与一次性验证码，无需服务器终端。
3. 打开链接，使用原来的 BD777 账号输入验证码并确认。回 Foundry 等待状态更新。
4. 原部署会话重试包列表。预期不再出现缺少 `read:packages` 的 403；具体包权限或镜像可运行性仍需该任务验证。

## 2026-11-05 后续：权限选择与 Docker 接入

本人要求推荐/自定义/全部选择，并从 Foundry 接上 Docker。默认范围为 Packages：推荐 `read:packages`，自定义可增加 `write:packages`、`delete:packages`，全部仅指界面列出的权限。读取为必选；明确说明取消勾选不撤销已有授权。组描述符增加可选 scope 列表，状态回传已授予的白名单 scopes；UI 复用共享选择控件，适配器验证所选白名单和实际授权结果。原本已具备读权限也能进入选择界面追加权限。

Docker 是独立的凭据接入能力，不新增 GitHub scope。本人点击后创建 Foundry 专用 Docker 配置与原生 credential helper：仅为 ghcr.io 的 get 请求从当前 gh 登录取凭据，stdout 只交给 Docker；不保存 token、不覆盖 ~/.docker/config.json，不更改登录账号。helper 只链接到允许使用 GitHub 登录的会话 PATH；未授权会话使用空 Docker 配置。每次会话准备重写 helper 指向当前 Worker 版本，避免旧 runtime 回收后失效。GitHub 原生登录更新或退出后，helper 跟随当前状态，不保留过期副本。进入下一轮需要原生环境更新，由 [DEV-131](DEV-131-connector-runtime-environment.md) 同时修复。

验证：GitHub/GHCR 单测 13 项、Web 连接器测试 22 项通过，含读取推荐、全部明确增加发布/删除、自定义、非 GHCR 主机拒绝、不把合成 token 持久化。真实 GitHub 增权与 GHCR 拉取仍待本人选定权限/启用后确认；本次未代替本人申请发布或删除权限。已发布：Server `db5b7786b5baf9ed`、Web `31f9a94b1b524722`、Worker `.1793892617`，版本换新限制见 DEV-131。真实 Chromium 以 e2e-alice 登录，合成设备拦截验证推荐/全选/自定义、待确认验证码、键盘、1280×900 light 和 390×844 dark；部署后真实页面 build 核对、离线设备禁用、中英文权限选择复验。证据：`.foundry/attachments/dev130-scopes/zh-permissions.png`、`dark-narrow.png`。未向真实 GitHub 申请发布/删除权限，未操作真实 DNS；真实 GHCR 拉取尚待本人启用后由部署会话复验。
