# DEV-299 Foundry MCP 渐进披露（S1：搜索提示与常驻工具）

状态：S1 代码与测试完成；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）；补丁 `/tmp/DEV-299a.patch`（相对共享树当时状态）。部署后的 haiku 会话实测见下方验收记录。

依据：[.foundry/reports/mcp-progressive-disclosure.md](../../.foundry/reports/mcp-progressive-disclosure.md) §4（树形）、§5（机制）、§7（切片）。

## 问题

Foundry MCP 有 57 个工具（含助理设置），完整定义约 57k 字符。担心每个会话都把全部定义放进上下文。编排者要求先确认两家运行时是否原生延迟，再决定 Foundry 自己要做什么。

## 测量（2026-11-18，synthetic 会话，已请求归档）

| 运行时 × 配置                                                            | 首次请求输入 token                                         | Foundry 工具是否延迟                    | 证据                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude 2.1.311 · `limen_default` · haiku（部署前，现网构建，无 `_meta`） | **44,147**（2 未缓存 + 31,916 缓存写 + 12,229 缓存读）     | **是**                                  | 会话 `sess_1794982322888608490`；转录 `api-request-shape` 行：请求含 13 个内置工具 + `DeferredToolPlaceholder`（defer 标记），`ToolSearch` 在列，无 `mcp__foundry__*` 完整定义 |
| Claude · Tencent TokenHub（deepseek）                                    | 29,034                                                     | **是**                                  | 引自 `sess_1794981520138143213` 的测量回答（本片未复测）：51 个会话中 46 个调用了 ToolSearch                                                                                   |
| Codex 0.169.1 · `codex_local` · gpt-6-luna · low                         | **18,640**（11,392 缓存读）；本线程三次请求合计输入 58,780 | **是**（code mode 的 `ALL_TOOLS` 搜索） | 会话 `sess_1794982324055216623`，rollout `~/.codex/sessions/2026/11/18/rollout-…-01a1ed48-bc1a-7033-a54b-c99f8504bcc3.jsonl`                                                   |

Codex 细节（转录核对）：

- 首个 `additional_tools` 记录只含三个命名空间（`functions` 4 个、`clock` 1 个、`collaboration` 6 个），共 39,259 字符，**没有 foundry 命名空间**。
- 模型的第一次调用是 `exec`：`ALL_TOOLS.filter(x => /get_execution_default/.test(x.name+" "+x.description))`，之后才 `tools.mcp__foundry__get_execution_default({})`。`exec` 的说明写明："Some deferred nested tools may be omitted from this description. They are still available on the global `tools` object and listed in `ALL_TOOLS`." 这就是 Codex 的延迟加载：先搜索，再调用。事件流里对应的是 `mcp_tool_call`，没有 `tool_search_call` 项。
- `ALL_TOOLS` 只给 `{name, description}`，所以 **Codex 看不到 `_meta`**，它按名字与描述文字匹配。

Claude 二进制核对（`~/.foundry-tools/agent-runtimes/claude/2.1.311-sdk-0.3.317/…/claude.exe`）：

- `anthropic/searchHint`：字符串，进入搜索匹配（`searchHint` 小写并截断后参与匹配）。
- `anthropic/alwaysLoad`：布尔 `true` 使该工具不延迟；只有服务器级 `serverDefersAllTools`（默认 false）为真时才被覆盖。

## 决定（编排者）

- 不做元入口工具。Claude 用原生 ToolSearch 披露 57 个真实工具名。
- 三个常驻工具：`send_message`、`list_sessions`、`needs_you`（`needs_you` 只在角色有它的会话里出现）。
- 新增 Foundry 操作放进已有类别工具的 `op`（如 `assistant_settings`），不新增顶层工具。
- Codex 因已延迟，S4（类别入口工具 `foundry_area`）对披露不再必需。是否做，留给编排者决定。

## S1 改动

| 文件                                                  | 改动                                                                                                                                    | 删除行（相对共享树基线） |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `apps/server/internal/httpapi/mcp_tools.json`         | 57 个工具各加一行 `_meta`：`anthropic/searchHint`（类别前缀 + 关键名词）；3 个加 `anthropic/alwaysLoad: true`                           | 0                        |
| `apps/server/internal/httpapi/mcp_tool_hints_test.go` | 新增：每个工具的 hint 以类别开头且 ≤120 字节；常驻集合恰为 3 个；`tools/list` 原样透传 `_meta`，且 `summary`/`limits`/`maxBytes` 不下发 | —                        |
| `docs/where-things-live.md`                           | MCP 类别、常驻工具、新操作规则与测试位置（一条）                                                                                        | 0                        |
| `docs/devlog/DEV-299-mcp-progressive-disclosure.md`   | 本文件                                                                                                                                  | —                        |

