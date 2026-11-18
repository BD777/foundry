# DEV-303 Issue 端到端回归（ISU-1）

[Devlog 索引](README.md) · [Roadmap · ISU-1](../roadmap.md) · [准出标准 G1–G5](../foundry-conversation-release-gate.md) · [Issue 工作流](../issue-workflow.md)

状态：**阻塞，未通过（ISU-1 未执行）；已合入 main（PR #278）**。ISU-1 保持“下一步”。Claude 与 Codex 两条闭环都没有执行：dev 上的 Issues 入口由 DEV-148 隐藏，真实浏览器无法进入 Issue 页面。

## 结论

| 准出项                  | Claude         | Codex          | 说明                          |
| ----------------------- | -------------- | -------------- | ----------------------------- |
| G1 主对话与澄清         | 未执行（阻塞） | 未执行（阻塞） | 无 Issue 入口，无法创建 Issue |
| G2 同源标准与显式确认   | 未执行（阻塞） | 未执行（阻塞） | 同上                          |
| G3 信息架构与可读性     | 未执行（阻塞） | 未执行（阻塞） | 同上                          |
| G4 验收结果与真实证据   | 未执行（阻塞） | 未执行（阻塞） | 同上                          |
| G5 回归与真实浏览器准出 | 未执行（阻塞） | 未执行（阻塞） | 未运行自动测试；无浏览器闭环  |

没有 Issue 被创建，没有模型请求，没有候选、判定、Accept 或集成。Claude/Codex 的 profile 与模型未选定，所以不记录运行时结论。

## 失败与根因

**F1：Issues 在 Web 中不可达（阻塞本次验收）**

- 复现：以 e2e-alice 登录 dev，打开 `https://dev.foundryapp.app/issues?workspace=ws_68dbe9ca-7d89-47d2-97ce-7d0a9fe83384`（1440×1000，zh-CN）。页面跳转到 `/chats?workspace=…`，侧栏只有概览、对话、助理、等你处理、助理设置、设备、资源、Skill 库、模型服务、连接器、统计、账户，没有 Issues。截图：`~/.foundry/devlog-evidence/DEV-303/issues-redirect-to-chats.png`。
- 根因：`apps/web/src/lib/feature-flags.ts` 中 `issuesEnabled = false`，由提交 `39348563`（DEV-148，#228，2026-11-09）引入。DEV-148 的 devlog 写明这是“Issues 隐藏”的有意改动（功能代码、Server 与数据不变）。
- 影响：准出标准 G1–G5 要求真实浏览器操作 Issue 页面。在不改产品代码的前提下，无法在 dev 上完成。API/MCP 路径可以驱动 Issue，但不满足 G5 的浏览器准出要求，不能替代 ISU-1。
- 未采取的做法：没有修改 `issuesEnabled`，没有本地构建或部署带 Issue 入口的 Web，没有用 API 代替浏览器闭环。

需要本人决定（产品可见性，Agent 不自行决定）：

1. 在 dev 临时开启 `issuesEnabled`（部署一次 Web），用于本次回归，验收后恢复为 `false`；或
2. 保持隐藏，ISU-1 继续阻塞，待 Issue 入口重新开放后再跑。

## 预检与清理记录

- 账号：e2e-alice（synthetic），密码只由脚本从仓库外文件读取，未输出。登录 200；验后登出 204，旧 Cookie 返回 403，临时 Cookie 与脚本已删除。
- 合成设备：`dev_a870ddf7-c6eb-4eaa-a1e1-f53202224146`（DEV-148 synthetic，VM-4-8-debian），工作区 `ws_68dbe9ca-7d89-47d2-97ce-7d0a9fe83384`（dev148-synthetic-workspace）。
- 为预检启动 `dev-verify-dev148-worker` 单元（已发布 runtime `0.5.7-dev.368.ge03dfd61.local.1794990574`，状态目录 `~/.foundry/dev148-acceptance/state`）。设备报告 connected。
- 验后停止：`dev-verify-dev148-worker` 单元已停止；其执行宿主仍在独立单元 `foundry-execution-af357928dec1cd10.service` 中运行，已单独停止，验后无 `dev148` 进程。
- 人本机服务未改动：`foundry-worker.service` 与执行宿主 `foundry-execution-564ac0895145439d.service` 保持 active。
- 磁盘：预检时根分区剩余 9.1 GiB（91% 已用）。删除了可再生的 `~/.cache/go-build`（188 MB），剩余 9.3 GiB。未删除备份、DB、旧 runtime（仍有进程引用）。

## 未检查的 DEV-291 / DEV-298e/f 改动

这些改动涉及 Issue 路径（主聊天路由、MCP Issue 操作、`agent_proposal` 草案），本次没有运行。它们在 Issue 页面可见之前不能通过 ISU-1。

## 复验条件

- Issues 入口可达（见上面的决定）。
- 每个 Runtime 各一条闭环：创建 → 澄清与契约 → 显式确认并开始 → 候选与证据 → 判定与接受 → 集成。每个 G 项记录通过/失败，附截图、Issue/契约/判定 ID 与耗时。
- 通过后更新 `docs/roadmap.md` 中 ISU-1 为已达成，并链接本文件的新版本。
