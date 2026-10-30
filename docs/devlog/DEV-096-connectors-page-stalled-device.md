# DEV-096 · 一台卡住的设备拖慢连接器页面；服务器在等待设备时检查链路

状态：已部署 dev（Server `8f2dfeb9…` SIGHUP，Web `992d80038c6faa45`），Agent 自验通过（Go、Web 测试；scratch 栈真实浏览器，用 SIGSTOP 的 Worker 模拟卡住的设备）。无 Worker 改动。人工验收待确认。未提交。来源：DEV-093 的连接器页面（[DEV-093](DEV-093-connector-cli-install.md)）。

## 问题

本人反馈 `GET /api/connectors/devices?refresh=1` 要挂几十秒。

nginx（2026-10-30 13:00–13:01，UTC+8）记录了三个这样的请求，同一时刻返回，分别用了 25.5 s、53.5 s、77.9 s；更早的一个以 499 结束（浏览器先放弃了）。

## 调查

**页面为什么等：**

- `refreshStaleConnectors` 并发读取每台在线设备上读数过期的连接器，然后 `wg.Wait()` 等所有读取结束。每个读取的超时 `connectorStatusTimeout` 是 150 s。
- 一台 Mac 的读取（aws、bytedcli 的 status RPC）一直没有回答（`received=false`），整页就一直等到这台设备的连接断开。
- 每次刷新都会对同一台设备再发一组读取，前一组还没结束。

**连接为什么卡住：** 编排会话提出的假设是“单向”：服务器到设备不通，设备的心跳仍在到达服务器，所以服务器以为链路正常。服务器日志不支持这个假设：

- 设备最后一次发来数据约在 01:00:02（服务器时间，下同）。之前心跳每 25 s 一次。
- 01:01:12，服务器自己的读超时触发：`closed (no data from device for 70s): … i/o timeout`。也就是说，设备这 70 s 里一个字节都没有发到服务器，包括心跳、pong 和消息片段。
- 01:01:26，设备重连时上报：`closed by worker … last data from server 75s before`，即设备也有约 75 s 没收到服务器的任何数据。
- 两个方向在同一时刻（约 01:00:02）都停了，是整条链路静默断开（NAT 或 Wi-Fi 路径丢包、没有 FIN/RST）。两端各自要等满自己的静默超时（服务器 70 s、设备 75 s）才发现。
- 重连之后，那台 Mac 遇到几次 `ECONNRESET … before secure TLS connection was established`，属于它自己的网络问题，不在本项范围内。

在这 70 s 里，服务器继续向这条已断的连接发新请求，每个都要等满自己的超时。这才是页面卡住的直接原因。

## 方案与实现

### 1. 页面不再等慢设备（Server + Web）

`apps/server/internal/httpapi/connectors.go`：

- 页面最多等 `connectorRefreshWait` = 3 s。没答完的读取在后台继续，有自己的期限 `connectorRefreshTimeout` = 60 s，脱离请求的生命周期（`context.WithoutCancel`）。
- 同一设备、同一连接器同时只有一个读取（`connectorReads`）。后来的请求加入正在进行的读取，不会再发一个；读数没过期的请求也会等正在进行的读取（同样不超过 3 s）。
- 设备条目新增 `checking`（协议 `DeviceConnectorDevice.checking?: string[]`，Go `Checking`）：列出正在读取的连接器种类。所有列表请求（包括不带 refresh 的）都会带上它。状态仍是上次的读数。
- 工作区的连接器视图走同一路径，也最多等 3 s。

Web：

- `device-connector-row.tsx`：正在读取时，行内第二行写“Checking now · last read 5 minutes ago”（没有读数时摘要行写“Checking now…”）。替换的是同一行文字，行高不变；该行带 `aria-busy`。徽标仍显示上次的状态。读数存在但未安装时，这一行改为“checked …”，所以开始和结束检查时行数不变。
- `device-held-connector.tsx`：只要有设备在 checking，每 2 s 重新读一次列表（不带 refresh，只读）。结束后停止。
- `workspace-device-connectors.tsx`：同样的文字，同样轮询。
- 文案 `deviceHeld.checkingNow`、`deviceHeld.checkingSince`，中英文都有。

