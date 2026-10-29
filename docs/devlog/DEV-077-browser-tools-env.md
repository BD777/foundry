# DEV-077 · 浏览器工具：playwright-cli 开箱可用，agent-browser 不再外泄代理密码

状态：已实现。Worker 已发布到 dev，dev 服务器设备的 daemon 已加载新版本；Agent 自验通过；人工验收待确认。代码未提交（按协调要求不做 Git 写操作）。

来源：[DEV-074 调研](../research/agent-live-view-20261029.md) §3.1 的两条发现（playwright-cli 版本漂移；agent-browser 画面流的安全问题），以及 [DEV-075](DEV-075-tool-step-screenshots.md)。协调会话 `sess_1793063405185071529`，实施会话 `sess_1793221659233566981`。

## 结论

| 问题                                           | 根因                                                                                                                                                                                                                                                                                 | 修复（Foundry 能控制的部分）                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `playwright-cli open` 在这台设备上直接失败     | playwright-cli 0.1.22 内置的 Playwright 只找自己的 `chromium-1247` 或 Chrome 稳定版（`/opt/google/chrome/chrome`）。设备上只有 Playwright 缓存里的 `chromium-1246`，也就是 Foundry 浏览器启动器用的那个版本                                                                          | 会话环境设置 `PLAYWRIGHT_MCP_EXECUTABLE_PATH`，指向本会话的 Foundry 启动器（没有 scratch 目录的会话直接指向浏览器）。只选隔离构建：先 Playwright Chromium，再 Chromium。会话已经设置该变量时不覆盖。设备只有日常 Chrome 时不设置，playwright-cli 自己能找到。不再下载第二个浏览器；浏览器经启动器登记为本会话的租约，回复结束时一并回收。Playwright MCP 读同一个变量，同样受益 |
| agent-browser 把代理密码发给画面流的所有客户端 | 会话环境里的 `HTTPS_PROXY` / `HTTP_PROXY` 带 `user:password@`（外部连接的本地代理注入，是真实凭据）。agent-browser 自动读取这些变量，并把解析出的 `proxy.username` / `proxy.password` 写进每条命令都会重发的 `launch` 参数。这些参数以 `type:"command"` 消息广播给画面流的每个客户端 | 会话环境另外设置 `AGENT_BROWSER_PROXY`（不带凭据的地址）、`AGENT_BROWSER_PROXY_USERNAME`、`AGENT_BROWSER_PROXY_PASSWORD`。实测这样 `launch` 参数只剩 `server` 和 `bypass`，代理认证照常生效。密码同时登记为已知秘密                                                                                                                                                            |
| 画面流本身无鉴权                               | agent-browser 0.38.2 每个会话都在 `127.0.0.1` 的随机端口开 WebSocket，没有鉴权。只检查 `Origin`：跨站网页被拒（403），但 `localhost` 来源的页面和不带 Origin 的本地进程都能连上，能看画面、读 tab/URL 和命令记录，还能发送鼠标和键盘输入                                             | 0.38.2 没有在启动时关闭画面流的开关（`AGENT_BROWSER_STREAM_PORT` 的 `0` / `1` / `off` / `false` 都会回退为随机端口），只有运行时的 `stream disable`。Foundry 无法在不破坏 DEV-074 第二期的前提下关掉它，所以写了上游 issue 草稿（见下）。DEV-075 和 Foundry 都不读取画面流                                                                                                     |

### 共享账户设备上的风险

- **同一系统账户**（本设备的 Foundry 设备说明里写明的共享账户）：对方本来就能读取会话进程的 `/proc/<pid>/environ`、浏览器 profile 和截图文件。画面流没有给同一账户增加新的能力，只是更方便。
- **同一台机器上的其他系统账户**：`127.0.0.1` 对所有本地账户开放。修复前，任何本地账户扫一遍端口就能连上画面流，读到外部连接代理的真实密码，看到并操作 Agent 的浏览器。修复后不再有密码，**画面和输入的暴露仍然存在**，要等上游修复。
- **网页**：跨站来源被拒；本机 `localhost` 上任何人起的页面都被放行。
- agent-browser 的 socket 目录在 `$XDG_RUNTIME_DIR/agent-browser`（0700），其中没有凭据。磁盘上没有找到含合成密码的命令日志。实测确认，“命令日志”就是画面流里的 `command` 消息。

## 代码

