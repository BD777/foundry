# DEV-210 Workspace 文件面板内联预览图片

## 状态

已合入 main（PR #267）。

实现、远程检查、dev 部署和真实浏览器截图已完成；train 已恢复 DEV-216/DEV-209 并保留本功能。SVG 的代理 `Content-Length` 补丁已交 train conductor，等待应用。未提交。

## 问题

Workspace files 面板打开 `funnel-snapshot.png` 时只显示 “Binary file, not previewable. Download it to open.”。图片内容通过普通文件读取返回，面板把前 8 KB 含 NUL 的文件统称为二进制，下载按钮虽然可用，但无法直接检查图片。

## 调查

- 面板入口是 `chat-detail-files.tsx` 的 `FileDetail`。它先看 `WorkspaceFileRead.content` 的前 8 KB，因此 PNG、JPEG 等有效图片也会进入二进制提示。
- 下载走 `/api/workspace-files/download`，浏览器请求携带 `__Host-foundry_session` cookie。原响应统一是 `application/octet-stream`，带 `Content-Disposition: attachment` 和 `nosniff`，没有实际图片 MIME，也没有面向 SVG 的 CSP。
- 对话附件图片使用 `attachment-list` / `local-image` 的共享图片缓存与 lightbox，不经过 Workspace files 的 `FileDetail`，因此不重复实现。

## 修复

- Server 下载端点用扩展名与文件头共同确认 `png`、`jpg`/`jpeg`、`gif`、`webp`、`avif`、`bmp`、`ico`、`svg`；扩展名与实际内容不一致时仍回退 `application/octet-stream`。
- 下载端点支持 `HEAD`：只读首个 64 KiB 分块，返回完整文件大小和经 magic bytes 验证的 `Content-Type`，不继续流式读取大文件。
- 下载响应加 `Content-Security-Policy: sandbox; default-src 'none'` 和 `Cross-Origin-Resource-Policy: same-origin`，并保留 `X-Content-Type-Options: nosniff` 与 attachment disposition。SVG 只通过 `<img>` 加载，不以内联 markup 渲染。
- Web 先 `HEAD` 判断 MIME 和大小；只对 20 MiB 以内的受支持图片发起 GET，并用 `URL.createObjectURL` 的 blob URL 显示，组件卸载或重试时回收 URL。
- 预览显示尺寸和文件大小，默认适应面板宽度；点击图片在 100% 和适应宽度间切换，100% 时容器可滚动。透明区域使用随明暗主题变化的棋盘格背景。
- 超限图片保留下载提示并显示实际大小；读取、解码和重试沿用共享 `LoadingState`、`Alert`、`Button` 与文件读取错误文案。

## 检查

| 检查                                                         | 结果                  |
| ------------------------------------------------------------ | --------------------- |
| macbook compute: `scripts/remote-check.sh … --web typecheck` | 通过，41 s            |
| macbook compute: 6 个 `internal/httpapi` 下载/图片测试       | 通过，6.805 s         |
| `chat-image-file-preview.test.mjs`                           | 4/4 通过              |
| macbook compute: `pnpm --filter @foundry/web audit:ui`       | 15 项 UI 审计全部通过 |
| 实时源码快照：最终 header 补丁后的 Web `tsc --noEmit`        | 通过                  |
| 实时源码快照：2 个下载/图片 Go 测试                          | 通过，2.855 s         |

## 部署与浏览器证据

