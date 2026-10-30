# DEV-073 委托验收遗留问题修复（DEV-055 / DEV-063）

状态：已实现，部署 dev Web `95d45cc1fa3ac9b5`，Agent 自验通过；人工验收待确认。负责会话 `sess_1793211621237335178`，编排 `sess_1793063405185071529`。

| 环节                | 状态   | 说明                                                                                                                       |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | 来源：2026-10-29 委托验收（[DEV-055](DEV-055-chat-file-paths.md)、[DEV-063](DEV-063-interactive-agent-questions.md) 文末） |
| 代码                | 已完成 | 仅 Web，见下                                                                                                               |
| dev Server/Web 部署 | 已完成 | Web `95d45cc1fa3ac9b5`（之前 `ce2e4fe1ec59fa5e`，含 DEV-071 第二轮）；Server 不涉及                                        |
| Worker 更新         | 不涉及 | —                                                                                                                          |
| Agent 自验          | 已完成 | 单测 + 真实 dev 浏览器，见下                                                                                               |
| 人工验收            | 待确认 | 见“验收步骤”                                                                                                               |

## 1. 关闭“从会话打开工作区外文件”后，路径仍是链接（DEV-055 步骤 8）

原因：不是渲染判断的问题。`use-chat-feature.tsx` 已按 `device.outsideFilesOff` 决定是否识别工作区外路径，但 Web 端设备数据会被实时事件改掉：`device_status_changed` 携带的是“共享视角”的整台设备（不含只给所有者的字段），`app/projections/devices.ts` 用它替换本地设备时只保留了 `owned`、`runtimeSettings`、`sharesSystemAccountWith`，漏了 DEV-055 新增的 `outsideFilesOff`。设备一有状态事件（Worker 连接、心跳上报等），开关就在页面里回到“开启”，路径重新变成链接；服务端仍正确返回 403 `device_files_off`。

修复：

- `devices.ts` 把“只属于当前查看者的字段”列为一个清单 `viewerOwnDeviceFields`（含 `outsideFilesOff`），事件替换设备时统一保留，以后新增此类字段只改一处。
- 读取合并（`deviceLoadedMerges`）：事件在读取期间改过的设备仍以事件为准，但这些字段改用本次读取的值（事件从不携带它们，例如刚保存的开关）。
- 测试：`test/device-status-event.test.mjs` 新增两例（事件保留开关；合并取读取值）。旧代码下第一例失败，修复后通过。

## 2. 键盘切换该复选框后焦点丢到 body

原因：保存期间复选框设为 `disabled`，浏览器把焦点移出被禁用的元素。

修复：`device-outside-files.tsx` 改用 `aria-disabled`（与 `chat-file-download.tsx` 等现有做法一致），保存中忽略再次切换；“正在保存”状态文本不变。

## 3. DEV-063 小问题

- (a) 回合结束时卡片保持展开：`agent-question-card.tsx` 只在进入 `waiting` 时展开，离开时不收起。现在离开 `waiting` 即收起；若此时焦点在卡片内（正在作答），保持展开，不打断输入。测试：`agent-questions.test.mjs` 新增一例。
- (b) 回合导航显示原始信封：`chat-turn-navigation.ts` 对带 `questionReply` 的用户消息改用“Answered the agent's question: B”（中文“回答了 Agent 的提问：B”，新键 `conversation:turns.questionReply`）。测试：`chat-turn-navigation.test.mjs` 新增一例。
- 计数决定：回答仍算一个导航锚点。迟到回答本身开启新回合；回合内回答（steer）与其他 steer 消息一样是用户消息，导航按用户消息定位，保持一致且可跳到回答处。若希望回合内回答不计数，需要导航区分 steer 消息，列为后续。

## 4. DEV-048 合成设备凭据轮换

