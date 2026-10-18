# 中文 Markdown 渲染复查

2026-10-18，针对截图中加粗标记原样显示的问题复查。

## 根因与修复

已核对截图对应会话的原始响应：`**高置信度：**下架后`、`**目前没有必须请你 review 或拍板的地方。**按你…` 等标记完整。用原有 Streamdown 配置分别在 static / streaming 模式重放，两者都会输出普通文本；`**中文加粗**正常` 则正确。问题出在中文标点附近的强调定界规则，发生在生成 DOM 之前。此前 Mermaid 验收没有覆盖这组 CJK 语法边界，是测试遗漏。

采用 Streamdown 官方 CJK 插件所使用的 `remark-cjk-friendly` 与 `remark-cjk-friendly-gfm-strikethrough`，分别在 GFM 前后注册；两种渲染模式共用这一语法管线。见[官方 CJK 说明](https://streamdown.ai/docs/plugins/cjk)。没有重写正文、添加空格或调整加粗 CSS。

复查也发现，直接接入完整 `@streamdown/cjk` 会把 `[https://a.example/p。q](https://a.example/p。q)` 与 `<https://a.example/p。q>` 的作者指定链接截成 `https://a.example/p`。因此只使用其成熟的语法扩展，继续保留已有的、能识别源码边界的裸链接处理。这两种显式链接已新增反向回归，完整 CJK 插件未保留在依赖中。

实现仅修改 `apps/web/src/components/conversation/markdown-content.tsx` 的语法插件列表，以及依赖声明/锁文件。用户消息换行、普通列表、文件引用、图片和 Mermaid 的现有接入未调整。当前分支 `release/2026-10-16-updates`，本轮改动保持未暂存，未改动其他会话的暂存内容。

## 验证

`apps/web/test/chat-markdown.test.mjs` 共 13 个测试通过，包含：

- 截图里的四种加粗、中文括号/冒号、斜体、删除线，覆盖 streaming / static / typedText 三种入口。
- 标题、引用、嵌套列表、有序列表、表格，及强调内部的代码与链接混合出现。
- 代码块、行内代码、反斜杠转义保留字面量；流式转完成后格式与文本一致。
- 原有中文裸链接边界、显式链接、相对文件引用、不安全协议拦截和 Mermaid 回归。
- 显式链接包含中文句号时，标签与完整目标保持一致。

真实 Chromium 使用 dev 已部署聊天页，浏览器内替换既有 e2e 测试账号的只读会话响应，没有修改真实会话或调用模型。重放截图原文并混入上述结构与 Mermaid，检查浅色/深色、1440 × 1000 与 390 × 844。截图中的四处加粗均生成强调节点，计算字体为 600；窄屏 scrollWidth = innerWidth = 390。普通代码和转义文本仍显示星号；同一正文中的 Mermaid 正常生成 SVG。

截图：`.foundry/attachments/markdown-cjk-deployed-light.png`、`markdown-cjk-deployed-dark.png`、`markdown-cjk-deployed-narrow.png`、`markdown-cjk-mermaid-narrow.png`。

检查日志：`/tmp/fdy-kUC5JZ/markdown-review-final-tests.log`、`markdown-review-final-checks.log`。独立构建及线上产物核对记录在同目录的 `markdown-review-final-build.log` 与 `markdown-review-deployment.json`。

最终检查：格式、Web 类型检查、2 个相关测试文件及 10 项 UI 审计全部通过；独立生产构建通过。线上 build `31c3593a24a2ca87`，76 个产物 SHA-256 与独立构建全部相符。Web 已通过现有构建监听器发布；Server 健康检查正常。
