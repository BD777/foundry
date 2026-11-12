# DEV-198 project upkeep 的指令文件预算

## 状态

已合入 main（PR #265，squash bb3f7fdd）。

已实现、验证并部署 dev Worker、Server、Web（2026-11-12）。等待人工验收。

## 问题

project upkeep 的 governance 角色会在项目 purpose 或指令文件变化时审阅 `AGENTS.md` / `README.md`，但原 prompt 只检查 stale、conflict 和 duplicate，没有预算或内容膨胀规则。持续追加会让根指令文件接近 Codex 的 32 KiB 共享上限，挤占每轮任务上下文。

## 实现

- governance 输入现在确定性统计根 `AGENTS.md` / `CLAUDE.md` 的行数和 UTF-8 字节数，并附带每文件 200 行、全项目 32 KiB、根文件建议 8 KiB 的预算事实；文件读取失败或截断会列为未计数，不让模型猜数字。见 [assistant/maintenance.go](../../apps/server/internal/personalagent/assistant/maintenance.go)。
- governance prompt 增加常驻内容准入规则：重复或代码可见内容删除；格式/lint 规则交给 linter/CI；长流程移到 project skill、子目录 `AGENTS.md` 或 `docs/` 并留触发指针；冲突/过时引用改正；只针对旧模型弱点的规则删除。
- 超预算或膨胀时 patch 只能拆分或删除，不得新增内容；拆分内容应进入第二个整文件 patch，`@import` 不被视为有效拆分。只有预算 findings 时列出最值得移出的 2-3 节及目标。
- finding 类型新增 `instruction_budget`、`instruction_bloat`，解析器接受两者。
- governance patch 的路径扩展到子目录 `AGENTS.md`、`docs/**/*.md` 和 `.claude` / `.agents` 下的 skill 文件；Server 与 Worker 使用相同边界校验。新文件由 Worker 原子创建，父目录符号链接不能逃出工作区。

## 检查

```text
go test ./internal/personalagent/assistant -run 'TestMaintenance'
ok github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant 0.065s

go test ./internal/httpapi -run 'TestMaintenanceEventCaptureIsIdempotent|TestGovernancePromptIncludesLongInstructionBudget|TestMaintenanceNativeReceiptAndSandboxBoundary|TestGovernanceActivityDoesNotScheduleAnotherReview'
ok github.com/foundry-dev/foundry/apps/server/internal/httpapi 7.073s

go build ./...
go vet ./internal/personalagent/assistant ./internal/httpapi
```

合成项目验证使用 300 行 `AGENTS.md`，其中含一节发布流程；只构造 governance 输入，不调用模型。测试断言输入包含 `lines:300`、精确字节数、超预算事实、预算规则和“不新增内容、只拆分/删除”。

## 部署

- 从三方合并后的 dev 检出构建；二进制 sha256 `568e5824aaac7f96bf020eff9dc7e6902ef918192dba141100203b1cdacd781e`。
- 回滚副本：`~/.foundry/server/releases/dev023-candidate/foundry-server.pre-upkeep-governance`，sha256 `04ef9a75573711518305e343e9c2693c96c80cdc7e2844f85a355796b4560eff`。
- `pm2 restart foundry-server` 后 online，PID `3385262`，restart count `71`；`/proc/<pid>/exe` 与新二进制哈希一致。
- `http://127.0.0.1:31982/healthz` 返回 200，`ready 1.104s after start`；20 秒后 pm2 restart count 仍为 `71`。

## 限制与验收

- 拆分路径已打通到 Worker 写入层；仍不覆盖任意项目文件，只允许经过审阅的指令、文档和 skill 路径。
- 没有发起真实 governance 模型审阅；确定性输入与 prompt 由合成 Server 测试覆盖。

验收步骤：

1. 让一个项目根 `AGENTS.md` 超过 200 行，或加入一段只在发布时使用的长流程。
2. 触发 project upkeep，打开 governance 审阅结果；应出现 `instruction_budget` / `instruction_bloat` finding，并给出具体移出段落和目标位置。
3. 检查任何 patch 只减少或拆分根文件，不应借审阅继续扩写。

## 时间线

- 2026-11-12：拆分路径已落地；Worker `0.5.7-dev.354.geb87723d.local.1794496418`，Server `e1b5c70580d8b0f5072b2a008f2f83d100724311cf218fa0c3e878c9388b85b5`，Web `b1a6c995cdf9f44d`。
