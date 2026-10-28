# DEV-055 回复中的文件路径可点击查看与下载

状态：Phase 1（工作区内路径）与 Phase 2（工作区外设备文件，仅设备所有者）已实现、部署 dev，并经 Agent 自验；人工验收待确认。

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

2026-10-27 用户反馈（截图 `.foundry/attachments/20261027/att_dmfp3v0ehs37_0_image.png`）：Agent 回复「实际 API Key 在 `~/.local/share/<app>/app.key`」，路径只是普通 code，用户希望识别为文件、可点击查看和下载。负责会话 `sess_1793116876771359572`，编排 `sess_1793063405185071529`。

## 原因（真实会话只读核对）

示例来自用户 Linux 开发机上一个工作区的 `sess_1793083163084997487`。北京时间 2026-10-27 18:20:02，Agent 在一条 shell 命令里用 `python3` heredoc 创建了 `~/.local/share/<app>/app.key`（0600），18:47:03 的回答引用了它。

回答中的链接只来自 Worker 在回合结束时的 `resolveFileReferences`（`packages/worker/src/session-file-references.ts`），它只认「设备上存在、且会话可以展示」的路径。对工作区外的文件，必须满足下面两条之一：

1. 会话的文件编辑工具写过（账本 origin `tool`）；
2. 位于临时目录（`/tmp`、`$TMPDIR`），且在本回合内修改过。

这个 key 两条都不满足：shell 命令创建的文件不进入工具写入账本，`~/.local/share` 也不是临时目录。所以它没有成为 `fileReferences`，Web 端的 `markdown-content.tsx` 只给 `fileReferences` 中的文本渲染按钮，它就只能是普通 code。同一会话中，`~/.config/systemd/user/ccm-autorun-mcp.service` 由工具写入，因此在会话文件列表里（`read_context scope=changes`）。

另外两处缺口：

- 工作区内的路径，只有回合结束时已存在才会被链接。之后才生成的文件、旧回答，或 Worker 没解析出的相对写法，都没有入口。
- 工作区文件读取被设备拒绝（不存在、越界、不是文件）时，Server 返回 500。Web 把它显示成「无法读取，请检查设备连接」，还会重试一次。

## Phase 1：工作区内路径（已实现）

规则：只看回答中的行内 code 和链接目标，fenced code block 不处理。路径形状由 Web 端判断，渲染时不发任何请求；点击后才由设备通过现有工作区读取接口解析，权限与工作区文件浏览器相同（workspace viewer），设备照旧拒绝越界路径、符号链接逃逸和 `.git` 内部文件。

- `components/conversation/file-path-candidate.ts`：`workspacePathReference(text, root)` 剥离行号后缀（`:12`、`#L10-L20`）和 `file://`，并接受：
  - 工作区内的绝对路径；
  - 带扩展名的相对路径，以及 `./x`、以 `/` 结尾的目录；
  - 常见扩展名的单独文件名（如 `package.json`）。

  排除：分支名、`@scope/pkg`、CIDR、无协议的主机名 URL、`console.log`、`Node.js`、版本号、`..` 越界，以及 `~/…` 与工作区外路径（留给 Phase 2）。结果标记 `unverified`，`kind` 按形状推测（以 `/` 结尾或无扩展名视为目录，`Makefile` 等常见无扩展名文件除外）。

- `markdown-content.tsx`（与 DEV-054 协调，只改 `fileLinkComponents` 中的文件分支和 `fileRoot` 属性）：
  - 已验证的引用优先；
  - Foundry id 链接，以及 `isAppHref` 判定的站内路由，交给 DEV-054 的 `MarkdownLink`；
  - 根路径链接改读 DEV-054 记录的 `dataRootHref`；
  - 流式输出期间不加链接。
