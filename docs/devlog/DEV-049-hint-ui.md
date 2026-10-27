# DEV-049 · 统一提示、操作反馈与菜单

状态：实现、自验和 dev 部署已完成；人工验收待确认。实施来源为协调会话 `sess_1793063405185071529` 于 2026-10-27 转达的用户反馈。本项不作 Git 历史写入，不改 Server/Worker。

## 问题与原因

归档完成后，`ChatArchiveFeedback` 把绿色成功 Alert 插在整个聊天双栏之前，导致正文下移；此前没有 Toast 组件。用户随后要求移除列表行/文件夹外露的归档图标，并指出归档菜单项与其他项目不协调。

菜单的原因是 `ContextMenu.Item asChild + Button` 与功能 CSS 共同控制外观；`justify-content: space-between` 把唯一带图标的 Archive 标签推到右侧，Button 与 Radix 的交互状态叠加。统一为共享菜单条目后，Archive 与普通操作同列左对齐，只有 Delete 使用危险色。

## 设计决定

| 类型          | 规则                                                 | 实现                                                                                      |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| a · 操作结果  | 保存、移除、归档、恢复、复制、动作失败               | 共享 Toast；有 Undo 保留到关闭，普通 5 秒、错误 10 秒，最多 3 条                          |
| b · 持续状态  | 离线、只读、授权待办、设置未生效、阻塞、页面加载故障 | 共享 Alert；加载/空态、诊断结果等专用数据表面保留语义与上下文                             |
| c · 字段/帮助 | 控件下的说明和校验                                   | `field.tsx` 导出 FieldHint，统一 12px/1.55/6px 间距与 token 色；保留 id、aria-describedby |
| d · 可选解释  | 不需常驻的补充知识                                   | FieldHelp → 共享 Popover，Info 按钮可见，可点击/Enter/Space，Escape 关闭                  |

