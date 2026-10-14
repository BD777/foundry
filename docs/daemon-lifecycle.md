# Foundry Daemon Lifecycle

Symbol-level map of the local daemon. References name modules and exported
symbols instead of line numbers, so this file survives refactors. Grep the
symbol name to find the current code.

## Module map

| Concern                                               | Module                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Connect loop, socket lifecycle, dispatch wiring       | `packages/worker/src/daemon-connection.ts`                                |
| Message handlers, one file per domain                 | `packages/worker/src/daemon/handlers/*.ts`                                |
| Running a dispatched session                          | `packages/worker/src/daemon/session-execution.ts`                         |
| Envelope send helpers, acknowledged session transport | `packages/worker/src/transport.ts` (`ReliableSessionTransport`)           |
| Canonical wire message names                          | `packages/protocol/src/daemon-messages.ts`                                |
| Envelope shape + validation                           | `packages/protocol/src/validation.ts`                                     |
| File / subagent / directory replies, session events   | `packages/worker/src/session-helpers.ts`                                  |
| Provider execution (Claude, Codex, profile commands)  | `packages/worker/src/runner/` (gathered by `runner.ts`)                   |
| Turn idle watchdog                                    | `packages/worker/src/watchdog.ts`                                         |
| Concurrency gate                                      | `packages/worker/src/task-scheduler.ts`                                   |
| Steer / cancel target registries                      | `packages/worker/src/session-control.ts`                                  |
| Server side of the socket                             | `apps/server/internal/httpapi/daemon_{hub,conn,inbound}.go`               |
| Server request/response correlation                   | `apps/server/internal/httpapi/daemon_rpc.go`                              |
| Evidence / verification worker RPC                    | `packages/worker/src/evidence-rpc.ts`                                     |
| Native account inspection                             | `packages/worker/src/native-inspection.ts`                                |
| Workspace inspection and Issue environment RPC        | `packages/worker/src/workspace-inspection.ts`, `issue-environment-rpc.ts` |
| Browser SSE lifecycle                                 | `apps/server/internal/httpapi/browser_events.go`                          |
| Browser event names and payloads (server)             | `apps/server/internal/browserevent/`                                      |
| Browser event names and payloads (clients)            | `packages/protocol/src/browser-events.ts`                                 |
| Server process configuration and lifecycle            | `apps/server/cmd/foundry-server/main.go`, `config.go`, `lifecycle.go`     |
| Stale-session reconciliation                          | `apps/server/internal/httpapi/agent_session_recovery.go`                  |
| Workspace skill scanning and packaging                | `packages/worker/src/skill-*.ts`                                          |

## 1. Connection layer

```
cli.ts main() → dispatch "connect"
  │
  └─ connect()                    [daemon-connection.ts]
       └─ connectWebSocket()       ← reconnect loop
            ├─ process heartbeat file: ~/.foundry/daemon-heartbeat every 30s
            ├─ syncReviews()       [issues.ts] once before connecting
            │
            └─ runWebSocketSession()   ← one socket attempt
                 ├─ WebSocket (maxPayload 2 MiB)
                 ├─ ConcurrentTaskScheduler(readAgentRuntimeSettings().maxConcurrentTasks)
                 │
                 ├─ socket.on("open")
                 │    ├─ build registrations for every known workspace
                 │    ├─ attach process-owned activeSessionIds
                 │    ├─ send hello, then workspaceReady per extra workspace
                 │    └─ start syncKnownNativeChats() interval
                 │
                 ├─ socket.on("message")
                 │    └─ parseProtocolEnvelopeJSON() → close 1002 on invalid envelope
                 │
                 ├─ socket.on("close")
                 │    └─ race(taskScheduler.whenIdle(), 30s shutdownTimeout) → finish(false)
                 │
                 └─ socket.on("error") → rejectSession() → reconnect
```

## 2. Message vocabulary

All envelope `type` values live in `daemonMessageTypes`
(`packages/protocol/src/daemon-messages.ts`). The worker imports that object;
it does not spell wire literals inline. The Go server keeps matching `ws*Type`
constants in `daemon_wire.go`.

`scripts/audit-contract.mjs` compares the two **as sets of names**. It does not
validate payload types, envelope direction, or handler coverage. Regression
tests for the parsers live in
`packages/protocol/test/daemon-message-contract.test.mjs`.

Inbound handlers in `runWebSocketSession`, keyed by `daemonMessageTypes`:

