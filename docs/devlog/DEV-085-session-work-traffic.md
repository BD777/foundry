# DEV-085 · session-work 流量过大，慢链路上的设备对账超时

状态：未开始（DEV-084 调查中发现，单独立项）。

## 现象（只读证据，2026-10-29 16:50–17:00 UTC+8，dev nginx 访问日志，来源 IP 已散列）

- 10 分钟内 `/api/daemon/session-work`：一个来源 371 次、257 MB；另一个 295 次、122 MB；另有 29 MB、26 MB、19 MB 的来源。单次响应常见 33 KB、373 KB、411 KB、693 KB，同一来源每秒数次。
- 本人 Linux 开发设备：`POST /api/daemon/session-work` 在 60 s 后被 nginx 以 408 结束（请求体没有在 60 s 内传完）；其执行宿主 journal 在 08:20–09:05Z 反复记录 `Work reconciliation: TimeoutError: The operation was aborted due to timeout`。
- 服务器日志同期大量 `slow request: POST /api/daemon/session-work took 1.0–1.4s`。

## 待调查

- 哪些设备、哪个调用方（daemon / 执行宿主 / `undici` 与 `node` 两种 UA）在发这些请求，频率由什么驱动。
- 响应为什么是数百 KB（是否每次返回全量 session work 状态，而非增量）。
- 慢链路上的上传体积与超时；与 DEV-084 的事件通道是否争用同一上行带宽。

## 流水

| 时间（UTC+8）    | 变化与证据                    | 剩余动作 |
| ---------------- | ----------------------------- | -------- |
| 2026-10-29 17:15 | 由 DEV-084 调查记录，未改代码 | 立项调查 |