- `chat-message-list.tsx`：只有 Agent 回答传入工作区根目录，用户自己的消息不加链接。
- `use-chat-context-panel.ts`：路径若已在会话文件账本中，打开原有的会话文件视图（含 diff）；否则打开新的 `workspace-path` 选择。目录从该目录开始浏览，文件直接打开预览，同时提供下载，「返回」回到所在目录。工作区根目录由 `chatContextCardForSessions` 提供（`workspaceRoot`），只在会话所属工作区与当前工作区一致时设置。
- `workspace-directory-browser.tsx`：新增 `startPath`。
- `chat-detail-panel.tsx`、`styles/20-chat-detail.css`：
  - 从文件返回目录时，标题显示目录名，不再是「File · 文件名」；
  - 「下载文件」按钮和读取失败提示与文件内容对齐（32px，窄面板 16px）。原来它们贴在面板边缘，这是 DEV-051 起所有文件视图共有的问题。
  - 失败提示放在自有容器 `.fdy-chat-detail-feedback` 中，没有覆盖共享 Alert 的样式。
- Server `httpapi/file_downloads.go`：设备拒绝工作区文件读取时返回 404，带上设备给出的原因，不再返回 500。Web 因此显示「文件不存在或已不可用」，也不再自动重试。兼容旧 Worker（沿用原有 `error` 字段）。

不改 Worker，也不改协议。

## Phase 2：工作区外的设备文件（已实现）

2026-10-28 用户批准按推荐方案实现（编排转达，原话「follow your recommendations」）：

1. 默认对设备所有者开启，Devices 页可按设备关闭；工作区成员、共享用户和会话 token 一律不可用。
2. 看起来是密钥的文件（`*.key`、`*.pem`、`.env*`、名称含 token/credential 等）遮罩显示，提供「显示」「复制」，不提供下载；内容不在服务器缓存，不写日志，不进会话记录。
3. 显示前不要求重新验证（可作为后续）。
4. 始终拒绝：`~/.ssh`、`~/.aws`、`~/.gnupg`、系统钥匙串/凭据库、浏览器配置目录；对命名路径和 realpath 都检查。

### API（Server，`httpapi/device_files.go`）

