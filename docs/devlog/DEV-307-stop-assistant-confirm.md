# DEV-307 停止助理工作：加二次确认

[Devlog 索引](README.md) · [DEV-278 助理答复送达](DEV-278-assistant-answers-reach-person.md)

状态：**已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）。**

## 问题

助理页头部的「停止助理工作」按钮一点即生效。停止会暂停助理的新派发，并取消它当前运行的全部 helper，代价高，但没有任何确认，误触即中断。同一按钮还在设置「状态」页出现，两处各自直接调用 `assistant.stopAll()`。

## 根因

- `apps/web/src/features/personal-agent/assistant-home.tsx` 的停止按钮 `onClick` 直接调用 `flip("stop")`。
- `apps/web/src/features/personal-agent/settings-status.tsx` 的停止按钮直接调用 `assistant.stopAll()`。
- 两处没有共用的停止入口，也就没有统一的确认位置。

## 修复

- 新增 `apps/web/src/features/personal-agent/stop-assistant-button.tsx`：`StopAssistantButton` 封装「停止助理工作」按钮与确认对话框。
  - 对话框用项目已有的 `Dialog`（`layout="compact"`，与归档对话框同一模式），初始焦点在「取消」，破坏性按钮「停止」用 `Button variant="danger"`（`button.tsx` 中已为「停止正在运行的工作」这类确认定义）。
  - 点「停止」后对话框关闭并调用一次 `onStop`；点「取消」或关闭则什么都不做。
  - 文案说明：暂停新工作、取消当前运行的帮手（zh 文案沿用既有用词「帮手」，en 仍用 helper）、随时点「继续」恢复。
  - helper 数来自页面已有数据 `visibleTasks(assistant.tasks).active`（与首页「正在做 N」同源）。只有数量大于 0 时才写入文案，列表未加载或为 0 时用不带数字的版本，不展示可能失真的数字。
- 两处入口都改用该组件：`assistant-home.tsx`（头部）与 `settings-status.tsx`（状态页）。
- 「继续」不需要确认，保持原样。
- 首页头部是同一组件的响应式版本（860px 以下隐藏简介），没有单独的移动端头部，因此只有一个停止入口需要处理。
- 中英文文案：`apps/web/src/i18n/locales/{zh-CN,en}/personalAgent.ts` 的 `home.stopConfirm`（`_one` / `_other` 两种复数形式，两种语言都保留以满足类型检查）。

## 有意未改的入口

- 聊天输入框里发送文字「停」（`channelCommand` 的 `stop`，`assistant-home.tsx` 的 `send()`）仍直接执行。这是用户主动输入的命令，不是误触，因此未加确认。如需一并确认，只需在 `send()` 的 `command === "stop"` 分支前打开同一对话框，这是产品决定，请由人确认。

## 改动文件

- `apps/web/src/features/personal-agent/stop-assistant-button.tsx`：新增。
- `apps/web/src/features/personal-agent/assistant-home.tsx`：头部停止按钮换为组件；移除不再使用的 `OctagonX` 导入。
- `apps/web/src/features/personal-agent/settings-status.tsx`：状态页停止按钮换为组件；移除不再使用的 `OctagonX` 导入，新增 `visibleTasks` 与组件导入。
- `apps/web/src/i18n/locales/zh-CN/personalAgent.ts`、`apps/web/src/i18n/locales/en/personalAgent.ts`：新增 `home.stopConfirm`。
- `apps/web/test/assistant-stop-confirm.test.mjs`：新增 4 项测试（见下）。
- `docs/devlog/DEV-307-stop-assistant-confirm.md`：本文件（新增）。`docs/devlog/README.md` 未改（按委托要求）。

## 验证

- 测试 `node --import ./test/register-bundler-resolve.mjs --test test/assistant-stop-confirm.test.mjs`：4/4 通过。
  - 点击停止打开对话框；取消不停止任何东西。
  - 确认：经真实 API 封装发出一次 `POST …/stop`（fetch 层计数为 1），并显示「继续」恢复说明。
  - 状态页：取消不停止；确认只调用一次 `assistant.stopAll`，并显示 2 个 helper 的数量文案（只统计 queued / running / asking）。
  - 无运行中 helper 时文案不含数字。
- 相关既有测试 `assistants-web.test.mjs`、`assistant-side-card.test.mjs`：13/13 通过（两者渲染助理首页头部）。
- `tsc -p tsconfig.json --noEmit`（apps/web）在远端 byte-dev 运行器上通过。首次运行因 zh 文案缺 `_one` 键报 TS2561，已补齐后通过。
- 生产构建：`remote-build.sh --web` 在 byte-dev 上通过（exit 0，SHA256SUMS 校验通过）。该构建早于「帮手」文案与全角问号的复核修改；复核后只重跑了测试与 typecheck，未重新构建。
- `audit:ui` 的 15 个脚本逐个运行全部通过（`pnpm audit:ui` 包装脚本未运行：工作树中的 pnpm 会尝试安装依赖）。
- `prettier --check` 通过（改动的 6 个文件）。
- 截图（`.foundry/attachments/20261118/dev307/`，由无头 Chromium 对一个临时夹具页渲染，夹具未进入补丁）：
  - `dev307-light-open-desktop.png`：浅色桌面，对话框打开，文案「2 个帮手」，标题全角问号。
  - `dev307-dark-open-390px.png`：深色，390 px 宽，对话框打开。
  - 截图为简体中文文案；英文文案只经测试验证，未截图。

## 验收步骤（部署后）

1. 打开助理首页，点头部「停止助理工作」。预期：弹出「停止助理工作？」对话框，文案说明会取消正在运行的 N 个 helper（N 为当前正在做的数量，无运行中工作时不写数字），按钮为「取消」与「停止」。助理仍在运行。
2. 点「取消」或按 Esc。预期：对话框关闭，助理仍在运行，没有停止请求。
3. 再次点「停止助理工作」→「停止」。预期：助理进入暂停，头部显示「已暂停新工作」与「继续」，只发出一次停止请求。
4. 点「继续」。预期：直接恢复，不弹确认。
5. 在「设置 → 状态」重复步骤 1–4。预期：同一对话框与文案。
6. 窄屏（390 px）与深色主题下检查对话框的换行与按钮可见性。

## 限制

- 已部署 dev（2026-11-18），未在真实 dev 账号（e2e-alice）上做浏览器验收；截图来自夹具页，不是真实助理数据。
- 文字命令「停」未加确认（见上）。
- 对话框在确认后即关闭，停止结果仍由原有通知展示；若停止请求失败，错误沿用原有的 `flip` / `run` 处理路径。
- 补丁所基于的共享树包含其他未提交改动（215 个文件）；typecheck 与构建覆盖的是包含这些改动的整棵树，并非仅本次改动。
