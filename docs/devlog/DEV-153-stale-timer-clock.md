# DEV-153 聊天列表里过期的定时图标：Claude 进程时区与重启后的首份定时列表

## 状态

状态：已部署 dev（Server、Web、Worker，版本见“部署”），Agent 自验完成，2026-11-09 22:39 CST 经 PR #234 squash 合入 main（`afb22c0c`），待人工验收。部署产物沿用最初的工作名 `dev152`（`foundry-server.pre-dev152`、`releases/dev152/` 等），与 DEV-152（Assistant flows）无关。

## 问题

本人截图：对话「排查Claude会话缺少提问卡片」（`sess_1793847986445716844`）在聊天列表里一直显示时钟图标（“有定时”），但右侧 Activity 只有已结束的定时（Ended timers 4），没有在等的定时。

## 调查

- 列表图标来自会话的 `scheduled`（Worker 上报的定时快照，Server 存进会话），Web 只去掉一周前首次出现的循环定时（`sessionScheduledTimerExpired`），单次定时时间过了也一直算“在等”。Activity 读的是 session work，已正确标为结束，所以两处不一致。
- 线上库里该会话的 `scheduled` 停在 2026-11-05 12:25Z 的快照：一条 `ScheduleWakeup`（`14db6a22`，`46 7 * * *`），之后该会话又跑了很多回合，快照从未更新。原因：11-08 会话在新的 Claude 进程里恢复，Claude Code 恢复会话时不带回 `ScheduleWakeup`（DEV-148 已记录），而 Worker 的定时跟踪在新进程“还没见过任何定时”时不报空列表（`emitSnapshot`），Server 于是一直留着旧快照。
- 第二个根因：该快照的 `nextFireAt` 是 `2026-11-04T23:46Z`，比快照本身早 13 小时。系统时区是 Asia/Shanghai，Worker 按它解释 cron；但这个对话的连接把 `TZ=America/Toronto` 传给了 Claude 进程（外部连接允许 TZ 透传，`harness/external-connection.ts`），Claude Code 按多伦多时间写 cron。session work 里同一个 wakeup 的两条记录印证了这一点：Worker 先记的临时条目 `46 20 5 11 *`（上海 20:46 = 12:46Z，正确），Claude 自己列出的 `46 7 * * *`（多伦多 07:46 = 12:46Z）；Worker 按上海时间比较小时，没能把两者对上，丢掉了已知的准确时间，再按上海时间推算出 23:46Z。若只按“单次定时时间已过即结束”，在这类设备上会把真实在等的 Claude 定时立刻判为结束；定时补发（DEV-148 timer revival）也会按错的时间投递。
- Codex：只有 Claude 的定时跟踪会上报 `timerSnapshot`（`codexTimersCapability.supported = false`），Codex 会话没有 `scheduled`，不会出现同样的残留。

## 改动

1. 定时带上它的时区（契约 + 协议 + Worker）
   - `AgentScheduledTask` / `AgentSessionScheduledTimer` 新增 `timeZone`：持有定时的 Claude 进程的 IANA 时区，cron 字段是该时区的墙上时间，`nextFireAt` 按它计算；旧记录没有此字段。
   - 协议 `cron.ts`：`nextCronFire`、`claudeOneShotFireAt`、`claudeRecurringFireAfter`、`claudeTimerNextFire`、`humanizeCron` 接受时区，在该时区的墙上时间里逐分钟扫描，只在命中时换算一次为绝对时间（`Intl.DateTimeFormat`，无新依赖）；不传时区时与原来一样用本进程时区。单次定时有 `timeZone` 时以 `nextFireAt` 为准确触发时间。循环定时的说明在时区与读者不同时附上时区，例如“工作日 09:00 (America/Toronto)”。
   - Worker：`claudeTimeZone` 按 Claude Code 的生效顺序取时区（设置里的 `env.TZ` > 进程环境 `TZ` > Worker 自身时区）；跟踪器创建时用已知环境估计，SDK 包装在外部连接准备好、真正启动进程前回报最终环境（`onProcessEnvironment`，`harness/agent-runtime/claude-sdk.ts`）。临时 wakeup 的 cron、与 Claude 列表的匹配、`nextFireAt`、说明文字、定时补发（`timer-revival.ts`）都按该时区计算。
