# DEV-150 助理与派出的工作分别选模型

状态：已合入 main（PR #230，squash `f2254d4e`）；单测、真实模型 E2E（dev，e2e-alice 合成数据）与真实浏览器自验通过；已部署 dev（Server、Web）；待本人验收。设计与待决定事项见 [助理编排](../assistant-orchestration.md)。

## 问题

本人（2026-11-09，经编排会话 `sess_1794143153454726480`）：用聪明的模型指挥便宜的模型干活。助理在 Model providers 里选一个配置（或所在电脑的订阅），派到各 Workspace 干活的会话另配一个；这份配置与 Chat 互不干扰，不沿用 Chat 里 Workspace 的默认模型，也不影响 Chat。

## 调查

- 助理的对话经收件箱以 coordinator 角色固定运行快照；派出只能经 `dispatch_item`（`create_session` 对助理拒绝），以 executor 角色解析（`personalagent/run_config.go`、`run/resolve.go`）。executor 不读 Chat 的 `agent_defaults`，但设置页只有“共享默认 + 四个角色覆盖”，没有“派出的工作用另一个模型”这一显式选择；`runDefault` 一设，executor 就跟着助理用贵模型。
- 助理的设置**影响 Chat**：会话不指定账号时，`pickAccount` 的第二优先级是“本人助理的账号”（`defaultAccountOf`，2026-10-15 起）。
- 选中的账号在目标电脑用不了时操作静默等待（`execution_configuration_unavailable`），助理要等下次读清单才知道。
- 业界做法与引用见设计文档 §b。

## 修复

- **设置页“用哪个模型”**（`features/personal-agent/settings-models.tsx`）：两组。“助理”：家电脑上的模型来源、模型、思考强度。“交出去的工作”：与助理相同 / 各电脑的默认 / 指定一个；指定时模型来源按 id 合并各电脑（写明“N 台电脑中 M 台可用”），模型目录从在线的那台读；另选“某台电脑用不了它时”：等待并告诉我（默认）/ 改用那台电脑的默认并告诉我。说明一行“你在项目里自己开的对话不受影响”，并链到 Model providers。记忆与项目整理的覆盖收进“后台整理（高级）”折叠区。控件复用 `SelectMenu`、`SegmentedControl`、`useProfileModels`、`agent-effort`；中英文案。
- **存储**：不加表。助理 = `runDefault`（选择不再带设备，跟随它的派出工作不会被钉在家电脑上）；与助理相同 = 无 `roleOverrides.executor` 且 `delegateModel = same_as_assistant`；各电脑的默认 = `roleOverrides.executor = {profileId: device_default}`；指定 = `roleOverrides.executor`。新字段 `PersonalAgentRunPreference.whenUnavailable`（`wait` | `device_default`，Go 与协议同步，校验）。
- **解析**（`run/resolve.go`）：指定的来源不在目标电脑、或模型不在它的目录，且 `whenUnavailable = device_default` 时改用电脑的默认账号与其默认模型，快照 `selectionReason = unavailable_used_device_default`；否则照旧拒绝、操作等待。拆出 `settle` 读档案并检查模型与强度。
- **`dispatch_item` 的回答加 `helper`**（`mcp_personal_agent.go`）：新帮手预计的账号（profile id，不给登录邮箱）、运行时、模型、强度与原因；用不了时 `unavailable` 与提示。工具说明同步。
- **与 Chat 隔离**（`session_accounts.go`、`agent_defaults.go`）：删除 `defaultAccountOf`，`pickAccount` / `resolveAgent` 不再以助理的账号为偏好；`models-and-accounts.md` 同步。

## 检查

- Go：`TestHelperModelIsTheAssistantsSecondChoice`（帮手用指定的模型；模型或账号不在时拒绝并在预览里说明；允许时改用电脑的默认并记原因；助理的选择不变）、`TestChatAccountIgnoresTheAssistantsChoice`（助理与帮手都选另一账号时 Chat 的账号不变）、`TestHelperChoices`（三种选择与校验）；httpapi 中助理与账号相关 19 个测试、`personalagent`、`run`、`store` 通过。
- Web：`personal-agent.test.mjs` 28 项（新：两组分别选择、三种帮手模式写入的设置、未选来源前不保存、用不了时的选择）；`tsc`、`audit:ui` 15 项（提示审计基线去掉 `rolesIntro` 一项）。
- `scripts/check-changed.sh`：prettier、gofmt、protocol 构建与测试、Web tsc 与测试、Worker tsc、Go 测试、audit:ui / contract / modules 全部通过。

## 部署

- 2026-11-09 05:25（UTC+8），持 `/tmp/fdy-deploy.lock`，本分支对 `origin/main` `08add543` 的 diff 以 `git apply --3way` 应用到 `~/workspace/foundry`；`go build` 后替换 `releases/dev023-candidate/foundry-server`（旧版留作 `foundry-server.pre-dev150`），`pm2 restart foundry-server`（未用 `--update-env`），本机 `/healthz` ok；Web `9bdc17f82ea8ab38`（上一版 `e1ea9c39ac09cc7c`，回滚副本 `~/.foundry/releases/dev150-web/`）。无数据库结构变化，未做 DB 备份。
- 05:36 补部署 Server（`helper.account` 改为 profile id；旧版 `foundry-server.pre-dev150b`）与 Web（模型目录读在线的电脑）；05:45 Web `e08ddc07b2c45f50`（文案）。此时主仓库里还有 DEV-151（Model providers 的 MCP 工具，另一会话）05:29 应用的改动，05:36 的 Server 构建包含它；两者文件不重叠（`mcp_tools.json` 各改不同条目）。
- Worker 无改动。

