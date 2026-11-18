# DEV-302 `foundry` CLI 在真实外部 Agent 中验证（MCP-1）

状态：目标达成（外部 Agent 经 CLI 完成派出、观察、读取产出、归档）；CLI 小修复代码与 worker 测试完成；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。补丁 `/tmp/DEV-302.patch`（相对共享树，`git apply --check` 通过）。

依据：[roadmap MCP-1](../roadmap.md#foundry-mcp--cli)；设计 [session-orchestration-design.md 实现边界](../session-orchestration-design.md#实现边界)。

## 验收目标

一个 Foundry 之外的 Agent（普通 Claude Code 或 Codex 进程，从本机 shell 直接启动，不经 Foundry）只靠 `foundry` CLI 完成：在工作区 `ws_8d046eba-109d-4017-b22f-6311250f90a7` 派出一个回答当前日期的会话，等它结束，读回答与产出，然后归档。

## 外部运行记录

运行环境：从 Foundry 会话 shell 启动时先清空 `FOUNDRY_*`、`CLAUDE_CODE_*`、`CODEX_*` 等变量（否则进程不是外部的）；`HOME` 保持真实，因此凭据走设备配对（`daemon-config.json` 的设备凭据，以设备主人身份、限于设备工作区）；运行时配置目录放在 `$TMPDIR`。

| 次序 | 运行时                           | 结果                               | 原因                                                                                                                                                                       |
| ---- | -------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Claude Code 2.1.295 · haiku      | 未开始                             | 设备上的 Claude 登录已过期：`Failed to authenticate: OAuth session expired and could not be refreshed`。profile `claude_local` 同为 `missing_auth`。未刷新、未改动该登录。 |
| 2    | Codex 0.163.0 · gpt-6-luna · low | 失败：`foundry: command not found` | Codex 的 shell 工具走 `/bin/bash -lc`，登录 PATH 里没有 `foundry`（见下「发现的阻塞」）。                                                                                  |
| 3    | 同上，改用绝对路径               | 超时，无产出                       | 后台 shell 的 stdin 未关闭，`codex exec` 停在 "Reading additional input from stdin"，没有写入任何线程条目。属于本次测试的运行方式问题，与 CLI 无关。                       |
| 4    | 同上，stdin 关闭                 | **达成**                           | 见下。                                                                                                                                                                     |

### 成功运行的转录摘录（第 4 次）

Agent 只拿到任务和 `foundry` 的绝对路径（不在 PATH 上），没有拿到任何子命令或参数说明；它自己用 `--help` 找到了用法。令牌与设备凭据未出现在输出中。

```text
$ foundry --help                                   # 顶层用法，列出全部动词
$ foundry session get --help                       # exit 1: "foundry session get reads no --help (it reads --workspace)"
$ foundry session create --help                    # exit 1: 同上，但错误信息列出了全部接受的 flag
$ foundry model list --help                        # exit 1: 同上
$ foundry profile list --workspace ws_8d04…        # 列出 profile（claude_local 缺登录；Tencent TokenHub、Limen 可用）
$ foundry model list --workspace ws_8d04…          # exit 1: "foundry: unknown profile: "（空 profile 名，未说明需要 --profile）
$ foundry session create --workspace ws_8d04… --profile prof_2c4c55cc-… \
    --model deepseek-v4.1-flash-1017 --prompt "Reply with today's current date only, in YYYY-MM-DD format."
  → { "id": "sess_1795000160522381635", "status": "queued", … }
$ foundry session get sess_1795000160522381635 --workspace ws_8d04…   # 手动轮询：running，running，completed（共 3 次）
$ foundry session thread sess_1795000160522381635 --workspace ws_8d04…  # 读取对话，含 3 条消息（模型的中间说明也在其中）
$ foundry session changes sess_1795000160522381635 --workspace ws_8d04… # { "files": [], "more": "Its tools wrote no files…" }
$ foundry session archive sess_1795000160522381635 --workspace ws_8d04… # { "archived": ["sess_1795000160522381635"], "blockers": [] }
最终回答：session id sess_1795000160522381635，日期 2026-11-18，无文件变更；CLI 不便之处：无单动词 --help、model list 需要 profile、没有等待命令。
```

- 会话 `sess_1795000160522381635`（synthetic，已归档；归档后不再出现在默认列表中）。`get` 的 `lastAnswer` 字段直接给出 `2026-11-18`，Agent 其实不需要 `thread`。
- 只有这一个 synthetic 会话被创建；失败的运行没有在工作区留下会话。

## 能否自行发现用法

能。Agent 从 `foundry --help` 得到全部动词与 flag，再用各动词的错误信息补足 flag 列表。缺口是：动词的 `--help` 不被接受，且 `foundry session create` 的用法行不显示 `--workspace`（但它可用，footer 也写明了）。

## 发现的阻塞与摩擦

1. **外部 Agent 的 PATH 上没有 `foundry`（阻塞，未修）**：安装只写 `~/.foundry/bin/foundry-worker`（`packages/worker/src/install/worker-install.ts:115` 的包装脚本），没有写 `foundry`；登录 PATH（`~/.profile`、`~/.bashrc`）也不含 `~/.foundry/bin`。设备上的 `foundry` 只能用绝对路径调用。属于 Worker 安装与更新的改动，超出小 CLI 修复范围，见「建议（未做）」。
2. **没有等待命令（已修）**：`docs/session-orchestration-design.md` 写了 `session wait`（`--timeout-ms`），但命令表与安装的 CLI 都没有。Agent 只能手动重复 `session get`。
3. **动词不接受 `--help`（已修）**：`session get --help` 之类报 "reads no --help"。
4. **`model list` 缺 `--profile` 时报 `unknown profile: `（空名）（未修，服务端）**：错误信息应说明需要 `--profile`（见 `list_models` 工具实现）。
5. **用法行不列 `--workspace`（已修，随动词 `--help` 一并显示）**。

## 修复（CLI，小改动）

- `foundry session wait <sessionId> [--workspace <id>] [--timeout-ms <n>]`：每 2 秒调用一次 `get_session`，状态不再是 `queued` / `running` / `blocked` 时打印与 `session get` 相同的回答；默认超时 10 分钟，超时报错 `session is still <状态> after <n> ms; run session wait again to keep waiting`（退出码 1）。`--timeout-ms` 只由 CLI 读取，不发给工具（命令表新增 `cliFlags` 字段，`foundry-cli-commands.ts`）。
- `foundry <command> <verb> --help`：打印该动词的参数、flag（含 `--workspace`）与所调用的工具，不调用服务器；`foundry session --help` 打印完整用法。
- 用法行与动词 `--help` 共用 `flagSummary`，`cliFlags` 也会列出。

改动文件：`packages/worker/src/agent-surface/foundry-cli-commands.ts`、`packages/worker/src/foundry-cli.ts`、`packages/worker/test/foundry-cli.test.mjs`。

## 验证

- 在 CanWendeMac-mini（compute 租约 `lease_d33a1688e27ab61b95e7`，shared，forCommands）上运行 `remote-check.sh --tree <worktree> --worker test foundry-cli.test.mjs foundry-skill.test.mjs`。worktree 为 HEAD `e03dfd61` 加共享树的全部差异，再加本次改动。
- `tsc`（worker 构建）通过。
- 新增 3 个测试通过：`session wait polls a session until it settles, then prints its answer`、`session wait stops at --timeout-ms and says the session is still running`、`a verb's --help prints its flags without calling the server`。其余 `foundry-cli.test.mjs` 测试全部通过。
- 失败 1 项（与本次改动无关）：`foundry-skill.test.mjs` 的 "every CLI command calls a Foundry tool with arguments it takes"。共享树的 `mcp_tools.json` 新增了 `issues`、`assistant_settings`、`assistant_channels`、`foundry_settings` 四个工具，但 CLI 命令表没有对应命令（静态核对：这四个名字在 HEAD 的目录中都不存在，在命令表中也都没有）。这是共享树里其他进行中工作的 CLI 对齐缺口，需要编排者分派。

## 建议（未做，需要决定）

1. **让 `foundry` 在设备 PATH 上可用**：Worker 安装/更新时同时写 `foundry` 包装脚本（与 `foundry-worker` 同一方式），并确保它所在目录在登录 PATH 中（例如 `~/.local/bin`）。这是 Worker 改动，需要编排者批准后执行；本次没有改动设备上的 `~/.local/bin` 或 `~/.foundry/bin`。
2. **`model list` / 类似工具的空 profile 错误**：服务端在 profile 为空时应报 "needs profile (see foundry profile list)"。属于 Server 改动。
3. **CLI 与目录对齐**：为 `issues`、`assistant_settings`、`assistant_channels`、`foundry_settings` 补命令，或在 `foundry-skill.test.mjs` 中明确哪些工具只给会话用。

## 验收步骤（部署后，由人或编排者执行）

1. 更新设备 Worker（`update_worker`）后，`foundry session wait --help` 显示 `foundry session wait <sessionId> [--workspace <string> --timeout-ms <number>]`，且不发起任何服务器调用。
2. 在 ws_8d046eba 派出一个 synthetic 会话（`foundry session create --workspace … --prompt "…"`），然后 `foundry session wait <id> --workspace …`：应一次性返回 `status` 为 `completed` 的回答，`lastAnswer` 有内容。
3. `foundry session wait <id> --timeout-ms 1` 对一个仍在运行的会话：退出码 1，错误信息含 `still running after 1 ms`。
4. 归档 synthetic 会话（`foundry session archive <id> --workspace …`），返回 `archived` 含该 id。

## 限制

- 设备上安装的 CLI（`0.5.7-dev.368`）还没有 `session wait` 和动词 `--help`，直到 Worker 更新后才生效；因此修复后的 CLI 没有被外部 Agent 再次运行，只在 worker 测试中验证。
- 设备上 Claude 登录已过期，Claude 路径未能运行；外部 Agent 只跑了 Codex gpt-6-luna。
- Codex 运行使用 `-s danger-full-access`：`CODEX_HOME` 放在 `$TMPDIR` 时，Codex 拒绝创建沙箱辅助程序（`bwrap: execvp codex-linux-sandbox`）。该 Agent 只被告知使用 `foundry`，运行目录为空临时目录。
- 第 4 次运行的 stdout 事件流在本地留存；Codex 的线程记录也已核对（`thread_items` 表）。
- 外部 Agent 的会话使用了 `Tencent TokenHub (Claude)` profile 与 `deepseek-v4.1-flash-1017`（Agent 认为是最便宜的可选项）。

## DEV-302b：CLI 对齐、`foundry` 上 PATH、`model list` 提示

状态：代码与测试完成；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。合并补丁 `/tmp/DEV-302b.patch`（相对共享树，包含 DEV-302 与本次改动）。

### 改动

1. **工具与命令对齐**（`packages/worker/src/agent-surface/foundry-cli-commands.ts`）。四个缺口的处理：
   - `issues`：挂在 `issue` 组下，每个 op 一个动词，`op` 固定为动词：`issue schema|validate|create|draft|comment|retry`。约定与 `model-guides` 组相同（`fixed: { op }`）。
   - `assistant_settings`、`assistant_channels`：新组 `assistant-settings`（get / update / notify-instances / notify-find-chat / notify-test）与 `assistant-channels`（list / peers / test / create / update）。**选择的约定：保留命令，由服务端拒绝非 personal_agent 调用方**，与 `assistant` 组现有工具一致；没有加排除清单。`ask_person` 的排除保持不变。
   - `foundry_settings`：新组 `foundry-settings`（get / update / undo）。
   - 技能：`packages/worker/skills/foundry` 与 `apps/server/internal/builtinskills/foundry` 不列 CLI 命令（测试禁止技能列 `foundry …`），无需改动。
   - `foundry-cli.ts` 文件头的命令清单同步更新。

2. **`foundry` 命令随安装写出**（新文件 `packages/worker/src/install/foundry-command.ts`）：
   - `<state>/bin/foundry`：sh 包装，`exec node <current>/…/dist/foundry-cli.js "$@"`，与 `foundry-worker` 同一方式，更新时无需改写。
   - 若 `~/.local/bin` 存在且在 PATH 上，则链接 `~/.local/bin/foundry` 指向上述包装；否则不链接，并输出完整路径与"把该目录加入 PATH"的提示。**不编辑任何 shell rc 文件。**
   - 不覆盖他人程序：目标位置是非 Foundry 文件（或指向非 Foundry 文件的链接）时保留原样并报告；`<state>/bin/foundry` 本身被他人占用时同样保留。
   - 触发点：`install`、`update`（`reportWorkerShim`），以及**每次 daemon 启动**（`daemon-connection.ts` 的 `connect()` 调用 `refreshFoundryCommand`，仅对已安装的 runtime 生效）。daemon 启动这一步是必要的：执行 update 的仍是旧版 Worker 代码，它不写 `foundry`；新版本在 update 重启后启动时补上，已有设备无需再 update 两次。
   - `worker-install.ts` 的 `writeWorkerShim` 改用同一个 `writeCommandShim`，输出内容不变。

3. **`model list` 无 `--profile`**：原先报 `unknown profile: `（空名）。根因在服务端 `listModelsForMCP`（`apps/server/internal/httpapi/mcp_workspaces.go`）：空 `profileId` 落到"未知 profile"分支。CLI 的 `--profile → profileId` 映射正确，未改。现在返回 400：`list_models needs a profileId: list the profiles with list_profiles (foundry profile list), then pass one as profileId (--profile)`。

### 各平台行为

- 代码路径在 macOS 与 Linux 相同。
- macOS：默认 PATH 不含 `~/.local/bin`，除非使用者自己加入，否则只输出路径提示，不链接。
- Linux：Debian/Ubuntu 的 `~/.profile` 在登录时把**已存在**的 `~/.local/bin` 加入 PATH。因此目录在登录前存在时链接在新登录 shell 中生效；安装过程中新建的目录需重新登录。
- 测试在 CanWendeMac-mini（macOS）上运行，但链接用的是临时目录，未触碰真实 `~/.local/bin`。

### 验证

- CanWendeMac-mini（macOS，compute 租约 `lease_2f9e1c3527b456091b82`，shared）：
  - Worker 构建（tsc）：PASS。
  - Worker 测试 `foundry-cli`、`foundry-skill`、`worker-install`、`worker-runtime`、`foundry-command`：36 通过，0 失败，1 跳过（既有用例 "retrying an installed server version…"，与本次改动无关）。
  - 新增 6 个 `foundry-command` 测试通过；`foundry-cli` 表驱动测试新增 9 个 CLI 参数用例通过。
  - `foundry-skill` 的 "every CLI command calls a Foundry tool…" 在共享树上失败，本次通过。
- Go：`go test ./internal/httpapi -run TestListProfilesShowsAssignedModelServices` 通过（含新增的无 profile 断言）。
- prettier `--check`：触及的文件全部通过；gofmt 无输出。
- 未运行：完整 Worker 测试套件、整个 `internal/httpapi` 包、部署。

### 限制

- 设备上的 `foundry` 只有在该设备 update 或 daemon 重启后出现（旧 Worker 不写它）。
- 新增的 CLI 动词未在真实外部 Agent 中再跑（同 DEV-302 限制）。
- 悬空符号链接（指向已删除 stack 的 `bin/foundry`）被视为他人占用，不覆盖；需要人工删除。

### 验收步骤（部署并 `update_worker` 后）

1. `~/.foundry/bin/foundry --help` 可运行；若 `~/.local/bin` 在 PATH 上，`command -v foundry` 指向 `~/.local/bin/foundry`。
2. `foundry model list --workspace <id>` 报 "list_models needs a profileId…"，不再报 `unknown profile: `。
3. `foundry issue draft <issueId> --content-file <file> --request-id <key>` 返回 `issues` 工具的结果（需要有效 requestId）。
4. `foundry foundry-settings get --area devices` 返回设备列表；`foundry assistant-channels list` 在非 assistant 会话中被服务端拒绝（预期行为）。

## 2026-11-18 dev 验收记录（Agent 代验收，DEV-302 / 302b）

- 外部 Codex CLI agent（sess_1795000160522381635）只用 `foundry` 完成创建、轮询、读取、归档。
- train 84 之后，`~/.foundry/bin/foundry --help` 在 sg-chaos 上可运行。