### 2. 服务器在等待设备回答时检查链路（Server）

`apps/server/internal/httpapi/daemon_liveness.go`（新）、`daemon_rpc.go`、`daemon_conn.go`：

- 服务器向设备发出请求、正在等回答时，每 5 s 看一次设备有多久没发来任何字节。超过 `daemonProbeAfter` = 15 s，就发一个 WebSocket ping（每个连接同一时间只有一个）。
- ping 发出后 `daemonProbeWindow` = 15 s 内，设备一个字节都没再来，就判定链路已断，关闭连接，原因写“device did not answer a ping within 15s”。所有等待中的请求立即失败，原因为 `local daemon disconnected: device did not answer a ping within 15s`；设备显示离线；Worker 那边连接断开后会自己重连。
- 什么算“活着”：和读超时的规则一样，设备发来的任何字节都算，包括 pong、心跳、正在慢慢上传的大消息的片段。所以上行很慢但仍在工作的设备（DEV-084/085 的情形）不会被误关。
- ping 本身在期限内写不出去时（服务器往设备方向正忙），不下结论。
- 设备空闲、服务器也没有请求在等时，行为不变（仍是 70 s 读超时），不会增加 ping 流量。

**没有做的：仅凭“没有 pong”就关连接。** 编排会话设想的单向场景是：设备仍在发心跳，但 pong 不回来。这次的证据里没有出现这种情况。而且在拥塞的上行链路上，pong 会排在已经排队的消息后面（DEV-084 的事件积压可达几分钟）；如果以 pong 为准，慢设备会被反复断开（flapping）。真正的单向（服务器→设备）断开时，设备收不到任何数据，它自己的 75 s 静默检测会重连。测试 `TestMissingPongAloneDoesNotEndATalkingDevice` 固定了这个取舍。

**Worker 静默检测（75 s）没有改。** 可以让 Worker 在服务器静默约 35 s 时主动 ping、15 s 内仍无数据就重连，总时间从 75 s 缩到约 50 s。不过服务器这一侧已经在“有请求在等”时约 30 s 内发现并关闭连接。页面不再被阻塞后，剩下的只是设备重连早二三十秒，这次不为它单独发 Worker。如需要，可作为后续项。

## 自验

- Go（`go test ./internal/httpapi`，带 `-race` 的子集）：
  - `TestConnectorsPageDoesNotWaitForAStalledDevice`：设备的 status 回答被扣住。`?refresh=1` 在等待时间内返回（测试里设为 200 ms），`checking` 为 `aws,bytedcli`；第二次刷新不会再问设备（status 读取仍是 2 次）；放行后，普通读取显示两个读数，`checking` 清空。
  - `TestRequestOnADeadLinkFailsOnceAPingGoesUnanswered`：设备完全静默（既不读也不写）。请求在探测时间内失败（测试里 300 ms + 300 ms，小于 5 s），原因含“did not answer a ping”。设备变为离线，之后的新请求立即失败。
  - `TestSlowUplinkIsNotMistakenForADeadLink`：设备 2 s 内每 100 ms 发出一个大消息的一块，期间不读，所以 pong 发不出来。连接保持，请求最终拿到回答。
  - `TestMissingPongAloneDoesNotEndATalkingDevice`：心跳不断、pong 不来。连接保持，请求按自己的期限结束。
  - 原有连接器测试通过；与 Daemon/Connector/Device/RPC/Hub/Link/Tunnel/Resource/Registration/Heartbeat/Disconnect 相关的 httpapi 测试子集通过（199 s）。
- Web：`device-held-connectors.test.mjs` 14/14，新增一项：checking 时显示 “Checking now · last read 9 minutes ago” 和 `aria-busy`；读数落地后显示新状态；之后停止轮询。tsc、12 项 UI 审计、`audit-contract`（310 个接口与 Go 结构一致）、`audit-module-boundaries` 通过。
- 真实浏览器（scratch 栈：本树构建的 Server 和 Web，空库；配对一个临时 HOME 的 Worker，先正常读一次，等读数过期后对 Worker 发 `SIGSTOP`，模拟链路静默）：
  - 页面 3.5 s 内显示，行内为“Checking now · last read 2 minutes ago”。之后每 2 s 一次普通列表请求，页面始终可用（Tab 键焦点正常移动）。
  - 约 21 s 后服务器日志：`nothing from the device for 45s, none of it since a ping 15s ago; closing (device did not answer a ping within 15s)`，两个读取立即以这个原因失败。页面不刷新就变为“Offline · last read 3 minutes ago”，安装按钮禁用并说明原因。
  - `SIGCONT` 后 Worker 在 1 s 内重连，并上报 `reason="device did not answer a ping within 15s"`。
  - 1280 深色、390 浅色下的 checking 状态截图已检查，无布局问题。截图在本机 `.foundry/attachments/20261030/dev096/`，不入库。

