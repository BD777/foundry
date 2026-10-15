# Codex 控制与执行服务验收

2026-10-16；接续 `runtime-integration-gap.md` 的改造前分析。此记录区分实现、实测和部署，不把代码推送当作线上生效。

## 实现边界

- Codex 从 SDK 的执行封装切到同一原生 CLI 的 app-server。一个 turn 只有一个原生执行者，执行、steer、interrupt 共享其 thread/turn 身份。Claude 仍走原生 Agent SDK。
- 业务会话、输入 ID、Server 队列、权限、Issue 候选与验收模型保持原有职责。适配器把原生通知映射为既有事件；上层不消费 Codex RPC。
- Linux 有用户 systemd 时，每个 Foundry state root 对应一个固定名称的 execution service。Worker 只连接它；执行、原生控制、后台任务、计时器、Issue 环境和 Evidence 在该服务中运行。
- IPC 使用私有 Unix socket 与随机令牌。Worker 与服务都核对 PID 和进程启动身份；另一个仍活着的 Worker 不能接管。旧连接不能继续控制新连接的执行。
- 派发身份、控制结果和事件 outbox 落盘。事件在 Server ACK 后才删除；Worker 退出不丢弃任务或待确认输出。未知 steer 不自动重发，不承诺原生协议之外的恰好一次执行。
- systemd 的 `KillMode=control-group` 负责整树回收。服务崩溃后旧任务明确失败，不自动重跑工具；服务自身重启后可重新连接。移除设备或卸载会停止该服务。
- 服务正在使用的安装版本被保留，Worker 更新不删除它。当前没有服务的热代码替换；升级服务代码必须等任务和后台工作结束后显式重启服务。Worker 的重连不是服务升级。

## 不扩大保证

- 本次跨 Worker 重启保证实测于 Linux/systemd。其他平台或没有用户 systemd 环境仍使用原来的进程内执行，不声称已经获得同样保证。
- 看护服务本身被杀、机器重启、原生进程自身崩溃均可能终止执行；保证的是可追踪、清理和明确失败，不是恢复进程内存。
- 第一次从旧版迁移不能收养旧 Worker 已启动的 SDK 进程，需要先等待旧执行结束。此后由服务启动的任务才可以在 Worker 重启后原样接回。
- 服务按设备/state root 管理多个执行；服务崩溃会影响其全部执行。IPC 是同一 OS 账号内的控制边界，不是多租户隔离。
- 持久去重记录目前不自动淘汰；长期设备需要后续加入与 Server 保留期协调的回收策略，不能任意删记录后允许重复执行。

## 自动验证

`scripts/check-changed.sh --files …` 首次检查：协议构建/测试、Web 类型检查、63 个 Web 测试文件、Worker 构建、Store 测试、UI/契约/模块审计通过。Worker 41 个测试文件中有一个旧 fixture 漏列已有 `device_sharing`；Server 测试仍期待人的 steer 没有 input ID。两项已更新并单独重测通过，不将首次结果描述为全绿。

- `TEST_EXECUTION_HOST_SYSTEMD=1 node scripts/run-worker-tests.mjs -- test/execution-host.test.mjs test/codex-app-server.test.mjs test/daemon-dispatch.test.mjs test/context-window.test.mjs`：18 项通过。包含真实 OS 服务的 SIGKILL、进程树清理与重启；假 CLI 只用于确定性的故障注入。
- 覆盖活 Worker 拒绝接管、Worker 死亡后接回、重复派发不重跑、重复 steer 返回既有结果、凭据拒绝、磁盘 outbox 的原身份重放和 ACK 删除。
- Codex 协议测试覆盖精确 turn 的 steer、迟到拒绝、丢确认结果未知、取消静默轮次、工具状态/用量/消息 phase 映射，以及不重复显示原生 userMessage 内部提示。
- Server 定向测试覆盖 Codex capability 门控、携附件的 steer、旧 Worker 拒绝、结果未知与可重试拒绝的区别、人的输入稳定 ID、空窗口映射序列化。

## 真实浏览器与原生执行

隔离栈 `runtime-host-review`，真实 Codex CLI 0.153.4；只使用既有原生账号。测试数据库为生产数据库副本，禁用集成；合成工作区 `/tmp/fdy-zKkzg4/runtime-host-browser-workspace`。以下确认和 Accept 由用户授权的验收自动化点击，不伪称用户本人逐条操作。

1. 会话 `sess_1792085540468299412` 启动真实命令，原要求输出 `ORIGINAL`。运行中在浏览器使用 Steer 改为 `STEERED`；重启测试 Worker，核对原生 PID **2214791** 与启动身份未变；最终页面收到 `STEERED`。测试期间 Worker 再次断开，持久 outbox 在重连后补交输出。
2. 官方模型选择器显示 `gpt-6.1-sol`。输入非法窗口保存禁用；400K 保存/刷新为 400000，真实轮次显示 **380K** 可用。窄屏 390×844 与桌面 1440×1000、亮/暗主题检查已记录。
3. 实际浏览器发现清空窗口时 Go `omitempty` 丢掉空 map，导致旧值恢复；改为发送空 map 并加入回归。原生最大窗口与保留空间分别展示，不将配置值当成实时上下文容量。
4. 合成 Issue `iss_107`（仅在隔离栈）：`hi` 先追问；补充目标后读取真实 README 并生成草案，确认前工作区干净；revision **2** 的确认后启动候选实现。缺证据时 Accept 禁用。采集后独立 Agent 读取候选文件和完整 diff，判定通过；显式接受后显示 Accepted and integrated，工作区提交 **d2d238f**，只改 README 标题。
5. Issue 契约 digest `sha256:0806770ca9084d9bf3169a0dde262687da7084eecb0b26338d1a5803dd2dbda9`；候选 `snap_59b12c38-fb14-41e7-b114-f9362a419335`；review `review_f622ae83-75a2-4724-a7bd-371c8f023aba`。失败/过期/版本绑定路径由既有自动测试覆盖，未把这些路径说成全部手动点击验证。

截图位于 `.foundry/attachments/runtime-host-review/`：`catalog-light.png`、`context-light.png`、`context-dark-mobile.png`、`steer-after-worker-restart.png`、`issue-independent-verification.png`、`issue-accepted.png`。原生执行测试与故障注入测试分别记录，不用 mock 冒充真实模型。

## 上下文窗口

gpt-6-astra 的原生已知上限为 872000，95% 可用空间对应 828400。旧 272000 默认对应 258400。官方账号的窗口可按模型设置；留空采用原生已知最大值。模型目录公布不代表旧 CLI 已支持其全部参数或该账号已有权限。

正在进行的 turn 不能在线扩大上下文；新配置在下一轮原生 start/resume 生效。当前会话 `sess_1792077855167355710` 的此次轮次仍由旧 Worker 执行，部署不能反向改变它已经建立的窗口。
