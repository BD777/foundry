# DEV-045 外部连接的登记与设备页管理

2026-10-26，编排会话 `sess_1792999134370683044` 分派给本会话 `sess_1793003459594287015`，作为 DEV-044（[外部模型连接与 Limen](DEV-044-external-connections.md)）的后续。用户批准的 v1 范围：Foundry 保持通用，不下载、不安装 helper；网关自己的安装程序向 Foundry 登记连接，Foundry 提供登记 CLI，以及设备页上的“验证 / 移除”。

## 问题

DEV-044 之后，接入外部连接需要手改 `~/.foundry/agent-profiles.local.json`，再在终端运行 `foundry-worker connection check <id>`。设备页只显示一行 CLI 提示，没有状态细分，也没有任何操作入口。

## 实现

- **登记 CLI**（`packages/worker/src/external-connection-registry.ts`，`cli.ts`，`cli-contract.ts`）：新增 `foundry-worker connection add <id> --label --executable [--arg]… --identity --model [--models]`、`connection remove <id>` 和 `connection list [--json]`。
  - 校验与运行时一致，复用 `externalConnectionAvailable`。
  - 幂等：相同输入返回 `unchanged`，不写文件；helper、身份或模型变化后原地更新，因检查指纹不再匹配而回到未验证。
  - 原子写入，权限 0600，保留其他 profile、已禁用条目和未知顶层键。非 external 的同名 id 一律拒绝，包括文件内的 profile、原生配置发现的 profile 和 `claude_local` 等内置登录。
  - 输出一行 JSON；退出码 0 成功，2 输入无效，3 id 冲突，4 不存在，5 正在检查。
  - 参数解析器允许以 `-` 开头的取值用内联形式传入（`--arg=--port`）。
- **检查与移除**：
  - Worker 新增能力 `external_connection_manage_v1` 和协议消息 `check_external_connection` / `remove_external_connection`。
  - 检查调用与 CLI 相同的 `checkExternalConnection`：每个连接同一时间只跑一个，第二个请求返回 busy；检查不阻塞 daemon 的消息循环。
  - 应答附带最新 registration，Server 立即同步。
- **Server**（`apps/server/internal/httpapi/external_connections.go`）：
  - 新增路由 `POST /api/devices/{deviceId}/external-connections/{profileId}/check` 和 `DELETE /api/devices/{deviceId}/external-connections/{profileId}`，均为 `deviceOwner`，会话 token 不在允许名单内。
  - 只处理设备上报的 external 行，其他类型返回 400。
  - 设备离线返回 409；旧 Worker 返回 409，提示“update this device's Foundry worker…”，不会向它发出请求。
  - 设备错误码映射：busy / id_conflict 为 409，not_found 为 404，其余为 502。检查超时 150 秒，nginx `/api` 的读超时为 86400 秒。
- **Web**（`device-external-connections.tsx`，由 `device-providers.tsx` 引用；`lib/profile-status.ts` 的 `externalConnectionState`；中英文案）：
  - 外部连接逐行显示四种状态徽标：缺少连接程序、未验证、验证失败（附原因）、可直接使用。
  - 操作为可见文字按钮：验证 / 重新验证，以及两次点击确认的移除（ConfirmButton）。
  - 状态处理：忙碌时按钮显示“正在验证…”或“正在移除…”，带 `aria-busy` 并保留键盘焦点，其他按钮禁用；设备离线、Worker 过旧或缺少 helper 时禁用并说明原因；错误用 Alert 显示。
  - 常驻说明：验证会用一轮对话和模型额度、永不自动运行；移除只删这一项，网关保留；连接由网关安装程序运行 `foundry-worker connection add` 登记。
  - 外部连接不再出现在“提升”菜单和旧的 CLI 提示中。
- **附带修复（DEV-044 回归）**：`deviceProfileRevision()` 原来包含 ctime。`readAgentProfilesFile` 每次读取都会 chmod，Linux 上这会改变 ctime，于是存在 profiles 文件的设备每个心跳（25 秒）都会重发完整 registration。现在去掉 ctime，原子重命名会改 ino，就地编辑会改 mtime，变化仍能被发现。由回归测试覆盖。
- 文档：[external-connections.md](../external-connections.md) 新增 _Installer registration_ 一节（命令、JSON、退出码、幂等规则）。

