# Markdown Mermaid 图表渲染

2026-10-18，在当前 `release/2026-10-16-updates` 分支直接修改；保留已有未提交改动，未切分支、提交或修改其他会话的业务文件。

使用现有 Streamdown 2.6.0 的官方 `@streamdown/mermaid` 1.0.3 插件及 Mermaid 11.17.2。它直接识别标准 Mermaid fenced code block，并提供缩放、平移、全屏、源码复制及 SVG/PNG/Mermaid 下载，无需另写图表布局引擎。选择依据：[官方插件文档](https://streamdown.ai/docs/plugins/mermaid)、[Mermaid 文档](https://mermaid.js.org/)。

实现位于 `apps/web/src/components/conversation/markdown-content.tsx` 与 `markdown-mermaid.tsx`。图表引擎通过动态导入按需加载；流式输出期间保留代码，整轮结束后渲染。应用主题通过 `components/ui/theme-context.ts` 传递；主题或已完成正文变化时重建渲染器，避免保留旧 SVG。错误时显示本地化提示、完整源码和重试按钮。采用 strict 安全模式及 SVG 文本标签，截图中的中文和 `<br/>` 可渲染并导出。

验收使用真实 Chromium：

- 截图中的 9 节点、10 条连线，以及时序图均正常渲染；普通 JavaScript code block 保持原有行为。
- 深浅主题切换、流式/完成切换、合法/错误语法切换、错误重试、中英文控件、缩放/重置、全屏和 Escape 退出已检查。
- SVG 实际下载并通过 XML 解析；中文流程图 PNG 实际下载（500 × 750）。源码复制通过真实按钮的 Clipboard API 调用参数核对，内容与输入一致（忽略代码块末尾换行）；未申请系统剪贴板读取权限。
- 在 dev 已部署聊天页再次验收。使用既有 e2e 测试账号，仅在浏览器内替换测试会话 GET 响应，没有改写真实会话或调用模型。1440 × 1000 及 390 × 844 均检查；窄屏 scrollWidth = innerWidth = 390。
- `scripts/check-changed.sh --files …`：格式、Web 类型检查、2 个相关测试文件、10 项 UI 审计全部通过。Go Server 构建及生产 Web 构建通过。

部署至 https://dev.foundryapp.app ：

- build `85b277ba532a1cbc`；76 个线上构建文件 SHA-256 与独立 staging 构建全部一致。
- Server 重启后健康检查正常，startedAt = `2026-10-18T09:24:04Z`。数据库备份及 quick_check 通过；备份在 `~/.foundry/server-backups/mermaid-20261018-1722/`。
- Web build watcher 已恢复，移除重建时清空在线目录的行为（PM2 参数 `--emptyOutDir false`），避免编辑期间暂时返回 500；按内容哈希保存资源。
- 未重启设备 Worker 或 execution-host。既有源码 Worker PID `241559`、设备 execution-host PID `3432223` 保持不变。

截图位于 `.foundry/attachments/mermaid-deployed-chat-light.png`、`mermaid-deployed-chat-dark.png`、`mermaid-deployed-fullscreen.png`、`mermaid-deployed-narrow.png`。详细检查记录位于 `/tmp/fdy-kUC5JZ/mermaid-checks-complete.log`，部署文件校验位于同目录 `mermaid-deployment-verification.json`。