2. 共享的“已结束”规则（协议 `sessionScheduledTimerEnded`，Go `AgentSessionScheduledTimer.Ended` 相同）
   - 循环定时：沿用一周到期。单次定时：触发后 1 小时仍在列表里即视为残留（Claude 在会话空闲时触发并移除到期的单次定时，没有进程持有时由设备投递一次）；没有 `timeZone` 的旧记录时间可能差一天，放宽到 2 天，所以已存的残留记录也会消失。
   - Web 的聊天列表时钟、“下次唤醒”说明和右侧定时卡片用新规则；Server 在返回会话侧栏前用 `AgentSessionSchedule.Live(now)` 去掉已结束的定时（`DeriveSessionPanel` 本身仍只依赖事件）。设备定时补发仍用原来的 `Expired`，时间已过但没人持有的单次定时照样补发一次。
3. 新进程的首份定时列表（Worker）
   - 进程收到 Claude 的第一份定时列表（Stop hook 的 `session_crons`）时，即使为空或与设备记录相同也上报一次（之前本进程已上报过则不重复）；之后只在变化时上报。Server 据此清掉旧进程留下的定时。
   - 上报的列表包含设备仍要投递的旧进程 wakeup（`SessionTimers.owedWakeups`），在投递前会话仍显示在等；设备记录的“Claude 持有的定时”仍只是 Claude 自己的列表，补发逻辑不变。

## 自验证据

- Worker（`run-worker-tests.mjs`）：新 `claude-timer-zones.test.mjs`（Worker 在 Asia/Shanghai、Claude 在 America/Toronto：wakeup 临时 cron 为 `46 7 5 11 *`、Claude 列出的 `46 7 * * *` 被匹配且保留 12:46Z；单次 CronCreate 按多伦多 09:47 计算；补发在 12:46Z 等待/投递、CronCreate 按同一时区等待；会话 schedule 带时区，触发后 30 分钟仍在、61 分钟结束；旧记录两天后结束；重启后设备仍要投递的 wakeup 留在首份列表、投递后消失，没有定时的新进程首份列表为空），以及 `agent-timers`、`session-timers`、`timer-revival`、`claude-timer-turns` 共 43 项通过。原有两项断言“空的或不变的首份列表不上报”，正是本次要改的行为，已改为“首份列表上报一次，之后只报变化”。
- Web：`chat-session-schedule.test.mjs` 新增“列表时钟去掉已触发的单次定时、保留未到的”，相关 19 项通过。
- Go：`store` 新增 `TestScheduledTimerEndedAndLive`、`TestSessionScheduleKeepsTimerZone`；`httpapi`、`sqlitestore` 的 Panel/Schedule/Timer/SessionWork 测试通过。
- `scripts/check-changed.sh`（21 个文件）：prettier、gofmt、协议构建与测试、tsc web、Web 测试 70 个文件、Worker 构建与测试 58 个文件、go test、audit:contract/openapi/modules 全部通过。

## 合入

2026-11-09 22:39 CST 经 PR #234 squash 合入 main（`afb22c0c`），CI 四项通过（web、go、packages、verify）。合入前 origin/main 仍是本项的基线 `85173f04`，无需 rebase；提交前重跑定时相关测试（Worker 43、Web 9、Go store）通过。之后 DEV-152 在其上合入。

## 部署

2026-11-09 12:20 CST（04:20Z），持 `/tmp/fdy-deploy.lock`，在 `~/workspace/foundry`（`85173f04`，本项 21 个文件在主仓库没有其他未提交改动，原样复制；重新生成的契约与 worktree 逐字节一致）构建：