## 验证

证据目录 `.foundry/attachments/20261026/dev045/`。

- Worker：`external-connection-registry.test.mjs` 6 项，覆盖幂等、指纹重置、保留其他 profile 与顶层键、0600、冲突与无效输入、移除只删 external 及其检查结果、CLI JSON 与退出码、busy 单飞、helper 缺失时检查失败且不发生推理、daemon 能力声明和 remove 消息往返（含 id_conflict 错误码）。`cli-help.test.mjs` 新增 add/remove/list 帮助不写状态。连同 `external-connection.test.mjs`、`provider-check-state.test.mjs` 共 40 项全部通过。
- Server：`external_connections_test.go` 5 项全部通过，覆盖未知连接 404、离线 409、旧 Worker 409 且不发请求、检查请求与结果、错误码映射、非 external 400、移除成功、非 owner 404。
- Web：`profile-status.test.mjs` 21 项全部通过（新增 `externalConnectionState`），`pnpm typecheck` 通过。
- 真实浏览器：headless Chromium + Vite 合成 fixture `apps/web/test/fixtures/external-connections.html`，参数 `scenario=ready|old-worker|offline`、`lang`、`theme`、`delay`，全部为合成数据和模拟 API。
  - 英文亮色、英文深色、中文深色 390px 下 `scrollWidth` 为 390，无横向溢出。
  - 键盘 Enter 触发验证，忙碌态保留焦点，成功后状态变为“可直接使用”。
  - 409 busy 错误在 Alert 中显示。
  - 移除：键盘两次 Enter 先进入确认态，再进入“正在移除…”；模拟 502 时显示错误，成功后该行消失。
  - Worker 过旧时全部按钮禁用并显示更新提示；离线时显示中文离线提示。
  - 截图：`light-en.png`、`dark-en.png`、`dark-zh-390.png`、`busy-en.png`、`error-en.png`、`remove-armed-en.png`、`old-worker-light-390.png`。
- 完整检查 `check-changed.log`：gofmt、protocol build/tests、Web tsc、21 个 Web 测试文件、Worker build、26 个 Worker 测试文件、httpapi 全包 go test、10 项 UI audit、contract、modules 全部 PASS。唯一的失败是 `docs/external-connections.md` 的 Prettier 格式，修正后 `prettier-recheck.log` 全部通过。
- 未调用任何模型端点；没有对 linux-dev-3 `limen_default` 运行真实 Check（需编排会话另行授权）。

## 验收步骤

1. 在设备上把可执行文件 `H` 登记为外部连接，运行 `foundry-worker connection add demo_gateway --label "Demo" --executable H --identity demo --model sonnet`。预期输出 `"action":"created"`，约 25 秒内设备页“这台设备上配置的”出现 Demo，状态为“未验证”。重复运行同一条命令，预期输出 `"unchanged"`。
2. 在设备页对一个已安装的真实外部连接点击“验证”（会用一轮对话额度）。预期按钮显示“正在验证…”，结束后状态变为“可直接使用”或“验证失败：原因”。
3. 点击 Demo 的“移除”，再点“确认从设备移除？”。预期该行消失，`connection list --json` 不再包含它，其他 profile 不变。
4. 在尚未更新的 Worker 上，预期按钮禁用，并显示“请更新这台设备的 Worker…”。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                      | 剩余动作                                                                |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2026-10-26 16:32 | 只读规划并发送计划；收到“go”后实现 Worker/Server/Web/文档，测试与浏览器验证见上 | 由编排会话协调部署 Server/Web 与发布 Worker；代码未提交；人工验收待确认 |

## 限制

- 登记 CLI 与设备页移除之间没有跨进程文件锁：极端情况下，同时进行的 add/remove 可能后写覆盖前写。现有的 `upsertAgentProfileConfig` 同样如此。
- busy 只在 daemon 进程内互斥，终端里的 `connection check` 与设备页的验证仍可能并行，各自写入结果。

