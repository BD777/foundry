# DEV-316 Codex 推理强度跟随模型官方目录

[事项索引](README.md)

状态：**已部署 dev（Server+Web+Worker，train 97，2026-11-19 约 08:35Z）；部署后 conductor 检查通过（见「部署后检查」）；待本人验收**。

## 问题

2026-11-19 反馈：Web 的 Codex 模型菜单里，「6.2 Astra」的推理强度只有 Minimal、Low、Medium、High、Extra high，缺少 Max 与 Ultra，且多出了官方并不提供的 Minimal。

## 事实来源（先于改动读取）

版本：本机 `codex-cli 0.163.0`，二进制 `/home/windeng/.codex/packages/standalone/releases/0.163.0-x86_64-unknown-linux-musl/bin/codex`。

1. **每个模型的目录（权威）**：
   - 实时 app-server `model/list`（仅元数据读取，不发推理请求；账号已登录的本机 CLI）：`gpt-6-astra`（显示名 `GPT-6-Astra`）的 `supportedReasoningEfforts` 为 `low, medium, high, xhigh, max, ultra`，`defaultReasoningEffort` 为 `medium`。同一次读取中没有任何模型列出 `minimal`。
   - `codex debug models --bundled`（同版本内置目录）：`gpt-6-astra` 为 `low … ultra`，默认 `low`；内置目录与实时目录的默认值不同，以实时 `model/list` 为准。
2. **协议枚举（值域）**：`codex app-server generate-ts --experimental` 生成的 `ReasoningEffort.ts` 为 `export type ReasoningEffort = string;`；`codex app-server generate-json-schema --experimental` 中该类型的描述为 “A non-empty reasoning effort value advertised by the model.”（`minLength: 1`，`type: string`）。即 Codex 的值域是开放字符串，由每个模型的目录决定，而不是固定枚举。
3. 未取得 codex-rs 源码（本机只有已安装的二进制）。因此这里的“枚举”结论仅针对已安装的 0.163.0 生成的协议类型。

结论：Codex 对每个模型的推理强度，以该模型在 `model/list` 中列出的值为准；`minimal` 在 0.163.0 中没有模型列出它，但旧的已保存设置可能仍含它，展示上需要诚实保留。

## 根因

Foundry 对 Codex 推理强度的“可选值”有四处各自写死的集合，全都没有读取模型目录：

- Web：`apps/web/src/lib/agent-effort.ts` 的 `codexEfforts = [minimal, low, medium, high, xhigh]`，对所有模型相同。
- 契约：`contracts/models/profiles.yaml` 的 `CodexReasoningEffort` 为同一个五值枚举。
- Server：`store/issue_options.go`、`httpapi/agent_defaults.go`、`httpapi/mcp_model_providers.go`、`personalagent/run/resolve.go` 各有一份集合；MCP 工具 schema（`mcp_tools.json`）也写着 `minimal…xhigh`。
- Worker：`harness/native/native-inspection.ts` 把 `model/list` 的每一行映射成 `{id, label}`，丢掉了 `supportedReasoningEfforts` 与 `defaultReasoningEffort`；内置目录的映射同样丢掉 `supported_reasoning_levels`。Claude 的同一映射也丢掉 `supportedEffortLevels`（见“未改动”）。
- 传输与展示：`AgentModelOption` 只携带 `id / label / contextWindow`；`mergeModelOptionLists` 在配置列表与发现列表同 id 时保留配置项，丢掉发现项的效力信息；Issue 页把模型选项降为 `{id, label}`；多处设置表单只保存模型 id 字符串。
- 展示缺口：未设置推理强度时界面写死显示 “High”，而 Codex 实际使用模型默认值；`ultra` 没有文案，未知值会显示成缺失的 i18n key。

所以：缺 Max/Ultra 的直接原因是 Web 写死列表；Minimal 多出来是同一个写死列表的历史残留。

## 修复

原则：每个模型的推理强度 = 该模型在 Codex 目录中列出的值，按目录顺序；目录没有说明的模型不提供任何档位。已保存的值即使目录不再列出，也原样显示。