- 发布前核对：线上 Worker `0.5.7-dev.321.g08add543.local.1794173489` 的 Worker 与协议 `dist` 和主仓库 HEAD 构建逐文件一致，重新打包不会回退其他会话的发布。
- Server：binary sha256 `b5244ff54f221534…`；旧 binary 留作 `releases/dev023-candidate/foundry-server.pre-dev152`；`pm2 restart foundry-server`，`/healthz` ok（startedAt 04:20:03Z），7 台设备 1–9 秒内重新连上。数据库无结构变化，未做备份。
- Web：`a2752f2e71c212bd`（上一版 `e08ddc07b2c45f50`，入口保存在 `releases/dev152/previous-20261109T042052Z/`），`scripts/deploy-web-dev.sh` 发布，入口资源逐字节一致、同源 API 返回 JSON。
- Worker：`0.5.7-dev.325.g85173f04.local.1794198054`（`release.before-dev152.json` 为上一版清单）。经各设备 compute 租约运行 `foundry-worker update`（macbook 为 `~/.foundry-stacks/dev/bin/foundry-worker`），7 台设备都报告新版本；CanWendeMac-mini、byte-dev、byte-dev-sg、cottoncpp、limen-canada、macbook 的执行宿主已是新版本。CanWendeMac-mini 的更新命令报 “120 s 内未上线”，之后自行连上并运行新版本。sg-chaos 的旧执行宿主（dev.321）仍在跑进行中的回合（含本会话），按规则不强制切换，空闲后切换。sg-chaos 上另有两个与本项无关的旧合成执行宿主（DEV-111 `~/.foundry/dev111-acceptance`，自 11-03；DEV-148 `~/.foundry/dev148-acceptance`），未动。

## 真实浏览器验证

本人账号在 dev 上没有可用的浏览器凭据，e2e-alice 的设备上没有可用的 Claude 账号（DEV-148 同样受限），所以在 scratch 栈 `dev152` 上做（线上库副本，`FOUNDRY_INTEGRATIONS=off`，本人账号密码只在副本中重置，Server/Web/Worker 都是本项构建）：

- 本对话（`sess_1793847986445716844`）：副本中该会话的 `scheduled` 先恢复为 11-05 的原始残留记录（`14db6a22`，`nextFireAt 2026-11-04T23:46Z`，无时区），聊天列表该行在浅色、深色下都没有时钟图标（之前为本人截图中的时钟）。
- 新的真实定时：在副本里给本人账号配对一个本项构建的 Worker（`TZ=Asia/Shanghai`），合成工作区 `/tmp/dev152-ws`，my-cpa `gemini-3.8-flash-high` · low 的 Claude 对话按要求调用 `ScheduleWakeup`（180 秒）。快照先是临时条目 `wakeup-1794200280000`（`58 12 9 11 *`），随后 Claude 的 `c660ceb0`（`58 12 * * *`），两者都带 `timeZone: Asia/Shanghai`、`nextFireAt 04:58:00Z`（匹配成功，保留准确时间）。触发前列表该行有时钟（浅/深），04:58:00Z 触发、Claude 回复 WOKE，04:58:06Z 上报空列表，之后该行没有时钟（浅/深）。
- 截图在 `.foundry/attachments/20261109/dev152/`（不入库）。验证后 scratch 栈（含副本与临时密码）与合成工作区已删除。
- 线上本对话：部署时该会话的 `scheduled` 已被本会话后来设置的一个真实 wakeup（04:07Z，旧 Worker 上报，无时区）替换；该 wakeup 04:32Z 触发后，本回合结束时 Claude 上报空列表，线上记录已清空（`scheduled` 为空）。

## 验收步骤

1. 打开 dev 的聊天列表，找到「排查Claude会话缺少提问卡片」。预期：行尾没有时钟图标。
2. 在任一 Claude 对话里让 Agent 用 `ScheduleWakeup` 设一个几分钟后的唤醒。预期：该对话行尾出现时钟；右侧定时卡片的时间与 Agent 说的时间一致。
3. 等唤醒触发、Agent 回复后。预期：时钟消失，右侧定时卡片显示为已结束。
4. 若某个对话的连接把 Claude 的时区设成与设备不同（例如 America/Toronto），在其中让 Agent 用 `CronCreate` 设一个每天的定时。预期：右侧定时说明带时区，例如“每天 09:00 (America/Toronto)”，下次时间按该时区计算。

## 限制

- 已存的旧记录（没有 `timeZone`）的单次定时要到时间后 2 天才在列表里消失；新记录 1 小时。
- 会话正在跑一个超过 1 小时的回合时，到期未触发的单次定时会提前从列表消失（右侧 Activity 仍显示）。
- `nextCronFire` 在夏令时跳过的那一分钟上取下一个存在的时刻，Claude Code 本身则跳过那一天；只影响夏令时切换当天恰好落在被跳过时间的定时。
- 本项未在本人 dev 账号的真实浏览器里复核（无凭据），上面的浏览器验证在线上库副本上完成。
