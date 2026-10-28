# DEV-065 聊天文件面板细节：路径可复制、Diff/File 切换保留焦点、下载移入标题栏

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

| 环节         | 状态   | 说明                                                                                                                                          |
| ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解     | 已完成 | 用户 10-28 提出三项（两张截图），编排会话 `sess_1793063405185071529` 转交                                                                     |
| 代码         | 已完成 | 只改 Web（文件清单见下）；在 DEV-064 的面板代码上修改                                                                                         |
| 自动检查     | 已完成 | `scripts/check-changed.sh`：prettier、tsc、web tests（63 个文件）、audit:ui 全部通过                                                          |
| dev Web 部署 | 已完成 | `b0ba3d5929f1811e`（共享树构建，经 `scripts/deploy-web-dev.sh`）；上一版 `6796efb44e5fdab8` 的入口保存在 `~/.foundry/server/releases/dev065/` |
| Agent 自验   | 已完成 | 真实浏览器（dev，e2e-alice），light/dark × 1280/390，每组 21 项检查全部通过                                                                   |
| 人工验收     | 待确认 | 见“验收步骤”                                                                                                                                  |

## 问题

1. 回答里的文件路径渲染成链接按钮，文字不能选中复制；面板里的路径也没有复制入口。
2. 文件面板里在 Diff 和 File 之间切换后，键盘焦点丢失（落到 `body`）。
3. 面板标题栏下单独一行 “Download file” 按钮，占了一整行。

## 原因与修复

- **焦点丢失**：`ChangeDetail` 在 Diff 模式返回 `<article>`，在 File 模式返回 `<SessionFileView>`。两种模式的根组件类型不同，React 会重新挂载整棵树，分段控件也跟着重建，焦点就丢了。修复：把 `SessionFileView` 的内容拆成 `SessionFileContent`；两种模式共用同一个 `<article>`，工具栏位置不变，只替换下面的内容。
- **下载**：把下载逻辑提取为 `useChatFileDownload`，由面板调用一次。下载按钮改为标题栏里的图标按钮 `ChatFileDownloadButton`，放在关闭 X 左边，带 Tooltip，aria-label 为 “Download file / 下载文件”。下载中图标转圈，设置 `aria-busy` 和 `aria-disabled`，不用 `disabled`，所以键盘焦点不会丢；失败时图标变成错误色。进度和失败原因（带“重试文件”）由 `ChatFileDownloadStatus` 显示在正文顶部，只在有内容时出现，原来那一整行已去掉。设备文件（`chat-device-file.tsx`）有敏感文件判断，仍保留正文里的带文字按钮。
- **路径复制**：
  - 面板里的路径行 `FilePathLine` 文字可选中，旁边有常驻的 `CopyButton`（aria-label 为 “Copy path / 复制路径”）。复制后 1.2 s 内显示对勾，aria-label 改为 “Copied”，同时弹出 Toast。
  - 回答里的路径（`markdown-content.tsx` 的 `FileReferenceButton`）后面加了 `CopyButton`（“Copy {{path}}”）。平时宽度为 0，不占句中位置；悬停或键盘聚焦（`:focus-within`）时展开；在没有悬停能力的设备上（`@media (hover: none)`）一直显示。Tab 从链接移到复制按钮，按 Enter 复制完整路径。
- i18n：`chat.detail.copyPath` 和 `conversation.message.copyPath` 的中英文。下载文案沿用 `detail.fileRead.download/downloading`。

文件：`apps/web/src/features/chat/{chat-file-download,chat-detail-panel,chat-detail-change,chat-detail-files}.tsx`、`apps/web/src/components/conversation/markdown-content.tsx`、`apps/web/src/styles/{20-chat-detail,20-chat-thread-and-context}.css`、`apps/web/src/i18n/locales/{en,zh-CN}/{chat,conversation}.ts`、测试 `apps/web/test/chat-file-panel-polish.test.mjs`（新增）和 `apps/web/test/file-delivery.test.mjs`（下载按钮断言改为看 aria-label）。

