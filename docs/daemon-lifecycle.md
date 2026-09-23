# Foundry Daemon Lifecycle

Symbol-level map of the local daemon. References name modules and exported
symbols instead of line numbers, so this file survives refactors. Grep the
symbol name to find the current code.

## Module map

| Concern                                               | Module                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Connect loop, socket lifecycle, message dispatch      | `packages/worker/src/daemon-connection.ts`                                |
| Envelope send helpers, acknowledged session transport | `packages/worker/src/transport.ts` (`ReliableSessionTransport`)           |
| Canonical wire message names                          | `packages/protocol/src/daemon-messages.ts`                                |
| Envelope shape + validation                           | `packages/protocol/src/validation.ts`                                     |
| File / subagent / directory replies, session events   | `packages/worker/src/session-helpers.ts`                                  |
| Provider execution (Claude, Codex, profile commands)  | `packages/worker/src/runner.ts`                                           |
| Turn idle watchdog                                    | `packages/worker/src/watchdog.ts`                                         |
| Concurrency gate                                      | `packages/worker/src/task-scheduler.ts`                                   |
| Steer / cancel target registries                      | `packages/worker/src/session-state.ts`                                    |
| Server side of the socket                             | `apps/server/internal/httpapi/daemon_ws.go`                               |
| Server request/response correlation                   | `apps/server/internal/httpapi/daemon_rpc.go`                              |
| Evidence / verification worker RPC                    | `packages/worker/src/evidence-rpc.ts`                                     |
| Native account inspection and login flows             | `packages/worker/src/native-inspection.ts`, `profile-authorization.ts`    |
| Workspace inspection and Issue environment RPC        | `packages/worker/src/workspace-inspection.ts`, `issue-environment-rpc.ts` |
| Browser SSE lifecycle                                 | `apps/server/internal/httpapi/browser_events.go`                          |
| Server process configuration and lifecycle            | `apps/server/cmd/foundry-server/main.go`, `config.go`, `lifecycle.go`     |
| Stale-session reconciliation                          | `apps/server/internal/httpapi/agent_session_recovery.go`                  |
| Workspace skill scanning and packaging                | `packages/worker/src/skill-*.ts`                                          |

## 1. Connection layer

```
cli.ts main() → dispatch "connect"
  │
  └─ connect()                    [daemon-connection.ts]
       ├─ connectPolling()         ← HTTP fallback
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
constants in `daemon_ws.go`.

`scripts/audit-contract.mjs` compares the two **as sets of names**. It does not
validate payload types, envelope direction, or handler coverage. Regression
tests for the parsers live in
`packages/protocol/test/daemon-message-contract.test.mjs`.

Inbound handlers in `runWebSocketSession`, keyed by `daemonMessageTypes`:

| Inbound                                                      | Handling                                                                | Reply                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `error`                                                      | log server error                                                        | —                                                               |
| `ack`                                                        | `sessionTransport.acknowledge()` [transport]                            | —                                                               |
| `registered`                                                 | bind session transport, `announceAdditionalIssueCapacity()`             | `readyForIssue` × free slots                                    |
| `readFile`                                                   | `sendFileRead()` [session-helpers]                                      | `fileRead`                                                      |
| `readSubagentTranscript`                                     | `sendSubagentTranscript()`                                              | `subagentTranscriptRead`                                        |
| `listSubagents`                                              | `sendSubagentList()`                                                    | `subagentsListed`                                               |
| `listDirectories`                                            | `sendDirectoryListing()`                                                | `directoriesListed`                                             |
| `inspectWorkspace`                                           | workspace inspection handler [workspace-inspection]                     | `workspaceInspected`                                            |
| `inspectNativeAccount`                                       | `inspectNativeAccount()` [native-inspection]                            | `nativeAccountInspected`                                        |
| `setupWorkspace`                                             | `initWorkspace()` [workspaces]                                          | `workspaceReady`                                                |
| `forgetWorkspace`                                            | `forgetWorkspaceRegistration()`                                         | `workspaceForgotten`                                            |
| `listAgentModels`                                            | `listAgentModelsConfig()` [models]                                      | `agentModelsListed`                                             |
| `upsertAgentProfile`                                         | `upsertAgentProfileConfig()` [profiles]                                 | `agentProfileUpserted`                                          |
| `upsertAgentRuntimeSettings`                                 | `writeAgentRuntimeSettings()` + `taskScheduler.setMaxConcurrentTasks()` | `agentRuntimeSettingsUpserted`                                  |
| `startProfileAuthorization` / `completeProfileAuthorization` | native OAuth flow via node-pty [profile-authorization]                  | `profileAuthorizationStarted` / `profileAuthorizationCompleted` |
| `readProfileCredential`                                      | read sealed credential for one dispatch [profiles]                      | `profileCredentialRead`                                         |
| `scanSkills`                                                 | `scanSkillRoots()` over the requested roots                             | `skillsScanned`                                                 |
| `readSkillFile` / `readSkillContent`                         | read one skill file / `packageSkillDirectory()` for promotion           | `skillFileRead` / `skillContentRead`                            |
| `issueEnvironment`                                           | prepare/inspect/cleanup Issue environments [issue-environments]         | `issueEnvironmentResult`                                        |
| `evidenceRequest`                                            | clarify/seal/collect/assess/accept/recover RPC [evidence-rpc]           | `evidenceResult`                                                |
| `steerSession`                                               | active steer target [session-state]                                     | `sessionSteered`                                                |
| `cancelSession`                                              | `cancelActiveSession()`                                                 | `sessionCanceled`                                               |
| `runSession`                                                 | claim, `taskScheduler.schedule()` → `executeAgentSession()`             | `sessionStarted` … `sessionCompleted`                           |
| `runIssue`                                                   | `taskScheduler.schedule()` → `executeIssue()` [issue-execution]         | `runStarted`, `runEvent`, `issueCompleted`                      |

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
  └─ executeAgentSession(transport, executionPath, session, …)   [daemon-connection.ts]
       ├─ 0. executionPath = sessionExecutionPath() (worktree-backed sessions)
       ├─    registerSessionAmbientEnv() → session token for `foundry` CLI/MCP
       ├─ 1. queuedSessionCancelRequests hit → return without starting
       ├─ 2. send sessionStarted
       ├─ 3. dispatch by provider:
       │       claude → runClaudeWorkspaceSession()   [runner.ts]
       │       codex  → runCodexWorkspaceSession()    [runner.ts]
       ├─ 4. success → completion marker + sessionCompleted{response}
       ├─ 5. isAgentSessionCanceledError() → emit "Session canceled" (warning)
       ├─ 6. other failure → emit "Session failed" + sessionCompleted{error}
       └─ 7. finally → clear steer/cancel targets, unregister ambient env
```

