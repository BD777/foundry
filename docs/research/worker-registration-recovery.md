# sg-chaos worker 注册失败恢复

日期：2026-10-16（北京时间）。

## 根因

16:04:28 更新到 `0.5.7-dev.30.gca56545.local.1792137787` 后，sg-chaos 的 worker 在 `/api/daemon/register` 持续收到 `400 invalid JSON request body` 并循环重启。原更新发生于 byte-dev 修复会话 `01a14316-1a5e-7b91-bf9d-1ab8e9668410`，它也更新了本机 worker。

`nativeCli()` 将本地 `RuntimeUpdateState` 整体作为 `NativeCli.update` 上报。Claude 更新状态实际含 `failureCount: 0`；协议及 Go 的 `AgentRuntimeUpdate` 未定义该字段，而注册接口使用严格 JSON 解码。因此即使更新成功、计数为零，也无法注册。

## 修复和回归

- `packages/worker/src/native-cli.ts` 在上报边界显式选取协议字段；首次检测及缓存读取均经过此投影。本地重试计数不删除，未来新增内部字段也不会自动进入注册数据。
- `packages/worker/test/native-cli.test.mjs` 覆盖首次检测、缓存刷新、零/非零失败计数、额外内部字段及本地计数保留。
- `scripts/check-changed.sh --files packages/worker/src/native-cli.ts packages/worker/test/native-cli.test.mjs`：格式、worker 构建、3 个测试文件、模块边界检查全部通过。

## 部署

用户授权修复后发布 `0.5.7-dev.30.gca56545.local.1792138509`，并通过正常 `foundry-worker update --server https://dev.foundryapp.app` 更新 sg-chaos。

补丁从之前的发布包生成；逐文件比对确认只有 worker 的 `dist/native-cli.js` 及两个包的版本 manifest 改变，没有把共享工作区其他未完成改动混入发布。旧 tarball 保留，原发布 manifest 和新包保存在 `/home/windeng/.foundry/server-backups/registration-fix-1792138509`。

16:15:19 worker 日志确认注册和 WebSocket 连接成功；服务端设备状态为 `connected`，记录的 worker 版本与新包一致。`foundry-worker doctor` 配对、工作区和 CLI 检查通过。恢复后已观察超过两个心跳周期：PID 2648320 保持不变、`NRestarts=0`，本地心跳从 08:15:18 UTC 持续推进到 08:16:18 UTC，服务器 TLS 连接保持 ESTABLISHED，未再出现注册失败。`device_presence` 按 5 分钟落盘，不能把其间数据库时间不变误判为心跳停止。没有修改 UI，未作浏览器 UI 验收。

原 Codex chat 已中断；当前工具没有跨 chat 发送/steer 接口，未向其注入消息。后续续跑应保留此修复，并在每次部署后核验注册、服务端版本和持续心跳，不能仅根据安装命令退出成功判断恢复。
