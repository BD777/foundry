# DEV-042 Claude 进度说明与思考分类

## 状态

2026-10-26：代码与本地自验完成，新 Worker 已安装并激活 daemon；实际 execution host 仍服务活动会话，保留旧版，等待安全切换。未提交 Git、未发布公共 Worker 下载、未完成人工验收。Server/Web 无代码变更，无需重新部署。

## 问题与依据

用户在 `sess_1792944596386341692` 提供截图，并指定 `sess_1792942569342884961` 调查，随后授权“按你的建议去修”。截图中的原始 SDK 帧 UUID 为 `23c16ade-6e74-48b5-bee9-c19011b3d90f`，记录时间 `2026-10-25T16:07:00.801Z`。其内容类型是 `thinking`，但同帧包含 `narration_block_indexes: [0]` 和 `thinking_display: "updates"`，属于面向用户的进度说明。

原适配仅按 thinking 类型生成 reasoning，丢弃了 narration 元数据，于是被显示在 `Finished thinking` 活动行。Anthropic 的 [thinking 文档](https://platform.claude.com/docs/en/build-with-claude/thinking) 区分思考摘要与 updates；本机 Claude Code 渲染逻辑也将明确标记的 narration 单独显示。Codex 的 commentary 已有独立映射，本次复用同一展示语义。

## 修改

- `packages/worker/src/claude-narration.ts`：共用分类器，仅接受明确 narration 索引或 updates 模式下非空的 thinking 文本，输出 commentary；不猜测句子含义、不读取或解码 signature。
- `packages/worker/src/sdk-messages.ts`：处理完整 SDK 帧中的每个过程 block，保留顺序、工具身份及 request usage，避免混合内容遗漏 narration。
- `packages/worker/src/runner/claude-messages.ts`：正常回合与后台续接均发布 commentary；不把它加入最终回答，保留转发子代理的隔离规则。
- `packages/worker/src/transcript-adapters/claude.ts`：带原始标记的历史、重放与子代理记录使用同一分类器。未标记的旧思考仍是 reasoning，空块不升级成正文。
- 新增 runner 测试并补充 adapter 回归；在模块审计清单登记新文件。

不修改模型请求配置，也不改前端样式。原有 commentary 投影已将内容放在对话流中，并让前后思考/工具活动各自折叠。

## 自验

1. `scripts/check-changed.sh --files` 覆盖本次 6 个 Worker 文件：格式、Worker 构建和相关 21 个测试文件通过。首次模块审计指出新文件未登记；登记到 session-runtime 后重新运行 `node scripts/audit-module-boundaries.mjs` 通过，零边界违规；该审计文件格式检查通过。
2. `node scripts/run-worker-tests.mjs -- test/claude-timer-turns.test.mjs test/native-chat-transcript.test.mjs`：13 项通过，覆盖定时器/后台续接及历史记录。
3. Web `transcript-pipeline.test.mjs` 和 `chat-transcript-classification.test.mjs`：27 项通过。
4. 将截图原始帧送入新 live 与历史适配器，两者均输出 commentary，正文内容保留。
5. 使用受管 Chromium 和 agent-browser，在真实前端 `projectTranscript`、`ChatMessageRow`、`ProcessDisclosure` 组件夹具中验证：亮色 1280×900、深色 390×844；进度说明处于活动区外、思考/工具独立折叠、键盘 Enter 展开、工具行可展开、进行中 commentary 和刷新回放正常、无横向溢出。截图已目视检查。此项为原始消息回放及组件浏览器验证，不声称是更新后的在线模型端到端运行。

证据在 `.foundry/attachments/narration-20261026/`：`adapter-evidence.json`、`light.png`、`dark-narrow.png`、`runtime-evidence.json`，以及移出的临时浏览器夹具。未保留临时页面到 Web 源码。

## 安装与实际加载

- 基线 `122222b`，打包版本 `0.5.7-dev.71.g122222b.local.1792950417`，本机标准 `update --server ... --from ...` 返回成功。安装包位于 `/tmp/foundry-narration-release-sess1792944596386341692/`。
- dev-server daemon PID `390800` active；current 指针指向新版。安装后的四个变更 JS 文件与已验证 dist 的 SHA-256 全部一致。
- 实际 execution host PID `3325667` 仍加载 `0.5.7-dev.57.gb316fc8.local.1792735712`，与更新前相同。未强制停止活动会话或后台服务。不能把安装成功描述为实时消息适配已生效；实际宿主空闲切换后仍需核验其入口版本。
- 更新后本机 dev API `http://127.0.0.1:31982/healthz` 返回 `status: ok`。公网 `/healthz` 被前端回退接管，不作为 API 健康证据。大写入前可用约 13 GiB，安装后约 12 GiB，使用率 88%。未清理其他任务数据。

## 验收与限制

待实际宿主切到新版后，用 Claude 发起一次包含工具调用的任务：面向用户的阶段性说明应在对话流中完整可读，思考摘要及工具详情仍留在活动区，最终回答独立出现；刷新后顺序应一致。

旧 Worker 已持久化的 Foundry 事件不含 narration 元数据，本次不重写旧记录。仅有文本和 reasoning 标签时无法安全追溯分类；截图所属旧事件不会因为刷新自动修正。带完整原始标记的记录重新适配可正确分类。旧版原生日志若没有这些标记，同样保守保留思考分类。
