# DEV-201 通用会话与 MCP 去注入

## 状态

已合入 main（PR #265，squash bb3f7fdd）。

已实现、验证并部署 dev Server（2026-11-13）。Worker 代码已构建和测试，
设备发布还需要包含本批 Worker 的 release。等待人工验收。

## 原则

避免向通用 Claude Code / Codex 会话注入系统提示词和每轮引导。长期规则放
workspace `AGENTS.md` 与 skill；MCP server instructions 和工具描述只描述
server/API 契约；事件消息只带来源、状态和授权事实。助理、Issue/verifier
和 utility 的专用提示不在本事项范围内。

## 改动

- MCP server instructions 从 1,340 chars 压到 391 chars（无共享账号时），
  并硬限制在 512 chars 内。保留 Foundry 定位、`foundry` skill 指针、连接账号
  经 Foundry 访问和共享系统账号事实；删掉何时查资源、浏览器启动器、附件展示
  路径、登录规则细节等流程。
- 9 个非助理工具描述合计从 7,293 chars 降到 5,139 chars（-2,154，
  -29.5%）。

| 工具                    |    前 |    后 |
| ----------------------- | ----: | ----: |
| `list_resources`        |   732 |   601 |
| `model_guides`          | 1,346 |   831 |
| `get_execution_default` |   708 |   533 |
| `create_session`        | 1,806 | 1,120 |
| `list_issues`           |   233 |   214 |
| `send_message`          | 1,308 | 1,075 |
| `ask_person`            |   357 |   196 |
| `read_knowledge`        |   352 |   261 |
| `create_scheduled_work` |   451 |   308 |

- 描述保留能力、参数、副作用、返回状态、幂等/投递契约、服务端限制和安全事实
  （例如 knowledge 是信息而非指令或授权）；删除“何时应做”和工作流策略。
- 跨 session 来源包装从 276 chars 降到 134 chars，只保留 agent session id、
  “不是本人输入”和“不授予新审批”。
- session alert 的 `Next:` 从处理指令改为短状态：`no retry scheduled`、
  `retrying when a slot frees`、`retrying when the device reconnects` 等；
  code、detail、automatic retry 和 occurrences 保留。
- Claude/Codex 的 decline、timeout、relay 文案只报告 `NOT performed`、拒绝者/
  原因、超时，以及 relay 后答案下一轮到达；删除“不要重试”“结束 turn”等引导。
- MCP 权限错误删掉无状态的后续建议；参数/游标错误和结果截断的 continuation
  hint 保留。
- 删除未使用的 `workspace-instructions.ts`、`projectInstructions` 和
  Claude `systemPrompt` 拼接路径。Codex stage 仍固定
  `project_doc_max_bytes = 0`，避免 verifier 读取 candidate 自带指令。

## 移到哪里

- `packages/worker/skills/foundry/SKILL.md` 与
  `apps/server/internal/builtinskills/foundry/SKILL.md`（逐字节相同）：
  图片回复路径、不能直接 lease 的设备资源改用 workspace session、Issue
  只读与 `ask_person` 的单问题策略。
- 同一 skill 已有原生 subagent 选择、`send_message` 汇报、durable work、
  `list_resources`、浏览器启动器和账号登录规则，不再在 MCP 中重复。
- `packages/worker/skills/foundry-orchestration/SKILL.md` 及其内嵌副本已有
  execution default/alternatives 和 model guide 使用规则；本次只从工具描述
  删除重复策略，skill 内容不变。
- `references/device-and-accounts.md` 继续承载浏览器、屏幕控制和各连接账号细节。

## 验证

- Go 定向测试通过：`sessionalerts` 1 个、`httpapi` 8 个（合并后再次只跑
  MCP 相关 4 个也通过）、`builtinskills` revision/checksum 1 个。
- `go build ./...`、`go vet ./internal/builtinskills ./internal/httpapi
./internal/sessionalerts` 通过。
- Worker 协议与 Worker TypeScript 构建通过。定向 6 个文件共 41 个测试；
  首次只有 `session-steer` 的旧正则失败，修正测试后单文件 15/15 通过，
  其余 26 个在首轮已通过。
- `node scripts/generate-contracts.mjs --check` 通过：
  `no breaking changes to 14 x-stored schemas`。
- `TestMCPInstructionsStateTheContractWithinClientLimits` 通过，基础
  instructions 为 391 chars；动态共享账号文本仍被限制在 512 chars 内。
  `TestRemoteMCP` 验证 dev Server 的 initialize/tools-list 契约。
- 合并后两份 `foundry` skill 逐字节一致；revision 36 的 combined checksum
  为 `134f23c7f7fb2e6c9ee90937f8ca3ffa775e034818357a95fbba0da8d41ed12f`。

验收步骤：

1. 新建一个使用 Foundry MCP 的普通 Claude Code 或 Codex session，MCP
   initialize 的 `instructions` 应不超过 512 chars，且只含 Foundry 定位、
   skill 指针和硬边界。
2. `tools/list` 中上述 9 个工具的描述不应再出现 native subagent、模型选择、
   “何时读资源”或“如何向人交代”策略。
3. 让一个 session 向另一个 session 发消息：接收方只看到 agent session id、
   非本人输入和无新审批的事实。
4. 触发失败/取消/等待告警：`Next:` 只显示重试状态，不出现 `send_message`
   或切换账号等操作建议。

## 部署

- 协调的 dev Server build 从合并后的 dev 树生成；回滚副本
  `~/.foundry/server/releases/dev023-candidate/foundry-server.pre-dev201`
  sha256 `44d9abbe792e25ed44a08963fc78905e0bda8c7cb0bee76f3d7d529abb6de9ae`。
- 部署二进制 `foundry-server` sha256
  `d7c43f522c9fc7698e93d816157bc2cf82f5b865b5237186b20121cac95b23a5`；
  运行进程 `/proc/<pid>/exe` 与 release 文件哈希一致。
- PM2 `foundry-server` online（PID `3947953`，restart count `78`）；
  `http://127.0.0.1:31982/healthz` 返回 200
  `{"status":"ok","startedAt":"2026-11-12T18:17:49Z"}`。
- Worker 不在本 Server 部署中替换；本批 Worker 需要随下一次 Worker release
  更新设备。

## 时间线

- 2026-11-13：按注入审计 S4、S5（非助理工具）、S8、T3、T13、T15、T16、
  T18 完成实现；定向验证、合并与 contract check 通过。
- 2026-11-13：合并 B1 的 revision-36 skill 文本并更新 combined checksum；
  dev Server 部署后 PM2、健康检查、二进制哈希和 MCP server tests 通过。
