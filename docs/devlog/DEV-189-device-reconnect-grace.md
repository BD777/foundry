# DEV-189 设备离线判定：断开后先「重连中」，宽限 60 秒再算离线

## 状态

方向已经本人确认（2026-11-12，[编排会话](https://dev.foundryapp.app/chats/sess_1794464313271186377)）。Server 核心与 Web 三态显示、操作禁用已实施并部署 dev；租约申请与 steer/cancel 的重连等待属于后续切片。

## 问题与证据

调查会话：[sess_1794470837752523846](https://dev.foundryapp.app/chats/sess_1794470837752523846)（只读）。

- 每台设备和 Server 之间只有一条 `/api/daemon/ws`。连接一断开，`DaemonHub.unregister`（apps/server/internal/httpapi/daemon_hub.go:454–494）就立刻把设备写成 `disconnected/offline`，同时把资源标成离线、通知租约，没有宽限期。只有「新连接顶替旧连接」这一种情况不会闪离线（:403、:467）。
- 心跳和超时本身并不敏感：Worker 每 25 秒发一次心跳；Server 每 30 秒 ping 一次，70 秒读不到数据才断；等待 RPC 期间是 15+15 秒探活。Worker 断开后会在 0.5–1.5 秒内带随机抖动重连。
- 14.6 天的日志里：Linux 设备平均每天异常断开约 6 次，两台 Mac 每天约 45 次（原因单独查）；Server 主动关机 920 次，每次部署都会让所有设备瞬间断开，然后马上重连。
- 2026-11-12 15:04–16:18，Mac 设备反复掉线，是发布时用 `launchctl submit` 留下的更新任务反复重启了 Worker 进程，不属于误判（已移除，见 memory）。

## 设计

- **三种状态**：`online`（已连接）、`reconnecting`（断开后不到 60 秒）、`offline`（断开满 60 秒仍没连回来）。业界做法也是这样：先给一段宽限期再判失败，例如 Kubernetes 节点在判 NotReady 之前有 grace period，Consul/Serf 会先标记为 suspect。
- **Server**
  - `unregister` 时不再立刻写 offline：设备进入 `reconnecting`，并启动一个 60 秒计时器。计时器到点时如果还没有新连接，才执行现在 offline 的那一整套动作：写库、把资源标成离线、通知租约、发 `device_status_changed`。
  - 宽限期内设备重新连上：取消计时器，不产生任何离线事件，最多只发一次「重连中 → 在线」的状态变化。
  - Server 启动后：上次关机时在线的设备，先视为 `reconnecting`，同样给 60 秒。这样每次部署时设备不会闪一下离线。
  - 宽限期是一个常量（60 秒），先不做成配置项。
- **对其他功能的影响**
  - 新会话派发：现在本来就会排队等设备，不用改。
  - 已有的租约：现在已有 2 分钟宽限，不用改。
  - 新申请租约、执行操作：设备处于 `reconnecting` 时，等它连回来，最多等 30 秒。超时后返回一个明确的「设备正在重连」错误，不要返回「离线」。
  - 对运行中会话的 steer / cancel：同样最多等 30 秒，超时再报错。
  - `list_resources`：设备上加一个字段 `connection: online|reconnecting|offline`。`online` 这个布尔值保持原有含义，只在已连接时为 true，不改变已有调用方的判断；实例的 `state` 在重连期间显示 `reconnecting`。
- **Web**：设备列表、工作区的设备分组、工作区详情，在重连期间都显示「重连中…」（中性色），不显示离线。依赖设备在线的操作，重连期间禁用并说明原因。

## 不做

- 不上 phi accrual 这类自适应故障检测：只有一条连接，而且断开有明确事件，固定宽限期就够用。
- 不改心跳和 ping 的间隔。

## 后续（另开任务）

- 两台 Mac 长期频繁断开（每天约 45 次），只读查根因：对照睡眠/唤醒日志（`pmset -g log`）、App Nap 和网络，看是哪一种。

## 多设备同时断开（调查：[sess_1794473129306689535](https://dev.foundryapp.app/chats/sess_1794473129306689535)，只读）

- 10/28–11/12 共有 35 次「±2 秒内 ≥3 台设备同时 1006」，涉及分布在不同国家的设备，没有固定周期。
- 已确定排除：nginx reload。这段时间 nginx 只有每天的日志 reopen（SIGUSR1）；最后一次 SIGHUP 在 11/05；acme.sh 的 `systemctl reload nginx` 在这些事件里没有触发。前面也没有 Cloudflare，`dev.foundryapp.app` 只做 DNS 解析，直接连到本机 nginx。
- 强相关的现象：35 次中有 16 次发生在 Server 启动后 5 分钟内，26 次在 1 小时内；两周里 Server 重启约 920 次。但这些断开都不在重启的那一秒内，具体机制目前还是推测，可能是重启后的连接收尾加上主机出口短时异常。
- 两台 Mac 近 3 天没有睡眠，所以断开和睡眠无关。Mac mini 有 3 次 ping 超时，伴随 9–34 秒的事件循环卡顿，Worker 进程偶尔卡住的问题需要单独看（[sess_1794472649367882392](https://dev.foundryapp.app/chats/sess_1794472649367882392)）。
- 下一步要查：降低 Server 重启频率，或者让重启时平滑交接连接；抓包或出口指标；Worker 事件循环卡顿的原因。本项的 60 秒宽限会让这类几秒钟的断开在用户那边看不出来。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 剩余动作                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 2026-11-12       | 调查完成，方向确认                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 实施：Server → Web，然后部署                                              |
| 2026-11-12 17:02 | Server 定向测试通过：`go test ./internal/httpapi/ -run 'Daemon\|Hub\|Reconnect\|Resources' ./internal/resources/`；覆盖宽限内 `reconnecting`、宽限内恢复无离线事件、到期执行资源/租约离线动作、启动宽限、连接替换不闪离线。契约定点加入设备状态 `reconnecting`，protocol build 与 Web typecheck 通过。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 部署 dev                                                                  |
| 2026-11-12 17:23 | 已备份旧二进制并部署 dev Server。PM2 online，重启计数保持 62，`unstable restarts` 为 0，`/healthz` 返回 200。重启后约 47 秒第一次 `list_resources`、超过 120 秒第二次采样，6 台设备均为 `connection: online` / `online: true`，没有 `offline`；设备均在宽限内重连，故部署采样未停留于 `reconnecting`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 下一片：租约申请与 steer/cancel 等待重连；另一会话完成 Web 显示与人工验收 |
| 2026-11-12 17:53 | Web 完成并部署 dev `82e7bf6a86eca8a4`（上一版 `728d8ae198733962`，回滚副本 `web-releases/dev189-web/previous-20261112T094733Z`）。设备列表、工作区设备分组/概览/详情和资源实例统一使用 `deviceConnection` 三态；重连显示中性「重连中…」，依赖设备的按钮禁用并显示恢复说明。`pnpm typecheck`、6 个相关测试文件 47/47、component-system 与 state-layout audit 通过；hint audit 仅余指定的 `model-guide-dialog.tsx:114`、`unlinked-models.tsx:94`。e2e-alice 真实浏览器拦截 `GET /api/foundry-data` 合成一台 `reconnecting`、一台 `disconnected`，浅/深色截图均为 1280×900：`.foundry/attachments/20261112/dev189-devices-light.png`、`dev189-devices-dark.png`；验后登出、清 cookie、关闭浏览器并删除临时拦截目录。                                                                                                                                                                                                                                                                                | 人工视觉验收；租约申请与 steer/cancel 等待重连仍为后续切片                |
| 2026-11-12 18:58 | S2a 完成并部署 dev Server。`DaemonHub.waitForConnection` 成为唯一重连等待原语：最多 30 秒、使用重连通知 channel、可被 request context 取消；租约 acquire/operate 与会话 steer/cancel、背景任务和 goal 控件共用它。离线仍立即返回原错误，等待超时返回 `<设备名> is reconnecting; try again shortly`。定向测试 `flock /tmp/fdy-heavy.lock go test ./internal/resources/ ./internal/sessions/ ./internal/httpapi/ -run 'Lease\|Steer\|Cancel\|Reconnect\|Resource'` 全通过。首次 cancel 回归失败的原因是测试 daemon 等到 `registered` 后才开始读消息，但 DEV-189 重连顺序会先发布连接、再发 `registered`，等待中的 `cancel_session` 可合法先到；已让 fake daemon 在 hello 后立即读/答消息。备份为 `foundry-server.pre-dev189-s2a`，新二进制 SHA-256 `5d9a76ecd36d56544ae08f1d9f2bc059944189e21df61e02c1d85bbd6be8cf1e`；PM2 online，重启计数 64→65，30 秒后仍为 65、`unstable restarts` 为 0，`/healthz` 返回 200，重启后 MCP `list_resources` 的 7 台设备全部 `connection: online`，无 `offline`。 | 人工验收；真实 30 秒超时路径未在 dev 上人工制造                           |
| 2026-11-12 21:48 | native chat sync 修复合并并发布 Worker `0.5.7-dev.354.geb87723d.local.1794490081`。10 个文件三方合入无冲突；`tsc` 通过，指定 5 个测试文件 34/34 通过；7 台设备 `update_worker` 全部 `succeeded`。Mac mini 更新后约 15 分钟（Toronto 08:28:50–08:43:50）无新的 ≥5 秒 native chat sync stall；两台 Mac 在 Toronto 08:28:50–08:48:45 无 ping 超时断连；两台 Mac 的 `launchctl list \| grep -i foundry` 均无遗留 self-update 任务。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 无；Worker 已全量发布                                                     |
