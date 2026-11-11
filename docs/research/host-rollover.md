# Execution host rollover after a Worker update

Status: implemented in worktree `host-rollover`, not committed, not deployed.

## Problem

2026-11-12, byte-dev: the Worker was updated to `…1794420871` (daemon PID 3053614 and
`runtime/current` new), but the execution host PID 2961542 kept running the old
`…1794413999` from 00:33. A Codex session started at 02:21 had that old host as parent, so its
built-in MCP forwarder was old too and the new `connector_instances` `secretFiles` resolution
never applied. sg-chaos showed the host stuck in `pending`, "waiting for sessions to drain".

## Current design (before)

- One host per device: one root (`execution-host/`), one socket, one service label/unit, one
  `claims.json`, one outbox (`execution-host/paths.ts`).
- The daemon's `ExecutionHostClient` (`execution-host/client.ts`) compares the running host's
  `entry`/`runtimeStamp` with its own (`targetChanged`). If they differ it starts a drain
  (`beginDrain`, `drain.ts`):
  - up to `runnerSwitchCapMs` (30 s) new turns are held (`held`) while turns run;
  - **past the cap `holding()` turns false and held and later turns go to the old host**
    ("they run on the old runner, which switches at the first moment no turn runs");
  - the switch (`switchRunner`) needs the old host idle: `prepare_upgrade` → stop → start new.
- The switch only happens when no turn, background task or service runs. On a shared, busy device
  there is no such moment, so the old host takes every new turn forever.

## Root cause

The replacement is an in-place swap of one host, so the old host can only be replaced when idle,
and after a 30 s cap new work is handed back to it. The cap was meant to avoid a 29-minute hold
(DEV-072) but turned "wait for drain" into "never switch": the old host's own new turns are what
keep it busy.

## Design

Two hosts coexist. The newest takes all new work; older ones retire and are stopped when empty.

### Layout (`execution-host/roots.ts`, `fleet.ts`, `paths.ts`, `service.ts`)

- A host's identity is its root. The original root stays for hosts that exist today (they are
  found and treated as retiring); a new runtime's host lives at
  `execution-hosts/<sha256(stamp)[0:12]>/` with its own socket, token, service label/unit
  (they derive from the root), `claims.json`, `controls.json`, outbox, heartbeat, identity.
- The service is launched with its root as a third argument (`main.ts`; macOS launcher passes
  `FOUNDRY_EXECUTION_ROOT`; an older launcher that cannot is bypassed with a direct command).
- Ports: every listener (server MCP forwarder, gateway forwarder, Codex compat) binds port 0 in
  the host process, and a session is handed the address of the host it runs in. Two hosts cannot
  collide; nothing is configured.

### Daemon side (`fleet.ts`, new)

`ExecutionHostFleet` replaces the single client behind `executionHostClient()` (same methods)
and owns one `ExecutionHostClient` per host (each a plain control link; the in-place hold/switch
of `client.ts` stays for the one-host case and its tests).

- `start()`: live hosts = roots whose `identity.json` process still runs. The one running this
  daemon's runtime is active; if none, the active host is the new generation root (started by
  the service manager through `open()`). Every other live host is marked retiring in the daemon,
  but it is **told to retire and stopped only once the active host answers** (`activeHealthy`).
  Until then the older host is still the one that serves: new turns go to it, so a new runtime
  whose host never comes up (crash loop, bad release) leaves the device on the old host. If the
  active host stays unreachable for 20 s, an older host that was already retired is un-retired.
- `refresh()` also re-links a live root nobody links (a host that was restarted by its service
  manager after a crash is retired again), and forgets a retiring host with no process only when
  the daemon stopped it (the `stopped` marker, see below) or it stayed dead for 60 s; forgetting
  releases its claims in the daemon's session registry and recomputes the native-work set.
- `run`: hosts that are being stopped, or unreachable, are never routed to (their link is closed
  while `stop` may take 20 s on launchd). A repeated dispatch goes to the host holding the input; a session held by a retiring
  host (running turn, background task, busy agent) stays there; a session idle in a retiring
  host first has its idle agent closed (`release_session`) and then runs on the active host with
  the same Foundry and native session id; everything else goes to the active host.
  A retiring host that refuses (race) falls back to the active host.
