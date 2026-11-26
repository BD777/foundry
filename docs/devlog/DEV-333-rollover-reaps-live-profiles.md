# DEV-333 Worker 发布后，正在跑的会话的 feishu-cli profile 被新运行器删掉

## 问题

2026-11-25 本人反馈：`sess_1795423194895939999`（byte-dev，project_a）在 04:02:57Z 说“Foundry 轮换后 profile 只剩 `default`”，飞书写操作全部失败，于是让本人“在 Foundry 重新授权 feishu-cli”。04:12 本人回复“写权限应该是有的，你重试一下”后，profile 又出现了，写入恢复。授权本身没有掉。

## 调查

- 时间线：04:01:07Z 有一次 dev 部署（`deploy-dev.sh … --label dev328c --server --web --worker`，见 `~/.foundry/server/lock-log.jsonl`），byte-dev 随后起了新的执行宿主（运行器），旧宿主进入退役。04:02:57 会话发现 profile 不见了。
- 会话当时有后台子任务（Claude 后台 subagent），所以按 `fleet.ts` 的设计（`holds()`：后台工作会把会话留在原宿主上）继续留在退役的旧宿主上。它的 profile 由旧宿主的 `holdWhileAgentRuns` 持有，只记在旧宿主进程的内存里（`liveProfiles`）。
- 新宿主在 `takeOverDeviceWork` 里调用 `reapConnectorLeftovers` 和 `reapSessionTools`。调用时机由 `seniorHostPresent` 决定，而它把“被 daemon 退役的宿主”当作已经交出工作（DEV-066 之后的约定，针对的是设备共享工作：计时器、工作清单）。这两个清理函数的判断是“清单里有、但不在本进程内存里的都算残留”。退役宿主还在用的 profile 和会话工具目录也满足这个条件，于是被删掉了。
- 04:12 本人发出的这一轮仍在旧宿主上跑（会话仍被持有），`materializeSessionAccounts` 重写了 profile，所以“又好了”。
- 同类问题第二处：空闲会话交接（`release_session` → `closeIdleRuntimes`）时，旧宿主只关闭 agent，持有的环境要等下一次 5 秒 sweep 才释放。新宿主在这段时间里可能已经为下一轮写好了同名 profile（名字按账号 + 会话确定）和同名工具目录，旧宿主的 sweep 随后会把它们删掉。

## 修复（Worker）

- `execution-host/roots.ts`：新增 `otherHostRuns(self)`，判断除自己以外还有没有宿主进程活着（退役中的也算）。
- `execution-host/server.ts`：按会话写出的残留（feishu-cli profile、会话工具目录）从 `takeOverDeviceWork` 中拆出，改成 `reapSessionLeftovers`：只在没有其他宿主活着时执行，执行一次。在此之前每 5 秒的 `announce` 会重新检查。设备共享工作的接管时机不变。
- `session/runner/active-runtimes.ts`：`closeIdleRuntimes` 关闭 agent 后，立即释放这些会话的 `holdWhileAgentRuns`（会话已没有活的 agent 时）。这样 `release_session` 在回复之前就已经清理完，不会再删掉新宿主写的东西。

不改变的部分：网关的授权判定（`gateway.SessionLive`）不变；崩溃宿主留下的 profile 仍在下一个宿主接管后清理，只是要等所有其他宿主都退出。

## 检查

- 新增测试：`host-rollover.test.mjs`“a retiring host still runs its sessions…”（退役宿主不再占有共享工作，但 `otherHostRuns` 为真）；`connectors-native-work-lifetime.test.mjs`“an idle agent handed over releases its profile before the next host writes it”。
- 定向测试（byte-dev，Linux）：`host-rollover`、`connectors-native-work-lifetime`、`session-environment-agent-lifetime` 共 43 个全部通过（`/tmp/remote-check-20261124T232021-340816.log`）。CanWendeMac-mini 上连接器两组通过；`host-rollover` 在该 runner 上 20 个失败，原因都是 `processIdentity` 在那里返回 undefined，原有用例也一样失败，与本改动无关。
- 构建：`remote-build --worker`，源树 `~/workspace/foundry`（base `c276f3e9`，自上次部署 03:59:43Z 以来只有本条的 5 个文件有改动），Worker `0.5.7-dev.409.gc276f3e9.local.1795580477`，tsc 通过。

## 限制

- 已经在跑的旧版本宿主退役时，第二处竞态仍按旧代码处理；修复版本成为“被退役的那个”之后才生效。第一处（新宿主误删）在修复版本作为新宿主上线时立即生效。

## 验收步骤

1. 在 byte-dev 上找一个有后台任务、用 feishu-cli 的会话，让它留在当前运行器上。
2. 发布一个新 Worker，让 byte-dev 切换运行器。
3. 预期：切换期间及之后 `~/.feishu-cli/profiles/foundry-*` 中该会话的 profile 一直在，feishu-cli 写操作不报授权错误；旧运行器退出后，没有会话在用的残留 profile 被清理。

## 时间线

- 2026-11-25 04:15Z 调查定位（证据见“调查”）。
- 2026-11-25 04:22Z 部署 dev：`deploy-dev.sh --prebuilt /tmp/dev333-build --label dev333 --worker`（回滚：`release.json.pre-dev333`）。`update_worker` 已更新 byte-dev、CanWendeMac-mini、sg-chaos，三台都报告 `…1795580477`。
- 2026-11-25 04:23Z byte-dev 实机核对：新宿主 `27327456d59c`（修复版，pid 1820467）04:22:26 启动；旧宿主 `154c51db3e47`（dev.403，retiring）仍在运行 `sess_1795423194895939999`。该会话的 `foundry-7a3ec9ed-…-48670c76ac` profile 与清单条目在切换后 45 s 仍在，会话 04:22 之后没有错误事件。旧宿主退出后残留清理是否正常，待下次切换后补验。人工验收待确认。
- 2026-11-25 05:30Z 补验（未完成）：旧宿主 `154c51db3e47`（dev.403，pid 833932）仍在运行并标记 retiring。原因是 `sess_1795423194895939999` 已完成回合，但还留着常驻后台命令 “Start resident headless browser”，所以按设计继续留在旧宿主上。该会话的 profile 与清单条目仍在（这是正确的：它的 agent 进程还活着）；新宿主 `27327456d59c` 没有清理它。旧宿主退出后的清理尚未发生，已排 08:30Z 再查一次。
- 2026-11-25 08:30Z 补验（完成）：05:37Z `sess_1795423194895939999` 的常驻后台命令到了后台时限被停掉，之后旧宿主 `154c51db3e47` 退出，`~/.foundry/execution-hosts/` 只剩修复版宿主 `27327456d59c`。`~/.feishu-cli/profiles/` 与清单里只有两个 `foundry-*` profile，都有活的 agent 在用（读 `/proc/<pid>/environ` 核对）：`…-48670c76ac` → `sess_1795423194895939999`，08:27:31Z 新回合在新宿主上重写，claude pid 2081438；`…-bce509051c` → `sess_1795592758545279686`，claude pid 2085123。没有无人使用的残留，日志里也没有清理失败。限制：reap 成功时不写日志，旧宿主退出后到 08:27 新回合之间，这个 profile 是被释放还是被清理掉的，没有直接证据，只能从结果判断（没有孤儿、在用的都在）。人工验收待确认。