- **Worker**：`model/list` 与内置目录两条路径都保留 `reasoningEfforts`（按目录顺序，过滤空串）与 `defaultReasoningEffort`；`isDefault` 随 `model/list` 的默认模型一起保留。两个映射函数导出，便于单元测试。
- **契约**：`CodexReasoningEffort` 改为非空字符串（`minLength 1`，`maxLength 64`），与 Codex 的开放值域一致；`AgentModelOption` 新增 `reasoningEfforts`、`defaultReasoningEffort`、`isDefault`。由 `scripts/generate-contracts.mjs` 重新生成 Go 与 TS 产物，不手改生成文件。
- **Server**：六处写死的 Codex 集合改为共用的 `store.ValidCodexEffort`（非空、≤64 字节、小写字母/数字/`-`/`_`）。Claude 的集合不变（与 SDK 的 `low…max` 一致）。`list_models` 的 MCP 结果带上每个模型的 `reasoningEfforts` 与 `defaultReasoningEffort`，供 Agent 选择合法值。MCP schema 去掉对 Codex 的 `enum`。
- **Web**：
  - `codexEffortOptions(model)` 只返回该模型目录列出的档位；`catalogModel(models, id)` 在 id 为空时取账号默认模型。
  - `effortLabel` 对没有文案的值显示其原名，不再显示缺失 key；新增 `ultra`（en “Ultra”，zh “终极”）与 `effortRuntimeDefault`、`effortNone` 文案。
  - 聊天工具栏：未设置时显示模型默认值（Astra 为 Medium），而不是写死的 High；模型目录没有档位时效力面板说明“该模型的目录未列出推理强度”。
  - `mergeModelOptionLists` 移到 `lib/model-options.ts`，发现项保持完整。
  - 设置类表单（执行默认、Agent 默认、Worker 组成员、个人助理模型设置、设备账号默认、模型提供方编辑）都改为读取所选模型的目录项。
  - Issue 页的模型选项保留发现的目录项。
- **Worker 与 Web 之外未改动**：Claude 的推理强度列表与行为不变。

## 改动文件