## 部署

- Server（2026-10-30 13:41:14 UTC+8，SIGHUP）：从共享树构建。共享树 = HEAD `a0ba354` 加上已上线的 DEV-085 第 4 轮（`session_work*`）、DEV-095（`chat_queue*`），再加本项。sha256 `8f2dfeb954cef7c75d2715c8268a00b35d8f7e5c886b4992a45d9715ee34e764`；回滚副本为硬链接 `releases/dev023-candidate/foundry-server.pre-dev096`（上一版 `af738ac0…`）。
  - 新进程 13:41:32 接管。旧进程 15.0 s 后才退出（exit status 1）。此前的交接通常不到 1 s，这次估计是旧进程里还挂着长请求，具体请求未确认。期间端口始终由 supervisor 持有。
  - `/healthz` 200；`/proc/<pid>/exe` 与新二进制一致；当时在线的 6 台设备 3 s 内全部重连；无 panic。
  - 无数据库迁移，未另做库备份。
- Web（13:42:39，`scripts/deploy-web-dev.sh`）：`992d80038c6faa45`，从共享树构建（HEAD + 已上线的 DEV-095 Web + 本项），上一版 `2a789abe3ae764de` 保存在 `releases/dev096-web/previous-20261030T054238Z`。
  - 公网用 e2e-alice 只读复查：`/api/connectors/devices?refresh=1` 735 ms 返回，行在 845 ms 显示，无页面错误。
- Worker：不涉及。

## 限制

- 单向（服务器→设备）断开仍由设备自己的 75 s 静默检测发现；服务器侧不以缺失的 pong 为准，原因见上。
- “Check again”按钮（单设备检查）仍会等这台设备，但现在链路断开时约 30 s 内就会失败，不再是 150 s。

## 验收步骤（给用户）

1. 打开 连接器 → AWS CLI（或 bytedcli）：即使有一台设备卡住，页面也会在约 3 秒内出现。卡住的设备那一行写着“Checking now · last read …”，其余设备正常显示。
2. 不用刷新：设备答复后，这一行变为新的状态；如果设备的链路确实断了，约半分钟内这一行变为“Offline”，设备会自行重连。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                  | 剩余动作       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 2026-10-30 12:40 | 接手（编排会话 sess_1793310871114448129）；读 nginx 与 Server 日志；页面等待改为最多 3 s + 后台去重读取 + checking                                                                                                                                                                          | 链路根因       |
| 2026-10-30 13:00 | 范围扩大到链路故障：日志表明两个方向同时静默（服务器 70 s 读超时先触发），不是单向；实现等待时的 ping 探测与测试                                                                                                                                                                            | scratch 浏览器 |
| 2026-10-30 13:25 | scratch 栈 SIGSTOP Worker 端到端通过（页面 3.5 s；约 21 s 后断开并显示离线；SIGCONT 后重连）；`check-changed` 通过                                                                                                                                                                          | 部署           |
| 2026-10-30 13:42 | Server `8f2dfeb9…` SIGHUP、Web `992d80038c6faa45` 上线，公网只读复查通过，见“部署”                                                                                                                                                                                                          | 人工验收       |
| 2026-10-30 13:48 | 线上首次触发：那台 Mac 的链路在 13:43 前后再次静默，服务器在设备静默 32 s 时关闭连接（旧规则要 70 s），等待中的技能仓库检查立即失败并带原因。设备 13:44:32 重连时报告 “closed by network … last data from server 50s before”，说明确实是链路断开，不是误判。其他 5 台在线设备没有被探测关闭 | 人工验收       |