## 5. Claude execution paths

```
runClaudeWorkspaceSession()                       [runner.ts]
  ├─ buildClaudeLaunchPlan() — fail-closed workspace-skill policy
  ├─ create .foundry/sessions/<id>/
  ├─ profile has a custom command → runProfileCommandSession() (spawn sh -lc)
  └─ otherwise → runClaudeAgentSdkSession()
       │    SDK import/start failure → runClaudeCliSession() fallback
       ├─ import @anthropic-ai/claude-agent-sdk, build base options
       └─ active runtime reuse:
            ├─ cleanupActiveClaudeRuntimes()  ← evicts entries older
            │    than settings.activeRuntimeTtlMs
            ├─ runtimeKey = activeRuntimeKey() — SHA-256 of
            │    provider + workspace + session/profile identity + options
            ├─ reusable (open, same native session) → emit
            │    "Reused active Claude Agent SDK"
            ├─ otherwise → close the stale entry, new runtime with
            │    AsyncInputQueue (resume the native session when known)
            └─ register steer/cancel targets, create turn +
               ClaudeTurnWatchdog, push prompt, startActiveClaudePump()
```

### Active runtime pump

```
startActiveClaudePump(runtime, query)              [runner.ts]
  └─ for await (message of query) → handleActiveClaudeMessage()
       stream ends without a result → closeActiveClaudeRuntime(reason)
       always → closeActiveClaudeRuntime() + drop from the runtime map

handleActiveClaudeMessage(runtime, message)        [runner.ts]
  ├─ refresh lastUsed, extract nativeSessionId, turn.watchdog.touch()
  ├─ append raw message to messagesPath
  ├─ updateActiveClaudeTurnTasks(): task_started/background_tasks_changed
  │    → retain task IDs on the turn
  │    task_notification → settle the matching retained task ID
  ├─ claudeProcessEvent()  [sdk-messages.ts] → emit progress to the UI
  ├─ claudeAgentResultError() → closeActiveClaudeRuntime(error)
  ├─ claudePartialText()      → accumulate + emit response stream
  └─ message.type === "result"
       ├─ retained tasks remain → treat as provisional, keep the Foundry turn
       │  running, and wait for Claude's notification-driven continuation
       └─ no retained tasks → write resultPath, emit finished,
          resolveActiveClaudeTurn(); an empty final result closes the runtime
```

## 6. Liveness layers

| Layer                         | Owner                                                    | Purpose                                                       |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Daemon process heartbeat file | `connectWebSocket()`, 30s interval                       | external supervisor liveness                                  |
| Session execution claim       | `SessionExecutionRegistry.activeSessionIds()` on hello   | distinguishes same-process reconnects from orphaning restarts |
| Native chat sync              | `runWebSocketSession()` open handler                     | periodic `syncKnownNativeChats()`                             |
| `ClaudeTurnWatchdog`          | `watchdog.ts`, one per active-runtime turn               | idle and max-duration turn timeouts                           |
| Active runtime TTL            | `cleanupActiveClaudeRuntimes()` vs `activeRuntimeTtlMs`  | evicts idle or closed SDK runtimes                            |
| Stale reconciliation          | `reconcileAgentSession()` in `agent_session_recovery.go` | fails abandoned runs so the UI stops showing them as running  |

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