| 路由                                                                             | 说明                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/devices/{deviceId}/files?path=&mode=read\|reveal\|stat[&purpose=copy]` | `read` 返回元数据与文本开头（密钥类文件不含内容）；`reveal` 含内容；`stat` 只有元数据 |
| `GET /api/devices/{deviceId}/files/download?path=`                               | 复用 DEV-051 分块流，100 MiB 上限；密钥类文件由设备逐块拒绝（403 `file_sensitive`）   |
| `PUT /api/devices/{deviceId}/outside-files` `{enabled}`                          | 所有者开关；设备投影对所有者带 `outsideFilesOff`                                      |

统一的准入（`openDeviceFiles`）：

- 只允许已登录账户本人，且该账户正是设备的 `owner`。管理员不放行，会话 token 在中间件层即 403（不在 `agentRouteAllowed`）。
- 必须带 `X-Foundry-Intent: device-file` 请求头。跨站页面和地址栏导航带不了它。
- 开关关闭时返回 403 `device_files_off`；设备离线返回 409；Worker 没有 `device_files_v1` 能力时返回 409 `worker_update_required`。
- 所有响应 `no-store`，内容只透传，不缓存也不写日志。
- 每次 read/reveal/copy/download 写一行 `device_file_access`（用户、设备、路径、动作、结果、显示字节数，不含内容），保留 90 天。

存储为两张新表：`device_outside_files`（开关）和 `device_file_access`（访问记录），迁移只做加法。

### 设备策略（Worker，`device-files.ts`）

- 展开 `~`，只接受绝对路径。对命名路径和 realpath 分别检查拒绝列表，防止符号链接绕过；只服务普通文件。
- 拒绝列表：
  - `~/.ssh`、`~/.aws`、`~/.gnupg`；
  - Foundry 与 Agent 凭据：`~/.foundry`、`~/.codex`、`~/.claude*`；
  - `~/.azure`、`~/.kube`、`~/.docker/config.json`、`~/.netrc`、`~/.git-credentials`、`~/.pgpass`、`~/.password-store`、`~/.config/gcloud`、`~/.config/gh/hosts.yml`、`~/.local/share/keyrings`、`~/.pki`；
  - 各浏览器配置目录（Linux/macOS/Windows）；
  - macOS Keychains、Safari/Cookies、TCC，Windows Credentials/Protect/Vault；
  - `/etc/shadow`、`/etc/sudoers`、`/etc/ssh`、`/proc`、`/sys`、`/dev`；
  - 任意 `.git` 内部和 `*.keychain(-db)`。
- 密钥类：
  - 文件名：`*.key`、`*.pem`、`*.p12`/`*.pfx`、`*.jks`、`*.keystore`、`*.kdbx`、`*.ppk`、`*.gpg`、`id_*`、`.env*`，以及名称含 token/secret/credential/password/api-key 的文件；
  - 内容：前 4 KiB 出现 `PRIVATE KEY` 头。
- 预览 128 KiB；二进制文件（前 8 KB 含 NUL）不返回内容；下载沿用 100 MiB 上限与文件版本校验。

### Web

- 链接：只在所有者本人、开关开启时识别工作区外路径（绝对路径或 `~/…`，按形状判断为文件）。标题为「在本设备上打开 …（仅你作为设备所有者可见）」。工作区内路径仍走 Phase 1。
- 侧栏 `DeviceFileDetail`（`chat-device-file.tsx`）：
  - 加载、离线、慢、需要更新 Worker、不存在、拒绝（凭据库）、不是普通文件、已关闭等状态，都有明确提示；
  - 文本文件可预览并下载；二进制文件只能下载；
  - 密钥类文件显示大小与 `••••`，提供「显示/隐藏」「复制」，没有下载。复制直接写入剪贴板而不渲染。内容只存在于该视图的状态中。
- Devices 页「设置」新增「会话中的文件」：一个勾选项和说明，只对所有者显示。

### 威胁与对策（实现后）

| 情形                         | 对策                                                      | 证据                                               |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| 共享工作区成员               | 链接不渲染；Server 校验 owner，否则 404                   | Go 测试 bob（成员）→ 404；实测非所有者 → 404       |
| 会话 token（被注入的 Agent） | 中间件 403                                                | Go 测试；实测合成会话中的 Agent 用自身 token → 403 |
| 跨站请求或导航               | 必须带意图头                                              | Go 测试无意图头 → 403                              |
| 符号链接或 `..` 绕过         | 命名路径和 realpath 双检；Web 拒绝 `..`                   | Worker 测试；实测指向 `~/.ssh` 的链接 → 拒绝       |
| 机密进入缓存、日志、会话记录 | no-store，不进 DEV-051 缓存；审计不含内容；查看不回写会话 | Go 测试检查记录不含内容                            |
| 被他人看到屏幕               | 默认遮罩                                                  | 实测截图                                           |
| 浏览器会话被盗               | 拒绝列表、审计、所有者开关；重新验证留作后续              | —                                                  |
| FIFO 或超大文件              | 只服务普通文件；预览和下载都有上限                        | Worker 测试                                        |

## 验收步骤（dev）

1. 打开一个工作区设备在线的会话，让 Agent 在回答中用行内 code 写出工作区内已存在的文件，如 `README.md`、`docs/xxx.md`，再写一个目录，如 `docs/`。
   预期：回答结束后，这些路径带文件或文件夹图标，可以点击；fenced code 中的同一路径仍是代码；分支名和 URL 不变；你自己发的消息中的路径不加链接。
2. 点击文件路径。
   预期：侧栏显示文件内容和「下载文件」；下载得到完整文件；点左上「返回」进入所在目录，标题为目录名。
3. 点击目录路径。
   预期：侧栏从该目录开始浏览。
4. 让 Agent 写一个不存在的工作区路径，如 `docs/not-here.md`，然后点击。
   预期：显示「文件不存在或已不可用」和「重试」，不再显示「请检查设备连接」。
5. （Phase 2，设备所有者）让 Agent 在回答中写出你设备上工作区外的文件，如 `~/notes/todo.md`，然后点击。
   预期：侧栏「设备文件」显示「位于 <设备>，在工作区之外；仅你可以打开」和内容，并有「下载文件」。
6. 写一个密钥类文件，如 `~/.local/share/<app>/app.key`，然后点击。
   预期：显示大小与 `••••`，有「显示」「复制」，没有「下载文件」。「显示」后出现内容，「隐藏」后恢复遮罩；「复制」后剪贴板有内容，页面不显示。
7. 写 `~/.ssh/known_hosts`（或指向它的符号链接），然后点击。
   预期：提示 Foundry 不打开凭据库，不显示任何内容。
8. Devices → 这台设备 → 设置 → 取消「允许从会话打开这台设备工作区外的文件」。
   预期：会话中工作区外路径不再是链接；已打开的面板重试后提示已关闭。重新勾选后恢复。
9. 让与你共享该工作区的另一个账户打开同一会话。
   预期：工作区外路径对他不是链接；直接请求接口返回 404。

## 进展

- 2026-10-28 00:10：定位原因（见上）；Phase 1 实现，`chat-file-paths.test.mjs` 6/6 通过，相关 chat 测试通过，Web typecheck 通过。`chat-markdown.test.mjs` 中 `/chats/x` 一项因 DEV-054 新的站内链接行为而失败，归 DEV-054 更新。部署待与 DEV-054 合并为一次 Web/Server 发布（共享工作树中 DEV-054 的 Server 改动尚在进行）。
- 2026-10-28 00:40：与 DEV-054 合并为一次 Web+Server 发布（DEV-054 执行）：
  - Server sha256 `afc7f429…c68a`，pm2 PID 1809098，healthz startedAt 16:48:09Z（UTC）；
  - Web `c56349edfb2b5bb4`；
  - 回滚包在 `~/.foundry/server/releases/dev054-055-links/`。
- 2026-10-28 00:36：意外事件。DEV-056 在 16:22:49Z 发布的 Web `bf02cf6e76e0debc` 构建时没有加载 `.env.production`，bundle 调用 `http://127.0.0.1:31982`，dev 全站显示「Local API is not reachable」。DEV-056 当时已不接收消息，本会话用它自己的备份恢复 `index.html`/`version.json` 到 `1792b54a13066032`；坏版本保存在 `~/.foundry/server/releases/dev055-rollback-bf02/`。浏览器复核 API 请求恢复为同源。之后发布统一使用 `scripts/deploy-web-dev.sh`。
- 2026-10-28 00:54：浏览器验证发现两处问题并修正：单段目录 `docs/` 未识别；面板中下载按钮和失败提示贴边。Web `51348b26f88082da` 经 `scripts/deploy-web-dev.sh` 发布（从共享工作树构建，脚本检查通过：入口 asset 一致、API 同源 JSON），上一版 `c56349edfb2b5bb4` 保存在 `~/.foundry/server/releases/dev055-panel-spacing/previous-20261027T165348Z/`。没有 Worker 改动，不需要更新设备。
- 浏览器自验（Agent，非用户验收）：
  - 账号与会话：e2e-alice 登录真实 dev，打开合成工作区 `ws_f6059fa3-…` 的会话 `sess_1793098721988494549`。
  - 合成数据：该工作区设备离线，所以回答文本和工作区文件的读取/目录列表由 Playwright 路由注入；其余请求均经真实 API。
  - 覆盖范围：light/dark × 1280/390 下的链接渲染、Tab/Enter 键盘打开（`:focus-visible` 为真）、文件预览与下载按钮、返回目录、目录链接、404 状态，均无横向溢出。
  - 证据：`.foundry/attachments/20261028/dev055/`（`browser-matrix.json`，截图 `links-*`、`file-*`、`folder-*`、`missing-*`、`focus-*`，旧版基线 `before-light-1280.png`）。
  - 真实 API 探针：离线设备的工作区读取返回 409 和 no-store（`real-read-offline.json`）。设备拒绝转 404 由 Go 测试覆盖，dev 上没有在线的合成设备可以实测。
