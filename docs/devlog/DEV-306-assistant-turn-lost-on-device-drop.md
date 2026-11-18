# DEV-306 — assistant's own turn lost when its computer drops

Status: deployed to dev as train 91 (2026-11-18); pending the person's acceptance; merged to main (PR #279).

## Problem

When the computer that runs an assistant's own conversation (home or message
channel) loses its connection to the server, that conversation's turn may be
cut off. Foundry already tells the assistant about the helpers it handed work
to on that computer (`assistant.DeviceBack`, `personalagent/assistant/device_back.go`),
but nothing covered the assistant's own turn. DEV-290 found that gap
(`sess_1794942081888585421`, §2 and design option B).

The person's condition (2026-11-18, verbatim):

> 「可以按你的建议做，但是你要确定它确实被中断了才去做这个唤醒。不要说它误判的电脑离线，它没有被中断，你却又去唤醒它。但其实电脑离线，因为 Agent Session 是跑在电脑上面的，它离线只是说它跟我们的 Server 没连上，所以它的 Agent 说不定还是在跑的。你这个也要处理好，我就是很担心你这个唤醒的动作是一种非常不必要的打扰。」

So a disconnect alone is not an interruption. The computer may still be running
the turn. Only the computer's own answer, after it connects again, can say the
turn is lost.

## How "really interrupted" is decided

The server asks about a turn only when the turn is one it still counts as
running and the reconnecting computer does not claim it:

