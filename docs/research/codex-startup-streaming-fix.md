# Codex 启动超时与 Commentary 流式重复

2026-10-16，针对 `sess_1792120713875295088`。

## 身份与启动检查

通过 MacBook 的 compute 租约读取执行环境：Worker 使用 `CODEX_HOME=/Users/bytedance/.codex-personal`、原生 Codex CLI 0.155.0。官方 `account/read` 返回 `cwindeng@outlook.com` / ChatGPT Pro；原生 `account/rateLimits/read` 在约 3.06 秒成功。未读取或输出凭据，未切换登录账号，也未发模型请求做健康检查。

原会话最初选择 Codex Local，失败于 `thread/start acknowledgement lost`。随后用户切换为 `byte-llm-gateway`、模型 `flux/gpt-6-astra`，该轮正常进入执行；没有由本次排查自动换号。

不发送 `turn/start` 的原生元数据测试成功建立 thread：initialize 约 2.86 秒，thread/start 总计约 18.64 秒。初次失败时具体卡在哪个原生依赖没有足够日志确定，不能断言是某个 MCP 或账号错误。已确认旧适配器对所有 RPC 都使用 30 秒超时；本机 MCP 配置包含 120 秒启动期限，因此同一短期限不适合原生准备阶段。

新适配器分开初始化（60 秒）、thread/start 与 resume（180 秒）、控制确认（30 秒）。慢启动会给当前轮次提示，可在初始化/启动等待期间立即取消；不重发结果未知的命令，也不把安静的正常执行当成启动失败。进程退出的错误会保留退出原因。

## Streaming 修复

新 app-server 返回逐步增长的 commentary 文本，原生消息 ID 保持不变。旧前端仅合并 assistant answer，commentary 则每个快照都追加，导致一段话出现几十行 Process。

- 按消息 ID 更新原 commentary 条目，保持原位置与步骤身份；不同消息、不同输入的独立说明不合并。
- Worker 复用已有流式合并机制，以最多每 250ms 的节奏发送 commentary，并在工具/完成等边界前刷新最后文本。
- 不删除生产事件、不改会话状态、不重跑任务。网页修复可以直接正确展示已经保存的旧记录。

## 验证与发布范围

- 真实会话的 147 个 commentary 快照包含 4 个消息 ID，使用修复后的投影得到 4 条完整消息。
- 将这些快照回放到隔离测试聊天，在真实浏览器展开后看到 4 行；检查亮色桌面、暗色 390px 窄屏，无横向溢出。回放保留原时间，因此测试聊天内合成组的时长不是实际任务耗时。
- `scripts/check-changed.sh --files …`：Web 类型检查、45 个 Web 测试文件、Worker 构建、6 个 Worker 测试文件及 10 项 UI 审计通过。后续启动提示改为使用当前轮次回调，重新构建并跑 Codex app-server 测试。
- 新测试覆盖超过控制期限的启动仍可完成、控制请求超时保留结果未知、启动期间及时取消、相同 commentary ID 合并且不同 ID 保留、原步骤位置稳定。
- 截图：`.foundry/attachments/codex-stream-review/replayed-light.png` 与 `replayed-dark-mobile.png`。
- 网页通过现有构建发布；Worker 修复包供更新。MacBook 当前任务仍运行，不能以更新中断它；新 Worker 的启动/合并逻辑需该设备更新后才生效，网页去重无需 Worker 重启。
- 改动已保留并暂存，尚未提交。
