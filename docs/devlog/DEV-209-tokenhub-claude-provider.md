# DEV-209 DeepSeek on TokenHub through Foundry's Claude runtime

状态：已合入 main（PR #267）。已部署 dev；真实 provider check 与短会话通过，待人工验收。

## 问题

同一个 DeepSeek V4.1-Flash checkpoint 在 DeepSeek 的公开对比中使用 Claude Code 的分数高于 Codex。本人批准先把它作为 Foundry 的可选模型来源验证，不改变全局执行默认值或 DeepSeek Worker 组。

## 调查

- 现有 `prof_a8985449-4ebc-42ef-ab50-35a55fa7f282`（Tencent TokenHub）是 Codex/OpenAI-compatible：`https://tokenhub.tencentmaas.com/v1`，模型 `deepseek/deepseek-flash` 与 `deepseek-v4.1-flash-1017`，key 已封存。
- TokenHub 的 [DeepSeek 调用指南](https://cloud.tencent.com/document/product/1823/132248)明确写着 DeepSeek 系列支持 OpenAI Chat Completions 和 Anthropic 两种协议，并给出 `https://tokenhub.tencentmaas.com/v1/messages`。
- TokenHub 的 [Anthropic Message 协议字段说明](https://cloud.tencent.com/document/product/1823/135874)列出了 Claude Code 需要的 Messages、tool use、thinking、prompt caching 与 usage 字段。
- TokenHub 的 [Claude Code 接入指南](https://cloud.tencent.com/document/product/1823/130070)和[企业版接入指南](https://cloud.tencent.com/document/product/1823/130665)都通过 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 配置 Claude Code；Foundry 的 Claude provider 正好生成同一组设置，并会把自定义模型固定到 Haiku/Sonnet/Opus 与子代理，避免 compaction/subagent 回退到不存在的 Claude 模型。
- 现有 Codex provider 没有设置 reasoning effort；Claude entry 也保持默认 effort，不伪造两者不存在的映射。

## 修复

现有 key 只能封存在原 profile id 下，`save_model_provider` 没有安全复用同一 owner 已有 server-held key 的入口。新增 `copyApiKeyFromProviderId`：

- 只接受当前 person 拥有的 API endpoint；
- 在 Server 内解封源 key 后立即按新 profile id 重封，不把值写入回答、日志或工具参数；
- 与 `apiKey`、`clearApiKey` 互斥；
- 源 profile 不存在、不属于本人或没有 key 时在写入目标 profile 前失败。

改动：`apps/server/internal/httpapi/mcp_model_providers.go`、`mcp_model_providers_test.go`、`mcp_tools.json`、`docs/model-providers-design.md`。

## 检查

在 macbook compute lease 上跑了 `scripts/remote-check.sh --files`：prettier、gofmt、protocol build、worker build、httpapi 7 个相关 Go tests、contract audit 全部通过（总 wall 36.9 s）。

Server 以当前共享树构建并部署：

- 二进制 SHA-256 `71c635ee438ea231480aaf7f2df7aca92e70a7174a57b6d348771ae0f481d56c`。
- 实际服务进程 `1399589` 的 `/proc/1399589/exe` 哈希一致；`/healthz` 为 `ok`，`startedAt=2026-11-13T08:29:03Z`。
- 回滚副本：`~/.foundry/server/releases/dev023-candidate/foundry-server.pre-dev209`。

Provider：

- ID `prof_2c4c55cc-e65e-4c76-bbed-4495af2b7617`，label `Tencent TokenHub (Claude)`，runtime `claude`，base URL 为规范后的 `https://tokenhub.tencentmaas.com`。
- Models：`deepseek/deepseek-flash`、`deepseek-v4.1-flash-1017`；默认 `deepseek-v4.1-flash-1017`，effort 留空以匹配原 Codex entry。
- 仅分配 `sg-chaos`；`keySet=true`。
- `check_model_provider` 于 `2026-11-13T08:31:41.120Z` 返回 `passed`。

真实短会话 `sess_1794558777325709532`：

- 使用 runtime `claude`、provider `Tencent TokenHub (Claude)`、model `deepseek-v4.1-flash-1017`，设备 `sg-chaos`。
- `pwd` 与 `head -12 AGENTS.md` 两次 shell 工具调用都成功；回答正确引用了 `AGENTS.md` 中 `Native agents first` 的第一条。
- 第一回合 usage：input `55,939`、cache read `29,824`、cache write `0`、output `404`、requests `2`、completed。
- 第二回合 usage：input `62,239`、cache read `58,880`、cache write `0`、output `410`、requests `2`、completed。
- `usage_turns` / `usage_requests` 都按 runtime `claude`、新 profile id 与同一 model 记录，cached-token 字段已落库。

## 验收步骤

1. 用源 Codex TokenHub profile 的 sealed key 创建 Claude runtime provider，base URL 使用 `https://tokenhub.tencentmaas.com/v1`，模型包含 `deepseek/deepseek-flash` 与 `deepseek-v4.1-flash-1017`，只分配 `sg-chaos`。
2. 在 `sg-chaos` 上运行 Foundry provider check，预期 Claude Agent SDK 完成一回合，结果 `passed`。
3. 开只读短会话，预期 transcript 的 runtime 为 Claude、model 为 `deepseek-v4.1-flash-1017`，能读取 `AGENTS.md` 并调用只读工具，usage 行含 input/cache read/cache write/output。

## 限制

不改变全局执行默认值，也不改 DeepSeek Worker 组；这些留待 A/B 结果。

本次验证账户的全局 `CLAUDE.md` 存在时，Claude Code 2.1.311 没有自动把项目根 `AGENTS.md` 加入 instruction context；会话明确报告了这一点，随后通过一次只读 shell 调用正确读取并引用了 `AGENTS.md`。这是所有 Claude runtime 会话的现有规则加载行为，不是 TokenHub 或 DeepSeek 特有；本项没有为此注入提示或改动原生配置。