- `httpapi/session_dispatch.go:334` `recoverOrphanedAgentSessions`: on every
  hello, each `running`/`blocked` input of the device that `hasActiveSession`
  does not claim (the hello's `activeSessionIds`) gets `recover_session`. Each
  ask is recorded per connection (`noteOrphanAsk`, `:367`) with the device, the
  input, when the device came back and, when the server saw the drop, when it
  dropped (`awayFor`, `personal_agent_ports.go:248`).

The device answers with `session_completed` for the input. The server then
decides:

| Case                                                          | What the server sees                                                                                                                                                | Recorded today                                    | Notice                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| Kept running (device still runs it)                           | Its hello claims the input (`activeSessionIds`); not asked at all                                                                                                   | Turn stays `running`; it completes later as usual | **No**                                                    |
| Finished while the device was away                            | Answer to the ask carries a recorded `response` (`recoveredCompletion` → `recordedCompletion`, worker `execution-core.ts`)                                          | Settled `completed`                               | **No**                                                    |
| Really lost                                                   | Answer to the ask carries an `error` and no `response` ("The worker stopped while this message was running, so its result was lost…", worker `recoveredCompletion`) | Settled `failed` (`SettleAgentSessionInput`)      | **Yes, once**, if the conversation is the assistant's own |
| Server already failed it as stale before the device came back | Not active, so never asked (`staleMessage`, `sessions/recovery.go`)                                                                                                 | Settled `failed` by the stale sweep               | **No**: nothing confirmed the loss                        |
| Device gone for good                                          | Never reconnects; no answer                                                                                                                                         | Waits, then fails after `OfflineWaitLimit`        | **No**                                                    |
| Not an assistant's session                                    | `assistant.Service.Conversation` is false                                                                                                                           | —                                                 | **No**                                                    |

The gate in code (`httpapi/daemon_session_inbound.go:150`, `:222`):
`asked, wasAsked := c.takeOrphanAsk(...)`; the notice is queued only when
`wasAsked && deviceLostTurn(payload)` (`session_dispatch.go:393`: `payload.Error != ""`,
`payload.Response == ""`, not a canceled failure) and the server has just
settled that input (`applied`). A replayed answer returns early (stale input),
so a lost turn is told once.

## What the assistant is told

`personalagent/assistant/turn_lost.go` (`TurnLost`), through the existing notice
path (`notices.addLine` → `tell`, kind `device_back`; no contract change). Text
(`turnLostTexts`):

- zh, with the drop time: 你的这一轮被中断了：电脑“{computer}”{A}离线，{B}回来，它已经不在运行这一轮，也没有保留结果。被中断的输入：{input}
- en, with the drop time: Your turn was interrupted: the computer "{computer}" went offline at {A} and came back at {B}. It no longer runs this turn and kept no result. The input that was running: {input}
- Without a known drop time (server restarted): the same without "went offline at {A}".

The input is `cutSummary` (200 characters at most). Times are in the person's
location.

Gates in `TurnLost`:

- Only `Service.Conversation(session)` (home or channel conversation).
- Not while the assistant is stopped (`agent.State != PersonalAgentActive`), and
  re-checked when the notice goes out. This matches the existing back notice,
  which drops a stopped assistant's notice rather than delivering it on resume.
- `stillInput`: the conversation's current input must still be the lost one. A
  later input (the person's or the assistant's) that started first cancels it.
  Checked at queue time (`due`) and again in the send closure.
- Dedupe: the key is `turn-lost:<input id>`; the settle path runs once per input.

## Changed files

New:

- `apps/server/internal/personalagent/assistant/turn_lost.go`
- `apps/server/internal/httpapi/turn_lost_notice_test.go`
- `docs/devlog/DEV-306-assistant-turn-lost-on-device-drop.md`

Edited (additions only, no lines removed):

- `apps/server/internal/httpapi/daemon_conn.go`: `orphanAsks` map on the connection; `assistant` import.
- `apps/server/internal/httpapi/daemon_hub.go`: `assistantTurnLost` hook.
- `apps/server/internal/httpapi/server.go`: wires `server.assistant.TurnLost`.
- `apps/server/internal/httpapi/session_dispatch.go`: records asks in `recoverOrphanedAgentSessions`; `noteOrphanAsk`, `takeOrphanAsk`, `deviceLostTurn`; `time` import.
- `apps/server/internal/httpapi/daemon_session_inbound.go`: takes the ask in `onSessionCompleted`; calls the hook after a settle.

## Tests (`turn_lost_notice_test.go`)

Each runs a real daemon websocket with the assistant fixture (`newAssistantFixture`, device `dev_alice`, credential header):

- `TestOrphanedTurnTheComputerStillRunsIsNotTold`: hello claims the turn → not asked, input unchanged, still running.
- `TestOrphanedTurnFinishedWhileAwayIsNotTold`: answer with a recorded result → `completed`, no notice input.
- `TestOrphanedTurnLostIsToldOnce`: answer with the lost error → one notice input and one notice run on the computer; the same answer sent again adds none.
- `TestOrphanedTurnLostWhileStoppedIsNotTold`: stopped assistant → no notice input.
- `TestLostTurnIsNotToldWhenThePersonSentSomethingNew`: a later input exists → `TurnLost` queues nothing.
- `TestLostTurnOfANonAssistantSessionIsNotTold`: a project session in another workspace → nothing.

"No notice" is checked by the conversation's input staying the same (`tell` creates the notice input before it is dispatched). "Told" waits up to 20 s for the computer to receive the run. The launch of a run takes about 5 s in the test environment, so a short wait misses it.

## Checks

All on CanWendeMac-mini (`remote-check.sh`, shared lease), against the shared tree plus this change:

- `-run 'TestOrphanedTurn|TestLostTurn|TestReconnectAsksTheDeviceAboutOrphanedInputs|DeviceBack|Recover|Orphan'` on `./internal/httpapi`: PASS.
- `-run 'Device|Recover|Orphan|Notice|DeviceBack|Assistant'` on `./internal/httpapi`: PASS (about 3 min; see the flake note below).
- `./internal/personalagent/...`: PASS.
- `./internal/sessions/`: PASS.
- `go vet ./internal/httpapi ./internal/personalagent/... ./internal/sessions/`: PASS.
- `gofmt -l`: clean. `scripts/audit-module-boundaries.mjs`: 0 tracked violations.

## Limitations

- A stopped assistant is not told, and nothing is delivered on resume. The brief said "delivered on resume like other notices", but the existing back notice drops it. This follows the existing convention; changing it is a product decision.
- After a server restart the drop time is unknown; the notice then omits the drop time. The turn is still told if the computer answers that it lost it.
- A turn the server already failed as stale (the computer away longer than `defaultAgentSessionStaleAfter`, 30 min) is not told, since nothing confirmed the loss.
- The notice reuses kind `device_back` to avoid regenerating the contract enum (`contracts/models/sessions.yaml`). A distinct kind would be a contract change.
- The existing `turn_failed` pending item for the lost turn is unchanged. `NotifyPendingItem` does not notify an assistant's own conversation, so there is no second notice.
- Not verified on a real device or in a real browser. Deployed to dev as train 91 (2026-11-18); the dev check is in Results.

## Results

- The six `TestOrphanedTurn*` / `TestLostTurn*` tests pass with the decisions above; the lost-turn test shows exactly one notice input and one notice run to the computer, and a replayed answer adds none.
- Flake, not reproduced in a paired run: `TestNativeChatHistoryPagesBackThroughItsDevice` (device history paging, not on the assistant path) hung for about 8 min in the first broad run and again in a second broad run on this tree. It passes alone (about 1 s), and both this tree and a base tree without the change passed the broad pattern in about 3 min. The cause is not traced; the earlier hangs were not compared against base.
- Dev (orchestrator, 2026-11-18, train 91): the deploy gates `-run 'TurnLost|Device|Recover|Orphan|Notice|DeviceBack|Assistant'` on `./internal/httpapi` ok. No live device drop was staged, because it would interrupt running sessions, so the turn-lost notice itself is not verified on dev.
- Not run: the full `pnpm verify`, Web and Worker packs, or a real-browser check.
