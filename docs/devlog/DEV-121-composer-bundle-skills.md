# DEV-121 输入框 `/` 菜单漏掉工作区单独勾选的 bundle 技能

| 环节           | 状态   | 说明                                                                                                                 |
| -------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研  | 已完成 | 根因在 Server 的 `workspaceSkills` 投影，见下                                                                        |
| 代码           | 已完成 | Server `foundry_data.go`；Web `message-composer.tsx`；Worker 删除 skillCatalog 并标注 `TODO(native-prompts)`；未提交 |
| dev Server/Web | 已部署 | Server `7aafb2c26c7df7b9`（SIGHUP 交接），Web `ffe17f9d4845f821`                                                     |
| Worker 更新    | 已完成 | `0.5.7-dev.269.g97415a6e.local.1793872794`，7 台设备，见“不往提示里注入 Skill”                                       |
| Agent 自验     | 已完成 | API + 真实浏览器，见“自验”                                                                                           |
| 人工验收       | 待验证 | 见“验收步骤”                                                                                                         |

## 问题

2026-11-05：本人在 macbook 的 research 工作区（`ws_72f5413d-…`）的 Skills 页勾选了 bytedcli bundle（0.170.0，262 个技能），但在 Chat 输入框里输入 `/byte`，提示 “No skills match “byte””。

## 根因

- 会话实际拿到的技能由 `resolveWorkspaceSkills`（`default_skills.go`）算出，包括四类：工作区单独选的技能、工作区勾选的 bundle、所有者的默认技能、所有者的默认 bundle。
- 输入框 `/` 菜单读的是 foundry-data 的 `workspaceSkills`。原来由 `workspaceSkillSummaries(catalog, bindings, DefaultSkillIDs)` 生成，只包括单独选的技能和 `DefaultIDs`。工作区自己勾选的 bundle 用 `add(bundled, false)` 加入，不进 `DefaultIDs`，所以这些技能不在菜单里，但会话照常拿到。
- dev 库只读核对：research 的 bytedcli 是 `skill_bundle_selections` 中 `scope=workspace` 的选择，不在用户默认里；单独选的技能和关掉的技能都是 0。所以菜单里只有带 “On by default” 的 bundle 的技能。

## 修复

`workspaceSkills` 改为直接用 `resolveWorkspaceSkills` 的 `Refs`（按目录顺序列出），菜单和会话用同一份结果。关掉的技能和重名时的优先级也随之一致。`workspaceSkills` 不再依赖 `ListWorkspaceSkillBindings`。

测试：

- `TestSkillBundleLifecycle`：工作区单独勾选的 bundle 的技能出现在 `workspaceSkills`。在旧代码上这条失败（`composer menu []`）。
- `TestDefaultSkillsFollowTheWorkspaceOwner`：关掉的默认技能不在菜单里。
- `scripts/check-changed.sh`：gofmt、httpapi 11 个测试、audit:contract 均通过。

## 部署

2026-11-05 12:06 UTC+8，持 `/tmp/fdy-deploy.lock` 把补丁应用到 `foundry-int`（3 个文件与 main HEAD 相同，无冲突），定向测试通过后构建，SIGHUP 交接：新 pid 514789 接管，旧进程 927 ms 退出，`/healthz` 200。Server `7aafb2c26c7df7b9`。回滚：`releases/dev023-candidate/foundry-server.pre-composer-bundle-menu`（`206d7ffbdc0ae6ef`），换回后 SIGHUP。

## 自验

复用 e2e-alice（密码只由脚本读取，cookie 在 0700 临时目录，验后登出并删除）。合成工作区 `dev023-dependency-source`（`ws_efa63246-…`）原本没有 bundle，菜单为 0：

1. 在该工作区单独勾选 bytedcli：`workspaceSkills` 有 261 项，其中 260 个 `bytedance-*`。bundle 有 262 个技能，但其中两个都叫 `bytedcli`，会话按名字只保留一个，菜单与会话一致。
2. 真实 Chromium（headless，1280×860）在该工作区的新 Chat 输入 `/byte`：261 个选项，第一项 `/bytedance-abase`，没有出现 “No skills match”。截图：`.foundry/attachments/20261105/composer-byte-after.png`。
3. 恢复：取消勾选后 bundle 为空，菜单为 0。没有发消息，也没有运行模型。