| 文件                                                                                                     | 说明                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `contracts/models/profiles.yaml`                                                                         | `CodexReasoningEffort` 改开放字符串；`AgentModelOption` 加三个字段  |
| `packages/protocol/src/contract.gen.ts`、`packages/protocol/src/contract-schema.json`                    | 生成产物                                                            |
| `apps/server/internal/store/profiles_gen.go`、`issues_gen.go`、`sessions_gen.go`、`contract-schema.json` | 生成产物                                                            |
| `apps/server/internal/store/issue_options.go`                                                            | `ValidCodexEffort`；Issue 校验改用它                                |
| `apps/server/internal/store/codex_effort_test.go`                                                        | 新增                                                                |
| `apps/server/internal/httpapi/agent_defaults.go`                                                         | `validEffort` 的 Codex 分支                                         |
| `apps/server/internal/httpapi/mcp_model_providers.go`                                                    | `checkEffort` 的 Codex 分支                                         |
| `apps/server/internal/httpapi/mcp_workspaces.go`                                                         | `list_models` 带出 `reasoningEfforts`、`defaultReasoningEffort`     |
| `apps/server/internal/httpapi/mcp_model_efforts_test.go`                                                 | 新增                                                                |
| `apps/server/internal/httpapi/agent_defaults_test.go`                                                    | 原用例 Codex `max` 已合法，改为不合法的 `Extra High`                |
| `apps/server/internal/httpapi/mcp_tools.json`                                                            | 三处 effort schema 去掉 Codex 的 `enum`，说明改为指向 `list_models` |
| `apps/server/internal/personalagent/run/resolve.go`                                                      | Codex 效力校验                                                      |
| `apps/server/internal/sqlitestore/issue_options_test.go`                                                 | 原用例 Codex `max` 改为不合法的 `Extra High`                        |
| `packages/worker/src/harness/native/native-inspection.ts`                                                | 两条目录映射保留效力与默认值，导出映射函数                          |
| `packages/worker/test/codex-model-efforts.test.mjs`                                                      | 新增                                                                |
| `apps/web/src/lib/agent-effort.ts`                                                                       | 按模型取档位，`catalogModel`，标签回退                              |
| `apps/web/src/lib/model-options.ts`                                                                      | 由 `features/chat/session/model-options.ts` 移入（`git mv`）        |
| `apps/web/src/features/chat/session/use-chat-runtime.ts`                                                 | 导入路径                                                            |
| `apps/web/src/components/agent-runtime/agent-runtime-labels.ts`                                          | 工具栏按所选模型取档位，未设置显示默认                              |
| `apps/web/src/components/agent-runtime/agent-runtime-settings-panels.tsx`                                | 空档位说明                                                          |
| `apps/web/src/components/agent-runtime/runtime-default-fields.tsx`                                       | 接收 `catalog`、`model`                                             |
| `apps/web/src/components/workspace/agent-default-fields.tsx`                                             | `useProfileModels` 返回 `catalog`                                   |
| `apps/web/src/components/workspace/execution-default-fields.tsx`                                         | 按所选模型取档位                                                    |
| `apps/web/src/features/personal-agent/settings-models.tsx`                                               | 按所选模型取档位                                                    |
| `apps/web/src/features/profiles/worker-groups-section.tsx`                                               | 成员档位组件 `MemberEffortSelect`，读取成员所属 Provider 的目录     |
| `apps/web/src/features/profiles/device-account-defaults.tsx`                                             | 保存目录项而非 id                                                   |
| `apps/web/src/features/profiles/profile-editor.tsx`、`profiles-feature.tsx`、`use-model-catalog.ts`      | 目录向下传递                                                        |
| `apps/web/src/features/issues/use-issue-models.ts`                                                       | Issue 模型选项保留目录项                                            |
| `apps/web/src/features/chat/context/chat-session-status.tsx`                                             | 标签回退                                                            |
| `apps/web/src/i18n/locales/en/agents.ts`、`zh-CN/agents.ts`                                              | `ultra`、`effortRuntimeDefault`、`effortNone`                       |
| `apps/web/test/codex-effort-menu.test.mjs`                                                               | 新增                                                                |
| `docs/devlog/DEV-316-codex-efforts.md`、`docs/devlog/README.md`                                          | 本文与索引                                                          |

## 检查

全部在 CanWendeMac-mini（`res_c5f59206bda2897c47c7`，共享租约）上通过 `scripts/remote-check.sh` / `remote-build.sh` 运行，检出的是本工作树的差异（基线 `aa552d8c`）：

| 检查                                                                                                                                                                                                                                                            | 结果                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `node scripts/generate-contracts.mjs --check`                                                                                                                                                                                                                   | PASS                                                                                          |
| `pnpm --filter @foundry/web typecheck`（`--web typecheck`）                                                                                                                                                                                                     | PASS                                                                                          |
| `apps/web/test/codex-effort-menu.test.mjs`                                                                                                                                                                                                                      | PASS                                                                                          |
| Web 生产构建（`remote-build.sh --web`，SHA256SUMS 校验）                                                                                                                                                                                                        | PASS                                                                                          |
| Worker：`codex-model-efforts.test.mjs`（4 项）、`native-inspection.test.mjs`                                                                                                                                                                                    | PASS                                                                                          |
| Worker：`codex-model-catalog.test.mjs` 中 “the execution owner loads the catalog before initialize and retains it on resume”                                                                                                                                    | **FAIL，在基线 `aa552d8c` 上同样失败**（`Cannot identify runtime lease owner`，与本改动无关） |
| Go：`./internal/store -run TestValidCodexEffort`                                                                                                                                                                                                                | PASS                                                                                          |
| Go：`./internal/sqlitestore -run TestIssueRuntimeOptionsPersistThroughFeedback`                                                                                                                                                                                 | PASS                                                                                          |
| Go：`./internal/httpapi -run 'TestListModelsCarriesEachModelsEfforts\|TestWorkerGroupsToolSwitchesMembersLikeThePage\|TestModelProviderToolsManageAnEndpointLikeThePage\|TestResolveAgentLevels\|TestWorkspaceDefaultAgent\|TestListModelsPagesOnlyChatModels'` | PASS（首次运行时 `TestWorkspaceDefaultAgent` 因旧用例而失败，已修正用例后通过）               |
| Go：`./internal/personalagent/run` 编译                                                                                                                                                                                                                         | PASS（无测试文件）                                                                            |
| `gofmt -l`、`prettier --check` 于改动文件                                                                                                                                                                                                                       | 通过（格式化后）                                                                              |

