# DEV-178 · 模型池、429 换 ID 重试与事件展开

## 问题

同一模型在 provider 下可能有多个独立配额的模型 id，但会话只能钉住一个 id；遇到 429 时整轮失败，需要人工 resume。额度已经耗尽的账号仍会被 Claude SDK 连续重试，产生多条失败并浪费更多请求。失败事件行又常因 detail 与摘要首行相同而不可展开。

## 调查

- TokenHub 实测同一底层模型有两个 id，各自按分钟计量，但 Foundry 没有等价模型组，也没有按近 60 秒用量选择的分配器。
- Foundry 的事件里没有自动重试证据；三条连续 `Session failed` 来自 Claude SDK 自带的 API-error 重试帧。
- 额度耗尽与临时限流必须分开：配额不会因短退避恢复，且同一 profile 下的不同模型 id 不能证明上游账号额度独立。
- `chat-process-display.ts` 会丢掉与摘要相同的 detail，导致 `Session failed` 行没有可展开内容。

## 修复

- 模型池支持 members、tokensPerMinute 与 weight；分配器按近 60 秒 token 用量估算余量，无配额时按权重轮转，并把决策集中在 `modelpool` 纯函数模块。
- 默认执行模型可保存单个模型或模型池；MCP 的创建与发送会话接受池 id，技能和 Web 中英文同步。
- 结构化限流优先按 `rate_limit_*`、TPM、模型网关、带模型上下文的 429 识别；最多换 3 个池成员，非池会话同 id 最多重试 1 次，指数退避加抖动并保留输入归属。
- 结构化 `billing_error`、`insufficient_quota` 等识别为 `model_quota_exhausted`，Claude 首帧立即停止 SDK 重试；服务端不换 ID、不自动重试，只告警一次。
- Worker 增加 `dispatch_retry` 能力门；旧 Worker 不具备时不产生重试状态并立即告警。已有模型输出时重发中英文“从中断处继续”提示。
- 失败行保留完整 detail，复用 `ProcessDisclosure` 的原生按钮、`TraceChevron`、`aria-expanded` 和可选中文本展开区。

## 部署与版本证据

该终态已部署到 dev：Server/Web `120fe737567f9e88`，Worker `…1794395454`。编排 1/2、429 识别和事件展开均在提交窗口前的部署快照中。

## 检查

- 编排 1：Web tsc、personal-agent/profiles 测试、Skill checksum 与 Worker Skill 5/5 通过；真实浏览器 light/dark 验证默认执行模型、provider 和 notes 顺序，无横向溢出。
- 编排 2：模型池、换 ID、耗尽告警、非池重试、旧 Worker 能力门与重试中取消的 Go 测试通过；Go build/vet、Protocol 3/3、Worker 19/19、Web profiles/usage 测试和 Web tsc 通过。
- 429/事件展开：Protocol 3/3、Worker 4/4、Go 定向测试、Web 相关 21/21 通过；真实浏览器 Enter/Space 展开和文本可选择验证通过。
- PR 合并前继续执行本分支 Go build/vet、Web 与 Worker typecheck。

## 限制

- 池成员没有独立上游账号身份，因此额度耗尽时不尝试换 ID；这避免在同账号上重复消耗。
- 池分配依赖已有 usage 请求记录，缺少记录时使用权重或保守余量。
- 自动重试只对声明 `dispatch_retry` 的新 Worker 生效。

## 验收步骤与预期结果

1. 在 Model providers 创建一个含两个 id 的模型池，并把默认执行模型设为该池；新子会话应记录池 id 和选中成员。
2. 模拟模型 429：事件应显示自动换到另一 id 重试，输入和会话归属不变；非池会话只同 id 重试一次。
3. 模拟 `billing_error` 或额度耗尽文本：不应出现自动换 ID，只出现一次“额度已耗尽”告警。
4. 打开包含 `Session failed` 的长事件：行应可用键盘展开，完整错误文本可选择并换行。
