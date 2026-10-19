# 运行时与 streaming 收尾验收

2026-10-16，北京时间 16:40 起。接续 session-coordination-20261016.md。

## 6.1 Sol 实际执行

- sg-chaos 原失败会话 sess_1792136803764191213 使用 codex_local、gpt-6.1-sol 恢复同一 native thread 01a143ad-79b1-7fc2-93f4-b8fbd47e94c9；启动日志确认 managed Codex 0.163.0。08:40:43–08:44:46 UTC 完成真实 streaming 展示改造，终态 completed，不再出现模型 400/active writer。
- MacBook 通过 Foundry 新建验收会话 sess_1792140121233347619，codex_local、gpt-6.1-sol；08:42:16 UTC completed，回复 FOUNDRY_61_SOL_OK，错误/警告均为 0。未调用工具或写业务文件。

## 自动更新时机

Worker 启动后检查；正常下次检查为 6 小时加 0–5 分钟抖动。需要更新但运行时被占用时，waiting_idle 每分钟重试；失败指数退避。原生协议验证后才切换版本化 executable。Codex app-server 是该 CLI 的模式，不是另一套要单独安装的 SDK。

活动进程继续原版本。新 execution host 每 5 秒由 Worker 刷新状态，活动 claims/background/ownTurns/在途操作未清空时不换代；空闲后 drain 握手切换。旧协议 host 是一次性迁移例外，不能把装好新 CLI 当成旧 host 已加载新选择代码。

## byte-dev 残留与保护

- 最新 Worker 安装为 0.5.7-dev.30.gca56545.local.1792140449，PID 3086135，NRestarts=0。
- 旧 host PID 1564333 仍是 dev.28。服务端已失败的 sess_1792133749851636189 还占 active claim。短暂停控制 Worker、以维护进程接回独立 host 后，仅取消这个已失败的精确 input，claims 已清空；控制 Worker 始终在 finally 恢复。
- 维护 snapshot 发现 sess_1792131715822392734（20 台 OMH 升级）的 background/ownTurns 仍活跃，故停止迁移，不强杀正常工作。批量升级 command 已完成，但 monitor bfpn59px3 仍在运行。不能把服务端 session.status=completed 等同于 native 全空闲。
- 已向用户提供保留监控/停止监控的选择，未收到停止授权前保留。
- 另发现 HOME 软链接导致 pruneRuntimes 用逻辑路径与模块真实路径比较，可能删掉运行中 host 的目录。已改为 canonical realpath 比较，新增实际软链接目录清理回归；按文件检查 build、4 个 Worker 测试文件、模块审计全部通过。补丁已发布并安装至 byte-dev，不更改账号或原 PATH 安装。

## streaming 展示

- 原会话完成 transcript-projection.ts 修复：commentary 渲染为 Markdown 正文；reasoning/tool 独立折叠。保留原有累积 snapshot 去重。
- 45 个 Web 测试文件、10 项 UI 审计通过；fixture 类型错误修正后 typecheck 通过；另有 32 项 transcript/usage/classification 测试通过。详见 codex-commentary-body-display.md。
- dev 公网产物 /assets/index-CY2L61UA.js 与本地发布文件逐字节相同。
- 主会话补做完整聊天页验收：隔离生产 DB 副本、integrations/egress 关闭、无 Worker，读取上述真实 6.1 Sol 会话已完成的 transcript。两条实际 commentary 在正文各出现一次，不在折叠标题中；页面 errors 为空。截图 .foundry/attachments/runtime-final/real-61-commentary.png。
- 浏览器验证是“真实 transcript + 隔离完整页面”；合成流式增量、明暗/窄屏交互由原会话 fixture 验证，不冒称访问生产用户浏览器或重新实时生成模型内容。

未 commit/push；没有发布共享目录里的任意未检验变化。
