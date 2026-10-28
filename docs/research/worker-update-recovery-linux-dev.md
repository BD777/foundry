# linux-dev 更新恢复与旧执行运行时切换

日期：2026-10-16。用户报告 worker 更新失败、CLI 旧版本提示，以及 dev-server 更新 worker 后 6.1 Sol 仍返回 400。

## 查明的原因

- linux-dev 第一次更新已安装 `0.5.7-dev.30.gca56545.local.1792135850`，但在服务切换前超时。重试只比较 runtime/current 的包版本便提前返回成功，实际控制 worker 仍是原 PID 2256834。
- linux-dev 的执行 host PID 1564333 属于独立的 systemd execution unit，仍运行较早的 `dev.28` 构建，且确有两条活动会话。其 Linux 使用 cgroup v1；旧空闲迁移检测只处理 v2。
- 新的 agent updater 使用“任意 native 进程仍活跃”作为忙碌判断，导致 Claude 的任务也阻止 Codex 更新。
- dev-server 的失败会话 `sess_1792136803764191213` 原生日志确认 CLI 仍为 `0.153.4`。worker 包更新不等于旧 execution host 和 CLI 已经切换；当前排查会话仍占用旧 host。
- 旧 host 会留下已完成任务的 Codex app-server 和 code-mode sidecar。这些闲置引擎进程也使“cgroup 只剩 host”检测永远不满足。

## 修复

- 同版本重试复用已安装包，但继续完成服务激活，不再把磁盘版本当成运行版本。
- systemd ownership 同时识别 cgroup v1/v2；确认 host 启动身份和独立服务组后，可只重启控制 worker，不打断执行。
- 空闲升级仍先检查 host snapshot 中无 claims/background/ownTurns；只额外允许无其他工具进程的闲置 Codex app-server 及其 code-mode sidecar。Claude 和任意 shell/工具进程不自动归类为可回收残留。
- updater 按可识别的 agent 进程归属判断忙碌，Claude 不再阻止 Codex；无法识别的进程保守阻止更新。
- 将旧版本黄色提示中的手动 npm 命令替换为自动更新状态和直接“更新到稳定版”按钮，说明等待哪个 agent。按钮含 agent 名称的无障碍标签，支持 busy/离线禁用和失败重试。

## 实机结果

- linux-dev 控制 worker 已安全重启，旧 execution host 的 PID/启动身份和两条 active claims 保持不变。
- linux-dev 的 Codex 自动更新实际完成：managed executable `0.163.0`，状态 `current`；Claude 保持 `waiting_idle`，不强杀现有任务。
- 同一个 dev-server 账号直接使用稳定版 Codex `0.163.0` 运行 `gpt-6.1-sol` 已返回 `OK`、exit 0、turn.completed。此为用户故障排查中的一次明确兼容性验证，不是自动 updater 的推理探测。
- 最终补丁包：`0.5.7-dev.30.gca56545.local.1792137787`，已在 dev 发布，并启动 dev-server / linux-dev 控制 worker 的安全更新。网页静态产物已包含新按钮。
- dev-server 的在途排查会话仍运行于旧 host；必须等本轮结束，新的控制 worker 才能安全替换旧 host，再由 updater 完成 Codex 切换。因此此处不宣称在途会话已加载新版本，也不宣称已重跑用户原失败问题。

## 验证

- worker 定向测试 23 项通过，包含同版本重试确实重启服务而不下载包、cgroup v1/v2、遗留 Codex sidecar 与工具进程区分。
- Web 16 个测试文件、类型检查、10 项 UI 审计通过。旧测试只按 aria-label 查按钮导致两项新增测试初次失败，已添加带 agent 名称的明确标签并复测通过。
- 最后针对 execution service 的 build、3 个测试文件和模块审计通过。
- Chromium 完整设备页：展开详情之前即可看到“更新到稳定版”；键盘触发、busy、错误后重试、离线禁用、亮/暗和窄屏无横向溢出均验证。截图在 `.foundry/attachments/byte-recovery-validation/`。
- 最终 worker tarball 内 241 个 dist 文件与已构建文件逐字节一致。

未执行 commit。