## E2E（dev，真实模型）

e2e-alice，合成设备 VM-4-8-debian（`dev_a870ddf7-…`，DEV-148 的合成 Worker，状态目录 `~/.foundry/dev148-acceptance/`，以 `dev150-synthetic-worker` 单元临时运行）与合成工作区 `ws_68dbe9ca-…`（`~/dev148-synthetic-workspace`）。助理原在离线的 DEV023 合成设备上，搬家到 VM-4-8-debian（新助理工作区 `ws_4e5616b1-…`）并恢复运行。密码只由脚本从仓库外文件读入，cookie 在 0700 临时目录。

- 设置：助理 Codex `gpt-6-astra` · high；帮手指定 `codex_local` · `gpt-5.6-luna` · low；该工作区 Chat 默认设为 `codex_local` · `gpt-6.1-terra` · medium。
- (a) 让助理“在『dev148-synthetic-workspace』新建 dev150/hello.txt，交给帮手”：助理会话 `sess_1794173366864468910` 为 `gpt-6-astra` · high；`dispatch_item` 回答带 `helper: {runtime: codex, model: gpt-5.6-luna, effort: low, reason: configured}`；帮手 `sess_1794173405584453378`（父会话是助理）为 `gpt-5.6-luna` · low，没有用工作区默认的 `gpt-6.1-terra`；文件内容正确，助理核实后回复。
- (b) 帮手改为 `claude_local`（该设备 Claude 未登录）+ “改用那台电脑的默认”：`helper.reason = unavailable_used_device_default` 并附提示；助理当场回复“原先选定的方式在这里无法使用，这次按你允许的备用方式处理”；帮手 `sess_1794174001844319081` 在 `codex_local` 默认模型上完成，助理汇报“实际用的是 gpt-6.1-sol，已从执行记录确认”。
- (c) 同一工作区在浏览器里新开 Chat：请求体 `model: gpt-6.1-terra`、`codexReasoningEffort: medium`，会话 `sess_1794174201770648100` 记录相同。
- 设置页（真实 Chromium，alice 账号，中文）：浅色 / 深色 × 1440 / 390 无横向溢出、无页面错误；键盘在“帮手用”分段控件上用方向键移到“指定一个”；模型来源下拉每项写“5 台电脑中 N 台可用”；“后台整理（高级）”折叠区可展开。截图在本会话工作区 `.foundry/attachments/20261109-dev150/`。
- 收尾：Chat 与两个帮手会话已归档；`dev150/` 合成文件已删除；工作区 Chat 默认已清空；助理恢复为停止状态（家留在 VM-4-8-debian，原 DEV023 设备离线无法搬回）。合成 Worker 单元仍在运行，供 DEV-151 的 E2E 使用，由其结束后停止。

## 限制

- 助理与帮手在 E2E 中是同一个 Codex 订阅的两个模型；“助理用服务端 API、帮手用订阅”的组合只有单测覆盖（解析对两类来源同一路径）。
- 设计 §f 的其他决定（后台整理用哪个模型、续用已有会话时的模型、回答识别 P2 去留、助理停下时帮手的提问）未实现，等本人决定。
- 续用已有帮手（`dispatch_item.sessionId`）时，如果它的模型与新的帮手模型不同，仍按原规则等待（`owner_configuration_differs`），见设计 §f-4。

## 验收步骤

1. 打开“助理设置 → 用哪个模型”。预期：两组“助理”“交出去的工作”；助理的模型服务只列助理所在电脑上的来源；下方写明项目里自己开的对话不受影响，并有“在 Model providers 管理 ›”。
2. 在“交出去的工作”选“指定一个”，选一个便宜的模型服务、模型和思考强度，保存。预期：下拉里每个来源写“N 台电脑中 M 台可用”；保存后再打开仍是这个选择。
3. 对助理说一件要在某个项目里做的小事。预期：它派出的会话（点开助理回复里的链接）用的是第 2 步的模型；助理自己的对话仍是“助理”一组的模型。
4. 在同一个项目里自己新开一个对话。预期：模型是这个项目自己的默认，不是第 2 步的。
5. 把“交出去的工作”指定为某台电脑上没有的来源，“某台电脑用不了它时”选“改用那台电脑的默认，并告诉我”，再让助理派活。预期：助理一开始就说这次用了备用方式，完成时说出实际用的模型。改回“等待，并告诉我”再试：助理说明缺什么、去哪里修，工作不开始。

## 时间线

- 2026-11-09 04:52–05:40 UTC+8：读文档、devlog 与代码，业界调研（子 Agent），写 `docs/assistant-orchestration.md`，向编排会话报告设计（`sess_1794143153454726480`）。
- 05:00–05:46：实现、测试、部署 dev、E2E 与浏览器检查（本会话，worktree `../foundry-assistant-orch`，分支 `feat/assistant-orchestration`）。
- 2026-11-09 06:10 UTC+8：PR #230 CI（verify、web、packages、go）全部通过后 squash 合入 main（`f2254d4e`）。dev 的 Server / Web 已是同一份代码；Worker 无改动。
