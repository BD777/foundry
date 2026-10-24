# DEV-040 模型服务 Base URL 校验纠正与 MCP 可见性

2026-10-24，用户要求修复诊断会话 `sess_1792847635628004878` 暴露的两个问题：Foundry MCP 查不到服务端模型服务的配置；创建模型服务时缺少校验和常见错误的自动纠正。来源会话：`sess_1792848385327385943`；事故会话：`sess_1792847561322587192`。

## 问题与原因

- 事故：cottoncpp 上的会话用模型服务 `hell-tw`（Claude，模型 `claude-opus-5-5`），报 "There's an issue with the selected model"。Base URL 填成了 `https://astergate.cc/v1`，Claude Code 自行追加 `/v1/messages`，实际请求 `/v1/v1/messages` 返回 404。用户随后手动改为 `https://astergate.cc`，13:24 的运行恢复。
- 校验缺失：Server `normalizeProfileInput` 只检查 Base URL 非空。Worker 读模型目录时会依次尝试 `<base>/models` 和 `<base>/v1/models`，带 `/v1` 的地址照样列出模型，界面看起来一切正常。
- MCP 缺失：`list_profiles` / `list_models` 只读设备上报的 profile，没有合并分配给该设备的服务端模型服务（HTTP `/api/agent-profiles` 已合并）。诊断会话因此只能看到名称，转而用 Anthropic SDK 直接请求端点，违反 AGENTS.md「Agent provider access」。

## 修复

- 统一规则 `normalizeProviderBaseUrl`（`packages/protocol/src/provider-endpoint.ts`），Go 侧 `apps/server/internal/httpapi/provider_endpoint.go` 规则相同，两边共用 `packages/protocol/test/provider-endpoint-fixtures.json` 的 26 个用例：
  - Claude：去掉误贴的 `/messages`、`/models`、`/chat/completions`，再去掉末尾 `/v1`。挂在子路径下的网关（如 `/api/anthropic`）保持不变。
  - Codex：去掉 `/responses`、`/chat/completions`、`/completions`、`/models`；只填主机（未带请求路径）时补 `/v1`。其他版本号（如 `/api/v3`）保持不变。
  - 共同：缺少协议时补 https（回环地址补 http），去掉末尾斜杠；无效地址、非 http(s) 协议、URL 中带用户名或密钥、带 query 或 fragment 时拒绝并说明原因。
- Server：新建、更新模型服务和设备 profile 创建时都按此规则规范化，并返回明确的 400 原因。提升（promote）不补 `/v1`，保留设备上能用的地址。端点同名匹配（`endpointTwinProfile`、`markPromotedDeviceProfile`）改为比较修复后的形式，已纠正的服务端副本和设备原配置仍能对上。
- Web 编辑器：按同一规则实时提示「将保存为 …」及原因；地址无效时显示错误并禁用保存（中英文）。
- Worker：运行前对旧存量地址按修复规则（不补版本）设置 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`，不需要迁移数据库。
- MCP：`list_profiles` / `list_models` 与 HTTP 共用 `deviceAgentProfiles`，返回分配给设备的模型服务（`origin: server`，含 `baseUrl`、models、`serverCredential`，不返回密钥）。可见范围仍按调用者所属的人和设备。Foundry skill 的 `diagnosing.md` 增加模型服务排障说明，并注明不要直接请求端点。

## 验证与部署证据

证据目录：`.foundry/attachments/20261024/dev040-provider-endpoint/`。

- `scripts/check-changed.sh` 全部通过（`check-changed.log`）：prettier、gofmt、protocol 构建与测试、Web tsc、4 个 Web 测试文件、Worker 构建与 8 个测试文件、23 个 httpapi Go 测试、10 项 UI 审计、contract 和模块审计。
- 完整 httpapi 套件（30 分钟超时）只有 `TestPromoteProfileAdoptsSealedCredential` 和新的 MCP 测试两项失败：前者断言需按新规则更新，后者是测试夹具问题。修正后两项通过。
- 部署：Web `5b376adbba4ac810` 已部署，公网 `version.json` 一致；Server PID 3873369，可执行文件 SHA256 `1711d38e…30bb4` 与构建一致，healthz ok（startedAt `2026-10-24T14:07:21Z`）。旧 binary、index.html、version.json 和 Worker `release.json` 已备份到 `~/.foundry/server/releases/dev040-provider-endpoint/previous`。无数据库结构迁移。
- Worker：`0.5.7-dev.60.g3884893.local.1792851123` 已发布，本机 daemon 已标准更新，安装的 `profiles.js` 与构建一致。活动执行宿主仍为 `.1792735712`，正常重启后才加载运行时修复；cottoncpp 等设备在各自更新后生效。
- 真实 MCP：部署后对 cottoncpp 调用 `list_profiles`，返回 `hell-tw`（`baseUrl: https://astergate.cc`、13 个模型、`serverCredential: true`），未返回密钥。
- 真实浏览器（Chromium，e2e-alice，合成服务 `zz-dev040-synthetic-check`）：
  - 输入 `https://astergate.cc/v1` 实时提示纠正，保存后字段为 `https://astergate.cc`。
  - 带凭据的 URL 显示错误并禁用创建。
  - 中文深色下 Codex 的 `/v1/chat/completions` 提示保存为 `/v1`。
  - 390px 宽度无横向溢出。
  - 合成服务已在界面中删除。截图为 `editor-*.png`。