- `steer`/`cancel`/`stopBackground`/`controlGoal` go to the host that holds the session.
- `refresh()` (every 5 s): when a retiring host reports no turn and no background task and has
  no unacknowledged envelope, `drainDecision`'s "switch" branch (idle/boundary) runs
  `prepare_upgrade` and the service is stopped. Past-cap logic is not used: no new turn is
  ever sent to it.
- `runner()` (device `runtimeState` report, no contract change): without retiring hosts it is the
  active host's runner; with them it is the oldest retiring host, `pending`, with its running
  turns / background sessions, `targetVersion` = the active host, `waitingFor`, `switching`
  while stopping, `failed` + error if stopping failed. `deadline` is absent: nothing waits.
  "Switch now" (`switchNow`) cancels the reviewed turns and stops the retiring hosts.

### Host side (`server.ts`, `protocol.ts`, `active-runtimes.ts`)

Protocol additions (same protocol number, additive): snapshot `capabilities: ["rollover"]`,
`retiring`, `standby`, `resident`, `outbox`; methods `retire`, `release_session`.

- `retire`: the host accepts a `run` only for a session it holds (claim, background task, busy
  agent) or an input it already claimed; closes idle agents now and after every turn
  (5 s announce tick); pauses timer revival (the active host owns timers).
- `release_session`: closes the session's idle agent unless it works.
- Hosts without the capability (every host that exists today) are only routed around and are
  stopped by the same drain rule; they cannot be asked to release an idle agent.

### Shared device state: one owner at a time

The session-work inventory, `session-timers.json`, timer revival, and the leftover reapers
(`reapSessionTools`, connector profiles, Claude settings) are device-global files with no
cross-process locking. A host that starts while a **senior** host lives starts in **standby**
(`snapshot.standby`): it serves turns, but session-work attaches are deferred
(`deferSessionWork`), timers are in memory (`SessionTimers.load` lets memory win and, when it
had timers of its own, writes the merged set), and none of the reapers or revival run. Senior =
the live host with the earlier `startedAt` in its `identity.json` (a host from before rollover
has none and is senior to every new one; the root path breaks a tie), so two hosts that start
together (macOS login runs every retained plist) cannot both wait for each other. Each 5 s tick
the standby host checks for a senior (`seniorHostPresent`): one that runs, or that died without
the daemon's `stopped` marker less than 60 s ago (its service manager may restart it, and a host
from before rollover would take the work again). When none is left it takes the work over exactly
as a first start does. Deferred attaches are written to `deferred-session-work.json` in the host's
own root, so a standby host that is stopped before it takes over still hands its sessions on:
the host that takes the inventory over reads (and removes) every other root's file. A retiring host keeps running its
own inventory until it exits, but pauses timer revival so a timer is never delivered twice.

### Claims and outbox

Isolated by root, so no two hosts write one `claims.json` or outbox. What a stopped host leaves
(unacknowledged envelopes, claims still `active`) is taken over by the active host
(`adoption.ts`): envelopes are re-queued in its own outbox with their ids and removed from the
old one; active claims are reported as interrupted (`executionHostStoppedError`), never rerun.
A root is adopted only when its host is gone for good: the daemon writes a `stopped` marker in
the root after it stopped the service (a marker older than the identity is ignored, a starting
host removes it), or the host has been dead for 60 s without being restarted. A host that merely
crashed is restarted by systemd (`Restart=on-failure`, 1 s) or launchd (`KeepAlive`) and reports
its own interrupted inputs and replays its outbox; adopting it in that window would deliver
everything twice and orphan the restarted process (`adoptionDue`, `adoption.ts`). The daemon does not stop a capable host while its `outbox` is non-zero.
`pruneRuntimes` pins the runtime of every host that has an identity, not just the original.

## Invariants

1. Once the active host answers, no new session or input is sent to a retiring host, except
   one it already holds (running turn, background task, busy agent) or a duplicate dispatch of
   an input it claimed. Before that the older host serves, and it is never stopped.
2. A turn running in a retiring host is never stopped except by the owner's "switch now".
3. A native session has one writer: an idle agent in a retiring host is closed before the
   active host resumes the session; a busy one keeps the session until its work ends.
4. Each host has its own socket, token, service, claims, outbox; ports are per process.
5. Shared device work (session-work inventory, kept timers, reapers) has at most one owner; the
   newer host waits in standby, so no two processes write the same file.
