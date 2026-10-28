# 跨会话消息来源

2026-10-16

发送者由服务端从调用凭据确定，用户提交的正文不能指定身份。已有 `sentBySessionId` 同时保存在输入和事件中，聊天界面据此显示来源会话链接。此前模型没有收到这项身份：普通输入忽略它，steer 的设备协议没有传递它。

本次让普通输入及 Claude/Codex steer 共用来源包装：明确指出消息来自哪个 agent session、不是用户直接输入，也不因此新增用户授权。附件与原始正文保持完整；存储与聊天正文不被包装污染。没有发送方的人的输入保持原样。steer 的身份经过 Server → Worker → execution host → runtime 传递，去重仍沿用原 input ID。

资源排队和释放仍由固定接口管理；没有把排队改为自动发聊天消息。`send_message` 仍可用于明确的跨会话协作，但不能伪装成人的授权。

验证：普通输入与 Claude 原生 SDK 测试替身收到一致来源说明；事件保留原文；原有人输入不变。Linux/Mac 定向回归均通过。实际模型旧轮次不会因替换磁盘文件而热加载新包装；新 execution host 生效后才使用新代码。

发布：服务端及 Mac、dev-server Worker 已部署 `0.5.7-dev.30.gca56545.local.1792128550`。Mac execution host 已使用新版；dev-server 正在运行的旧 host 等全部任务空闲后安全升级。追加 Codex steer 测试确认来源、图片及原始事件正文均保留；8 项输入/steer 回归通过。

服务端额外验证：发送者字段完整下发至设备；人的 HTTP 输入试图指定 `sentBySessionId` 会被拒绝（400），身份只取已认证调用者。原有 `send_message` 身份测试覆盖服务端凭据到输入元数据的绑定。