- `packages/worker/src/resource-pool.ts`：新增 `sessionBrowserToolEnvironment(env, sessionId?, resources?)`，生成上面两组变量。代理按 `AGENT_BROWSER_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY` 的顺序取（含小写形式）。会话已经设置 `AGENT_BROWSER_PROXY_USERNAME` 或 `AGENT_BROWSER_PROXY_PASSWORD` 时不改动。
- `packages/worker/src/session-ambient.ts`：`sessionEnvironment` 在合并外部连接环境之后应用上述函数（只对会话生效，provider 检查不受影响）。原有的 `HTTP(S)_PROXY` 保留不动，模型流量和其他工具不受影响。
- `packages/worker/src/secret-redaction.ts`：日志用的 `redactSecrets` 也先去掉已知秘密（以前只有转写用的 `redactTranscriptText` 这样做）。代理密码以裸值出现时（不在 URL 里，也不是 `"password":` 字段），转写、会话事件和 Worker 日志都会去掉它。
- 测试 `packages/worker/test/browser-tool-environment.test.mjs`（4 项，全部为合成值）：启动器选择与不覆盖规则；代理凭据拆分与不改动的情形；画面流的 `launch` JSON、裸密码文本、带凭据 URL 经 `redactTranscriptText`、`redactSecrets` 和 `sessionEvent`（含 message 的 text/title）后都不含密码；`sessionEnvironment` 实际产出这些变量。

## 检查

- `scripts/check-changed.sh --files`（4 个文件）：prettier、Worker 构建、16 个 Worker 测试文件、`audit:modules` 全部通过。
- 本机复现（修复前）：`playwright-cli open about:blank` 报 `Chromium distribution 'chrome' is not found`。用合成值 `HTTPS_PROXY=http://synthuser:SYNTH-…@127.0.0.1:9` 时，画面流的 `launch` 消息里出现 `"password":"SYNTH-…"`；用 `AGENT_BROWSER_PROXY` 带凭据时同样出现。另外确认真实会话环境也会这样泄露，只看了键名，值没有写进本文。
- 修复方式验证：只用合成值（一个要求 Basic 认证的本地代理），拆分后的变量能通过认证，页面经代理打开，`launch` 里没有凭据。`HTTPS_PROXY` 带凭据和拆分变量同时存在时，agent-browser 用拆分变量，`launch` 里依旧没有凭据。用真实会话环境经新代码访问 `https://example.com`，正常打开。
- 新会话检查：从已安装的新 Worker 运行时调用 `sessionEnvironment`，合成会话、最小环境（`env -i`，只保留 HOME、PATH 和代理变量）。结果：`PLAYWRIGHT_MCP_EXECUTABLE_PATH=<scratch>/bin/playwright-chromium`，`playwright-cli open about:blank` 打开成功（默认 headless；0.1.22 没有 `--headless` 参数，只有 `--headed`）。agent-browser 画面流的所有消息都不含密码。

## 部署与更新

- 只改 Worker，不涉及 Server 或 Web。
- Worker `0.5.7-dev.136.gcea0d99.local.1793222409`，从共享工作树打包。与上一版 `.1793219656`（DEV-075）逐文件比较，只有 `resource-pool.js`、`secret-redaction.js`、`session-ambient.js` 和 `package.json` 不同。旧包备份在服务器发布目录的 `releases/dev077-browser-tools/previous-worker-packages/`。打包前后都通知了 DEV-076，同一时间只有一个发布。`/api/worker/release` 已返回新版本。
- dev 服务器设备通过独立的 `systemd-run --user` 单元执行 `foundry-worker update`：`.1793219656 → .1793222409`，daemon 已重启并加载 `runtime/current`（新版本）。忙碌的执行宿主仍是 `.104`，没有强停，空闲切换后新会话才会拿到这些变量。没有改动其他设备。
- 注意：打包时重建了工作树里的 `packages/worker/dist`。设备上有几个合成或开发用的执行宿主直接运行工作树里的 dist；已加载的模块不受影响，改动只增加内容。

## 上游 issue 草稿（vercel-labs/agent-browser，未提交，等协调者同意）