## 验证

- 单测：`chat-file-panel-polish.test.mjs` 覆盖 Diff→File→Diff 切换后 `document.activeElement` 仍是同一个分段按钮，以及面板路径复制和 “Copied” 状态；`file-delivery`、`chat-change-detail`、`chat-markdown`、`chat-file-paths` 通过。
- 首次运行 `check-changed` 时，`file-delivery` 有 3 项失败、`session-work-controls` 有 1 项失败。原因是共享树里他人未提交的 `api/http.ts` GET 重启重试会多发请求，与本项无关；第二次运行时 63 个测试文件全部通过。
- 真实浏览器：headless Chromium，dev 发布 `b0ba3d5929f1811e`，复用 e2e-alice 登录，打开 DEV-055 合成会话 `sess_1793120845188154104`。只在这个浏览器内改写只读 GET：在会话 thread 里加一条合成的工具写入记录，并模拟 `files/read`、`files/diff`、`files/download`（下载先延迟 1.5 s，再改为 409 测失败）。没有新建业务对象，没有发消息，也没有运行模型。light/dark × 1280/390 四组各 21 项检查全部通过：
  - 回答路径的复制按钮平时不占宽度；Tab 能聚焦到它，聚焦后可见；Enter 后显示 “Copied”，剪贴板内容是完整路径。
  - 标题栏只有一个下载图标，正文里没有下载行。
  - 用键盘（方向键 + Space）和鼠标切换 Diff/File 后，焦点都留在分段控件上。
  - 面板路径复制按钮可聚焦，复制结果和反馈正确。
  - 下载时 busy 状态和焦点保持正确，文件名正确，下载完成后恢复空闲；失败时图标变为错误态，正文显示可重试的原因，悬停显示 Tooltip。
  - 截图：`.foundry/attachments/20261028/dev065/`（`{light,dark}-{1280,390}-{chat-copy-focus,chat-copied,panel-diff,panel-file,download-busy,download-error}.png`）。

## 限制

- 回答里的路径本身仍是按钮（点击打开文件），拖选文字不能代替复制；复制入口是旁边的复制按钮。
- 设备文件（工作区外）的下载仍在正文里，没有移到标题栏。
- 差异不可用时点 “View file” 会卸载这个按钮，焦点不会移到分段控件上（本次未处理）。

## 验收步骤

1. 打开 https://dev.foundryapp.app/chats/sess_1792897906152291224?workspace=ws_7a62ebd5-ba52-46df-8306-c23ad1c22c51 （或任一回答里带文件路径的聊天）。把鼠标悬停在回答里的路径上，或用 Tab 聚焦。预期：路径后出现复制图标；点击或按 Enter 后，图标变为对勾并弹出 “Copied”；粘贴得到完整路径。不悬停时，路径后没有空隙。
2. 打开一个文件。预期：标题栏 “Change/File + 文件名” 右侧、X 左侧有下载图标，悬停显示 “Download file”；原来单独的 “Download file” 行已去掉；“New file / Diff | File / All of this chat's edits” 行保留。点击下载图标，图标转圈后开始下载。
3. 在 Change 文件上按 Tab 聚焦 Diff/File，用左右方向键加 Space（或鼠标）来回切换。预期：焦点环一直留在分段控件上。
4. 面板里路径行右侧的复制按钮，复制得到工作区相对路径。
5. 切换深色模式和窄屏（手机宽度）各看一次，按钮都可见、可用。

## 时间线

| 时间             | 事件                                                                         | 下一步   |
| ---------------- | ---------------------------------------------------------------------------- | -------- |
| 2026-10-28 22:05 | 实现、单测、dev Web 发布 `b0ba3d5929f1811e`，真实浏览器矩阵通过，devlog 完成 | 人工验收 |