该设备的配对凭据曾两次出现在工具输出中（DEV-055、委托验收）。用 e2e-alice 新建一次性配对令牌，对 DEV-048 合成 Worker 状态目录执行 `foundry-worker pair --token …`（服务端对同一 Worker 指纹轮换凭据），设备 id 不变（`dev_1d7e8a04-…`）。脚本只输出状态码，不显示任何凭据：

- 轮换前旧凭据访问 `GET /api/devices`：200；轮换后旧凭据：401；新凭据：200。
- 旧配置副本与日志已删除；登录 cookie 已登出并删除。

## 自验证据

- Web：`pnpm typecheck` 通过，全量单测 948/948（含 DEV-071 第二轮）；`scripts/check-changed.sh`（本事项 9 个文件）prettier、tsc、23 个相关测试文件、audit:ui 全部通过。
- 部署：`scripts/deploy-web-dev.sh` 发布 `95d45cc1fa3ac9b5`，脚本核对公网入口资源与同源 API 通过；回滚入口在 `~/.foundry/server/releases/dev073/previous-20261028T185928Z`。
- 真实 dev 浏览器（e2e-alice，headless Chromium，1280 宽；密码由脚本从仓库外文件读入表单，不输出）：
  1. 开关开启时，DEV-055 Phase 2 合成会话 `sess_1793155947693648643` 中 4 个工作区外路径是链接。
  2. 设备页“设置”用键盘：Space → 关（焦点仍在复选框），Space → 开，Space → 关；三次后 `document.activeElement` 都是该复选框。
  3. 不刷新页面回到会话：链接 0；随后启动合成 Worker 产生设备连接事件，25 s 后链接仍为 0（修复前这一步会恢复为链接）。
  4. 键盘重新开启，回到会话：4 个链接恢复；停止 Worker 后仍为 4。
  5. 回合导航（委托验收的已归档会话 `sess_1793202140770104457`，只读）：第 2、4 项为“Answered the agent's question: B / C”，页面所有 aria-label 中不再出现信封标签。
  6. 新建合成 Codex 会话 `sess_1793214221359754288`（gpt-6.1-sol，一个短回合：提问、`sleep 20`、结束，不作答）：等待时卡片展开；回合结束后不刷新即变为 “Continued on its own assumption” 并收起，显示 “Answer” 按钮。
- 截图（本机，不入库）：`.foundry/attachments/20261029/dev073/`。

## 限制

- 浏览器验证只做了 1280 浅色；改动不涉及样式。
- 回合内回答仍计入导航轮次（见上文决定）。
- 合成会话 `sess_1793214221359754288` 保留在 DEV-048 合成工作区，未归档。

## 验收步骤（dev）

1. 以设备所有者打开 https://dev.foundryapp.app/devices ，进入自己的设备 → 设置，用 Tab 聚焦“Open this device's files outside workspaces from chats”，按 Space 关闭。
   预期：保存后焦点仍在复选框上；再按 Space 可重新打开。
2. 保持关闭，打开一个回答含工作区外路径（如 `/tmp/…/notes.md`、`~/…`）的会话，并让该设备的 Worker 重连或等待一段时间。
   预期：这些路径始终是普通代码文本，不是链接；重新开启后恢复为链接。
3. 让 Codex（gpt-6 系列）用 `request_user_input_async` 提问后不等回答就结束回合，页面保持打开。
   预期：回合结束时卡片自动收起为 “Answer”，状态 “Continued on its own assumption”，无需刷新。
4. 回答一个问题后，查看左侧回合导航（悬停或读屏）。
   预期：该项显示 “Answered the agent's question: <答案>”，不出现 `<send_user_message_question_reply>`。

## 2026-10-30 复验

第 1 项（DEV-055 步骤 8）在当前 dev Web `3c5a4213c1199f52` 上复验通过，证据见 [DEV-055](DEV-055-chat-file-paths.md) 文末。第 2、3 项本轮没有复验，仍以 2026-10-29 的自验证据为准；人工验收照旧按约定在本人下次使用时进行。