限制：没有用本人账号在 research 工作区实测，这一步留给人工验收。bytedcli bundle 内有两个同名 `bytedcli` 技能，这是数据本身的问题，与本修复无关。

## 验收步骤

1. 打开 research 工作区 → Chats，在输入框输入 `/byte`。预期：列出 `/bytedance-abase` 等 bytedcli 技能，不再提示 “No skills match”。
2. 在 Skills 页取消勾选 bytedcli，再输入 `/byte`。预期：菜单不再列出这些技能。恢复勾选后重新出现。

## 后续：`/` 菜单在文字中间也能打开（2026-11-05）

本人反馈：输入 `123 /byte` 不出菜单。原因：`activeSlashToken`（`apps/web/src/components/ui/message-composer.tsx`）只认行首的 `/`。现在 `/` 在文本开头或任意空白之后都会打开菜单；紧贴在字符后面的 `/`（`123/`、路径、URL）仍不会。选中技能时替换从 `/` 到光标的这一段，其余文字不动。

- 测试：新增 `apps/web/test/composer-slash-token.test.mjs`（行首、空格后、换行后、字中、路径、URL、光标在中间）；`check-changed`（prettier、tsc、3 个 web 测试、audit:ui）通过。
- 部署：持 `/tmp/fdy-deploy.lock` 打进 `foundry-int`，在那里构建，用 `scripts/deploy-web-dev.sh` 发布。Web `ffe17f9d4845f821`（原 `6ec8d85fc8573af3`，回滚副本在 `releases/dev121/previous-20261105T045525Z`）。
- 自验：e2e-alice，合成工作区 `dev023-dependency-source`，真实 Chromium。`123/` 打开 0 项；`123 /` 打开 6 项；按 Enter 得到 `123 /imagegen `，菜单关闭，消息未发送。截图：`.foundry/attachments/20261105/composer-slash-midline.png`。
- 说明：只有 Claude 在消息开头的 `/name` 会被 Worker 改写为 `/foundry-workspace:name`，并由 Claude Code 当作命令调用。在文字中间时，两种 agent 收到的都是普通文字，靠模型从技能列表中认出并调用。

验收：在 research 输入 `123 /byte`，应列出 bytedcli 技能；选中后得到 `123 /bytedance-… `。输入 `123/byte` 不出菜单。

## 暂不做：选中的技能显示为整块标签（2026-11-05）

本人希望选中的技能在输入框中显示为整块标签，删除时整块删除，并要求用成熟方案、不自己 hack。原生 `<textarea>` 中放不了整块标签，需要换成富文本编辑器。调研结论：

- TipTap `@tiptap/extension-mention` + `@tiptap/suggestion`（3.32.2，MIT，2026-10-30 仍在发布）：节点声明 `atom: true`，整块删除；`suggestion.char` 可设为 `/`；`renderText` 可让纯文本仍为 `/name`。已从 npm 包源码核实 `atom: true` 和 license。
- Lexical（`@lexical/react` 0.53）：核心没有现成的 mention 插件，社区的 `lexical-beautiful-mentions` 最后发布于 2025-08。
- `react-mentions`（4.4.10）：保留 textarea，用覆盖层高亮，并不是真正的标签。

需要引入编辑器依赖，并改动 `ComposerInput` 及 Chat、Issue、Pending 等宿主的 ref、粘贴附件、IME、草稿和排队编辑。本人决定（2026-11-05）：效果上要行内标签，但改动大，先不做。

### 调研补充（2026-11-05）

- **技能加载现状**：Chat 和 Issue 执行会话不往指令里写技能目录。Claude 通过 SDK 的 `plugins: [{type:"local"}]` 加载会话快照里的 `foundry-workspace` 插件，技能名带 `foundry-workspace:` 前缀。Codex 把每个技能符号链接到工作区的 `.agents/skills`。`skillCatalog` 的文字目录只有 Issue 验证者使用：它关闭了原生技能发现，防止候选方给评审方植入技能。`codex-options.ts` 中关于 `codexArgumentLimit` 的注释已过时，仍写着 Codex 用 skillCatalog。
- **原生列表预算**：Claude Code 技能列表的预算是上下文的 1%，超出时从最少用的技能开始去掉描述，名字始终保留（code.claude.com/docs/en/skills）。Codex 默认不超过上下文的 2%，可用 `skills.max_context_tokens` 调整（最多 10,000 tokens），技能太多时先缩短描述，再省略技能并给出警告（learn.chatgpt.com/docs/build-skills）。
- **Beautiful UI**：`PromptBar`、`ChatComposer` 都基于 `<textarea>`，选中 `@` 或 `/` 项只插入纯文本；只有附件在文本外显示为一排 chip。没有行内整块标签。
- **Codex 原生协议**（`codex app-server generate-ts`，codex-cli 0.163.0）：`UserInput` 包含 `{type:"skill", name, path}`；`text` 输入带 `text_elements`，即 `{byteRange, placeholder}`，用来标记文本中需要渲染的特殊片段。Codex 原生的显式调用是 `$name`，不是 `/name`。
- **编辑器**：TipTap Mention（MIT，`atom: true`）同时提供节点和触发菜单。Lexical 有官方 `LexicalTypeaheadMenuPlugin`（MIT），但 mention 节点要自己写。