## 限制

- 已存的错误地址在 Server/UI 中保持原值，直到下次编辑保存；运行时由 Worker 修复。
- Codex 已存的裸主机地址在运行时不补 `/v1`，以免影响原本可用的网关。
- 不对端点做在线探测，模型名是否被网关支持仍以运行结果为准。

## 人工验收

1. 打开「模型服务」，新建 Claude 服务，Base URL 填 `https://astergate.cc/v1`：字段下方应显示「将保存为 https://astergate.cc。已去掉 /v1……」；保存后字段变为 `https://astergate.cc`。
2. Base URL 填 `https://user:key@example.com`：应显示错误，保存按钮不可用。
3. 在任一会话中让 Agent 调用 `list_profiles`（指定 cottoncpp 设备）：应看到 `hell-tw` 的 `baseUrl`、models 和 `serverCredential`，看不到密钥。

## 2026-10-24 进展

- 代码、自验、dev Server/Web 部署、Worker 发布及本机 daemon 更新已完成；代码未提交，人工验收待确认。

## 2026-10-24 PR #144 CI：Foundry Skill 版本号

- AWS 测试修复后（见 DEV-037）CI 继续执行到 Go 测试，`TestFoundrySkillPackageHasARecordedRevision` 失败：本项给 `references/diagnosing.md` 新增了模型服务排障条目，但内置 Foundry Skill 仍为 revision 9，包校验和 `7f6db7f8…` 未登记。
- 修复：按 `builtinskills.go` 约定（目录变更即升版本，Worker 才会重新拉取）将 claude/codex 两份 Foundry Skill 升到 revision 10，并在测试中登记新校验和。`go test ./internal/builtinskills/` 通过。
- 影响：已部署的 dev Server 以 revision 9 下发新内容，已缓存 revision 9 的 Worker 不会重新拉取该条目；合入后需重新部署 Server 才会生效（结果见下）。
- 合入：PR #144 两项 `verify`（run 40105726184 / 40105731293，head `773aca8`）通过后以 merge commit `3081b85` 合入 main，本地 main 已快进。
- 部署：从 `3081b85` 构建 Server，SHA256 `3579f079…a8765f`；PM2 `foundry-server` 重启后 PID 3917181，实际加载的可执行文件 SHA256 与构建一致，本机 `/healthz` ok（startedAt `2026-10-24T15:23:16Z`），公网 `/healthz` 200，停机前断开的 6 个 daemon 连接均已重连。旧 binary（`1711d38e…`）备份在 `~/.foundry/server/releases/pr144-merge/previous`。Web 与 Worker 无变更，未重新部署。
- 未验证：各设备 Worker 是否已拉取 revision 10（下次需要内置 Skill 时按版本号重新获取）。