6. A stopped host's unsent envelopes and unfinished inputs are delivered or reported as
   interrupted by the active host; nothing is rerun.

## Limitations (stated, not hidden)

- The host that exists today when this ships has no `rollover` capability: it is routed around,
  but cannot be told to pause its timers or release idle agents. A session that was idle there
  with only a resident idle agent is treated as free, so for a short overlap a native session may
  have an idle old process and a new one; sessions with kept Claude timers on that old host may
  deliver a timer twice. This exists for the first rollover only.
- A retiring host that holds background tasks forever keeps the new host in standby: kept
  timers (including Claude timers that were due) and the session-work inventory of the new
  host's sessions are not delivered or reported until it exits. The runner report shows
  `waitingFor: background`. Timers set while standing by live only in memory until the takeover
  (a crash of the standby host in that window loses them).
- The first rollover cannot know the sessions that sit idle with a resident agent in a host from
  before rollover: its snapshot has no `resident` list and no `release_session`. Making the new
  host wait for them would need the old host's cooperation (or a record of dispatches that
  survives a daemon restart), so it stays a limitation of that one rollover.
- Completed-claim duplicate suppression (24 h) does not follow a retired host's claims.
- Retiring hosts exit through the service manager (`stop`), driven by the daemon; with the daemon
  down they stay until it returns. launchd's KeepAlive makes a self-exit pointless.

## Rollback

Installing an older Worker (one without this feature) is **not safe while hosts run outside the
original root**: the old Worker knows only the original root, starts its own host there, and that
host has no standby logic, so two hosts would deliver timers and own session work; its
`pruneRuntimes` also pins only the original root's runtime and could delete the runtime folders
that the generation hosts run from.

What the new Worker does about it (`execution-host/rollback.ts`, `worker-install.ts`):
before an update or install goes to a build with a lower version (the server's served build or
npm's latest), it refuses with the message above while any host other than the original-root
host still runs. Two ways forward:

1. wait: the retiring hosts exit when their turns and background tasks end; then the update is
   allowed (one host in the original root is what the old Worker expects);
2. `FOUNDRY_STOP_HOSTS_FOR_DOWNGRADE=1 foundry-worker update`: stops every execution host first
   (turns running in them are interrupted and reported so), then installs.

`stopExecutionHost` (uninstall, device removal, the override above) keeps the `identity.json` of a
host that left unfinished inputs or envelopes, with the `stopped` marker, so a Worker with this
feature adopts it later. The older Worker cannot: those inputs stay unreported (sessions show as
running) until the Worker is updated again; so prefer waiting over the override.

Limits: the check runs in the new installer, so it cannot cover a manual downgrade that does not
go through `update`/`install` (switching `runtime/current` by hand, `npx` of an old build). In that
case stop the hosts first: `systemctl --user stop 'foundry-execution-*'` or `launchctl bootout`
of the `…execution…` labels, and delete `execution-hosts/`. The refusal covers versions only
where both parse as `x.y.z`.

## macOS launcher

A host beside the original one needs the app launcher to pass `FOUNDRY_EXECUTION_ROOT`. If the
installed launcher predates that, the host is started as a plain `node` process, without the
Foundry app identity that macOS privacy grants are tied to. This now logs once per daemon
(`Execution host starts without the Foundry app launcher …`) and asks for `update`/`install`,
which rewrites the launcher. Not verified on a real Mac: whether an update rewrites the
launcher before the daemon restarts (it is written in `install/service.ts`).

## Verification

`packages/worker/test/host-rollover.test.mjs`: fake hosts and sessions (new turn → new host, old
turn finishes/steered/cancelled on the old host, drained host stopped, same session resumes with
its native id after a `release_session`, capability-less host, refusal fallback, distinct
sockets/units and forwarder ports, adoption of a stopped host's envelopes and claims, idle-agent
closing).

Added after review: crashed-then-restarted retiring host kept and retired again, stopped host
forgotten with its registry claims released, unlinked live host found again, old host serving
(and not stopped) while the new host cannot start, no routing to a host being stopped,
simultaneous-start seniority, adoption timing and stop marker, timer persistence after standby,
deferred session-work attaches handed on through files, and the downgrade guard. Not covered by an
automated test: `server.ts` itself (standby/takeover, `retire`, `release_session`), the macOS
launcher fallback, and a real A→B→C rollover.
