# Agent 依赖统一与 stable 自动更新：实现记录

日期：2026-10-16。代码已实现；15:32 已部署 dev server/web，并发布新版 worker 包供用户点击更新。未主动更新设备 worker，未 commit。

## 实际变更

- Codex 聊天、独立 verifier、显式检查统一使用原生 app-server。共享 JSON-RPC client 位于 `packages/worker/src/agent-runtime/codex-client.ts`。移除 `@openai/codex-sdk` 包依赖及官网模型并集实现。
- Claude 所有 SDK 调用统一经 `agent-runtime/claude-sdk.ts`，保留官方 SDK 的控制方法。SDK 是程序接口，Claude Code binary 是实际引擎，不是两条不同的代理执行链路。
- 通用更新控制器、适配器注册表、stable 版本发现、持久化状态和跨进程维护锁位于 `packages/worker/src/agent-runtime/`。启动时和每 6 小时加随机抖动检查；等待空闲每分钟重试；失败指数退避，最多 6 小时。
- Codex 跟随官方 npm latest 的正式版本；Claude Code 跟随官方 stable；Claude SDK 跟随正式 latest。完整 prerelease 版本保留，alpha/beta/rc 不当成 stable；显式 executable pin 不再静默回落。
- 新版本放入版本化目录，安装和原生协议验证成功后才原子切换描述文件。已有符合目标的 executable 会复用；失败不改变生效版本。npm 校验发行包完整性，固定官方 registry；禁用通用 lifecycle，仅执行 Claude 包已核对的 `install.cjs` 以连接平台 binary。
- SDK 使用版本化、不可变的模块路径加载，每次查询持有对应版本的引用。没有覆盖正在运行的 `node_modules`；旧 query 保留原 SDK，后续 query 可加载新 SDK。这比设计初稿另建 SDK runner 进程更小，仍保留版本隔离和查询生命周期约束。
- 维护锁覆盖执行准备、原生进程与生效切换。Issue/verifier 的锁由沙箱外宿主持有，子进程继承保护，不开放沙箱对宿主锁目录的写入权限。
- 按既有空闲 TTL 定期回收没有 pending turn、后台任务或原生继续执行的缓存进程，防止没有下一条消息时永远无法更新。正在工作的进程不强杀。
- 停用后台推理健康探测。更新验证只运行 `--version`、SDK 加载、原生元数据/协议握手，不发送 prompt。
- CLI/SDK 更新代次、可执行版本及非敏感账号指纹进入目录/运行缓存标识。token 正常续期不改变身份指纹；账号或配置来源变更会改变。
- 设备账号详情新增已安装版本、真实 executable 路径、最新 stable、SDK 目标、更新状态和检查更新操作；等待空闲不会显示成“安装成功”。保留两种语言、键盘、busy/error 和离线禁用状态。

## 安装来源与生效范围

独立运行时使用 Foundry 管理的版本目录，在 Foundry 内选用更新后的程序，不重写用户原来的 PATH 安装。App bundle、系统包管理器拥有的程序和显式 pin 显示外部管理原因，不覆盖它们。自动更新只维护已安装 agent，不自动增加新的 agent。

Claude 子进程关闭自身后台 updater，由 Foundry 统一调度；不会改用户终端的全局配置。其他程序自行更新共享安装不受 Foundry 锁控制。已经安装的较新非 stable Claude 版本可在维护窗口切回 stable，依旧先验证再生效。

新版候选验证失败时保留原生效描述文件。这里保证的是 staging 失败不切换，不承诺任意第三方配置/数据库 migration 的回滚。上一版描述保留；旧版本不在仍有工作时删除。

## 验证证据

1. 第一轮按文件检查：Web 346 项测试、protocol build/tests、Web/worker 类型与构建、服务端模型缓存测试、store 测试、UI/contract/module 审计通过。worker 集成测试发现三处沙箱锁写入问题。
2. 将锁移至沙箱外后，Issue/verifier 真沙箱、workspace 执行和取消共 18 项测试通过；Claude 会话恢复、fork、替换等及更新控制共 18 项通过。
3. 修正后的范围检查全部通过：Web 14 个测试文件、worker 23 个测试文件、类型/构建、10 项 UI 审计及模块审计。新安装流程测试实际启动假 npm 和原生协议进程，验证候选失败不改变 generation，且没有 `turn/start`。
4. 官方真实发行包在独立临时安装目录验证通过：Codex `0.163.0` 的 app-server 元数据读取；Claude Code stable `2.1.292` + Claude Agent SDK `0.3.301` 的 SDK 加载及 `supportedModels()`。没有模型推理、没有切换真实账号或生效运行时。
5. 真实 Chromium 完整设备页验收：键盘 Enter 可触发检查；请求中 busy/disabled；失败后可重试；设备离线时禁用；浅色/深色、390px 窄屏无横向溢出。使用独立 scratch 服务和模拟更新响应，没有对生产设备发更新请求。

截图（位于本工作区附件目录）：

- `.foundry/attachments/agent-runtime-validation/light.png`
- `.foundry/attachments/agent-runtime-validation/dark.png`
- `.foundry/attachments/agent-runtime-validation/error.png`
- `.foundry/attachments/agent-runtime-validation/narrow.png`

浏览器结果：`keyboardActivated=true, busy=true, retryEnabled=true, horizontalOverflow=false, offlineDisabled=true`。已按完整页面正常比例检查截图。

## 发布边界

本轮验证的是本地实现、安装/切换机制、真实发行包协议兼容与浏览器交互。未将代码发布到任一真实 worker，也未在更新后的生产 Foundry 会话中重新执行模型任务。不能将本地验收写成线上 rollout 已完成。

## 2026-10-16 15:32 dev 部署

用户明确授权部署并重启 dev server/web，设备 worker 由用户点击更新。

- SQLite online backup 与 `quick_check=ok` 完成；旧 server 二进制、web 产物和 worker 发布包已备份至 `/home/windeng/.foundry/server-backups/agent-updates-20261016-153029/`。
- Go 构建和 Vite production 构建完成；PM2 `foundry-server`、`foundry-web-build` 已重启并 online。server 明确使用 `/home/windeng/.foundry/server/foundry.db`。
- server `/healthz` 返回 `status=ok`，`startedAt=2026-10-16T07:32:40Z`。
- `https://dev.foundryapp.app/` 加载 `/assets/index-DMLklZPu.js`，已验证产物包含运行时 stable 更新页面。
- `/api/worker/release` 已发布 `0.5.7-dev.30.gca56545.local.1792135850`。protocol/worker 两个 tarball 都从公网下载并核对 SHA-256 与本地构建一致；worker 包包含新增 runtime updater 且不再依赖 Codex SDK。
- 发布前包在隔离 staging 目录生成；切换 release.json 前先放好 tarball，旧发布包保留，避免中断已开始的下载。
- 没有更新设备 worker 或强制替换活动 execution host。设备更新后的注册版本、空闲切换和实际模型会话仍需在用户点击更新后验收。