- 检查：`scripts/check-changed.sh --files …` 全部通过（`check-changed.txt` 为首轮；`check-changed-final.txt` 为最终一轮）。首轮唯一失败是运行时撞上 DEV-054 正在修改的测试，单独重跑通过（`web-tests-rerun.txt`）。
- 限制：
  - 链接按形状推测，存在少量误判：不存在的相对路径点击后会显示「不存在」；没有扩展名的文件会被当作目录打开。
  - 工作区外路径和 `~/` 路径留给 Phase 2。
  - 真实设备实测使用 e2e-alice 的合成设备（与 dev 服务器设备 同机的独立 Worker），没有读取 `foundry` 工作区：e2e-alice 不是它的成员，会话 token 也不能访问 workspace-files。
- 2026-10-28 01:13：真实设备读取验收（编排要求不能只靠 fixture）。
  - 环境：临时启动 e2e-alice 的 DEV-048 合成设备 Worker（与 dev 服务器设备 同机，`FOUNDRY_STATE_ROOT=~/.foundry/dev048-acceptance/state`，当前工作树的 Worker 构建），工作区 `ws_d4da0f57-…`。在合成会话 `sess_1793120845188154104` 中让真实 Codex（设备本地登录）原样回复四个路径。
  - 文件安排：`dev055-after/` 在回答结束后才创建，所以 Worker 回合结束时的验证不会链接它，点击时只能经新路径解析。四个链接都没有 pending 标记。
  - 实测（浏览器 → 真实 Server → 真实 daemon → 真实文件，无路由注入）：

    | 点击                              | 结果                                      | 请求耗时 / 界面可见   |
    | --------------------------------- | ----------------------------------------- | --------------------- |
    | 回答后才写入的 `report.md`        | read 200                                  | 12–13 ms / 79–107 ms  |
    | 目录 `dev055/docs/`               | tree 200                                  | 10–467 ms / 83–877 ms |
    | 目录内的 `notes.md`               | read 200                                  | 13–17 ms              |
    | 不存在的 `dev055-gone/missing.md` | **404**，界面显示「文件不存在或已不可用」 | 5–192 ms              |
    | 20 MiB 随机文件                   | 预览 read 200                             | 515–600 ms            |
    | 同一文件下载                      | 进度「448 KB / 20.0 MB received」         | 13.7–14.5 s           |

    下载结果 SHA-256 与源文件一致（`5805d703…71d1`），所有 read 都是 `no-store`。

  - 发现并修正：二进制文件的预览原先把原始字节当文本显示。现在与设备对会话文件的判断一致（前 8 KB 含 NUL），改为「二进制文件，无法预览，请下载后打开」（中英文案）。Web `408602ecf9676f5e` 经 `scripts/deploy-web-dev.sh` 发布，上一版是其他会话发布的 `ca6ba388cb6b4c2e`，备份在 `~/.foundry/server/releases/dev055-binary-note/`。复测通过 light 1280 与 dark 390 两组。
  - 证据：`real-device-light-1280.json`、`real-device-dark-390.json`，截图 `real-{file,folder,missing}-*`、`real-download-progress-1280.png`（由 dark 390 复测覆盖）。检查 `check-changed-binary-note.txt` 全部通过。
  - 清理：daemon 经 SIGINT 退出；它启动的合成执行宿主 `foundry-execution-2f24728fc1335ada.service`（`FOUNDRY_STATE_ROOT` 确认属于 DEV-048 合成设备）已停止，为 inactive，其他执行宿主未动。浏览器已关闭，两份 20 MiB 测试文件已删除；合成会话和小文件保留供追溯。
  - 说明：检查配置时，本会话日志中出现过一次该合成设备的 device credential（只属于 e2e-alice 的测试设备）。如需要可在 Devices 页重新配对或移除该合成设备。