| Inbound                              | Handling                                                                        | Reply                                      |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `error`                              | log server error                                                                | —                                          |
| `ack`                                | `sessionTransport.acknowledge()` [transport]                                    | —                                          |
| `registered`                         | bind session transport, `announceAdditionalIssueCapacity()`                     | `readyForIssue` × free slots               |
| `readFile`                           | `sendFileRead()` [session-helpers]                                              | `fileRead`                                 |
| `readSubagentTranscript`             | `sendSubagentTranscript()`                                                      | `subagentTranscriptRead`                   |
| `readSessionFile`                    | `readSessionFile()`: a ledger-listed file, bounded [session-files]              | `sessionFileRead`                          |
| `listSubagents`                      | `sendSubagentList()`                                                            | `subagentsListed`                          |
| `listDirectories`                    | `sendDirectoryListing()`                                                        | `directoriesListed`                        |
| `inspectWorkspace`                   | workspace inspection handler [workspace-inspection]                             | `workspaceInspected`                       |
| `inspectNativeAccount`               | `inspectNativeAccount()` [native-inspection]                                    | `nativeAccountInspected`                   |
| `setupWorkspace`                     | `initWorkspace()` [workspaces]                                                  | `workspaceReady`                           |
| `forgetWorkspace`                    | `forgetWorkspaceRegistration()`                                                 | `workspaceForgotten`                       |
| `listAgentModels`                    | `listAgentModelsConfig()` [models]                                              | `agentModelsListed`                        |
| `upsertAgentProfile`                 | `upsertAgentProfileConfig()` [profiles]                                         | `agentProfileUpserted`                     |
| `upsertAgentRuntimeSettings`         | `writeAgentRuntimeSettings()` + `taskScheduler.setMaxConcurrentTasks()`         | `agentRuntimeSettingsUpserted`             |
| `readProviderKey`                    | `configuredProviderKey()`: the key one provider names, for promotion [profiles] | `providerKeyRead`                          |
| `scanSkills`                         | `scanSkillRoots()` over the requested roots                                     | `skillsScanned`                            |
| `readSkillFile` / `readSkillContent` | read one skill file / `packageSkillDirectory()` for promotion                   | `skillFileRead` / `skillContentRead`       |
| `issueEnvironment`                   | prepare/inspect/cleanup Issue environments [issue-environments]                 | `issueEnvironmentResult`                   |
| `evidenceRequest`                    | seal/collect/assess/accept/recover RPC [evidence-rpc]                           | `evidenceResult`                           |
| `steerSession`                       | active steer target [session-state]                                             | `sessionSteered`                           |
| `cancelSession`                      | `cancelActiveSession()`                                                         | `sessionCanceled`                          |
| `runSession`                         | claim, `taskScheduler.schedule()` → `executeAgentSession()`                     | `sessionStarted` … `sessionCompleted`      |
| `runIssue`                           | `taskScheduler.schedule()` → `executeIssue()` [issue-execution]                 | `runStarted`, `runEvent`, `issueCompleted` |

### Server-side RPC correlation

Every server-initiated request goes through the `daemonRPC` registry
(`daemon_rpc.go`) owned by its daemon connection. It allocates collision-free IDs, registers before enqueueing,
and removes an entry on response, context cancellation, queue failure, payload
validation failure, or connection teardown. A malformed correlated response
therefore fails its HTTP caller immediately instead of leaving it blocked until
timeout. Late and unknown responses are harmless; connection teardown
(`failAllPending()` → `failAll()`) releases every remaining waiter with
`local daemon disconnected`.

## 3. Server shutdown

```
SIGINT / SIGTERM
  → signal.NotifyContext()                         [main.go]
  → serve(): shutdown context (ShutdownTimeout, 15s)   [lifecycle.go]
  → httpapi.Server.Shutdown()                      drains what http.Server cannot
       ├─ Feishu bots StopAll()
       ├─ browserEventHub.Shutdown()               closes SSE streams
       └─ DaemonHub.Shutdown()
            ├─ reject new upgrades with 503
            └─ close every upgraded socket concurrently;
               each connection's daemonRPC.failAll() releases callers
  → http.Server.Shutdown(); Close() if the budget expired
  → store Close() exactly once (deferred in run())
```

HTTP `ReadTimeout` and `WriteTimeout` intentionally remain zero because SSE and
WebSocket responses are long-lived. `ReadHeaderTimeout`, `IdleTimeout`, header
size limits, protocol heartbeats, per-request contexts, and bounded graceful
shutdown provide the applicable limits instead.

## 4. Session execution