- 2026-11-13 18:31（UTC+8）在 `/tmp/fdy-deploy.lock` 下发布 Web `ddabdc4c106c8b9d`、Server `bb1130678bb23f26871d99ce3f51963548f4762a20485e46cbb0bcfbd8743b29`。`/healthz` 返回 200，`startedAt` 为 `2026-11-13T10:31:36Z`；运行进程 `/proc/1736909/exe` 哈希与发布文件一致。截图在同一构建上完成。
- 发布后核对入口资源和 `/version.json`；真实 e2e-alice 浏览器在 1280×900 下通过 Workspace files 面板打开合成文件。PNG 显示 `828 × 528 · 57.2 KB`，浅色和深色截图见下。点击后按钮从“以 100% 查看”变为“让 … 适应面板宽度”，滚动容器从 `674/674` 变为 `674/736`，证明 100% 与滚动切换生效。
- 超过 20 MiB 的 PNG 只触发 `workspace-files/read` 与一次 `HEAD`，没有图片 `GET`；页面显示包含 `21.0 MB` 和 `20 MB` 上限的超限提示。
- SVG 的实际 GET 返回 `image/svg+xml`、1262 bytes，浏览器解码为 `720 × 440`。公网 nginx 对 SVG 做 gzip 后会移除 `Content-Length`，所以当前已部署版本的 HEAD 没有大小字段；截图时只在浏览器测试中补上同一份实际响应的大小头。代码已改为优先读取 `X-Foundry-File-Size`，并已作为补丁交给 train conductor。
- 截图（1280×577，正常比例）：[PNG 浅色](../../.foundry/attachments/20261113/dev210/png-light.png)、[PNG 深色](../../.foundry/attachments/20261113/dev210/png-dark.png)、[SVG 深色](../../.foundry/attachments/20261113/dev210/svg-dark.png)、[超限 PNG 深色](../../.foundry/attachments/20261113/dev210/oversize-dark.png)。
- 本轮 10:31 发布后发现基线不含随后出现的 DEV-216；收到 train 策略后没有再次部署。train 已在 19:14（UTC+8）恢复后续功能并保留 DEV-210，当前 Web 为 `fbb6b42c7eb3e557`、Server 为 `789843f2ffc11b24b012aed124dee5f1a0dfd27da4e3abe8d86fae10ad9b6aee`，`startedAt` 为 `2026-11-13T11:14:04Z`。SVG 大小头补丁位于 `/tmp/DEV-210-file-size-header.patch`，SHA-256 `0fefcbf89d325d14de7b328cc1ac28f584d0187989a12c1f014d468801ee489c`。

## 验收步骤

1. 在 Workspace files 面板打开 PNG，预期图片直接显示，标题下显示宽高与大小；浅色、深色下透明棋盘格都清楚。
2. 点击图片，预期切到 100%；图片宽于面板时出现滚动，再点击回到适应宽度。
3. 打开 SVG，预期以图片正常显示，不出现源码或脚本执行。
4. 打开超过 20 MiB 的 PNG，预期不发起图片 GET，显示包含实际大小的超限提示，下载按钮仍可用。

## 限制

- 当前已部署 Server 的 compute 工具结果上限为 6000 bytes，远端 28 MB 构建产物回传过慢；最终构建改在 sg-chaos 的 `/tmp/fdy-heavy.lock` 下从只含本事项改动的冻结快照完成。
- 不改变对话附件图片的现有预览路径。
- 当前 dev 的 SVG 在线预览要等 train 应用 `X-Foundry-File-Size` 补丁；PNG 和超限行为不依赖该补丁。

| 2026-11-13 20:45 | 文件大小头随第二班列车上线（Server `61f14d85…`，后续 `9e758c9a…`；Web `17e800313131e760` / `8af18e21af705018`）。编排会话代为验证（原会话已归档）：e2e-alice 的合成工作区 `ws_68dbe9ca-…`（合成设备 VM-4-8-debian，临时以 `dev210-svg-check-worker` 单元运行，验后停止），经公网 nginx 代理 HEAD/GET 合成 SVG：159 B 时 `image/svg+xml`、`Content-Length: 159`、`X-Foundry-File-Size: 159`；21,922 B 时 nginx 以 gzip 返回且不带 Content-Length，`X-Foundry-File-Size: 21922` 仍在并经 `Access-Control-Expose-Headers` 暴露；两者都带 `Content-Security-Policy: sandbox; default-src 'none'`、`X-Content-Type-Options: nosniff`、`Content-Disposition: attachment`。合成文件、登录 cookie 已删除并登出 | 本人在浏览器里打开 SVG 预览验收 |