> **Title:** Stream server: no auth, can't be disabled at startup, and broadcasts launch params including proxy credentials
>
> **Version:** 0.38.2 (linux-x64)
>
> **What happens**
>
> 1. Every session starts a WebSocket stream server on `127.0.0.1:<random>` without authentication. The Origin check rejects cross-site origins, but any local process (no Origin header) and any page served from `localhost` can connect. They receive frames, tabs/URLs and the command activity feed, and they can send `input_mouse` / `input_keyboard`. On multi-user hosts this exposes the agent's browser to every local account.
> 2. The command activity feed includes `launch` params verbatim. When the proxy comes from `HTTP(S)_PROXY` / `AGENT_BROWSER_PROXY` / `--proxy` with userinfo, the params contain `proxy.username` and `proxy.password`. The CLI re-sends `launch` with every command, so a client attached at any time receives the password.
> 3. There is no way to disable the stream at startup: `AGENT_BROWSER_STREAM_PORT=0|1|off|false` all fall back to a random port. Only `stream disable` at runtime turns it off, which leaves a window.
>
> **Repro (synthetic values)**
>
> ```sh
> HTTPS_PROXY=http://u:SYNTH-secret@127.0.0.1:9 agent-browser --session t open about:blank
> agent-browser --session t stream status   # → ws://127.0.0.1:<port>
> # connect any WebSocket client, then:
> HTTPS_PROXY=http://u:SYNTH-secret@127.0.0.1:9 agent-browser --session t eval 1
> # client receives {"action":"launch","params":{"proxy":{"password":"SYNTH-secret",...}},"type":"command"}
> ```
>
> **Asks**
>
> - Redact secrets in broadcast command params (proxy password, `set credentials`, `auth` values, headers), or omit `launch` params from the feed.
> - A startup opt-out, e.g. `AGENT_BROWSER_STREAM=0` / `--no-stream` / config `"stream": false`.
> - Optional token auth for the stream (like the dashboard's access token), or a Unix socket with 0600 permissions.
>
> Workaround we use: pass the credential via `AGENT_BROWSER_PROXY_USERNAME` / `AGENT_BROWSER_PROXY_PASSWORD` with a credential-less `AGENT_BROWSER_PROXY`. The `launch` params then omit them.

## 限制

- 画面流仍然无鉴权，同一台机器的其他本地账户能看到并操作 Agent 的浏览器，要等上游修复或第二期由 Worker 代理。Agent 自己用 `--proxy http://u:p@…` 或 `set credentials` 传入的值仍会出现在画面流里，Foundry 拦不住。
- 长度不足 16 个字符的密码不登记为已知秘密（避免误伤普通文本），只靠 URL 和 `"password":` 等格式规则去除。
- `PLAYWRIGHT_MCP_EXECUTABLE_PATH` 是环境变量，优先级高于项目里 `.playwright/cli.config.json` 的 `executablePath`。想用其他浏览器时，在会话或 profile 环境里自行设置这个变量（Foundry 不会覆盖）。
- 执行宿主空闲切换前，dev 服务器设备上的会话仍是旧行为。其他设备要更新 Worker 后才生效。

## 人工验收

1. 等 dev 服务器设备的执行宿主切换到 `.1793222409`（或在自己的设备上 `foundry-worker update` 并等执行宿主切换），在该设备上新开一个会话。
2. 让 Agent 运行 `echo $PLAYWRIGHT_MCP_EXECUTABLE_PATH; playwright-cli open https://example.com; playwright-cli close`。预期：路径是本会话 scratch 目录下的 `bin/playwright-chromium`，页面打开，没有 “distribution 'chrome' is not found”。
3. 在走外部连接代理的设备上，让 Agent 运行 `env | grep -c AGENT_BROWSER_PROXY_PASSWORD; echo "$AGENT_BROWSER_PROXY"`。预期：计数为 1，地址里没有 `@`。再让它 `agent-browser open https://example.com`，页面正常打开。
4. 会话转写里看不到代理密码。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                                                                       | 剩余动作                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 2026-10-29 05:05 | 接手：本机复现两条发现。找到密码的实际来源：外部连接注入的 `HTTP(S)_PROXY` 会被 agent-browser 自动读取并广播出去。                                               | —                                                                             |
| 2026-10-29 05:18 | 修复与 4 项测试，`check-changed` 通过；合成代理验证拆分后认证可用，画面流不再带密码。                                                                            | 发布                                                                          |
| 2026-10-29 05:22 | Worker `.1793222409` 发布（与 DEV-076 交接发布权）；dev 服务器设备 daemon 安全自更新并已加载新版本；从新运行时做新会话检查，`playwright-cli open` 成功。         | 人工验收；执行宿主切换后在真实会话里复看一次；上游 issue 是否提交待协调者决定 |
| 2026-10-30 05:50 | 用户决定：不提交上游 issue。画面流只监听 `127.0.0.1` 且已校验 `Origin`，跨站网页连不上；本机其他账户能连上属于本地信任边界内的风险，按可接受处理，不再额外防御。 | 无                                                                            |
