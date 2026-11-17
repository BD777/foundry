# DEV-288 派出 helper 成功时仍显示「派出会话失败：null」，并修正等待处理计数文案

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #277）。

## 问题

- 2026-11-17 dev 上 e2e-alice 的助理首页（Codex 运行时）：每次派出 helper 成功后，「已派出 helper 会话…」下方都显示「派出会话失败：null」。helper 实际已创建并完成（如 `sess_1794940088045964037`）。
- 截图：`.foundry/attachments/20261118/verify-278-285/285-1-home-child-report-light.png`（浅色）与 `285-2-…-dark.png`。
- 存储事件：会话 `sess_1794761923996513314`（18:28Z，标签 "Used tool"）的 `foundry.create_session` 调用详情为 `Result` JSON 之后跟 `Error\n\nnull`。

## 调查与证据

### 1. 「null」从哪来

- `packages/worker/src/session/runner/sdk-messages.ts` 的 `sdkToolCallDetail`：`if (item.error !== undefined)` 时无条件写入 `Error` 段。Codex 成功调用时发送 `error: null`，于是 `sdkString(null)` 得到空串，回落到 `safeJSONString(null)`，写出 `Error\n\nnull`。
- Web 端 `apps/web/src/components/conversation/turn-handoffs.ts` 的 `toolError` 读取 `Error` 段正文，正文 `null` 被当作失败原因，`toolHandoffs` 把调用标为 `failed`，行上显示「派出会话失败：」加正文。

### 2. 同类写法排查

- `sdk-messages.ts`：其余 `!== undefined` 判断（`parentToolUseId`、`delay`）与错误段无关；API 错误的 `record.error` 只作为错误码，不写入正文。
- `claude-messages.ts`：`failedClaudeToolDetail` 只在 `is_error === true` 时调用，`handoffResultText(null)` 返回空串，空串直接返回原详情，不写 `Error` 段。Claude 路径无同样缺陷，未改动。

### 3. 助理页面「条形」（截图中用户消息左侧的竖条）

- 该条是 `ChatTurnNavigator`（`apps/web/src/components/conversation/chat-turn-navigator.tsx`），无障碍名称「会话轮次」，为有意设计的轮次导航轨。
- 在 dev 页面 `/assistants/asst_3fc8b4a2107893e6b1e36425a39aacdb` 的实际 DOM 中：`nav.fdy-chat-turn-nav` 含 44 个按钮，`data-density="dense"`，每个按钮高 4 px；全线程共 44 条用户消息（`buildChatTurnAnchors` 只为 `role === "user"` 的消息建锚点），即每条细线对应一轮用户消息。
- 细线是 `h-0.5` 的 2 px 横线，静止时 `scaleX(0.23)`，因此呈现为一列细横纹。导航轨位于左侧 gutter，在可用高度内居中（`items-center`），是整段会话的缩略索引，不与某条消息逐一对齐，所以不会「挨着」每条用户消息。
- 结论：是有意的控件，不是缺陷，本次未改动。

### 4. 文案不一致

- `apps/web/src/i18n/locales/zh-CN/chat.ts` 的 `chat.list.needsMe_*` 为「等我处理 · {{count}}」，导航与页面标题为「等你处理」（`zh-CN/shell.ts`、`zh-CN/pending.ts`）。
- `en/chat.ts` 的同一键为「Needs me · {{count}}」，英文导航为「Needs you」（`en/shell.ts`）。

## 根因

1. Worker 把 `null` 错误写成 `Error` 段正文 `null`（`sdkToolCallDetail` 的判断只检查 `!== undefined`）。
2. Web 把正文 `null` 当作失败原因（`toolError` 不识别空值），已存的历史事件因此也显示为失败。
3. 文案键与导航用词不一致（人工编写时未对照导航）。

## 修复