- 使用 [Radix Toast 官方能力](https://www.radix-ui.com/primitives/docs/components/toast)：悬停、聚焦和窗口失焦暂停计时；F8 聚焦通知区，Tab 到操作，Escape 关闭，支持滑动。普通信息 polite，错误 assertive。
- 浮层固定右上角，390px 时顶部通栏，避开聊天底部可变高度输入框及发送按钮。底部常量偏移无法保证长草稿/附件时不遮挡输入，因此没有采用固定底部偏移。Toast 不进入聊天布局，不为反馈预留正文空白。
- 一个 Provider/viewport 在 FoundryShell；features 仅通过 UI 层 API 或状态桥接组件使用。共享 Toast 支持更新已存在的操作禁用状态，更新不会复活已关闭的通知；异步 Undo 忙碌时禁用，失败保留入口。
- 复制按钮保留自身 Copied/check 状态，并通过相同 Toast 报告成功/失败；已自行提供文案的会话/飞书复制入口不重复通知。
- RowMenu 和 Context/Dropdown parts 共用 `row-menu.css`：左侧标签、可选统一图标列、右侧子菜单 chevron、二行禁用原因、独立选中标记。聊天/文件夹菜单不使用前置图标。
- 检索了所有 ContextMenu/DropdownMenu/RowMenu 入口：聊天行、文件夹、分组/复制子菜单、轮次下拉已迁移；其余管理行已用 RowMenu。SelectMenu 和 AgentRuntimeControls 是共享 UI 中的选择/配置面板，不改成动作菜单；没有残留功能层自制 `.Item/.Content`。子菜单额外用 [Radix 提供的可用尺寸变量](https://www.radix-ui.com/primitives/docs/components/context-menu) 限制宽高，390px 两级展开时允许标签换行。
- 持续的安装/诊断输出、设备配对终态、未确认刷新、发送失败/保留草稿等需要阅读/重试的结果不作为短暂“已保存”通知隐藏。共享 Alert 统一空 body 与紧凑尺寸，不删除这些业务状态。

## 盘点

初盘在实现前记录 182 个 Alert/hint/notice/banner 入口；扩展检索又纳入所有 `role=alert/status` 入口，共 358 个表面（不重复共享 UI 内部节点）。下表逐入口列出分类；同一组件混用加载与操作错误时，保留加载 Alert，把操作 catch 单独迁往 Toast。

机器可读原始入口和决策：`.foundry/attachments/20261027/dev049/full-inventory.json`。行号为初盘时点。原样式类已移除的入口仍用原路径定位。专用加载/空态与运行中状态不被误归类成操作完成反馈。

| 原入口                                                                           | 类型 | 文案/表面                                                                               | 处置                                                              |
| -------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/web/src/app/workspace-hub-view.tsx:54`                                     | b    | `settings.managedByOwner`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/conversation/chat-message-list.tsx:190`                 | b    | `fdy-chat-waiting`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/conversation/chat-message-list.tsx:205`                 | b    | `message.failed`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/conversation/conversation-queue.tsx:164`                | b    | `fdy-chat-queue-notice`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/conversation/conversation-queue.tsx:337`                | c    | `queue.unconfirmed`                                                                     | FieldHint / 控件自带描述；身份、时间等数据文字不是提示控件        |
| `apps/web/src/components/conversation/conversation.tsx:178`                      | b    | `fdy-chat-composer-blocked`                                                             | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/conversation/conversation.tsx:200`                      | b    | `composer.requestFailed`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/conversation/markdown-mermaid.tsx:37`                   | b    | `diagram.error`                                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/skills/skill-catalog-list.tsx:253`                      | b    | `common:states.loading`                                                                 | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/components/skills/skill-compare-dialog.tsx:247`                    | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/skills/skill-compare-dialog.tsx:251`                    | b    | `compare.loadingIndex`                                                                  | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/components/skills/skill-compare-dialog.tsx:285`                    | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/skills/skill-compare-dialog.tsx:289`                    | b    | `compare.loadingFile`                                                                   | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/components/skills/skill-compare-dialog.tsx:294`                    | b    | `compare.loadingViewer`                                                                 | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/components/skills/skill-compare-dialog.tsx:311`                    | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/skills/skill-dependencies-view.tsx:69`                  | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/skills/skill-dependencies-view.tsx:84`                  | b    | `dependencies.analysisIncomplete`                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/skills/skill-promotion-dialog.tsx:130`                  | b    | `device.loadingComparison`                                                              | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/components/skills/skill-promotion-dialog.tsx:248`                  | a    | `fdy-skill-error`                                                                       | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/components/skills/skill-promotion-dialog.tsx:254`                  | a    | `promotion.offline`                                                                     | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/components/skills/skill-promotion-dialog.tsx:256`                  | a    | `fdy-skill-error`                                                                       | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/components/workspace/workspace-details.tsx:95`                     | b    | `details.inspecting`                                                                    | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/components/workspace/workspace-details.tsx:102`                    | b    | `fdy-location-error`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-details.tsx:107`                    | b    | `<p role="alert" key={message}> {message} </p>`                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-editor.tsx:109`                     | b    | `editor.blocked`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-editor.tsx:111`                     | b    | `editor.removeCurrent`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-editor.tsx:144`                     | b    | `editor.reconnectRemove`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-editor.tsx:149`                     | b    | `fdy-location-error`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-locate-dialog.tsx:116`              | b    | `locate.looking`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-locate-dialog.tsx:165`              | b    | `locate.reconnect`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-locate-dialog.tsx:168`              | b    | `fdy-location-error`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-service-tunnels.tsx:149`            | b    | `tunnels.status.preview_domain_unconfigured`                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-service-tunnels.tsx:158`            | b    | `tunnels.error`                                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-services.tsx:158`                   | b    | `work.loadFailed`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-services.tsx:163`                   | a    | `work.controlFailed`                                                                    | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/components/workspace/workspace-services.tsx:183`                   | b    | `work.loadingServices`                                                                  | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/components/workspace/workspace-services.tsx:208`                   | b    | `work.applying`                                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/components/workspace/workspace-services.tsx:251`                   | b    | `work.serviceStatusUnconfirmed`                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/accounts/account-feature.tsx:125`                         | a    | `<Alert tone={nameFeedback.tone} title={nameFeedback.text} />`                          | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/accounts/account-feature.tsx:169`                         | a    | `<Alert tone={passwordFeedback.tone} title={passwordFeedback.text} />`                  | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/accounts/account-feature.tsx:192`                         | a    | `<Alert tone={languageFeedback.tone} title={languageFeedback.text} />`                  | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/accounts/auth-screen.tsx:118`                             | b    | `auth.inviteUnavailableTitle`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/accounts/auth-screen.tsx:182`                             | b    | `auth.failedTitle`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/accounts/members-feature.tsx:107`                         | a    | `members.updateFailed`                                                                  | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/channels/channels-feature.tsx:44`                         | b    | `readOnlyTitle`                                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/channels/feishu-app-panel.tsx:110`                        | b    | `app.secretMissing`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/channels/feishu-app-panel.tsx:122`                        | b    | `<Alert title={bot.statusDetail} tone="warning" />`                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/channels/feishu-app-panel.tsx:126`                        | b    | `app.rotateHint`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/channels/feishu-app-panel.tsx:207`                        | c    | `app.switchHint`                                                                        | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/channels/feishu-chats-panel.tsx:94`                       | c    | `chats.empty`                                                                           | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/channels/feishu-chats-panel.tsx:119`                      | c    | `chats.needsApp`                                                                        | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/channels/feishu-chats-panel.tsx:123`                      | c    | `chats.mentionCommand`                                                                  | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/channels/feishu-chats-panel.tsx:149`                      | c    | `fdy-feishu-hint`                                                                       | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/channels/feishu-chats-panel.tsx:197`                      | c    | `pairing.pending`                                                                       | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/chat/archived-chats-view.tsx:86`                          | b    | `archive.failed`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/archived-chats-view.tsx:91`                          | b    | `archive.emptyTitle`                                                                    | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/chat/archived-chats-view.tsx:97`                          | b    | `list.noMatches`                                                                        | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/chat/chat-account-usage.tsx:174`                          | b    | `fdy-chat-account-usage-note`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-archive-banner.tsx:51`                          | b    | `archive.title`                                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-archive-dialog.tsx:166`                         | b    | `fdy-chat-archive-disabled-reason`                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-archive-dialog.tsx:214`                         | b    | `archive.loading`                                                                       | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/chat/chat-archive-dialog.tsx:230`                         | b    | `archive.blockers`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-archive-dialog.tsx:298`                         | b    | `archive.failed`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-context-subagents.tsx:87`                       | b    | `contextCard.subagentsRefreshFailed`                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-context-work.tsx:252`                           | b    | `work.applying`                                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-context-work.tsx:257`                           | b    | `fdy-chat-work-error`                                                                   | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-context-work.tsx:384`                           | a    | `<Alert tone="error" title={t( controller.controlError ? "work.controlFailed" : "work.` | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/chat/chat-context-work.tsx:461`                           | b    | `work.receipt`                                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-context-work.tsx:471`                           | b    | `work.pendingCount`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-background.tsx:126`                      | b    | `detail.background.stopConfirm`                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-background.tsx:157`                      | a    | `detail.background.stopFailed`                                                          | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/chat/chat-detail-change.tsx:126`                          | b    | `detail.diff.failed`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-change.tsx:163`                          | b    | `detail.diff.snapshotNote`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-change.tsx:169`                          | b    | `detail.diff.otherEdits`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-change.tsx:176`                          | b    | `detail.diff.changedSince`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-files.tsx:151`                           | b    | `detail.fileNotYet`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-files.tsx:159`                           | b    | `detail.fileMissing`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-detail-files.tsx:166`                           | b    | `detail.fileChanged`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-group-context-menu.tsx:127`                     | b    | `groups.deleteError`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-group-context-menu.tsx:153`                     | b    | `fdy-chat-rename-error`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-rename-dialog.tsx:91`                           | a    | `fdy-chat-rename-error`                                                                 | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/chat/chat-thread-notices.tsx:76`                          | b    | `thread.waitingForDevice`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-thread-notices.tsx:150`                         | b    | `thread.readOnly`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-thread-notices.tsx:154`                         | b    | `<Alert title={threadNotice.title} tone={threadNotice.tone}> <p>{threadNotice.message}` | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-thread-view.tsx:193`                            | b    | `list.reloadGroups`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/chat/chat-thread-view.tsx:205`                            | b    | `list.savingLayout`                                                                     | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/chat/chat-thread-view.tsx:290`                            | b    | `list.noMatches`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/account-inspection.tsx:97`                        | b    | `inspection.offline`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/account-inspection.tsx:99`                        | b    | `inspection.retry`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/account-inspection.tsx:120`                       | b    | `fdy-account-source-missing`                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/account-inspection.tsx:189`                       | b    | `<p role="status"> <Trans ns="profiles" i18nKey="inspection.fallback" values={{ source` | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/account-inspection.tsx:217`                       | b    | `inspection.asking`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/add-device-dialog.tsx:110`                        | b    | `add.failedTitle`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/agent-runtime-status.tsx:38`                      | b    | `<p role={update.state === "failed" ? "alert" : "status"}> {update.detail} </p>`        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/agent-runtime-update-notice.tsx:29`               | b    | `runtimeUpdates.noticeTitle`                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/connection-assignment-dialog.tsx:185`             | b    | `fdy-connection-assign-error`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-account-defaults.tsx:97`                   | c    | `accountDefaults.hint`                                                                  | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/devices/device-account-defaults.tsx:118`                  | b    | `accountDefaults.invalidModel`                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-account-defaults.tsx:160`                  | c    | `contextWindows.invalid`                                                                | FieldHint / 控件自带描述；身份、时间等数据文字不是提示控件        |
| `apps/web/src/features/devices/device-account-defaults.tsx:210`                  | b    | `<span role="status">{message}</span>`                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-account-share.tsx:119`                     | b    | `accountShare.label`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-account-share.tsx:177`                     | b    | `accountShare.read`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-account-share.tsx:180`                     | b    | `list.refresh`                                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-accounts.tsx:194`                          | c    | `fdy-device-account-hint`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/devices/device-accounts.tsx:204`                          | b    | `accounts.suspended`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-accounts.tsx:241`                          | c    | `accounts.installCliHint`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/devices/device-accounts.tsx:249`                          | b    | `<Alert tone={installed.ok ? "success" : "error"} title={ installed.cli?.update ? t(`r` | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-accounts.tsx:312`                          | b    | `<p role="alert">{error}</p>`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-connections.tsx:116`                       | b    | `deviceConnections.savedRefreshing`                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-connections.tsx:174`                       | b    | `<p role="alert">{writeError}</p>`                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-connections.tsx:176`                       | b    | `deviceConnections.refreshFailedDetail`                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-diagnostics.tsx:138`                       | b    | `fdy-location-error`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-diagnostics.tsx:143`                       | b    | `diagnostics.runningNote`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-diagnostics.tsx:248`                       | b    | `diagnostics.repair.running`                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-diagnostics.tsx:251`                       | b    | `fdy-device-diagnostics-note`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-external-connections.tsx:198`              | a    | `<Alert tone={notice.tone} title={notice.title}> {notice.detail} </Alert>`              | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-labels.tsx:103`                            | b    | `labels.loadFailed`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-labels.tsx:113`                            | b    | `labels.loading`                                                                        | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/devices/device-labels.tsx:270`                            | b    | `labels.invalid`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-labels.tsx:271`                            | b    | `<p role="status">{message}</p>`                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-providers.tsx:159`                         | b    | `providers.checking`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-removal-dialog.tsx:95`                     | b    | `removal.blocked`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-removal-dialog.tsx:100`                    | a    | `fdy-device-removal-error`                                                              | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-rename-dialog.tsx:73`                      | a    | `fdy-location-error`                                                                    | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-resources.tsx:57`                          | a    | `<span role="status">{summary}</span>`                                                  | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-resources.tsx:241`                         | a    | `<p role="status">{message}</p>`                                                        | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-resources.tsx:243`                         | a    | `fdy-device-resource-error`                                                             | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-settings.tsx:101`                          | a    | `<p role="status">{message}</p>`                                                        | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-skills.tsx:146`                            | b    | `device.loadingComparison`                                                              | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/devices/device-skills.tsx:226`                            | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-skills.tsx:275`                            | b    | `device.offline`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-skills.tsx:280`                            | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-worker.tsx:203`                            | b    | `<p role="status">{notes.join(" ")}</p>`                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-worker.tsx:205`                            | b    | `fdy-location-error`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-worker.tsx:319`                            | b    | `worker.updateStalledTitle`                                                             | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-worker.tsx:337`                            | a    | `worker.updateFailedTitle`                                                              | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/devices/device-worker.tsx:395`                            | b    | `worker.updateStepSince`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-worker.tsx:414`                            | b    | `fdy-location-error`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/device-worker.tsx:441`                            | b    | `worker.behindTitle`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/devices-feature.tsx:223`                          | b    | `detail.offline`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/devices-feature.tsx:250`                          | b    | `detail.sharedTitle`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/pairing-progress.tsx:87`                          | b    | `add.consent.pairedTitle`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/pairing-progress.tsx:93`                          | b    | `add.consent.cancelledTitle`                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/pairing-progress.tsx:99`                          | b    | `add.consent.expiredTitle`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/pairing-progress.tsx:105`                         | b    | `add.consent.acceptedTitle`                                                             | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/pairing-progress.tsx:113`                         | b    | `add.consent.title`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/pairing-progress.tsx:143`                         | b    | `add.consent.failed`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/promote-provider-dialog.tsx:136`                  | b    | `promotion.keyOffline`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/devices/promote-provider-dialog.tsx:160`                  | b    | `fdy-location-error`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/account-row.tsx:133`                    | b    | `fdy-xacc-row-detail`                                                                   | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/app-row.tsx:67`                         | b    | `apps.rotateHint`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/app-row.tsx:138`                        | b    | `fdy-xacc-row-detail`                                                                   | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/authorize-dialog.tsx:129`               | b    | `connect.failed`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/authorize-dialog.tsx:148`               | b    | `connect.starting`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/cloudflare-connector.tsx:115`           | b    | `connect.tryAgain`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/cloudflare-connector.tsx:135`           | b    | `cloudflare.noSecretStore`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/cloudflare-connector.tsx:352`           | b    | `cloudflare.needsAuth`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/cloudflare-connector.tsx:376`           | b    | `<p role="status"> {t( login?.phase === "verifying" ? "cloudflare.verifying" : link ? ` | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/cloudflare-connector.tsx:393`           | b    | `cloudflare.verificationPending`                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/cloudflare-connector.tsx:540`           | b    | `<Alert tone="error" title={error} />`                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/cloudflare-connector.tsx:541`           | b    | `cloudflare.discovering`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/connect-dialog.tsx:205`                 | b    | `connect.failed`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/connect-dialog.tsx:233`                 | b    | `connect.starting`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-authorization-groups.tsx:41`     | a    | `<Alert title={error} tone="error" />`                                                  | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/external-accounts/device-held-connector.tsx:130`          | b    | `deviceHeld.loadFailed`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-held-connector.tsx:141`          | b    | `deviceHeld.loading`                                                                    | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/external-accounts/device-held-connector.tsx:146`          | b    | `deviceHeld.unknown`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-held-connector.tsx:206`          | b    | `<Alert key={device.deviceId} title={t( state.status === "expired" ? "deviceHeld.remin` | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-held-connector.tsx:439`          | b    | `deviceHeld.installing`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-sign-in-dialog.tsx:221`          | b    | `deviceSignIn.reconnecting`                                                             | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-sign-in-dialog.tsx:251`          | b    | `<Alert tone="info" title={challenge.instruction} />`                                   | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-sign-in-dialog.tsx:254`          | b    | `connect.tryAgain`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/device-sign-in-dialog.tsx:269`          | b    | `deviceSignIn.reconnecting`                                                             | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/feishu-connector.tsx:338`               | b    | `page.loadFailed`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/feishu-connector.tsx:345`               | b    | `page.secretsMissing`                                                                   | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/feishu-connector.tsx:348`               | b    | `page.loading`                                                                          | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/external-accounts/sign-in.tsx:277`                        | b    | `connect.failed`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/sign-in.tsx:283`                        | b    | `connect.tryAgain`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/sign-in.tsx:289`                        | b    | `fdy-xacc-waiting`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/sign-in.tsx:312`                        | b    | `connect.partialTitle`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/workspace-account-authorization.tsx:38` | b    | `connect.cancel`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/workspace-account-authorization.tsx:44` | b    | `workspace.loading`                                                                     | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/external-accounts/workspace-account-authorization.tsx:50` | b    | `workspace.appUnavailable`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/workspace-connectors-feature.tsx:115`   | b    | `workspace.loadFailed`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/workspace-connectors-feature.tsx:118`   | b    | `workspace.loading`                                                                     | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/external-accounts/workspace-connectors-feature.tsx:125`   | b    | `<Alert title={readOnlyReason} tone="info" />`                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/workspace-connectors-feature.tsx:127`   | b    | `workspace.retryBinding`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/workspace-device-connectors.tsx:177`    | b    | `workspace.retryBinding`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/external-accounts/workspace-device-connectors.tsx:270`    | b    | `workspace.loading`                                                                     | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/issue-detail/alignment-conflict.tsx:34`                   | b    | `alignment.title`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/candidate-review.tsx:40`                     | b    | `<p role="alert">{error}</p>`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/candidate-review.tsx:42`                     | b    | `candidate.loading`                                                                     | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/issue-detail/criterion-result-card.tsx:62`                | b    | `criterion.checking`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/criterion-result-card.tsx:114`               | b    | `<p role="alert">{verificationErrorText(verification.error.message)}</p>`               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/evidence-materials.tsx:239`                  | b    | `<p role="alert">{error}</p>`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/evidence-preview.tsx:125`                    | b    | `<p role="alert">{error}</p>`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-contract-panel.tsx:96`                 | b    | `contractPanel.errorTitle`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-conversation.tsx:119`                  | b    | `conversation.replyFailedTitle`                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-conversation.tsx:156`                  | b    | `shared.stepUnfinished`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-detail-view.tsx:90`                    | b    | `view.organizing`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-environment.tsx:45`                    | b    | `environment.loadFailed`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-environment.tsx:80`                    | b    | `environment.needsAttention`                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-evidence-panel.tsx:106`                | b    | `evidence.loading`                                                                      | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/issue-detail/issue-evidence-panel.tsx:122`                | b    | `evidence.checking`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-evidence-panel.tsx:207`                | b    | `shared.stepUnfinished`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issue-detail/issue-question-card.tsx:41`                  | a    | `question.permissionTitle`                                                              | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/issue-detail/issue-question-card.tsx:65`                  | a    | `<p role="alert">{error}</p>`                                                           | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/issue-detail/issue-sessions.tsx:55`                       | a    | `<p role="alert">{error}</p>`                                                           | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/issue-detail/verification-actions.tsx:428`                | a    | `<p role="alert">{error}</p>`                                                           | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/issues/initialize-git-dialog.tsx:51`                      | b    | `fdy-git-setup-error`                                                                   | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issues/issue-notices.tsx:20`                              | b    | `worker.title`                                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/issues/issues-feature.tsx:314`                            | b    | `page.needsAgent`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-gate.tsx:42`                     | b    | `loading`                                                                               | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/personal-agent/assistant-gate.tsx:51`                     | b    | `loadFailed`                                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-home.tsx:272`                    | b    | `loading`                                                                               | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/personal-agent/assistant-home.tsx:276`                    | b    | `conversation.loadFailed`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-home.tsx:334`                    | b    | `loadFailed`                                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-home.tsx:339`                    | b    | `home.stopped.title`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-home.tsx:344`                    | b    | `home.offline.title`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-home.tsx:385`                    | b    | `inbox.readFailed`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-home.tsx:394`                    | c    | `inbox.retrySettingsHint`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/assistant-settings.tsx:231`                | b    | `settings.models.catalogFailed`                                                         | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-settings.tsx:309`                | b    | `settings.unsaved`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-settings.tsx:319`                | b    | `settings.loosen.title`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/assistant-settings.tsx:330`                | a    | `settings.saveFailed`                                                                   | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/personal-agent/assistant-setup.tsx:124`                   | a    | `setup.failed`                                                                          | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:102`                  | c    | `planning.completed`                                                                    | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:121`                  | b    | `planning.executionStillOpen`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:128`                  | b    | `fdy-pa-field-hint`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:134`                  | c    | `planning.clarify`                                                                      | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:157`                  | c    | `planning.clarify`                                                                      | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:168`                  | c    | `planning.location`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:214`                  | c    | `planning.service`                                                                      | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:236`                  | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:243`                  | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:311`                  | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:318`                  | c    | `planning.evidenceNeeded`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:321`                  | a    | `planning.saveFailed`                                                                   | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:325`                  | c    | `planning.completeHint`                                                                 | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list-plan.tsx:350`                  | c    | `planning.modeHint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/person-list.tsx:56`                        | b    | `list.loadFailed`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/person-list.tsx:156`                       | a    | `list.failed`                                                                           | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/personal-agent/proposal-card.tsx:98`                      | a    | `proposal.answerFailed`                                                                 | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/personal-agent/settings-activity.tsx:81`                  | b    | `settings.activity.loadFailed`                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-activity.tsx:90`                  | b    | `loading`                                                                               | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/personal-agent/settings-device-references.tsx:42`         | b    | `settings.devices.unavailable`                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-entry.tsx:177`                    | c    | `settings.entry.hoursHint`                                                              | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-field.tsx:31`                     | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge-location.tsx:18`        | b    | `settings.devices.removed`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge-location.tsx:26`        | b    | `knowledge.offlineSource`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge-pending.tsx:36`         | b    | `knowledge.pending`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:321`                | c    | `knowledge.isolationHint`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:330`                | b    | `knowledge.failed`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:338`                | b    | `loading`                                                                               | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:421`                | b    | `knowledge.state`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:428`                | c    | `knowledge.migrationHint`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:430`                | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:522`                | b    | `knowledge.moveProgress`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:530`                | c    | `knowledge.moveRoute`                                                                   | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:567`                | b    | `knowledge.copyCleanup`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:576`                | c    | `knowledge.recallHint`                                                                  | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:599`                | c    | `knowledge.cachedAccount`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:633`                | c    | `knowledge.domainHint`                                                                  | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:696`                | c    | `knowledge.location`                                                                    | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:710`                | b    | `knowledge.state`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:755`                | c    | `knowledge.forgetScope`                                                                 | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:771`                | c    | `knowledge.entryState`                                                                  | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:812`                | b    | `knowledge.adoptTitle`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:816`                | c    | `knowledge.capacity`                                                                    | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:884`                | c    | `knowledge.publishHint`                                                                 | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-knowledge.tsx:975`                | c    | `knowledge.forgetLimits`                                                                | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-limits.tsx:81`                    | c    | `settings.limits.usageNote`                                                             | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:121`              | c    | `maintenance.description`                                                               | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:122`              | c    | `maintenance.boundaries`                                                                | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:124`              | b    | `maintenance.error`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:136`              | c    | `maintenance.empty`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:153`              | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:162`              | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:267`              | c    | `maintenance.current`                                                                   | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:275`              | c    | `maintenance.proposed`                                                                  | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-maintenance.tsx:282`              | b    | `maintenance.stale`                                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-memory.tsx:92`                    | b    | `settings.memory.loadFailed`                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-memory.tsx:101`                   | b    | `loading`                                                                               | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/personal-agent/settings-memory.tsx:143`                   | a    | `settings.memory.failed`                                                                | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/personal-agent/settings-memory.tsx:152`                   | c    | `settings.memory.pendingBody`                                                           | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-memory.tsx:255`                   | b    | `knowledge.legacyMoving`                                                                | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-models.tsx:149`                   | c    | `settings.models.inherits`                                                              | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-models.tsx:156`                   | c    | `settings.models.applyNext`                                                             | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-models.tsx:252`                   | c    | `settings.models.fallbackHint`                                                          | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-rules.tsx:64`                     | c    | `settings.rules.archiveSessionHint`                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-runs.tsx:67`                      | c    | `runs.boundaries`                                                                       | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-runs.tsx:68`                      | c    | `runs.budgetHint`                                                                       | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-runs.tsx:70`                      | b    | `runs.failed`                                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/settings-runs.tsx:106`                     | c    | `fdy-pa-field-hint`                                                                     | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-runs.tsx:114`                     | c    | `runs.configuration`                                                                    | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-runs.tsx:127`                     | c    | `runs.requestedOnly`                                                                    | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-runs.tsx:130`                     | c    | `runs.usage`                                                                            | FieldHint（保留 id/描述关联）；校验用 error tone                  |
| `apps/web/src/features/personal-agent/settings-status.tsx:185`                   | a    | `<Alert tone="error" title={error.title}> {error.message} </Alert>`                     | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/personal-agent/task-list.tsx:49`                          | b    | `tasks.loadFailed`                                                                      | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/personal-agent/task-list.tsx:160`                         | a    | `tasks.stopFailed`                                                                      | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/profiles/connection-devices.tsx:149`                      | a    | `<p role="alert">{error}</p>`                                                           | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/profiles/context-window-fields.tsx:101`                   | c    | `contextWindows.invalid`                                                                | FieldHint / 控件自带描述；身份、时间等数据文字不是提示控件        |
| `apps/web/src/features/profiles/profile-editor.tsx:154`                          | c    | `fdy-profile-field-error`                                                               | FieldHint / 控件自带描述；身份、时间等数据文字不是提示控件        |
| `apps/web/src/features/profiles/profile-editor.tsx:159`                          | b    | `editor.baseUrlSavedAs`                                                                 | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/profiles/profile-editor.tsx:219`                          | b    | `<small role="status"> {codexTransportStatus( t, draft.codexTransport, profile?.codexT` | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/profiles/profiles-feature.tsx:182`                        | a    | `fdy-profile-modal-error`                                                               | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/resources/resource-activity.tsx:69`                       | b    | `activity.failed`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resource-activity.tsx:80`                       | b    | `activity.loading`                                                                      | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/resources/resource-backends.tsx:222`                      | b    | `access.check.output`                                                                   | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resource-backends.tsx:238`                      | b    | `fdy-res-status`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resource-backends.tsx:244`                      | b    | `install.wait`                                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resource-backends.tsx:250`                      | b    | `fdy-res-status`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resource-backends.tsx:255`                      | a    | `fdy-res-error`                                                                         | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/resources/resource-backends.tsx:331`                      | b    | `install.output`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resource-compute-access.tsx:71`                 | b    | `compute.saving`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resource-compute-access.tsx:76`                 | a    | `fdy-res-note`                                                                          | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/resources/resource-compute-access.tsx:81`                 | a    | `fdy-res-error`                                                                         | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/resources/resource-lease.tsx:118`                         | a    | `fdy-res-status`                                                                        | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/resources/resource-lease.tsx:123`                         | a    | `fdy-res-error`                                                                         | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/resources/resources-feature.tsx:123`                      | b    | `loadFailed`                                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resources-feature.tsx:131`                      | b    | `problems.title`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/resources/resources-feature.tsx:144`                      | b    | `loading`                                                                               | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/resources/resources-feature.tsx:269`                      | a    | `fdy-res-status`                                                                        | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/resources/resources-feature.tsx:274`                      | a    | `fdy-res-error`                                                                         | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/sharing/sharing-feature.tsx:127`                          | a    | `updateFailed`                                                                          | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/sharing/sharing-feature.tsx:180`                          | b    | `runsCode.title`                                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/add-repository-dialog.tsx:240`              | b    | `library.repo.readingOnDevice`                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/add-repository-dialog.tsx:253`              | b    | `library.repo.reading`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/add-repository-dialog.tsx:297`              | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/bundle-tool-status.tsx:234`                 | b    | `library.bundle.setupRunningNote`                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/bundle-tool-status.tsx:238`                 | b    | `library.bundle.setupFinished`                                                          | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/bundle-tool-status.tsx:245`                 | c    | `fdy-skill-error`                                                                       | FieldHint / 控件自带描述；身份、时间等数据文字不是提示控件        |
| `apps/web/src/features/skill-library/recommended-bundles.tsx:175`                | b    | `library.recommended.addingNote`                                                        | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/recommended-bundles.tsx:182`                | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/repository-source.tsx:227`                  | a    | `library.repo.workingNote`                                                              | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skill-library/repository-source.tsx:229`                  | a    | `fdy-skill-error`                                                                       | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skill-library/skill-bundle-row.tsx:234`                   | a    | `library.bundle.working`                                                                | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skill-library/skill-bundle-row.tsx:239`                   | a    | `fdy-skill-error`                                                                       | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skill-library/skill-library-feature.tsx:155`              | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skill-library/skill-pick-row.tsx:133`                     | a    | `library.repo.workingNote`                                                              | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skill-library/skill-pick-row.tsx:138`                     | a    | `fdy-skill-error`                                                                       | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skill-library/skill-repositories-section.tsx:80`          | b    | `library.repo.loading`                                                                  | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/skills/draft-trial-dialog.tsx:141`                        | a    | `<p role="alert">{error}</p>`                                                           | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skills/foundry-skill-page.tsx:108`                        | b    | `foundrySkill.loadFailed`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skills/foundry-skill-page.tsx:118`                        | b    | `foundrySkill.loading`                                                                  | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/skills/skill-version-pin.tsx:70`                          | a    | `fdy-skill-error`                                                                       | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/skills/skills-feature.tsx:142`                            | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skills/skills-feature.tsx:148`                            | b    | `workspace.dismissNotice`                                                               | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skills/skills-feature.tsx:250`                            | b    | `workspace.duplicateNames`                                                              | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skills/workspace-bundles.tsx:107`                         | b    | `fdy-skill-error`                                                                       | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skills/workspace-drafts.tsx:110`                          | b    | `fdy-workspace-drafts-alert`                                                            | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/skills/workspace-drafts.tsx:115`                          | b    | `drafts.loading`                                                                        | 保留专用加载/空态，短状态沿用语义角色                             |
| `apps/web/src/features/skills/workspace-drafts.tsx:120`                          | b    | `drafts.unsupported`                                                                    | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/workspaces/workspace-overview.tsx:165`                    | b    | `overview.offlineNote`                                                                  | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/workspaces/workspace-overview.tsx:167`                    | b    | `<p role="alert">{error}</p>`                                                           | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/workspaces/workspace-overview.tsx:238`                    | b    | `<p role="status">{repo.error}</p>`                                                     | Alert / 共享状态文字；诊断报告、授权进度、分页/队列阻塞保留上下文 |
| `apps/web/src/features/workspaces/workspace-selection-panel.tsx:183`             | a    | `fdy-workspace-success`                                                                 | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `apps/web/src/features/workspaces/workspace-selection-panel.tsx:188`             | a    | `fdy-location-error`                                                                    | Toast；混合加载/动作状态拆开，加载故障仍为 Alert                  |
| `features/chat/chat-archive-feedback.tsx` 原成功/错误 Alert                      | a    | 归档 + Undo                                                                             | Toast，不插入双栏之前                                             |
| `app/app-notices.tsx`                                                            | a/b  | 全局通知、保存/加载、API 不可达、新版本                                                 | 操作和进度 Toast；持续故障/版本为共享 Alert                       |
| `lib/use-copied.ts`                                                              | a    | 复制成功/失败                                                                           | 统一 Toast，覆盖所有复制入口                                      |
| `features/accounts/account-feature.tsx`                                          | d    | 语言说明                                                                                | FieldHelp/Popover                                                 |

## 实现与审计

- `components/ui/toast.tsx` / `toast.css`：共享 API、Provider、受限堆叠、操作生命周期与可访问性。
- `field.tsx` / `field.css` / `field-help.tsx`：共享字段帮助与可选说明；删除原 PA、Feishu、设备/账户等 hint 样式。
- `row-menu.tsx` / `row-menu-parts.tsx` / `row-menu.css`：统一动作菜单；删除 chat-list、chat-groups、turn-menu 的功能样式。
- 迁移全局 notice、账户、成员、权限、设备外部连接、资源、助理、Skills、Workspace 和聊天动作反馈；通过语义事件传递 error tone，不从中英文字符串猜严重性。
- `audit-feedback.mjs` 已接入 `audit:ui`，没有新增 baseline：拒绝新 `*-hint/*-notice`、功能层直接拼装 Radix 菜单条目/表面，以及能可靠识别的“saved/copied/saveFailed/stopFailed…” Alert。设备已删除、历史已归档等状态不靠关键词粗暴判断。
- `audit-feedback.test.mjs` 验证三种坏例被拒绝、合法持续 Alert 被允许。`ui-feedback.test.mjs` 验证 StrictMode 去重、最多三条、Undo 忙碌/失败/成功、更新不复活以及剪贴板拒绝。

## 部署与验证流水

| 北京时间            | 实际结果                                                                                                       | 边界                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 2026-10-27 14:30 起 | 读取 AGENTS/架构/准出标准，保留原 main 未提交工作，初盘和实现共享 Toast                                        | 无 Git/Server/Worker 写入                                                               |
| 2026-10-27 14:46    | 首批 Web `fb84ebdf93ac9e78` 已部署，public version.json 一致；已通知协调会话用户可刷新重试                     | 原 index/version 在 `~/.foundry/server/releases/dev049-hints/previous/`；原 assets 保留 |
| 同日首批检查        | 24 文件 checker 全绿：格式、全量 Web typecheck、54 测试文件、10 audits；生产构建通过                           | 后续菜单与全项目迁移仍在进行                                                            |
| 同日浏览器          | 四组 light/dark × 1280/390，真实右键、Shift+F10、菜单键、左对齐、disabled 第二行、Popover、堆叠和横向宽度通过  | 合成 fixture，无用户真实聊天写操作                                                      |
| 同日专项            | 归档/Undo/恢复/失败；F8→Tab→Undo→Enter；悬停/聚焦超时暂停与离开后消失；错误 assertive；busy 禁用；失败保留操作 | 初次脚本短时遇到 HMR 重载和 fixture 回调闭包，修正后重跑                                |
| 最终检查/部署       | 最终 Web 069a4d3a7c0f6c77；119 文件分段覆盖、最终 delta checker 全绿                                           | 人工验收未完成                                                                          |

最初菜单回归仍查询旧 `[role=alert]` 节点，已改验 Toast 表面；旧 V3 审计写死胶囊通知样式，已更新该已替换组件的契约。现存其他 3 条 V3 布局债务未扩充。中间失败日志保留，最终通过状态另列，不把中途失败混称全程通过。全组遇到旧断言后未清理模态框而驻留，已停止该失效运行、补 afterEach 卸载并重新串行检查；没有修改生产逻辑去迎合旧节点选择器。

一次过时构建和重复测试已在内存压力出现后停止，两个浏览器随即关闭，验证了各自 PID 已退出。后续检查/构建遵守共享 flock 串行，未停止其他活动会话。

候选 build 使用独立输出目录 `~/.foundry/server/releases/dev049-hints/web`，避免与 DEV-050 的构建产物互相覆盖。DEV-050 的最终分页源码已进入冻结候选 Web build，其功能验收由 DEV-050 会话负责，本项不替其宣称准出。

### 冻结候选与发布顺序

2026-10-27 16:21，冻结候选 `3b449cf945b20c61` 已构建并部署，公网 `version.json` 与 index meta 一致。发布前 typecheck、11 项 UI audits、归档/菜单/Toast 11 测试通过；Vite 成功，存在既有大 chunk 提示。源码冻结位置 `~/.foundry/server/releases/dev049-hints/snapshot/`，607 个源码文件清单摘要 `39d632273535571f144f729ad68afc097387ad46724f733a4190aa03df1aaf76`。依赖复用现有 node_modules；pnpm 11 包装命令曾触发安装检查而中止，随后直接使用本地 tsc/node/Vite 成功，没有重装依赖。

候选包含 DEV-050/051 的稳定源码，不包含当时正在实现的 DEV-052。DEV-052 随后于 16:22 发布 `f0af1c5d7df5517d`，本会话不再用旧快照覆盖该版本。第一批 `fb84ebdf93ac9e78` 的 index/version 另存 `~/.foundry/server/releases/dev049-hints/first-phase/`，最初回滚仍在 `previous/`，每次发布保留原 assets。

部署后用 e2e-alice 的独立合成工作区只读检查：真实中文菜单 Shift+F10、light 1280 / dark 390；账户 FieldHint 为 12px/6px；帮助可点击/Enter 打开、Escape 关闭。没有归档或修改真实聊天/账户。此轮发现共享 Popover 原本超宽（470.78px，right=482.78），为 `.fdy-popover` 添加官方 available-width/height、换行及滚动限制；本地中文 light/dark 390 复验 left=18/right=378/width=360、clientWidth=scrollWidth=358。该最终 CSS 小修已由 DEV-052 的冻结候选 `069a4d3a7c0f6c77` 于 16:40 发布；公网 version/index 与 6 个入口 assets 的 SHA256 均核对一致，回执见 `.foundry/attachments/20261027/dev052/web-final-deployment.json`。此候选不含 DEV-051 新增的预览/下载需求；本会话没有重新发布旧快照。

冻结快照完整回归在独立源码上串行运行，避免 DEV-052 并行改动污染断言。原测试只挂载页面而没有 shell viewport，现挂载相同 ToastProvider；补失败后清理、DOM Event 环境以及目录查询 mock 的正确响应，业务请求/重试断言保留。16:34 左右该 206 文件 checker 及排队 delta checker 意外返回 143；Foundry 无对应 stop operation/barrier，peer 已提供其仅针对自身单个排队 PID 的操作回执，当前不能断言终止原因。中断前 108 个测试文件已执行到后继文件，日志共有 586 条通过、零失败；已保存 `frozen-tests.log` 与 `test-coverage.json`。末尾 worker/workspace 共 11 文件补跑 40/40 通过，退出码 0（`tail-tests.log`）；不把这次中断写成“整组 checker 全绿”。最后 6 文件 delta checker 全绿：格式、当前主树 typecheck（60秒）、2 文件测试、11 audits；独立覆盖最后的 CSS、测试 helper 与目录响应 mock（`final-delta-check.log`）。

磁盘低于 10GiB 时仅回收已关闭的本会话浏览器 Cache（约 113MB），未动 DB/WAL、其他会话缓存或 Go 缓存；build 前后约 9.9–10GiB 可用。

最终公开版本又在真实账户页复验：`069a4d3a7c0f6c77`，e2e-alice，390×844、浅/深色；帮助 left=12/right=368/width=356、clientWidth=scrollWidth=354，页面无横向溢出。Enter 打开、Escape 关闭并还原焦点到说明按钮。没有修改账户/聊天；浏览器已关闭。回执 `final-public-browser.json`，截图 `deployed-final-help-{light,dark}-390.png`。

## 截图与原始证据

目录：`.foundry/attachments/20261027/dev049/`。

| 证据                        | 文件                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 用户原图                    | `user-before.png`、`menu-user-before.png`                                                                                       |
| 归档与恢复                  | `archive-after-light-1280.png`、`folder-toast-dark-390.png`、`keyboard-undo-focus-light-390.png`、`keyboard-undo-light-390.png` |
| 动作失败不插正文            | `archive-error-dark-390.png`；一次 Toast、零重复 inline Alert、scrollWidth=390                                                  |
| 共享菜单全页矩阵            | `chat-menu-{pointer,keyboard,disabled}-{light,dark}-{1280,390}.png`、`folder-menu-*.png`                                        |
| RowMenu / FieldHelp / Toast | `row-dropdown-hover-*.png`、`field-help-*.png`、`feedback-*.png`                                                                |
| 浏览器逐步回执              | `browser-matrix.json`，含色值、坐标、disabled 与布局断言                                                                        |
| 代码归属清单                | `files.txt`（206 文件，排除 DEV-050/051 自有文件，保留其源码）                                                                  |

### 部署后与边界修复截图

- `deployed-menu-light-1280.png`、`deployed-menu-dark-390.png`：真实 dev 中文页面，键盘打开同一菜单。
- `deployed-field-help-light-1280.png`：真实账户页共享字段间距与帮助按钮。
- `deployed-field-help-dark-390.png`：部署后发现的旧 Popover 超宽证据；不能当成通过截图。
- `popover-fixed-zh-{light,dark}-390.png`：修复后本地共享原语，使用同一账户中文说明，完整换行。
- `submenu-fit-{light,dark}-390.png`：两级菜单可用宽度限制后的截图；旧 `submenu-selected-hover-dark-390.png` 属于修复前证据。

## 人工验收

1. 刷新 dev。在一条完成的合成对话上右键：Archive 与 Rename 左对齐，无孤立图标；普通状态下没有常亮底色，hover/键盘焦点清楚。运行对话的 Archive 禁用，并在下一行显示先停止。
2. 聚焦对话行和文件夹，按 Shift+F10 或菜单键，看到相同菜单；文件夹归档显示数量。列表行/文件夹头没有独立 Archive 图标。
3. 在合成工作区归档，正文不下移；浮层 Undo 可见。F8 后 Tab 到 Undo，Enter 恢复；失败显示错误，Undo 可重试。关闭提示后不会自行重新出现。
4. 切换浅/深色、390px：通知通栏但不挡底部 composer/send，菜单没有横向溢出，禁用原因可读。
5. 查看账户、设备、助理设置：帮助文字的字号/颜色/间距统一；语言 Info 按钮支持点击和键盘，必要规则/错误仍留在上下文。
6. 复制任意合成命令或会话 ID，结果用相同 Toast；拒绝剪贴板权限时有错误反馈。

## 限制

- 浏览器对共享原语和归档有真实交互验证；未逐一触发所有外部系统的保存、授权、安装或删除动作，避免改变用户真实配置。相关调用与状态映射由类型检查/回归测试覆盖。资源未生效/等待授权的说明保留 Alert，资源完成结果和外部连接最后一行移除的结果直接发布 Toast，覆盖原节点消失的情况。
- 本项只验证 Issue/Evidence 中的共享反馈显示映射和相关自动回归；没有重新执行完整模型驱动的 G1–G5 Issue 创建/实现/Accept 链路，不据此宣称该业务链路重新准出。
- 菜单与帮助视觉已由 Agent 在正常比例全页检查；用户审美确认和人工验收仍待完成。
- Toast 最多三条，连续大量操作会移除最早反馈；有 Undo 的条目通常不自动消失，但仍遵循堆叠上限。归档恢复也可从已归档页执行。

## 2026-10-27 委托 Agent 准出（编排会话 sess_1793063405185071529）

用户于 2026-10-27 在编排会话中明确：“验证的话你自己接口级别+端到端级别自行验证吧”。以下为 Agent 自验证据，不代表用户本人测试；只关闭已验证范围。

- 结论：通过（委托 Agent 准出）。证据：编排会话在 fixture 中实测右键/Shift+F10 菜单（无外露归档图标、项左对齐）、文件夹归档浮层 Toast（fixed，不挤正文，scrollWidth 不溢出）与 Undo 恢复；复核已部署版本截图（菜单、帮助 Popover）。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