未运行：整包 `go test`、整包 `pnpm test`、`pnpm verify`（按仓库规则只跑定向检查）；未做真实浏览器检查（见下）。

## 部署

需要部署三者，已由 Foundry 的 deploy 流程执行（train 97，2026-11-19 约 08:35Z）：

- **Server**：契约与校验、MCP 工具 schema、`list_models` 输出。
- **Web**：菜单与设置表单。
- **Worker**：`model/list` 与内置目录映射。设备上的 Worker 需用 `update_worker` 更新并核验已加载的版本。

## 真实浏览器检查（部署后执行）

前置：Codex 官方账号已登录，设备在线，Server 与 Web 已部署。

1. 对话页工具栏选择 Codex 账号与模型「6.2 Astra」（目录 id `gpt-6-astra`），打开“推理强度”。
   - 预期：列出 `Low、Medium、High、Extra high、Max、Ultra`，顺序与目录一致；不出现 Minimal。当前值为未设置时，显示 `Medium`（模型默认）。
2. 选择 Max 后刷新页面。
   - 预期：仍显示 Max。
3. 切换模型到 `gpt-5.5`（目录只列 `low…xhigh`）。
   - 预期：列表为 `Low、Medium、High、Extra high`，不出现 Max、Ultra。
4. 在设置 → 执行默认或个人助理模型设置中，选择同一个 Codex 账号，打开推理强度。
   - 预期：与对话页一致；保存 Ultra 后显示 `Ultra`。
5. 将已保存的旧值 `minimal` 留在某个设置里（或以 API 写入），打开对应界面。
   - 预期：仍显示 `Minimal`，不报错；选项列表不包含它。
6. 使用只有端点目录、目录未列档位的 Codex 模型（如 OpenAI 兼容端点）。
   - 预期：推理强度面板显示“该模型的目录未列出推理强度”；不出现写死的五个档位。
7. 中英文切换，检查 `Ultra` / `终极` 与其余档位文案。
8. 窄屏与深色主题下，检查效力面板的说明文字不溢出。

## 限制与待确认

- “Ultra”的中文文案“终极”是本次选定的，待验收确认。
- 目录没有列出档位的 Codex 模型（主要是端点目录）现在不再提供任何可选档位，而不是之前的五个。这是行为变化：Codex 0.163.0 对这类模型的内置目录本身也是 `supported_reasoning_levels: []`，但端点是否实际接受 effort 我们没有验证。需要确认是否接受这一变化。
- 截图中的显示名“6.2 Astra”与目录显示名 `GPT-6-Astra` 不同；本次未改动显示名的来源。
- Claude 的推理强度列表未改。`supportedEffortLevels` 是按模型给出的，Claude 目录映射仍丢弃它；当前 Claude 的 `low…max` 完整覆盖 SDK 的值域，所以没有缺档，但“按模型过滤”属于另一项工作。
- 未取得 codex-rs 源码，值域结论基于已安装的 0.163.0 生成的协议类型与 `model/list`。
- 真实浏览器检查与部署尚未执行。

## 部署后检查

- 2026-11-19，部署后由 conductor（sess_1794766761859841092）在 dev 上检查，编排者转述：Codex 模型 `gpt-6-astra`（6.2 Astra）的推理强度显示 low 至 ultra，与其官方目录一致。原始截图未记入本文件。「Ultra / 终极」文案仍待本人确认。
