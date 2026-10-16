# 2026-10-16 会话统筹核对

北京时间 16:27–16:31，只读核对生产进程、Foundry 会话记录、安装状态与故障日志；没有触发部署、杀进程或重跑用户任务。

## 两个会话

| 会话                     | 实际状态 | 已完成                                                                                                            | 未完成                                                                                          |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| sess_1792136803764191213 | failed   | 无代码变更；两次均在原生启动阶段失败                                                                              | 原始 streaming 内容展示问题尚未回答/实现；先遇到旧 CLI 的 6.1 Sol 400，续跑又遇到 active writer |
| sess_1792126883462218988 | failed   | 模型兼容性调查、原生运行时统一、stable 更新、目录绑定、设备 UI、byte-dev 更新修复已实现并发布；历史验收见实现记录 | 最后恢复工作被 host 退出打断；原失败 Foundry 会话的完整复验及 byte-dev 最终空闲切换没有闭环     |

## 这次事故是两个故障

1. 16:04:28 起，sg-chaos 更新到尾号 1792137787 后 `/api/daemon/register` 返回 400，Worker 循环重启。内部 RuntimeUpdateState.failureCount 进入严格协议请求，服务端不认识此字段。恢复补丁 1792138509 在 native-cli.ts 边界只投影协议字段，保留内部重试计数。已有首次/缓存读取、额外字段测试。
2. 16:07:47，仍驻留旧版 1792117322 的 execution host PID 2423477 因 readline.Interface 未处理的 ECONNRESET 退出。systemd 随后重启并完成新版替换。不是所有 Worker 断连都会保住任务：前提是实际运行的 host 已加载断连容错修复。这也是此前仅确认 Worker 更新、旧 host 长期驻留的交付缺口。现安装的 server/client.js 均含 Interface error handler。

不能将第二个会话的终态报错时间 16:15:19 当成旧 host 实际崩溃时间；日志中的退出是 16:07:47，终态随后补报。

## 当前生产状态

- 六台在线设备（sg-chaos、macbook、byte-dev、byte-dev-sg、CanWendeMac-mini、cottoncpp）的服务端注册版本全部为 0.5.7-dev.30.gca56545.local.1792138509。其他离线历史设备不包含在此结论中。
- sg-chaos：Worker PID 2648320，NRestarts=0；host PID 2648384、entry 为修复版。Codex managed 0.163.0，Claude 2.1.292 / SDK 0.3.301；本机 --version 核对成功。
- macbook：Worker PID 60534、host PID 60567，entry 为修复版；managed 描述和更新状态报告 Codex 0.163.0、Claude 2.1.292 / SDK 0.3.301。本次只读描述，没有新增原生推理测试。
- byte-dev：Worker PID 2987307，修复版；两次观察 NRestarts 均为 102（历史累计，不能当成当前仍重启），心跳更新。host PID 1564333 仍是 dev.28。存在活动输入 sess_1792066225554301740，因此不强制切 host；Claude waiting_idle，Codex managed 0.163.0 且 --version 核对成功。旧 host 尚未加载新版运行时代码，不能把 Codex 安装完成说成所有执行已切换。
- 两次远程 compute lease 均已释放。

## 收尾顺序与职责

1. 发布协调集中在主会话：核对注册成功、两个以上心跳周期和实际 Worker/host/CLI 版本；各功能会话不要各自发布全工作区或重启设备。事故恢复补丁必须保留。
2. 更新事项先完成原失败 Foundry 会话端到端验收，明确区别“CLI 原生验证成功”与“实际 Foundry 会话恢复成功”；byte-dev 等活动任务结束后再核对 host 与 Claude 更新生效。不能只看 Devices 中 Worker 版本。
3. streaming 会话回到原始展示问题，评估 commentary/assistant text 与 reasoning/tool 的边界，之后才实施页面改动及真实浏览器验收；不混入 updater 改造。
4. 发布测试仍应补强真实 Worker 注册请求对服务端严格 JSON schema 的契约测试，以及坏发布后注册失败的恢复策略。本次投影回归修复了眼前字段泄漏，但不是完整发布故障隔离。
5. 共享工作区仍有未提交修改，HEAD ca56545；未绕过 09:00–22:00 提交限制。本次未把其他会话的未完成工作提交或发布。

这是状态与待办核对，不宣称原两个会话的业务任务已经恢复完成。
