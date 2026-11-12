# DEV-196 assistant progressive disclosure

## 状态

已合入 main（PR #265）。

已实现、验证并部署 dev Server 与 Worker（2026-11-12）。等待人工验收。

## 问题

助理的 `AGENTS.md` 把项目、handoff、memory 与清单三段长流程都放在主提示词里，运行前每轮都要加载完整内容。按 Agent Skills 的渐进式披露，主提示词应保留判断与路由，详细流程应在需要时由 Claude Code 或 Codex 原生加载。

## 调查

- Server 的 [prompt.go](../../apps/server/internal/personalagent/prompt/prompt.go) 生成 AGENTS.md、示例和 skill 文件；[instructions.go](../../apps/server/internal/personalagent/assistant/instructions.go) 把它们放进每次 assistant run 的 `personalAgentFiles`。
- Worker 的 [personal-agent-files.ts](../../packages/worker/src/session/personal-agent-files.ts) 在 runtime 启动前把文件写入 assistant home。
- 官方路径依据：
  - Claude Code: https://code.claude.com/docs/en/skills `Where skills live`，项目 skill 为 `.claude/skills/<name>/SKILL.md`，并支持目录软链接。
  - Codex: https://developers.openai.com/codex/skills.md `Where Codex loads local skills`，repo skill 为 `.agents/skills/<name>/SKILL.md`，并支持软链接。
- Foundry 的 workspace draft scanner 原本会扫描这两个路径。为避免把 Foundry-owned skill 当作用户草稿，canonical 内容放在不会被扫描的 `.foundry/assistant-skills`，runtime 位置使用软链接；draft scanner 只跳过目标位于该 canonical 目录的链接。

## 实现

- 用编排者提供的原文替换 `system.md`，新增 `assistant-projects`、`assistant-handoff`、`assistant-memory-and-list` 三个标准 Agent Skills。
- `prompt.Version` 升为 `2026-11-12.5`；`prompt.ContentDigest` 覆盖 `system.md` 与三个 `SKILL.md`。
- Server 每次 run 发送 AGENTS.md、示例和三份 canonical skill；Worker 每次刷新 canonical 目录，并重建 `.claude/skills`、`.agents/skills` 下的目录软链接。重写会清理旧版本和失效链接，不删除用户的其它 skill。
- Worker draft scanner 跳过 Foundry-owned assistant skill links，因此 `refresh_workspace_skills` 不会把这些链接导入为草稿。

## 检查

- `go test ./internal/personalagent/prompt -update -count=1` 通过，golden 已更新。
- `go test ./internal/personalagent/prompt -run '^TestAgentsFileFitsCodexsLimit$' -v -count=1` 通过；worst-case AGENTS.md 为 `8188` bytes，上限 `28672` bytes。
- `go test ./internal/httpapi -run '^TestAssistantRunsCarryItsInstructionsAndTheTurnsContext$' -count=1` 通过。
- `go build ./...` 与 `go vet ./internal/personalagent/prompt ./internal/personalagent/assistant ./internal/httpapi` 通过。
- Worker `tsc -p tsconfig.json` 通过。
- `personal-agent.test.mjs` 13/13；`workspace-draft-skills.test.mjs` 9/9。覆盖一个 canonical 内容、两个 runtime 链接、旧 skill 与链接清理、用户 skill 保留，以及 draft 扫描跳过。
- frontmatter 测试确认三个 name 与目录一致，description 分别为 231、243、228 chars，均少于 1024。

## 部署

- 三方合并 14 个文件进 dev 检出，无冲突；merge 前备份在 `~/.foundry/server/releases/assistant-skills/merge-before-20261112T222102`。
- Worker 包 `0.5.7-dev.354.geb87723d.local.1794493387` 已发布到 `~/.foundry/server/worker-packages`。上一包备份在 `~/.foundry/server/worker-packages-rollback/before-assistant-skills-20261112T222301`。
- 先通过 MCP `update_worker` 更新 7 台设备：CanWendeMac-mini、byte-dev、byte-dev-sg、cottoncpp、limen-canada、macbook、sg-chaos。全部报告成功，Worker 与 Server version 均为 `...1794493387`。
- 7 台 Worker 更新完成后才切换 Server。新二进制 SHA-256 为 `e3a3e06cb84ba80186fbdc4043da8504c79bea34e5cebec1a08b6fafc819c445`，PM2 online，`/healthz` 返回 `{"status":"ok","startedAt":"2026-11-12T14:31:52Z"}`。
- 回滚二进制：`~/.foundry/server/releases/dev023-candidate/foundry-server.pre-assistant-skills`，SHA-256 `568e5824aaac7f96bf020eff9dc7e6902ef918192dba141100203b1cdacd781e`。

## 实测

`windeng` 的默认助理目录 `~/Foundry/personal-agent-2` 仍是旧生成物，尚未因验证消息重写；没有可安全复用的 `windeng` CLI 登录，e2e-alice 的 assistant home 又不在已更新的在线设备上，因此没有替真实用户发送消息。

按备选路径调用同一 Server 生成器 `prompt.RunFiles`，再调用合并后的 Worker `writePersonalAgentFiles` 写入临时 assistant home：

- `AGENTS.md` 为 `7495` bytes，包含 `Your skills hold the detailed procedures` 和 `Foundry rewrites AGENTS.md, .foundry/ and your skills before each conversation`。
- canonical 目录包含三个 `SKILL.md`。
- `.claude/skills/assistant-projects` 与 `.agents/skills/assistant-projects` 都是软链接，并解析到同一个 `.foundry/assistant-skills/assistant-projects`。

## 验收

1. 触发默认助理一次运行，确认其 home 的 `AGENTS.md` 已不含三段长流程，而是引用三个 assistant skills。
2. 确认 `.foundry/assistant-skills` 有三个 skill，`.claude/skills` 与 `.agents/skills` 各有对应软链接。
3. 分别用 Claude Code 与 Codex 打开 assistant home，运行 `/skills`，确认三个 skill 出现在原生 skill 列表。
4. 刷新 workspace draft skills，确认三个 Foundry-owned assistant skill 不出现在用户草稿列表。