```
runSession → taskScheduler.schedule(sessionSchedulingKey(...), …)
  │
  └─ executeAgentSession(transport, executionPath, session, …)   [daemon/session-execution.ts]
       ├─ 0. executionPath = sessionExecutionPath() (worktree-backed sessions)
       ├─    registerSessionAmbientEnv() → session token for `foundry` CLI/MCP
       ├─ 1. takeQueuedSessionCancel() hit → return without starting
       ├─ 2. send sessionStarted
       ├─ 3. dispatch by provider:
       │       claude → runClaudeWorkspaceSession()   [runner/claude-turn.ts]
       │       codex  → runCodexWorkspaceSession()    [runner/codex-turn.ts]
       ├─ 4. success → completion marker + sessionCompleted{response}
       ├─ 5. isAgentSessionCanceledError() → emit "Session canceled" (warning)
       ├─ 6. other failure → emit "Session failed" + sessionCompleted{error}
       └─ 7. finally → clear steer/cancel targets, unregister ambient env
```

## 5. Claude execution paths

```
runClaudeWorkspaceSession()                       [runner/claude-turn.ts]
  ├─ buildClaudeLaunchPlan() — fail-closed workspace-skill policy
  ├─ create .foundry/sessions/<id>/
  ├─ profile has a custom command → runProfileCommandSession() (spawn sh -lc)
  └─ otherwise → runClaudeAgentSdkSession()
       │    (no CLI fallback: an SDK error is the session's error)
       ├─ import @anthropic-ai/claude-agent-sdk, build base options
       └─ active runtime reuse:
            ├─ cleanupActiveClaudeRuntimes()  ← evicts idle entries older
            │    than settings.activeRuntimeTtlMs (never a busy one)
            ├─ runtimeKey = activeRuntimeKey() — SHA-256 of
            │    provider + workspace + session/profile identity + options
            ├─ reusable (open, same native session) → emit
            │    "Reused active Claude Agent SDK"
            ├─ otherwise → close the stale entry, new runtime with
            │    AsyncInputQueue (resume the native session when known)
            └─ register steer/cancel targets, create turn +
               ClaudeTurnLiveness, push prompt, startActiveClaudePump()
```

### Active runtime pump

```
startActiveClaudePump(runtime, query)              [runner/claude-messages.ts]
  └─ for await (message of query) → handleActiveClaudeMessage()
       stream ends without a result → closeActiveClaudeRuntime(reason)
       always → closeActiveClaudeRuntime() + drop from the runtime map

handleActiveClaudeMessage(runtime, message)        [runner/claude-messages.ts]
  ├─ refresh lastUsed, extract nativeSessionId
  ├─ append raw message to messagesPath
  ├─ turn.liveness.observe(): tool calls, model requests, retries and
  │    compaction in flight; a tool_result emits "Used tool"/"Tool failed"
  ├─ updateActiveClaudeTurnTasks(): task_started/background_tasks_changed
  │    → retain task IDs on the turn
  │    task_notification → settle the matching retained task ID
  ├─ claudeProcessEvent()  [sdk-messages.ts] → emit progress to the UI
  ├─ claudeAgentResultError() → closeActiveClaudeRuntime(error)
  ├─ claudePartialText()      → accumulate + emit response stream
  └─ message.type === "result"
       ├─ retained tasks remain → treat as provisional (the answer is kept as
       │  deliveredResponse), keep the Foundry turn running, and wait for
       │  Claude's notification-driven continuation
       └─ no retained tasks → write resultPath, emit finished,
          resolveActiveClaudeTurn(); an empty final result closes the runtime
```

## 6. Liveness layers

| Layer                         | Owner                                                    | Purpose                                                       |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Daemon process heartbeat file | `connectWebSocket()`, 30s interval                       | external supervisor liveness                                  |
| Session execution claim       | `SessionExecutionRegistry.activeSessionIds()` on hello   | distinguishes same-process reconnects from orphaning restarts |
| Native chat sync              | `runWebSocketSession()` open handler                     | periodic `syncKnownNativeChats()`                             |
| Turn liveness                 | `watchdog.ts`, one per Claude or Codex turn              | in-flight operations, notices, start-up bound and ceiling     |
| Active runtime TTL            | `cleanupActiveClaudeRuntimes()` vs `activeRuntimeTtlMs`  | evicts idle or closed SDK runtimes; never a busy one          |
| Stale reconciliation          | `reconcileAgentSession()` in `agent_session_recovery.go` | fails abandoned runs so the UI stops showing them as running  |

### Turn liveness

Silence is never a death signal. A turn is alive while its agent process is:
the pump sees the process exit or the SDK stream end or throw. Claude Code's
own keep-alives do not reach the SDK stream, and long tool calls, model
requests, retries and background work are legitimately quiet, so time since
the last message decides nothing.

- **Expected silence is known.** `ClaudeTurnLiveness` follows the message
  stream: a `tool_use` is in flight until its `tool_result` (the step row
  stays "Using tool" until then), a model request from `status: requesting`
  or `message_start` until `message_stop` (stream pings count as progress),
  an `api_retry` for its delay plus the request timeout, compaction from
  `status: compacting` until it ends. Background tasks and timers are the
  runtime's (`claudeRuntimeHasLiveWork`). `CodexTurnLiveness` does the same
  from Codex items.
