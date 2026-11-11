# DEV-186 执行宿主轮换（多宿主并存）与编排效率规则

## 问题

2026-11-12，byte-dev：Worker 更新到 `…1794420871`，但执行宿主仍是旧的 `…1794413999`，新开的 Codex 会话挂在旧宿主下，新的 `secretFiles` 解析不生效；sg-chaos 上宿主一直 `pending`，等待会话清空。忙碌的共享设备永远没有「无回合」的时刻，旧宿主永远接新回合。

## 调查

设计与已知局限：`docs/research/host-rollover.md`。两轮只读 review：sess_1794423739200524759（找出崩溃宿主被收养后孤立、新宿主没起来就退休旧宿主等问题）、sess_1794424905149725184（复核，判断可上真机，并指出两个新问题）。

## 修复

- 多宿主并存：新回合交给新宿主，旧宿主只留在跑的回合，空闲后由 daemon 停掉（`packages/worker/src/execution-host/` 的 `fleet.ts`、`adoption.ts`、`rollback.ts`、`roots.ts`）。
- review 后修复（sess_1794423976765893964）：只有 root 里没有未完成输入与未送达 envelope 才删 `identity.json`（`hasUnfinishedWork`），否则保留并留 stopped 标记供收养；standby 宿主接管前等 senior 宿主的 60 秒宽限（`seniorHostPresent`），避免与 systemd 重启的旧宿主双 owner。
- 回滚到旧 Worker 的局限写入设计文档。

## 部署与版本证据

- 部署的 Worker 版本 `0.5.7-dev.353.g09d40b7f.local.1794425515`；`host-rollover.test.mjs` 22/22 通过，worker tsc 通过一次。
- 真机验证（sess_1794425563546743603）：
  - limen-canada（Linux）通过：`current` 从 `…1794425158` 更新到 `…1794425515`，旧宿主 581600 在原会话 A 的 8 分钟命令运行期间不动；新宿主 582777 在 `execution-hosts/e1fdf44106f1/` 出现；新会话 B 的祖先是新宿主；A 完成后 19:47:14 旧宿主被停；A 的下一回合在新宿主上运行。
  - CanWendeMac-mini（macOS）通过：旧宿主 71136 → 新宿主 82234，经 `Foundry Worker.app` 的 applet 启动、launchd 服务 hash 更换；B 在新宿主下；A 完成后 19:57:26 旧宿主停止，旧 launchd 服务消失；约 2 分钟内多次检查旧宿主没有被 KeepAlive 拉起；日志无 launcher 回退告警。全程没有强制停止进程。

## 检查

`packages/worker/test/host-rollover.test.mjs`；PR 的 CI 结果见 PR。

## 限制

- runner 的 `pending` 上报只存在服务端内存，验证会话没有设备 owner 凭据，未直接验证；由行为间接证明。
- Linux 上 A 的输出没有数满 48 行；macOS 第 7 步未看到完整进程链（推断为新宿主，因当时只有它存活）。
- limen-canada 上 A 用的是 Codex 会话（该设备的 Claude 默认 profile 无模型响应）。
- 降级到旧 Worker 无法收养保留的 root，对应会话会显示运行中直到再次升级；standby 宿主在接管前崩溃会丢这段 timer（见设计文档）。

## 验收

1. 在忙碌设备上更新 Worker：设备上出现 `execution-hosts/<hash>/` 新宿主，新开会话的父进程是新宿主，旧宿主上已在运行的回合不中断。
2. 旧宿主的最后一个回合结束后约 10 秒内被停，`ps` 中只剩新宿主；原会话下一回合在新宿主上续上。
3. macOS：`launchctl list | grep foundry` 只剩新宿主的服务。

## DEV-187 编排效率规则

`docs/agent-orchestration.md` 新增编排效率规则（只读需要的段落、写完再统一验证、重命令用 `flock /tmp/fdy-heavy.lock`、不另设 GOCACHE、Worktrees and merging、Watching workers），`AGENTS.md` 链接到该文件。验收：打开 `AGENTS.md` 能跳转到该文档；worker 简报里引用它。
