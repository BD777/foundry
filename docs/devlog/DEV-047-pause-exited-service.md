# DEV-047 暂停已退出的服务无法确认

## 问题

2026-10-27 编排会话 `sess_1793063405185071529` 暂停两个已失败的 DEV-006/007 合成验收服务（`work_2de671af…`、`work_e079566a…`；依赖的 `/tmp/fdy-iirZAF/...` 临时目录已被清理，无法再启动）。设备回报 `Error: No live supervised process to pause`，观测停在 `unknown`，暂停一直得不到确认。

## 原因与修复

- `session-work/processes.ts` 的 `pause()` 只处理“尚未启动”和“正在运行”两种情况；进程已退出（失败的服务）时直接报错。
- 修复：已停止或已退出且进程组为空时，`pause()` 不发信号直接返回；暂停后的定义不会被再次启动，观测保持其真实结果（如 `failed`）并确认当前 revision。进程首领已退出但进程组仍有成员的情况行为不变。
- 测试：`session-work.test.mjs` 新增“暂停已失败的受管进程无需存活进程即可确认”；该文件 32 项全部通过，`check-changed.sh` 通过。

## 发布

- Worker `0.5.7-dev.81.gac22cc1.local.1793065621`（含 DEV-045 复核修复）已发布到 dev `release.json`；sg-chaos daemon 已加载。服务对账在执行宿主中进行，sg-chaos 执行宿主在编排会话结束、空闲后切换，届时两项暂停应得到确认。其余设备随下次常规更新获得。
- 代码未提交（Git 时段为北京时间 22:00–09:00）。

## 待完成

- 确认 sg-chaos 执行宿主切换后两项服务的暂停 revision 18 / 26 得到确认。
- 人工验收：在 Workspace 服务列表中暂停一个已失败的服务，应很快显示为已暂停且无错误。

## 2026-10-27 委托 Agent 准出（编排会话 sess_1793063405185071529）

用户于 2026-10-27 在编排会话中明确：“验证的话你自己接口级别+端到端级别自行验证吧”。以下为 Agent 自验证据，不代表用户本人测试；只关闭已验证范围。

- 结论：通过（委托 Agent 准出）。证据：sg-chaos 执行宿主切换后，`work_2de671af…` 与 `work_e079566a…` 的 pause 已确认（confirmedRevision 18/26 = revision），观测为真实 failed、无错误。
- 2026-10-27 22:10 复核：`list_session_work` 中两项 `desiredState=paused`，`confirmedRevision` 18/26 与 revision 一致；sg-chaos 执行宿主已为 Worker `0.5.7-dev.81.gac22cc1.local.1793104558`（`/proc` 实际路径核对）。