- **Bounds are the runtime's own** (Claude Code,
  https://code.claude.com/docs/en/env-vars, read from the environment the CLI
  process gets): a foreground Bash call its `timeout`, else
  `BASH_DEFAULT_TIMEOUT_MS` (2 min), at most `BASH_MAX_TIMEOUT_MS` (10 min) —
  at that limit Claude Code moves the command to the background and the call
  returns; a model request `API_TIMEOUT_MS` (10 min) per attempt; an MCP call
  `MCP_TOOL_TIMEOUT` (~28 h). Codex: `stream_idle_timeout_ms` (5 min). Other
  tools have no documented limit and stay visible as running. An operation
  past its bound plus `FOUNDRY_TURN_OPERATION_GRACE_MS` (2 min) gets one
  "looks stuck" Notice; nothing is killed.
- **Long quiet is a notice.** With nothing in flight for
  `FOUNDRY_TURN_QUIET_NOTICE_MS` (10 min), the turn gets a Notice ("No
  progress … the agent may be stuck") and keeps running; the person can stop
  it.
- **Start-up hangs fail.** A process started for the turn must send its first
  message within `FOUNDRY_AGENT_STARTUP_TIMEOUT_MS` (3 min; phase "starting
  the process") and reach the model within `API_TIMEOUT_MS` plus grace (phase
  "sign-in or first response"). The error includes the end of Claude Code's
  stderr.
- **Ceiling.** `FOUNDRY_TURN_MAX_DURATION_MS` (12 h, `0` turns it off) is the
  last-resort limit per turn.
- **A delivered answer stands.** A turn that waits for background work
  (`waitsForBackgroundWork`) keeps Claude's answer; if a stop, the process
  ending or a new runtime ends it before that work settles, the turn completes
  with the answer and a Notice saying the work was cut off. A chat's turn ends
  with its answer anyway.

The recurring timers in `daemon-connection.ts` maintain process health and
native chat synchronization. Session liveness is connection state, not a
synthetic transcript event; the UI also filters legacy `Still working` records
(`apps/web/src/lib/agent-session-events.ts`).

Codex sessions follow the same pattern with `activeCodexThreads`
(`cleanupActiveCodexThreads()`, "Reused active Codex thread").

## 7. Known problem areas

**Active runtime state leak.** If a session is failed by stale reconciliation
while its SDK process keeps orphaned subtasks, the runtime can stay in the map
and be reused. The next turn then reports no completion record and resolves
with an empty response. Mitigated by `closeActiveClaudeRuntime()` on an empty
final result and by `activeRuntimeTtlMs` eviction, not fully eliminated.

**Stale reconciliation.** Normal progress advances `lastActivityAt`; a socket
reconnect also carries the process-owned active session IDs. The server only
honors an exact `(device, session)` execution claim, so a same-process reconnect
survives a long outage while a restarted daemon cannot keep an orphan alive by
reusing the device ID.

**Connection leak on shutdown.** `socket.on("close")` awaits
`taskScheduler.whenIdle()`. A wedged task would block reconnect forever, so the
wait races against `shutdownTimeout`; a stuck task still leaves work orphaned.

**Provider env precedence.** `profile.env` model overrides must assign, not
default-assign, or context compaction can select a model the account cannot
use. `profileRuntimeEnvironment()` also mirrors the profile env into the SDK
flag settings so the chosen profile stays authoritative.

## 8. Topology

```
                    ┌──────────────────┐
                    │   Server (Go)    │
                    │   :31982         │
                    └────────┬─────────┘
                             │  WebSocket + HTTP API
    ┌────────────────────────┼────────────────────────┐
    ▼                        ▼                        ▼
┌──────────┐          ┌──────────┐          ┌──────────┐
│ Browser  │          │  Daemon  │          │  CLI     │
│ (Vite)   │          │ (Node)   │          │ (user)   │
│ :31983   │          │          │          │          │
└──────────┘          └────┬─────┘          └──────────┘
                           │
                connectWebSocket()   ← reconnect loop
                           │
                runWebSocketSession()  ← one socket
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
    hello /          runSession /       steerSession /
    workspaceReady   runIssue           cancelSession
                           │
                  taskScheduler.schedule()
                           │
                  executeAgentSession()
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
    runClaudeWorkspaceSession   runCodexWorkspaceSession
              │
     runClaudeAgentSdkSession
              │
       active runtime
     startActiveClaudePump()
              │
              ▼
        sessionCompleted
```