- 2026-10-28 10:50（北京时间）：Phase 2 部署与真实设备验收。
  - 部署：
    - Server：与 DEV-059、DEV-060 合并构建，sha256 `61e2c75f0adfb0d6b4630aaccfdbe0f06033813c4feb4ac0a40df019031f5d47`，pm2 PID 2101145，`/proc` 一致，healthz startedAt 2026-10-28T02:45:31Z，重启到健康约 67 s；回滚二进制在 `~/.foundry/server/releases/dev055-059-060-combined/previous/foundry-server`（afc7f429…）。
    - Web：`5581a718c528ce0b`（合并），之后 `f7dbf6c64e63bb21`（FieldHint 修正），均经 `scripts/deploy-web-dev.sh` 从共享工作树构建。
    - Worker：`0.5.7-dev.104.g4d184b2.local.1793154141`，Worker tarball sha256 `9b8e66f6…56c1`，已发布到 `worker-packages`，上一版 manifest 保存在 `previous/worker-release.json`。dev 服务器设备 经已安装 runtime 的 `startSelfUpdate`（与 Devices 页同一入口）更新成功：daemon 在 `runtime/current` 切到 `.104` 后 5 s 重启（PID 2104947，`.104` 声明 `device_files_v1`），忙碌的执行宿主保持运行。用户 Linux 开发机 未更新（会话 token 无法调用其更新路由，本次未申请 compute lease），用户真实设备需在 Devices 页更新后可用。
  - 真实设备验收：e2e-alice 的 DEV-048 合成设备 Worker 用已发布的 `.104` runtime 运行。合成会话 `sess_1793155947693648643` 中真实 Codex 原样回答 `/tmp/dev055-outside/` 下的合成文件（笔记、假密钥 `app.key`、2 MiB 二进制、指向 `~/.ssh/known_hosts` 的符号链接）。浏览器请求全部走真实 Server 和设备，没有注入。
    - 所有者（light/dark × 1280/390）：
      - 4 个设备文件链接，标题「仅你作为设备所有者可见」，无横向溢出；
      - 笔记：预览并可下载；
      - 密钥：遮罩、无下载按钮；「显示」后出现，「隐藏」后恢复；键盘「复制」后剪贴板内容正确，页面不显示；
      - 符号链接：「Foundry 不打开凭据库…」；
      - 二进制：只提供下载，2 MiB 下载 3.1 s，sha256 一致；
      - 24 个请求全部带意图头且为 `no-store`，最长 1.56 s。
      - 证据：`p2-real-device-owner.json`，截图 `p2-*`。
    - 拒绝（真实 API）：
      - 非所有者设备 404；
      - 缺意图头 403 `intent_required`；
      - 会话 token 403（两台设备）；
      - `~/.ssh/known_hosts` 与指向它的链接 403 `file_denied`；
      - 密钥下载 403 `file_sensitive`；
      - 目录 422 `not_a_file`；
      - 不存在 404 `file_missing`；
      - 开关关闭后 403 `device_files_off`，重新开启后 200。
    - Devices → 设置：「允许从会话打开这台设备工作区外的文件」勾选项可用键盘切换，保存后服务器状态一致（截图 `p2-devices-switch-*`）。
  - 修正：CSS 审计（去掉 `overflow-x`）、反馈审计（提示改用 `FieldHint`）、模块边界审计（`device-files` 归入 Worker 的 session-files 模块）、daemon 合同测试（线协议类型移入 `daemon_wire.go`）。
  - 限制与后续：
    - 关闭开关后，已打开的会话仍画出链接，点击时显示「已关闭」，Server 照常拒绝。修正（切换开关时发出 devices 变更事件，一行）已在工作树并通过测试；但当时共享工作树里另一会话（session inbox）正在改 Server 文件，未单独重启部署，留给下一次协调的 Server 部署。
    - 没有扩展名、也不是已知文件名的路径（如 `~/.ssh/known_hosts`）不画链接，按设计如此；访问记录暂无 UI，只存服务器。
    - 用户真实设备（用户 Linux 开发机）需在 Devices 页更新 Worker 后才能打开工作区外文件；旧 Worker 会提示需要更新。
  - 清理：合成 daemon 经 SIGINT 退出，其执行宿主 `foundry-execution-2f24728fc1335ada` 已停止，浏览器关闭，测试下载与临时 pack 已删除；`/tmp/dev055-outside` 合成文件保留供追溯。
- 2026-10-28 15:26（北京时间）：DEV-062 从共享工作树合并部署 Server（sha `aa09f6b2…`，PID 2281975，healthz startedAt 07:22:14Z）。该构建晚于开关变更事件那一行的最后修改，上面「限制与后续」中待部署的这一行已随之上线：开关切换后，打开的会话会收到 devices 变更并刷新链接。
