# DEV-177 · 用量统计、子会话告警与 MCP 体积预算

## 问题

模型请求虽然有 token 记录，但没有可靠的成本估算、统计趋势和失败回合速度；Codex 的估算 tok/s 又因请求计时锚点错误被放大了几十倍。子会话失败、取消、卡住、等槽或设备离线时，发起者不会收到系统告警。MCP 的 `list_session_work` 等工具一次返回过多文本，挤占调用方上下文。

## 调查

- 价格数据没有内置来源，模型 id 的 provider 前缀和上下文后缀也没有统一规范化；重算历史时还必须保留上游实际报告的金额。
- Codex token usage 常在一个请求的最后一个输出 item 之后才到达；旧逻辑只测最后工具完成到 usage 更新的时间。
- 子会话告警需要独立 incident 生命周期和恢复状态，不能混入普通结果汇报或文本去重。
- dev 数据库副本中 `list_session_work` 默认输出约 129 KB；多个列表工具的默认视图也不满足小而可分页的约束。

## 修复

- 内嵌 LiteLLM 价格快照，按 `reported > custom > estimated > unknown` 计价，支持 provider 前缀/上下文字缀规范化和历史重算；Model providers 可编辑逐模型四档价格。
- 新增 Usage 页面和按范围补齐的时间桶，展示成本、token、请求速度与模型分布；缺失系列补 0，面积图使用折线。
- Codex 请求以回合或整批工具结束为起点，以最后一个 reasoning/message/tool item 为终点；Web 丢弃不可信的过短或过高估算。
- 新增持久化 `session_alerts`，对失败、取消、blocked、等槽和设备离线去重计数，在父会话空闲时用 `turn_end`、忙碌时用 `boundary` 投递。
- `list_session_work` 改为默认 20 条摘要并支持 status/session/offset/limit/cursor；MCP 统一文本预算默认 12 KB、最大 32 KB，超限返回续读方式并记录日志。
- 本 PR 的 profiles/sessions 契约与 profile 页面是混文件；其中也包含模型池、模型心得和默认执行模型 schema，供后续主题直接使用。

## 部署与版本证据

该终态已部署到 dev：Server/Web `120fe737567f9e88`，Worker `…1794395454`。统计页和用量拆分来自 S-3/S-4；子会话告警、Codex tok/s 和 MCP 预算均在同一部署快照中。

## 检查

- S-3：Go build/vet、价格规范化与历史重算测试、Profile 价格持久化、usage API 聚合、Web profiles 19/19、Web typecheck 通过。
- S-4：Usage 指标与图表测试通过；真实浏览器浅色、深色、390 px 均验证图表 SVG、图例、坐标轴和非空像素；最后 `usage-feature` 4/4 与 Web tsc 通过。
- Codex tok/s：Worker tsc、`codex-app-server` 22 通过/1 skip、请求流 10/10、Worker turn usage 12/12、Web 相关 21/21 和 Web tsc 通过。
- 告警：Go 告警/失败/取消/等槽/离线/父忙闲测试、SQLite ownership、Skill revision、Go build/vet 通过。
- MCP 预算：默认 `list_session_work` 从 129,464 B 降到 4,875 B，109/109 项分 9 页无重复；Go build/vet、目标测试、Worker tsc、Skill 5/5 和逐字节同步通过。
- PR 合并前继续执行本分支 Go build/vet、Web 与 Worker typecheck。

## 限制

- LiteLLM 价格是快照，未知模型仍显示 unknown；网络刷新失败时继续使用当前快照。
- MCP 预算按 UTF-8 文本字节计算，图片媒体继续沿用原有大小限制。
- `list_models` 的 120 模型行为使用合成目录验证，dev 的 TokenHub daemon 在只读副本上离线。

## 验收步骤与预期结果

1. 打开 Usage：切换 24 小时、7 天与自定义范围，时间桶数量应完整，缺失系列补 0，模型中可选择自定义价格来源。
2. 运行一个 Codex 回合：tok/s 应处于合理范围，过短计时或超过 1000 tok/s 的估算不应显示。
3. 让子会话失败或取消后保持父会话空闲：父会话应收到一条系统告警；重复状态不应重复刷屏，恢复后销案。
4. 调用 `list_session_work` 不带参数：结果应简洁且不超过 12 KB；继续使用 cursor 应能无重复读完所有项。