- `mcp.go` 不需要改：`tools/list` 已原样下发 `_meta`（只删 `summary`、`limits`、`maxBytes`），测试证明了这一点。
- `mcp_tool_descriptions_test.go` 不需要改：它只统计 `description` 长度，不计 `_meta`。
- 类别分布（实际计数）：sessions & work 12；workspaces & skills 7；devices & resources 9；connectors & accounts 5；models & execution 10；person list & memory 10；issues & knowledge 3；assistant settings 1（合计 57）。报告 §4 的估计数略有出入，以此为准。
- Codex 没有可验证的 hint 键（已在 `codex` 0.169.1 二进制中搜索 `search_hint`、`searchHint`、`always_load`、`alwaysLoad`、`anthropic/`，均无），因此 Codex 侧不加任何 hint。

## 检查

- `gofmt -l` 对新测试文件无输出；`go vet ./internal/httpapi` 通过。
- `go build ./...` 通过（工作树，含共享树的未提交改动）。
- `go test ./internal/httpapi -run 'MCP|Tool|Description|Hint' -count=1`：通过（约 101 秒）。
- 详细运行：`TestEveryFoundryToolHasACategorySearchHint`、`TestToolsListSendsSearchHintsAndAlwaysLoadUnchanged`、`TestMCPGenericToolDescriptionsStateContractsWithoutWorkflowPolicy`、`TestToolsListFollowsTheSessionsRole` 均 PASS。

## 限制

- 已部署 dev（2026-11-18）；haiku 会话的部署后测量见验收记录。
- `alwaysLoad` 的代价：每个 Claude 会话首次请求多出三个完整定义（报告估计约 1.9k token），换来这三个高频工具不需要一次 ToolSearch 往返。尚未实测这个增量。
- 搜索召回（`searchHint` 是否让 ToolSearch 找对类别）未测量。
- Codex 的披露只依赖名字与描述。如果希望 Codex 也能按类别找到工具，类别词要进入 `description`，这会改变 Claude 的描述，需单独决定。
- 工作期间共享树仍在被他人修改（`routes.go` 等 11 个文件在快照后变化）。已重新同步；补丁只包含本片触及的文件，相对于我开始修改时的基线。

## 部署后测量（编排者执行）

1. 部署 dev Server 后，启动一个 haiku · `limen_default` 会话，提示词与部署前相同：`Reply with OK only. Do not use tools.`，`reportBack` 为 false。
2. 读取该会话的 Claude 原生转录（`~/.foundry/connection-data/<…>/claude/projects/-home-windeng-workspace-foundry/<nativeSessionId>.jsonl`）。
   - 预期：`api-request-shape` 的工具列表中，`list_sessions`、`send_message` 以完整定义出现（`needs_you` 视角色而定）；其余 Foundry 工具仍为 `DeferredToolPlaceholder`；`ToolSearch` 仍在列。
   - 对照部署前：13 个内置工具 + 占位符，0 个 `mcp__foundry__*` 完整定义。
3. 第一条 `assistant` 的 usage：计算 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，与 44,147 比较。预期增加约一个工具定义集的 token。注意：同批部署还会带上其他人的改动（系统提示、技能），总数的变化不全归于本片；以第 2 步的工具列表为准。
4. 可选：搜索召回。提示词：`Use ToolSearch to find the Foundry tool that leases a Mac screen, then reply with only its name.` 预期答案 `acquire_resource`。

## 验收步骤（人或编排者）

- 在 dev 的 Claude 会话中，ToolSearch 能按类别词（如"lease screen"、"model provider"）找到对应工具。预期：返回正确工具名。
- 第 1–3 步的转录数字与上表一致，并记录实际增量。
- Codex 会话不受本片影响；无需验收。

## 2026-11-18 dev 验收记录（Agent 代验收，DEV-299a）

- 部署后，haiku 会话加载了 list_sessions 与 send_message，其余工具延迟加载；首次请求 token 为 45,495（对照 44,147）；ToolSearch 找到了 acquire_resource。