## 不往提示里注入 Skill（2026-11-05）

本人决定：任何角色都不往提示里写 Skill 清单，Issue 的各个身份也一样，Skill 只按 Agent 原生的方式提供（与 CLAUDE.md “Native agents first” 一致）。Issue 角色以后要重新梳理、可能重构，眼下先保证不影响普通 Chat，并在代码里标出所有还在注入提示的地方。

- **代码**：
  - Worker 删除 `skillCatalog`、`skill-indexes/`、目录预算、大 bundle 合成一条，以及只为目录存在的 `description`/`bundle` 字段。
  - 判定者（`evidence-agent.ts`）不再在提示里写 `workspaceSkills`，`evidence-rpc.ts` 也不再为它物化 Skill；判定者暂时没有 Workspace Skill。
  - 修正 `codex-options.ts` 的过时注释。
  - Issue 角色中仍往提示里写文字的地方共 11 处，统一标为 `TODO(native-prompts)`：判定者、澄清、执行提示、verification notes、`startSession` 替换系统提示、`claudeWorkspaceInstructions`、Server `evidence_routes.go` 仍下发的 `skillRefs`、protocol 注释。
- **文档**：`docs/skills.md` 加入“不往提示里注入 Skill”；`docs/architecture-modules.md` 在原 D4 记录后追加“D4 修订”，并指向这个 TODO 标记。
- **测试**：主工作区 `scripts/check-changed.sh` 通过（prettier、worker build、64 个 worker 测试文件、audit:modules）。改写的测试改为断言：判定者提示中没有 `workspaceSkills`；300 个技能的 bundle 下 Claude 的 `systemPrompt` 为空、Codex 配置为 `{}`；Skill 集里没有 `skill-indexes/`。`go vet ./internal/httpapi/` 通过（Server 只改了注释，未重新部署）。
- **部署**：持 `/tmp/fdy-deploy.lock` 打进 `foundry-int` 后打包，与线上 `…1793872470`（DEV-127 刚发布）逐文件对比：只有本项涉及的 11 个 dist 文件和 protocol 的 `evidence-rpc.d.ts` 不同；只改注释的文件去掉注释行后无差异。发布 Worker `0.5.7-dev.269.g97415a6e.local.1793872794`，回滚副本 `~/.foundry/server/worker-packages-rollback/before-dev121-native-prompts/`，另存 `release.before-dev121.json`。已通知同时在更新 Worker 的会话 `sess_1793850749311731318`。
- **Worker 更新**：通过 compute 租约逐台执行 `foundry-worker update`。CanWendeMac-mini、byte-dev、byte-dev-sg、cottoncpp、limen-canada、sg-chaos 从 `…1793872470` 升到 `…1793872794`，systemd/launchd 在 10:08–10:09 UTC 重启，状态 active。macbook（Worker 在 `~/.foundry-stacks/dev`）已由上述会话的更新装上 `…1793872794`，daemon 在安装后 4 秒重启。租约已全部释放。
- **自验**：在 sg-chaos 的 foundry 工作区新建 Claude 会话 `sess_1793873641140599401`（一轮，回复 OK，验后归档）。“Loaded skills” 共 15 个，回复正常。新 Worker 生成的会话 Skill 树（`skill-sets/ecb56407…`）只有 `.claude-plugin`、快照清单和 `skills/`（15 个），没有 `skill-indexes/`。
- **限制**：判定者在 Issue 重构前没有 Workspace Skill（原 D4 的效果暂停）；`skillRefs` 字段和其余 `TODO(native-prompts)` 留待 Issue 角色重构处理。
