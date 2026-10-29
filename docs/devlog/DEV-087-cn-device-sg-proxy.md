# DEV-087 · 本人的 CN 开发设备：更新 Worker，Foundry 连接经 SG 中转

状态：Worker 更新与中转已完成，Agent 自验通过；外部连接网关接入已备好，等本人发放邀请码；顺带修复的 Worker 代码缺陷未提交、未发布；人工验收待确认。

来源：协调会话 `sess_1793063405185071529` 的运维简报（本人确认该设备空闲并授权两项操作）。实施会话 `sess_1793266244659983881`。只经 Foundry compute 租约操作，结束后已释放。

## 结论

| 项目                 | 结果                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker 更新          | `.1793206791 → 0.5.7-dev.139.g408e64d.local.1793259553`。daemon 与执行宿主都已实际加载新版本（看的是进程路径和 `daemon-health.json`，不只是已安装的包）                                            |
| SG 中转              | sing-box 服务运行中，只监听内网地址，要求账号密码（不带凭据的请求被拒）。CN → SG 内网 TCP 可达，建连约 75 ms                                                                                       |
| Foundry 连接改走中转 | 已用 `foundry-worker proxy set` 设置为 `http://` 方案（只影响 Worker ↔ Foundry Server，Agent 和其他流量不变）                                                                                      |
| 发现的缺陷           | `socks5h://` / `socks5://` 下，Worker 的 HTTP 请求（`serverFetch`）对不带端口的 URL 向代理请求 **0 端口**，代理拒绝，所有 HTTP 调用约 5 s 后失败；WebSocket 不受影响。已在本地修复并补测试，未提交 |

## 测量（CN 设备 → dev 服务器，`/healthz`）

| 指标                                     | 直连                       | 经 SG（socks5h）                | 经 SG（http）                   |
| ---------------------------------------- | -------------------------- | ------------------------------- | ------------------------------- |
| TCP 建连                                 | ~250 ms，偶发 1.3 s        | ~75 ms（到中转）                | ~75 ms（到中转）                |
| 新连接整次请求（10 次交替采样）          | 中位 ~2.0 s，0.75–4.2 s    | 中位 ~0.49 s，最大 1.5 s        | 中位 ~0.9 s，0.30–1.5 s         |
| 复用连接单次往返（2 轮 × 20 次）         | 中位 0.27 s，p90 0.9–1.1 s | 中位 0.074–0.080 s，p90 ≤ 0.3 s | 中位 0.076–0.080 s，p90 ≤ 0.1 s |
| 下载 498 KB 前端包（3 次）               | 4.4–4.9 s，105–116 KB/s    | —                               | 0.64–0.85 s，600–795 KB/s       |
| Worker 自身 `checkServerProxy`（冷启动） | —                          | 失败（见缺陷）                  | 343–378 ms，HTTP 200            |

daemon 用一条长连接 WebSocket，所以复用连接往返和吞吐量更有代表性：往返约降为 1/3.5，吞吐量约提高到 6 倍。SG 本机到 dev 服务器 TLS 约 35–40 ms。

服务端日志（切换前）：日志覆盖北京时间 10-29 00:00 至 17:38，全部 22 条 `is behind` 警告都来自该设备，集中在 15:14–17:32；积压从 1 分钟涨到 **15 分 42 秒**（17:22，当时 467 条消息未写出）。这一形态与上表的低吞吐一致，单靠往返延迟解释不了。

切换后：17:41:06 服务端记下 `device … reconnected … proxy=socks5h://<中转>`（这一行描述的是上一条连接，即 socks5h 期间），之后设备以 http 方案连接，`daemon-health.json` 显示 runner ready。切换后 90 s 内没有新的代理错误。**负载下 `is behind` 是否消失尚未观察到**：切换时设备上没有运行中的回合。

## 过程

1. 空闲确认：设备 8 个工作区都没有运行中的会话；唯一的托管进程（一个自动部署任务）为 paused/stopped；有一个 Open Lark 服务隧道（只是隧道登记，不是 Worker 托管的进程）。有一个 Claude 常驻进程属于已完成的会话（回合 17:30 结束），没有子进程，处于回合之间。
2. 更新：照抄 Web 端自更新的方式，用独立的 `systemd-run --user` 单元执行 `foundry-worker update --server <dev>`，这样 daemon 重启时更新进程不会被一起结束。17:33:14 新 daemon 上线；执行宿主随之进入排空，17:34:58 空闲切换到新版本（约 100 s）。旧宿主下的空闲 Claude 常驻进程随旧宿主结束，会话可原生续接。
3. 凭据传递：不让明文经过对话转写。CN 设备生成一次性 RSA 密钥对，只把公钥交给 SG；SG 用 jq 只取出用户名和密码，URL 编码后用 OAEP-SHA256 加密；只有密文经过本会话；CN 解密到 0600 文件，`proxy set` 写入 `worker-proxy.json`（0600）。两端的密钥、密文、明文都已 `shred`，scratch 目录已清理。
4. 先按测量选了 socks5h（新连接更稳、远端解析 DNS），17:38 设置。WebSocket 经中转成功，但 daemon 日志随即出现 `Foundry server request via proxy socks5h://… failed`。用隔离的 state root 复现：`Socks5 proxy rejected connection - Failure`，每次约 5 s；同一凭据的 `http://` 方案正常。为不让设备的 HTTP 调用持续失败，17:41 改为 `http://`。