## 部署记录（2026-10-26 17:10–17:13，编排会话 `sess_1792999134370683044`）

- Server：构建自 `main` 工作树（未提交），`~/.foundry/server/releases/dev045-external-management/foundry-server` SHA256 `d06102f6…d569`，替换 `releases/dev023-candidate/foundry-server`；旧二进制（`8975a93b…`）备份在 `dev045-external-management/previous/`。PM2 `foundry-server` 重启后 PID 816181，实际加载哈希一致，`/healthz` ok（startedAt `2026-10-26T09:10:05Z`）。无数据库迁移。
- Web：build `c02552a1a1a2568f` 部署到 `/var/www/foundryapp-dev`，公网 `version.json` 一致，首页 200；旧 `index.html`/`version.json` 备份同上。
- Worker：发布 `0.5.7-dev.81.gac22cc1.local.1793005823`（dev `release.json`，旧版备份同上）；包内含 `external-connection-registry.js`、`external_connection_manage_v1`、`observedSessionWork`（DEV-046）与 ctime 修复。
- linux-dev-3：以 `systemd-run --user` 临时单元执行 `foundry-worker update`，daemon 已为 `…1793005823`；执行宿主仍为 `…1793003292`，空闲后自动切换。
- 磁盘：发布后 `/` 达 90%，清理可再生的 Go 构建缓存（2.8 GB）后为 87%（14 GB 可用）；未删除任何发布回滚副本。
- 未做：通过 Limen 的真实 Check（消耗额度，待用户在设备页点击验收）。

## 2026-10-27 复核后修复与发布（编排会话 `sess_1793063405185071529`）

只读复核 `sess_1793063959078988040` 结论：无必须修复项；以下按建议处理。

- 检查进行中移除：同一进程内的 `remove` 返回 `busy`（退出码 5 / HTTP 409）；检查结束时若连接已被另一进程（CLI）移除，丢弃刚写入的检查结果，避免重新登记后显示过期的“可直接使用”（`external-connection-registry.ts` 的 `withExternalCheck`，`provider-check.ts` 改用它）。
- 重新登记保留关闭状态：`enabled` 不再属于登记管理的字段，网关安装程序重复 `connection add` 不会重新打开用户关掉的连接（文档已注明）。
- 非所有者看到禁用按钮时显示原因“只有这台设备的所有者可以验证或移除它的外部连接”（中英文）。
- 未处理：`externalConnectionState` 把无检查结果的非 healthy 行一律视为“缺少连接程序”。当前 Worker 只在 helper 缺失时产生该组合，改为显式字段需跨协议/Worker/Server/Web，暂列为限制。
- 公开仓库卫生：DEV-044 记录中的私有 adapter 路径与提交、helper 安装路径与 SHA256、macOS 用户名路径已改为概述。
- 检查：`check-changed.sh`（prettier、Web tsc、17 个 Web 测试文件、Worker build、registry 测试 8/8、audit:ui、audit:modules）全部 PASS；新增 2 个 registry 测试。真实浏览器：合成 fixture 新增 `scenario=not-owner`，headless Chromium 在 en/light 与 zh-CN/dark 下均显示所有者提示且按钮全部禁用，`ready` 场景不显示。
- 部署：Web build `cd4869d45156c57f` 已部署到 `/var/www/foundryapp-dev`，公网 `version.json` 一致、首页 200；Server 未改动。Worker `0.5.7-dev.81.gac22cc1.local.1793065107` 已发布（旧 `release.json` 与 Web 入口备份在 `~/.foundry/server/releases/dev045-followup-20261027/previous/`），四台设备经与设备页 Update 相同的自更新路径更新：linux-dev-3、mac-laptop、mac-desktop 的 daemon 与执行宿主均已加载 `.1793065107`；dev-server daemon 已加载，执行宿主因编排会话运行中保留 `.1793005823`，空闲后自动切换。更新后四台的 `limen_default` 仍为 passed。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