- `packages/worker/src/session/runner/sdk-messages.ts`：`sdkToolCallDetail` 改为 `toolErrorText(item.error)` 取值，只有有意义的错误才写 `Error` 段。新增私有函数 `toolErrorText`：布尔值与 `hasMeaningfulToolPayload` 判定为空的值（`null`、`""`、`{}`、`"null"`）返回空串。保留既有的 1024 字节截断。
- `apps/web/src/components/conversation/turn-handoffs.ts`：`toolError` 把正文恰为 `null` 的 `Error` 段视为无错误，历史事件同样生效。
- `apps/web/src/i18n/locales/zh-CN/chat.ts`：`needsMe_one` / `needsMe_other` 改为「等你处理 · {{count}}」。
- `apps/web/src/i18n/locales/en/chat.ts`：同键改为「Needs you · {{count}}」，与英文导航一致。
- 测试：
  - `packages/worker/test/tool-call-detail.test.mjs` 新增两条：`error: null` / `""` / `{}` / `false` 不写 `Error` 段；真实错误（字符串与 `{message}`）仍写出。
  - `apps/web/test/turn-handoffs.test.mjs` 新增一条：存储文本 `Error\n\nnull` 的 `create_session` 调用不标记失败，仍解析出子会话 id。

## 检查

- 本地 `prettier --check`（改动的 6 个文件）：`All matched files use Prettier code style!`
- 本地 `node --import ./test/register-bundler-resolve.mjs --test test/turn-handoffs.test.mjs`：`pass 12 / fail 0`。
- 修复前代码（临时换回 live 版本）：web 用例 `pass 11 / fail 1`，失败项为新增的 `a stored null error is no failure (DEV-288)`；已恢复修复版本。
- 远端 byte-dev（`res_309405e6874f83ccd87c`，lease `lease_c06412fbbbd2a77d7e1d`）：
  - `--worker test tool-call-detail.test.mjs`：`# tests 4 / pass 4 / fail 0`，PASS（日志 `/tmp/remote-check-20261117T134757-2923561.log`）。
  - 同一测试用修复前 `sdk-messages.ts` 运行：`not ok 2 - a null, empty or object-free error writes no Error section`，`# pass 3 / fail 1`（日志 `/tmp/dev288-e2e/rc-worker-mutant.log`）；已恢复修复版本。
  - `--worker build`（worker `tsc -p tsconfig.json`）：PASS（日志 `/tmp/remote-check-20261117T134926-2928105.log`）。
  - `--web typecheck`：PASS（日志 `/tmp/remote-check-20261117T135048-2932583.log`）。
  - `--sh 'pnpm --filter @foundry/web build'`：PASS，`✓ built in 21.75s`（日志 `/tmp/remote-check-20261117T135238-2940154.log`）。

## 验收（部署后，dev）

1. 打开 `/assistants/asst_3fc8b4a2107893e6b1e36425a39aacdb`，让助理派出一个 helper 并等待完成。派出行下不应出现「派出会话失败」。
2. 打开历史中 `sess_1794761923996513314` 的 "Used tool" 事件（已存的 `Error\n\nnull`）：不应显示失败。
3. 让一次真实失败的派出（例如越权项目）：仍应显示「派出会话失败」与简短原因。
4. 切换到英文界面，等待计数应显示「Needs you · N」；中文界面应显示「等你处理 · N」。

## 限制

- 未部署到 dev；上述验收需部署后执行，浏览器内的实际效果未验证。
- 截图中的竖条判定为有意控件（见调查 3），本次未改动。若希望助理首页隐藏该导航轨，需另行决定。
- 已存事件仍保留 `Error\n\nnull` 文本，靠 web 端识别；未回写存储。
- Claude 路径未发现同样问题，未做修改。

## 时间线

| 日期       | 事项                                                                                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Agent 代验收（编排者，e2e-alice，Web 72ac74dca55c1b63）：刷新后助理首页不再出现「派出会话失败」行，包括旧的已存派出记录。新派出（帮手 sess_1794943561799795687）显示「派出会话 <标题> · 助理 · 已完成」，没有失败行。390 px 下移动端会话列表胶囊显示「等你处理 · 2」。截图 `.foundry/attachments/20261118/verify-288-289/`（未提交）。 |