## 缺陷与修复（未提交）

- 根因：`packages/worker/src/server-proxy.ts` 的 SOCKS 分支把 undici `connect` 选项里的 `options.port` 直接 `Number()`。URL 不带端口时 undici 给的是空字符串（本地用 undici 6.29.1 确认：`https://dev…/healthz` → `port: ""`），于是向代理请求 `host:0`。现有测试的目标都带显式端口，所以没有覆盖到。WebSocket 走 `socks-proxy-agent`，不受影响。
- 修复：端口为空时按协议取 443 / 80。
- 测试：`packages/worker/test/server-proxy.test.mjs` 新增「SOCKS fetch asks the proxy for the scheme's default port when the URL has none」，断言代理收到 `only-proxy.invalid:443` 和 `:80`。修复前该测试失败（6/7），修复后 7/7 通过。
- 影响：任何把 Worker 代理设为 `socks5://` / `socks5h://` 的设备，其 Worker → Server 的 HTTP 调用（读回原生对话、上传等）都会失败。发布含此修复的 Worker 后，该设备可改回 `socks5h://`（可选；http 方案的复用连接表现相同）。

## 外部连接网关接入（进行中，等本人）

协调会话 18:00 前后转达本人优先级：该设备要能用外部连接网关。照 [DEV-044](DEV-044-external-connections.md) 的三台设备接入方式进行。

- 邀请码：网关要求每台机器一个 principal，经 网关 CLI 的 `join --invite-stdin` 兑换一次性邀请码。本会话能用的唯一连接（dev 服务器设备上的网关连接）权限只有 `api:invoke`，不能发邀请码；网关运行在外部主机上，不在本人的 Foundry 设备里，没有网关服务端。因此停在这里，已把“需要本人动手”的一项（后台创建邀请：principal 为该设备、账号同现有设备、1 小时有效；在该设备终端以隐藏输入粘贴并 `join`）交给协调会话。没有复制任何设备的 key。
- 已备好（用户级，无 sudo）：网关 CLI 0.1.0、host-connection helper、Bun 1.3.14（npm 安装）。网关 CLI 和 helper 与参考设备逐字节一致（sha256 校验）。CN 设备直连 GitHub 不通、`gh` 未登录，二进制 82 MB 也无法经工具参数传递，所以用 xz 压缩、分两块，作为 Foundry 附件经一个投递会话送到设备，校验后安装并删除附件；投递会话的模型回合因所选模型不可用而失败，附件在此之前已送达，会话已归档。
- 网关出口：CN 设备直连网关 HTTPS 可达（约 1.3 s 建连），不需要经中转。
- 剩余（join 之后由本会话完成）：helper `--describe` 取身份；备份 `agent-profiles.local.json`（该设备此前没有这个文件）；`connection add <gateway>_default`（默认 sonnet，可选 sonnet/opus/haiku）；`connection check`；核对服务端 `list_profiles`。

## 回滚

- 在该设备上执行 `foundry-worker proxy clear`，daemon 自动重连并恢复直连。
- 改方案：`foundry-worker proxy set <scheme>://<凭据>@<中转>`；`foundry-worker proxy show` 只显示方案和地址。

## 限制

- 负载下的 `is behind` 改善待下一次该设备有繁忙回合时从服务端日志确认。
- 中转是单点：SG 主机或 sing-box 停止时，该设备的 Foundry 连接会失败，直到 `proxy clear`。sing-box 已配置开机启动和异常重启。
- 本机磁盘剩余约 11 GiB（90%），本事项没有大写入。

## 时间线

- 2026-10-29 17:20–17:45（北京时间）：空闲确认、更新、中转核查、测量、切换、发现并修复 SOCKS 端口缺陷（本地）。证据见上；剩余动作：提交并发布 Worker 修复、负载下复查 `is behind`、人工验收。
- 2026-10-29 17:50–18:25（北京时间）：网关接入准备完成，邀请码需本人发放；轮询 25 分钟未见 join，已释放租约，等协调会话通知后继续。
