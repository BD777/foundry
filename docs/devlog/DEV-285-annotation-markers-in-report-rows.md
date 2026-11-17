# DEV-285 报告行里的注释标记显示为「注释 N」

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #TBD）。

来源：2026-11-17 助理 web 侧评审 D8（`.foundry/reports/assistant-review-20261117-web.md` §D8、R6）。

## 问题

帮手（Claude）在答复里照搬了批注格式：`:codex-annotation{index="1" id="…"}`。这段答复作为 child_report 进入助理 home 对话，原始标记文字直接可见。批注提示格式保持 Codex 原样，本项只改显示。

## 调查

- 渲染链：`MarkdownContent` 的 remark 插件链（`remarkCodexAnnotations`）已经把标记转成引用链接。用测试 harness 直接渲染，正文、加粗后紧贴标记、列表、标题、表格中的标记都显示为「Annotation 1」，没有原始文字。
- 仍会露出原始标记的路径：
  1. 代码 span 只含一个标记（`` `:codex-annotation{…}` ``）。插件按设计保留代码原文，于是显示为代码。帮手把格式当作示例写进代码时就会出现。
  2. 纯文本行（`TurnSourceRow` 的非 Markdown 分支，例如 `caughtUp` 的定时/后台正文）。
  3. 过程行的文字片段（`process-disclosure.tsx` 中非工具调用的 `snippet`）。
- 未能从代码路径复现 R6 当时的确切渲染形态（事件数据不在本地）。以上三条是能确认的未覆盖路径；第 1 条是最可能的形态，属推断。

## 修复

- `remark-codex-annotations.ts`：抽出 `splitAnnotationDirectives`，Markdown 插件与纯文本渲染共用同一解析。index 不是正整数的标记保持文字。只含一个标记的代码 span 变为引用；含其他文字的代码和已有链接保持原样。
- `annotation-reference.tsx`：新增 `AnnotatedText`，纯文本按同一解析渲染为 `AnnotationReference`（有 id 且可查到批注时带悬停提示）。
- `turn-source-row.tsx`（非 Markdown 正文）与 `process-disclosure.tsx`（文字片段）改用 `AnnotatedText`。
- 工具调用的输出（`pre`）、通道原始消息、系统状态文字不是 agent 答复，未改。

## 验证

- Web typecheck：通过（Mac mini，`remote-check --web typecheck`）。
- 定向测试（Mac mini）：`remark-codex-annotations.test.mjs`（6 项，含新增的代码 span 与 index 0 用例）、`annotation-display.test.mjs`（新增，3 项：child_report 正文、代码 span 内的标记、纯文本片段）、`chat-markdown.test.mjs`、`chat-steer-annotations.test.mjs` 全部通过。
- 生产构建门：`pnpm --filter @foundry/web build` 通过（Mac mini）。

## 限制

- 未做真实浏览器的深色/浅色与窄屏核对；本项只改文字渲染，沿用既有「注释 N」样式和主题 token，验收时需在 dev 上用 e2e-alice 的合成数据看一次报告行。
- 代码 span 转引用是本项的判断，需要人确认：若希望代码永远原样显示，应改为修正批注提示（由 DEV-282 处理），而不是恢复原文。
- 未部署、未提交。

## 验收步骤

1. 让助理的帮手在答复中写出 `` `:codex-annotation{index="1" id="x"}` `` 或裸标记。
2. 助理 home 中该 child_report 行正文显示「注释 1」，无原始 `:codex-annotation`。
3. 深色与浅色主题、390px 宽度下，引用文字可读，悬停（有 id 且可查到时）显示批注。

## 时间线

| 日期       | 事项                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Agent 代验收（编排者）：子会话回报行与帮手转录中显示「注释 1」，无原始标记；浅色/深色/390 px。截图 `.foundry/attachments/20261118/verify-278-285/`（未提交）。 |
