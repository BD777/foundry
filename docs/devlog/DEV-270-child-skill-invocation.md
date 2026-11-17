# DEV-270 编排者的子会话调不动 `/foundry-orchestration`

状态：已部署 dev（2026-11-17/18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #275）。实现与自验证完成；Claude 与 Codex 子会话的真实调用已于 2026-11-18 复验通过（见下）。

## 问题

2026-11-17，`sess_1794903494975054964`（Claude 编排者，由本人用 `/foundry-orchestration` 启动）派出 Codex 子会话 `sess_1794903766920178431`，brief 写的是「请按 foundry-orchestration skill 的方式工作」。子会话的 Loaded skills 里有 `foundry-orchestration`，但它用 rg 搜了一分钟找不到，随后走了本人 AGENTS.md 指定的 `relay-subagent` 路径，因 `model_hub/es1_orange_o50` 凭据不可用而失败，最后自己做完了任务。

## 排查

- 只读核对子会话与父会话的事件与 brief。
- **搜索为何找不到**：Foundry 把选中的 skill 以符号链接放进工作区 `.agents/skills/<name>`。ripgrep 默认不进入符号链接目录，所以 `rg -l` 与 `rg --files -g` 都搜不到它；`cat .agents/skills/foundry-orchestration/SKILL.md` 却能读到。子会话按名字搜、没有直接读路径，因此绕了一圈。符号链接本身不改。
- **斜杠输入的去向**：Web 输入框选中 skill 后插入的是纯文本 `/<name> `（`message-composer.tsx`），服务端不做转换。
  - Claude：启动时 `claudeManagedPrompt` 把开头的 `/name` 改成 `/foundry-workspace:<name>`（skill 随本地插件 `foundry-workspace` 提供）；插入到运行中回合的 steer 不经过这一改写。
  - Codex：提示词原样作为文本进入 `turn/start`，没有任何改写，`/foundry-orchestration` 对 Codex 只是普通文本。
- **Codex 的显式调用形式**：在 byte-dev 的托管运行时 Codex 0.169.0（`~/.foundry-tools/agent-runtimes/codex/current.json`）上探测：
  - `{type:"skill", name, path}` 与 `{type:"mention", …}` 两种输入项被接受、不报错，但**不注入** SKILL.md 正文。
  - 文本里的 `$<name>` 注入正文，无需工具调用；`agents/openai.yaml` 中 `allow_implicit_invocation: false` 时仍然注入。
  - 纯文本与 `/<name>` 不注入。

## 修复

- 新增 `packages/worker/src/skills/skill-invocation.ts`，一个解析器：`leadingSkillInvocation` 按 `claudeManagedPrompt` 原有的名字规则（name、invocationName、aliases）找开头的 `/name`。
  - `claudeManagedPrompt`（Claude）：改为 `/foundry-workspace:<name>`，行为不变。
  - `codexManagedPrompt`（Codex）：改为 `$<name>`，草稿 skill 不改（与 `linkCodexSkills` 一致）。
- 使用位置：
  - Codex 启动：`codex-turn.ts` 对提示词调用 `codexManagedPrompt`（`observeInput` 仍用原文）。
  - Codex steer：`codex-stream.ts` 的 `applySteer` 在包装发送者信息之前改写。
  - Claude steer：`claude-turn-controls.ts` 的 `steerClaudeTurn` 在包装之前改写（新增）；`text` 用于回答问题的判断不变。
- 内置 `foundry-orchestration` 增加一行（「Split the work」末尾）：「To have a child orchestrate, begin its prompt with /foundry-orchestration.」两份副本保持一致，revision 7 → 9（Claude 与 Codex 同时；revision 8 已由 DEV-269 占用，本次在其之上 rebase）。另加一节「Keep the pipeline fast」（交付与验证的速度做法，编排者决定放进 skill）。`disable-model-invocation` 不变。
- 符号链接不动；提示词文本不改。

## 验证

- 解析器与两种改写：`packages/worker/test/skill-invocation.test.mjs`（别名、非 skill 的 `/x` 保持文本、非开头不匹配、草稿不改、Codex 启动输入为 `$name` 文本）。
- Codex steer 改写与 Claude steer 改写：`packages/worker/test/session-steer.test.mjs` 新增两个用例。
- 已有 `workspace-draft-skills.test.mjs` 的 Claude 用例改为从新模块导入。
- 见本文末「检查结果」。

## 验收步骤（部署后）

1. 在 byte-dev 的 Codex 工作区，由 Claude 编排者派子会话，提示词以 `/foundry-orchestration` 开头。预期：子会话直接按编排者方式工作，不再 rg 搜 skill。
2. 同样的子会话改用 Claude 运行。预期：Claude 一侧同样进入编排模式（这一步尚未在真实子会话上验证）。
3. 运行中的 Codex 会话里 steer 发送 `/foundry-orchestration …`。预期：回合收到 `$foundry-orchestration …`。

## 限制

- 只在 Codex 0.169.0（byte-dev 托管运行时）探测过输入项行为；其它版本未验证。
- Claude 一侧的 `/foundry-workspace:` 形式和 steer 路径未在真实子会话上验证，待部署后由编排者验证。
- 改写只作用于提示词开头；若提示词前面有「导入的上下文」前缀，与 Claude 原有行为一致，不会改写。

## 检查结果

- 本地 Linux（worker dist，临时 state root）：`skill-invocation`、`workspace-draft-skills`、`foundry-skill` 19/19；`session-steer` 17/17（含两个新 steer 用例）；`turn-usage`、`session-launch-options`、`codex-boundary`、`runner-skills` 42/42。
- Mac mini `worker test`（同一批文件）：60 个用例中 51 通过。9 个失败与未打补丁的 c8c8a35e 基线失败集合一致：`processIdentity(process.pid)` 在该 runner 上取不到启动时间，报 `Cannot identify runtime lease owner.`（`harness/agent-runtime/maintenance.ts:27`）。与本补丁无关，未修。
- Mac mini `worker build`（tsc 生产构建）：PASS。
- Mac mini `go test ./internal/builtinskills/`：PASS。
- 补丁在「c8c8a35e + DEV-269」上 `git apply` 成功，结果与提交树逐文件一致（README 除外，DEV-269 行由其自身补丁提供）。
- 未跑 `apps/server` 全量 `go build ./...`（本机与远端都超时）；本次 Go 改动只有常量与测试，`builtinskills` 包已编译并通过测试。
- 未在 Web 或真实子会话上验证；见「验收步骤」。

## 2026-11-17 夜：补丁 b（实测发现）

- 编排者实测：Codex 子会话收到的提示开头是 Foundry 的来源说明「Foundry message source: agent session … Message from that session:」，`/foundry-orchestration` 在其后，不再是开头，于是 `$name` 改写没有发生，Codex 回答「未加载」。Claude 子会话那次是模型自己调用了 Skill 工具。同一问题也会出现在本人带附件或注释、以 `/skill` 开头的消息上。
- 修复：`userMessageText` 在前面要加来源说明、附件说明或注释时，把消息开头的命令留在整段提示的最前面（只有前面要加东西时才挪；其他消息原样）。两种运行时已有的改写随之生效。
- 检查：byte-dev `scripts/run-worker-tests.mjs`：session-steer（含新增用例）、chat-naming、skill-invocation、workspace-draft-skills 共 39 个通过。

## 2026-11-18 凌晨：补丁 c（部署补丁 b 后实测仍失败）

- Codex 原生提示已经以 `$foundry-orchestration` 开头，但 Codex 仍答「未加载」。查 rollout：Codex 的技能列表里有 `foundry-workspace:foundry` 等，**没有** `foundry-orchestration`——它的 `agents/openai.yaml` 是 `allow_implicit_invocation: false`（只许显式调用），不出现在模型可见的列表里；而 app-server 不解析文本里的 `$name`（那是 TUI 的功能）。Codex 0.169 app-server 的 `UserInput` 有结构化的 `{ type: "skill", name, path }`。
- 修复：`codexManagedInput` 把开头的已选技能变成 Codex 的 skill 输入项（`path` 为该技能的 `SKILL.md`），其余作为文本；新回合（`codex-turn.ts`）与 steer（`codex-stream.ts`）都用它；`appServerInput` 只给文本项加 `text_elements`。草稿仍原样。
- 检查：byte-dev `run-worker-tests`：skill-invocation、session-steer、codex-boundary、execution-core 共 45 个通过。
- 2026-11-18 凌晨复验（Worker train 43 `…1794933749`）：编排者派出的 Codex 子会话（`sess_1794933914558150721`，gpt-5.6-luna）提示以 `/foundry-orchestration` 开头，原生 rollout 收到 `<skill><name>foundry-workspace:foundry-orchestration</name>…` 整段技能内容，回答「是 / # Foundry orchestration」。Claude 子会话（`sess_1794930266257466533`）同样加载成功。
